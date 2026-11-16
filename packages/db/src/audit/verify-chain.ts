import type { Sql } from "postgres";

export interface ChainResult {
  rows: number;
  brokenLinks: number;
  badHashes: number;
}

/**
 * Migration 0010's preimage, as a nested postgres.js fragment rather than a string repeated per call site.
 * 0010's own header says this expression "has to move with it, field for field and in this order; one
 * divergence and the nightly walk reports every row as a bad hash" — so there is exactly one copy of it in
 * TypeScript, and `checkAuditChain` (packages/db/src/integrity/audit-chain.ts) composes this same fragment
 * instead of restating it. It reads the unqualified column names of `app.audit_log`, so every caller must
 * select the row's own columns into scope (`select *` from the table, or from a CTE over it).
 */
export const chainHashExpression = (tx: Sql) =>
  tx`sha256(coalesce(prev_hash, ''::bytea) || convert_to(
       jsonb_build_array(tenant_id, actor_id, extract(epoch from occurred_at)::text, table_name,
                         row_id, action, before, after)::text, 'UTF8'))`;

/**
 * The recomputation half of the chain. It walks `seq` order, which is the order links were made in only
 * because `app.audit_chain()` draws `seq` under the tenant lock (migration 0125, DBS-02, ADR 0094); before
 * that, two concurrent writers in one tenant forked the chain and this walk reported clean rows as broken. Its preimage is `app.audit_chain()`'s, field for field and in that order —
 * migration 0010 canonicalised both at once, and a single field out of step here reports every row in the tenant
 * as tampered. `packages/db/test/audit.test.ts` runs this function over rows the trigger wrote, so the two cannot
 * drift apart silently.
 */
export async function verifyChain(tx: Sql, tenantId: string): Promise<ChainResult> {
  const [row] = await tx<{ rows: number; broken_links: number; bad_hashes: number }[]>`
    with ordered as (
      select *, lag(hash) over (order by seq) as expected_prev
        from app.audit_log where tenant_id = ${tenantId})
    select count(*)::int as rows,
           count(*) filter (where prev_hash is distinct from expected_prev)::int as broken_links,
           count(*) filter (where hash <> ${chainHashExpression(tx)})::int as bad_hashes
      from ordered`;
  return { rows: row!.rows, brokenLinks: row!.broken_links, badHashes: row!.bad_hashes };
}
