import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

/** Narrows the compare. Omit both for the whole tenant (the nightly run and 1B's integrity job). */
export interface EmployeeYtdCheckOptions {
  companyId?: string | undefined;
  /** The `employee_ytd.tax_year` to compare (the calendar year of `payroll_run.pay_date`, round 18 B7). Named `year`
   *  because `no-number-money` reads `tax` as money (the `ytdFromEmployeeYtd` precedent, 8C T3). */
  year?: number | undefined;
}

interface CompareRow {
  company_id: string;
  employee_id: string;
  tax_year: string;
  missing_in_projection: boolean;
  missing_in_rebuild: boolean;
  p_gross: string | null;
  p_net: string | null;
  p_by_component: string | null;
  p_by_scheme: string | null;
  r_gross: string | null;
  r_net: string | null;
  r_by_component: string | null;
  r_by_scheme: string | null;
}

const COLUMNS = ["gross", "net", "by_component", "by_scheme"] as const;

/**
 * spec:2084's "rebuilt from posted lines nightly and compared (D14)", and acceptance test 2's clause for this
 * projection (contracts §4.12.8, round 18 B5/B6/B14; ADR 0077): rebuild every posted PAYROLL run's delta, full-outer-join
 * it against `app.employee_ytd` on the projection's full key, and report every row missing on either side or differing
 * in any measure.
 *
 * The rebuild consumes **`app.employee_ytd_delta`** and nothing else — the same function step 12's `mergeEmployeeYtd`
 * consumes (B6) — and folds a year with `app.jsonb_add_money_agg` / `app.jsonb_add_scheme_agg`, built from the very
 * binary functions the MERGE adds with. That is what makes "rebuilds bit-identically" true by construction: the two
 * sides cannot disagree about how a total was derived, only about whether the maintained row was ever written. Every
 * measure is compared as TEXT — `to_char` for the two amounts, jsonb's canonical text for the two objects — so a
 * difference in scale is reported, not absorbed by numeric equality.
 *
 * **`app.employee_ytd_opening` is on NEITHER side** (B14): the projection is written only by the step-12 MERGE, which
 * never sees an opening, so adding openings to the rebuild alone would report every cut-over employee as permanent
 * `amount_differs` drift. The opening meets the projection at READ time, in `ytdFromEmployeeYtd`.
 *
 * One statement, no DDL: the plan materialised the rebuild in a `create temp table`, which AGENTS.md forbids from
 * application code — 1B's `checkAccountBalanceProjection` uses a CTE for the same reason, and so does this. It READS
 * only; a drift is reported, never repaired (spec:98 — only `posting/**` may write the table).
 *
 * Runs inside `withTenant`, so both sides are one tenant's rows. The rebuild reads `app.document` (6C's
 * `branch_isolation`), so it is meant for a principal that sees every branch — the job's system principal (hazard 20)
 * or a company-wide role; a branch-restricted reader would see a short rebuild.
 */
export async function checkEmployeeYtdProjection(
  tx: Sql,
  opts: EmployeeYtdCheckOptions = {},
): Promise<ProjectionMismatch[]> {
  const companyId = opts.companyId ?? null;
  const year = opts.year ?? null;
  const rows = await tx<CompareRow[]>`
    with posted as (
      select r.document_id
        from app.payroll_run r
        join app.document d on d.id = r.document_id
       where d.status = 'posted'
         and (${companyId}::uuid is null or r.company_id = ${companyId}::uuid)
    ),
    parts as (
      select x.company_id, x.employee_id, x.tax_year, x.gross, x.net, x.by_component, x.by_scheme
        from posted p
        cross join lateral app.employee_ytd_delta(p.document_id) x
       where (${year}::int is null or x.tax_year = ${year}::int)
    ),
    rebuilt as (
      select company_id, employee_id, tax_year,
             sum(gross)::numeric(19,4)            as gross,
             sum(net)::numeric(19,4)              as net,
             app.jsonb_add_money_agg(by_component) as by_component,
             app.jsonb_add_scheme_agg(by_scheme)   as by_scheme
        from parts
       group by company_id, employee_id, tax_year
    ),
    projected as (
      select y.company_id, y.employee_id, y.tax_year, y.gross, y.net, y.by_component, y.by_scheme
        from app.employee_ytd y
       where (${companyId}::uuid is null or y.company_id = ${companyId}::uuid)
         and (${year}::int is null or y.tax_year = ${year}::int)
    )
    select coalesce(p.company_id, r.company_id)::text   as company_id,
           coalesce(p.employee_id, r.employee_id)::text as employee_id,
           coalesce(p.tax_year, r.tax_year)::text       as tax_year,
           (p.company_id is null)                       as missing_in_projection,
           (r.company_id is null)                       as missing_in_rebuild,
           to_char(p.gross, 'FM999999999999990.0000')   as p_gross,
           to_char(p.net, 'FM999999999999990.0000')     as p_net,
           p.by_component::text                         as p_by_component,
           p.by_scheme::text                            as p_by_scheme,
           to_char(r.gross, 'FM999999999999990.0000')   as r_gross,
           to_char(r.net, 'FM999999999999990.0000')     as r_net,
           r.by_component::text                         as r_by_component,
           r.by_scheme::text                            as r_by_scheme
      from projected p
      full outer join rebuilt r
        on r.company_id = p.company_id and r.employee_id = p.employee_id and r.tax_year = p.tax_year
     where p.company_id is null
        or r.company_id is null
        or to_char(p.gross, 'FM999999999999990.0000') <> to_char(r.gross, 'FM999999999999990.0000')
        or to_char(p.net, 'FM999999999999990.0000')   <> to_char(r.net, 'FM999999999999990.0000')
        or p.by_component::text <> r.by_component::text
        or p.by_scheme::text    <> r.by_scheme::text
     order by 1, 2, 3`;

  const mismatches: ProjectionMismatch[] = [];
  for (const row of rows) {
    const key = {
      company_id: row.company_id,
      employee_id: row.employee_id,
      tax_year: row.tax_year,
    };
    if (row.missing_in_projection) {
      mismatches.push({
        projection: "employee_ytd",
        key,
        side: "missing_in_projection",
        detail: `the rebuild has gross ${row.r_gross} net ${row.r_net} and employee_ytd has no row`,
      });
      continue;
    }
    if (row.missing_in_rebuild) {
      mismatches.push({
        projection: "employee_ytd",
        key,
        side: "missing_in_rebuild",
        detail: `employee_ytd has gross ${row.p_gross} net ${row.p_net} and no posted run produces it`,
      });
      continue;
    }
    for (const column of COLUMNS) {
      const projected = row[`p_${column}` as const];
      const rebuilt = row[`r_${column}` as const];
      if (projected !== rebuilt) {
        mismatches.push({
          projection: "employee_ytd",
          key,
          side: "amount_differs",
          detail: `${column} ${projected} <> ${rebuilt}`,
        });
      }
    }
  }
  return mismatches;
}

/** 8C's member of 1B's registry (round 18 B5); registered in ./index.ts. */
export const EMPLOYEE_YTD_CHECK: ProjectionCheck = {
  name: "employee_ytd",
  run: (tx) => checkEmployeeYtdProjection(tx),
};
