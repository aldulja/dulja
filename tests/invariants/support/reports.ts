import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import {
  Money,
  Quantity,
  rational,
  statementKindFor,
  type CurrencyCode,
  type ReportDefinition,
} from "@dulja/domain";
import {
  MAX_DATASET_ROWS,
  convertToInvoice,
  createPromotion,
  creditNoteFrom,
  draftTransfer,
  isDatasetId,
  issueDocument,
  itemProfitabilityRows,
  postDocument,
  recordCounts,
  rowsForDefinition,
  snapshotCountSheet,
  transitionDocument,
  valuationAsOf,
  withTenant as withContext,
  type DatasetRow,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedBranch,
  seedItem,
  seedLot,
  seedParty,
  seedPaymentTerm,
  seedPriceList,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../../support/source";
import { postJournal } from "./post-journal";
import { ensureOpenPeriods, secondPrincipal } from "./post-inventory";
// `postFromPack` threads `partyId` and the HEADER `warehouseId` into 3C's `draftTypedDocument`, which
// `GOODS_RECEIPT` and `DELIVERY_ORDER` need (`requires: ["party", "warehouse"]`); 3B's `postInventoryDocument`
// carries no party. `packApproval` / `PACK_DIR` read each type's codes off its own shipped envelope.
import { PACK_DIR, packApproval, postFromPack, seedTypeFromPack } from "./ar-ap";

/**
 * 7B's tie-out harness (contracts §4.17.1, 7B amendment A9; ADR 0068). The one place a report definition is
 * read off disk, executed through 7A's `rowsForDefinition` — the row provider 7A's `reporting.render` handler
 * calls — and compared with the ledger or a projection over an INDEPENDENT path.
 *
 * Every `DatasetRow` key is the dataset's snake_case column alias (amendment A3), never the camelCase member
 * of a read-function row type; every sum goes through `Money` / `Quantity`, never `Number()`; every
 * comparison is fixed-scale string against fixed-scale string, so "to the cent" is literal.
 */

/** The production `TenantContext` (§4.2.2) the shipped services take. */
async function ctxFor(db: Db, s: Seed, actorId: string): Promise<TenantContext> {
  return { tenantId: s.tenant, actorId, requestId: await uuidv7(db.admin) };
}

/** The twenty-two codes of §4.16.1 this slice seeds, in the register's own order. */
export const CATALOGUE_7B = [
  "accounting.general_ledger",
  "accounting.journal_register",
  "accounting.account_statement",
  "accounting.period_comparison",
  "accounting.profit_and_loss",
  "accounting.balance_sheet",
  "accounting.document_register",
  "accounting.audit_log",
  "accounting.document_event_log",
  "accounting.trial_balance",
  "accounting.ledger",
  "inventory.stock_ageing",
  "inventory.movement_register",
  "inventory.expiry_list",
  "inventory.price_list",
  "inventory.promotion_register",
  "inventory.transfer_register",
  "inventory.count_register",
  "inventory.profit_by_item",
  "inventory.stock_on_hand",
  "inventory.valuation",
  "inventory.sales_by_item",
] as const;
export type ReportCode7B = (typeof CATALOGUE_7B)[number];

export const CATALOGUE_DIR = join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7b");

/** The seed-file envelope of §4.16.1 (amendment A1): `definitionVersion` is the ROW version, the inner
 *  `definition.version` the FORMAT version. The test tier's typed twin of 7A's loader envelope (A18 item 5). */
export interface ReportSeedEnvelope {
  definitionVersion: number;
  definition: ReportDefinition;
}

export function readEnvelope(code: string): ReportSeedEnvelope {
  const path = join(CATALOGUE_DIR, `${code}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ReportSeedEnvelope;
  if (!Number.isInteger(parsed.definitionVersion) || parsed.definitionVersion < 1) {
    throw new Error(`${path}: definitionVersion must be an integer >= 1 (amendment A1)`);
  }
  if (parsed.definition?.code !== code) {
    throw new Error(
      `${path}: definition.code is ${String(parsed.definition?.code)}, the file name says ${code}`,
    );
  }
  return parsed;
}

export function readDefinition(code: string): ReportDefinition {
  return readEnvelope(code).definition;
}

/** Every field a definition references anywhere — what the field-coverage gate compares with the row keys. */
function referencedFields(d: ReportDefinition): string[] {
  return [
    ...d.dataset.filters.map((f) => f.field),
    ...d.columns.map((c) => c.field),
    ...d.groups.map((g) => g.field),
    ...d.totals.map((t) => t.field),
    ...d.sort.map((s) => s.field),
  ];
}

/**
 * Executes a DEFINITION through 7A's one row provider. `rowsForDefinition` sends a `STATEMENT_CODES` key to
 * `statementRows` and every other code to `datasetFor(source).run(...)`, building the filter triples from the
 * definition and dropping a clause whose parameter is absent or empty. This file knows no SQL of a report.
 *
 * It adds exactly three things: (a) a named §4.16.2 message for an unknown dataset, (b) a named message for a
 * statement run without `fiscalPeriodId`, and (c) the refusal of a FULL page — a tie-out summed over a
 * truncated page is the quietest false negative there is. `companyId` is a named member, never a parameter,
 * and a `null` parameter is an omitted one.
 */
export async function runDefinition(
  tx: Sql,
  definition: ReportDefinition,
  params: Readonly<Record<string, string | null>>,
  limit: number = MAX_DATASET_ROWS,
): Promise<DatasetRow[]> {
  const source = definition.dataset.source;
  if (!isDatasetId(source)) {
    throw new Error(
      `${definition.code}: dataset "${source}" is not a member of 7A's closed registry (§4.16.2)`,
    );
  }
  const companyId = params["companyId"];
  if (typeof companyId !== "string" || companyId === "") {
    throw new Error(`${definition.code}: runDefinition needs params.companyId`);
  }
  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "companyId" && typeof value === "string" && value !== "") parameters[key] = value;
  }
  if (statementKindFor(definition.code) !== null && parameters["fiscalPeriodId"] === undefined) {
    throw new Error(
      `${definition.code}: a statement needs the fiscalPeriodId parameter (amendment A6)`,
    );
  }
  const rows = await rowsForDefinition(tx, definition, { companyId, parameters, limit });
  if (rows.length >= limit) {
    throw new Error(
      `${definition.code}: rowsForDefinition filled the page (${rows.length} of limit ${limit}); a tie-out over ` +
        `a truncated page proves nothing — narrow the fixture's parameters, never raise the limit past MAX_DATASET_ROWS`,
    );
  }
  return rows;
}

/** Every field the definition references is a key of the rows the query ACTUALLY returned (amendment A3's
 *  third check — `assertDefinitionFields` only sees the declared column list). A zero-row result proves
 *  nothing and is refused. */
export function assertFieldCoverage(
  definition: ReportDefinition,
  rows: readonly DatasetRow[],
): void {
  if (rows.length === 0) {
    throw new Error(
      `${definition.code}: the fixture returned no rows, so field coverage proves nothing — fix the fixture, never the gate`,
    );
  }
  const keys = new Set(Object.keys(rows[0]!));
  const missing = [...new Set(referencedFields(definition))].filter((f) => !keys.has(f));
  if (missing.length > 0) {
    throw new Error(
      `${definition.code}: dataset "${definition.dataset.source}" has no field(s) ${missing.join(", ")} — ` +
        `either the definition names a field amendment A3 does not pin, or 7A's query does not return one it does`,
    );
  }
}

