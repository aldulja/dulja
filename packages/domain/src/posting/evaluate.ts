import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type Decimal from "decimal.js";
import seedSchema from "../../document-type-seed.schema.json" with { type: "json" };
import policySchema from "../../posting-policy.schema.json" with { type: "json" };
import { D } from "../money/decimal";
import { toBase, type ExchangeRate } from "../money/exchange-rate";
import { Money, type CurrencyCode } from "../money/money";
import type { Quantity } from "../money/quantity";
import type { RoundingMode } from "../money/rounding";
import { contradictsSide, taxSideOf } from "../tax/side";
import type { PostingPolicy } from "./policy";

export type DocumentStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "issued"
  | "void"
  | "posted"
  | "reversed";

/** contracts §4.4.2 — declared in full at its final shape and filled at the Phase 1 subset (plan 1A
 *  assumption 8). Every later slice fills a field it adds a column for; no consumer ever changes. */
export interface DocumentSnapshot {
  header: {
    id: string;
    companyId: string;
    documentTypeCode: string;
    status: DocumentStatus;
    series: string;
    fiscalPeriodId: string | null;
    number: bigint | null;
    effectiveDate: string;
    partyId: string | null;
    currency: CurrencyCode;
    exchangeRate: ExchangeRate;
    branchId: string;
    attributedTo: string | null;
    clientRef: string | null;
    warehouseId: string | null;
    toWarehouseId: string | null;
    taxInclusive: boolean;
    reversesDocumentId: string | null;
    customFields: Record<string, unknown>;
  };
  lines: LineSnapshot[];
  company: {
    id: string;
    baseCurrency: CurrencyCode;
    fxRoundingAccountId: string | null;
    costingMethod: "avco" | "fifo";
  };
  party: {
    id: string;
    kind: string;
    receivableAccountId: string | null;
    payableAccountId: string | null;
    creditLimit: Money | null;
  } | null;
  refs: {
    accountsByCode: Record<string, string>;
    items: Record<string, ItemRef>;
    taxCodes: Record<string, TaxCodeRef>;
    components: Record<string, PayComponentRef>;
    schemes: Record<string, SchemeRef>;
    dimensionTypesByCode: Record<string, string>;
  };
}

export interface LineSnapshot {
  id: string;
  lineNo: number;
  kind: "account" | "item" | "tax" | "text" | "tender" | "payroll";
  description: string | null;
  accountId: string | null;
  itemId: string | null;
  quantity: Quantity | null;
  unitPrice: Money | null;
  discount: Money;
  amount: Money;
  taxCodeId: string | null;
  taxAmount: Money;
  totalInclTax: Money;
  debit: Money;
  credit: Money;
  cost: Money | null;
  warehouseId: string | null;
  toWarehouseId: string | null;
  lotId: string | null;
  unitId: string | null;
  unitQuantity: Quantity | null;
  countedQuantity: Quantity | null;
  expectedQuantity: Quantity | null;
  /** The `when` filter's `line.tender_method` reads this typed field, never the untyped bag (§4.6.5). */
  tenderMethod: "cash" | "card" | "transfer" | "store_credit" | null;
  customFields: Record<string, unknown>;
  dimensions: Record<string, string>;
  payroll: PayrollLineRef | null;
}

export interface PlannedLedgerLine {
  lineNo: number;
  accountId: string;
  side: "debit" | "credit";
  amount: Money;
  base: Money;
  dimensions: Record<string, string>;
  sourceLineNo: number | null;
  /** 3B — amendment A4: `"cost"` marks a line whose amount is already in the company's base currency. */
  role: "policy" | "fx_rounding" | "cost";
  /** 3D (ADR 0042): which of `line.cost` / `line.variance_value` this line resolved from, so
   *  `applyMovements` (§4.7.2) can tell two amendment-A5 survivors on one source line apart — one carries
   *  the matched value and the other the variance, and `role` alone says only that both are costs. ABSENT
   *  (not `undefined`) for every other amount reference, so 1A's, 2A's and 2B's `toEqual` assertions on
   *  whole planned lines stay green. */
  fill?: "cost" | "variance_value";
}
export interface PlannedMovement {
  lineNo: number;
  movementNo: number;
  itemId: string;
  warehouseId: string;
  lotId: string | null;
  quantity: Quantity;
  effect: "receipt" | "issue";
  value: Money | null;
  costing: "consume_layers" | "create_layer" | "zero";
}
export interface PlannedTaxLine {
  lineNo: number;
  taxCodeId: string;
  base: Money;
  amount: Money;
  inclusive: boolean;
}
export interface PostingPlan {
  ledgerLines: PlannedLedgerLine[];
  movements: PlannedMovement[];
  taxLines: PlannedTaxLine[];
  warnings: string[];
}
export interface PolicyValidation {
  ok: boolean;
  errors: { path: string; message: string }[];
}

/** Declared here, in core, and nowhere else — spec:2366 forbids packages/domain/src/** importing
 *  packages/domain/payroll/**. 8B's richer types satisfy these structurally and core never imports HR. */
export interface PayComponentRef {
  id: string;
  code: string;
  kind: "earning" | "deduction";
  expenseAccountId: string | null;
  payableAccountId: string | null;
}
export interface SchemeRef {
  id: string;
  code: string;
  payableAccountId: string;
  expenseAccountId: string | null;
}
export interface PayrollLineRef {
  employeeId: string;
  employeeDimensionValueId: string;
  componentId: string | null;
  schemeId: string | null;
  share: "employee" | "employer" | null;
}
/** Declared here for the same reason: app.item is 3A's table and app.tax_code is 5A's, and the evaluator
 *  resolves item.* and tax_code.* references before either exists. */
export interface ItemRef {
  id: string;
  code: string;
  kind: "product" | "service" | "asset";
  baseUnitId: string;
  trackLots: boolean;
  revenueAccountId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  expenseAccountId: string | null;
}
export interface TaxCodeRef {
  id: string;
  code: string;
  rate: string;
  kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
  roundingMode: RoundingMode;
  outputAccountId: string | null;
  inputAccountId: string | null;
}

export class PolicyEvaluationError extends Error {
  constructor(
    readonly code: "ERR_POLICY_INVALID" | "ERR_POLICY_REQUIRES_MISSING" | "ERR_LEDGER_UNBALANCED",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PolicyEvaluationError";
  }
}

