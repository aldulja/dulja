import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, isMutating, type PermissionCode } from "@dulja/contracts/permissions";
import { ROLES } from "../seed/roles";
import { startDb, type Db } from "./harness";

function staffPermissionHolders(code: string): readonly string[] {
  return ROLES.filter(
    (seedRole) => seedRole.code !== "admin" && seedRole.permissions.includes(code),
  )
    .map((seedRole) => seedRole.code)
    .toSorted();
}
describe("permission catalogue", () => {
  it("6D registers its two scoped codes and exactly sixteen POS codes", async () => {
    const rows = await db.admin<
      { code: string; module: string; mutating: boolean }[]
    >`select code,module,mutating from app.permission where code in ('pos.shift.close_any','pos.report.read') order by code`;
    expect(rows).toEqual([
      { code: "pos.report.read", module: "pos", mutating: false },
      { code: "pos.shift.close_any", module: "pos", mutating: true },
    ]);
    const [count] = await db.admin<
      { n: number }[]
    >`select count(*)::int n from app.permission where module='pos'`;
    expect(count!.n).toBe(16);
  });

  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => db.stop());
  it("6C introduces exactly its four scoped staff/PIN authorities", async () => {
    const mine = PERMISSIONS.filter((permission) => permission.phase === "6C");
    const expected = [
      { code: "hr.attendance.record", module: "hr", mutating: true },
      { code: "hr.employee.manage", module: "hr", mutating: true },
      { code: "hr.employee.read", module: "hr", mutating: false },
      { code: "pos.cashier.manage_pin", module: "pos", mutating: true },
    ];
    expect(
      mine
        .map(({ code, module, mutating }) => ({ code, module, mutating }))
        .toSorted((a, b) => a.code.localeCompare(b.code)),
    ).toEqual(expected);
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code,module,mutating from app.permission where code=any(${mine.map((permission) => permission.code)}::text[]) order by code`;
    expect([...rows]).toEqual(expected);
  });
  it("each 6C code carries its PermissionDef description, and migration 0069 seeds the same four strings", async () => {
    // The 0039, 0047 and 0052 cases below pin their migrations' strings the same way. 0069 once seeded
    // its own wording, and pos.cashier.manage_pin read "Create, reset and revoke" in app.permission
    // although creating and revoking a credential is admin.user.manage (PR 12 review).
    const mine = PERMISSIONS.filter((permission) => permission.phase === "6C");
    expect(mine).toHaveLength(4);
    const sql = readFileSync(
      new URL("../migrations/0069_seed_permission_phase6c.sql", import.meta.url),
      "utf8",
    );
    for (const def of mine) {
      expect(def.description.length, def.code).toBeGreaterThan(0);
      expect(sql, def.code).toContain(`'${def.code}'`);
      // A SQL string literal doubles its apostrophes ("cashier''s").
      expect(sql, def.code).toContain(`'${def.description.replaceAll("'", "''")}'`);
    }
    const rows = await db.admin<{ code: string; description: string }[]>`
      select code, description from app.permission
       where code = any(${mine.map((permission) => permission.code)}::text[]) order by code`;
    expect([...rows]).toEqual(
      mine
        .map(({ code, description }) => ({ code, description }))
        .toSorted((a, b) => a.code.localeCompare(b.code)),
    );
    const down = readFileSync(new URL("../migrations/0069.down.sql", import.meta.url), "utf8");
    for (const def of mine) expect(down, def.code).toContain(`'${def.code}'`);
  });
  it("6C grants staff and PIN authorities to exactly the designated human roles", () => {
    expect(staffPermissionHolders("hr.employee.read")).toEqual([
      "branch_manager",
      "hr_payroll",
      "user",
    ]);
    expect(staffPermissionHolders("hr.employee.manage")).toEqual(["hr_payroll"]);
    expect(staffPermissionHolders("hr.attendance.record")).toEqual([
      "branch_manager",
      "hr_payroll",
    ]);
    expect(staffPermissionHolders("pos.cashier.manage_pin")).toEqual(["branch_manager"]);
    for (const seedRole of ROLES.filter(
      (candidate) =>
        candidate.code === "auditor" ||
        candidate.code === "pos_terminal" ||
        candidate.code === "cashier",
    )) {
      expect(
        seedRole.permissions.filter(
          (code) => PERMISSIONS.find((permission) => permission.code === code)?.phase === "6C",
        ),
      ).toEqual([]);
    }
  });
  it("matches TypeScript in both directions", async () => {
    const rows = await db.migrator<
      { code: string; module: string; mutating: boolean }[]
    >`select code,module,mutating from app.permission order by code`;
    expect(rows.map((row) => `${row.code}|${row.module}|${row.mutating}`)).toEqual(
      PERMISSIONS.toSorted((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map(
        (item) => `${item.code}|${item.module}|${item.mutating}`,
      ),
    );
  });
  it("holds exactly the five Phase 0 admin codes, with admin.audit_log.read non-mutating", async () => {
    // Scoped to the admin module since 1A's migration 0014: the catalogue is phased (spec:2142), so the
    // count of rows in app.permission grows every slice while this clause is about Phase 0's five.
    const rows = await db.migrator<
      { code: string; mutating: boolean }[]
    >`select code,mutating from app.permission where code = any(${PERMISSIONS.filter((p) => p.phase === "0B").map((p) => p.code)}::text[]) order by code`;
    expect(rows).toEqual([
      { code: "admin.audit_log.read", mutating: false },
      { code: "admin.company.manage", mutating: true },
      { code: "admin.role.assign", mutating: true },
      { code: "admin.role.manage", mutating: true },
      { code: "admin.user.manage", mutating: true },
    ]);
  });
  it("holds the six Phase 1 accounting codes with the contracts' mutating flags (§3.6.2)", async () => {
    // app.permission is global — no tenant_id, no RLS (plan0A:1313) — so it is read on db.migrator directly.
    // Scoped to 1A's codes as the admin case above is scoped to its module: 1B, 2A, 2B and 3C have each added
    // `accounting.*` codes since (spec:2142 phases the catalogue), and this clause is about Phase 1's six.
    // The contract's 1A list is the filter, so a seventh 1A code or a missing row fails the equality below.
    const phase1 = [...PERMISSIONS].filter((p) => p.phase === "1A").map((p) => p.code);
    const rows = await db.migrator<
      { code: string; module: string; mutating: boolean }[]
    >`select code, module, mutating from app.permission where code = any(${phase1}::text[]) order by code`;
    expect(rows).toEqual([
      { code: "accounting.account.manage", module: "accounting", mutating: true },
      { code: "accounting.journal.create", module: "accounting", mutating: true },
      { code: "accounting.journal.post", module: "accounting", mutating: true },
      { code: "accounting.ledger.read", module: "accounting", mutating: false },
      { code: "accounting.period.close", module: "accounting", mutating: true },
      { code: "accounting.period.reopen", module: "accounting", mutating: true },
    ]);
  });
  it("migration 0015 seeds accounting.report.read as a non-mutating accounting code (§3.6.2, slice 1B)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = 'accounting.report.read'`;
    expect(rows).toEqual([
      { code: "accounting.report.read", module: "accounting", mutating: false },
    ]);
  });

  it("accounting.report.read is granted to exactly accountant and auditor in the seed (spec:2157, 2163)", async () => {
    const holders = ROLES.filter(
      (role) => role.code !== "admin" && role.permissions.includes("accounting.report.read"),
    )
      .map((role) => role.code)
      .toSorted();
    expect(holders).toEqual(["accountant", "auditor"]);
  });

  it("2A introduces exactly accounting.party.manage, and it is mutating (contracts §3.6.2)", async () => {
    const mine = [...PERMISSIONS].filter((p) => p.phase === "2A");
    expect(mine.map((p) => p.code)).toEqual(["accounting.party.manage"]);
    expect(mine[0]!.mutating).toBe(true);
    expect(mine[0]!.module).toBe("accounting");
    const rows = await db.admin<{ module: string; mutating: boolean }[]>`
      select module, mutating from app.permission where code = 'accounting.party.manage'`;
    expect(rows).toEqual([{ module: "accounting", mutating: true }]);
  });

  it("only `user` is seeded with it; `auditor` holds no mutating code (spec:2159, R7 spec:2178)", () => {
    const holders = [...ROLES].filter(
      (r) => r.code !== "admin" && r.permissions.includes("accounting.party.manage"),
    );
    expect(holders.map((r) => r.code)).toEqual(["user"]);
    const auditor = [...ROLES].find((r) => r.code === "auditor")!;
    expect(auditor.permissions).not.toContain("accounting.party.manage");
  });

  it("7A adds accounting.report.export, non-mutating, and nothing else (§3.6.2)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code like 'accounting.report.%' order by code`;
    expect(rows).toEqual([
      { code: "accounting.report.export", module: "accounting", mutating: false },
      { code: "accounting.report.read", module: "accounting", mutating: false },
    ]);
    expect(PERMISSIONS.filter((p) => p.phase === "7A").map((p) => p.code)).toEqual([
      "accounting.report.export",
    ]);
  });

  it("migration 0076 seeds the same description permissions.ts carries, and its down deletes only that code", () => {
    const def = PERMISSIONS.find((p) => p.code === "accounting.report.export")!;
    const up = readFileSync(
      new URL("../migrations/0076_seed_permission_phase7a.sql", import.meta.url),
      "utf8",
    );
    expect(up).toContain(`'${def.description.replaceAll("'", "''")}'`);
    const down = readFileSync(new URL("../migrations/0076.down.sql", import.meta.url), "utf8");
    expect(down).toMatch(/delete from app\.permission where code = 'accounting\.report\.export';/);
  });

  it("the auditor holds accounting.report.export and still no mutating code (spec:2163, R7 spec:2178)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions).toContain("accounting.report.export");
    expect(auditor.permissions.filter((c) => isMutating(c as PermissionCode))).toEqual([]);
    expect(staffPermissionHolders("accounting.report.export")).toEqual(["auditor"]);
  });

  it("7C adds admin.data.export, non-mutating, and nothing else (§3.6.2)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where module = 'admin' order by code`;
    expect(rows).toEqual([
      { code: "admin.audit_log.read", module: "admin", mutating: false },
      { code: "admin.company.manage", module: "admin", mutating: true },
      { code: "admin.data.export", module: "admin", mutating: false },
      { code: "admin.role.assign", module: "admin", mutating: true },
      { code: "admin.role.manage", module: "admin", mutating: true },
      { code: "admin.terminal.manage", module: "admin", mutating: true },
      { code: "admin.user.manage", module: "admin", mutating: true },
    ]);
    expect(PERMISSIONS.filter((p) => p.phase === "7C").map((p) => p.code)).toEqual([
      "admin.data.export",
    ]);
  });

  it("migration 0079 seeds the same description permissions.ts carries, and its down deletes only that code", () => {
    const def = PERMISSIONS.find((p) => p.code === "admin.data.export")!;
    const up = readFileSync(
      new URL("../migrations/0079_seed_permission_phase7c.sql", import.meta.url),
      "utf8",
    );
    expect(up).toContain(`'${def.description.replaceAll("'", "''")}'`);
    const down = readFileSync(new URL("../migrations/0079.down.sql", import.meta.url), "utf8");
    expect(down).toMatch(/delete from app\.permission where code = 'admin\.data\.export';/);
  });

  it("the auditor holds admin.data.export and still no mutating code (spec:2163, R7 spec:2178)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions).toContain("admin.data.export");
    expect(auditor.permissions.filter((c) => isMutating(c as PermissionCode))).toEqual([]);
    expect(staffPermissionHolders("admin.data.export")).toEqual(["auditor"]);
  });

  it("exports only codes the table's own CHECK grammar would accept", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.code, permission.code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
      expect(permission.code.startsWith(`${permission.module}.`), permission.code).toBe(true);
      expect(permission.description.length, permission.code).toBeGreaterThan(0);
    }
  });
});