/**
 * Which of the four ledger sums each money total is compared against (amendment A5). Closed, and a KEY into
 * one query's four fixed columns — never a SQL fragment, so nothing is interpolated into a statement.
 *
 * `debit` / `credit` are GROSS, unsigned sums: a field maps to one only when its total moves one way. `net`
 * (debit − credit) and `credit_net` (credit − debit) are SIGNED, chosen by the natural balance of the account
 * tied against. **A signed field is never mapped to `credit`**: a run posting its net leg as a debit to a
 * payable makes `sum(base_credit)` zero while the signed total is negative. `credit_net` is the arm for that
 * shape; no 7B key uses it, and 8D's are its first users.
 */
const LEDGER_MEASURE: Readonly<Record<string, "debit" | "credit" | "net" | "credit_net">> = {
  base_debit: "debit",
  base_credit: "credit",
  base_balance: "net",
  base_total: "debit",
  // 7C (contracts round 15, A3). Both are SIGNED — a refund or a credit note moves the other way — so neither is
  // `credit`. `net_sales_base` is restricted to income accounts by the window's `accountTypes`, `tax_base` to
  // the tax control by `tieOut.account`; no fifth column and no new arm.
  net_sales_base: "credit_net",
  tax_base: "credit_net",
  // 8D (contracts round 19, A10). The `payroll_line` dataset's two SIGNED measures — each line's contribution to one
  // §4.15 credit-balance account: `net_contribution` to 2400 salaries payable, `payable_contribution` to the scheme's
  // own 241n. The sign lives in the dataset's SQL (a deduction or an employee share is already negative, the net-pay
  // leg already zero), so the sum re-derives net from its parts. Both are `credit_net`, not the `credit` the plan's
  // A10 wrote: a negative-net supplementary run posts its net leg as a DEBIT to 2400, which `sum(base_credit)` would
  // miss — this map's own rule above, and the arm its comment reserved for 8D (8D Self-Review question (e)).
  net_contribution: "credit_net",
  payable_contribution: "credit_net",
};

/** The ledger side's window. `accountTypes` restricts by `account.type` (a statement ties one statement's
 *  account types, A6); `accountCode` by one code; `documentTypeCodes` by the posting document's type. */
export interface LedgerWindow {
  fiscalPeriodId?: string;
  fromDate?: string;
  toDate?: string;
  accountCode?: string;
  accountTypes?: readonly string[];
  documentTypeCodes?: readonly string[];
  /** 7C (contracts round 15, A3). Each narrows the ledger side through the `document` join the query already
   *  has — `d.party_id`, `d.branch_id`, `d.shift_id` — and each is optional, so 7B's windows are unchanged. */
  partyId?: string;
  branchId?: string;
  shiftId?: string;
}

/** A `tieOut.kind: "none"` report's proof: an independent query whose row set the report's must equal on
 *  `key` (a list of snake_case row fields). */
export interface TieOutWitness {
  key: readonly string[];
  rows(tx: Sql): Promise<Record<string, string | null>[]>;
}

export interface TieOutOptions {
  params: Readonly<Record<string, string | null>>;
  baseCurrency: CurrencyCode;
  window?: LedgerWindow;
  /** The valuation date for a `stock_valuation` tie-out. Defaults to the run's `asOf` parameter, else today
   *  (7A's `cost_layer.age_days` is measured from `current_date`, A13). */
  asOf?: string;
  /** For a `stock_on_hand` tie-out over a report that is complete for SOME keys only (7B Task 6): the exact
   *  keys to compare, joined the way the branch joins them. A named key absent from the projection is an
   *  error, so the restriction can never silently become "compare nothing". */
  projectionKeys?: readonly string[];
  witness?: TieOutWitness;
}

function sumMoney(rows: readonly DatasetRow[], field: string, base: CurrencyCode): Money {
  return rows.reduce(
    (acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), base)),
    Money.zero(base),
  );
}

function firstMoneyTotal(definition: ReportDefinition): string {
  const money = new Set(definition.columns.filter((c) => c.format === "money").map((c) => c.field));
  const total = definition.totals.find((t) => t.fn === "sum" && money.has(t.field));
  if (total === undefined) {
    throw new Error(
      `${definition.code}: tieOut.kind is "ledger_sum" but no money column has a sum total (amendment A5)`,
    );
  }
  if (!Object.hasOwn(LEDGER_MEASURE, total.field)) {
    throw new Error(
      `${definition.code}: "${total.field}" is not in the closed measure map ${Object.keys(LEDGER_MEASURE).join(", ")} (amendment A5)`,
    );
  }
  return total.field;
}

/** The quantity twin of `firstMoneyTotal`. `Quantity` is 6 dp and `Money` 4, so a quantity tie-out never
 *  passes through `Money` (SAH-066). */
function firstQuantityTotal(definition: ReportDefinition): string {
  const quantities = new Set(
    definition.columns.filter((c) => c.format === "quantity").map((c) => c.field),
  );
  const total = definition.totals.find((t) => t.fn === "sum" && quantities.has(t.field));
  if (total === undefined) {
    throw new Error(
      `${definition.code}: a stock_on_hand tie-out needs a sum total over a quantity column`,
    );
  }
  return total.field;
}

