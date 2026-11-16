import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currency, Money } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateLandedCostForDocument, postDocument } from "../../src/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../../src/seed/index";
// 3B's helpers, through the allowance amendment A21(c) gives `packages/db/test` (§4.17.1).
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";
import {
  draftTypedDocument,
  grantCodes,
  seedCurrency,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "my");
const MYR = currency("MYR");
const USD = currency("USD");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "3c-fx-test",
});
const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
  config: {
    tenantId: seed.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "fx",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "fx HQ",
    baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: 1,
    fiscalYear: 2026,
  },
  tenantId: seed.tenant,
  companyId: seed.company,
  systemPrincipalId: seed.system,
  packRoot: PACK_ROOT,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "fx");
  await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
  );
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
  );
  await ensureOpenPeriods(db, s, 2026);
  await seedCurrency(db, s, { code: "USD" });
  // A plainly invented rate. No published or market figure appears anywhere in this repository.
  await seedRate(db, s, {
    from: "USD",
    to: "MYR",
    on: "2026-01-01",
    rate: "4.00000000",
    source: "manual:fixture",
  });
  partyId = await seedParty(db, s, { kind: "vendor", code: "FX-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "FX-WH" });
}, 300_000);
afterAll(async () => {
  await db.stop();
});

describe("OD-05 — a USD shipment against MYR books, at the built default (spec:1023)", () => {
  it("holds the GRNI accrual in USD and the cost layer in MYR, with base = round(value × rate, 4)", async () => {
    const [ty] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`,
    );
    const [freight] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.account where company_id = ${s.company} and code = '5900'`,
    );
    // trackLots: false on every item here — `seedItem` defaults it to TRUE (§4.6.1, migration 0028) and
    // `planMovements` refuses a DECLARED receipt of a lot-tracked item whose line names no lot
    // (ERR_POLICY_REQUIRES_MISSING); no line in this file names one, and the lot path is 3A's and 3D's.
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "FX-ITEM", trackLots: false });

    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: ty!.id,
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-04-10",
      currency: "USD",
      exchangeRate: "4.00000000",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "8.000000",
          unitPrice: "125.0000",
          amount: "1000.0000",
        },
        {
          kind: "account",
          accountId: freight!.id,
          description: "ocean freight, USD",
          amount: "60.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );

    // Every ledger amount is USD at rate 4, with base = value × 4 exactly (hazard 23; ledger_entry's CHECK).
    const entries = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        {
          code: string;
          currency: string;
          debit: string;
          credit: string;
          base_debit: string;
          base_credit: string;
        }[]
      >`select a.code, e.currency, e.debit::text as debit, e.credit::text as credit,
               e.base_debit::text as base_debit, e.base_credit::text as base_credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code, e.line_no`,
    );
    // Ordered `by a.code, e.line_no`. BOTH debits land on `1300`: line 1 through `item.inventory_account`,
    // whose default IS `1300` (§4.6.1), and line 2 through the freight rule's `account: { code: "1300" }`.
    // Line 1 (the goods, 1000) therefore precedes line 2 (the freight, 60).
    expect(entries).toEqual([
      {
        code: "1300",
        currency: "USD",
        debit: "1000.0000",
        credit: "0.0000",
        base_debit: "4000.0000",
        base_credit: "0.0000",
      },
      {
        code: "1300",
        currency: "USD",
        debit: "60.0000",
        credit: "0.0000",
        base_debit: "240.0000",
        base_credit: "0.0000",
      },
      {
        code: "2150",
        currency: "USD",
        debit: "0.0000",
        credit: "1000.0000",
        base_debit: "0.0000",
        base_credit: "4000.0000",
      },
      {
        code: "5900",
        currency: "USD",
        debit: "0.0000",
        credit: "60.0000",
        base_debit: "0.0000",
        base_credit: "240.0000",
      },
    ]);

    // The layer is BASE currency (§4.7.3, 3B's A4): (1000 + 60) USD × 4 = 4240 MYR over 8 units.
    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unit_cost: string; value: string }[]>`
        select l.unit_cost::text as unit_cost, m.value::text as value
          from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
         where m.document_id = ${documentId}`,
    );
    expect(layer).toEqual({ unit_cost: "530.0000", value: "4240.0000" });

    // The accrual the supplier will invoice against is 1000 USD, not 4000 MYR. That is the default OD-05
    // question 3 asks about: nothing in Phase 3 revalues it, and 4B is where the settlement difference posts.
    const [accrual] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ currency: string; total: string }[]>`
        select e.currency, sum(e.credit)::text as total from app.ledger_entry e
          join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} and a.code = '2150' group by e.currency`,
    );
    expect(accrual).toEqual({ currency: "USD", total: "1000.0000" });
  });

  it("the allocation itself is document currency, so the split is the supplier's arithmetic", async () => {
    const [ty] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = 'SHIPMENT'`,
    );
    const [freight] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.account where company_id = ${s.company} and code = '5900'`,
    );
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "FX-ITEM-2", trackLots: false });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: ty!.id,
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-04-11",
      currency: "USD",
      exchangeRate: "4.00000000",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "3.000000",
          unitPrice: "1.0000",
          amount: "3.0000",
        },
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "3.000000",
          unitPrice: "1.0000",
          amount: "3.0000",
        },
        {
          kind: "account",
          accountId: freight!.id,
          description: "handling, USD",
          amount: "1.0000",
        },
      ],
    });
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_value" }],
      }),
    );
    // 1.0000 USD over two equal weights → 0.5000 / 0.5000, in USD. Converting first and splitting in MYR
    // would give 2.0000 / 2.0000 and a supplier reconciliation nobody can follow.
    expect(rows.map((r) => r.allocatedAmount)).toEqual(["0.5000", "0.5000"]);
    const total = rows.reduce(
      (acc, r) => acc.add(Money.of(r.allocatedAmount, USD)),
      Money.zero(USD),
    );
    expect(total.toString()).toBe("1.0000");
    expect(MYR).not.toBe(USD);
  });
});