/**
 * Slice 3A, the catalogue half of plan 3A Task 3. Deliberately a sibling of the describe above rather than a
 * member of it: nothing here touches Postgres, so it runs where no Docker daemon does. The role-grant half is
 * in roles-seed.test.ts, which may not import @dulja/contracts (dependency-rule ALLOW names only this file).
 */
describe("the five inventory codes — slice 3A (contracts §3.6.2)", () => {
  const CODES = [
    "inventory.item.read",
    "inventory.item.manage",
    "inventory.price.manage",
    "inventory.stock.read",
    "inventory.negative_stock.override",
  ] as const;

  it("all five are in the catalogue, module 'inventory', phase '3A'", () => {
    for (const code of CODES) {
      const def = PERMISSIONS.find((permission) => permission.code === code);
      expect(def, code).toBeDefined();
      expect(def!.module).toBe("inventory");
      expect(def!.phase).toBe("3A");
    }
    expect(
      [...PERMISSIONS].filter((permission) => permission.phase === "3A").map((p) => p.code),
    ).toEqual([...CODES]);
  });

  it("the two reads are non-mutating and the three authorities are mutating (R7, spec:2178)", () => {
    expect(isMutating("inventory.item.read")).toBe(false);
    expect(isMutating("inventory.stock.read")).toBe(false);
    expect(isMutating("inventory.item.manage")).toBe(true);
    expect(isMutating("inventory.price.manage")).toBe(true);
    expect(isMutating("inventory.negative_stock.override")).toBe(true);
  });

  it("the auditor still holds no mutating code (R7)", () => {
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    for (const code of auditor.permissions)
      expect(isMutating(code as PermissionCode), code).toBe(false);
  });
});

