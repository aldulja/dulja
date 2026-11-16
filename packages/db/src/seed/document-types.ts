import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import type { Sql } from "postgres";
import { withTenant, type TenantContext } from "../with-tenant";
import { SeedError } from "./types";
import type { LoaderContext, PackLoader } from "./packs";

export interface DocumentTypeSeedResult {
  code: string;
  documentTypeId: string;
  policyId: string;
  created: boolean;
}

interface Envelope {
  code: string;
  nameEn: string;
  nameAr?: string;
  module: "accounting" | "inventory" | "hr" | "pos";
  policyVersion: number;
  effectiveFrom: string;
  policy: Record<string, unknown>;
}

/**
 * The `document-types` sub-pack loader (contracts §3.4.8, §4.3.7), in its standalone form: it is handed a pool
 * and opens the tenant transaction itself. `documentTypesLoader` at the foot of this file is the same loader in
 * §4.2.13's `PackLoader` form, for callers that already hold a `tx` — which is every `--only` run. Per-tenant
 * rows cannot be written by a migration — FORCE ROW LEVEL SECURITY binds app_migrator too (spec:1366) — so every
 * document type and posting policy arrives this way, from version-controlled JSON, diffable in review (SAH-078).
 *
 * `catalogue` is a parameter rather than an import because packages/db may import only @dulja/domain
 * (spec:2389, dependency-rule) — and both this file's callers, the loader below and the test, read the codes
 * from app.permission, which is global, RLS-free (0001 §4) and written only by migration 0014, so it is the
 * same set as PERMISSIONS by construction (permission-catalogue.test.ts asserts the equality in both directions).
 */
export async function loadDocumentTypes(
  sql: Sql,
  ctx: TenantContext,
  packDir: string,
  catalogue: readonly string[],
): Promise<DocumentTypeSeedResult[]> {
  const envelopes = await readEnvelopes(packDir, catalogue);
  return withTenant(sql, ctx, (tx) => applyDocumentTypes(tx, ctx.tenantId, envelopes));
}

/** The file half: read, validate against the envelope schema, the file name and the permission catalogue. No
 *  I/O to the database, so it is the same whichever of the two entry points calls it. */
async function readEnvelopes(packDir: string, catalogue: readonly string[]): Promise<Envelope[]> {
  const files = (await readdir(packDir)).filter((file) => file.endsWith(".json")).toSorted();
  const envelopes: Envelope[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(packDir, file), "utf8")) as unknown;
    const envelopeCheck = validateDocumentTypeSeed(raw);
    if (!envelopeCheck.ok) {
      throw new Error(
        `${file}: ${envelopeCheck.errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ")}`,
      );
    }
    const envelope = raw as Envelope;
    if (basename(file, ".json") !== envelope.code) {
      throw new Error(
        `${file}: the file name must equal the envelope's code ${envelope.code} (contracts §4.3.7)`,
      );
    }
    const policyCheck = validatePolicy(envelope.policy, catalogue);
    if (!policyCheck.ok) {
      throw new Error(
        `${file}: ${policyCheck.errors.map((error) => `${error.path || "/"} ${error.message}`).join("; ")}`,
      );
    }
    envelopes.push(envelope);
  }
  return envelopes;
}

/** The transaction half: `tx` is already inside one tenant transaction — opened by `loadDocumentTypes` above, or
 *  by 0C's `runLoaders` before it calls `documentTypesLoader.load`. It never opens its own (§4.2.2 forbids
 *  nesting). */
