// tests/regression/support/costing.ts — 3B's own regression helpers. Not a ThinContext member (§4.17.1).
// `tests/**` has no `dependency-rule` TIER owner (0b:5064), so this file may name any package it needs.
import { join } from "node:path";
import { PERMISSIONS } from "@dulja/contracts";
import {
  openLayersFor,
  rebuildStockValuation,
  replay,
  reverseDocument,
  valuationAsOf,
  withTenant,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import { currency, Money, Quantity, type Layer } from "@dulja/domain";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import type { SourceFile } from "../../../scripts/lint/types";
import { sharedDb } from "../../support/regression";
import { REPO_ROOT, sourceFiles as walk } from "../../support/source";
// `postInventoryDocument` is deliberately NOT imported here: the regression files call it directly, and an
// import this module does not use fails `bun run lint`.
import {
  ensureOpenPeriods,
  postOverriddenIssue,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../invariants/support/post-inventory";

const MYR = currency("MYR");

/** One tenant context per call, with a fresh `request_id`. Hoisted out of `costingContext` because it
 *  captures nothing from that closure — `unicorn/consistent-function-scoping` refuses the inner form. */
const ctxOf = async (s: Seed, db: Db) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});

export interface CostingFixture {
  db: Db;
  s: Seed;
  item: string;
  warehouse: string;
  receipt: string;
  issueType: string;
}

/**
 * @param sah this file's SAH number, e.g. "004". It names the tenant, and the ISOLATION is the point:
 *   one company per regression file. The files below assert absolute figures — a valuation that is
 *   `undefined`, a unit cost of exactly 1.0000 — and every one of them would be false in some file order if
 *   they shared a company, because `sah-004` leaves stock on the shelf and `sah-005` deliberately leaves
 *   invalidated layers behind (it back-dates against a `recordingJobs()` client and never runs the replay).
 *   The container is still shared: `sharedDb()` starts one for the whole `tests` run (§4.17.1).
 *   `seedTenantV2` rather than `sharedDb().a` because 1A's version wires `fx_rounding_account_id` and the
 *   1000/4000 accounts that every policy in this slice resolves; Plan 0A's `seedTenant` does not.
 */
