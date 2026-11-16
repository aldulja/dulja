import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { resolvePrincipal, withTenant } from "@dulja/db";
import type { AppEnv, RequestContext } from "../context";
import { setPrincipalAttributes } from "../otel";
import type { JwtVerifier } from "../ports";
export const AAL1_PATHS: ReadonlySet<string> = new Set(["/v1/session"]);
export function authenticate(deps: { db: Sql; verifier: JwtVerifier }): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const header = context.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer "))
      throw new AppError("ERR_AUTH_TOKEN_INVALID", "the request carries no Bearer token");
    const verified = await deps.verifier(header.slice(7));
    if (verified.aal !== "aal2" && !AAL1_PATHS.has(new URL(context.req.url).pathname))
      throw new AppError("ERR_AUTH_AAL_INSUFFICIENT", "this route requires aal2");
    const rows = await resolvePrincipal(deps.db, verified.sub);
    if (rows.length !== 1)
      throw new AppError(
        rows.length === 0 ? "ERR_AUTH_NO_MEMBERSHIP" : "ERR_INTERNAL",
        "the subject has no unambiguous membership",
      );
    const row = rows[0]!;
    const ctx: RequestContext = {
      tenantId: row.tenantId,
      actorId: row.principalId,
      requestId: context.get("requestId"),
      principalKind: row.kind,
      aal: verified.aal,
    };
    setPrincipalAttributes(ctx);
    context.set("ctx", ctx);
    // The identity is server-resolved, never client-supplied; binding it here puts it on every line
    // logged for the rest of the request (spec:2063).
    context.set(
      "logger",
      context.get("logger").child({ tenant_id: ctx.tenantId, actor_id: ctx.actorId }),
    );
    context.set("withTenant", (fn) => withTenant(deps.db, ctx, fn));
    await next();
  };
}