/** A fixed-scale decimal string as an integer count of 10^-6 units, for an exact `Rational` (no float). */
function micros(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const units = BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`);
  return negative ? -units : units;
}

/**
 * A `cost_layer` row's RESIDUE value. The dataset's `value` is the layer's stored RECEIPT value at `qty_in`
 * (migration 0118), so the residue is `round(value × qty_remaining / qty_in, 4)` — exactly the per-layer term
 * `valuationAsOf` sums (ADR 0039's approved exact-value amendment; contracts 7B A5). One `Rational`, one
 * rounding, half away from zero as Postgres's `round(numeric, 4)`.
 */
function layerResidue(r: DatasetRow, base: CurrencyCode): Money {
  const qtyIn = micros(String(r["qty_in"] ?? "0"));
  if (qtyIn === 0n) return Money.zero(base);
  return Money.of(String(r["value"] ?? "0.0000"), base).multiply(
    rational(micros(String(r["qty_remaining"] ?? "0")), qtyIn),
    "HALF_AWAY_FROM_ZERO",
  );
}

/** One stored row of a 7C projection branch: its composite key and its figures as fixed-scale text. */
type StoredRow = { key: string } & Record<string, string | null>;

/** A run parameter as the run saw it: `runDefinition` drops an absent or empty one, and so does this. */
function param(opts: TieOutOptions, name: string): string | null {
  const value = opts.params[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The comparison every 7C projection branch makes (contracts round 15, A3): each report row, keyed on
 * `keyFields`, is a stored row whose `figures` equal the report's through `Money` (a null equals only a null);
 * a key the report repeats is refused; and every stored key is in the report. Fixed scale against fixed scale,
 * so "to the cent" is literal and no epsilon is chosen.
 */
function compareStored(
  definition: ReportDefinition,
  rows: readonly DatasetRow[],
  stored: readonly StoredRow[],
  keyFields: readonly string[],
  figures: readonly string[],
  base: CurrencyCode,
): void {
  const money = (value: unknown): string | null =>
    value === null || value === undefined ? null : Money.of(String(value), base).toString();
  const byKey = new Map(stored.map((r) => [r.key, r]));
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyFields.map((k) => String(row[k] ?? "")).join("|");
    if (seen.has(key)) {
      throw new Error(`${definition.code}: the report repeats ${key}`);
    }
    seen.add(key);
    const want = byKey.get(key);
    if (want === undefined) {
      throw new Error(
        `${definition.code}: the report has ${key}, which the stored source does not select`,
      );
    }
    for (const field of figures) {
      if (!(field in row)) {
        throw new Error(`${definition.code}: rows carry no '${field}' column`);
      }
      const got = money(row[field]);
      const exp = money(want[field]);
      if (got !== exp) {
        throw new Error(
          `${definition.code}: ${key}.${field} is ${String(exp)} stored and ${String(got)} in the report`,
        );
      }
    }
  }
  for (const key of byKey.keys()) {
    if (!seen.has(key)) {
      throw new Error(`${definition.code}: the stored source has ${key} and the report does not`);
    }
  }
}

/**
 * Executes the definition's declared `tieOut` (§4.11.1, amendment A5). Every branch compares two INDEPENDENT
 * paths: the report's own rows against one SQL sum, one projection read or one witness query.
 */
export async function assertTieOut(
  tx: Sql,
  definition: ReportDefinition,
  opts: TieOutOptions,
): Promise<void> {
  const rows = await runDefinition(tx, definition, opts.params);
  assertFieldCoverage(definition, rows);
  const base = opts.baseCurrency;
  const companyId = String(opts.params["companyId"]);
  const w = opts.window ?? {};

  if (definition.tieOut.kind === "ledger_sum") {
    const field = firstMoneyTotal(definition);
    const measure = LEDGER_MEASURE[field]!;
    const account = w.accountCode ?? definition.tieOut.account ?? null;
    const types = w.documentTypeCodes === undefined ? null : [...w.documentTypeCodes];
    const accountTypes = w.accountTypes === undefined ? null : [...w.accountTypes];
    const [row] = await tx<{ debit: string; credit: string; net: string; credit_net: string }[]>`
      select coalesce(sum(le.base_debit), 0)::numeric(19,4)::text                  as debit,
             coalesce(sum(le.base_credit), 0)::numeric(19,4)::text                 as credit,
             coalesce(sum(le.base_debit - le.base_credit), 0)::numeric(19,4)::text as net,
             coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit_net
        from app.ledger_entry le
        join app.account       a  on a.id  = le.account_id
        join app.document      d  on d.id  = le.document_id
        join app.document_type dt on dt.id = d.document_type_id
       where le.company_id = ${companyId}::uuid
         and (${w.fiscalPeriodId ?? null}::uuid is null or le.fiscal_period_id = ${w.fiscalPeriodId ?? null}::uuid)
         and (${w.fromDate ?? null}::date is null or le.effective_date >= ${w.fromDate ?? null}::date)
         and (${w.toDate ?? null}::date is null or le.effective_date <= ${w.toDate ?? null}::date)
         and (${account}::text is null or a.code = ${account}::text)
         and (${accountTypes}::text[] is null or a.type::text = any(${accountTypes}::text[]))
         and (${types}::text[] is null or dt.code = any(${types}::text[]))
         and (${w.partyId ?? null}::uuid is null or d.party_id = ${w.partyId ?? null}::uuid)
         and (${w.branchId ?? null}::uuid is null or d.branch_id = ${w.branchId ?? null}::uuid)
         and (${w.shiftId ?? null}::uuid is null or d.shift_id = ${w.shiftId ?? null}::uuid)`;
    const measured = Money.of(row![measure], base);
    const reported = sumMoney(rows, field, base);
    if (reported.toString() !== measured.toString()) {
      throw new Error(
        `${definition.code}: the report totals ${reported.toString()} and the ledger totals ${measured.toString()} ` +
          `for measure ${measure}${account === null ? "" : ` on account ${account}`}`,
      );
    }
    return;
  }

  if (definition.tieOut.kind === "projection") {
    switch (definition.tieOut.projection) {
      case "account_balance": {
        // The stored side is restricted to the report's own window — a single-account report carries
        // `window.accountCode`, and every OTHER stored account would otherwise be compared with a report that
        // never claimed to cover it.
        const only = w.accountCode ?? null;
        const stored = await tx<
          { code: string; currency: string; debit: string; credit: string }[]
        >`
          select a.code, b.currency::text as currency, b.base_debit::text as debit, b.base_credit::text as credit
            from app.account_balance b join app.account a on a.id = b.account_id
           where b.company_id = ${companyId}::uuid
             and (${w.fiscalPeriodId ?? null}::uuid is null or b.fiscal_period_id = ${w.fiscalPeriodId ?? null}::uuid)
             and (${only}::text is null or a.code = ${only}::text)
           order by a.code, b.currency`;
        if (stored.length === 0) {
          throw new Error(
            `${definition.code}: account_balance has no row in this window${only === null ? "" : ` for account ${only}`}, so the tie-out would compare nothing`,
          );
        }
        const reported = new Map<string, Money>();
        for (const r of rows) {
          // `account_code` / `base_debit` / `base_credit` are 7A's aliases (A3), not `TrialBalanceRow` members;
          // a camelCase read here would be `undefined`, coerce to zero and pass vacuously.
          const key = `${String(r["account_code"])}|${String(r["currency"])}`;
          const net = Money.of(String(r["base_debit"] ?? "0.0000"), base).subtract(
            Money.of(String(r["base_credit"] ?? "0.0000"), base),
          );
          reported.set(key, (reported.get(key) ?? Money.zero(base)).add(net));
        }
        const storedKeys = new Set<string>();
        for (const s of stored) {
          const key = `${s.code}|${s.currency}`;
          storedKeys.add(key);
          const expected = Money.of(s.debit, base).subtract(Money.of(s.credit, base));
          const got = reported.get(key) ?? Money.zero(base);
          if (got.toString() !== expected.toString()) {
            throw new Error(
              `${definition.code}: account_balance says ${expected.toString()} for ${key}, the report says ${got.toString()}`,
            );
          }
        }
        for (const [key, got] of reported) {
          if (!storedKeys.has(key) && !got.isZero()) {
            throw new Error(
              `${definition.code}: the report carries ${got.toString()} for ${key}, which account_balance does not hold in this window`,
            );
          }
        }
        return;
      }
      case "stock_on_hand": {
        // The grouping key is whichever of (item_id, warehouse_id, lot_id) the REPORT's rows carry, and the
        // projection is aggregated on the same subset. Only the projection keys the report could contain are
        // compared: an item- or warehouse-filtered report is not asked to account for another item's stock.
        const qtyField = firstQuantityTotal(definition);
        const keyFields = ["item_id", "warehouse_id", "lot_id"].filter((k) => k in rows[0]!);
        const keyOf = (r: Readonly<Record<string, unknown>>): string =>
          keyFields.map((k) => String(r[k] ?? "")).join("|");
        const stored = await tx<
          { item_id: string; warehouse_id: string; lot_id: string; quantity: string }[]
        >`
          select item_id::text, warehouse_id::text, lot_id::text, quantity::text
            from app.stock_on_hand where company_id = ${companyId}::uuid`;
        const reported = new Map<string, Quantity>();
        for (const r of rows) {
          const key = keyOf(r);
          reported.set(
            key,
            (reported.get(key) ?? Quantity.zero()).add(
              Quantity.of(String(r[qtyField] ?? "0.000000")),
            ),
          );
        }
        // The keys compared: every key the report carries, or exactly `projectionKeys` for a report that is
        // complete for some keys only (a transfer register is complete for the in-transit warehouse, which
        // only transfers touch, and not for the warehouse the goods left).
        const compared = new Set(opts.projectionKeys ?? reported.keys());
        const expected = new Map<string, Quantity>();
        for (const r of stored) {
          const key = keyOf(r);
          if (!compared.has(key)) continue;
          expected.set(key, (expected.get(key) ?? Quantity.zero()).add(Quantity.of(r.quantity)));
        }
        for (const key of opts.projectionKeys ?? []) {
          if (!expected.has(key)) {
            throw new Error(
              `${definition.code}: projectionKeys names ${key}, which stock_on_hand does not hold`,
            );
          }
        }
        for (const key of compared) {
          const got = reported.get(key) ?? Quantity.zero();
          const want = expected.get(key) ?? Quantity.zero();
          if (got.toString() !== want.toString()) {
            throw new Error(
              `${definition.code}: stock_on_hand says ${want.toString()} for ${key}, the report says ${got.toString()}`,
            );
          }
        }
        return;
      }
      case "stock_valuation": {
        // TWO row shapes (A5): the `stock_valuation` dataset's own `value` column, or a `cost_layer` row's
        // residue, valued as `valuationAsOf` values it. The arithmetic lives here, once.
        const itemId = opts.params["itemId"] ?? null;
        if (itemId === null || itemId === "") {
          throw new Error(
            `${definition.code}: a stock_valuation tie-out needs the itemId parameter`,
          );
        }
        const asOf = opts.asOf ?? opts.params["asOf"] ?? new Date().toISOString().slice(0, 10);
        const valuation = await valuationAsOf(tx, { companyId, asOf, itemId, limit: 1000 });
        if (valuation.length === 0) {
          throw new Error(`${definition.code}: valuationAsOf returned nothing for item ${itemId}`);
        }
        const valued = (r: DatasetRow): Money =>
          definition.dataset.source === "cost_layer"
            ? layerResidue(r, base)
            : Money.of(String(r["value"] ?? "0.0000"), base);
        for (const v of valuation) {
          const got = rows
            .filter((r) => String(r["warehouse_id"]) === v.warehouseId)
            .reduce((a, r) => a.add(valued(r)), Money.zero(base));
          if (got.toString() !== Money.of(v.value, base).toString()) {
            throw new Error(
              `${definition.code}: valuationAsOf says ${v.value} for warehouse ${v.warehouseCode}, the report says ${got.toString()}`,
            );
          }
        }
        return;
      }
      case "item_profitability": {
        // Restricted to the period the report was RUN for, when it was run for one.
        const period = opts.params["fiscalPeriodId"] ?? null;
        const all = await itemProfitabilityRows(tx, { companyId });
        const stored = period === null ? all : all.filter((p) => p.fiscalPeriodId === period);
        if (stored.length === 0) {
          throw new Error(
            `${definition.code}: item_profitability has no row for ${period ?? "this company"}; run rebuildItemProfitability in the fixture first`,
          );
        }
        for (const p of stored) {
          // LEFT: the dataset's snake_case column. RIGHT: `ItemProfitabilityRow`'s camelCase member (A3).
          const got = rows.filter(
            (r) =>
              String(r["item_id"]) === p.itemId &&
              String(r["fiscal_period_id"]) === p.fiscalPeriodId,
          );
          if (got.length !== 1) {
            throw new Error(
              `${definition.code}: item_profitability has (${p.itemId}, ${p.fiscalPeriodId}) and the report has ${got.length} row(s)`,
            );
          }
          const pairs = [
            ["revenue_base", p.revenueBase],
            ["cogs_base", p.cogsBase],
            ["margin_base", p.marginBase],
          ] as const;
          for (const [field, expected] of pairs) {
            const reported = Money.of(String(got[0]![field] ?? "0.0000"), base);
            if (reported.toString() !== Money.of(expected, base).toString()) {
              throw new Error(
                `${definition.code}: item_profitability.${field} is ${expected}, the report says ${reported.toString()}`,
              );
            }
          }
        }
        return;
      }
      // ── 7C (contracts round 15, A3 and A16 item 13) — four stored sources, compared per key AND as a set ──
      // The stored side is the test's own SQL, restricted by the run's own parameters under the names the 7C
      // definitions declare, exactly as `stock_valuation` reads `itemId` and `item_profitability` reads
      // `fiscalPeriodId` above. Every report row's key must be a stored row with the same figures to the cent,
      // and every stored row the parameters select must be in the report.
      case "party_ageing": {
        // 7B's vocabulary named this member and no 7B code read it, so the branch did not exist; 7C's
        // `accounting.ageing` is its first reader. The REBUILT snapshot for the run's `asOf`, never the live
        // `party_ageing_rows` — that comparison is the ageing parity case's, against 4B's `agedBalance`.
        const asOf = param(opts, "asOf");
        if (asOf === null) {
          throw new Error(`${definition.code}: a party_ageing tie-out needs the asOf parameter`);
        }
        const stored = await tx<StoredRow[]>`
          select pa.party_id::text || '|' || pa.currency::text || '|' || pa.bucket as key,
                 pa.amount::text as amount, pa.base_amount::text as base_amount
            from app.party_ageing pa join app.party p on p.id = pa.party_id
           where pa.company_id = ${companyId}::uuid and pa.as_of = ${asOf}::date
             and (${param(opts, "partyKind")}::text is null or p.kind::text = ${param(opts, "partyKind")}::text)
             and (${param(opts, "currency")}::text is null or pa.currency::text = ${param(opts, "currency")}::text)`;
        compareStored(
          definition,
          rows,
          stored,
          ["party_id", "currency", "bucket"],
          ["amount", "base_amount"],
          base,
        );
        return;
      }
      case "shift": {
        // The shift's own stored figures: the count is a physical count in the shift's currency (6D A3), so
        // these four are compared as stored and `over_short` is never re-signed (positive is over).
        const stored = await tx<StoredRow[]>`
          select s.id::text as key, s.opening_float::text as opening_float,
                 s.counted_cash::text as counted_cash, s.expected_cash::text as expected_cash,
                 s.over_short::text as over_short
            from app.shift s join app.company co on co.id = s.company_id
           where s.company_id = ${companyId}::uuid
             and (${param(opts, "shiftId")}::uuid is null or s.id = ${param(opts, "shiftId")}::uuid)
             and (${param(opts, "branchId")}::uuid is null or s.branch_id = ${param(opts, "branchId")}::uuid)
             and (${param(opts, "cashierPrincipalId")}::uuid is null
                  or s.opened_principal_id = ${param(opts, "cashierPrincipalId")}::uuid)
             and (${param(opts, "fromDate")}::date is null
                  or (s.opened_at at time zone co.timezone)::date >= ${param(opts, "fromDate")}::date)
             and (${param(opts, "toDate")}::date is null
                  or (s.opened_at at time zone co.timezone)::date <= ${param(opts, "toDate")}::date)`;
        compareStored(
          definition,
          rows,
          stored,
          ["shift_id"],
          ["opening_float", "counted_cash", "expected_cash", "over_short"],
          base,
        );
        return;
      }
      case "allocation": {
        // A settlement allocation posts nothing (§4.8.1), so `ledger_sum` would compare the register against
        // zero and pass for the wrong reason. The date window is the SETTLED document's, as the register's is.
        const stored = await tx<StoredRow[]>`
          select al.id::text as key, al.base_amount::text as base_amount
            from app.allocation al
            join app.document      sd on sd.id = al.settlement_document_id
            join app.document_type st on st.id = sd.document_type_id
            join app.document      dd on dd.id = al.settled_document_id
           where al.company_id = ${companyId}::uuid
             and (${param(opts, "partyId")}::uuid is null or al.party_id = ${param(opts, "partyId")}::uuid)
             and (${param(opts, "settlementTypeCode")}::text is null
                  or st.code = ${param(opts, "settlementTypeCode")}::text)
             and (${param(opts, "fromDate")}::date is null or dd.effective_date >= ${param(opts, "fromDate")}::date)
             and (${param(opts, "toDate")}::date is null or dd.effective_date <= ${param(opts, "toDate")}::date)`;
        compareStored(definition, rows, stored, ["allocation_id"], ["base_amount"], base);
        return;
      }
      case "bank_statement_line": {
        // Live matches only: an unmatched row (`unmatched_at` set) is history, not a reconciliation. `isMatched`
        // absent means "false" — the unreconciled meaning the report is named for. Bound as text and cast by
        // Postgres: postgres.js serialises a boolean-typed parameter's string "true" as false (A16 item 12).
        const isMatched = param(opts, "isMatched") ?? "false";
        const stored = await tx<StoredRow[]>`
          select bl.id::text as key, bl.amount::text as amount,
                 coalesce(m.matched, 0)::numeric(19,4)::text as matched_amount
            from app.bank_statement_line bl
            join app.bank_statement bs on bs.id = bl.statement_id
            left join lateral (select sum(bm.amount) as matched from app.bank_match bm
                                where bm.statement_line_id = bl.id and bm.unmatched_at is null) m on true
           where bl.company_id = ${companyId}::uuid
             and (coalesce(m.matched, 0) = bl.amount) = ${isMatched}::text::boolean
             and (${param(opts, "bankAccountId")}::uuid is null
                  or bs.bank_account_id = ${param(opts, "bankAccountId")}::uuid)
             and (${param(opts, "fromDate")}::date is null or bl.value_date >= ${param(opts, "fromDate")}::date)
             and (${param(opts, "toDate")}::date is null or bl.value_date <= ${param(opts, "toDate")}::date)`;
        compareStored(definition, rows, stored, ["line_id"], ["amount", "matched_amount"], base);
        return;
      }
      // ── 8D (contracts round 19, A6) — two stored sources, added after 7C's; no earlier case is edited ──
      case "statutory_schedule": {
        // WHAT THIS ARM PROVES, STATED EXACTLY. Both sides read app.statutory_schedule — the report through the
        // `statutory_schedule` dataset, this side directly — so it is NOT a proof against the ledger. It proves the
        // definition's filters, the dataset's select and the stored projection agree: a wrong filter, a dropped
        // scheme, a mis-scaled numeric or a period boundary off by a day fails here. "Each scheme's schedule = its
        // payable to the cent" is `hr.payable_reconciliation`'s per-scheme 241n `ledger_sum`, and 8C's test 30.
        // Restricted by the run's own parameters under the names `hr.statutory_summary` declares, as 7C's arms are.
        const stored = await tx<StoredRow[]>`
          select ss.id::text as key, ss.total_employee::text as total_employee,
                 ss.total_employer::text as total_employer
            from app.statutory_schedule ss join app.statutory_scheme sc on sc.id = ss.scheme_id
           where ss.company_id = ${companyId}::uuid
             and (${param(opts, "fromDate")}::date is null or ss.period_start >= ${param(opts, "fromDate")}::date)
             and (${param(opts, "toDate")}::date is null or ss.period_end <= ${param(opts, "toDate")}::date)
             and (${param(opts, "schemeCode")}::text is null or sc.code = ${param(opts, "schemeCode")}::text)`;
        if (stored.length === 0) {
          throw new Error(
            `${definition.code}: statutory_schedule has no row for these parameters, so the tie-out would compare nothing`,
          );
        }
        compareStored(
          definition,
          rows,
          stored,
          ["statutory_schedule_id"],
          ["total_employee", "total_employer"],
          base,
        );
        return;
      }
      case "employee_ytd": {
        // The `employee_ytd` dataset is unnested to (employee, tax_year, scheme) grain, so `gross` and `net` REPEAT
        // across an employee's scheme rows: this arm compares DISTINCT (employee, year) pairs, never a sum, and
        // compares each scheme's two shares against the stored `by_scheme` bags read here as JSON — not through the
        // dataset's `jsonb_each`. Restricted to the run's `taxYear` parameter, else to `asOf`'s year.
        //
        // 9B (contracts round 18 B14): the dataset adds 8C's cut-over opening (`app.employee_ytd_opening`) at read
        // time, so the stored side is the projection PLUS the opening, each table read on its own here and added as
        // `Money` in this arm — never through the dataset's SQL. A year with neither row compares nothing and fails.
        const year =
          param(opts, "taxYear") ?? (opts.asOf === undefined ? null : opts.asOf.slice(0, 4));
        type YtdRow = {
          employee: string;
          year: number;
          gross: string;
          net: string;
          by_scheme: string;
        };
        const posted = await tx<YtdRow[]>`
          select e.employee_number as employee, y.tax_year::int as year,
                 y.gross::text as gross, y.net::text as net, y.by_scheme::text as by_scheme
            from app.employee_ytd y join app.employee e on e.id = y.employee_id
           where y.company_id = ${companyId}::uuid
             and (${year}::int is null or y.tax_year = ${year}::int)
           order by e.employee_number, y.tax_year`;
        const openings = await tx<YtdRow[]>`
          select e.employee_number as employee, o.tax_year::int as year,
                 o.gross::text as gross, o.net::text as net, o.by_scheme::text as by_scheme
            from app.employee_ytd_opening o join app.employee e on e.id = o.employee_id
           where o.company_id = ${companyId}::uuid
             and (${year}::int is null or o.tax_year = ${year}::int)
           order by e.employee_number, o.tax_year`;
        type Shares = Record<string, { employee?: string; employer?: string }>;
        const combined = new Map<
          string,
          {
            employee: string;
            year: number;
            gross: Money;
            net: Money;
            bag: Map<string, { employee: Money; employer: Money }>;
          }
        >();
        for (const r of [...posted, ...openings]) {
          const key = `${r.employee}|${r.year}`;
          const into = combined.get(key) ?? {
            employee: r.employee,
            year: r.year,
            gross: Money.zero(base),
            net: Money.zero(base),
            bag: new Map<string, { employee: Money; employer: Money }>(),
          };
          into.gross = into.gross.add(Money.of(r.gross, base));
          into.net = into.net.add(Money.of(r.net, base));
          for (const [scheme, share] of Object.entries(JSON.parse(r.by_scheme) as Shares)) {
            const prior = into.bag.get(scheme) ?? {
              employee: Money.zero(base),
              employer: Money.zero(base),
            };
            into.bag.set(scheme, {
              employee: prior.employee.add(Money.of(String(share.employee ?? "0.0000"), base)),
              employer: prior.employer.add(Money.of(String(share.employer ?? "0.0000"), base)),
            });
          }
          combined.set(key, into);
        }
        const stored = [...combined.values()].map((c) => ({
          employee: c.employee,
          year: c.year,
          gross: c.gross.toString(),
          net: c.net.toString(),
          by_scheme: JSON.stringify(
            Object.fromEntries(
              [...c.bag].map(([scheme, v]) => [
                scheme,
                { employee: v.employee.toString(), employer: v.employer.toString() },
              ]),
            ),
          ),
        }));
        if (stored.length === 0) {
          throw new Error(
            `${definition.code}: employee_ytd and its opening have no row in this window, so the tie-out would compare nothing`,
          );
        }
        const money = (v: unknown): string => Money.of(String(v ?? "0.0000"), base).toString();
        const pairs = new Map<string, { gross: string; net: string }>();
        const shares = new Map<string, { employee: string; employer: string }>();
        for (const r of rows) {
          const key = `${String(r["employee_number"])}|${String(r["tax_year"])}`;
          const pair = { gross: money(r["gross"]), net: money(r["net"]) };
          const prior = pairs.get(key);
          if (prior !== undefined && (prior.gross !== pair.gross || prior.net !== pair.net)) {
            throw new Error(
              `${definition.code}: employee_ytd rows for ${key} disagree — ${prior.gross}/${prior.net} vs ${pair.gross}/${pair.net}`,
            );
          }
          pairs.set(key, pair);
          if (r["scheme_code"] !== null && r["scheme_code"] !== undefined) {
            shares.set(`${key}|${String(r["scheme_code"])}`, {
              employee: money(r["scheme_employee"]),
              employer: money(r["scheme_employer"]),
            });
          }
        }
        const storedKeys = new Set<string>();
        const storedShares = new Set<string>();
        for (const s of stored) {
          const key = `${s.employee}|${s.year}`;
          storedKeys.add(key);
          const got = pairs.get(key);
          if (got === undefined) {
            throw new Error(`${definition.code}: employee_ytd has ${key} and the report does not`);
          }
          if (got.gross !== money(s.gross) || got.net !== money(s.net)) {
            throw new Error(
              `${definition.code}: employee_ytd says ${s.gross}/${s.net} for ${key}, the report says ${got.gross}/${got.net}`,
            );
          }
          const bag = JSON.parse(s.by_scheme) as Record<
            string,
            { employee?: string; employer?: string }
          >;
          for (const [scheme, want] of Object.entries(bag)) {
            storedShares.add(`${key}|${scheme}`);
            const have = shares.get(`${key}|${scheme}`);
            if (
              have === undefined ||
              have.employee !== money(want.employee) ||
              have.employer !== money(want.employer)
            ) {
              throw new Error(
                `${definition.code}: employee_ytd's ${scheme} shares for ${key} are ${money(want.employee)}/${money(want.employer)}, the report says ${have === undefined ? "nothing" : `${have.employee}/${have.employer}`}`,
              );
            }
          }
        }
        for (const key of pairs.keys()) {
          if (!storedKeys.has(key)) {
            throw new Error(
              `${definition.code}: the report has ${key}, which employee_ytd does not hold`,
            );
          }
        }
        // …and no scheme row the stored bags do not hold (an opening's scheme must not appear from nowhere).
        for (const key of shares.keys()) {
          if (!storedShares.has(key)) {
            throw new Error(
              `${definition.code}: the report has shares for ${key}, which employee_ytd does not hold`,
            );
          }
        }
        return;
      }
      default:
        throw new Error(
          `${definition.code}: projection "${String(definition.tieOut.projection)}" is not one this harness executes — 7C and 8D extend the switch for theirs (amendment A5)`,
        );
    }
  }

  // kind === "none": the row witness of amendment A5.
  if (opts.witness === undefined) {
    throw new Error(
      `${definition.code}: tieOut.kind is "none", so the group test must supply a row witness (amendment A5)`,
    );
  }
  const witness = opts.witness;
  const expected = await witness.rows(tx);
  const project = (r: Readonly<Record<string, unknown>>): string =>
    witness.key.map((k) => String(r[k] ?? "")).join("|");
  const got = new Set(rows.map(project));
  const want = new Set(expected.map(project));
  for (const key of want) {
    if (!got.has(key))
      throw new Error(`${definition.code}: the witness has row ${key} and the report does not`);
  }
  for (const key of got) {
    if (!want.has(key))
      throw new Error(`${definition.code}: the report has row ${key} and the witness does not`);
  }
}

