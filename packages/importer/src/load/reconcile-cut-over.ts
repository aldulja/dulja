// `./run` before any loader module: it imports the registry, which imports every loader, and a loader module entered
// first would build `loaders` with itself still unset (9B T6's note).
import { withRunScope } from "./run";
import Decimal from "decimal.js";
import type { Sql } from "postgres";
import { listEmployeeYtdOpening, valuationAsOf, type ValuationRow } from "@dulja/db";
import { currency, Money, type CostingMethod, type CurrencyCode } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { reconcile, type ReconciliationReport } from "../reconcile";
import { hasColumns } from "../reconcile/probe";
import type { AccountMapEntry } from "./account-map";
import { accountMap } from "./accounts";
import { SUSPENSE_CODE } from "./opening-balance";
import { openingStockLoader } from "./opening-stock";
import { replayLegacyMovements, type LegacyMovement } from "./recost";
import { refResolver } from "./refs";
import { moneyOf, payMoneyOf, optionalText, requireText } from "./scalar";
import { LoadError, type LoadContext } from "./types";

/**
 * One line of the cut-over reconciliation: a figure the source holds beside the figure Dulja holds, and why they
 * differ. Every money figure is a fixed-scale string, debit-positive (a credit balance is negative), as the ledger
 * reads it. `explanation` is `null` when there is nothing to explain or when nothing explains it; which of the two is
 * decided once, by the row's own rule (ADR 0086), and a row that is not explained is in `unexplained`.
 *
 * `employeeYtd` rows carry NO pay figure (9B T8): `source` and `dulja` describe, and `difference` is `0.0000` when the
 * opening equals the employee's own payslips to the cent, or names WHICH figure disagrees — never by how much.
 */
export interface Comparison {
  key: string;
  label: string;
  source: string;
  dulja: string;
  difference: string;
  explanation: string | null;
}

export interface CutOverReconciliation {
  generatedAt: string;
  cutOverDate: string;
  /** Per Dulja account the owner's map names, per legacy account it does not, and per Dulja account the map does not
   *  name that holds a balance at the cut-over date (`3900` aside — `suspense` is its section). */
  trialBalance: Comparison[];
  /** Per item and warehouse: the recomputation of the legacy movement history (§5.1 #6) against `valuationAsOf`. */
  stockValuation: Comparison[];
  /** Per legacy employee with pay in the cut-over year, keyed `YTD:<EMPID>` as the skip register keys a withheld one. */
  employeeYtd: Comparison[];
  /** `3900`, decomposed (ADR 0086): the legacy trial balance's own imbalance, then the account itself against the
   *  imbalance less every trial-balance difference above. */
  suspense: Comparison[];
  /** `3900`'s balance at the cut-over date, debit-positive (a credit is negative). */
  suspenseBalance: string;
  unexplained: Comparison[];
  ok: boolean;
}

const ZERO = "0.0000";
const VALUATION_PAGE = 1000;
const IMBALANCE_KEY = "legacy imbalance";

/** A difference and the rule's verdict on it. `settled` is the only thing `unexplained` reads. */
interface Judged {
  row: Comparison;
  settled: boolean;
}

// ── explain: a difference is matched exactly by 9A's reports, or it is not ──────────────────────────────────────────

const ACCTOTALS_RULES: Readonly<Record<string, 1 | -1>> = {
  "ACCTOTALS.DEBIT": 1,
  "ACCTOTALS.CREDIT": -1,
};

/**
 * What a 9A report moves the legacy trial balance by, debit-positive, or `null` when it moves it by nothing or says
 * nothing about money. Two of the six kinds carry a trial-balance figure:
 *   - `unbalanced_vouchers`: the vouchers' net imbalance (`summary.netImbalance`, debit − credit) — SAH-003;
 *   - `aggregate_drift`: `ACCTOTALS`' stored totals less their `VOUITEMS` recomputation — Σ of
 *     `ACCTOTALS.DEBIT`'s signed `stored − recomputed` less the same for `ACCTOTALS.CREDIT`, a missing stored row
 *     counting as a stored zero. The other rules (`ACCOBJECTS`, `MAT*`) restate figures the trial balance does not read.
 * `orphans`, `null_poison`, `duplicate_aggregates` and `employee_mapping` quantify rows, not money, and never explain a
 * figure.
 */
function netEffect(report: ReconciliationReport): Decimal | null {
  let effect = new Decimal(0);
  if (report.kind === "unbalanced_vouchers") {
    if (report.summary["status"] !== "compared") return null;
    effect = new Decimal(report.summary["netImbalance"] ?? "0");
  } else if (report.kind === "aggregate_drift") {
    for (const row of report.rows) {
      const sign = ACCTOTALS_RULES[String(row["rule"])];
      if (sign === undefined) continue;
      const moved =
        row["status"] === "drift"
          ? new Decimal(String(row["difference"]))
          : row["status"] === "missing_stored_row"
            ? new Decimal(String(row["recomputed"])).negated()
            : new Decimal(0);
      effect = effect.plus(moved.times(sign));
    }
  } else return null;
  return effect.isZero() ? null : effect;
}