export function costingContext(sah: string) {
  let fixture: CostingFixture | null = null;

  const api = {
    /** This file's own tenant, item, warehouse and two document types, memoised after the first call. */
    async inventory(): Promise<CostingFixture> {
      if (fixture) return fixture;
      const { db } = await sharedDb();
      const s = await seedTenantV2(db, `SAH-${sah}`);
      // `grantCodes(db, s)` with no `codes` grants NOTHING, and 2B's R2 evaluates both fixture policies'
      // `approval.post` inside the posting transaction (the reversal and COST_ADJUSTMENT post under it too).
      await grantCodes(db, s, { codes: ["accounting.journal.post"] });
      await ensureOpenPeriods(db, s, 2026);
      // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1), and every regression file posts this item
      // on lot-less lines, which `evaluatePolicy` refuses for a lot-tracked item (ERR_POLICY_REQUIRES_MISSING).
      const { itemId } = await seedItem(db, s, { code: "SAH-COST", trackLots: false });
      // `COST_ADJUSTMENT` has to exist in THIS tenant before `runReplay`: `replay` calls
      // `resolveAdjustmentAccounts` unconditionally as soon as anything is in scope (Task 9 Step 3), and
      // that raises `ERR_NOT_FOUND` on a missing document type before any arithmetic. `sah-054` asserts one
      // adjustment IS posted, so this load is load-bearing rather than defensive. The path is absolute
      // because Vitest runs the `tests` workspace from `tests/` — a bare `"packages/db/seed/…"` would
      // resolve under `tests/` and the loader would raise ENOENT (0B's `REPO_ROOT`, §4.17.1).
      //
      // `loadDocumentTypes` takes a POOL and opens its own `withTenant` (src/seed/document-types.ts:45), so
      // it is called directly — handing it a transaction makes the production `withTenant` raise
      // ERR_TENANT_CONTEXT_NESTED, which is why 3B's own DB-tier suites call it the same way.
      await loadDocumentTypes(
        db.migrator,
        { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
        join(REPO_ROOT, "packages", "db", "seed", "my", "document-types"),
        PERMISSIONS.map((p) => p.code),
      );
      fixture = {
        db,
        s,
        item: itemId,
        warehouse: await seedWarehouse(db, s, { code: "SAH-WH" }),
        receipt: await seedDocumentType(db, s, {
          code: "STOCK_RECEIPT_TEST",
          module: "inventory",
          policy: STOCK_RECEIPT_COST_POLICY,
        }),
        issueType: await seedDocumentType(db, s, {
          code: "STOCK_ISSUE_TEST",
          module: "inventory",
          policy: STOCK_ISSUE_COST_POLICY,
        }),
      };
      return fixture;
    },

    async secondWarehouse(db: Db, s: Seed): Promise<string> {
      return seedWarehouse(db, s, { code: "SAH-WH2" });
    },

    /**
     * The one valuation row for this fixture's item. **Throws** when there is none, so a caller can read
     * `.unitCost` without a `!`: `tsconfig.base.json` sets `noUncheckedIndexedAccess` (plan0A:281), so a
     * helper returning `rows[0]` gives every call site a `ValuationRow | undefined` and every property
     * access a compile error. The two cases that assert ABSENCE use `valuationOrNone` below.
     */
    async valuation(db: Db, s: Seed, asOf: string) {
      const rows = await api.valuationRows(db, s, asOf);
      const row = rows[0];
      if (!row) {
        throw new Error(
          `no valuation row for this fixture's item at ${asOf} (the quantity is zero)`,
        );
      }
      return row;
    },
    /** The same read, for the two cases whose whole point is that the row is not there. */
    async valuationOrNone(db: Db, s: Seed, asOf: string) {
      return (await api.valuationRows(db, s, asOf))[0];
    },
    async valuationRows(db: Db, s: Seed, asOf: string) {
      return withTenant(db.rw, await ctxOf(s, db), (tx) =>
        valuationAsOf(tx, { companyId: s.company, asOf, limit: 50 }),
      );
    },
    async openLayers(db: Db, s: Seed, itemId: string, warehouseId: string): Promise<Layer[]> {
      return withTenant(db.rw, await ctxOf(s, db), (tx) =>
        openLayersFor(tx, { companyId: s.company, itemId, warehouseId, baseCurrency: MYR }),
      );
    },
    async storedValuation(db: Db, s: Seed, asOf: string) {
      return withTenant(
        db.rw,
        await ctxOf(s, db),
        (tx) => tx<{ quantity: string; value: string; updated_at: string }[]>`
        select quantity::text, value::text, updated_at::text from app.stock_valuation
         where company_id = ${s.company} and as_of = ${asOf}::date`,
      );
    },
    async rebuild(db: Db, s: Seed, asOf: string) {
      return withTenant(db.rw, await ctxOf(s, db), (tx) =>
        rebuildStockValuation(tx, { companyId: s.company, asOf }),
      );
    },
    async runReplay(db: Db, s: Seed) {
      const jobCtx = {
        tenantId: s.tenant,
        actorId: s.system,
        requestId: await uuidv7(db.admin),
      };
      return replay(
        db.rw,
        { tenantId: s.tenant, requestId: jobCtx.requestId, payload: { companyId: s.company } },
        jobCtx,
      );
    },
    async reverse(db: Db, s: Seed, documentId: string, effectiveDate: string) {
      const reverseCtx = await ctxOf(s, db);
      return withTenant(db.rw, reverseCtx, (tx) =>
        reverseDocument(tx, reverseCtx, {
          documentId,
          effectiveDate,
          reason: "regression fixture",
          jobs: recordingJobs(),
        }),
      );
    },

    /**
     * An issue the layers cannot cover, authorised the ONLY way F-6 admits. It **delegates** to Task 6's
     * `postOverriddenIssue` rather than re-deriving the sequence: `app.assert_override_authorised` refuses
     * the obvious shaping twice — the attributed principal may not be the document's creator, and
     * `recordOverride` takes `actor_id` from `app.current_actor()`, so a second *actor* cannot exist inside
     * one transaction — and one file getting that wrong would be one file silently not testing an override.
     */
    async overriddenIssue(
      db: Db,
      s: Seed,
      documentTypeId: string,
      warehouseId: string,
      itemId: string,
      quantity: string,
      effectiveDate: string,
    ) {
      return postOverriddenIssue(db, s, {
        documentTypeId,
        itemId,
        warehouseId,
        quantity,
        effectiveDate,
      });
    },

    async sumDocumentLineCost(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(
        db.rw,
        await ctxOf(s, db),
        (tx) => tx<{ v: string }[]>`
        select coalesce(sum(l.cost), 0)::text as v
          from app.document_line l
          join app.inventory_movement m on m.document_id = l.document_id and m.line_no = l.line_no
         where l.company_id = ${s.company} and m.quantity < 0`,
      );
      return row!.v;
    },
    async sumConsumptionValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(
        db.rw,
        await ctxOf(s, db),
        (tx) => tx<{ v: string }[]>`
        select coalesce(sum(value), 0)::text as v from app.cost_consumption
         where company_id = ${s.company} and invalidated_at is null`,
      );
      return row!.v;
    },
    /**
     * The valued-but-unconsumed part of every authorised shortfall (ADR 0038 note 7), derived from
     * **quantities and unit costs** — NOT as `Σ document_line.cost − Σ cost_consumption.value`. Deriving it
     * by that subtraction would make `sah-009`'s first assertion (`Σ consumption + shortfall = Σ cost`) an
     * identity that holds over any data at all, including data where costing is broken, which is the one
     * thing that tie-out exists to detect.
     *
     * The formula: for every issue movement whose consumptions do not cover its quantity, the uncovered
     * quantity times the unit cost those consumptions were taken at. Under AVCO every consumption row of one
     * movement carries the same `unit_cost` — the running average, which is exactly what the engine values a
     * shortfall at — so `max(c.unit_cost)` IS that figure. A movement with no consumption row at all
     * (an override issue against no layers) coalesces to a 0.0000 unit cost, which is also what the engine
     * computes there: the average of an empty layer set. **AVCO only**, which is what every fixture in this
     * slice uses; a FIFO company's shortfall would need `average(openLayers)` at the movement's own point and
     * is not exercised here.
     *
     * `round(…, 4)` matters: `numeric(19,6) × numeric(19,4)` is a 10-dp result, and an unrounded
     * "120.0000000000" would never equal a 4-dp figure from `document_line.cost`.
     */
    async openShortfallValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(
        db.rw,
        await ctxOf(s, db),
        (tx) => tx<{ v: string }[]>`
        select coalesce(round(sum((abs(m.quantity) - coalesce(c.qty, 0)) * coalesce(c.unit_cost, 0)), 4), 0)::text as v
          from app.inventory_movement m
          left join (
            select cc.movement_id, sum(cc.quantity) as qty, max(cc.unit_cost) as unit_cost
              from app.cost_consumption cc
             where cc.company_id = ${s.company} and cc.invalidated_at is null
             group by cc.movement_id) c on c.movement_id = m.id
         where m.company_id = ${s.company}
           and m.quantity < 0
           and abs(m.quantity) > coalesce(c.qty, 0)`,
      );
      return row!.v;
    },
    async receiptValue(db: Db, s: Seed): Promise<string> {
      const [row] = await withTenant(
        db.rw,
        await ctxOf(s, db),
        (tx) => tx<{ v: string }[]>`
        select coalesce(sum(value), 0)::text as v from app.inventory_movement
         where company_id = ${s.company} and quantity > 0`,
      );
      return row!.v;
    },
    /** Money arithmetic in SQL, so no JavaScript number ever touches an amount — not even in a test.
     *  `round(…, 4)` so the result is comparable to a `numeric(19,4)` column rendered as text. */
    async plus(db: Db, a: string, b: string): Promise<string> {
      const [row] = await db.admin<
        { v: string }[]
      >`select round(${a}::numeric + ${b}::numeric, 4)::text as v`;
      return row!.v;
    },
    async minus(db: Db, a: string, b: string): Promise<string> {
      const [row] = await db.admin<
        { v: string }[]
      >`select round(${a}::numeric - ${b}::numeric, 4)::text as v`;
      return row!.v;
    },

    async sourceFiles(roots: string[]): Promise<SourceFile[]> {
      return walk(roots);
    },

    /** The two pure inputs `sah-007` and `sah-008` hand straight to the engine. */
    valuelessReceipt() {
      return {
        method: "avco" as const,
        openLayers: [],
        allowShortfall: false,
        movement: {
          lineNo: 1,
          movementNo: 1,
          itemId: "i",
          warehouseId: "w",
          lotId: "l",
          quantity: Quantity.of("10.000000"),
          effect: "receipt" as const,
          value: null,
          costing: "create_layer" as const,
          effectiveDate: "2026-01-01",
          postingSeq: 1n,
          movementId: "m",
        },
      };
    },
    /**
     * A ZERO-quantity issue — SAH-008(c)'s wash line. Named for what it is: there is no such thing as a
     * sub-micro `Quantity` (`Quantity.of` throws above six decimal places, 0d:1034-1039), so the engine's
     * `MIN_MEANINGFUL_QTY` refusal cannot be reached from a constructed quantity and this is the arm of
     * SAH-008 a runtime input can still present. It is refused with `ERR_COST_VALUE_MISSING`.
     */
    washLineIssue() {
      const layer: Layer = {
        id: "L",
        itemId: "i",
        warehouseId: "w",
        lotId: "l",
        movementId: "m0",
        qtyIn: Quantity.of("0.000001"),
        value: Money.zero(MYR),
        unitCost: Money.of("1.0000", MYR),
        qtyRemaining: Quantity.of("0.000001"),
        effectiveDate: "2026-01-01",
        postingSeq: 1n,
        lineNo: 1,
        movementNo: 1,
      };
      return {
        method: "avco" as const,
        openLayers: [layer],
        allowShortfall: true,
        movement: {
          lineNo: 1,
          movementNo: 1,
          itemId: "i",
          warehouseId: "w",
          lotId: "l",
          quantity: Quantity.of("0.000000"),
          effect: "issue" as const,
          value: Money.zero(MYR),
          costing: "consume_layers" as const,
          effectiveDate: "2026-02-01",
          postingSeq: 2n,
          movementId: "m1",
        },
      };
    },
  };
  return api;
}
