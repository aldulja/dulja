# ADR 0024 — The ledger-integrity check is four independent read functions and one registry

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 1B

## Context

spec:2246 asks for "a continuous job asserting Σdebit = Σcredit per tenant/period/company and that
projections match a fresh rebuild", spec:1963 for a nightly audit-chain walk, and spec:2179 for every
period reopen to be reported. Later slices add projections: 3A `stock_on_hand`, 3B `stock_valuation`,
4B `party_ageing` and `item_profitability`, 6C the `pos_cashier` snapshot, 8C `employee_ytd`.

## Decision

Four read functions in `packages/db/src/integrity/`, each usable on its own, composed by
`runIntegrityCheck` into one `IntegrityReport`. Projections join through
`registerProjectionCheck({ name, run })` — the same registry shape as `registerReconcilableSource`
(contracts §4.8.3) — so no later slice edits this slice's file. The job never writes to a projection:
it detects and records an incident. SAH-079's root cause is a system that repaired instead of detecting.

The audit-chain half restates no formula: migration 0010 canonicalised the preimage through
`jsonb_build_array`, and its header warns that a recomputation one field out of step reports every row in
the tenant as tampered. `packages/db/src/audit/verify-chain.ts` now exports that expression as a nested
`postgres.js` fragment, `chainHashExpression`, and both `verifyChain` and `checkAuditChain` compose it,
so there is exactly one copy of it in TypeScript.

## Consequences

- A slice adding a projection adds one `registerProjectionCheck` call and nothing else.
- `runIntegrityCheck` is pure read plus one audit insert, so it could run on a read replica except for
  the incident write, which the handler performs on the primary.
- The incident lands in `app.audit_log` with `table_name = 'integrity_incident'`, inside the same
  hash chain as every other write, so an incident record cannot be edited away afterwards.
- A change to the hash preimage is one edit in one file, and the day it needs a `hash_version` column
  (migration 0010's header describes that cutover) both callers move together by construction.

## Open question referred to the contracts document, not decided here

PostgreSQL's `MERGE` can raise a **unique violation (23505)** when two transactions concurrently take
the `when not matched then insert` branch for the *same brand-new* key. §4.3.3's `account_balance`
MERGE has that shape and §4.2.2's `withTenant` retries only `40P01`/`40001`. The warm-key path — two
posts to a key that already exists — takes `when matched then update`, locks the row and is safe, and
that is the path SAH-049 describes. The cold-start race is nevertheless real for the first document
ever posted to an (account, period, currency) from two connections at once. **This ADR proposes no
change** (spec:95 — a money-semantics change is proposed and asked, never implemented first): the
proposal is either to add `23505` to the `withTenant` retry set in contracts §4.2.2, or to have
`postDocument` retry step 12.

1A answered the same question inside the posting service by taking one transaction-scoped advisory lock
per planned balance key, in sorted key order, before the `MERGE` (`packages/db/src/posting/post.ts`
step 12). That closes the race for every post that goes through the posting service, which is every post
there is. `tests/invariants/account-balance-concurrency.test.ts` pins the behaviour so the answer stays
visible, and the referred question is now narrower: whether the retry set should also change, so a
future writer that forgets the lock fails loudly rather than intermittently.
