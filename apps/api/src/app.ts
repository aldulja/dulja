import { terminalAuth } from "./middleware/terminal-auth";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, type Logger } from "@dulja/contracts";
import type { JobClient } from "@dulja/db";
import type { HrKeyRing, ObjectStore } from "@dulja/db";
import type { AppEnv } from "./context";
import type { AuthAdmin, JwtVerifier } from "./ports";
import { loggerMiddleware } from "./middleware/logger";
import { authenticate } from "./middleware/auth";
import { idempotency } from "./middleware/idempotency";
import { requestBodyLimit } from "./middleware/body-limit";
import { otelMiddleware } from "./otel";
import { requestId } from "./middleware/request-id";
import { assertRouteGates } from "./middleware/require-permission";
import { toProblemResponse } from "./problem";
import { buildRoutes } from "./routes";
export interface AppDeps {
  terminalJwtSigningKey: Uint8Array;
  db: Sql;
  jobs: JobClient;
  logger: Logger;
  authAdmin: AuthAdmin;
  verifier: JwtVerifier;
  /** 2C — attachment bytes (contracts §4.2.7, the sixth member). */
  objectStore: ObjectStore;
  /** 8A — the HR field-encryption key ring (amendment A8; the eighth member, A21 item 2). A route never reads a
   *  key from process.env, and startApi() swaps in a deterministic test ring. */
  hrKeys: HrKeyRing;
}
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", otelMiddleware());
  app.use("*", requestId());
  app.use("*", loggerMiddleware(deps.logger));
  // API-11 (ADR 0092) — before authentication and idempotency, which reads and hashes every unsafe body.
  app.use("/v1/*", requestBodyLimit());
  // 3B — every handler can reach the job client, so a posting route can hand it to postDocument step 14
  // (contracts §4.2.3's eighth Variables member). `AppDeps.jobs` already existed; no dependency is added.
  app.use("*", async (c, next) => {
    c.set("jobs", deps.jobs);
    c.set("db", deps.db);
    await next();
  });
  const modules = buildRoutes({
    authAdmin: deps.authAdmin,
    objectStore: deps.objectStore,
    hrKeys: deps.hrKeys,
  });
  // Select the longest owning module using Hono's routed path. One auth and one idempotency
  // layer per request, including modules nested below /v1/companies.
  const authMode = (path: string) => {
    const segments = path.split("/");
    const owner = modules
      .toSorted((a, b) => b.path.length - a.path.length)
      .find((route) =>
        route.path
          .split("/")
          .every((segment, i) =>
            segment.startsWith(":") ? Boolean(segments[i]) : segment === segments[i],
          ),
      );
    return owner?.auth ?? "human";
  };
  const humanAuth = authenticate({ db: deps.db, verifier: deps.verifier });
  const idempotent = idempotency(deps.db);
  const signedAuth = terminalAuth({ db: deps.db, signingKey: deps.terminalJwtSigningKey });
  app.use("/v1/*", (c, next) =>
    authMode(c.req.path) === "public"
      ? next()
      : authMode(c.req.path) === "terminal"
        ? signedAuth(c, next)
        : humanAuth(c, next),
  );
  app.use("/v1/*", (c, next) => (authMode(c.req.path) === "public" ? next() : idempotent(c, next)));
  app.onError((error, context) => {
    const response = toProblemResponse(context, error);
    // The problem body deliberately withholds driver text from the caller (SAH-083). Without this the
    // cause would be withheld from the operator too, and an unmapped SQLSTATE would vanish entirely.
    if (response.status >= 500)
      context.get("logger")?.error(
        {
          err: String(error),
          sqlstate: (error as { extra?: { sqlstate?: string } }).extra?.sqlstate,
        },
        "unhandled",
      );
    return response;
  });
  app.notFound((context) =>
    toProblemResponse(
      context,
      new AppError(
        "ERR_NOT_FOUND",
        `no route matches ${context.req.method} ${new URL(context.req.url).pathname}`,
      ),
    ),
  );
  // The same list mounts the routers and judges them: `assertRouteGates` reads each module's `auth`
  // and `permissions` to decide which mounted paths may carry no gate, so the declaration in
  // `routes/index.ts` is now enforced rather than merely documented.
  for (const module of modules) app.route(module.path, module.router);
  assertRouteGates(app, modules);
  void deps.authAdmin;
  return app;
}
export { ConfigError, readConfig, type ApiConfig } from "./config";
export { ROUTES, buildRoutes, type RouteModule } from "./routes";
