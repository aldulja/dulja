import type { Sql } from "postgres";
import { readPackFile, type LoaderContext, type PackLoader } from "./packs";

/** One element per dimension type, so a later slice adds a type by adding an element to branch.json's array. */
interface DimensionSeed {
  readonly code: string;
  readonly nameEn: string;
  readonly values: readonly { readonly code: string; readonly nameEn: string }[];
}

/**
 * spec:2000 step 4: "the `BRANCH` dimension type and head-office value". `role_assignment_branch.branch_id`,
 * `document.branch_id` and `pos_terminal.branch_id` all reference `dimension_value` rows of this type, so nothing
 * that carries a branch can be created until this loader has run.
 *
 * `name_ar` is not written: 0D's migration 0007 added it as nullable, the Arabic labels for BRANCH and HQ are i18n
 * catalogue entries (0E) rather than tenant data, and a tenant's own branch names arrive through the dimension API.
 */
export const dimensionsLoader: PackLoader = {
  name: "dimensions",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const types = readPackFile<readonly DimensionSeed[]>(ctx.packRoot, "dimensions", "branch.json");
    let inserted = 0;
    for (const type of types) {
      const created = await tx<{ id: string }[]>`
        insert into app.dimension_type (tenant_id, company_id, code, name_en)
        values (${ctx.tenantId}, ${ctx.companyId}, ${type.code}, ${type.nameEn})
        on conflict (company_id, code) do nothing
        returning id::text as id`;
      inserted += created.length;
      const [row] =
        created.length > 0
          ? created
          : await tx<{ id: string }[]>`
              select id::text as id from app.dimension_type
               where company_id = ${ctx.companyId} and code = ${type.code}`;
      for (const value of type.values) {
        const valueRows = await tx<{ id: string }[]>`
          insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
          values (${ctx.tenantId}, ${row!.id}, ${value.code}, ${value.nameEn})
          on conflict (dimension_type_id, code) do nothing
          returning id::text as id`;
        inserted += valueRows.length;
      }
    }
    return inserted;
  },
};
