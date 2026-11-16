import type { Sql } from "postgres";

export interface EmployeeYtdMergeResult {
  /** How many (employee, tax_year) rows the MERGE inserted or updated. Zero for a non-PAYROLL document. */
  readonly rows: number;
}

/**
 * Contracts §4.3.2 **step 12**, the PAYROLL branch (§4.12.8, round 18 B6, ADR 0077): `MERGE` into `app.employee_ytd`
 * alongside `account_balance` and `stock_on_hand`, in the posting transaction (D14). The only writer of the table
 * (spec:98, `posting-only-tables`).
 *
 * Everything it aggregates comes from `app.employee_ytd_delta` — the same function the nightly rebuild calls — so the
 * maintained projection and its rebuild cannot disagree about how a total was derived. A document with no
 * `payroll_run` row (every type but `PAYROLL`) makes the function return zero rows, so `postDocument` calls this
 * unconditionally: no document-type branch, no HR import into the posting service. At step 12 the document is
 * `issued`, not yet `posted`; the delta function admits both for exactly this reason.
 *
 * The deltas are ADDED, never replaced: a `supplementary` run (ADR 0076 — the correction path) carries a difference
 * whose `net` may be negative, which is why the jsonb merge is arithmetic rather than `||`.
 *
 * FIRST it serialises on the keys it touches (round 18 B16 item 7, amendment A4's reasoning): `MERGE … WHEN NOT
 * MATCHED THEN INSERT` does not re-check the target on a concurrent insert, so two PAYROLL posts for one employee and
 * year would both take the NOT MATCHED branch and the second would raise 23505 at commit. Sorted keys, so two posts
 * whose employee sets overlap queue rather than deadlock; transaction-scoped, released at commit.
 *
 * Not idempotent: a second call for the same document adds its delta twice, which is why nothing but
 * `postDocument` may call it.
 */
export async function mergeEmployeeYtd(
  tx: Sql,
  documentId: string,
): Promise<EmployeeYtdMergeResult> {
  const keys = await tx<{ key: string }[]>`
    select d.company_id::text || '/' || d.employee_id::text || '/' || d.tax_year::text as key
      from app.employee_ytd_delta(${documentId}::uuid) d`;
  if (keys.length === 0) return { rows: 0 };
  for (const key of keys.map((k) => k.key).toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`ytd:${key}`}, 0))`;
  }

  const merged = await tx<{ employee_id: string }[]>`
    merge into app.employee_ytd y
    using (
      select app.current_tenant() as tenant_id, d.company_id, d.employee_id, d.tax_year,
             d.gross, d.net, d.by_component, d.by_scheme
        from app.employee_ytd_delta(${documentId}::uuid) d
    ) s
       on y.company_id = s.company_id and y.employee_id = s.employee_id and y.tax_year = s.tax_year
     when matched then update set
       gross        = y.gross + s.gross,
       net          = y.net + s.net,
       by_component = app.jsonb_add_money(y.by_component, s.by_component),
       by_scheme    = app.jsonb_add_scheme(y.by_scheme, s.by_scheme),
       updated_at   = now()
     when not matched then insert
       (tenant_id, company_id, employee_id, tax_year, gross, net, by_component, by_scheme)
       values (s.tenant_id, s.company_id, s.employee_id, s.tax_year, s.gross, s.net, s.by_component, s.by_scheme)
    returning y.employee_id`;
  return { rows: merged.length };
}
