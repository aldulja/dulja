import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import { AppError, ProblemSchema, decodeCursor, encodeCursor } from "@dulja/contracts";
import {
  CashierSchema,
  CashierList,
  CashierQuery,
  CreateCashierBody,
  SetPinBody,
} from "@dulja/contracts/pos/cashier";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  getEmployee,
  linkEmployeePrincipal,
  createCashier,
  getCashier,
  listCashiers,
  setCashierPin,
  revokeCashier,
  hashPin,
  lockTenantAuditSerial,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import type { AuthAdmin } from "../../ports";
import { IdempotencyHeader } from "../idempotency-header";
import { requirePermission } from "../../middleware/require-permission";
import { staffBranchGate, assertStaffBranchPermission } from "../staff-permission";
const Params = z.object({ companyId: z.string().uuid() }),
  IdParams = Params.extend({ principalId: z.string().uuid() });
const manage = PERMISSION["pos.cashier.manage_pin"],
  users = PERMISSION["admin.user.manage"];
const missing = () => new AppError("ERR_NOT_FOUND", "cashier or employee is not visible");
const errors = {
  403: {
    description: "forbidden",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
  404: {
    description: "not found",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
  409: {
    description: "already linked or registered",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
};
export function createCashierRoutes(authAdmin: AuthAdmin): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
  router.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["pos"],
      request: { params: Params, query: CashierQuery },
      middleware: [staffBranchGate(manage)],
      responses: {
        200: { description: "cashiers", content: { "application/json": { schema: CashierList } } },
        ...errors,
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param"),
        q = c.req.valid("query"),
        cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
      if (cursor && (cursor.k.length !== 0 || !z.string().uuid().safeParse(cursor.id).success))
        throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
      const result = await c.var.withTenant((tx) =>
        listCashiers(tx, companyId, {
          limit: q.limit,
          ...(cursor ? { cursor } : {}),
          ...(q["filter[branchId][eq]"] ? { branchId: q["filter[branchId][eq]"] } : {}),
        }),
      );
      return c.json(
        {
          items: result.rows.map((row) => CashierSchema.parse(row)),
          next_cursor: result.nextCursor ? encodeCursor({ k: [], id: result.nextCursor }) : null,
        },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/{principalId}",
      tags: ["pos"],
      request: { params: IdParams },
      middleware: [staffBranchGate(manage)],
      responses: {
        200: { description: "cashier", content: { "application/json": { schema: CashierSchema } } },
        ...errors,
      },
    }),
    async (c) => {
      const { companyId, principalId } = c.req.valid("param");
      const row = await c.var.withTenant(async (tx) => {
        const cashier = await getCashier(tx, companyId, principalId);
        if (!cashier) throw missing();
        await assertStaffBranchPermission(tx, manage, companyId, cashier.branchId);
        return cashier;
      });
      return c.json(CashierSchema.parse(row), 200);
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["pos"],
      request: {
        params: Params,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: CreateCashierBody } } },
      },
      middleware: [requirePermission(users, { company: "path:companyId" })],
      responses: {
        201: { description: "cashier", content: { "application/json": { schema: CashierSchema } } },
        ...errors,
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param"),
        body = c.req.valid("json");
      const row = await c.var.withTenant(async (tx) => {
        await lockTenantAuditSerial(tx, c.var.ctx.tenantId);
        const [locked] =
          await tx`select id from app.employee where company_id=${companyId} and id=${body.employeeId} for update`;
        if (!locked) throw missing();
        const employee = await getEmployee(tx, companyId, body.employeeId);
        if (!employee || employee.terminatedOn !== null) throw missing();
        if (employee.principalId !== null)
          throw new AppError("ERR_CONFLICT_UNIQUE", "employee already has a principal");
        const [branch] =
          await tx`select 1 from app.dimension_value v join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where v.id=${body.branchId} and t.company_id=${companyId} and t.code='BRANCH' and v.archived_at is null`;
        if (!branch) throw missing();
        const [held] =
          await tx`select p.id from app.principal p join app.membership m on m.principal_id=p.id and m.tenant_id=app.current_tenant() where lower(p.email)=lower(${body.email})`;
        if (held) throw new AppError("ERR_CONFLICT_UNIQUE", "email already belongs to a principal");
        const pinHash = await hashPin(body.pin);
        const created = await authAdmin.createUser(body.email),
          principalId = newUuidV7();
        await tx`insert into app.principal(id,kind,auth_subject,email,display_name) values(${principalId},'human',${created.sub},${created.email},${body.displayName})`;
        await tx`insert into app.membership(tenant_id,principal_id) values(app.current_tenant(),${principalId})`;
        await linkEmployeePrincipal(tx, companyId, body.employeeId, principalId);
        return createCashier(tx, companyId, {
          principalId,
          employeeId: body.employeeId,
          branchId: body.branchId,
          pinHash,
        });
      });
      return c.json(CashierSchema.parse(row), 201);
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/{principalId}/pin",
      tags: ["pos"],
      request: {
        params: IdParams,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: SetPinBody } } },
      },
      middleware: [staffBranchGate(manage)],
      responses: {
        200: {
          description: "cashier with reset credential",
          content: { "application/json": { schema: CashierSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { companyId, principalId } = c.req.valid("param"),
        body = c.req.valid("json");
      const row = await c.var.withTenant(async (tx) => {
        const original = await getCashier(tx, companyId, principalId);
        if (!original) throw missing();
        await assertStaffBranchPermission(tx, manage, companyId, original.branchId);
        const updated = await setCashierPin(tx, companyId, principalId, await hashPin(body.pin));
        if (!updated) throw missing();
        return updated;
      });
      return c.json(CashierSchema.parse(row), 200);
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/{principalId}/revoke",
      tags: ["pos"],
      request: {
        params: IdParams,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: z.object({}).strict() } } },
      },
      middleware: [requirePermission(users, { company: "path:companyId" })],
      responses: {
        200: {
          description: "revoked credential",
          content: { "application/json": { schema: CashierSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { companyId, principalId } = c.req.valid("param");
      const row = await c.var.withTenant((tx) => revokeCashier(tx, companyId, principalId));
      if (!row) throw missing();
      return c.json(CashierSchema.parse(row), 200);
    },
  );
  return router;
}
export function cashierRouteModule(authAdmin: AuthAdmin): RouteModule {
  return {
    path: "/v1/companies/:companyId/cashiers",
    router: createCashierRoutes(authAdmin),
    permissions: [manage, users],
    auth: "human",
  };
}
