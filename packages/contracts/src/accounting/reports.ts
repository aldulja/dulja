import { z } from "zod";
import {
  CurrencySchema,
  DateSchema,
  ListEnvelope,
  ListQuery,
  MoneySchema,
  RateSchema,
  UuidSchema,
} from "../common";
/**
 * `AccountTypeSchema` is **1A's**, declared in `packages/contracts/src/accounting/account.ts`
 * (`z.enum(["asset","liability","equity","income","expense"])`) and already re-exported from the barrel
 * by 1A's `export * from "./accounting/account";`. It is imported here and **not** re-declared and
 * **not** re-exported: two `export *` statements carrying one name is TS2308, which would stop
 * `packages/contracts` type-checking. §4.2.8's module table lists ten names for this file and
 * `AccountTypeSchema` is deliberately not among them.
 */
import { AccountTypeSchema } from "./account";
import { PartyKindSchema } from "./party";

/**
 * The report codes whose route EXISTS, in the closed register of contracts §4.16.1 (§4.16.3). 1B's two,
 * plus 3D's three, plus 4B's one; every later report-shipping slice appends its own here, in the PR that
 * mounts the route. It is a wire-validation convenience, never a second register.
 *
 * §4.16.1 is the register; this enum is the TYPED surface (1B's two `GET`s, 7A's definition and saved-view
 * routes, every contract-tier consumer) and never a second register. Membership is not what makes a code
 * runnable: 7A's `POST …/reports/{code}/runs` validates `{code}` against the bare `REPORT_CODE_PATTERN` and
 * answers 404 "No such report" when no definition resolves for a caller who has already cleared
 * `requireReportExport` (7B amendment A4). Slices append their own codes here and no slice asserts a total
 * member count.
 */
export const ReportCodeSchema = z.enum([
  "pos.z_report",
  "pos.sales_by_cashier",
  "accounting.trial_balance",
  "accounting.ledger",
  "inventory.stock_on_hand",
  "inventory.valuation",
  "inventory.sales_by_item",
  "accounting.ageing", // 4B
  // ── 7B — the accounting catalogue (§4.16.1; amendment A4: appended, never re-sorted) ──
  "accounting.general_ledger",
  "accounting.journal_register",
  "accounting.account_statement",
  "accounting.period_comparison",
  "accounting.profit_and_loss",
  "accounting.balance_sheet",
  "accounting.document_register",
  "accounting.audit_log",
  "accounting.document_event_log",
  // ── 7B — the inventory catalogue ──
  "inventory.stock_ageing",
  "inventory.movement_register",
  "inventory.expiry_list",
  "inventory.price_list",
  "inventory.promotion_register",
  "inventory.transfer_register",
  "inventory.count_register",
  "inventory.profit_by_item",
  // ── 7C — AR/AP, POS and cross-module (§4.16.1; round 15, A15: appended, never re-sorted). Its three
  // re-expressed codes — accounting.ageing, pos.z_report, pos.sales_by_cashier — are already members. ──
  "accounting.party_statement",
  "accounting.allocation_register",
  "accounting.unreconciled_items",
  "accounting.branch_profit_and_loss",
  "accounting.tax_return_view",
  "pos.sales_by_branch",
  "pos.needs_attention",
  // ── 8D — the HR catalogue (§4.16.1, in register order; appended, never re-sorted) ──
  "hr.employee_list",
  "hr.payroll_register",
  "hr.statutory_summary",
  "hr.payable_reconciliation",
  "hr.contract_expiry",
  "hr.attendance",
  "hr.payslip",
  "hr.annual_statement",
]);
export type ReportCode = z.infer<typeof ReportCodeSchema>;

export const TrialBalanceRowSchema = z.object({
  accountId: UuidSchema,
  accountCode: z.string(),
  accountNameEn: z.string(),
  accountNameAr: z.string().nullable(),
  accountType: AccountTypeSchema,
  currency: CurrencySchema,
  debit: MoneySchema,
  credit: MoneySchema,
  baseDebit: MoneySchema,
  baseCredit: MoneySchema,
});
export type TrialBalanceRowDto = z.infer<typeof TrialBalanceRowSchema>;

/**
 * The only filterable/sortable fields; anything else is ERR_VALIDATION_FAILED (§4.2.8).
 * `.strict()` is what makes that true rather than aspirational: `ListQuery` is a plain `z.object`, and a
 * plain Zod object STRIPS unknown keys instead of rejecting them, so without this a
 * `filter[account_code][like]=…` would be dropped silently and the request would answer 200. Both query
 * schemas in this file carry it.
 */
