import type { Sql } from "postgres";
import {
  createEmployee,
  upsertEmployeeYtdOpening,
  writeSensitive,
  type HrKeyRing,
  type SensitiveField,
  type SensitiveValues,
} from "@dulja/db";
import { Money, type CurrencyCode } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { openingBranchId } from "./document";
import { mappedByLoad } from "./master";
import { baseCurrency, cutOverDate, loadSource, READ_BATCH } from "./run";
import {
  dateOf,
  optionalDateOf,
  optionalText,
  payMoneyOf,
  requireText,
  sensitiveOf,
} from "./scalar";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type LoadResult,
  type SkipRecord,
  type SourceColumn,
} from "./types";

/** A Dulja employee about to be written — never a transcription of the legacy row (hazard 3). */
export interface EmployeeTarget {
  /** EMPID — the `import_batch` source key, and the key `employee_ytd_opening`'s loader resolves through. */
  legacyKey: string;
  /** EMPNUMBER verbatim: `employee.employee_number`, the party's code and `employee.legacy_ref` (0101's comment: "the
   *  source system's employee number"). */
  employeeNumber: string;
  nameEn: string;
  nameAr: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  /** Only the fields the source holds a value for; sealed by 8A's `writeSensitive` and nowhere else. */
  sensitive: SensitiveValues;
}

/** One employee's cut-over opening (§5.1 #11): the headline gross and net §3.10.1 names, in the base currency. */
export interface EmployeeYtdTarget {
  legacyKey: string;
  employeeId: string;
  /** The tax year — the cut-over date's calendar year (round 18 B7's convention for `tax_year`). */
  year: number;
  gross: Money;
  net: Money;
}

// ── the HR key ring: module state, like the account map ─────────────────────────────────────────────────────────

let ring: HrKeyRing | null = null;

/** The ring every sensitive field is sealed under. The CLI builds it from `HR_FIELD_ENCRYPTION_KEY` (and its version)
 *  and Task 9's handler from the worker's own ring; a worker serves many tenants, so each run sets it and clears it. */
export function setKeyRing(value: HrKeyRing): void {
  ring = value;
}

export function clearKeyRing(): void {
  ring = null;
}

function keyRing(): HrKeyRing {
  if (!ring)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "no HR key ring is set; HR_FIELD_ENCRYPTION_KEY must be present before the employee load, because an employee's national id, bank account and scheme numbers are written only through 8A's encrypted writer (§4.12.5, ADR 0071)",
    );
  return ring;
}

// ── the column maps ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sensitive column map, keyed by 8A's own `SensitiveField` names so no new vocabulary is introduced. Every entry is
 * a HYPOTHESIS until the live catalogue confirms it (hazard 3) and every one is `sensitive`: its value is sealed by
 * `writeSensitive` and enters `import_batch.source_hash` as presence only. A column the source lacks is not read and
 * the field is simply not loaded — never guessed, never written as an empty string. 8A's other three fields
 * (`passport`, `residency_category`, `work_permit_expiry`) have no column the plan or the dossier names.
 */
export const SENSITIVE_SOURCES: Readonly<Partial<Record<SensitiveField, SourceColumn>>> = {
  national_id: {
    name: "EMPNATID",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "national identity number → employee_sensitive.national_id",
  },
  date_of_birth: {
    name: "EMPDOB",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "date of birth → employee_sensitive.date_of_birth",
  },
  bank_account: {
    name: "EMPBANKACC",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "salary bank account → employee_sensitive.bank_account; PAYROLL_PAYMENT's batch file needs it (8C)",
  },
  epf_number: {
    name: "EMPEPFNO",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "the employee's EPF reference — a REFERENCE NUMBER, never a rate or a threshold",
  },
  socso_number: {
    name: "EMPSOCSONO",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "the employee's SOCSO reference number",
  },
  tax_number: {
    name: "EMPTAXNO",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "the employee's income-tax reference number",
  },
};

const SENSITIVE_ENTRIES = Object.entries(SENSITIVE_SOURCES) as [SensitiveField, SourceColumn][];

