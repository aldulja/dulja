# Dulja

Dulja is a **Windows-only** replacement for Sahlisoft Accounting — decision D1 (spec:116), settled in §3.0 (spec:977) as "Windows only for v1. No macOS, no Linux desktop, no mobile", with macOS, Linux and mobile considered and rejected. `apps/desktop/electron-builder.yml` carries one `win:` target and the two `dist` scripts both pass `--win`; the Linux in this repository is server-side only and is the same section's choice — Cloudflare Containers for the API and workers, Supabase for the database. Version 1 covers Accounting, Inventory, HR & Payroll, and POS. The target is a multi-tenant, auditable system whose financial and security invariants are enforced in the data layer.

## Current phase

**Every v1 phase (0–9) is implemented and none has exited.** No plan follows Phase 9; Phase 10 is deferred (spec:2296). What remains is owner gates, staging, the Windows packaged run and merge review. `docs/status/phase-history.md` holds each phase's full record — what was built, what was verified and on which head, what was not.

- **Latest work — the full review of 2026-11-15/16.** Ten area reviews of `main` found 11 blockers and 36 high findings; fix PRs #19–#45 (27) were merged to `main` on 2026-11-16 at the owner's request, each with failing-first tests. The ledger is `docs/review/2026-11-15-full-review.md`. **`main` has not run CI since that merge**: GitHub Actions stopped starting jobs at about 01:22 UTC on 2026-11-16 ("recent account payments have failed or your spending limit needs to be increased", ledger BASE-02). First owner action: raise the Actions spending limit and let CI run on `main`.
- **Owner-only items the review surfaced:** OPS-01 (the API refuses to boot outside `dev` without `SUPABASE_SERVICE_ROLE_KEY`, which §3.11 withholds from the container), ORCH-01 (Chromium sandbox in production), the pack bootstrap of an API-created company (OD-21), each fix PR's ADR questions, and the OD-24 screens a shop still lacks.
- **`db:rollback` requires an explicit integer target** since PR #43, and `--force-staging` or `--force-production` when `APP_ENV` is that environment.

What stands between each phase and its exit, as its own record states it:

| Phase                 | Record                                   | Open before exit                                                                                              |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0 Foundations         | `docs/review/2026-09-05-phase-0-exit.md` | `bun run test:staging`, the exit-gate suite, needs staging (OD-19, OD-20, OD-21); ADR 0019                    |
| 1 Ledger              | `docs/reports/phase-1.md`                | The PITR drill needs staging (OD-19); OD-24 screen                                                            |
| 2 Documents           | `docs/reports/phase-2.md`                | ADRs 0026, 0027, 0029–0031, 0087; OD-24 screen                                                                |
| 3 Inventory           | `docs/reports/phase-3.md`                | ADRs 0034, 0037–0042; OD-05, OD-06, OD-24 screens                                                             |
| 4 AR/AP               | `docs/reports/phase-4.md`                | ADRs 0044–0048; OD-05, OD-09, OD-24 screens; staging                                                          |
| 5 Tax and e-invoicing | `docs/reports/phase-5.md`                | OD-15 (statutory pack, MyInvois); ADRs 0049–0053; a local exit only                                           |
| 6 POS                 | `docs/reports/phase-6.md`                | OD-11, OD-12, OD-18; ADRs 0054–0064; the Windows packaged run; staging                                        |
| 7 Reporting           | `docs/reports/phase-7.md`                | ADRs 0065–0070 and contracts A2/A11; OD-24 parity, OD-27; staging                                             |
| 8 HR and payroll      | `docs/reports/phase-8.md`                | OD-23 (the parallel run — the first DoD clause is unmet), OD-14, OD-28, OD-24 parity; ADRs 0071–0080; staging |
| 9 Migration           | `docs/reports/phase-9.md`                | OD-17 (no live Sahlisoft byte has been read), OD-16, OD-25, OD-26, OD-27, OD-23; ADRs 0081–0086; staging      |
| Full review           | `docs/review/2026-11-15-full-review.md`  | CI on `main` (BASE-02); ADRs 0089–0097; OPS-01, ORCH-01                                                       |

Every owner-gated half is verified against its local equivalent only — Testcontainers, the container image, `wrangler dev`, synthetic corpora and fixture values — and never against a deployed system, a real payroll, the live legacy database or real statutory rates.

## Current State

The standing records that outlive a phase are in **`docs/status/current-state.md`**, which is part of this section and as binding as this file. Read the matching heading there before you:

