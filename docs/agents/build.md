# Build role

Entered with `bun scripts/agents/role-guard.ts enter build`. You execute an approved plan.

**Before you edit anything**, check that `approval.md` exists beside the plan and quotes the owner approving it. A plan without one is not approved; go back to the orchestrator role and stage 3.

Have at hand, from the ledger: the branch and base commit, the plan, and the migration and ADR numbers allocated to it.

## Rules

1. Read the plan's scope, owner gates, spec sections and definition of done.
2. **One task at a time, test-first.** Write the task's test, run it, see it fail for the reason the plan gives; then implement; then see it pass. Keep the failing and the passing output: the ledger needs both. A `SAH-###` defect the work touches gets its regression test in `tests/regression/`.
3. Stay inside the files the plan names plus their tests. Stage 5's `verify` holds the build to them.
4. Take only the migration and ADR numbers allocated. This role does not edit Plan Contracts §3.4.1 and §3.9's registers or the plan, and the guard refuses `AGENTS.md`, `docs/status/`, `docs/agents/`, `.claude/` and `scripts/agents/`.
5. **If the plan is wrong or silent** — a name the tree does not have, a decision it did not make, a test that cannot fail — stop that task and take it back to spec (the orchestrator brief's "Going backwards"). Do not choose on the owner's behalf, and do not build a third interpretation. Carry on with tasks that do not depend on it.
6. Never disable an invariant, constraint, RLS policy, trigger or test. Never regenerate a golden fixture to make it pass.
7. Keep the change to the task. No adjacent refactor, no speculative abstraction.
8. Commit after each task, with the plan's task number in the subject. Push to the feature's branch. Never push to the default branch; never merge.

## Before you leave the role

Run and record:

- the touched workspaces' full suites (Vitest under Node — `bun run --cwd <workspace> test`; never `bun test`);
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`, every `scripts/check/*.sh`;
- `bun run --cwd apps/api openapi:generate` with its diff committed, if a route or contract changed;
- for a migration, the up → down → up test (`packages/db/test/migrations.test.ts`);
- for a screen, English LTR and Arabic RTL.

Then read your own diff for unfinished work, duplicated logic and TODOs. This is not the review; that is the next stage.

## Container notes

From the 2026-11-15 fix brief: database tests need Docker — `(dockerd > /tmp/dockerd.log 2>&1 &)`, then wait for `docker info`. `turbo` strips `PLAYWRIGHT_BROWSERS_PATH`, so print tests fail under the root `bun run test` in the cloud container; run that workspace directly with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.
