// apps/api/src/routes/admin/terminals.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateEnrolmentBody,
  CreatedEnrolmentSchema,
  EnrolmentList,
  EnrolmentQuery,
  type EnrolmentSchema,
} from "@dulja/contracts/sync/enrolment";
import { createEnrolment } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { AppEnv } from "../../context";

export const terminalRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

// The write gate is `{ company: "body:companyId" }`; the read gate is `{ company: "any" }` (§4.2.5's fourth
// variant) because `ScopeSource` has no `query:companyId` form and inventing one would widen a frozen union
// for one route. `{ company: "any" }` is not a bypass: it evaluates `exists (… app.actor_has($code, c.id))`
// inside `c.var.withTenant`, where RLS has already reduced `app.company` to the caller's tenant, and the
// handler's own `where company_id = $1` is what narrows it to the requested company.
terminalRoutes.openapi(
  createRoute({
    method: "post",
    path: "/enrolments",
    tags: ["admin"],
    request: {
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateEnrolmentBody } } },
    },
    middleware: [
      requirePermission(PERMISSION["admin.terminal.manage"], { company: "body:companyId" }),
    ],
    responses: {
      201: {
        description: "the code, shown once",
        content: { "application/json": { schema: CreatedEnrolmentSchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      409: {
        description: "that terminal code is taken",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const created = await c.var.withTenant((tx) =>
      createEnrolment(tx, c.get("ctx"), { ...body, ttlMinutes: body.ttlMinutes ?? 60 }),
    );
    // The plaintext code is in THIS response and nowhere else, ever (spec:1322). It is never logged: the
    // request logger's `forbidden_log_field` regex covers `secret`, and no handler line writes it.
    return c.json(created, 201);
  },
);

terminalRoutes.openapi(
  createRoute({
    method: "get",
    path: "/enrolments",
    tags: ["admin"],
    request: { query: EnrolmentQuery },
    middleware: [requirePermission(PERMISSION["admin.terminal.manage"], { company: "any" })],
    responses: {
      200: {
        description: "the company's enrolments",
        content: { "application/json": { schema: EnrolmentList } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("query");
    await c.var.withTenant(async (tx) => {
      const [scope] = await tx<
        { ok: boolean }[]
      >`select app.actor_has('admin.terminal.manage', ${companyId}, null) as ok`;
      if (!scope?.ok)
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          "terminal management is not permitted in this company",
        );
    });
    // Every column EXCEPT code_hash, named one by one. `EnrolmentSchema` has no `codeHash` member, so even if
    // this became a `select *` the response would fail wire validation rather than leak the hash (SAH-025).
    const items = await c.var.withTenant(
      (tx) => tx<z.infer<typeof EnrolmentSchema>[]>`
      select id, company_id as "companyId", branch_id as "branchId", name, terminal_code as "terminalCode",
             expires_at as "expiresAt", redeemed_at as "redeemedAt", terminal_id as "terminalId",
             created_at as "createdAt"
        from app.terminal_enrolment
       where company_id = ${companyId}
       order by created_at desc, id desc`,
    );
    return c.json({ items, next_cursor: null }, 200);
  },
);

terminalRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{terminalId}/revoke",
    tags: ["admin"],
    request: { headers: IdempotencyHeader, params: z.object({ terminalId: UuidSchema }) },
    middleware: [requirePermission(PERMISSION["admin.terminal.manage"], { company: "any" })],
    responses: { 204: { description: "revoked" } },
  }),
  async (c) => {
    const { terminalId } = c.req.valid("param");
    // `where revoked_at is null` makes a second call a no-op, and the answer is 204 either way: revocation is
    // idempotent by nature (spec:1322 — "revoked_at set → ERR_TERMINAL_REVOKED" is the WHOLE story), and a 409
    // on the second call would make a retry after a timeout look like a failure and invite a support script
    // that clears the column. A terminal in another tenant is invisible under RLS and updates zero rows, which
    // is also a 204 — the same answer as "already revoked", so no probe learns whether the id exists.
    await c.var.withTenant(
      (tx) =>
        tx`update app.pos_terminal set revoked_at = now() where id = ${terminalId} and revoked_at is null
         and app.actor_has('admin.terminal.manage', company_id, branch_id)`,
    );
    return c.body(null, 204);
  },
);
