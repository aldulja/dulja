import type { Sql } from "postgres";
import type { CostingMethod } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import { draftAndPost, refusePriorOpening, type ImportedLine } from "./document";
import { assertNoJobPartition } from "./matopens-guard";
import { replayLegacyMovements, type LegacyMovement, type OpeningPosition } from "./recost";
import { refResolver } from "./refs";
import { baseCurrency, EMPTY_TARGET, loadSource } from "./run";
import { dateOf, flagOf, moneyOf, optionalText, quantityOf, requireText } from "./scalar";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type SkipRecord,
  type SourceColumn,
} from "./types";

/** One OPENING_STOCK document per warehouse per 200 positions. A document with thousands of lines is legal but
 *  unprintable and unreviewable; 200 is what a warehouse manager can check against a count sheet, and every document
 *  balances on its own, so a partial cut-over is still explicable. */
export const OPENING_STOCK_LINES_PER_DOCUMENT = 200;

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "BTMID",
    required: true,
    confidence: "hypothesis",
    note: "the movement line's own key (BillItems, prefix BTM — the dossier names BillItems.BtmQnt verbatim)",
  },
  { name: "BTMMAT", required: true, confidence: "hypothesis", note: "the Materials key" },
  { name: "BTMWAR", required: true, confidence: "hypothesis", note: "the Warehouses key" },
  {
    name: "BTMBAT",
    required: false,
    confidence: "hypothesis",
    note: "the MatBatches key, when the material is batch-tracked",
  },
  {
    name: "BTMDATE",
    required: true,
    confidence: "hypothesis",
    note: "the movement's accounting date — the first element of §4.3.5's chronological key",
  },
  {
    name: "BTMSEQ",
    required: true,
    confidence: "hypothesis",
    note: "the parent Bill's own sequence — the second element",
  },
  {
    name: "BTMROW",
    required: true,
    confidence: "hypothesis",
    note: "the line number within the bill — the third element",
  },
  {
    name: "BTMIN",
    required: true,
    confidence: "hypothesis",
    note: "direction flag: 1 receipt, 0 issue",
  },
  {
    name: "BTMQNT",
    required: true,
    confidence: "hypothesis",
    note: "quantity in the material's base unit, a positive magnitude (the dossier names this column verbatim)",
  },
  {
    name: "BTMVAL",
    required: false,
    confidence: "hypothesis",
    note: "the line's value on a RECEIPT; never read on an issue, which the engine costs. A NULL on a receipt is refused, never zeroed (LEGACY-011)",
  },
];

