// packages/db/test/sync/accounts-and-codes.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { chartOfAccountsLoader } from "../../src/seed";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { PACK_ROOT } from "../ar-ap/_support";

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

describe("migration 0062 and the 6A chart rows (§3.6.2, §3.6.4, §4.15)", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Alpha");
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("app.permission holds exactly the eleven codes with the right module and mutating flag", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...SIX_A_CODES]}) order by code`;
    expect(rows.map((r) => r.code)).toEqual([...SIX_A_CODES].toSorted());
    expect(rows.find((r) => r.code === "pos.sync.pull")!.mutating).toBe(false);
    expect(rows.filter((r) => r.code !== "pos.sync.pull").every((r) => r.mutating)).toBe(true);
    expect(rows.find((r) => r.code === "admin.terminal.manage")!.module).toBe("admin");
    expect(rows.filter((r) => r.code.startsWith("pos.")).every((r) => r.module === "pos")).toBe(
      true,
    );
  });

  it("the seeded roles match spec:2160-2161 exactly — a cashier may not void, blind-return or override", async () => {
    const cashier = ROLES.find((r) => r.code === "cashier")!;
    // 6B (T4) adds the three till-evaluated codes spec:2161 also gives the cashier: own shift, price check,
    // clock in/out.
    expect([...cashier.permissions].filter((c) => c.startsWith("pos.")).toSorted()).toEqual([
      "pos.attendance.clock",
      "pos.customer.create",
      "pos.price.check",
      "pos.shift.own",
      "pos.ticket.discount",
      "pos.ticket.return",
      "pos.ticket.sell",
    ]);
    for (const forbidden of [
      "pos.ticket.void",
      "pos.ticket.return_blind",
      "pos.ticket.override",
      "pos.sync.push",
    ]) {
      expect(cashier.permissions, forbidden).not.toContain(forbidden);
    }
    const bm = ROLES.find((r) => r.code === "branch_manager")!;
    for (const held of [
      "pos.ticket.void",
      "pos.ticket.return_blind",
      "pos.ticket.override",
      "pos.needs_attention.resolve",
    ]) {
      expect(bm.permissions, held).toContain(held);
    }
    // R8 (spec:2179): a terminal holds exactly two codes and a human never holds them.
    const term = ROLES.find((r) => r.code === "pos_terminal")!;
    expect([...term.permissions].toSorted()).toEqual(["pos.sync.pull", "pos.sync.push"]);
    for (const r of ROLES.filter((x) => x.code !== "pos_terminal" && x.code !== "admin")) {
      expect(
        r.permissions.some((c) => c.startsWith("pos.sync.")),
        r.code,
      ).toBe(false);
    }
    // R6 (spec:2177): no seeded role but admin holds both halves of an incompatible pair.
    for (const r of ROLES.filter((x) => x.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(r.permissions.includes(x) && r.permissions.includes(y), `${r.code} ${x}+${y}`).toBe(
          false,
        );
      }
    }
  });

  it("6a-pos-tenders.json seeds 1110/1120/2200 and 1100 already resolves (hazard 33)", async () => {
    await prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "chart" },
      (tx) =>
        chartOfAccountsLoader.load(tx, {
          config: { tenantId: s.tenant } as never,
          tenantId: s.tenant,
          companyId: s.company,
          systemPrincipalId: s.system,
          packRoot: PACK_ROOT,
        }),
    );
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; account_type: string }[]>`
      select code, type::text as account_type from app.account
       where company_id = ${s.company} and code in ('1100','1110','1120','2200') order by code`,
    );
    expect(rows).toEqual([
      { code: "1100", account_type: "asset" }, // 0C's — consumed, never re-seeded
      { code: "1110", account_type: "asset" },
      { code: "1120", account_type: "asset" },
      { code: "2200", account_type: "liability" },
    ]);
  });

  it("re-applying the chart sub-pack is idempotent (§3.4.8 — on conflict do nothing on the natural key)", async () => {
    await prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "chart-2" },
      (tx) =>
        chartOfAccountsLoader.load(tx, {
          config: { tenantId: s.tenant } as never,
          tenantId: s.tenant,
          companyId: s.company,
          systemPrincipalId: s.system,
          packRoot: PACK_ROOT,
        }),
    );
    const [n] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company} and code = '1110'`,
    );
    expect(n!.n).toBe(1);
  });
});
