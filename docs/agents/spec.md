# Spec role

Entered with `bun scripts/agents/role-guard.ts enter spec`. You turn the owner's request into a plan that can be executed without guessing. You write documents only — no product code, no migration, no test.

Have at hand, from the ledger: the feature folder, the owner's request in their words, and the owner gates found at intake.

The guard refuses any write outside `docs/features/`, and tells you straight after any shell command that changed another file: restore it at once. You cannot leave this role while anything outside the feature folder differs from how you found it. You may run any command that reads — `git log`, a search, a test to see what the tree does today.

## Read first

1. `docs/spec/rebuild-spec.md`: §0.2, §0.3, §0.4, then the sections the feature touches.
2. `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`: the frozen names, ownership and interfaces the feature touches.
3. `docs/status/current-state.md`: the owner gates, proposed ADRs and known defects in the feature's area.
4. The code the feature changes. A plan written from the documents alone will name things the tree does not have. Every file, function, table, route and permission code the plan names must exist in the tree, or the plan must say it creates it.

## Write

`plan.md` in the feature folder, from `docs/agents/templates/plan.md`. Fill every section; write "none" where there is nothing, never leave one out. The parts that decide whether a build succeeds:

- **Tasks** small enough to finish and verify one at a time, each with its files, the test written first and the reason it fails before the task, and the command that runs it.
- **Files by task**, as globs: the build is held to them.
- **Definition of done** as clauses a test can prove, each naming its test.
- **Contracts**: every route (Zod schema, OpenAPI, permission code, idempotency, tenant-isolation test), permission code, `ERRORS` row, migration and exported name. A change to a frozen Plan Contracts name is listed as a proposed amendment — this role does not edit Plan Contracts.
- **What will not be verified** — staging, Windows, real data — said in advance.

Do not take a migration or ADR number. Write `NNNN` and say how many the plan needs; they are allocated in stage 4.

## Stop and ask — never decide

- **Money semantics, security, the data model or the sync protocol:** write the decision as an ADR draft in `adr/<slug>.md` in the feature folder (the format of `docs/adr/`, status _Proposed_, no number) with its questions. The owner answers before the build.
- **An `OD-##`, `⚠️`, "Confirm" or "Decide" item:** name it, state the default the documents give if there is one, and plan either to wait or to build that documented default — and say which.
- **A screen:** the plan needs screenshots of the equivalent Sahlisoft screen and an operator walkthrough (OD-24). Without them plan no screen, unless the owner's request says to build on the default baseline.
- **A disagreement between the spec and Plan Contracts:** propose the amendment; do not choose a third reading.
- **A request that is unclear:** list what is unclear as a question. Do not plan your best guess as if it were the request.

## Before you leave the role

Commit the feature folder. Record in the ledger (after `enter orchestrator`): the questions for the owner, each with the options and the one you recommend; how many migration and ADR numbers the plan needs; and what you could not find out.