// ── The shared fixture ──────────────────────────────────────────────────────────────────────────────

export interface InventoryFixture {
  itemId: string;
  itemCode: string;
  baseUnitId: string;
  unitCode: string;
  whHq: string;
  whBranch: string;
  whTransit: string;
  lotId: string;
  lotCode: string;
  /** Document-type code → id, configured from the shipped pack by `seedTypeFromPack`. */
  typeIds: Readonly<Record<string, string>>;
  /** `vendorId` carries the `GOODS_RECEIPT`, `customerId` the `DELIVERY_ORDER` and the sales chain. */
  vendorId: string;
  customerId: string;
  receiptId: string;
  deliveryId: string;
  transferId: string;
}
export interface SalesFixture {
  partyId: string;
  termId: string;
  invoiceId: string;
  creditNoteId: string;
}
/** What the master-data and adjustment registers need: one price list with one line, one promotion and one
 *  posted `STOCK_COUNT`. Behind an option because `assertFieldCoverage` refuses a zero-row tie-out. */
export interface CatalogueFixture {
  priceListId: string;
  promotionId: string;
  countDocumentId: string;
}
export interface ReportFixture {
  db: Db;
  s: Seed;
  reader: string;
  outsider: string;
  accounts: Readonly<Record<string, string>>;
  branchB: string;
  journals: { documentId: string; number: string }[];
  inventory: InventoryFixture | null;
  sales: SalesFixture | null;
  catalogue: CatalogueFixture | null;
}

