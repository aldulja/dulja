import { describe, expect, it } from "vitest";
import {
  adminPermissions,
  ADMIN_EXCLUDED_CODES,
  ADMIN_EXCLUDED_PREFIXES,
  INCOMPATIBLE_PAIRS,
  ROLES,
} from "../seed/roles";

describe("the nine system role seeds", () => {
  it("uses the specification's nine role codes in order", () => {
    expect(ROLES.map((role) => role.code)).toEqual([
      "admin",
      "accountant",
      "user",
      "warehouse",
      "branch_manager",
      "cashier",
      "hr_payroll",
      "auditor",
      "pos_terminal",
    ]);
  });
  it("provides bilingual names and descriptions", () => {
    for (const role of ROLES) {
      expect(role.nameEn.length).toBeGreaterThan(0);
      expect(role.nameAr.length).toBeGreaterThan(0);
      expect(role.description.length).toBeGreaterThan(10);
    }
  });
  it("grants all eight non-admin roles as of 6C", () => {
    // Admin receives its permissions from the current catalogue at seed time.
    expect(ROLES.filter((role) => role.permissions.length > 0).map((role) => role.code)).toEqual([
      "accountant",
      "user",
      "warehouse",
      "branch_manager",
      "cashier",
      "hr_payroll",
      "auditor",
      "pos_terminal",
    ]);
  });
  it("gives the accountant every accounting code it holds except period.reopen (spec:2157)", () => {
    // The exact list grows slice by slice: 1A seeded the five accounting codes, 1B added report.read,
    // 2B added document.reverse, 3A the two inventory reads, 3B the costing read, 3C the two purchase
    // codes, 3D the one adjustment approval, 4A six of its seven AR/AP codes (never
    // payment.create — R6) and 4B bank reconciliation. period.reopen stays admin-only (R8).
    const accountant = ROLES.find((role) => role.code === "accountant")!;
    expect([...accountant.permissions].toSorted()).toEqual([
      "accounting.account.manage",
      // 4B — imports bank statements and matches or unmatches them (spec:2157); mutating, so never the auditor.
      "accounting.bank.reconcile",
      // 4A — the credit-limit override is exception authority (spec:2157); a second principal records it.
      "accounting.credit_limit.override",
      "accounting.document.reverse",
      "accounting.journal.create",
      "accounting.journal.post",
      "accounting.ledger.read",
      // 4A — approves and posts payments; never drafts one (R6, spec:2177).
      "accounting.payment.approve",
      "accounting.payment.post",
      "accounting.period.close",
      "accounting.purchase.create",
      "accounting.purchase.post",
      // 4A — receipts are created and posted by the same role: money in needs no maker-checker (spec:2147).
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.report.read",
      // 4A — posts sales invoices and sales credit notes.
      "accounting.sales.post",
      "accounting.tax.file",
      "accounting.tax.manage",
      // 8A — verifies statutory rate tables as the HR checker (spec:2160); never loads one (R6).
      // 8B — approves and posts payroll as the HR checker (spec:2157); never prepares a run (R6).
      "hr.payroll.approve",
      "hr.payroll.post",
      "hr.payroll.read",
      "hr.statutory_table.verify",
      // 3D — approves stock counts and write-offs, and never drafts one (R1, test 31).
      "inventory.adjustment.approve",
      "inventory.cost.read",
      "inventory.item.read",
      "inventory.stock.read",
    ]);
    expect(accountant.permissions).not.toContain("accounting.period.reopen");
  });
  it("gives the clerk drafting and party work, the auditor reads only (spec:2158, 2163)", () => {
    expect([...ROLES.find((role) => role.code === "user")!.permissions].toSorted()).toEqual([
      "accounting.journal.create",
      "accounting.party.manage",
      // 4A — the clerk drafts payments (and receipts, below) and posts neither (spec:2158).
      "accounting.payment.create",
      // 3C — the clerk drafts purchase documents and never posts one (spec:2159).
      "accounting.purchase.create",
      // 4A — the receipt half of the same drafting authority.
      "accounting.receipt.create",
      // 3D — the sales half of the same sentence: drafting only.
      "accounting.sales.create",
      "hr.employee.read",
      "inventory.item.read",
      "inventory.stock.read",
    ]);
    expect([...ROLES.find((role) => role.code === "auditor")!.permissions].toSorted()).toEqual([
      "accounting.ledger.read",
      // 7A — spec:2163 "Read everything financial … and export"; mutating: false, so R7 holds.
      "accounting.report.export",
      "accounting.report.read",
      "admin.audit_log.read",
      // 7C — the tenant data export (spec:2163 "… and export", spec:2186); mutating: false, so R7 holds.
      "admin.data.export",
      // 8B — the payroll register, posted lines only (spec:2163); mutating: false, so R7 holds.
      "hr.payroll.read",
      "inventory.cost.read",
      "inventory.item.read",
      "inventory.stock.read",
      "pos.report.read",
    ]);
  });
  it("8B: hr_payroll prepares, the accountant approves and posts, the auditor reads (spec:2157, 2162, 2163, R6)", () => {
    expect(holders("hr.payroll.read")).toEqual(["accountant", "auditor", "hr_payroll"]);
    expect(holders("hr.payroll.prepare")).toEqual(["hr_payroll"]);
    expect(holders("hr.payroll.approve")).toEqual(["accountant"]);
    expect(holders("hr.payroll.post")).toEqual(["accountant"]);
    // 8C (migration 0095) — the release and advance codes are the officer's; approval stays the accountant's.
    expect(holders("hr.payroll.pay")).toEqual(["hr_payroll"]);
    expect(holders("hr.advance.create")).toEqual(["hr_payroll"]);
    // 8D (migration 0097) — producing a filing from posted figures is the officer's alone.
    expect(holders("hr.filing.generate")).toEqual(["hr_payroll"]);
    // 8D Task 8 (migration 0096, ⚠️ OD-13 answered build) — the officer records and decides leave; R4 is per row.
    expect(holders("hr.leave.record")).toEqual(["hr_payroll"]);
    expect(holders("hr.leave.approve")).toEqual(["hr_payroll"]);
    // R6 — the pair INCOMPATIBLE_PAIRS has carried as strings since 0D is now live: no seeded role holds both.
    for (const role of ROLES) {
      const both =
        role.permissions.includes("hr.payroll.prepare") &&
        role.permissions.includes("hr.payroll.approve");
      expect(both, role.code).toBe(false);
    }
  });
  it("8A: hr_payroll loads and the accountant verifies; the auditor holds none of the six (spec:2160–2163)", () => {
    const sixCodes = [
      "hr.employee.read_sensitive",
      "hr.compensation.read",
      "hr.compensation.manage",
      "hr.pay_component.manage",
      "hr.statutory_table.manage",
      "hr.statutory_table.verify",
    ];
    for (const code of sixCodes.slice(0, 5)) expect(holders(code), code).toEqual(["hr_payroll"]);
    expect(holders("hr.statutory_table.verify")).toEqual(["accountant"]);
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    for (const code of sixCodes) expect(auditor.permissions, code).not.toContain(code);
  });
  it("the auditor alone is seeded with admin.data.export; admin gets it computed (spec:2163, §3.6.4)", () => {
    expect(holders("admin.data.export")).toEqual(["auditor"]);
    expect(adminPermissions(["admin.data.export"])).toEqual(["admin.data.export"]);
  });
  it("the auditor alone is seeded with accounting.report.export; admin gets it computed (spec:2163, §3.6.4)", () => {
    // The catalogue half — non-mutating, phase 7A, and R7 over PERMISSIONS — is in permission-catalogue.test.ts,
    // the one file dependency-rule lets import @dulja/contracts.
    expect(holders("accounting.report.export")).toEqual(["auditor"]);
    expect(adminPermissions(["accounting.report.export"])).toEqual(["accounting.report.export"]);
    expect(ROLES.find((role) => role.code === "admin")!.permissions).toEqual([]);
  });
  it("admin alone holds accounting.period.reopen (spec:2179 R8)", () => {
    // The catalogue is spelled out rather than imported: packages/db may not import @dulja/contracts
    // (dependency-rule), and the one carve-out is permission-catalogue.test.ts, which is where the
    // both-directions equality between app.permission and PERMISSIONS is asserted.
    expect(adminPermissions(["accounting.period.reopen"])).toContain("accounting.period.reopen");
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      expect(role.permissions).not.toContain("accounting.period.reopen");
  });
  it("computes admin grants from the catalogue", () => {
    const catalogue = [
      "admin.user.manage",
      "admin.role.manage",
      "admin.role.assign",
      "admin.company.manage",
      "admin.audit_log.read",
      "accounting.journal.post",
      "pos.ticket.sell",
      "pos.sync.pull",
      "pos.sync.push",
      "pos.ticket.void",
    ];
    expect(adminPermissions(catalogue)).toEqual([
      "admin.user.manage",
      "admin.role.manage",
      "admin.role.assign",
      "admin.company.manage",
      "admin.audit_log.read",
      "accounting.journal.post",
      "pos.ticket.void",
    ]);
    expect(ADMIN_EXCLUDED_CODES).toEqual(["pos.ticket.sell"]);
    expect(ADMIN_EXCLUDED_PREFIXES).toEqual(["pos.sync."]);
  });
  it("defines the four incompatible pairs", () => {
    expect(INCOMPATIBLE_PAIRS).toEqual([
      ["accounting.payment.create", "accounting.payment.approve"],
      ["hr.payroll.prepare", "hr.payroll.approve"],
      ["hr.statutory_table.manage", "hr.statutory_table.verify"],
      ["hr.employee.read_sensitive", "pos.ticket.sell"],
    ]);
  });
  it("limits terminal grants to the two sync codes introduced by 6A", () => {
    expect(ROLES.find((role) => role.code === "pos_terminal")?.permissions).toEqual([
      "pos.sync.pull",
      "pos.sync.push",
    ]);
  });
  it("never grants both sides of a pair to a non-admin role", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      for (const [left, right] of INCOMPATIBLE_PAIRS)
        expect(role.permissions.includes(left) && role.permissions.includes(right)).toBe(false);
  });
});

