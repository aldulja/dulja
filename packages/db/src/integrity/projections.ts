import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

const CHECKS = new Map<string, ProjectionCheck>();

/**
 * Register a projection for the nightly rebuild-and-compare (spec:1204, 2265; acceptance test 2).
 * 1B registers `account_balance`; 3A registers `stock_on_hand` (contracts §4.7.3) and 8C `employee_ytd`
 * (§4.12.8). Registering twice under one name replaces the earlier entry, so a hot reload is harmless.
 */
export function registerProjectionCheck(check: ProjectionCheck): void {
  CHECKS.set(check.name, check);
}

/** Every registered check, in a stable name order so a report diff is readable. */
export function projectionChecks(): readonly ProjectionCheck[] {
  return [...CHECKS.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

interface CompareRow {
  company_id: string;
  account_id: string;
  fiscal_period_id: string;
  currency: string;
  missing_in_projection: boolean;
  missing_in_rebuild: boolean;
  r_debit: string | null;
  r_credit: string | null;
  r_base_debit: string | null;
  r_base_credit: string | null;
  b_debit: string | null;
  b_credit: string | null;
  b_base_debit: string | null;
  b_base_credit: string | null;
}

const AMOUNT_COLUMNS = ["debit", "credit", "base_debit", "base_credit"] as const;

/**
 * §4.3.3's rebuild, executed: group app.ledger_entry on the projection's full key inside a CTE, full-outer-join
 * it against app.account_balance, and report every row missing on either side or whose amounts differ.
 * Reversals ADD entries with swapped sides (D13), so the projection is a pure sum and the comparison is
 * exact — "bit-identically" in the Phase 1 DoD means exactly this.
 *
 * Runs inside withTenant, so both sides are already one tenant's rows (contracts §4.2.2) — the
 * structural answer to LEGACY-001, where the aggregate was keyed without the tenant.
 *
 * One statement, no DDL. An earlier draft materialised the rebuild in a `create temporary table … on
 * commit drop`, which AGENTS.md forbids from application code ("Never … issue DDL from application code")
 * and which also made the check depend on a privilege the schema never granted on purpose. The CTE is the
 * same rows, the same join and the same comparison, and it is re-entrant by construction.
 */
export async function checkAccountBalanceProjection(tx: Sql): Promise<ProjectionMismatch[]> {
  const rows = await tx<CompareRow[]>`
    with rebuilt as (
      select l.company_id, l.account_id, l.fiscal_period_id, l.currency,
             sum(l.debit)       as debit,
             sum(l.credit)      as credit,
             sum(l.base_debit)  as base_debit,
             sum(l.base_credit) as base_credit
        from app.ledger_entry l
       group by l.company_id, l.account_id, l.fiscal_period_id, l.currency
    )
    select coalesce(r.company_id, b.company_id)::text             as company_id,
           coalesce(r.account_id, b.account_id)::text             as account_id,
           coalesce(r.fiscal_period_id, b.fiscal_period_id)::text as fiscal_period_id,
           coalesce(r.currency, b.currency)::text                 as currency,
           (b.company_id is null)                                 as missing_in_projection,
           (r.company_id is null)                                 as missing_in_rebuild,
           r.debit::text as r_debit, r.credit::text as r_credit,
           r.base_debit::text as r_base_debit, r.base_credit::text as r_base_credit,
           b.debit::text as b_debit, b.credit::text as b_credit,
           b.base_debit::text as b_base_debit, b.base_credit::text as b_base_credit
      from rebuilt r
      full outer join app.account_balance b
        on  b.company_id       = r.company_id
        and b.account_id       = r.account_id
        and b.fiscal_period_id = r.fiscal_period_id
        and b.currency         = r.currency
     where r.company_id is null
        or b.company_id is null
        or b.debit       <> r.debit
        or b.credit      <> r.credit
        or b.base_debit  <> r.base_debit
        or b.base_credit <> r.base_credit
     order by 1, 2, 3, 4`;

  const mismatches: ProjectionMismatch[] = [];
  for (const row of rows) {
    const key = {
      company_id: row.company_id,
      account_id: row.account_id,
      fiscal_period_id: row.fiscal_period_id,
      currency: row.currency,
    };
    if (row.missing_in_projection) {
      mismatches.push({
        projection: "account_balance",
        key,
        side: "missing_in_projection",
        detail: `the ledger has base_debit ${row.r_base_debit} / base_credit ${row.r_base_credit} and account_balance has no row`,
      });
      continue;
    }
    if (row.missing_in_rebuild) {
      mismatches.push({
        projection: "account_balance",
        key,
        side: "missing_in_rebuild",
        detail: `account_balance has base_debit ${row.b_base_debit} / base_credit ${row.b_base_credit} and the ledger has no entries`,
      });
      continue;
    }
    for (const column of AMOUNT_COLUMNS) {
      const projected = row[`b_${column}` as const];
      const rebuilt = row[`r_${column}` as const];
      if (projected !== rebuilt) {
        mismatches.push({
          projection: "account_balance",
          key,
          side: "amount_differs",
          detail: `${column} ${projected} <> ${rebuilt}`,
        });
      }
    }
  }
  return mismatches;
}

/** The ProjectionCheck this slice contributes to the registry; registered in ./index.ts. */
export const ACCOUNT_BALANCE_CHECK: ProjectionCheck = {
  name: "account_balance",
  run: checkAccountBalanceProjection,
};
