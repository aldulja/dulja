import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
import { parseReportDefinition, validateReportDefinition } from "@dulja/domain";
import { withTenant, type TenantContext } from "../with-tenant";
import { reportDefinitionSets } from "../reports/definition-store";
import { ReportError } from "../reports/errors";
import { assertDefinitionFields } from "../reports/statement";
import type { LoaderContext, PackLoader } from "./packs";

/** `applied` counts the files applied — inserted, replaced or found already identical; `inserted` counts the
 *  rows that did not exist before, which is what `reportsLoader.load` returns (§4.2.13: zero on a re-run). */
export interface ReportSeedResult {
  applied: number;
  inserted: number;
  codes: readonly string[];
}

/**
 * **The seed-file envelope** (contracts §4.16.1), on 1A's document-type precedent (§4.3.7). A report file is
 * `{ "definitionVersion": <int ≥ 1>, "definition": <ReportDefinition> }` and nothing else.
 *
 * The two numbers are DIFFERENT and must not share a name. `definition.version` is §4.11.1's **format**
 * version, frozen at the JSON Schema's `"const": 1` — a schema change is a new `const` and a new `$id`, never
 * a widened enum. `definitionVersion` is `app.report_definition.version`, the row's version that
 * `unique (company_id, code, version)` keys on, and §4.16.1 requires a re-expressed code to be seeded at
 * `definitionVersion = 2`. Writing `definition.version` into the row column would pin every seeded core row at
 * version 1 forever and make 7B's five re-expressed codes and 7C's three unseedable.
 */
export interface ReportSeedEnvelope {
  definitionVersion: number;
  definition: unknown;
}

interface PackFile {
  relative: string;
  body: unknown;
}

/** `<packRoot>/reports/<owning slice>/<code>.json` — §4.16.1's layout, so 7B, 7C, 8D and the four
 *  minimal-set slices never touch one file. Sorted, so a seed run is deterministic and diffable. A file at the
 *  top of the directory (the README) belongs to no slice and is not a definition. */
