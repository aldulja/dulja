import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db, uuidv7, withTenant } from "./harness";

describe("identity core — v1.1 bootstrap and resolution fixes", () => {
  let db: Db | undefined;
  let tenantId: string;
  let systemId: string;
  let humanId: string;

  beforeAll(async () => {
    db = await startDb();
    tenantId = await uuidv7(db.admin);
    systemId = await uuidv7(db.admin);
    humanId = await uuidv7(db.admin);
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("bootstraps a tenant, system principal, and membership in one FORCE RLS transaction", async () => {
    await withTenant(db!.migrator, tenantId, systemId, async (transaction) => {
      await transaction`insert into app.tenant (id, name) values (${tenantId}, 'Owner Sdn Bhd')`;
      await transaction`
        insert into app.principal (id, kind, auth_subject, display_name)
        values (${systemId}, 'system', ${`system:${tenantId}`}, 'system')
      `;
      await transaction`
        insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${systemId})
      `;
      const rows = await transaction<{ id: string }[]>`select id from app.principal`;
      expect(rows.map((row) => row.id)).toEqual([systemId]);
    });
  });

  it("invites a human principal and membership in one transaction", async () => {
    await withTenant(db!.rw, tenantId, systemId, async (transaction) => {
      await transaction`
        insert into app.principal (id, kind, auth_subject, email, display_name)
        values (${humanId}, 'human', 'sub-owner-1', 'owner@example.test', 'Owner')
      `;
      await transaction`
        insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${humanId})
      `;
    });

    await withTenant(db!.rw, tenantId, systemId, async (transaction) => {
      const rows = await transaction<{ id: string }[]>`select id from app.principal order by id`;
      expect(rows.map((row) => row.id).toSorted()).toEqual([systemId, humanId].toSorted());
    });
  });

  it("rejects a principal insert without a tenant transaction setting", async () => {
    await expect(
      db!.rw`
        insert into app.principal (kind, auth_subject, display_name) values ('human', 'stray', 'Stray')
      `,
    ).rejects.toThrow(/row-level security/);
  });

  it("resolves a principal without tenant context while direct reads return no rows", async () => {
    const rows = await db!.rw<{ principal_id: string; tenant_id: string; kind: string }[]>`
      select * from app.resolve_principal('sub-owner-1')
    `;
    expect(rows).toEqual([{ principal_id: humanId, tenant_id: tenantId, kind: "human" }]);
    expect(await db!.rw`select * from app.principal`).toHaveLength(0);
    expect(await db!.rw`select * from app.membership`).toHaveLength(0);
    expect(await db!.rw`select * from app.resolve_principal('nobody')`).toHaveLength(0);
  });

  it("uses a SECURITY DEFINER function owned by app_auth without BYPASSRLS", async () => {
    const [functionOwner] = await db!.admin<{ owner: string; secdef: boolean; bypass: boolean }[]>`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef,
             (select rolbypassrls from pg_roles where oid = p.proowner) as bypass
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'resolve_principal'
    `;
    expect(functionOwner).toEqual({ owner: "app_auth", secdef: true, bypass: false });
  });

  it("isolates a second tenant", async () => {
    const secondTenant = await uuidv7(db!.admin);
    const secondSystem = await uuidv7(db!.admin);

    await withTenant(db!.migrator, secondTenant, secondSystem, async (transaction) => {
      await transaction`insert into app.tenant (id, name) values (${secondTenant}, 'Other')`;
      await transaction`
        insert into app.principal (id, kind, auth_subject, display_name)
        values (${secondSystem}, 'system', ${`system:${secondTenant}`}, 'system')
      `;
      await transaction`
        insert into app.membership (tenant_id, principal_id) values (${secondTenant}, ${secondSystem})
      `;
    });

    await withTenant(db!.rw, secondTenant, secondSystem, async (transaction) => {
      expect(
        (await transaction<{ id: string }[]>`select id from app.tenant`).map((row) => row.id),
      ).toEqual([secondTenant]);
      expect(
        (await transaction<{ id: string }[]>`select id from app.principal`).map((row) => row.id),
      ).toEqual([secondSystem]);
    });
  });

  it("enforces auth-subject prefixes for system and terminal principals", async () => {
    await expect(
      withTenant(
        db!.migrator,
        tenantId,
        systemId,
        (transaction) =>
          transaction`
          insert into app.principal (kind, auth_subject, display_name)
          values ('human', 'system:impostor', 'X')
        `,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      withTenant(
        db!.migrator,
        tenantId,
        systemId,
        (transaction) =>
          transaction`
          insert into app.principal (kind, auth_subject, display_name)
          values ('system', 'not-prefixed', 'X')
        `,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects a membership naming another tenant through WITH CHECK", async () => {
    const otherTenant = await uuidv7(db!.admin);
    const otherSystem = await uuidv7(db!.admin);
    const stranger = await uuidv7(db!.admin);

    await withTenant(db!.migrator, otherTenant, otherSystem, async (transaction) => {
      await transaction`insert into app.tenant (id, name) values (${otherTenant}, 'Other 2')`;
      await transaction`
        insert into app.principal (id, kind, auth_subject, display_name)
        values (${otherSystem}, 'system', ${`system:${otherTenant}`}, 'system')
      `;
      await transaction`
        insert into app.membership (tenant_id, principal_id) values (${otherTenant}, ${otherSystem})
      `;
      await transaction`
        insert into app.principal (id, kind, auth_subject, display_name)
        values (${stranger}, 'human', ${`p3:${otherTenant}`}, 'P3')
      `;
    });

    // The session names otherTenant; the row names the first tenant. Only the policy's WITH CHECK can
    // catch that, because the row is legal against every constraint on the table.
    await expect(
      withTenant(
        db!.rw,
        otherTenant,
        otherSystem,
        (transaction) =>
          transaction`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${stranger})`,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
