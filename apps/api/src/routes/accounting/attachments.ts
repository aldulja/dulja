import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AppError,
  AttachmentList,
  AttachmentQuery,
  AttachmentSchema,
  ProblemSchema,
  UploadAttachmentBody,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  insertAttachment,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  readAttachmentContent,
  resolvePolicy,
  stageAttachment,
  type AttachmentRow,
  type DocumentTypeModule,
  type ObjectStore,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import {
  LOT_READ_CODE,
  MODULE_READ_CODE,
  requireAttachmentRead,
} from "../../middleware/require-attachment-read";
import { INVENTORY_PERMISSION } from "../inventory/permissions";
import { DOCUMENT_STAGE_CODES } from "./documents";
import { assertRoleInCompany, markPermissionGate } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";

export const ATTACHMENTS_PATH = "/v1/companies/:companyId/attachments";

interface DocumentGate {
  companyId: string;
  branchId: string | null;
  documentTypeId: string;
  effectiveDate: string;
}

const toDto = (row: AttachmentRow) => ({
  id: row.id,
  companyId: row.companyId,
  documentId: row.documentId,
  lotId: row.lotId,
  objectKey: row.objectKey,
  fileName: row.fileName,
  mimeType: row.mimeType,
  byteSize: row.byteSize,
  sha256: row.sha256,
  uploadedBy: row.uploadedBy,
  createdAt: row.createdAt,
});

/** Exactly one of the two owners, read out of the multipart body. Migration 0031's
 *  `attachment_owner_check` is the same rule in the database; refusing here makes it a 400 rather than a
 *  500 from a `check_violation` the handler cannot pre-empt. `UploadAttachmentBody`'s `.refine` states it
 *  a third time, for the OpenAPI document. */
const UUID_PART = /^[0-9a-f-]{36}$/i;
function ownerOf(form: FormData | null): { documentId: string } | { lotId: string } {
  const documentId = form?.get("documentId");
  const lotId = form?.get("lotId");
  const hasDocument = typeof documentId === "string" && UUID_PART.test(documentId);
  const hasLot = typeof lotId === "string" && UUID_PART.test(lotId);
  if (hasDocument === hasLot) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      "an attachment belongs to exactly one of a document or a lot",
      {
        errors: [
          { path: "documentId", message: "give exactly one of documentId or lotId, as a uuid" },
        ],
      },
    );
  }
  return hasDocument ? { documentId: documentId as string } : { lotId: lotId as string };
}

/**
 * Pre-flight only (spec:2173). For a DOCUMENT the gate is the code that may create or edit a draft of that
 * type — `approval.create ?? approval.post` (§4.4.1) — because attaching a file to a document is editing it.
 * For a LOT (3A) it is `inventory.item.manage`: a lot is catalogue data and §3.6.1 closes the inventory
 * vocabulary at five codes, so there is no separate attachment code (assumption 11).
 * It reads the multipart body's owner itself, because §4.5.8 fixes a path with no `:documentId`
 * segment for 2B's `requireDocumentPermission` to load, and it is not a `requirePermission` gate because a
 * read code on a POST is `ERR_ROUTE_GATE_READONLY` at boot (R7, spec:2178). Hono caches the parsed form, so
 * the handler's own `c.req.formData()` re-uses this parse. Marked as a gate over the policy-resolved union
 * plus the lot code.
 */
