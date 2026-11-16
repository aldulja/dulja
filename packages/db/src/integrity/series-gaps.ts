import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

/**
 * The numbering half of the nightly integrity run (contracts §4.5.5: "the 1B integrity job reports any
 * non-empty result"; ADR 0030). It walks every counter the tenant owns and asks `app.series_gaps` for the
 * numbers the counter has advanced past that no document and no void explains.
 *
 * It reports through `ProjectionMismatch` because that is the shape `registerProjectionCheck` accepts:
 * `projection` is the counter table, and `missing_in_projection` reads as "the number is missing from the set
 * of documents and voids that should explain it". A dedicated `numberingGaps` member on `IntegrityReport`
 * would read better and is recorded in ADR 0030 as a later amendment to contracts §4.16.3.
 */
export const SERIES_GAP_CHECK: ProjectionCheck = {
  name: "document_series",
  async run(tx: Sql): Promise<ProjectionMismatch[]> {
    const counters = await tx<{ company_id: string; series: string; fiscal_period_id: string }[]>`
      select company_id, series, fiscal_period_id from app.document_series
       order by company_id, series, fiscal_period_id`;
    const mismatches: ProjectionMismatch[] = [];
    for (const c of counters) {
      const gaps = await tx<{ number: string }[]>`
        select number::text as number
          from app.series_gaps(${c.company_id}, ${c.series}, ${c.fiscal_period_id}) order by 1`;
      for (const g of gaps) {
        mismatches.push({
          projection: "document_series",
          key: {
            company_id: c.company_id,
            series: c.series,
            fiscal_period_id: c.fiscal_period_id,
            number: g.number,
          },
          side: "missing_in_projection",
          detail: `number ${g.number} of series ${c.series} is neither an issued document nor a recorded void (spec:2222, SAH-051)`,
        });
      }
    }
    return mismatches;
  },
};
