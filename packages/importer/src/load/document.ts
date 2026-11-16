import type { Sql } from "postgres";
import { postDocument, resolvePolicy, type PostResult } from "@dulja/db";
import type { Money, Quantity } from "@dulja/domain";
import { baseCurrency } from "./run";
import { LoadError, type LoadContext } from "./types";

/** One line of an imported document. Amounts are `Money` in the company's base currency, never a `number`. */
export interface ImportedLine {
  lineNo: number;
  accountId?: string | null;
  itemId?: string | null;
  warehouseId?: string | null;
  lotId?: string | null;
  unitId?: string | null;
  kind: "account" | "item";
  description: string;
  debit?: Money;
  credit?: Money;
  quantity?: Quantity;
  unitPrice?: Money;
  amount?: Money;
}

/** One cut-over document (contracts §4.14's `OPENING_BALANCE` / `OPENING_STOCK`), drafted and posted whole. */
export interface ImportedDocument {
  documentTypeCode: "OPENING_BALANCE" | "OPENING_STOCK";
  /** The legacy document number, verbatim (§5.1 #8, LEGACY-051) — `null` for a figure that is no legacy document's. */
  legacyRef: string | null;
  partyId?: string | null;
  warehouseId?: string | null;
  lines: ImportedLine[];
}

/** `document.branch_id` is NOT NULL (0001) and `LoadContext` carries no branch (§4.13.2), so every imported document —
 *  and every imported warehouse (Task 4) — lands in the company's head office, the BRANCH value Plan 0A seeds and 4B's
 *  company-level FX revaluation already resolves by code. The legacy schema has no branch that maps onto it. */
export const OPENING_BRANCH_CODE = "HQ";

/** The live head-office BRANCH value of a company, or a refusal naming what to create. Package-internal: the warehouse
 *  loader and `draftAndPost` resolve the one branch the same way. */
export async function openingBranchId(tx: Sql, companyId: string, why: string): Promise<string> {
  const [branch] = await tx<{ id: string }[]>`
    select v.id::text as id from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where t.company_id = ${companyId} and t.code = 'BRANCH' and v.code = ${OPENING_BRANCH_CODE}
       and v.archived_at is null`;
  if (!branch)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `company ${companyId} has no live BRANCH value ${OPENING_BRANCH_CODE}; ${why}, so create it before the load`,
    );
  return branch.id;
}

/** The `import_batch` target tables whose rows point at a document the load posted (Tasks 5–7). */
const DOCUMENT_TARGETS = ["opening_balance", "open_item", "opening_stock"];

/** How many of a refused run's new keys a refusal names before it says how many more there are. */
const KEYS_NAMED = 5;

/**
 * 9B review, finding 3 — a WHOLE-TABLE opening (the trial balance, opening stock) is ONE-SHOT. `runLoad` hands `load`
 * only the rows no earlier run recorded, and `import_batch` cannot be updated or deleted (0102), so once any run has
 * recorded a row of this loader a second `load` would compute its answer from the new rows ALONE: a one-account
 * `OPENING_BALANCE` with a `3900` residue of its own, or a stock opening replayed from a fragment of the history.
 * Reversing the first opening does not change that — its rows stay recorded — so this refuses whenever an earlier run
 * recorded any row of the loader, whether its document is posted, reversed or (`EMPTY_TARGET`) was never posted. A
 * correction after the opening is an ordinary Dulja document; a whole re-import goes into a fresh company.
 */
export async function refusePriorOpening(
  tx: Sql,
  ctx: LoadContext,
  opening: {
    readonly sourceTable: string;
    readonly targetTable: string;
    readonly what: string;
    readonly newKeys: readonly string[];
    readonly correction: string;
  },
): Promise<void> {
  const [prior] = await tx<
    { run_id: string; series: string | null; number: string | null; status: string | null }[]
  >`
    select b.run_id::text as run_id, d.series, d.number::text as number, d.status::text as status
      from app.import_batch b left join app.document d on d.id = b.target_id
     where b.company_id = ${ctx.companyId} and b.source_table = ${opening.sourceTable}
       and b.target_table = ${opening.targetTable}
     order by b.created_at, b.id
     limit 1`;
  if (!prior) return;
  const keys = opening.newKeys.slice(0, KEYS_NAMED).join(", ");
  const more =
    opening.newKeys.length > KEYS_NAMED ? ` and ${opening.newKeys.length - KEYS_NAMED} more` : "";
  const as =
    prior.series === null
      ? " (it opened nothing: every row netted to zero)"
      : ` as ${prior.series} ${prior.number ?? ""}${prior.status === "reversed" ? ", since reversed," : ""}`;
  throw new LoadError(
    "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
    `${opening.what} was already loaded${as} by run ${prior.run_id}, and ${opening.sourceTable} now holds ${keys}${more}, which that load did not read or did not map. The importer's opening is one-shot: a reversal does not reopen it, because a re-run would compute it out of these rows alone. ${opening.correction}; for a whole re-import, load into a fresh company (the runbook's rehearsal company)`,
  );
}

