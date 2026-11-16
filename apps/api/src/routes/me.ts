import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { MyCompaniesSchema, type MyCompanies } from "@dulja/contracts/admin/my-companies";
import type { AppEnv } from "../context";
import { membershipOnly } from "../middleware/require-permission";
import type { RouteModule } from "./index";

/**
 * `GET /v1/me/companies` (ADR 0089; 2026-11-15 review UI-03, UI-11) — the companies in which the caller holds at
 * least one LIVE role assignment, each with the branches those assignments admit (`app.actor_in_branch`: every live
 * BRANCH value for a company-wide assignment, the assignment's own branches otherwise). It answers ids, codes and
 * names only and grants nothing: every screen the back office opens with a company from here still asks its own
 * permission at that company. A member with no live role gets an empty list, not a refusal — there is nothing to
 * hide from a caller about their own assignments.
 *
 * Read on the caller's own transaction, under the tenant's RLS, so another tenant's rows are never in view; the
 * `role_assignment` predicate is what bounds it to the caller within the tenant.
 */
export const meCompanyRoutes = new OpenAPIHono<AppEnv>();

interface Row {
  company_id: string;
  company_code: string;
  company_name: string;
  branch_id: string | null;
  branch_code: string | null;
  name_en: string | null;
  name_ar: string | null;
}

meCompanyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/companies",
    tags: ["admin"],
    summary: "List the companies and branches the caller holds a live role in",
    middleware: [membershipOnly()] as const,
    responses: {
      200: {
        description: "The caller's companies, each with the branches their roles admit",
        content: { "application/json": { schema: MyCompaniesSchema } },
      },
    },
  }),
  async (context) => {
    const rows = await context.var.withTenant(
      (tx) => tx<Row[]>`
        select c.id as company_id, c.code as company_code, c.name as company_name,
               b.id as branch_id, b.code as branch_code, b.name_en, b.name_ar
          from app.company c
          left join app.dimension_type dt on dt.company_id = c.id and dt.code = 'BRANCH'
          left join app.dimension_value b
                 on b.dimension_type_id = dt.id and b.archived_at is null
                and app.actor_in_branch(c.id, b.id)
         where exists (
           select 1 from app.role_assignment ra
            where ra.principal_id = app.current_actor() and ra.company_id = c.id
              and (ra.expires_at is null or ra.expires_at > now()))
         order by c.code, c.id, b.code, b.id`,
    );
    const companies = new Map<string, MyCompanies["companies"][number]>();
    for (const row of rows) {
      let company = companies.get(row.company_id);
      if (!company) {
        company = {
          id: row.company_id,
          code: row.company_code,
          name: row.company_name,
          branches: [],
        };
        companies.set(row.company_id, company);
      }
      if (row.branch_id !== null)
        company.branches.push({
          id: row.branch_id,
          code: row.branch_code!,
          nameEn: row.name_en!,
          nameAr: row.name_ar,
        });
    }
    return context.json({ companies: [...companies.values()] }, 200);
  },
);

export const meRouteModule: RouteModule = {
  path: "/v1/me",
  router: meCompanyRoutes,
  permissions: [],
  auth: "human",
};