/** A non-negative whole number as the source holds it, or a refusal naming the row. */
function ordinalOf(row: LegacyRow, column: string, site: string): string {
  const value = requireText(row, column, site);
  if (!/^\d{1,18}$/.test(value))
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${JSON.stringify(value)}; it is an ordering key and must be a whole number`,
    );
  return value;
}

const positionKey = (p: { itemKey: string; warehouseKey: string; lotKey: string | null }): string =>
  `${p.itemKey}\u0000${p.warehouseKey}\u0000${p.lotKey ?? "\u0000"}`; // NUL: no legacy key contains one
const reportKey = (p: { itemKey: string; warehouseKey: string; lotKey: string | null }): string =>
  `${p.itemKey}/${p.warehouseKey}${p.lotKey === null ? "" : `/${p.lotKey}`}`;

/**
 * `BILLITEMS` → `OPENING_STOCK` documents at a RECOMPUTED cost (§5.1 #6; contracts §4.14, round 20 C11).
 *
 * Reads the whole legacy movement history (C13), recomputes the opening positions with 3B's engine
 * (`replayLegacyMovements`) and posts them through `draftAndPost` → `postDocument`, which writes every movement, layer,
 * `stock_on_hand` cell and ledger row (Global Constraint 1). The history itself is NOT loaded as documents: §5.1 #6
 * asks for a recomputed opening, not a re-enacted past, and re-posting years of movements would make every Dulja period
 * before cut-over look real when it is not. No legacy cost figure is read: a receipt's own value is the only money in.
 *
 * `dependsOn` is the three tables `load` resolves into (T3's definition), so the registry places it after `lot`.
 *
 * **Why `postDocument` is called without a `JobClient`.** Its step 14 needs one only for a BACK-DATED inventory
 * document, one some already-posted movement of the same items follows. `load` refuses that case before it posts — a
 * company that already holds stock some other document moved, or any movement dated after the cut-over date — so on
 * every path that reaches `draftAndPost` the opening is the company's first stock and nothing follows it. The guard says
 * what to do; step 14's fail-closed `ERR_INTERNAL` would not.
 */
export const openingStockLoader: Loader<LegacyRow, LegacyMovement> = {
  sourceTable: "BILLITEMS",
  targetTable: "opening_stock",
  // C13 — a moving average over one page of a history is not its average.
  wholeTable: true,
  dependsOn: ["item", "warehouse", "lot"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BTMID", "BILLITEMS"),

  /** Never a `{ skip }`: dropping one movement changes every later cost of its item, so a row that cannot be read
   *  refuses the run. What cannot be OPENED is reported by `load`, per position, once the whole history is known. */
  map(row) {
    const sourceKey = requireText(row, "BTMID", "BILLITEMS");
    const site = `BILLITEMS/${sourceKey}`;
    const inbound = flagOf(row, "BTMIN", site);
    if (inbound === null)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: BTMIN is NULL; a movement whose direction is unknown is never guessed`,
      );
    return {
      sourceKey,
      itemKey: requireText(row, "BTMMAT", site),
      warehouseKey: requireText(row, "BTMWAR", site),
      lotKey: optionalText(row, "BTMBAT"),
      effectiveDate: dateOf(row, "BTMDATE", site),
      sequence: BigInt(ordinalOf(row, "BTMSEQ", site)),
      lineNo: Number(ordinalOf(row, "BTMROW", site)),
      direction: inbound ? "in" : "out",
      quantity: quantityOf(row, "BTMQNT", site),
      // A NULL receipt value passes through as `null` so the replay refuses it with LEGACY-011's own message; an
      // issue's stored value is never read (§5.1 #6).
      value:
        inbound && optionalText(row, "BTMVAL") !== null
          ? moneyOf(row, "BTMVAL", baseCurrency(), site)
          : null,
    };
  },

  /** Called EXACTLY ONCE with every mapped `BILLITEMS` row no earlier run recorded (C13), in one transaction. */
  async load(tx: Sql, ctx: LoadContext, rows: LegacyMovement[]) {
    // Part VII #7 / LEGACY-022 (OD-27, 9B T15), asked of the run's own source before anything is computed: a legacy
    // opening stock partitioned by job would be merged here into positions that were never one position — a valuation
    // that ties to the ledger and is still wrong, the worst outcome a cut-over can have. Fail closed.
    const partition = await assertNoJobPartition(loadSource().reader);
    if (partition)
      throw new LoadError(
        "ERR_IMPORT_SOURCE_UNREADABLE",
        `${partition.table}.${partition.column} has ${partition.distinctNonZero} distinct non-zero values (for example ${partition.sample.join(", ")}); the legacy opening stock is partitioned by job and this loader would merge positions that were never one position. Answer Part VII #7 with the customer and decide how a job maps to a Dulja warehouse before loading opening stock (LEGACY-022, OD-27)`,
      );
    await refuseUnsafeOpening(tx, ctx, rows);

    const [company] = await tx<{ costing_method: CostingMethod }[]>`
      select costing_method from app.company where id = ${ctx.companyId}`;
    // The company's own currency, read once when the run opened (N3): the Money `map` minted is the same type.
    const result = replayLegacyMovements(rows, company!.costing_method, baseCurrency());

    // Amendment C15: both reasons below are functions of the WHOLE history, which `map` never sees.
    const skips: SkipRecord[] = [];
    const report = (
      p: { itemKey: string; warehouseKey: string; lotKey: string | null },
      reason: string,
    ) =>
      skips.push({
        loader: "opening_stock",
        sourceTable: "BILLITEMS",
        sourceKey: reportKey(p),
        reason,
      });

    for (const n of result.negatives)
      report(
        n,
        `the legacy history drives item ${n.itemKey}${n.lotKey === null ? "" : ` batch ${n.lotKey}`} in warehouse ${n.warehouseKey} to ${n.quantity}; a negative opening is never loaded — it needs an inventory.negative_stock.override recorded by a second principal, which an importer running as one system principal cannot supply (acceptance test 18, hazard 17)${n.lotKey === null ? "" : `; the item's cost in that warehouse is one pool across its batches (§4.7.1), so none of its batches there is opened`}`,
      );

    const opened = await resolvePositions(tx, ctx, result.positions, report);

    // Bucketed by the LEGACY warehouse key, in the replay's order, so a source row finds its document and a FIFO
    // item's parts keep their layer order across documents (a later document posts at a later posting_seq).
    const buckets = new Map<string, { position: string; line: ImportedLine }[]>();
    for (const { position, line } of opened) {
      const bucket = buckets.get(position.warehouseKey) ?? [];
      bucket.push({ position: positionKey(position), line });
      buckets.set(position.warehouseKey, bucket);
    }

    const documentOfPosition = new Map<string, string>();
    const documentOfWarehouse = new Map<string, string>();
    for (const [warehouseKey, all] of buckets) {
      for (let i = 0; i < all.length; i += OPENING_STOCK_LINES_PER_DOCUMENT) {
        const page = all.slice(i, i + OPENING_STOCK_LINES_PER_DOCUMENT);
        const posted = await draftAndPost(tx, ctx, {
          documentTypeCode: "OPENING_STOCK",
          legacyRef: null,
          warehouseId: page[0]!.line.warehouseId ?? null,
          lines: page.map((p, n) => ({ ...p.line, lineNo: n + 1 })),
        });
        for (const p of page) documentOfPosition.set(p.position, posted.documentId);
        if (!documentOfWarehouse.has(warehouseKey))
          documentOfWarehouse.set(warehouseKey, posted.documentId);
      }
    }

    // One target per SOURCE row, in order (`runLoad` pairs them positionally): the document its own position landed
    // in; else, for a position that was reported, the opening of its warehouse, because that document is the
    // warehouse's cut-over and the position is named in the skip register; else EMPTY_TARGET — "seen, produced no
    // target row", the ordinary answer for a warehouse emptied before cut-over, whose history nets to nothing.
    // Every row is RECORDED, a reported position's included, and so is FINAL (9B review, finding 3): opening stock is
    // one-shot, and re-opening one position later would replay a fragment of its history. A reported position is
    // opened after cut-over by an ordinary STOCK_COUNT, and `reconcileCutOver` names it as explained by the skip
    // register — never as unexplained, and never by a re-run.
    const batchIds = rows.map(
      (row) =>
        documentOfPosition.get(positionKey(row)) ??
        documentOfWarehouse.get(row.warehouseKey) ??
        EMPTY_TARGET,
    );
    // `inserted` and `skipped` count POSITIONS — the unit an operator checks against a count sheet — not source rows.
    return { inserted: opened.length, skipped: skips.length, batchIds, skips };
  },
};

