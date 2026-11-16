import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import type { RoundingMode } from "@dulja/domain";
import { parseRateTable } from "@dulja/domain/payroll";
import { readPackFile, type LoaderContext, type PackLoader } from "./packs";
import { SeedError } from "./types";

export interface SchemeSeed {
  code: string;
  nameEn: string;
  nameAr?: string;
  roundingMode?: RoundingMode;
}
export interface PayComponentSeed {
  code: string;
  nameEn: string;
  nameAr?: string;
  kind: "earning" | "deduction";
  quantityBased?: boolean;
}

/** §4.12.4's marker: a table whose `source.authority` is this literal is a test fixture, never a published table. */
const TEST_AUTHORITY = "Dulja test fixture";
const RATE_TABLE_FILE = /^v\d+\.json$/;

/** A list file of the sub-pack, or `[]` when the pack does not carry it. The other directory loaders (`tax`,
 *  `reports`) load whatever files are present and nothing when there are none; this one follows them, so a pack
 *  reconstructed for a database that predates 0084 can keep the required directory and leave it empty. The shipped
 *  pack carries both files and `test/hr/statutory-loader.test.ts` pins what they insert. */
function readListFile<T>(packRoot: string, file: string): T[] {
  return existsSync(join(packRoot, "statutory", file))
    ? readPackFile<T[]>(packRoot, "statutory", file)
    : [];
}

/**
 * The `--only statutory` loader (§3.4.8, contracts round 16 A12, ADR 0073). Applies `schemes.json`, then
 * `pay-components.json`, then every `<SCHEME>/vN.json` present.
 *
 * **Idempotent on the natural keys** — `on conflict … do nothing` everywhere, so a re-run inserts zero rows. A loaded
 * rate table is NEVER overwritten: overwriting one would silently replace numbers a second principal has already
 * verified.
 *
 * **Every rate-table file is validated against `rate-table.schema.json` before it touches the database**
 * (`parseRateTable`, which throws `RateTableValidationError` with JSON Pointers), its declared `scheme` must name the
 * directory it sits in, and a `"Dulja test fixture"` authority is refused outside `APP_ENV=dev` (§4.12.4).
 *
 * **`pay_component_scheme` is deliberately NOT seeded**, and **`verified_at` is never set**: applicability is a
 * statutory claim that arrives with OD-23, and verification is a human act by a different principal (spec:2080).
 */
export async function loadStatutoryPack(tx: Sql, ctx: LoaderContext): Promise<number> {
  let applied = 0;

  const schemes = readListFile<SchemeSeed>(ctx.packRoot, "schemes.json");
  for (const s of schemes) {
    const res = await tx`
      insert into app.statutory_scheme (tenant_id, company_id, code, name_en, name_ar, rounding_mode)
      values (${ctx.tenantId}, ${ctx.companyId}, ${s.code}, ${s.nameEn}, ${s.nameAr ?? null},
              ${s.roundingMode ?? "HALF_AWAY_FROM_ZERO"})
      on conflict (company_id, code) do nothing`;
    applied += res.count;
  }

  const components = readListFile<PayComponentSeed>(ctx.packRoot, "pay-components.json");
  for (const c of components) {
    const res = await tx`
      insert into app.pay_component (tenant_id, company_id, code, name_en, name_ar, kind, quantity_based)
      values (${ctx.tenantId}, ${ctx.companyId}, ${c.code}, ${c.nameEn}, ${c.nameAr ?? null}, ${c.kind},
              ${c.quantityBased ?? false})
      on conflict (company_id, code) do nothing`;
    applied += res.count;
  }

  const dev = ctx.config.appEnv === "dev";
  for (const scheme of schemes) {
    const dir = join(ctx.packRoot, "statutory", scheme.code);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((f) => RATE_TABLE_FILE.test(f))
      .toSorted()) {
      const definition = parseRateTable(
        readPackFile<unknown>(ctx.packRoot, "statutory", `${scheme.code}/${file}`),
      );
      if (definition.source.authority === TEST_AUTHORITY && !dev) {
        throw new SeedError(
          `${scheme.code}/${file} carries source.authority "${TEST_AUTHORITY}"; a test fixture may not be seeded outside APP_ENV=dev (§4.12.4)`,
        );
      }
      if (definition.scheme !== scheme.code) {
        throw new SeedError(
          `${scheme.code}/${file} declares scheme "${definition.scheme}"; the directory says "${scheme.code}"`,
        );
      }
      const source = `${definition.source.authority} / ${definition.source.publication} / retrieved ${definition.source.retrieved_on}`;
      const res = await tx`
        insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
        select ${ctx.tenantId}, s.id, ${definition.version}::int, ${definition.effective_from}::date,
               ${definition.effective_to ?? null}::date, ${tx.json(definition as never)}, ${source}
          from app.statutory_scheme s where s.company_id = ${ctx.companyId} and s.code = ${scheme.code}
        on conflict (scheme_id, version) do nothing`;
      applied += res.count;
    }
  }
  return applied;
}

export const statutoryLoader: PackLoader = { name: "statutory", load: loadStatutoryPack };
