# Fix role

Entered with `bun scripts/agents/role-guard.ts enter fix`. You fix review findings.

Have at hand, from the ledger: the findings to fix (ids, and the findings file with the evidence), and any migration and ADR numbers allocated.

## Rules

1. Read each finding, its reproduction and the code it names.
2. **Test-first, per finding.** Write the regression test, run it, and see it fail for the reason the finding states; then fix; then see it pass. The review's reproduction is a starting point, not the test: the regression test stays in the tree and must fail only for this defect. A `LEGACY-###` the fix touches gets its regression block in `tests/regression/`.
3. If a finding does not reproduce, do not "fix" it. Record that in the ledger, with what you ran.
4. Fix the cause, not the symptom the test shows. Never disable an invariant, constraint, RLS policy, trigger or test; never skip or weaken a test to get green; never regenerate a golden fixture to make it pass.
5. A fix that changes money semantics, security, the data model or the sync protocol carries an ADR proposal, or a proposed amendment to the ADR the finding names, status _Proposed_. If the right behaviour is the owner's decision — an `OD-##`, a `⚠️`, "Confirm" or "Decide" — implement nothing for that part and write the question in the ledger.
6. Take only the numbers allocated. This role does not edit Plan Contracts §3.4.1 and §3.9's registers or the plan, and the guard refuses `AGENTS.md`, `docs/status/`, `docs/agents/`, `.claude/` and `scripts/agents/`. One migration per pull request, with its handwritten down migration.
7. Fix what the finding states and no more. A second defect you meet on the way is a new finding for the next review round, unless the fix cannot be correct without it.
8. One commit per finding, with the finding id in the subject. Push to the feature's branch. Never push to the default branch; never merge.

## Before you leave the role

Run and record the same checks as the build role (`docs/agents/build.md`, "Before you leave the role"). Record in the ledger, for each finding: fixed, not reproduced, or left for the owner — with the commit and the failing-before and passing-after output.

A fix is not done because its own test passes: it goes back to review.
