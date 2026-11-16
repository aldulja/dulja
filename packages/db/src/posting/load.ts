import {
  currency,
  Money,
  parsePolicy,
  PolicyEvaluationError,
  Quantity,
  UNIT_RATE,
  type DocumentSnapshot,
  type ExchangeRate,
  type ItemRef,
  type LineSnapshot,
  type PayComponentRef,
  type PayrollLineRef,
  type PostingPolicy,
  type SchemeRef,
} from "@dulja/domain";
import type { Sql } from "postgres";
import { PostingError } from "./errors";

import { loadTaxCodeRefs, resolvePosReturnTaxSource } from "../tax/codes";

/** §4.6.5's four tender methods — the only values `loadSnapshot` lifts into `LineSnapshot.tenderMethod`. */
const TENDER_METHODS = new Set(["cash", "card", "transfer", "store_credit"]);

interface HeaderRow {
  tax_inclusive: boolean;
  id: string;
  company_id: string;
  document_type_id: string;
  document_type_code: string;
  status: string;
  series: string;
  fiscal_period_id: string | null;
  number: string | null;
  effective_date: string;
  party_id: string | null;
  currency: string;
  exchange_rate: string;
  rate_source: string | null;
  reverses_document_id: string | null;
  client_ref: string | null;
  branch_id: string;
  attributed_to: string | null;
  base_currency: string;
  fx_rounding_account_id: string | null;
  // 3B: migration 0035's column (OD-06). CHECK-bounded to 'avco' | 'fifo'.
  costing_method: string;
  // 3A: migration 0031's two header columns (contracts §4.3.4). A JOURNAL has neither.
  warehouse_id: string | null;
  to_warehouse_id: string | null;
  // 2A: the party's own columns, through a LEFT JOIN — a JOURNAL has no party and all three stay null.
  party_kind: string | null;
  party_receivable: string | null;
  party_payable: string | null;
}
interface LineRow {
  id: string;
  line_no: number;
  description: string | null;
  account_id: string | null;
  debit: string;
  credit: string;
  dimensions: Record<string, string>;
  custom_fields: Record<string, unknown>;
  // 2A: migration 0019's ten columns.
  kind: string;
  item_id: string | null;
  quantity: string | null;
  unit_price: string | null;
  discount: string;
  amount: string;
  tax_code_id: string | null;
  tax_amount: string;
  total_incl_tax: string;
  cost: string | null;
  // 3A: migration 0032's four columns (contracts §4.3.4). There is deliberately no to_warehouse_id.
  warehouse_id: string | null;
  lot_id: string | null;
  unit_id: string | null;
  unit_quantity: string | null;
  // 3D: migration 0040's two columns (contracts §4.3.4). Only a STOCK_COUNT or TRANSFER_RECEIPT line
  // carries them; on such a line `quantity` is the signed variance.
  counted_quantity: string | null;
  expected_quantity: string | null;
}

/** contracts §4.4.2's shape. 1A declared it at its final shape and filled the Phase 1 subset; 2A fills the
 *  eleven fields its migrations 0017–0019 add columns for (contracts §4.3.1). Every `null`/`{}`/literal that
 *  remains below is a column a later slice adds — the slice is named on the line. */
