import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { ItemTaxCodeInvalidError, ItemAccountUnresolvedError } from "./errors";

export type ItemKind = "product" | "service" | "asset";

/**
 * The §4.15 codes an item's four account columns default to. Registered there with 0C as the ONE
 * seeding slice; this slice resolves them and never seeds or invents one (hazard 33).
 */
export const ITEM_ACCOUNT_DEFAULTS = {
  revenue: "4000",
  inventory: "1300",
  cogs: "5000",
  expense: "5900",
} as const;

export interface ItemAccounts {
  revenueAccountId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  expenseAccountId: string | null;
}
export interface ItemAccountOverrides {
  revenueAccountId?: string | null;
  inventoryAccountId?: string | null;
  cogsAccountId?: string | null;
  expenseAccountId?: string | null;
}

/**
 * Resolves the four account columns for a new or updated item.
 *
 * A product needs all four codes; a service or asset holds no stock, so `1300` and `5000` are left
 * NULL and only revenue and expense are resolved (§4.15's `5900` row: "item.expense_account_id default
 * for kind ∈ service | asset"). An explicit override wins — including an explicit `null`, which means
 * "this item deliberately has no such account". A default code the company's chart does not contain is
 * an `ItemAccountUnresolvedError` naming the code, never a silent NULL: SAH-064 is exactly a guard that
 * looked like it defaulted a value and did not, and a NULL `inventory_account_id` would surface much
 * later as `ERR_POLICY_REQUIRES_MISSING` at post, in the slice that did not write it.
 */
export async function resolveItemAccounts(
  tx: Sql,
  params: { companyId: string; kind: ItemKind; overrides?: ItemAccountOverrides },
): Promise<ItemAccounts> {
  const needed: (keyof typeof ITEM_ACCOUNT_DEFAULTS)[] =
    params.kind === "product"
      ? ["revenue", "inventory", "cogs", "expense"]
      : ["revenue", "expense"];
  const codes = needed.map((k) => ITEM_ACCOUNT_DEFAULTS[k]);
  const rows = await tx<{ code: string; id: string }[]>`
    select code, id from app.account
     where company_id = ${params.companyId} and code = any(${codes}) and is_group = false`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));

  const pick = (
    slot: keyof typeof ITEM_ACCOUNT_DEFAULTS,
    override: string | null | undefined,
  ): string | null => {
    if (override !== undefined) return override;
    if (!needed.includes(slot)) return null;
    const code = ITEM_ACCOUNT_DEFAULTS[slot];
    const id = byCode.get(code);
    if (!id) throw new ItemAccountUnresolvedError(code, params.companyId);
    return id;
  };

  const o = params.overrides ?? {};
  return {
    revenueAccountId: pick("revenue", o.revenueAccountId),
    inventoryAccountId: pick("inventory", o.inventoryAccountId),
    cogsAccountId: pick("cogs", o.cogsAccountId),
    expenseAccountId: pick("expense", o.expenseAccountId),
  };
}

export interface ItemRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: ItemKind;
  baseUnitId: string;
  barcode: string | null;
  taxCodeId: string | null;
  revenueAccountId: string | null;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  expenseAccountId: string | null;
  trackLots: boolean;
  shelfLifeDays: number | null;
  archivedAt: string | null;
  createdAt: string;
}
export interface NewItem {
  companyId: string;
  code: string;
  nameEn: string;
  nameAr?: string | null;
  kind: ItemKind;
  baseUnitId: string;
  barcode?: string | null;
  taxCodeId?: string | null;
  trackLots?: boolean;
  shelfLifeDays?: number | null;
  accounts?: ItemAccountOverrides;
  /** 9B — the source system's own material code (0101, §5.1 #8), set once by the cut-over importer. Absent for an
   *  item created through the API, which leaves the column NULL. */
  legacyRef?: string | null;
}

interface DbItem {
  id: string;
  company_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  kind: ItemKind;
  base_unit_id: string;
  barcode: string | null;
  tax_code_id: string | null;
  revenue_account_id: string | null;
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  expense_account_id: string | null;
  track_lots: boolean;
  shelf_life_days: number | null;
  archived_at: string | null;
  created_at: string;
}

const toItem = (r: DbItem): ItemRow => ({
  id: r.id,
  companyId: r.company_id,
  code: r.code,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  kind: r.kind,
  baseUnitId: r.base_unit_id,
  barcode: r.barcode,
  taxCodeId: r.tax_code_id,
  revenueAccountId: r.revenue_account_id,
  inventoryAccountId: r.inventory_account_id,
  cogsAccountId: r.cogs_account_id,
  expenseAccountId: r.expense_account_id,
  trackLots: r.track_lots,
  shelfLifeDays: r.shelf_life_days,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
});

/** `ctx` is taken for the log/enqueue envelope symmetry every §4.3.1 writer has; the acting principal
 *  is always `app.current_actor()` from the session, never a parameter (SAH-044). */