// `strictRequired: false` because contracts §4.4.1's `inventory.if/then` names `warehouse` and `costing` in a
// `then.required` while the properties are declared on the parent object — legal JSON Schema, refused by Ajv's
// strictRequired heuristic. Every other strict check stays on.
//
// Compiled on first use, once per process, never at import: Ajv compiles a schema with `new Function`, and the
// desktop renderers, which reach this barrel through `@dulja/contracts`, run under `script-src 'self'` with no
// `'unsafe-eval'` (`apps/desktop/src/window-options.ts`). A compile at import threw before React mounted, so
// `backoffice.exe` and `pos.exe` painted nothing (found verifying PR 12). `test/lazy-schemas.test.ts` pins it.
let ajv: Ajv2020 | undefined;
let policyCompiled: ValidateFunction | undefined;
let seedCompiled: ValidateFunction | undefined;
const compile = (schema: object): ValidateFunction =>
  (ajv ??= new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    useDefaults: false,
  })).compile(schema);
const policyValidator = (): ValidateFunction => (policyCompiled ??= compile(policySchema));
const seedValidator = (): ValidateFunction => (seedCompiled ??= compile(seedSchema));

const toErrors = (errors: ErrorObject[] | null | undefined): { path: string; message: string }[] =>
  (errors ?? []).map((error) => ({
    path: error.instancePath,
    message: `${error.message ?? "is invalid"}${
      error.params && "additionalProperty" in error.params
        ? ` (${String(error.params.additionalProperty)})`
        : ""
    }`,
  }));

/** Seed time: the JSON Schema plus "every approval code exists in the catalogue" (F-21, contracts §4.4.1). */
export function validatePolicy(
  definition: unknown,
  catalogue: readonly string[],
): PolicyValidation {
  const validate = policyValidator();
  if (!validate(definition)) return { ok: false, errors: toErrors(validate.errors) };
  const policy = definition as PostingPolicy;
  const errors: { path: string; message: string }[] = [];
  const check = (code: string | null | undefined, path: string): void => {
    if (code && !catalogue.includes(code))
      errors.push({ path, message: `${code} is not in the permission catalogue` });
  };
  check(policy.approval.post, "/approval/post");
  check(policy.approval.approve, "/approval/approve");
  check(policy.approval.create, "/approval/create");
  return { ok: errors.length === 0, errors };
}

/** Post time: the schema only, throwing. A definition already in the database has been through
 *  validatePolicy at seed time; this guards against one written by hand or by an older schema. */
export function parsePolicy(definition: unknown): PostingPolicy {
  const validate = policyValidator();
  if (!validate(definition)) {
    const detail = toErrors(validate.errors)
      .map((error) => `${error.path || "/"} ${error.message}`)
      .join("; ");
    throw new PolicyEvaluationError("ERR_POLICY_INVALID", detail);
  }
  return definition as PostingPolicy;
}

/** The §4.3.7 envelope: the schema, plus the cross-field rule the schema cannot express. */
export function validateDocumentTypeSeed(envelope: unknown): PolicyValidation {
  const validate = seedValidator();
  if (!validate(envelope)) return { ok: false, errors: toErrors(validate.errors) };
  const seed = envelope as { code: string; policy: { documentType?: unknown } };
  const declared = typeof seed.policy?.documentType === "string" ? seed.policy.documentType : "";
  if (seed.code !== declared) {
    return {
      ok: false,
      errors: [
        {
          path: "/code",
          message: `code ${seed.code} does not equal policy.documentType ${declared}`,
        },
      ],
    };
  }
  return { ok: true, errors: [] };
}

const REQUIRES_FIELD: Record<string, (snapshot: DocumentSnapshot) => unknown> = {
  party: (snapshot) => snapshot.header.partyId,
  warehouse: (snapshot) => snapshot.header.warehouseId,
  to_warehouse: (snapshot) => snapshot.header.toWarehouseId,
  attributed_to: (snapshot) => snapshot.header.attributedTo,
  client_ref: (snapshot) => snapshot.header.clientRef,
  reverses_document: (snapshot) => snapshot.header.reversesDocumentId,
};

export function validateRequires(
  policy: PostingPolicy,
  snapshot: DocumentSnapshot,
): { missing: string[] } {
  return {
    missing: (policy.requires ?? []).filter((field) => REQUIRES_FIELD[field]?.(snapshot) == null),
  };
}

type PolicyLine = PostingPolicy["lines"][number];
type AccountRef = PolicyLine["account"];
type AmountRef = PolicyLine["amount"];

const missing = (what: string, site: string): never => {
  throw new PolicyEvaluationError("ERR_POLICY_REQUIRES_MISSING", `${site} cannot resolve ${what}`);
};

function resolveAccount(
  ref: AccountRef,
  line: LineSnapshot | null,
  snapshot: DocumentSnapshot,
): string {
  const site = line ? `line ${line.lineNo}` : `document ${snapshot.header.id}`;
  if ("code" in ref) {
    // A literal chart code. Every literal a policy may name is registered in contracts §4.15 with the one
    // slice that seeds it; an unseeded code fails here rather than posting to a null account.
    return (
      snapshot.refs.accountsByCode[ref.code] ??
      missing(`account code ${ref.code} in company ${snapshot.company.id}`, site)
    );
  }
  switch (ref.from) {
    case "company.fx_rounding_account_id":
      return (
        snapshot.company.fxRoundingAccountId ?? missing("company.fx_rounding_account_id", site)
      );
    case "party.receivable_account":
      return snapshot.party?.receivableAccountId ?? missing("party.receivable_account", site);
    case "party.payable_account":
      return snapshot.party?.payableAccountId ?? missing("party.payable_account", site);
    default:
      break;
  }
  if (!line) return missing(`${ref.from} on a document-scoped rule`, site); // unreachable: guarded in evaluatePolicy
  switch (ref.from) {
    case "line.account":
      return line.accountId ?? missing("line.account", site);
    case "item.revenue_account":
    case "item.inventory_account":
    case "item.cogs_account":
    case "item.expense_account": {
      const item: ItemRef | undefined = line.itemId ? snapshot.refs.items[line.itemId] : undefined;
      const id =
        item &&
        {
          "item.revenue_account": item.revenueAccountId,
          "item.inventory_account": item.inventoryAccountId,
          "item.cogs_account": item.cogsAccountId,
          "item.expense_account": item.expenseAccountId,
        }[ref.from];
      return id ?? missing(ref.from, site);
    }
    case "tax_code.output_account":
    case "tax_code.input_account": {
      const code: TaxCodeRef | undefined = line.taxCodeId
        ? snapshot.refs.taxCodes[line.taxCodeId]
        : undefined;
      const id =
        code &&
        (ref.from === "tax_code.output_account" ? code.outputAccountId : code.inputAccountId);
      return id ?? missing(ref.from, site);
    }
    case "line.component.expense_account": {
      const component: PayComponentRef | undefined = line.payroll?.componentId
        ? snapshot.refs.components[line.payroll.componentId]
        : undefined;
      return component?.expenseAccountId ?? missing(ref.from, site);
    }
    case "line.scheme.payable_account":
    case "line.scheme.expense_account": {
      const scheme: SchemeRef | undefined = line.payroll?.schemeId
        ? snapshot.refs.schemes[line.payroll.schemeId]
        : undefined;
      const id =
        scheme &&
        (ref.from === "line.scheme.payable_account"
          ? scheme.payableAccountId
          : scheme.expenseAccountId);
      return id ?? missing(ref.from, site);
    }
    default:
      throw new PolicyEvaluationError(
        "ERR_POLICY_INVALID",
        `unknown account reference ${String(ref.from)}`,
      );
  }
}

