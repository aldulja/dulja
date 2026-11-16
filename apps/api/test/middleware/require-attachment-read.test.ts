import { describe, expect, it } from "vitest";
import { PERMISSION } from "@dulja/contracts/permissions";
import { MODULE_READ_CODE } from "../../src/middleware/require-attachment-read";

describe("the §4.5.8 download map — one row per slice, default deny", () => {
  it("maps POS attachments to the registered report reader — 6D", () => {
    expect(MODULE_READ_CODE.pos).toBe(PERMISSION["pos.report.read"]);
  });
  it("maps hr to hr.payroll.read, never to the accounting code — 8B (§4.5.8, §4.14)", () => {
    // PAYROLL, PAYROLL_PAYMENT and EMPLOYEE_ADVANCE are all `hr`: their attachments carry per-employee pay,
    // and resolving `hr` to the ledger read code is exactly the side channel test 32 exists to close.
    expect(MODULE_READ_CODE.hr).toBe(PERMISSION["hr.payroll.read"]);
    expect(MODULE_READ_CODE.hr).not.toBe(PERMISSION["accounting.ledger.read"]);
  });
  it("maps accounting to accounting.ledger.read — 2C's one row", () => {
    expect(MODULE_READ_CODE.accounting).toBe(PERMISSION["accounting.ledger.read"]);
  });

  it("denies a module by ABSENCE from the map, never by a fall-through default", () => {
    // Stated as a property, never as a key list. The rows arrive one per slice — 3A `inventory`,
    // 6D `pos`, 8B `hr` — and Phases 3, 6 and 8 may land in any order (spec:2301), so a case that
    // pinned `Object.keys(MODULE_READ_CODE)` to `["accounting"]` would have to be rewritten by
    // whichever of the three landed next. At 2C all three are absent; as each lands it drops out of
    // `absent` and this case stays true untouched.
    const absent = (["accounting", "inventory", "pos", "hr"] as const).filter(
      (m) => !(m in MODULE_READ_CODE),
    );
    for (const module of absent) expect(MODULE_READ_CODE[module]).toBeUndefined();
    // No row is ever an empty string either: `requireAttachmentRead`'s deny is `if (!code)`, so a
    // falsy row would read as a hit at the type level and as a deny at run time — the worst pair.
    expect(
      Object.values(MODULE_READ_CODE).every((c) => typeof c === "string" && c.length > 0),
    ).toBe(true);
  });

  it("every row present names a module of the union and a code the catalogue carries", () => {
    // At 2C a reference to the inventory stock read code is a compile error (§3.6.3), so the assertion is
    // against `PERMISSION` itself rather than against a literal table this file would have to grow.
    const catalogue = new Set<unknown>(Object.values(PERMISSION));
    for (const [module, code] of Object.entries(MODULE_READ_CODE)) {
      expect(["accounting", "inventory", "pos", "hr"]).toContain(module); // DocumentTypeModule, §4.3.4
      expect(typeof code).toBe("string");
      expect(catalogue.has(code)).toBe(true);
    }
  });
});