describe("the five inventory codes and their role grants — slice 3A (contracts §3.6.2, §3.6.4)", () => {
  // The catalogue-facing half of this task's assertions — module, phase and the mutating flags — lives in
  // packages/db/test/permission-catalogue.test.ts, the one file dependency-rule's ALLOW set lets import
  // @dulja/contracts. What is asserted here is the seed, which is local to this workspace.
  it("the two reads are granted to exactly the five roles spec:2157-2163 gives catalogue and stock visibility", () => {
    for (const code of ["inventory.item.read", "inventory.stock.read"])
      expect(
        ROLES.filter((role) => role.permissions.includes(code))
          .map((role) => role.code)
          .toSorted(),
        code,
      ).toEqual(["accountant", "auditor", "branch_manager", "user", "warehouse"]);
  });

  it("no seeded role holds item.manage, price.manage or negative_stock.override — only computed admin does", () => {
    // spec:2159 warehouse "May not: Prices, item master"; spec:2160 branch_manager "May not: Prices, item
    // master or credit terms (head office owns the catalogue)". Nothing in the spec's table gives a named
    // role the catalogue write or the negative-stock override, so nothing here does either.
    for (const code of [
      "inventory.item.manage",
      "inventory.price.manage",
      "inventory.negative_stock.override",
    ])
      expect(
        ROLES.filter((role) => role.code !== "admin").some((role) =>
          role.permissions.includes(code),
        ),
        code,
      ).toBe(false);
    const admin = adminPermissions([
      "inventory.item.read",
      "inventory.item.manage",
      "inventory.price.manage",
      "inventory.stock.read",
      "inventory.negative_stock.override",
    ]);
    expect(admin).toContain("inventory.negative_stock.override");
    expect(admin).toContain("inventory.price.manage");
  });

  it("no INCOMPATIBLE_PAIRS entry is created by these grants (R6)", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      for (const [left, right] of INCOMPATIBLE_PAIRS)
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} ${left}+${right}`,
        ).toBe(false);
  });
});

describe("the costing code's role grants — slice 3B (contracts §3.6.2, §3.6.4)", () => {
  // The catalogue-facing half — module, phase and the mutating flag — lives in
  // packages/db/test/permission-catalogue.test.ts, the one file dependency-rule's ALLOW set lets import
  // @dulja/contracts. What is asserted here is the seed, which is local to this workspace.
  it("inventory.cost.read goes to exactly accountant and auditor", () => {
    // spec:2157 gives the accountant costing; spec:2163 gives the auditor "Read everything financial: …
    // stock and costs", which also fixes that "costs" in the role table means SIGHT of costs. The other
    // three are refused it by name (code review 2, S1b): spec:2158 `user` "May not: … see costs";
    // spec:2159 `warehouse` "May not: Prices, costs, …"; spec:2160 `branch_manager` "May not: Prices, …;
    // costs; …". The earlier comment here — that spec:2159/2160 give the warehouse and the branch manager
    // stock and margin for their branch — misquoted both rows; that phrase is spec:1022's, a capability
    // row that names no role.
    expect(
      ROLES.filter((role) => role.permissions.includes("inventory.cost.read"))
        .map((role) => role.code)
        .toSorted(),
    ).toEqual(["accountant", "auditor"]);
    for (const code of ["user", "warehouse", "branch_manager"])
      expect(ROLES.find((role) => role.code === code)!.permissions, code).not.toContain(
        "inventory.cost.read",
      );
  });

  it("admin receives it through the computed grant, not a seeded entry", () => {
    expect(adminPermissions(["inventory.cost.read"])).toEqual(["inventory.cost.read"]);
    expect(ROLES.find((role) => role.code === "admin")!.permissions).toEqual([]);
  });

  it("creates no INCOMPATIBLE_PAIRS entry (R6)", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      for (const [left, right] of INCOMPATIBLE_PAIRS)
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} ${left}+${right}`,
        ).toBe(false);
  });
});

