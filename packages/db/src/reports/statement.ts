import type { Sql } from "postgres";
import {
  STATEMENT_EXTRA_FIELDS,
  statementKindFor,
  statementSectionFields,
  type ReportDefinition,
  type ReportLang,
  type StatementKind,
} from "@dulja/domain";
import { assertDatasetGate, datasetFor, datasetRowBound } from "./datasets";
import { ReportError } from "./errors";
import { MAX_DATASET_ROWS, type DatasetRow } from "./query";

export interface StatementParams {
  companyId: string;
  fiscalPeriodId: string;
  /** Narrows the statement to one BRANCH value; implies the ledger read. */
  branchId?: string | null;
  /** true reads per BRANCH even with no `branchId` — one row per branch, account and currency. */
  perBranch?: boolean;
  limit?: number;
  /** The language of `section_label`, the printed heading. Default `en`. */
  lang?: ReportLang;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A malformed uuid would otherwise reach Postgres as SQLSTATE 22P02 and surface as a 500 (LEGACY-084). */
function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `value '${value}' is not a uuid (field '${field}')`,
    );
  }
}

/**
 * The per-BRANCH read. `account_balance`'s key is (company, account, period, currency) and carries no branch
 * (§4.3.3), so the branch cut is the ledger summed to exactly that grain plus the branch. A posted amount's
 * branch is its document's `branch_id`: the posting service writes that same value as every line's BRANCH
 * dimension (`dimensionsFor` — the header's BRANCH always wins, LEGACY-042/050), and no seeded policy narrows a
 * rule's `dimensions.from`, so the document join is the one branch tag every line has.
 *
 * It sums in SQL rather than collapsing a page of `ledger_entry` rows in TypeScript: a statement over a page
 * that a row ceiling cut short would add up and be wrong. The projection is a pure sum of the ledger grouped
 * by (account, period, currency) — the posting MERGE's own `group by` — so the per-branch rows of one account
 * sum to its `account_balance` row exactly. Every literal below is authored here; only values are bound.
 */
async function branchLedgerRows(
  tx: Sql,
  params: { companyId: string; fiscalPeriodId: string; branchId: string | null; limit: number },
): Promise<DatasetRow[]> {
  const rows = await tx<DatasetRow[]>`
    select l.account_id                                         as account_id,
           ac.code                                              as account_code,
           ac.name_en                                           as account_name_en,
           ac.name_ar                                           as account_name_ar,
           ac.type::text                                        as account_type,
           ac.is_group                                          as is_group,
           ac.parent_id                                         as parent_id,
           l.fiscal_period_id                                   as fiscal_period_id,
           to_char(fp.starts_on, 'YYYY-MM')                     as fiscal_period_code,
           l.currency                                           as currency,
           sum(l.debit)::numeric(19,4)                          as debit,
           sum(l.credit)::numeric(19,4)                         as credit,
           sum(l.base_debit)::numeric(19,4)                     as base_debit,
           sum(l.base_credit)::numeric(19,4)                    as base_credit,
           (sum(l.base_debit) - sum(l.base_credit))::numeric(19,4) as base_balance,
           d.branch_id                                          as branch_id,
           bv.code                                              as branch_code
      from app.ledger_entry l
      join app.account         ac on ac.id = l.account_id
      join app.document        d  on d.id  = l.document_id
      join app.fiscal_period   fp on fp.id = l.fiscal_period_id
      join app.dimension_value bv on bv.id = d.branch_id
     where l.company_id = ${params.companyId}::uuid
       and l.fiscal_period_id = ${params.fiscalPeriodId}::uuid
       and (${params.branchId}::uuid is null or d.branch_id = ${params.branchId}::uuid)
     group by d.branch_id, bv.code, l.account_id, ac.code, ac.name_en, ac.name_ar, ac.type,
              ac.is_group, ac.parent_id, l.fiscal_period_id, fp.starts_on, l.currency
     order by bv.code asc, ac.code asc, l.currency asc
     limit ${params.limit}`;
  return [...rows];
}

/** Keeps the rows `kind` covers and annotates each with its `section`, `section_rank` and `section_label`
 *  (`statementSectionFields`), so the pure layout sorts and groups on columns that EXIST. A group account is
 *  kept: posting refuses one (`posting/load.ts`), so a balance on it can only be one posted before it became a
 *  group, and dropping it would break the ledger identity silently. */
function annotate(
  rows: readonly DatasetRow[],
  kind: StatementKind,
  lang: ReportLang,
): DatasetRow[] {
  const out: DatasetRow[] = [];
  for (const row of rows) {
    const fields = statementSectionFields(kind, String(row["account_type"]), lang);
    if (fields === null) continue; // the other statement's account types
    out.push({ branch_id: null, branch_code: null, ...row, ...fields });
  }
  return out;
}

