import type { Sql } from "postgres";
import { createFiscalYear } from "../periods/fiscal-year";
import { readPackFile, type LoaderContext, type PackLoader } from "./packs";

interface CalendarSeed {
  readonly periodsPerYear: 12;
  readonly status: "open";
}

/**
 * spec:2001: "fiscal periods for the current year". Twelve calendar months from the owner's fiscal-year start
 * month (OWNER GATE OD-21, `--fiscal-year-start`), all `open`; closing and locking are 1A's.
 *
 * The year itself is `createFiscalYear` (ADR 0097), the one rule `POST /v1/companies/{companyId}/fiscal-years`
 * also applies. The seed keeps its 0C behaviour on an overlap — the overlapping month is left out, never refused —
 * so a re-run under a changed `--fiscal-year-start` still completes.
 */
export const fiscalPeriodsLoader: PackLoader = {
  name: "fiscal-periods",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    readPackFile<CalendarSeed>(ctx.packRoot, "fiscal-periods", "monthly.json");
    const { inserted } = await createFiscalYear(tx, ctx.companyId, {
      fiscalYear: ctx.config.fiscalYear,
      startMonth: ctx.config.fiscalYearStartMonth,
      overlap: "skip",
    });
    return inserted;
  },
};