/** 3D behaviour 1 (ADR 0042). `when: { "line.quantity_sign": … }` (§4.4.1) resolves from the line's SIGNED
 *  quantity. On a line carrying both count columns that quantity is the variance `counted − expected`
 *  (§4.3.4, migration 0040), which is what makes "post only the variance" a policy fact. Zero and null match
 *  NEITHER value — that is what makes a stock-count line whose sheet matches plan nothing at all
 *  (spec:1052). A filter never fails open, so the null is returned rather than defaulted either way. */
function quantitySignOf(line: LineSnapshot): "positive" | "negative" | null {
  if (line.quantity === null || line.quantity.isZero()) return null;
  return line.quantity.isNegative() ? "negative" : "positive";
}

/** Every `when` key the schema admits, resolved against the line and the snapshot. A `when` is a CONJUNCTION:
 *  every declared equality must hold. A key whose value cannot be read (no item, no payroll ref, no quantity)
 *  does not match — a filter never fails open. */
function matchesWhen(
  when: NonNullable<PolicyLine["when"]>,
  line: LineSnapshot | null,
  snapshot: DocumentSnapshot,
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    let actual: string | null = null;
    switch (key) {
      case "line.kind":
        actual = line?.kind ?? null;
        break;
      case "line.tender_method":
        actual = line?.tenderMethod ?? null;
        break;
      case "line.component.kind": {
        const id = line?.payroll?.componentId ?? null;
        actual = id ? (snapshot.refs.components[id]?.kind ?? null) : null;
        break;
      }
      case "line.share":
        actual = line?.payroll?.share ?? null;
        break;
      case "line.quantity_sign":
        actual = line === null ? null : quantitySignOf(line);
        break;
      case "item.kind": {
        const id = line?.itemId ?? null;
        actual = id ? (snapshot.refs.items[id]?.kind ?? null) : null;
        break;
      }
      case "document.kind": {
        // Amendment A6: a document has no `kind` column; 8B's payroll_run.kind is a 1:1 extension and core
        // never imports HR (spec:2366), so the custom-field bag is where a kind lives for the evaluator.
        const v = snapshot.header.customFields["kind"];
        actual = typeof v === "string" ? v : null;
        break;
      }
      default:
        throw new PolicyEvaluationError("ERR_POLICY_INVALID", `unknown when key ${key}`);
    }
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * Code review 2 (Phase 4), M1-X. Whether the policy CHOSE `line`'s direction from its sign: true only when
 * at least one `each_line` rule matches the line and every rule that matches selects on `line.quantity_sign` —
 * STOCK_COUNT's rule pairs, each on the sides its sign needs. A rule that does not select on the sign keeps
 * the policy's forward side, while `orientLeg` flips a negative line's movement; on a stock document whose cost
 * is not yet known (A5's stand-in keeps the policy's side, and §4.7.2's fill never alters it) the ledger then
 * runs one way and the stock the other. `postDocument` refuses such a line outside a reversal.
 *
 * Meeting NO rule is not a choice, and is false. `planMovements` moves a line by its `item_id`, while every
 * seeded stock policy matches on `line.kind: "item"`, so a negative `account` line carrying an item met no
 * rule, was admitted vacuously, and still posted as a flipped movement with no ledger behind it (code review
 * 2, the verification of M1-X). Here, beside `matchesWhen`, so that matching has one spelling (hazard 9).
 */
export function quantitySignChosen(
  policy: PostingPolicy,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): boolean {
  const met = eachLineRulesMet(policy, line, snapshot);
  return (
    met.length > 0 &&
    met.every((rule) => rule.when !== undefined && "line.quantity_sign" in rule.when)
  );
}

/**
 * Code review 3 (Phase 4), R4. Whether ANY `each_line` rule of `policy` meets `line` — the non-vacuity half of
 * `quantitySignChosen`, asked of a line whatever its sign. `planMovements` moves every product line it is
 * given, so a line that meets no rule moves stock that no ledger leg accounts for; `postDocument` refuses such
 * a movement outside a reversal. Same matching as `quantitySignChosen`, through the same helper (hazard 9).
 */
export function lineMeetsARule(
  policy: PostingPolicy,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): boolean {
  return eachLineRulesMet(policy, line, snapshot).length > 0;
}

/**
 * Code review 3 (Phase 4), R3's repair. Whether an `each_line` rule that meets `line` posts
 * `line.variance_value`. A counted `transfer` line whose two legs differ (`transferQuantities`: expected out,
 * counted in) moves two values, and §4.7.2's fill posts the difference between them ONLY through a
 * `line.variance_value` rule; when the rules meeting the line name `line.cost` alone, one value is posted
 * against two legs of different value. `postDocument` refuses such a line. Same matching as
 * `quantitySignChosen`, through the same helper (hazard 9).
 */
export function lineMeetsAVarianceRule(
  policy: PostingPolicy,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): boolean {
  return eachLineRulesMet(policy, line, snapshot).some(
    (rule) => rule.amount === "line.variance_value",
  );
}

/** The `each_line` rules whose `when` holds for `line` — an absent `when` holds for every line. */
function eachLineRulesMet(
  policy: PostingPolicy,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): PolicyLine[] {
  return policy.lines.filter(
    (rule) =>
      rule.for === "each_line" &&
      (rule.when === undefined || matchesWhen(rule.when, line, snapshot)),
  );
}

/**
 * ADR 0045 (4A), contracts §4.4.2 — the one place a `COST_AMOUNT_REFS` reference (below) becomes a SIGNED
 * amount. A cost is stored as a non-negative magnitude (§4.7.2 A6) and `applyMovements`' receipt-value
 * branch 1 reads that column directly, so the sign cannot live in the column. It lives here: on a line whose
 * quantity is NEGATIVE — a reversal, a credit note, a cancelled delivery — the cost is read as negative, and
 * A9's sign normalisation then flips the rule's `side`. Without this a reversal debits its clearing corridor
 * a second time instead of relieving it (3d:2740). A zero or null quantity is untouched: a zero plans no
 * movement (3D A3) and a null has no direction.
 *
 * A NULL cost never reaches this function: `lineAmount` returns it as null and the caller emits the stand-in
 * zero on the policy's own side (A5). The side of a to-be-filled line must be the policy's, because §4.7.2's
 * fill rules "never alter `side`" and the fill happens after evaluation.
 *
 * A rule whose `when` selects on `line.quantity_sign` is exempt: it has ALREADY chosen its direction from the
 * sign — STOCK_COUNT and TRANSFER_RECEIPT carry one rule pair per sign, each on the sides that sign needs —
 * so negating its cost as well flips the line twice. A reversed count surplus (quantity −3, its cost copied
 * positive) matched the `negative` pair, credit inventory and debit 5110, and the negation then swapped it
 * back to debit inventory while the movement issued the stock (code review, C3).
 */
function resolveCostAmount(cost: Money, line: LineSnapshot, signChosen: boolean): Money {
  if (signChosen) return cost;
  return line.quantity !== null && line.quantity.isNegative() ? cost.negate() : cost;
}

/** Resolves a line-scoped amount. Returns `null` for a cost reference the costing engine has not filled
 *  (amendment A5) — the caller emits a zero line and exempts it from the drop. `signChosen` is true when
 *  the rule's `when` selects on `line.quantity_sign` (see `resolveCostAmount`). */
function lineAmount(ref: AmountRef, line: LineSnapshot, signChosen: boolean): Money | null {
  switch (ref) {
    case "line.debit":
      return line.debit;
    case "line.credit":
      return line.credit;
    case "line.amount":
    case "line.total_excl_tax":
      return line.amount; // §4.3.4: `amount` IS the excl.-tax total (amendment A6)
    case "line.total_incl_tax":
      return line.totalInclTax;
    case "line.tax_amount":
      return line.taxAmount;
    case "line.discount":
      return line.discount;
    case "line.cost":
    case "line.variance_value":
      // null until §4.3.2 step 9; a known cost takes its sign from the line's quantity (ADR 0045)
      return line.cost === null ? null : resolveCostAmount(line.cost, line, signChosen);
    default:
      throw new PolicyEvaluationError(
        "ERR_POLICY_INVALID",
        `amount reference ${ref} is not valid on a line-scoped rule`,
      );
  }
}

function documentAmount(ref: AmountRef, snapshot: DocumentSnapshot, zero: Money): Money {
  const sum = (pick: (l: LineSnapshot) => Money): Money =>
    snapshot.lines.reduce((total, l) => total.add(pick(l)), zero);
  switch (ref) {
    case "document.total_excl_tax":
      return sum((l) => l.amount);
    case "document.total_incl_tax":
      return sum((l) => l.totalInclTax);
    case "document.tax_total":
      return sum((l) => l.taxAmount);
    default:
      throw new PolicyEvaluationError(
        "ERR_POLICY_INVALID",
        `amount reference ${ref} is not valid on a document-scoped rule`,
      );
  }
}

/**
 * The two amount references whose resolved value is a COST — and a cost is arithmetic over
 * `inventory_movement.value`, which contracts §4.7.3 declares to be in the company's BASE currency. A
 * planned line built from one of these is therefore already base: it is tagged `role: "cost"`, `base` is
 * the amount itself, and `insertLedger` writes it at exchange rate 1.00000000 exactly as it already writes
 * an `fx_rounding` line. Converting it at the document's rate would make the base COGS of a fixed quantity
 * of goods depend on what the document's currency did that morning (3B — amendment A4).
 *
 * ADR 0045 (4A): their SIGN comes from the line's quantity — see `resolveCostAmount` above.
 */
export const COST_AMOUNT_REFS: ReadonlySet<string> = new Set(["line.cost", "line.variance_value"]);

const DOCUMENT_SCOPED_ACCOUNTS: ReadonlySet<string> = new Set([
  "party.receivable_account",
  "party.payable_account",
  "company.fx_rounding_account_id",
]);

function dimensionsFor(
  rule: PolicyLine,
  line: LineSnapshot | null,
  snapshot: DocumentSnapshot,
): Record<string, string> {
  // The schema's default, restated: a rule with no `dimensions` block takes the line's own bag plus the
  // document's BRANCH. contracts §4.3.2 step 10's "regardless" is that default — a rule that DECLARES a
  // narrower `from` omits what it does not name, which is what makes `dimensions.required` a rule the
  // engine can break (spec:1066, F-9).
  const from = rule.dimensions?.from ?? ["line.dimensions", "document.branch"];
  const out: Record<string, string> = {};
  for (const source of from) {
    if (source === "line.dimensions" && line) Object.assign(out, line.dimensions);
    if (source === "document.branch") out["BRANCH"] = snapshot.header.branchId;
    if (source === "line.employee" && line?.payroll)
      out["EMPLOYEE"] = line.payroll.employeeDimensionValueId;
  }
  // The header's BRANCH always wins over a value a client put in the line's own bag (LEGACY-042, LEGACY-050).
  if (from.includes("document.branch")) out["BRANCH"] = snapshot.header.branchId;
  return out;
}

/** Amendment A9. `app.ledger_entry` has `check (debit >= 0)` and `check (credit >= 0)` (plan0A:2012) and
 *  1A's `insertLedger` puts `line.amount` straight into the column named by `line.side`, so a negative
 *  planned amount would die on a constraint instead of producing a mirrored entry. A negative amount is
 *  therefore the SAME entry on the opposite side: side carries the direction, the magnitude is absolute.
 *  This is what lets one `each_line` rule set post a document and its reversal (Task 8). */
const normalise = (
  side: "debit" | "credit",
  amount: Money,
): { side: "debit" | "credit"; amount: Money } =>
  amount.isNegative()
    ? { side: side === "debit" ? "credit" : "debit", amount: amount.abs() }
    : { side, amount };

/** Pure. Zero-amount planned lines are dropped (§4.3.2 step 6) EXCEPT a cost reference the costing engine
 *  has not filled — see amendment A5. A zero-amount `each_tax` group is dropped BEFORE its accountRef is
 *  resolved, so a tax code with no account (zero-rated, exempt) plans no ledger line rather than refusing.
 *  Every planned LEDGER line's `amount` is non-negative — `side` is the sole carrier of direction (amendment
 *  A9); planned TAX lines, one per code for the whole document (`planTaxLines`), keep their signed magnitude.
 *  Throws PolicyEvaluationError and never touches I/O. */
export function evaluatePolicy(policy: PostingPolicy, snapshot: DocumentSnapshot): PostingPlan {
  const zero = Money.zero(snapshot.header.currency);
  // 3B — a cost is a base-currency amount (amendment A4), so the zero that stands in for an uncomputed one
  // must be base too; everything else stands in for a document-currency amount.
  const zeroBase = Money.zero(snapshot.company.baseCurrency);
  const ledgerLines: PlannedLedgerLine[] = [];
  const warnings: string[] = [];
  let lineNo = 0;

  const push = (
    rule: PolicyLine,
    source: LineSnapshot | null,
    raw: Money,
    unresolvedCost: boolean,
  ): void => {
    if (raw.isZero() && !unresolvedCost) return;
    const { side, amount } = normalise(rule.side, raw);
    const isCost = COST_AMOUNT_REFS.has(rule.amount);
    lineNo += 1;
    const planned: PlannedLedgerLine = {
      lineNo,
      accountId: resolveAccount(rule.account, source, snapshot),
      side,
      amount,
      // A cost is already base; everything else converts at the document's rate (spec:1816).
      base: isCost ? amount : toBase(amount, snapshot.header.exchangeRate),
      dimensions: dimensionsFor(rule, source, snapshot),
      sourceLineNo: source?.lineNo ?? null,
      role: isCost ? "cost" : "policy",
    };
    // 3D behaviour 5 (ADR 0042). The conditional spread is what keeps `fill` ABSENT rather than
    // `undefined` on every other reference: `{ fill: undefined }` is not equal to `{}` under Vitest's
    // strict object comparison, and 1A, 2A and 2B compare whole planned lines.
    ledgerLines.push(
      rule.amount === "line.cost"
        ? { ...planned, fill: "cost" }
        : rule.amount === "line.variance_value"
          ? { ...planned, fill: "variance_value" }
          : planned,
    );
  };

  for (const rule of policy.lines) {
    if (rule.for === "each_line") {
      for (const line of snapshot.lines) {
        if (rule.when && !matchesWhen(rule.when, line, snapshot)) continue;
        const resolved = lineAmount(
          rule.amount,
          line,
          rule.when !== undefined && "line.quantity_sign" in rule.when,
        );
        if (resolved === null) {
          // One warning per LINE, not per rule: a policy that names line.cost twice (the COGS debit and the
          // inventory credit of every sales policy) describes one uncomputed cost, and repeating the sentence
          // would make `plan.warnings` grow with the rule count rather than with the facts.
          const prefix = `line ${line.lineNo}:`;
          if (!warnings.some((w) => w.startsWith(prefix))) {
            warnings.push(
              `${prefix} cost is not yet computed; the costing engine fills it at post`,
            );
          }
          // `lineAmount` returns null for `line.cost` and `line.variance_value` and for nothing else, so
          // this call site is always a cost reference and its stand-in zero is base currency.
          push(rule, line, zeroBase, true);
        } else {
          push(rule, line, resolved, false);
        }
      }
      continue;
    }

    if (rule.for === "each_tax") {
      if (rule.amount !== "tax.amount") {
        throw new PolicyEvaluationError(
          "ERR_POLICY_INVALID",
          `an each_tax rule must use amount "tax.amount", not ${rule.amount}`,
        );
      }
      // The LEDGER legs are one set per rule: a reverse-charge pair debits one account and credits another
      // for the same group. The tax FACTS are not — `planTaxLines` (below) plans them once per document.
      for (const g of taxGroups(snapshot, (line) =>
        eachTaxRuleMatches(rule, line, snapshot),
      ).values()) {
        // ORDER IS LOAD-BEARING — the zero-amount group is dropped HERE, before `resolveAccount` runs below.
        // A zero-rated, exempt or out-of-scope tax code has no output and no input account, so resolving the
        // rule's accountRef first would refuse an ordinary zero-rated sale with ERR_POLICY_REQUIRES_MISSING
        // naming an account that is right to be absent. The zero group's `PlannedTaxLine` is not dropped with
        // it: `planTaxLines` plans every group, because the zero group's base is what a zero-rated return box
        // is computed from. Do not move the drop after `resolveAccount`.
        //
        // MON-04: the drop must not skip the SIDE check its non-zero twin gets from `resolveAccount`. A
        // zero-rated input code on a sale has no output account either, and dropped unchecked its fact was
        // written and boxed as a purchase. So a code whose kind declares the other side of the document's
        // policy (`taxSideOf`) is refused here with the refusal `resolveAccount` gives the non-zero group.
        const taxCode = snapshot.refs.taxCodes[g.line.taxCodeId!];
        if (taxCode && contradictsSide(taxCode.kind, taxSideOf(policy))) {
          throw new PolicyEvaluationError(
            "ERR_POLICY_REQUIRES_MISSING",
            `line ${g.line.lineNo}: tax code ${taxCode.code} is an ${taxCode.kind} code and ${policy.documentType} ` +
              `posts ${taxSideOf(policy)} tax — it has no ${taxSideOf(policy)} account`,
          );
        }
        if (g.amount.isZero()) continue;
        // The account resolves through the GROUP's representative line, but the ledger line belongs to the
        // document, not to that line: sourceLineNo is null (§4.4.2's PlannedLedgerLine).
        const { side, amount } = normalise(rule.side, g.amount);
        lineNo += 1;
        ledgerLines.push({
          lineNo,
          accountId: resolveAccount(rule.account, g.line, snapshot),
          side,
          amount,
          base: toBase(amount, snapshot.header.exchangeRate),
          dimensions: dimensionsFor(rule, null, snapshot),
          sourceLineNo: null,
          role: "policy",
        });
      }
      continue;
    }

    // rule.for === "document": one line, from the document's own totals.
    if (!("code" in rule.account) && !DOCUMENT_SCOPED_ACCOUNTS.has(rule.account.from)) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_INVALID",
        `a document-scoped rule cannot resolve ${rule.account.from}, which is line-scoped`,
      );
    }
    if (rule.when && !matchesWhen(rule.when, null, snapshot)) continue;
    push(rule, null, documentAmount(rule.amount, snapshot, zero), false);
  }

  for (const required of policy.dimensions?.required ?? []) {
    if (!snapshot.refs.dimensionTypesByCode[required]) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `dimension type ${required} is required by ${policy.documentType} and company ${snapshot.company.id} does not define it`,
      );
    }
    const offender = ledgerLines.find((line) => !line.dimensions[required]);
    if (offender) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `dimension ${required} is required by ${policy.documentType} and planned line ${offender.lineNo} carries none`,
      );
    }
  }

  // 3A: `movements` is planned here rather than in applyMovements (ADR 0035) — §4.4.2 makes movementNo the
  // evaluator's to assign, planning is pure, and this keeps applyMovements free of policy interpretation,
  // which is what lets 3B replace its body without touching this file.
  return {
    ledgerLines,
    movements: planMovements(policy, snapshot),
    taxLines: planTaxLines(policy, snapshot),
    warnings,
  };
}

