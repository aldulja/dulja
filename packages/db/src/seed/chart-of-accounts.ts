import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { readPackFile, type LoaderContext, type PackLoader } from "./packs";
import { SeedError } from "./types";

/** §4.15's declared file shape; `isGroup` marks an unregistered presentation parent. */
export interface AccountSeed {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly type: "asset" | "liability" | "equity" | "income" | "expense";
  readonly parentCode?: string;
  readonly currency?: string;
  readonly isGroup?: boolean;
}

/** §4.15: `company.fx_rounding_account_id` is set to this code immediately after it is inserted (spec:2001). */
export const FX_ROUNDING_ACCOUNT_CODE = "5920";

/** §4.15's frozen format: four digits, first digit = the account_type in the app.account_type enum's own order. */
const TYPE_DIGIT: Readonly<Record<AccountSeed["type"], string>> = {
  asset: "1",
  liability: "2",
  equity: "3",
  income: "4",
  expense: "5",
};
const LEAF_CODE = /^[1-5][0-9]{3}$/;

/** Enforced here and not as a DDL CHECK: a tenant's accountant may add accounts with any code they choose. */
function validate(file: string, rows: readonly AccountSeed[]): void {
  for (const account of rows) {
    if (account.isGroup) continue; // group codes are unregistered by §4.15
    if (!LEAF_CODE.test(account.code) || account.code[0] !== TYPE_DIGIT[account.type]) {
      throw new SeedError(
        `chart-of-accounts/${file}: account code '${account.code}' does not match ^[1-5][0-9]{3}$ with first digit ${TYPE_DIGIT[account.type]} for type ${account.type}`,
      );
    }
  }
}

/**
 * §3.4.8's "add a file, never a loader" rule made concrete: every `.json` in the sub-pack is loaded, so later slices
 * each add `<slice>.json` (§4.15's file-per-slice layout) and none of them edits this file or a shared chart. Files
 * are applied in name order, which puts `0c-base.json` and its group parents first; a parent is resolved by code
 * within the same run, so a later slice's file may hang rows off 0C's groups.
 */
export const chartOfAccountsLoader: PackLoader = {
  name: "chart-of-accounts",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const files = readdirSync(join(ctx.packRoot, "chart-of-accounts"))
      .filter((file) => file.endsWith(".json"))
      .toSorted();
    let inserted = 0;

    for (const file of files) {
      const rows = readPackFile<readonly AccountSeed[]>(ctx.packRoot, "chart-of-accounts", file);
      validate(file, rows);
      for (const account of rows) {
        let parentId: string | null = null;
        if (account.parentCode) {
          const [parent] = await tx<{ id: string }[]>`
            select id::text as id from app.account
             where company_id = ${ctx.companyId} and code = ${account.parentCode}`;
          if (!parent)
            throw new SeedError(
              `chart-of-accounts/${file}: account '${account.code}' names parent '${account.parentCode}', which is not in the pack`,
            );
          parentId = parent.id;
        }
        const created = await tx<{ id: string }[]>`
          insert into app.account (tenant_id, company_id, code, name_en, name_ar, type, parent_id, is_group, currency)
          values (${ctx.tenantId}, ${ctx.companyId}, ${account.code}, ${account.nameEn}, ${account.nameAr},
                  ${account.type}::app.account_type, ${parentId}, ${account.isGroup ?? false}, ${account.currency ?? null})
          on conflict (company_id, code) do nothing
          returning id::text as id`;
        inserted += created.length;
      }
    }

    // spec:2001 "then set company.fx_rounding_account_id". `is distinct from` keeps the re-run silent: an unguarded
    // UPDATE fires the AFTER ROW audit trigger on every deploy, which would break "changes nothing".
    const [fx] = await tx<{ id: string }[]>`
      select id::text as id from app.account
       where company_id = ${ctx.companyId} and code = ${FX_ROUNDING_ACCOUNT_CODE}`;
    if (!fx)
      throw new SeedError(
        `chart-of-accounts: the pack does not contain the FX-rounding account ${FX_ROUNDING_ACCOUNT_CODE} (§4.15, spec:2001)`,
      );
    await tx`update app.company set fx_rounding_account_id = ${fx.id}
              where id = ${ctx.companyId} and fx_rounding_account_id is distinct from ${fx.id}::uuid`;

    return inserted;
  },
};
