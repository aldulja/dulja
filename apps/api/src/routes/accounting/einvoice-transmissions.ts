// apps/api/src/routes/accounting/einvoice-transmissions.ts (5B)
//
// One module, five routes, one PROBES key — `/poll` (ADR 0053, amendment 2026-10-06) is a sub-path and
// inherits the module's probe (hazard 31). The unsafe routes are the reason
// `accounting.tax.file` exists in `apps/api` at all — the permission-catalogue lint (§3.6.3) scans
// this workspace and `packages/db` may not import @dulja/contracts (§3.1).
//
// `EInvoiceError` (packages/db) is translated to an `AppError` here, once, by `rethrowAsAppError` —
// 3C's `LandedCostError` pattern (`apps/api/src/problem.ts` gains no branch).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  admitOperatorSubmit,
  cancelTransmission,
  companySettings,
  getTransmission,
  listTransmissions,
  pollTransmission,
  writeEinvoiceSettings,
  EInvoiceError,
  SUBMITTABLE_FROM,
  type EinvoiceTransmissionRow,
} from "@dulja/db";
import {
  AppError,
  CancelTransmissionBody,
  decodeCursor,
  encodeCursor,
  EinvoiceSettingsBody,
  EinvoiceSettingsSchema,
  EinvoiceTransmissionList,
  EinvoiceTransmissionQuery,
  EinvoiceTransmissionSchema,
  ProblemSchema,
  SubmitAcceptedSchema,
  UuidSchema,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";
import { requirePermission } from "../../middleware/require-permission";

/** The bracket form — a dotted code cannot be reached by dot access (5A T4's note). */
export const EINVOICE_PERMISSION = { file: PERMISSION["accounting.tax.file"] } as const;

const scope = { company: "path:companyId" } as const;
const settingsScope = { company: "path:companyId" } as const;

const PathParams = z.object({ companyId: UuidSchema, transmissionId: UuidSchema });
const CompanyParams = z.object({ companyId: UuidSchema });

/** The one translation point. `EInvoiceError.code` is a literal subset of `ErrCode`, so the mapping
 *  is total and the status comes from the registry rather than from a table repeated here. */
function rethrowAsAppError(e: unknown): never {
  if (e instanceof EInvoiceError) throw new AppError(e.code, e.detail);
  throw e;
}

/** The wire shape: the row with `requestSha256` rendered as lower-case hex (Task 5 already returns it
 *  that way) and every timestamp as RFC 3339. `response` is DELIBERATELY not on the wire — ADR 0053
 *  fixes what may be stored there and nothing in v1 puts a remote body in front of a browser. */
function toDto(row: EinvoiceTransmissionRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    transmitter: row.transmitter,
    profileVersion: row.profileVersion,
    externalId: row.externalId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    requestSha256: row.requestSha256,
    qrPayload: row.qrPayload,
    submittedAt: row.submittedAt,
    acceptedAt: row.acceptedAt,
    cancelledAt: row.cancelledAt,
    polledAt: row.polledAt,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
  };
}

