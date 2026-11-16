import * as Sentry from "@sentry/node";

/** spec:2063 "never a token, password, or full card number" — the predicate the forbidden-log-fields lint applies. */
const SECRET_HEADER = /token|password|authorization|card|pin|secret/i;

/**
 * OWNER GATE OD-22. With no DSN this is a no-op; nothing else in the worker knows the difference. The scrub is
 * reproduced rather than shared: `apps/worker` and `apps/api` are sibling apps and §3.1's dependency rule forbids one
 * importing the other. `skipOpenTelemetrySetup` for the same reason as the API's: traces are OpenTelemetry's.
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
