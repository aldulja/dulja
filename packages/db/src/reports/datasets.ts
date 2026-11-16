import type { Sql } from "postgres";
import { ReportDefinitionError } from "@dulja/domain";
import { ReportError } from "./errors";
import type { Dataset } from "./query";
import type { SqlFragment } from "./sql-fragment";
import {
  accountBalanceDataset,
  accountDataset,
  auditLogDataset,
  documentDataset,
  documentEventDataset,
  documentLineDataset,
  ledgerEntryDataset,
  taxTransactionDataset,
} from "./datasets/accounting";
import {
  allocationDataset,
  bankMatchDataset,
  bankStatementLineDataset,
  partyAgeingDataset,
  partyDataset,
  paymentTermDataset,
} from "./datasets/ar-ap";
import {
  costConsumptionDataset,
  costLayerDataset,
  inventoryMovementDataset,
  itemDataset,
  itemProfitabilityDataset,
  lotDataset,
  priceListLineDataset,
  promotionDataset,
  stockOnHandDataset,
  stockValuationDataset,
  warehouseDataset,
} from "./datasets/inventory";
import { needsAttentionDataset, shiftDataset, tillEventDataset } from "./datasets/pos";
import {
  attendanceEventDataset,
  employeeDataset,
  employeeYtdDataset,
  leaveRecordDataset,
  payrollLineDataset,
  statutoryScheduleDataset,
} from "./datasets/hr";

/**
 * THE closed registry of contracts §4.16.2. Every member is a named `withTenant` read query; a definition
 * names an id and never contributes SQL (test 27). Membership is pre-declared in §4.16.2 in the form of
 * §3.5.3, which is what stops three slices editing this file in parallel:
 *
 *   7A (this file, at creation) — every dataset whose source tables all exist at migration <= 0058, which is
 *                                 every dataset 7B needs. **7B adds none and never edits this file.**
 *   7C — the three Phase 6 members below (`datasets/pos.ts`; contracts round 15, amendment A1)
 *   8D — employee, attendance_event, payroll_line, employee_ytd, statutory_schedule (`datasets/hr.ts`, 8D Task 2;
 *        contracts round 19), and `leave_record` (8D Task 8 — OD-13 answered build, round 19 A14)
 *
 * `pdc` is NOT a member: §4.16.2 drops it with 4B's `app.pdc` table when OD-09 = no, and migration 0051 is
 * reserved and unused (OD-09 not built), so the 7A set is twenty-five, not twenty-six. The id and the
 * `accounting.pdc_register` report that would read it are dropped together, so the union never names a
 * table that does not exist.
 *
 * A dataset for a table §4.16.2 does not name is added to that section FIRST.
 */
export type DatasetId =
  // 7A — every source table exists at migration <= 0058
  | "ledger_entry"
  | "account_balance"
  | "account"
  | "document"
  | "document_line"
  | "document_event"
  | "audit_log"
  | "party"
  | "party_ageing"
  | "allocation"
  | "payment_term"
  | "bank_statement_line"
  | "bank_match"
  | "item"
  | "lot"
  | "warehouse"
  | "price_list_line"
  | "promotion"
  | "inventory_movement"
  | "stock_on_hand"
  | "cost_layer"
  | "cost_consumption"
  | "stock_valuation"
  | "item_profitability"
  | "tax_transaction"
  // 7C — Phase 6 tables (6A's 0060, 6D's 0070); appended so 7A's order is untouched
  | "shift"
  | "till_event"
  | "needs_attention"
  // 8D — Phase 8, plus the two 6C tables whose FIRST report is 8D's (§4.16.2); appended so 7A's and 7C's order is
  // untouched. 8D Task 8 appends `leave_record` (⚠️ OD-13 answered build, round 19 A14) — the thirty-fourth.
  | "employee"
  | "attendance_event"
  | "payroll_line"
  | "employee_ytd"
  | "statutory_schedule"
  | "leave_record";

