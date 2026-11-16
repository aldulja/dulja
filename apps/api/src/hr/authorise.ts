import type { MiddlewareHandler } from "hono";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { requirePermission } from "../middleware/require-permission";

/**
 * `hr.filing.generate` — 8D's one unconditional code (§3.6.2, migration 0097), referenced by `PERMISSION[…]` so
 * §3.6.3's handler-↔-catalogue lint is satisfied in the same task that seeds the row (7A's `requireReportExport`
 * precedent). A filing is produced for ONE company's employees from that company's posted payroll figures, so the
 * gate is company-scoped on the path: the route that mounts it must pass the same `companyId` down into every
 * service call it makes (AGENTS.md — an entity id alone lets a caller authorised for one company reach another's
 * rows). The code is `mutating: true`, so `assertRouteGates` admits it on an unsafe method with no marker.
 *
 * Its first consumer is 8D Task 5's `POST …/payroll-runs/{documentId}/payslips`; until that route is composed onto
 * 8B's `payroll-runs` module and the code joins that module's `permissions`, `tests/regression/sah-047.test.ts`
 * reports the code unrouted (contracts round 19, 8D A13 item 8).
 */
export function requireFilingGenerate(): MiddlewareHandler<AppEnv> {
  return requirePermission(PERMISSION["hr.filing.generate"], { company: "path:companyId" });
}
