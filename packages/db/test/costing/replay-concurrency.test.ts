import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postInventoryDocument,
  recordingJobs,
  secondPrincipal,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { lockTenantAuditSerial } from "../../src/costing/invalidate";
import { replay } from "../../src/costing/replay";
import { recordOverride } from "../../src/posting/lifecycle";
import { loadDocumentTypes } from "../../src/seed/document-types";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

type Hook = (text: string, values: readonly unknown[]) => Promise<void> | undefined;

/** The pool `replay` is handed, with every statement of every transaction it opens shown to `hook` first —
 *  see replay-restart.test.ts, where the same seam is documented. A hook that returns a promise runs another
 *  session's work to COMMIT before the statement executes; one that throws is a crash at that statement. */
function instrumented(pool: Sql, hook: Hook): Sql {
  const wrapTx = (tx: Sql): Sql =>
    new Proxy(tx, {
      apply(target, thisArg, args: unknown[]) {
        const [strings, ...values] = args;
        if (Array.isArray(strings) && "raw" in strings) {
          const waitFor = hook((strings as readonly string[]).join("?"), values);
          if (waitFor !== undefined) {
            return waitFor.then(() => Reflect.apply(target, thisArg, args) as unknown);
          }
        }
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    });
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "begin") {
        return (...args: unknown[]) => {
          const callback = args.at(-1) as (tx: Sql) => Promise<unknown>;
          return (target.begin as (...a: unknown[]) => Promise<unknown>)(
            ...args.slice(0, -1),
            (tx: Sql) => callback(wrapTx(tx)),
          );
        };
      }
      return Reflect.get(target, prop, target) as unknown;
    },
  });
}

const isBatchRead = (text: string): boolean =>
  text.includes(`m.movement_no as "movementNo"`) && text.includes("limit");
const isStockLock = (text: string): boolean => text.includes("pg_advisory_xact_lock");

/**
 * Code review 2 — F4. The replay's step 2 re-invalidates the window once, in its own transaction, and the
 * forward pass then reads the tail batch by batch. A document posted in between — an ORDINARY post, which
 * invalidates nothing — was read by the next batch as it stood: an issue got a second VALID consumption set
 * beside its post-time one (step 4 then summed both), and a receipt's layer was pushed into the in-memory
 * open set twice, so every earlier-dated issue in the batch was averaged over a layer dated after it.
 *
 * Every case compares the run with the post landing INSIDE the replay against a control tenant where the same
 * post lands just BEFORE it — which step 2 already handles — and asserts the two end identically.
 */