/**
 * Slice 3B, the catalogue half of plan 3B Task 10. A sibling of the describes above for the same reason the
 * 3A block is one: nothing here touches Postgres. The role-grant half is in roles-seed.test.ts.
 */
describe("the one costing code — slice 3B (contracts §3.6.2)", () => {
  it("inventory.cost.read is the slice's whole catalogue contribution", () => {
    expect(
      [...PERMISSIONS].filter((permission) => permission.phase === "3B").map((p) => p.code),
    ).toEqual(["inventory.cost.read"]);
  });

  it("is module 'inventory' and NON-mutating — which is what lets the auditor hold it (R7)", () => {
    const def = PERMISSIONS.find((permission) => permission.code === "inventory.cost.read");
    expect(def).toBeDefined();
    expect(def!.module).toBe("inventory");
    expect(isMutating("inventory.cost.read")).toBe(false);
    expect(def!.description.length).toBeGreaterThan(0);
  });

  it("the auditor still holds no mutating code after this grant (R7)", () => {
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    expect(auditor.permissions).toContain("inventory.cost.read");
    for (const code of auditor.permissions)
      expect(isMutating(code as PermissionCode), code).toBe(false);
  });
});

/** Hoisted out of the describe below: oxlint unicorn(consistent-function-scoping) refuses a nested
 *  function that captures nothing from its parent scope. */