/** Whether `rule` — an `each_tax` rule — takes `line` into its groups: an absent `when` takes every line. */
function eachTaxRuleMatches(
  rule: PolicyLine,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): boolean {
  return rule.when === undefined || matchesWhen(rule.when, line, snapshot);
}

/** The `each_tax` groups over the coded lines `takes` admits: one per tax code, in the order each code first
 *  appears in the document, summing the lines' `amount` (the base) and `tax_amount`, with `line` the group's
 *  FIRST line. The ledger legs and `planTaxLines` both group through here, so they cannot disagree on what a
 *  group is (hazard 9). */
function taxGroups(
  snapshot: DocumentSnapshot,
  takes: (line: LineSnapshot) => boolean,
): Map<string, { base: Money; amount: Money; line: LineSnapshot }> {
  const groups = new Map<string, { base: Money; amount: Money; line: LineSnapshot }>();
  for (const line of snapshot.lines) {
    if (!line.taxCodeId || !takes(line)) continue;
    const g = groups.get(line.taxCodeId);
    groups.set(
      line.taxCodeId,
      g
        ? { base: g.base.add(line.amount), amount: g.amount.add(line.taxAmount), line: g.line }
        : { base: line.amount, amount: line.taxAmount, line },
    );
  }
  return groups;
}

