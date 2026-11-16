import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schema from "./rate-table.schema.json" with { type: "json" };
import type { RateTable } from "./rate-table";

export const RATE_TABLE_SCHEMA_ID = "urn:dulja:rate-table:1";

export interface RateTableValidation {
  ok: boolean;
  errors: { path: string; message: string }[];
}

/** Carries the same `errors` array `validateRateTable` returns — JSON Pointers into the rejected definition. */
export class RateTableValidationError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly errors: { path: string; message: string }[]) {
    super(`rate table is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
    this.name = "RateTableValidationError";
  }
}

/** A calendar date, `YYYY-MM-DD`, that exists (2026-02-30 does not). */
const isDate = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
};

/** An absolute URI with a scheme. `URL` is the WHATWG parser every runtime here ships. */
const isUri = (value: string): boolean => {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
};

// Compiled on first use, never at import — the rule every validator in this package follows (Ajv compiles with
// `new Function`; test/lazy-schemas.test.ts explains why). The schema's two formats are registered here rather than
// through ajv-formats, which this package does not depend on: §4.12.3 declares `date` and `uri`, and a format Ajv
// does not know is a compile error under `strict`, so ignoring them is not an option either.
let compiled: ValidateFunction<RateTable> | undefined;
const validator = (): ValidateFunction<RateTable> =>
  (compiled ??= new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
    .addFormat("date", isDate)
    .addFormat("uri", isUri)
    .compile<RateTable>(schema));

/** An additionalProperties error points at the parent, so the offending key is appended (the report validator's
 *  rule, LEGACY-084: name the specific offending entity). */
function pointerOf(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") {
    const extra = (e.params as { additionalProperty: string }).additionalProperty;
    return `${e.instancePath}/${extra}`;
  }
  return e.instancePath === "" ? "/" : e.instancePath;
}

/** `errors[i].path` is a JSON Pointer into the rejected definition, the shape §4.2.4's `Problem.errors[]` carries
 *  for ERR_VALIDATION_FAILED. */
export function validateRateTable(definition: unknown): RateTableValidation {
  const validate = validator();
  if (validate(definition)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => ({
      path: pointerOf(e),
      message: e.message ?? e.keyword,
    })),
  };
}

/** The definition, typed — or a RateTableValidationError carrying every fault. Never `any`. */
export function parseRateTable(definition: unknown): RateTable {
  const v = validateRateTable(definition);
  if (!v.ok) throw new RateTableValidationError(v.errors);
  return definition as RateTable;
}