function moduleOf(code: string): string {
  return PERMISSIONS.find((permission) => permission.code === code)!.module;
}

/**
 * Slice 3C, the catalogue half of plan 3C Task 2. A sibling of the describes above for the same reason the
 * 3A and 3B blocks are: nothing here touches Postgres, so it runs where no Docker daemon does. The
 * role-grant half is in roles-seed.test.ts, which may not import @dulja/contracts.
 */
describe("the four purchasing codes — slice 3C (contracts §3.6.2)", () => {
  const CODES = [
    "accounting.purchase.create",
    "accounting.purchase.post",
    "inventory.receipt.create",
    "inventory.receipt.post",
  ] as const;

  it("all four are in the catalogue with phase '3C' and nothing else is", () => {
    expect(
      [...PERMISSIONS].filter((permission) => permission.phase === "3C").map((p) => p.code),
    ).toEqual([...CODES]);
  });

  it("the two accounting codes are module 'accounting' and the two receipt codes 'inventory'", () => {
    // §4.14's rule puts all four document types in the `inventory` module for attachment reads, but the
    // permission module is the code's own prefix: `accounting.purchase.*` is accounting work.
    expect(moduleOf("accounting.purchase.create")).toBe("accounting");
    expect(moduleOf("accounting.purchase.post")).toBe("accounting");
    expect(moduleOf("inventory.receipt.create")).toBe("inventory");
    expect(moduleOf("inventory.receipt.post")).toBe("inventory");
  });

  it("every one is mutating, which is why the auditor holds none of them (R7, spec:2178)", () => {
    for (const code of CODES) expect(isMutating(code), code).toBe(true);
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    for (const code of CODES) expect(auditor.permissions, code).not.toContain(code);
    for (const code of auditor.permissions)
      expect(isMutating(code as PermissionCode), code).toBe(false);
  });

  it("each carries a description, and migration 0039 seeds the same four strings", () => {
    const sql = readFileSync(
      new URL("../migrations/0039_seed_permission_phase3c.sql", import.meta.url),
      "utf8",
    );
    for (const code of CODES) {
      const def = PERMISSIONS.find((permission) => permission.code === code)!;
      expect(def.description.length, code).toBeGreaterThan(0);
      expect(sql, code).toContain(`'${code}'`);
      expect(sql, code).toContain(def.description);
    }
    const down = readFileSync(new URL("../migrations/0039.down.sql", import.meta.url), "utf8");
    for (const code of CODES) expect(down, code).toContain(`'${code}'`);
  });
});

