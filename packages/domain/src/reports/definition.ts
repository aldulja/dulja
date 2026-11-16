// GENERATED FILE — do not edit by hand.
// Source: packages/domain/report-definition.schema.json ($id urn:dulja:report-definition:1)
// Regenerate: bun run --cwd packages/domain report:types
export interface ReportDefinition {
  version: 1;
  code: string;
  nameEn: string;
  nameAr: string;
  module: "accounting" | "inventory" | "hr" | "pos";
  permission: string;
  parameters: Parameter[];
  dataset: {
    source: string;
    filters: Filter[];
  };
  /**
   * @minItems 1
   */
  columns: [Column, ...Column[]];
  groups: Group[];
  totals: Total[];
  sort: SortKey[];
  layout: {
    orientation: "portrait" | "landscape";
    paper: "A4" | "A5" | "receipt";
    header: string;
    footer: string;
  };
  tieOut: {
    kind: "ledger_sum" | "projection" | "none";
    account?: string;
    projection?: string;
  };
}
export interface Parameter {
  name: string;
  kind:
    | "date"
    | "date_range"
    | "period"
    | "account"
    | "party"
    | "item"
    | "warehouse"
    | "branch"
    | "dimension_value"
    | "enum"
    | "text";
  required: boolean;
  /**
   * @minItems 1
   */
  options?: [string, ...string[]];
}
export interface Filter {
  field: string;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "like";
  param: string;
}
export interface Column {
  field: string;
  labelEn: string;
  labelAr: string;
  format: "text" | "money" | "quantity" | "date" | "integer" | "percent";
  align: "start" | "end";
  width?: number;
}
export interface Group {
  field: string;
  subtotal: boolean;
}
export interface Total {
  field: string;
  fn: "sum" | "count" | "avg";
}
export interface SortKey {
  field: string;
  dir: "asc" | "desc";
}
