import type { Sql } from "postgres";
import type { PeriodReopen } from "./types";

export interface PeriodReopenOptions {
  tenantId: string;
  /** Only reopens with audit_log.seq greater than this. Omitted: every reopen ever recorded. */
  sinceSeq?: number | undefined;
}

/**
 * spec:2179: "`accounting.period.reopen` … requires a reason written to the audit row, and every reopen
 * is reported by the nightly integrity job." A reopen is a fiscal_period UPDATE whose audited before
 * image has status closed or locked and whose after image has status open — there is no other way to
 * change the column, because `audit_row` is an AFTER ROW trigger with no flag to skip (spec:103, 2049).
 *
 * `reason` is read from the after image's `reopen_reason` key (1A's migration 0013, ADR 0023) and is
 * null-safe: a reopen performed by direct SQL without the column set is still reported, with a null
 * reason.
 *
 * `seq::int`: audit_log.seq is bigint, which postgres.js returns as a STRING unless a parser is configured
 * (createDb configures none), and `PeriodReopen.auditSeq` is declared `number`. audit-chain.ts casts the
 * same way for the same reason.
 */
export async function listPeriodReopens(
  tx: Sql,
  opts: PeriodReopenOptions,
): Promise<PeriodReopen[]> {
  const sinceSeq = opts.sinceSeq ?? null;
  const rows = await tx<
    {
      seq: number;
      occurred_at: string;
      actor_id: string;
      row_id: string;
      from_status: string;
      to_status: string;
      reason: string | null;
    }[]
  >`
    select seq::int as seq,
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
           actor_id::text,
           row_id,
           before ->> 'status'        as from_status,
           after  ->> 'status'        as to_status,
           after  ->> 'reopen_reason' as reason
      from app.audit_log
     where tenant_id  = ${opts.tenantId}
       and table_name = 'fiscal_period'
       and action     = 'update'
       and before ->> 'status' in ('closed', 'locked')
       and after  ->> 'status' = 'open'
       and (${sinceSeq}::bigint is null or seq > ${sinceSeq})
     order by seq`;

  return rows.map((row) => ({
    auditSeq: row.seq,
    occurredAt: row.occurred_at,
    actorId: row.actor_id,
    fiscalPeriodId: row.row_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
  }));
}