const plural = (count: string | number, one: string, many: string): string =>
  String(count) === "1" ? one : many;

function sentence(report: ReconciliationReport, effect: Decimal): string {
  if (report.kind === "unbalanced_vouchers") {
    const unbalanced = report.summary["unbalanced"] ?? "0";
    return `unbalanced_vouchers: ${unbalanced} of ${report.summary["vouchers"] ?? "0"} ${plural(report.summary["vouchers"] ?? "0", "voucher", "vouchers")} ${plural(unbalanced, "does", "do")} not balance, netting ${effect.toFixed(4)} (SAH-003) — posted to ${SUSPENSE_CODE}`;
  }
  const accounts = new Set(
    report.rows
      .filter(
        (r) => ACCTOTALS_RULES[String(r["rule"])] !== undefined && r["status"] !== "source_absent",
      )
      .map((r) => String(r["key"])),
  ).size;
  return `aggregate_drift: ACCTOTALS' stored totals less their VOUITEMS recomputation net ${effect.toFixed(4)} across ${accounts} ${plural(accounts, "account", "accounts")} (SAH-001) — posted to ${SUSPENSE_CODE}`;
}

/**
 * ADR 0086: a difference is explained by 9A's reports when the SIGNED trial-balance effects of some subset of them sum
 * to it exactly. Nothing is rounded into agreement, no tolerance exists, and nothing is guessed — a difference no subset
 * accounts for is `null`. Signed, not absolute: a report that moves the trial balance by +100 does not explain a −100
 * difference, and two reports of +100 and −100 explain nothing but a zero. Reports that carry no money (or move the
 * trial balance by nothing) are not candidates, so they are never named beside the one that matched. The subsets are
 * searched in kind order, smallest mask first; there are at most sixty-four.
 */
export function explain(
  difference: string,
  reasons: readonly ReconciliationReport[],
): string | null {
  const target = new Decimal(difference);
  if (target.isZero()) return null;
  const candidates = reasons
    .map((report) => ({ report, effect: netEffect(report) }))
    .filter((c): c is { report: ReconciliationReport; effect: Decimal } => c.effect !== null)
    .toSorted((a, b) =>
      a.report.kind < b.report.kind ? -1 : a.report.kind > b.report.kind ? 1 : 0,
    );
  for (let mask = 1; mask < 1 << candidates.length; mask += 1) {
    const chosen = candidates.filter((_, i) => (mask & (1 << i)) !== 0);
    const sum = chosen.reduce((total, c) => total.plus(c.effect), new Decimal(0));
    if (sum.equals(target)) return chosen.map((c) => sentence(c.report, c.effect)).join("; ");
  }
  return null;
}

// ── reading the source ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A whole table, each key once — the load's own SAH-049 rule (ADR 0084): an identical second sighting of a key is read
 * once, a different one refuses, because the load refused it too and a reconciliation that summed both would compare
 * against a figure nobody loaded.
 */
async function readWhole(
  reader: LegacyReader,
  table: string,
  columns: readonly string[],
  keyColumn: string,
): Promise<LegacyRow[]> {
  const rows = new Map<string, { row: LegacyRow; text: string }>();
  for await (const page of reader.read<LegacyRow>(table, { columns: [...columns], batch: 500 })) {
    for (const row of page) {
      const key = requireText(row, keyColumn, table);
      const text = JSON.stringify(columns.map((c) => row[c] ?? null));
      const seen = rows.get(key);
      if (seen && seen.text !== text)
        throw new LoadError(
          "ERR_IMPORT_DUPLICATE_SOURCE_KEY",
          `${table}/${key} appears twice with different values (SAH-049); the load refuses it, so the reconciliation does too`,
        );
      if (!seen) rows.set(key, { row, text });
    }
  }
  return [...rows.values()].map((r) => r.row);
}

/** The declared columns the table has: required ones always (a missing one refuses, as pre-flight would), optional ones
 *  only when present — the load maps an absent optional column as NULL, and so does this. */
async function readableColumns(
  reader: LegacyReader,
  table: string,
  columns: readonly { name: string; required: boolean }[],
): Promise<string[]> {
  const out: string[] = [];
  for (const c of columns)
    if (c.required || (await hasColumns(reader, table, [c.name]))) out.push(c.name);
  return out;
}

async function requireTable(reader: LegacyReader, table: string, why: string): Promise<boolean> {
  if ((await reader.tables()).includes(table)) return true;
  throw new LoadError(
    "ERR_IMPORT_SOURCE_UNREADABLE",
    `the source has no ${table}, and ${why}; a figure the reconciliation cannot read is never taken as zero`,
  );
}

