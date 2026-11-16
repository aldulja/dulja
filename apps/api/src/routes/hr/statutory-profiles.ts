import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ProblemSchema } from "@dulja/contracts";
import {
  OpenStatutoryProfileBody,
  StatutoryProfileList,
  StatutoryProfileQuery,
  StatutoryProfileSchema,
} from "@dulja/contracts/hr/statutory-profile";
import { PERMISSION } from "@dulja/contracts/permissions";
import { listStatutoryProfiles, openStatutoryProfile, type StatutoryProfile } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { requireEmployeeInCompany } from "./employee-scope";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** The wire object, written out once, so a column added to `StatutoryProfile` cannot reach the API by accident. */
const toDto = (p: StatutoryProfile) => ({
  id: p.id,
  employeeId: p.employeeId,
  effectiveFrom: p.effectiveFrom,
  effectiveTo: p.effectiveTo,
  maritalStatus: p.maritalStatus,
  spouseWorking: p.spouseWorking,
  childReliefCount: p.childReliefCount,
  residencyCategory: p.residencyCategory,
  extra: p.extra,
  enteredBy: p.enteredBy,
  createdAt: p.createdAt,
});

/** 8A T5 — two sub-paths composed onto 6C's employees module (A16). A plain const: it closes over no key ring. The
 *  list is gated by the compensation READ code, not by membership: spec:2450 names it in acceptance test 32, so the
 *  pre-flight and the `compensation_gate` RLS policy agree. */
export const statutoryProfileRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

statutoryProfileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{employeeId}/statutory-profiles",
    tags: ["hr"],
    // `query` is declared although the handler reads nothing out of it: an undeclared query schema validates
    // NOTHING, and test 32 needs `?sort=…`, `?filter[…]` and `?fields=…` to be 400 rather than a silent 200.
    request: { params: Params, query: StatutoryProfileQuery },
    middleware: [requirePermission(PERMISSION["hr.compensation.read"], gate)],
    responses: {
      200: {
        description: "Newest first",
        content: { "application/json": { schema: StatutoryProfileList } },
      },
      403: problem("forbidden"),
      404: problem("no such employee in this company"),
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const items = await c.var.withTenant(async (tx) => {
      // 404 and never an empty list for an employee the caller cannot see: an empty list reads as "exists, no
      // profiles yet", and one answer for both keeps employee ids from being discovered by the answer's shape.
      await requireEmployeeInCompany(tx, companyId, employeeId);
      return listStatutoryProfiles(tx, employeeId);
    });
    return c.json({ items: items.map(toDto), next_cursor: null }, 200);
  },
);

statutoryProfileRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{employeeId}/statutory-profiles",
    tags: ["hr"],
    request: {
      params: Params,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: OpenStatutoryProfileBody } } },
    },
    middleware: [requirePermission(PERMISSION["hr.compensation.manage"], gate)],
    responses: {
      201: {
        description: "Opened; the previous row is closed",
        content: { "application/json": { schema: StatutoryProfileSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such employee in this company"),
      409: problem("a principal may not write their own profile (R4), or the date collides"),
    },
  }),
  async (c) => {
    const { companyId, employeeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await requireEmployeeInCompany(tx, companyId, employeeId);
      const id = await openStatutoryProfile(tx, employeeId, {
        effectiveFrom: body.effectiveFrom,
        maritalStatus: body.maritalStatus,
        spouseWorking: body.spouseWorking,
        childReliefCount: body.childReliefCount,
        residencyCategory: body.residencyCategory,
        extra: body.extra,
      });
      const rows = await listStatutoryProfiles(tx, employeeId);
      return toDto(rows.find((r) => r.id === id)!);
    });
    return c.json(dto, 201);
  },
);