/**
 * `plan.taxLines` — the document's tax FACTS, which §4.3.2 step 11 writes to `app.tax_transaction` (unique on
 * `(document_id, line_no, tax_code_id)`) and a return sums. PR 11 review, round 3: they are planned ONCE per
 * document, over the UNION of the lines any `each_tax` rule's `when` matches — each line counted once,
 * grouped per tax code, `lineNo` the group's first line. Planned per RULE, as they were, a reverse-charge pair
 * (debit input, credit output, one code) planned the same group twice and the post failed on the unique key,
 * and two overlapping filters planned one code from two different first lines, so both rows inserted and the
 * return counted that tax twice. The LEDGER legs stay one set per rule (`evaluatePolicy`'s `each_tax` branch).
 *
 * A policy with one `each_tax` rule — every seeded one (`phase-5a-pinned`) — plans exactly what it planned
 * before: the same lines, the same groups in the same order, the same figures. A policy with none plans none.
 * Every group is planned, a zero-amount one included: its base is what a zero-rated return box reads, and the
 * zero drop before `resolveAccount` (amendment A11) is the ledger legs' rule, not this one's. `amount` keeps its
 * SIGN — 5A's tax ledger needs it to tell an invoice's output tax from a credit note's (amendment A9 exempts it
 * from the normalisation the ledger legs take).
 */
