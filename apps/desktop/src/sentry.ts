import * as Sentry from "@sentry/electron/main";

/** spec:2063 "never a token, password, or full card number" — the predicate the forbidden-log-fields lint applies. */
const SECRET_HEADER = /token|password|authorization|card|pin|secret/i;

/**
 * spec:2324 / §5.0 row 0.14 — "Sentry in API and Electron". OWNER GATE OD-22: with no DSN this is a
 * no-op and nothing else in the app knows the difference, exactly as `apps/api/src/sentry.ts` and
 * `apps/worker/src/sentry.ts` behave. The header scrub is reproduced rather than shared for the same
 * reason the worker's is: `apps/desktop` and `apps/api` are sibling apps and §3.1's dependency rule
 * forbids one importing the other (here it is stricter still — `desktop` imports only build outputs).
 *
 * No `tracesSampleRate`: ADR 0013 decision 6 is "Sentry reports errors; OpenTelemetry owns tracing",
 * and 0E wires no OTel exporter into the main process, so sampled transactions would correlate with
 * nothing. Errors are the whole contract here.
 *
 * **Call this before the `ready` event.** `@sentry/electron`'s main-process SDK registers its own
 * privileged scheme for renderer IPC and throws outright ("Sentry SDK should be initialized before
 * the Electron app 'ready' event is fired") if `init` runs later.
 */
export function initSentry(dsn: string | undefined, environment: string): void {
  if (dsn === undefined || dsn === "") return;
  Sentry.init({
    dsn,
    environment,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        for (const key of Object.keys(headers)) if (SECRET_HEADER.test(key)) delete headers[key];
      }
      return event;
    },
  });
}

/**
 * Report a fault and wait for it to leave the process. Callers use this on the paths that end in
 * `app.exit`, where Sentry's normal background flush would never run. Resolves either way: an
 * uninitialised SDK (OD-22's default) has nothing to send, and a failed send must not replace the
 * fault being reported.
 */
export async function captureFault(error: Error): Promise<void> {
  Sentry.captureException(error);
  await Sentry.flush(2000).catch(() => false);
}
