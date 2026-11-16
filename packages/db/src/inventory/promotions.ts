import type { Sql } from "postgres";

// Column lists are inlined here for the same reason as in `prices.ts`: the driver's `unsafe` helper has
// exactly three homes (hazard 21) and this is not one of them.

export type PromotionKind = "percent_off" | "amount_off" | "bundle";

export interface PromotionRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: PromotionKind;
  definition: Record<string, unknown>;
  startsAt: string | null;
  endsAt: string | null;
  branchId: string | null;
  createdAt: string;
}

export async function createPromotion(
  tx: Sql,
  input: {
    companyId: string;
    code: string;
    nameEn: string;
    nameAr?: string | null;
    kind: PromotionKind;
    definition: Record<string, unknown>;
    startsAt?: string | null;
    endsAt?: string | null;
    branchId?: string | null;
  },
): Promise<PromotionRow> {
  // Bind timestamps as text before the cast: postgres.js serializes timestamptz parameters through
  // Date and drops microseconds, which can collapse a valid short window into equal endpoints.
  const [row] = await tx<PromotionRow[]>`
    insert into app.promotion
      (tenant_id, company_id, code, name_en, name_ar, kind, definition, starts_at, ends_at, branch_id)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.kind}, ${tx.json(input.definition as never)}::jsonb, ${input.startsAt ?? null}::text::timestamptz,
            ${input.endsAt ?? null}::text::timestamptz, ${input.branchId ?? null})
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
              branch_id as "branchId", created_at::text as "createdAt"`;
  return row!;
}

export async function updatePromotion(
  tx: Sql,
  promotionId: string,
  patch: {
    nameEn?: string;
    nameAr?: string | null;
    definition?: Record<string, unknown>;
    startsAt?: string | null;
    endsAt?: string | null;
  },
): Promise<PromotionRow | null> {
  // `::jsonb` on the bound parameter: the driver tags a `json()` parameter as `json`, and
  // `coalesce(json, jsonb)` is a type mismatch Postgres refuses outright. The cast is the same one
  // `custom-fields/service.ts` writes for the same reason. `json(null)` binds SQL NULL whatever type it
  // declares, so the `coalesce` still means "leave `definition` alone when the patch omits it".
  const [row] = await tx<PromotionRow[]>`
    update app.promotion set
      name_en    = coalesce(${patch.nameEn ?? null}, name_en),
      name_ar    = case when ${patch.nameAr !== undefined} then ${patch.nameAr ?? null} else name_ar end,
      definition = coalesce(${patch.definition ? tx.json(patch.definition as never) : null}::jsonb, definition),
      starts_at  = case when ${patch.startsAt !== undefined} then ${patch.startsAt ?? null}::text::timestamptz else starts_at end,
      ends_at    = case when ${patch.endsAt !== undefined} then ${patch.endsAt ?? null}::text::timestamptz else ends_at end
    where id = ${promotionId}
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
              branch_id as "branchId", created_at::text as "createdAt"`;
  return row ?? null;
}

/** A promotion is retired by setting `ends_at` — there is no archived_at on this table (§4.6.1). */
export async function listPromotions(
  tx: Sql,
  params: {
    companyId: string;
    branchId?: string | null;
    activeOn?: string;
    cursor?: { code: string } | null;
    limit: number;
  },
): Promise<PromotionRow[]> {
  return tx<PromotionRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           kind, definition, starts_at::text as "startsAt", ends_at::text as "endsAt",
           branch_id as "branchId", created_at::text as "createdAt"
      from app.promotion
     where company_id = ${params.companyId}
       and (${params.branchId ?? null}::uuid is null or branch_id is null or branch_id = ${params.branchId ?? null})
       and (${params.activeOn ?? null}::text::timestamptz is null
            or ((starts_at is null or starts_at <= ${params.activeOn ?? null}::text::timestamptz)
            and (ends_at   is null or ends_at   >= ${params.activeOn ?? null}::text::timestamptz)))
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
}
