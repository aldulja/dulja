import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenant, seedBranch, seedBranchPosPolicy, grantCodes, type Seed } from "../fixtures";
import { lintSchema, listApplied } from "../../src";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "alpha");
  b = await seedTenant(db, "beta");
  // `app.branch_pos_policy` takes Form A of `branch_isolation` in Task 5's migration 0068, and every read
  // below is `a.human`. One company-wide grant (no `branchIds`) is what keeps them non-empty afterwards —
  // amendment A15's consumer side, written now so this suite never turns red at Task 5.
  await grantCodes(db, a);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.branch_pos_policy — limits are a row, never a blob (§4.6.4; spec:1324)", () => {
  it("migration 66 is applied and every limit defaults to the closed position", async () => {
    expect(await listApplied(db.migrator)).toContain(66);
    const id = await seedBranchPosPolicy(db, a);
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<Record<string, string>[]>`
      select max_line_discount_pct::text, max_ticket_discount_pct::text, max_void_amount::text,
             max_price_override_pct::text, blind_return_allowed::text, max_blind_return_amount::text,
             rounding_increment::text, paid_out_allowed::text, max_paid_out_amount::text
        from app.branch_pos_policy where id = ${id}`,
    );
    expect(row).toEqual({
      max_line_discount_pct: "0.000000",
      max_ticket_discount_pct: "0.000000",
      max_void_amount: "0.0000",
      max_price_override_pct: "0.000000",
      blind_return_allowed: "false",
      max_blind_return_amount: "0.0000",
      rounding_increment: "0.0500",
      paid_out_allowed: "false",
      max_paid_out_amount: "0.0000",
    });
  });

  it("one row per branch — a second insert for the same branch conflicts", async () => {
    const second = await seedBranch(db, a, { code: "BR-2" });
    await seedBranchPosPolicy(db, a, { branchId: second });
    await expect(seedBranchPosPolicy(db, a, { branchId: second })).rejects.toThrow(/duplicate key/);
  });

  it("a limit is stored at its declared scale and never as a float", async () => {
    const br = await seedBranch(db, a, { code: "BR-3" });
    const id = await seedBranchPosPolicy(db, a, {
      branchId: br,
      limits: {
        maxLineDiscountPct: "0.150000",
        maxVoidAmount: "250.0000",
        blindReturnAllowed: true,
        maxBlindReturnAmount: "75.5000",
      },
    });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<Record<string, string>[]>`
      select max_line_discount_pct::text, max_void_amount::text, max_blind_return_amount::text
        from app.branch_pos_policy where id = ${id}`,
    );
    expect(row).toEqual({
      max_line_discount_pct: "0.150000",
      max_void_amount: "250.0000",
      max_blind_return_amount: "75.5000",
    });
  });

  it("a negative or over-100% limit is refused by a CHECK, not by a handler", async () => {
    const br = await seedBranch(db, a, { code: "BR-4" });
    await expect(
      seedBranchPosPolicy(db, a, { branchId: br, limits: { maxLineDiscountPct: "-0.010000" } }),
    ).rejects.toThrow(/branch_pos_policy_pct_range/);
    await expect(
      seedBranchPosPolicy(db, a, { branchId: br, limits: { maxTicketDiscountPct: "1.500000" } }),
    ).rejects.toThrow(/branch_pos_policy_pct_range/);
    await expect(
      seedBranchPosPolicy(db, a, { branchId: br, limits: { maxVoidAmount: "-1.0000" } }),
    ).rejects.toThrow(/branch_pos_policy_amount_non_negative/);
  });

  it("writing the row bumps the catalogue revision so the branch's terminals re-pull it (§4.10.2)", async () => {
    const br = await seedBranch(db, a, { code: "BR-5" });
    const id = await seedBranchPosPolicy(db, a, { branchId: br });
    const [before] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ r: string }[]>`select revision::text as r from app.branch_pos_policy where id = ${id}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.branch_pos_policy set max_void_amount = 10.0000 where id = ${id}`,
    );
    const [after] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ r: string }[]>`select revision::text as r from app.branch_pos_policy where id = ${id}`,
    );
    expect(BigInt(after!.r)).toBeGreaterThan(BigInt(before!.r));
  });

  it("tenant B cannot see tenant A's policy rows", async () => {
    const id = await seedBranchPosPolicy(db, a, {
      branchId: await seedBranch(db, a, { code: "BR-6" }),
    });
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`select id from app.branch_pos_policy where id = ${id}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0066", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