export const einvoiceTransmissionRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["accounting"],
    summary: "List e-invoice transmissions for a company",
    request: { params: CompanyParams, query: EinvoiceTransmissionQuery },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: {
        description: "A page of transmissions",
        content: { "application/json": { schema: EinvoiceTransmissionList } },
      },
      400: {
        description: "Invalid query",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const afterId = q.cursor === undefined ? null : decodeCursor(q.cursor).id;
    const rows = await c.var.withTenant((tx) =>
      listTransmissions(tx, {
        companyId,
        ...(q["filter[status][eq]"] === undefined ? {} : { status: q["filter[status][eq]"] }),
        afterId,
        limit: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const next =
      rows.length > q.limit && page.length > 0
        ? encodeCursor({ k: [], id: page[page.length - 1]!.id })
        : null;
    return c.json({ items: page.map(toDto), next_cursor: next }, 200);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{transmissionId}",
    tags: ["accounting"],
    summary: "Read one e-invoice transmission",
    request: { params: PathParams },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: {
        description: "The transmission",
        content: { "application/json": { schema: EinvoiceTransmissionSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, transmissionId } = c.req.valid("param");
    const row = await c.var
      .withTenant((tx) => getTransmission(tx, transmissionId))
      .catch(rethrowAsAppError);
    if (row.companyId !== companyId)
      throw new AppError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
    return c.json(toDto(row), 200);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{transmissionId}/submit",
    tags: ["accounting"],
    summary: "Queue a submission (or resubmission) of this transmission",
    description:
      "Enqueues accounting.tax.submit under singletonKey = transmissionId. The route never calls the authority: the job owns the two short transactions the remote call is bracketed by. It answers 409 while a call to the authority is in flight (claimedAt younger than the claim window). A row in error whose lastError begins with the warning that the authority may already hold the document is never resubmitted by automation: this route is the operator's deliberate resubmission, and it replaces that warning with a record of the request, keeping the diagnostic after it, in the transaction that enqueues the job.",
    request: { params: PathParams, headers: IdempotencyHeader },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      202: {
        description: "Queued",
        content: { "application/json": { schema: SubmitAcceptedSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "Not submittable from this status, or a call to the authority is in flight",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, transmissionId } = c.req.valid("param");
    const { row, jobId } = await c.var
      .withTenant(async (tx) => {
        const current = await getTransmission(tx, transmissionId);
        // This route's company binding stays HERE, in the transaction that enqueues: the route never
        // calls `submitTransmission`, and the job payload (contracts amendment 2) names no company,
        // so the worker's call cannot carry one. Cancel and poll bind theirs inside the claim.
        if (current.companyId !== companyId)
          throw new AppError("ERR_NOT_FOUND", `transmission ${transmissionId} does not exist`);
        // The same guard the service applies, applied here so the operator sees 409 rather than a
        // job that fails silently in the worker. `submitTransmission` re-checks under its own claim.
        if (!SUBMITTABLE_FROM.includes(current.status)) {
          throw new EInvoiceError(
            "ERR_EINVOICE_STATUS_ILLEGAL",
            `transmission ${transmissionId} is ${current.status}; submit has allowed states ${SUBMITTABLE_FROM.join(", ")}`,
          );
        }
        // ADR 0053, amendment 2026-10-06, made enforceable (PR 11 review): 409 while a call is in
        // flight, as the claim refuses one — a first submission still reads `pending` during its
        // call, and a job queued behind it would run on whatever it records. And on a row the worker
        // will not resubmit, because the authority answered 2xx and may hold the document, this IS
        // the deliberate resubmission: the warning is replaced by a record of the request here, in
        // the transaction that enqueues, so the job proceeds — and an enqueue that fails restores
        // the warning with it.
        const admitted = await admitOperatorSubmit(tx, transmissionId);
        const id = await c.var.jobs.enqueue(
          tx,
          "accounting.tax.submit",
          {
            tenantId: c.var.ctx.tenantId,
            requestId: c.var.ctx.requestId,
            payload: { transmissionId, phase: "submit" },
          },
          { singletonKey: transmissionId, retryLimit: 8, retryDelaySeconds: 60 },
        );
        return { row: admitted, jobId: id };
      })
      .catch(rethrowAsAppError);
    c.var.logger.info({ transmissionId, jobId }, "e-invoice submission queued");
    return c.json({ transmission: toDto(row), jobId }, 202);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{transmissionId}/cancel",
    tags: ["accounting"],
    summary: "Cancel an accepted transmission with the authority",
    description:
      "Calls the transmitter directly rather than through a job: the reason is an operator's words, the call is rare, and its refusal must reach the operator in the response. An authority fault (a 5xx, a 429 or a timeout) is recorded on the row, releases its claim and answers 500 ERR_INTERNAL; that answer is stored against the Idempotency-Key and replayed for it, so a retry needs a fresh key. The answer is recorded after the call, outside a request-spanning transaction: if the API stops between the two, the key becomes reclaimable after 120 seconds, and a retry with it runs the cancel again, which answers 409 for a row the first call cancelled.",
    request: {
      params: PathParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CancelTransmissionBody } } },
    },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: {
        description: "Cancelled",
        content: { "application/json": { schema: EinvoiceTransmissionSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description:
          "Not cancellable from this status, or another call to the authority holds the claim — in flight, or taken over from this call after the claim window, in which case nothing of this call was recorded",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "E-invoicing not enabled, or the transmitter is unavailable",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, transmissionId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    // `cancelTransmission` takes the POOL, not a `tx`: it opens two short transactions around the
    // remote call (Task 5, ADR 0053), so no row lock of the transmission's is held across the
    // network — `c.var.withTenant` would join the request's transaction instead. And this route is
    // SELF_TRANSACTED (apps/api/src/middleware/idempotency.ts), so the idempotency middleware runs it
    // outside its request-spanning transaction and records the answer afterwards. Inside it, the
    // request held one pooled connection while the service waited for a second from the same pool,
    // and as many concurrent calls as the pool has connections waited for ever (ADR 0053, amendment
    // 2026-10-06) — unlike ADR 0020's `inviteUser`, which holds one connection and needs no other.
    // The path company goes INTO the call: the claim refuses another company's row with
    // ERR_NOT_FOUND in its own transaction, before the status check and before anything is claimed.
    // That makes a route-level pre-read redundant — and a pre-read in a separate transaction was
    // the weaker of the two anyway (AGENTS.md: the gate's company passes down into every call).
    const row = await cancelTransmission(c.var.db, c.var.ctx, {
      transmissionId,
      reason,
      companyId,
    }).catch(rethrowAsAppError);
    return c.json(toDto(row), 200);
  },
);

einvoiceTransmissionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{transmissionId}/poll",
    tags: ["accounting"],
    summary: "Reconcile a submitted transmission with the authority now",
    description:
      "One poll, called directly rather than through a job, for a row automatic polling has given up on: the worker stops re-enqueueing at its poll limit and leaves the row submitted. This route is not bound by that limit. A poll never demotes: an answer that is not a 2xx accepted, rejected or cancelled leaves the row submitted with the diagnostic in lastError (ADR 0053, amendment 2026-10-06). An authority fault (a 5xx, a 429 or a timeout) is recorded on the row, releases its claim and answers 500 ERR_INTERNAL; that answer is stored against the Idempotency-Key and replayed for it, so a retry needs a fresh key. The answer is recorded after the call, outside a request-spanning transaction: if the API stops between the two, the key becomes reclaimable after 120 seconds, and a retry with it polls again.",
    request: { params: PathParams, headers: IdempotencyHeader },
    middleware: [requirePermission(EINVOICE_PERMISSION.file, scope)],
    responses: {
      200: {
        description: "The transmission after the poll",
        content: { "application/json": { schema: EinvoiceTransmissionSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description:
          "Not submitted, or another call to the authority holds the claim — already in flight, or taken over from this call after the claim window, in which case nothing of this call was recorded",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      422: {
        description: "E-invoicing not enabled, or the transmitter is unavailable",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, transmissionId } = c.req.valid("param");
    // The POOL, and SELF_TRANSACTED, for the reasons the cancel route gives; the company is bound
    // inside the claim.
    const row = await pollTransmission(c.var.db, c.var.ctx, { transmissionId, companyId }).catch(
      rethrowAsAppError,
    );
    c.var.logger.info({ transmissionId, status: row.status }, "e-invoice transmission polled");
    return c.json(toDto(row), 200);
  },
);

export const einvoiceTransmissionRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/einvoice-transmissions",
  router: einvoiceTransmissionRoutes,
  permissions: [EINVOICE_PERMISSION.file],
  auth: "human",
};

/** MOUNTED ON 0B's `companyRoutes`, not registered as a module — see Step 6. */
export const einvoiceSettingsRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

einvoiceSettingsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{companyId}/einvoice-settings",
    tags: ["admin"],
    summary: "Read a company's e-invoicing configuration",
    request: { params: CompanyParams },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], settingsScope)],
    responses: {
      200: {
        description: "The three settings",
        content: { "application/json": { schema: EinvoiceSettingsSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const s = await c.var
      .withTenant((tx) => companySettings(tx, companyId))
      .catch(rethrowAsAppError);
    return c.json(EinvoiceSettingsSchema.parse(s), 200);
  },
);

einvoiceSettingsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{companyId}/einvoice-settings",
    tags: ["admin"],
    summary: "Set or clear a company's e-invoicing configuration",
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: EinvoiceSettingsBody } } },
    },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], settingsScope)],
    responses: {
      200: {
        description: "The stored settings",
        content: { "application/json": { schema: EinvoiceSettingsSchema } },
      },
      400: {
        description: "Invalid body",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const s = await c.var
      .withTenant((tx) => writeEinvoiceSettings(tx, { companyId, ...body }))
      .catch(rethrowAsAppError);
    // `credentialRef` is a NAME; `clientId` is not a secret. Neither field name matches
    // FORBIDDEN_LOG_FIELD, which is why amendment 6 chose them (Global Constraint 16).
    c.var.logger.info(
      { companyId, transmitter: s.transmitter, credentialRef: s.credentialRef },
      "e-invoice settings written",
    );
    return c.json(EinvoiceSettingsSchema.parse(s), 200);
  },
);
