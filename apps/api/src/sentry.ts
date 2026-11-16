import * as Sentry from "@sentry/node";

/** spec:2063 "never a token, password, or full card number" — the predicate the forbidden-log-fields lint applies. */
const SECRET_HEADER = /token|password|authorization|card|pin|secret/i;

/**
 * OWNER GATE OD-22. With no DSN this is a no-op; nothing else in the application knows the difference.
 * Sentry reports errors only: `skipOpenTelemetrySetup` stops it registering a second OpenTelemetry provider beside
 * `startTelemetry`'s (verified against @sentry/node 10.74.0, ADR 0013), and traces go through OTLP.
 */
export function startSentry(opts: { appEnv: string; serviceName: string }): boolean {
  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: opts.appEnv,
    serverName: opts.serviceName,
    skipOpenTelemetrySetup: true,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        for (const key of Object.keys(headers)) if (SECRET_HEADER.test(key)) delete headers[key];
      }
      return event;
    },
  });
  return true;
}
