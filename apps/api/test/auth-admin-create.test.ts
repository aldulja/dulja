import { afterEach, describe, expect, it, vi } from "vitest";
import { StubAuthAdmin, SupabaseAuthAdmin, createAuthAdmin } from "../src/auth-admin";
import { readConfig } from "../src/config";
const options = {
  url: "https://project.supabase.co",
  serviceRoleKey: "test-service-role",
  invitePath: "/auth/v1/invite",
  createPath: "/auth/v1/admin/users",
};
afterEach(() => vi.unstubAllGlobals());
describe("cashier identity creation", () => {
  it("creates an email-confirmed provider user without an invitation or password", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: "real-provider-sub", email: "untrusted@example.invalid" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new SupabaseAuthAdmin(options).createUser("cashier@example.invalid"),
    ).resolves.toEqual({ sub: "real-provider-sub", email: "cashier@example.invalid" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://project.supabase.co/auth/v1/admin/users");
    expect(init).toMatchObject({
      method: "POST",
      headers: { apikey: "test-service-role", authorization: "Bearer test-service-role" },
      body: JSON.stringify({ email: "cashier@example.invalid", email_confirm: true }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).not.toHaveProperty("password");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("maps duplicate users, provider failure, invalid JSON and missing subject safely", async () => {
    const admin = new SupabaseAuthAdmin(options);
    for (const status of [409, 422]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("held", { status })),
      );
      await expect(admin.createUser("held@example.invalid")).rejects.toMatchObject({
        code: "ERR_CONFLICT_UNIQUE",
      });
    }
    for (const response of [
      new Response("failure", { status: 500 }),
      Response.json({}),
      new Response("invalid json", { status: 200 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await expect(admin.createUser("cashier@example.invalid")).rejects.toMatchObject({
        code: "ERR_INTERNAL",
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    await expect(admin.createUser("cashier@example.invalid")).rejects.toMatchObject({
      code: "ERR_INTERNAL",
    });
  });
  it("keeps the development subject deterministic across invitation and creation", async () => {
    const admin = new StubAuthAdmin();
    expect(await admin.createUser("CASHIER@example.invalid")).toEqual(
      await admin.inviteUser("CASHIER@example.invalid"),
    );
    expect((await admin.createUser("cashier@example.invalid")).sub).toBe(
      (await admin.inviteUser("CASHIER@example.invalid")).sub,
    );
  });
  it("production composition chooses the actual admin-create endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "provider-sub" }));
    vi.stubGlobal("fetch", fetchMock);
    const admin = createAuthAdmin(
      readConfig({
        DATABASE_URL: "postgres://app_rw:test@localhost/db",
        TERMINAL_JWT_SIGNING_KEY: "dulja-test-terminal-signing-key-0123456789abcdef",
        SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
        SUPABASE_JWT_ISSUER: "https://project.supabase.co/auth/v1",
        SUPABASE_URL: options.url,
        SUPABASE_SERVICE_ROLE_KEY: options.serviceRoleKey,
      }),
    );
    await admin.createUser("cashier@example.invalid");
    expect((fetchMock.mock.calls[0] as unknown as [URL])[0].pathname).toBe("/auth/v1/admin/users");
  });
});