export async function loadSnapshot(tx: Sql, documentId: string): Promise<DocumentSnapshot> {
  const [header] = await tx<HeaderRow[]>`
    select d.id, d.company_id, d.document_type_id, t.code as document_type_code, d.status::text as status,
           d.series, d.fiscal_period_id, d.number::text as number, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
           d.tax_inclusive, d.party_id, d.currency, d.exchange_rate::text as exchange_rate, d.rate_source,
           d.reverses_document_id, d.client_ref::text as client_ref, d.branch_id, d.attributed_to,
           d.warehouse_id, d.to_warehouse_id,
           c.base_currency, c.fx_rounding_account_id, c.costing_method,
           pt.kind as party_kind, pt.receivable_account_id as party_receivable, pt.payable_account_id as party_payable
      from app.document d
      join app.document_type t on t.id = d.document_type_id
      join app.company c       on c.id = d.company_id
      left join app.party pt   on pt.id = d.party_id
     where d.id = ${documentId}`;
  if (!header) throw new PostingError("ERR_NOT_FOUND", `no document ${documentId} in this tenant`);

  const docCurrency = currency(header.currency.trim());
  const baseCurrency = currency(header.base_currency.trim());
  const exchangeRate: ExchangeRate =
    docCurrency === baseCurrency
      ? { ...UNIT_RATE(baseCurrency), effectiveFrom: header.effective_date }
      : {
          from: docCurrency,
          to: baseCurrency,
          // Already "4.68350000" — ::text preserves numeric(19,8)'s scale; a parseFloat here would be
          // SAH-012 in the new system.
          rate: header.exchange_rate,
          effectiveFrom: header.effective_date,
          source: header.rate_source ?? "unknown",
        };

  // The party join above is on `pt.id` alone and not `(pt.tenant_id, pt.id)`: app.party carries a FORCED
  // tenant_isolation policy, so a cross-tenant row is invisible to this session in the first place, and
  // document_party_fk (migration 0018) makes the pair impossible to write.
  const lineRows = await tx<LineRow[]>`
    select id, line_no, description, account_id, debit::text as debit, credit::text as credit,
           dimensions, custom_fields, kind, item_id,
           quantity::text as quantity, unit_price::text as unit_price, discount::text as discount,
           amount::text as amount, tax_code_id, tax_amount::text as tax_amount,
           total_incl_tax::text as total_incl_tax, cost::text as cost,
           warehouse_id, lot_id, unit_id, unit_quantity::text as unit_quantity,
           counted_quantity::text as counted_quantity, expected_quantity::text as expected_quantity
      from app.document_line where document_id = ${documentId} order by line_no`;
  // 8B (contracts round 17, A11). One query for the whole document, keyed by document_line_id.
  // `employeeDimensionValueId` is resolved HERE rather than in the evaluator because the evaluator is pure and has
  // no source for an id — the same reason `PlannedMovement.lotId` is resolved in `applyMovements`. A document with
  // no payroll_line rows (every type but PAYROLL) gets an empty map and `payroll: null` on every line.
  const payrollRows = await tx<
    {
      document_line_id: string;
      employee_id: string;
      dimension_value_id: string | null;
      component_id: string | null;
      scheme_id: string | null;
      share: "employee" | "employer" | null;
    }[]
  >`
    select pl.document_line_id, pl.employee_id, dv.id as dimension_value_id,
           pl.component_id, pl.scheme_id, pl.share
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      left join app.employee e         on e.id = pl.employee_id and e.company_id = pl.company_id
      left join app.dimension_type dt  on dt.company_id = pl.company_id and dt.code = 'EMPLOYEE'
      left join app.dimension_value dv on dv.dimension_type_id = dt.id and dv.code = e.employee_number
     where dl.document_id = ${documentId}`;
  const payrollByLine = new Map<string, PayrollLineRef>();
  for (const r of payrollRows) {
    if (r.dimension_value_id === null) {
      // Fail closed and NAME it. A payroll line whose employee has no EMPLOYEE dimension value would post
      // untagged, and spec:2101 makes the per-employee payable a ledger projection — an untagged line silently
      // breaks every downstream schedule. `ensureEmployeeDimensionValue` (8B T2) is the repair and
      // `calculatePayrollRun` calls it per employee, so reaching here means a line was written by hand (or the
      // employee is not visible to this session under 6C's branch_isolation).
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `payroll line ${r.document_line_id} names employee ${r.employee_id}, which has no EMPLOYEE dimension value ` +
          "visible to this session; call ensureEmployeeDimensionValue before drafting the line (contracts §4.12.7)",
      );
    }
    payrollByLine.set(r.document_line_id, {
      employeeId: r.employee_id,
      employeeDimensionValueId: r.dimension_value_id,
      componentId: r.component_id,
      schemeId: r.scheme_id,
      share: r.share,
    });
  }

  const lines: LineSnapshot[] = lineRows.map((row) => ({
    id: row.id,
    lineNo: row.line_no,
    kind: row.kind as LineSnapshot["kind"],
    description: row.description,
    accountId: row.account_id,
    itemId: row.item_id,
    quantity: row.quantity === null ? null : Quantity.of(row.quantity),
    unitPrice: row.unit_price === null ? null : Money.of(row.unit_price, docCurrency),
    discount: Money.of(row.discount, docCurrency),
    amount: Money.of(row.amount, docCurrency),
    taxCodeId: row.tax_code_id,
    taxAmount: Money.of(row.tax_amount, docCurrency),
    totalInclTax: Money.of(row.total_incl_tax, docCurrency),
    debit: Money.of(row.debit, docCurrency),
    credit: Money.of(row.credit, docCurrency),
    // 3B / amendment A4: cost is BASE currency, matching inventory_movement.value (contracts §4.7.3).
    // null ≠ zero, still — amendment A5 depends on the distinction.
    cost: row.cost === null ? null : Money.of(row.cost, baseCurrency),
    warehouseId: row.warehouse_id,
    // No document_line.to_warehouse_id column exists (§4.3.4's 3A row adds four columns and not this one).
    // planMovements falls back to header.toWarehouseId; 3D adds the column if a per-line destination arrives.
    toWarehouseId: null,
    lotId: row.lot_id,
    unitId: row.unit_id,
    unitQuantity: row.unit_quantity === null ? null : Quantity.of(row.unit_quantity),
    // 3D / migration 0040 — `::text` on a numeric(19,6) is already the fixed 6-dp string Quantity.of
    // takes (contracts §4.2.1), so no formatting step stands between the column and the snapshot.
    countedQuantity: row.counted_quantity === null ? null : Quantity.of(row.counted_quantity),
    expectedQuantity: row.expected_quantity === null ? null : Quantity.of(row.expected_quantity),
    // §4.4.2 (6A Task 10 Step 3): the `when` filter's `line.tender_method` reads this TYPED field, never the
    // untyped bag. An absent or unknown method lifts to null, matches no rule and fails the balance check.
    tenderMethod:
      row.kind === "tender" && TENDER_METHODS.has(String(row.custom_fields["method"]))
        ? (row.custom_fields["method"] as LineSnapshot["tenderMethod"])
        : null,
    customFields: row.custom_fields,
    dimensions: row.dimensions,
    // 8B (§4.12.6): the line's payroll_line row, or null for a line that has none.
    payroll: payrollByLine.get(row.id) ?? null,
  }));

  // 2A: 0D's custom_field_value, keyed by the DEFINITION's code — which is what the evaluator's
  // `when: { "document.kind": … }` reads (amendment A6). The definition's company must be the document's:
  // custom_field_value has no company key of its own, RLS bounds the tenant only, and a value another company
  // of the tenant wrote against this document's id must not steer this company's posting.
  const customFieldRows = await tx<{ code: string; value: unknown }[]>`
    select d.code, v.value
      from app.custom_field_value v
      join app.custom_field_definition d on d.id = v.definition_id
     where v.entity_id = ${documentId} and d.entity = 'document' and d.company_id = ${header.company_id}`;

  const accountRows = await tx<{ code: string; id: string }[]>`
    select code, id from app.account
     where company_id = ${header.company_id} and is_group = false and archived_at is null`;
  const dimensionRows = await tx<{ code: string; id: string }[]>`
    select code, id from app.dimension_type where company_id = ${header.company_id}`;

  // 8B (contracts round 17, A11). `PayComponentRef` and `SchemeRef` are declared IN CORE
  // (packages/domain/src/posting/evaluate.ts, §4.4.2) precisely so `packages/domain/src/**` never imports
  // `packages/domain/payroll/**` (spec:2366); these queries produce those structural shapes. Company-scoped, not
  // line-scoped, exactly as `accountsByCode` is: a pay-component catalogue is dozens of rows, and the maps stay
  // empty for a company with no HR rows. An archived component is left out, so a policy rule that resolves through
  // one refuses with ERR_POLICY_REQUIRES_MISSING rather than posting to a retired component's account.
  const componentRows = await tx<
    {
      id: string;
      code: string;
      kind: "earning" | "deduction";
      expense_account_id: string | null;
      payable_account_id: string | null;
    }[]
  >`
    select id, code, kind, expense_account_id, payable_account_id
      from app.pay_component
     where company_id = ${header.company_id} and archived_at is null`;
  const components: Record<string, PayComponentRef> = {};
  for (const r of componentRows) {
    components[r.id] = {
      id: r.id,
      code: r.code,
      kind: r.kind,
      expenseAccountId: r.expense_account_id,
      payableAccountId: r.payable_account_id,
    };
  }
  // `statutory_scheme.payable_account_id` is nullable in 8A's DDL (8B's seed wires it) while `SchemeRef`'s is not:
  // a scheme with no payable account is left OUT of the map, so every rule resolving through it refuses with
  // ERR_POLICY_REQUIRES_MISSING — the same outcome the evaluator gives a null account — and no type is widened.
  const schemeRows = await tx<
    {
      id: string;
      code: string;
      payable_account_id: string;
      employer_expense_account_id: string | null;
    }[]
  >`
    select id, code, payable_account_id, employer_expense_account_id
      from app.statutory_scheme
     where company_id = ${header.company_id} and payable_account_id is not null`;
  const schemes: Record<string, SchemeRef> = {};
  for (const r of schemeRows) {
    schemes[r.id] = {
      id: r.id,
      code: r.code,
      payableAccountId: r.payable_account_id,
      expenseAccountId: r.employer_expense_account_id,
    };
  }

  // 3A: the items the lines name, read by row id. `= any(…)` on an empty array is legal but pointless,
  // so an all-account document issues no query at all.
  const itemIds = [
    ...new Set(lineRows.map((r) => r.item_id).filter((v): v is string => v !== null)),
  ];
  const itemRows =
    itemIds.length === 0
      ? []
      : await tx<
          {
            id: string;
            code: string;
            kind: string;
            base_unit_id: string;
            track_lots: boolean;
            revenue_account_id: string | null;
            inventory_account_id: string | null;
            cogs_account_id: string | null;
            expense_account_id: string | null;
          }[]
        >`
          select id, code, kind, base_unit_id, track_lots,
                 revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id
            from app.item where id = any(${itemIds})`;

  return {
    header: {
      id: header.id,
      companyId: header.company_id,
      documentTypeCode: header.document_type_code,
      status: header.status as DocumentSnapshot["header"]["status"],
      series: header.series,
      fiscalPeriodId: header.fiscal_period_id,
      number: header.number === null ? null : BigInt(header.number),
      effectiveDate: header.effective_date,
      partyId: header.party_id,
      currency: docCurrency,
      exchangeRate,
      branchId: header.branch_id,
      attributedTo: header.attributed_to,
      clientRef: header.client_ref,
      // 3A's migration 0031.
      warehouseId: header.warehouse_id,
      toWarehouseId: header.to_warehouse_id,
      // 5A's migration 0054.
      taxInclusive: header.tax_inclusive,
      reversesDocumentId: header.reverses_document_id,
      customFields: Object.fromEntries(customFieldRows.map((row) => [row.code, row.value])),
    },
    lines,
    company: {
      id: header.company_id,
      baseCurrency,
      fxRoundingAccountId: header.fx_rounding_account_id,
      // 3B / migration 0035 — the last 2A stub (contracts §4.3.1). The cast is the same shape 2A used for
      // `h.status` and `h.party_kind`: the column's CHECK is the guarantee, and runtime re-validation of a
      // two-label CHECK would be noise.
      costingMethod: header.costing_method as "avco" | "fifo",
    },
    // 2A: app.party, through the LEFT JOIN above. `party_kind` is non-null exactly when `party_id` is, so the
    // non-null assertion is sound; the two account links are legitimately nullable columns.
    party:
      header.party_id === null
        ? null
        : {
            id: header.party_id,
            kind: header.party_kind! as "customer" | "vendor" | "employee" | "student" | "dealer",
            receivableAccountId: header.party_receivable,
            payableAccountId: header.party_payable,
            creditLimit: null, // 4A's migration 0045 adds party.credit_limit
          },
    refs: {
      accountsByCode: Object.fromEntries(accountRows.map((row) => [row.code, row.id])),
      // §4.4.2: refs.items is keyed by the ROW ID (the document_line.item_id value), never by code, so the
      // evaluator never does a second lookup. ItemRef.kind is total because app.item.kind is NOT NULL (§4.6.1).
      items: Object.fromEntries(
        itemRows.map((r) => [
          r.id,
          {
            id: r.id,
            code: r.code,
            kind: r.kind as ItemRef["kind"],
            baseUnitId: r.base_unit_id,
            trackLots: r.track_lots,
            revenueAccountId: r.revenue_account_id,
            inventoryAccountId: r.inventory_account_id,
            cogsAccountId: r.cogs_account_id,
            expenseAccountId: r.expense_account_id,
          },
        ]),
      ),
      taxCodes: await loadTaxCodeRefs(
        tx,
        header.company_id,
        header.effective_date,
        header.reverses_document_id ?? (await resolvePosReturnTaxSource(tx, documentId)),
      ),
      components,
      schemes,
      dimensionTypesByCode: Object.fromEntries(dimensionRows.map((row) => [row.code, row.id])),
    },
  };
}

/** The policy effective for a document: the greatest effective_from <= effectiveDate, ties broken by the
 *  highest version (spec:2172, contracts §4.3.1). The definition is parsed against the schema on the way out,
 *  so a hand-edited or stale row is refused rather than evaluated (SAH-013). */
export async function resolvePolicy(
  tx: Sql,
  documentTypeId: string,
  effectiveDate: string,
): Promise<{ policyId: string; definition: PostingPolicy }> {
  const [row] = await tx<{ id: string; version: number; definition: unknown }[]>`
    select id, version, definition from app.posting_policy
     where document_type_id = ${documentTypeId} and effective_from <= ${effectiveDate}::date
     order by effective_from desc, version desc
     limit 1`;
  if (!row) {
    throw new PostingError(
      "ERR_POLICY_NOT_FOUND",
      `no posting policy for document type ${documentTypeId} effective on ${effectiveDate}`,
    );
  }
  try {
    return { policyId: row.id, definition: parsePolicy(row.definition) };
  } catch (error) {
    if (error instanceof PolicyEvaluationError) {
      throw new PostingError(
        "ERR_POLICY_INVALID",
        `posting policy ${row.id} (version ${row.version}) is invalid: ${error.detail}`,
      );
    }
    throw error;
  }
}
