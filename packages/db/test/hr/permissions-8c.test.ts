import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { startDb, type Db } from "../harness";

// 8C T4 — migration 0095 and the role grants (§3.6.2, §3.6.4). The catalogue half — the two `PermissionDef` rows
// against permissions.ts — lives in permission-catalogue.test.ts's 8C block: a packages/db test other than that file
// may not import @dulja/contracts (dependency-rule; round 18 B16 item 3). This file reads app.permission and ROLES.

let db: Db;
beforeAll(async () => {
  db = await startDb();
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const CODES = ["hr.payroll.pay", "hr.advance.create"] as const;

describe("8C's two permission codes (§3.6.2)", () => {
  it("app.permission carries both, in module hr, mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...CODES]}) order by code`;
    expect(rows).toEqual([
      { code: "hr.advance.create", module: "hr", mutating: true },
      { code: "hr.payroll.pay", module: "hr", mutating: true },
    ]);
  });

  it("hr_payroll holds both; the auditor holds neither (R7); no seeded role holds an R6 pair", () => {
    const hr = ROLES.find((r) => r.code === "hr_payroll")!;
    expect(hr.permissions).toContain("hr.payroll.pay");
    expect(hr.permissions).toContain("hr.advance.create");
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    for (const code of CODES) expect(auditor.permissions).not.toContain(code);

    for (const role of ROLES) {
      if (role.code === "admin") continue; // R6 exempts admin (spec:2177)
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`,
        ).toBe(false);
      }
    }
  });

  it("hr_payroll does NOT gain accounting.payment.approve or .post — R1 separates release from approval", () => {
    // spec:2082 chose Phase 4's money-out machinery so payroll money leaves the bank under the same two-person
    // control as every other payment: the officer releases, the accountant approves and posts.
    const hr = ROLES.find((r) => r.code === "hr_payroll")!;
    expect(hr.permissions).not.toContain("accounting.payment.approve");
    expect(hr.permissions).not.toContain("accounting.payment.post");
    const accountant = ROLES.find((r) => r.code === "accountant")!;
    expect(accountant.permissions).toContain("accounting.payment.approve");
    expect(accountant.permissions).toContain("accounting.payment.post");
    for (const code of CODES) expect(accountant.permissions).not.toContain(code);
  });
});
