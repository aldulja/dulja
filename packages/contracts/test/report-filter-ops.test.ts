import { REPORT_FILTER_OPS } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import { FILTER_OPS } from "../src/common";

describe("the filter-operator vocabulary is one list, spelled twice by the dependency rule", () => {
  it("@dulja/contracts' FILTER_OPS and @dulja/domain's REPORT_FILTER_OPS are equal, in order", () => {
    // §3.1 makes `packages/domain` import nothing internal, so the eight tokens §4.2.8 fixes for the API's
    // filter grammar and the eight §4.11.1 fixes for a ReportDefinition's dataset filters cannot be one
    // constant. `packages/contracts` imports `@dulja/domain`, so this is the one place they can meet — and
    // this assertion is what stops the two from drifting (hazard 9: one thing, one spelling).
    expect([...FILTER_OPS]).toEqual([...REPORT_FILTER_OPS]);
  });
});
