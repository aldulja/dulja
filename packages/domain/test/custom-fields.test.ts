import { describe, expect, it } from "vitest";
import { validateCustomFieldValue, type CustomFieldDefinition } from "../src/index";

const def = (over: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  code: "F",
  kind: "text",
  required: false,
  options: {},
  ...over,
});

describe("validateCustomFieldValue", () => {
  it("validates text without trimming", () => {
    expect(validateCustomFieldValue(def({ kind: "text" }), " hello ")).toEqual({
      ok: true,
      value: " hello ",
    });
    expect(
      validateCustomFieldValue(def({ kind: "text", options: { maxLength: 3 } }), "hello"),
    ).toEqual({ ok: false, errors: [{ path: "F", message: "must be at most 3 characters" }] });
    expect(validateCustomFieldValue(def({ kind: "text" }), 5).ok).toBe(false);
  });

  it("accepts only finite integers", () => {
    expect(validateCustomFieldValue(def({ kind: "integer" }), 42)).toEqual({ ok: true, value: 42 });
    for (const bad of [1.5, "42", Number.NaN, Number.POSITIVE_INFINITY])
      expect(validateCustomFieldValue(def({ kind: "integer" }), bad).ok).toBe(false);
  });

  it("uses strings for scaled decimals", () => {
    expect(
      validateCustomFieldValue(def({ kind: "decimal", options: { scale: 2 } }), "12.34"),
    ).toEqual({ ok: true, value: "12.34" });
    expect(
      validateCustomFieldValue(def({ kind: "decimal", options: { scale: 2 } }), "12.345").ok,
    ).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "decimal" }), 12.34)).toEqual({
      ok: false,
      errors: [{ path: "F", message: "must be a decimal string, not a number" }],
    });
  });

  it("validates a zero-scale decimal as an integer string without throwing", () => {
    const definition = def({ kind: "decimal", options: { scale: 0 } });
    for (const value of ["0", "12", "-12"]) {
      expect(validateCustomFieldValue(definition, value)).toEqual({ ok: true, value });
    }
    for (const value of ["12.0", "12.5", "1e2", "", 12]) {
      expect(validateCustomFieldValue(definition, value).ok).toBe(false);
    }
  });

  it("normalises money through Money", () => {
    expect(
      validateCustomFieldValue(def({ kind: "money" }), { amount: "12.5", currency: "MYR" }),
    ).toEqual({ ok: true, value: { amount: "12.5000", currency: "MYR" } });
    expect(
      validateCustomFieldValue(def({ kind: "money" }), { amount: "12.12345", currency: "MYR" }).ok,
    ).toBe(false);
    expect(
      validateCustomFieldValue(def({ kind: "money" }), { amount: "1.0000", currency: "myr" }).ok,
    ).toBe(false);
  });

  it("accepts real ISO dates only", () => {
    expect(validateCustomFieldValue(def({ kind: "date" }), "2026-02-28")).toEqual({
      ok: true,
      value: "2026-02-28",
    });
    expect(validateCustomFieldValue(def({ kind: "date" }), "2026-02-30").ok).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "date" }), "28/02/2026").ok).toBe(false);
  });

  it("validates booleans and dimension ids", () => {
    expect(validateCustomFieldValue(def({ kind: "boolean" }), false)).toEqual({
      ok: true,
      value: false,
    });
    expect(validateCustomFieldValue(def({ kind: "boolean" }), "false").ok).toBe(false);
    const id = "01920000-0000-7000-8000-000000000001";
    expect(validateCustomFieldValue(def({ kind: "dimension_value" }), id)).toEqual({
      ok: true,
      value: id,
    });
    expect(validateCustomFieldValue(def({ kind: "dimension_value" }), "not-a-uuid").ok).toBe(false);
  });

  it("accepts declared enum labels only", () => {
    const definition = def({ kind: "enum", options: { enumValues: ["low", "high"] } });
    expect(validateCustomFieldValue(definition, "high")).toEqual({ ok: true, value: "high" });
    expect(validateCustomFieldValue(definition, "medium")).toEqual({
      ok: false,
      errors: [{ path: "F", message: "must be one of: low, high" }],
    });
    expect(validateCustomFieldValue(def({ kind: "enum" }), "x").ok).toBe(false);
  });

  it("enforces required while accepting null for optional fields", () => {
    expect(validateCustomFieldValue(def({ required: true }), null)).toEqual({
      ok: false,
      errors: [{ path: "F", message: "is required" }],
    });
    expect(validateCustomFieldValue(def({}), null)).toEqual({ ok: true, value: null });
  });
});
