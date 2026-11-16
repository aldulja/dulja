import { describe, expect, it } from "vitest";
import { ADMIN_EXCLUDED_CODES, ADMIN_EXCLUDED_PREFIXES, INCOMPATIBLE_PAIRS } from "../seed/roles";
import {
  CEILING_EXEMPT_CODES,
  CEILING_EXEMPT_PREFIXES,
  incompatiblePairsIn,
  isCeilingExempt,
  RUNTIME_INCOMPATIBLE_PAIRS,
} from "../src/rbac/role-ceiling";

// ADR 0091. The serving image ships nothing under packages/db/seed, so role-ceiling.ts keeps runtime copies of three
// seed lists. This is the guard that they never drift from their source.
describe("the role-administration ceiling's lists match the seed (ADR 0091)", () => {
  it("R6's pairs and the admin-excluded codes are the seed's, exactly", () => {
    expect(RUNTIME_INCOMPATIBLE_PAIRS).toEqual(INCOMPATIBLE_PAIRS);
    expect(CEILING_EXEMPT_CODES).toEqual(ADMIN_EXCLUDED_CODES);
    expect(CEILING_EXEMPT_PREFIXES).toEqual(ADMIN_EXCLUDED_PREFIXES);
  });

  it("exempts only the till's codes, and finds a pair in either order", () => {
    expect(isCeilingExempt("pos.ticket.sell")).toBe(true);
    expect(isCeilingExempt("pos.sync.push")).toBe(true);
    expect(isCeilingExempt("admin.role.assign")).toBe(false);
    expect(
      incompatiblePairsIn(["accounting.payment.approve", "accounting.payment.create"]),
    ).toEqual([["accounting.payment.create", "accounting.payment.approve"]]);
    expect(incompatiblePairsIn(["accounting.payment.create"])).toEqual([]);
  });
});