async function applyDocumentTypes(
  tx: Sql,
  tenantId: string,
  envelopes: readonly Envelope[],
): Promise<DocumentTypeSeedResult[]> {
  const companies = await tx<{ id: string }[]>`select id from app.company order by created_at`;
  const results: DocumentTypeSeedResult[] = [];
  for (const company of companies) {
    for (const envelope of envelopes) {
      // `module` is the attachment download gate of contracts §4.5.8; 2A's migration 0018 added the column and
      // the envelope's value is what reaches it — the column default is a safety net, never the source (§4.3.4).
      const inserted = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, name_ar, module)
        values (${tenantId}, ${company.id}, ${envelope.code}, ${envelope.nameEn}, ${envelope.nameAr ?? null},
                ${envelope.module})
        on conflict (company_id, code) do nothing
        returning id`;
      const [type] =
        inserted.length > 0
          ? inserted
          : await tx<{ id: string }[]>`
              select id from app.document_type where company_id = ${company.id} and code = ${envelope.code}`;

      // A policy version is `do update`, never `do nothing` (contracts §3.4.8): a placeholder seeded on
      // staging must not silently survive the real definition arriving in a later phase. But a version that a
      // posted document PINS (SAH-013, spec:1753) is what that document was posted under, and rewriting it
      // would change how the document reverses months later. So the update is refused — here with a message
      // that names the fix, and by migration 0106's guard should any other path try — and the operator bumps
      // `policyVersion` in the pack file instead.
      const [existing] = await tx<{ id: string; same: boolean; pinned: boolean }[]>`
        select p.id,
               p.definition = ${JSON.stringify(envelope.policy)}::text::jsonb
                 and p.effective_from = ${envelope.effectiveFrom}::date as same,
               exists (select 1 from app.document where posting_policy_id = p.id)
                 or exists (select 1 from app.ledger_entry where posting_policy_id = p.id) as pinned
          from app.posting_policy p
         where p.document_type_id = ${type!.id} and p.version = ${envelope.policyVersion}`;
      if (existing && !existing.same && existing.pinned) {
        throw new SeedError(
          `${envelope.code} policy version ${envelope.policyVersion} does not match the pack file but is pinned by posted documents; ` +
            `bump policyVersion and its effective date in the pack file instead of editing a version in place (SAH-013, ADR 0027)`,
        );
      }
      // A version already equal to the pack file is left alone. `do update` rewrites the row even when nothing
      // differs, and app.posting_policy is audited (0001), so every re-run appended one audit row per document
      // type — where spec:2317's "running it twice changes nothing" includes app.audit_log.
      const [policy] = existing?.same
        ? [{ id: existing.id }]
        : await tx<{ id: string }[]>`
            insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
            values (${tenantId}, ${type!.id}, ${envelope.policyVersion}, ${envelope.effectiveFrom}::date, ${JSON.stringify(envelope.policy)}::text::jsonb)
            on conflict (document_type_id, version) do update
               set definition = excluded.definition, effective_from = excluded.effective_from
            returning id`;
      results.push({
        code: envelope.code,
        documentTypeId: type!.id,
        policyId: policy!.id,
        created: inserted.length > 0,
      });
    }
  }
  return results;
}

/**
 * The §4.2.13 seam: what `bun run seed --only document-types` dispatches to. `runLoaders` has already opened the
 * tenant transaction with the system principal as actor, so this receives `tx` and must not open another
 * (`ERR_TENANT_CONTEXT_NESTED`, §4.2.2) — which is why it composes the two halves above rather than calling
 * `loadDocumentTypes`. The catalogue is read from `app.permission` inside the same transaction, exactly as 0C's
 * `rolesLoader` does: this file is inside `packages/db`, which `dependency-rule` pins to `["@dulja/domain"]`
 * (spec:2389), so a `PERMISSIONS` import here would be a lint violation. `app.permission` is global — no
 * `tenant_id`, no RLS — migration 0014 is its only writer, and `permission-catalogue.test.ts` asserts it equals
 * `PERMISSIONS` in both directions, so the read is the same set by construction.
 *
 * The return is "rows inserted", the one meaning §4.2.13 gives every loader: the count of document types created,
 * which is 0 on the idempotent second run even though the policy upsert is `do update`.
 */
export const documentTypesLoader: PackLoader = {
  name: "document-types",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const catalogue = (
      await tx<{ code: string }[]>`select code from app.permission order by code`
    ).map((row) => row.code);
    const envelopes = await readEnvelopes(join(ctx.packRoot, "document-types"), catalogue);
    const results = await applyDocumentTypes(tx, ctx.tenantId, envelopes);
    return results.filter((result) => result.created).length;
  },
};