/**
 * The rows of one statement for one fiscal period, each annotated with its statement `section`.
 *
 * Company-level (no `branchId`, no `perBranch`): the `account_balance` dataset — the synchronous projection
 * 1B's trial balance reads, never a re-aggregation — with `branch_id` / `branch_code` null. Per BRANCH: the
 * ledger summed to the same row shape plus the branch (`branchLedgerRows`).
 *
 * A statement is never truncated: a read that would exceed `limit` (default and ceiling `MAX_DATASET_ROWS - 1`)
 * is refused rather than returned short, because a short statement still totals and is wrong.
 */
export async function statementRows(
  tx: Sql,
  kind: StatementKind,
  params: StatementParams,
): Promise<DatasetRow[]> {
  assertUuid(params.companyId, "companyId");
  assertUuid(params.fiscalPeriodId, "fiscalPeriodId");
  const branchId = params.branchId ?? null;
  if (branchId !== null) assertUuid(branchId, "branchId");
  const cap = Math.min(
    Math.max(Math.trunc(params.limit ?? MAX_DATASET_ROWS), 1),
    MAX_DATASET_ROWS - 1,
  );

  const rows =
    branchId === null && params.perBranch !== true
      ? await datasetFor("account_balance").run(tx, {
          companyId: params.companyId,
          filters: [{ field: "fiscal_period_id", op: "eq", value: params.fiscalPeriodId }],
          sort: [
            { field: "account_code", dir: "asc" },
            { field: "currency", dir: "asc" },
          ],
          limit: cap + 1,
          offset: 0,
        })
      : await branchLedgerRows(tx, {
          companyId: params.companyId,
          fiscalPeriodId: params.fiscalPeriodId,
          branchId,
          limit: cap + 1,
        });
  if (rows.length > cap) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `the ${kind} statement for period '${params.fiscalPeriodId}' has more than ${cap} rows; a statement is never truncated`,
    );
  }
  return annotate(rows, kind, params.lang ?? "en");
}

/** True when a definition lays its rows out by BRANCH — 7A's `perBranch` fragment names `branch_code` in its
 *  groups and columns — so its rows must carry a real branch even when no `branchId` narrows the run. */
function laysOutByBranch(definition: ReportDefinition): boolean {
  const fields = [
    ...definition.columns.map((c) => c.field),
    ...definition.groups.map((g) => g.field),
  ];
  return fields.includes("branch_code") || fields.includes("branch_id");
}

/**
 * **The one row provider.** Every run of a report — the `reporting.render` handler (Task 11) and any later
 * caller — goes through this function and never calls `datasetFor(...).run` itself, which is what makes the
 * statement path reachable outside its own test file.
 *
 * On the **dataset** branch, a filter whose optional parameter was not supplied is DROPPED rather than bound
 * to `null`, so an absent `branchId` means "every branch" instead of "no rows". `validateReportDefinition`
 * already proved every filter names a declared parameter, so no unknown key can reach a query here.
 *
 * Before **either** branch the definition's gate is re-checked (`assertDatasetGate`), so no stored row runs
 * under a gate the store would refuse today (second review, finding 8).
 *
 * On **either** branch a read that would exceed `limit` (default and ceiling `MAX_DATASET_ROWS - 1`) is refused
 * `ERR_VALIDATION_FAILED` rather than returned short.
 *
 * On the **statement** branch the definition's `dataset.filters` are NOT consulted: `statementRows` owns its
 * queries and takes exactly `fiscalPeriodId` and `branchId`. A statement definition that declares any other
 * filter has it dropped — which is why `STATEMENT_LAYOUTS` declares only those two.
 */
