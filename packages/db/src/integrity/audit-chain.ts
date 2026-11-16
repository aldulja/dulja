import type { Sql } from "postgres";
import { chainHashExpression } from "../audit/verify-chain";
import type { AuditChainResult } from "./types";

/**
 * The nightly chain walk spec:1963 requires and acceptance test 13 asserts: for every row of one
 * tenant's audit_log in seq order, prev_hash must equal the previous row's hash and hash must recompute
 * from the same session-independent input app.audit_chain() uses.
 *
 * The preimage is `chainHashExpression`, the one TypeScript copy of migration 0010's canonicalised
 * formula — restating it here would be the exact divergence 0010's header warns about. `verifyChain`
 * (packages/db/src/audit/verify-chain.ts) composes the same fragment; this function adds the `seq` of the
 * first bad row, which the nightly report needs and a boolean verdict cannot carry.
 *
 * `seq` order is chain order: since migration 0125 (DBS-02, ADR 0094) `app.audit_chain()` draws `seq`
 * after taking the tenant lock, so two writers in one tenant can no longer interleave numbers and links.
 * A gap in `seq` is NOT reported: one sequence serves every tenant and a rolled-back transaction consumes
 * numbers, so gaps are normal. A deleted row surfaces as the BROKEN LINK of its successor, which is the
 * detection the chain exists for.
 *
 * `tenant_id` is passed explicitly even though RLS already restricts the table: it makes
 * audit_log_tenant_seq_idx usable and keeps the formula identical to 0010's.
 */
export async function checkAuditChain(tx: Sql, tenantId: string): Promise<AuditChainResult> {
  const [row] = await tx<
    {
      rows: number;
      broken_links: number;
      bad_hashes: number;
      first_broken_seq: number | null;
    }[]
  >`
    with ordered as (
      select *, lag(hash) over (order by seq) as expected_prev
        from app.audit_log where tenant_id = ${tenantId}
    ), flagged as (
      select seq,
             (prev_hash is distinct from expected_prev) as broken_link,
             (hash <> ${chainHashExpression(tx)})       as bad_hash
        from ordered
    )
    select count(*)::int                                          as rows,
           count(*) filter (where broken_link)::int               as broken_links,
           count(*) filter (where bad_hash)::int                  as bad_hashes,
           (min(seq) filter (where broken_link or bad_hash))::int as first_broken_seq
      from flagged`;

  return {
    rows: row!.rows,
    brokenLinks: row!.broken_links,
    badHashes: row!.bad_hashes,
    firstBrokenSeq: row!.first_broken_seq,
  };
}
