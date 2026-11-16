import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import type { StatutoryScheduleResult } from "../../src/hr/schedule";
import { layoutFor, type EmployerIdentifiers } from "../../src/hr/schedule-layouts";
import { REPO_ROOT } from "../../../../tests/support/source";

// 8C T13 — ⚠️ OD-28, the statutory-schedule upload layouts (docs/owner/statutory-layouts/README.md). Every scheme's
// shape case is SKIPPED until the owner supplies both its published specification and an accepted example; until then
// the generic `scheduleCsv` (Task 7) is the layout in force and `layoutFor` answers null.

const SCHEMES = ["EPF", "SOCSO", "EIS", "PCB"] as const;
const MYR = currency("MYR");

/**
 * The fixture every layout is rendered against. **Every figure and every identifier here is INVENTED** (hazard 1,
 * hazard 2): no real rate, no real registration number, no real employee. The test compares the SHAPE of the output —
 * header, column count, delimiter, terminator — against the authority's accepted example, and a shape needs no real
 * numbers to be checked.
 */
const SYNTHETIC_SCHEDULE: StatutoryScheduleResult = {
  scheduleId: "00000000-0000-7000-8000-000000000001",
  companyId: "00000000-0000-7000-8000-000000000004",
  schemeId: "00000000-0000-7000-8000-000000000002",
  schemeCode: "SYNTH",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payrollDocumentId: "00000000-0000-7000-8000-000000000003",
  totalEmployee: Money.of("30.0000", MYR),
  totalEmployer: Money.of("60.0000", MYR),
  currency: MYR,
  attachmentId: null,
  remittanceDocumentId: null,
  rows: [
    {
      employeeId: "00000000-0000-7000-8000-000000000005",
      employeeNumber: "E-1",
      employeeName: "Synthetic, Employee One",
      schemeReference: "SYNTH-REF-0001",
      employeeShare: "10.0000",
      employerShare: "20.0000",
    },
    {
      employeeId: "00000000-0000-7000-8000-000000000006",
      employeeNumber: "E-2",
      employeeName: "Synthetic Employee Two",
      schemeReference: "SYNTH-REF-0002",
      employeeShare: "20.0000",
      employerShare: "40.0000",
    },
  ],
};

const SYNTHETIC_EMPLOYER: EmployerIdentifiers = { employerRegistration: "SYNTH-EMPLOYER-0001" };

for (const scheme of SCHEMES) {
  const dir = join(REPO_ROOT, "docs/owner/statutory-layouts", scheme);
  const example = join(dir, "accepted-example.csv");
  const spec = join(dir, "spec.md");
  const have = existsSync(example) && existsSync(spec);

  describe(scheme, () => {
    it.skipIf(!have)("renders a schedule in the shape of the authority's accepted example", () => {
      const layout = layoutFor(scheme);
      expect(layout, `no layout module for ${scheme} though its example is present`).not.toBeNull();
      const accepted = readFileSync(example, "utf8");
      const rendered = layout!.render(SYNTHETIC_SCHEDULE, SYNTHETIC_EMPLOYER);
      expect(rendered.split(/\r?\n/)[0]).toBe(accepted.split(/\r?\n/)[0]); // same header
      expect(rendered.split(/\r?\n/)[1]?.split(layout!.delimiter).length).toBe(
        accepted.split(/\r?\n/)[1]?.split(layout!.delimiter).length,
      ); // same column count
      expect(rendered.endsWith("\r\n")).toBe(accepted.endsWith("\r\n")); // same terminator
    });

    it("has no layout until the owner supplies the specification and an accepted example (OD-28)", () => {
      if (have) return;
      // The generic layout ships and the record is complete; only the upload shape is pending. A layout registered
      // without both files on disk is an unverified authority fact (hazard 1), and this is what refuses it.
      expect(layoutFor(scheme)).toBeNull();
    });
  });
}

describe("the registry", () => {
  it("answers null for a scheme it has never heard of, so scheduleCsv stays the fallback", () => {
    expect(layoutFor("SYNTH")).toBeNull();
  });
});