const EMPLOYEE_COLUMNS: readonly SourceColumn[] = [
  {
    name: "EMPID",
    required: true,
    confidence: "hypothesis",
    note: "the employee's own key (Employees, prefix EMP); the import_batch source key",
  },
  {
    name: "EMPNUMBER",
    required: true,
    confidence: "hypothesis",
    note: "the payroll number the officer uses → employee.employee_number, the party code and employee.legacy_ref",
  },
  {
    name: "EMPNAME",
    required: true,
    confidence: "hypothesis",
    note: "display name → party.name_en",
  },
  {
    name: "EMPNAMEAR",
    required: false,
    confidence: "hypothesis",
    note: "Arabic name → party.name_ar",
  },
  {
    name: "EMPHIRED",
    required: true,
    confidence: "hypothesis",
    note: "hire date → employee.hired_on",
  },
  {
    name: "EMPLEFT",
    required: false,
    confidence: "hypothesis",
    note: "termination date; APPLIED BY UPDATE so 8C's AFTER UPDATE OF terminated_on trigger fires (spec:2090)",
  },
  ...SENSITIVE_ENTRIES.map(([, column]) => column),
];

const YTD_COLUMNS: readonly SourceColumn[] = [
  {
    name: "EMPID",
    required: true,
    confidence: "hypothesis",
    note: "the employee's own key; the opening's source key is YTD:<EMPID>, the employee it opens is EMPID's",
  },
  // `sensitive` (9B review, finding 6): a pay figure enters the persisted `import_batch.source_hash` as presence only,
  // as the national id does. A plain sha256 of {EMPID, gross, net} is brute-forced from a salary range in seconds, and
  // `import_batch` is plumbing every loader's resolver reads, outside every route and export gate `hr.payroll.read`
  // puts on `employee_ytd_opening` itself (ADR 0084 decision 13's amendment).
  {
    name: "EMPYTDGROSS",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "current-tax-year gross → employee_ytd_opening.gross (§5.1 #11)",
  },
  {
    name: "EMPYTDNET",
    required: false,
    confidence: "hypothesis",
    sensitive: true,
    note: "current-tax-year net → employee_ytd_opening.net (§5.1 #11)",
  },
];

/** The payslip table §5.1 #11's reconciliation reads. Not a loader's source table, so pre-flight never sees it; it is
 *  read only by `assertYtdReconciles`, through the run's own reader, filtered to one employee and one year. */
const PAYITEMS = "PAYITEMS";
export const PAYITEM_COLUMNS: readonly string[] = ["PITEMP", "PITYEAR", "PITGROSS", "PITNET"];

/** The tax year an opening belongs to: the cut-over date's calendar year, the convention round 18 B7 fixes for
 *  `employee_ytd.tax_year` (the calendar year of `pay_date`); OD-23 confirms it. Not named `taxYear…`, because
 *  `no-number-money` reads `tax` as money. */
const yearOf = (date: string): number => Number(date.slice(0, 4));

// ── §5.1 #11: the reconciliation ────────────────────────────────────────────────────────────────────────────────

/** One answer per reader (a run opens one), so a source without the payslip table is asked once, not per employee. */
const payItemsPresent = new WeakMap<LegacyReader, Promise<boolean>>();

/**
 * §5.1 #11 — "reconcile them to the last legacy payslips before the first Dulja run". Compares the employee's stored
 * year-to-date gross and net with the sums of their own `PAYITEMS` rows for `year`. Answers `null` when both agree to
 * the cent and a skip reason otherwise; the caller (the opening loader's `map`) returns that reason, so the opening is
 * REPORTED and NOT RECORDED, and the next run, once the customer has corrected either side, reconciles it again.
 *
 * The reason names the employee and which figure disagrees, and never a figure: a skip reason reaches `skips.csv`, the
 * job log and the API, and a salary is printed in none of them. The operator compares the two in the legacy payroll.
 *
 * One filtered read per employee — right for the thirty-to-two-hundred-person businesses §5.1 is about; the runbook
 * says to measure the rehearsal on a larger source.
 */