- **report a defect** — "Known defects and limits" lists what is recorded and not fixed; do not report those as new, and do not fix one that waits on an owner decision;
- **touch anything an owner gate covers** — "Owner gates still open" has each gate's default, record and what it blocks;
- **rely on or change a security control** — "ADRs awaiting the owner" lists every proposed ADR and every widening or tightening of a Phase 0 control;
- **take a migration or ADR number** — "In the tree" lists the numbers used, unused and reserved; the register itself is Plan Contracts §3.4.1 and §3.9.

The short form of what is open:

- **Owner gates:** OD-04 role names · OD-05 the ⚠️ rows of §3.0.3/§3.0.4 · OD-06 the costing method (AVCO is the default) · OD-08 BOM, consignment, commissions, project costing (not built) · OD-09 post-dated cheques (not built; migration `0051` reserved) · OD-11 cashier alias domain · OD-12 cashier list · OD-14 four HR facts · OD-15 tax-return publication and MyInvois · OD-16 historical POS data · OD-17 the live Sahlisoft database · OD-18 code-signing certificate · OD-19 Supabase · OD-20 Cloudflare · OD-21 owner login, legal name, currency, fiscal year · OD-22 Sentry · OD-23 the payroll parallel run · OD-24 legacy screenshots and an operator walkthrough before any screen · OD-25 cut-over date and `3900` · OD-26 legacy passwords · OD-27 legacy report templates and five Part VII answers · OD-28 statutory layouts (built on defaults). OD-01 and OD-02 are unconfirmed and block nothing. Answered: OD-03 and OD-07 **no**, OD-10 **yes**, OD-13 **build**.
- **ADRs:** most ADRs written since Phase 2 are _Proposed_ and implemented ahead of approval; the list is under "ADRs awaiting the owner". Treat a proposed ADR as the code's current behaviour, not as the owner's decision.
- **One known failure belongs to this build container, not to any phase:** test 15's PDF (`tests/invariants/zero-code-document-type.test.ts`, "prints: a PDF in each direction") loses its hyphens under the container's Chromium.
- Three `tests/invariants` files (`lint-rules`, `logical-properties`, `type-resolution`), the four `tests/lint` files and `tests/golden` need no container and run anywhere.

Keep this file short. A new standing record — a defect left unfixed, a gate, a widening, a number taken — goes into `docs/status/current-state.md` under its heading; only a change to the short form above is edited here.

## Sources of Truth

- `docs/spec/rebuild-spec.md` v1.2 is the product and architecture authority. Start with §0.2, §0.3, and §0.4; then follow §0's reading order.
- `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` version 2026-09-07 freezes cross-slice names, ownership, migration ranges, ADR ranges, and shared interfaces for work after Plan 0A. Read it before any plan.
- The active slice plan supplies executable, checkbox-based tasks and names the exact spec sections required for that slice. Do not treat SQL or test results described inside a plan as proof that the workspace has implemented them. Plans describe the intended implementation and prior design verification. The four phase reports say, per clause, what was proved and at what strength; read them the same way.
- The legacy-system dossier (`sahlisoft-accounting-analysis.md`) is kept out of this public repository; where a document cites it, read the rebuild specification instead. It was evidence about the legacy system, never authority for Dulja's target architecture.
- `docs/review/2026-09-04-dulja-docs-review.md` records the review history and why earlier specification corrections were made.
- `CONTRIBUTING.md` carries the spec's §0.2 and §3.9 verbatim for human contributors.
- `docs/status/current-state.md` and `docs/status/phase-history.md` hold the standing records and the per-phase history this file summarises (ADR 0088, amended 2026-11-17). `docs/agents/` holds the role briefs of the feature workflow below.
- This file is the single agent instruction file. It takes the entry-point role spec §5.2 gives a root `CLAUDE.md`, which ADR 0088 retired; Claude Code reads `AGENTS.md` directly when no `CLAUDE.md` exists (v2.1.277 or later), so do not add one back; if an older Claude Code ever needs one, it holds only an `@AGENTS.md` import (ADR 0088).

Use the `docs/spec/` paths above; do not maintain duplicate copies. When documents disagree, preserve settled decisions in the spec and frozen shared contracts in the plan-contract document. Stop and propose an ADR or contract amendment instead of silently choosing a third interpretation.

## Working on a Slice

1. Confirm the previous slice or phase dependency is green; follow the dependency graph in Plan Contracts §6.3.
2. Read the active plan's assumptions, owner gates, required spec sections, and definition of done before editing.
3. Execute one unchecked task at a time, test-first, and keep changes within that task's stated files and migration/ADR ranges.
4. Add a regression test for every `SAH-###` defect the work touches.
5. Run the root quality checks and the active task's focused tests. Report the slice against its definition of done.
6. Update **Current phase** and **Current State** — this file's short form and the full records in `docs/status/` — only after the slice's implementation and its definition of done are present in this workspace and verified; the slice that closes a phase rewrites **Current phase** (Plan Contracts §3.8) and that phase's entry in `docs/status/phase-history.md`. Recording what is _not_ proven — an open owner gate, a suite CI cannot run, a phase gate still unmet — is always in scope and waits on nothing.

