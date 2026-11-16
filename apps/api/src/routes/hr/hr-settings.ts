import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { HrSettingSchema, UpdateHrSettingBody } from "@dulja/contracts/hr/hr-setting";
import { PERMISSION } from "@dulja/contracts/permissions";
import { listSchemes, readHrSetting, setEmployerRegistration, upsertHrSetting } from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
// §3.6.2 fixes that company HR settings are maintained under the company-administration code, so this slice seeds
// no seventh code (hazard 26).
const manage = PERMISSION["admin.company.manage"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** The settings row and every scheme's registration, in one read. Before anything is stored the §2.12 default
 *  (`calendar_days`, no pay day) is answered — ⚠️ OD-23 leaves the company with no row. */
const read = async (tx: Sql, companyId: string) => {
  const setting = await readHrSetting(tx, companyId);
  const schemes = await listSchemes(tx, companyId);
  return {
    companyId,
    prorationRule: setting?.prorationRule ?? ("calendar_days" as const),
    payDay: setting?.payDay ?? null,
    employerRegistrations: schemes.map((s) => ({
      schemeId: s.id,
      schemeCode: s.code,
      registration: s.employerRegistration,
    })),
  };
};

/** 8A T11 (⚠️ OD-23) — the company's proration rule, pay day and employer registrations. */
export const hrSettingRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

hrSettingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams },
    middleware: [requirePermission(manage, gate)],
    responses: {
      200: {
        description: "The settings and every scheme's registration",
        content: { "application/json": { schema: HrSettingSchema } },
      },
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    return c.json(await c.var.withTenant((tx) => read(tx, companyId)), 200);
  },
);

hrSettingRoutes.openapi(
  createRoute({
    method: "put",
    path: "/",
    tags: ["hr"],
    request: {
      params: CompanyParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: UpdateHrSettingBody } } },
    },
    middleware: [requirePermission(manage, gate)],
    responses: {
      200: {
        description: "Stored",
        content: { "application/json": { schema: HrSettingSchema } },
      },
      400: problem("validation failed"),
      403: problem("forbidden"),
      404: problem("a named scheme is not one of this company's"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      // Every scheme id is bound to the PATH company before anything is written: RLS bounds the tenant only, so a
      // sibling company's scheme id would otherwise take this company's registration (the 8A employee-scope rule).
      const own = new Set((await listSchemes(tx, companyId)).map((s) => s.id));
      for (const r of body.employerRegistrations)
        if (!own.has(r.schemeId))
          throw new AppError("ERR_NOT_FOUND", `statutory scheme ${r.schemeId} was not found`);
      await upsertHrSetting(tx, {
        companyId,
        prorationRule: body.prorationRule,
        payDay: body.payDay,
      });
      for (const r of body.employerRegistrations)
        await setEmployerRegistration(tx, r.schemeId, r.registration);
      return read(tx, companyId);
    });
    return c.json(dto, 200);
  },
);

export const hrSettingRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/hr-settings",
  router: hrSettingRoutes,
  permissions: [manage],
  auth: "human",
};
