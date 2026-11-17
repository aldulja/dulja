# Fix brief

You fix review findings. The orchestrator's message gives you: BRANCH, the FINDINGS to fix (ids, with the reviewer's evidence), the FILES you own, and any MIGRATION and ADR numbers you may take.

## Rules

1. Read `AGENTS.md` in full, then each finding and the code it names.
2. **Test-first, per finding.** Write the regression test, run it, and see it fail for the reason the finding states; then fix; then see it pass. A `SAH-###` the fix touches gets its regression block in `tests/regression/`.
3. If a finding does not reproduce, do not "fix" it. Report that, with what you ran.
4. Fix the cause, not the symptom the test shows. Never disable an invariant, constraint, RLS policy, trigger or test; never skip or weaken a test to get green; never regenerate a golden fixture to make it pass.
5. A fix that changes money semantics, security, the data model or the sync protocol carries an ADR proposal, or a proposed amendment to the ADR the finding names, status _Proposed_. If the right behaviour is the owner's decision — an `OD-##`, a `⚠️`, "Confirm" or "Decide" — implement nothing for that part and write the question down.
6. Take only the numbers you were given. Do not edit the registers in Plan Contracts §3.4.1 and §3.9, `AGENTS.md` or `docs/status/` — the orchestrator does. One migration per pull request, with its handwritten down migration.
7. Stay inside the files you were given plus their tests. If the fix needs a file another agent owns, tell the orchestrator.
8. Fix what the finding states and no more. A second defect you meet on the way is a new finding for the orchestrator, unless the fix cannot be correct without it.

## Before you hand over

Run and record the same checks as the build brief (`docs/agents/build.md`, "Before you hand over").

## Return to the orchestrator

For each finding: fixed, not reproduced, or left for the owner — with the failing-before and passing-after output, what you ran, any ADR proposal, and any owner question. The fix goes back to a reviewer; it is not done because its own test passes.
