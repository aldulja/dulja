import type { Sql } from "postgres";

/** One monthly period's bounds, as `YYYY-MM-DD` dates. */
export interface PeriodBounds {
  readonly startsOn: string;
  readonly endsOn: string;
}

/** UTC-only date arithmetic: a fiscal period is a calendar fact, never a moment. */
function monthBounds(year: number, monthIndex: number): PeriodBounds {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0)); // day 0 of the next month is the last of this one
  return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}

/** The twelve monthly periods of fiscal year `fiscalYear` starting in month `startMonth` (1–12). A year that starts
 *  after January runs into the next calendar year: fiscal year 2026 starting in July ends on 2027-06-30. */
export function fiscalYearBounds(fiscalYear: number, startMonth: number): PeriodBounds[] {
  return Array.from({ length: 12 }, (_, i) => monthBounds(fiscalYear, startMonth - 1 + i));
}

/** A period of the requested year overlaps an existing period whose bounds differ (ADR 0097). */
export class FiscalYearOverlapError extends Error {
  constructor(
    readonly requested: PeriodBounds,
    readonly existing: PeriodBounds,
  ) {
    super(
      `the period ${requested.startsOn}..${requested.endsOn} overlaps the existing period ` +
        `${existing.startsOn}..${existing.endsOn}`,
    );
    this.name = "FiscalYearOverlapError";
  }
}

export interface FiscalYearResult {
  /** The year's twelve period ids, in date order — the ones inserted and the ones that already existed. */
  readonly periodIds: string[];
  readonly inserted: number;
}

/**
 * Creates one company's fiscal year as twelve `open` monthly periods — the seed's `fiscal-periods` loader and
 * `POST /v1/companies/{companyId}/fiscal-years` both call this (ADR 0097), so there is one rule for a year.
 *
 * A period whose exact bounds already exist is kept as it is, whatever its status, which is what makes a repeat
 * change nothing. A period that overlaps an existing one with OTHER bounds is the exclusion constraint's case:
 * `overlap: "refuse"` (the route) throws `FiscalYearOverlapError` before any insert, so a refused year writes
 * nothing; `overlap: "skip"` (the seed, unchanged since 0C) inserts the rest and leaves the overlapping month out.
 *
 * **The conflict clause has no target on purpose.** `app.fiscal_period` carries no unique constraint on
 * `(company_id, starts_on)` — its guard is `exclude using gist (company_id with =, daterange(starts_on, ends_on,
 * '[]') with &&)`, and Postgres accepts an exclusion constraint as the arbiter of `ON CONFLICT DO NOTHING` only in
 * the targetless form. The explicit overlap read before it is the refusal path; the clause is the race backstop.
 */
export async function createFiscalYear(
  tx: Sql,
  companyId: string,
  input: { fiscalYear: number; startMonth: number; overlap: "refuse" | "skip" },
): Promise<FiscalYearResult> {
  const bounds = fiscalYearBounds(input.fiscalYear, input.startMonth);
  const first = bounds[0]!;
  const last = bounds[11]!;
  const existing = await tx<{ id: string; startsOn: string; endsOn: string }[]>`
    select id::text as id, starts_on::text as "startsOn", ends_on::text as "endsOn"
      from app.fiscal_period
     where company_id = ${companyId}::uuid
       and daterange(starts_on, ends_on, '[]') && daterange(${first.startsOn}::date, ${last.endsOn}::date, '[]')
     order by starts_on`;
  const exact = new Map(existing.map((p) => [`${p.startsOn}/${p.endsOn}`, p.id]));
  if (input.overlap === "refuse") {
    for (const wanted of bounds) {
      if (exact.has(`${wanted.startsOn}/${wanted.endsOn}`)) continue;
      const clash = existing.find(
        (p) => p.startsOn <= wanted.endsOn && p.endsOn >= wanted.startsOn,
      );
      if (clash) throw new FiscalYearOverlapError(wanted, clash);
    }
  }
  const periodIds: string[] = [];
  let inserted = 0;
  for (const { startsOn, endsOn } of bounds) {
    const kept = exact.get(`${startsOn}/${endsOn}`);
    if (kept) {
      periodIds.push(kept);
      continue;
    }
    const rows = await tx<{ id: string }[]>`
      insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on, status)
      values (app.current_tenant(), ${companyId}::uuid, ${startsOn}::date, ${endsOn}::date, 'open')
      on conflict do nothing
      returning id::text as id`;
    if (rows[0]) {
      periodIds.push(rows[0].id);
      inserted += 1;
    } else if (input.overlap === "refuse") {
      // A concurrent writer took the range between the read and the insert.
      throw new FiscalYearOverlapError({ startsOn, endsOn }, { startsOn, endsOn });
    }
  }
  return { periodIds, inserted };
}

/** The start month (1–12) of the company's earliest period, or null when it has none. */
export async function fiscalYearStartMonth(tx: Sql, companyId: string): Promise<number | null> {
  const [row] = await tx<{ month: number }[]>`
    select extract(month from starts_on)::int as month from app.fiscal_period
     where company_id = ${companyId}::uuid order by starts_on limit 1`;
  return row?.month ?? null;
}
