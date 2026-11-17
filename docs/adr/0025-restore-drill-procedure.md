# ADR 0025 — The restore drill is two phases and one shared verdict; the local equivalent is a snapshot, not a WAL replay

**Status:** accepted, with one proposal referred to the owner · **Date:** 2026-09-19 · **Slice:** 1B

## Context

spec:2233 asks for "RPO/RTO stated as numbers, tested quarterly by an actual restore drill (LEGACY-081)"
and spec:2234 for restore "verified automatically, not assumed". Acceptance test 24 (spec:2442) fixes
what verification means: the trial balance from the restored ledger equals the one the live system
reported at that timestamp, and the audit chain verifies to that point. The Phase 1 definition of done
(spec:2287) requires the first drill to have run against staging and been written up.

Two facts shape the design. PITR on staging depends on OD-19, which is unanswered — so the drill cannot
be written as staging-only or Phase 1 cannot close. And whether a platform restores *beside* the live
database or *in place of* it is a property of the platform; a drill that assumes either is asserting a
vendor fact from memory, which is the same defect as inventing an endpoint.

## Decision

**Two phases, one verdict.** `captureDrillPoint` records, at the recovery target, the trial-balance
fingerprint, the `ledger_entry` count and the audit head. `verifyRestore` reads only the restored
database and compares. The phases are separated by a JSON artifact, so they may run minutes or hours
apart, on different machines, against databases that never coexist.

**The verdict is one function in both modes.** `formatDrillVerdict` prints the same five lines locally
and on staging; only the way the restored database is obtained differs. Staging adds no assertion.

**"Computed from the restored ledger" is proved by pairing two checks.** The fingerprint reads
`account_balance`; `checkAccountBalanceProjection` rebuilds that projection from the restored
`ledger_entry` and compares row for row. Both green is strictly stronger than re-aggregating the ledger
in the report would be: a restore that kept balances but lost ledger rows fails the second check, and
the report keeps its production shape (spec:1204 — the trial balance reads the synchronous projection,
and a report that quietly recomputed would hide the drift the integrity job exists to find).

**The local equivalent is a `pg_dump` snapshot restored into a second database.** It is not a WAL
replay and does not exercise `archive_command`, WAL retention or the platform's recovery-target
machinery. It exercises every assertion, every command in the runbook and the whole verdict path. What
only staging can prove is that the WAL is there and that the platform can land on an arbitrary target —
which is precisely the half OD-19 gates. The drill is green in CI from the day this slice merges and
gains that half the day the owner answers.

**No click path is written down.** The runbook records which control was used on the day, in its drill
log. A stale click path in a runbook is worse than none.

## Consequences

- CI runs test 24 on every push, in local mode, in about a minute — on a runner that can start the
  Postgres container. The Windows-only CI this repository runs today cannot, so this is one more suite
  behind the same gap `CLAUDE.md` records.
- The quarterly re-run (contracts §6.1) is Steps 1–4 of the runbook and produces one drill-log row.
- `checkAccountBalanceProjection` is now load-bearing for two acceptance tests, 2 and 24. A change to
  its comparison key changes what a restore is allowed to be.
- The drill writes to no database. Its only output is the capture file; the projection check it runs is a
  single read statement — LEGACY-081's second half was a restore procedure that overwrote the live system.

## Proposal referred to the owner, not decided here

spec:2233 wants RPO and RTO **as numbers**, and the numbers are a billing decision (retention window
and plan tier) tied to OD-19, not an engineering one. This ADR proposes **RPO ≤ 5 minutes** and
**RTO ≤ 4 hours** for staging and production as the targets the drill log is read against, and records
that they are unconfirmed. The drill *measures* both on every run regardless, so the first three drill
rows will say whether the proposal is achievable before anyone commits to it. The published SLA with
credits stays deferred (spec:2234). Nothing in the code depends on either number.
