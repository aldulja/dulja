import type { Sql } from "postgres";

export interface PeriodAwaitingClose {
  readonly fiscalPeriodId: string;
  readonly companyId: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface MonthEndReady {
  readonly fiscalPeriodId: string;
  readonly companyId: string;
  readonly endsOn: string;
  readonly ready: boolean;
  readonly summary: string;
}

/**
 * Every company's fiscal periods whose `ends_on` has passed and which are still `open` — the list the
 * month-end job walks (spec:1159 names "month-end close" as a pg-boss scheduled job). It resolves the
 * periods only; nothing here changes a status.
 */
export async function listPeriodsAwaitingClose(
  tx: Sql,
  opts: { asOf: string },
): Promise<PeriodAwaitingClose[]> {
  const rows = await tx<{ id: string; company_id: string; starts_on: string; ends_on: string }[]>`
    select p.id::text, p.company_id::text, p.starts_on::text, p.ends_on::text
      from app.fiscal_period p
     where p.status = 'open'
       and p.ends_on < ${opts.asOf}::date
     order by p.company_id, p.ends_on`;
  return rows.map((row) => ({
    fiscalPeriodId: row.id,
    companyId: row.company_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  }));
}

/**
 * Records that a period was checked and is (or is not) ready for a human to close under
 * `accounting.period.close`. Written into app.audit_log through `app.record_system_event` (migration 0105;
 * app_rw has no INSERT on the table itself — 0001 §8 revokes it) — the same tamper-evident chain every
 * other write goes into — so "the system said this period was clean on this date" is itself auditable
 * evidence and cannot be edited afterwards.
 *
 * This function, and the job that calls it, NEVER set fiscal_period.status. spec:2223 makes period close
 * "uniform for all roles"; it is a human act, and acceptance test 9 exercises exactly the job path that
 * must not be able to perform it.
 */
export async function recordMonthEndReady(
  tx: Sql,
  tenantId: string,
  entry: MonthEndReady,
): Promise<void> {
  // `tenantId` is the caller's statement of whose row this is; the function takes the tenant from the
  // session, so a mismatch is a bug worth failing on rather than a row silently filed under another tenant.
  const [row] = await tx<{ tenant: string }[]>`select app.current_tenant()::text as tenant`;
  if (row?.tenant !== tenantId) {
    throw new Error(`recordMonthEndReady: session tenant ${row?.tenant} is not ${tenantId}`);
  }
  await tx`
    select app.record_system_event('month_end_ready', ${entry.fiscalPeriodId}, ${JSON.stringify(entry)}::text::jsonb)`;
}