export async function rowsForDefinition(
  tx: Sql,
  definition: ReportDefinition,
  params: {
    companyId: string;
    parameters: Readonly<Record<string, string>>;
    limit?: number;
    /** The run's language — a statement's `section_label` is printed in it. Default `en`. */
    lang?: ReportLang;
  },
): Promise<DatasetRow[]> {
  // The gate, re-checked at READ time (Phase 7 second review, finding 8): a stored definition was validated when
  // it was written, but a row written before a gate rule existed — or by a path that bypassed the store — must
  // not run under a wider gate. `assertDatasetGate` is the store's own rule (the dataset's admitted codes and
  // every column's `requires`); a definition that fails it is refused here, before any row is read, and the
  // run fails with the reason (ERR_VALIDATION_FAILED, `/permission`).
  assertDatasetGate(definition);
  const limit = params.limit ?? MAX_DATASET_ROWS;
  const kind = statementKindFor(definition.code);
  if (kind !== null) {
    const fiscalPeriodId = params.parameters["fiscalPeriodId"];
    if (fiscalPeriodId === undefined || fiscalPeriodId === "") {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report '${definition.code}' requires the parameter 'fiscalPeriodId'`,
      );
    }
    const branchId = params.parameters["branchId"];
    return statementRows(tx, kind, {
      companyId: params.companyId,
      fiscalPeriodId,
      branchId: branchId === undefined || branchId === "" ? null : branchId,
      perBranch: laysOutByBranch(definition),
      limit,
      lang: params.lang ?? "en",
    });
  }
  const filters = definition.dataset.filters.flatMap((f) => {
    const value = params.parameters[f.param];
    return value === undefined || value === "" ? [] : [{ field: f.field, op: f.op, value }];
  });
  // Never truncated, as a statement is not (Phase 7 review, finding 3): one row past the cap is read, and a
  // run that reaches it is REFUSED. A short page still totals, so a clamped read rendered a partial report
  // whose figures looked complete. The ceiling is `MAX_DATASET_ROWS - 1` because the dataset clamps every
  // read to `MAX_DATASET_ROWS`, and the extra row must fit under that clamp.
  const cap = Math.min(Math.max(Math.trunc(limit), 1), MAX_DATASET_ROWS - 1);
  // The gate's row bound (second review, finding 4): a definition read under a module's code sees only that
  // module's rows, whatever its filters and parameter options say.
  const rowBound = datasetRowBound(definition.dataset.source, definition.permission);
  const rows = await datasetFor(definition.dataset.source).run(tx, {
    companyId: params.companyId,
    ...(rowBound === undefined ? {} : { rowBound }),
    filters,
    sort: definition.sort.map((s) => ({ field: s.field, dir: s.dir })),
    limit: cap + 1,
    offset: 0,
  });
  if (rows.length > cap) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report '${definition.code}' would print more than ${cap} rows; narrow the parameters (a report is never truncated)`,
    );
  }
  return rows;
}

/**
 * The run's parameters as a header and footer PRINT them: every `period`-kind parameter's fiscal-period uuid
 * is replaced by the period's code, `YYYY-MM` of its first day — the spelling every dataset's
 * `fiscal_period_code` uses — so `{title} — {fiscalPeriodId}` reads "Balance sheet — 2026-03", not a uuid. The
 * lookup is bound to the run's company; a value that is not a uuid of one of its periods prints as given.
 * Every other parameter passes through unchanged. Only `renderReport`'s `{name}` substitution reads this: the
 * rows were already read with the raw parameters.
 */
export async function reportDisplayParameters(
  tx: Sql,
  definition: ReportDefinition,
  params: { companyId: string; parameters: Readonly<Record<string, string>> },
): Promise<Record<string, string>> {
  const shown: Record<string, string> = { ...params.parameters };
  if (!UUID.test(params.companyId)) return shown;
  for (const parameter of definition.parameters) {
    if (parameter.kind !== "period") continue;
    const value = params.parameters[parameter.name];
    if (value === undefined || !UUID.test(value)) continue;
    const [period] = await tx<{ code: string }[]>`
      select to_char(fp.starts_on, 'YYYY-MM') as code
        from app.fiscal_period fp
       where fp.id = ${value}::uuid and fp.company_id = ${params.companyId}::uuid`;
    if (period !== undefined) shown[parameter.name] = period.code;
  }
  return shown;
}

/**
 * **The one field check.** Every field a definition names must exist on the rows its dataset produces.
 *
 * This cannot live in `packages/domain` beside the rest of the validation: `validateReportDefinition` takes
 * the dataset IDS and the permission codes as two `ReadonlySet<string>` (§4.11.1), and a dataset's column list
 * is a `DatasetColumn[]` whose `ref` is a `packages/db` closure. So it lives here, and the definition store
 * (Task 13) and the seed loader (Task 14) both call it.
 *
 * It matters because the run-time checks do not cover the display list: `columnOf` raises for a filter or a
 * sort key, and nothing looks at `columns[]`, `groups[]` or `totals[]`. A typo there renders as a silently
 * empty column whose total still adds up — a report that is wrong and looks right.
 *
 * A **statement** code's rows carry five fields its dataset does not declare (`STATEMENT_EXTRA_FIELDS`), so
 * the known set is unioned for those three codes and for no others.
 */
export function assertDefinitionFields(definition: ReportDefinition): void {
  const dataset = datasetFor(definition.dataset.source); // throws ERR_REPORT_DATASET_UNKNOWN
  // The gate before the fields: a permission the dataset does not admit is refused at save and at seed
  // (Phase 7 review, finding 1).
  assertDatasetGate(definition);
  const known = new Set<string>(dataset.columns.map((c) => c.field));
  if (statementKindFor(definition.code) !== null) {
    for (const extra of STATEMENT_EXTRA_FIELDS) known.add(extra);
  }
  const bad = [
    ...definition.columns.map((c) => c.field),
    ...definition.groups.map((g) => g.field),
    ...definition.totals.map((t) => t.field),
    ...definition.sort.map((k) => k.field),
    ...definition.dataset.filters.map((f) => f.field),
  ].filter((field) => !known.has(field));
  if (bad.length > 0) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `dataset '${definition.dataset.source}' has no such field: ${[...new Set(bad)].join(", ")}`,
    );
  }
}
