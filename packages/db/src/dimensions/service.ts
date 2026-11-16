import type { Sql } from "postgres";

export interface DimensionTypeRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}
export interface DimensionValueRow {
  id: string;
  dimensionTypeId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  parentId: string | null;
  archivedAt: string | null;
}
export interface CreateDimensionTypeInput {
  companyId: string;
  code: string;
  nameEn: string;
  nameAr?: string | null;
}
export interface CreateDimensionValueInput {
  dimensionTypeId: string;
  code: string;
  nameEn: string;
  nameAr?: string | null;
  parentId?: string | null;
}

export async function createDimensionType(
  tx: Sql,
  input: CreateDimensionTypeInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.dimension_type (tenant_id, company_id, code, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null})
    returning id`;
  return row!.id;
}

export async function createDimensionValue(
  tx: Sql,
  input: CreateDimensionValueInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.dimension_value
      (tenant_id, dimension_type_id, code, name_en, name_ar, parent_id)
    values (app.current_tenant(), ${input.dimensionTypeId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null}, ${input.parentId ?? null})
    returning id`;
  return row!.id;
}

export async function listDimensionTypes(tx: Sql, companyId: string): Promise<DimensionTypeRow[]> {
  const rows = await tx<
    {
      id: string;
      company_id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
    }[]
  >`
    select id, company_id, code, name_en, name_ar
      from app.dimension_type where company_id = ${companyId} order by code`;
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    nameEn: row.name_en,
    nameAr: row.name_ar,
  }));
}

export async function listDimensionValues(
  tx: Sql,
  dimensionTypeId: string,
  includeArchived: boolean,
): Promise<DimensionValueRow[]> {
  const rows = await tx<
    {
      id: string;
      dimension_type_id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      parent_id: string | null;
      archived_at: string | null;
    }[]
  >`
    select id, dimension_type_id, code, name_en, name_ar, parent_id, archived_at
      from app.dimension_value
     where dimension_type_id = ${dimensionTypeId}
       and (${includeArchived}::boolean or archived_at is null)
     order by code`;
  return rows.map((row) => ({
    id: row.id,
    dimensionTypeId: row.dimension_type_id,
    code: row.code,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    parentId: row.parent_id,
    archivedAt: row.archived_at,
  }));
}
