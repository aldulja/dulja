import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schema from "../../report-definition.schema.json" with { type: "json" };
import { NUMERIC_COLUMN_FORMATS, REPORT_CODE_PATTERN, type ReportColumnFormat } from "./codes";
import type { ReportDefinition } from "./definition";
import { ReportDefinitionError } from "./error";

export interface ReportDefinitionValidation {
  ok: boolean;
  errors: { path: string; message: string }[];
}

export interface ReportDefinitionSets {
  /** Every member of `DatasetId` whose owning slice has shipped — `new Set(DATASET_IDS)` at the db tier. */
  readonly datasets: ReadonlySet<string>;
  /** Every permission code in `app.permission` — the F-21 rule: a definition may not name a code no slice seeded. */
  readonly permissions: ReadonlySet<string>;
}

// Compiled on first use, once per process, never at import — the same rule as the posting-policy, seed,
// tax-pack and e-invoice-profile validators: Ajv compiles with `new Function`, and the desktop renderers run
// under a CSP with no `'unsafe-eval'` (`test/lazy-schemas.test.ts` pins it).
let compiled: ValidateFunction<ReportDefinition> | undefined;
const validator = (): ValidateFunction<ReportDefinition> =>
  (compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile<ReportDefinition>(schema));

/** Ajv's instancePath is already a JSON Pointer; an additionalProperties error points at the parent, so the
 *  offending key is appended to make the message actionable (LEGACY-084: name the specific offending entity). */
function pointerOf(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") {
    const extra = (e.params as { additionalProperty: string }).additionalProperty;
    return `${e.instancePath}/${extra}`;
  }
  return e.instancePath === "" ? "/" : e.instancePath;
}

function schemaErrors(
  errors: ErrorObject[] | null | undefined,
): { path: string; message: string }[] {
  return (errors ?? []).map((e) => ({ path: pointerOf(e), message: e.message ?? e.keyword }));
}

/** Schema + grammar + the two closed sets + internal referential integrity. `errors[]` entries are JSON
 *  Pointers into the rejected definition, sorted by path. The two closed sets arrive as parameters because
 *  `DatasetId` lives in `packages/db` and `PermissionCode` in `packages/contracts` (§3.1, ADR 0065). */
export function validateReportDefinition(
  definition: unknown,
  sets: ReportDefinitionSets,
): ReportDefinitionValidation {
  const validate = validator();
  if (!validate(definition)) return { ok: false, errors: schemaErrors(validate.errors) };
  const def = definition;
  const errors: { path: string; message: string }[] = [];

  // 1. the module must agree with the code's first segment (§4.16.1)
  const codeModule = REPORT_CODE_PATTERN.exec(def.code)?.[1];
  if (codeModule !== def.module) {
    errors.push({
      path: "/module",
      message: `module '${def.module}' disagrees with code '${def.code}' (contracts §4.16.1)`,
    });
  }

  // 2. the two closed sets — never inside the schema, because a schema cannot know which slices have shipped
  if (!sets.datasets.has(def.dataset.source)) {
    errors.push({
      path: "/dataset/source",
      message: `dataset '${def.dataset.source}' is not a member of the closed DatasetId registry (contracts §4.16.2)`,
    });
  }
  if (!sets.permissions.has(def.permission)) {
    errors.push({
      path: "/permission",
      message: `permission '${def.permission}' is not in the permission catalogue`,
    });
  }

  // 3. parameter names are unique, and an enum parameter must offer options
  const seenParams = new Set<string>();
  def.parameters.forEach((p, i) => {
    if (seenParams.has(p.name)) {
      errors.push({
        path: `/parameters/${i}/name`,
        message: `parameter '${p.name}' is declared twice`,
      });
    }
    seenParams.add(p.name);
    if (p.kind === "enum" && (p.options === undefined || p.options.length === 0)) {
      errors.push({
        path: `/parameters/${i}/options`,
        message: `enum parameter '${p.name}' declares no options`,
      });
    }
  });

  // 4. column fields are unique, and every group / total field is one of them. A SORT key need not be a
  //    column (Phase 7 remediation, ADR 0065 amendment): a report orders by a field it does not print — the
  //    ageing's `bucket_rank`, a statement's `section_rank`. Whether the key exists is a property of the
  //    dataset, which this package cannot see; `assertDefinitionFields` (packages/db) refuses an unknown one at
  //    save and seed, and `columnOf` at run time.
  const formatOf = new Map<string, ReportColumnFormat>();
  def.columns.forEach((c, i) => {
    if (formatOf.has(c.field)) {
      errors.push({
        path: `/columns/${i}/field`,
        message: `column '${c.field}' is declared twice`,
      });
    }
    formatOf.set(c.field, c.format);
  });
  def.groups.forEach((g, i) => {
    if (!formatOf.has(g.field)) {
      errors.push({
        path: `/groups/${i}/field`,
        message: `group field '${g.field}' is not one of this definition's columns`,
      });
    }
  });
  def.totals.forEach((t, i) => {
    const format = formatOf.get(t.field);
    if (format === undefined) {
      errors.push({
        path: `/totals/${i}/field`,
        message: `total field '${t.field}' is not one of this definition's columns`,
      });
      return;
    }
    if (t.fn !== "count" && !NUMERIC_COLUMN_FORMATS.includes(format)) {
      errors.push({
        path: `/totals/${i}/fn`,
        message: `total fn '${t.fn}' needs a money, quantity, integer or percent column; '${t.field}' is ${format}`,
      });
    }
  });

  // 5. every filter must name a declared parameter — this is what makes a value a bound parameter and never
  //    text spliced into SQL (test 27, LEGACY-069's root cause)
  def.dataset.filters.forEach((f, i) => {
    if (!seenParams.has(f.param)) {
      errors.push({
        path: `/dataset/filters/${i}/param`,
        message: `filter references parameter '${f.param}', which the definition does not declare`,
      });
    }
  });

  // 6. tieOut carries what its kind needs — the DoD's "every report's numbers tie to the ledger" (7B/7C).
  //    `ledger_sum` with no account is admitted when the definition has totals: a statement compares its
  //    grand total, not one account code (Task 9's STATEMENT_LAYOUTS).
  if (
    def.tieOut.kind === "ledger_sum" &&
    def.tieOut.account === undefined &&
    def.totals.length === 0
  ) {
    errors.push({
      path: "/tieOut/account",
      message: "tieOut kind 'ledger_sum' requires an account code or at least one total to compare",
    });
  }
  if (def.tieOut.kind === "projection" && def.tieOut.projection === undefined) {
    errors.push({
      path: "/tieOut/projection",
      message: "tieOut kind 'projection' requires a projection name",
    });
  }

  errors.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { ok: errors.length === 0, errors };
}

/** Schema and grammar only, no set membership — for a definition already stored and validated, whose
 *  registry may have grown since (§4.16.2). Throws `ReportDefinitionError`. */
export function parseReportDefinition(definition: unknown): ReportDefinition {
  const validate = validator();
  if (!validate(definition)) {
    const errors = schemaErrors(validate.errors);
    throw new ReportDefinitionError(
      `report definition is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      errors,
    );
  }
  return definition;
}
