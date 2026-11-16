import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import {
  CreateLeaveRecordBody,
  CreateLeaveTypeBody,
  CreatePublicHolidayBody,
  LeaveDecisionBody,
  LeaveEntitlementList,
  LeaveEntitlementQuery,
  LeaveEntitlementSchema,
  LeaveRecordList,
  LeaveRecordQuery,
  LeaveRecordSchema,
  LeaveTypeList,
  LeaveTypeQuery,
  LeaveTypeSchema,
  PublicHolidayList,
  PublicHolidayQuery,
  PublicHolidaySchema,
  SetLeaveEntitlementBody,
} from "@dulja/contracts/hr/leave";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  approveLeave,
  createLeaveType,
  createPublicHoliday,
  listEntitlements,
  listLeaveRecords,
  listLeaveTypes,
  listPublicHolidays,
  rejectLeave,
  requestLeave,
  setEntitlement,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

/**
 * 8D Task 8 — ⚠️ OD-13 answered BUILD on 2026-11-07 (contracts round 19, 8D A14): spec:2085's minimal leave register,
 * one module and one `PROBES` key (hazard 31). Seven routes:
 *
 *   POST /                            request leave for an employee        hr.leave.record
 *   GET  /                            the register                         hr.employee.read
 *   POST /{leaveRecordId}/decision    approve or reject                    hr.leave.approve
 *   GET|POST /types                   the company's leave types            hr.leave.record
 *   GET|PUT  /entitlements            yearly entitlements (an upsert)      hr.leave.record
 *   GET|POST /holidays                public holidays (NULL branch = all)  hr.leave.record
 *
 * Every gate clears the PATH company and every service call is bound to it (RLS bounds the tenant only): an
 * employee, leave type or branch of another company is 404. No `if` here decides a rule — R4 (no self-approval,
 * spec:2175, test 31) is 0096's trigger and arrives as `ERR_HR_SELF_PAY` (409); a decided record is final
 * (`ERR_TABLE_IMMUTABLE`, 409); a duplicate type or holiday is the unique constraint (`ERR_CONFLICT_UNIQUE`, 409).
 * Static segments (`/types`, `/entitlements`, `/holidays`) sit where `/{leaveRecordId}` would, but no
 * `GET /{leaveRecordId}` exists and the decision route is one segment deeper, so nothing shadows anything.
 */
export const leaveRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