// ── the reconciliation ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The phase's definition of done, computed (spec:2295): "Trial balance and stock valuation match the source on the
 * cut-over date, and the difference on every recomputed figure is explained (§5.1); each employee's imported YTD
 * reconciles to their last legacy payslip." ADR 0086 is the rule each section applies; `ok` is "nothing unexplained".
 *
 * Runs on the caller's transaction as the tenant's system principal, against the FROZEN source the load read, after a
 * real (not dry) run. Reads only — the source through `reader`, Dulja through the ledger, `valuationAsOf` and
 * `listEmployeeYtdOpening` — and needs the owner's account map set (`setAccountMap`), as the load did.
 */
export async function reconcileCutOver(
  tx: Sql,
  reader: LegacyReader,
  ctx: LoadContext,
): Promise<CutOverReconciliation> {
  // Outside `runLoad`, so `baseCurrency()` is not set: the currency and the costing method are read here, on `tx`.
  const [company] = await tx<{ base_currency: string; costing_method: CostingMethod }[]>`
    select base_currency, costing_method from app.company where id = ${ctx.companyId}`;
  if (!company)
    throw new LoadError("ERR_VALIDATION_FAILED", `no company ${ctx.companyId} in this tenant`);
  const base = currency(company.base_currency);
  const money = (text: string | undefined): Money<CurrencyCode> => Money.of(text ?? ZERO, base);
  const zero = Money.zero(base);

  const map = accountMap();
  const onSuspense = map.entries.find((e) => e.code === SUSPENSE_CODE);
  if (onSuspense)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `legacy account ${onSuspense.legacyCode} is mapped onto ${SUSPENSE_CODE}, the opening-balance suspense; ${SUSPENSE_CODE} holds only what the cut-over could not place, so its balance can be decomposed (ADR 0086) — map the account elsewhere`,
    );

  // 9A's two reports that carry a trial-balance figure (`netEffect`); the other four explain no money.
  const reasons = [
    await reconcile(reader, "aggregate_drift"),
    await reconcile(reader, "unbalanced_vouchers"),
  ];

  // ── Dulja: every account's net at the cut-over date, from the ledger itself (an independent witness, 7B's tie-out
  //    rule), not from a period projection — the cut-over date is a date, not a period.
  const ledger = new Map(
    (
      await tx<{ code: string; net: string }[]>`
        select a.code, sum(l.base_debit - l.base_credit)::text as net
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.company_id = ${ctx.companyId} and l.effective_date <= ${ctx.cutOverDate}::date
         group by a.code`
    ).map((r) => [r.code, money(r.net)]),
  );
  const duljaNet = (code: string): Money<CurrencyCode> => ledger.get(code) ?? zero;

  // ── The source's trial balance: ACCTOTALS, as the trial-balance opening read it (Task 5's columns).
  const legacy = new Map<string, Money<CurrencyCode>>();
  for (const row of await readWhole(
    reader,
    "ACCTOTALS",
    ["ACTACC", "ACTDEBIT", "ACTCREDIT"],
    "ACTACC",
  )) {
    const code = requireText(row, "ACTACC", "ACCTOTALS");
    const site = `ACCTOTALS/${code}`;
    legacy.set(
      code,
      moneyOf(row, "ACTDEBIT", base, site).subtract(moneyOf(row, "ACTCREDIT", base, site)),
    );
  }
  const imbalance = [...legacy.values()].reduce((sum, net) => sum.add(net), zero);

  const treatments = new Set(map.entries.map((e) => e.treatment));
  const subLedger =
    treatments.has("ar_control") || treatments.has("ap_control")
      ? await openItemsNet(reader, base)
      : { receivable: zero, payable: zero };

  const stock = await stockSection(
    tx,
    reader,
    ctx,
    base,
    company.costing_method,
    treatments.has("inventory_control"),
  );

  // ── 1. The trial balance, per Dulja account the map names.
  const tb: Judged[] = [];
  const codes = [...new Set(map.entries.map((e) => e.code))].toSorted();
  const inventoryCodes = codes.filter((code) =>
    map.entries.some((e) => e.code === code && e.treatment === "inventory_control"),
  );
  const inventoryDulja = inventoryCodes.reduce((sum, code) => sum.add(duljaNet(code)), zero);
  const inventoryLegacy = inventoryCodes.reduce(
    (sum, code) =>
      sum.add(
        legacyOf(
          map.entries.filter((e) => e.code === code),
          legacy,
          zero,
        ),
      ),
    zero,
  );
  for (const code of codes) {
    const entries = map.entries.filter((e) => e.code === code);
    const entry = entries[0]!;
    const source = legacyOf(entries, legacy, zero);
    const dulja = duljaNet(code);
    const difference = source.subtract(dulja);
    const row: Comparison = {
      key: code,
      label: `${entries.map((e) => e.legacyCode).join(", ")} → ${code} ${entry.nameEn} (${entry.treatment})`,
      source: source.toString(),
      dulja: dulja.toString(),
      difference: difference.toString(),
      explanation: null,
    };
    let settled = difference.isZero();
    switch (entry.treatment) {
      case "balance":
        // The trial-balance opening posts a balance account's stored net exactly (Task 5). A difference here means the
        // opening did not post, or something else did — neither is a cause 9A's reports could name.
        break;
      case "exclude":
        settled = dulja.isZero();
        if (settled && !difference.isZero())
          row.explanation = `excluded by the owner's account map${entry.note ? ` (${entry.note})` : ""}: not loaded, so its ${source.toString()} stands on ${SUSPENSE_CODE}`;
        break;
      case "ar_control":
      case "ap_control": {
        const items = entry.treatment === "ar_control" ? subLedger.receivable : subLedger.payable;
        settled = items.equals(dulja);
        row.label = `${row.label}; the legacy open items total ${items.toString()}`;
        if (settled) row.explanation = controlSentence(entry, source, items);
        break;
      }
      case "inventory_control":
        // The positions the opening-stock load read and reported are in the recomputation and, until a STOCK_COUNT
        // opens them after cut-over, not in Dulja: the stock rows explain exactly that much (9B review, finding 3).
        settled = stock.recomputed.subtract(inventoryDulja).equals(stock.reported);
        row.label = `${row.label}; the recomputed valuation is ${stock.recomputed.toString()}`;
        if (settled)
          row.explanation = inventorySentence(
            inventoryCodes,
            inventoryLegacy,
            stock.recomputed,
            stock.reported,
          );
        break;
    }
    tb.push({ row, settled });
  }
  // Legacy accounts with a stored total the map does not name: the opening reported and did not load them.
  for (const [code, net] of [...legacy].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (map.entries.some((e) => e.legacyCode === code)) continue;
    tb.push({
      row: {
        key: `legacy ${code}`,
        label: `legacy account ${code}, not in the account map`,
        source: net.toString(),
        dulja: ZERO,
        difference: net.toString(),
        explanation: null,
      },
      settled: net.isZero(),
    });
  }
  // Dulja accounts the map does not name that hold a balance at the cut-over date: nothing in the cut-over put it there.
  for (const [code, net] of [...ledger].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (code === SUSPENSE_CODE || codes.includes(code) || net.isZero()) continue;
    tb.push({
      row: {
        key: code,
        label: `${code}, which no legacy account maps to`,
        source: ZERO,
        dulja: net.toString(),
        difference: net.negate().toString(),
        explanation: null,
      },
      settled: false,
    });
  }

  // ── 2. 3900, decomposed. The ledger balances, every legacy account is in exactly one row above and every Dulja
  //    account but 3900 is in at most one, so 3900's net is Σ differences − the legacy imbalance; the last row checks
  //    it, and each part is explained by its own row.
  const imbalanceRow: Judged = (() => {
    const explanation = explain(imbalance.toString(), reasons);
    return {
      row: {
        key: IMBALANCE_KEY,
        label: "the legacy trial balance's own imbalance: Σ ACCTOTALS debit − credit (§5.1 #2)",
        source: imbalance.toString(),
        dulja: ZERO,
        difference: imbalance.toString(),
        explanation,
      },
      settled: imbalance.isZero() || explanation !== null,
    };
  })();
  const differences = tb.reduce((sum, j) => sum.add(money(j.row.difference)), zero);
  const expected = differences.subtract(imbalance);
  const suspenseNet = duljaNet(SUSPENSE_CODE);
  const closing = expected.subtract(suspenseNet);
  const parts = tb.filter((j) => !money(j.row.difference).isZero());
  const closingRow: Judged = {
    row: {
      key: SUSPENSE_CODE,
      label: `${SUSPENSE_CODE} at the cut-over date = Σ trial-balance differences − the legacy imbalance`,
      source: expected.toString(),
      dulja: suspenseNet.toString(),
      difference: closing.toString(),
      explanation: closing.isZero()
        ? `${SUSPENSE_CODE} holds ${suspenseNet.toString()}: the trial-balance differences (${
            parts.map((j) => `${j.row.key} ${j.row.difference}`).join(", ") || "none"
          }) less the legacy imbalance ${imbalance.toString()}, each explained on its own row`
        : null,
    },
    settled: closing.isZero(),
  };
  const suspense = [imbalanceRow, closingRow];

  // ── 3. Each employee's YTD against their own payslips.
  const employeeYtd = await employeeSection(tx, reader, ctx, base);

  const all = [...tb, ...stock.rows, ...employeeYtd, ...suspense];
  const unexplained = all.filter((j) => !j.settled).map((j) => j.row);
  return {
    generatedAt: new Date().toISOString(),
    cutOverDate: ctx.cutOverDate,
    trialBalance: tb.map((j) => j.row),
    stockValuation: stock.rows.map((j) => j.row),
    employeeYtd: employeeYtd.map((j) => j.row),
    suspense: suspense.map((j) => j.row),
    suspenseBalance: suspenseNet.toString(),
    unexplained,
    ok: unexplained.length === 0,
  };
}

