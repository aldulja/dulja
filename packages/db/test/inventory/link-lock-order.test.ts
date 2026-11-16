// packages/db/test/inventory/link-lock-order.test.ts — code review 4, item 3. Every writer of a fulfilment link
// takes the source line's `document_link:<line>` advisory key before its first audited write, and the audit
// chain's per-tenant `tenant-serial:` key (0010) after it. Code review 3 made reverseDocument take the keys of
// every line its document was linked against, so that a reversal reinstating an ancestor's claim (0116 §4)
// kept that order. It took them for an ORDINARY reversal too — a depth-0 reversal, which can reinstate no
// claim — while convertOrderToDelivery and draftTransferReceipt still inserted their draft (taking the
// tenant's key) before linkFulfilment took the line's. So reversing a delivery while a second delivery of the
// same order line was being drafted deadlocked; on 381bb34 the two just queued. A reversal now takes the keys
// only for lines linked to a STRICT ancestor, and both services take theirs before their first INSERT, as
// convertToInvoice and creditNoteFrom already did.
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openQuantity } from "../../src/documents/link";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { draftTransfer, draftTransferReceipt } from "../../src/inventory/transfer";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import {
  ctxOf,
  DELIVERY_ORDER_POLICY,
  GRN_POLICY,
  SALES_ORDER_POLICY,
  TRANSFER_POLICY,
  TRANSFER_RECEIPT_POLICY,
} from "./policies";

/** A promise's outcome as data. */
const outcomeOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ ok: true as const, message: "" }),
    (error: unknown) => ({ ok: false as const, message: String(error) }),
  );

