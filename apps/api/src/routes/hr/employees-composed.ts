import { OpenAPIHono } from "@hono/zod-openapi";
import type { HrKeyRing } from "@dulja/db";
import type { AppEnv } from "../../context";
import { employeeRoutes } from "./employees"; // 6C (contracts round 16: 6C-FIRST)
import { createSensitiveRoutes } from "./sensitive"; // 8A T4
import { statutoryProfileRoutes } from "./statutory-profiles"; // 8A T5
import { compensationRoutes } from "./compensation"; // 8A T7
import { createPermitExpiryRoutes } from "./permit-expiry"; // 8D T3 (amendment A3)

/**
 * 6C's employee router plus 8A's sub-resources, composed once, at `buildRoutes` time (amendment A16). 6C exports
 * `employeeRoutes` and `employeeRouteModule` as consts; a `.route(…)` onto that const from another module would run
 * at import time with no `deps` in scope, so this builds a fresh router and leaves 6C's two exports untouched.
 */
export function composeEmployeeRouter(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  // 8D T3: FIRST, before 6C's `GET /{employeeId}` — Hono runs matching handlers in registration order, so the static
  // `/permit-expiry` must be registered ahead of the parameterised detail route or it would be read as an employee id.
  routes.route("/", createPermitExpiryRoutes(hrKeys));
  routes.route("/", employeeRoutes);
  routes.route("/", createSensitiveRoutes(hrKeys));
  routes.route("/", statutoryProfileRoutes);
  routes.route("/", compensationRoutes);
  return routes;
}
