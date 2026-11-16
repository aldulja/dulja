import type { RateTableKind, SchemeCalculator } from "../types";
import { bandedContribution } from "./banded-contribution";
import { percentageWithCeiling } from "./percentage-with-ceiling";
import { progressiveSchedule } from "./progressive-schedule";

/** Exactly the three kinds §4.12.3's `kind` enum admits. A fourth is a schema change, not a code change. */
export const calculators: Readonly<Record<RateTableKind, SchemeCalculator>> = {
  banded_contribution: bandedContribution,
  percentage_with_ceiling: percentageWithCeiling,
  progressive_schedule: progressiveSchedule,
};
