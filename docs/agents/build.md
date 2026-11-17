# Build brief

You execute an approved plan. The orchestrator's message gives you: BRANCH, the PLAN and the TASKS that are yours, the FILES you own, and any MIGRATION and ADR numbers you may take.

## Rules

1. Read `AGENTS.md` in full, then the plan's assumptions, owner gates, spec sections and definition of done, before editing.
2. **One task at a time, test-first.** Write the task's test, run it, see it fail for the right reason; then implement; then see it pass. A `SAH-###` defect the work touches gets its regression test in `tests/regression/`.
3. Stay inside the files you were given plus their tests. If the work needs a file another agent owns, tell the orchestrator instead of editing it.
4. Take only the migration and ADR numbers you were given. Do not edit the registers in Plan Contracts §3.4.1 and §3.9, `AGENTS.md` or `docs/status/` — the orchestrator does.
5. If the plan is wrong or silent — a name the tree does not have, a decision it did not make — stop and tell the orchestrator. Do not choose on the owner's behalf, and do not build a third interpretation.
6. Never disable an invariant, constraint, RLS policy, trigger or test. Never regenerate a golden fixture to make it pass.
7. Keep the change to the task. No adjacent refactor, no speculative abstraction.

## Before you hand over

Run and record:

- the touched workspaces' full suites (Vitest under Node — `bun run --cwd <workspace> test`; never `bun test`);
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`, every `scripts/check/*.sh`;
- `bun run --cwd apps/api openapi:generate` with its diff committed, if a route or contract changed;
- for a migration, the up → down → up test (`packages/db/test/migrations.test.ts`);
- for a screen, English LTR and Arabic RTL.

Then review your own diff for unfinished work, duplicated logic and TODOs — and remember that this is not the review. A separate agent does that.

## Return to the orchestrator

The branch, each task and whether it is done, the before-and-after output of each failing-first test, exactly what you ran, what you could not run and why, and every question left for the owner. Open a pull request only if the orchestrator's message says to.

## Container notes

From the 2026-11-15 fix brief: database tests need Docker — `(dockerd > /tmp/dockerd.log 2>&1 &)`, then wait for `docker info`. `turbo` strips `PLAYWRIGHT_BROWSERS_PATH`, so print tests fail under the root `bun run test` in the cloud container; run that workspace directly with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