/**
 * 9B review, finding 4 — an opening is loaded into a company that has posted nothing else. Refuses when the company
 * holds a posted (or reversed) document the cut-over load did not create: one no `import_batch` row of a document
 * loader points at, nor the reversal of one. Without it, a principal holding the import gate could add an opening to a
 * live company's books, doubling every balance it touches. Reversing that document does not make the company fresh —
 * the original stands, `reversed`, beside its reversal — so the refusal names a fresh company as the remedy (9B review,
 * finding 3). The trial-balance opening and the open items call it before they post; opening stock has its own,
 * stricter guard over movements (`refuseUnsafeOpening`). `runLoad` hands `load` only rows no earlier run recorded, so
 * an identical re-run after the company starts trading never reaches it.
 */
export async function refuseForeignPostings(
  tx: Sql,
  ctx: LoadContext,
  what: string,
): Promise<void> {
  const [foreign] = await tx<{ type: string; series: string; number: string | null }[]>`
    select t.code as type, d.series, d.number::text as number
      from app.document d join app.document_type t on t.id = d.document_type_id
     where d.company_id = ${ctx.companyId} and d.status in ('posted', 'reversed')
       and not exists (
             select 1 from app.import_batch b
              where b.company_id = d.company_id and b.target_table = any(${DOCUMENT_TARGETS}::text[])
                and (b.target_id = d.id or b.target_id = d.reverses_document_id))
     order by d.id
     limit 1`;
  if (foreign)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `company ${ctx.companyId} already holds ${foreign.type} ${foreign.series} ${foreign.number ?? ""}, posted outside the cut-over load; ${what} an opening, loaded only into a company that has posted nothing else — load into a fresh company (reversing that document does not make this one fresh: it stands, reversed, beside its reversal)`,
    );
}

function inBase(value: Money | undefined, site: string): string | null {
  if (value === undefined) return null;
  const base = baseCurrency();
  if (value.currency !== base)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site} is in ${value.currency}; an imported document is in the company's base currency ${base}`,
    );
  return value.toString();
}

/**
 * The ONE place `packages/importer` writes `app.document` and `app.document_line` (9B plan N7). It drafts the header and
 * its lines and hands the id to `postDocument`, which issues, numbers, posts, MERGEs and audits it exactly as the API's
 * transition would (§4.3.2): the ledger rows, movements, layers, `account_balance`, `stock_on_hand`, the number and the
 * `document_event` are all the posting service's (§0.2, hazard 22). That is what makes the import path the API path, and
 * lets acceptance tests 9 and 18 be RE-RUN through it rather than re-implemented.
 *
 * The document is dated `ctx.cutOverDate` (spec:2039: entered by the operator, never derived), in the company's base
 * currency at rate 1, in the head office, and numbered in its policy's series (§4.3.6; `OB`/`OS`, round 20 C1) at issue.
 * A refusal — a closed period, a missing type or policy, an archived account — raises inside the caller's transaction,
 * so the page rolls back whole and nothing, not even the draft, is left behind. Returns what `postDocument` returned.
 */
export async function draftAndPost(
  tx: Sql,
  ctx: LoadContext,
  doc: ImportedDocument,
): Promise<PostResult> {
  if (doc.lines.length === 0)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `an imported ${doc.documentTypeCode} has no lines; a loader with nothing to post answers EMPTY_TARGET instead`,
    );
  const [type] = await tx<{ id: string }[]>`
    select id::text as id from app.document_type
     where company_id = ${ctx.companyId} and code = ${doc.documentTypeCode} and archived_at is null`;
  if (!type)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `company ${ctx.companyId} has no live document type ${doc.documentTypeCode}; run \`bun run seed --tenant <id> --only document-types\` before the load`,
    );
  // The series comes from the policy in force on the cut-over date, as `issueDocument` will read it, so the draft
  // already shows the series it is numbered in (§4.3.6). `resolvePolicy` refuses a missing or invalid policy.
  const { definition } = await resolvePolicy(tx, type.id, ctx.cutOverDate);
  const branchId = await openingBranchId(
    tx,
    ctx.companyId,
    "every imported document lands in the head office",
  );

  const [header] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       branch_id, party_id, warehouse_id, legacy_ref)
    values (${ctx.tenantId}, ${ctx.companyId}, ${type.id}, ${definition.numbering.series},
            ${ctx.cutOverDate}, ${baseCurrency()}, '1.00000000', ${branchId},
            ${doc.partyId ?? null}, ${doc.warehouseId ?? null}, ${doc.legacyRef})
    returning id::text as id`;
  const documentId = header!.id;

  for (const line of doc.lines) {
    const site = `${doc.documentTypeCode} line ${line.lineNo}`;
    await tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id, warehouse_id,
         lot_id, unit_id, debit, credit, quantity, unit_price, amount)
      values (${ctx.tenantId}, ${ctx.companyId}, ${documentId}, ${line.lineNo}, ${line.kind},
              ${line.description}, ${line.accountId ?? null}, ${line.itemId ?? null},
              ${line.warehouseId ?? null}, ${line.lotId ?? null}, ${line.unitId ?? null},
              ${inBase(line.debit, `${site} debit`) ?? "0"}, ${inBase(line.credit, `${site} credit`) ?? "0"},
              ${line.quantity?.toString() ?? null}, ${inBase(line.unitPrice, `${site} unit price`)},
              ${inBase(line.amount, `${site} amount`) ?? "0"})`;
  }

  // Everything after this line is the posting service's, including the issue and the number.
  return postDocument(tx, ctx, { documentId });
}