export const DATASETS: Readonly<Record<DatasetId, Dataset>> = {
  ledger_entry: ledgerEntryDataset,
  account_balance: accountBalanceDataset,
  account: accountDataset,
  document: documentDataset,
  document_line: documentLineDataset,
  document_event: documentEventDataset,
  audit_log: auditLogDataset,
  party: partyDataset,
  party_ageing: partyAgeingDataset,
  allocation: allocationDataset,
  payment_term: paymentTermDataset,
  bank_statement_line: bankStatementLineDataset,
  bank_match: bankMatchDataset,
  item: itemDataset,
  lot: lotDataset,
  warehouse: warehouseDataset,
  price_list_line: priceListLineDataset,
  promotion: promotionDataset,
  inventory_movement: inventoryMovementDataset,
  stock_on_hand: stockOnHandDataset,
  cost_layer: costLayerDataset,
  cost_consumption: costConsumptionDataset,
  stock_valuation: stockValuationDataset,
  item_profitability: itemProfitabilityDataset,
  tax_transaction: taxTransactionDataset,
  shift: shiftDataset,
  till_event: tillEventDataset,
  needs_attention: needsAttentionDataset,
  employee: employeeDataset,
  attendance_event: attendanceEventDataset,
  payroll_line: payrollLineDataset,
  employee_ytd: employeeYtdDataset,
  statutory_schedule: statutoryScheduleDataset,
  leave_record: leaveRecordDataset,
};

/**
 * The read codes that may gate each dataset — a CLOSED, minimal set per member (Phase 7 review, finding 1; ADR
 * 0065's amendment). A run executes as the tenant's SYSTEM principal, so a definition's `permission` is the only
 * data gate a run has; without this table a clone could re-gate any dataset on any catalogued code. Each set is
 * the codes the 32 shipped definitions use for that dataset (contracts §4.16.1), plus the one obvious stronger
 * code where the brief of its source names one (`accounting.ledger.read` beside `accounting.report.read` on the
 * ledger reads); a dataset no shipped definition reads takes the read code of the module its table belongs to.
 * Two datasets admit two codes because the shipped catalogue does: `document` (7B's count register under
 * `inventory.stock.read`) and `item_profitability` (3D's `inventory.sales_by_item` under the same code) — and
 * `assertCodeVersionRules` (definition-store) stops a writer moving a code from one to the other unless they hold
 * both. Permission codes are plain strings here: `packages/db` may not import `@dulja/contracts` (§3.1);
 * `definition-gates.test.ts` proves every code is in `app.permission`.
 */
export const DATASET_READ_CODES: Readonly<Record<DatasetId, readonly string[]>> = {
  ledger_entry: ["accounting.report.read", "accounting.ledger.read"],
  account_balance: ["accounting.report.read", "accounting.ledger.read"],
  account: ["accounting.report.read", "accounting.ledger.read"],
  document: ["accounting.report.read", "inventory.stock.read"],
  document_line: ["accounting.report.read"],
  // The trail of every table, the gated ones included: the auditor's code and nothing weaker.
  document_event: ["admin.audit_log.read"],
  audit_log: ["admin.audit_log.read"],
  party: ["accounting.report.read"],
  party_ageing: ["accounting.report.read"],
  allocation: ["accounting.report.read"],
  payment_term: ["accounting.report.read"],
  bank_statement_line: ["accounting.bank.reconcile"],
  bank_match: ["accounting.bank.reconcile"],
  item: ["inventory.item.read"],
  lot: ["inventory.stock.read"],
  warehouse: ["inventory.stock.read"],
  price_list_line: ["inventory.item.read"],
  promotion: ["inventory.item.read"],
  inventory_movement: ["inventory.stock.read"],
  stock_on_hand: ["inventory.stock.read"],
  // Cost-bearing: spec:2159/2160's "Costs" column.
  cost_layer: ["inventory.cost.read"],
  cost_consumption: ["inventory.cost.read"],
  stock_valuation: ["inventory.cost.read"],
  item_profitability: ["inventory.cost.read", "inventory.stock.read"],
  tax_transaction: ["accounting.tax.manage"],
  shift: ["pos.report.read"],
  till_event: ["pos.report.read"],
  needs_attention: ["pos.needs_attention.resolve"],
  // 8D (contracts round 19, 8D A13 item 2) — §4.16.1's permission for every 8D code over each source. The
  // establishment reads are the directory's own code; the three payroll reads are `hr.payroll.read`, which Part VI
  // test 32 names as the gate of posted payroll amounts. No HR column `requires` a stronger code: no HR dataset
  // serves a sensitive or compensation field at all (test 32).
  employee: ["hr.employee.read"],
  attendance_event: ["hr.employee.read"],
  payroll_line: ["hr.payroll.read"],
  employee_ytd: ["hr.payroll.read"],
  statutory_schedule: ["hr.payroll.read"],
  // 8D Task 8 (⚠️ OD-13): the register's own read code — `GET …/leave-records` is gated on it too. A leave record is
  // an establishment fact (who is away, when), not a pay figure, and the dataset joins no gated table (test 32).
  leave_record: ["hr.employee.read"],
};