describe("code review 2 — a document posted while the replay runs is costed once, in date order (F4)", () => {
  let db: Db;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
    );
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  interface World {
    s: Seed;
    receiptType: string;
    issueType: string;
    items: Record<string, string>;
    warehouseId: string;
    supervisorId: string | null;
  }

  async function world(name: string, itemCodes: readonly string[] = ["X"]): Promise<World> {
    const s = await seedTenantV2(db, name);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    const receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    const items: Record<string, string> = {};
    for (const code of itemCodes) {
      items[code] = (await seedItem(db, s, { code: `${name}-${code}`, trackLots: false })).itemId;
    }
    const warehouseId = await seedWarehouse(db, s, { code: `${name}-WH` });
    return { s, receiptType, issueType, items, warehouseId, supervisorId: null };
  }

  async function post(
    w: World,
    kind: "receipt" | "issue" | "override",
    item: string,
    quantity: string,
    on: string,
    opts: { unitPrice?: string; lines?: number } = {},
  ): Promise<string> {
    let supervisorId: string | null = null;
    if (kind === "override") {
      if (w.supervisorId === null) {
        w.supervisorId = await secondPrincipal(db, w.s, "sup");
        await grantCodes(db, w.s, {
          codes: ["inventory.negative_stock.override"],
          principalId: w.supervisorId,
          roleCode: "sup",
        });
      }
      supervisorId = w.supervisorId;
    }
    const itemId = w.items[item]!;
    const { documentId } = await postInventoryDocument(db, w.s, {
      documentTypeId: kind === "receipt" ? w.receiptType : w.issueType,
      warehouseId: w.warehouseId,
      effectiveDate: on,
      jobs: recordingJobs(),
      lines: Array.from({ length: opts.lines ?? 1 }, () => ({
        itemId,
        warehouseId: w.warehouseId,
        quantity,
        unitPrice: opts.unitPrice ?? "50.0000",
      })),
      ...(supervisorId === null
        ? {}
        : {
            beforePost: async (tx: Sql, id: string) =>
              recordOverride(
                tx,
                { tenantId: w.s.tenant, actorId: w.s.human, requestId: await uuidv7(db.admin) },
                {
                  documentId: id,
                  code: "inventory.negative_stock.override",
                  reason: "authorised negative-stock excursion (code review 2 fixture)",
                  attributedTo: supervisorId,
                },
              ),
          }),
    });
    return documentId;
  }

  async function runReplay(w: World, pool: Sql = db.rw) {
    const ctx = { tenantId: w.s.tenant, actorId: w.s.system, requestId: await uuidv7(db.admin) };
    return replay(
      pool,
      { tenantId: w.s.tenant, requestId: ctx.requestId, payload: { companyId: w.s.company } },
      ctx,
    );
  }

  /** Runs `action` to commit exactly once, just before the first statement `when` accepts. */
  function inject(
    when: (text: string, values: readonly unknown[]) => boolean,
    action: () => Promise<unknown>,
  ) {
    const state = { fired: false };
    const pool = instrumented(db.rw, (text, values) => {
      if (state.fired || !when(text, values)) return undefined;
      state.fired = true;
      return action().then(() => undefined);
    });
    return { pool, state };
  }

  /** Every figure the two runs must agree on, keyed by document ORDER (the ids differ between tenants). */
  async function figures(w: World, documents: readonly string[]) {
    return withTenant(db.rw, w.s.tenant, w.s.human, async (tx) => {
      const balance = async (code: string) => {
        const [row] = await tx<{ bal: string }[]>`
          select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::numeric(19,4)::text as bal
            from app.ledger_entry e join app.account a on a.id = e.account_id
           where e.company_id = ${w.s.company} and a.code = ${code}`;
        return row!.bal;
      };
      const [layers] = await tx<{ value: string; qty: string }[]>`
        select coalesce(sum(round(value * qty_remaining / qty_in, 4)), 0)::numeric(19,4)::text as value,
               coalesce(sum(qty_remaining), 0)::numeric(19,6)::text as qty
          from app.cost_layer where company_id = ${w.s.company} and invalidated_at is null`;
      const [onHand] = await tx<{ qty: string }[]>`
        select coalesce(sum(quantity), 0)::numeric(19,6)::text as qty
          from app.inventory_movement where company_id = ${w.s.company}`;
      const perDocument = [];
      for (const id of documents) {
        const [row] = await tx<{ cost: string | null; consumed: string; consumed_value: string }[]>`
          select (select sum(cost)::numeric(19,4)::text from app.document_line where document_id = ${id}) as cost,
                 coalesce(sum(c.quantity), 0)::numeric(19,6)::text as consumed,
                 coalesce(sum(c.value), 0)::numeric(19,4)::text as consumed_value
            from app.inventory_movement m
            left join app.cost_consumption c on c.tenant_id = m.tenant_id and c.movement_id = m.id
                                            and c.invalidated_at is null
           where m.document_id = ${id}`;
        perDocument.push(row!);
      }
      const [invalid] = await tx<{ n: number }[]>`
        select (select count(*)::int from app.cost_layer where company_id = ${w.s.company} and invalidated_at is not null)
             + (select count(*)::int from app.cost_booking where company_id = ${w.s.company} and pending is not null) as n`;
      return {
        inventory: await balance("1300"),
        cogs: await balance("5000"),
        layers: layers!.value,
        layerQty: layers!.qty,
        onHand: onHand!.qty,
        perDocument,
        leftPending: invalid!.n,
      };
    });
  }

  it("case A: an ordinary issue posted after step 2 is costed once and books its own difference", async () => {
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "10.000000", "2026-01-01", { unitPrice: "4.0000" }),
        await post(w, "receipt", "X", "10.000000", "2026-01-05", { unitPrice: "5.0000" }),
        await post(w, "issue", "X", "4.000000", "2026-01-10"),
        await post(w, "receipt", "X", "10.000000", "2026-01-03", { unitPrice: "7.0000" }),
      ];
      return { w, docs };
    };
    const newIssue = (w: World) => post(w, "issue", "X", "5.000000", "2026-01-20");

    const control = await build("F4A-CTRL");
    const controlN = await newIssue(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, controlN]);
    // Exact remaining-value decrements price the issue of 5 at 26.6667, preserving the receipt total.
    expect(expected.perDocument[4]).toEqual({
      cost: "26.6667",
      consumed: "5.000000",
      consumed_value: "26.6667",
    });
    expect(expected.layerQty).toBe(expected.onHand);

    const { w, docs } = await build("F4A");
    let n = "";
    // After step 2 committed: the first batch read is the forward pass's first statement.
    const { pool, state } = inject(isBatchRead, async () => {
      n = await newIssue(w);
    });
    await runReplay(w, pool);
    expect(state.fired).toBe(true);
    expect(await figures(w, [...docs, n])).toEqual(expected);
  }, 300_000);

  it("case C: a receipt posted after step 2 is opened once, in its own place in the order", async () => {
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "10.000000", "2026-01-01", { unitPrice: "4.0000" }),
        await post(w, "issue", "X", "4.000000", "2026-01-10"),
        await post(w, "receipt", "X", "10.000000", "2026-01-03", { unitPrice: "7.0000" }),
      ];
      return { w, docs };
    };
    const newReceipt = (w: World) =>
      post(w, "receipt", "X", "10.000000", "2026-01-20", { unitPrice: "9.0000" });

    const control = await build("F4C-CTRL");
    const controlR = await newReceipt(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, controlR]);
    // The Jan-10 issue averages the Jan-1 and Jan-3 layers only: 4 × (40 + 70) / 20 = 22.0000.
    expect(expected.perDocument[1]!.cost).toBe("22.0000");
    expect(expected).toMatchObject({ inventory: "178.0000", layers: "178.0000" });

    const { w, docs } = await build("F4C");
    let r = "";
    const { pool, state } = inject(isBatchRead, async () => {
      r = await newReceipt(w);
    });
    await runReplay(w, pool);
    expect(state.fired).toBe(true);
    expect(await figures(w, [...docs, r])).toEqual(expected);
  }, 300_000);

  it("a post between a batch's read and its stock lock is read under the lock, not skipped", async () => {
    // Two items, so the batch's range runs PAST the new post's date: Y's issue on the 25th sorts after X's
    // new issue on the 20th, and a batch that took its rows before the post committed would step over it.
    const build = async (name: string) => {
      const w = await world(name, ["X", "Y"]);
      const docs = [
        await post(w, "receipt", "X", "10.000000", "2026-01-01", { unitPrice: "4.0000" }),
        await post(w, "receipt", "Y", "10.000000", "2026-01-01", { unitPrice: "3.0000" }),
        await post(w, "issue", "X", "4.000000", "2026-01-10"),
        await post(w, "issue", "Y", "4.000000", "2026-01-25"),
        await post(w, "receipt", "X", "10.000000", "2026-01-03", { unitPrice: "7.0000" }),
        await post(w, "receipt", "Y", "10.000000", "2026-01-02", { unitPrice: "6.0000" }),
      ];
      return { w, docs };
    };
    const newIssue = (w: World) => post(w, "issue", "X", "5.000000", "2026-01-20");

    const control = await build("F4L-CTRL");
    const controlN = await newIssue(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, controlN]);
    expect(expected.leftPending).toBe(0);

    const { w, docs } = await build("F4L");
    let n = "";
    let readSeen = false;
    const { pool, state } = inject(
      (text) => {
        if (isBatchRead(text)) readSeen = true;
        // The first stock lock AFTER the forward pass's first read: the rows are in memory, unlocked.
        return readSeen && isStockLock(text);
      },
      async () => {
        n = await newIssue(w);
      },
    );
    await runReplay(w, pool);
    expect(state.fired).toBe(true);
    expect(await figures(w, [...docs, n])).toEqual(expected);
  }, 300_000);

  it("a post between two batches is costed once, and 1300 still ties to the layers", async () => {
    // 600 @ 5, 505 issue lines of 1 on the 10th, then 100 @ 8 back-dated to the 7th: a two-batch window. The
    // new issue lands after the first batch committed.
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "600.000000", "2026-01-05", { unitPrice: "5.0000" }),
        await post(w, "issue", "X", "1.000000", "2026-01-10", { lines: 505 }),
        await post(w, "receipt", "X", "100.000000", "2026-01-07", { unitPrice: "8.0000" }),
      ];
      return { w, docs };
    };
    const newIssue = (w: World) => post(w, "issue", "X", "5.000000", "2026-01-20");

    const control = await build("F4B-CTRL");
    const controlN = await newIssue(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, controlN]);

    const { w, docs } = await build("F4B");
    let n = "";
    let first: string | null = null;
    const { pool, state } = inject(
      (text, values) => {
        if (!isBatchRead(text)) return false;
        const cursor = JSON.stringify(values.slice(2, 6).map(String));
        first ??= cursor;
        return cursor !== first;
      },
      async () => {
        n = await newIssue(w);
      },
    );
    await runReplay(w, pool);
    expect(state.fired).toBe(true);
    expect(await figures(w, [...docs, n])).toEqual(expected);
  }, 600_000);

  it("a run that dies after a concurrent uncovered issue is resumed from that issue", async () => {
    // No receipt before the back-dated one, so an issue posted while the replay runs finds every layer of the
    // item invalid and is booked at 0.0000 with no consumption row. The window is exactly one batch (the
    // receipt and 499 lines), so the new issue is the first movement AFTER it, and the run dies before
    // reaching it. The rerun has nothing but that issue's own mark to start from.
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "override", "X", "1.000000", "2026-01-10", { lines: 499 }),
        await post(w, "receipt", "X", "600.000000", "2026-01-03", { unitPrice: "7.0000" }),
      ];
      return { w, docs };
    };
    const newIssue = (w: World) => post(w, "override", "X", "2.000000", "2026-01-20");

    const control = await build("F4R-CTRL");
    const controlN = await newIssue(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, controlN]);
    // 499 lines and the new issue of 2, all at 7.0000.
    expect(expected.perDocument[2]).toEqual({
      cost: "14.0000",
      consumed: "2.000000",
      consumed_value: "14.0000",
    });

    const { w, docs } = await build("F4R");
    let n = "";
    let reads = 0;
    let first: string | null = null;
    const pool = instrumented(db.rw, (text, values) => {
      if (!isBatchRead(text)) return undefined;
      reads += 1;
      const cursor = JSON.stringify(values.slice(2, 6).map(String));
      first ??= cursor;
      if (reads === 1) {
        return newIssue(w).then((id) => {
          n = id;
        });
      }
      if (cursor !== first) throw new Error("simulated crash at the second batch");
      return undefined;
    });
    await expect(runReplay(w, pool)).rejects.toThrow(/simulated crash/);
    await runReplay(w);
    expect(await figures(w, [...docs, n])).toEqual(expected);
  }, 600_000);

  it("a receipt posted while a two-batch replay runs stays available to a poster between the batches", async () => {
    // The verification of F4's first fix. That fix kept a concurrently posted receipt out of the batch's open
    // set by INVALIDATING every layer at or after the batch cursor, so from the first batch that covered the
    // receipt's pair until the batch that reached it, a poster could not use the stock: the issue of 220 below,
    // with 245 on hand, was refused "only 201.000000 remains". Before F4's fix it posted. Keeping the layer out
    // of the batch's IN-MEMORY open set is all the costing needs; the stock stays available (F5 is the owner's
    // question and this must not widen it).
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "600.000000", "2026-01-05", { unitPrice: "5.0000" }),
        await post(w, "issue", "X", "1.000000", "2026-01-10", { lines: 505 }),
        await post(w, "receipt", "X", "100.000000", "2026-01-07", { unitPrice: "8.0000" }),
      ];
      return { w, docs };
    };
    const newReceipt = (w: World) =>
      post(w, "receipt", "X", "50.000000", "2026-01-20", { unitPrice: "9.0000" });
    const newIssue = (w: World) => post(w, "issue", "X", "220.000000", "2026-01-20");

    // The control: the receipt lands before the replay and the issue after it, so both are costed in date
    // order with nothing in flight.
    const control = await build("F4S-CTRL");
    const controlR = await newReceipt(control.w);
    await runReplay(control.w);
    const controlN = await newIssue(control.w);
    const expected = await figures(control.w, [...control.docs, controlR, controlN]);
    expect(expected.leftPending).toBe(0);

    const { w, docs } = await build("F4S");
    let r = "";
    let n = "";
    let outcome = "not tried";
    let reads = 0;
    let first: string | null = null;
    const pool = instrumented(db.rw, (text, values) => {
      if (!isBatchRead(text)) return undefined;
      reads += 1;
      const cursor = JSON.stringify(values.slice(2, 6).map(String));
      first ??= cursor;
      // The receipt, before the first batch locks its pair; the issue, after that batch COMMITTED and before
      // the second one reads.
      if (reads === 1) {
        return newReceipt(w).then((id) => {
          r = id;
        });
      }
      if (outcome === "not tried" && cursor !== first) {
        return newIssue(w).then(
          (id) => {
            n = id;
            outcome = "posted";
          },
          (error: unknown) => {
            outcome = String(error);
          },
        );
      }
      return undefined;
    });
    await runReplay(w, pool);
    expect(outcome).toBe("posted");
    expect(await figures(w, [...docs, r, n])).toEqual(expected);
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  }, 600_000);

  it("a run that dies with a mid-run receipt at its batch boundary is resumed as an uninterrupted run ends", async () => {
    // The guard for the change above: a receipt posted while the replay runs now stays VALID, so it no longer
    // marks where a rerun starts. The window is exactly one batch (the back-dated receipt and 499 lines), so
    // the new receipt is the first movement after it and carries no mark; the issue after it consumed it, so
    // the batch re-invalidated that issue's set and marked it. The run dies before a second batch, and the
    // rerun must end where an uninterrupted run does.
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "600.000000", "2026-01-05", { unitPrice: "5.0000" }),
        await post(w, "issue", "X", "1.000000", "2026-01-10", { lines: 499 }),
        await post(w, "receipt", "X", "100.000000", "2026-01-07", { unitPrice: "8.0000" }),
      ];
      return { w, docs };
    };
    const extra = async (w: World) => [
      await post(w, "receipt", "X", "50.000000", "2026-01-20", { unitPrice: "9.0000" }),
      await post(w, "issue", "X", "30.000000", "2026-01-21"),
    ];

    const control = await build("F4E-CTRL");
    const controlX = await extra(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, ...controlX]);
    expect(expected.leftPending).toBe(0);
    expect(expected.layerQty).toBe(expected.onHand);

    const { w, docs } = await build("F4E");
    let x: string[] = [];
    let reads = 0;
    let first: string | null = null;
    const pool = instrumented(db.rw, (text, values) => {
      if (!isBatchRead(text)) return undefined;
      reads += 1;
      const cursor = JSON.stringify(values.slice(2, 6).map(String));
      first ??= cursor;
      if (reads === 1) {
        return extra(w).then((ids) => {
          x = ids;
        });
      }
      if (cursor !== first) throw new Error("simulated crash at the second batch");
      return undefined;
    });
    await expect(runReplay(w, pool)).rejects.toThrow(/simulated crash/);
    await runReplay(w);
    expect(await figures(w, [...docs, ...x])).toEqual(expected);
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  }, 600_000);

  it("an issue a concurrent back-dated post invalidated gives its layers back before the batch costs the tail", async () => {
    // An ordinary issue posts after step 2, then a back-dated receipt dated between it and the cursor
    // invalidates that issue's consumptions — `invalidateFrom` never restores a layer (that is step 2's job,
    // and step 2 has already run). The batch's own re-invalidation then finds nothing still valid to return,
    // so a restore scoped to what IT invalidated left the layers the issue consumed short by 5, costed the tail
    // against them, and moved the back-dated post's marks to 'booking': the replay that post enqueued found
    // nothing to do, and the error stayed for good (layers 16 against 21 on hand). Predates F4's fix.
    const build = async (name: string) => {
      const w = await world(name);
      const docs = [
        await post(w, "receipt", "X", "10.000000", "2026-01-01", { unitPrice: "4.0000" }),
        await post(w, "issue", "X", "4.000000", "2026-01-10"),
        await post(w, "receipt", "X", "10.000000", "2026-01-03", { unitPrice: "7.0000" }),
      ];
      return { w, docs };
    };
    const extra = async (w: World) => [
      await post(w, "issue", "X", "5.000000", "2026-01-20"),
      await post(w, "receipt", "X", "10.000000", "2026-01-15", { unitPrice: "9.0000" }),
    ];

    const control = await build("F4P-CTRL");
    const controlX = await extra(control.w);
    await runReplay(control.w);
    const expected = await figures(control.w, [...control.docs, ...controlX]);
    // The Jan-10 issue averages Jan 1 and Jan 3 only: 4 × (40 + 70) / 20 = 22.0000; and every unit on hand
    // is in a valid layer.
    expect(expected.perDocument[1]!.cost).toBe("22.0000");
    expect(expected.layerQty).toBe(expected.onHand);
    expect(expected.leftPending).toBe(0);

    const { w, docs } = await build("F4P");
    let x: string[] = [];
    const { pool, state } = inject(isBatchRead, async () => {
      x = await extra(w);
    });
    await runReplay(w, pool);
    expect(state.fired).toBe(true);
    expect(await figures(w, [...docs, ...x])).toEqual(expected);
    // The replay the back-dated receipt enqueued finds the work done, and leaves every figure as it is.
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
    expect(await figures(w, [...docs, ...x])).toEqual(expected);
  }, 300_000);

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
  /** Returns once some backend of this database waits on a heavyweight lock: a row, a transaction id or an
   *  advisory key. */
  const someoneWaits = async (): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the concurrent post never waited on a lock");
  };

  /**
   * Code review 3, R1. A replay transaction locked its cost rows — booking rows in step 4, stock keys and
   * consumption, layer and booking rows in a step-3 batch — BEFORE its first audited write, and that write
   * takes the tenant's audit serialisation (`app.audit_chain`, 0010's `tenant-serial:` key). A poster takes
   * them the other way round: the audit lock at its first audited write, which comes before every stock key and
   * cost row it touches, and held to commit. So a post that reached a row or key the replay held waited for it
   * while holding the lock the replay was about to ask for: a deadlock, which Postgres broke by aborting one
   * side and `withTenant` hid with its single retry (a second deadlock fails the post, or the job).
   *
   * Each case starts a back-dated receipt, WITHOUT waiting for it, at a statement where the replay holds its
   * row locks, lets the replay go on once the post waits on a lock, and asserts the deadlock counter never
   * moves, and that every figure ends where a control ends in which the receipt posted first.
   */
  const lockOrderCases: { name: string; tag: string; at: (text: string) => boolean }[] = [
    // Step 4: after the group's `for update of b`, before the valuation and the COST_ADJUSTMENT insert. The
    // poster reaches `invalidateFrom`'s booking upsert and waits on the row.
    { name: "step 4's group", tag: "R1B", at: (text) => text.includes("generation as (") },
    // Step 3: after the batch's stock locks, at its re-invalidation. The poster waits on the pair's stock key
    // at postDocument step 9; the batch's first audited write is its `document_line.cost` update.
    {
      name: "a step-3 batch",
      tag: "R1S",
      at: (text) => text.includes("update app.cost_consumption c") && text.includes("returning"),
    },
  ];
  for (const { name, tag, at } of lockOrderCases) {
    it(`a back-dated post while ${name} holds its locks waits for the replay rather than deadlocking with it (code review 3, R1)`, async () => {
      const build = async (label: string) => {
        const w = await world(label);
        const docs = [
          await post(w, "receipt", "X", "10.000000", "2026-01-05", { unitPrice: "5.0000" }),
          await post(w, "issue", "X", "10.000000", "2026-01-10"),
          await post(w, "receipt", "X", "10.000000", "2026-01-07", { unitPrice: "8.0000" }),
        ];
        return { w, docs };
      };
      const backDated = (w: World) =>
        post(w, "receipt", "X", "5.000000", "2026-01-08", { unitPrice: "9.0000" });

      const control = await build(`${tag}-CTRL`);
      const controlR = await backDated(control.w);
      await runReplay(control.w);
      const expected = await figures(control.w, [...control.docs, controlR]);
      // AVCO over 10 @ 5, 10 @ 8 and 5 @ 9: the Jan-10 issue of 10 costs 10 × 175 / 25 = 70.0000.
      expect(expected.perDocument[1]!.cost).toBe("70.0000");
      expect(expected.leftPending).toBe(0);

      const { w, docs } = await build(tag);
      const before = await deadlocks();
      const concurrent: { poster?: Promise<{ id: string } | { error: string }> } = {};
      const { pool, state } = inject(at, async () => {
        concurrent.poster = backDated(w).then(
          (id) => ({ id }),
          (error: unknown) => ({ error: String(error) }),
        );
        await someoneWaits();
      });
      await runReplay(w, pool);
      expect(state.fired).toBe(true);
      const outcome = await concurrent.poster!;
      expect(await settledDeadlocks(before)).toBe(before);
      expect(outcome).toHaveProperty("id");
      // The replay the back-dated receipt enqueued.
      await runReplay(w);
      expect(await figures(w, [...docs, (outcome as { id: string }).id])).toEqual(expected);
    }, 300_000);
  }

  it("the replay's lock is app.audit_chain's key for any spelling of the tenant id (code review 3, R1)", async () => {
    // 0010's trigger keys the lock on `new.tenant_id::text`, the uuid column's canonical form. A key built
    // from the caller's string instead is a different lock for any other spelling Postgres accepts as the
    // same uuid — braces, upper case, no hyphens — and the lock order would silently stop applying.
    const s = await seedTenantV2(db, "R1K");
    const spelled = `{${s.tenant.toUpperCase()}}`;
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await lockTenantAuditSerial(tx, spelled);
      held();
      await released;
    });
    await isHeld;
    // The trigger's own expression, from another session: the key must already be taken.
    const [row] = await db.admin<{ free: boolean }[]>`
      select pg_try_advisory_xact_lock(
               hashtextextended('tenant-serial:' || ${s.tenant}::uuid::text, 0)) as free`;
    release();
    await holder;
    expect(row!.free).toBe(false);
  }, 120_000);
});