function legacyOf(
  entries: readonly AccountMapEntry[],
  legacy: ReadonlyMap<string, Money<CurrencyCode>>,
  zero: Money<CurrencyCode>,
): Money<CurrencyCode> {
  return entries.reduce((sum, e) => sum.add(legacy.get(e.legacyCode) ?? zero), zero);
}

function controlSentence(
  entry: AccountMapEntry,
  legacy: Money<CurrencyCode>,
  items: Money<CurrencyCode>,
): string {
  const head = `supplied by the open-item load, one OPENING_BALANCE per open legacy ${entry.treatment === "ar_control" ? "receivable" : "payable"} (ADR 0085): the legacy BILLS total ${items.toString()}`;
  const drift = legacy.subtract(items);
  if (drift.isZero()) return `${head}, as the control does`;
  return `${head} while the legacy control holds ${legacy.toString()} — the ${drift.toString()} between them is the legacy control's own drift against its open items (SAH-001), standing on ${SUSPENSE_CODE}`;
}

function inventorySentence(
  codes: readonly string[],
  legacy: Money<CurrencyCode>,
  recomputed: Money<CurrencyCode>,
  reported: Money<CurrencyCode>,
): string {
  const head = `supplied by OPENING_STOCK at the cost 3B's engine recomputes by replaying the legacy movement history (§5.1 #6): ${recomputed.toString()}${codes.length > 1 ? ` across ${codes.join(", ")}` : ""}`;
  const recost = legacy.subtract(recomputed);
  const said = recost.isZero()
    ? `${head}, as the legacy control holds`
    : `${head}, while the legacy control holds ${legacy.toString()} — the ${recost.toString()} between them is the recost — the stored figure, which §5.1 #6 forbids importing, less the recomputation — standing on ${SUSPENSE_CODE}`;
  if (reported.isZero()) return said;
  return `${said}; ${reported.toString()} of the recomputation is in positions the load reported and did not open (the skip register; see stockValuation), which a STOCK_COUNT opens after cut-over`;
}