export const TrialBalanceQuery = ListQuery.extend({
  fiscalPeriodId: UuidSchema,
  currency: CurrencySchema.optional(),
}).strict();

export const TrialBalanceList = ListEnvelope(TrialBalanceRowSchema);

export const LedgerRowSchema = z.object({
  entryId: UuidSchema,
  effectiveDate: DateSchema,
  documentId: UuidSchema,
  documentTypeCode: z.string(),
  series: z.string(),
  number: z.string().nullable(),
  lineNo: z.number().int().positive(),
  postingSeq: z.string(),
  currency: CurrencySchema,
  exchangeRate: RateSchema,
  debit: MoneySchema,
  credit: MoneySchema,
  baseDebit: MoneySchema,
  baseCredit: MoneySchema,
  runningBaseBalance: MoneySchema,
});
export type LedgerRowDto = z.infer<typeof LedgerRowSchema>;

export const LedgerQuery = ListQuery.extend({
  accountId: UuidSchema,
  fromDate: DateSchema,
  toDate: DateSchema,
}).strict();

/**
 * `{ items, next_cursor }` per §4.2.8, plus `opening_base_balance`: a ledger that does not state the
 * balance brought forward is not a ledger, and deriving it client-side would be money arithmetic in a
 * client (spec:2041). Purely additive — a client reading only items/next_cursor is unaffected.
 *
 * **It is the balance brought forward into `fromDate`, and it is page-invariant**: every page of the same
 * `(accountId, fromDate, toDate)` carries the same value, so a view may render it once as a header. It is
 * NOT "the balance this page opens with" — that number is the previous page's last `runningBaseBalance`,
 * which travels inside the cursor and never appears on the wire as a field.
 */
export const LedgerList = ListEnvelope(LedgerRowSchema).extend({
  opening_base_balance: MoneySchema,
});

// ── 4B — accounting.ageing (§4.16.1, §4.8.2) ──────────────────────────────────────────────────────────────

/**
 * §4.2.8's second registered bare form (4B amendment 12, round 8), FILE-LOCAL and never a `common.ts`
 * export: an ageing row carries its `currency` once and then six figures in it, so `MoneySchema` on each would
 * repeat the code six times per row. The sign is admitted because an unallocated receipt on account is a
 * NEGATIVE open figure (money held, not owed).
 */
const AgeingAmount = z.string().regex(/^-?\d+\.\d{4}$/);

/** One row of `agedBalance` (packages/db/src/reports/ageing.ts): one party in one currency. */
export const AgeingRowSchema = z.object({
  partyId: UuidSchema,
  partyCode: z.string(),
  partyNameEn: z.string(),
  partyNameAr: z.string().nullable(),
  partyKind: PartyKindSchema,
  /** The open documents' currency; the five buckets and `total` are in it. */
  currency: CurrencySchema,
  current: AgeingAmount,
  d1_30: AgeingAmount,
  d31_60: AgeingAmount,
  d61_90: AgeingAmount,
  over_90: AgeingAmount,
  total: AgeingAmount,
  /** In the COMPANY's base currency, at each open document's own rate — never a conversion of `total`. */
  totalBase: AgeingAmount,
});
export type AgeingRowDto = z.infer<typeof AgeingRowSchema>;
export const AgeingList = ListEnvelope(AgeingRowSchema);

/**
 * §4.2.8 Layer 1 closes the flat-parameter set at `ListQuery`'s four plus the grandfathered schemas, so
 * `asOf` is NOT a flat parameter: it is `filter[as_of][eq]=YYYY-MM-DD`, and it is REQUIRED. Layer 2 makes
 * `parseFilters` the mechanism for this route (the case §4.2.8 names 4B's ageing route as needing), so the
 * filter keys are parsed from the raw query rather than declared as literal keys — a route uses one mechanism
 * or the other, never both. The handler admits exactly these fields, each with its own operators and value
 * grammar, and answers ERR_VALIDATION_FAILED for anything else:
 *
 *   filter[as_of][eq]          a calendar date — required
 *   filter[party_id][eq]       a uuid
 *   filter[party_kind][eq]     a party kind
 *   filter[currency][eq]       a currency code
 *   filter[bucket][eq|in]      one bucket, or a comma-separated list of buckets
 */
export const AGEING_FILTER_FIELDS = [
  "as_of",
  "party_id",
  "party_kind",
  "currency",
  "bucket",
] as const;
export const AgeingQuery = ListQuery;