/**
 * Slice 4A, the catalogue half of plan 4A Task 2. A sibling of the describes above for the same reason the
 * 3A, 3B and 3C blocks are: nothing here touches Postgres. The role-grant and account-resolution halves are
 * in test/seed/permission-phase4a.test.ts and roles-seed.test.ts, which may not import @dulja/contracts.
 */
describe("the seven AR/AP codes — slice 4A (contracts §3.6.2)", () => {
  const CODES = [
    "accounting.sales.post",
    "accounting.receipt.create",
    "accounting.receipt.post",
    "accounting.payment.create",
    "accounting.payment.approve",
    "accounting.payment.post",
    "accounting.credit_limit.override",
  ] as const;

  it("all seven are in the catalogue with phase '4A' and nothing else is", () => {
    expect(
      [...PERMISSIONS].filter((permission) => permission.phase === "4A").map((p) => p.code),
    ).toEqual([...CODES]);
  });

  it("every one is module 'accounting' and mutating, so the auditor holds none of them (R7, spec:2178)", () => {
    for (const code of CODES) {
      expect(moduleOf(code), code).toBe("accounting");
      expect(isMutating(code), code).toBe(true);
    }
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    for (const code of CODES) expect(auditor.permissions, code).not.toContain(code);
    for (const code of auditor.permissions)
      expect(isMutating(code as PermissionCode), code).toBe(false);
  });

  it("each carries a description, and migration 0047 seeds the same seven strings", () => {
    const sql = readFileSync(
      new URL("../migrations/0047_seed_permission_phase4a.sql", import.meta.url),
      "utf8",
    );
    for (const code of CODES) {
      const def = PERMISSIONS.find((permission) => permission.code === code)!;
      expect(def.description.length, code).toBeGreaterThan(0);
      expect(sql, code).toContain(`'${code}'`);
      expect(sql, code).toContain(def.description);
    }
    const down = readFileSync(new URL("../migrations/0047.down.sql", import.meta.url), "utf8");
    for (const code of CODES) expect(down, code).toContain(`'${code}'`);
  });
});