/**
 * The rows a dataset serves under a gate NARROWER than its own full read code (Phase 7 second review, finding
 * 4). `DATASET_READ_CODES` admits `inventory.stock.read` on `document` because 7B's count register reads stock
 * counts under it — but a code gates a dataset, not a document type, and a clone of that register could override
 * its `countTypes` options to `SALES_INVOICE` or `PAYMENT` and print the company's financial documents to every
 * stock reader. So a module code carries a ROW BOUND: under `inventory.stock.read`, `document` serves only the
 * inventory module's document types (`document_type.module = 'inventory'` — STOCK_COUNT, TRANSFER, GOODS_RECEIPT
 * and the rest of 3A–3D's types); under `accounting.report.read` it keeps every type.
 *
 * Each bound is literal SQL over the dataset's OWN aliases (`dt` is `document`'s `document_type` join), authored
 * here, never taken from a definition (test 27). A (dataset, code) pair with no entry has no bound: the code is
 * the dataset's own full read code. `document_line` and `document_event` admit no module code, so carry none.
 */
export const DATASET_ROW_BOUNDS: Readonly<
  Partial<Record<DatasetId, Readonly<Record<string, (tx: Sql) => SqlFragment>>>>
> = {
  document: { "inventory.stock.read": (tx) => tx`dt.module = 'inventory'` },
};

/** The row bound a run of `source` gated on `permission` carries, or `undefined` for none. */
export function datasetRowBound(
  source: string,
  permission: string,
): ((tx: Sql) => SqlFragment) | undefined {
  if (!isDatasetId(source)) return undefined;
  const bounds = DATASET_ROW_BOUNDS[source];
  return bounds === undefined || !Object.prototype.hasOwnProperty.call(bounds, permission)
    ? undefined
    : bounds[permission];
}

/**
 * Refuses a definition whose `permission` is not one its dataset admits (`DATASET_READ_CODES`), or that names a
 * column declaring a stronger requirement (`DatasetColumn.requires`, second review, finding 5) under any other
 * code — in its columns, groups, totals, sort or filters. Called by `assertDefinitionFields` — THE check the
 * definition store and the seed loader both run — so a definition written through the API and one shipped in
 * a pack are held to one rule. An unknown dataset is `datasetFor`'s refusal, raised first.
 */
export function assertDatasetGate(definition: {
  code: string;
  permission: string;
  dataset: { source: string; filters?: readonly { field: string }[] };
  columns?: readonly { field: string }[];
  groups?: readonly { field: string }[];
  totals?: readonly { field: string }[];
  sort?: readonly { field: string }[];
}): void {
  const dataset = datasetFor(definition.dataset.source); // throws ERR_REPORT_DATASET_UNKNOWN
  const admitted = DATASET_READ_CODES[definition.dataset.source as DatasetId];
  if (!admitted.includes(definition.permission)) {
    const message = `dataset '${definition.dataset.source}' may be gated only on ${admitted.join(", ")}; '${definition.permission}' would open its rows to another read code`;
    throw new ReportDefinitionError(`report definition is invalid: /permission ${message}`, [
      { path: "/permission", message },
    ]);
  }
  const referenced = new Set<string>([
    ...(definition.columns ?? []).map((c) => c.field),
    ...(definition.groups ?? []).map((g) => g.field),
    ...(definition.totals ?? []).map((t) => t.field),
    ...(definition.sort ?? []).map((k) => k.field),
    ...(definition.dataset.filters ?? []).map((f) => f.field),
  ]);
  const stronger = dataset.columns.filter(
    (c) =>
      c.requires !== undefined && c.requires !== definition.permission && referenced.has(c.field),
  );
  if (stronger.length > 0) {
    const message = stronger
      .map(
        (c) =>
          `column '${c.field}' of dataset '${definition.dataset.source}' needs '${c.requires!}', not '${definition.permission}'`,
      )
      .join("; ");
    throw new ReportDefinitionError(`report definition is invalid: /permission ${message}`, [
      { path: "/permission", message },
    ]);
  }
}

/** `Object.keys(DATASETS)` in registry order. */
export const DATASET_IDS: readonly DatasetId[] = Object.keys(DATASETS) as DatasetId[];

export function isDatasetId(id: string): id is DatasetId {
  return Object.prototype.hasOwnProperty.call(DATASETS, id);
}

export function datasetFor(id: string): Dataset {
  if (!isDatasetId(id)) {
    throw new ReportError(
      "ERR_REPORT_DATASET_UNKNOWN",
      `dataset '${id}' is not a member of the closed registry; the members are ${DATASET_IDS.join(", ")}`,
    );
  }
  return DATASETS[id];
}
