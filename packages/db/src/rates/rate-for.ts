import { currency, UNIT_RATE, type ExchangeRate } from "@dulja/domain";
import type { Sql } from "postgres";

export async function rateFor(
  tx: Sql,
  companyId: string,
  from: string,
  to: string,
  on: string,
): Promise<ExchangeRate | null> {
  if (from === to) return UNIT_RATE(currency(from));
  const rows = await tx<
    { rate: string; effective_from: string; source: string }[]
  >`select r.rate::text as rate, r.effective_from::text as effective_from, r.source from app.rate_for(${companyId}, ${from}, ${to}, ${on}) as r where r.id is not null`;
  const row = rows[0];
  return row
    ? {
        from: currency(from),
        to: currency(to),
        rate: row.rate,
        effectiveFrom: row.effective_from,
        source: row.source,
      }
    : null;
}
