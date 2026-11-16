import {
  applyConversion,
  IDENTITY_CONVERSION,
  rational,
  type Quantity,
  type Rational,
} from "@dulja/domain";
import type { Sql } from "postgres";
// `UnitConversionMissingError` is declared ONCE, in the module Task 1 created, and imported here.
// Declaring it a second time in this file and re-exporting both from `packages/db/src/index.ts` is a
// duplicate named export — TS2308 — and `bun run typecheck` would refuse it.
import { UnitConversionMissingError } from "./errors";

export interface UnitRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  createdAt: string;
}

interface DbUnit {
  id: string;
  company_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  created_at: string;
}

const toUnit = (r: DbUnit): UnitRow => ({
  id: r.id,
  companyId: r.company_id,
  code: r.code,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  createdAt: r.created_at,
});

export async function createUnit(
  tx: Sql,
  input: { companyId: string; code: string; nameEn: string; nameAr?: string | null },
): Promise<UnitRow> {
  const [row] = await tx<DbUnit[]>`
    insert into app.unit_of_measure (tenant_id, company_id, code, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null})
    returning id, company_id, code, name_en, name_ar, created_at`;
  return toUnit(row!);
}

/** Keyset paging on `code`, the only sortable field the unit resource declares (§4.2.8). */
export async function listUnits(
  tx: Sql,
  params: { companyId: string; cursor?: { code: string } | null; limit: number },
): Promise<UnitRow[]> {
  const rows = params.cursor
    ? await tx<DbUnit[]>`
        select id, company_id, code, name_en, name_ar, created_at from app.unit_of_measure
         where company_id = ${params.companyId} and code > ${params.cursor.code}
         order by code limit ${params.limit}`
    : await tx<DbUnit[]>`
        select id, company_id, code, name_en, name_ar, created_at from app.unit_of_measure
         where company_id = ${params.companyId}
         order by code limit ${params.limit}`;
  return rows.map(toUnit);
}

export interface UnitConversionRow {
  itemId: string;
  unitId: string;
  unitCode: string;
  numerator: string;
  denominator: string;
}

/**
 * The conversions of one item, upserted. `numerator`/`denominator` cross this boundary as digit STRINGS
 * and are `bigint` in SQL — never `number`, which would silently lose precision above 2^53 and is what
 * `no-number-money` forbids for a rate (§3.7.5).
 *
 * **A pair the payload omits is left standing, not removed.** `app_rw` holds no DELETE on
 * `app.unit_conversion` (§3.5.4's list is pinned and 2B is its only extender) and §4.6.1 gives the table
 * no `archived_at`, so there is no mechanism to retire one — which is acceptable because a conversion is
 * a physical fact about a package, and a carton that held twelve pieces still held twelve. To stop
 * selling in a unit, remove it from the item's price lists; the conversion staying is harmless. A slice
 * that genuinely needs retirement adds `archived_at` to §4.6.1's row first, exactly as Task 4 did for
 * `price_list_line`.
 */
export async function replaceUnitConversions(
  tx: Sql,
  itemId: string,
  conversions: readonly { unitId: string; numerator: string; denominator: string }[],
): Promise<UnitConversionRow[]> {
  for (const c of conversions) {
    await tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (app.current_tenant(), ${itemId}, ${c.unitId}, ${c.numerator}::bigint, ${c.denominator}::bigint)
      on conflict (item_id, unit_id)
      do update set numerator = excluded.numerator, denominator = excluded.denominator`;
  }
  return listUnitConversions(tx, itemId);
}

export async function listUnitConversions(tx: Sql, itemId: string): Promise<UnitConversionRow[]> {
  return tx<UnitConversionRow[]>`
    select c.item_id as "itemId", c.unit_id as "unitId", u.code as "unitCode",
           c.numerator::text as "numerator", c.denominator::text as "denominator"
      from app.unit_conversion c
      join app.unit_of_measure u on u.id = c.unit_id
     where c.item_id = ${itemId}
     order by u.code`;
}

/**
 * The rational for one (item, unit). The item's own base unit needs no row and resolves to
 * IDENTITY_CONVERSION; anything else must be configured, and an unconfigured unit raises rather than
 * defaulting to 1/1 — a silent identity is exactly SAH-066's failure mode with a different sign.
 */
export async function resolveUnitConversion(
  tx: Sql,
  params: { itemId: string; unitId: string },
): Promise<Rational> {
  const [row] = await tx<
    { isBase: boolean; numerator: string | null; denominator: string | null }[]
  >`
    select (i.base_unit_id = ${params.unitId}) as "isBase",
           c.numerator::text  as "numerator",
           c.denominator::text as "denominator"
      from app.item i
      left join app.unit_conversion c on c.item_id = i.id and c.unit_id = ${params.unitId}
     where i.id = ${params.itemId}`;
  if (!row) throw new UnitConversionMissingError(params.itemId, params.unitId);
  if (row.isBase) return IDENTITY_CONVERSION;
  if (row.numerator === null || row.denominator === null) {
    throw new UnitConversionMissingError(params.itemId, params.unitId);
  }
  return rational(BigInt(row.numerator), BigInt(row.denominator));
}

/** The read-side twin of the 0032 trigger: same arithmetic, same order, same rounding mode. */
export async function convertToBase(
  tx: Sql,
  params: { itemId: string; unitId: string; unitQuantity: Quantity },
): Promise<Quantity> {
  return applyConversion(params.unitQuantity, await resolveUnitConversion(tx, params));
}
