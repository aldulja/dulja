import { createHash } from "node:crypto";
import type { EInvoiceCredentials, EInvoiceProfile } from "@dulja/domain";
import { readSecret } from "./credentials";
import { EInvoiceError, TransientTransmissionError } from "./errors";

const keyFor = (credentials: EInvoiceCredentials, secret: string) =>
  JSON.stringify([
    credentials.clientId,
    credentials.secretRef,
    createHash("sha256").update(secret).digest("hex"),
  ]);
const unavailable = (detail: string): never => {
  throw new EInvoiceError("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE", detail);
};

function waitForToken<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface RequestAuthorization {
  headerValue: string;
  sensitiveValues: readonly string[];
}

/** Process-only authorization. No token or client secret is returned to an API or stored in SQL. */
export function createRequestAuthorization(options: {
  profile: EInvoiceProfile;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}) {
  const auth = options.profile.auth;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const flights = new Map<string, Promise<{ value: string; expiresAt: number }>>();
  async function acquire(credentials: EInvoiceCredentials, secret: string) {
    if (auth.kind !== "oauth2_client_credentials")
      return unavailable("token acquisition requires an OAuth profile");
    if (!credentials.clientId) return unavailable("the OAuth client identifier is missing");
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.profile.timeoutMs ?? 30_000);
    try {
      const response = await doFetch(auth.tokenUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: secret,
          grant_type: "client_credentials",
          ...(auth.scope ? { scope: auth.scope } : {}),
        }).toString(),
        signal: controller.signal,
      });
      // The deadline also covers body delivery; no response body is used as an error message.
      const body = await response.text();
      if (response.status === 429 || response.status >= 500)
        throw new TransientTransmissionError(
          response.status,
          `token endpoint returned ${response.status}`,
        );
      if (!response.ok)
        return unavailable(`token endpoint refused authentication (HTTP ${response.status})`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return unavailable("token endpoint returned invalid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return unavailable("token endpoint returned an invalid response");
      const data = parsed as Record<string, unknown>;
      if (
        typeof data.access_token !== "string" ||
        !data.access_token ||
        /\s/.test(data.access_token) ||
        String(data.token_type).toLowerCase() !== "bearer" ||
        typeof data.expires_in !== "number" ||
        !Number.isSafeInteger(data.expires_in) ||
        data.expires_in <= 0
      )
        return unavailable("token endpoint returned invalid token metadata");
      const lifeMs = data.expires_in * 1000;
      const expiresAt = started + lifeMs - Math.min(30_000, lifeMs / 10);
      if (!Number.isSafeInteger(lifeMs) || expiresAt <= now())
        return unavailable("token endpoint returned an already expired token");
      return { value: data.access_token, expiresAt };
    } catch (cause) {
      if (cause instanceof EInvoiceError || cause instanceof TransientTransmissionError)
        throw cause;
      // Network errors may include a redirect URL or response content; keep diagnostics structural.
      throw new TransientTransmissionError(0, "token request failed or timed out");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async get(
      credentials: EInvoiceCredentials,
      signal?: AbortSignal,
    ): Promise<RequestAuthorization> {
      signal?.throwIfAborted();
      const secret = readSecret(credentials.secretRef, options.env);
      if (auth.kind === "bearer")
        return { headerValue: `${auth.scheme ?? "Bearer"} ${secret}`, sensitiveValues: [secret] };
      const key = keyFor(credentials, secret);
      let token = cache.get(key);
      if (!token || token.expiresAt <= now()) {
        let flight = flights.get(key);
        if (!flight) {
          flight = acquire(credentials, secret)
            .then((value) => {
              for (const [candidate, cached] of cache)
                if (cached.expiresAt <= now()) cache.delete(candidate);
              if (!cache.has(key) && cache.size >= 64) cache.delete(cache.keys().next().value!);
              cache.set(key, value);
              return value;
            })
            .finally(() => {
              if (flights.get(key) === flight) flights.delete(key);
            });
          flights.set(key, flight);
        }
        token = await waitForToken(flight, signal);
      }
      return { headerValue: `Bearer ${token.value}`, sensitiveValues: [secret, token.value] };
    },
    invalidate(credentials: EInvoiceCredentials, headerValue: string) {
      if (auth.kind !== "oauth2_client_credentials") return;
      const key = keyFor(credentials, readSecret(credentials.secretRef, options.env));
      // A concurrent 401 on an older token must not evict a token already refreshed by another call.
      if (`Bearer ${cache.get(key)?.value}` === headerValue) cache.delete(key);
    },
  };
}
