import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { validatePolicy } from "@dulja/domain";
import {
  AppError,
  CreateDocumentTypeBody,
  CreatePostingPolicyBody,
  decodeCursor,
  DocumentTypeList,
  DocumentTypeQuery,
  DocumentTypeSchema,
  encodeCursor,
  ListQuery,
  PostingPolicyList,
  PostingPolicySchema,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION, PERMISSIONS } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

/**
 * The half of "a new document type is added with zero code" (spec:2288) that a tenant touches: create a type
 * with its module, add a policy version, list and archive. Document types and posting policies are
 * maintained under `admin.company.manage` (contracts §3.6.2); the permission vocabulary is closed (§3.6.1).
 * A policy version is append-only through this API — ADR 0027; the seed CLI keeps its upsert (§3.4.8).
 */
export const documentTypeRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const scope = { company: "path:companyId" } as const;
const gate = () => requirePermission(PERMISSION["admin.company.manage"], scope);
/** The F-21 catalogue check runs here at configuration time, so a policy naming a permission code no slice
 *  has shipped is refused before any write, never at post. The API may import the catalogue; the seed reads
 *  it from `app.permission` because packages/db may not (§3.1). */
const CATALOGUE: readonly string[] = PERMISSIONS.map((permission) => permission.code);

interface DocumentTypeRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  module: string;
  archived_at: Date | null;
  created_at: Date;
}
interface PolicyRow {
  id: string;
  document_type_id: string;
  version: number;
  effective_from: string;
  definition: unknown;
  created_at: Date;
}

const toDto = (row: DocumentTypeRow) => ({
  id: row.id,
  code: row.code,
  nameEn: row.name_en,
  nameAr: row.name_ar,
  module: row.module as "accounting" | "inventory" | "hr" | "pos",
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});
const toPolicyDto = (row: PolicyRow) => ({
  id: row.id,
  documentTypeId: row.document_type_id,
  version: row.version,
  effectiveFrom: row.effective_from,
  definition: row.definition,
  createdAt: row.created_at.toISOString(),
});

/** contracts §4.2.7 — the company-resolution guard every company-scoped module carries. RLS matches no row of
 *  another tenant's company and the honest answer is ERR_NOT_FOUND, never an empty page. */
async function companyExists(
  tx: Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0],
  companyId: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`select id from app.company where id = ${companyId}`;
  if (!row) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
}

documentTypeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["admin"],
    middleware: [gate()] as const,
    summary: "Create a document type (its policy versions are added separately)",
    request: {
      params: z.object({ companyId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateDocumentTypeBody } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: DocumentTypeSchema } },
      },
      409: {
        description: "Duplicate code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await companyExists(tx, companyId);
      return tx<DocumentTypeRow[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, name_ar, module)
        values (${c.var.ctx.tenantId}, ${companyId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null}, ${body.module})
        returning id, code, name_en, name_ar, module, archived_at, created_at`;
    });
    return c.json(toDto(row[0]!), 201);
  },
);

documentTypeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [gate()] as const,
    summary: "List document types",
    request: { params: z.object({ companyId: UuidSchema }), query: DocumentTypeQuery },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: DocumentTypeList } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // Keyset pagination on (code, id) — the declared sort key — with the shared codec of §4.2.8. A hard-coded
    // `next_cursor: null` under a LIMIT truncates silently, and a company may hold more than the 100 types
    // `ListQuery.limit` defaults to.
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const afterCode = after ? String(after.k[0]) : null;
    const afterId = after?.id ?? null;
    const codeFilter = q["filter[code][eq]"] ?? null;
    const moduleFilter = q["filter[module][eq]"] ?? null;
    const rows = await c.var.withTenant(async (tx) => {
      await companyExists(tx, companyId);
      return tx<DocumentTypeRow[]>`
        select id, code, name_en, name_ar, module, archived_at, created_at
          from app.document_type
         where company_id = ${companyId}
           and (${q.includeArchived === "true"} or archived_at is null)
           and (${codeFilter}::text is null or code = ${codeFilter})
           and (${moduleFilter}::text is null or module = ${moduleFilter})
           and (${afterCode}::text is null or (code, id) > (${afterCode}, ${afterId}::uuid))
         order by code, id
         limit ${q.limit}`;
    });
    const last = rows.at(-1);
    return c.json(
      {
        items: rows.map(toDto),
        next_cursor:
          rows.length === q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
      },
      200,
    );
  },
);

documentTypeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentTypeId}/archive",
    tags: ["admin"],
    middleware: [gate()] as const,
    summary: "Archive a document type (never deleted — spec:2049)",
    request: {
      params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      200: {
        description: "Archived",
        content: { "application/json": { schema: DocumentTypeSchema } },
      },
      404: {
        description: "Unknown",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentTypeId } = c.req.valid("param");
    const rows = await c.var.withTenant(
      (tx) => tx<DocumentTypeRow[]>`
        update app.document_type set archived_at = now()
         where id = ${documentTypeId} and company_id = ${companyId} and archived_at is null
         returning id, code, name_en, name_ar, module, archived_at, created_at`,
    );
    if (rows.length === 0) {
      throw new AppError("ERR_NOT_FOUND", `no unarchived document type ${documentTypeId}`);
    }
    return c.json(toDto(rows[0]!), 200);
  },
);

documentTypeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{documentTypeId}/policies",
    tags: ["admin"],
    middleware: [gate()] as const,
    summary: "Add a posting-policy version (append-only — ADR 0027)",
    request: {
      params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePostingPolicyBody } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: PostingPolicySchema } },
      },
      409: {
        description: "Version exists",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "Invalid definition",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, documentTypeId } = c.req.valid("param");
    const body = c.req.valid("json");

    // Schema AND catalogue, before any write: a policy naming a permission code no slice has shipped is
    // refused at configuration time rather than at post (F-21, contracts §4.4.1).
    const report = validatePolicy(body.definition, CATALOGUE);
    if (!report.ok) {
      // `errors` carries the JSON Pointer into the rejected definition. §4.2.4 reserved the member for
      // ERR_VALIDATION_FAILED; amendment A10 extends it to ERR_POLICY_INVALID, because LEGACY-078's claim is
      // that an invalid rule is refused at configuration time *naming the JSON path*, and `detail` alone
      // makes a caller parse prose. `detail` carries the same paths so a human-readable message loses nothing.
      throw new AppError(
        "ERR_POLICY_INVALID",
        `posting policy for document type ${documentTypeId} is invalid: ${report.errors
          .map((error) => `${error.path || "/"} ${error.message}`)
          .join("; ")}`,
        { errors: report.errors },
      );
    }

    const rows = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ code: string }[]>`
        select code from app.document_type where id = ${documentTypeId} and company_id = ${companyId}`;
      if (!type) throw new AppError("ERR_NOT_FOUND", `no document type ${documentTypeId}`);
      const declared = (body.definition as { documentType?: unknown }).documentType;
      if (declared !== type.code) {
        throw new AppError(
          "ERR_POLICY_INVALID",
          `definition.documentType ${String(declared)} does not equal the type's code ${type.code}`,
        );
      }
      // Append-only: no `on conflict` (ADR 0027). A duplicate version raises 23505 → ERR_CONFLICT_UNIQUE.
      return tx<PolicyRow[]>`
        insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
        values (${c.var.ctx.tenantId}, ${documentTypeId}, ${body.version}, ${body.effectiveFrom}::date,
                ${JSON.stringify(body.definition)}::text::jsonb)
        returning id, document_type_id, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
                  definition, created_at`;
    });
    return c.json(toPolicyDto(rows[0]!), 201);
  },
);

documentTypeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{documentTypeId}/policies",
    tags: ["admin"],
    middleware: [gate()] as const,
    summary: "List a document type's policy versions — its whole history",
    request: {
      params: z.object({ companyId: UuidSchema, documentTypeId: UuidSchema }),
      query: ListQuery,
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: PostingPolicyList } } },
    },
  }),
  async (c) => {
    const { companyId, documentTypeId } = c.req.valid("param");
    const q = c.req.valid("query");
    // The policy list on a type is its whole history and ADR 0027 makes it append-only, so it only grows —
    // which is exactly why it needs a cursor. `version` is unique per type (`unique (document_type_id,
    // version)`), so the keyset is one column plus the id tiebreak the codec always carries.
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const afterVersion = after ? Number(after.k[0]) : null;
    const rows = await c.var.withTenant(
      (tx) => tx<PolicyRow[]>`
        select p.id, p.document_type_id, p.version, to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
               p.definition, p.created_at
          from app.posting_policy p
          join app.document_type t on t.id = p.document_type_id
         where p.document_type_id = ${documentTypeId} and t.company_id = ${companyId}
           and (${afterVersion}::int is null or p.version > ${afterVersion})
         order by p.version
         limit ${q.limit}`,
    );
    const last = rows.at(-1);
    return c.json(
      {
        items: rows.map(toPolicyDto),
        next_cursor:
          rows.length === q.limit && last ? encodeCursor({ k: [last.version], id: last.id }) : null,
      },
      200,
    );
  },
);
