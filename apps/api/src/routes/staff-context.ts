import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { StaffContextSchema, type StaffContext } from "@dulja/contracts/admin/staff-context";
import { PERMISSION } from "@dulja/contracts/permissions";
import { listStaffContext } from "@dulja/db";
import type { AppEnv } from "../context";
import { markPermissionGate } from "../middleware/require-permission";
import type { RouteModule } from "./index";

// The gates of the screens the selector serves: 6C's four staff codes, 6D's shift reports, the branch limits and —
// 8B T15 — the payroll run screens, which the approver and the auditor open with `hr.payroll.read` alone.
const permissions = [
  PERMISSION["hr.employee.read"],
  PERMISSION["hr.employee.manage"],
  PERMISSION["hr.attendance.record"],
  PERMISSION["pos.cashier.manage_pin"],
  PERMISSION["pos.report.read"],
  PERMISSION["admin.company.manage"],
  PERMISSION["hr.payroll.read"],
] as const;
export const staffContextRoutes = new OpenAPIHono<AppEnv>();
// Company:any gates cannot admit a branch-only assignment. The repository checks
// each actual company/branch through actor_has; an empty projection is refused.
const scopedProjectionGate = markPermissionGate(async (_context, next) => {
  await next();
}, permissions);
staffContextRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    summary: "List accessible staff-screen branches",
    middleware: [scopedProjectionGate] as const,
    responses: {
      200: {
        description: "Accessible company and branch context",
        content: { "application/json": { schema: StaffContextSchema } },
      },
      403: {
        description: "No staff branch authority",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (context) => {
    const rows = await context.var.withTenant(listStaffContext);
    if (rows.length === 0) throw new AppError("ERR_RBAC_FORBIDDEN", "No accessible staff branch");
    const companies = new Map<string, StaffContext["companies"][number]>();
    for (const row of rows) {
      let company = companies.get(row.company_id);
      if (!company) {
        company = {
          id: row.company_id,
          code: row.company_code,
          name: row.company_name,
          baseCurrency: row.base_currency,
          branches: [],
        };
        companies.set(row.company_id, company);
      }
      company.branches.push({
        id: row.branch_id,
        code: row.branch_code,
        nameEn: row.name_en,
        nameAr: row.name_ar,
      });
    }
    return context.json({ companies: [...companies.values()] }, 200);
  },
);
export const staffContextRouteModule: RouteModule = {
  path: "/v1/staff-context",
  router: staffContextRoutes,
  permissions,
  auth: "human",
};