export async function createItem(tx: Sql, ctx: TenantContext, input: NewItem): Promise<ItemRow> {
  await assertItemTaxCode(tx, input.companyId, input.taxCodeId ?? null);
  // `exactOptionalPropertyTypes` is on: an absent override set is omitted, never passed as `undefined`.
  const accounts = await resolveItemAccounts(tx, {
    companyId: input.companyId,
    kind: input.kind,
    ...(input.accounts === undefined ? {} : { overrides: input.accounts }),
  });
  const [row] = await tx<DbItem[]>`
    insert into app.item (tenant_id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
                          revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
                          track_lots, shelf_life_days, tax_code_id, legacy_ref)
    values (${ctx.tenantId}, ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind}, ${input.baseUnitId}, ${input.barcode ?? null},
            ${accounts.revenueAccountId}, ${accounts.inventoryAccountId},
            ${accounts.cogsAccountId}, ${accounts.expenseAccountId},
            ${input.trackLots ?? true}, ${input.shelfLifeDays ?? null}, ${input.taxCodeId ?? null},
            ${input.legacyRef ?? null})
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, tax_code_id, archived_at, created_at`;
  return toItem(row!);
}

export async function getItem(tx: Sql, itemId: string): Promise<ItemRow | null> {
  const [row] = await tx<DbItem[]>`
    select id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
           revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
           track_lots, shelf_life_days, tax_code_id, archived_at, created_at
      from app.item where id = ${itemId}`;
  return row ? toItem(row) : null;
}

/**
 * `code` and `kind` are immutable after create: `code` is the natural key a price list, a legacy_ref
 * and every import batch point at, and `kind` decides whether the item holds stock at all — changing
 * it under existing movements is SAH-007's shape. A rename is `name_en`/`name_ar`.
 */
export async function updateItem(
  tx: Sql,
  itemId: string,
  patch: {
    nameEn?: string;
    nameAr?: string | null;
    barcode?: string | null;
    taxCodeId?: string | null;
    trackLots?: boolean;
    shelfLifeDays?: number | null;
    accounts?: ItemAccountOverrides;
  },
): Promise<ItemRow | null> {
  const current = await getItem(tx, itemId);
  if (!current) return null;
  if (patch.taxCodeId !== undefined)
    await assertItemTaxCode(tx, current.companyId, patch.taxCodeId);
  const accounts = patch.accounts
    ? await resolveItemAccounts(tx, {
        companyId: current.companyId,
        kind: current.kind,
        overrides: patch.accounts,
      })
    : {
        revenueAccountId: current.revenueAccountId,
        inventoryAccountId: current.inventoryAccountId,
        cogsAccountId: current.cogsAccountId,
        expenseAccountId: current.expenseAccountId,
      };
  const [row] = await tx<DbItem[]>`
    update app.item set
      name_en              = ${patch.nameEn ?? current.nameEn},
      name_ar              = ${patch.nameAr === undefined ? current.nameAr : patch.nameAr},
      barcode              = ${patch.barcode === undefined ? current.barcode : patch.barcode},
      track_lots           = ${patch.trackLots ?? current.trackLots},
      shelf_life_days      = ${patch.shelfLifeDays === undefined ? current.shelfLifeDays : patch.shelfLifeDays},
      revenue_account_id   = ${accounts.revenueAccountId},
      inventory_account_id = ${accounts.inventoryAccountId},
      cogs_account_id      = ${accounts.cogsAccountId},
      expense_account_id   = ${accounts.expenseAccountId},
      tax_code_id          = ${patch.taxCodeId === undefined ? current.taxCodeId : patch.taxCodeId}
     where id = ${itemId}
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, tax_code_id, archived_at, created_at`;
  return row ? toItem(row) : null;
}

/** spec:2049 — master data is archived, never deleted. Idempotent: a second call is a no-op. */
export async function archiveItem(tx: Sql, itemId: string): Promise<ItemRow | null> {
  const [row] = await tx<DbItem[]>`
    update app.item set archived_at = coalesce(archived_at, now()) where id = ${itemId}
    returning id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
              revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
              track_lots, shelf_life_days, tax_code_id, archived_at, created_at`;
  return row ? toItem(row) : null;
}

export async function listItems(
  tx: Sql,
  params: {
    companyId: string;
    kind?: ItemKind;
    /** 3A T11 — the two exact-match filters `ItemQuery` declares. Added here rather than applied to the
     *  page in the route: a filter applied after the keyset page has been cut would drop rows from the
     *  middle of the result and still hand the caller a cursor, which is a silently short page. */
    code?: string;
    barcode?: string;
    includeArchived?: boolean;
    cursor?: { code: string } | null;
    limit: number;
  },
): Promise<ItemRow[]> {
  const rows = await tx<DbItem[]>`
    select id, company_id, code, name_en, name_ar, kind, base_unit_id, barcode,
           revenue_account_id, inventory_account_id, cogs_account_id, expense_account_id,
           track_lots, shelf_life_days, tax_code_id, archived_at, created_at
      from app.item
     where company_id = ${params.companyId}
       and (${params.kind ?? null}::text is null or kind = ${params.kind ?? null})
       and (${params.code ?? null}::text is null or code = ${params.code ?? null})
       and (${params.barcode ?? null}::text is null or barcode = ${params.barcode ?? null})
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toItem);
}

/** Only an active effective sales code belonging to this item company may be selected. */
async function assertItemTaxCode(
  tx: Sql,
  companyId: string,
  taxCodeId: string | null,
): Promise<void> {
  if (taxCodeId === null) return;
  const [valid] = await tx<{ id: string }[]>`
    select id from app.tax_code where id = ${taxCodeId} and company_id = ${companyId}
      and archived_at is null and kind <> 'input'
      and effective_from <= current_date and (effective_to is null or effective_to >= current_date)`;
  if (!valid) throw new ItemTaxCodeInvalidError();
}
