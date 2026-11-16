import type { Sql } from "postgres";

/** 8A, migration 0085 — §3.10.1 spec:2086 (proration) and spec:2088 (registrations). ⚠️ OD-23. */
export type ProrationRule = "calendar_days" | "working_days";

export interface CompanyHrSetting {
  companyId: string;
  prorationRule: ProrationRule;
  payDay: number | null;
}

/** The one row of a company, or null before anything is stored (the §2.12 default then applies). */
export async function readHrSetting(tx: Sql, companyId: string): Promise<CompanyHrSetting | null> {
  const [row] = await tx<
    { company_id: string; proration_rule: ProrationRule; pay_day: number | null }[]
  >`select company_id, proration_rule, pay_day from app.company_hr_setting where company_id = ${companyId}::uuid`;
  return row === undefined
    ? null
    : { companyId: row.company_id, prorationRule: row.proration_rule, payDay: row.pay_day };
}

/** At most one row per company (`unique (company_id)`); a second write replaces the two settings. */
export async function upsertHrSetting(tx: Sql, input: CompanyHrSetting): Promise<void> {
  await tx`
    insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
    select c.tenant_id, c.id, ${input.prorationRule}, ${input.payDay}::smallint
      from app.company c where c.id = ${input.companyId}::uuid
    on conflict (company_id) do update
      set proration_rule = excluded.proration_rule, pay_day = excluded.pay_day`;
}

/** Amendment A4's relational read: what the dropped jsonb "display copy" would have held, one row per scheme. */
export async function employerRegistrations(
  tx: Sql,
  companyId: string,
): Promise<{ schemeCode: string; registration: string | null }[]> {
  const rows = await tx<{ code: string; employer_registration: string | null }[]>`
    select code, employer_registration from app.statutory_scheme
     where company_id = ${companyId}::uuid order by code`;
  return rows.map((r) => ({ schemeCode: r.code, registration: r.employer_registration }));
}

/** The PRIMARY store (amendment A3): the scheme row. A caller that took the scheme id from a request binds it to
 *  its company first (the route does); RLS bounds the tenant only. */
export async function setEmployerRegistration(
  tx: Sql,
  schemeId: string,
  registration: string | null,
): Promise<void> {
  const res = await tx`
    update app.statutory_scheme set employer_registration = ${registration} where id = ${schemeId}::uuid`;
  if (res.count === 0)
    throw new Error(`statutory scheme ${schemeId} is not visible to this transaction`);
}
