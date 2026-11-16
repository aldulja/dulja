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
import { MOVEMENTS_PER_BATCH, replay } from "../../src/costing/replay";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
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

/** Resolved from this file: Vitest runs this package from `packages/db` (1a:5114). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

/** One statement's template text, with each interpolation shown as `?`. */
type Hook = (text: string, values: readonly unknown[]) => Promise<void> | undefined;

/**
 * `replay` opens its own transactions from the pool it is handed, so the only seam a DB-tier test has into the
 * middle of a run is the pool itself. This wraps it: every statement of every transaction the replay opens is
 * shown to `hook` first, which may throw (a crash at that statement: the transaction rolls back, the job fails)
 * or return a promise to wait on (another session's work, committed before the statement runs). Anything that
 * returns `undefined` passes through untouched, so nested fragments and helper calls are unaffected.
 */
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

/** The forward pass's batch read — the one statement that names the cursor and the batch limit. */
const isBatchRead = (text: string): boolean =>
  text.includes(`m.movement_no as "movementNo"`) && text.includes("limit");
/** Step 4's COST_ADJUSTMENT header insert. */
const isAdjustmentHeader = (text: string): boolean =>
  /insert into app\.document \(/.test(text) && text.includes("'CA'");

/**
 * Code review 2 — C1 and C2. The replay's restart state lived only in rows the replay itself rewrites: a
 * movement was "in scope" while its consumptions were invalidated, and "before" was the latest invalidated
 * generation. So a run that recosted a movement and then could not BOOK the difference — no open period, or a
 * crash between the forward pass and the adjustment — left nothing for the next run to find (C1), and a
 * generation with no consumption row at all (a wholly uncovered issue) was invisible, so the next run compared
 * against an OLDER generation and booked the same reversal again, every run (C2). Each case below runs in its
 * own tenant, and each figure is derived in its comment.
 */
describe("code review 2 — a recost is booked exactly once, however the run ends (C1, C2)", () => {
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
    itemId: string;
    warehouseId: string;
    supervisorId: string | null;
  }

  async function world(name: string): Promise<World> {
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
    // Lot-less, so every issue line is ONE movement over one (item, warehouse) layer set.
    const { itemId } = await seedItem(db, s, { code: `${name}-ITEM`, trackLots: false });
    const warehouseId = await seedWarehouse(db, s, { code: `${name}-WH` });
    return { s, receiptType, issueType, itemId, warehouseId, supervisorId: null };
  }

  async function receive(w: World, quantity: string, unitPrice: string, on: string) {
    const jobs = recordingJobs();
    const { documentId } = await postInventoryDocument(db, w.s, {
      documentTypeId: w.receiptType,
      warehouseId: w.warehouseId,
      effectiveDate: on,
      jobs,
      lines: [{ itemId: w.itemId, warehouseId: w.warehouseId, quantity, unitPrice }],
    });
    return { documentId, jobs };
  }

  /** `lines` issue lines of `quantity` each, on one document. */
  async function issue(w: World, quantity: string, on: string, lines = 1) {
    const { documentId } = await postInventoryDocument(db, w.s, {
      documentTypeId: w.issueType,
      warehouseId: w.warehouseId,
      effectiveDate: on,
      jobs: recordingJobs(),
      lines: Array.from({ length: lines }, () => ({
        itemId: w.itemId,
        warehouseId: w.warehouseId,
        quantity,
        unitPrice: "50.0000",
      })),
    });
    return documentId;
  }

  /** An issue the layers cannot cover, authorised by a second principal (F-6). `postOverriddenIssue` grants a
   *  fixed role code and so runs once per tenant; these cases need two overrides in one tenant. */
  async function overriddenIssue(w: World, quantity: string, on: string) {
    if (w.supervisorId === null) {
      w.supervisorId = await secondPrincipal(db, w.s, "sup");
      await grantCodes(db, w.s, {
        codes: ["inventory.negative_stock.override"],
        principalId: w.supervisorId,
        roleCode: "sup",
      });
    }
    const supervisorId = w.supervisorId;
    const { documentId } = await postInventoryDocument(db, w.s, {
      documentTypeId: w.issueType,
      warehouseId: w.warehouseId,
      effectiveDate: on,
      jobs: recordingJobs(),
      lines: [{ itemId: w.itemId, warehouseId: w.warehouseId, quantity, unitPrice: "50.0000" }],
      beforePost: async (tx, id) =>
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

  async function setPeriods(w: World, status: "open" | "closed", startsOn?: string) {
    await withTenant(db.migrator, w.s.tenant, w.s.system, (tx) =>
      status === "closed"
        ? tx`update app.fiscal_period set status = 'closed' where company_id = ${w.s.company}`
        : tx`update app.fiscal_period set status = 'open', reopen_reason = 'code review 2: book the recost'
              where company_id = ${w.s.company} and starts_on = ${startsOn!}::date`,
    );
  }

  /** The ledger on 1300 and 5000, the valid layers' value, Σ issue cost, and how many adjustments exist. */
  async function figures(w: World) {
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
      const [cost] = await tx<{ total: string }[]>`
        select coalesce(sum(l.cost), 0)::numeric(19,4)::text as total
          from app.document_line l join app.document d on d.id = l.document_id
         where d.company_id = ${w.s.company} and d.document_type_id = ${w.issueType}`;
      const [adjustments] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${w.s.company} and t.code = 'COST_ADJUSTMENT'`;
      return {
        inventory: await balance("1300"),
        cogs: await balance("5000"),
        layers: layers!.value,
        layerQty: layers!.qty,
        cost: cost!.total,
        adjustments: adjustments!.n,
      };
    });
  }

  async function lineCost(w: World, documentId: string): Promise<string> {
    const [row] = await withTenant(
      db.rw,
      w.s.tenant,
      w.s.human,
      (tx) => tx<{ cost: string }[]>`
        select sum(cost)::numeric(19,4)::text as cost from app.document_line where document_id = ${documentId}`,
    );
    return row!.cost;
  }

  async function adjustment(w: World, documentId: string) {
    return withTenant(
      db.rw,
      w.s.tenant,
      w.s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.base_debit::text as debit, e.base_credit::text as credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code`,
    );
  }

  /** 10 @ 5 on the 5th, an issue of 10 on the 10th (50.0000), then 10 @ 8 back-dated to the 7th. The issue
   *  now takes 5 from each layer at the (50 + 80) / 20 = 6.5000 average: 65.0000, a 15.0000 rise. */
  async function recostOfFifteen(name: string) {
    const w = await world(name);
    await receive(w, "10.000000", "5.0000", "2026-01-05");
    const issueId = await issue(w, "10.000000", "2026-01-10");
    const { jobs } = await receive(w, "10.000000", "8.0000", "2026-01-07");
    expect(jobs.enqueued.map((j) => j.name)).toContain("inventory.cost.replay");
    return { w, issueId };
  }

  it("C1(a): a recost that found no open period is booked by the run after a period is reopened", async () => {
    const { w, issueId } = await recostOfFifteen("C1A");
    await setPeriods(w, "closed");

    // The incident path: the layers are rewritten and nothing can post.
    expect((await runReplay(w)).adjustmentsPosted).toEqual([]);
    expect(await lineCost(w, issueId)).toBe("65.0000");
    expect(await figures(w)).toMatchObject({
      cogs: "50.0000",
      inventory: "80.0000",
      layers: "65.0000",
    });

    // The incident's own instruction: reopen a period and re-enqueue. The rerun must post the 15.0000 the
    // first run could not — it previously found nothing in scope and posted nothing, for ever.
    await setPeriods(w, "open", "2026-01-01");
    const rerun = await runReplay(w);
    expect(rerun.adjustmentsPosted).toHaveLength(1);
    expect(await adjustment(w, rerun.adjustmentsPosted[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "15.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000" },
    ]);
    expect(await figures(w)).toEqual({
      inventory: "65.0000",
      cogs: "65.0000",
      layers: "65.0000",
      layerQty: "10.000000",
      cost: "65.0000",
      adjustments: 1,
    });
    // …and once booked it is booked: a further run posts nothing.
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  }, 300_000);

  it("C1(b): a run that dies between the forward pass and the adjustment is completed by the rerun", async () => {
    const { w } = await recostOfFifteen("C1B");
    let armed = true;
    const crashing = instrumented(db.rw, (text) => {
      if (armed && isAdjustmentHeader(text)) {
        armed = false;
        throw new Error("simulated crash before step 4 posts");
      }
      return undefined;
    });
    await expect(runReplay(w, crashing)).rejects.toThrow(/simulated crash/);
    expect(armed).toBe(false);
    // The forward pass committed: the cost reads 65 while the ledger still carries 50.
    expect(await figures(w)).toMatchObject({ cogs: "50.0000", layers: "65.0000", cost: "65.0000" });

    const rerun = await runReplay(w);
    expect(rerun.adjustmentsPosted).toHaveLength(1);
    expect(await adjustment(w, rerun.adjustmentsPosted[0]!)).toEqual([
      { code: "1300", debit: "0.0000", credit: "15.0000" },
      { code: "5000", debit: "15.0000", credit: "0.0000" },
    ]);
    expect(await figures(w)).toMatchObject({
      inventory: "65.0000",
      cogs: "65.0000",
      layers: "65.0000",
      cost: "65.0000",
      adjustments: 1,
    });
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  }, 300_000);

  it("C1(c): a crash between two forward-pass batches, inside one document, ends where an uninterrupted run does", async () => {
    // 600 @ 5, one issue document of 505 lines of 1 unit, then 100 @ 8 back-dated before it. The replay's
    // window is the receipt plus 505 lines — two batches, the boundary falling inside the document.
    expect(MOVEMENTS_PER_BATCH).toBe(500);
    const build = async (name: string) => {
      const w = await world(name);
      await receive(w, "600.000000", "5.0000", "2026-01-05");
      await issue(w, "1.000000", "2026-01-10", 505);
      await receive(w, "100.000000", "8.0000", "2026-01-07");
      return w;
    };

    const control = await build("C1C-CTRL");
    await runReplay(control);
    const expected = await figures(control);
    // 5000 carries exactly the recomputed cost, and every movement is booked once.
    expect(expected.cogs).toBe(expected.cost);
    expect(expected.adjustments).toBe(1);

    const w = await build("C1C");
    // Crash on the first batch read whose cursor is not the run's start — the second batch.
    let first: string | null = null;
    let armed = true;
    const crashing = instrumented(db.rw, (text, values) => {
      if (!armed || !isBatchRead(text)) return undefined;
      const cursor = JSON.stringify(values.slice(2, 6).map(String));
      first ??= cursor;
      if (cursor !== first) {
        armed = false;
        throw new Error("simulated crash at the second batch");
      }
      return undefined;
    });
    await expect(runReplay(w, crashing)).rejects.toThrow(/simulated crash/);
    expect(armed).toBe(false);

    await runReplay(w);
    const after = await figures(w);
    expect(after).toEqual({ ...expected, adjustments: 1 });
    // The rerun books the whole window's difference, not just the six movements it had left to recompute.
    expect(after.cogs).toBe(after.cost);
    expect(await runReplay(w)).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  }, 600_000);

  it("C2(a): a movement a replay left wholly uncovered is not booked again by every later replay", async () => {
    const w = await world("C2A");
    await receive(w, "100.000000", "5.0000", "2026-01-05");
    // 110 against 100: 500.0000 covered + 10 x 5.0000 of shortfall = 550.0000.
    const m = await overriddenIssue(w, "110.000000", "2026-01-10");
    await receive(w, "100.000000", "6.0000", "2026-01-20");
    // Back-dated to the 7th, 150 against the open layers AS THEY STAND (openLayersFor has no date filter):
    // 100 @ 6 + 50 short at 6.0000 = 900.0000.
    const i0 = await overriddenIssue(w, "150.000000", "2026-01-07");
    expect(await lineCost(w, m)).toBe("550.0000");
    expect(await lineCost(w, i0)).toBe("900.0000");

    // Replay A, in date order: I0 takes the 100 @ 5 and is 50 short at 5.0000 = 750.0000; M finds no open
    // layer at all and costs 0.0000. COGS moves by (750 − 900) + (0 − 550) = −700.0000.
    const a = await runReplay(w);
    expect(a.adjustmentsPosted).toHaveLength(1);
    expect(await adjustment(w, a.adjustmentsPosted[0]!)).toEqual([
      { code: "1300", debit: "700.0000", credit: "0.0000" },
      { code: "5000", debit: "0.0000", credit: "700.0000" },
    ]);
    expect(await lineCost(w, i0)).toBe("750.0000");
    expect(await lineCost(w, m)).toBe("0.0000");
    expect((await figures(w)).cogs).toBe("750.0000");

    // Nothing has changed, so nothing may post. M's generation has no row, and "before" used to fall back to
    // its 550.0000 generation, re-booking −550.0000 on every run: 200.0000, then −350.0000.
    expect((await runReplay(w)).adjustmentsPosted).toEqual([]);
    expect((await runReplay(w)).adjustmentsPosted).toEqual([]);
    expect(await figures(w)).toMatchObject({ cogs: "750.0000", cost: "750.0000", adjustments: 1 });
  }, 300_000);

  it("C2(b): a back-dated issue no layer covered at post still starts the replay, and the answer is date order's", async () => {
    const build = async (name: string, backDated: boolean) => {
      const w = await world(name);
      await receive(w, "120.000000", "5.0000", "2026-01-05");
      let i0: string;
      let m: string;
      if (backDated) {
        // 125 against 120: 600.0000 + 5 x 5.0000 = 625.0000. Then 120 back-dated to the 7th finds every layer
        // empty and costs 0.0000 with no consumption row.
        m = await overriddenIssue(w, "125.000000", "2026-01-10");
        i0 = await overriddenIssue(w, "120.000000", "2026-01-07");
      } else {
        i0 = await overriddenIssue(w, "120.000000", "2026-01-07");
        m = await overriddenIssue(w, "125.000000", "2026-01-10");
      }
      return { w, i0, m };
    };

    // Date order: I0 takes all 120 @ 5 = 600.0000; M finds nothing open and costs 0.0000.
    const control = await build("C2B-CTRL", false);
    expect(await lineCost(control.w, control.i0)).toBe("600.0000");
    expect(await lineCost(control.w, control.m)).toBe("0.0000");
    expect((await figures(control.w)).cogs).toBe("600.0000");

    const { w, i0, m } = await build("C2B", true);
    expect(await lineCost(w, i0)).toBe("0.0000");
    expect(await lineCost(w, m)).toBe("625.0000");
    const out = await runReplay(w);
    expect(out.adjustmentsPosted).toHaveLength(1);
    // (600 − 0) + (0 − 625) = −25.0000.
    expect(await adjustment(w, out.adjustmentsPosted[0]!)).toEqual([
      { code: "1300", debit: "25.0000", credit: "0.0000" },
      { code: "5000", debit: "0.0000", credit: "25.0000" },
    ]);
    expect(await lineCost(w, i0)).toBe("600.0000");
    expect(await lineCost(w, m)).toBe("0.0000");
    const after = await figures(w);
    const expected = await figures(control.w);
    expect({ ...after, adjustments: 0 }).toEqual({ ...expected, adjustments: 0 });
    expect(after.cogs).toBe("600.0000");
    expect((await runReplay(w)).adjustmentsPosted).toEqual([]);
  }, 300_000);

  describe("migration 0115 — app.cost_booking follows Plan Contracts §3.3", () => {
    let a: World;
    let b: World;
    let aMovement: string;

    beforeAll(async () => {
      // Two tenants, each with a back-dated receipt, so invalidateFrom has written booking rows in both.
      ({ w: a } = await recostOfFifteen("T2A"));
      ({ w: b } = await recostOfFifteen("T2B"));
      const [row] = await withTenant(
        db.rw,
        a.s.tenant,
        a.s.human,
        (tx) => tx<{ movement_id: string }[]>`
          select movement_id::text as movement_id from app.cost_booking where company_id = ${a.s.company}`,
      );
      aMovement = row!.movement_id;
    }, 300_000);

    it("the schema linter reports zero violations, and the table is derived: AUDIT_EXEMPT, not IMMUTABLE", async () => {
      expect(await lintSchema(db.admin)).toEqual([]);
      expect(AUDIT_EXEMPT.has("cost_booking")).toBe(true);
      expect(IMMUTABLE.has("cost_booking")).toBe(false);
      const held = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = 'cost_booking' order by 1`;
      expect(held.map((h) => h.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    });

    it("a back-dated post marks the issue it invalidated, in its own tenant only (two-tenant, spec:106)", async () => {
      const seen = async (w: World) =>
        withTenant(
          db.rw,
          w.s.tenant,
          w.s.human,
          (tx) => tx<{ company_id: string; pending: string | null; booked_value: string }[]>`
            select company_id::text as company_id, pending, booked_value::text as booked_value
              from app.cost_booking`,
        );
      // One row each — the issue of 10 booked at 50.0000 — and neither tenant sees the other's.
      expect(await seen(a)).toEqual([
        { company_id: a.s.company, pending: "recost", booked_value: "50.0000" },
      ]);
      expect(await seen(b)).toEqual([
        { company_id: b.s.company, pending: "recost", booked_value: "50.0000" },
      ]);
    });

    it("tenant B can neither write a row into tenant A nor point one at tenant A's movement", async () => {
      await expect(
        withTenant(
          db.rw,
          b.s.tenant,
          b.s.human,
          (tx) => tx`
            insert into app.cost_booking (tenant_id, company_id, movement_id, booked_value)
            values (${a.s.tenant}, ${a.s.company}, ${aMovement}, '1.0000')`,
        ),
      ).rejects.toThrow(/row-level security/);
      // Its own tenant id, A's movement: the composite (tenant_id, movement_id) key finds no such movement.
      await expect(
        withTenant(
          db.rw,
          b.s.tenant,
          b.s.human,
          (tx) => tx`
            insert into app.cost_booking (tenant_id, company_id, movement_id, booked_value)
            values (${b.s.tenant}, ${b.s.company}, ${aMovement}, '1.0000')`,
        ),
      ).rejects.toThrow(/cost_booking_tenant_id_movement_id_fkey/);
      // …and an UPDATE from B reaches none of A's rows.
      const touched = await withTenant(
        db.rw,
        b.s.tenant,
        b.s.human,
        (tx) =>
          tx`update app.cost_booking set pending = null where movement_id = ${aMovement} returning id`,
      );
      expect(touched).toHaveLength(0);
    });

    it("booked_value is a magnitude and pending is one of its two states", async () => {
      const update = (set: "value" | "pending") =>
        withTenant(db.rw, a.s.tenant, a.s.human, (tx) =>
          set === "value"
            ? tx`update app.cost_booking set booked_value = '-0.0001' where movement_id = ${aMovement}`
            : tx`update app.cost_booking set pending = 'done' where movement_id = ${aMovement}`,
        );
      await expect(update("value")).rejects.toThrow(/cost_booking_booked_value_check/);
      await expect(update("pending")).rejects.toThrow(/cost_booking_pending_check/);
    });
  });
});