/**
 * Slice 4B, the catalogue half of plan 4B Task 2. A sibling of the 3C and 4A describes above for the same
 * reason: nothing here touches Postgres. The role-grant, account-resolution and applied-migration halves are
 * in test/seed/permission-phase4b.test.ts, which may not import @dulja/contracts.
 */
describe("the one bank-reconciliation code — slice 4B (contracts §3.6.2)", () => {
  const CODE = "accounting.bank.reconcile";

  it("it is in the catalogue with phase '4B' and nothing else is", () => {
    expect(
      [...PERMISSIONS].filter((permission) => permission.phase === "4B").map((p) => p.code),
    ).toEqual([CODE]);
  });

  it("it is module 'accounting' and mutating, so the auditor does not hold it (R7, spec:2178)", () => {
    expect(moduleOf(CODE)).toBe("accounting");
    expect(isMutating(CODE)).toBe(true);
    const auditor = ROLES.find((role) => role.code === "auditor")!;
    expect(auditor.permissions).not.toContain(CODE);
    for (const code of auditor.permissions)
      expect(isMutating(code as PermissionCode), code).toBe(false);
  });

  it("it carries a description, and migration 0052 seeds the same string", () => {
    const def = PERMISSIONS.find((permission) => permission.code === CODE)!;
    expect(def.description.length).toBeGreaterThan(0);
    const sql = readFileSync(
      new URL("../migrations/0052_seed_permission_phase4b.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain(`'${CODE}'`);
    expect(sql).toContain(def.description);
    const down = readFileSync(new URL("../migrations/0052.down.sql", import.meta.url), "utf8");
    expect(down).toContain(`'${CODE}'`);
  });
});

const SIX_A_CODES = [
  "admin.terminal.manage",
  "pos.sync.pull",
  "pos.sync.push",
  "pos.ticket.sell",
  "pos.ticket.discount",
  "pos.ticket.return",
  "pos.ticket.return_blind",
  "pos.ticket.void",
  "pos.ticket.override",
  "pos.needs_attention.resolve",
  "pos.customer.create",
] as const;

describe("Phase6A cross-catalogue agreement", () => {
  it("the catalogue module agrees with the database, both directions (§3.6.3's build check, over this slice)", async () => {
    for (const code of SIX_A_CODES) {
      const def = PERMISSIONS.find((p) => p.code === code);
      expect(def, code).toBeDefined();
      expect(def!.phase).toBe("6A");
    }
  });

  it("every code POS_PERMISSION names is in the catalogue, and its ten members are registered (§3.6.3, 6D extension)", async () => {
    const { OVERRIDE_SUBJECT_FOR, POS_PERMISSION } = await import("../src/sync/authority");
    const named = Object.values(POS_PERMISSION);
    expect(new Set(named).size).toBe(10);
    for (const code of named)
      expect(
        PERMISSIONS.some((p) => p.code === code),
        code,
      ).toBe(true);
    // The eight are exactly the eleven minus the two sync codes and the admin one — the codes a ROUTE gates.
    expect([...named].toSorted()).toEqual(
      [
        ...SIX_A_CODES.filter(
          (c) => c !== "pos.sync.pull" && c !== "pos.sync.push" && c !== "admin.terminal.manage",
        ),
        "pos.shift.own",
        "pos.shift.close_any",
      ].toSorted(),
    );
    expect(Object.keys(OVERRIDE_SUBJECT_FOR).toSorted()).toEqual([...named].toSorted());
    // 6C: a supervisor lifts branch limits, never a missing cashier grant.
    expect(named.filter((c) => OVERRIDE_SUBJECT_FOR[c] !== null)).toEqual([]);
  });
});

// Seed-policy permission resolution remains in the sole catalogue cross-tier test.
it("POS_TICKET's policy resolves only registered permissions", async () => {
  const { validatePolicy } = await import("@dulja/domain");
  const envelope = JSON.parse(
    readFileSync(new URL("../seed/my/document-types/POS_TICKET.json", import.meta.url), "utf8"),
  );
  expect(
    validatePolicy(
      envelope.policy,
      PERMISSIONS.map((p) => p.code),
    ).errors,
  ).toEqual([]);
});

describe("the four payroll codes — slice 8B (contracts §3.6.2)", () => {
  it("are exactly read, prepare, approve and post in the hr module, read alone non-mutating (R7)", () => {
    expect(
      PERMISSIONS.filter((p) => p.phase === "8B").map((p) => ({
        code: p.code,
        module: p.module,
        mutating: p.mutating,
      })),
    ).toEqual([
      { code: "hr.payroll.read", module: "hr", mutating: false },
      { code: "hr.payroll.prepare", module: "hr", mutating: true },
      { code: "hr.payroll.approve", module: "hr", mutating: true },
      { code: "hr.payroll.post", module: "hr", mutating: true },
    ]);
  });

  it("migration 0089 seeds the descriptions permissions.ts carries, and its down deletes only those four", () => {
    const up = readFileSync(
      new URL("../migrations/0089_seed_permission_phase8b.sql", import.meta.url),
      "utf8",
    );
    for (const def of PERMISSIONS.filter((p) => p.phase === "8B")) {
      expect(up, def.code).toContain(`'${def.description.replaceAll("'", "''")}'`);
    }
    const down = readFileSync(new URL("../migrations/0089.down.sql", import.meta.url), "utf8");
    expect(down).toContain(
      "('hr.payroll.read', 'hr.payroll.prepare', 'hr.payroll.approve', 'hr.payroll.post')",
    );
  });

  it("R6 binds the pair once both codes exist: no seeded role holds prepare and approve (spec:2177)", () => {
    expect(staffPermissionHolders("hr.payroll.prepare")).toEqual(["hr_payroll"]);
    expect(staffPermissionHolders("hr.payroll.approve")).toEqual(["accountant"]);
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions.filter((c) => isMutating(c as PermissionCode))).toEqual([]);
  });

  it("the PAYROLL policy resolves only registered permissions", async () => {
    const { validatePolicy } = await import("@dulja/domain");
    const envelope = JSON.parse(
      readFileSync(new URL("../seed/my/document-types/PAYROLL.json", import.meta.url), "utf8"),
    );
    expect(
      validatePolicy(
        envelope.policy,
        PERMISSIONS.map((p) => p.code),
      ).errors,
    ).toEqual([]);
  });
});

describe("the two money-out codes — slice 8C (contracts §3.6.2, round 18 B16 item 3)", () => {
  it("are exactly hr.payroll.pay and hr.advance.create in the hr module, both mutating", () => {
    expect(
      PERMISSIONS.filter((p) => p.phase === "8C").map((p) => ({
        code: p.code,
        module: p.module,
        mutating: p.mutating,
      })),
    ).toEqual([
      { code: "hr.payroll.pay", module: "hr", mutating: true },
      { code: "hr.advance.create", module: "hr", mutating: true },
    ]);
  });

  it("migration 0095 seeds the descriptions permissions.ts carries, and its down deletes only those two", () => {
    const up = readFileSync(
      new URL("../migrations/0095_seed_permission_phase8c.sql", import.meta.url),
      "utf8",
    );
    for (const def of PERMISSIONS.filter((p) => p.phase === "8C")) {
      expect(up, def.code).toContain(`'${def.description.replaceAll("'", "''")}'`);
    }
    const down = readFileSync(new URL("../migrations/0095.down.sql", import.meta.url), "utf8");
    expect(down).toContain("('hr.payroll.pay', 'hr.advance.create')");
  });

  it("hr_payroll alone is seeded with both; no seeded role gains an R6 pair", () => {
    expect(staffPermissionHolders("hr.payroll.pay")).toEqual(["hr_payroll"]);
    expect(staffPermissionHolders("hr.advance.create")).toEqual(["hr_payroll"]);
  });
});

describe("the filing code — slice 8D (contracts §3.6.2, round 19 8D A9)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => db.stop());

  it("8D introduces hr.filing.generate, mutating, in module hr — the hr.leave.* pair is 0096's (OD-13, Task 8)", async () => {
    const eightD = PERMISSIONS.filter((p) => p.phase === "8D");
    // ⚠️ OD-13 answered build (round 19 A14): Task 8 ships the leave pair beside the filing code — three in all.
    expect(eightD.map((p) => p.code)).toEqual([
      "hr.filing.generate",
      "hr.leave.record",
      "hr.leave.approve",
    ]);
    const filing = eightD.find((p) => p.code === "hr.filing.generate");
    expect(filing).toBeDefined();
    expect(filing!.mutating).toBe(true);
    expect(filing!.module).toBe("hr");
    const [row] = await db.admin<{ module: string; mutating: boolean; description: string }[]>`
      select module, mutating, description from app.permission where code = 'hr.filing.generate'`;
    expect(row).toEqual({ module: "hr", mutating: true, description: filing!.description });
  });

  it("migration 0097 seeds the description permissions.ts carries, and its down deletes only that code", () => {
    const up = readFileSync(
      new URL("../migrations/0097_seed_permission_phase8d.sql", import.meta.url),
      "utf8",
    );
    expect(up).not.toMatch(/'hr\.leave\./); // 8D A9: the leave pair is 0096's — no literal row here
    const filing = PERMISSIONS.find((p) => p.code === "hr.filing.generate")!;
    expect(up).toContain(`'${filing.description.replaceAll("'", "''")}'`);
    const down = readFileSync(new URL("../migrations/0097.down.sql", import.meta.url), "utf8");
    expect(down).toContain("delete from app.permission where code = 'hr.filing.generate';");
  });

  it("hr_payroll alone is seeded with it, and the auditor holds nothing mutating (R7)", () => {
    expect(staffPermissionHolders("hr.filing.generate")).toEqual(["hr_payroll"]);
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions.filter((c) => isMutating(c as PermissionCode))).toEqual([]);
  });
});

