// packages/db/src/reports/ageing.ts
//
// The `accounting.ageing` read function (contracts §4.16.3, 4B amendment 10). 7C replaces the ROUTE's body
// with a ReportDefinition over this same function and re-runs 4B Task 3's tie-out unchanged as the proof that
// nothing moved (§4.16.1's "re-expresses" rule), so this name and this row shape are contract.
//
// It computes FRESH through app.party_ageing_rows and never reads the stored snapshot: a snapshot exists only
// for the dates the job ran, and a report that answered "no snapshot for that date" would be a worse report
// (ADR 0046's last consequence). It pivots the function's rows and adds nothing to them.
import type { Sql } from "postgres";
import type { AgeingBucket } from "../ar-ap/ageing";

export interface AgedBalanceParams {
  companyId: string;
  asOf: string;
  partyId?: string;
  partyKind?: string;
  currency?: string;
  /** Narrows the rows the pivot sees; the other bucket columns of a returned row then read zero. */
  buckets?: readonly AgeingBucket[];
  /** Keyset on `(party_code, currency)`, the report's order. */
  cursor?: { partyCode: string; currency: string } | null;
  limit: number;
}

export interface AgedBalanceRow {
  partyId: string;
  partyCode: string;
  partyNameEn: string;
  partyNameAr: string | null;
  partyKind: string;
  /** The open documents' currency; the five buckets and `total` are in it. */
  currency: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  over_90: string;
  total: string;
  /** In the COMPANY's base currency, at each open document's own rate — never a conversion of `total`. */
  totalBase: string;
}

export async function agedBalance(tx: Sql, params: AgedBalanceParams): Promise<AgedBalanceRow[]> {
  const buckets = params.buckets === undefined ? null : [...params.buckets];
  const cursorCode = params.cursor?.partyCode ?? null;
  const cursorCurrency = params.cursor?.currency ?? null;
  const rows = await tx<
    {
      party_id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      kind: string;
      currency: string;
      b_current: string;
      b_1_30: string;
      b_31_60: string;
      b_61_90: string;
      b_over_90: string;
      total: string;
      total_base: string;
    }[]
  >`
    select g.party_id::text as party_id, p.code, p.name_en, p.name_ar, p.kind, g.currency::text as currency,
           coalesce(sum(g.amount) filter (where g.bucket = 'current'), 0)::numeric(19,4)::text as b_current,
           coalesce(sum(g.amount) filter (where g.bucket = '1_30'),    0)::numeric(19,4)::text as b_1_30,
           coalesce(sum(g.amount) filter (where g.bucket = '31_60'),   0)::numeric(19,4)::text as b_31_60,
           coalesce(sum(g.amount) filter (where g.bucket = '61_90'),   0)::numeric(19,4)::text as b_61_90,
           coalesce(sum(g.amount) filter (where g.bucket = 'over_90'), 0)::numeric(19,4)::text as b_over_90,
           coalesce(sum(g.amount), 0)::numeric(19,4)::text      as total,
           coalesce(sum(g.base_amount), 0)::numeric(19,4)::text as total_base
      from app.party_ageing_rows(${params.companyId}::uuid, ${params.asOf}::date) g
      join app.party p on p.id = g.party_id
     where (${params.partyId ?? null}::uuid is null or g.party_id = ${params.partyId ?? null}::uuid)
       and (${params.partyKind ?? null}::text is null or p.kind = ${params.partyKind ?? null}::text)
       and (${params.currency ?? null}::text is null or g.currency = ${params.currency ?? null}::text)
       and (${buckets}::text[] is null or g.bucket = any(${buckets}::text[]))
       and (${cursorCode}::text is null
            or (p.code, g.currency::text) > (${cursorCode}::text, ${cursorCurrency}::text))
     group by g.party_id, p.code, p.name_en, p.name_ar, p.kind, g.currency
     order by p.code, g.currency
     limit ${params.limit}`;

  return rows.map((r) => ({
    partyId: r.party_id,
    partyCode: r.code,
    partyNameEn: r.name_en,
    partyNameAr: r.name_ar,
    partyKind: r.kind,
    currency: r.currency,
    current: r.b_current,
    d1_30: r.b_1_30,
    d31_60: r.b_31_60,
    d61_90: r.b_61_90,
    over_90: r.b_over_90,
    total: r.total,
    totalBase: r.total_base,
  }));
}
