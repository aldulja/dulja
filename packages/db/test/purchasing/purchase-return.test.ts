import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currency, Money, validateDocumentTypeSeed } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateLandedCostForDocument,
  linkFulfilment,
  openQuantity,
  postDocument,
  valuationAsOf,
} from "../../src/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../../src/seed/index";
import {
  ensureOpenPeriods,
  postOverriddenIssue,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");
const MYR = currency("MYR");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "3c-pr-test",
});
const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
  config: {
    tenantId: seed.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "pr",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "pr HQ",
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

/** The permission catalogue as DATA, read from the global `app.permission` table: `packages/db` may not
 *  import `@dulja/contracts` (0B's `dependency-rule` — its ALLOW set names `permission-catalogue.test.ts`
 *  and no other file), and that suite pins the table equal to `PERMISSIONS` in both directions, so the two
 *  sources cannot disagree. 3B's costing suites make the same substitution. */
let catalogue: string[];

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "pr");
  await grantCodes(db, s, {
    // `accounting.journal.post` is the code 3B's STOCK_ISSUE_COST_POLICY names: test 18's override half
    // posts an issue through that fixture type (as `landed-cost.test.ts` does), and 2B's R2 checks it.
    codes: [
      "accounting.journal.post",
      "accounting.purchase.create",
      "accounting.purchase.post",
      "inventory.receipt.create",
      "inventory.receipt.post",
    ],
  });
  // chart-of-accounts BEFORE document-types, and before `seedParty`: §4.5.7 defaults a vendor's
  // `payable_account_id` to `2100`, and the debit leg below resolves through it.
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
  );
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
  );
  await ensureOpenPeriods(db, s, 2026);
  catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
    (row) => row.code,
  );
  partyId = await seedParty(db, s, { kind: "vendor", code: "PR-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "PR-WH" });
}, 300_000);
afterAll(async () => {
  await db.stop();
});

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

/** A posted receipt of `quantity` at `unitPrice`, which is what a return has to have something to return. */
async function receive(
  itemCode: string,
  quantity: string,
  unitPrice: string,
  amount: string,
): Promise<{ itemId: string; baseUnitId: string }> {
  // trackLots: false on every item here — `seedItem` defaults it to TRUE (§4.6.1, migration 0028) and
  // `planMovements` refuses a DECLARED receipt of a lot-tracked item whose line names no lot
  // (ERR_POLICY_REQUIRES_MISSING); no line in this file names one, and the lot path is 3A's and 3D's.
  const { itemId, baseUnitId } = await seedItem(db, s, { code: itemCode, trackLots: false });
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: await typeId("GOODS_RECEIPT"),
    series: "GRN",
    partyId,
    warehouseId,
    effectiveDate: "2026-05-01",
    lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity, unitPrice, amount }],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
  );
  return { itemId, baseUnitId };
}

