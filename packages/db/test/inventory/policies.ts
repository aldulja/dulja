import type { TenantContext } from "../../src/with-tenant";
import type { Seed } from "../fixtures";

/**
 * 3D's shared test-policy module (Task 4 creates it; Tasks 5, 7, 8 and 9 append the other four constants
 * and edit nothing already here). One file for all of this slice's policies plus the 3C one its tests need,
 * so Tasks 4-11 never re-type a policy and cannot drift from the seed files. Each constant is the `policy`
 * member of §4.3.7's envelope, exactly as the seed file carries it; Task 9 Step 6 is the case that asserts
 * the two agree after `JSON.parse`.
 *
 * The constants are `as const` objects rather than a read of `packages/db/seed/my/document-types/`, because
 * Task 4 executes BEFORE Task 8 and `TRANSFER_RECEIPT.json` does not exist on disk until then.
 */

/** The `TenantContext` every posting call in this directory needs. `requestId` is per-call so an
 *  idempotency replay in one test cannot be served from another's record (§4.2.9). */
export function ctxOf(
  s: Seed,
  requestId = `test-${Math.random().toString(36).slice(2)}`,
): TenantContext {
  return { tenantId: s.tenant, actorId: s.human, requestId };
}

/**
 * 3C's `GOODS_RECEIPT`, repeated here because every test in this slice creates stock with it and
 * `packages/db/seed/` is not importable from a test (§3.1). **Transcribed from
 * `packages/db/seed/my/document-types/GOODS_RECEIPT.json` as it stands in the tree, not from the 3D plan's
 * copy of it**: 3C's file wins (Task 9 Step 6 is the check that says so), and the two differ — the shipped
 * file values both legs at `line.amount` (§4.3.4's cost-leg pairing: a RECEIPT policy has ALL `line.amount`
 * legs) and carries two further `line.kind = 'account'` rules for a landed-cost line, where the plan's copy
 * had a `line.cost` debit and no account rules.
 *
 * Note the `2150` credit leg: every `beforeAll` that configures this policy seeds that account, or the
 * first post raises `ERR_POLICY_REQUIRES_MISSING` (§4.4.1), and `requires: ["party", "warehouse"]` means
 * every receipt document carries a `party_id`.
 */