Do not execute all plans at once. Work in phase order; only the parallel branches explicitly listed in Plan Contracts §6.3 may overlap.

## Feature Workflow

A new feature is worked by an **orchestrator** and four roles — **spec, build, review, fix** — each a separate agent with a fresh context and its own brief in `docs/agents/`. This is the shape the 2026-11-15 full review used (an orchestrator, ten reviewers, 27 fix sessions).

```text
owner request → orchestrator → spec → OWNER APPROVES → build → review ⇄ fix → orchestrator verifies → owner merges
```

| Role         | Does                                                                                                       | Never                                                                    | Brief                         |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| Orchestrator | Splits the work, gives each agent its branch, files and numbers, keeps the ledger, reports to the owner    | Writes product code, merges, or decides an owner gate                    | `docs/agents/orchestrator.md` |
| Spec         | Writes the plan: spec sections, owner gates, tasks with their tests, the definition of done, ADR proposals | Writes product code or invents a UI workflow                             | `docs/agents/spec.md`         |
| Build        | Executes the approved plan one task at a time, test-first                                                  | Leaves its files, takes a number it was not given, or reviews its own PR | `docs/agents/build.md`        |
| Review       | Reads the change with fresh eyes and reports findings, each with `file:line`, a failure scenario, severity | Changes product code, or reports a recorded known defect as new          | `docs/agents/review.md`       |
| Fix          | For each finding: a test that fails for the stated reason, then the fix                                    | Skips or weakens a test, or fixes what waits on the owner                | `docs/agents/fix.md`          |

Claude Code picks each role up from `.claude/agents/<role>.md` — start a feature with `claude --agent orchestrator`, or ask for a role by name. Those files hold only the role's name, when to use it, its tool limits (spec cannot run commands; review has no edit tool) and a pointer to its brief. **The brief in `docs/agents/` is the only copy of the instructions**; change the brief, never the pointer.

Rules that hold for every role:

- **The owner approves the plan before any build starts.** Anything touching money semantics, security, the data model or the sync protocol is an ADR proposal the owner answers first; an `OD-##`, `⚠️`, "Confirm" or "Decide" item is never decided by an agent.
- **The reviewer is never the builder.** A review by the agent that wrote the code, or by one handed the builder's conclusions, does not count.
- **Only the orchestrator edits the shared registers:** Plan Contracts §3.4.1 and §3.9 (migration and ADR numbers), `AGENTS.md` and `docs/status/`. It allocates numbers before a builder or fixer starts, and two agents never own the same file at once.
- **Review and fix repeat** until no blocker or high finding remains. A medium or low finding is fixed or recorded under "Known defects and limits" in `docs/status/current-state.md`, never dropped.
- **Nothing is reported done from reading alone.** Each role records what it ran and what it could not run, in the terms of Change Discipline below.
- **Use the fewest agents the work needs.** A small fix — one workspace, no migration, no ADR, no contract change — is one agent working test-first and checking its own diff; it does not need this chain. Parallel builders or fixers are for work whose files do not overlap.

## Commands

Use these root workspace commands:

```powershell
bun install
bun run lint
bun run lint:rules
bun run format:check
bun run typecheck
bun run test
bun run e2e
```

Use Bun 1.4 for dependency management, scripts, builds, the API, and workers. The Vitest suite runs under Node 24 LTS, normally through the root `bun run test` script. Database tests require Docker Desktop with the WSL2 backend and a real PostgreSQL 18 Testcontainer. **The daemon must be serving Linux containers**: a Windows-container daemon cannot run the `postgres` image at all, which is why the five DB-backed workspaces (`packages/db`, `packages/importer`, `apps/api`, `apps/worker`, `tests`) and `bun run e2e` cannot run on the Windows `checks` job; the ubuntu `database` matrix runs the five and the `e2e` job runs `bun run e2e` (`.github/workflows/ci.yml`).

`bun run lint:rules` runs the repository's own rules in `scripts/lint/rules/`; `oxlint` does not cover them and CI runs both. `bun run format:check` is `oxfmt` over everything `.prettierignore` does not exclude — that excludes `docs/` but **not** the root `.md` files, so `AGENTS.md` and `CONTRIBUTING.md` are formatted and must stay formatted.

