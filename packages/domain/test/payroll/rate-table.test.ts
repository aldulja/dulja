import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseRateTable, RateTableValidationError, validateRateTable } from "../../payroll";
import { generateRateTableType } from "../../scripts/generate-rate-table-type";

/** Invented figures (hazard 1): the shape of §4.12.4's synthetic table, not a rate of any authority. */
const BANDED = {
  schema_version: 1,
  scheme: "SYNTH",
  version: 1,
  kind: "banded_contribution",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "§4.12.4",
    url: "https://dulja.invalid/x",
    retrieved_on: "2026-01-01",
  },
  verification: {
    verified_by: "Dulja test fixture",
    verified_on: "2026-01-01",
    method: "synthetic_test",
  },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  required_profile_fields: [],
  table: { bands: [{ from: "0.0000", to: "1000.0000", employee: "10.0000", employer: "20.0000" }] },
};

describe("packages/domain/payroll — the rate-table schema (§4.12.3)", () => {
  it("accepts the three shapes the schema admits, and only those", () => {
    expect(validateRateTable(BANDED).ok).toBe(true);
    expect(
      validateRateTable({
        ...BANDED,
        kind: "percentage_with_ceiling",
        table: {
          employee_rate: "0.0100",
          employer_rate: "0.0200",
          ceiling: "9999.0000",
          floor: null,
        },
      }).ok,
    ).toBe(true);
    expect(
      validateRateTable({
        ...BANDED,
        kind: "progressive_schedule",
        table: {
          brackets: [{ from: "0.0000", to: "1000.0000", rate: "0.0100", cumulative: "0.0000" }],
          reliefs: { self: "100.0000" },
        },
      }).ok,
    ).toBe(true);
    expect(validateRateTable({ ...BANDED, kind: "flat_amount" }).ok).toBe(false);
  });

  it("every figure is a decimal STRING — a JSON number is refused (§4.12.3, hazard 4)", () => {
    const numeric = {
      ...BANDED,
      table: { bands: [{ from: 0, to: 1000, employee: 10, employer: 20 }] },
    };
    const v = validateRateTable(numeric);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toContain("/table/bands/0/from");
  });

  it("the schema file itself declares no `number` type anywhere (hazard 4)", async () => {
    const raw = await readFile(
      new URL("../../payroll/rate-table.schema.json", import.meta.url),
      "utf8",
    );
    expect([...raw.matchAll(/"type"\s*:\s*"number"/g)]).toHaveLength(0);
  });

  it("source is required with all four of its members — a table with no provenance is refused (LEGACY-078)", () => {
    const { source, ...noSource } = BANDED;
    expect(source).toBeTruthy();
    expect(validateRateTable(noSource).ok).toBe(false);
    expect(validateRateTable({ ...BANDED, source: { authority: "X" } }).ok).toBe(false);
  });

  it("the declared formats are enforced: a date that does not exist and a url with no scheme are refused", () => {
    const badDate = validateRateTable({ ...BANDED, effective_from: "2026-02-30" });
    expect(badDate.errors.map((e) => e.path)).toContain("/effective_from");
    const badUrl = validateRateTable({ ...BANDED, source: { ...BANDED.source, url: "not a url" } });
    expect(badUrl.errors.map((e) => e.path)).toContain("/source/url");
  });

  it("an unknown property anywhere is refused — additionalProperties is false at every level", () => {
    expect(validateRateTable({ ...BANDED, surprise: 1 }).ok).toBe(false);
    expect(
      validateRateTable({
        ...BANDED,
        table: {
          bands: [{ from: "0.0000", to: null, employee: "1.0000", employer: "1.0000", extra: "x" }],
        },
      }).ok,
    ).toBe(false);
  });

  it("parseRateTable throws with JSON-Pointer paths, never `any`", () => {
    let caught: unknown;
    try {
      parseRateTable({ schema_version: 2 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateTableValidationError);
    expect((caught as RateTableValidationError).errors[0]!.path).toMatch(/^\//);
    expect(parseRateTable(BANDED).scheme).toBe("SYNTH");
  });

  it("the committed type is in sync with the schema (the 1A drift-guard pattern)", async () => {
    const onDisk = await readFile(new URL("../../payroll/rate-table.ts", import.meta.url), "utf8");
    expect((await generateRateTableType()).replace(/\r\n/g, "\n")).toBe(
      onDisk.replace(/\r\n/g, "\n"),
    );
  });
});
