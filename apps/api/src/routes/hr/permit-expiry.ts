import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ProblemSchema } from "@dulja/contracts";
import { PermitExpiryList, PermitExpiryQuery } from "@dulja/contracts/hr/permit-expiry";
import { PERMISSION } from "@dulja/contracts/permissions";
import { permitExpiry, type HrKeyRing } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

const Params = z.object({ companyId: z.string().uuid() });
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/**
 * 8D T3 (amendment A3, contracts round 19) — `GET /v1/companies/{companyId}/employees/permit-expiry`, the permit half
 * of spec:2091's "contract and permit expiry list". The contract half is the `hr.contract_expiry` report; the permit
 * date is ciphertext in `employee_sensitive`, so it is decrypted here, behind the confidentiality code.
 *
 * Composed onto 6C's `employees` module by `composeEmployeeRouter` — a sub-path of an existing module, so it adds no
 * `PROBES` key (hazard 31). Two gates, one in front of the other: `requirePermission` refuses a caller without
 * `hr.employee.read_sensitive` with a 403, and `sensitive_gate` (RESTRICTIVE RLS, migration 0081) would hand that caller
 * zero rows anyway. A FACTORY, as `createSensitiveRoutes(hrKeys)` is: the ring is closed over, never read from env.
 */
export function createPermitExpiryRoutes(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "get",
      path: "/permit-expiry",
      tags: ["hr"],
      request: { params: Params, query: PermitExpiryQuery },
      middleware: [
        requirePermission(PERMISSION["hr.employee.read_sensitive"], { company: "path:companyId" }),
      ],
      responses: {
        200: {
          description:
            "Employees whose decrypted work permit expires within `withinDays` of today (a lapsed permit is always listed), soonest first. `next_cursor` is always null: the window bounds the list.",
          content: { "application/json": { schema: PermitExpiryList } },
        },
        400: problem("an unknown or malformed query parameter"),
        403: problem("forbidden — the caller lacks hr.employee.read_sensitive in this company"),
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const { withinDays, includeTerminated } = c.req.valid("query");
      const items = await c.var.withTenant((tx) =>
        permitExpiry(tx, hrKeys, { companyId, withinDays, includeTerminated }),
      );
      return c.json({ items, next_cursor: null }, 200);
    },
  );
  return routes;
}
