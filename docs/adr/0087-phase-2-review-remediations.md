# ADR 0087 — Phase 2 review remediations

**Status:** PROPOSED — several of these decisions touch security and the data model, so spec:95 requires
them to be asked; as with ADR 0020 they were implemented in the same PR they were found in, and this record
says so rather than pretending the order was the other way round.
**Date:** 2026-09-19
**Deciders:** owner (pending), architect
**Branch:** the Phase 2 review pass on `claude/fervent-wright-2t2v3b` (PR #5) — not a slice. **Number
allocated from the §3.9 tail** under §3.4.1's proposed rule for a branch that is not a slice; the register
row is in Plan Contracts §3.9. **Migrations:** 0105–0108, allocated the same way (§3.4.1).
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

A code review of the Phase 2 diff (2A–2C) found fifteen defects, and a second pass over the Phase 0 and
Phase 1 code it leans on found sixteen more — all in code whose database-backed tests have never run (no
Docker daemon on the machine every phase since 0 was built on; see `docs/reports/phase-2.md`). Most were
fixed in code alone. Seven needed a decision that a later reader should find here rather than in a commit
message, because each one either widens or narrows something an earlier ADR settled.

## Decisions

**1. The system writes its own audit rows through one SECURITY DEFINER door, never by grant** (migration
0105). 1B's integrity-incident and month-end rows were inserted straight into `app.audit_log` as `app_rw`,
which 0001 §8 revokes INSERT on — so the nightly alarm failed before it reached Sentry. The grant is not
widened: 0010's chain canonicalisation depends on application code being unable to write `audit_log`
directly. `app.record_system_event(p_table, p_row_id, p_after)` admits exactly two `table_name` values,
takes the tenant from the session and never from a parameter, and lets `app.audit_chain()` hash the row.
The worker raises the incident before it writes the row, so a failed write can never suppress the alarm.

**2. A pinned posting-policy version is immutable in the database, and the seed refuses to rewrite one**
(migration 0106). Contracts §3.4.8 says a seeded policy version is `do update` so a staging placeholder
does not survive the real definition; ADR 0027 says a version is append-only through the API; and
`document.posting_policy_id` is the pin LEGACY-013 relies on. All three hold at once: a version nothing has
posted under may still be replaced (the placeholder case); one a document or ledger entry pins cannot
change by any path, and the seed says "bump `policyVersion`" instead of failing on the trigger.

**3. A closed period is immutable in more than its status; a ledger entry fits its period** (migration
0107). `fiscal_period` never changes company, its dates change only while open and never around ledger
entries it holds, and `closed|locked → open` needs a reason whatever path writes it (spec:2179 R8 was
enforced by the API alone). `ledger_entry` rows must name a period of their own company that contains their
`effective_date`. `currency.pos_rounding_increment` gains `> 0`, and the contract refuses `0.0000`.

**4. An assignment names a member of the tenant, in the schema** (migration 0108). `role_assignment` and
`pos_terminal` reference `membership(tenant_id, principal_id)`, not the global `principal`, and
`assert_assignment_kind()` raises on a principal RLS hides instead of passing on a NULL comparison.

**5. `attributed_to` is a terminal's alone.** spec:1324 confines it to the POS shape — a terminal acts, the
PIN-verified supervisor is attributed (6C). A human or system caller who names another principal on an
override or a transition is refused with 400; they ARE the second principal. Before this, any tenant member
could record an override "by" any principal who held the code.

**6. Every id a body carries is bound to the path's company before it is written.** Parties' settlement
accounts, a document's party, role assignments' branch ids, custom-field definitions' document type and
dimension type, custom-field values' entity, dimension values' parent — each had a tenant-composite key
(or none) and was accepted from a sibling company. The posting service re-validates every planned account at
post time too, so an account archived between draft and post is refused, and `loadSnapshot` reads only this
company's custom-field values. `MODULE_READ_CODE` is one map, evaluated at the owning document's branch by
the attachment, print and events gates alike.

**7. A route that writes nothing may be gated by a read code, on one kind of evidence.** `markWriteFreeGate`
admits a read code on an unsafe method only for a route `REPLAY_BY_RERUN` also declares write-free, and
such a route runs outside the idempotency layer's request-spanning transaction. Both widen Phase 0 controls
(`assertRouteGates`, the one-transaction idempotency design) and are the part of this ADR most in need of the
owner's eye.

## Consequences

- Migrations 0105–0108 apply after 0027 in version order and depend on nothing later than 0013. Each has a
  hand-written down file; `packages/db/test/review-guards.test.ts` pins every guard.
- The alarm path of ADR 0024 is now reachable in production; its tests run under `app_rw` and had asserted
  the row while the grant made it impossible.
- Two amendments to Plan Contracts ride with this ADR: the §3.4.1 and §3.9 register rows for a non-slice
  branch (the first use of the proposed tail rule), and §3.4.8's `do update` sentence, which now reads
  "unless a posted document pins the version".
- Nothing here has been observed to pass against Postgres. The four migrations, the guards and every
  route change are typechecked and linted; the database-free suites are green; the rest waits on a runner.