describe("link writers take the source line's key before the tenant's (code review 4, item 3)", () => {
  let db: Db;
  let s: Seed;
  let soType: string;
  let doType: string;
  let trfType: string;
  let trrType: string;
  let itemId: string;
  let unitId: string;
  let partyId: string;
  let whMain: string;
  let whBranch: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-cr4-lock-order");
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    const acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    await seedAccount(db, s, {
      code: "2150",
      nameEn: "Goods received not invoiced",
      type: "liability",
    });
    soType = await seedDocumentType(db, s, {
      code: "SALES_ORDER",
      module: "inventory",
      policy: SALES_ORDER_POLICY,
    });
    doType = await seedDocumentType(db, s, {
      code: "DELIVERY_ORDER",
      module: "inventory",
      policy: DELIVERY_ORDER_POLICY,
    });
    const grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    trfType = await seedDocumentType(db, s, {
      code: "TRANSFER",
      module: "inventory",
      policy: TRANSFER_POLICY,
    });
    trrType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT",
      module: "inventory",
      policy: TRANSFER_RECEIPT_POLICY,
    });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    whMain = await seedWarehouse(db, s, { code: "WH-MAIN" });
    const branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    await seedWarehouse(db, s, { code: "WH-BR2-TR", kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-LOCK",
      trackLots: false,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    // 50 units at 3.0000, enough for every delivery and dispatch below.
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId,
      warehouseId: whMain,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whMain,
          unitId,
          quantity: "50.000000",
          unitPrice: "3.0000",
          amount: "150.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** An issued SALES_ORDER of one line. */
  async function issuedOrder(quantity: string, amount: string) {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-08",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whMain,
          unitId,
          quantity,
          unitPrice: "9.0000",
          amount,
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );
    return order;
  }

  const convert = (
    tx: Sql,
    order: { documentId: string; lineIds: string[] },
    quantity: string,
    effectiveDate: string,
  ) =>
    convertOrderToDelivery(tx, ctxOf(s), {
      sourceDocumentId: order.documentId,
      targetDocumentTypeId: doType,
      targetSeries: "DO",
      effectiveDate,
      warehouseId: whMain,
      fefo: false,
      lines: [{ sourceLineId: order.lineIds[0]!, quantity }],
    });

  /** A delivery of `quantity` against the order's line, drafted, issued and posted. */
  const deliverPosted = (
    order: { documentId: string; lineIds: string[] },
    quantity: string,
    effectiveDate: string,
  ) =>
    withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const { documentId } = await convert(tx, order, quantity, effectiveDate);
      await issueDocument(tx, ctxOf(s), { documentId });
      await postDocument(tx, ctxOf(s), { documentId });
      return documentId;
    });

  const reverse = (tx: Sql, documentId: string, effectiveDate: string) =>
    reverseDocument(tx, ctxOf(s), { documentId, effectiveDate, reason: "code review 4" });

  /** The database's deadlock counter. A victim's count reaches it when its backend next goes idle — within
   *  about a second (PGSTAT_MIN_INTERVAL) — so `settledDeadlocks` gives a moved counter that long to show. */
  const deadlocks = async (): Promise<string> => {
    const [row] = await db.admin<{ n: string }[]>`
      select coalesce(sum(deadlocks), 0)::text as n from pg_stat_database`;
    return row!.n;
  };
  const settledDeadlocks = async (before: string): Promise<string> => {
    for (let i = 0; i < 50; i += 1) {
      const now = await deadlocks();
      if (now !== before) return now;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return deadlocks();
  };
  /** Resolves once some backend waits on an advisory key. */
  const someoneWaits = async (): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_locks where not granted and locktype = 'advisory'`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the second transaction never waited on an advisory key");
  };
  /** Whether the tenant's audit key (0010's expression) is free: tried from another session, and released at
   *  once, because an autocommit statement's transaction ends with it. */
  const tenantSerialFree = async (): Promise<boolean> => {
    const [row] = await db.admin<{ free: boolean }[]>`
      select pg_try_advisory_xact_lock(
               hashtextextended('tenant-serial:' || ${s.tenant}::uuid::text, 0)) as free`;
    return row!.free;
  };
  /** Holds `document_link:<lineId>` in its own transaction until the returned `release` is called. */
  async function holdLineKey(lineId: string) {
    let held!: () => void;
    let release!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${lineId}`}, 0))`;
      held();
      await released;
    });
    await isHeld;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  it("reversing a delivery while a second delivery of the same order line is drafted: both commit, and no deadlock", async () => {
    // The verifier's scenario. The second delivery is paused just before its `insert into app.document_link`,
    // after its audited document INSERT; the reversal of DO1 starts while it is paused. On 04cf7ef the reversal
    // took document_link:<SO line> and waited on the tenant's key, then the link's trigger waited on the line's.
    const order = await issuedOrder("10.000000", "90.0000");
    const do1 = await deliverPosted(order, "3.000000", "2026-01-10");
    const before = await deadlocks();

    let paused!: () => void;
    let resume!: () => void;
    const atLink = new Promise<void>((resolve) => (paused = resolve));
    const go = new Promise<void>((resolve) => (resume = resolve));
    const pausing = (tx: Sql): Sql =>
      new Proxy(tx, {
        apply(target, thisArg, args: unknown[]) {
          const [strings] = args;
          if (
            Array.isArray(strings) &&
            "raw" in strings &&
            (strings as readonly string[]).join("?").includes("insert into app.document_link")
          ) {
            paused();
            return go.then(() => Reflect.apply(target, thisArg, args) as unknown);
          }
          return Reflect.apply(target, thisArg, args) as unknown;
        },
      });

    const fulfil = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convert(pausing(tx), order, "2.000000", "2026-01-11"),
      ),
    );
    await atLink;
    const reversal = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) => reverse(tx, do1, "2026-01-11")),
    );
    try {
      await someoneWaits();
    } finally {
      resume();
    }
    expect(await Promise.all([fulfil, reversal])).toEqual([
      { ok: true, message: "" },
      { ok: true, message: "" },
    ]);
    expect(await settledDeadlocks(before)).toBe(before);
    // DO1's three are released by its reversal; the drafted second delivery holds its two.
    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, order.documentId),
    );
    expect(line!.openQuantity).toBe("8.000000");
  });

  it("an ordinary reversal of a linked delivery takes no document_link key; the reversal of that reversal, which reinstates the claim, does", async () => {
    const order = await issuedOrder("5.000000", "45.0000");
    const do1 = await deliverPosted(order, "2.000000", "2026-01-12");
    const holder = await holdLineKey(order.lineIds[0]!);
    // Depth 0: DO1 is linked against the order line, but reversing it can only release that claim. On 04cf7ef
    // it waited for the held key, and the lock timeout below cancelled it.
    const ordinary = await outcomeOf(
      withTenant(db.rw, s.tenant, s.human, async (tx) => {
        await tx`set local lock_timeout = '2s'`;
        return reverse(tx, do1, "2026-01-13");
      }),
    );
    // Depth 2: reversing the mirror reinstates DO1's claim on the order line (0116 §4), so the line's key is
    // still taken up front, before the mirror's audited writes — here it waits for the holder and times out.
    const [mirror] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.document where reverses_document_id = ${do1}`,
    );
    const reinstating = await outcomeOf(
      withTenant(db.rw, s.tenant, s.human, async (tx) => {
        await tx`set local lock_timeout = '2s'`;
        return reverse(tx, mirror?.id ?? do1, "2026-01-14");
      }),
    );
    await holder.release();
    expect(ordinary).toEqual({ ok: true, message: "" });
    expect(reinstating.ok).toBe(false);
    expect(reinstating.message).toMatch(/lock timeout/);
    // Released, the same reinstating reversal posts.
    await withTenant(db.rw, s.tenant, s.human, (tx) => reverse(tx, mirror!.id, "2026-01-14"));
    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, order.documentId),
    );
    expect(line!.openQuantity).toBe("3.000000");
  });

  it("convertOrderToDelivery waits for the order line's key before its first audited write", async () => {
    const order = await issuedOrder("4.000000", "36.0000");
    const holder = await holdLineKey(order.lineIds[0]!);
    const drafting = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) => convert(tx, order, "1.000000", "2026-01-15")),
    );
    let free: boolean;
    try {
      await someoneWaits();
      // On 04cf7ef the draft's document INSERT had already taken the tenant's key when the link waited.
      free = await tenantSerialFree();
    } finally {
      await holder.release();
    }
    expect(await drafting).toEqual({ ok: true, message: "" });
    expect(free).toBe(true);
  });

  it("draftTransferReceipt waits for the dispatch line's key before its first audited write", async () => {
    const dispatch = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whMain,
        toWarehouseId: whBranch,
        effectiveDate: "2026-01-16",
        series: "TRF",
        documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: "3.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      return drafted;
    });
    const holder = await holdLineKey(dispatch.lineIds[0]!);
    const drafting = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: dispatch.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate: "2026-01-17",
        }),
      ),
    );
    let free: boolean;
    try {
      await someoneWaits();
      free = await tenantSerialFree();
    } finally {
      await holder.release();
    }
    expect(await drafting).toEqual({ ok: true, message: "" });
    expect(free).toBe(true);
  });
});
