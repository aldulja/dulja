// packages/domain/src/tax/pack-schema.ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import taxPackSchema from "../../tax-pack.schema.json" with { type: "json" };

export interface TaxPackValidation {
  ok: boolean;
  errors: { path: string; message: string }[];
}

let compiled: ValidateFunction | undefined;
/** Compiled on first use, not at import, for `posting/evaluate.ts`'s reason: the desktop renderers' CSP refuses
 *  the `new Function` Ajv compiles with, and they import this barrel. */
const taxPackValidator = (): ValidateFunction =>
  (compiled ??= new Ajv2020({ allErrors: true, strict: true, useDefaults: false }).compile(
    taxPackSchema,
  ));

const toErrors = (errors: ErrorObject[] | null | undefined): { path: string; message: string }[] =>
  (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: `${e.message ?? "is invalid"}${
      e.params && "additionalProperty" in e.params
        ? ` (${String(e.params.additionalProperty)})`
        : ""
    }`,
  }));

/**
 * Validates ONE tax sub-pack file — a regime manifest or a codes manifest — against
 * `tax-pack.schema.json`'s `oneOf`. Returns a report rather than throwing, the `PolicyValidation` shape
 * §4.4.2 already uses, so `taxLoader` can name the file and the JSON path in one `SeedError`.
 *
 * The `oneOf` means a file that satisfies NEITHER branch reports both branches' failures. That is the
 * intended noise: the commonest fault is a codes manifest saved under a `.regime.json` name, and a reader
 * needs to see which shape was expected.
 */
export function validateTaxPack(file: unknown): TaxPackValidation {
  const validate = taxPackValidator();
  if (!validate(file)) return { ok: false, errors: toErrors(validate.errors) };
  return { ok: true, errors: [] };
}
