import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  AttendanceList,
  AttendanceQuery,
  AttendanceEventSchema,
  RecordAttendanceBody,
} from "@dulja/contracts/hr/attendance";
import { AppError, ProblemSchema, decodeCursor, encodeCursor } from "@dulja/contracts";
import { listAttendance, recordAttendance, getEmployee } from "@dulja/db";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { IdempotencyHeader } from "../idempotency-header";
import { staffBranchGate, assertStaffBranchPermission } from "../staff-permission";

export const attendanceEventRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
const Params = z.object({ companyId: z.string().uuid() });

attendanceEventRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: Params, query: AttendanceQuery },
    middleware: [staffBranchGate(PERMISSION["hr.employee.read"])],
    responses: {
      200: {
        description: "attendance events",
        content: { "application/json": { schema: AttendanceList } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cursor && (cursor.k.length !== 0 || !z.string().uuid().safeParse(cursor.id).success))
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
    const { rows, nextCursor } = await c.var.withTenant((tx) =>
      listAttendance(tx, companyId, {
        limit: q.limit,
        ...(cursor ? { cursor } : {}),
        ...(q["filter[employeeId][eq]"] ? { employeeId: q["filter[employeeId][eq]"] } : {}),
        ...(q["filter[occurredAt][gte]"] ? { from: q["filter[occurredAt][gte]"] } : {}),
        ...(q["filter[occurredAt][lt]"] ? { to: q["filter[occurredAt][lt]"] } : {}),
      }),
    );
    return c.json(
      {
        items: rows.map((row) => AttendanceEventSchema.parse(row)),
        next_cursor: nextCursor ? encodeCursor({ k: [], id: nextCursor }) : null,
      },
      200,
    );
  },
);

attendanceEventRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: RecordAttendanceBody } } },
    },
    middleware: [staffBranchGate(PERMISSION["hr.attendance.record"])],
    responses: {
      201: {
        description: "the recorded event",
        content: { "application/json": { schema: AttendanceEventSchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
      404: {
        description: "no such employee",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const employee = await getEmployee(tx, companyId, body.employeeId);
      if (!employee) throw new AppError("ERR_NOT_FOUND", "employee is not visible");
      await assertStaffBranchPermission(
        tx,
        PERMISSION["hr.attendance.record"],
        companyId,
        body.branchId ?? employee.homeBranchId,
      );
      const created = await recordAttendance(tx, companyId, {
        employeeId: body.employeeId,
        kind: body.kind,
        occurredAt: body.occurredAt,
        terminalId: null,
        ...(body.branchId === undefined ? {} : { branchId: body.branchId }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.correctsEventId === undefined ? {} : { correctsEventId: body.correctsEventId }),
      });
      if (!created)
        throw new AppError(
          "ERR_NOT_FOUND",
          `employee ${body.employeeId} is not visible in company ${companyId}`,
        );
      return created;
    });
    return c.json(AttendanceEventSchema.parse(row), 201);
  },
);

export const attendanceEventRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/attendance-events",
  router: attendanceEventRoutes,
  permissions: [PERMISSION["hr.employee.read"], PERMISSION["hr.attendance.record"]],
  auth: "human",
};