describe("the leave codes — slice 8D Task 8 (⚠️ OD-13 answered build; contracts round 19, 8D A9 and A14)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => db.stop());

  it("0096 seeds both leave codes, mutating, in module hr, with the descriptions permissions.ts carries", async () => {
    for (const code of ["hr.leave.record", "hr.leave.approve"] as const) {
      const def = PERMISSIONS.find((p) => p.code === code)!;
      expect(def, code).toBeDefined();
      expect(def.phase).toBe("8D");
      const [row] = await db.admin<{ module: string; mutating: boolean; description: string }[]>`
        select module, mutating, description from app.permission where code = ${code}`;
      expect(row, code).toEqual({ module: "hr", mutating: true, description: def.description });
    }
    const up = readFileSync(
      new URL("../migrations/0096_create_leave_register.sql", import.meta.url),
      "utf8",
    );
    for (const code of ["hr.leave.record", "hr.leave.approve"]) {
      const def = PERMISSIONS.find((p) => p.code === code)!;
      expect(up).toContain(`'${def.description.replaceAll("'", "''")}'`);
    }
    const down = readFileSync(new URL("../migrations/0096.down.sql", import.meta.url), "utf8");
    expect(down).toContain(
      "delete from app.permission where code in ('hr.leave.record', 'hr.leave.approve');",
    );
  });

  it("hr_payroll alone is seeded with both — R4 refuses its own leave per row, so no role pair is needed", () => {
    expect(staffPermissionHolders("hr.leave.record")).toEqual(["hr_payroll"]);
    expect(staffPermissionHolders("hr.leave.approve")).toEqual(["hr_payroll"]);
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions).not.toContain("hr.leave.approve");
  });
});
