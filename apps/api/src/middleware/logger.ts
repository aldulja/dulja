import type { MiddlewareHandler } from "hono";
import type { Logger } from "@dulja/contracts";
import type { AppEnv } from "../context";
export function loggerMiddleware(base: Logger): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    // spec:2063 requires tenant_id and actor_id on every line. They are unknown until authenticate()
    // resolves the principal, so they are declared null here and re-bound there.
    const logger = base.child({
      request_id: context.get("requestId"),
      trace_id: context.get("traceId"),
      tenant_id: null,
      actor_id: null,
    });
    context.set("logger", logger);
    const started = Date.now();
    await next();
    // Read the logger back rather than closing over it: authenticate() replaces it with a child that
    // carries the resolved tenant and actor, and the completion line must carry them too.
    context.get("logger").info(
      {
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res.status,
        ms: Date.now() - started,
      },
      "request",
    );
  };
}