const attachGate = markPermissionGate(
  async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const form = await c.req.formData().catch(() => null);
    const owner = ownerOf(form);

    if (!("documentId" in owner)) {
      const lotCode = INVENTORY_PERMISSION.itemManage;
      await c.var.withTenant(async (tx) => {
        // S3 (code review 2): the company first, before the lot is read (see `assertRoleInCompany`).
        await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
        const [lot] = await tx<{ companyId: string }[]>`
        select company_id as "companyId" from app.lot
         where id = ${owner.lotId} and company_id = ${companyId}`;
        if (!lot) {
          throw new AppError(
            "ERR_NOT_FOUND",
            `lot ${owner.lotId} is not visible in company ${companyId}`,
          );
        }
        const [allowed] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${lotCode}, ${lot.companyId}, null) as ok`;
        if (!allowed?.ok) {
          throw new AppError(
            "ERR_RBAC_FORBIDDEN",
            `attaching a file to lot ${owner.lotId} requires ${lotCode}`,
          );
        }
      });
      await next();
      return;
    }

    const documentId = owner.documentId;
    await c.var.withTenant(async (tx) => {
      // S3 (code review 2): the company first, before the document is read — a caller with no role in the
      // path company got 403 naming the document's create code for a real id and 404 for a random one.
      await assertRoleInCompany(tx, c.var.ctx.actorId, companyId);
      const [doc] = await tx<DocumentGate[]>`
      select company_id as "companyId", branch_id as "branchId",
             document_type_id as "documentTypeId", to_char(effective_date, 'YYYY-MM-DD') as "effectiveDate"
        from app.document where id = ${documentId} and company_id = ${companyId}`;
      if (!doc) {
        throw new AppError(
          "ERR_NOT_FOUND",
          `document ${documentId} is not visible in company ${companyId}`,
        );
      }
      const { definition } = await resolvePolicy(tx, doc.documentTypeId, doc.effectiveDate);
      const code = definition.approval.create ?? definition.approval.post;
      const [allowed] = await tx<{ ok: boolean }[]>`
      select app.actor_has(${code}, ${doc.companyId}, ${doc.branchId}) as ok`;
      if (!allowed?.ok) {
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          `attaching a file to document ${documentId} requires ${code}`,
        );
      }
    });
    await next();
  },
  [...DOCUMENT_STAGE_CODES, INVENTORY_PERMISSION.itemManage],
);

/**
 * The list's COMPANY gate, asked at the branch of the document `?documentId=` names (bound to the path's
 * company), and at company scope when the query names none. The Phase 2 review moved the row-level gate
 * and the download gate to the owning document's branch, as print and events ask, but this gate still asked
 * with a NULL branch — so a reader restricted to HQ could download an HQ attachment and was refused its
 * list. A document id that is not a uuid, or names no document of this company, leaves the branch NULL and
 * demands company-wide authority, which is the stricter answer; the row-level gate still filters every row.
 *
 * **The code is the named document's module read code** (Phase 8 review, 2026-11-08) — §4.5.8's one map, the code
 * the download gate already asks. It was `accounting.ledger.read` whatever the document, so the payroll role
 * (`hr.payroll.read` without the ledger code) could download a run's payslip but never list the run's payslips, and a
 * ledger reader passed the gate for a run whose rows the row-level gate then hid. A module with no row denies. With
 * no document named, the company-wide list still asks `accounting.ledger.read`.
 */
const LIST_GATE_CODE = PERMISSION["accounting.ledger.read"];
const listGate = markPermissionGate(
  async (c, next) => {
    const companyId = c.req.param("companyId")!;
    const documentId = new URL(c.req.url).searchParams.get("documentId");
    const verdict = await c.var.withTenant(async (tx) => {
      const [doc] =
        documentId !== null && UUID_PART.test(documentId)
          ? await tx<{ branchId: string; module: DocumentTypeModule }[]>`
              select d.branch_id as "branchId", dt.module
                from app.document d join app.document_type dt on dt.id = d.document_type_id
               where d.id = ${documentId} and d.company_id = ${companyId}`
          : [];
      const code = doc === undefined ? LIST_GATE_CODE : MODULE_READ_CODE[doc.module];
      if (code === undefined) return { code: `the ${doc!.module} read code`, ok: false };
      const [row] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${companyId}::uuid, ${doc?.branchId ?? null}::uuid) as ok`;
      return { code, ok: row?.ok ?? false };
    });
    if (!verdict.ok) {
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `principal ${c.var.ctx.actorId} does not hold ${verdict.code} in company ${companyId}`,
      );
    }
    await next();
  },
  [...new Set<string>([LIST_GATE_CODE, ...Object.values(MODULE_READ_CODE)])],
);

