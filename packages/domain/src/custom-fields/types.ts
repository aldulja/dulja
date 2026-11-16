export type CustomFieldKind =
  | "text"
  | "integer"
  | "decimal"
  | "money"
  | "date"
  | "boolean"
  | "dimension_value"
  | "enum";

export interface CustomFieldOptions {
  readonly enumValues?: string[];
  readonly scale?: number;
  readonly dimensionTypeId?: string;
  readonly maxLength?: number;
}
export interface CustomFieldDefinition {
  readonly code: string;
  readonly kind: CustomFieldKind;
  readonly required: boolean;
  readonly options: CustomFieldOptions;
}
export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly errors: readonly { readonly path: string; readonly message: string }[];
    };