/**
 * The three refusals that keep an opening the company's FIRST stock, before anything is computed.
 *
 *  1. Any earlier run that recorded a row of this loader (9B review, finding 3): opening stock is ONE-SHOT. `runLoad`
 *     hands `load` only keys no earlier run recorded, so a re-run would replay a fragment of the history — a cost no
 *     moving average ever had — and a reversal of the first opening does not change that, its rows staying recorded.
 *  2. Any stock movement already in the company, whatever moved it: the opening would be added to stock it did not
 *     count, or be back-dated behind a later movement (postDocument step 14). After refusal 1 no movement can be this
 *     loader's, and a reversal leaves its movements in place, so the remedy is a fresh company.
 *  3. A legacy movement dated after the cut-over date: the opening is the position ON that date (spec:2039).
 */
async function refuseUnsafeOpening(
  tx: Sql,
  ctx: LoadContext,
  rows: readonly LegacyMovement[],
): Promise<void> {
  await refusePriorOpening(tx, ctx, {
    sourceTable: "BILLITEMS",
    targetTable: "opening_stock",
    what: "opening stock",
    newKeys: rows.map((r) => r.sourceKey),
    correction:
      "Correct a position after cut-over with a STOCK_COUNT (docs/runbooks/stock-count.md), which prices what it finds",
  });

  const [held] = await tx<
    { type: string; series: string; number: string; effective_date: string }[]
  >`
    select t.code as type, d.series, d.number::text as number,
           to_char(m.effective_date, 'YYYY-MM-DD') as effective_date
      from app.inventory_movement m
      join app.document d on d.id = m.document_id
      join app.document_type t on t.id = d.document_type_id
     where m.company_id = ${ctx.companyId}
     order by m.effective_date, d.number
     limit 1`;
  if (held)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `the company already holds stock moved by ${held.type} ${held.series} ${held.number} on ${held.effective_date}; opening stock is the first stock a cut-over company holds, so load into a fresh company (reversing that document does not make this one fresh: its movements stand beside the reversal's)`,
    );

  const late = rows.find((r) => r.effectiveDate > ctx.cutOverDate);
  if (late)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `BILLITEMS/${late.sourceKey} is dated ${late.effectiveDate}, after the cut-over date ${ctx.cutOverDate}; an opening is the position ON that date, so freeze the source at the cut-over date or correct the date`,
    );
}

