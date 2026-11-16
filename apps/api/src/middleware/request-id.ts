import { context as otelContext, trace } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { v7 as uuidv7 } from "uuid";
import type { AppEnv } from "../context";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const supplied = context.req.header("X-Request-Id");
    const id = supplied && uuid.test(supplied) ? supplied : uuidv7();
    context.set("requestId", id);
    // The W3C trace id of the span otelMiddleware opened; the request id only when no SDK is running.
    context.set("traceId", trace.getSpan(otelContext.active())?.spanContext().traceId ?? id);
    context.header("X-Request-Id", id);
    await next();
    context.header("X-Request-Id", id);
  };
}