export async function assertYtdReconciles(
  reader: LegacyReader,
  target: { legacyKey: string; gross: Money; net: Money },
  year: number,
): Promise<{ skip: string } | null> {
  const key = target.legacyKey;
  let present = payItemsPresent.get(reader);
  if (present === undefined) {
    present = reader.tables().then((tables) => tables.includes(PAYITEMS));
    payItemsPresent.set(reader, present);
  }
  if (!(await present))
    return {
      skip: `employee ${key}'s YTD cannot be reconciled: the source has no ${PAYITEMS} table, so their YTD opening is NOT loaded (§5.1 #11) — an unreconciled figure is never loaded`,
    };

  const base: CurrencyCode = target.gross.currency;
  const site = `${PAYITEMS} of employee ${key}`;
  let gross = Money.zero(base);
  let net = Money.zero(base);
  for await (const page of reader.read<LegacyRow>(PAYITEMS, {
    columns: [...PAYITEM_COLUMNS],
    where: {
      op: "and",
      operands: [
        { op: "eq", column: "PITEMP", value: key },
        { op: "eq", column: "PITYEAR", value: String(year) },
      ],
    },
    batch: READ_BATCH,
  })) {
    for (const row of page) {
      gross = gross.add(payMoneyOf(row, "PITGROSS", base, site));
      net = net.add(payMoneyOf(row, "PITNET", base, site));
    }
  }

  const off = [
    target.gross.equals(gross) ? null : "gross",
    target.net.equals(net) ? null : "net",
  ].filter((f): f is string => f !== null);
  if (off.length === 0) return null;
  return {
    skip: `employee ${key}'s stored YTD ${off.join(" and ")} ${off.length === 1 ? "does" : "do"} not equal the sum of their ${year} payslips (${PAYITEMS}); the employee is loaded and their YTD opening is NOT — reconcile it with the customer and re-run (--only employee_ytd_opening) (§5.1 #11). The figures are pay data and are not printed; compare them in the legacy payroll`,
  };
}

// ── the employee master ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * `EMPLOYEES` → `app.party` (kind `employee`) + `app.employee` + `app.employee_sensitive` (§5.1 #12; §4.6.2's closing
 * rule: one party of kind employee plus one employee, in one transaction). Paged; source key the bare `EMPID`.
 *
 * **§5.1 #12 — the legacy data holds a person twice** (`Salaries.Employees` and `Accounts` rows flagged `IsEmployee`).
 * This loader maps the HR row, and only the HR row, to the one party and the one employee; an `Accounts` row never
 * becomes a person (the party loader takes customers and vendors, and `IsEmployee` is not one of its flags). Nothing
 * links the employee to a legacy account, so 9A's employee-mapping report (`employeeMapping`, both strategies
 * `hypothesis`) is never turned into a guess here: its `account_only`, `hr_only` and `ambiguous_name` rows stay the
 * owner's decisions, in that report, and an `account_only` person — no hire date, no payroll number — is not invented.
 *
 * Written through 6C/8A's `createEmployee` (the API's own service; 9B adds the optional `legacyRef` and `partyCode`),
 * 8A's `writeSensitive` and nothing else. A legacy row whose payroll number a PERSON already created in Dulja (a
 * cashier set up before cut-over) is ADOPTED — linked, and none of its fields written — and reported; one another
 * legacy row already became refuses the run, because a payroll number identifies one person.
 */
