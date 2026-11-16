import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { createDb, resolvePrincipal } from "@dulja/db";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, TEST_ISSUER, type StartedApi } from "../../apps/api/test/support/app";
import { grantAdmin } from "../support/api";

const problemCode = async (response: Response) => ((await response.json()) as Problem).code;

describe("acceptance test 11 — authentication bypass resistance", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    await api.loadPrincipals();
  });
  afterAll(async () => api.stop());
  it("ignores forged tenant and actor headers", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/session",
      as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human },
    });
    expect(await response.json()).toMatchObject({ tenantId: a.tenant, principalId: a.human });
  });

  it("refuses aal1 on a protected route", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/companies",
      as: a.human,
      aal: "aal1",
    });
    expect(await problemCode(response)).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("makes invalid, expired, wrong-issuer, and tampered tokens indistinguishable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const subject = `human:${a.tenant}`;
    const tokens = [
      "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.e30.AAAA",
      `${api.tokenFor(a.human)}tampered`,
      api.signToken({
        sub: subject,
        aal: "aal2",
        iss: TEST_ISSUER,
        iat: now - 3600,
        exp: now - 60,
      }),
      api.signToken({
        sub: subject,
        aal: "aal2",
        iss: "https://other.invalid/auth/v1",
        iat: now,
        exp: now + 600,
      }),
    ];
    for (const token of tokens) {
      const response = await api.request({
        method: "GET",
        path: "/v1/session",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
      expect(await problemCode(response)).toBe("ERR_AUTH_TOKEN_INVALID");
    }
  });

  it("grants no membership to an unknown valid subject", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/session",
      as: "00000000-0000-7000-8000-000000000000",
    });
    expect(await problemCode(response)).toBe("ERR_AUTH_NO_MEMBERSHIP");
  });

  it("ignores tenant fields in request bodies", async () => {
    const response = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      body: {
        code: "SNEAK",
        name: "Sneak",
        baseCurrency: "MYR",
        tenant_id: b.tenant,
        tenantId: b.tenant,
      },
    });
    expect(response.status).toBe(201);
    const [leak] = await api.db.admin<{ count: number }[]>`
      select count(*)::int as count from app.company
       where tenant_id = ${b.tenant} and code = 'SNEAK'`;
    expect(leak!.count).toBe(0);
  });

  it("ignores query parameters that name session variables", async () => {
    const response = await api.request({
      method: "GET",
      path: `/v1/companies?limit=100&app.tenant_id=${b.tenant}&set_config=1`,
      as: a.human,
    });
    expect(response.status).toBe(200);
    const ids = ((await response.json()) as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
    expect(ids).not.toContain(b.company);
  });

  it("scopes idempotency keys by principal", async () => {
    const key = "bypass-replay";
    await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      body: { code: "K1", name: "K1", baseCurrency: "MYR" },
      idempotencyKey: key,
    });
    const other = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: b.human,
      body: { code: "K1", name: "K1", baseCurrency: "MYR" },
      idempotencyKey: key,
    });
    expect(other.headers.get("Idempotency-Replayed")).toBeNull();
    const [rows] = await api.db.admin<{ count: number }[]>`
      select count(*)::int as count from app.idempotency_key where key = ${key}`;
    expect(rows!.count).toBe(2);
  });

  it("gives direct app_rw reads nothing while resolvePrincipal remains callable", async () => {
    const rw = createDb(api.db.url("app_rw"));
    expect(await rw<{ id: string }[]>`select id from app.principal`).toEqual([]);
    expect(await rw<{ id: string }[]>`select id from app.company`).toEqual([]);
    expect(await resolvePrincipal(rw, `human:${a.tenant}`)).toHaveLength(1);
    await rw.end();
  });

  it("app_rw cannot insert for another tenant", async () => {
    const rw = createDb(api.db.url("app_rw"));
    await expect(
      rw.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
        await tx`insert into app.company (tenant_id, code, name, base_currency)
                 values (${b.tenant}, 'X', 'Forged', 'MYR')`;
      }),
    ).rejects.toThrow(/row-level security/);
    await rw.end();
  });
});

describe("acceptance test 11 — sync headers — 6A", () => {
  let api: StartedApi;
  let owner: Seed;
  let terminal: import("./support/pos").EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    const { seedTenantV2, grantCodes } = await import("@dulja/db/test");
    owner = await seedTenantV2(api.db, "Sync bypass");
    await grantCodes(api.db, owner, { codes: ["admin.terminal.manage"] });
    const { enrolTerminal } = await import("./support/pos");
    terminal = await enrolTerminal(api, owner, { as: owner.human, code: "BYPASS" });
  }, 180_000);
  afterAll(async () => api.stop());
  it("refuses a valid human token at the terminal surface", async () => {
    const response = await api.request({
      method: "GET",
      path: "/v1/sync/catalogue",
      as: owner.human,
    });
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
  });
  it("ignores forged tenant and actor headers beside a valid signature", async () => {
    const { syncRequest } = await import("./support/pos");
    const response = await syncRequest(api, terminal, {
      method: "GET",
      path: "/v1/sync/catalogue",
      headers: { "X-Tenant-Id": "00000000-0000-7000-8000-000000000000", "X-Actor-Id": owner.human },
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(
      Buffer.from(response.headers.get("X-Terminal-Token")!.split(".")[1]!, "base64url").toString(
        "utf8",
      ),
    ) as { sub: string };
    expect(payload.sub).toBe(`terminal:${terminal.terminalId}`);
  });
  it("refuses a signature for another path and preserves the signed encoded pathname", async () => {
    const { signSyncRequest } = await import("./support/pos");
    for (const signedPath of ["/v1/sync/tickets", "/v1/sync/catalogue"]) {
      const response = await api.request({
        method: "GET",
        path: "/v1/%73ync/catalogue",
        headers: signSyncRequest(terminal, { method: "GET", path: signedPath }),
      });
      expect(response.status).toBe(401);
      expect(await problemCode(response)).toBe("ERR_TERMINAL_SIGNATURE_INVALID");
    }
    const path = "/v1/%73ync/catalogue";
    const response = await api.request({
      method: "GET",
      path,
      headers: signSyncRequest(terminal, { method: "GET", path }),
    });
    expect(response.status).toBe(200);
  });
});
