// GENERATED FILE — do not edit by hand.
// Source: packages/domain/posting-policy.schema.json ($id urn:dulja:posting-policy:1)
// Regenerate: bun run --cwd packages/domain policy:types
export type AccountRef =
  | {
      from:
        | "line.account"
        | "party.receivable_account"
        | "party.payable_account"
        | "item.revenue_account"
        | "item.inventory_account"
        | "item.cogs_account"
        | "item.expense_account"
        | "tax_code.output_account"
        | "tax_code.input_account"
        | "line.component.expense_account"
        | "line.scheme.payable_account"
        | "line.scheme.expense_account"
        | "company.fx_rounding_account_id";
    }
  | {
      code: string;
    };
export type AmountRef =
  | "line.debit"
  | "line.credit"
  | "line.amount"
  | "line.total_excl_tax"
  | "line.total_incl_tax"
  | "line.tax_amount"
  | "line.cost"
  | "line.discount"
  | "line.variance_value"
  | "tax.amount"
  | "document.total_excl_tax"
  | "document.total_incl_tax"
  | "document.tax_total";
export type PermissionCodeOrNull = null | PermissionCode;
export type PermissionCode = string;

export interface PostingPolicy {
  version: 1;
  documentType: string;
  direction: "inbound" | "outbound" | "internal" | "none";
  requires: ("party" | "warehouse" | "to_warehouse" | "attributed_to" | "client_ref" | "reverses_document")[];
  lines: PolicyLine[];
  inventory: {
    effect: "issue" | "receipt" | "transfer" | "none";
    warehouse?: "header.warehouse" | "line.warehouse";
    to_warehouse?: "header.to_warehouse" | "line.to_warehouse";
    costing?: "consume_layers" | "create_layer" | "zero" | "none";
    allowNegative?: boolean;
  };
  tax: {
    applies: boolean;
    inclusive?: boolean | "header.tax_inclusive";
    einvoice?: boolean;
  };
  numbering: {
    series: string;
    assignAt: "issue";
  };
  reversal: {
    allowed: boolean;
    producesType: string | null;
  };
  approval: {
    required: boolean;
    approve: PermissionCodeOrNull;
    post: PermissionCode;
    create?: PermissionCode;
  };
  fxRoundingAccount: {
    from: "company.fx_rounding_account_id";
  };
  dimensions?: {
    required?: string[];
  };
}
export interface PolicyLine {
  for: "each_line" | "each_tax" | "document";
  side: "debit" | "credit";
  account: AccountRef;
  amount: AmountRef;
  when?: {
    "line.kind"?: "account" | "item" | "tax" | "text" | "tender" | "payroll";
    "line.tender_method"?: "cash" | "card" | "transfer" | "store_credit";
    "line.component.kind"?: "earning" | "deduction";
    "line.share"?: "employee" | "employer";
    "line.quantity_sign"?: "positive" | "negative";
    "item.kind"?: "product" | "service" | "asset";
    "document.kind"?: string;
  };
  dimensions?: {
    from?: ("line.dimensions" | "document.branch" | "line.employee")[];
  };
}