/**
 * The §4.15 codes this catalogue names, each created with 1A's idempotent `seedAccount` (`seedTenantV2`
 * creates only `1000`, `4000` and `5920`), so nothing re-seeds a shipped row (hazard 33). `1310` is not
 * optional: 3D's `TRANSFER` policy debits it by code and a missing one kills the inventory chain at post.
 */
const CATALOGUE_ACCOUNTS: readonly {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}[] = [
  { code: "1100", nameEn: "Bank", type: "asset" },
  { code: "1200", nameEn: "Trade receivables", type: "asset" },
  { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "1310", nameEn: "Goods in transit", type: "asset" },
  { code: "2100", nameEn: "Trade payables", type: "liability" },
  { code: "2150", nameEn: "Goods received not invoiced", type: "liability" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5100", nameEn: "Inventory write-off - expiry loss", type: "expense" },
  { code: "5110", nameEn: "Stock-count variance", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

/** Every non-mutating code a 7B definition is gated by, plus `accounting.ledger.read`. */
const READ_CODES = [
  "accounting.report.read",
  "accounting.ledger.read",
  "admin.audit_log.read",
  "inventory.stock.read",
  "inventory.cost.read",
  "inventory.item.read",
];

/** `policy.approval.create` and `.post` off a shipped envelope. `PackApproval` carries no `create` member. */
function packCodes(code: string): string[] {
  const envelope = JSON.parse(
    readFileSync(join(PACK_DIR, "document-types", `${code}.json`), "utf8"),
  ) as { policy?: { approval?: { create?: unknown; post?: unknown } } };
  const a = envelope.policy?.approval;
  return [a?.create, a?.post].filter((c): c is string => typeof c === "string");
}

export async function reportFixture(
  db: Db,
  name: string,
  opts: { inventory?: boolean; sales?: boolean; catalogue?: boolean } = {},
): Promise<ReportFixture> {
  const s = await seedTenantV2(db, name);
  // 3B's helper opens EVERY 2026 period, including the two `seedTenantV2` creates closed and locked, so
  // `s.closedPeriod` (2026-02) and `s.lockedPeriod` (2026-03) are open here and used only as period ids.
  await ensureOpenPeriods(db, s, 2026);
  const accounts: Record<string, string> = { "1000": s.cash, "4000": s.sales };
  for (const a of CATALOGUE_ACCOUNTS) accounts[a.code] = await seedAccount(db, s, a);
  const branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch two" });
  const outsider = await secondPrincipal(db, s, "phase7b-outsider");
  await grantCodes(db, s, { codes: READ_CODES, principalId: s.human, roleCode: "phase7b_reader" });
  await grantCodes(db, s, { codes: [], principalId: outsider, roleCode: "phase7b_nothing" });

  // Three posted JOURNALs in 2026-01 and one in 2026-02 — the period comparison needs two populated periods.
  const posted = [
    await postJournal(
      db,
      s,
      [
        { account: s.cash, debit: "1200.0000" },
        { account: s.sales, credit: "1200.0000" },
      ],
      { effectiveDate: "2026-01-05" },
    ),
    await postJournal(
      db,
      s,
      [
        { account: accounts["5900"]!, debit: "300.0000" },
        { account: s.cash, credit: "300.0000" },
      ],
      { effectiveDate: "2026-01-12" },
    ),
    await postJournal(
      db,
      s,
      [
        { account: s.sales, debit: "200.0000" },
        { account: s.cash, credit: "200.0000" },
      ],
      { effectiveDate: "2026-01-20" },
    ),
    await postJournal(
      db,
      s,
      [
        { account: s.cash, debit: "450.0000" },
        { account: s.sales, credit: "450.0000" },
      ],
      { effectiveDate: "2026-02-09", periodId: s.closedPeriod },
    ),
  ];
  const journals = posted.map((p) => ({ documentId: p.documentId, number: p.number.toString() }));

  const inventory = opts.inventory === true ? await inventoryChain(db, s, branchB) : null;
  const sales = opts.sales === true ? await salesChain(db, s, inventory) : null;
  const catalogue = opts.catalogue === true ? await catalogueChain(db, s, inventory) : null;

  return {
    db,
    s,
    reader: s.human,
    outsider,
    accounts,
    branchB,
    journals,
    inventory,
    sales,
    catalogue,
  };
}

/** Memoised per (label, options) for the process — the regression files that add a tenant to 0B's
 *  `sharedDb()` container. A group test that owns its container calls `reportFixture` directly. */
const FIXTURES = new Map<string, Promise<ReportFixture>>();
export function cachedReportFixture(
  db: Db,
  label: string,
  opts: { inventory?: boolean; sales?: boolean; catalogue?: boolean } = {},
): Promise<ReportFixture> {
  const key = `${label}|${JSON.stringify(opts)}`;
  const existing = FIXTURES.get(key);
  if (existing !== undefined) return existing;
  const built = reportFixture(db, label, opts);
  FIXTURES.set(key, built);
  return built;
}

/**
 * The fixture's arithmetic, which every inventory tie-out depends on: 40 received at 5.0000 into `WH-HQ`
 * (`1300` debit 200.0000, one layer of 40); 6 delivered (`1250` debit / `1300` credit 30.0000); 4 dispatched
 * towards `WH-BR2`, which 3D's `draftTransfer` routes through branch two's in-transit warehouse `WH-TR`
 * (`1310` debit / `1300` credit 20.0000, a second layer of 4 in `WH-TR`). The transfer is deliberately not
 * received. So `stock_on_hand` is `WH-HQ` 30 and `WH-TR` 4; `valuationAsOf` `WH-HQ` 150.0000 and `WH-TR`
 * 20.0000; the ledger `1300` 150.0000 and `1310` 20.0000.
 */
async function inventoryChain(db: Db, s: Seed, branchB: string): Promise<InventoryFixture> {
  const typeIds: Record<string, string> = {};
  for (const code of [
    "GOODS_RECEIPT",
    "DELIVERY_ORDER",
    "TRANSFER",
    "TRANSFER_RECEIPT",
    "STOCK_COUNT",
  ]) {
    typeIds[code] = await seedTypeFromPack(db, s, code);
  }
  // R2 reads `approval.post` inside the posting transaction and `seedTenantV2` grants `s.human` nothing, so
  // the codes are read off the three envelopes and granted once. `DELIVERY_ORDER` and `TRANSFER` both post
  // under `inventory.transfer.post` (§4.14), so the set collapses the duplicate.
  const codes = [
    ...new Set(["GOODS_RECEIPT", "DELIVERY_ORDER", "TRANSFER"].flatMap((code) => packCodes(code))),
  ];
  await grantCodes(db, s, { codes, principalId: s.human, roleCode: "phase7b_poster" });

  const vendorId = await seedParty(db, s, {
    kind: "vendor",
    code: "VEND-1",
    nameEn: "Alpha supplier",
  });
  const customerId = await seedParty(db, s, { kind: "customer", code: "CUST-1" });

  const unitCode = "EA";
  const unit = await seedUnit(db, s, { code: unitCode, nameEn: "Each" });
  const { itemId, baseUnitId } = await seedItem(db, s, {
    code: "ITEM-1",
    kind: "product",
    trackLots: true,
    baseUnitId: unit,
  });
  const whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
  const whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
  const whTransit = await seedWarehouse(db, s, {
    code: "WH-TR",
    kind: "in_transit",
    branchId: branchB,
  });
  const lotCode = "LOT-A";
  const lotId = await seedLot(db, s, { itemId, code: lotCode, expiresOn: "2026-06-30" });

  // `draftTypedDocument` defaults `amount` to "0", so every line writes it: `GOODS_RECEIPT` credits `2150`
  // with `line.amount`, and a zero would leave the receipt unbalanced.
  const receipt = await postFromPack(db, s, {
    code: "GOODS_RECEIPT",
    effectiveDate: "2026-01-06",
    partyId: vendorId,
    warehouseId: whHq,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId: whHq,
        lotId,
        unitId: baseUnitId,
        quantity: "40.000000",
        unitPrice: "5.0000",
        amount: "200.0000",
      },
    ],
  });
  const delivery = await postFromPack(db, s, {
    code: "DELIVERY_ORDER",
    effectiveDate: "2026-01-14",
    partyId: customerId,
    warehouseId: whHq,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId: whHq,
        lotId,
        unitId: baseUnitId,
        quantity: "6.000000",
        unitPrice: "11.0000",
        amount: "66.0000",
      },
    ],
  });
  // The dispatch leg through 3D's own service: the caller names the FINAL destination (`WH-BR2`) and
  // `draftTransfer` resolves the corridor (`WH-TR`) into `to_warehouse_id` (contracts 7B A18).
  const ctx = await ctxFor(db, s, s.human);
  const transferId = await withContext(db.rw, ctx, async (tx) => {
    const drafted = await draftTransfer(tx, ctx, {
      fromWarehouseId: whHq,
      toWarehouseId: whBranch,
      effectiveDate: "2026-01-16",
      series: "TRF",
      documentTypeId: typeIds["TRANSFER"]!,
      lines: [{ itemId, unitId: baseUnitId, lotId, quantity: "4.000000" }],
    });
    if (drafted.inTransitWarehouseId !== whTransit) {
      throw new Error(
        "reportFixture: draftTransfer did not route through WH-TR — 3D's corridor rule changed",
      );
    }
    await issueDocument(tx, ctx, { documentId: drafted.documentId });
    await postDocument(tx, ctx, { documentId: drafted.documentId });
    return drafted.documentId;
  });

  return {
    itemId,
    itemCode: "ITEM-1",
    baseUnitId,
    unitCode,
    whHq,
    whBranch,
    whTransit,
    lotId,
    lotCode,
    typeIds,
    vendorId,
    customerId,
    receiptId: receipt.documentId,
    deliveryId: delivery.documentId,
    transferId,
  };
}