describe("PURCHASE_RETURN — contracts §4.14, spec:1698, ADR 0041", () => {
  it("the seed file is a valid envelope: outbound, issue, consume_layers, series PR, both legs line.cost", () => {
    const envelope = JSON.parse(
      readFileSync(join(TYPES_DIR, "PURCHASE_RETURN.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["code"]).toBe("PURCHASE_RETURN");
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("outbound");
    expect(policy["inventory"]).toEqual({
      effect: "issue",
      warehouse: "line.warehouse",
      costing: "consume_layers",
    });
    expect(policy["numbering"]).toEqual({ series: "PR", assignAt: "issue" });
    expect(policy["requires"]).toEqual(["party", "warehouse"]);
    expect(policy["approval"]).toEqual({
      required: false,
      approve: null,
      post: "accounting.purchase.post",
      create: "accounting.purchase.create",
    });
    // ADR 0041: both legs at line.cost, debit party.payable_account, credit item.inventory_account.
    expect(
      (policy["lines"] as { side: string; amount: string; account: Record<string, string> }[]).map(
        (l) => [l.side, l.amount, l.account["from"]],
      ),
    ).toEqual([
      ["debit", "line.cost", "party.payable_account"],
      ["credit", "line.cost", "item.inventory_account"],
    ]);
  });

  it("every approval code the policy names is in the catalogue (F-21)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_RETURN.json"), "utf8")) as {
      policy: { approval: Record<string, string | null> };
    };
    for (const key of ["approve", "post", "create"] as const) {
      const code = envelope.policy.approval[key];
      if (code !== null && code !== undefined) expect(catalogue).toContain(code);
    }
  });

  it("issues stock at carrying cost, debits payables and credits inventory by the same figure", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-1", "100.000000", "12.0000", "1200.0000");
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-10",
      // The operator enters the SUPPLIER's price for the printed document; the policy uses only line.cost.
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "12.0000",
          amount: "120.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );

    const [mv] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${documentId}`,
    );
    expect(mv).toEqual({ quantity: "-10.000000", value: "-120.0000" }); // signs from `effect`, never the plan

    const entries = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string; rate: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit,
             e.exchange_rate::text as rate
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId} order by a.code`,
    );
    // 2100 trade payables debited, the item's inventory account (1300 by default) credited, both 120.0000.
    // Rate 1.00000000 on both: a cost line is written in base currency (3B's A4 widened insertLedger's branch).
    expect(entries).toEqual([
      { code: "1300", debit: "0.0000", credit: "120.0000", rate: "1.00000000" },
      { code: "2100", debit: "120.0000", credit: "0.0000", rate: "1.00000000" },
    ]);

    const [onHand] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`,
    );
    expect(onHand!.quantity).toBe("90.000000");
  });

  it("returns goods that carry a landed cost at the LANDED figure, not at the supplier's price", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PR-ITEM-2", trackLots: false });
    const freight = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`,
    );
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("SHIPMENT"),
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-02",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "100.0000",
          amount: "1000.0000",
        },
        { kind: "account", accountId: freight[0]!.id, description: "freight", amount: "200.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId: receipt.documentId,
        allocations: [{ costLineId: receipt.lineIds[1]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );

    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-11",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "2.000000",
          unitPrice: "100.0000",
          amount: "200.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() }),
    );

    // The layer is at 120.0000 a unit, so two units leave at 240.0000 — not the 200.0000 the operator typed.
    // The 40.0000 difference is the freight share on the returned goods; ADR 0041 leaves it for 4A's credit note.
    const [line] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${ret.documentId}`,
    );
    expect(line!.cost).toBe("240.0000");
    const [payables] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ debit: string }[]>`
      select e.debit::text as debit from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${ret.documentId} and a.code = '2100'`,
    );
    expect(payables!.debit).toBe("240.0000");
  });

  it("test 18: the data layer refuses a return beyond stock, and only an authorised override admits it", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-3", "5.000000", "10.0000", "50.0000");
    const returnType = await typeId("PURCHASE_RETURN");

    // No flag, no header, no session variable opens this door — the trigger reads the movements themselves.
    const tooMuch = await draftTypedDocument(db, s, {
      documentTypeId: returnType,
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-12",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "9.000000",
          unitPrice: "10.0000",
          amount: "90.0000",
        },
      ],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctx(s), { documentId: tooMuch.documentId, jobs: recordingJobs() }),
      ),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);

    // The one door F-6 admits: an `inventory.negative_stock.override` event recorded by a SECOND principal
    // (hazard 17). postOverriddenIssue is 3B's helper precisely because the guard has two clauses a caller
    // gets wrong once each.
    //
    // The override half runs through 3A's registered STOCK_ISSUE_TEST and NOT through PURCHASE_RETURN, for
    // one mechanical reason: `postOverriddenIssue`'s options carry no `partyId`, and PURCHASE_RETURN's
    // `requires: ["party", "warehouse"]` would refuse the document at step 4 with
    // ERR_POLICY_REQUIRES_MISSING before `assert_stock_available` ever fired. Test 18 is an assertion about
    // the TRIGGER — "negative stock is rejected by the data layer regardless of write path" — not about a
    // document type, and the refusal half above already establishes that a purchase return is one such path.
    const issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    const overridden = await postOverriddenIssue(db, s, {
      documentTypeId: issueType,
      itemId,
      warehouseId,
      quantity: "9.000000",
      effectiveDate: "2026-05-13",
      unitPrice: "10.0000",
    });
    expect(overridden.supervisorId).not.toBe(s.human);
    const [onHand] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`,
    );
    expect(onHand!.quantity).toBe("-4.000000");
    const [event] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_event
       where document_id = ${overridden.documentId} and event_kind = 'override'
         and override_code = 'inventory.negative_stock.override'`,
    );
    expect(event!.n).toBe(1);
  });

  it("test 7's supplier-return leg: valuation and the cost side tie to the cent", async () => {
    const { itemId, baseUnitId } = await receive("PR-ITEM-4", "20.000000", "15.0000", "300.0000");
    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-14",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "6.000000",
          unitPrice: "15.0000",
          amount: "90.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() }),
    );

    // ONE costing answer (SAH-009): the valuation read, the layer residues and the consumption rows all agree.
    // `ValuationParams` is 3B's frozen shape: `{ companyId; asOf; itemId?; warehouseId?; cursor?; limit }`.
    // There is no `itemIds`, and `limit` is REQUIRED — an excess property on an object literal is a
    // TypeScript error and a missing required one is another, so this call is the shape or the suite does
    // not compile.
    const valuation = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: "2026-05-31", itemId, limit: 100 }),
    );
    // `round(…, 4)`, not a bare `::text`. `numeric(19,6) * numeric(19,4)` has scale 6 + 4 = 10 in PostgreSQL
    // and `sum()` keeps it, so the bare cast would read "210.0000000000" while the arithmetic is right. The
    // rounding is the one `valuationAsOf` itself applies per layer, which is why the two agree.
    const [residue] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string; value: string }[]>`
      select coalesce(sum(l.qty_remaining), 0)::text as quantity,
             round(coalesce(sum(l.value * l.qty_remaining / l.qty_in), 0), 4)::text as value
        from app.cost_layer l where l.item_id = ${itemId} and l.invalidated_at is null`,
    );
    expect(residue).toEqual({ quantity: "14.000000", value: "210.0000" });
    const valued = valuation.reduce((acc, r) => acc.add(Money.of(r.value, MYR)), Money.zero(MYR));
    expect(valued.toString()).toBe("210.0000");

    const [consumed] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ value: string }[]>`
      select coalesce(sum(k.value), 0)::text as value from app.cost_consumption k
        join app.inventory_movement m on m.id = k.movement_id where m.document_id = ${ret.documentId}`,
    );
    expect(consumed!.value).toBe("90.0000");
    // 300 received − 90 returned = 210 remaining, to the cent, by three independent readers.
  });

  it("test 14: who can post a purchase return in company X is one query, and it names a real type", async () => {
    // The type exists as configuration, which is what makes the question meaningful (§2.4's "a real
    // purchase-return type exists for the one-query test"). 0A pinned the query; this re-runs it verbatim.
    expect(await typeId("PURCHASE_RETURN")).toBeTruthy();
    const who = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ id: string; display_name: string }[]>`
      select distinct p.id, p.display_name
        from app.principal p
        join app.role_assignment ra on ra.principal_id = p.id
        join app.role_permission rp on rp.role_id = ra.role_id
       where ra.company_id = ${s.company} and rp.permission_code = 'accounting.purchase.post'
         and (ra.expires_at is null or ra.expires_at > now())
       order by p.display_name`,
    );
    expect(who.map((r) => r.id)).toContain(s.human);
  });

  it("links a return to the receipt it reverses, and the receipt's open quantity falls (SAH-018)", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PR-ITEM-5", trackLots: false });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_ORDER"),
      series: "PO",
      partyId,
      effectiveDate: "2026-05-03",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "10.0000",
          amount: "100.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("GOODS_RECEIPT"),
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-04",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "10.0000",
          amount: "100.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: order.documentId,
        targetDocumentId: receipt.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: order.lineIds[0]!,
            targetLineId: receipt.lineIds[0]!,
            quantity: "10.000000",
          },
        ],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );

    const ret = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-05-15",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "4.000000",
          unitPrice: "10.0000",
          amount: "40.0000",
        },
      ],
    });
    // link_kind 'returns' against the POSTED receipt: the guard admits a posted source (Task 1) and the
    // returned quantity is a projection over these rows, never a column on the receipt line (SAH-018).
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: receipt.documentId,
        targetDocumentId: ret.documentId,
        linkKind: "returns",
        lines: [
          {
            sourceLineId: receipt.lineIds[0]!,
            targetLineId: ret.lineIds[0]!,
            quantity: "4.000000",
          },
        ],
      }),
    );
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, receipt.documentId),
    );
    expect(rows.map((r) => [r.orderedQuantity, r.linkedQuantity, r.openQuantity])).toEqual([
      ["10.000000", "4.000000", "6.000000"],
    ]);

    const [returnedColumn] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line' and column_name like '%returned%'`;
    expect(returnedColumn!.n).toBe(0); // SAH-018 asserted structurally, not by inspection
  });
});
