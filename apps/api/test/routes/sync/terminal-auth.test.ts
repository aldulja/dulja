import { SignJWT } from "jose";
import type { ApiRequest } from "../../support/app";
// apps/api/test/routes/sync/terminal-auth.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, grantCodes, type Seed } from "@dulja/db/test";
import { TERMINAL_TOKEN_HEADER } from "../../../src/middleware/terminal-auth";
// FIVE levels, not four: this file sits at apps/api/test/routes/sync/, one directory deeper than the
// apps/api/test/routes/*.test.ts files 3B/4A/5A wrote, and four levels resolves to `apps/`.
import {
  enrolTerminal,
  signSyncRequest,
  type EnrolledTerminal,
} from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";

/** The signer is `signSyncRequest` from the shared fixture (§4.17.1, Step 6) and NOT a local copy: SAH-046's
 *  sentence is "one canonical name per concept, checked in one place", and a test file with its own signer is
 *  the second spelling that sentence forbids. `headersFor` below is a one-line alias for readability only. */
const headersFor = (
  t: EnrolledTerminal,
  method: string,
  path: string,
  body?: unknown,
  at = new Date(),
) => signSyncRequest(t, { method, path, body, at });

describe("terminalAuth (§4.10.3) — the identity a client cannot write (SAH-026, SAH-046)", () => {
  let api: StartedApi;
  let s: Seed;
  let t: EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
    t = await enrolTerminal(api, s, { as: s.human, code: "KL01" });
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  const request = (input: ApiRequest): Promise<Response> => api.request(input);

  const pull = (headers: Record<string, string>) =>
    request({ method: "GET", path: "/v1/sync/catalogue?limit=1", headers });

  it("a correctly signed request is accepted and hands back a terminal JWT", async () => {
    const res = await pull(headersFor(t, "GET", "/v1/sync/catalogue"));
    expect(res.status).toBe(200);
    const token = res.headers.get(TERMINAL_TOKEN_HEADER);
    expect(token, "a signed call must mint a token for the next calls (spec:1322)").toBeTruthy();

    // The token alone is enough for the NEXT call — no signature headers at all.
    const withToken = await request({
      method: "GET",
      path: "/v1/sync/catalogue?limit=1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(200);
    expect(
      withToken.headers.get(TERMINAL_TOKEN_HEADER),
      "a token call does not re-mint",
    ).toBeNull();
  });

  it("a human's Supabase JWT is NOT a terminal token", async () => {
    const res = await request({ method: "GET", path: "/v1/sync/catalogue?limit=1", as: s.human });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Problem).code).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
  });

  it("every bypass shape is refused (acceptance test 11's sync half)", async () => {
    const good = headersFor(t, "GET", "/v1/sync/catalogue");
    const cases: [string, Record<string, string>][] = [
      ["no headers at all", {}],
      ["id without a signature", { "X-Terminal-Id": t.terminalId }],
      ["malformed terminal id", { ...good, "X-Terminal-Id": "invalid-id" }],
      ["non-RFC3339 timestamp", { ...good, "X-Terminal-Timestamp": "October 7, 2026" }],
      ["signature over a DIFFERENT path", headersFor(t, "GET", "/v1/sync/tickets")],
      ["signature over a DIFFERENT method", headersFor(t, "POST", "/v1/sync/catalogue")],
      [
        "a timestamp 10 minutes old (replay)",
        headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() - 600_000)),
      ],
      [
        "a timestamp 10 minutes ahead (clock forgery)",
        headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() + 600_000)),
      ],
      [
        "a garbage signature",
        { ...good, "X-Terminal-Signature": Buffer.alloc(64).toString("base64") },
      ],
      [
        "an unknown terminal id",
        { ...good, "X-Terminal-Id": "00000000-0000-7000-8000-000000000000" },
      ],
      // Each forged case carries its OWN good signature, a second apart: a signed message is spent once
      // (PR 12 review, finding E1), so reusing `good` twice would test the replay refusal, not the header.
      [
        "a forged X-Tenant-Id beside a good signature",
        {
          ...headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() - 1_000)),
          "X-Tenant-Id": s.tenant,
        },
      ],
      [
        "a forged X-Actor-Id beside a good signature",
        {
          ...headersFor(t, "GET", "/v1/sync/catalogue", undefined, new Date(Date.now() - 2_000)),
          "X-Actor-Id": s.human,
        },
      ],
    ];
    for (const [label, headers] of cases) {
      const res = await pull(headers);
      if (label.startsWith("a forged")) {
        // A forged tenant/actor header is INERT, not an error: identity comes from the signature and the
        // header is never read (SAH-026). The request succeeds AS THE TERMINAL, which is the proof.
        expect(res.status, label).toBe(200);
      } else {
        expect(res.status, label).toBe(401);
        expect(((await res.json()) as Problem).code, label).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
      }
    }
  });

  it("a revoked terminal is refused with ERR_TERMINAL_REVOKED, and the token minted before revocation dies too", async () => {
    const doomed = await enrolTerminal(api, s, { as: s.human, code: "KL09" });
    const first = await pull(headersFor(doomed, "GET", "/v1/sync/catalogue"));
    expect(first.status).toBe(200);
    const token = first.headers.get(TERMINAL_TOKEN_HEADER)!;

    const rev = await request({
      method: "POST",
      path: `/v1/admin/terminals/${doomed.terminalId}/revoke`,
      as: s.human,
    });
    expect(rev.status).toBe(204);

    const signed = await pull(headersFor(doomed, "GET", "/v1/sync/catalogue"));
    expect(signed.status).toBe(403);
    expect(((await signed.json()) as Problem).code).toBe("ERR_TERMINAL_REVOKED");

    // The JWT is short-lived but not instantly expiring, so revocation MUST be re-checked per request against
    // the row. A token that outlived its terminal is exactly SAH-027's "one variable disables every control".
    const withToken = await request({
      method: "GET",
      path: "/v1/sync/catalogue?limit=1",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(403);
  });

  it("tokens with a different key, an expired lifetime or an unknown terminal are all 401", async () => {
    const other = await enrolTerminal(api, s, { as: s.human, code: "KL10" });
    const forged = await request({
      method: "GET",
      path: "/v1/sync/catalogue?limit=1",
      headers: {
        Authorization: `Bearer ${api.signToken({ sub: `terminal:${other.terminalId}`, tid: s.tenant })}`,
      },
    });
    // api.signToken uses the SUPABASE test key, not TERMINAL_JWT_SIGNING_KEY: a valid human token shape signed
    // by the wrong key must not open a terminal door (SAH-025's "never derive an identity from elsewhere").
    expect(forged.status).toBe(401);
    const signingKey = new TextEncoder().encode("dulja-test-terminal-signing-key-0123456789abcdef");
    for (const payload of [
      { sub: `terminal:${other.terminalId}`, exp: Math.floor(Date.now() / 1000) - 60 },
      {
        sub: "terminal:00000000-0000-7000-8000-000000000000",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
    ]) {
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("urn:dulja:terminal")
        .sign(signingKey);
      const response = await request({
        method: "GET",
        path: "/v1/sync/catalogue",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as Problem).code).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
    }
  });
});
