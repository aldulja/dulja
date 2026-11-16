// packages/db/src/sync/identity.ts
import type { Sql } from "postgres";
import type { ResolvedPrincipal } from "../with-tenant";

export interface ResolvedEnrolment {
  readonly enrolmentId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
}

/**
 * The pre-tenant door for a one-time enrolment code (contracts §4.1, migration 0060). `app.resolve_enrolment`
 * is SECURITY DEFINER and owned by `app_auth`, so this call needs no `set_config` — which is the whole point:
 * a till presenting a code has no tenant, no principal and no session, and inventing one from the request
 * would be SAH-026 rebuilt.
 */
export async function resolveEnrolment(sql: Sql, codeHash: Buffer): Promise<ResolvedEnrolment[]> {
  return sql<ResolvedEnrolment[]>`
    select enrolment_id as "enrolmentId", tenant_id as "tenantId", company_id as "companyId", branch_id as "branchId"
      from app.resolve_enrolment(${codeHash})`;
}

/**
 * The terminal's own principal, resolved with no tenant set. There is deliberately **no** `app.resolve_terminal`:
 * §4.1 fixes `principal.auth_subject` for a terminal as `'terminal:<terminal_id>'`, so Plan 0A's
 * `app.resolve_principal` already answers this question, and a second SECURITY DEFINER function would be a
 * second door to audit for the same fact.
 */
export async function resolveTerminalPrincipal(
  sql: Sql,
  terminalId: string,
): Promise<ResolvedPrincipal[]> {
  return sql<ResolvedPrincipal[]>`
    select principal_id as "principalId", tenant_id as "tenantId", kind
      from app.resolve_principal(${`terminal:${terminalId}`})`;
}

/**
 * Spends one verified signed `/v1/sync/*` request (PR 12 review, extra finding E1; migration 0060's
 * `terminal_request_guard`). `digest` is the sha256 hex of the canonical signed message, so it names exactly
 * one method, path, timestamp and body; `signedAt` is that message's timestamp. Returns `false` when this
 * terminal has already spent the same message — a captured request replayed inside the clock window — and
 * `true` otherwise, pruning in the same statement every entry older than `2 × windowSeconds`, which the
 * caller's skew check refuses before it gets here.
 *
 * One upsert, so its row lock is the race guard: two copies of one request cannot both claim it, and two
 * different requests both can, in either order. Runs as the terminal, inside the terminal's tenant.
 */
export async function claimSignedRequest(
  tx: Sql,
  input: {
    tenantId: string;
    terminalId: string;
    digest: string;
    signedAt: string;
    windowSeconds: number;
  },
): Promise<boolean> {
  const claimed = await tx`
    insert into app.terminal_request_guard as g (tenant_id, terminal_id, seen)
    values (${input.tenantId}, ${input.terminalId}, jsonb_build_object(${input.digest}::text, ${input.signedAt}::text))
    on conflict (terminal_id) do update
       set seen = (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                     from jsonb_each_text(g.seen) e
                    where e.value::timestamptz > now() - make_interval(secs => ${2 * input.windowSeconds}))
                  || excluded.seen
     where not g.seen ? ${input.digest}::text
    returning g.id`;
  return claimed.length === 1;
}