async function collect(packDir: string): Promise<PackFile[]> {
  const slices = (await readdir(packDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const files: PackFile[] = [];
  for (const slice of slices) {
    const names = (await readdir(join(packDir, slice)))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    for (const name of names) {
      const text = await readFile(join(packDir, slice, name), "utf8");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new ReportError(
          "ERR_VALIDATION_FAILED",
          `report seed file '${slice}/${name}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      files.push({ relative: `${slice}/${name}`, body });
    }
  }
  return files;
}

/** The envelope's three refusals, exactly the three `loadDocumentTypes` performs (§4.3.7): a body that is not
 *  the two-member envelope, a `definitionVersion` that is not an integer ≥ 1, and a `definition` that fails
 *  validation (below). */
function envelopeOf(file: PackFile): ReportSeedEnvelope {
  const body = file.body;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).toSorted().join(",") !== "definition,definitionVersion"
  ) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report seed file '${file.relative}' must be exactly { "definitionVersion": <int ≥ 1>, "definition": … } (§4.16.1's envelope)`,
    );
  }
  const envelope = body as ReportSeedEnvelope;
  const definitionVersion: unknown = envelope.definitionVersion;
  if (
    typeof definitionVersion !== "number" ||
    !Number.isInteger(definitionVersion) ||
    definitionVersion < 1
  ) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report seed file '${file.relative}' declares definitionVersion ${JSON.stringify(definitionVersion)}; it must be an integer of at least 1`,
    );
  }
  return envelope;
}

/**
 * The transaction half. `tx` is already inside ONE tenant transaction — opened by `loadReportDefinitions`
 * below, or by 0C's `runLoaders` before it calls `reportsLoader.load`. It never opens its own; §4.2.2 forbids
 * nesting and would raise `ERR_TENANT_CONTEXT_NESTED`. This is 1A's `document-types` shape exactly.
 */
async function applyReports(
  tx: Sql,
  companyId: string,
  files: readonly PackFile[],
): Promise<ReportSeedResult> {
  // The two closed sets, read ONCE per run: the permission catalogue from `app.permission` (global) and the
  // dataset ids from `DATASET_IDS`, because `packages/db` may not import `@dulja/contracts` (§3.1). F-21: a
  // definition naming a code no slice has seeded is refused here, at seed time, not at run time.
  const sets = await reportDefinitionSets(tx);
  const codes: string[] = [];
  let inserted = 0;

  for (const file of files) {
    const { definitionVersion, definition: raw } = envelopeOf(file);

    const result = validateReportDefinition(raw, sets);
    if (!result.ok) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      );
    }
    const definition = parseReportDefinition(raw);
    // Every field the definition names must exist on the rows its dataset produces — THE check the definition
    // store runs (Tasks 9 and 13), so a pack file and a definition written through the API are held to one
    // rule. Without it a typo'd display column ships to every tenant as a silently empty column.
    assertDefinitionFields(definition);
    const expected = `${definition.code}.json`;
    if (!file.relative.endsWith(`/${expected}`)) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' declares code '${definition.code}'; §4.16.1 requires the file to be named '${expected}' (the ROW version is the envelope's definitionVersion, never part of the file name)`,
      );
    }
    const json = JSON.stringify(definition);

    // A tenant's own row at the same (company, code, version) is never overwritten, and the refusal is RAISED
    // rather than passed over: a silent no-op is how a staging deploy diverges from its pack.
    const [existing] = await tx<{ is_core: boolean; same: boolean }[]>`
      select d.is_core,
             d.definition = ${json}::text::jsonb and d.archived_at is null as same
        from app.report_definition d
       where d.company_id = ${companyId}::uuid and d.code = ${definition.code}
         and d.version = ${definitionVersion}
       for update`;
    if (existing !== undefined && !existing.is_core) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `${definition.code} version ${definitionVersion} is a tenant's own definition (is_core = false); the seed refuses to overwrite it — raise definitionVersion in '${file.relative}' or archive the tenant's row`,
      );
    }
    // A core row already equal to the file is left alone. `do update` rewrites the row even when nothing
    // differs, and app.report_definition is audited (0074), so a re-run would append an audit row per file —
    // where spec:2317's "running it twice changes nothing" includes app.audit_log (1A's same decision).
    if (existing?.same !== true) {
      // §3.4.8's policy-version rule applied to reports: a CORE row is `do update`, so a placeholder seeded on
      // staging in an early phase cannot silently survive the real definition arriving later. `where is_core`
      // is the database's half of the tenant-row refusal above.
      const rows = await tx<{ inserted: boolean }[]>`
        insert into app.report_definition as d
          (tenant_id, company_id, code, version, definition, is_core)
        values (app.current_tenant(), ${companyId}::uuid, ${definition.code}, ${definitionVersion},
                ${json}::text::jsonb, true)
        on conflict (company_id, code, version) do update
          set definition = excluded.definition, archived_at = null
          where d.is_core
        returning (xmax = 0) as inserted`;
      if (rows.length === 0) {
        throw new ReportError(
          "ERR_VALIDATION_FAILED",
          `${definition.code} version ${definitionVersion} is a tenant's own definition (is_core = false); the seed refuses to overwrite it — raise definitionVersion in '${file.relative}' or archive the tenant's row`,
        );
      }
      if (rows[0]!.inserted) inserted += 1;
    }
    codes.push(definition.code);
  }

  return { applied: codes.length, inserted, codes: codes.toSorted() };
}

/** The file-reading form. Opens its own tenant transaction, so the CLI and a test can call it directly. */
export async function loadReportDefinitions(
  sql: Sql,
  ctx: TenantContext,
  packRoot: string,
  companyId: string,
): Promise<ReportSeedResult> {
  const files = await collect(join(packRoot, "reports"));
  return withTenant(sql, ctx, (tx) => applyReports(tx, companyId, files));
}

/**
 * The §4.2.13 seam: what `bun run seed --only reports` dispatches to. `runLoaders` has already opened the
 * tenant transaction with the system principal as actor, so this receives `tx` and must not open another
 * (`ERR_TENANT_CONTEXT_NESTED`, §4.2.2). It returns "rows inserted", the one meaning §4.2.13 gives every
 * loader — zero on the idempotent second run.
 */
export const reportsLoader: PackLoader = {
  name: "reports",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const files = await collect(join(ctx.packRoot, "reports"));
    return (await applyReports(tx, ctx.companyId, files)).inserted;
  },
};
