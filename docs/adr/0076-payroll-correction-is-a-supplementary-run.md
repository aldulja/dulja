# 0076 — Correction of a posted PAYROLL is a supplementary run, not a `reverseDocument`

- Status: **Proposed** — asked, not decided (spec:95: money semantics). Implemented in 8B Task 4 as the plan's
  default, ahead of approval, under the owner's direction to implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8B · Task 4
- Contracts: round 17, A4

## Context

spec:2081 says "Correction after posting is a reversal plus a supplementary run; nothing is edited in place
(LEGACY-041)". The `PAYROLL` policy must declare a `reversal` block — the schema requires it — and the value decides
which of the two halves of that sentence the system actually offers.

## Decision

`PAYROLL` (`packages/db/seed/my/document-types/PAYROLL.json`) declares
`reversal: { "allowed": false, "producesType": null }`. A posted run is corrected by a `supplementary` run
(`payroll_run.kind = 'supplementary'`) carrying the delta.

Two independent mechanics forbid the reversal path, and either alone is decisive.

1. **The state machine.** `reverseDocument` creates a fresh **draft** mirror and posts it in the same transaction.
   Contracts §4.3.2 step 2 admits a draft only when `draft → issued` is legal, and §4.5.1 makes that legal only when
   the effective policy has `approval.required = false`. PAYROLL's is `true` (spec:2172 R1), so the inner post raises
   `ERR_DOC_STATUS_ILLEGAL` — the tree's recorded limit "no approval-required type can be reversed" (AGENTS.md).
   Setting `approval.required = false` to make reversal work would delete maker ≠ checker for the highest-risk
   document in the system (LEGACY-032); letting the reversal skip the trigger is LEGACY-027.
2. **The extension rows.** `reverseDocument` copies `document_line` columns and knows nothing of `app.payroll_line`.
   Every mirrored payroll line would resolve `line.component.kind` and `line.share` to `null`, match no policy rule,
   plan zero ledger lines for it, and the mirror could not reproduce the original.

## Consequences

- The supplementary run is a first-class `payroll_run.kind` (§4.12.6), not a workaround. The original run's posted
  lines, its `pinned_tables` and its ledger rows are never touched (LEGACY-041; acceptance test 29).
- The half of spec:2081 that says "a reversal" is **not** offered for PAYROLL. If the owner wants it, the cost is
  stated rather than hidden: `reverseDocument` gains a payroll-extension copy step, and the state machine gains a
  rule admitting a reversal of an `approval.required` type straight to `issued` under the *original* document's
  already-granted approval. Both change frozen files (1A's reverse path, 2B's `app.document_status_before`) and
  belong in a contracts amendment, not in this slice.
- A run posted in error in its entirety is corrected by a supplementary run that negates every line; the policy's
  `account`-line debit rule is what posts a negative net pay.
- Nothing about a *draft* changes: a draft or submitted run is recalculated in place (spec:2081, R3).

## Owner question

1. Is "correction is a supplementary run; a PAYROLL is never reversed" accepted, or must the reversal half of
   spec:2081 be built at the cost stated above?

## Amendment — 2026-11-15: "never edited in place" holds for every principal (full review DBS-03)

- Status: **Proposed** — money semantics (spec:95). Implemented in migration `0126` ahead of approval.
- This ADR's premise — a posted run is corrected by a supplementary run, never edited — was enforced only against a
  principal who could see the run's document. Migration `0126` makes it unconditional: a `payroll_line` of a
  non-draft run is refused on INSERT and UPDATE whether or not the caller can read the parent (a status it cannot
  read is a refusal), and `payroll_run`'s period, pay date, kind and `pinned_tables` are frozen once the document
  leaves draft. The supplementary run remains the only correction path; nothing in the posting path writes either
  table after draft. ADR 0074's amendment of the same date carries the policies and the R4 extension.

## Amendment (2026-11-15, full review findings HRP-02, HRP-08, HRP-12, HRP-15)

- Status: **Proposed** (money semantics, spec:95). Implemented ahead of approval in the review's fix branch, with
  migration `0128_guard_payroll_run_corrections.sql`.

The decision above says a supplementary run carries **the delta**, but the run service computed a supplementary run
exactly like a regular one: a correction to a posted January paid the whole of January again (2400 credited a second
1950, `employee_ytd.gross` 4000). What "the delta" means is now built:

1. **A supplementary run's lines are the period's corrected figures less what the period's posted runs already
   carried**, per employee and per line (each earning and deduction component, each scheme's employee and employer
   share, and the net-pay leg). A posted run counts when its period lies inside the supplementary run's; one that only
   partly overlaps it is refused. The corrected figures are computed on the YTD the period started from (the posted
   runs' contributions are taken out of `ytdBefore`), so a YTD-reading scheme does not see the period twice.
   `employee_ytd` moves by the delta, because the projection adds posted lines.
2. **A zero difference writes no line**, and a supplementary run on which an employee has nothing to correct is
   refused (`ERR_VALIDATION_FAILED`, "nothing to correct").
3. **A negative difference — an over-payment, on any line — is refused** (`ERR_VALIDATION_FAILED`, "a negative
   correction … is not posted until the owner decides how it is recovered"). The Consequences above say a run posted
   in error is "corrected by a supplementary run that negates every line", but `payroll_line.amount >= 0` (0087) has
   no signed line, an earning line can only debit its expense account, and `createPayrollPayment` pays no employee
   whose net is not positive — so a debit to 2400 would sit there with no recovery path. That is owner question 2.
4. **A manual override on a supplementary run is the period's figure**; its line carries the difference, and the run
   service adds the posted share back when it reads the override for a recalculation.
5. **A supplementary run cannot post a stale delta.** If another run of an overlapping period that shares one of its
   employees posts after it was calculated (`payroll_run.calculated_at`), posting it raises `ERR_DOC_STATUS_ILLEGAL`
   (0128's `document_supplementary_payroll_current`); returning it to draft and recalculating nets the new run.
6. **One regular run per company and period** (HRP-08): a second `regular` run over an overlapping span that is not
   void is refused by the service and by 0128's trigger under a per-company advisory lock.
7. **R3 widened** (HRP-12): a change to `employee.hired_on` or `terminated_on`, or to `employee_statutory_profile`,
   inside a submitted or approved run's period returns it to draft with reason `employment_changed` or
   `statutory_profile_changed` — the inputs proration and the scheme calculators read. spec:2174 names compensation
   only; this is owner question 3.
8. **An override may create a zero share's line** (HRP-15, spec:2087): a share the calculator computed as zero has no
   line, and the override now creates it when the employee is on the run and one of their components feeds the
   scheme; otherwise the calculator still refuses.

Not covered, recorded: a `regular` or `final` run is not netted, so a regular run posted after a supplementary run of
the same period, or a `final` run over a period a regular run already paid, still pays in full.

### Owner questions (added)

2. How is an over-payment recovered — a deduction from a later pay (an advance-recovery-style component the next run
   carries), or a receivable from the employee? Until that is answered a negative correction is refused, and building
   it needs signed payroll lines (0087's amount check) and a policy rule for a credit to an earning's expense account.
3. Is R3's widening to employment dates and the statutory profile accepted, or should a stale input be caught some
   other way (for example, by re-checking inputs at post)?
