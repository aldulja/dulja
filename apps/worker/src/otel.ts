import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export interface TelemetryHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * The worker half of ADR 0013. `apps/worker` is a pg-boss poller with no HTTP surface beyond `health.ts`, so this
 * module is `startTelemetry` and nothing else — no middleware, no principal attributes, no span-collection seam. A
 * job's tenant and actor are attributes its handler sets on its own span through `@opentelemetry/api`.
 *
 * Same default as the API's (OWNER GATE OD-22): no `OTEL_EXPORTER_OTLP_ENDPOINT` means an in-memory exporter, so a
 * worker container boots and polls with observability unconfigured rather than crashing on start.
 */
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const exporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
    : new InMemorySpanExporter();
  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