export const employeeLoader: Loader<LegacyRow, EmployeeTarget> = {
  sourceTable: "EMPLOYEES",
  targetTable: "employee",
  dependsOn: [],
  sourceColumns: EMPLOYEE_COLUMNS,
  sourceKey: (row) => requireText(row, "EMPID", "EMPLOYEES"),

  map(row) {
    const legacyKey = requireText(row, "EMPID", "EMPLOYEES");
    const site = `EMPLOYEES/${legacyKey}`;
    const hiredOn = dateOf(row, "EMPHIRED", site);
    const terminatedOn = optionalDateOf(row, "EMPLEFT", site);
    if (terminatedOn !== null && terminatedOn < hiredOn)
      return {
        skip: `employee ${legacyKey} left on ${terminatedOn}, before they were hired on ${hiredOn}; correct the source — the loader will not guess which date is wrong`,
      };
    const sensitive: SensitiveValues = {};
    for (const [field, column] of SENSITIVE_ENTRIES) {
      const value = sensitiveOf(
        row,
        column.name,
        site,
        field === "date_of_birth" ? "date" : "text",
      );
      if (value !== null) sensitive[field] = value;
    }
    return {
      legacyKey,
      employeeNumber: requireText(row, "EMPNUMBER", site),
      nameEn: requireText(row, "EMPNAME", site),
      nameAr: optionalText(row, "EMPNAMEAR"),
      hiredOn,
      terminatedOn,
      sensitive,
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: EmployeeTarget[]): Promise<LoadResult> {
    const branchId = await openingBranchId(
      tx,
      ctx.companyId,
      "every imported employee's home branch is the head office until HR moves them",
    );
    // Refused before the first write when any row has a sealed field to write.
    const sealer = rows.some((r) => Object.keys(r.sensitive).length > 0) ? keyRing() : null;
    const claimed = new Set<string>();
    const batchIds: string[] = [];
    const skips: SkipRecord[] = [];
    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
      const [existing] = await tx<{ id: string }[]>`
        select id::text as id from app.employee
         where company_id = ${ctx.companyId} and employee_number = ${row.employeeNumber}`;
      if (existing) {
        if (
          claimed.has(existing.id) ||
          (await mappedByLoad(tx, ctx.companyId, "employee", existing.id))
        )
          throw new LoadError(
            "ERR_VALIDATION_FAILED",
            `employee ${row.legacyKey} carries payroll number ${row.employeeNumber}, which another legacy employee already became; a payroll number identifies one person — correct the source`,
          );
        claimed.add(existing.id);
        skipped += 1;
        batchIds.push(existing.id);
        skips.push({
          loader: "employee",
          sourceTable: "EMPLOYEES",
          sourceKey: row.legacyKey,
          reason: `employee ${row.legacyKey}'s payroll number ${row.employeeNumber} already exists in Dulja (created by hand), so the load adopted that employee and wrote none of its fields; HR enters its sensitive fields and any termination`,
        });
        continue;
      }

      // The party code is the payroll number, as every API-created employee's is. A party that already holds it (any
      // kind — the code is unique per company) moves this one to `<number>-<EMPID>`; `name_en` keeps the name, so the
      // suffix loses nothing. A suffixed code that is taken too refuses, naming both: there is no third rule.
      let partyCode = row.employeeNumber;
      if (await partyCodeTaken(tx, ctx.companyId, partyCode)) {
        partyCode = `${row.employeeNumber}-${row.legacyKey}`;
        if (await partyCodeTaken(tx, ctx.companyId, partyCode))
          throw new LoadError(
            "ERR_VALIDATION_FAILED",
            `employee ${row.legacyKey} wants party code ${row.employeeNumber}, which another party holds, and ${partyCode} is taken too; rename one of them`,
          );
      }
      const made = await createEmployee(tx, ctx.companyId, {
        employeeNumber: row.employeeNumber,
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        homeBranchId: branchId,
        hiredOn: row.hiredOn,
        legacyRef: row.employeeNumber,
        partyCode,
      });
      claimed.add(made.id);
      inserted += 1;
      batchIds.push(made.id);

      if (sealer !== null && Object.keys(row.sensitive).length > 0)
        await writeSensitive(tx, sealer, made.id, row.sensitive);

      // spec:2090: "a direct app_rw update OR THE PHASE 9 IMPORTER cannot bypass" the termination trigger, and 8C's
      // trigger is AFTER UPDATE OF terminated_on — an INSERT carrying the date would not fire it. So the employee is
      // created active and terminated by UPDATE in the same transaction; 8A's employee_no_self_pay runs first, and the
      // system principal is nobody's employee.
      if (row.terminatedOn !== null)
        await tx`update app.employee set terminated_on = ${row.terminatedOn}::date where id = ${made.id}`;
    }
    return { inserted, skipped, batchIds, skips };
  },
};

async function partyCodeTaken(tx: Sql, companyId: string, code: string): Promise<boolean> {
  const [row] = await tx<{ taken: boolean }[]>`
    select exists (select 1 from app.party where company_id = ${companyId} and code = ${code}) as taken`;
  return row!.taken;
}

// ── the cut-over YTD opening ────────────────────────────────────────────────────────────────────────────────────

