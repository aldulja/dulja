import { createPublicKey } from "node:crypto";
// apps/api/src/routes/sync/enrolments.ts — the ONE public route in this slice.
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { EnrolBody, EnrolResultSchema } from "@dulja/contracts/sync/enrolment";
import {
  hashEnrolmentCode,
  redeemEnrolment,
  resolveEnrolment,
  SyncError,
  systemContext,
  withTenant,
} from "@dulja/db";
import type { AppEnv } from "../../context";

export const enrolmentRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/**
 * `POST /v1/sync/enrol` — §4.10.3's frozen path, and the system's ONE unsafe public route.
 *
 * **No `Idempotency-Key`, deliberately** (Task 0 amendment 21). §4.2.9's middleware keys on
 * `(tenant_id, principal_id, key)` and opens its own `withTenant` on `c.var.ctx`; a `auth: "public"` module
 * has neither a tenant nor a principal, so mounting it here would raise `ERR_TENANT_CONTEXT_MISSING` (500) on
 * every enrolment — and declaring the header without mounting the middleware would be worse, because the
 * OpenAPI document would promise a guarantee nothing enforces. `createApp` attaches `idempotency` from the
 * same `route.auth` switch that attaches `terminalAuth`, and `"public"` gets neither.
 *
 * The route is idempotent in its own right, which is the condition Task 0 amendment 21 sets for being public
 * and unsafe at all: redemption is `update … set redeemed_at = now() where redeemed_at is null returning …`,
 * so a second call with the same code — a retry after a timeout, or a stolen code — answers exactly the same
 * `ERR_TERMINAL_ENROLMENT_INVALID` as an unknown one, and creates no second terminal.
 */
enrolmentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["sync"],
    request: { body: { content: { "application/json": { schema: EnrolBody } } } },
    responses: {
      201: {
        description: "enrolled",
        content: { "application/json": { schema: EnrolResultSchema } },
      },
      400: {
        description: "invalid code",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    // The raw pool, not `c.var.withTenant`: there is no tenant yet and inventing one from the request would
    // be LEGACY-026 rebuilt. `db` is an `AppEnv["Variables"]` member set by createApp from AppDeps (Task 0
    // amendment 7), and this handler is one of exactly two call sites in the system.
    const db = c.get("db");
    // Step 1 runs with NO tenant: the SECURITY DEFINER door of migration 0060.
    const found = await resolveEnrolment(db, hashEnrolmentCode(body.code));
    if (found.length === 0) {
      // The SAME problem for unknown, expired and spent. A probe learns only "that is not a code" (LEGACY-025).
      throw new AppError("ERR_TERMINAL_ENROLMENT_INVALID", "that enrolment code is not valid");
    }
    const enrolment = found[0]!;
    const der = Buffer.from(body.devicePublicKey, "base64");
    if (der.length !== 44)
      throw new AppError("ERR_VALIDATION_FAILED", "devicePublicKey is not an Ed25519 SPKI key");

    try {
      if (
        createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519"
      )
        throw new Error("wrong key type");
    } catch {
      throw new AppError("ERR_VALIDATION_FAILED", "devicePublicKey is not an Ed25519 SPKI key");
    }

    // Step 2 runs as the tenant's SYSTEM principal: there is no human here and the terminal does not exist yet,
    // so the only identity that can create it is the tenant's own (spec:2179's system-principal clause).
    const ctx = await systemContext(db, enrolment.tenantId, c.get("requestId"));
    try {
      const terminal = await withTenant(db, ctx, (tx) => redeemEnrolment(tx, enrolment, der));
      return c.json(
        {
          terminalId: terminal.terminalId,
          branchId: terminal.branchId,
          companyId: terminal.companyId,
        },
        201,
      );
    } catch (e) {
      if (e instanceof SyncError) throw new AppError(e.code, e.detail);
      throw e;
    }
  },
);