const CompanyParams = z.object({ companyId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

leaveRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateLeaveRecordBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      201: {
        description: "The request, at status `requested` with no decider",
        content: { "application/json": { schema: LeaveRecordSchema } },
      },
      400: problem(
        "validation failed (a span ending before it starts, or more days than the span)",
      ),
      403: problem("forbidden"),
      404: problem("the employee or the leave type is not one of this company's"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const id = await requestLeave(tx, {
        companyId,
        employeeId: body.employeeId,
        leaveTypeId: body.leaveTypeId,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        days: body.days,
        reason: body.reason,
      });
      // Read back BY ID, so the response is the row this request wrote and never "whatever sorted first".
      const [created] = await listLeaveRecords(tx, { companyId, id, limit: 1 });
      return created!;
    });
    return c.json(LeaveRecordSchema.parse(row), 201);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: LeaveRecordQuery },
    // An establishment read (who is away, when): the directory's own code, as the `leave_record` dataset's.
    middleware: [requirePermission(PERMISSION["hr.employee.read"], gate)],
    responses: {
      200: {
        description: "Leave records, newest start first; `next_cursor` is always null",
        content: { "application/json": { schema: LeaveRecordList } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) =>
      listLeaveRecords(tx, {
        companyId,
        limit: q.limit,
        ...(q["filter[status][eq]"] ? { status: q["filter[status][eq]"] } : {}),
        ...(q["filter[employee_id][eq]"] ? { employeeId: q["filter[employee_id][eq]"] } : {}),
        ...(q["filter[leave_type_id][eq]"] ? { leaveTypeId: q["filter[leave_type_id][eq]"] } : {}),
        ...(q["filter[starts_on][gte]"] ? { fromDate: q["filter[starts_on][gte]"] } : {}),
        ...(q["filter[starts_on][lte]"] ? { toDate: q["filter[starts_on][lte]"] } : {}),
      }),
    );
    return c.json({ items: items.map((r) => LeaveRecordSchema.parse(r)), next_cursor: null }, 200);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{leaveRecordId}/decision",
    tags: ["hr"],
    request: {
      params: z.object({ companyId: z.string().uuid(), leaveRecordId: z.string().uuid() }),
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: LeaveDecisionBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.approve"], gate)],
    responses: {
      200: {
        description: "The decided record; `approvedBy` is the session principal",
        content: { "application/json": { schema: LeaveRecordSchema } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
      404: problem("no such record visible in this company"),
      409: problem(
        "R4 — the actor is the employee whose leave this is (ERR_HR_SELF_PAY, spec:2175); or the record is already decided (ERR_TABLE_IMMUTABLE)",
      ),
    },
  }),
  async (c) => {
    const { companyId, leaveRecordId } = c.req.valid("param");
    const { decision, reason } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const decided =
        decision === "approved"
          ? await approveLeave(tx, { companyId, leaveRecordId })
          : await rejectLeave(tx, { companyId, leaveRecordId, reason: reason ?? null });
      if (!decided) return null;
      const [only] = await listLeaveRecords(tx, { companyId, id: leaveRecordId, limit: 1 });
      return only ?? null;
    });
    if (row === null)
      throw new AppError(
        "ERR_NOT_FOUND",
        `leave record ${leaveRecordId} was not found in this company`,
      );
    return c.json(LeaveRecordSchema.parse(row), 200);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "get",
    path: "/types",
    tags: ["hr"],
    request: { params: CompanyParams, query: LeaveTypeQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      200: {
        description: "The company's leave types, by code; `next_cursor` is always null",
        content: { "application/json": { schema: LeaveTypeList } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) =>
      listLeaveTypes(tx, { companyId, includeArchived: q.includeArchived, limit: q.limit }),
    );
    return c.json({ items: items.map((r) => LeaveTypeSchema.parse(r)), next_cursor: null }, 200);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "post",
    path: "/types",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreateLeaveTypeBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      201: {
        description: "The created type",
        content: { "application/json": { schema: LeaveTypeSchema } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
      409: problem("this company already has a type with that code (ERR_CONFLICT_UNIQUE)"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = await c.var.withTenant((tx) =>
      createLeaveType(tx, {
        companyId,
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr,
        paid: body.paid,
      }),
    );
    // Every member is the returned id or a field of the validated body; a fresh type is never archived.
    return c.json(
      LeaveTypeSchema.parse({
        id,
        code: body.code,
        nameEn: body.nameEn,
        nameAr: body.nameAr,
        paid: body.paid,
        archivedAt: null,
      }),
      201,
    );
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "get",
    path: "/entitlements",
    tags: ["hr"],
    request: { params: CompanyParams, query: LeaveEntitlementQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      200: {
        description: "Yearly entitlements; `next_cursor` is always null",
        content: { "application/json": { schema: LeaveEntitlementList } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) =>
      listEntitlements(tx, {
        companyId,
        limit: q.limit,
        ...(q["filter[employee_id][eq]"] ? { employeeId: q["filter[employee_id][eq]"] } : {}),
        ...(q["filter[year][eq]"] === undefined ? {} : { year: q["filter[year][eq]"] }),
        ...(q["filter[leave_type_id][eq]"] ? { leaveTypeId: q["filter[leave_type_id][eq]"] } : {}),
      }),
    );
    return c.json(
      { items: items.map((r) => LeaveEntitlementSchema.parse(r)), next_cursor: null },
      200,
    );
  },
);

// PUT, not POST: `setEntitlement` is an upsert on the natural key (employee, year, type) and there is no accrual
// engine (spec:2085), so the same body twice leaves the same figure. The read-back filters on all three key parts.
leaveRoutes.openapi(
  createRoute({
    method: "put",
    path: "/entitlements",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: SetLeaveEntitlementBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      200: {
        description: "The stored entitlement",
        content: { "application/json": { schema: LeaveEntitlementSchema } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
      404: problem("the employee or the leave type is not one of this company's"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await setEntitlement(tx, {
        companyId,
        employeeId: body.employeeId,
        year: body.year,
        leaveTypeId: body.leaveTypeId,
        days: body.days,
      });
      // The upsert and this read share one transaction and the filter is the table's own natural key, so the row
      // just written is always found: an empty result would be an invariant break, not a client outcome.
      const [only] = await listEntitlements(tx, {
        companyId,
        employeeId: body.employeeId,
        year: body.year,
        leaveTypeId: body.leaveTypeId,
        limit: 1,
      });
      return only!;
    });
    return c.json(LeaveEntitlementSchema.parse(row), 200);
  },
);

leaveRoutes.openapi(
  createRoute({
    method: "get",
    path: "/holidays",
    tags: ["hr"],
    request: { params: CompanyParams, query: PublicHolidayQuery },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      200: {
        description:
          "Public holidays the caller's branches see (a NULL branch is every branch); `next_cursor` is always null",
        content: { "application/json": { schema: PublicHolidayList } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await c.var.withTenant((tx) =>
      listPublicHolidays(tx, {
        companyId,
        limit: q.limit,
        ...(q["filter[holiday_on][gte]"] ? { fromDate: q["filter[holiday_on][gte]"] } : {}),
        ...(q["filter[holiday_on][lte]"] ? { toDate: q["filter[holiday_on][lte]"] } : {}),
      }),
    );
    return c.json(
      { items: items.map((r) => PublicHolidaySchema.parse(r)), next_cursor: null },
      200,
    );
  },
);

// The duplicate refused here is the one `unique nulls not distinct` exists for: two company-wide holidays on the
// same date (23505 → ERR_CONFLICT_UNIQUE). A branch outside the caller's branches is Form B's refusal.
leaveRoutes.openapi(
  createRoute({
    method: "post",
    path: "/holidays",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: CreatePublicHolidayBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.leave.record"], gate)],
    responses: {
      201: {
        description: "The created holiday",
        content: { "application/json": { schema: PublicHolidaySchema } },
      },
      400: problem("validation failed"),
      403: problem("forbidden, or the branch is outside the caller's branches"),
      404: problem("the branch is not a branch of this company"),
      409: problem(
        "that date already carries a holiday for this branch, or company-wide (ERR_CONFLICT_UNIQUE)",
      ),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const id = await c.var.withTenant((tx) =>
      createPublicHoliday(tx, {
        companyId,
        branchId: body.branchId,
        holidayOn: body.holidayOn,
        nameEn: body.nameEn,
        nameAr: body.nameAr,
      }),
    );
    return c.json(
      PublicHolidaySchema.parse({
        id,
        branchId: body.branchId,
        holidayOn: body.holidayOn,
        nameEn: body.nameEn,
        nameAr: body.nameAr,
      }),
      201,
    );
  },
);

export const leaveRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/leave-records",
  router: leaveRoutes,
  permissions: [
    PERMISSION["hr.leave.record"],
    PERMISSION["hr.leave.approve"],
    PERMISSION["hr.employee.read"],
  ],
  auth: "human",
};