function planTaxLines(policy: PostingPolicy, snapshot: DocumentSnapshot): PlannedTaxLine[] {
  const rules = policy.lines.filter((rule) => rule.for === "each_tax");
  if (rules.length === 0) return [];
  const inclusive =
    policy.tax.inclusive === "header.tax_inclusive"
      ? snapshot.header.taxInclusive
      : policy.tax.inclusive === true;
  const groups = taxGroups(snapshot, (line) =>
    rules.some((rule) => eachTaxRuleMatches(rule, line, snapshot)),
  );
  const taxLines: PlannedTaxLine[] = [];
  for (const [taxCodeId, g] of groups) {
    taxLines.push({ lineNo: g.line.lineNo, taxCodeId, base: g.base, amount: g.amount, inclusive });
  }
  return taxLines;
}

/**
 * spec:1868 — a document must balance EXACTLY in its own currency; only the per-line rounding of the base
 * conversion may leave a residue, and one FX-rounding line at rate 1 on company.fx_rounding_account_id
 * absorbs it.
 *
 * Two checks, in this order, because they answer different questions:
 *
 *   1. Σ amount(debit) = Σ amount(credit) in the DOCUMENT currency — and, separately, in base for the cost
 *      lines a foreign-currency document carries (amendment A4) — to the last minor unit. No tolerance:
 *      the amounts are what the user keyed and nothing has been rounded yet. A 100.0000 / 99.9900 journal
 *      is a wrong document, not a rounding residue, and it is refused here whatever the rate. At rate 1
 *      base = amount line for line, so a document that passes this check can leave no base residue at all.
 *   2. Σ base(debit) − Σ base(credit), which `toBase` rounds per line to 4 dp HALF_AWAY_FROM_ZERO. Each line
 *      contributes at most 0.00005 of error, so |residue| ≤ 0.00005 × lines for a genuine rounding residue;
 *      the bound applied is 0.0001 × lines, twice that. Anything larger is not rounding and is refused.
 *
 * The earlier 0.01 × lines bound was a hundred times too loose: it let a same-currency journal that was
 * out by a sen post with a fabricated fx_rounding line (review of 2026-09-19).
 *
 * An `fx_rounding` line already on the plan — this function's own output, from an earlier call — is taken
 * OFF before either check and the residue derived again from what is left. `postDocument` calls this twice
 * (step 6, then step 9a on the filled plan), and the earlier line is a base-currency line with no partner:
 * left in, check 1 saw it alone in the base group beside the paired cost legs and refused a foreign-currency
 * document whose policy lines do not pair line for line (code review, C2). So the result carries exactly one
 * fx_rounding line, for the residue of the plan as it now stands, and a second call is a no-op.
 */
