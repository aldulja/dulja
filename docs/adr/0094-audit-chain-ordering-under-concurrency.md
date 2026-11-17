# ADR 0094 — Audit chain ordering under concurrency

**Status:** PROPOSED — it changes how the audit trail, a security control, assigns its order, so spec:95
requires the owner's approval; as with ADR 0087 it is implemented in the same PR that found the defect.
**Date:** 2026-11-15
**Deciders:** owner (pending), architect
**Branch:** `claude/fix-audit-chain-order` — a review fix, not a slice. Number and migration (**0125**)
allocated by the 2026-11-15 full review's orchestrator under §3.4.1's proposed tail rule.
**Finding:** DBS-02 (high), `docs/review/findings/db-security-schema.md` on `claude/review-db-security-schema`.
**Supersedes:** nothing. **Amends:** migration 0001 §8's `audit_log.seq` and 0010's `app.audit_chain()`.

## Context

`app.audit_log.seq` was `generated always as identity`, drawn when PostgreSQL formed the row — before the
BEFORE trigger `app.audit_chain()` took the tenant's `tenant-serial:` advisory lock and linked the row to
`order by seq desc limit 1`. Two writers in one tenant could therefore interleave: S1 writes seq 9 and holds the
lock; S2 draws seq 10 and waits; S1 writes seq 11 (prev = h9) and commits; S2 writes seq 10 with prev = h11.
Both verifiers (`verifyChain`, `checkAuditChain`) walk `lag(hash) over (order by seq)`, so the nightly integrity
job and acceptance test 13 report two broken links on untampered data, permanently (the log is immutable). And a
waiter's row had no successor in seq order, so deleting it left the walk clean — the one thing the chain exists
to catch. Any multi-row post beside another writer in the same tenant does this; it was reproduced with two
connections (`packages/db/test/audit.test.ts`, "keeps one unbroken chain when two transactions in a tenant write
at once": `brokenLinks: 2` before, `0` after).

## Decision

1. **The chain position is drawn under the lock.** Migration 0125 drops `seq`'s identity (no row is touched) and
   creates `app.audit_log_chain_seq`, owned by the column and started past the highest stored `seq`.
   `app.audit_chain()` takes the tenant lock, then `new.seq := nextval(…)`, then reads its predecessor and hashes —
   one critical section. A later writer in the tenant gets the lock only after the holder ends, so within a tenant
   seq order = lock order = link order. A supplied `seq` is overwritten, so no inserter can choose a position
   (LEGACY-023's review block proves it).
2. **`seq` stays the chain order; no `chain_no` column.** Every reader — both verifiers, test 13, the audit
   routes and report, the export — already orders by `seq`; a second per-tenant counter would leave them all
   one refactor from walking the wrong order. Numbers stay globally unique across tenants (one sequence), so
   gaps within a tenant remain normal and unreported, as before.
3. **The preimage is unchanged.** `seq` was never hashed, so every row written before 0125 still verifies,
   nothing is rehashed and no trigger — `audit_log_immutable` included — is disabled. Chains that already forked
   in a test database stay forked; they are no longer produced.
4. **An audited write must run under READ COMMITTED.** The predecessor read sees what committed before the lock
   was granted only because each plpgsql statement takes a fresh snapshot under READ COMMITTED. Under REPEATABLE
   READ or SERIALIZABLE the transaction's first snapshot hides the holder's rows and the same fork returns, so
   `app.audit_chain()` now refuses those levels (`ERR_AUDIT_ISOLATION`) instead of forking silently. Nothing in the
   tree uses them; `withTenant` pins READ COMMITTED.

## Why now is free

AGENTS.md: migration 0010's forward-only window is still open — no deployed database holds audit rows anyone
must verify (OD-19/OD-20 are unanswered). This change does not even need that window, since the preimage is
untouched; but the forks it stops are permanent once written, so it should land before the first staging seed.

## Consequences

- The integrity job and test 13 stop reporting false breaks under concurrent load, and deleting any row but the
  tenant's last is detected again as its successor's broken link.
- Writers in one tenant were already serialised by the same lock; this adds one `nextval` inside it.
- Down (`0125.down.sql`) restores 0010's function and the identity column, restarted past the highest `seq`, and
  reopens DBS-02.

## Owner question

Approve decision 4 (refusing audited writes outside READ COMMITTED), or prefer the trigger to tolerate other
levels and accept the fork risk there?