/**
 * `EMPLOYEES` → `app.employee_ytd_opening` (spec:2084; 8C's table and its one writer, `upsertEmployeeYtdOpening`).
 * Source key `YTD:<EMPID>` — disjoint from the employee loader's bare `EMPID` on the same source table, as the party
 * loader's `ACC:` is from the account loader's codes. Depends on `employee`, which `map` resolves into.
 *
 * **A loader of its own, so an opening that does not reconcile can be loaded later.** The reconciliation (§5.1 #11)
 * runs in `map`: a figure that disagrees with the employee's own payslips is a `{ skip }` — in the register, and NOT in
 * `import_batch` — so the employee stays loaded (their own loader recorded them) and the next run, once the customer
 * has corrected either side, maps it again. Inside the employee loader's `load` (the plan's form) the withheld figure
 * would have been recorded with the employee and never retried (ADR 0084 decision 7).
 *
 * Only `gross` and `net` are loaded; `by_component` and `by_scheme` stay `{}`: the legacy breakdown's columns are
 * unconfirmed, and a guessed per-scheme split would be a statutory claim (hazard 1). The source is `legacy:<runId>`,
 * 8C's provenance form. The opening is never merged into `app.employee_ytd` (round 18 B14): `ytdFromEmployeeYtd` adds
 * it at read time.
 */
export const employeeYtdOpeningLoader: Loader<LegacyRow, EmployeeYtdTarget> = {
  sourceTable: "EMPLOYEES",
  targetTable: "employee_ytd_opening",
  dependsOn: ["employee"],
  sourceColumns: YTD_COLUMNS,
  sourceKey: (row) => `YTD:${requireText(row, "EMPID", "EMPLOYEES")}`,

  async map(row, refs) {
    const legacyKey = requireText(row, "EMPID", "EMPLOYEES");
    const site = `EMPLOYEES/${legacyKey}`;
    const grossText = optionalText(row, "EMPYTDGROSS");
    const netText = optionalText(row, "EMPYTDNET");
    if (grossText === null && netText === null)
      return {
        skip: `employee ${legacyKey} carries no current-tax-year YTD (EMPYTDGROSS and EMPYTDNET are NULL or absent), so no opening is loaded — a NULL is never read as zero (§5.1 #11, SAH-007)`,
      };
    if (grossText === null || netText === null)
      return {
        skip: `employee ${legacyKey} carries ${grossText === null ? "EMPYTDNET without EMPYTDGROSS" : "EMPYTDGROSS without EMPYTDNET"}; a half opening is not loaded — a NULL is never read as zero (§5.1 #11, SAH-007)`,
      };
    const base = baseCurrency();
    const gross = payMoneyOf(row, "EMPYTDGROSS", base, site);
    const net = payMoneyOf(row, "EMPYTDNET", base, site);
    const year = yearOf(cutOverDate());
    // The source is checked before Dulja is asked anything, so a dry run on an empty tenant still reports a drift.
    const drift = await assertYtdReconciles(loadSource().reader, { legacyKey, gross, net }, year);
    if (drift) return drift;
    const employeeId = await refs.byLegacyRef("employee", legacyKey);
    if (employeeId === null)
      return {
        skip: `employee ${legacyKey} was not loaded, so their YTD opening cannot be (a dry run loads no employee; otherwise the employee loader's own report says why)`,
      };
    return { legacyKey, employeeId, year, gross, net };
  },

  async load(tx: Sql, ctx: LoadContext, rows: EmployeeYtdTarget[]): Promise<LoadResult> {
    const batchIds: string[] = [];
    const skips: SkipRecord[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      // An opening a load did not write (8C's `manual:<reason>` form) is somebody's decision: adopted, never
      // overwritten — `upsertEmployeeYtdOpening` would replace its figures.
      const [existing] = await tx<{ id: string; source: string }[]>`
        select id::text as id, source from app.employee_ytd_opening
         where company_id = ${ctx.companyId} and employee_id = ${row.employeeId} and tax_year = ${row.year}`;
      if (existing) {
        skipped += 1;
        batchIds.push(existing.id);
        skips.push({
          loader: "employee_ytd_opening",
          sourceTable: "EMPLOYEES",
          sourceKey: `YTD:${row.legacyKey}`,
          reason: `employee ${row.legacyKey} already has a ${row.year} opening (source ${existing.source}); the load left it as it is`,
        });
        continue;
      }
      const id = await upsertEmployeeYtdOpening(tx, ctx, {
        companyId: ctx.companyId,
        employeeId: row.employeeId,
        year: row.year,
        gross: row.gross,
        net: row.net,
        byComponent: {},
        byScheme: {},
        source: `legacy:${ctx.runId}`,
      });
      inserted += 1;
      batchIds.push(id);
    }
    return { inserted, skipped, batchIds, skips };
  },
};