export function createAttachmentRoutes(store: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["accounting"],
      summary: "Upload an attachment against a document or a lot",
      middleware: [attachGate] as const,
      request: {
        headers: IdempotencyHeader,
        params: z.object({ companyId: UuidSchema }),
        body: {
          content: { "multipart/form-data": { schema: UploadAttachmentBody } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Stored",
          content: { "application/json": { schema: AttachmentSchema } },
        },
        400: {
          description: "Invalid",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        404: {
          description: "No such document or lot",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const form = await c.req.formData();
      const owner = ownerOf(form);
      const file = form.get("file");

      if (!(file instanceof File)) {
        throw new AppError("ERR_VALIDATION_FAILED", "file is required and must be a file part", {
          errors: [{ path: "file", message: "expected a binary part named `file`" }],
        });
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `file is ${file.size} bytes; the maximum is ${MAX_ATTACHMENT_BYTES}`,
          { errors: [{ path: "file", message: `at most ${MAX_ATTACHMENT_BYTES} bytes` }] },
        );
      }

      // The name is data. It reaches Content-Disposition and nothing else; the object key is derived
      // from the row's uuid (LEGACY-038), so a traversal payload here addresses nothing.
      const fileName = (file.name || "attachment").split(/[/\\]/).pop()!.slice(0, 255);
      const bytes = new Uint8Array(await file.arrayBuffer());

      // The object is written BEFORE the row's transaction opens, so the network round trip to R2 holds no
      // row lock and no savepoint. A rollback afterwards leaves an unreferenced object, which insertAttachment
      // removes on a failed insert and 7C's sweep would otherwise catch (ADR 0031).
      const input = {
        companyId,
        ...owner,
        fileName,
        mimeType: file.type || "application/octet-stream",
        bytes,
      };
      const staged = await stageAttachment(store, c.var.ctx, input);
      const row = await c.var.withTenant((tx) =>
        insertAttachment(tx, c.var.ctx, store, input, staged),
      );
      return c.json(toDto(row), 201);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["accounting"],
      summary: "List a company's, a document's or a lot's attachments",
      // TWO gates, because attachment IDENTITY is itself a side channel: `fileName`, `byteSize`, `sha256`
      // and `uploadedBy` are all returned here. `companyId` is caller-supplied and RLS is tenant-scoped,
      // never company-scoped, so without the first gate any authenticated tenant member could enumerate
      // any company's attachment metadata. A read code on a GET is legal under R7. The second gate is
      // `readableModules` in the handler, at the row level (§4.5.8, §4.14 test 32).
      middleware: [listGate] as const,
      request: { params: z.object({ companyId: UuidSchema }), query: AttachmentQuery },
      responses: {
        200: {
          description: "Attachments",
          content: { "application/json": { schema: AttachmentList } },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const query = c.req.valid("query");
      const { documentId, limit } = query;
      // §4.2.8's literal `filter[<field>][eq]` grammar; its presence also implies `includeLots`, because a
      // caller who names a lot has plainly asked for lot rows. The explicit flag is for "all of them".
      const lotId = query["filter[lotId][eq]"];
      const includeLots = query.includeLots || lotId !== undefined;
      // The second gate, at the ROW level and at each owning document's branch: an attachment is listed only
      // when the caller holds its type's module read code there (§4.5.8, §4.14 test 32). One map, the same
      // one the download and print gates read.
      const rows = await c.var.withTenant((tx) =>
        listAttachments(tx, {
          companyId,
          documentId,
          lotId,
          includeLots,
          // Not the module map: a lot's certificate is catalogue data (§4.5.8's lot rule), so the row-level
          // gate for a lot row is `inventory.item.read` and never `inventory.stock.read`.
          lotReadCode: LOT_READ_CODE,
          limit,
          readCodes: MODULE_READ_CODE,
        }),
      );
      // The list is bounded by `limit` and ordered by (created_at, id); a document's attachment count is
      // small enough that 2C ships no cursor. A slice that needs one uses encodeCursor (§4.2.8).
      return c.json({ items: rows.map(toDto), next_cursor: null }, 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{attachmentId}/content",
      tags: ["accounting"],
      summary: "Download an attachment's bytes",
      middleware: [requireAttachmentRead()] as const,
      request: { params: z.object({ companyId: UuidSchema, attachmentId: UuidSchema }) },
      responses: {
        200: {
          description: "The file",
          content: { "application/octet-stream": { schema: z.any() } },
        },
        403: {
          description: "Forbidden",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
        404: {
          description: "Not found",
          content: { "application/problem+json": { schema: ProblemSchema } },
        },
      },
    }),
    async (c) => {
      const { row } = c.var.attachment;
      let bytes: Uint8Array;
      try {
        bytes = await readAttachmentContent(store, row);
      } catch (e) {
        // The recorded hash did not match, or the object is gone. Never serve the bytes and never echo the
        // key to the client; the detail goes to the log with the request id (spec:2063).
        c.var.logger.error({ attachment_id: row.id, err: String(e) }, "attachment_integrity");
        throw new AppError("ERR_INTERNAL", `attachment ${row.id} could not be served`);
      }
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "content-type": row.mimeType,
        "content-length": String(row.byteSize),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
        "x-request-id": c.var.requestId,
      });
    },
  );

  return routes;
}