describe("the four purchasing codes' role grants — slice 3C (contracts §3.6.2, §3.6.4)", () => {
  // The catalogue-facing half — module, phase and the mutating flags — lives in
  // packages/db/test/permission-catalogue.test.ts, the one file dependency-rule's ALLOW set lets import
  // @dulja/contracts. What is asserted here is the seed, which is local to this workspace.
  it("accounting.purchase.create goes to accountant and user; .post to accountant alone (spec:2159)", () => {
    expect(
      ROLES.filter((role) => role.permissions.includes("accounting.purchase.create"))
        .map((role) => role.code)
        .toSorted(),
    ).toEqual(["accountant", "user"]);
    expect(
      ROLES.filter((role) => role.permissions.includes("accounting.purchase.post")).map(
        (role) => role.code,
      ),
    ).toEqual(["accountant"]);
  });

  it("both inventory.receipt codes go to warehouse alone — not accountant, not branch_manager", () => {
    // spec:2159 "Receive against purchase documents … post receipts and transfers — quantities only" is
    // the warehouse row. The branch manager's "receiving transfers" is 3D's inventory.transfer.*, and the
    // accountant's row gives it purchase documents, not receipts.
    for (const code of ["inventory.receipt.create", "inventory.receipt.post"]) {
      expect(
        ROLES.filter((role) => role.permissions.includes(code)).map((role) => role.code),
        code,
      ).toEqual(["warehouse"]);
    }
    const accountant = ROLES.find((role) => role.code === "accountant")!;
    const branchManager = ROLES.find((role) => role.code === "branch_manager")!;
    for (const code of ["inventory.receipt.create", "inventory.receipt.post"]) {
      expect(accountant.permissions, code).not.toContain(code);
      expect(branchManager.permissions, code).not.toContain(code);
    }
    expect(branchManager.permissions).not.toContain("accounting.purchase.create");
    expect(branchManager.permissions).not.toContain("accounting.purchase.post");
  });

  it("the auditor receives none of the four — every one is mutating (R7, spec:2178)", () => {
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    for (const code of [
      "accounting.purchase.create",
      "accounting.purchase.post",
      "inventory.receipt.create",
      "inventory.receipt.post",
    ])
      expect(auditor.permissions, code).not.toContain(code);
  });

  it("admin receives all four through the computed grant, not a seeded entry", () => {
    expect(
      adminPermissions([
        "accounting.purchase.create",
        "accounting.purchase.post",
        "inventory.receipt.create",
        "inventory.receipt.post",
      ]),
    ).toEqual([
      "accounting.purchase.create",
      "accounting.purchase.post",
      "inventory.receipt.create",
      "inventory.receipt.post",
    ]);
    expect(ROLES.find((role) => role.code === "admin")!.permissions).toEqual([]);
  });

  it("creates no INCOMPATIBLE_PAIRS entry (R6)", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      for (const [left, right] of INCOMPATIBLE_PAIRS)
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} ${left}+${right}`,
        ).toBe(false);
  });
});

/** The seeded non-admin roles holding one code, sorted. Hoisted out of the describe below: oxlint's
 *  `unicorn/consistent-function-scoping` refuses a nested function that captures nothing. */
function holders(code: string): string[] {
  return ROLES.filter((role) => role.code !== "admin" && role.permissions.includes(code))
    .map((role) => role.code)
    .toSorted();
}

describe("the seven AR/AP codes' role grants — slice 4A (contracts §3.6.2, §3.6.4)", () => {
  // The catalogue-facing half — module, phase and the mutating flags — lives in
  // packages/db/test/permission-catalogue.test.ts, the one file dependency-rule's ALLOW set lets import
  // @dulja/contracts. What is asserted here is the seed, which is local to this workspace.
  it("accountant posts sales and receipts and approves and posts payments (spec:2157)", () => {
    for (const code of [
      "accounting.sales.post",
      "accounting.receipt.post",
      "accounting.payment.approve",
      "accounting.payment.post",
    ])
      expect(holders(code), code).toEqual(["accountant"]);
  });

  it("the two create codes: receipts by accountant and user, payments by user alone (spec:2157–2158, R6)", () => {
    expect(holders("accounting.receipt.create")).toEqual(["accountant", "user"]);
    expect(holders("accounting.payment.create")).toEqual(["user"]);
  });

  it("accounting.credit_limit.override goes to accountant and nobody else in the seed (spec:2158)", () => {
    expect(holders("accounting.credit_limit.override")).toEqual(["accountant"]);
  });

  it("the payment pair is now a live R6 pair and no seeded role holds both halves", () => {
    expect(INCOMPATIBLE_PAIRS).toContainEqual([
      "accounting.payment.create",
      "accounting.payment.approve",
    ]);
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      for (const [left, right] of INCOMPATIBLE_PAIRS)
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} ${left}+${right}`,
        ).toBe(false);
  });

  it("admin receives all seven through the computed grant, not a seeded entry", () => {
    const codes = [
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.payment.create",
      "accounting.payment.approve",
      "accounting.payment.post",
      "accounting.credit_limit.override",
    ];
    expect(adminPermissions(codes)).toEqual(codes);
    expect(ROLES.find((role) => role.code === "admin")!.permissions).toEqual([]);
  });
});
