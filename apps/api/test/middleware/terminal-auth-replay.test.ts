// apps/api/test/middleware/terminal-auth-replay.test.ts — PR 12 review, extra findings E1 and E4.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalSyncRequest as sharedCanonical } from "@dulja/sync";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import type { Problem } from "@dulja/contracts";
import { canonicalSyncRequest, TERMINAL_TOKEN_HEADER } from "../../src/middleware/terminal-auth";
import {
  enrolTerminal,
  signSyncRequest,
  type EnrolledTerminal,
} from "../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../support/app";

describe("terminalAuth — the canonical string has one definition (E4, SAH-046)", () => {
  it("the middleware's export IS @dulja/sync's function, not a second spelling of it", () => {
    expect(canonicalSyncRequest).toBe(sharedCanonical);
  });
});

describe("terminalAuth — a signed request is spent once (E1, ADR 0055 decision 7)", () => {
  let api: StartedApi;
  let s: Seed;
  let t: EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Replay");
    await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });
    t = await enrolTerminal(api, s, { as: s.human, code: "RP01" });
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  const pull = (headers: Record<string, string>) =>
    api.request({ method: "GET", path: "/v1/sync/catalogue?limit=1", headers });

  it("the identical signed request a second time is refused and mints no token", async () => {
    const captured = signSyncRequest(t, { method: "GET", path: "/v1/sync/catalogue" });
    const first = await pull(captured);
    expect(first.status).toBe(200);
    expect(first.headers.get(TERMINAL_TOKEN_HEADER)).toBeTruthy();

    const replay = await pull(captured);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as Problem).code).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
    expect(
      replay.headers.get(TERMINAL_TOKEN_HEADER),
      "a replay must not buy a fresh JWT",
    ).toBeNull();

    // The query string is not signed, so changing it does not make the captured message a new one.
    const altered = await api.request({
      method: "GET",
      path: "/v1/sync/catalogue?limit=1000",
      headers: captured,
    });
    expect(altered.status).toBe(401);
  });

  it("two concurrent copies of one signed request: exactly one is served", async () => {
    const captured = signSyncRequest(t, { method: "GET", path: "/v1/sync/catalogue" });
    const answers = await Promise.all([pull(captured), pull(captured)]);
    expect(answers.map((r) => r.status).toSorted()).toEqual([200, 401]);
  });

  it("two distinct requests in quick succession are both served, in either order", async () => {
    const now = Date.now();
    const earlier = signSyncRequest(t, {
      method: "GET",
      path: "/v1/sync/catalogue",
      at: new Date(now - 1),
    });
    const later = signSyncRequest(t, {
      method: "GET",
      path: "/v1/sync/catalogue",
      at: new Date(now),
    });
    // The later-stamped one first: a till's concurrent catalogue and ticket loops can arrive out of order,
    // so the guard must not demand a rising timestamp.
    expect((await pull(later)).status).toBe(200);
    expect((await pull(earlier)).status).toBe(200);
    const concurrent = await Promise.all([
      pull(
        signSyncRequest(t, { method: "GET", path: "/v1/sync/catalogue", at: new Date(now + 1) }),
      ),
      pull(
        signSyncRequest(t, { method: "GET", path: "/v1/sync/catalogue", at: new Date(now + 2) }),
      ),
    ]);
    expect(concurrent.map((r) => r.status)).toEqual([200, 200]);
  });

  it("the token a signed call minted keeps working: bearer calls are not spent", async () => {
    const first = await pull(signSyncRequest(t, { method: "GET", path: "/v1/sync/catalogue" }));
    const token = first.headers.get(TERMINAL_TOKEN_HEADER)!;
    for (let i = 0; i < 2; i++) {
      const res = await api.request({
        method: "GET",
        path: "/v1/sync/catalogue?limit=1",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });
});