/**
 * The tree's two-document sales path (4A, ADR 0044): the delivery's goods are invoiced by 4A's
 * `convertToInvoice`, which copies the delivery's cost so the invoice relieves `1250`, and one unit is
 * credited back by 4A's `creditNoteFrom` (a `SALES_CREDIT_NOTE` requires `reverses_document`). 6 invoiced at
 * 11.0000 = 66.0000 revenue, 1 credited = 11.0000, so `item_profitability` reads revenue 55.0000 against a
 * delivered cost of 30.0000 — margin 25.0000 for the item in 2026-01.
 */
async function salesChain(
  db: Db,
  s: Seed,
  inventory: InventoryFixture | null,
): Promise<SalesFixture> {
  if (inventory === null) {
    throw new Error(
      "reportFixture: { sales: true } needs { inventory: true } — the invoice converts the delivery",
    );
  }
  const invoiceTypeId = await seedTypeFromPack(db, s, "SALES_INVOICE");
  const creditTypeId = await seedTypeFromPack(db, s, "SALES_CREDIT_NOTE");
  const codes = [...new Set(["SALES_INVOICE", "SALES_CREDIT_NOTE"].flatMap((c) => packCodes(c)))];
  await grantCodes(db, s, { codes, principalId: s.human, roleCode: "phase7b_seller" });
  const termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  const partyId = inventory.customerId;
  const ctx = await ctxFor(db, s, s.human);
  await withContext(
    db.rw,
    ctx,
    (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`,
  );

  const invoiceId = await withContext(db.rw, ctx, async (tx) => {
    const r = await convertToInvoice(tx, ctx, {
      companyId: s.company,
      sourceDocumentId: inventory.deliveryId,
      targetDocumentTypeId: invoiceTypeId,
      targetSeries: "INV",
      effectiveDate: "2026-01-15",
      lines: [],
    });
    await issueDocument(tx, ctx, { documentId: r.documentId });
    await postDocument(tx, ctx, { documentId: r.documentId });
    return r.documentId;
  });
  const creditNoteId = await withContext(db.rw, ctx, async (tx) => {
    const [line] = await tx<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoiceId} order by line_no limit 1`;
    const cn = await creditNoteFrom(tx, ctx, {
      companyId: s.company,
      settledDocumentId: invoiceId,
      targetDocumentTypeId: creditTypeId,
      targetSeries: "CN",
      effectiveDate: "2026-01-22",
      reason: "one unit returned",
      lines: [{ settledLineId: line!.id, quantity: "1.000000" }],
    });
    await issueDocument(tx, ctx, { documentId: cn.documentId });
    await postDocument(tx, ctx, { documentId: cn.documentId });
    return cn.documentId;
  });
  return { partyId, termId, invoiceId, creditNoteId };
}