/**
 * Each position resolved to the Dulja rows it opens against, or REPORTED (§5.1 #3) — never opened against a guessed
 * parent: an item, warehouse or batch that did not import; a service, which holds no stock; a batch of another
 * material (`document_line` has no constraint tying a lot to its item, so the check is here); and a batch-less
 * position of a batch-tracked item, which the evaluator refuses (ADR 0034) and which would fail the whole load.
 */
async function resolvePositions(
  tx: Sql,
  ctx: LoadContext,
  positions: readonly OpeningPosition[],
  report: (p: OpeningPosition, reason: string) => void,
): Promise<{ position: OpeningPosition; line: ImportedLine }[]> {
  const refs = refResolver(tx, ctx.companyId);
  const resolved: {
    position: OpeningPosition;
    itemId: string;
    warehouseId: string;
    lotId: string | null;
  }[] = [];
  for (const position of positions) {
    const itemId = await refs.byLegacyRef("item", position.itemKey);
    const warehouseId = await refs.byLegacyRef("warehouse", position.warehouseKey);
    const lotId = position.lotKey === null ? null : await refs.byLegacyRef("lot", position.lotKey);
    if (!itemId || !warehouseId || (position.lotKey !== null && !lotId)) {
      report(
        position,
        `the opening position for legacy material ${position.itemKey} in warehouse ${position.warehouseKey}${position.lotKey === null ? "" : ` batch ${position.lotKey}`} references an item, warehouse or lot that did not import; the position is reported, never opened against a guessed parent (§5.1 #3, LEGACY-073)`,
      );
      continue;
    }
    resolved.push({ position, itemId, warehouseId, lotId });
  }

  const items = new Map(
    (
      await tx<{ id: string; code: string; kind: string; track_lots: boolean }[]>`
        select id::text as id, code, kind::text as kind, track_lots from app.item
         where company_id = ${ctx.companyId} and id = any(${[...new Set(resolved.map((r) => r.itemId))]}::uuid[])`
    ).map((r) => [r.id, r]),
  );
  const lotIds = resolved.map((r) => r.lotId).filter((id): id is string => id !== null);
  const lots = new Map(
    (
      await tx<{ id: string; item_id: string }[]>`
        select id::text as id, item_id::text as item_id from app.lot
         where company_id = ${ctx.companyId} and id = any(${[...new Set(lotIds)]}::uuid[])`
    ).map((r) => [r.id, r.item_id]),
  );

  const opened: { position: OpeningPosition; line: ImportedLine }[] = [];
  for (const { position, itemId, warehouseId, lotId } of resolved) {
    const item = items.get(itemId)!;
    const holding = `legacy material ${position.itemKey} in warehouse ${position.warehouseKey}`;
    if (item.kind !== "product") {
      report(
        position,
        `${holding} is a ${item.kind} item; a ${item.kind} holds no stock, so its ${position.quantity.toString()} is reported, never opened against inventory control`,
      );
      continue;
    }
    if (lotId !== null && lots.get(lotId) !== itemId) {
      report(
        position,
        `legacy batch ${position.lotKey} is not a batch of material ${position.itemKey}; the position is reported, never opened against another item's batch`,
      );
      continue;
    }
    if (lotId === null && item.track_lots) {
      report(
        position,
        `${holding} holds ${position.quantity.toString()} with no batch, but item ${item.code} is batch-tracked; a batch-less receipt of it is refused (ADR 0034), so the position is reported, not opened`,
      );
      continue;
    }
    opened.push({
      position,
      line: {
        lineNo: opened.length + 1,
        kind: "item",
        itemId,
        warehouseId,
        lotId,
        description: `Opening stock, legacy material ${position.itemKey}${position.lotKey === null ? "" : ` batch ${position.lotKey}`}, recomputed from its movement history (§5.1 #6)`,
        quantity: position.quantity,
        unitPrice: position.unitCost,
        amount: position.value,
      },
    });
  }
  return opened;
}
