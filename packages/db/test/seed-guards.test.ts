import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs, seed, SeedError, StubSeedAuthAdmin } from "../src/seed";
import { startDb, type Db } from "./harness";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("seed guards (DBS-12, DBS-17)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  const tenantRows = async (tenantId: string) => {
    const [row] = await db.admin<{ tenants: number; companies: number; members: number }[]>`
      select (select count(*)::int from app.tenant where id = ${tenantId}) as tenants,
             (select count(*)::int from app.company where tenant_id = ${tenantId}) as companies,
             (select count(*)::int from app.membership where tenant_id = ${tenantId}) as members`;
    return row!;
  };

  /**
   * DBS-12 (2026-11-15 full review): the owner's principal lookup runs under RLS, so another tenant's principal
   * with the same `auth_subject` was invisible; a new id was minted, the targetless `on conflict do nothing` hit
   * the global unique `auth_subject`, and the membership insert then failed its foreign key — after the tenant,
   * its company and every pack had committed, leaving a tenant with no owner that every re-run failed the same way.
   */
  it("a second tenant whose owner e-mail already owns a tenant is refused before anything is written", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const email = `shared-${first.slice(0, 8)}@example.my`;
    const config = (tenantId: string) =>
      parseSeedArgs(["--tenant", tenantId, "--owner-email", email], {} as NodeJS.ProcessEnv);

    await seed(migrator, config(first), new StubSeedAuthAdmin());
    expect(await tenantRows(first)).toMatchObject({ tenants: 1, companies: 1, members: 2 });

    // A fresh stub, as a second CLI run would have: its subject for the e-mail is the same deterministic one.
    const refused = seed(migrator, config(second), new StubSeedAuthAdmin());
    await expect(refused).rejects.toBeInstanceOf(SeedError);
    await expect(seed(migrator, config(second), new StubSeedAuthAdmin())).rejects.toThrow(
      /already belongs to another tenant/,
    );
    expect(await tenantRows(second)).toEqual({ tenants: 0, companies: 0, members: 0 });

    // The first tenant's own re-run still adopts its owner.
    await expect(seed(migrator, config(first), new StubSeedAuthAdmin())).resolves.toMatchObject({
      tenantId: first,
    });
  }, 240_000);

  /** DBS-17: outside `dev` the fixture owner and company, and the stub auth admin, are refused (OD-21). */
  describe("a staging or production seed refuses the OD-21 fixture values", () => {
    const tenantId = "019a0000-0000-7000-8000-0000000000aa";

    it.each([["staging"], ["production"]])(
      "APP_ENV=%s needs --owner-email and --company-name for a full seed",
      (appEnv) => {
        const env = { APP_ENV: appEnv } as NodeJS.ProcessEnv;
        expect(() => parseSeedArgs(["--tenant", tenantId], env)).toThrow(/--owner-email/);
        expect(() =>
          parseSeedArgs(["--tenant", tenantId, "--owner-email", "owner@shop.my"], env),
        ).toThrow(/--company-name/);
        expect(() =>
          parseSeedArgs(
            [
              "--tenant",
              tenantId,
              "--owner-email",
              "owner@dulja.invalid",
              "--company-name",
              "Shop Sdn Bhd",
            ],
            env,
          ),
        ).toThrow(/\.invalid/);
        expect(
          parseSeedArgs(
            [
              "--tenant",
              tenantId,
              "--owner-email",
              "owner@shop.my",
              "--company-name",
              "Shop Sdn Bhd",
            ],
            env,
          ),
        ).toMatchObject({ ownerEmail: "owner@shop.my", companyName: "Shop Sdn Bhd" });
        // A re-apply of one sub-pack to a seeded tenant writes no owner and no company name.
        expect(parseSeedArgs(["--tenant", tenantId, "--only", "roles"], env).only).toEqual([
          "roles",
        ]);
      },
    );

    const cli = (args: readonly string[], appEnv: string) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APP_ENV: appEnv,
        DATABASE_URL_MIGRATOR: db.url("app_migrator"),
      };
      delete env["SUPABASE_URL"];
      delete env["SUPABASE_SERVICE_ROLE_KEY"];
      const run = spawnSync("bun", ["run", "seed", "--", ...args], {
        cwd: PACKAGE_DIR,
        env,
        encoding: "utf8",
        timeout: 120_000,
        // As the other seed CLI tests: `bun` is a `.cmd` shim on some Windows machines. Every argument is a
        // literal or a uuid minted here.
        shell: process.platform === "win32",
      });
      return { status: run.status, stderr: run.stderr };
    };

    it("the CLI exits 2 on the fixture values and on the stub auth admin, and writes nothing", async () => {
      const bare = randomUUID();
      const fixture = cli(["--tenant", bare], "production");
      expect(fixture.status, fixture.stderr).toBe(2);
      expect(await tenantRows(bare)).toEqual({ tenants: 0, companies: 0, members: 0 });

      const stated = randomUUID();
      const stub = cli(
        ["--tenant", stated, "--owner-email", "owner@shop.my", "--company-name", "Shop Sdn Bhd"],
        "production",
      );
      expect(stub.status, stub.stderr).toBe(2);
      expect(stub.stderr).toMatch(/SUPABASE_URL/);
      expect(await tenantRows(stated)).toEqual({ tenants: 0, companies: 0, members: 0 });
    }, 240_000);

    it("--only outside dev re-applies to a seeded tenant and refuses to create one", async () => {
      const fresh = randomUUID();
      const run = cli(["--tenant", fresh, "--only", "roles"], "staging");
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toMatch(/not seeded/);
      expect(await tenantRows(fresh)).toEqual({ tenants: 0, companies: 0, members: 0 });
    }, 120_000);
  });
});
