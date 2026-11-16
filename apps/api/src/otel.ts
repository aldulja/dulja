import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context";

export interface TelemetryHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const memory = new InMemorySpanExporter();

/**
 * §4.9: "Distributed tracing; RED metrics per endpoint". §5.0 row 0.14 is the acceptance check: one request visible
 * end to end with tenant and actor attached. The edge Worker mints or forwards `traceparent`; `otelMiddleware`
 * continues it, so the container's spans and Postgres's statements land in the caller's trace.
 *
 * The DEFAULT is the in-memory exporter, so a missing OTEL_EXPORTER_OTLP_ENDPOINT (OWNER GATE OD-22) degrades to
 * "traces are collected and dropped", never to a crash on boot. Verified against @opentelemetry/sdk-node 0.222.0
 * (ADR 0013): `serviceName` and `spanProcessors` are constructor options and `start()` is synchronous.
 */
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const exporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
    : memory;
  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

/**
 * One server span per request, opened from the *inbound* trace context so the Worker's trace id continues into the
 * container instead of a new trace starting here. `startActiveSpan` makes it the active span for everything awaited
 * inside, which is what lets `setPrincipalAttributes` and `pgDebugTracer` find it. Registered first in `createApp`,
 * ahead of `requestId()` (contracts §4.2.3).
 */
export function otelMiddleware(): MiddlewareHandler<AppEnv> {
  const tracer = trace.getTracer("dulja-api");
  return async (c, next) => {
    const carrier: Record<string, string> = {};
    const inbound = c.req.header("traceparent");
    if (inbound) carrier["traceparent"] = inbound;
    const parent = propagation.extract(context.active(), carrier);
    const path = new URL(c.req.url).pathname;
    await tracer.startActiveSpan(
      `${c.req.method} ${path}`,
      { kind: SpanKind.SERVER },
      parent,
      async (span) => {
        try {
          await next();
        } finally {
          span.setAttribute("http.request.method", c.req.method);
          span.setAttribute("url.path", path);
          span.setAttribute("http.response.status_code", c.res.status);
          span.end();
        }
      },
    );
  };
}

/** §5.0 row 0.14's "with tenant and actor attached". Called once per request by the auth middleware. */
export function setPrincipalAttributes(ctx: {
  tenantId: string;
  actorId: string;
  requestId: string;
}): void {
  trace.getSpan(context.active())?.setAttributes({
    "dulja.tenant_id": ctx.tenantId,
    "dulja.actor_id": ctx.actorId,
    "dulja.request_id": ctx.requestId,
  });
}

/** Test-only: the spans the in-memory exporter has collected. */
export function collectedSpans(): readonly {
  name: string;
  traceId: string;
  attributes: Record<string, unknown>;
}[] {
  return memory.getFinishedSpans().map((span: ReadableSpan) => ({
    name: span.name,
    traceId: span.spanContext().traceId,
    attributes: span.attributes as Record<string, unknown>,
  }));
}

/** Test-only: clears the in-memory exporter, so one case never asserts over another case's spans. */
export function resetSpans(): void {
  memory.reset();
}

/**
 * postgres.js reports every statement through its `debug` hook, the documented seam, so nothing is monkey-patched.
 * The hook receives the *prepared* text and this tracer ignores the parameters, so no value reaches a span
 * (spec:2063).
 */
export function pgDebugTracer(): (connection: number, query: string) => void {
  const tracer = trace.getTracer("dulja-pg");
  return (_connection, query) => {
    const span = tracer.startSpan(`pg ${query.trim().split(/\s+/)[0]?.toLowerCase() ?? "query"}`);
    span.setAttribute("db.system", "postgresql");
    span.setAttribute("db.statement", query.slice(0, 500));
    span.end();
  };
}