export const GRN_POLICY = {
  version: 1,
  documentType: "GOODS_RECEIPT",
  direction: "inbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "2150" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "1300" },
      amount: "line.amount",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.amount",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" },
  tax: { applies: false },
  numbering: { series: "GRN", assignAt: "issue" },
  reversal: { allowed: true, producesType: "GOODS_RECEIPT" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.receipt.post",
    create: "inventory.receipt.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/**
 * §4.14 `TRANSFER_RECEIPT` — the receive leg with variance (spec:1053). Landed here rather than at Task 8
 * because Task 4 is the first task that posts one, and `TRANSFER_RECEIPT.json` does not exist until Task 8.
 *
 * FOUR ledger rules, and the shape is load-bearing. The first pair is unconditional and moves what ARRIVED
 * (`line.cost`, which Task 4 fills with |receipt.value|) out of 1310 and into the destination's inventory
 * account. The two conditional pairs move the DIFFERENCE (`line.variance_value`, filled with
 * | |issue.value| - |receipt.value| |) between 1310 and 5110, in whichever direction the variance's sign
 * says. Net effect on 1310 across all four: a credit of |issue.value| — the exact figure the dispatch
 * debited — so the corridor clears to zero on every receipt, short or over. That is the arithmetic the
 * definition-of-done clause's second half rests on, and it is why `variance_value` needs no column
 * (LEGACY-018).
 */
export const TRANSFER_RECEIPT_POLICY = {
  version: 1,
  documentType: "TRANSFER_RECEIPT",
  direction: "internal",
  requires: ["warehouse", "to_warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1310" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    // A SHORTFALL (counted < expected, so the variance is negative): the missing value is a loss.
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1310" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    // An OVERAGE (counted > expected): more arrived than left. The corridor is over-relieved, so the
    // difference goes back the other way.
    {
      for: "each_line",
      side: "debit",
      account: { code: "1310" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
  ],
  inventory: {
    effect: "transfer",
    warehouse: "line.warehouse",
    to_warehouse: "header.to_warehouse",
    costing: "consume_layers",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "TRR", assignAt: "issue" },
  reversal: { allowed: false, producesType: null }, // see "the reversal interaction" in Task 8
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/** §4.14 `SALES_ORDER` — the sales twin of 3C's PURCHASE_ORDER. `lines: []` is the whole of "non-posting",
 *  and `dimensions.required` is `[]` for 3C's reason: the check runs over planned ledger lines and there
 *  are none. Transcribed from `packages/db/seed/my/document-types/SALES_ORDER.json`; Task 9 Step 6 is the
 *  case that asserts the two agree after `JSON.parse`. */
export const SALES_ORDER_POLICY = {
  version: 1,
  documentType: "SALES_ORDER",
  direction: "none",
  requires: ["party"],
  lines: [],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "SO", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

/**
 * §4.14 `DELIVERY_ORDER` — stock out before the invoice (F-19). Both legs address `line.cost` and NOT
 * `line.amount`: a delivery moves COST, and `line.unit_price` carries the agreed selling price only so
 * 4A's SALES_INVOICE can read it. §4.3.4's cost-leg pairing holds — an ISSUE policy has all `line.cost`
 * legs — so step 6's `balanceInBase` sees the whole document as residue and never a half-costed one.
 *
 * `allowNegative: true` is load-bearing and is on this type alone in this slice: amendment A8b makes
 * `cost()` admit an uncovered quantity only when BOTH this flag and an `inventory.negative_stock.override`
 * event are present, and test 18's re-run and test 7 both go negative through this type.
 */
export const DELIVERY_ORDER_POLICY = {
  version: 1,
  documentType: "DELIVERY_ORDER",
  direction: "outbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1250" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: {
    effect: "issue",
    warehouse: "line.warehouse",
    costing: "consume_layers",
    allowNegative: true,
  },
  tax: { applies: false },
  numbering: { series: "DO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/**
 * §4.14 `TRANSFER` — the dispatch leg (3D T7). `effect: "transfer"` emits TWO movements per line (issue at
 * `warehouse`, receipt at `to_warehouse`), and Task 3's rule gives the receipt leg `create_layer` however
 * this `costing` reads: a transfer policy's `costing` describes the SOURCE leg. `1310` is 3C's account and
 * is named here without being re-seeded (hazard 33).
 *
 * Both legs are `line.cost`, which is §4.3.4's cost-leg pairing read for an internal movement: nothing on a
 * dispatch line carries a price, and the value is whatever left the source warehouse. `allowNegative: false`
 * — a branch cannot dispatch stock it does not have, and the honest document for stock that has vanished is
 * a `STOCK_COUNT` or an `EXPIRY_WRITE_OFF`.
 */
export const TRANSFER_POLICY = {
  version: 1,
  documentType: "TRANSFER",
  direction: "internal",
  requires: ["warehouse", "to_warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1310" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: {
    effect: "transfer",
    warehouse: "line.warehouse",
    to_warehouse: "header.to_warehouse",
    costing: "consume_layers",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "TRF", assignAt: "issue" },
  reversal: { allowed: true, producesType: "TRANSFER" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/**
 * §4.14 `EXPIRY_WRITE_OFF` — spec:1054. `5100` is 3C's account (§4.15) and is named, never re-seeded.
 * `dimensions.required: ["BRANCH"]` is the spec's "tagged BRANCH": the evaluator adds `document.branch` as
 * BRANCH to every planned line and then checks `required`, so a policy that omitted it would post untagged
 * lines and the branch profit report (7C) would silently miss the loss.
 *
 * Both legs are `line.cost` — §4.3.4's cost-leg pairing for an ISSUE policy. A write-off is a plain issue
 * at cost: nothing on the line carries a price, and `document_line.amount` is written as 0 by the drafting
 * service, so a mixed `line.amount` leg would leave step 6's `balanceInBase` with half a document.
 */
export const EXPIRY_WRITE_OFF_POLICY = {
  version: 1,
  documentType: "EXPIRY_WRITE_OFF",
  direction: "internal",
  requires: ["warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "5100" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: {
    effect: "issue",
    warehouse: "line.warehouse",
    costing: "consume_layers",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "EWO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "EXPIRY_WRITE_OFF" },
  approval: {
    required: true,
    approve: "inventory.adjustment.approve",
    post: "inventory.adjustment.approve",
    create: "inventory.adjustment.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;

/**
 * §4.14 `STOCK_COUNT` — variance only (spec:1052, 2026). Transcribed from
 * `packages/db/seed/my/document-types/STOCK_COUNT.json`; Task 9 Step 6 is the case that asserts the two
 * agree after `JSON.parse`.
 *
 * `effect: "receipt"` with `costing: "create_layer"` on a type that also ISSUES. A surplus is a receipt with
 * no purchase price, valued by amendment A8 at `average(openLayers)`; a shortfall is a NEGATIVE resolved
 * quantity, which the evaluator's behaviour 2 flips to `issue` + `consume_layers` on its own. One declared
 * effect covers both directions because the sign does the work, which is why the frozen schema needed no new
 * label. A line whose count matches has a zero variance, `quantity_sign` is null, no `when` matches, and the
 * zero-drop removes its movement — that is the whole of "posts only the variance".
 *
 * `approval.required: true` with `create` and `approve` naming DIFFERENT codes is what makes R1
 * non-vacuous: Task 2 granted `inventory.count.create` to `warehouse`/`branch_manager` and
 * `inventory.adjustment.approve` to `accountant`, so the counter and the approver are necessarily two
 * principals (spec:2026).
 */
export const STOCK_COUNT_POLICY = {
  version: 1,
  documentType: "STOCK_COUNT",
  direction: "internal",
  requires: ["warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
  ],
  inventory: {
    effect: "receipt",
    warehouse: "line.warehouse",
    costing: "create_layer",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "SC", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_COUNT" },
  approval: {
    required: true,
    approve: "inventory.adjustment.approve",
    post: "inventory.adjustment.approve",
    create: "inventory.count.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
} as const;
