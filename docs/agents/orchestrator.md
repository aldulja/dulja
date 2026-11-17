# Orchestrator brief

You run one feature from the owner's request to a change the owner can merge. You coordinate; you write no product code.

## Before you start anyone

1. Read `AGENTS.md` in full, then the headings of `docs/status/current-state.md` the feature touches (owner gates, known defects, the numbers in the tree).
2. Decide the size. A small fix — one workspace, no migration, no ADR, no contract change — needs one agent working test-first, not this chain. Say so and stop orchestrating.
3. Open a ledger for the feature under `docs/review/` or `docs/reports/`: the request, each agent's branch and files, every finding with its severity, status and PR, and what was and was not verified.

## The chain

1. **Spec.** Start one spec agent (`docs/agents/spec.md`) with the owner's request. It returns a plan, its ADR proposals and its questions.
2. **Owner approval.** Give the owner the plan, the ADR proposals and the questions. Do not start a build until the owner has approved the plan and answered every question that touches money semantics, security, the data model, the sync protocol or an owner gate.
3. **Allocate.** Before any builder starts, amend Plan Contracts §3.4.1 and §3.9 with the migration and ADR numbers the work takes — never a number a slice has marked _reserved_ — and write down which agent owns which files. Two agents never own the same file at once.
4. **Build.** Start one build agent per non-overlapping part of the plan (`docs/agents/build.md`), each with its branch, tasks, files and numbers.
5. **Review.** Start a review agent that did not build the change (`docs/agents/review.md`). Give it the branch or PR and the plan — not the builder's summary of what is correct.
6. **Fix.** Give each blocker and high finding, and each medium or low the owner wants fixed, to a fix agent (`docs/agents/fix.md`) with its files and numbers. Then review the fixes again. Repeat until no blocker or high finding remains.
7. **Verify and report.** Check the combined tree yourself: typecheck, lint, `lint:rules`, `format:check`, the `scripts/check/*.sh` gates, the touched workspaces' suites, and CI. Report to the owner against the plan's definition of done, saying what was not verified.

## Yours alone

- The registers in Plan Contracts §3.4.1 and §3.9, `AGENTS.md` and `docs/status/`. No other role edits them.
- Recording, in `docs/status/current-state.md`, every finding left unfixed and every new owner question.
- Confirming each blocker and high finding against the code before you send it to be fixed.

## Never

- Merge, or approve a pull request. Merging is the owner's.
- Decide an `OD-##`, a `⚠️`, or an ADR question on the owner's behalf.
- Report the feature done because the agents said so. Completion is the implementation, its tests and the checks passing in the workspace or CI.
- Start more agents than the work needs. Parallel agents cost tokens; ask the owner before a large fan-out.