/** The legacy open items' net per side, debit-positive — `BILLS` read with Task 7's own rules (kind `1` receivable,
 *  `2` payable, a NULL amount refused). A receivable opens on the debit side and a payable on the credit side. */
async function openItemsNet(
  reader: LegacyReader,
  base: CurrencyCode,
): Promise<{ receivable: Money<CurrencyCode>; payable: Money<CurrencyCode> }> {
  await requireTable(
    reader,
    "BILLS",
    "the account map names an AR or AP control the open-item load supplies",
  );
  let receivable = Money.zero(base);
  let payable = Money.zero(base);
  for (const row of await readWhole(reader, "BILLS", ["BILID", "BILKIND", "BILOPEN"], "BILID")) {
    const site = `BILLS/${requireText(row, "BILID", "BILLS")}`;
    const kind = requireText(row, "BILKIND", site);
    const amount = moneyOf(row, "BILOPEN", base, site);
    if (kind === "1") receivable = receivable.add(amount);
    else if (kind === "2") payable = payable.subtract(amount);
    else
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: BILKIND is ${JSON.stringify(kind)}; 1 is a receivable and 2 a payable, and a kind the load cannot read is never guessed`,
      );
  }
  return { receivable, payable };
}

/** A legacy position as the skip register keys it (`opening-stock.ts`' `reportKey`): item/warehouse[/batch]. */
const positionOf = (m: { itemKey: string; warehouseKey: string; lotKey: string | null }): string =>
  `${m.itemKey}/${m.warehouseKey}${m.lotKey === null ? "" : `/${m.lotKey}`}`;

/**
 * The stock valuation: the SOURCE side is the recomputation of the legacy movement history — `BILLITEMS` parsed by the
 * opening-stock loader's own `map` and replayed by `replayLegacyMovements` at the company's costing method, exactly as
 * the load did — never `MatCosts` (§5.1 #6 forbids importing the legacy cost). Per Dulja item and warehouse, against
 * `valuationAsOf` at the cut-over date. A position whose item or warehouse did not import is its own row; so is a Dulja
 * valuation no legacy position accounts for. A pool the legacy history drives negative opens nothing and has no value
 * on either side: it is listed, explained by the skip register that names it, and does not fail the reconciliation
 * (ADR 0086 decision 5). A position the load READ and reported rather than opened (a service, a batch of another
 * item, a parent that did not import) is final — opening stock is one-shot — so a difference of exactly its value is
 * explained by the skip register and counted after cut-over; one the load never read (the source grew) is not
 * (ADR 0086 decision 9, 9B review finding 3), and neither is one it read before its item, warehouse or lot was loaded
 * (ADR 0086 decision 10, 2026-11-15 review HRP-04).
 */
async function stockSection(
  tx: Sql,
  reader: LegacyReader,
  ctx: LoadContext,
  base: CurrencyCode,
  method: CostingMethod,
  mapped: boolean,
): Promise<{
  rows: Judged[];
  recomputed: Money<CurrencyCode>;
  /** Σ of the stock rows the skip register explains: positions the load read and reported, not opened. */
  reported: Money<CurrencyCode>;
}> {
  const zero = Money.zero(base);
  const present = (await reader.tables()).includes("BILLITEMS");
  if (!present && mapped)
    await requireTable(
      reader,
      "BILLITEMS",
      "the account map names an inventory control OPENING_STOCK supplies",
    );

  const movements: LegacyMovement[] = [];
  if (present) {
    const columns = await readableColumns(reader, "BILLITEMS", openingStockLoader.sourceColumns);
    const rows = await readWhole(reader, "BILLITEMS", columns, "BTMID");
    const refs = refResolver(tx, ctx.companyId);
    await withRunScope({ baseCurrency: base, cutOverDate: ctx.cutOverDate }, async () => {
      for (const row of rows) {
        const movement = await openingStockLoader.map(row, refs);
        if ("skip" in movement) continue; // the loader's `map` never skips; a row it cannot read refuses
        movements.push(movement);
      }
    });
    const late = movements.find((m) => m.effectiveDate > ctx.cutOverDate);
    if (late)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `BILLITEMS/${late.sourceKey} is dated ${late.effectiveDate}, after the cut-over date ${ctx.cutOverDate}; the source is not the frozen one the load read`,
      );
  }
  const result = replayLegacyMovements(movements, method, base);
  const recomputed = result.positions.reduce((sum, p) => sum.add(p.value), zero);

  // 9B review, finding 3 — which positions the load READ and did not open. Opening stock is one-shot, so such a
  // position is final: it is in the skip register, and a STOCK_COUNT opens it after cut-over. A position is "read"
  // when every one of its source rows is recorded under `opening_stock` (so a row added to the source after the load
  // is not, and stays unexplained), and "opened" when one of the load's own OPENING_STOCK documents carries a line for
  // its item, warehouse and lot.
  const recordedAt = new Map(
    (
      await tx<{ source_key: string; at: Date }[]>`
        select source_key, created_at as at from app.import_batch
         where company_id = ${ctx.companyId} and source_table = 'BILLITEMS' and target_table = 'opening_stock'`
    ).map((r) => [r.source_key, r.at.getTime()]),
  );
  const recorded = new Set(recordedAt.keys());
  // 2026-11-15 review, HRP-04 (ADR 0086 decision 10): when each parent a position resolves into was recorded. A
  // position the load read while its item, warehouse or lot was not yet loaded — an opening run ahead of its parents —
  // was reported for a reason the source does not have, so the skip register does not explain it.
  const parentAt = new Map(
    (
      await tx<{ target_table: string; source_key: string; at: Date }[]>`
        select target_table, source_key, created_at as at from app.import_batch
         where company_id = ${ctx.companyId} and target_table in ('item', 'warehouse', 'lot')`
    ).map((r) => [`${r.target_table}:${r.source_key}`, r.at.getTime()]),
  );
  const readAt = new Map<string, number>();
  for (const m of movements) {
    const at = recordedAt.get(m.sourceKey);
    if (at !== undefined) readAt.set(positionOf(m), Math.max(readAt.get(positionOf(m)) ?? at, at));
  }
  const parentsLoadedLate = (p: {
    itemKey: string;
    warehouseKey: string;
    lotKey: string | null;
  }): boolean => {
    const read = readAt.get(positionOf(p));
    if (read === undefined) return false;
    const parents = [`item:${p.itemKey}`, `warehouse:${p.warehouseKey}`];
    if (p.lotKey !== null) parents.push(`lot:${p.lotKey}`);
    return parents.some((k) => (parentAt.get(k) ?? -Infinity) > read);
  };
  const openedLines = new Set(
    (
      await tx<{ position: string }[]>`
        select distinct concat_ws('|', l.item_id::text, l.warehouse_id::text, coalesce(l.lot_id::text, '')) as position
          from app.document_line l
         where l.company_id = ${ctx.companyId}
           and l.document_id in (select b.target_id from app.import_batch b
                                  where b.company_id = ${ctx.companyId} and b.source_table = 'BILLITEMS'
                                    and b.target_table = 'opening_stock')`
    ).map((r) => r.position),
  );
  const unread = new Set(movements.filter((m) => !recorded.has(m.sourceKey)).map(positionOf));

  const refs = refResolver(tx, ctx.companyId);
  const source = new Map<string, { value: Money<CurrencyCode>; legacy: string }>();
  const unresolved = new Map<string, Money<CurrencyCode>>();
  const reportedValue = new Map<string, Money<CurrencyCode>>();
  const reportedKeys = new Map<string, string[]>();
  const lateKeys = new Map<string, string[]>();
  for (const p of result.positions) {
    const itemId = await refs.byLegacyRef("item", p.itemKey);
    const warehouseId = await refs.byLegacyRef("warehouse", p.warehouseKey);
    const lotId = p.lotKey === null ? null : await refs.byLegacyRef("lot", p.lotKey);
    const legacyKey = `legacy material ${p.itemKey} in warehouse ${p.warehouseKey}`;
    const key = !itemId || !warehouseId ? legacyKey : `${itemId}|${warehouseId}`;
    const opened =
      itemId !== null &&
      warehouseId !== null &&
      (p.lotKey === null || lotId !== null) &&
      openedLines.has(`${itemId}|${warehouseId}|${lotId ?? ""}`);
    if (!opened && !unread.has(positionOf(p))) {
      if (parentsLoadedLate(p)) lateKeys.set(key, [...(lateKeys.get(key) ?? []), positionOf(p)]);
      else {
        reportedValue.set(key, (reportedValue.get(key) ?? zero).add(p.value));
        reportedKeys.set(key, [...(reportedKeys.get(key) ?? []), positionOf(p)]);
      }
    }
    if (!itemId || !warehouseId) {
      unresolved.set(legacyKey, (unresolved.get(legacyKey) ?? zero).add(p.value));
      continue;
    }
    source.set(key, { value: (source.get(key)?.value ?? zero).add(p.value), legacy: legacyKey });
  }

  const valuation: ValuationRow[] = [];
  let cursor: { itemCode: string; warehouseCode: string } | null = null;
  for (;;) {
    const page = await valuationAsOf(tx, {
      companyId: ctx.companyId,
      asOf: ctx.cutOverDate,
      cursor,
      limit: VALUATION_PAGE,
    });
    valuation.push(...page);
    if (page.length < VALUATION_PAGE) break;
    const last = page.at(-1)!;
    cursor = { itemCode: last.itemCode, warehouseCode: last.warehouseCode };
  }
  const held = new Map(valuation.map((v) => [`${v.itemId}|${v.warehouseId}`, v]));

  const ids = [...source.keys()].map((k) => k.split("|") as [string, string]);
  const names = new Map(
    (
      await tx<{ id: string; code: string }[]>`
        select id::text as id, code from app.item
         where company_id = ${ctx.companyId} and id = any(${ids.map(([item]) => item)}::uuid[])
        union all
        select id::text as id, code from app.warehouse
         where company_id = ${ctx.companyId} and id = any(${ids.map(([, warehouse]) => warehouse)}::uuid[])`
    ).map((r) => [r.id, r.code]),
  );

  const rows: Judged[] = [];
  let reported = zero;
  const compare = (
    key: string,
    label: string,
    sourceValue: Money<CurrencyCode>,
    duljaValue: Money<CurrencyCode>,
    mapKey: string,
  ) => {
    const difference = sourceValue.subtract(duljaValue);
    // ADR 0086 decision 9: explained by the skip register when the difference is EXACTLY the value of the positions
    // the load read and reported under this key — no tolerance, and a partly-opened position is not explained.
    const skipped = reportedValue.get(mapKey) ?? zero;
    const bySkip = !difference.isZero() && !skipped.isZero() && difference.equals(skipped);
    if (bySkip) reported = reported.add(difference);
    const late = lateKeys.get(mapKey);
    rows.push({
      row: {
        key,
        label:
          late === undefined
            ? label
            : `${label}; the opening-stock load read ${late.join(", ")} before its item, warehouse or lot was loaded, so its skip is a load-order mistake and the skip register does not explain it (2026-11-15 review, HRP-04)`,
        source: sourceValue.toString(),
        dulja: duljaValue.toString(),
        difference: difference.toString(),
        explanation: bySkip
          ? `the opening-stock load read ${plural(reportedKeys.get(mapKey)!.length, "this position", "these positions")} (${reportedKeys.get(mapKey)!.join(", ")}) and reported rather than opened ${plural(reportedKeys.get(mapKey)!.length, "it", "them")} — the skip register (skips.csv) names each and why. Opening stock is one-shot, so a re-run never opens ${plural(reportedKeys.get(mapKey)!.length, "it", "them")}: count ${plural(reportedKeys.get(mapKey)!.length, "it", "them")} with a STOCK_COUNT after cut-over (9B review, finding 3)`
          : null,
      },
      settled: difference.isZero() || bySkip,
    });
  };
  for (const key of new Set([...source.keys(), ...held.keys()])) {
    const [itemId, warehouseId] = key.split("|") as [string, string];
    const v = held.get(key);
    const itemCode = v?.itemCode ?? names.get(itemId) ?? itemId;
    const warehouseCode = v?.warehouseCode ?? names.get(warehouseId) ?? warehouseId;
    const legacyKey = source.get(key)?.legacy;
    compare(
      `${itemCode}/${warehouseCode}`,
      `${itemCode} in ${warehouseCode}${legacyKey ? ` (${legacyKey})` : ", which no legacy position accounts for"}`,
      source.get(key)?.value ?? zero,
      v ? Money.of(v.value, base) : zero,
      key,
    );
  }
  for (const [legacyKey, value] of unresolved)
    compare(
      legacyKey,
      `${legacyKey}, whose item or warehouse did not import (see skips.csv)`,
      value,
      zero,
      legacyKey,
    );
  rows.sort((a, b) => (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  for (const n of result.negatives)
    rows.push({
      row: {
        key: `legacy material ${n.itemKey} in warehouse ${n.warehouseKey}${n.lotKey === null ? "" : ` batch ${n.lotKey}`}`,
        label: "a pool the legacy history drives negative",
        source: ZERO,
        dulja: ZERO,
        difference: ZERO,
        explanation: `the legacy history drives it to ${n.quantity}; a negative opening is never loaded (acceptance test 18) and the skip register names it — count it after cut-over`,
      },
      settled: true,
    });
  return { rows, recomputed, reported };
}

/**
 * Each employee's YTD opening against the sum of their own `PAYITEMS` for the cut-over date's calendar year (§5.1 #11,
 * round 18 B7) — the DoD's "reconciles to their last legacy payslip", checked on what Dulja HOLDS, whatever wrote it
 * (the load, or a person's `manual:` opening after a withheld one). One row per legacy employee with a YTD figure or a
 * payslip in that year; reconciled means an opening whose gross AND net equal the payslips' to the cent. No figure is
 * written into a row (9B T8): a salary reaches the artefact, the terminal and the customer's printout that way.
 */
async function employeeSection(
  tx: Sql,
  reader: LegacyReader,
  ctx: LoadContext,
  base: CurrencyCode,
): Promise<Judged[]> {
  const tables = await reader.tables();
  if (!tables.includes("EMPLOYEES")) return [];
  const year = Number(ctx.cutOverDate.slice(0, 4));
  const columns = await readableColumns(reader, "EMPLOYEES", [
    { name: "EMPID", required: true },
    { name: "EMPYTDGROSS", required: false },
    { name: "EMPYTDNET", required: false },
  ]);
  const employees = await readWhole(reader, "EMPLOYEES", columns, "EMPID");

  const payslips = new Map<
    string,
    { gross: Money<CurrencyCode>; net: Money<CurrencyCode>; count: number }
  >();
  const hasPayslips = tables.includes("PAYITEMS");
  if (hasPayslips)
    for await (const page of reader.read<LegacyRow>("PAYITEMS", {
      columns: ["PITEMP", "PITYEAR", "PITGROSS", "PITNET"],
      where: { op: "eq", column: "PITYEAR", value: String(year) },
      batch: 500,
    }))
      for (const row of page) {
        const key = requireText(row, "PITEMP", "PAYITEMS");
        const site = `PAYITEMS of employee ${key}`;
        const sum = payslips.get(key) ?? {
          gross: Money.zero(base),
          net: Money.zero(base),
          count: 0,
        };
        payslips.set(key, {
          gross: sum.gross.add(payMoneyOf(row, "PITGROSS", base, site)),
          net: sum.net.add(payMoneyOf(row, "PITNET", base, site)),
          count: sum.count + 1,
        });
      }

  const openings = new Map(
    (await listEmployeeYtdOpening(tx, { companyId: ctx.companyId, year })).map((o) => [
      o.employeeId,
      o,
    ]),
  );
  const refs = refResolver(tx, ctx.companyId);
  const rows: Judged[] = [];
  for (const row of employees) {
    const key = requireText(row, "EMPID", "EMPLOYEES");
    const pay = payslips.get(key);
    const figures =
      optionalText(row, "EMPYTDGROSS") !== null || optionalText(row, "EMPYTDNET") !== null;
    if (!pay && !figures) continue; // no pay in the year: nothing to reconcile
    const employeeId = await refs.byLegacyRef("employee", key);
    const opening = employeeId === null ? undefined : openings.get(employeeId);
    const off = !opening
      ? "no opening"
      : !hasPayslips
        ? "no payslips to compare"
        : [
            Money.of(opening.gross, base).equals(pay?.gross ?? Money.zero(base)) ? null : "gross",
            Money.of(opening.net, base).equals(pay?.net ?? Money.zero(base)) ? null : "net",
          ]
            .filter((f): f is string => f !== null)
            .join(" and ");
    const count = pay?.count ?? 0;
    rows.push({
      row: {
        key: `YTD:${key}`,
        label: `employee ${opening?.employeeNumber ?? key}'s ${year} year-to-date gross and net against their own payslips (§5.1 #11)`,
        source: hasPayslips
          ? `${count} ${plural(count, "payslip", "payslips")} in ${year}`
          : "no PAYITEMS table",
        dulja: opening
          ? `opening loaded (${opening.source})`
          : employeeId === null
            ? "employee not loaded"
            : "no opening (withheld — the skip register names it)",
        difference: off === "" ? ZERO : off,
        explanation: null,
      },
      settled: off === "",
    });
  }
  return rows;
}
