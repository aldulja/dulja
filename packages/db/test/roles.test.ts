import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES_SQL, startDb, type Db } from "./harness";

describe("provision/roles.sql — spec §3.8 roles, task 0.2 local equivalent", () => {
  let db: Db | undefined;

  beforeAll(async () => {
    db = await startDb({ migrate: false });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("creates exactly the three roles with the required attributes", async () => {
    const rows = await db!.admin<
      { rolname: string; rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }[]
    >`
      select rolname, rolcanlogin, rolbypassrls, rolsuper
        from pg_roles where rolname in ('app_migrator', 'app_rw', 'app_auth') order by rolname
    `;

    expect(rows).toEqual([
      { rolname: "app_auth", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "app_migrator", rolcanlogin: true, rolbypassrls: false, rolsuper: false },
      { rolname: "app_rw", rolcanlogin: true, rolbypassrls: false, rolsuper: false },
    ]);
  });

  it("app_rw and app_migrator sessions run in UTC", async () => {
    const [rw] = await db!.rw<{ tz: string }[]>`select current_setting('timezone') as tz`;
    const [migrator] = await db!.migrator<
      { tz: string }[]
    >`select current_setting('timezone') as tz`;

    expect(rw?.tz).toBe("UTC");
    expect(migrator?.tz).toBe("UTC");
  });

  it("lets only app_migrator assume app_auth", async () => {
    await expect(db!.rw`set role app_auth`).rejects.toThrow(/permission denied/);

    await db!.migrator.begin(async (tx) => {
      await tx`set local role app_auth`;
      const [role] = await tx<{ user: string }[]>`select current_user as user`;
      expect(role?.user).toBe("app_auth");
    });
  });

  it("is idempotent", async () => {
    await expect(db!.admin.unsafe(readFileSync(ROLES_SQL, "utf8"))).resolves.toBeDefined();
  });
});
