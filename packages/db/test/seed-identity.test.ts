import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { bootstrapIdentity } from "../src/seed/identity";
import { startDb, type Db } from "./harness";

describe("seed steps 1–3 — tenant, system principal, membership under FORCE RLS (spec:1997; v1.1 fix #2)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const env = {} as NodeJS.ProcessEnv;
  const cfg = (tenantId: string) => parseSeedArgs(["--tenant", tenantId], env);

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("creates the three rows in one transaction and reports created: true", async () => {
    const t = randomUUID();
    const r = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    expect(r.created).toBe(true);
    const [p] = await db.admin<{ auth_subject: string; kind: string }[]>`
      select auth_subject, kind::text from app.principal where id = ${r.systemPrincipalId}`;
    expect(p).toEqual({ auth_subject: `system:${t}`, kind: "system" });
    const [m] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.membership where tenant_id = ${t}`;
    expect(m!.n).toBe(1);
  });

  it("the tenant's audit row cites the not-yet-inserted system principal — the deferrable FK makes it legal", async () => {
    const t = randomUUID();
    const r = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const rows = await db.admin<{ table_name: string; actor_id: string }[]>`
      select table_name, actor_id::text from app.audit_log where tenant_id = ${t} order by seq`;
    expect(rows.map((x) => x.table_name)).toEqual(["tenant", "principal", "membership"]);
    expect(rows.every((x) => x.actor_id === r.systemPrincipalId)).toBe(true);
  });

  it("a second run changes nothing and adopts the existing system principal (spec:2317)", async () => {
    const t = randomUUID();
    const first = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const [before] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${t}`;
    const second = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    expect(second).toEqual({ systemPrincipalId: first.systemPrincipalId, created: false });
    const [after] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${t}`;
    expect(after!.n).toBe(before!.n);
  });

  it("registers the tenant for the job runner, which cannot list app.tenant under FORCE RLS (§4.2.6)", async () => {
    const t = randomUUID();
    await bootstrapIdentity(migrator, cfg(t), randomUUID());
    await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const [row] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from pgboss.tenant_registry where tenant_id = ${t}`;
    expect(row!.n).toBe(1);
  });

  it("the two facts this design rests on (assumption 5) hold in the shipped schema", async () => {
    const [unique] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint c join pg_class r on r.oid = c.conrelid
       where r.relname = 'principal' and c.contype = 'u'
         and pg_get_constraintdef(c.oid) = 'UNIQUE (auth_subject)'`;
    expect(unique!.n).toBe(1);
    const [policy] = await db.admin<{ qual: string }[]>`
      select pg_get_expr(p.polqual, p.polrelid) as qual from pg_policy p join pg_class r on r.oid = p.polrelid
       where r.relname = 'principal' and p.polname = 'principal_in_tenant'`;
    expect(policy!.qual).toContain("current_tenant()");
    expect(policy!.qual).not.toContain("current_actor()");
  });
});
