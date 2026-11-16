import { isCalendarDate } from "../calendar-date";
import { currency, Money } from "../money/money";
import type { CustomFieldDefinition, ValidationResult } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (code: string, message: string): ValidationResult => ({
  ok: false,
  errors: [{ path: code, message }],
});
const pass = (value: unknown): ValidationResult => ({ ok: true, value });

export function validateCustomFieldValue(
  def: CustomFieldDefinition,
  value: unknown,
): ValidationResult {
  if (value === null || value === undefined)
    return def.required ? fail(def.code, "is required") : pass(null);

  switch (def.kind) {
    case "text": {
      if (typeof value !== "string") return fail(def.code, "must be a string");
      const max = def.options.maxLength;
      if (max !== undefined && value.length > max)
        return fail(def.code, `must be at most ${max} characters`);
      return pass(value);
    }
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? pass(value)
        : fail(def.code, "must be an integer");
    case "decimal": {
      if (typeof value === "number")
        return fail(def.code, "must be a decimal string, not a number");
      if (typeof value !== "string") return fail(def.code, "must be a decimal string");
      const scale = def.options.scale ?? 2;
      const pattern = scale === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`);
      return pattern.test(value)
        ? pass(value)
        : fail(def.code, `must be a decimal string with at most ${scale} decimal places`);
    }
    case "money": {
      if (typeof value !== "object" || value === null)
        return fail(def.code, "must be { amount, currency }");
      const wire = value as { amount?: unknown; currency?: unknown };
      if (typeof wire.amount !== "string" || typeof wire.currency !== "string")
        return fail(def.code, "must be { amount, currency }");
      try {
        return pass(Money.of(wire.amount, currency(wire.currency)).toJSON());
      } catch {
        return fail(
          def.code,
          "must be an amount with at most 4 decimal places and a three-letter currency code",
        );
      }
    }
    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value))
        return fail(def.code, "must be a date as YYYY-MM-DD");
      return isCalendarDate(value) ? pass(value) : fail(def.code, "must be a real calendar date");
    }
    case "boolean":
      return typeof value === "boolean" ? pass(value) : fail(def.code, "must be true or false");
    case "dimension_value":
      return typeof value === "string" && UUID.test(value)
        ? pass(value)
        : fail(def.code, "must be a dimension value id");
    case "enum": {
      const values = def.options.enumValues;
      if (!values || values.length === 0)
        return fail(def.code, "the definition declares no enum values");
      return typeof value === "string" && values.includes(value)
        ? pass(value)
        : fail(def.code, `must be one of: ${values.join(", ")}`);
    }
  }
}