export function balanceInBase(
  plan: PostingPlan,
  fxRoundingAccountId: string | null,
  baseCurrency: CurrencyCode,
): PostingPlan {
  const lines = plan.ledgerLines.filter((line) => line.role !== "fx_rounding");
  const unrounded =
    lines.length === plan.ledgerLines.length ? plan : { ...plan, ledgerLines: lines };
  // Check 1 runs PER CURRENCY the plan carries. A policy line is in the document's currency, but a cost line
  // is BASE (3B amendment A4) and is only ever paired with another cost line (contracts §4.3.4, 3C), so a
  // foreign-currency document with a cost leg — a USD SALES_INVOICE relieving 1250 at the delivery's cost
  // (4A) — carries two groups, each of which must balance on its own. Summing them together raised
  // ERR_MONEY_CURRENCY_MISMATCH out of `Money.add` instead of posting. A single-currency plan is one group,
  // so for every other document this is the check exactly as it was.
  const byCurrency = new Map<string, { debit: Money; credit: Money }>();
  for (const line of lines) {
    const code = line.amount.currency as string;
    const totals = byCurrency.get(code) ?? {
      debit: Money.zero(line.amount.currency),
      credit: Money.zero(line.amount.currency),
    };
    byCurrency.set(
      code,
      line.side === "debit"
        ? { debit: totals.debit.add(line.amount), credit: totals.credit }
        : { debit: totals.debit, credit: totals.credit.add(line.amount) },
    );
  }
  for (const [code, totals] of byCurrency) {
    if (!totals.debit.equals(totals.credit)) {
      throw new PolicyEvaluationError(
        "ERR_LEDGER_UNBALANCED",
        `debits ${totals.debit.toString()} and credits ${totals.credit.toString()} ${code} do not balance`,
      );
    }
  }

  const zero = Money.zero(baseCurrency);
  const debit = lines
    .filter((line) => line.side === "debit")
    .reduce((total, line) => total.add(line.base), zero);
  const credit = lines
    .filter((line) => line.side === "credit")
    .reduce((total, line) => total.add(line.base), zero);
  const residue = debit.subtract(credit);
  if (residue.isZero()) return unrounded;

  const tolerance: Decimal = new D("0.0001").times(Math.max(lines.length, 1));
  if (residue.toDecimal().abs().greaterThan(tolerance)) {
    throw new PolicyEvaluationError(
      "ERR_LEDGER_UNBALANCED",
      `base debits and credits differ by ${residue.toString()} ${baseCurrency}, which exceeds the ${tolerance.toFixed(4)} rounding tolerance for ${lines.length} lines`,
    );
  }
  if (!fxRoundingAccountId) {
    throw new PolicyEvaluationError(
      "ERR_LEDGER_UNBALANCED",
      `base debits and credits differ by ${residue.toString()} ${baseCurrency} and the company has no fx_rounding_account_id to absorb it`,
    );
  }
  const branch = lines[0]?.dimensions.BRANCH;
  return {
    ...plan,
    ledgerLines: [
      ...lines,
      {
        // After the highest surviving number, not after the count: `applyMovements` drops a filled zero
        // cost line without renumbering (§4.7.2), so on the step-9a call the count can name a live line.
        lineNo: Math.max(0, ...lines.map((line) => line.lineNo)) + 1,
        accountId: fxRoundingAccountId,
        side: residue.isPositive() ? "credit" : "debit",
        amount: residue.abs(),
        base: residue.abs(),
        dimensions: branch ? { BRANCH: branch } : {},
        sourceLineNo: null,
        role: "fx_rounding",
      },
    ],
  };
}

type WarehouseRef = NonNullable<PostingPolicy["inventory"]["warehouse"]>;
type ToWarehouseRef = NonNullable<PostingPolicy["inventory"]["to_warehouse"]>;

function resolveWarehouse(
  ref: WarehouseRef,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): string | null {
  // §4.3.4: the header carries the default and a line's warehouse_id overrides it. A policy that names
  // header.warehouse means the whole document ships from one place, so it does NOT consult the line.
  return ref === "line.warehouse"
    ? (line.warehouseId ?? snapshot.header.warehouseId)
    : snapshot.header.warehouseId;
}

function resolveToWarehouse(
  ref: ToWarehouseRef,
  line: LineSnapshot,
  snapshot: DocumentSnapshot,
): string | null {
  // `line.toWarehouseId` is a constant null at 3A: there is no document_line.to_warehouse_id column and
  // §4.3.4's 3A row does not add one (assumption 3). The fallback is what makes the branch meaningful today,
  // and 3D adds the column in its own migration range if a per-line destination arrives.
  return ref === "line.to_warehouse"
    ? (line.toWarehouseId ?? snapshot.header.toWarehouseId)
    : snapshot.header.toWarehouseId;
}

/** 3D behaviour 2 (ADR 0042). `PlannedMovement.quantity` is always a MAGNITUDE and `effect` is the sole
 *  carrier of direction — the movement twin of amendment A9's rule for a planned ledger line. §4.7.1's
 *  `cost()` dispatches on `effect` ("receipts create a layer, issues consume"), so a negative quantity would
 *  reach a branch that does not exist; and `inventory_movement.quantity` is "+ receipt, − issue" (§4.7.3),
 *  so the sign belongs to the row, which `applyMovements` writes. A negatively resolved leg therefore emits
 *  the OPPOSITE effect at the magnitude. `Quantity` has no `abs()` (§4.2.1), hence `negate()`. */
function orientLeg(
  declared: "issue" | "receipt",
  quantity: Quantity,
): { effect: "issue" | "receipt"; quantity: Quantity } {
  if (!quantity.isNegative()) return { effect: declared, quantity };
  return { effect: declared === "issue" ? "receipt" : "issue", quantity: quantity.negate() };
}

/** 3D behaviour 4 (ADR 0042, ADR 0043). A `transfer` line's two legs need not carry one quantity. When the
 *  line carries BOTH count columns the ISSUE leg takes `expected_quantity` (everything that left the source)
 *  and the RECEIPT leg takes `counted_quantity` (what arrived); the difference is spec:1053's "variance on
 *  receipt", and it has nowhere else to live because `inventory.effect` is one value per policy. A line
 *  without both columns transfers its own `quantity` on both legs, which is the dispatch shape. */
function transferQuantities(line: LineSnapshot): {
  issue: Quantity | null;
  receipt: Quantity | null;
} {
  if (line.expectedQuantity !== null && line.countedQuantity !== null) {
    return { issue: line.expectedQuantity, receipt: line.countedQuantity };
  }
  return { issue: line.quantity, receipt: line.quantity };
}

/**
 * The movement half of the posting plan — ADR 0035. Pure: every input is on the snapshot, and the only
 * outputs are `PlannedMovement`s with `value: null` — §4.7.2's `applyMovements` fills `value`, and 3B
 * replaces how. (The wording avoids the literal "plan" followed by an open bracket: LEGACY-067's scan
 * refuses that shape anywhere in shipped source, because it is how the legacy procedures pinned a query
 * plan, and a doc comment is not exempt from a whole-file grep.)
 *
 * `quantity` is always a MAGNITUDE and `effect` is the sole carrier of direction, exactly as amendment A9
 * makes `side` the sole carrier for a planned ledger line. `PlannedMovement.quantity.isNegative()` is
 * therefore always false, and no consumer — 3B, 3D, 6A, 9B — may infer a direction from it.
 *
 * `movementNo` is 1-based per DOCUMENT and assigned in emission order (§4.4.2), which is why a `transfer`
 * line's two legs can share one `lineNo`: `(document_id, movement_no)` is the movement row's unique key.
 */
