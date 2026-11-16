import type { Sql } from "postgres";
import { adminPermissions, ROLES } from "../../seed/roles";
import type { LoaderContext, PackLoader } from "./packs";

/**
 * Applies the nine system roles per tenant (§3.6.4; spec:2000 step 4). ⚠️ OWNER GATE OD-04 — the names live in
 * `packages/db/seed/roles.ts` (slice 0D) and this file never restates them.
 *
 * The catalogue is read from `app.permission`, not imported: this package may not import `@dulja/contracts`
 * (§5.2's dependency rule), and `role_permission.permission_code` has a foreign key to that table anyway, so the
 * database's contents are the only grantable set. A role naming a code the catalogue does not yet hold is skipped
 * rather than failed — F-21, the same tolerance the `role-seed` lint applies.
 *
 * The system principal is the actor (withTenant set it), so `forbid_self_grant` and `keep_last_admin_*` hold.
 */
export const rolesLoader: PackLoader = {
  name: "roles",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const catalogue = (
      await tx<{ code: string }[]>`select code from app.permission order by code`
    ).map((row) => row.code);
    const present = new Set(catalogue);
    let inserted = 0;

    for (const role of ROLES) {
      const created = await tx<{ id: string }[]>`
        insert into app.role (tenant_id, code, name_en, name_ar, description, is_system)
        values (${ctx.tenantId}, ${role.code}, ${role.nameEn}, ${role.nameAr}, ${role.description}, true)
        on conflict (tenant_id, code) do nothing
        returning id::text as id`;
      inserted += created.length;

      const [row] =
        created.length > 0
          ? created
          : await tx<{ id: string }[]>`
              select id::text as id from app.role where tenant_id = ${ctx.tenantId} and code = ${role.code}`;
      const roleId = row!.id;

      const codes =
        role.code === "admin"
          ? adminPermissions(catalogue)
          : role.permissions.filter((code) => present.has(code));
      for (const code of codes) {
        const granted = await tx<{ role_id: string }[]>`
          insert into app.role_permission (tenant_id, role_id, permission_code)
          values (${ctx.tenantId}, ${roleId}, ${code})
          on conflict (role_id, permission_code) do nothing
          returning role_id::text as role_id`;
        inserted += granted.length;
      }
    }
    return inserted;
  },
};