Database and staging commands:

```powershell
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:rollback
bun run --cwd packages/db db:status
bun run --cwd packages/db db:lint
bun run seed
bun run test:staging
```

`bun run test:staging` is the Phase 0 exit-gate suite. It skips itself unless `STAGING_BASE_URL`, `DATABASE_URL` and `DATABASE_URL_MIGRATOR` are all set (`tests/staging/phase-0-exit.test.ts:9`), so a green run with those unset proves nothing.

Use the command written in the active plan when it is more specific. Never substitute `bun test` for the Node-hosted Vitest contract. The one `bun test` in the tree is additive, not a substitution: `apps/worker`'s `test` script runs `bun test test/health.test.ts` _after_ its Vitest run, and `apps/worker/vitest.config.ts:10` excludes that file so the two never both claim it.

## Planned Architecture

The implementation is one Bun-workspace/Turborepo monorepo:

- `apps/api` — Hono API in a Cloudflare Container.
- `apps/worker` — pg-boss jobs; same container image, separate entry point.
- `apps/edge` — Cloudflare Worker for auth pre-checks, rate limits, routing, and update delivery.
- `apps/backoffice` — React/Vite/TanStack application; `apps/pos` — the till's React/Vite renderer and its Electron main-process code (a SQLite cache and the sync loops).
- `apps/desktop` — Electron main/preload and packaging for `backoffice.exe` and `pos.exe`.
- `packages/domain` — pure TypeScript domain logic; no I/O or framework imports.
- `packages/db` — Drizzle schema, handwritten SQL migrations, seed packs, linter, and database tests.
- `packages/contracts` — Zod schemas, the permission catalogue (`permissions.ts`) and the committed OpenAPI document (`openapi.json`, generated from the API's routes and diffed in CI). The generated client the spec plans does not exist yet; `apps/backoffice` calls the API through a handwritten wrapper.
- `packages/sync`, `packages/ui`, `packages/i18n` — POS sync, shared UI, and English/Arabic localization.
- `packages/importer` — the Sahlisoft importer (Plans 9A and 9B): the legacy Firebird reader, its profiling and reconciliation reports, and the loaders and cut-over reconciliation, run as the `bun run legacy` CLI and, in the worker, as the `admin.import.run` job.
- `infra` — the runtime container image (one image, two entrypoints), `wrangler.jsonc`, and Renovate.
- `tests/regression`, `tests/invariants`, `tests/golden`, `tests/e2e`, `tests/lint`, `tests/staging` — cross-workspace acceptance suites and the Phase 0 exit-gate suite.

All of the above is present.

Dependency direction is enforced: `domain` imports no other workspace package; `db` and `contracts` may import `domain`; `importer` may import `domain`, `db` and `contracts` (it uses the first two), and `apps/worker` imports `importer`; applications import packages, never other applications; `desktop` imports build outputs only.

## Non-Negotiable Rules

Never:

- Write a ledger or inventory-movement row outside the single posting service.
- Represent money with a floating-point type, including TypeScript `number`; use Postgres `numeric(19,4)` and the `Money` domain type.
- Build SQL through string concatenation, issue DDL from application code, or use transaction-mode pooling on port 6543.
- Disable an invariant, constraint, RLS policy, or trigger, even temporarily.
- Make audit writes optional or trust actor/tenant identity supplied by a client.
- Hard-code dependency versions in source files; the lockfile owns versions.
- Invent UI workflows from the specification.

Always:

- Run database access inside a transaction that sets transaction-local `app.tenant_id` and `app.actor_id`.
- Use UUIDv7 identifiers, generated server-side except for the POS ticket `client_ref`; use UTC `timestamptz`, user-entered `effective_date`, singular `snake_case` SQL names, and `camelCase`/`PascalCase` TypeScript names.
- For tenant-scoped tables, apply the full Plan Contracts §3.3 rule: forced RLS, the declared tenant policy, composite tenant foreign keys, migration/down migration, audit and actor triggers where required, and a two-tenant test. Use only the documented exemption sets.
- For endpoints, add Zod validation, OpenAPI, registered permissions, idempotency on unsafe methods, and tenant-isolation coverage. "Registered" is enforced at boot, not merely documented: `assertRouteGates` (`apps/api/src/middleware/require-permission.ts`, called from `apps/api/src/app.ts`) refuses to build the application when a mounted method-and-path carries no permission gate, exempting only a path whose owning module declares `auth: "public"` or declares no permissions, a path no module owns, and a safe-method route marked `membershipOnly()`. RLS bounds the tenant and nothing else, so an endpoint whose gate clears a company (`requirePermission(…, { company: "path:companyId" })`) must pass that company down into every service call it makes; an entity id alone lets a caller authorised for one company reach another's rows inside the same tenant.
- Keep migrations as `NNNN_<verb>_<noun>.sql` plus a handwritten `NNNN.down.sql`; CI must prove up → down → up.
- Keep financial projections rebuildable and verify rebuilds bit-identically.
- Verify every UI screen in English LTR and Arabic RTL before merge.

## Owner Gates and Decisions

- Owner dependencies are authoritative in `docs/spec/rebuild-spec.md` §5.3 and Plan Contracts §2.12. Do not decide items marked `⚠️`, `Confirm`, `Decide`, or `OD-##` on the owner's behalf.
- The local prerequisites are Git, Bun 1.4, Node 24, and Docker Desktop on the WSL2 backend serving Linux containers. OD-01 and OD-02 (the two v1.1 RLS corrections) are built as the spec describes, remain formally unconfirmed, and block nothing. OD-04 (the nine role names) is seeded from the spec's names and still awaits confirmation.
- Decisions affecting money semantics, security, the data model, or the sync protocol require an ADR proposal and owner approval before implementation. Low-risk implementation choices may be recorded in an ADR and executed.
- **Cash rounding at the till uses `app.branch_pos_policy.rounding_increment`; `app.currency.pos_rounding_increment` is display-only.** That is Phase 6's settlement, a proposal in ADR 0059, of the question ADR 0020's second resolution recorded. Migration `0066` creates the branch column with a `0.05` default under a `rounding_increment > 0` check, and `verifyCashRounding` (`packages/db/src/sync/cash-rounding.ts`) falls back to the same `0.05` for a branch with no policy row. `bootstrapCompany` (`packages/db/src/seed/owner.ts:12`) still seeds the base currency on the column defaults of `packages/db/migrations/0005_create_currency_exchange_rate.sql:8`, so the currency column is `0.0100`, and nothing computes with it. **Do not hard-code an increment into the seed**; a shop's increment is its branch policy, set in the back office.
- **Migration 0010's forward-only audit hashing is free only while no database holds audit rows anyone must verify.** Rows written before it do not verify under the canonicalised preimage, and rehashing them needs UPDATE on `app.audit_log`, which `audit_log_immutable` (`packages/db/migrations/0001_foundations.sql:481`) exists to refuse. The window shuts the first time staging is seeded — OD-19 and OD-20 — and after that the same change costs a `hash_version` column or a recorded `seq` cutover, with `packages/db/src/audit/verify-chain.ts` recomputing each row under the formula in force when that row was written.
- Before any UI task, obtain screenshots of the equivalent Sahlisoft screen and a short operator walkthrough. Preserve or improve keyboard speed.

## Change Discipline

- Keep changes scoped to the active task and preserve existing naming and contracts.
- Do not refactor adjacent work or add speculative abstractions.
- Record reusable decisions in `docs/adr/`; amend Plan Contracts before changing a frozen cross-slice contract.
- A branch that is not a slice — a remediation, a review fix, a security patch — has **no migration or ADR range of its own**, and the register's rules are all written for slices. Plan Contracts §3.4.1 now carries a ⚠️ **proposal** for how such a branch allocates a number, and §3.9 applies the same rule to ADRs; it is the owner's to approve or replace, not settled text. Until it is settled: amend the register in the same PR before taking any number, and never take one a slice has marked _reserved_. The phase-0 review branch took 0C's and 0E's reserved `0009` and `0010` plus ADR `0020`, and §3.4.1's "never renumbers" means that cannot now be repaired — the register records the occupants instead.
- Re-pin a golden fixture only through `GOLDEN_WRITE=1` (`tests/package.json`'s `golden:costing`), then review the diff line by line: every changed figure must be an intended formula change (spec:2264, `tests/golden/costing.test.ts`). Never regenerate a fixture to make it pass.
- Never report a phase complete from document review alone. Completion requires the implementation, its stated tests, and the phase gate to pass in the workspace/CI.

## Phase Execution Rule

When the user asks to implement or complete a phase from an implementation plan, the whole phase is one unit of work: carry on from task to task without pausing for confirmation until every task is implemented and verified. Stop early only for a blocker that needs the user's input, an irreversible or destructive action that needs approval, or an external dependency that cannot be resolved.

Before declaring the phase complete:

- Review the original phase checklist.
- Verify every item is implemented.
- Run relevant tests, type checking, linting, and build verification.
- Fix issues introduced by the implementation.
- Review the final diff for incomplete work, unnecessary complexity, duplicated logic, TODOs, and regressions.
