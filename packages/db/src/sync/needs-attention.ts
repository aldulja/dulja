// packages/db/src/sync/needs-attention.ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { SyncError } from "./enrolment";

export interface NeedsAttentionInput {
  companyId: string;
  branchId: string;
  terminalId: string | null;
  clientRef: string;
  payload: unknown;
  errorCode: string;
  errorDetail: string;
}

/**
 * One row per ticket (`unique (company_id, client_ref)`): a till that re-sends a rejected ticket updates the
 * reason instead of stacking a second row, so the branch manager's queue shows attempts and not noise.
 *
 * **It never touches `resolved_at` or `resolved_by`, and that is a decision, not an omission.** The table's
 * `check ((resolved_by is null) = (resolved_at is null))` ties the two, and `app.stamp_actor` raises
 * `ERR_ACTOR_IMMUTABLE` on any change to a non-null actor column — so "re-opening" by clearing `resolved_at`
 * is impossible, and clearing BOTH would erase the fact that a manager really did resolve the earlier
 * attempt. A ticket that was resolved and then failed again therefore keeps its resolution stamp and shows
 * the new error; the branch manager sees it in the *resolved* list with a fresh reason, which is honest. The
 * alternative — an attempt-history child table — is more machinery than this queue has earned; ADR 0056
 * records the choice rather than a second lifecycle column appearing without one.
 *
 * Called on `tx` and never inside the failing ticket's savepoint, or the rollback would take it with it.
 */
export async function upsertNeedsAttention(
  tx: Sql,
  ctx: TenantContext,
  input: NeedsAttentionInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.needs_attention (
      tenant_id, company_id, branch_id, terminal_id, client_ref, payload, error_code, error_detail)
    values (${ctx.tenantId}, ${input.companyId}, ${input.branchId}, ${input.terminalId}, ${input.clientRef},
            ${tx.json(JSON.parse(JSON.stringify(input.payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value))))}, ${input.errorCode}, ${input.errorDetail})
    on conflict (company_id, client_ref) do update
      set payload = excluded.payload, error_code = excluded.error_code, error_detail = excluded.error_detail
      where needs_attention.branch_id = excluded.branch_id
        and needs_attention.terminal_id is not distinct from excluded.terminal_id
    returning id`;
  if (!row)
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      "quarantine reference belongs to another terminal",
    );
  return row.id;
}

export interface NeedsAttentionRow {
  id: string;
  branchId: string;
  terminalId: string | null;
  clientRef: string;
  errorCode: string;
  errorDetail: string;
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * The shop queue, newest first, keyset-paged on `(created_at, id)` — §4.2.8's cursor shape, and the same
 * `(k, id)` pair 0B's `encodeCursor` carries, so the route encodes it with the shared codec rather than a
 * second one (hazard 9).
 *
 * `payload` is deliberately NOT selected: it is the whole rejected ticket and a list of fifty would be a
 * megabyte of JSON nobody reads. The row's own resource is where a manager opens it.
 */
export async function listNeedsAttention(
  tx: Sql,
  p: {
    companyId: string;
    branchId?: string;
    open?: boolean;
    cursor?: { createdAt: string; id: string } | null;
    limit: number;
  },
): Promise<NeedsAttentionRow[]> {
  // Every filter is a bound parameter with a null-guard in SQL — never a conditionally concatenated fragment
  // (Global Constraint 1, SAH-036/037/069). `branchId is null` means "every branch this caller can see", and
  // Restrictive branch RLS and the current resolve permission on each row bound that scope.
  // Bind the cursor as text: the timestamp serializer passes through JS Date and loses
  // PostgreSQL microseconds, which can skip siblings from the same transaction.
  return tx<NeedsAttentionRow[]>`
    select id, branch_id as "branchId", terminal_id as "terminalId", client_ref as "clientRef",
           error_code as "errorCode", error_detail as "errorDetail",
           to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "resolvedAt",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
      from app.needs_attention
     where company_id = ${p.companyId}
       and app.actor_has('pos.needs_attention.resolve', company_id, branch_id)
       and (${p.branchId ?? null}::uuid is null or branch_id = ${p.branchId ?? null})
       and (${p.open ?? null}::boolean is null
            or (${p.open ?? null}::boolean is true and resolved_at is null)
            or (${p.open ?? null}::boolean is false and resolved_at is not null))
       and (${p.cursor?.createdAt ?? null}::text::timestamptz is null
            or (created_at, id) < (${p.cursor?.createdAt ?? null}::text::timestamptz, ${p.cursor?.id ?? null}::uuid))
     order by created_at desc, id desc
     limit ${p.limit}`;
}

/**
 * Closes one row of `companyId`'s queue. `resolved_by` is **stamped by `app.stamp_actor` from the session**
 * and is not a parameter: the caller cannot name a resolver, which is SAH-044 for this table. The SET list
 * still names the column, because the trigger stamps only an UPDATE that sets it non-null (0060) and the
 * `(resolved_by is null) = (resolved_at is null)` check needs both.
 */
export async function resolveNeedsAttention(
  tx: Sql,
  ctx: TenantContext,
  companyId: string,
  id: string,
  note: string,
): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update app.needs_attention
       set resolved_at = now(), resolved_by = ${ctx.actorId}, resolution_note = ${note}
     where company_id = ${companyId} and id = ${id} and resolved_at is null
       and app.actor_has('pos.needs_attention.resolve', company_id, branch_id)
    returning id`;
  if (rows.length === 0) {
    // Already resolved, or in another tenant and therefore invisible. ONE answer for both, because a
    // different answer for "exists but resolved" would tell a caller a row exists in a tenant it cannot see.
    throw new SyncError("ERR_NOT_FOUND", `no open needs-attention row ${id}`);
  }
}