/**
 * One price list with one line, one promotion, and one posted `STOCK_COUNT`. The count goes through 3D's own
 * pair — `snapshotCountSheet` writes `expected_quantity`, `recordCounts` is the sole writer of the counted
 * quantity and the variance — then submit / approve / issue / post under R1's two principals, with the hop
 * read off the shipped envelope. `WH-HQ` holds 30, so counting 29 posts a variance of −1 at 5.0000:
 * `1300` credit 5.0000 / `5110` debit 5.0000.
 */
async function catalogueChain(
  db: Db,
  s: Seed,
  inventory: InventoryFixture | null,
): Promise<CatalogueFixture> {
  if (inventory === null) {
    throw new Error(
      "reportFixture: { catalogue: true } needs { inventory: true } — the price line and the count name the item",
    );
  }
  const priceListId = await seedPriceList(db, s, {
    code: "RETAIL",
    currency: "MYR",
    lines: [
      {
        itemId: inventory.itemId,
        unitId: inventory.baseUnitId,
        minQuantity: "0",
        unitPrice: "11.0000",
      },
    ],
  });
  const promotionId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const row = await createPromotion(tx, {
      companyId: s.company,
      code: "JAN10",
      nameEn: "January 10%",
      nameAr: "خصم يناير",
      kind: "percent_off",
      definition: { percent: "10" },
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2026-01-31T23:59:59Z",
      branchId: s.hq,
    });
    return row.id;
  });

  const approval = packApproval("STOCK_COUNT");
  if (!approval.required || approval.approve === null) {
    throw new Error(
      "reportFixture: STOCK_COUNT.json no longer declares approval.required with an approve code — 3D's envelope changed (§4.14)",
    );
  }
  const counter = await secondPrincipal(db, s, "phase7b-counter");
  const checker = await secondPrincipal(db, s, "phase7b-checker");
  const createCode = packCodes("STOCK_COUNT").filter((c) => c !== approval.post);
  await grantCodes(db, s, { codes: createCode, principalId: counter, roleCode: "phase7b_counter" });
  await grantCodes(db, s, {
    codes: [...new Set([approval.approve, approval.post])],
    principalId: checker,
    roleCode: "phase7b_checker",
  });
  const counterCtx = await ctxFor(db, s, counter);
  const checkerCtx = await ctxFor(db, s, checker);

  const sheet = await withContext(db.rw, counterCtx, (tx) =>
    snapshotCountSheet(tx, counterCtx, {
      documentTypeId: inventory.typeIds["STOCK_COUNT"]!,
      series: "SC",
      effectiveDate: "2026-01-24",
      warehouseId: inventory.whHq,
      itemIds: [inventory.itemId],
    }),
  );
  if (sheet.lines.length !== 1) {
    throw new Error(
      `reportFixture: the count sheet has ${sheet.lines.length} lines, expected 1 — the inventory chain changed`,
    );
  }
  await withContext(db.rw, counterCtx, async (tx) => {
    await recordCounts(tx, counterCtx, {
      documentId: sheet.documentId,
      counts: [{ documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "29.000000" }],
    });
    await transitionDocument(tx, counterCtx, { documentId: sheet.documentId, to: "submitted" });
  });
  await withContext(db.rw, checkerCtx, async (tx) => {
    await transitionDocument(tx, checkerCtx, { documentId: sheet.documentId, to: "approved" });
    await issueDocument(tx, checkerCtx, { documentId: sheet.documentId });
    await postDocument(tx, checkerCtx, { documentId: sheet.documentId });
  });
  return { priceListId, promotionId, countDocumentId: sheet.documentId };
}
