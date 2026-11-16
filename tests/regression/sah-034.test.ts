import { PERMISSIONS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression(
  "SAH-034",
  "`Grants` — the document-level permission table — is never read by any code",
  {
    "the permission table is real data that the database itself reads, not a table nothing consults":
      async ({ api, expect }) => {
        // `Grants` existed and was never queried. `app.permission` is the FK target of every `role_permission` row
        // and the argument of `app.actor_has` (plan0A:985–1004), so a code that is not here cannot be granted and a
        // grant that is here is what the predicate answers about. (`actor_has` is never called from `db.admin`: it
        // reads `app.current_actor()`, which only exists inside a `withTenant` transaction.)
        const rows = await api.db.admin<
          { code: string }[]
        >`select code from app.permission order by code`;
        expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).toSorted());

        const fks = await api.db.admin<{ conname: string }[]>`
      select c.conname from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_class r on r.oid = c.confrelid
       where t.relname = 'role_permission' and r.relname = 'permission' and c.contype = 'f'`;
        expect(fks.length).toBe(1);
      },

    "withdrawing the grant closes the route on the very next request": async ({
      api,
      a,
      expect,
    }) => {
      const ok = await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human });
      expect(ok.status).toBe(200);

      await api.db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
        await tx`delete from app.role_permission
                where tenant_id = ${a.tenant} and permission_code = 'admin.audit_log.read'`;
      });

      const denied = await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human });
      expect(denied.status).toBe(403);
      expect((await problemOf(denied)).code).toBe("ERR_RBAC_FORBIDDEN");

      await api.db.migrator.begin(async (tx) => {
        // restore: later files in this run need it
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
        const [role] = await tx<
          { id: string }[]
        >`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${role!.id}, 'admin.audit_log.read')`;
      });
      expect(
        (await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human })).status,
      ).toBe(200);
    },
  },
);
