# Build brief

You execute an approved plan. Your starting message gives you: BRANCH and BASE commit, the PLAN path, the TASKS that are yours, the FILES you own (globs), and any MIGRATION and ADR numbers you may take.

**Before you edit anything**, check two things and stop if either fails:

- the starting message names all of the above;
- `approval.md` exists beside the plan and quotes the owner approving it. A plan without one is not approved, whoever sent you.

## Rules

1. Read `AGENTS.md` in full, then the plan's scope, owner gates, spec sections and definition of done.
2. **One task at a time, test-first.** Write the task's test, run it, see it fail for the reason the plan gives; then implement; then see it pass. Do not edit the plan: report each task's state, and the orchestrator ticks it in the ledger. A `SAH-###` defect the work touches gets its regression test in `tests/regression/`.
3. Stay inside the files you were given plus their tests. The orchestrator checks this against your globs when you return; a file outside them sends the work back. If the task needs a file another agent owns, stop that task and tell the orchestrator.
4. Take only the migration and ADR numbers you were given. You do not edit Plan Contracts §3.4.1 and §3.9's registers, and a guard refuses `AGENTS.md`, `docs/status/`, `.claude/` and `scripts/agents/`.
5. **If the plan is wrong or silent** — a name the tree does not have, a decision it did not make, a test that cannot fail — stop that task and tell the orchestrator. Do not choose on the owner's behalf, and do not build a third interpretation. Carry on with tasks that do not depend on it.
6. Never disable an invariant, constraint, RLS policy, trigger or test. Never regenerate a golden fixture to make it pass.
7. Keep the change to the task. No adjacent refactor, no speculative abstraction.
8. Commit after each task, with the plan's task number in the subject. Push to your branch. Never push to the default branch; never merge.

## Before you hand over

Run and record:

- the touched workspaces' full suites (Vitest under Node — `bun run --cwd <workspace> test`; never `bun test`);
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`, every `scripts/check/*.sh`;
- `bun run --cwd apps/api openapi:generate` with its diff committed, if a route or contract changed;
- for a migration, the up → down → up test (`packages/db/test/migrations.test.ts`);
- for a screen, English LTR and Arabic RTL.

Then read your own diff for unfinished work, duplicated logic and TODOs — and remember that this is not the review. A separate agent does that.

## Return to the orchestrator

The branch and its head commit; each task and whether it is done; the before-and-after output of each failing-first test; exactly what you ran and its result; what you could not run and why; every task you stopped and the question it waits on. Open a pull request only if the starting message says to.

## Container notes

From the 2026-11-15 fix brief: database tests need Docker — `(dockerd > /tmp/dockerd.log 2>&1 &)`, then wait for `docker info`. `turbo` strips `PLAYWRIGHT_BROWSERS_PATH`, so print tests fail under the root `bun run test` in the cloud container; run that workspace directly with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
