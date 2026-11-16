// packages/db/src/einvoice/verify.ts (5B)
//
// The OD-15 verification command (hazard 5). Four checks, four lines, one per key, and every one of
// them runs identically against `synthetic` and against the authority transmitter — which is what makes the local
// equivalent a real equivalent rather than a different code path.
//
// It prints no secret and no response body. `reachable` reports the HTTP status class only.

import { loadProfile, ProfileNotFoundError } from "./profile";
import type { EInvoiceProfile } from "@dulja/domain";
import { readSecret, EINVOICE_SECRET_NAMES } from "./credentials";
import { parseProfile, renderPath } from "@dulja/domain";
import { createRequestAuthorization } from "./authorization";
import { EInvoiceError } from "./errors";

export interface VerifyResult {
  profile: "ok" | string;
  schema: "ok" | string;
  credentials: "present" | string;
  reachable: "ok" | string;
}

export async function verifyProfile(
  code: string,
  opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    profile?: EInvoiceProfile;
    clientId?: string;
    /** Verification-only origin for the synthetic loopback stub's ephemeral port. */
    baseUrl?: string;
  } = {},
): Promise<VerifyResult> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const doFetch = opts.fetchImpl ?? fetch;
  const result: VerifyResult = {
    profile: "ok",
    schema: "ok",
    credentials: "present",
    reachable: "ok",
  };

  // `opts.profile` is for a caller that already holds a parsed profile whose `baseUrl` differs from
  // the committed file's — which is every test, because `synthetic.v1.json` is committed with
  // `"baseUrl": "http://127.0.0.1:0"` and the loopback stub binds a RANDOM port that only
  // `startStubServer()`'s own `server.profile` carries. Without it the `reachable` probe would
  // always go to port 0 and hazard 5's local equivalent could never print `reachable: ok`.
  // The `schema` check still runs: an injected profile came through `parseProfile` to exist.
  let profile: EInvoiceProfile;
  if (opts.profile) {
    try {
      profile = parseProfile(opts.profile);
    } catch {
      return {
        profile: "ok",
        schema: "injected profile is invalid",
        credentials: "not checked",
        reachable: "not checked",
      };
    }
  } else {
    try {
      profile = loadProfile(code);
    } catch (e) {
      if (e instanceof ProfileNotFoundError) {
        return {
          profile: `no profile file for "${code}" in packages/db/einvoice-profiles`,
          schema: "not checked",
          credentials: "not checked",
          reachable: "not checked",
        };
      }
      // parseProfile threw: the file exists but does not satisfy einvoice-profile.schema.json.
      return {
        profile: "ok",
        schema: (e as Error).message,
        credentials: "not checked",
        reachable: "not checked",
      };
    }
  }

  if (opts.baseUrl !== undefined) {
    try {
      if (
        code !== "synthetic" ||
        profile.code !== "synthetic" ||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(opts.baseUrl)
      )
        throw new Error("invalid loopback override");
      const base = new URL(opts.baseUrl);
      profile = parseProfile({ ...profile, baseUrl: base.origin });
    } catch {
      return {
        profile: "ok",
        schema: "base URL override requires the synthetic profile and an explicit loopback port",
        credentials: "not checked",
        reachable: "not checked",
      };
    }
  }

  // The secret must be one of the declared names AND set in this environment.
  const ref = EINVOICE_SECRET_NAMES[0];
  try {
    readSecret(ref, env);
  } catch (e) {
    result.credentials = e instanceof EInvoiceError ? e.detail : (e as Error).message;
    result.reachable = "not checked";
    return result;
  }

  // Reachability: the poll call with a deliberately non-existent external id. Any HTTP answer at all
  // proves the base URL, the path template and TLS work; 401 would prove the credential does not,
  // which is why `credentials` is checked separately and first.
  const spec = profile.calls.poll;
  // The SAME join `http-transmitter.ts` uses: the schema's `baseUrl` pattern admits a trailing slash
  // and a path template is always rooted, so a profile written with one would otherwise produce a
  // double slash here and nowhere else — a verification command that probes a different URL than the
  // transmitter calls is worse than no verification command.
  const url = `${profile.baseUrl.replace(/\/$/, "")}${renderPath(spec.pathTemplate, { externalId: "verify-probe-nonexistent" })}`;
  try {
    const authorization = createRequestAuthorization({ profile, env, fetchImpl: doFetch });
    const material = await authorization.get({
      clientId: opts.clientId ?? env["EINVOICE_CLIENT_ID"] ?? "",
      secretRef: ref,
    });
    const res = await doFetch(url, {
      method: spec.method,
      redirect: "error",
      headers: { [profile.auth.header]: material.headerValue },
      signal: AbortSignal.timeout(profile.timeoutMs ?? 10_000),
    });
    result.reachable =
      res.status >= 500 || res.status === 429 ? `remote answered ${res.status}` : "ok";
    if (res.status === 401 || res.status === 403)
      result.credentials = `authentication refused (HTTP ${res.status})`;
  } catch (e) {
    if (e instanceof EInvoiceError) {
      result.credentials = e.detail;
      result.reachable = "not checked";
    } else result.reachable = `no answer: ${(e as Error).name}`;
  }
  return result;
}

export function formatVerifyResult(r: VerifyResult): string {
  return [
    `profile: ${r.profile}`,
    `schema: ${r.schema}`,
    `credentials: ${r.credentials}`,
    `reachable: ${r.reachable}`,
  ].join("\n");
}