export function planMovements(
  policy: PostingPolicy,
  snapshot: DocumentSnapshot,
): PlannedMovement[] {
  const inv = policy.inventory;
  if (inv.effect === "none") return [];

  // §4.4.1's if/then requires `costing` for a stock-moving effect but admits the label "none", while
  // PlannedMovement.costing admits only consume_layers | create_layer | zero. A policy in that gap describes a
  // movement the costing engine cannot price, so it is refused at post rather than half-planned.
  const declaredCosting = inv.costing;
  if (declaredCosting === undefined || declaredCosting === "none") {
    throw new PolicyEvaluationError(
      "ERR_POLICY_INVALID",
      `${policy.documentType} declares inventory.effect "${inv.effect}" with costing "${declaredCosting ?? "absent"}"; a planned movement carries consume_layers, create_layer or zero`,
    );
  }

  // Rule 9, in one place so no branch below can apply half of it. `costing` follows the EMITTED effect —
  // §4.7.1's engine produces `newLayer` for a receipt and `consumptions` for an issue, so a movement whose
  // costing disagrees with its effect is a plan 3B cannot price. The one exception is `"zero"`, which is a
  // costing INSTRUCTION and not a direction: §4.7.1 reads it as the free-of-charge marker ("a value-less
  // issue with no open layers costs at zero only when costing = 'zero'", spec:1055), so deriving over it
  // would delete the signal.
  const costingFor = (emitted: "issue" | "receipt"): PlannedMovement["costing"] =>
    declaredCosting === "zero" ? "zero" : emitted === "issue" ? "consume_layers" : "create_layer";

  const movements: PlannedMovement[] = [];
  let movementNo = 0;

  for (const line of snapshot.lines) {
    if (line.itemId === null) continue;

    const item = snapshot.refs.items[line.itemId];
    if (item === undefined) {
      // Unreachable after 3A's migration 0032 (document_line_item_fk guarantees the row, and loadSnapshot
      // reads every distinct item_id) — asserted loudly rather than defaulted, because a missing ref would
      // otherwise plan a movement for an item whose kind and trackLots nobody knows.
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: item ${line.itemId} is not in the snapshot's item map`,
      );
    }
    if (item.kind !== "product") continue; // a service has no stock; an asset is Phase 10's register

    // 3D (ADR 0042): a line carrying BOTH count columns is a COUNTED line, and its `quantity` is the
    // derived variance `counted − expected`. An absent variance there is "the sheet matched", not a missing
    // number, so 3A's refusal stays exactly as it was for every line that is not counted.
    //
    // A count-SHEET line not yet counted — `expected_quantity` snapshotted, `counted_quantity` still null,
    // so `quantity` is null — is exempt too, outside a transfer: `recordCounts`' contract and
    // docs/runbooks/stock-count.md both say a line the counter never names "keeps its empty counted quantity
    // and posts nothing", which is what a cycle count posted in parts relies on. Only `snapshotCountSheet`
    // writes `expected_quantity` without `counted_quantity`; a line with neither is refused exactly as in 3A.
    const counted = line.countedQuantity !== null && line.expectedQuantity !== null;
    const uncountedSheetLine =
      inv.effect !== "transfer" && line.expectedQuantity !== null && line.countedQuantity === null;
    if (line.quantity === null && !counted && !uncountedSheetLine) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: quantity is required by ${policy.documentType}'s inventory.effect "${inv.effect}"`,
      );
    }
    // Behaviour 3: `app.inventory_movement` carries `check (quantity <> 0)` and has no null branch, so a
    // single-leg effect over a zero or absent quantity plans nothing at all (spec:1052). A `transfer` is
    // exempt HERE because its two legs carry their own quantities and are dropped one by one below — an
    // exact TRANSFER_RECEIPT has a zero variance and two full legs.
    if (inv.effect !== "transfer" && (line.quantity === null || line.quantity.isZero())) continue;

    const fromWarehouseId = resolveWarehouse(inv.warehouse ?? "header.warehouse", line, snapshot);
    if (fromWarehouseId === null) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: warehouse is required by ${policy.documentType} and neither the line nor the header carries one`,
      );
    }

    if (inv.effect === "transfer") {
      const toWarehouseId = resolveToWarehouse(
        inv.to_warehouse ?? "header.to_warehouse",
        line,
        snapshot,
      );
      if (toWarehouseId === null) {
        throw new PolicyEvaluationError(
          "ERR_POLICY_REQUIRES_MISSING",
          `line ${line.lineNo}: to_warehouse is required by ${policy.documentType} and neither the line nor the header carries one`,
        );
      }
      if (toWarehouseId === fromWarehouseId) {
        throw new PolicyEvaluationError(
          "ERR_POLICY_REQUIRES_MISSING",
          `line ${line.lineNo}: to_warehouse resolves to the same warehouse as warehouse (${fromWarehouseId}); a transfer needs two`,
        );
      }
      // The warehouse leg is always emitted first, whichever way the stock is going, so the numbering is a
      // property of the policy and not of the sign. Costing comes from `costingFor` — rule 9's one helper,
      // shared with the non-transfer branch below. 3D: the two legs resolve their quantities separately
      // (behaviour 4) and are oriented separately (behaviour 2), so a receipt variance is two movements of
      // different magnitude rather than a second effect the schema has no room for.
      const quantities = transferQuantities(line);
      const legs = [
        { declared: "issue" as const, warehouseId: fromWarehouseId, quantity: quantities.issue },
        { declared: "receipt" as const, warehouseId: toWarehouseId, quantity: quantities.receipt },
      ];
      for (const leg of legs) {
        if (leg.quantity === null || leg.quantity.isZero()) continue; // behaviour 3, per leg
        const oriented = orientLeg(leg.declared, leg.quantity);
        movements.push({
          lineNo: line.lineNo,
          movementNo: ++movementNo,
          itemId: item.id,
          warehouseId: leg.warehouseId,
          lotId: line.lotId,
          quantity: oriented.quantity,
          effect: oriented.effect,
          value: null,
          costing: costingFor(oriented.effect),
        });
      }
      continue;
    }

    // The guard above dropped every zero and every absent quantity that reaches a single-leg effect, so
    // this line has one. The re-test is the compiler's narrowing rather than a cast; it cannot be reached.
    const quantity = line.quantity;
    if (quantity === null) continue;
    const single = orientLeg(inv.effect, quantity);
    const effect = single.effect;

    // A line the policy DECLARES a receipt and that is EMITTING one, on a lot-tracked item, must name its
    // batch: the sentinel would silently pool two batches and the expiry report would then be wrong. Both
    // conditions are required so a reversal — declared receipt, emitting issue — never trips the gate, and
    // neither does a return, which is an issue policy emitting a receipt into the lot it came from.
    if (effect === "receipt" && inv.effect === "receipt" && item.trackLots && line.lotId === null) {
      throw new PolicyEvaluationError(
        "ERR_POLICY_REQUIRES_MISSING",
        `line ${line.lineNo}: lot is required by ${policy.documentType} for lot-tracked item ${item.code}`,
      );
    }

    movements.push({
      lineNo: line.lineNo,
      movementNo: ++movementNo,
      itemId: item.id,
      warehouseId: fromWarehouseId,
      lotId: line.lotId,
      quantity: single.quantity,
      effect,
      value: null,
      costing: costingFor(effect),
    });
  }

  return movements;
}
