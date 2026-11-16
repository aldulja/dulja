# ADR 0013: Observability — OpenTelemetry for traces, Sentry for errors, one `request_id` end to end

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C

## Context

spec §4.9 requires distributed tracing, RED metrics per endpoint, and structured logs carrying `tenant_id`,
`actor_id`, `request_id` and `trace_id` on every line (spec:2063). §5.0 row 0.14's acceptance check is a single
sentence: one request visible end to end in the trace viewer with tenant and actor attached. The system spans
three runtimes — a Workers isolate, a Bun container and Postgres — so "end to end" means the trace id has to
survive two hops.

## Decision

1. **W3C `traceparent` is the carrier.** The edge Worker forwards the caller's header or mints one;
   `otelMiddleware()` extracts it and opens the request's server span as a child of it.
2. **`otelMiddleware()` heads the fixed middleware order** (`otel → requestId → logger → auth → idempotency →
   requirePermission → handler`, contracts §4.2.3). Without an active span `setPrincipalAttributes` is a silent
   no-op and Postgres spans start their own traces. `requestId()` reads the active span's trace id into the
   `trace_id` log field.
3. **`request_id` and `trace_id` stay separate fields.** A retried request keeps its trace and gets a new request
   id; conflating them would lose that.
4. **Postgres spans come from postgres.js's own `debug` hook**, passed through `createDb`'s options — no
   monkey-patching, and the tracer reads only the *prepared* statement text, so no parameter value can reach a span.
5. **Span attributes are `dulja.tenant_id`, `dulja.actor_id`, `dulja.request_id`**, set once by the auth
   middleware. A test asserts that no attribute key matches `/token|password|authorization|card|pin|secret/i` —
   the span twin of the `forbidden-log-fields` lint.
6. **Sentry reports errors; OpenTelemetry owns tracing.** `Sentry.init` is called with
   `skipOpenTelemetrySetup: true` and no `tracesSampleRate`, so Sentry never registers a second global tracer
   provider beside `NodeSDK`'s. Its `beforeSend` removes any header whose name matches the same secret predicate.
7. **Both exporters degrade, never crash.** No `OTEL_EXPORTER_OTLP_ENDPOINT` → an in-memory exporter (which is
   also what the tests assert against); no `SENTRY_DSN` → Sentry is not initialised. That is OD-22's default.
8. **Not decided here:** the ledger-integrity SLI (spec:2246) is 1B's, on top of 0D's integrity job; RED metrics
   and SLO alerting land with the report engine's own instrumentation.

## Verified facts (recorded 2026-09-16)

| Question | Answer as installed |
|---|---|
| `@opentelemetry/sdk-node` version | 0.222.0 |
| Exporter option | `spanProcessors: SpanProcessor[]` (`spanProcessor` singular is deprecated); `traceExporter` also exists |
| Service-name option | `serviceName?: string` |
| `start()` / `shutdown()` | `start(): void` (synchronous); `shutdown(): Promise<void>` |
| OTLP HTTP exporter endpoint option | `url?: string` (`@opentelemetry/exporter-trace-otlp-http` 0.222.0) |
| `@sentry/node` version | 10.74.0 |
| Own-OpenTelemetry option | `skipOpenTelemetrySetup?: boolean` |

## Consequences

- `createDb`'s options gain `debug?`, an additive change to contracts §4.2.2.
- Trace continuity is asserted in CI against the in-memory exporter (`apps/api/test/otel.test.ts`), so the owner's
  Sentry account and OTLP endpoint are needed to *view* traces, never to prove they are correct.
- A 5xx converted into a problem response by the API's `onError` is not reported to Sentry by this ADR; only
  uncaught exceptions are. Explicit error capture belongs with the first slice that defines an alerting policy.
