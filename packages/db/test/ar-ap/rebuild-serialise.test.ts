// packages/db/test/ar-ap/rebuild-serialise.test.ts — code review 2 (F6). The two asynchronous projection
// rebuilds upsert with `MERGE … WHEN NOT MATCHED THEN INSERT`, which does not re-check the target on a
// concurrent insert (contracts amendment A4, the account_balance hazard). The nightly `.fanout` calls
// `runJob` per company outside the stately queue, so it can overlap a post-triggered rebuild of the same
// company and the same as_of: both found a key absent, both inserted, and the second died 23505 when the
// first committed — a failed run and a false integrity incident. Each rebuild now takes a transaction
// advisory lock on its key before the statement, so the second waits and then updates the first's rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { rebuildPartyAgeing } from "../../src/ar-ap/ageing";
import { rebuildItemProfitability } from "../../src/projections/item-profitability";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import {
  seedItem,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "../index";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;

const ctx = async (): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});

/** Resolves once some backend is waiting on a lock it has not been granted — B, queued behind A. */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks where not granted`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second rebuild never waited on the first");
}

/**
 * Run `rebuild` in transaction A and hold A open; start the same rebuild in transaction B; once B is waiting,
 * commit A. Returns both outcomes, B's as the error it raised if it raised one.
 */
async function overlap<T>(
  rebuild: (tx: Sql) => Promise<T>,
): Promise<{ a: T; b: { ok: true; value: T } | { ok: false; code: unknown; message: string } }> {
  let ran!: () => void;
  let release!: () => void;
  const aRan = new Promise<void>((resolve) => (ran = resolve));
  const aReleased = new Promise<void>((resolve) => (release = resolve));
  const a = withTenant(db.rw, await ctx(), async (tx) => {
    const value = await rebuild(tx);
    ran();
    await aReleased;
    return value;
  });
  await aRan;
  const b = withTenant(db.rw, await ctx(), (tx) => rebuild(tx)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      code: (error as { code?: unknown }).code,
      message: String(error),
    }),
  );
  await someoneWaits();
  release();
  return { a: await a, b: await b };
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "rebuild-serialise");
  f = await arApFixture(db, s);
  // One open invoice for the ageing, and one delivered item for item_profitability.
  await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-01-10",
    partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
  });
  const { itemId, baseUnitId } = await seedItem(db, s, {
    code: "RS-ITEM",
    kind: "product",
    trackLots: false,
  });
  const warehouseId = await seedWarehouse(db, s, { code: "RS-WH" });
  const line = (quantity: string, amount: string) => ({
    kind: "item" as const,
    itemId,
    unitId: baseUnitId,
    warehouseId,
    quantity,
    unitPrice: "5.0000",
    amount,
  });
  await postFromPack(db, s, {
    code: "GOODS_RECEIPT",
    effectiveDate: "2026-01-02",
    partyId: f.partyIds.vendor,
    warehouseId,
    jobs: recordingJobs(),
    lines: [line("10.000000", "50.0000")],
  });
  await postFromPack(db, s, {
    code: "DELIVERY_ORDER",
    effectiveDate: "2026-01-05",
    partyId: f.partyIds.customer,
    warehouseId,
    jobs: recordingJobs(),
    lines: [line("2.000000", "10.0000")],
  });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("F6 (code review 2) — two overlapping rebuilds of one key serialise instead of failing 23505", () => {
  it("party_ageing: a second rebuild of a fresh (company, as_of) waits for the first and updates its rows", async () => {
    const { a, b } = await overlap((tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-01-20" }),
    );
    expect(a.merged).toBe(1);
    expect(b).toMatchObject({ ok: true, value: { merged: 1, zeroed: 0 } });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.party_ageing
       where company_id = ${s.company} and as_of = '2026-01-20'`;
    expect(n!.n).toBe(1);
  });

  it("item_profitability: a second rebuild of a company with no stored rows waits and updates them", async () => {
    const [before] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.item_profitability where company_id = ${s.company}`;
    expect(before!.n).toBe(0);
    const { a, b } = await overlap((tx) => rebuildItemProfitability(tx, { companyId: s.company }));
    expect(a.merged).toBeGreaterThan(0);
    expect(b).toMatchObject({ ok: true, value: { merged: a.merged, zeroed: 0 } });
  });
});
