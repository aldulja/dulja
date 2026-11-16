import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema, decodeCursor, encodeCursor } from "@dulja/contracts";
import {
  EmployeeSchema,
  EmployeeList,
  EmployeeQuery,
  CreateEmployeeBody,
  TerminateEmployeeBody,
  UpdateEmployeeBody,
} from "@dulja/contracts/hr/employee";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  createEmployee,
  getEmployee,
  listEmployees,
  terminateEmployee,
  updateEmployee,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";
import { staffBranchGate, assertStaffBranchPermission } from "../staff-permission";
export const employeeRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const Params = z.object({ companyId: z.string().uuid() }),
  IdParams = Params.extend({ employeeId: z.string().uuid() });
const read = PERMISSION["hr.employee.read"],
  manage = PERMISSION["hr.employee.manage"];
const missing = () => new AppError("ERR_NOT_FOUND", "employee is not visible");
const errors = {
  403: {
    description: "forbidden",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
  404: {
    description: "not found",
    content: { "application/problem+json": { schema: ProblemSchema } },
  },
};
employeeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: Params, query: EmployeeQuery },
    middleware: [staffBranchGate(read)],
    responses: {
      200: { description: "employees", content: { "application/json": { schema: EmployeeList } } },
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
      listEmployees(tx, companyId, {
        limit: q.limit,
        ...(cursor ? { cursor } : {}),
        ...(q["filter[homeBranchId][eq]"] ? { branchId: q["filter[homeBranchId][eq]"] } : {}),
        ...(q["filter[active][eq]"] ? { active: q["filter[active][eq]"] === "true" } : {}),
      }),
    );
    return c.json(
      {
        items: result.rows.map((row) => EmployeeSchema.parse(row)),
        next_cursor: result.nextCursor ? encodeCursor({ k: [], id: result.nextCursor }) : null,
      },
      200,
    );
  },
);
employeeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{employeeId}",
    tags: ["hr"],
    request: { params: IdParams },
    middleware: [staffBranchGate(read)],
    responses: {
      200: { description: "employee", content: { "application/json": { schema: EmployeeSchema } } },
      ...errors,
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      const employee = await getEmployee(tx, companyId, employeeId);
      if (!employee) throw missing();
      await assertStaffBranchPermission(tx, read, companyId, employee.homeBranchId);
      return employee;
    });
    return c.json(EmployeeSchema.parse(row), 200);
  },
);
employeeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateEmployeeBody } } },
    },
    middleware: [staffBranchGate(manage)],
    responses: {
      201: { description: "employee", content: { "application/json": { schema: EmployeeSchema } } },
      409: {
        description: "duplicate employee number",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      ...errors,
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param"),
      body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await assertStaffBranchPermission(tx, manage, companyId, body.homeBranchId);
      return createEmployee(tx, companyId, {
        employeeNumber: body.employeeNumber,
        nameEn: body.nameEn,
        homeBranchId: body.homeBranchId,
        hiredOn: body.hiredOn,
        ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.employmentType === undefined ? {} : { employmentType: body.employmentType }),
      });
    });
    return c.json(EmployeeSchema.parse(row), 201);
  },
);
// ADR 0097 (full review PRD-07): edit and terminate. The path company is passed into every service call and the
// manage code is asked again at the employee's own home branch, as GET asks the read code.
employeeRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{employeeId}",
    tags: ["hr"],
    summary: "Edit an employee's non-sensitive master fields",
    request: {
      params: IdParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateEmployeeBody } } },
    },
    middleware: [staffBranchGate(manage)],
    responses: {
      200: { description: "employee", content: { "application/json": { schema: EmployeeSchema } } },
      400: {
        description: "invalid, or an undeclared field",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      ...errors,
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param"),
      body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const employee = await getEmployee(tx, companyId, employeeId);
      if (!employee) throw missing();
      await assertStaffBranchPermission(tx, manage, companyId, employee.homeBranchId);
      const updated = await updateEmployee(tx, companyId, employeeId, {
        ...(body.nameEn === undefined ? {} : { nameEn: body.nameEn }),
        ...(body.nameAr === undefined ? {} : { nameAr: body.nameAr }),
        ...(body.hiredOn === undefined ? {} : { hiredOn: body.hiredOn }),
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.employmentType === undefined ? {} : { employmentType: body.employmentType }),
      });
      if (!updated) throw missing();
      return updated;
    });
    return c.json(EmployeeSchema.parse(row), 200);
  },
);
employeeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{employeeId}/terminate",
    tags: ["hr"],
    summary: "Terminate an employee (0093's trigger expires their roles and till credentials)",
    request: {
      params: IdParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: TerminateEmployeeBody } } },
    },
    middleware: [staffBranchGate(manage)],
    responses: {
      200: { description: "employee", content: { "application/json": { schema: EmployeeSchema } } },
      400: {
        description: "invalid, or before the hire date",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      ...errors,
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param"),
      { terminatedOn } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const employee = await getEmployee(tx, companyId, employeeId);
      if (!employee) throw missing();
      await assertStaffBranchPermission(tx, manage, companyId, employee.homeBranchId);
      const terminated = await terminateEmployee(tx, companyId, employeeId, terminatedOn);
      if (!terminated) throw missing();
      return terminated;
    });
    return c.json(EmployeeSchema.parse(row), 200);
  },
);
export const employeeRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/employees",
  router: employeeRoutes,
  permissions: [read, manage],
  auth: "human",
};
