import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  CreatePrintTemplateBody,
  PrintTemplateList,
  PrintTemplateSchema,
  ProblemSchema,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { composeTemplateSource, htmlEscape, renderTemplate, TemplateError } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const PRINT_TEMPLATES_PATH = "/v1/companies/:companyId/print-templates";

/**
 * `/v1/companies/{companyId}/print-templates` under `admin.company.manage` (contracts §3.6.2, §4.5.9). A
 * template added here and one the `templates` sub-pack seeds are composed by the same function and are
 * indistinguishable rows — which is half of what test 15 means by "purely as configuration".
 *
 * `document_type_code` is not a column of `app.print_template`: the insert's row gets it from the request
 * (the caller already holds it) and the list's from the join. Every column list is written out; nothing
 * interpolates one (§3.3, hazard 21).
 */
export const printTemplateRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const gate = () =>
  requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });

interface Row {
  id: string;
  company_id: string;
  document_type_id: string;
  code: string;
  version: number;
  name_en: string;
  name_ar: string | null;
  engine: string;
  paper: string;
  source: string;
  created_at: Date;
  document_type_code: string;
}

const toDto = (r: Row) => ({
  id: r.id,
  companyId: r.company_id,
  documentTypeId: r.document_type_id,
  documentTypeCode: r.document_type_code,
  code: r.code,
  version: r.version,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  engine: r.engine as "chromium",
  paper: r.paper as "A4" | "A5" | "receipt",
  source: r.source,
  createdAt: r.created_at.toISOString(),
});

printTemplateRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "Add a print template version",
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema }),
      body: {
        content: { "application/json": { schema: CreatePrintTemplateBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: PrintTemplateSchema } },
      },
      400: {
        description: "Invalid",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "No such document type",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Version exists",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const input = c.req.valid("json");

    // Parse the body BEFORE it reaches the table: a template that cannot render is a 400 now, not a
    // 500 on the first print. The model is irrelevant here — only the grammar is being checked.
    try {
      renderTemplate(input.body, {}, htmlEscape);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      // A path the empty model lacks is expected and fine; only a GRAMMAR error is rejected.
      if (!/the model has no path/.test(e.message)) {
        throw new AppError("ERR_VALIDATION_FAILED", e.message, {
          errors: [{ path: "body", message: e.message }],
        });
      }
    }

    const source = composeTemplateSource({ labels: input.labels }, input.body);

    const row = await c.var.withTenant(async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type
         where company_id = ${companyId} and code = ${input.documentTypeCode} and archived_at is null`;
      if (!type) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `document type ${input.documentTypeCode} does not exist in company ${companyId}`,
        );
      }
      // `document_type_code` is NOT selected back — a bare bind parameter in a RETURNING list has no
      // inferable type (42P18); it is the code the caller sent, attached here.
      const [inserted] = await tx<Omit<Row, "document_type_code">[]>`
        insert into app.print_template (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
        values (${c.var.ctx.tenantId}, ${companyId}, ${type.id}, ${input.code}, ${input.version},
                ${input.nameEn}, ${input.nameAr ?? null}, ${input.engine}, ${source}, ${input.paper})
        returning id, company_id, document_type_id, code, version, name_en, name_ar, engine, paper,
                  source, created_at`;
      return { ...inserted!, document_type_code: input.documentTypeCode };
    });
    return c.json(toDto(row), 201);
  },
);

printTemplateRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    middleware: [gate()] as const,
    summary: "List a company's print templates",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: {
      200: {
        description: "Templates",
        content: { "application/json": { schema: PrintTemplateList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const rows = await c.var.withTenant(
      (tx) => tx<Row[]>`
        select t.id, t.company_id, t.document_type_id, t.code, t.version, t.name_en, t.name_ar,
               t.engine, t.paper, t.source, t.created_at, dt.code as document_type_code
          from app.print_template t
          join app.document_type dt on dt.id = t.document_type_id
         where t.company_id = ${companyId}
         order by dt.code, t.code, t.version`,
    );
    // A company's template set is small and bounded; 2C ships no cursor (§4.2.8 admits no bare array).
    return c.json({ items: rows.map(toDto), next_cursor: null }, 200);
  },
);
