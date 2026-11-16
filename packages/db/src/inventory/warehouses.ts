import type { Sql } from "postgres";

export type WarehouseKind = "stock" | "in_transit";

export interface WarehouseRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: WarehouseKind;
  branchId: string;
  parentId: string | null;
  archivedAt: string | null;
  createdAt: string;
}
export interface WarehouseNode extends WarehouseRow {
  depth: number;
  /** Codes from the root to this node inclusive — what a screen renders as a breadcrumb. */
  path: string[];
}

interface DbWarehouse {
  id: string;
  company_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  kind: WarehouseKind;
  branch_id: string;
  parent_id: string | null;
  archived_at: string | null;
  created_at: string;
}

const toWarehouse = (r: DbWarehouse): WarehouseRow => ({
  id: r.id,
  companyId: r.company_id,
  code: r.code,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  kind: r.kind,
  branchId: r.branch_id,
  parentId: r.parent_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
});

export async function createWarehouse(
  tx: Sql,
  input: {
    companyId: string;
    code: string;
    nameEn: string;
    nameAr?: string | null;
    kind?: WarehouseKind;
    branchId: string;
    parentId?: string | null;
  },
): Promise<WarehouseRow> {
  const [row] = await tx<DbWarehouse[]>`
    insert into app.warehouse (tenant_id, company_id, code, name_en, name_ar, kind, branch_id, parent_id)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind ?? "stock"}, ${input.branchId}, ${input.parentId ?? null})
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return toWarehouse(row!);
}

export async function getWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null> {
  const [row] = await tx<DbWarehouse[]>`
    select id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at
      from app.warehouse where id = ${warehouseId}`;
  return row ? toWarehouse(row) : null;
}

/** `code`, `kind` and `branch_id` are immutable: movements already written are keyed by this row, and
 *  moving a warehouse to another branch would silently re-scope every historical figure (LEGACY-045). */
export async function updateWarehouse(
  tx: Sql,
  warehouseId: string,
  patch: { nameEn?: string; nameAr?: string | null; parentId?: string | null },
): Promise<WarehouseRow | null> {
  const current = await getWarehouse(tx, warehouseId);
  if (!current) return null;
  const [row] = await tx<DbWarehouse[]>`
    update app.warehouse set
      name_en   = ${patch.nameEn ?? current.nameEn},
      name_ar   = ${patch.nameAr === undefined ? current.nameAr : patch.nameAr},
      parent_id = ${patch.parentId === undefined ? current.parentId : patch.parentId}
     where id = ${warehouseId}
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return row ? toWarehouse(row) : null;
}

/** spec:2049 — master data is archived, never deleted. Idempotent: a second call is a no-op. */
export async function archiveWarehouse(tx: Sql, warehouseId: string): Promise<WarehouseRow | null> {
  const [row] = await tx<DbWarehouse[]>`
    update app.warehouse set archived_at = coalesce(archived_at, now()) where id = ${warehouseId}
    returning id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at`;
  return row ? toWarehouse(row) : null;
}

export async function listWarehouses(
  tx: Sql,
  params: {
    companyId: string;
    kind?: WarehouseKind;
    includeArchived?: boolean;
    cursor?: { code: string } | null;
    limit: number;
  },
): Promise<WarehouseRow[]> {
  const rows = await tx<DbWarehouse[]>`
    select id, company_id, code, name_en, name_ar, kind, branch_id, parent_id, archived_at, created_at
      from app.warehouse
     where company_id = ${params.companyId}
       and (${params.kind ?? null}::text is null or kind = ${params.kind ?? null})
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toWarehouse);
}

/** LEGACY-071's positive form: one recursive CTE, top-down, returning depth and the code path. */
export async function warehouseTree(tx: Sql, companyId: string): Promise<WarehouseNode[]> {
  const rows = await tx<(DbWarehouse & { depth: number; path: string[] })[]>`
    with recursive node as (
      select w.id, w.company_id, w.code, w.name_en, w.name_ar, w.kind, w.branch_id, w.parent_id,
             w.archived_at, w.created_at, 0 as depth, array[w.code] as path
        from app.warehouse w
       where w.company_id = ${companyId} and w.parent_id is null
      union all
      select w.id, w.company_id, w.code, w.name_en, w.name_ar, w.kind, w.branch_id, w.parent_id,
             w.archived_at, w.created_at, n.depth + 1, n.path || w.code
        from app.warehouse w
        join node n on w.parent_id = n.id
       where w.company_id = ${companyId}
    )
    select * from node order by path`;
  return rows.map((r) => ({ ...toWarehouse(r), depth: r.depth, path: r.path }));
}
