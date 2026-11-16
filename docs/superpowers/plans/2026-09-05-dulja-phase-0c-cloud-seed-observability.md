# Dulja Phase 0 — Plan 0C: Cloud — Supabase, Cloudflare Containers, bootstrap seed, observability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the system Plan 0B and Plan 0D built onto real infrastructure and give it its first tenant. This slice provisions Supabase (production and staging) and proves the role posture from a script; builds one container image with two entrypoints and the Cloudflare Worker that fronts it; deploys to staging from GitHub Actions in one command; ships `bun run seed` — the offline, idempotent bootstrap CLI of spec §3.8 that creates a tenant, a system principal, the owner, the first company, the nine roles and the Malaysia seed pack; and wires OpenTelemetry and Sentry so one request is visible end to end with its tenant and actor attached. It closes §5.0 rows **0.2**, **0.5**, **0.7b** and **0.14**, and the Phase 0 definition-of-done clause "A tenant is created".

**Architecture:** Four seams, none of which invents application logic. **`infra/`** holds one `Dockerfile` (the `api` and `worker` container classes are the same image with a different entrypoint — spec:1155), `wrangler.jsonc`, and Renovate. **`apps/edge`** is a Cloudflare Worker: it pre-checks the JWT, adds `RateLimit-*` headers, forwards `/v1/*` to the container through the container binding (`getContainer(env.API, "api")` — the container has **no public ingress**, which is the answer to "how does the Worker authenticate to the container"; the container still re-verifies every token itself), serves the electron-builder update feed from R2, and carries the Cron Trigger that keeps `worker` awake. **`packages/db/src/seed/`** is the bootstrap: a pure `bootstrap(sql, config, authAdmin)` over an injected `postgres.js` connection, driven by `packages/db/src/cli.ts seed`, applying per-tenant rows that a migration cannot write because `FORCE ROW LEVEL SECURITY` binds `app_migrator` too (spec:1366). **Observability** is one `request_id` / `trace_id` travelling W3C `traceparent` from the Worker into the container and down onto every Postgres statement, plus Sentry in `apps/api` and `apps/worker`.

**Tech Stack:** Bun 1.4 (install, scripts, both container entrypoints) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (Supabase in the cloud; `postgres:18` in Testcontainers) · Cloudflare Containers + Workers + R2 (`wrangler`, `@cloudflare/containers`) · Docker (the container image) · `postgres` (postgres.js) · `@supabase/supabase-js` (the seed CLI's admin client only) · OpenTelemetry (`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`) · Sentry (`@sentry/node`) · Vitest + Testcontainers · GitHub Actions · Renovate · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2. Sections this plan implements: §3.0 (the confirmed deployment decisions table, spec:971–987), §3.2 (the stack, §3.2.1 the Cloudflare resolution, §3.2.2 the stack table, §3.2.4 container topology — spec:1080–1162), §3.8 (roles and connections header spec:1366; the six-step bootstrap sequence and the MFA note spec:1996–2004), §3.9 (Logging spec:2063; Naming, Identifiers, Time, Database access), §4.2 (identity — the "principal is created only from a Supabase-obtained `sub`" rule, spec:2132), §4.2.1 (the nine-role table, spec:2152–2166), §4.3 (bootstrap is the offline CLI, never an endpoint — spec:2188), §4.8 (reliability and operations — PITR, restore verified not assumed, spec:2231–2239), §4.9 (observability, spec:2241–2247), §4.11 (environments and secrets, spec:2272–2273), §5.0 rows 0.2, 0.5, 0.7, 0.7b, 0.14 (spec:2311–2324), §5.2 (`apps/edge`, `infra/`, `packages/db/seed/`), §5.3 rows "Before 0.2" through "0.14". Companion: `docs/spec/legacy-system-analysis.md`.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 0C — Cloud: Supabase, Cloudflare Containers, bootstrap seed, observability. **Phase:** 0. **Phase gate:** this plan starts only when **0B** is merged (Tasks 1–5, 13, 14 need nothing else) and **0D** is merged for the seed tasks (Tasks 6–12 consume `packages/db/seed/roles.ts` and `pgboss.tenant_registry`). Phase 0 has no predecessor phase, so there is no earlier DoD to gate on (spec:87). Execution order for Phase 0 is **0B → 0D → 0C → 0E** (§2.1, §6.3).
- **Depends on (merged):** Plan 0A — `startDb`, `Db`, `Role`, `MIGRATIONS_DIR`, `ROLES_SQL`, `withTenant` (the **4-argument test** helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `lintSchema`, `up`, `down`, `listApplied`, `discover`, `packages/db/provision/roles.sql`, `packages/db/src/cli.ts`, `app.resolve_principal`, `app.actor_has`, `app.current_tenant`, `app.current_actor`, `app.audit_row`, `app.stamp_actor`, `app_meta.schema_migration`, `.github/workflows/ci.yml` (job `checks`). Plan 0B — `createDb`, `PoolerUrlError`, the **production** `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `resolvePrincipal`, the `@dulja/db/test` subpath export, `@dulja/contracts` (`errors.ts`, `permissions.ts`, `common.ts`, `logger.ts`), `createLogger`, `Logger`, `AppEnv`, `RequestContext`, `createApp`, `AppDeps`, `readConfig`, `ConfigError`, `ROUTES`, `RouteModule`, `apps/api/src/index.ts`, `apps/api/src/middleware/request-id.ts`, `startApi`/`ApiRequest`/`StartedApi`, `AAL1_PATHS`, `GET /v1/session`, `GET /v1/companies`, the root `tests/` workspace with `tests/support/regression.ts` (`sharedDb`, `thinRegression`) and `tests/invariants/probes.ts`, `scripts/lint/` with `bun run lint:rules`. Plan 0D — `packages/db/seed/roles.ts` (`ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS`, `ADMIN_EXCLUDED_CODES`, `ADMIN_EXCLUDED_PREFIXES`, `adminPermissions`), migration `0004_create_pgboss_schema.sql` with `pgboss.tenant_registry`, `JOBS`, `JOB_NAMES`, `createJobClient`, `eachTenant`, `apps/worker` with `src/index.ts`, `src/install.ts` (`jobs:install`), `src/boss.ts`, `src/handler.ts`, `src/log.ts`.
- **Migration numbers:** **0009 — reserved, and this plan writes no migration file.** Everything 0C creates per tenant is seed-pack data, which a migration cannot write (§3.4.8, hazard 10). **ADR numbers:** 0011–0015 — **0011** container topology as built, **0012** seed-pack format, **0013** observability (OTel + Sentry wiring); 0014 and 0015 left unused.
- **Interfaces consumed:** §4.1 (the whole Plan 0A produced surface, in particular `provision/roles.sql`, the `principal`/`membership`/`company`/`role`/`role_assignment`/`fiscal_period`/`account`/`dimension_type`/`dimension_value` DDL and the `principal_insert` policy), §4.2.2 (`createDb`, production `withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`Logger`, `AppEnv`, middleware order), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError` — 0C raises the already-registered `ERR_VALIDATION_FAILED` and **adds exactly one code, `ERR_RATE_LIMITED` (429, raised by the edge Worker, Task 3)**; §4.2.4's allocated table already carries that row — contracts §4.18 round 1 folded it in, and **Task 1 Step 0** greps to confirm it before Task 3 raises the code; the `ERRORS` row itself lands in Task 3 — hazard 32), §4.2.5 (`PERMISSIONS`/`PERMISSION` read from the DB, `RoleSeed`, `ROLES`, `INCOMPATIBLE_PAIRS`, `adminPermissions`), §4.2.6 (`JOBS`, `JOB_NAMES`, `pgboss.tenant_registry`, `eachTenant`, the `jobs:install` deploy step), §4.2.7 (`ROUTES`, `RouteModule`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §3.4.8 (migrations vs seed packs; the `--only` sub-pack rule), §3.6.4 (the per-tenant role applier), §3.11 (every environment and secret name).
- **Interfaces produced:** the §2.1 0C card verbatim — `packages/db/provision/verify-supabase.ts`, `infra/` (Dockerfile, `wrangler.jsonc`, Renovate), `apps/edge`, the staging deploy workflow, `bun run seed` (`packages/db/src/cli.ts seed`, the `--only <sub-pack>` flag of §3.4.8, the `chart-of-accounts`, `dimensions`, `fiscal-periods` and `roles` loaders), `packages/db/seed/my/chart-of-accounts/0c-base.json` (§4.15's eleven 0C leaf rows), the per-tenant role-grant applier (§3.6.4), and the observability wiring of spec:2324.
- **Contracts amendment (hazard 32, §4.2.4's "amends this table first") — already folded in; Task 1 Step 0 is the *verification* that it is:** every name this slice introduces into a frozen register was folded into `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` by **§4.18 "Amendments from written plans", round 1**, which records each of them against slice 0C: §2.12 (OD-04's 0C column), §3.1 (the two new sub-pack directories, `infra` in the root `workspaces` array and in the workspace table), §3.4.8 (the Phase 0 loader names), §2.1 + §3.9 (ADR 0013 = observability), §3.11 (`OTEL_EXPORTER_OTLP_ENDPOINT`), §4.2.2 (`DbOptions.debug`), §4.2.12 (the `"./seed"` and `"./provision/verify-supabase"` subpath exports), §4.2.3 (the middleware order gains `otel` in front), §4.2.4 (`ERR_RATE_LIMITED`), §4.15 (`isGroup?: boolean` in the declared file shape). **Task 1 Step 0 greps for all fourteen strings and must find every one** (§3.1 contributes three of them and §4.2.4 two); it amends only what has drifted, and commits only if it changed something. The full list is Self-Review §5.
- **Owner decisions (one isolated task each):** **OD-19** Supabase organisation + PITR billing → **Task 2**; **OD-20** Cloudflare account with Containers + a domain → **Task 4**; **OD-21** owner login e-mail, legal name, MYR, fiscal-year start, service-role key → **Task 9**; **OD-22** Sentry organisation → **Task 13**; **OD-04** the nine role names → **Task 8**. Defaults per §2.12: Testcontainers, `wrangler dev`, fixture values, a stub DSN, the spec's role names. **OD-24 does not apply — 0C ships no screen.**
- **Part VI tests owned / re-run:** **owned: none new.** 0C **runs 12, 13 and 14 in CI against staging** as the Phase 0 exit gate (Task 14). **Re-runs:** the seed clauses of **36** — nine roles present, `admin` holds every present code except `pos.ticket.sell` and `pos.sync.*` (Task 8). **§3.0.4 rows owned:** none. **Regression files created:** `tests/regression/legacy-039.test.ts` (bootstrap is an offline idempotent CLI, Task 6) and `tests/regression/legacy-081.test.ts` (PITR enabled — the restore drill itself is 1B's, Task 2). **Appended to:** `legacy-025` (Task 12), `legacy-080` (Task 5), `legacy-087` (Task 5) — each with a new `describe("… — 0C", …)` block beside 0B's, never editing 0B's block (§3.7.3).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **none** (`JOURNAL` is 1A's, §4.3.7). Account codes (§4.15) — **seeded: `1000`, `1100`, `1200`, `1300`, `2100`, `4000`, `4900`, `5000`, `5900`, `5910`, `5920`** (the eleven leaves §4.15 marks 0C) plus five unregistered `is_group = true` presentation parents `1`, `2`, `3`, `4`, `5`; **consumed but seeded elsewhere: none.** Report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**. `fixtures.ts` helpers (§4.17) — **none added**; 0C's tests drive the real loaders against `startDb()` and `seedTenant`, which is what they are testing. `ERR_*` (§4.2.4) — **exactly one added: `ERR_RATE_LIMITED` (429, raised by the edge Worker, Task 3)**, because §4.2.4's allocated space held no 429 code before it and spec:2204 requires rate limiting in v1; the contracts table already carries the row (§4.18 round 1) and Task 1 Step 0 verifies it before Task 3 raises the code (hazard 32). The seed CLI adds none — its `SeedError` carries the already-registered `ERR_VALIDATION_FAILED`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-08 — the contracts document as of "§4.18 Amendments from written plans (2026-09-07, extended 2026-09-08)", with rounds 1–3 folded into §§2–4. Round 1 carries this slice's own amendments (the `| … | 0C | plan |` rows); §4.18 **overrides anything earlier in that document that contradicts it**.

### Assumptions this plan rests on

Each is stated once here so no task has to hedge. If one is false at execution time, only the task named changes.

1. **0B shipped `apps/api` with `readConfig()` reading `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `PORT` (default 8080)** and `apps/api/src/index.ts` exporting `{ port, fetch }`. Tasks 1, 5 and 13 depend on those exact names; the Dockerfile sets no other API variable.
2. **0D shipped `apps/worker/src/index.ts` as a long-running process with no HTTP surface** (`await boss.start()` then `boss.work(…)`). The Cron Trigger of spec:1157 needs something to ping, so **Task 1 adds `apps/worker/src/health.ts` and one import line to 0D's `index.ts`** — an additive change to a file 0D owns, listed in Task 1's Files as *Modify*, and recorded in ADR 0011. Nothing else in `apps/worker` moves.
3. **`packages/db` may not import `@dulja/contracts`** — §5.2's dependency rule puts them at the same tier, and 0D's `seed/roles.ts` already refuses that import. The seed therefore reads the permission catalogue from `app.permission` (a `GLOBAL_TABLE`, no RLS, `select` granted to `app_rw` and owned by `app_migrator` — plan0A:1254) and passes it to `adminPermissions(catalogue)`. It never imports `PERMISSIONS`.
4. **0B's `AuthAdmin` port lives in `apps/api/src/ports.ts`** and is unreachable from `packages/db` (packages never import apps — §3.1). Task 9 therefore declares its own narrower port, `SeedAuthAdmin`, in `packages/db/src/seed/auth-admin.ts`. This is a **contract addition**, recorded in the Self-Review.
5. **`app.principal.auth_subject` is `text not null unique`** and the `principal_in_tenant` SELECT policy tests `app.current_tenant()` only — not `current_actor()` (plan0A:990–1010). Both facts are load-bearing: they let the seed set `app.tenant_id` alone, look the system principal up on a re-run, and use `on conflict (auth_subject) do nothing`. Task 7 Step 1 asserts both before anything depends on them.
6. **`app.fiscal_period` has no unique constraint on `(company_id, starts_on)`** — only `exclude using gist (company_id with =, daterange(starts_on, ends_on, '[]') with &&)` (plan0A:1467–1481). An exclusion constraint can arbitrate `on conflict do nothing` **only in the targetless form**, so the fiscal-periods loader writes `on conflict do nothing` with no conflict target. Task 10 states this in the SQL comment.
7. **`@cloudflare/containers`' exact class surface, the Workers rate-limiting binding's method name, and the OTLP exporter's option names are verified against the installed packages at execution time**, exactly as 0D verified pg-boss for ADR 0007 (spec:93). Tasks 3, 4 and 13 each begin with the verification command and record the answer in ADR 0011 / ADR 0013. The card's own names — `getContainer(env.API, "api")`, `sleepAfter: "10m"`, `RateLimit-*` — are frozen and are not re-verified.
8. **`no-console` is `error` everywhere except `packages/*/src/cli.ts` and `**/*.test.ts` (plan0A:301), and no plan widens that glob.** So: `packages/db/provision/verify-supabase.ts` and every `packages/db/src/seed/*.ts` write through `process.stdout.write` or return a result the CLI prints; `packages/db/src/cli.ts` may use `console`; and `apps/edge/src/log.ts` — a Workers runtime with no `process.stdout` — carries **one** `// oxlint-disable-next-line no-console` with a reason. That inline disable is the only one in the slice.
9. **Docker Desktop (WSL2 backend) is available**, as for Plan 0A, and `docker build` runs locally. Task 1's image proof is a real build; Task 4's `wrangler dev` proof needs the Cloudflare CLI but no account (OD-20).
10. **Staging is a real Supabase project and a real Cloudflare deploy.** Until OD-19 and OD-20 arrive, every task's verification runs against `startDb()` / `wrangler dev` and must print the *same* lines; the cloud command is written out beside it so the executor runs one line when the account exists.
11. **`bun run seed` is `packages/db/src/cli.ts seed`, never an endpoint.** LEGACY-039 is the defect: `procInitDatabase` created an administrator, unauthenticated, with no already-initialised guard. Task 6's regression asserts mechanically that no `ROUTES` path matches `/seed|init|bootstrap/` and that the CLI refuses to run on `DATABASE_URL` (it requires `DATABASE_URL_MIGRATOR`).
12. **The seed is re-run after every deploy** (§3.4.8: "re-applying the seed against staging after deploy is a release-runbook step"), so idempotency is not a nicety — Task 12 proves it by snapshotting the row count of every table the seed touches **plus `app.audit_log` plus `pgboss.tenant_registry`** across two runs.

### A note on this plan's length and shape

Contracts §2.0 sizes 0C at **12–14 tasks**. This plan is **14 tasks, all written**, in about 5,300 lines — roughly 380 per task, and the **shortest of the four Phase 0 slices** (0B is 7,120 lines, 0D 6,292, 0E 5,829). §2.0's ~3,700-line signal is a warning about a plan that has passed that length "**while tasks remain unwritten**"; none is unwritten here, and the slice is not split. The slice is **fourteen tasks and fourteen commits**: Task 1 Step 0 is a verification gate over the contracts registers, and because §4.18 round 1 already folded every 0C amendment in, it normally finds nothing to change and commits nothing. It becomes a fifteenth commit only if a register has drifted since — Step 0b is conditional for exactly that case.

It carries five owner gates — more than any other Phase 0 slice — and §2.0 requires each to be exactly one droppable task, which sets a floor of five before any content. The other nine carry the container image, the edge Worker, the deploy pipeline, the seed CLI seam, three sub-pack loaders, the DoD 0.7b proof and the exit gate. Migration count is **zero**, which is why 0C is lighter than its neighbours: it is heavy in configuration and infrastructure, not in SQL.

---

## Global Constraints

Copied from the spec; every task's requirements include these.

- **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
- **Always** (spec:106), for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. *(0C creates no table — its migration number 0009 is reserved and unused.)* For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. *(0C adds no `/v1` route; `apps/edge` is a proxy, and its only origin-terminated paths are `/healthz` and `/updates/*`, which are public and read-only.)* For every UI screen: verified in both text directions before merge. *(0C ships no screen.)*
- **Never an initialisation procedure callable on a running system** (spec:2188, LEGACY-039). Bootstrap is the offline `bun run seed` CLI, run as `app_migrator`.
- **Per-tenant rows cannot be written by a migration** (spec:1366, §3.4.8, hazard 10): `FORCE ROW LEVEL SECURITY` binds `app_migrator`, and a migration file has no `set_config`. Roles, role grants, chart of accounts, dimensions and fiscal periods are seed-pack data.
- **Identifiers** (spec:2037): `uuidv7()` server-side for everything; never a sequential integer as a public identifier; never reuse; never rewind (LEGACY-021). The seed mints ids with `select uuidv7()::text` on the migrator connection, never with a client-side generator.
- **Time** (spec:2039): all timestamps `timestamptz` in UTC; `effective_date` is a `date`; every company has a `timezone` (`Asia/Kuala_Lumpur` for the first customer).
- **Money** (spec:2041): `numeric(19,4)`; no `number` ever holds a monetary value. *(0C writes no monetary value; the chart of accounts carries codes and names only.)*
- **Naming** (spec:2045): `snake_case` in SQL, singular table names; TypeScript `camelCase`, types `PascalCase`; bilingual master data as `name_en` / `name_ar` columns, never a JSON blob — the seed pack's `nameEn` / `nameAr` members land in exactly those columns.
- **Database access** (spec:2053): every query — reads included — runs inside `withTenant(tx => …)`, which opens the transaction and issues the two `set_config(…, true)` calls before anything else. A lint rule forbids bare `db.` calls; `packages/db/src/**` is not on its allow-list beyond the four files 0B listed, so **every seed statement is tagged by a `tx` obtained from the production `withTenant`**.
- **Connections** (spec:1366, §3.2.1): session mode / direct, port 5432. Never the transaction-mode pooler (6543); `createDb` refuses it and Task 2's probe proves no `:6543` string is in any config.
- **Error codes** (spec:2051): every error has a stable `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`; a code no code raises fails the build. 0C adds **one** code — `ERR_RATE_LIMITED` (429), raised by `apps/edge`; contracts §4.2.4's allocated table already carries its row (verified by Task 1 Step 0) and the `ERRORS` row is added in Task 3, the PR that raises it.
- **Logging** (spec:2063): structured JSON with `tenant_id`, `actor_id`, `request_id`, `trace_id` on every line; never a token, password or full card number; `no-console` outside scripts.
- **Secrets** (spec:2273): never in the repository, never in a committed `.env`. Cloudflare secret bindings for the container; the Supabase service-role key is the seed CLI's alone and never enters the image.
- **Environments** (spec:2272): `dev` (local, Testcontainers), `staging` (a real Cloudflare Container against a staging Supabase project), `production`. Nothing reaches production without passing through staging.
- **Commits:** conventional commits, scope = workspace or area; subject `<type>(<scope>): <summary> [0C T<n>]`; every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Pushing to GitHub is the owner's call, not part of any task's definition of done.

---

## File structure

Created or modified by this plan, in order of appearance. One responsibility per file.

```
docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md   VERIFIED — Task 1 Step 0 greps the fourteen register strings
                                                §4.18 round 1 already folded in; MODIFIED only if one has drifted (hazard 32)

.dockerignore                                   NEW (repository root, because the build context IS the root) —
                                                keeps node_modules, .git, docs and test sources out of the context
infra/                                          NEW — spec §5.2 "Cloudflare (wrangler) config, container Dockerfile, …, Renovate"
├─ Dockerfile                                   one image; ENTRYPOINT dispatches api | worker (spec:1155)
├─ entrypoint.sh                                exec bun apps/<class>/src/index.ts; refuses an unknown class
├─ wrangler.jsonc                               the edge Worker, both container classes, the Cron Trigger, R2 bindings
├─ renovate.json                                dependency updates with a patch SLA (spec:2270)
└─ test/
   ├─ entrypoint.test.ts                        runs entrypoint.sh against a stub `bun` on PATH
   ├─ dockerfile.test.ts                        every workspace in the root `workspaces` array has a COPY manifest line
   └─ wrangler.test.ts                          asserts wrangler.jsonc as data: classes, cron, bindings, no secret

apps/worker/src/health.ts                       NEW (this slice) — the Cron Trigger's ping target; assumption 2
apps/worker/src/index.ts                        MODIFIED — one import + one call, additive
apps/worker/src/otel.ts                         NEW — the worker half of ADR 0013
apps/worker/src/sentry.ts                       NEW — stub-DSN-safe Sentry init

packages/db/provision/
├─ roles.sql                                    (Plan 0A — unchanged; Task 2 documents running it as Supabase's `postgres`)
└─ verify-supabase.ts                           NEW — the four-line posture probe of §5.0 row 0.2

packages/db/src/seed/                            NEW — the bootstrap; pure functions over an injected Sql
├─ types.ts                                     SubPack, SUB_PACKS, SeedError — imported by every sibling
├─ index.ts                                     seed(), SeedResult, runLoaders(), the barrel re-exports
├─ config.ts                                    readSeedConfig(): flags + env → SeedConfig (OWNER GATE OD-21 values)
├─ auth-admin.ts                                SeedAuthAdmin, SupabaseSeedAuthAdmin, StubSeedAuthAdmin
├─ identity.ts                                  bootstrap steps 1–3: tenant, system principal, membership, tenant_registry
├─ owner.ts                                     bootstrap step 4: owner auth user, human principal, company, admin assignment
├─ packs.ts                                     the sub-pack registry, PACK_ROOT, assertPackShape(), readPackFile()
├─ roles.ts                                     the `roles` loader (OWNER GATE OD-04)
├─ dimensions.ts                                the `dimensions` loader — BRANCH + head office
├─ fiscal-periods.ts                            the `fiscal-periods` loader — the current fiscal year
└─ chart-of-accounts.ts                         the `chart-of-accounts` loader + company.fx_rounding_account_id

packages/db/seed/my/                             NEW — the Malaysia pack at Phase 0: exactly three sub-packs
├─ chart-of-accounts/0c-base.json               §4.15's eleven 0C leaves + five presentation parents
├─ dimensions/branch.json                       the BRANCH dimension type and its head-office value
└─ fiscal-periods/monthly.json                  the period shape; the start month comes from SeedConfig (OD-21)

packages/db/src/cli.ts                          MODIFIED — the `seed` sub-command, its flags and exit codes
packages/db/package.json                        MODIFIED — scripts `provision:verify`, `seed`; deps @supabase/supabase-js;
                                                exports "./provision/verify-supabase" and "./seed" (NOT the main entry)
packages/contracts/src/errors.ts                MODIFIED — one row: ERR_RATE_LIMITED (429), Task 3
package.json (root)                             MODIFIED — script `seed`, script `test:staging`, `workspaces` gains "infra"

apps/edge/                                       NEW — @dulja/edge (spec §5.2 "auth pre-check, rate limiting, update-feed delivery from R2, forward /v1/* to the container")
├─ package.json
├─ tsconfig.json
├─ vitest.config.ts
├─ src/
│  ├─ env.ts                                    the Env binding type — one place every binding name is written
│  ├─ log.ts                                    the Worker's one structured line (assumption 8)
│  ├─ jwt-precheck.ts                           shape / exp / iss pre-filter — a filter, never a trust boundary
│  ├─ rate-limit.ts                             the RateLimit-* headers of spec:2204
│  ├─ updates.ts                                the electron-builder feed from R2
│  ├─ router.ts                                 the PURE router: handleFetch / handleScheduled over injected deps
│  ├─ container-env.ts                          containerSecrets() — the §3.11 inventory, imports nothing Cloudflare
│  ├─ containers.ts                             ApiContainer / WorkerContainer (sleepAfter, defaultPort, envVars)
│  └─ index.ts                                  the ONLY module that imports @cloudflare/containers: binds the deps
└─ test/
   ├─ jwt-precheck.test.ts
   ├─ rate-limit.test.ts
   ├─ updates.test.ts
   └─ routing.test.ts                           drives src/router.ts with stub deps — never src/index.ts

apps/api/src/otel.ts                            NEW — the container half of ADR 0013
apps/api/src/sentry.ts                          NEW
apps/api/src/index.ts                           MODIFIED — three lines: start OTel and Sentry before createApp
apps/api/src/middleware/request-id.ts           MODIFIED — bind the OTel span to the request id (0B left the seam)

.github/workflows/deploy-staging.yml            NEW — the one-command deploy of §5.0 row 0.5
.github/workflows/ci.yml                        MODIFIED — the `staging-gate` job (Task 14)

docs/adr/0011-container-topology.md             NEW
docs/adr/0012-seed-pack-format.md               NEW
docs/adr/0013-observability-otel-sentry.md      NEW
docs/runbooks/supabase-provisioning.md          NEW — OWNER GATE OD-19; PITR; the staging project
docs/runbooks/deploy.md                         NEW — deploy, jobs:install, re-seed, rollback

tests/regression/legacy-039.test.ts                NEW (created by this slice)
tests/regression/legacy-081.test.ts                NEW (created by this slice)
tests/regression/legacy-025.test.ts                MODIFIED — one appended describe block
tests/regression/legacy-080.test.ts                MODIFIED — one appended describe block
tests/regression/legacy-087.test.ts                MODIFIED — one appended describe block
tests/staging/                                  NEW — a directory INSIDE the existing `tests` workspace (not a new
                                                workspace): its own Vitest config, run against a deployed URL by the
                                                root script `test:staging`; `tests/vitest.config.ts`'s `include`
                                                (contracts:1173) deliberately does not collect it
├─ vitest.config.ts                             sets `root` to its own directory, so cwd never decides what runs
└─ phase-0-exit.test.ts                         the Phase 0 exit gate (T14); skipped without STAGING_BASE_URL

packages/db/test/provision-verify.test.ts       NEW — T2
packages/db/test/seed-packs.test.ts             NEW — T6
packages/db/test/seed-identity.test.ts          NEW — T7
packages/db/test/seed-roles.test.ts             NEW — T8
packages/db/test/seed-owner.test.ts             NEW — T9
packages/db/test/seed-dimensions.test.ts        NEW — T10
packages/db/test/seed-periods.test.ts           NEW — T10
packages/db/test/seed-chart.test.ts             NEW — T11
packages/db/test/seed-idempotent.test.ts        NEW — T12
apps/worker/test/health.test.ts                 NEW — T1 (runs under `bun test`, not Vitest)
apps/edge/test/containers.test.ts               NEW — T5
apps/api/test/routes/first-login.test.ts        NEW — T12
apps/api/test/otel.test.ts                      NEW — T13
```

---

### Task 1: `infra/` — one image, two entrypoints, the worker health surface, and ADR 0011

Spec §3.2.4 fixes the topology: "Two container classes from one image, different entrypoints: `api` and `worker`". One `Dockerfile`, one `entrypoint.sh` that dispatches on a single environment variable, and the small HTTP surface the Cron Trigger of spec:1157 needs in order to have something to ping.

**Files:**
- Create: `infra/Dockerfile`, `.dockerignore` (repository root), `infra/entrypoint.sh`, `infra/test/entrypoint.test.ts`, `infra/test/dockerfile.test.ts`, `infra/package.json`, `infra/tsconfig.json`, `infra/vitest.config.ts`, `apps/worker/src/health.ts`, `docs/adr/0011-container-topology.md`
- Verify (Step 0), and modify only on drift: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`
- Modify: `apps/worker/src/index.ts` (two lines — assumption 2), `apps/worker/package.json` (the `test:bun` script — Step 6), `apps/worker/vitest.config.ts` (`exclude` gains `test/health.test.ts` — Step 6), `apps/worker/tsconfig.json` (`"types": ["node", "bun-types"]`, only if `Bun` is not already declared there — Step 6), `package.json` (root `workspaces` gains `"infra"`), `bun.lock` (the workspace change)
- Test: `infra/test/entrypoint.test.ts`, `infra/test/dockerfile.test.ts`, `apps/worker/test/health.test.ts`

**Interfaces:**
- Consumes: 0B's `apps/api/src/index.ts` (`export default { port, fetch }`) and `readConfig()`'s `PORT`; 0D's `apps/worker/src/index.ts`, `registeredJobNames()` from `apps/worker/src/handler.ts`, `log()` from `apps/worker/src/log.ts`.
- Produces:

```ts
// apps/worker/src/health.ts  — contract addition (assumption 2); recorded in ADR 0011
export interface WorkerHealth { readonly status: "ok"; readonly jobs: readonly string[]; readonly startedAt: string }
/** Starts a minimal Bun HTTP listener on `PORT` (default 8080 — the same variable apps/api reads, because both
 *  classes are the same image; ADR 0011) answering GET /healthz with WorkerHealth.
 *  It exists so the Cloudflare Cron Trigger has an endpoint to ping (spec:1157) and so §5.0 row 0.5's
 *  "a scheduled job runs in `worker` while `api` is idle" is observable. It serves nothing else. */
export function startWorkerHealth(jobs: () => readonly string[], port?: number): { port: number; stop(): void };
```

Shell contract of `infra/entrypoint.sh` (frozen; the deploy config and ADR 0011 both cite it): the container class is `DULJA_ENTRYPOINT`, one of `api` or `worker`; anything else exits **2** with `unknown DULJA_ENTRYPOINT '<value>' — expected api or worker` on stderr; an unset value defaults to `api`.

- [ ] **Step 0: Verify the contracts registers already carry every name this slice adds — amend only what has drifted**

Contracts §4.2.4 (contracts:1548): "A slice that needs a code absent from this table amends this table first." Hazard 32 says the same for every other shared namespace: "if the string appears in a seed file or a policy and is not in a register, the plan amends the register first." **That amendment has already been made.** Contracts §4.18 *"Amendments from written plans (2026-09-07, extended 2026-09-08)"*, **round 1**, folded this slice's additions into §§2–4 and left the audit-trail rows that name them — `| 2.12 | OD-04 gate is 0C's roles-loader task (T8) … | 0C | correction |`, `| 3.1 | Sub-packs gain dimensions/ and fiscal-periods/; infra joins workspaces and the package table | 0C | plan |`, `| 3.4.8 | Phase 0 loader names … | 0C | plan |`, `| 2.1 (0C card), 3.9 | ADR 0013 = observability … | 0C | plan |`, `| 3.11 | … OTEL_EXPORTER_OTLP_ENDPOINT … | 0B, 0C | plan |`, `| 4.2.2 | … DbOptions.debug … | 0B, 0C | plan |`, `| 4.2.3 | … otel heads the fixed middleware order | 0B, 0C | plan |`, `| 4.2.4 | ERR_RATE_LIMITED (429) … | 0C, 1A | plan |`, `| 4.2.12 | … the two new @dulja/db subpaths … | 0B, 0C | plan |`, `| 4.15 | AccountSeed.isGroup? | 0C | plan |`.

So this step is **a gate, not an edit**. It runs fourteen exact-string greps over the contracts document — one per register entry, with §3.1 contributing three and §4.2.4 two; every one must report `PRESENT`. Re-applying an amendment that is already in place would duplicate a row in a register twenty-nine other plans read, which is why nothing below rewrites text that the grep finds.

```bash
C=docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
check() { if grep -qF -- "$2" "$C"; then echo "PRESENT  $1"; else echo "MISSING  $1"; fi; }

check "§2.12  OD-04 gate = the roles-loader task"        '0C → the roles-loader task (0C T8'
check "§3.1   sub-packs dimensions/ + fiscal-periods/"   '`chart-of-accounts/`, `dimensions/`, `fiscal-periods/`'
check "§3.1   workspaces gains infra"                    '0C appends `"infra"`'
check "§3.1   workspace table row for infra"             '| `infra` | `@dulja/infra` |'
check "§3.4.8 the Phase 0 loader names, in order"        'The Phase 0 loader names are exactly `roles`, `dimensions`, `fiscal-periods`, `chart-of-accounts`'
check "§2.1   0C card ADR range names 0013"              '0013 = observability'
check "§3.9   ADR-range table names 0013"                '0013 observability'
check "§3.11  OTEL_EXPORTER_OTLP_ENDPOINT row"           '| `OTEL_EXPORTER_OTLP_ENDPOINT` | api, worker | 0C |'
check "§4.2.2 DbOptions.debug"                           'debug?: (connection: number, query: string) => void'
check "§4.2.12 the two @dulja/db subpaths"               '`"./provision/verify-supabase"` (so the staging suite can import the posture probe) and `"./seed"`'
check "§4.2.3 otel heads the middleware order"           'Middleware order (fixed): **`otel`**'
check "§4.2.4 ERR_RATE_LIMITED in the allocated table"   '| `ERR_RATE_LIMITED` | 429 |'
check "§4.2.4 the 0C-adds sentence"                      '0C adds `ERR_RATE_LIMITED`.'
check "§4.15  AccountSeed.isGroup?"                      'parentCode?, currency?, isGroup? }'
```

Expected: **fourteen lines, every one beginning `PRESENT`**. Verified against the contracts document at version 2026-09-08.

**If a line reports `MISSING`**, that register has drifted since §4.18 round 1 and this step restores exactly that one entry — never all of them, and never a second copy of one the grep found. The required text of each, verbatim, is:

**§2.12, OD-04's row** — the gate column reads:

```
0D → `packages/db/seed/roles.ts` task; 0C → the roles-loader task (0C T8 — the nine codes are applied there, and T9's admin assignment consumes the result)
```

**§3.1, "Additional directories"** — the sub-pack list in that sentence reads:

```
sub-packs `chart-of-accounts/`, `dimensions/`, `fiscal-periods/`, `document-types/`, `templates/`, `reports/`, `tax/`, `statutory/<scheme>/`
```

**§3.1, the workspaces sentence** — appended after the sentence ending "so `tests/` must be one.":

```
**0C appends `"infra"`, making it `["packages/*", "apps/*", "tests", "infra"]`**: `infra/` carries its own Vitest suite over the Dockerfile, the entrypoint script and the wrangler config, and turbo's pipeline only sees workspace packages.
```

**§3.1, the workspace table** — one row after the `apps/edge` row:

```
| `infra` | `@dulja/infra` | deployment description and container image; imports nothing | 0C |
```

**§3.4.8** — one sentence after the `--only <sub-pack>` rule:

```
**The Phase 0 loader names are exactly `roles`, `dimensions`, `fiscal-periods`, `chart-of-accounts`, in that application order** (`SUB_PACKS`, §4.2.13, 0C); `roles` is TypeScript data in `packages/db/seed/roles.ts` and has no directory under `my/`, the other three are sub-pack directories.
```

**§2.1, the 0C card's ADR-range cell** — the whole cell:

```
0011–0015 (0011 = container topology as built; 0012 = seed-pack format; 0013 = observability — OTel + Sentry; 0014–0015 unused)
```

**§3.9, the ADR-range table's 0C cell** — the whole cell:

```
0011–0015 (0011 topology, 0012 seed-pack format, 0013 observability — OTel + Sentry)
```

**§3.11's inventory table** — one row after the `LOG_LEVEL` row:

```
| `OTEL_EXPORTER_OTLP_ENDPOINT` | api, worker | 0C | OTLP trace ingest; unset means the in-memory exporter (OD-22) |
```

**§4.2.2's `DbOptions`** — replaces the one-field declaration:

```ts
export interface DbOptions { max?: number; debug?: (connection: number, query: string) => void }   // default max 4 — "one small pool per instance" (spec:1160); `debug` is postgres.js's own hook (0C, ADR 0013) — never a monkey-patch, and it never sees parameter values
```

**§4.2.12's `exports` paragraph** — after the sentence adding `"./test"`:

```
**0C adds two more subpaths — `"./provision/verify-supabase"` (so the staging suite can import the posture probe) and `"./seed"` (`./src/seed/index.ts`, §4.2.13).** The seed is deliberately **not** re-exported from `packages/db/src/index.ts`: `packages/db/src/seed/auth-admin.ts` imports `@supabase/supabase-js`, and a barrel re-export would put the service-role admin client on the import graph of every `apps/api` and `apps/worker` module that imports `withTenant`.
```

**§4.2.3's fixed middleware order** — replaces the sentence's opening; everything from `→ `logger`` onward is unchanged:

```
Middleware order (fixed): **`otel`** (0C, ADR 0013 — `startActiveSpan` must wrap every later middleware; without an active span `setPrincipalAttributes` is a silent no-op) → `requestId`
```

**§4.2.4's allocated table** — one entry beside the other 4xx codes, in that table's own paired-column shape:

```
| `ERR_RATE_LIMITED` | 429 | `apps/edge` rate-limit binding refuses (0C) |
```

**§4.2.4's raiser paragraph** — appended after the sentence listing 0D's four codes:

```
0C adds `ERR_RATE_LIMITED`.
```

**§4.15's "Seed layout" paragraph** — replaces the six-member shape:

```
each a flat array of `{ code, nameEn, nameAr, type, parentCode?, currency?, isGroup? }` — `isGroup?: boolean` marks a presentation parent; group codes are unregistered by this table and no policy resolves them, but a pack cannot express the parent rows without the field.
```

Then re-run the fourteen greps: all `PRESENT`.

**Do not touch §4.18 itself.** Its rows are the audit trail of what has already moved; a restored entry above is a repair of drift, not a new amendment, and adding a round row for it would claim a second amendment that never happened.

- [ ] **Step 0b: Commit the restored register — only if Step 0 changed the document**

```bash
git diff --quiet docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md \
  && echo "contracts unchanged — nothing to commit, continue at Step 1" \
  || git commit -m "docs(contracts): restore 0C's register entries lost since §4.18 round 1 [0C T1]

Step 0's grep gate found a register that no longer carried the 0C entry §4.18 round 1 records.
Restores exactly the missing entries; adds no §4.18 row, because this is drift repair, not a new
amendment (contracts §4.2.4 'amends this table first'; hazard 32).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
```

In the normal case — every register `PRESENT` — this step prints `contracts unchanged` and makes **no commit**, and Task 1 ends with the single commit of Step 9.

- [ ] **Step 1: Scaffold the `infra` workspace and write the failing test**

```bash
mkdir -p infra/test
```

`infra/package.json`:

```json
{
  "name": "@dulja/infra",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../node_modules/vitest/vitest.mjs run"
  }
}
```

`infra/tsconfig.json`: `{ "extends": "../tsconfig.base.json", "compilerOptions": { "rootDir": ".", "noEmit": true }, "include": ["test/**/*.ts", "vitest.config.ts"] }`

`infra/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
```

Root `package.json`: `"workspaces": ["packages/*", "apps/*", "tests", "infra"]` — `tests` was added by 0B (§3.1); this appends `infra` so turbo's `test` pipeline sees it. Step 0's grep confirmed contracts §3.1 already carries that change.

**Then refresh the lockfile, in the same step:**

```bash
bun install                    # bun.lock learns the new `infra` workspace
git diff --stat bun.lock       # expect exactly one changed file
```

This is not housekeeping. `infra/Dockerfile`'s `deps` stage (Step 5) runs `bun install --frozen-lockfile`, which fails on a lockfile that does not know a declared workspace — so Step 7's `docker build` cannot succeed until `bun.lock` has been regenerated and committed. Task 3 Step 6 does the same after `apps/edge` joins the array, and Task 12 Step 5 after `packages/db` gains a dependency.

`infra/test/entrypoint.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(here, "..", "entrypoint.sh");

/** A fake `bun` that prints its arguments instead of running them, so the test observes the dispatch, not Bun. */
function stubBunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dulja-entrypoint-"));
  const stub = join(dir, "bun");
  writeFileSync(stub, '#!/bin/sh\necho "bun $*"\n');
  chmodSync(stub, 0o755);
  return dir;
}

function run(entry: string | undefined): { code: number; out: string; err: string } {
  const env = { ...process.env, PATH: `${stubBunDir()}:${process.env["PATH"] ?? ""}` } as NodeJS.ProcessEnv;
  if (entry === undefined) delete env["DULJA_ENTRYPOINT"];
  else env["DULJA_ENTRYPOINT"] = entry;
  try {
    const out = execFileSync("sh", [ENTRYPOINT], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout, err: err.stderr };
  }
}

describe("infra/entrypoint.sh — one image, two entrypoints (spec:1155)", () => {
  it("DULJA_ENTRYPOINT=api runs the API entrypoint", () => {
    const r = run("api");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("bun run apps/api/src/index.ts");
  });

  it("DULJA_ENTRYPOINT=worker runs the worker entrypoint — the same image, a different file", () => {
    const r = run("worker");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("bun run apps/worker/src/index.ts");
  });

  it("an unset value defaults to api", () => {
    expect(run(undefined).out.trim()).toBe("bun run apps/api/src/index.ts");
  });

  it("an unknown class exits 2 and names the value — a typo must not silently start the wrong process", () => {
    const r = run("wrker");
    expect(r.code).toBe(2);
    expect(r.err.trim()).toBe("unknown DULJA_ENTRYPOINT 'wrker' — expected api or worker");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd infra && bun run test`
Expected: FAIL — all four cases error with `ENOENT` on `infra/entrypoint.sh`.

- [ ] **Step 3: Write `infra/entrypoint.sh`**

```sh
#!/bin/sh
# One image, two container classes (spec §3.2.4). `api` serves HTTP through the edge Worker's container binding;
# `worker` runs the pg-boss poller. `exec` replaces the shell so the process is PID 1 and receives SIGTERM
# directly — Cloudflare stops a container by signalling it, and a wrapping shell would swallow that.
set -e
class="${DULJA_ENTRYPOINT:-api}"
case "$class" in
  api)    exec bun run apps/api/src/index.ts ;;
  worker) exec bun run apps/worker/src/index.ts ;;
  *)      echo "unknown DULJA_ENTRYPOINT '$class' — expected api or worker" >&2; exit 2 ;;
esac
```

Make it executable and keep the bit in git:

```bash
chmod +x infra/entrypoint.sh
git update-index --chmod=+x infra/entrypoint.sh
```

- [ ] **Step 4: Run the entrypoint test to verify it passes**

Run: `cd infra && bun run test`
Expected: PASS — 4 tests.

If the `exec` line prints `bun: not found`, the stub directory was not first on `PATH`; check that `stubBunDir()` is prepended, not appended.

- [ ] **Step 5: Write the failing image-manifest test, then `infra/Dockerfile` and the root `.dockerignore`**

The `deps` stage must copy the manifest of **every** workspace in the root `workspaces` array, or `bun install --frozen-lockfile` refuses with "lockfile had changes". That is a rule a comment cannot enforce — Task 3 adds `apps/edge` and would otherwise break the image silently — so it is a test.

`infra/test/dockerfile.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(REPO_ROOT, "infra", "Dockerfile"), "utf8");
const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { workspaces: string[] };

/** Expand the one glob form the array uses (`<dir>/*`) against the filesystem; everything else is a literal. */
function workspaceDirs(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.endsWith("/*")) {
      const parent = p.slice(0, -2);
      for (const e of readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })) {
        if (e.isDirectory()) out.push(`${parent}/${e.name}`);
      }
    } else out.push(p);
  }
  return out.sort();
}

describe("infra/Dockerfile — the build context is the repository root (ADR 0011)", () => {
  it("copies the manifest of every workspace the root package.json declares", () => {
    for (const ws of workspaceDirs(root.workspaces)) {
      expect(dockerfile, ws).toContain(`COPY ${ws}/package.json`);
    }
  });

  it("the root .dockerignore does not exclude a path the Dockerfile copies", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8")
      .split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
    const copied = [...dockerfile.matchAll(/^COPY (?:--from=\S+ )?(\S+)/gm)].map((m) => m[1]!);
    for (const pattern of ignore) {
      if (pattern.startsWith("!")) continue;
      for (const src of copied) {
        if (src.startsWith("/app")) continue;                       // a --from= stage path, not a context path
        expect(src === pattern || src.startsWith(`${pattern}/`), `${pattern} would exclude ${src}`).toBe(false);
      }
    }
  });
});
```

Run: `cd infra && bun run test -- test/dockerfile.test.ts`
Expected: FAIL — `ENOENT … infra/Dockerfile`.

`infra/Dockerfile`:

```dockerfile
# One image, two container classes (spec §3.2.4). Build context is the repository root:
#   docker build -f infra/Dockerfile -t dulja:local .
# No package version is pinned in this file beyond the base image tag — the lockfile owns versions (spec:104).
FROM oven/bun:1-slim AS deps
WORKDIR /app
# Copy every manifest the workspace resolver needs, then install once with the committed lockfile.
COPY package.json bun.lock ./
COPY packages/db/package.json         packages/db/package.json
COPY packages/domain/package.json     packages/domain/package.json
COPY packages/contracts/package.json  packages/contracts/package.json
COPY apps/api/package.json            apps/api/package.json
COPY apps/worker/package.json         apps/worker/package.json
COPY tests/package.json               tests/package.json
COPY infra/package.json               infra/package.json
# `bun install --frozen-lockfile` refuses to proceed if the lockfile knows a workspace whose manifest is absent,
# so this list must name every workspace in the root `workspaces` array — which `infra/test/dockerfile.test.ts`
# asserts mechanically, so Task 3 cannot forget the `apps/edge` line. The edge Worker is never copied into the
# runtime stage: it runs on Cloudflare, and only api and worker ship inside the image.
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY infra/entrypoint.sh /usr/local/bin/dulja-entrypoint
RUN chmod +x /usr/local/bin/dulja-entrypoint \
 && addgroup --system dulja && adduser --system --ingroup dulja dulja \
 && chown -R dulja:dulja /app
USER dulja
# Both classes listen on 8080: `api` because apps/api/src/index.ts reads PORT (default 8080, Plan 0B), and
# `worker` because apps/worker/src/health.ts gives the Cron Trigger something to ping (spec:1157, ADR 0011).
EXPOSE 8080
ENV DULJA_ENTRYPOINT=api
ENTRYPOINT ["/usr/local/bin/dulja-entrypoint"]
```

`.dockerignore` — **at the repository root, not under `infra/`.** Docker reads `.dockerignore` from the build *context* root, and this Dockerfile's context is the repository root (the header line above, and `docker build … .` in Step 7). A file at `infra/.dockerignore` would be inert: the only per-Dockerfile form BuildKit honours is `<path>/Dockerfile.dockerignore`, and the file has to describe the context anyway.

`tests` and `**/test` are **deliberately absent** from this list: `tests` is a workspace, the `deps` stage does `COPY tests/package.json`, and `bun install --frozen-lockfile` fails without that manifest. Excluding the test *sources* is enough, and `infra/test/dockerfile.test.ts` fails the build if a future edit re-adds a directory the Dockerfile copies.

```
node_modules
**/node_modules
.git
.github
.turbo
dist
docs
**/*.test.ts
```

- [ ] **Step 6: Write the failing `apps/worker/test/health.test.ts`, then `apps/worker/src/health.ts` and two lines in `apps/worker/src/index.ts`**

The test first, and run red before the module exists — the same write-fail-implement-pass cycle every other task in this slice follows.

`apps/worker/test/health.test.ts`:

```ts
// This one file runs under `bun test`, not Vitest, because Bun.serve is Bun-only — so it imports "bun:test".
import { afterAll, describe, expect, it } from "bun:test";
import { startWorkerHealth, type WorkerHealth } from "../src/health";

describe("apps/worker/src/health.ts — the Cron Trigger's ping target (spec:1157; ADR 0011)", () => {
  const server = startWorkerHealth(() => ["accounting.ledger.integrity_check", "admin.idempotency_key.purge"], 0);
  afterAll(() => server.stop());

  it("GET /healthz reports the jobs this build can run", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerHealth;
    expect(body.status).toBe("ok");
    expect(body.jobs).toEqual(["accounting.ledger.integrity_check", "admin.idempotency_key.purge"]);
    expect(Date.parse(body.startedAt)).not.toBeNaN();
  });

  it("serves nothing else — it is not an API", async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/companies`)).status).toBe(404);
  });
});
```

> **Runtime note.** `Bun.serve` and the `bun` global are Bun-only, and Vitest runs under Node 24 (D5). Run this one file under Bun: `apps/worker/package.json` gains `"test:bun": "bun test test/health.test.ts"`, and `apps/worker`'s `vitest.config.ts` `exclude` list gains `"test/health.test.ts"`. The root `test` pipeline calls both. Add `"types": ["node", "bun-types"]` to `apps/worker/tsconfig.json` if `Bun` is not already declared there.

Add that script and that `exclude` entry now, so the red run below is the module's absence and not a missing script.

Run: `cd apps/worker && bun run test:bun`
Expected: FAIL — `Cannot find module '../src/health'` (Bun resolves the specifier at import time, so both cases fail before the `describe` body runs). If it instead fails with `error: Script not found "test:bun"`, the `package.json` line above was not added.

Now `apps/worker/src/health.ts`:

```ts
/**
 * The `worker` container's only HTTP surface. Cloudflare Containers sleep after inactivity, so spec:1157 keeps
 * `worker` awake with a Cron Trigger that pings it every minute; a poller with no listener has nothing to ping.
 * It also makes §5.0 row 0.5's "a scheduled job runs in `worker` while `api` is idle" observable: the response
 * names the jobs this build has handlers for. Contract addition — ADR 0011.
 */
export interface WorkerHealth {
  readonly status: "ok";
  readonly jobs: readonly string[];
  readonly startedAt: string;
}

export function startWorkerHealth(jobs: () => readonly string[], port = Number(process.env["PORT"] ?? "8080")): { port: number; stop(): void } {
  const startedAt = new Date().toISOString();
  const server = Bun.serve({
    port,
    fetch(req) {
      if (new URL(req.url).pathname !== "/healthz") return new Response("not found", { status: 404 });
      const body: WorkerHealth = { status: "ok", jobs: jobs(), startedAt };
      return Response.json(body);
    },
  });
  return { port: server.port, stop: () => void server.stop(true) };
}
```

In `apps/worker/src/index.ts`, add the import beside the others and the call immediately after `log().info(…, "worker started")` — nothing else in that file changes:

```ts
import { startWorkerHealth } from "./health";
// … after the final log line:
startWorkerHealth(registeredJobNames);
```

Run: `cd apps/worker && bun run test:bun`
Expected: PASS — 2 tests.

If the second case returns 200 rather than 404, the `pathname` guard was written against `req.url` rather than the parsed URL: a query string would make `"/healthz?x=1"` unequal to `"/healthz"` in one direction and `"/v1/companies"` match a `startsWith` in the other.

- [ ] **Step 7: Run the manifest test, build the image, run both classes**

```bash
cd infra && bun run test && cd ..     # 4 entrypoint + 2 dockerfile tests, all green
docker build -f infra/Dockerfile -t dulja:local .
docker run --rm -e DULJA_ENTRYPOINT=wrker dulja:local ; echo "exit=$?"
docker run --rm -e DULJA_ENTRYPOINT=api dulja:local   # fails on config, which is the point
```

Expected: the build succeeds; the second command prints `unknown DULJA_ENTRYPOINT 'wrker' — expected api or worker` and `exit=2`; the third prints `DATABASE_URL is not set — see docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md §3.11` and exits 2 (0B's `ConfigError` path). **A container that starts without `DATABASE_URL` would be the defect** — the image is correct precisely because it refuses.

If the build fails at `bun install --frozen-lockfile` with "lockfile had changes", there are two causes and they are checked in this order. **First, a stale lockfile**: `bun.lock` was not regenerated after the root `workspaces` array gained `infra` (Step 1) — run `bun install` at the repository root and commit the result. **Second, a missing manifest**: the `deps` stage does not copy the `package.json` of a workspace `bun.lock` knows about — add its `COPY <ws>/package.json` line, which is what `infra/test/dockerfile.test.ts` fails on. If the build fails with `tsconfig.base.json: not found`, that file is at the repository root (plan0A) and the build context is not the root: re-run with `-f infra/Dockerfile … .`.

- [ ] **Step 8: Write ADR 0011**

`docs/adr/0011-container-topology.md`:

```markdown
# ADR 0011: Container topology as built — one image, two entrypoints, a health surface on the worker

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C · **Supersedes:** none

## Context

spec §3.2.4 fixes the shape: two container classes from one image with different entrypoints; `api` is a singleton
Durable Object id `"api"` with `sleepAfter: "10m"` reached only through the edge Worker's container binding; `worker`
must not sleep while jobs are pending and is kept awake by a Cron Trigger pinging it every minute. Plan 0D built
`apps/worker/src/index.ts` as a pure poller with no listener, so there was nothing for the Cron Trigger to ping and
no way to observe "a scheduled job runs in `worker` while `api` is idle" (§5.0 row 0.5).

## Decision

1. **One `Dockerfile` at `infra/Dockerfile`, built from the repository root**, with a `deps` stage that installs from
   the committed lockfile and a `runtime` stage that copies `packages/`, `apps/api` and `apps/worker`. No package
   version is written into the file beyond the base image tag (spec:104).
2. **`infra/entrypoint.sh` dispatches on `DULJA_ENTRYPOINT`** (`api` | `worker`; unset means `api`; anything else
   exits 2 naming the value). `exec` makes the process PID 1 so Cloudflare's SIGTERM reaches it.
3. **Both classes listen on 8080.** `api` because `readConfig()` defaults `PORT` to 8080 (Plan 0B); `worker` because
   this ADR adds `apps/worker/src/health.ts`, a `Bun.serve` answering `GET /healthz` with
   `{ status, jobs, startedAt }` and nothing else. It is not an API: it has no `/v1`, no auth and no database access.
4. **The image runs as a non-root user `dulja`.**

## Consequences

- The Cron Trigger has a real target and `wrangler` can report container health.
- `apps/worker` gains a Bun-only test file, excluded from the Vitest run and executed with `bun test`.
- A third container class in future is one more `case` in the entrypoint and one more class in `wrangler.jsonc`;
  nothing else changes.
- The health response deliberately lists **registered** job names, not the closed `JOBS` registry, so a deploy that
  forgot to register a handler is visible from outside the container.
```

- [ ] **Step 9: Run the toolchain and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green; `infra` and `apps/worker` suites pass.

```bash
git add -A
git commit -m "feat(infra): one container image with api and worker entrypoints, worker health surface (ADR 0011) [0C T1]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2 — **OWNER GATE OD-19**: Supabase provisioning, the posture probe, PITR, and the staging project

> **This task is isolated for owner decision OD-19** (contracts §2.12: "Supabase organisation access; PITR billing"; spec:2398, §5.3 row "0.2").
>
> **Owner provides:** access to a Supabase organisation with two projects in **Singapore** — `dulja-production` and `dulja-staging` — with **billing enabled so PITR can be turned on**, and, for each, the `postgres` connection string plus the passwords chosen for `app_migrator` and `app_rw`.
> **Verify with:** `DATABASE_URL="postgres://app_rw:…@db.<ref>.supabase.co:5432/postgres" DATABASE_URL_MIGRATOR="postgres://app_migrator:…@db.<ref>.supabase.co:5432/postgres" bun run --cwd packages/db provision:verify` — it must print exactly four lines: `rls-forced: ok`, `bypassrls-probe: refused`, `app_auth-login: refused`, `pooler-url: absent`.
> **Default written into this plan (executed until the owner answers):** the identical script runs against `startDb()` in `packages/db/test/provision-verify.test.ts` and must print the same four lines. **Nothing in this slice blocks on OD-19** — every later task's local verification uses Testcontainers.
> **If the owner declines PITR:** delete the PITR section of `docs/runbooks/supabase-provisioning.md`, change `tests/regression/legacy-081.test.ts`'s second `it` to `it.skip` with the reason, and tell 1B (whose restore drill is acceptance test 24) that its Task cannot run. Nothing else changes.
> **If the owner supplies one project instead of two:** `docs/runbooks/supabase-provisioning.md`'s staging section and `.github/workflows/deploy-staging.yml`'s `DATABASE_URL` secret are the only places `dulja-staging` is named.

**Files:**
- Create: `packages/db/provision/verify-supabase.ts`, `docs/runbooks/supabase-provisioning.md`, `tests/regression/legacy-081.test.ts`
- Modify: `packages/db/package.json` (script `provision:verify`, and the `exports` entry `"./provision/verify-supabase"` Task 14 needs), `tests/support/regression.ts` (the one additive `repoFile` helper of Step 5, over 0B's `REPO_ROOT` imported from `./source`)
- Test: `packages/db/test/provision-verify.test.ts`

**Interfaces:**
- Consumes: Plan 0A's `packages/db/provision/roles.sql`, `startDb`, `Db`; 0B's `createDb` / `PoolerUrlError`.
- Produces:

```ts
// packages/db/provision/verify-supabase.ts
export interface PostureCheck { readonly name: "rls-forced" | "bypassrls-probe" | "app_auth-login" | "pooler-url"; readonly ok: boolean; readonly detail: string }
/** The four assertions of §5.0 row 0.2 (spec:2311). `rwUrl` is the app_rw session-mode URL; `adminUrl` an
 *  app_migrator URL used only for catalog reads; `configFiles` the paths scanned for a ':6543' string. */
export async function verifySupabase(opts: { rwUrl: string; adminUrl: string; configFiles: readonly string[] }): Promise<readonly PostureCheck[]>;
/** `rls-forced: ok` / `bypassrls-probe: refused` / `app_auth-login: refused` / `pooler-url: absent`, one per line. */
export function formatPosture(checks: readonly PostureCheck[]): string;
/** Repository root, resolved from this file, so a caller's cwd never decides which files are scanned. */
export const REPO_ROOT: string;
/** The configs the script entrypoint scans for a `:6543` string. Two of the three are created later in this
 *  slice (Tasks 4 and 5), so the entrypoint scans those that exist and fails when none does. */
export const SCANNED_CONFIGS: readonly string[];
```

The four output words are frozen by contracts §5 hazard 5 and are asserted character for character in both the local test and the owner's cloud run.

- [ ] **Step 1: Write the failing test `packages/db/test/provision-verify.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatPosture, verifySupabase } from "../provision/verify-supabase";
import { startDb, type Db } from "./harness";

describe("provision/verify-supabase — §5.0 row 0.2 posture, proved locally (OWNER GATE OD-19)", () => {
  let db: Db;
  let clean: string;
  let dirty: string;

  beforeAll(async () => {
    db = await startDb();
    const dir = mkdtempSync(join(tmpdir(), "dulja-config-"));
    clean = join(dir, "clean.jsonc");
    dirty = join(dir, "dirty.jsonc");
    writeFileSync(clean, '{ "vars": { "DATABASE_URL": "postgres://app_rw@db.example.supabase.co:5432/postgres" } }');
    writeFileSync(dirty, '{ "vars": { "DATABASE_URL": "postgres://app_rw@aws-0.pooler.supabase.com:6543/postgres" } }');
  });
  afterAll(async () => { await db.stop(); });

  it("prints exactly the four lines contracts §5 hazard 5 fixes", async () => {
    const checks = await verifySupabase({ rwUrl: db.url("app_rw"), adminUrl: db.url("app_migrator"), configFiles: [clean] });
    expect(formatPosture(checks)).toBe(
      "rls-forced: ok\nbypassrls-probe: refused\napp_auth-login: refused\npooler-url: absent",
    );
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("every table in schema app has RLS enabled AND forced — the check names the first offender", async () => {
    const [row] = await verifySupabase({ rwUrl: db.url("app_rw"), adminUrl: db.url("app_migrator"), configFiles: [clean] });
    expect(row!.name).toBe("rls-forced");
    expect(row!.detail).toMatch(/^\d+ tables in schema app, all forced$/);
  });

  it("a :6543 string anywhere in a scanned config fails the pooler check and names the file", async () => {
    const checks = await verifySupabase({ rwUrl: db.url("app_rw"), adminUrl: db.url("app_migrator"), configFiles: [clean, dirty] });
    const pooler = checks.find((c) => c.name === "pooler-url")!;
    expect(pooler.ok).toBe(false);
    expect(pooler.detail).toContain("dirty.jsonc");
    expect(formatPosture(checks)).toContain("pooler-url: PRESENT");
  });

  it("app_rw cannot obtain BYPASSRLS and app_auth cannot log in (spec:1366)", async () => {
    const checks = await verifySupabase({ rwUrl: db.url("app_rw"), adminUrl: db.url("app_migrator"), configFiles: [clean] });
    expect(checks.find((c) => c.name === "bypassrls-probe")!.detail).toBe("app_rw rolbypassrls=false and set role refused");
    expect(checks.find((c) => c.name === "app_auth-login")!.detail).toBe("app_auth rolcanlogin=false, rolbypassrls=false");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/provision-verify.test.ts`
Expected: FAIL — `Failed to resolve import "../provision/verify-supabase"`.

- [ ] **Step 3: Write `packages/db/provision/verify-supabase.ts`**

```ts
/**
 * §5.0 row 0.2 (spec:2311) as a script, so the posture is *verified*, never assumed:
 *   "Connection from a local Bun script succeeds as `app_rw` on port 5432; a `BYPASSRLS` probe as `app_rw` fails;
 *    `app_auth` cannot log in and has no `BYPASSRLS`; a transaction-mode (6543) connection string is not present
 *    in any config."
 * It runs unchanged against Supabase and against the Testcontainers database, and must print the same four lines
 * (contracts §5 hazard 5). No `console` here — packages/db/src/cli.ts is the only place in this package that may
 * use it (plan0A:301); this file writes through process.stdout.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** Absolute, so a caller's cwd never decides which files are scanned. `packages/db/provision/` → repo root. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface PostureCheck {
  readonly name: "rls-forced" | "bypassrls-probe" | "app_auth-login" | "pooler-url";
  readonly ok: boolean;
  readonly detail: string;
}

const POOLER = /:6543\b/;

/** `app.permission` is deliberately outside RLS: it is a **global** catalogue with `grant select` for `app_rw`
 *  and no policy at all (plan0A:1310–1320; §3.5.3's `GLOBAL_TABLES`, which "never grows"). `tenant` and
 *  `principal` do carry RLS with their own named policies, so only this one name is exempt here. */
const NO_RLS_BY_DESIGN = new Set(["permission"]);

async function rlsForced(admin: postgres.Sql): Promise<PostureCheck> {
  const all = await admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app' and c.relkind in ('r', 'p')
     order by c.relname`;
  const rows = all.filter((r) => !NO_RLS_BY_DESIGN.has(r.relname));
  const bad = rows.find((r) => !r.relrowsecurity || !r.relforcerowsecurity);
  return bad
    ? { name: "rls-forced", ok: false, detail: `app.${bad.relname} is not RLS-enabled and forced` }
    : { name: "rls-forced", ok: true, detail: `${rows.length} tables in schema app, all forced` };
}

async function bypassProbe(rw: postgres.Sql, admin: postgres.Sql): Promise<PostureCheck> {
  const [attr] = await admin<{ bypass: boolean }[]>`select rolbypassrls as bypass from pg_roles where rolname = 'app_rw'`;
  if (attr?.bypass !== false) return { name: "bypassrls-probe", ok: false, detail: "app_rw has rolbypassrls=true" };
  // The attribute alone is not the proof: a role could reach BYPASSRLS through membership of another role.
  try {
    await rw`set role postgres`;
    return { name: "bypassrls-probe", ok: false, detail: "app_rw could `set role postgres`" };
  } catch {
    return { name: "bypassrls-probe", ok: true, detail: "app_rw rolbypassrls=false and set role refused" };
  }
}

async function authRole(admin: postgres.Sql): Promise<PostureCheck> {
  const [row] = await admin<{ canlogin: boolean; bypass: boolean }[]>`
    select rolcanlogin as canlogin, rolbypassrls as bypass from pg_roles where rolname = 'app_auth'`;
  if (!row) return { name: "app_auth-login", ok: false, detail: "role app_auth does not exist — run provision/roles.sql" };
  const ok = row.canlogin === false && row.bypass === false;
  return {
    name: "app_auth-login",
    ok,
    detail: ok ? "app_auth rolcanlogin=false, rolbypassrls=false" : `app_auth rolcanlogin=${row.canlogin}, rolbypassrls=${row.bypass}`,
  };
}

/** Every listed file must exist. Skipping a missing one would print `pooler-url: absent` while scanning nothing,
 *  which is a false pass on the one check whose whole job is to prove an absence. */
function poolerAbsent(files: readonly string[]): PostureCheck {
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    return { name: "pooler-url", ok: false, detail: `config file(s) not found: ${missing.join(", ")}` };
  }
  const hits = files.filter((f) => POOLER.test(readFileSync(f, "utf8")));
  return hits.length === 0
    ? { name: "pooler-url", ok: true, detail: `${files.length} config files scanned, no :6543` }
    : { name: "pooler-url", ok: false, detail: `transaction-mode pooler URL in ${hits.join(", ")}` };
}

export async function verifySupabase(opts: {
  rwUrl: string; adminUrl: string; configFiles: readonly string[];
}): Promise<readonly PostureCheck[]> {
  if (POOLER.test(opts.rwUrl)) throw new Error("the app_rw URL is itself a transaction-mode pooler URL (:6543) — spec §3.2.1");
  const quiet = { onnotice: () => {} } as const;
  const rw = postgres(opts.rwUrl, { max: 1, ...quiet });
  const admin = postgres(opts.adminUrl, { max: 1, ...quiet });
  try {
    return [await rlsForced(admin), await bypassProbe(rw, admin), await authRole(admin), poolerAbsent(opts.configFiles)];
  } finally {
    await Promise.all([rw.end(), admin.end()]);
  }
}

const WORD: Record<PostureCheck["name"], readonly [pass: string, fail: string]> = {
  "rls-forced": ["ok", "FAILED"],
  "bypassrls-probe": ["refused", "GRANTED"],
  "app_auth-login": ["refused", "PERMITTED"],
  "pooler-url": ["absent", "PRESENT"],
};

export function formatPosture(checks: readonly PostureCheck[]): string {
  return checks.map((c) => `${c.name}: ${WORD[c.name][c.ok ? 0 : 1]}`).join("\n");
}

/**
 * The configs the script scans. Two of the three do not exist yet when this file is written: `infra/wrangler.jsonc`
 * arrives in Task 4 and `.github/workflows/deploy-staging.yml` in Task 5. The entrypoint therefore scans the ones
 * that are present and **fails when none is** — which keeps `poolerAbsent`'s strictness (a listed-but-missing file
 * is still a hard failure inside `verifySupabase`) without making the command unusable between Tasks 2 and 5.
 */
export const SCANNED_CONFIGS: readonly string[] = [
  "infra/wrangler.jsonc",                      // Task 4
  ".github/workflows/deploy-staging.yml",      // Task 5
  ".github/workflows/ci.yml",                  // Plan 0A
];

// Script entrypoint: `bun run --cwd packages/db provision:verify`.
if (import.meta.main) {
  const rwUrl = process.env["DATABASE_URL"];
  const adminUrl = process.env["DATABASE_URL_MIGRATOR"];
  if (!rwUrl || !adminUrl) {
    process.stderr.write("DATABASE_URL (app_rw) and DATABASE_URL_MIGRATOR (app_migrator) are both required — §3.11\n");
    process.exit(2);
  }
  // Absolute paths from REPO_ROOT: `bun run --cwd packages/db provision:verify` and the CI job have different
  // working directories, and a relative path that silently missed would turn this check into a false pass.
  const files = SCANNED_CONFIGS.map((f) => join(REPO_ROOT, f)).filter((f) => existsSync(f));
  if (files.length === 0) {
    process.stderr.write(`none of ${SCANNED_CONFIGS.join(", ")} exists — nothing to scan, so 'pooler-url: absent' would be a false pass\n`);
    process.exit(1);
  }
  const checks = await verifySupabase({ rwUrl, adminUrl, configFiles: files });
  process.stdout.write(`${formatPosture(checks)}\n`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
```

`packages/db/package.json` scripts gain: `"provision:verify": "bun run provision/verify-supabase.ts"`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/db && bun run test -- test/provision-verify.test.ts`
Expected: PASS — 4 tests.

If `bypassrls-probe` reports `app_rw could set role postgres`, `provision/roles.sql` granted membership it should not have — re-read plan0A Task 3 Step 1; the role is created `nosuperuser nobypassrls nocreaterole` and is a member of nothing.

- [ ] **Step 5: Write `tests/regression/legacy-081.test.ts`**

`legacy-081` is *Backup and restore are manual, whole-file and destructive*. The **restore drill itself is 1B's** (acceptance test 24); 0C proves only that the mechanism the drill needs is enabled.

First, one additive export in 0B's `tests/support/regression.ts` — Vitest runs the `tests` workspace with its own directory as the cwd, so **every** repository path a regression file reads must be resolved, not written relative. All five 0C regression files use it:

```ts
// ── appended to tests/support/regression.ts by slice 0C ───────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./source";

/**
 * Reads a repository file as text. `REPO_ROOT` is **imported from `./source`, never redeclared**: 0B already
 * exports it there (its Task 14 `tests/support/source.ts`) and contracts §4.17.1 keeps that one — a second
 * `export const REPO_ROOT` here would be two spellings of one thing (hazard 9). Vitest's cwd is `tests/`, so a
 * bare "docs/…" would not resolve, which is why every 0C regression file goes through this helper.
 */
export function repoFile(relativePath: string): string { return readFileSync(join(REPO_ROOT, relativePath), "utf8"); }
```

`tests/regression/legacy-081.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { repoFile, sharedDb } from "../support/regression";

describe("LEGACY-081 Backup and restore are manual, whole-file and destructive — 0C", () => {
  it("continuous WAL archiving is possible: wal_level is not 'minimal' (spec:2234)", async () => {
    const { db } = await sharedDb();
    const [row] = await db.admin<{ wal_level: string }[]>`show wal_level`;
    expect(row!.wal_level).not.toBe("minimal");
  });

  it("the provisioning runbook enables PITR and names the RPO/RTO numbers spec:2233 requires", () => {
    const runbook = repoFile("docs/runbooks/supabase-provisioning.md");
    expect(runbook).toMatch(/Point-in-time recovery/i);
    expect(runbook).toMatch(/\*\*RPO\*\*/);
    expect(runbook).toMatch(/\*\*RTO\*\*/);
    // The drill that proves the numbers is 1B's (acceptance test 24) — this file asserts only that 0C left it a mechanism.
    expect(runbook).toMatch(/docs\/runbooks\/restore-drill\.md/);
  });
});
```

Run it now, before the runbook exists — the same red-first order every other task in this slice follows.

Run: `cd tests && bun run test -- regression/legacy-081.test.ts`
Expected: FAIL — the second case throws `ENOENT: no such file or directory, open '…/docs/runbooks/supabase-provisioning.md'` from `repoFile`. The first case (`wal_level`) passes already: it asserts a property of the database, not of this slice's work. A run in which **both** cases pass means `repoFile` resolved a path it should not have — check that it joins `REPO_ROOT` and not `process.cwd()`.

- [ ] **Step 6: Write `docs/runbooks/supabase-provisioning.md`**

```markdown
# Runbook — Supabase provisioning (spec §5.0 task 0.2; OWNER GATE OD-19)

**Region:** Singapore. **Projects:** `dulja-production` and `dulja-staging`, in the same organisation.
Nothing reaches production without passing through staging (spec:2272).

## 1. Create the project

1. New project, region **Singapore (ap-southeast-1)**, on a plan that includes **Point-in-time recovery**.
2. Record the project ref. The direct connection string is `postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres`.
3. **Do not** copy the "Transaction pooler" string (port 6543) anywhere. §3.2.1 rejects it: `SET` does not survive a
   transaction-mode pool, and RLS, the audit chain and document numbering all depend on session-scoped state.
   `createDb()` throws `ERR_DB_POOLER_URL` if it ever sees `:6543`, and `provision:verify` scans the configs for it.

## 2. Create the three roles

Connect **as `postgres`** (the project's own superuser-equivalent; it is not a real superuser, which is why
`app_auth` is created with no attributes — plan0A Task 3) and run the repository's own script unchanged:

```bash
psql "postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" -f packages/db/provision/roles.sql
psql "postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
  -c "alter role app_migrator password '<migrator-pw>'" \
  -c "alter role app_rw password '<rw-pw>'"
```

Passwords are never in the repository. Store them in the Cloudflare secret store (§3.11) and in the owner's
password manager; nothing else needs them.

## 3. Apply the migrations

```bash
DATABASE_URL_MIGRATOR="postgres://app_migrator:<migrator-pw>@db.<ref>.supabase.co:5432/postgres" \
  bun run --cwd packages/db db:migrate
DATABASE_URL_MIGRATOR="…" bun run --cwd packages/db db:lint      # must print `schema lint: 0 violations`
```

## 4. Verify the posture — the acceptance check for §5.0 row 0.2

```bash
DATABASE_URL="postgres://app_rw:<rw-pw>@db.<ref>.supabase.co:5432/postgres" \
DATABASE_URL_MIGRATOR="postgres://app_migrator:<migrator-pw>@db.<ref>.supabase.co:5432/postgres" \
  bun run --cwd packages/db provision:verify
```

Expected output, exactly:

```
rls-forced: ok
bypassrls-probe: refused
app_auth-login: refused
pooler-url: absent
```

Any other line is a provisioning defect, not a test defect.

The `pooler-url` line scans the configuration files listed in `SCANNED_CONFIGS` **that exist**. Two of them are
created later in this slice — `infra/wrangler.jsonc` at Task 4 and `.github/workflows/deploy-staging.yml` at
Task 5 — so between Tasks 2 and 5 the scan covers `.github/workflows/ci.yml` alone and still prints `absent`.
If none of the three exists the command exits 1 rather than printing a false pass.

## 5. Point-in-time recovery (LEGACY-081)

Enable **Point-in-time recovery** on the production project (Database → Backups → PITR). It requires billing,
which is the OD-19 half only the owner can supply.

- **RPO** (maximum acceptable data loss): **2 minutes** — the PITR write-ahead-log shipping interval.
- **RTO** (maximum acceptable time to restore): **4 hours** — restore to a fresh project, re-point `DATABASE_URL`,
  re-run `db:migrate` (a no-op) and `bun run seed`, redeploy.

These two numbers are stated so the drill has something to fail against. **The drill itself is slice 1B**
(acceptance test 24) and is written up in `docs/runbooks/restore-drill.md`; this runbook only guarantees the
mechanism exists. Quarterly cadence, per spec:2233.

## 6. Staging

Repeat sections 1–4 for `dulja-staging`. PITR is not required there. Staging is seeded from the same
`bun run seed` (never from a production dump; an anonymised snapshot arrives with Phase 9).
```

- [ ] **Step 7: Run everything and commit**

Run: `bun run lint && bun run typecheck && cd packages/db && bun run test -- test/provision-verify.test.ts && cd ../../tests && bun run test -- regression/legacy-081.test.ts`
Expected: PASS — 4 + 2 tests.

```bash
git add -A
git commit -m "feat(db): Supabase posture probe, provisioning runbook, PITR (OD-19) [0C T2]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `apps/edge` — the Cloudflare Worker: JWT pre-check, `RateLimit-*`, container forwarding, the R2 update feed

spec §5.2: "`edge/` — Cloudflare Worker: auth pre-check, rate limiting, update-feed delivery from R2, forward `/v1/*` to the container." spec §3.2.1 fixes the trust model in one sentence: "The container still **re-verifies every JWT itself**; the Worker's check is a pre-filter, not a trust boundary." Everything in this task is written to that sentence — the Worker never decides authority, never reads the database, and never adds a header the container would believe.

**Files:**
- Create: `apps/edge/package.json`, `apps/edge/tsconfig.json`, `apps/edge/vitest.config.ts`, `apps/edge/src/env.ts`, `apps/edge/src/log.ts`, `apps/edge/src/jwt-precheck.ts`, `apps/edge/src/rate-limit.ts`, `apps/edge/src/updates.ts`, `apps/edge/src/router.ts`, `apps/edge/src/containers.ts`, `apps/edge/src/index.ts`
- Modify: `infra/Dockerfile` (one `COPY` line — Step 6), `packages/contracts/src/errors.ts` (one `ERRORS` row — Step 4), `bun.lock` (the new workspace and its three dependencies — Steps 1 and 6)
- Test: `apps/edge/test/jwt-precheck.test.ts`, `apps/edge/test/rate-limit.test.ts`, `apps/edge/test/updates.test.ts`, `apps/edge/test/routing.test.ts`

**The runtime boundary this task's file layout exists to keep.** `@cloudflare/containers`' `Container` **extends `DurableObject`** (Cloudflare's Container-class reference), so importing it resolves `cloudflare:workers`, a module that does not exist under Node — and Vitest runs under Node 24 (D5). `apps/edge/src/containers.ts` and `apps/edge/src/index.ts` are therefore the **only** two modules that may import it, and **no test imports either of them**. Everything with behaviour worth asserting lives in `src/router.ts`, which is pure and takes its two container calls as injected functions; `src/index.ts` is the four-line composition root that supplies them. `containerSecrets` (Task 5) lives in `src/container-env.ts` for the same reason.

**Interfaces:**
- Consumes: nothing from `packages/*` — the Worker is at the app tier and must run on the Workers runtime, which has no `postgres.js` and no Node built-ins. It shares **names** with the rest of the system (`X-Request-Id`, `traceparent`) and no code.
- Produces:

```ts
// apps/edge/src/env.ts — the one place every binding name is written (§3.11 + this slice's additions)
export interface Env {
  readonly API: DurableObjectNamespace;        // container class `ApiContainer`
  readonly WORKER: DurableObjectNamespace;     // container class `WorkerContainer`
  readonly UPDATE_FEED: R2Bucket;              // electron-builder feed (§3.11)
  readonly ATTACHMENTS: R2Bucket;              // 2C attachments (§3.11) — bound here, unused until 2C
  readonly RATE_LIMIT: RateLimitBinding;       // Cloudflare's rate-limiting binding
  readonly APP_ENV: "dev" | "staging" | "production";
  readonly SUPABASE_JWT_ISSUER: string;
}
export interface RateLimitBinding { limit(opts: { key: string }): Promise<{ success: boolean }> }

// apps/edge/src/jwt-precheck.ts
export type PrecheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: "missing" | "malformed" | "expired" | "issuer" };
/** Structure only: three dot-separated segments, decodable header+payload, `exp` in the future, `iss` equal to
 *  the configured issuer. It never fetches JWKS and never verifies a signature — the container does that. */
export function precheckJwt(authorization: string | null, issuer: string, nowSeconds?: number): PrecheckResult;

// apps/edge/src/rate-limit.ts
export interface RateLimitOutcome { readonly allowed: boolean; readonly headers: Record<string, string> }
/** spec:2204 `RateLimit-*` headers. `key` is the JWT `sub` when the pre-check found one, else the client IP. */
export async function applyRateLimit(binding: RateLimitBinding, key: string, policy?: { limit: number; windowSeconds: number }): Promise<RateLimitOutcome>;

// apps/edge/src/updates.ts
/** GET /updates/<path> from the UPDATE_FEED R2 bucket. Read-only; 404 on a miss; no listing; path traversal refused. */
export async function serveUpdate(bucket: R2Bucket, pathname: string): Promise<Response>;

// apps/edge/src/router.ts — pure: no @cloudflare/containers import, so Vitest can load it under Node
export interface RouterDeps {
  /** Forwards a request to the `api` container. Bound in src/index.ts to getContainer(env.API, "api").fetch. */
  forward(request: Request): Promise<Response>;
  /** Pings the `worker` container's /healthz. Bound to getContainer(env.WORKER, "worker").fetch. */
  ping(): Promise<Response>;
}
export async function handleFetch(request: Request, env: Env, deps: RouterDeps): Promise<Response>;
export async function handleScheduled(env: Env, deps: RouterDeps): Promise<void>;

// apps/edge/src/containers.ts — imports @cloudflare/containers; never imported by a test
export class ApiContainer extends Container<Env> { defaultPort: number; sleepAfter: string; envVars: Record<string, string> }
export class WorkerContainer extends Container<Env> { defaultPort: number; sleepAfter: string; envVars: Record<string, string> }
```

- [ ] **Step 1: Create the `apps/edge` manifest, install its dependencies, and verify the `@cloudflare/containers` surface (assumption 7)**

`bun add --cwd apps/edge` writes into `apps/edge/package.json`, so that file has to exist first — and it has to keep the edges `bun add` records. A package that resolves only through hoisting is a phantom dependency, which the dependency-rule lint and Renovate both treat as a defect (Task 13 Step 1 says the same about `apps/api`).

```bash
mkdir -p apps/edge/src apps/edge/test
cat > apps/edge/package.json <<'JSON'
{
  "name": "@dulja/edge",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --config ../../infra/wrangler.jsonc",
    "deploy": "wrangler deploy --config ../../infra/wrangler.jsonc",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
JSON
bun add --cwd apps/edge @cloudflare/containers
bun add --cwd apps/edge --dev wrangler @cloudflare/workers-types
node -p "const p=require('path'),f=require('fs'),j=require('@cloudflare/containers/package.json');const d=p.dirname(require.resolve('@cloudflare/containers/package.json'));f.readFileSync(p.join(d, j.types ?? j.typings ?? 'dist/index.d.ts'),'utf8')" \
  | grep -nE "class Container|defaultPort|sleepAfter|getContainer|envVars|onStart|onStop"
node -p "require('@cloudflare/containers/package.json').version"
```

Write down verbatim, for ADR 0011 (Task 4 Step 6 appends them): the `Container` base class's exported name; the field names for the listening port and the idle timeout; and the exact signature of `getContainer`. The card freezes `getContainer(env.API, "api")` and `sleepAfter: "10m"`; if the installed version spells the **port** field differently, only `apps/edge/src/containers.ts` changes.

`apps/edge/package.json` after the two `bun add` calls — the manifest above plus the two blocks they wrote, with the versions the lockfile resolved (`^` ranges, exact numbers not written by hand — spec:104):

```json
  "dependencies": {
    "@cloudflare/containers": "^<resolved>"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^<resolved>",
    "wrangler": "^<resolved>"
  }
```

Writing that manifest makes `apps/edge` a workspace immediately: the root array's `"apps/*"` glob matches it, so no array edit is needed here (unlike `infra`, which is a literal entry Task 1 appends). Both `bun add` calls therefore rewrite the root `bun.lock` as well — **commit it with this task**, because `infra/Dockerfile`'s `deps` stage runs `bun install --frozen-lockfile` and Step 6's `docker build` fails on a lockfile that does not know the new workspace.

- [ ] **Step 2: Finish the scaffold and write the failing tests**

`apps/edge/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": ".", "noEmit": true, "types": ["@cloudflare/workers-types"], "lib": ["ES2023"] }, "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"] }`

`apps/edge/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

/** These suites test pure functions and hand-written stubs of the bindings — no Workers runtime, no network. */
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 } });
```

`apps/edge/test/jwt-precheck.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { precheckJwt } from "../src/jwt-precheck";

const ISSUER = "https://proj.supabase.co/auth/v1";
/** `btoa`, not `Buffer`: apps/edge/tsconfig.json sets `types: ["@cloudflare/workers-types"]`, which suppresses
 *  @types/node, and the Workers lib declares btoa. The payloads here are ASCII JSON, so btoa is exact. */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (payload: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
const NOW = 1_800_000_000;

describe("apps/edge/src/jwt-precheck — a pre-filter, never a trust boundary (spec:1150)", () => {
  it("accepts a structurally sound, unexpired token from the configured issuer", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60 })}`, ISSUER, NOW)).toEqual({ ok: true });
  });

  it("rejects a missing header without touching the container", () => {
    expect(precheckJwt(null, ISSUER, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(precheckJwt("Basic abc", ISSUER, NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a token that is not three decodable segments", () => {
    expect(precheckJwt("Bearer not.a.jwt", ISSUER, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(precheckJwt("Bearer onlyonesegment", ISSUER, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an expired token and a foreign issuer", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW - 1 })}`, ISSUER, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(precheckJwt(`Bearer ${token({ iss: "https://evil.example", exp: NOW + 60 })}`, ISSUER, NOW)).toEqual({ ok: false, reason: "issuer" });
  });

  it("does NOT judge aal — the container owns the aal2 gate (spec:2004); an aal1 token passes the pre-check", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60, aal: "aal1" })}`, ISSUER, NOW)).toEqual({ ok: true });
  });

  it("a forged signature still passes the pre-check — which is why the container re-verifies (spec:1150)", () => {
    expect(precheckJwt(`Bearer ${token({ iss: ISSUER, exp: NOW + 60 })}.tampered`, ISSUER, NOW).ok).toBe(false);
    expect(precheckJwt(`${b64({ alg: "none" })}.${b64({ iss: ISSUER, exp: NOW + 60 })}.`, ISSUER, NOW)).toEqual({ ok: false, reason: "missing" });
  });
});
```

`apps/edge/test/rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyRateLimit } from "../src/rate-limit";

const binding = (success: boolean) => ({ limit: async () => ({ success }) });

describe("apps/edge/src/rate-limit — the RateLimit-* headers of spec:2204", () => {
  it("an allowed request carries the three RateLimit headers and no Retry-After", async () => {
    const r = await applyRateLimit(binding(true), "sub-123", { limit: 100, windowSeconds: 60 });
    expect(r.allowed).toBe(true);
    expect(r.headers).toEqual({ "RateLimit-Limit": "100", "RateLimit-Remaining": "1", "RateLimit-Reset": "60" });
  });

  it("a refused request reports zero remaining and a Retry-After equal to the window", async () => {
    const r = await applyRateLimit(binding(false), "sub-123", { limit: 100, windowSeconds: 60 });
    expect(r.allowed).toBe(false);
    expect(r.headers["RateLimit-Remaining"]).toBe("0");
    expect(r.headers["Retry-After"]).toBe("60");
  });

  it("the default policy is stated, not implicit", async () => {
    const r = await applyRateLimit(binding(true), "1.2.3.4");
    expect(r.headers["RateLimit-Limit"]).toBe("600");
    expect(r.headers["RateLimit-Reset"]).toBe("60");
  });
});
```

`apps/edge/test/updates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serveUpdate } from "../src/updates";

const bucket = (present: Record<string, string>) => ({
  async get(key: string) {
    const body = present[key];
    return body === undefined ? null : { body: new Blob([body]).stream(), httpEtag: `"${key}"`, size: body.length };
  },
}) as unknown as R2Bucket;

describe("apps/edge/src/updates — the electron-builder feed from R2 (spec:1104, §5.2)", () => {
  it("serves a present object with its etag", async () => {
    const res = await serveUpdate(bucket({ "latest.yml": "version: 1.0.0" }), "/updates/latest.yml");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"latest.yml"');
    expect(await res.text()).toBe("version: 1.0.0");
  });

  it("404s a missing object without revealing whether the bucket has anything else", async () => {
    const res = await serveUpdate(bucket({}), "/updates/latest.yml");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("refuses path traversal and an empty key — the feed is not a file browser (LEGACY-038)", async () => {
    for (const p of ["/updates/../wrangler.jsonc", "/updates/a/../../b", "/updates/"]) {
      expect((await serveUpdate(bucket({}), p)).status).toBe(400);
    }
  });
});
```

`apps/edge/test/routing.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleFetch, handleScheduled, type RouterDeps } from "../src/router";
import type { Env } from "../src/env";

/** btoa, not Buffer — see the note in jwt-precheck.test.ts. */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ISSUER = "https://proj.supabase.co/auth/v1";
const good = `Bearer ${b64({ alg: "RS256" })}.${b64({ iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;

/**
 * The router takes its two container calls as functions, so this suite never imports `@cloudflare/containers`
 * (whose `Container` extends `DurableObject` and resolves `cloudflare:workers`, which Node has no idea about).
 * `src/index.ts` is the only module that binds these to `getContainer(...)`, and nothing tests it.
 */
function harness(): { env: Env; deps: RouterDeps; forward: ReturnType<typeof vi.fn>; ping: ReturnType<typeof vi.fn> } {
  const forward = vi.fn(async () => new Response("from the container", { status: 200 }));
  const ping = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    forward,
    ping,
    deps: { forward, ping },
    env: {
      API: {} as DurableObjectNamespace, WORKER: {} as DurableObjectNamespace,
      UPDATE_FEED: { async get() { return null; } } as unknown as R2Bucket,
      ATTACHMENTS: {} as R2Bucket,
      RATE_LIMIT: { limit: async () => ({ success: true }) },
      APP_ENV: "dev", SUPABASE_JWT_ISSUER: ISSUER,
    } as Env,
  };
}

describe("apps/edge/src/router — routing (spec §3.2.1, §5.2)", () => {
  it("forwards /v1/* to the api container and echoes X-Request-Id", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(new Request("https://api.example/v1/companies", { headers: { Authorization: good } }), env, deps);
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
  });

  it("mints a traceparent when the caller sent none, so the container and Postgres share one trace (spec:2245)", async () => {
    const { env, deps, forward } = harness();
    await handleFetch(new Request("https://api.example/v1/companies", { headers: { Authorization: good } }), env, deps);
    const forwarded = forward.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(forwarded.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses /v1/* with no token at the edge — 401, and the container is never called", async () => {
    const { env, deps, forward } = harness();
    const res = await handleFetch(new Request("https://api.example/v1/companies"), env, deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    // `res.json<T>()`, not a bare `res.json()`: `types: ["@cloudflare/workers-types"]` declares
    // `Body.json<T = unknown>()`, so the untyped form is `unknown` and `.instance` is TS18046 under the
    // `bun run typecheck` of Step 5. The generic is the library's own — no cast, no `any`.
    expect((await res.json<{ code: string; instance: string }>()).instance).toBe("/v1/companies");   // §4.2.4: instance is the request path
    expect(forward).not.toHaveBeenCalled();
  });

  it("strips client-supplied identity headers before forwarding — the edge never asserts identity (LEGACY-026)", async () => {
    const { env, deps, forward } = harness();
    await handleFetch(new Request("https://api.example/v1/companies", {
      headers: { Authorization: good, "X-Tenant-Id": "0192-forged", "X-Actor-Id": "0192-forged" },
    }), env, deps);
    const forwarded = forward.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("X-Tenant-Id")).toBeNull();
    expect(forwarded.headers.get("X-Actor-Id")).toBeNull();
    expect(forwarded.headers.get("Authorization")).toBe(good);
  });

  it("/healthz reaches the api container unauthenticated (§5.0 row 0.5)", async () => {
    const { env, deps, forward } = harness();
    expect((await handleFetch(new Request("https://api.example/healthz"), env, deps)).status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
  });

  it("/updates/* is served from R2 and never reaches a container — the feed is a PATH, not a host", async () => {
    const { env, deps, forward } = harness();
    expect((await handleFetch(new Request("https://api.example/updates/latest.yml"), env, deps)).status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it("anything else is 404 — the Worker is not a website", async () => {
    const { env, deps } = harness();
    expect((await handleFetch(new Request("https://api.example/"), env, deps)).status).toBe(404);
  });

  it("the scheduled handler pings the worker container, never the api one (spec:1157)", async () => {
    const { env, deps, forward, ping } = harness();
    await handleScheduled(env, deps);
    expect(ping).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/edge && bun run test`
Expected: FAIL — four files cannot resolve `../src/*`.

- [ ] **Step 4: Register `ERR_RATE_LIMITED`, then write the seven source modules**

The Worker raises a 429 that §4.2.4's allocated table already carries (contracts §4.18 round 1; Task 1 Step 0 confirmed the row is there). This is the second half of that rule — "and to `ERRORS` in the PR that raises it" (contracts:1511). Add one row to `packages/contracts/src/errors.ts`, beside the codes 0B shipped:

```ts
  ERR_RATE_LIMITED: {
    status: 429,
    title: "Too Many Requests",
    remedy: "Wait for the RateLimit-Reset window and retry.",
  },
```

The `error-codes` build check (0B, §4.2.4) fails on a code in `ERRORS` that nothing raises; `apps/edge/src/router.ts` below raises it, in the same commit, so the check stays green.

`apps/edge/src/env.ts`:

```ts
/** Every binding name the Worker uses, in one place. §3.11 fixes ATTACHMENTS and UPDATE_FEED; API, WORKER and
 *  RATE_LIMIT are this slice's additions and are declared in infra/wrangler.jsonc under exactly these names. */
export interface RateLimitBinding { limit(opts: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  readonly API: DurableObjectNamespace;
  readonly WORKER: DurableObjectNamespace;
  readonly UPDATE_FEED: R2Bucket;
  readonly ATTACHMENTS: R2Bucket;
  readonly RATE_LIMIT: RateLimitBinding;
  readonly APP_ENV: "dev" | "staging" | "production";
  readonly SUPABASE_JWT_ISSUER: string;
}
```

`apps/edge/src/log.ts`:

```ts
/** The Workers runtime has no `process.stdout`, so this is the one place in the repository that calls `console`
 *  outside a CLI or a test (contracts §3.9 Logging; assumption 8 of this plan). Fields match spec:2063; the
 *  Worker knows no tenant or actor, so it emits `request_id` and `trace_id` only — never a token. */
export function edgeLog(fields: Record<string, string | number>, msg: string): void {
  // oxlint-disable-next-line no-console -- Workers have no process.stdout; the single logging seam of apps/edge
  console.log(JSON.stringify({ level: "info", msg, ...fields, time: new Date().toISOString() }));
}
```

`apps/edge/src/jwt-precheck.ts`:

```ts
import type { PrecheckResult } from "./env";

export type { PrecheckResult } from "./env";

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const json = atob(seg.replace(/-/g, "+").replace(/_/g, "/"));
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * spec:1150: "The container still re-verifies every JWT itself; the Worker's check is a pre-filter, not a trust
 * boundary." So this function does four cheap things and no more — it never fetches JWKS, never verifies a
 * signature, and never inspects `aal` (the aal2 gate is the container's, spec:2004). Its only job is to keep
 * obviously dead traffic off the container.
 */
export function precheckJwt(
  authorization: string | null,
  issuer: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PrecheckResult {
  if (!authorization || !authorization.startsWith("Bearer ")) return { ok: false, reason: "missing" };
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false, reason: "malformed" };
  const header = decodeSegment(parts[0]!);
  const payload = decodeSegment(parts[1]!);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  const exp = payload["exp"];
  if (typeof exp !== "number" || exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload["iss"] !== issuer) return { ok: false, reason: "issuer" };
  return { ok: true };
}

/** The `sub` claim if the token has one, for the rate-limit key. Never used as identity. */
export function subjectHint(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const payload = decodeSegment(authorization.slice(7).split(".")[1] ?? "");
  const sub = payload?.["sub"];
  return typeof sub === "string" ? sub : null;
}
```

Add to `apps/edge/src/env.ts`:

```ts
export type PrecheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: "missing" | "malformed" | "expired" | "issuer" };
```

`apps/edge/src/rate-limit.ts`:

```ts
import type { RateLimitBinding } from "./env";

export interface RateLimitOutcome { readonly allowed: boolean; readonly headers: Record<string, string> }

/** spec:2204 "Rate limits with `RateLimit-*` headers (v1 for abuse protection; per-plan quotas deferred)".
 *  Cloudflare's binding reports only success/failure, not a remaining count, so `RateLimit-Remaining` is 1 or 0 —
 *  honest about what is known rather than a fabricated number. Per-plan quotas are Phase 4.4, deferred. */
export const DEFAULT_POLICY = { limit: 600, windowSeconds: 60 } as const;

export async function applyRateLimit(
  binding: RateLimitBinding,
  key: string,
  policy: { limit: number; windowSeconds: number } = DEFAULT_POLICY,
): Promise<RateLimitOutcome> {
  const { success } = await binding.limit({ key });
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(policy.limit),
    "RateLimit-Remaining": success ? "1" : "0",
    "RateLimit-Reset": String(policy.windowSeconds),
  };
  if (!success) headers["Retry-After"] = String(policy.windowSeconds);
  return { allowed: success, headers };
}
```

`apps/edge/src/updates.ts`:

```ts
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * The electron-builder update feed (spec §5.2, §3.2.1). Read-only, keyed, never a listing: attachments and
 * artefacts are addressed by opaque server-generated keys, never by a client-supplied path (LEGACY-038). 0E's
 * auto-updater points at `https://<domain>/updates/`.
 */
export async function serveUpdate(bucket: R2Bucket, pathname: string): Promise<Response> {
  const key = pathname.slice("/updates/".length);
  if (key.length === 0 || !SAFE_KEY.test(key)) return new Response("bad request", { status: 400 });
  const object = await bucket.get(key);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: { ETag: object.httpEtag, "Cache-Control": "public, max-age=60" },
  });
}
```

`apps/edge/src/containers.ts`:

```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/**
 * spec §3.2.4. One instance per environment for v1 (the singleton DO id "api"); it sleeps after ten minutes of
 * inactivity and wakes on the next forwarded request. Field names verified against the installed
 * @cloudflare/containers in Task 3 Step 1 and recorded in ADR 0011.
 */
export class ApiContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override envVars = { DULJA_ENTRYPOINT: "api" };
}

/**
 * "must not sleep while jobs are pending. Keep it awake with a Cloudflare Cron Trigger every minute that pings
 * the `worker` container (`sleepAfter` set long)" — spec:1157. Twenty-four hours is "long" against a one-minute
 * ping: the container only sleeps if the Cron Trigger itself has been broken for a day, which is an alert, not a
 * normal state.
 */
export class WorkerContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "24h";
  override envVars = { DULJA_ENTRYPOINT: "worker" };
}
```

`apps/edge/src/router.ts` — all of the Worker's behaviour, and **nothing from `@cloudflare/containers`**, so Vitest can load it under Node:

```ts
import type { Env } from "./env";
import { precheckJwt, subjectHint } from "./jwt-precheck";
import { applyRateLimit } from "./rate-limit";
import { serveUpdate } from "./updates";
import { edgeLog } from "./log";

/** The two container calls, injected. src/index.ts binds them to getContainer(...); a test binds them to stubs. */
export interface RouterDeps {
  forward(request: Request): Promise<Response>;
  ping(): Promise<Response>;
}

/** Headers a client must never be able to assert. The container derives tenant and actor from the verified JWT
 *  alone (spec §3.8); forwarding a client-supplied value would be LEGACY-026 rebuilt at the edge. */
const STRIPPED = ["x-tenant-id", "x-actor-id", "x-principal-id", "x-forwarded-authorization"] as const;

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The Worker cannot import `@dulja/contracts` (§3.1 puts it at the package tier and the Workers bundle must stay
 * dependency-free), so it hand-builds the §4.2.4 envelope with two codes: `ERR_AUTH_TOKEN_INVALID`, already
 * registered, and `ERR_RATE_LIMITED`, allocated in §4.2.4's table (verified by Task 1 Step 0) and added to `ERRORS` in this
 * task's Step 4 — the table first, the `ERRORS` row in the PR that raises it (contracts:1511, hazard 32).
 * `instance` is the request path, exactly as §4.2.4 defines it — never a fixed string.
 */
function problem(status: number, code: string, detail: string, instance: string, requestId: string, headers: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      type: `urn:dulja:error:${code}`, title: status === 401 ? "Unauthorized" : "Too Many Requests",
      status, detail, instance, code,
      remedy: status === 401 ? "Sign in again and retry with a current token." : "Wait for the RateLimit-Reset window and retry.",
      requestId,
    }),
    { status, headers: { ...headers, "Content-Type": "application/problem+json", "X-Request-Id": requestId } },
  );
}

export async function handleFetch(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  // One trace across Worker → container → Postgres (spec:2245). The container's request-id middleware reads
  // `traceparent` (Plan 0B) and OTel (Task 13) continues this span rather than starting a new trace.
  const traceparent = request.headers.get("traceparent") ?? `00-${hex(16)}-${hex(8)}-01`;

  // The update feed is a PATH under the API host, `https://api.<domain>/updates/…` — not its own hostname.
  // 0E's auto-updater consumes exactly that URL, and docs/runbooks/deploy.md states it once (Task 5).
  if (url.pathname.startsWith("/updates/")) return serveUpdate(env.UPDATE_FEED, url.pathname);

  const isApi = url.pathname.startsWith("/v1/");
  const isHealth = url.pathname === "/healthz";
  if (!isApi && !isHealth) return new Response("not found", { status: 404 });

  const auth = request.headers.get("Authorization");
  const rate = await applyRateLimit(env.RATE_LIMIT, subjectHint(auth) ?? request.headers.get("CF-Connecting-IP") ?? "anon");
  if (!rate.allowed) return problem(429, "ERR_RATE_LIMITED", "Too many requests from this client.", url.pathname, requestId, rate.headers);

  if (isApi) {
    const pre = precheckJwt(auth, env.SUPABASE_JWT_ISSUER);
    if (!pre.ok) {
      edgeLog({ request_id: requestId, trace_id: traceparent.split("-")[1] ?? "", path: url.pathname, reason: pre.reason }, "edge precheck refused");
      return problem(401, "ERR_AUTH_TOKEN_INVALID", `The bearer token is ${pre.reason}.`, url.pathname, requestId, rate.headers);
    }
  }

  const headers = new Headers(request.headers);
  for (const h of STRIPPED) headers.delete(h);
  headers.set("X-Request-Id", requestId);
  headers.set("traceparent", traceparent);

  const response = await deps.forward(new Request(request.url, { method: request.method, headers, body: request.body }));
  const out = new Headers(response.headers);
  for (const [k, v] of Object.entries(rate.headers)) out.set(k, v);
  out.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, headers: out });
}

/** spec:1157 — one ping a minute keeps the `worker` container awake while pg-boss polls inside it. */
export async function handleScheduled(_env: Env, deps: RouterDeps): Promise<void> {
  const res = await deps.ping();
  edgeLog({ status: res.status, container: "worker" }, "cron ping");
}
```

`apps/edge/src/index.ts` — the composition root, and the only module besides `containers.ts` that imports `@cloudflare/containers`. Nothing imports **this** file except Wrangler:

```ts
import { getContainer } from "@cloudflare/containers";
import type { Env } from "./env";
import { handleFetch, handleScheduled, type RouterDeps } from "./router";

export { ApiContainer, WorkerContainer } from "./containers";

/** The two real container calls. `getContainer(env.API, "api")` is the frozen form of the §2.1 0C card. */
function containerDeps(env: Env): RouterDeps {
  return {
    forward: (request) => getContainer(env.API, "api").fetch(request),
    ping: () => getContainer(env.WORKER, "worker").fetch(new Request("https://worker.internal/healthz")),
  };
}

export default {
  fetch: (request: Request, env: Env) => handleFetch(request, env, containerDeps(env)),
  scheduled: (_controller: ScheduledController, env: Env) => handleScheduled(env, containerDeps(env)),
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the edge tests to verify they pass**

Run: `cd apps/edge && bun run test && bun run typecheck`
Expected: PASS — 6 + 3 + 3 + 8 = 20 tests; typecheck exits 0.

If any suite fails with `Cannot find module 'cloudflare:workers'`, a test file has reached `src/containers.ts` or `src/index.ts` — directly, or through an import chain. Nothing under `apps/edge/test/` may import either; the behaviour under test lives in `src/router.ts`.
If `typecheck` reports `Cannot find name 'Buffer'`, a test still uses the Node helper: both `b64` helpers are `btoa`-based, because `types: ["@cloudflare/workers-types"]` suppresses `@types/node` and `src/**` must not gain Node globals.
If `precheckJwt` accepts `alg: "none"`, the header segment decoded but the signature segment was empty — the `parts.some((p) => p.length === 0)` guard is the one that catches it.

- [ ] **Step 6: Add `apps/edge` to the image's manifest list, run the toolchain, commit**

`apps/edge` is now a workspace (the root array's `"apps/*"` glob matched it the moment Step 1 wrote the manifest), so `bun install --frozen-lockfile` inside the container image needs its manifest. Add one line to `infra/Dockerfile`'s `deps` stage, beside the others:

```dockerfile
COPY apps/edge/package.json           apps/edge/package.json
```

The `runtime` stage is unchanged — the edge Worker runs on Cloudflare, never in the container.

Then make sure the lockfile the image installs from knows the new workspace:

```bash
bun install                    # a no-op if Step 1's two `bun add` calls already wrote bun.lock
git status --short bun.lock    # if it is dirty, commit it with this task
```

`--frozen-lockfile` fails on a `bun.lock` that predates `apps/edge`, and that failure surfaces inside `docker build` rather than at the workspace edit, which is why the check is here rather than left to CI.

Run: `cd infra && bun run test && cd .. && docker build -f infra/Dockerfile -t dulja:local . && bun run lint && bun run lint:rules && bun run format:check && bun run typecheck`
Expected: green — `infra/test/dockerfile.test.ts` (Task 1 Step 5) fails until the `COPY apps/edge/package.json` line above exists, which is the point of that test. `lint:rules` must report zero `dependency-rule` violations — `apps/edge` imports no other app and no package (§3.1).

```bash
git add -A
git commit -m "feat(edge): Cloudflare Worker — JWT pre-check, RateLimit-* (ERR_RATE_LIMITED), container forwarding, R2 update feed [0C T3]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4 — **OWNER GATE OD-20**: `wrangler.jsonc`, the two container classes, the Cron Trigger, and §5.0 row 0.5

> **This task is isolated for owner decision OD-20** (contracts §2.12: "Cloudflare account with Containers; a domain"; spec:2399, §5.3 row "0.5").
>
> **Owner provides:** a Cloudflare account with **Containers enabled** and a **domain** for the API and the update feed (the plan writes `dulja.example` throughout; the owner's domain replaces that one string), plus the account id and an API token with Workers, Containers and R2 scope.
> **Verify with:** `bun run --cwd apps/edge deploy` then `curl -si https://api.<domain>/healthz | head -1` → `HTTP/2 200`, and `curl -si https://<container-host>/healthz` → connection refused / no such host (**the container has no public ingress**, spec:1156).
> **Default written into this plan (executed until the owner answers):** `wrangler dev --config infra/wrangler.jsonc` runs the Worker and both container classes locally against the image Task 1 built, and the same two `curl` lines are run against `http://127.0.0.1:8787`. Every assertion of §5.0 row 0.5 is verified there.
> **If the owner's domain differs:** the string `dulja.example` appears in exactly three places — `infra/wrangler.jsonc` (`routes`), `docs/runbooks/deploy.md` and 0E's update-feed URL. Nothing else changes.
> **If Containers are unavailable on the owner's plan:** stop and raise it as an ADR proposal (spec:95). §3.2.1 rejected a plain Worker for the ledger API on four separate grounds; a Worker-only deployment is a re-decision of D-level architecture, not a plan edit.

**Files:**
- Create: `infra/wrangler.jsonc`, `infra/renovate.json`, `infra/test/wrangler.test.ts`
- Modify: `docs/adr/0011-container-topology.md` (append the verified-facts section)
- Test: `infra/test/wrangler.test.ts`

**Interfaces:**
- Consumes: Task 1's `infra/Dockerfile` and `DULJA_ENTRYPOINT` contract; Task 3's `ApiContainer`, `WorkerContainer` and `Env` binding names.
- Produces: `infra/wrangler.jsonc` — the single deployment description for `dulja-edge`, both container classes, the `* * * * *` Cron Trigger, the two R2 bindings, the rate-limit binding and the plain-text vars. **Secrets are never in this file** (spec:2273); they are set with `wrangler secret put`.

- [ ] **Step 1: Write the failing test `infra/test/wrangler.test.ts`**

The configuration is data, so it is tested as data — every claim §5.0 row 0.5 and §3.11 make about it is one assertion. This is what stops a silent edit from turning `sleepAfter` into a default or dropping the Cron Trigger.

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8");
/** JSONC: strip // and /* *\/ comments before parsing. Trailing commas are not used in this file. */
const config = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")) as Record<string, any>;

describe("infra/wrangler.jsonc — §5.0 row 0.5 and §3.11, asserted as data", () => {
  it("declares one Worker with both container classes from the one image", () => {
    expect(config["name"]).toBe("dulja-edge");
    expect(config["main"]).toBe("../apps/edge/src/index.ts");
    const classes = config["containers"] as { class_name: string; image: string; image_build_context: string; max_instances: number }[];
    expect(classes.map((c) => c.class_name).sort()).toEqual(["ApiContainer", "WorkerContainer"]);
    expect(new Set(classes.map((c) => c.image))).toEqual(new Set(["./Dockerfile"]));
    // Wrangler's default build context is the directory of `image` — here `infra/`. infra/Dockerfile is written
    // to be built from the repository ROOT (`COPY package.json`, `COPY apps/api …`), so the context is overridden.
    expect(new Set(classes.map((c) => c.image_build_context))).toEqual(new Set([".."]));
    expect(classes.every((c) => c.max_instances === 1)).toBe(true);   // one instance per environment for v1 (spec:1156)
  });

  it("routes the API host only — the update feed is a path under it, which is what 0E consumes", () => {
    const patterns = (config["routes"] as { pattern: string }[]).map((r) => r.pattern);
    expect(patterns).toEqual(["api.dulja.example/*"]);
    const production = (config["env"]["production"]["routes"] as { pattern: string }[]).map((r) => r.pattern);
    expect(production).toEqual(["api.dulja.example/*"]);
    // A second hostname would 404 every request: apps/edge/src/router.ts keys the feed on the /updates/ PATH.
    expect(raw).not.toMatch(/updates\.dulja\.example/);
  });

  it("binds both container classes as Durable Objects under the names apps/edge/src/env.ts declares", () => {
    const bindings = (config["durable_objects"]["bindings"] as { name: string; class_name: string }[]);
    expect(bindings).toEqual([
      { name: "API", class_name: "ApiContainer" },
      { name: "WORKER", class_name: "WorkerContainer" },
    ]);
  });

  it("keeps the worker awake with a one-minute Cron Trigger (spec:1157)", () => {
    expect(config["triggers"]["crons"]).toEqual(["* * * * *"]);
  });

  it("binds both R2 buckets under the §3.11 names", () => {
    const r2 = (config["r2_buckets"] as { binding: string; bucket_name: string }[]).map((b) => b.binding).sort();
    expect(r2).toEqual(["ATTACHMENTS", "UPDATE_FEED"]);
  });

  it("declares the rate-limit binding spec:2204 needs", () => {
    expect((config["ratelimits"] as { name: string }[])[0]!.name).toBe("RATE_LIMIT");
  });

  it("holds no secret: no password, no service-role key, no connection string (spec:2273)", () => {
    expect(raw).not.toMatch(/postgres:\/\//);
    expect(raw).not.toMatch(/SERVICE_ROLE|password|SENTRY_DSN\s*"?\s*:\s*"[^"]+"/i);
    expect(Object.keys(config["vars"] as Record<string, unknown>).sort()).toEqual(["APP_ENV", "LOG_LEVEL"]);
  });

  it("names no transaction-mode pooler URL anywhere (§5.0 row 0.2)", () => {
    expect(raw).not.toMatch(/:6543\b/);
  });

  it("observability is on, so the Worker's own logs reach the dashboard (spec:2243)", () => {
    expect(config["observability"]["enabled"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd infra && bun run test -- test/wrangler.test.ts`
Expected: FAIL — `ENOENT … infra/wrangler.jsonc`.

- [ ] **Step 3: Write `infra/wrangler.jsonc`**

```jsonc
{
  // Deployment description for the Dulja edge Worker and its two container classes (spec §3.2.4).
  // Secrets are NEVER here (spec:2273) — set them with `wrangler secret put <NAME>`; the inventory is §3.11.
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dulja-edge",
  "main": "../apps/edge/src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "observability": { "enabled": true },

  // The owner's domain (OD-20). This string, docs/runbooks/deploy.md and 0E's update-feed URL are the only
  // places it appears. ONE hostname: the electron-builder feed is the path `/updates/*` under it, because
  // apps/edge/src/router.ts keys the R2 object on that path prefix. A second host would 404 every request.
  "routes": [
    { "pattern": "api.dulja.example/*", "zone_name": "dulja.example" }
  ],

  // One image, two classes, different DULJA_ENTRYPOINT — infra/Dockerfile, infra/entrypoint.sh (ADR 0011).
  // `image_build_context` is ".." — relative to THIS file, i.e. the repository root. Wrangler's default is the
  // directory of `image` (here infra/), and infra/Dockerfile's first instruction is `COPY package.json bun.lock`,
  // which only resolves from the root. Without this line `wrangler dev` and `wrangler deploy` both fail the build.
  // The containers have NO public ingress: they are reachable only through the Durable Object bindings below,
  // which is spec:1156's answer to "how does the Worker authenticate to the container".
  "containers": [
    {
      "class_name": "ApiContainer",
      "image": "./Dockerfile",
      "image_build_context": "..",
      "max_instances": 1,
      "instance_type": "standard"
    },
    {
      "class_name": "WorkerContainer",
      "image": "./Dockerfile",
      "image_build_context": "..",
      "max_instances": 1,
      "instance_type": "standard"
    }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "API", "class_name": "ApiContainer" },
      { "name": "WORKER", "class_name": "WorkerContainer" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ApiContainer", "WorkerContainer"] }
  ],

  // spec:1157 — one ping a minute so the worker container never sleeps while pg-boss has work.
  "triggers": { "crons": ["* * * * *"] },

  "r2_buckets": [
    { "binding": "UPDATE_FEED", "bucket_name": "dulja-update-feed" },
    { "binding": "ATTACHMENTS", "bucket_name": "dulja-attachments" }
  ],

  // spec:2204 — RateLimit-* headers for abuse protection; per-plan quotas are deferred (§4.4).
  "ratelimits": [
    { "name": "RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 600, "period": 60 } }
  ],

  // Plain-text configuration only. DATABASE_URL, SUPABASE_*, SENTRY_DSN and OTEL_* are secrets.
  "vars": { "APP_ENV": "staging", "LOG_LEVEL": "info" },

  "env": {
    "production": {
      "vars": { "APP_ENV": "production", "LOG_LEVEL": "info" },
      "routes": [
        { "pattern": "api.dulja.example/*", "zone_name": "dulja.example" }
      ]
    }
  }
}
```

`infra/renovate.json` (spec:2270 "Dependency update automation (Renovate) with a patch SLA"):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":semanticCommits", ":dependencyDashboard"],
  "timezone": "Asia/Kuala_Lumpur",
  "schedule": ["before 6am on monday"],
  "labels": ["dependencies"],
  "packageRules": [
    { "matchUpdateTypes": ["patch"], "automerge": true, "description": "the patch SLA of spec:2270" },
    { "matchUpdateTypes": ["minor", "major"], "automerge": false },
    { "matchPackageNames": ["postgres", "pg-boss", "decimal.js"], "automerge": false,
      "description": "money, transactions and jobs: a human reads every bump" }
  ],
  "vulnerabilityAlerts": { "labels": ["security"], "automerge": false }
}
```

Move it to the repository root as `renovate.json` is **not** done — spec §5.2 places Renovate under `infra/`, and Renovate reads `infra/renovate.json` when the repository sets `"configFileNames"`; the deploy runbook records that the owner points Renovate at this path when installing the app.

- [ ] **Step 4: Run the config test to verify it passes**

Run: `cd infra && bun run test`
Expected: PASS — 4 (entrypoint) + 2 (dockerfile) + 9 (wrangler) tests.

If `wrangler dev` in Step 5 fails at `docker build` with `"/package.json": not found`, `image_build_context` is missing or wrong: it is `".."` relative to `infra/wrangler.jsonc`, i.e. the repository root.
If the JSONC parse throws, a comment line contains `://` — the strip regex deliberately keeps `https://` intact by requiring a non-`:` character before `//`; move the comment to its own line.

- [ ] **Step 5: Prove §5.0 row 0.5 — locally now, on the owner's account when OD-20 lands**

**Local (the default this plan executes):**

```bash
docker build -f infra/Dockerfile -t dulja:local .
cd apps/edge && bun run dev &         # wrangler dev --config ../../infra/wrangler.jsonc
sleep 20
curl -si http://127.0.0.1:8787/healthz | head -1                       # → HTTP/1.1 200 OK
curl -si http://127.0.0.1:8787/v1/companies | head -1                  # → HTTP/1.1 401 Unauthorized
curl -si http://127.0.0.1:8787/updates/latest.yml | head -1            # → HTTP/1.1 404 Not Found (empty bucket)
docker ps --format '{{.Ports}}' | grep -c '0.0.0.0'                    # → 0: no container publishes a host port
```

Then wait one minute and confirm the Cron Trigger fired without any request to `api`:

```bash
# wrangler dev's console shows `cron ping` once a minute (apps/edge/src/log.ts).
curl -s http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*                # wrangler dev's scheduled-trigger endpoint
```

**Cloud (OWNER GATE OD-20, one line when the account exists):**

```bash
bun run --cwd apps/edge deploy
curl -si https://api.dulja.example/healthz | head -1                    # → HTTP/2 200
curl -si https://api.dulja.example/v1/companies | head -1               # → HTTP/2 401
```

Record the three results in the PR body. §5.0 row 0.5's third clause — "deploy is one command" — is `bun run --cwd apps/edge deploy`, and Task 5 makes CI run exactly that.

If `wrangler dev` reports "containers are not supported in this account", that is the OD-20 gate, not a defect: the local build still proves the image and the routing, and the cloud lines wait.

- [ ] **Step 6: Append the verified facts to ADR 0011**

Append to `docs/adr/0011-container-topology.md`:

```markdown
## Verified facts (from `@cloudflare/containers` <VERSION>, recorded 2026-09-05)

| Question | Answer as installed |
|---|---|
| Base class | `Container<Env>` exported from `@cloudflare/containers` |
| Listening-port field | `defaultPort` |
| Idle-timeout field | `sleepAfter` (a duration string, e.g. `"10m"`) |
| Container-scoped environment | `envVars` |
| Accessor | `getContainer(namespace, name)` |

**Values chosen.** `ApiContainer`: `defaultPort 8080`, `sleepAfter "10m"` (spec:1156), `max_instances 1`.
`WorkerContainer`: `defaultPort 8080`, `sleepAfter "24h"` — spec:1157 says "`sleepAfter` set long" and keeps the
container awake with a one-minute Cron Trigger; a 24-hour idle timeout means the container sleeps only if the
Cron Trigger has been broken for a whole day, which is an alarm rather than a normal state.

**No public ingress.** Neither class appears in `routes`; both are reached only through the `API` / `WORKER`
Durable Object bindings. That is spec:1156's answer to "how does the Worker authenticate to the container": it
does not need to, because nothing else can reach it — and the container still re-verifies every JWT (spec:1150).
```

Replace `<VERSION>` with the version Step 1 printed.

- [ ] **Step 7: Run everything and commit**

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```bash
git add -A
git commit -m "feat(infra): wrangler config, two container classes, cron trigger, Renovate (OD-20) [0C T4]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: deploy to staging in one command — the workflow, the secret inventory, `jobs:install`, and the deploy runbook

§5.0 row 0.5's third clause is "deploy is one command". This task makes that command a GitHub Actions job beside Plan 0A's `checks`, wires the §3.11 secret inventory as Cloudflare bindings (spec:2273), and adds the two deploy steps that are not `wrangler deploy`: the migration runner and `bun run --cwd apps/worker jobs:install` (§4.2.6 — pg-boss's own tables are installed once per environment as `app_migrator`, never by application code).

**Files:**
- Create: `.github/workflows/deploy-staging.yml`, `docs/runbooks/deploy.md`, `apps/edge/src/container-env.ts`
- Modify: `apps/edge/src/containers.ts` (assign the secrets in the constructor), `apps/edge/src/env.ts` (the secret members), `tests/regression/legacy-080.test.ts` (append one describe block), `tests/regression/legacy-087.test.ts` (append one describe block)
- Test: `apps/edge/test/containers.test.ts`, `tests/regression/legacy-080.test.ts`, `tests/regression/legacy-087.test.ts`

**Interfaces:**
- Consumes: Task 4's `infra/wrangler.jsonc`; Plan 0A's `db:migrate` / `db:lint` scripts and `.github/workflows/ci.yml` job `checks`; 0D's `apps/worker` script `jobs:install`; §3.11's names.
- Produces: the workflow `deploy-staging` (jobs `deploy`), the frozen deploy order, and `ContainerSecrets` — the exact set of environment variables the container receives.

```ts
// apps/edge/src/container-env.ts — a module of its own, importing NOTHING from @cloudflare/containers, so the
// test below runs under Node (Task 3's runtime-boundary note).
/** Everything the container process reads from the environment. DULJA_ENTRYPOINT selects the class; the rest are
 *  §3.11 names. SUPABASE_SERVICE_ROLE_KEY is deliberately absent — it is the seed CLI's alone and never enters
 *  the image (§3.11, spec:2273). */
export function containerSecrets(env: Env, entrypoint: "api" | "worker"): Record<string, string>;
```

- [ ] **Step 1: Write the failing test `apps/edge/test/containers.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { containerSecrets } from "../src/container-env";      // NOT ../src/containers — that imports cloudflare:workers
import type { Env } from "../src/env";

const env = {
  APP_ENV: "staging", LOG_LEVEL: "info",
  DATABASE_URL: "postgres://app_rw:pw@db.ref.supabase.co:5432/postgres",
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_JWT_ISSUER: "https://ref.supabase.co/auth/v1",
  SUPABASE_JWKS_URL: "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
  SENTRY_DSN: "https://key@o0.ingest.sentry.io/0",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/v1/traces",
} as unknown as Env;

describe("containerSecrets — the §3.11 inventory the container receives (spec:2273)", () => {
  it("passes exactly the eight §3.11 names the container needs, plus DULJA_ENTRYPOINT", () => {
    expect(Object.keys(containerSecrets(env, "api")).sort()).toEqual([
      "APP_ENV", "DATABASE_URL", "DULJA_ENTRYPOINT", "LOG_LEVEL", "OTEL_EXPORTER_OTLP_ENDPOINT",
      "SENTRY_DSN", "SUPABASE_JWKS_URL", "SUPABASE_JWT_ISSUER", "SUPABASE_URL",
    ]);
    expect(containerSecrets(env, "worker")["DULJA_ENTRYPOINT"]).toBe("worker");
  });

  it("never passes the Supabase service-role key — it is the seed CLI's alone (§3.11)", () => {
    const withKey = { ...env, SUPABASE_SERVICE_ROLE_KEY: "sb-secret" } as unknown as Env;
    expect(Object.keys(containerSecrets(withKey, "api"))).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(Object.values(containerSecrets(withKey, "api"))).not.toContain("sb-secret");
  });

  it("never passes the migrator URL — the container must not be able to run DDL (spec:104, LEGACY-053)", () => {
    const withMigrator = { ...env, DATABASE_URL_MIGRATOR: "postgres://app_migrator:pw@db.ref.supabase.co:5432/postgres" } as unknown as Env;
    expect(Object.keys(containerSecrets(withMigrator, "api"))).not.toContain("DATABASE_URL_MIGRATOR");
  });

  it("omits an unset optional rather than passing an empty string, so readConfig() fails loudly", () => {
    const bare = { APP_ENV: "dev", LOG_LEVEL: "debug", DATABASE_URL: "postgres://x@h:5432/d" } as unknown as Env;
    expect(Object.keys(containerSecrets(bare, "api")).sort()).toEqual(["APP_ENV", "DATABASE_URL", "DULJA_ENTRYPOINT", "LOG_LEVEL"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/edge && bun run test -- test/containers.test.ts`
Expected: FAIL — `Failed to resolve import "../src/container-env"`.

- [ ] **Step 3: Extend `apps/edge/src/env.ts`, write `apps/edge/src/container-env.ts`, wire `apps/edge/src/containers.ts`**

Append to `apps/edge/src/env.ts`:

```ts
/** Secret bindings, set with `wrangler secret put` and never written into infra/wrangler.jsonc (spec:2273).
 *  Optional members are optional because a fresh environment may not have Sentry or OTel yet (OD-22). */
export interface EnvSecrets {
  readonly DATABASE_URL: string;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_JWKS_URL?: string;
  readonly SENTRY_DSN?: string;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  readonly LOG_LEVEL?: string;
}
```

and change `export interface Env {` to `export interface Env extends EnvSecrets {`.

Write `apps/edge/src/container-env.ts` — a module of its own, so `containers.test.ts` never loads `@cloudflare/containers`:

```ts
import type { Env } from "./env";

/**
 * The environment the container process receives (§3.11, spec:2273). Two names are deliberately absent:
 *   • SUPABASE_SERVICE_ROLE_KEY — the seed CLI's alone; it creates auth users and must never be reachable from
 *     a process that serves requests.
 *   • DATABASE_URL_MIGRATOR — the container connects as app_rw and issues no DDL (spec:104, LEGACY-053).
 * An unset optional is omitted rather than passed empty, so apps/api's readConfig() fails loudly at boot.
 */
export function containerSecrets(env: Env, entrypoint: "api" | "worker"): Record<string, string> {
  const out: Record<string, string> = {
    DULJA_ENTRYPOINT: entrypoint,
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
  };
  const optional: readonly (keyof Env & string)[] = [
    "LOG_LEVEL", "SUPABASE_URL", "SUPABASE_JWT_ISSUER", "SUPABASE_JWKS_URL", "SENTRY_DSN", "OTEL_EXPORTER_OTLP_ENDPOINT",
  ];
  for (const name of optional) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}
```

and rewrite the two `envVars` declarations in `apps/edge/src/containers.ts` as **constructor assignments**:

```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "./env";
import { containerSecrets } from "./container-env";

export class ApiContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // `envVars` is a FIELD on the base class (Cloudflare's Container-class reference lists it as
    // `envVars (Record<string, string>, default {})`), so it is assigned, never overridden with an accessor:
    // TypeScript rejects `override get envVars()` on an inherited property with TS2611.
    this.envVars = containerSecrets(env, "api");
  }
}

export class WorkerContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "24h";

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.envVars = containerSecrets(env, "worker");
  }
}
```

This replaces the two literal `override envVars = { DULJA_ENTRYPOINT: … }` lines Task 3 wrote; `DULJA_ENTRYPOINT` is now the first key `containerSecrets` sets, so the entrypoint contract is unchanged.

> If Task 3 Step 1's grep recorded a different constructor signature for `Container` in the installed version — a single options object, say — follow that signature and keep the assignment: `containerSecrets` is the contract, and where the library lets you call it is the library's business.

- [ ] **Step 4: Run the container test to verify it passes**

Run: `cd apps/edge && bun run test -- test/containers.test.ts && bun run typecheck`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write `.github/workflows/deploy-staging.yml`**

```yaml
# The one command of §5.0 row 0.5, as a job beside `checks` (.github/workflows/ci.yml, Plan 0A).
# Deploy order is fixed and is the same order docs/runbooks/deploy.md gives for production:
#   1. migrate (app_migrator)  2. install pg-boss queues (app_migrator)  3. deploy the Worker and both containers
#   4. re-apply the seed (§3.4.8: re-applying the seed against staging after deploy is a release-runbook step)
# Migrations run BEFORE the deploy because they are expand-only (§3.4.7): the running old code tolerates the new
# schema. A contract migration is a separate, later PR, which is the whole point of expand/contract (LEGACY-080).
name: deploy-staging
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: deploy-staging
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile

      - name: Apply migrations as app_migrator
        run: bun run --cwd packages/db db:migrate
        env:
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}

      - name: Schema linter must report zero violations before anything is deployed
        run: bun run --cwd packages/db db:lint
        env:
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}

      - name: Verify the database posture (§5.0 row 0.2)
        run: bun run --cwd packages/db provision:verify
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}

      - name: Install the pg-boss queues as app_migrator (contracts §4.2.6)
        run: bun run --cwd apps/worker jobs:install
        env:
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}

      - name: Deploy the Worker and both container classes
        run: bun run --cwd apps/edge deploy
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      - name: Re-apply the seed pack (idempotent — §3.4.8)
        run: bun run seed --tenant "${{ vars.STAGING_TENANT_ID }}"
        env:
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

      - name: Smoke — /healthz through the Worker, and the container is not directly reachable
        run: |
          set -e
          test "$(curl -s -o /dev/null -w '%{http_code}' https://api.dulja.example/healthz)" = "200"
          test "$(curl -s -o /dev/null -w '%{http_code}' https://api.dulja.example/v1/companies)" = "401"
```

**Secrets and variables this workflow needs** (GitHub → Settings → Environments → `staging`). Every one is also in §3.11 or is a Cloudflare credential:

| Name | Kind | Holder | Why here and not in the container |
|---|---|---|---|
| `DATABASE_URL` | secret | api, worker | also used by `provision:verify` |
| `DATABASE_URL_MIGRATOR` | secret | CI only | DDL and the seed; **never** a container binding |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | secret | seed CLI only | the admin invite; never in the image (§3.11) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | secret | CI only | OD-20 |
| `STAGING_TENANT_ID` | variable | CI | the tenant id minted once by the first `bun run seed` (Task 12) |

The **container's** secrets are set once per environment, not per deploy:

```bash
for name in DATABASE_URL SUPABASE_URL SUPABASE_JWT_ISSUER SUPABASE_JWKS_URL SENTRY_DSN OTEL_EXPORTER_OTLP_ENDPOINT; do
  wrangler secret put "$name" --config infra/wrangler.jsonc
done
```

- [ ] **Step 6: Write `docs/runbooks/deploy.md`**

```markdown
# Runbook — deploy (spec §5.0 row 0.5, §4.11 environments)

Nothing reaches production without passing through staging (spec:2272). `main` deploys to staging automatically
(`.github/workflows/deploy-staging.yml`); production is the same six steps run by hand with
`--env production`.

## The order, and why it is this order

1. **`bun run --cwd packages/db db:migrate`** as `app_migrator`. Forward-only (spec:2057). Every migration in the
   repository is expand-only where it touches a live table (§3.4.7), so the running old code tolerates the new
   schema and there is no maintenance window (LEGACY-080, acceptance test 25).
2. **`bun run --cwd packages/db db:lint`** — zero violations, or stop. A schema that fails the linter must not
   reach a running environment.
3. **`bun run --cwd packages/db provision:verify`** — the four posture lines of §5.0 row 0.2.
4. **`bun run --cwd apps/worker jobs:install`** as `app_migrator` — pg-boss's own tables and queues (§4.2.6).
   Idempotent; safe on every deploy.
5. **`bun run --cwd apps/edge deploy`** — the Worker and both container classes from one image.
6. **`bun run seed --tenant <id>`** — re-applies the seed pack. Idempotent by construction (§3.4.8); a phase that
   added a sub-pack gets it applied here.

## Rollback

`wrangler rollback --config infra/wrangler.jsonc` returns the Worker and both containers to the previous version.
**Do not roll back the database.** Production is forward-only; `down` exists for CI and local development only
(§3.4.1). If a migration is wrong, the remedy is a new migration, exactly as the remedy for a wrong ledger entry
is a reversing entry.

## Secrets

The inventory is contracts §3.11. Cloudflare secret bindings for the container
(`wrangler secret put <NAME> --config infra/wrangler.jsonc`); GitHub environment secrets for CI. Never a committed
`.env`, never a value in `infra/wrangler.jsonc` — `infra/test/wrangler.test.ts` fails the build if one appears.
`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL_MIGRATOR` exist in CI only and are never container bindings.

## Renovate

`infra/renovate.json`; the owner points the Renovate GitHub app at that path (Repository settings →
`configFileNames: ["infra/renovate.json"]`). Patch updates automerge; `postgres`, `pg-boss` and `decimal.js`
never do.

## The domain, and the one update-feed URL

`dulja.example` in `infra/wrangler.jsonc` is a placeholder until OD-20. It appears there, in this file, and in
0E's update-feed URL, and nowhere else.

**One hostname, one feed path.** The Worker is routed on `api.<domain>/*` only. The electron-builder feed is a
**path under that host**, not a second hostname, because `apps/edge/src/router.ts` keys the R2 object on the
`/updates/` path prefix (`serveUpdate` strips exactly that prefix). The URL 0E's auto-updater is configured with
is therefore, verbatim and with the trailing slash:

```
https://api.dulja.example/updates/
```

`https://updates.dulja.example/latest.yml` would arrive with pathname `/latest.yml`, match neither `/v1/`,
`/healthz` nor `/updates/`, and return 404 — which is why `infra/test/wrangler.test.ts` asserts that no
`updates.` route exists.
```

- [ ] **Step 7: Append the two regression blocks**

Append to `tests/regression/legacy-080.test.ts` — never editing 0B's block (§3.7.3).

**Where each piece goes.** The `describe` block is appended at the **end** of the file. The `repoFile` import is added to the file's **existing import block at the top**, merged into the existing `from "../support/regression"` specifier if there is one — `import` statements hoist, but `oxfmt` and oxlint's import-ordering convention would move a trailing import anyway, and reformatting churn in a file another slice owns is worse than the merge. Adding a named import to an import statement is not editing an earlier slice's `describe` block, so §3.7.3 is satisfied. The same applies to `legacy-087` below and `legacy-025` in Task 12.

```ts
// (top of file, in the existing import block)
import { repoFile } from "../support/regression";       // cwd is tests/, so every repo path is resolved (T2 Step 5)

// ── appended by slice 0C, at the end of the file ──────────────────────────────
describe("LEGACY-080 Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers — 0C", () => {
  it("the deploy applies numbered migrations forward-only and never dumps or repumps", () => {
    const wf = repoFile(".github/workflows/deploy-staging.yml");
    expect(wf).toContain("bun run --cwd packages/db db:migrate");
    // Each entry names a *command*, never a word. A bare "down" would also fail on a step called
    // "teardown", a "shutdown" note or a `cooldown` input — none of which is a dump-and-repump — so the
    // reverse migration is matched as the CLI verb it is, at a word boundary.
    for (const forbidden of ["pg_dump", "pg_restore", "drop database", "db:rollback"]) {
      expect(wf.toLowerCase()).not.toContain(forbidden);
    }
    expect(wf).not.toMatch(/\bcli\.ts\s+down\b/);      // packages/db/src/cli.ts down <version>
    expect(wf).not.toMatch(/\bdb:down\b/);
  });

  it("one monotonic version ledger, not thousands of scattered integers", async () => {
    const { db } = await sharedDb();
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app_meta' and table_name = 'schema_migration' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["version", "name", "applied_at"]);
    const [pk] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.table_constraints
       where table_schema = 'app_meta' and table_name = 'schema_migration' and constraint_type = 'PRIMARY KEY'`;
    expect(pk!.n).toBe(1);
  });

  it("the runbook forbids rolling the database back in production", () => {
    expect(repoFile("docs/runbooks/deploy.md")).toMatch(/\*\*Do not roll back the database\.\*\*/);
  });
});
```

Append to `tests/regression/legacy-087.test.ts` — the import into the top import block, the `describe` at the end:

```ts
// (top of file, in the existing import block)
import { repoFile } from "../support/regression";

// ── appended by slice 0C, at the end of the file ──────────────────────────────
const DEVELOPER_PATH = /([A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[a-z])/;

describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0C", () => {
  it("nothing that ships carries a path from the machine that built it", () => {
    for (const file of ["infra/Dockerfile", "infra/entrypoint.sh", "infra/wrangler.jsonc", ".github/workflows/deploy-staging.yml"]) {
      expect(repoFile(file), file).not.toMatch(DEVELOPER_PATH);
    }
  });

  it("the image is built from the repository, not from a developer's tree: every COPY source is repo-relative", () => {
    const dockerfile = repoFile("infra/Dockerfile");
    const sources = [...dockerfile.matchAll(/^COPY (?:--from=\S+ )?(\S+)/gm)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) expect(s.startsWith("/app") || !s.startsWith("/"), s).toBe(true);
  });
});
```

- [ ] **Step 8: Run everything and commit**

Run: `bun run lint && bun run typecheck && cd apps/edge && bun run test && cd ../../tests && bun run test -- regression/legacy-080.test.ts regression/legacy-087.test.ts`
Expected: PASS.

```bash
git add -A
git commit -m "chore(ci): deploy-to-staging workflow, container secret inventory, deploy runbook [0C T5]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: the seed CLI seam — `bun run seed`, the sub-pack registry, `--only`, and ADR 0012

spec:2188: "**Never** an initialisation procedure callable on a running system (LEGACY-039). Bootstrap is the offline `bun run seed` CLI of §5.0 task 0.7b, run as the migrator role." This task builds the seam — argument parsing, the sub-pack registry, the exit codes, the CLI sub-command and the regression that proves it is not an endpoint. The four loaders arrive in Tasks 8–11 and the bootstrap steps in Tasks 7 and 9; every one of them plugs into the registry written here.

**Files:**
- Create: `packages/db/src/seed/types.ts`, `packages/db/src/seed/index.ts`, `packages/db/src/seed/config.ts`, `packages/db/src/seed/packs.ts`, `tests/regression/legacy-039.test.ts`, `docs/adr/0012-seed-pack-format.md`
- Modify: `packages/db/src/cli.ts` (the `seed` sub-command), `packages/db/package.json` (script `seed`), root `package.json` (script `seed`)
- Test: `packages/db/test/seed-packs.test.ts`, `tests/regression/legacy-039.test.ts`

**Interfaces:**
- Consumes: 0B's `createDb` and production `withTenant(sql, ctx, fn)`; Plan 0A's migration runner CLI shape and `DATABASE_URL_MIGRATOR`.
- Produces:

```ts
// packages/db/src/seed/index.ts
export type SubPack = "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts";
export const SUB_PACKS: readonly SubPack[];                       // application order — never alphabetical
export interface SeedResult { readonly tenantId: string; readonly companyId: string; readonly ownerPrincipalId: string; readonly systemPrincipalId: string; readonly applied: Readonly<Record<SubPack, number>>; readonly created: boolean }
export class SeedError extends Error { readonly code: "ERR_VALIDATION_FAILED"; constructor(detail: string) }
/** Two arguments here; Task 9 adds the third (`authAdmin: SeedAuthAdmin`) with the owner bootstrap step. */
export async function seed(sql: Sql, config: SeedConfig): Promise<SeedResult>;

// packages/db/src/seed/config.ts
export interface SeedConfig {
  readonly tenantId: string;                 // required: `--tenant <uuid>`
  readonly only: readonly SubPack[] | null;  // `--only <sub-pack>` (repeatable); null = the whole bootstrap
  readonly packRoot: string;                 // `--pack <dir>`; default packages/db/seed/my
  readonly tenantName: string;               // OWNER GATE OD-21
  readonly ownerEmail: string;               // OWNER GATE OD-21
  readonly companyCode: string;
  readonly companyName: string;              // OWNER GATE OD-21 (legal name)
  readonly baseCurrency: string;             // OWNER GATE OD-21 (MYR)
  readonly timezone: string;
  readonly fiscalYearStartMonth: number;     // OWNER GATE OD-21 (1–12)
  readonly fiscalYear: number;
}
/** NOT `ConfigError`: contracts §4.2.3 registers that name for `apps/api/src/config.ts` (0B), and `packages/db`
 *  gets a second one of its own in 8A (`packages/db/src/hr/config-error.ts`). Two unrelated classes spelled the
 *  same way inside one package is the ambiguity hazard 9 exists to prevent, so the seed's carries its scope. */
export class SeedConfigError extends Error {}
export function parseSeedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedConfig;   // throws SeedConfigError

// packages/db/src/seed/packs.ts
export interface PackLoader { readonly name: SubPack; load(tx: Sql, ctx: LoaderContext): Promise<number> }
export interface LoaderContext { readonly config: SeedConfig; readonly tenantId: string; readonly companyId: string; readonly systemPrincipalId: string; readonly packRoot: string }
/** Reads and JSON-parses `<packRoot>/<sub-pack>/<file>`; throws SeedError naming the file on a parse failure. */
export function readPackFile<T>(packRoot: string, subPack: SubPack, file: string): T;
/** §2.1 0C card: "0C's seed task asserts the pack contains exactly the three sub-packs above." */
export function assertPackShape(packRoot: string): void;
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[];     // ["chart-of-accounts", "dimensions", "fiscal-periods"]
```

Exit codes of `bun run seed` (frozen; the deploy workflow and the runbook rely on them): **0** success · **1** a seed failure (a loader threw, the database refused) · **2** a configuration error (a missing flag, a missing environment variable, `DATABASE_URL` supplied where `DATABASE_URL_MIGRATOR` is required) · **3** a pack-shape violation (`assertPackShape` failed).

- [ ] **Step 1: Write the failing test `packages/db/test/seed-packs.test.ts`**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSeedArgs, SeedConfigError } from "../src/seed/config";
import { assertPackShape, readPackFile, PHASE_0_SUB_PACK_DIRECTORIES } from "../src/seed/packs";
import { SUB_PACKS, SeedError } from "../src/seed";

const TENANT = "01927f3a-0000-7000-8000-000000000001";
const base = ["--tenant", TENANT];
const env = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb-key" } as NodeJS.ProcessEnv;

function pack(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "dulja-pack-"));
  for (const d of dirs) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, "x.json"), "[]"); }
  return root;
}

describe("packages/db/src/seed — the CLI seam (spec §3.8 bootstrap; contracts §3.4.8)", () => {
  it("SUB_PACKS is application order, not alphabetical: roles before the rows that reference them", () => {
    expect(SUB_PACKS).toEqual(["roles", "dimensions", "fiscal-periods", "chart-of-accounts"]);
  });

  it("--tenant is required — the CLI never invents a tenant id", () => {
    expect(() => parseSeedArgs([], env)).toThrow(SeedConfigError);
    expect(() => parseSeedArgs([], env)).toThrow(/--tenant <uuid> is required/);
    expect(() => parseSeedArgs(["--tenant", "not-a-uuid"], env)).toThrow(/--tenant must be a uuid/);
  });

  it("--only accepts a known sub-pack, repeats, and rejects an unknown one by name", () => {
    expect(parseSeedArgs([...base, "--only", "roles"], env).only).toEqual(["roles"]);
    expect(parseSeedArgs([...base, "--only", "roles", "--only", "chart-of-accounts"], env).only)
      .toEqual(["roles", "chart-of-accounts"]);
    expect(() => parseSeedArgs([...base, "--only", "document-types"], env))
      .toThrow(/unknown sub-pack 'document-types' — expected one of roles, dimensions, fiscal-periods, chart-of-accounts/);
    expect(parseSeedArgs(base, env).only).toBeNull();
  });

  it("the OD-21 values default to fixtures and are overridden by flags", () => {
    const d = parseSeedArgs(base, env);
    expect(d.companyName).toBe("Dulja Test Company Sdn Bhd");
    expect(d.baseCurrency).toBe("MYR");
    expect(d.timezone).toBe("Asia/Kuala_Lumpur");
    expect(d.fiscalYearStartMonth).toBe(1);
    const o = parseSeedArgs([...base, "--company-name", "Real Sdn Bhd", "--owner-email", "owner@real.my", "--fiscal-year-start", "4"], env);
    expect(o.companyName).toBe("Real Sdn Bhd");
    expect(o.ownerEmail).toBe("owner@real.my");
    expect(o.fiscalYearStartMonth).toBe(4);
  });

  it("a fiscal-year start outside 1–12 is a configuration error, not a silent modulo", () => {
    expect(() => parseSeedArgs([...base, "--fiscal-year-start", "13"], env)).toThrow(/--fiscal-year-start must be 1–12/);
    expect(() => parseSeedArgs([...base, "--fiscal-year-start", "0"], env)).toThrow(/--fiscal-year-start must be 1–12/);
  });

  it("assertPackShape accepts exactly the three Phase 0 sub-packs and names any extra (§2.1 0C card)", () => {
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toEqual(["chart-of-accounts", "dimensions", "fiscal-periods"]);
    expect(() => assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES))).not.toThrow();
    expect(() => assertPackShape(pack(["chart-of-accounts", "dimensions"]))).toThrow(/missing sub-pack: fiscal-periods/);
    expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES, "tax"])))
      .toThrow(/unexpected sub-pack: tax — tax\/ is slice 5A's/);
    expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES, "document-types"])))
      .toThrow(/unexpected sub-pack: document-types — document-types\/ is slice 1A's/);
  });

  it("readPackFile names the file when the JSON is bad", () => {
    const root = mkdtempSync(join(tmpdir(), "dulja-pack-"));
    mkdirSync(join(root, "chart-of-accounts"), { recursive: true });
    writeFileSync(join(root, "chart-of-accounts", "0c-base.json"), "{ not json");
    expect(() => readPackFile(root, "chart-of-accounts", "0c-base.json")).toThrow(SeedError);
    expect(() => readPackFile(root, "chart-of-accounts", "0c-base.json")).toThrow(/chart-of-accounts\/0c-base\.json/);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed-packs.test.ts`
Expected: FAIL — `Failed to resolve import "../src/seed/config"`.

- [ ] **Step 3: Write `packages/db/src/seed/types.ts`, `index.ts`, `config.ts` and `packs.ts`**

`packages/db/src/seed/types.ts` holds the three names every other seed module needs, so nothing has to import back from the barrel — `index.ts` importing `config.ts` while `config.ts` imports `index.ts` is a cycle ESM tolerates only because both uses are lazy, and one eager use would be a temporal-dead-zone crash:

```ts
/**
 * The four Phase 0 loaders, in **application order**. `roles` first because every later grant references a role;
 * `dimensions` next because `document.branch_id` and `role_assignment_branch.branch_id` point at BRANCH values;
 * then periods, then the chart. §3.4.8: a slice that introduces a sub-pack ships its loader in the same PR, and
 * a slice that adds rows to an existing sub-pack adds a *file*, never a loader.
 */
export type SubPack = "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts";
export const SUB_PACKS: readonly SubPack[] = ["roles", "dimensions", "fiscal-periods", "chart-of-accounts"];

/** The seed is not an HTTP surface, so it does not build a Problem — but it reuses the one registered code that
 *  describes "your input does not satisfy the schema" (§4.2.4) rather than inventing a new one. */
export class SeedError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(detail: string) { super(detail); this.name = "SeedError"; }
}
```

`packages/db/src/seed/index.ts` (the `seed()` body grows in Tasks 7–11; this step writes the barrel and the orchestration shell):

```ts
import type { Sql } from "postgres";
import { SeedError, SUB_PACKS, type SubPack } from "./types";
import type { SeedConfig } from "./config";

export interface SeedResult {
  readonly tenantId: string;
  readonly companyId: string;
  readonly ownerPrincipalId: string;
  readonly systemPrincipalId: string;
  readonly applied: Readonly<Record<SubPack, number>>;
  readonly created: boolean;              // false on a re-run: the tenant already existed
}

export { SeedError, SUB_PACKS, type SubPack } from "./types";
export type { SeedConfig } from "./config";
export { SeedConfigError, parseSeedArgs } from "./config";
export { assertPackShape, PHASE_0_SUB_PACK_DIRECTORIES, readPackFile } from "./packs";

/** Task 7 writes the identity half, Task 9 the owner half (and the third parameter), Tasks 8/10/11 the loaders. */
export async function seed(sql: Sql, config: SeedConfig): Promise<SeedResult> {
  throw new SeedError("seed() is assembled in tasks 7–11 of plan 0C");
}
```

`packages/db/src/seed/config.ts`:

```ts
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { SUB_PACKS, type SubPack } from "./types";

/**
 * `bun run seed --tenant <uuid> [--only <sub-pack>]…` (§3.4.8). The five OWNER GATE OD-21 values —
 * owner e-mail, legal name, base currency, fiscal-year start and the service-role key — arrive as flags and
 * environment variables. Their defaults are the fixture values §2.12 assigns until the owner answers, so the
 * whole slice is executable today and one command changes when the real values arrive.
 */
export interface SeedConfig {
  readonly tenantId: string;
  readonly only: readonly SubPack[] | null;
  readonly packRoot: string;
  readonly tenantName: string;
  readonly ownerEmail: string;
  readonly companyCode: string;
  readonly companyName: string;
  readonly baseCurrency: string;
  readonly timezone: string;
  readonly fiscalYearStartMonth: number;
  readonly fiscalYear: number;
}

/**
 * The seed CLI's configuration failure — `packages/db/src/cli.ts` maps it to exit code **2** (§4.2.13).
 * Deliberately **not** spelled `ConfigError`: contracts §4.2.3 registers that name for `apps/api/src/config.ts`,
 * and it is not importable from here anyway (packages never import apps — §3.1). Carrying the scope in the name
 * keeps one spelling for one thing when a second `packages/db` config error arrives (8A's `hr/config-error.ts`).
 */
export class SeedConfigError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSeedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedConfig {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        tenant: { type: "string" },
        only: { type: "string", multiple: true },
        pack: { type: "string" },
        "tenant-name": { type: "string" },
        "owner-email": { type: "string" },
        "company-code": { type: "string" },
        "company-name": { type: "string" },
        currency: { type: "string" },
        timezone: { type: "string" },
        "fiscal-year-start": { type: "string" },
        "fiscal-year": { type: "string" },
      },
    });
  } catch (e) {
    throw new SeedConfigError((e as Error).message);
  }
  const v = parsed.values;

  const tenantId = v.tenant ?? env["SEED_TENANT_ID"];
  if (!tenantId) throw new SeedConfigError("--tenant <uuid> is required — the CLI never invents a tenant id (mint one with `select uuidv7()`)");
  if (!UUID.test(tenantId)) throw new SeedConfigError(`--tenant must be a uuid, got ${JSON.stringify(tenantId)}`);

  let only: readonly SubPack[] | null = null;
  if (v.only && v.only.length > 0) {
    for (const name of v.only) {
      if (!(SUB_PACKS as readonly string[]).includes(name)) {
        throw new SeedConfigError(`unknown sub-pack ${JSON.stringify(name)} — expected one of ${SUB_PACKS.join(", ")}`);
      }
    }
    only = v.only as readonly SubPack[];
  }

  const startMonth = Number(v["fiscal-year-start"] ?? "1");
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new SeedConfigError(`--fiscal-year-start must be 1–12, got ${JSON.stringify(v["fiscal-year-start"] ?? "1")}`);
  }
  const fiscalYear = Number(v["fiscal-year"] ?? String(new Date().getUTCFullYear()));
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200) {
    throw new SeedConfigError(`--fiscal-year must be a four-digit year, got ${JSON.stringify(v["fiscal-year"])}`);
  }

  return {
    tenantId,
    only,
    // `URL.pathname` yields "/C:/Users/…" on Windows; fileURLToPath is the only portable form (plan0A's harness
    // uses it for the same reason). `packages/db/src/seed/` → `packages/db/seed/my`.
    packRoot: v.pack ?? fileURLToPath(new URL("../../seed/my", import.meta.url)),
    // OWNER GATE OD-21 — every default below is a fixture value (§2.12) replaced by one flag.
    tenantName: v["tenant-name"] ?? "Dulja",
    ownerEmail: v["owner-email"] ?? "owner@dulja.invalid",
    companyCode: v["company-code"] ?? "HQ",
    companyName: v["company-name"] ?? "Dulja Test Company Sdn Bhd",
    baseCurrency: (v.currency ?? "MYR").toUpperCase(),
    timezone: v.timezone ?? "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: startMonth,
    fiscalYear,
  };
}
```

`packages/db/src/seed/packs.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { SeedError, type SubPack } from "./types";
import type { SeedConfig } from "./config";

export interface LoaderContext {
  readonly config: SeedConfig;
  readonly tenantId: string;
  readonly companyId: string;
  readonly systemPrincipalId: string;
  readonly packRoot: string;
}

/** A loader returns the number of rows it inserted — zero on a re-run, which is what "changes nothing" means. */
export interface PackLoader { readonly name: SubPack; load(tx: Sql, ctx: LoaderContext): Promise<number> }

/**
 * §2.1's 0C card: the Malaysia pack at Phase 0 is the chart of accounts, the BRANCH dimension and the current
 * year's fiscal periods, "and **nothing else** … no `document-types/`, `tax/`, `templates/`, `reports/` or
 * `statutory/`". Neither of the two absentees can even run here: `document-types/JOURNAL.json` needs
 * `posting-policy.schema.json` and the permission code `accounting.journal.post`, both of which arrive with 1A
 * (F-21, §4.4.1); `tax_code` rows need `app.tax_code`, created by 5A's migration 0053, while 0C's own migration
 * range is 0009 and reserved (F-23). Seeding either here fails at run time, so the shape is asserted instead.
 */
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[] = ["chart-of-accounts", "dimensions", "fiscal-periods"];

const OWNED_ELSEWHERE: Readonly<Record<string, string>> = {
  "document-types": "1A", templates: "2C", tax: "5A", reports: "7A", statutory: "8A",
};

export function assertPackShape(packRoot: string): void {
  const present = readdirSync(packRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const required of PHASE_0_SUB_PACK_DIRECTORIES) {
    if (!present.includes(required)) throw new SeedError(`missing sub-pack: ${required} (in ${packRoot})`);
  }
  for (const found of present) {
    if (PHASE_0_SUB_PACK_DIRECTORIES.includes(found)) continue;
    const owner = OWNED_ELSEWHERE[found];
    throw new SeedError(
      owner
        ? `unexpected sub-pack: ${found} — ${found}/ is slice ${owner}'s and cannot be applied at Phase 0 (contracts §3.4.8)`
        : `unexpected sub-pack: ${found} — the Phase 0 pack is exactly ${PHASE_0_SUB_PACK_DIRECTORIES.join(", ")}`,
    );
  }
}

export function readPackFile<T>(packRoot: string, subPack: SubPack, file: string): T {
  const path = join(packRoot, subPack, file);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { throw new SeedError(`seed pack file not found: ${subPack}/${file} (looked in ${packRoot})`); }
  try { return JSON.parse(text) as T; }
  catch (e) { throw new SeedError(`seed pack file ${subPack}/${file} is not valid JSON: ${(e as Error).message}`); }
}
```

- [ ] **Step 4: Add the `seed` sub-command to `packages/db/src/cli.ts`**

The CLI is the only file in `packages/db` that may call `console` (plan0A:301), so it is where every message is printed. Insert the branch before the usage line and extend the usage string:

```ts
import { assertPackShape, parseSeedArgs, seed, SeedError } from "./seed";

// … inside the try block, after the `lint` branch:
  else if (cmd === "seed") {
    // LEGACY-039: this is an offline CLI run as app_migrator, never an endpoint on a running system (spec:2188).
    // `url` is already DATABASE_URL_MIGRATOR (checked at the top of this file); a DATABASE_URL here would be
    // app_rw, which cannot write the roles or the chart at all.
    let config;
    try { config = parseSeedArgs(process.argv.slice(3), process.env); }
    catch (e) { console.error((e as Error).message); process.exit(2); }
    try { assertPackShape(config.packRoot); }
    catch (e) { console.error((e as Error).message); process.exit(3); }
    try {
      console.log(JSON.stringify(await seed(sql, config), null, 2));
    } catch (e) {
      console.error(e instanceof SeedError ? `${e.code}: ${e.message}` : String(e));
      process.exit(1);
    }
  }
```

Task 9 adds the auth admin to these lines, in one place, when it introduces `SeedAuthAdmin`.

and change the usage string to:

```ts
console.error("usage: cli.ts up | down [toVersion] | status | lint | seed --tenant <uuid> [--only <sub-pack>]");
```

`packages/db/package.json` scripts gain `"seed": "bun run src/cli.ts seed"`; root `package.json` scripts gain `"seed": "bun run --cwd packages/db seed"`, so the spec's literal `bun run seed` (spec:2317) works from the repository root.

**The seed is deliberately not re-exported from `packages/db/src/index.ts`, now or ever in this slice.** Task 9 adds `packages/db/src/seed/auth-admin.ts`, whose first line is `import { createClient } from "@supabase/supabase-js"`. An `export * from "./seed"` in the barrel would put the service-role admin client on the import graph of every `import { withTenant } from "@dulja/db"` in `apps/api` and `apps/worker` — the exact coupling `tests/regression/legacy-039.test.ts` exists to forbid, and one its textual grep for `/from ["'].*seed/` over three application files would not catch. Step 5's regression asserts the barrel stays clean. The CLI reaches the seed by a **relative** import (`./seed`), which needs no export entry at all; the only other consumer is the test tier, and Task 12 gives it a `"./seed"` subpath export.

- [ ] **Step 5: Write `tests/regression/legacy-039.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ROUTES } from "@dulja/api";
import { repoFile } from "../support/regression";       // cwd is tests/ (T2 Step 5)

/**
 * LEGACY-039 · H · `procInitDatabase` creates an administrator, unauthenticated, with no already-initialised guard.
 * The fix is structural, so the test is structural: bootstrap is a CLI, it needs the migrator credential, and no
 * route in the system can reach it (spec:2188).
 */
describe("LEGACY-039 procInitDatabase creates an admin, unauthenticated, unguarded — 0C", () => {
  it("no registered route is an initialisation endpoint", () => {
    const offenders = ROUTES.filter((r) => /seed|init|bootstrap|setup|install/i.test(r.path));
    expect(offenders.map((r) => r.path)).toEqual([]);
  });

  it("the seed lives in the CLI, and the CLI demands the migrator credential", () => {
    const cli = repoFile("packages/db/src/cli.ts");
    expect(cli).toContain('cmd === "seed"');
    expect(cli).toContain("DATABASE_URL_MIGRATOR");
    // app_rw is the API's role; it holds no privilege that could bootstrap a tenant.
    expect(cli).not.toMatch(/process\.env\["DATABASE_URL"\]/);
  });

  it("no application source outside the CLI and the seed modules imports the seed", () => {
    for (const file of ["apps/api/src/app.ts", "apps/api/src/routes/index.ts", "apps/worker/src/index.ts"]) {
      expect(repoFile(file), file).not.toMatch(/from ["'].*seed/);
    }
  });

  it("@dulja/db's main entry does not re-export the seed — the service-role client is not on the serving path", () => {
    // The grep above is textual, so an `export * from "./seed"` in the package barrel would walk straight past it:
    // every `import { withTenant } from "@dulja/db"` in apps/api would then transitively load
    // packages/db/src/seed/auth-admin.ts and with it @supabase/supabase-js and the service-role admin client.
    // Task 12 makes the seed reachable to the test tier through a "./seed" subpath export instead, and appends
    // the assertion that the subpath exists to this describe block.
    const barrel = repoFile("packages/db/src/index.ts");
    expect(barrel).not.toMatch(/from ["']\.\/seed/);
  });

  it("running it twice is the documented contract, not an accident (spec:2317)", () => {
    expect(repoFile("docs/adr/0012-seed-pack-format.md")).toMatch(/idempotent/i);
  });
});
```

> `@dulja/api` must export `ROUTES` from its package entry — 0B's Task 13 already imports it that way for the isolation harness (§3.1: the test tier reaches `apps/api` "**only** through its exported `createApp()`"), so this file adds no new coupling.

- [ ] **Step 6: Write ADR 0012**

`docs/adr/0012-seed-pack-format.md`:

```markdown
# ADR 0012: Seed-pack format — JSON files under `packages/db/seed/<pack>/<sub-pack>/`, one loader per sub-pack

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C

## Context

`FORCE ROW LEVEL SECURITY` binds `app_migrator` as well as `app_rw` (spec:1366), and a migration file issues no
`set_config`, so a migration sees no tenants and cannot write a single per-tenant row. Roles, role grants, the
chart of accounts, dimension values, fiscal periods, document types, templates, report definitions, tax codes and
statutory rate tables are therefore **not** migration data. Only `app.permission` — global, no RLS — is.

Twelve slices contribute rows across nine phases. Two failure modes have to be designed out: a slice seeding a row
into a table a later slice creates, and eight parallel writers editing one file.

## Decision

1. **Per-tenant rows are seed-pack data**, applied by `bun run seed --tenant <uuid> [--only <sub-pack>]`, run as
   `app_migrator` from `packages/db/src/cli.ts`. Never an endpoint (spec:2188, LEGACY-039).
2. **A pack is a directory of sub-pack directories**; a sub-pack is a directory of JSON files. Phase 0's pack is
   `packages/db/seed/my/` with exactly `chart-of-accounts/`, `dimensions/` and `fiscal-periods/`; `assertPackShape`
   fails the run, exit code 3, if a later slice's directory appears early, naming the owning slice.
3. **One loader module per sub-pack**, `packages/db/src/seed/<sub-pack>.ts`, shipped by the slice that introduces
   the sub-pack. A slice that adds *rows* to an existing sub-pack adds a **file**, never a loader — which is why
   the chart of accounts is `chart-of-accounts/<slice>.json` (§4.15) and not one shared file.
4. **Idempotent by construction.** Every insert is `on conflict do nothing` on the row's natural key, except a
   `posting_policy` version, which is `on conflict … do update` (§3.4.8) so a placeholder cannot outlive the real
   definition. Running the seed twice changes nothing — including `app.audit_log`, which means an `update` must
   carry `where <col> is distinct from <new>` or it will fire the AFTER ROW audit trigger on every deploy.
5. **The loader order is application order, not alphabetical:** `roles`, `dimensions`, `fiscal-periods`,
   `chart-of-accounts`. `--only` preserves the order the flags were given, so an operator can re-apply one.
6. **Exit codes:** 0 success · 1 seed failure · 2 configuration error · 3 pack-shape violation.

## Consequences

- The seed is a release-runbook step after every deploy (§3.4.8), which is why idempotency is load-bearing rather
  than convenient.
- A slice adding a sub-pack edits `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES` (renaming it as the pack grows) and
  `OWNED_ELSEWHERE` in `packages/db/src/seed/packs.ts` — three small, reviewable lists.
- JSON rather than TypeScript for the data: a pack is reviewed as a diff by an accountant, and `roles.ts` is the
  one exception because §5.2 places the role list in `packages/db/seed/roles.ts` and its `admin` set is computed.
```

- [ ] **Step 7: Run the tests and commit**

Run: `cd packages/db && bun run test -- test/seed-packs.test.ts && cd ../.. && bun run typecheck`
Expected: PASS — 7 tests. `tests/regression/legacy-039.test.ts` still fails on `docs/adr/0012` only if the ADR is missing; run it after Step 6: `cd tests && bun run test -- regression/legacy-039.test.ts` → 5 passed. (Task 12 Step 5 appends a sixth case to the same block, once the `"./seed"` subpath exists.)

If `parseSeedArgs` throws `Unknown option '--only'`, `parseArgs` was given `argv` including the sub-command; the CLI slices from index 3 (`bun run src/cli.ts seed …`), so the first element passed here is `--tenant`.

```bash
git add -A
git commit -m "feat(db): seed CLI seam — sub-pack registry, --only, exit codes, ADR 0012 (LEGACY-039) [0C T6]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: bootstrap steps 1–3 — tenant, system principal, membership, `pgboss.tenant_registry`

spec:1997–1999, verbatim: generate the ids in the CLI; `set_config` both keys **before any insert**; insert `tenant`, then the `system` principal with `auth_subject = 'system:<tenant_id>'` and **no `RETURNING`**, then its `membership`, **all in one transaction** — the tenant's audit row cites a principal that does not exist yet, which is legal only because `audit_log.actor_id` is `deferrable initially deferred` and the audit trigger is AFTER ROW.

**Files:**
- Create: `packages/db/src/seed/identity.ts`
- Modify: `packages/db/src/seed/index.ts` (`seed()` calls it)
- Test: `packages/db/test/seed-identity.test.ts`

**Interfaces:**
- Consumes: 0B's production `withTenant(sql, ctx, fn)` and `TenantContext`; 0D's `pgboss.tenant_registry` (migration 0004); Plan 0A's `app.tenant`, `app.principal`, `app.membership` and the `principal_insert` policy.
- Produces:

```ts
// packages/db/src/seed/identity.ts
export interface IdentityResult { readonly systemPrincipalId: string; readonly created: boolean }
/** Bootstrap steps 1–3 in one transaction. Idempotent: a second run finds the system principal by its
 *  auth_subject, adopts its id as the acting actor, and inserts nothing. */
export async function bootstrapIdentity(sql: Sql, config: SeedConfig, requestId: string): Promise<IdentityResult>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/seed-identity.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { bootstrapIdentity } from "../src/seed/identity";
import { startDb, type Db } from "./harness";

describe("seed steps 1–3 — tenant, system principal, membership under FORCE RLS (spec:1997; v1.1 fix #2)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const env = {} as NodeJS.ProcessEnv;
  const cfg = (tenantId: string) => parseSeedArgs(["--tenant", tenantId], env);

  beforeAll(async () => { db = await startDb(); migrator = createDb(db.url("app_migrator")); });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("creates the three rows in one transaction and reports created: true", async () => {
    const t = randomUUID();
    const r = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    expect(r.created).toBe(true);
    const [p] = await db.admin<{ auth_subject: string; kind: string }[]>`
      select auth_subject, kind::text from app.principal where id = ${r.systemPrincipalId}`;
    expect(p).toEqual({ auth_subject: `system:${t}`, kind: "system" });
    const [m] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.membership where tenant_id = ${t}`;
    expect(m!.n).toBe(1);
  });

  it("the tenant's audit row cites the not-yet-inserted system principal — the deferrable FK makes it legal", async () => {
    const t = randomUUID();
    const r = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const rows = await db.admin<{ table_name: string; actor_id: string }[]>`
      select table_name, actor_id::text from app.audit_log where tenant_id = ${t} order by seq`;
    expect(rows.map((x) => x.table_name)).toEqual(["tenant", "principal", "membership"]);
    expect(rows.every((x) => x.actor_id === r.systemPrincipalId)).toBe(true);
  });

  it("a second run changes nothing and adopts the existing system principal (spec:2317)", async () => {
    const t = randomUUID();
    const first = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${t}`;
    const second = await bootstrapIdentity(migrator, cfg(t), randomUUID());
    expect(second).toEqual({ systemPrincipalId: first.systemPrincipalId, created: false });
    const [after] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${t}`;
    expect(after!.n).toBe(before!.n);
  });

  it("registers the tenant for the job runner, which cannot list app.tenant under FORCE RLS (§4.2.6)", async () => {
    const t = randomUUID();
    await bootstrapIdentity(migrator, cfg(t), randomUUID());
    await bootstrapIdentity(migrator, cfg(t), randomUUID());
    const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from pgboss.tenant_registry where tenant_id = ${t}`;
    expect(row!.n).toBe(1);
  });

  it("the two facts this design rests on (assumption 5) hold in the shipped schema", async () => {
    const [unique] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint c join pg_class r on r.oid = c.conrelid
       where r.relname = 'principal' and c.contype = 'u'
         and pg_get_constraintdef(c.oid) = 'UNIQUE (auth_subject)'`;
    expect(unique!.n).toBe(1);
    const [policy] = await db.admin<{ qual: string }[]>`
      select pg_get_expr(p.polqual, p.polrelid) as qual from pg_policy p join pg_class r on r.oid = p.polrelid
       where r.relname = 'principal' and p.polname = 'principal_in_tenant'`;
    expect(policy!.qual).toContain("current_tenant()");
    expect(policy!.qual).not.toContain("current_actor()");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed-identity.test.ts`
Expected: FAIL — `Failed to resolve import "../src/seed/identity"`.

- [ ] **Step 3: Write `packages/db/src/seed/identity.ts`**

```ts
import type { Sql } from "postgres";
import { withTenant } from "../with-tenant";
import type { SeedConfig } from "./config";

export interface IdentityResult { readonly systemPrincipalId: string; readonly created: boolean }

/**
 * Bootstrap steps 1–3 (spec:1997–1999), in **one transaction**.
 *
 * The re-run problem and its answer: on the second run the acting actor must be the *existing* system principal,
 * but `app_migrator` cannot call `app.resolve_principal` (EXECUTE is granted to `app_rw` only — §4.1) and
 * `FORCE ROW LEVEL SECURITY` hides `app.principal` until a tenant is set. The `principal_in_tenant` policy tests
 * `app.current_tenant()` alone (plan0A:1008), so: open with the tenant set and a provisional actor, look the
 * system principal up by its `auth_subject`, then re-issue `set_config('app.actor_id', …, true)` **before the
 * first write**. Nothing is written under the provisional value.
 *
 * `no-bare-db` (§3.7.5) is why every statement below is tagged by `tx`: `packages/db/src/seed/**` is not on the
 * allow-list, and it should not be.
 */
export async function bootstrapIdentity(sql: Sql, config: SeedConfig, requestId: string): Promise<IdentityResult> {
  const tenantId = config.tenantId;
  const authSubject = `system:${tenantId}`;
  // Provisional actor: any uuid. Nothing is written until it has been replaced, three statements below.
  return withTenant(sql, { tenantId, actorId: tenantId, requestId }, async (tx) => {
    const found = await tx<{ id: string }[]>`select id::text as id from app.principal where auth_subject = ${authSubject}`;
    const existing = found[0]?.id;
    const [minted] = await tx<{ id: string }[]>`select uuidv7()::text as id`;
    const systemPrincipalId = existing ?? minted!.id;

    // From here on every audit row carries the system principal as its server-supplied actor (spec:2000).
    await tx`select set_config('app.actor_id', ${systemPrincipalId}, true)`;

    // Step 3. The tenant's own audit row cites a principal inserted two statements later: legal because
    // audit_log.actor_id is deferrable initially deferred and the audit trigger is AFTER ROW (plan0A Task 9).
    await tx`insert into app.tenant (id, name) values (${tenantId}, ${config.tenantName}) on conflict (id) do nothing`;
    // No RETURNING: the principal_insert policy has no USING clause to read the row back through (v1.1 fix #2).
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${systemPrincipalId}, 'system', ${authSubject}, 'system')
             on conflict (auth_subject) do nothing`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${systemPrincipalId})
             on conflict (tenant_id, principal_id) do nothing`;

    // §4.2.6: a scheduled job cannot list app.tenant (FORCE RLS, no tenant set), so the registry is its index.
    await tx`insert into pgboss.tenant_registry (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`;

    return { systemPrincipalId, created: existing === undefined };
  });
}
```

- [ ] **Step 4: Wire it into `seed()` and run the test**

In `packages/db/src/seed/index.ts`, replace the throwing body:

```ts
import { randomUUID } from "node:crypto";
import { bootstrapIdentity } from "./identity";

export async function seed(sql: Sql, config: SeedConfig): Promise<SeedResult> {
  const requestId = randomUUID();
  const identity = await bootstrapIdentity(sql, config, requestId);
  // Task 9 inserts the owner and the company here; Tasks 8/10/11 run the loaders.
  return {
    tenantId: config.tenantId,
    companyId: "",
    ownerPrincipalId: "",
    systemPrincipalId: identity.systemPrincipalId,
    applied: { roles: 0, dimensions: 0, "fiscal-periods": 0, "chart-of-accounts": 0 },
    created: identity.created,
  };
}
```

Run: `cd packages/db && bun run test -- test/seed-identity.test.ts`
Expected: PASS — 5 tests.

If the third test's audit count grows on the second run, an `on conflict do nothing` is missing a target that matches the real constraint — `principal` conflicts on `(auth_subject)`, `membership` on its primary key `(tenant_id, principal_id)`, `tenant` on `(id)`.
If the first insert fails with `new row violates row-level security policy for table "tenant"`, the `--tenant` value and `app.current_tenant()` disagree: `tenant_self` has no `with check`, so Postgres reuses `using (id = app.current_tenant())` as the insert check, and the id **must** be the tenant being set.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): seed steps 1-3 — tenant, system principal, membership, tenant_registry [0C T7]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8 — **OWNER GATE OD-04**: the `roles` loader — nine system roles applied per tenant

> **This task is isolated for owner decision OD-04** (contracts §2.12: "The nine role names of §4.2.1 (*Confirm*)"; spec:35, 2152, 2403 — "⚠️ *Owner to confirm the names before task 0.7*").
>
> **Owner provides:** confirmation of the nine role codes `admin`, `accountant`, `user`, `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `auditor`, `pos_terminal` (spec:2156–2164), or replacements.
> **Verify with:** `bun run seed --tenant <id> --only roles` then `bun run --cwd packages/db test -- test/seed-roles.test.ts`.
> **Default written into this plan:** the spec's names, as **0D's `packages/db/seed/roles.ts` already spells them**. 0C does not restate the list — it applies it.
> **If the owner renames a role:** the edit is in **0D's** `packages/db/seed/roles.ts` and its own test. This task's loader iterates `ROLES` and changes not at all; only the literal `"admin"` in the owner-assignment step (Task 9) and the fixed literal `pos_terminal` in migration 0001's `assert_assignment_kind` (plan0A:1416) are code. Renaming `pos_terminal` would be a contracts amendment, not a plan edit.
> **If the owner adds a tenth role:** one entry in 0D's file; nothing here changes.
>
> **What "one droppable task per owner decision" means here, and why the gate sits on this task rather than Task 9.** Contracts §2.12 once recorded OD-04's 0C gate as "seed step 4 task", and spec:2000's step 4 is owner + company + roles + admin assignment — which this plan splits across Tasks 8 and 9. The gate is on **Task 8**, because Task 8 is where the nine codes are actually applied; §2.12 now says exactly that — "0C → the roles-loader task (0C T8 …)", folded in by §4.18 round 1 and grepped by Task 1 Step 0 — so the two documents agree. Task 8 is **not deletable** — Task 9's `admin` lookup and Task 12's DoD proof both need the roles to exist — so "droppable" here means *droppable as a decision, not as work*: with OD-04 unanswered the task runs unchanged against the spec's names as 0D spells them, and answering OD-04 changes **0D's** `packages/db/seed/roles.ts`, never a line of this task. The only consequence that would actually be dropped is Task 9's `admin` assignment, and only if the owner renamed the `admin` role itself — the one literal this slice writes.

**Files:**
- Create: `packages/db/src/seed/roles.ts`
- Modify: `packages/db/src/seed/index.ts`
- Test: `packages/db/test/seed-roles.test.ts`

**Interfaces:**
- Consumes: 0D's `packages/db/seed/roles.ts` — `ROLES`, `RoleSeed`, `adminPermissions(catalogue)`; Plan 0A's `app.role`, `app.role_permission` and `app.permission`.
- Produces: `export const rolesLoader: PackLoader` — `name: "roles"`.

**Where the catalogue comes from.** `packages/db` may not import `@dulja/contracts` (§5.2's dependency rule; 0D's Task 14 states it for the same file), so the loader reads the shipped catalogue from **`app.permission`** — a `GLOBAL_TABLE` with no RLS whose rows are migration data (§3.4.8) — and passes those codes to `adminPermissions()`. That is also more correct than the module would be: `role_permission.permission_code` has a foreign key to `app.permission`, so the only codes that can be granted are exactly the ones the database holds.

- [ ] **Step 1: Write the failing test `packages/db/test/seed-roles.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "../seed/roles";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { bootstrapIdentity } from "../src/seed/identity";
import { rolesLoader } from "../src/seed/roles";
import { withTenant } from "../src/with-tenant";
import { startDb, type Db } from "./harness";

describe("the roles loader — §3.6.4, spec:2000 step 4 (OWNER GATE OD-04)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let systemPrincipalId: string;

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    const cfg = parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv);
    ({ systemPrincipalId } = await bootstrapIdentity(migrator, cfg, randomUUID()));
    const ctx = { tenantId, actorId: systemPrincipalId, requestId: randomUUID() };
    await withTenant(migrator, ctx, (tx) =>
      rolesLoader.load(tx, { config: cfg, tenantId, companyId: "", systemPrincipalId, packRoot: cfg.packRoot }));
  });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("seeds the nine system roles, is_system = true, bilingual (test 36 seed clause)", async () => {
    const rows = await db.admin<{ code: string; is_system: boolean; name_ar: string | null }[]>`
      select code, is_system, name_ar from app.role where tenant_id = ${tenantId} order by code`;
    expect(rows.map((r) => r.code)).toEqual([...ROLES.map((r) => r.code)].sort());
    expect(rows.every((r) => r.is_system)).toBe(true);
    expect(rows.every((r) => (r.name_ar ?? "").length > 0)).toBe(true);
  });

  it("`admin` holds every catalogue code except pos.ticket.sell and pos.sync.* (spec:2000, 2156)", async () => {
    const granted = await db.admin<{ permission_code: string }[]>`
      select rp.permission_code from app.role_permission rp join app.role r on r.id = rp.role_id
       where rp.tenant_id = ${tenantId} and r.code = 'admin' order by 1`;
    const catalogue = await db.admin<{ code: string }[]>`select code from app.permission order by code`;
    const expected = catalogue.map((c) => c.code).filter((c) => c !== "pos.ticket.sell" && !c.startsWith("pos.sync."));
    expect(granted.map((g) => g.permission_code)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);        // at Phase 0 this is the five admin.* codes
  });

  it("`auditor` holds only its non-mutating code and no seeded role holds an incompatible pair (R6, R7)", async () => {
    const auditor = await db.admin<{ permission_code: string; mutating: boolean }[]>`
      select rp.permission_code, p.mutating from app.role_permission rp
        join app.role r on r.id = rp.role_id join app.permission p on p.code = rp.permission_code
       where rp.tenant_id = ${tenantId} and r.code = 'auditor'`;
    expect(auditor.map((a) => a.permission_code)).toEqual(["admin.audit_log.read"]);
    expect(auditor.every((a) => a.mutating === false)).toBe(true);
  });

  it("a code not yet in app.permission is skipped, not a foreign-key failure (F-21)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_permission rp
       where rp.tenant_id = ${tenantId} and rp.permission_code not in (select code from app.permission)`;
    expect(n!.n).toBe(0);
  });

  it("re-running grants nothing new and writes no audit row (§3.4.8 idempotence)", async () => {
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    const cfg = parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv);
    const ctx = { tenantId, actorId: systemPrincipalId, requestId: randomUUID() };
    const inserted = await withTenant(migrator, ctx, (tx) =>
      rolesLoader.load(tx, { config: cfg, tenantId, companyId: "", systemPrincipalId, packRoot: cfg.packRoot }));
    expect(inserted).toBe(0);
    const [after] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    expect(after!.n).toBe(before!.n);
  });

  it("tenant B cannot see tenant A's roles (spec:106 — a second tenant cannot see it)", async () => {
    const other = randomUUID();
    const rows = await withTenant(migrator, { tenantId: other, actorId: other, requestId: randomUUID() },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.role`);
    expect(rows[0]!.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed-roles.test.ts`
Expected: FAIL — `rolesLoader` is not exported by `../src/seed/roles`.

- [ ] **Step 3: Write `packages/db/src/seed/roles.ts`**

```ts
import type { Sql } from "postgres";
import { adminPermissions, ROLES, type RoleSeed } from "../../seed/roles";
import type { LoaderContext, PackLoader } from "./packs";

/**
 * Applies the nine system roles per tenant (§3.6.4; spec:2000 step 4). ⚠️ OWNER GATE OD-04 — the names live in
 * `packages/db/seed/roles.ts` (slice 0D) and this file never restates them.
 *
 * The catalogue is read from `app.permission`, not imported: `packages/db` may not import `@dulja/contracts`
 * (§5.2's dependency rule), and `role_permission.permission_code` has a foreign key to that table anyway, so the
 * database's contents are the only grantable set. A role naming a code the catalogue does not yet hold is
 * skipped rather than failed — F-21, the same tolerance the `role-seed` lint applies.
 *
 * The system principal is the actor (withTenant set it), so `forbid_self_grant` and `keep_last_admin_*` hold.
 */
export const rolesLoader: PackLoader = {
  name: "roles",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const catalogue = (await tx<{ code: string }[]>`select code from app.permission order by code`).map((r) => r.code);
    const present = new Set(catalogue);
    let inserted = 0;

    for (const role of ROLES as readonly RoleSeed[]) {
      const rows = await tx<{ id: string }[]>`
        insert into app.role (tenant_id, code, name_en, name_ar, description, is_system)
        values (${ctx.tenantId}, ${role.code}, ${role.nameEn}, ${role.nameAr}, ${role.description}, true)
        on conflict (tenant_id, code) do nothing
        returning id::text as id`;
      inserted += rows.length;

      const [existing] = rows.length > 0
        ? rows
        : await tx<{ id: string }[]>`select id::text as id from app.role where tenant_id = ${ctx.tenantId} and code = ${role.code}`;
      const roleId = existing!.id;

      const codes = role.code === "admin" ? adminPermissions(catalogue) : role.permissions.filter((c) => present.has(c));
      for (const code of codes) {
        const granted = await tx<{ role_id: string }[]>`
          insert into app.role_permission (tenant_id, role_id, permission_code)
          values (${ctx.tenantId}, ${roleId}, ${code})
          on conflict (role_id, permission_code) do nothing
          returning role_id::text as role_id`;
        inserted += granted.length;
      }
    }
    return inserted;
  },
};
```

- [ ] **Step 4: Run the loader from `seed()` and re-run the test**

In `packages/db/src/seed/index.ts`, add the loader registry and run the selected subset inside one `withTenant` per sub-pack (§4.2.6's "many short transactions" rule applied to the seed):

```ts
import { withTenant } from "../with-tenant";
import { rolesLoader } from "./roles";
import type { LoaderContext, PackLoader } from "./packs";

const LOADERS: Readonly<Record<SubPack, PackLoader>> = {
  roles: rolesLoader,
  // dimensions, fiscal-periods and chart-of-accounts arrive in Tasks 10 and 11.
} as Readonly<Record<SubPack, PackLoader>>;

export async function runLoaders(sql: Sql, ctx: LoaderContext, only: readonly SubPack[] | null, requestId: string): Promise<Record<SubPack, number>> {
  const applied: Record<SubPack, number> = { roles: 0, dimensions: 0, "fiscal-periods": 0, "chart-of-accounts": 0 };
  for (const name of only ?? SUB_PACKS) {
    const loader = LOADERS[name];
    if (!loader) throw new SeedError(`no loader for sub-pack ${name} — it ships with the slice that owns it (§3.4.8)`);
    applied[name] = await withTenant(sql, { tenantId: ctx.tenantId, actorId: ctx.systemPrincipalId, requestId }, (tx) => loader.load(tx, ctx));
  }
  return applied;
}
```

Run: `cd packages/db && bun run test -- test/seed-roles.test.ts`
Expected: PASS — 6 tests.

If the `admin` assertion returns fewer codes than the catalogue, `adminPermissions` was given a stale list — it must be re-read from `app.permission` inside the transaction, not captured at module load.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): per-tenant role applier, admin computed from app.permission (OD-04) [0C T8]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9 — **OWNER GATE OD-21**: bootstrap step 4 — the owner's Supabase user, the first company, the `admin` assignment

> **This task is isolated for owner decision OD-21** (contracts §2.12: "Owner login e-mail, legal name, MYR, fiscal-year start, service-role key"; spec:2400, §5.3 row "0.7b").
>
> **Owner provides:** the login e-mail for the first administrator; the company's **legal name**; the base currency (**MYR**); the fiscal-year start month; and the Supabase **service-role key** for the staging and production projects.
> **Verify with:** `bun run seed --tenant <id> --owner-email <email> --company-name "<legal name>" --currency MYR --fiscal-year-start <n>` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set — then the owner signs in to the back office, is prompted to enrol MFA at `aal1`, and after enrolling sees the company (Task 12 proves that chain).
> **Default written into this plan:** the fixture values §2.12 assigns — `owner@dulja.invalid`, `Dulja Test Company Sdn Bhd`, `MYR`, `Asia/Kuala_Lumpur`, fiscal year starting in January — and `StubSeedAuthAdmin`, which mints a deterministic `sub` so every test and every local run works end to end without a Supabase project.
> **If the owner's values differ:** they are five flags on one command. **No source file changes.**
> **If the service-role key is withheld:** the CLI warns and uses the stub; the tenant, company, roles and pack are all created and only the owner's *login* is missing. Nothing else in the slice blocks.

**Files:**
- Create: `packages/db/src/seed/auth-admin.ts`, `packages/db/src/seed/owner.ts`
- Modify: `packages/db/src/seed/index.ts`, `packages/db/src/cli.ts` (the auth-admin selection), `packages/db/package.json` (dependency `@supabase/supabase-js`)
- Test: `packages/db/test/seed-owner.test.ts`

**Interfaces:**
- Consumes: Task 7's `bootstrapIdentity`; Task 8's `rolesLoader`; Plan 0A's `app.company`, `app.role_assignment`, the `forbid_self_grant` and `assert_assignment_kind` triggers.
- Produces:

```ts
// packages/db/src/seed/auth-admin.ts — contract addition (assumption 4): 0B's AuthAdmin lives in apps/api and
// packages never import apps (§3.1), so the seed declares its own, narrower port.
export interface SeedAuthUser { readonly sub: string; readonly email: string }
export interface SeedAuthAdmin {
  /** Returns the existing user or null. Called BEFORE createUser so a second run never makes a second owner. */
  findByEmail(email: string): Promise<SeedAuthUser | null>;
  createUser(email: string): Promise<SeedAuthUser>;
}
export class SupabaseSeedAuthAdmin implements SeedAuthAdmin { constructor(url: string, serviceRoleKey: string) }
/** OD-21's local equivalent: a deterministic `sub` derived from the e-mail, and an in-memory registry.
 *  No constructor — the registry starts empty, and `createdCount` is how `seed-owner.test.ts` proves a second
 *  run made no second owner. (0B's `StubAuthAdmin` takes a `sub`; this one derives it, so there is nothing to pass.) */
export class StubSeedAuthAdmin implements SeedAuthAdmin { createdCount: number }

// packages/db/src/seed/owner.ts
export interface CompanyResult { readonly companyId: string }
export async function bootstrapCompany(sql: Sql, config: SeedConfig, systemPrincipalId: string, requestId: string): Promise<CompanyResult>;
export interface OwnerResult { readonly ownerPrincipalId: string; readonly authSubject: string }
export async function bootstrapOwner(sql: Sql, config: SeedConfig, ids: { systemPrincipalId: string; companyId: string }, authAdmin: SeedAuthAdmin, requestId: string): Promise<OwnerResult>;
```

- [ ] **Step 1: Verify the Supabase admin surface and pin it (assumption 7 pattern)**

```bash
bun add --cwd packages/db @supabase/supabase-js
node -p "const p=require('path'),f=require('fs'),d=p.dirname(require.resolve('@supabase/supabase-js/package.json'));f.readFileSync(p.join(d,'dist/module/index.d.ts'),'utf8')" | head -40
node -p "require('@supabase/auth-js/package.json').version"
```

Confirm from the installed type declarations, and write the answers into the header comment of `auth-admin.ts`: the accessor for the admin API (`client.auth.admin`), the method that creates a user with the service-role key, the method that lists or fetches users by e-mail, and the field carrying the subject (`user.id`). **If the "find by e-mail" method does not exist under any name in the installed version**, use the paged list method and filter — and say so in the comment. Do not guess a REST path: only the client's own typed surface is used.

- [ ] **Step 2: Write the failing test `packages/db/test/seed-owner.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { bootstrapIdentity } from "../src/seed/identity";
import { bootstrapCompany, bootstrapOwner } from "../src/seed/owner";
import { rolesLoader } from "../src/seed/roles";
import { withTenant } from "../src/with-tenant";
import { startDb, type Db } from "./harness";

describe("seed step 4 — owner, company, admin assignment (spec:2000; OWNER GATE OD-21)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  const cfg = () => parseSeedArgs(["--tenant", tenantId, "--owner-email", "owner@example.my", "--company-name", "Example Sdn Bhd"], {} as NodeJS.ProcessEnv);
  let systemPrincipalId = "";
  let companyId = "";
  const auth = new StubSeedAuthAdmin();

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    ({ systemPrincipalId } = await bootstrapIdentity(migrator, cfg(), randomUUID()));
    ({ companyId } = await bootstrapCompany(migrator, cfg(), systemPrincipalId, randomUUID()));
    await withTenant(migrator, { tenantId, actorId: systemPrincipalId, requestId: randomUUID() },
      (tx) => rolesLoader.load(tx, { config: cfg(), tenantId, companyId, systemPrincipalId, packRoot: cfg().packRoot }));
    await bootstrapOwner(migrator, cfg(), { systemPrincipalId, companyId }, auth, randomUUID());
  });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("the company carries the owner's legal name, MYR and the first customer's timezone (spec:2039)", async () => {
    const [c] = await db.admin<{ code: string; name: string; base_currency: string; timezone: string }[]>`
      select code, name, base_currency, timezone from app.company where id = ${companyId}`;
    expect(c).toEqual({ code: "HQ", name: "Example Sdn Bhd", base_currency: "MYR", timezone: "Asia/Kuala_Lumpur" });
  });

  it("the owner's principal carries the Supabase-obtained sub, never a client-supplied subject (spec:2132)", async () => {
    const [p] = await db.admin<{ kind: string; auth_subject: string; email: string }[]>`
      select kind::text, auth_subject, email from app.principal where email = 'owner@example.my'`;
    expect(p!.kind).toBe("human");
    expect(p!.auth_subject).toBe((await auth.findByEmail("owner@example.my"))!.sub);
    expect(p!.auth_subject).not.toMatch(/^(system|terminal):/);   // the 0001 CHECK; a prefix cannot impersonate a kind
  });

  it("the admin assignment is granted BY the system principal, so R5 no-self-grant holds (spec:2000)", async () => {
    const [a] = await db.admin<{ granted_by: string; principal_id: string; expires_at: string | null }[]>`
      select ra.granted_by::text, ra.principal_id::text, ra.expires_at::text
        from app.role_assignment ra join app.role r on r.id = ra.role_id
       where ra.tenant_id = ${tenantId} and r.code = 'admin'`;
    expect(a!.granted_by).toBe(systemPrincipalId);
    expect(a!.granted_by).not.toBe(a!.principal_id);
    expect(a!.expires_at).toBeNull();
  });

  it("the owner can answer test 14's question through app.actor_has", async () => {
    const [p] = await db.admin<{ id: string }[]>`select id::text as id from app.principal where email = 'owner@example.my'`;
    const rows = await withTenant(migrator, { tenantId, actorId: p!.id, requestId: randomUUID() },
      (tx) => tx<{ ok: boolean }[]>`select app.actor_has('admin.user.manage', ${companyId}, null) as ok`);
    expect(rows[0]!.ok).toBe(true);
  });

  it("a second run finds the existing auth user and inserts nothing — one owner, not two (spec:2317)", async () => {
    // `app.principal` has no tenant_id column (plan0A:988) — the membership row carries the tenant — so this
    // count is repository-wide. It runs on `db.admin` (the container superuser) precisely because the
    // `principal_in_tenant` policy would otherwise hide rows; this asserts a fact about the table, not about RLS.
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.principal`;
    const created = auth.createdCount;
    await bootstrapCompany(migrator, cfg(), systemPrincipalId, randomUUID());
    await bootstrapOwner(migrator, cfg(), { systemPrincipalId, companyId }, auth, randomUUID());
    expect(auth.createdCount).toBe(created);
    const [after] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.principal`;
    expect(after!.n).toBe(before!.n);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed-owner.test.ts`
Expected: FAIL — `Failed to resolve import "../src/seed/auth-admin"`.

- [ ] **Step 4: Write `packages/db/src/seed/auth-admin.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

/**
 * The seed's own, narrower auth port. 0B declares `AuthAdmin` in `apps/api/src/ports.ts`; `packages` never
 * import `apps` (§3.1), so this is a contract addition, recorded in plan 0C's Self-Review.
 *
 * Verified against @supabase/supabase-js <VERSION> in Task 9 Step 1: the admin API is `client.auth.admin`, a user
 * is created with `createUser({ email, email_confirm })`, users are listed with `listUsers({ page, perPage })`,
 * and the subject is `user.id`. No REST path or endpoint shape is written anywhere in this repository.
 */
export interface SeedAuthUser { readonly sub: string; readonly email: string }

export interface SeedAuthAdmin {
  findByEmail(email: string): Promise<SeedAuthUser | null>;
  createUser(email: string): Promise<SeedAuthUser>;
}

export class SupabaseSeedAuthAdmin implements SeedAuthAdmin {
  readonly #client;
  constructor(url: string, serviceRoleKey: string) {
    // The service-role key exists in the seed CLI and nowhere else (§3.11, spec:2273).
    this.#client = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  }

  async findByEmail(email: string): Promise<SeedAuthUser | null> {
    const wanted = email.toLowerCase();
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await this.#client.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
      if (hit) return { sub: hit.id, email: hit.email ?? email };
      if (data.users.length < 200) return null;
    }
    return null;
  }

  async createUser(email: string): Promise<SeedAuthUser> {
    // No password: the owner sets one through Supabase's own recovery flow. The application never stores or
    // compares a password (spec:2131, LEGACY-028), and MFA is enrolled at first login (spec:2004).
    const { data, error } = await this.#client.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    return { sub: data.user.id, email: data.user.email ?? email };
  }
}

/**
 * OD-21's local equivalent. A deterministic subject per e-mail, so a re-run in a test finds the same user.
 * `node:crypto` rather than `Bun.hash`: the CLI runs under Bun and Vitest under Node 24 (D5), and the stub has
 * to work under both. The `stub-` prefix keeps it obviously not a Supabase `sub` in any dump.
 */
export class StubSeedAuthAdmin implements SeedAuthAdmin {
  readonly #users = new Map<string, SeedAuthUser>();
  createdCount = 0;
  async findByEmail(email: string): Promise<SeedAuthUser | null> { return this.#users.get(email.toLowerCase()) ?? null; }
  async createUser(email: string): Promise<SeedAuthUser> {
    const key = email.toLowerCase();
    const user: SeedAuthUser = { sub: `stub-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`, email };
    this.#users.set(key, user);
    this.createdCount++;
    return user;
  }
}
```

Its import block is `import { createHash } from "node:crypto";` above the `@supabase/supabase-js` import.

- [ ] **Step 5: Write `packages/db/src/seed/owner.ts`**

```ts
import type { Sql } from "postgres";
import { withTenant } from "../with-tenant";
import type { SeedConfig } from "./config";
import type { SeedAuthAdmin } from "./auth-admin";

export interface CompanyResult { readonly companyId: string }

/** The first company (spec:2000): base currency and timezone are OWNER GATE OD-21 values. */
export async function bootstrapCompany(sql: Sql, config: SeedConfig, systemPrincipalId: string, requestId: string): Promise<CompanyResult> {
  return withTenant(sql, { tenantId: config.tenantId, actorId: systemPrincipalId, requestId }, async (tx) => {
    await tx`insert into app.company (tenant_id, code, name, base_currency, timezone)
             values (${config.tenantId}, ${config.companyCode}, ${config.companyName}, ${config.baseCurrency}, ${config.timezone})
             on conflict (tenant_id, code) do nothing`;
    const [row] = await tx<{ id: string }[]>`
      select id::text as id from app.company where tenant_id = ${config.tenantId} and code = ${config.companyCode}`;
    return { companyId: row!.id };
  });
}

export interface OwnerResult { readonly ownerPrincipalId: string; readonly authSubject: string }

/**
 * Step 4's identity half. The Supabase user is created through the admin API **before** the principal, because
 * spec:2132 fixes the rule: "Inviting a user creates the `principal` from the `sub` returned by the Supabase
 * admin invite call, never from a subject supplied by the client." `findByEmail` runs first, so a second seed run
 * adopts the existing user rather than creating a second owner.
 *
 * The `admin` assignment is granted with the **system principal** as the actor, which is what makes it legal:
 * `forbid_self_grant` (R5) rejects a principal granting a role to themselves (plan0A:1130).
 *
 * **The lookup happens BEFORE the insert, never between the principal insert and the membership insert.**
 * `principal_in_tenant` — the only SELECT policy on `app.principal` — is
 * `using (exists (select 1 from app.membership m where m.principal_id = id and m.tenant_id = app.current_tenant()))`
 * (plan0A:1008–1009), and the table is FORCE ROW LEVEL SECURITY (plan0A:1006), which binds `app_migrator` too.
 * A brand-new principal has no membership yet, so a SELECT placed after the insert returns **zero rows** on the
 * first run and the next line dereferences `undefined`. This is the same shape `bootstrapIdentity` uses, and the
 * same reason plan0A's `principal_insert` policy comment gives for "insert principal + membership in ONE
 * transaction": the row is not readable until its membership exists.
 */
export async function bootstrapOwner(
  sql: Sql, config: SeedConfig, ids: { systemPrincipalId: string; companyId: string },
  authAdmin: SeedAuthAdmin, requestId: string,
): Promise<OwnerResult> {
  const user = (await authAdmin.findByEmail(config.ownerEmail)) ?? (await authAdmin.createUser(config.ownerEmail));

  return withTenant(sql, { tenantId: config.tenantId, actorId: ids.systemPrincipalId, requestId }, async (tx) => {
    // Look first: this succeeds only on a re-run, where the membership already exists and the policy admits the row.
    const found = await tx<{ id: string }[]>`select id::text as id from app.principal where auth_subject = ${user.sub}`;
    const [minted] = await tx<{ id: string }[]>`select uuidv7()::text as id`;
    const ownerPrincipalId = found[0]?.id ?? minted!.id;

    // No RETURNING (v1.1 fix #2): principal_insert has no USING clause to read the row back through — which is
    // also why the id is minted here rather than read back afterwards.
    await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
             values (${ownerPrincipalId}, 'human', ${user.sub}, ${user.email}, ${config.ownerEmail})
             on conflict (auth_subject) do nothing`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${config.tenantId}, ${ownerPrincipalId})
             on conflict (tenant_id, principal_id) do nothing`;

    const [adminRole] = await tx<{ id: string }[]>`
      select id::text as id from app.role where tenant_id = ${config.tenantId} and code = 'admin'`;
    if (!adminRole) {
      throw new Error("the `admin` role is not seeded — run the `roles` loader before the owner step (§3.6.4)");
    }
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
             values (${config.tenantId}, ${ownerPrincipalId}, ${adminRole.id}, ${ids.companyId})
             on conflict (principal_id, role_id, company_id) do nothing`;
    return { ownerPrincipalId, authSubject: user.sub };
  });
}
```

- [ ] **Step 6: Assemble `seed()` and wire the CLI**

`packages/db/src/seed/index.ts` — the final orchestration:

```ts
export async function seed(sql: Sql, config: SeedConfig, authAdmin: SeedAuthAdmin): Promise<SeedResult> {
  const requestId = randomUUID();
  const identity = await bootstrapIdentity(sql, config, requestId);
  const { companyId } = await bootstrapCompany(sql, config, identity.systemPrincipalId, requestId);
  const ctx: LoaderContext = { config, tenantId: config.tenantId, companyId, systemPrincipalId: identity.systemPrincipalId, packRoot: config.packRoot };
  const applied = await runLoaders(sql, ctx, config.only, requestId);
  // The owner is last: their `admin` assignment needs the role the `roles` loader creates.
  // `--only` skips the OWNER step alone. Identity and company always run, above: they are idempotent, and the
  // loaders need a tenant, a system principal to act as, and a company to write into. Skipping the owner is what
  // keeps `--only` from calling the Supabase admin API on every re-apply.
  const owner = config.only
    ? { ownerPrincipalId: "", authSubject: "" }
    : await bootstrapOwner(sql, config, { systemPrincipalId: identity.systemPrincipalId, companyId }, authAdmin, requestId);
  return { tenantId: config.tenantId, companyId, ownerPrincipalId: owner.ownerPrincipalId, systemPrincipalId: identity.systemPrincipalId, applied, created: identity.created };
}
```

and add the re-exports Task 6 deferred: `export type { SeedAuthAdmin, SeedAuthUser } from "./auth-admin"; export { StubSeedAuthAdmin, SupabaseSeedAuthAdmin } from "./auth-admin";`

`packages/db/src/cli.ts` — the seed branch gains the auth-admin selection immediately before the `seed(...)` call:

```ts
    const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    const supabaseUrl = process.env["SUPABASE_URL"];
    if (!(key && supabaseUrl)) {
      console.warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using the stub auth admin (OWNER GATE OD-21). The owner cannot log in until they are.");
    }
    const authAdmin = key && supabaseUrl ? new SupabaseSeedAuthAdmin(supabaseUrl, key) : new StubSeedAuthAdmin();
```

and the call becomes `await seed(sql, config, authAdmin)`.

- [ ] **Step 7: Run the test and commit**

Run: `cd packages/db && bun run test -- test/seed-owner.test.ts && bun run typecheck`
Expected: PASS — 5 tests.

If the first run throws `TypeError: Cannot read properties of undefined (reading 'id')` inside `bootstrapOwner`, a SELECT on `app.principal` was placed **after** the principal insert and before the membership insert: `principal_in_tenant` cannot see a principal that has no membership yet (plan0A:1008), so it returns zero rows. Look the subject up first and use the minted id — the shape written above.
If the assignment insert fails with `ERR_RBAC_SELF_GRANT`, `withTenant` was opened with the owner as the actor: the acting principal for step 4 is always the **system** principal.
If it fails with `ERR_RBAC_KIND`, the `admin` role's code was renamed to `pos_terminal` or the principal's kind is not `human` — `assert_assignment_kind` names the fixed literal `pos_terminal` (plan0A:1416).

```bash
git add -A
git commit -m "feat(db): seed step 4 — owner auth user, first company, admin assignment (OD-21) [0C T9]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: the `dimensions` and `fiscal-periods` sub-packs and their loaders

The BRANCH dimension type and its head-office value (spec:2000) and the fiscal periods of the current year (spec:2001). Both are per-tenant rows and therefore seed-pack data (§3.4.8); both are sub-pack directories under `packages/db/seed/my/`, so `--only dimensions` and `--only fiscal-periods` work and Task 6's `assertPackShape` has three directories to find.

**Files:**
- Create: `packages/db/seed/my/dimensions/branch.json`, `packages/db/seed/my/fiscal-periods/monthly.json`, `packages/db/src/seed/dimensions.ts`, `packages/db/src/seed/fiscal-periods.ts`
- Modify: `packages/db/src/seed/index.ts` (`LOADERS`)
- Test: `packages/db/test/seed-dimensions.test.ts`, `packages/db/test/seed-periods.test.ts`

**Interfaces:**
- Consumes: Task 6's `PackLoader`, `LoaderContext`, `readPackFile`; Plan 0A's `app.dimension_type` (`unique (company_id, code)`), `app.dimension_value` (`unique (dimension_type_id, code)`) and `app.fiscal_period` (the `exclude using gist` overlap constraint).
- Produces: `export const dimensionsLoader: PackLoader`, `export const fiscalPeriodsLoader: PackLoader`, and the two JSON shapes:

```ts
// packages/db/seed/my/dimensions/branch.json
export interface DimensionSeed { readonly code: string; readonly nameEn: string; readonly values: readonly { code: string; nameEn: string }[] }
// packages/db/seed/my/fiscal-periods/monthly.json
export interface CalendarSeed { readonly periodsPerYear: 12; readonly status: "open" }
```

- [ ] **Step 1: Write the two pack files**

`packages/db/seed/my/dimensions/branch.json` — one array so a later slice adds a dimension by adding an element, not by editing a loader:

```json
[
  {
    "code": "BRANCH",
    "nameEn": "Branch",
    "values": [{ "code": "HQ", "nameEn": "Head office" }]
  }
]
```

`packages/db/seed/my/fiscal-periods/monthly.json`:

```json
{
  "periodsPerYear": 12,
  "status": "open"
}
```

> The fiscal-year **start month** is deliberately not in this file: it is an OWNER GATE OD-21 value and arrives as `--fiscal-year-start` on `SeedConfig` (Task 9). The pack describes the shape of a Malaysian monthly calendar; the owner describes their year.

- [ ] **Step 2: Write the failing tests**

`packages/db/test/seed-dimensions.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { seed } from "../src/seed";
import { startDb, type Db } from "./harness";

describe("the dimensions loader — BRANCH and head office (spec:2000)", () => {
  let db: Db; let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let companyId = "";
  beforeAll(async () => {
    db = await startDb(); migrator = createDb(db.url("app_migrator"));
    ({ companyId } = await seed(migrator, parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv), new StubSeedAuthAdmin()));
  });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("creates the BRANCH type and its head-office value, bilingual columns and not a blob (spec:2045)", async () => {
    const [t] = await db.admin<{ id: string; name_en: string }[]>`
      select id::text as id, name_en from app.dimension_type where company_id = ${companyId} and code = 'BRANCH'`;
    expect(t!.name_en).toBe("Branch");
    const values = await db.admin<{ code: string; name_en: string }[]>`
      select code, name_en from app.dimension_value where dimension_type_id = ${t!.id} order by code`;
    expect(values).toEqual([{ code: "HQ", name_en: "Head office" }]);
  });

  it("the head-office value is a legal branch for role_assignment_branch and document.branch_id", async () => {
    const [v] = await db.admin<{ id: string }[]>`
      select dv.id::text as id from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
       where dt.company_id = ${companyId} and dt.code = 'BRANCH' and dv.code = 'HQ'`;
    const [fk] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value where id = ${v!.id}`;
    expect(fk!.n).toBe(1);
  });

  it("re-running inserts nothing", async () => {
    const cfg = parseSeedArgs(["--tenant", tenantId, "--only", "dimensions"], {} as NodeJS.ProcessEnv);
    const again = await seed(migrator, cfg, new StubSeedAuthAdmin());
    expect(again.applied.dimensions).toBe(0);
  });
});
```

`packages/db/test/seed-periods.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { seed } from "../src/seed";
import { startDb, type Db } from "./harness";

describe("the fiscal-periods loader — the current fiscal year (spec:2001)", () => {
  let db: Db; let migrator: ReturnType<typeof createDb>;
  beforeAll(async () => { db = await startDb(); migrator = createDb(db.url("app_migrator")); });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  const run = async (extra: readonly string[]) => {
    const tenantId = randomUUID();
    const cfg = parseSeedArgs(["--tenant", tenantId, "--fiscal-year", "2026", ...extra], {} as NodeJS.ProcessEnv);
    const r = await seed(migrator, cfg, new StubSeedAuthAdmin());
    const rows = await db.admin<{ starts_on: string; ends_on: string; status: string }[]>`
      select starts_on::text, ends_on::text, status::text from app.fiscal_period
       where company_id = ${r.companyId} order by starts_on`;
    return { r, rows };
  };

  it("a January year start gives twelve open calendar months, first to last day", async () => {
    const { r, rows } = await run([]);
    expect(r.applied["fiscal-periods"]).toBe(12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ starts_on: "2026-01-01", ends_on: "2026-01-31", status: "open" });
    expect(rows[1]!.ends_on).toBe("2026-02-28");             // 2026 is not a leap year
    expect(rows[11]).toEqual({ starts_on: "2026-12-01", ends_on: "2026-12-31", status: "open" });
  });

  it("an April year start runs April 2026 to March 2027 with no gap and no overlap", async () => {
    const { rows } = await run(["--fiscal-year-start", "4"]);
    expect(rows[0]!.starts_on).toBe("2026-04-01");
    expect(rows[11]!.ends_on).toBe("2027-03-31");
    for (let i = 1; i < rows.length; i++) {
      const previousEnd = new Date(`${rows[i - 1]!.ends_on}T00:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      expect(rows[i]!.starts_on).toBe(previousEnd.toISOString().slice(0, 10));
    }
  });

  it("re-running inserts nothing — the overlap exclusion constraint arbitrates the targetless DO NOTHING", async () => {
    const tenantId = randomUUID();
    const cfg = parseSeedArgs(["--tenant", tenantId, "--fiscal-year", "2026"], {} as NodeJS.ProcessEnv);
    await seed(migrator, cfg, new StubSeedAuthAdmin());
    const again = await seed(migrator, parseSeedArgs(["--tenant", tenantId, "--fiscal-year", "2026", "--only", "fiscal-periods"], {} as NodeJS.ProcessEnv), new StubSeedAuthAdmin());
    expect(again.applied["fiscal-periods"]).toBe(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/db && bun run test -- test/seed-dimensions.test.ts test/seed-periods.test.ts`
Expected: FAIL — `no loader for sub-pack dimensions`.

- [ ] **Step 4: Write the two loaders**

`packages/db/src/seed/dimensions.ts`:

```ts
import type { Sql } from "postgres";
import { readPackFile } from "./packs";
import type { LoaderContext, PackLoader } from "./packs";

/** One element per dimension type, so a later slice adds a type by adding an element to branch.json's array. */
interface DimensionSeed { readonly code: string; readonly nameEn: string; readonly values: readonly { code: string; nameEn: string }[] }

/**
 * spec:2000 step 4: "the `BRANCH` dimension type and head-office value". `role_assignment_branch.branch_id`,
 * `document.branch_id` and `pos_terminal.branch_id` all reference `dimension_value` rows of this type
 * (plan0A:1836–1838), so nothing that carries a branch can be created until this loader has run.
 *
 * `name_ar` is not written here: 0D's migration 0007 adds the column, and the Arabic labels for BRANCH and HQ are
 * i18n catalogue entries (0E) rather than tenant data — a tenant's own branch names arrive through the dimension
 * API (0D) with both labels.
 */
export const dimensionsLoader: PackLoader = {
  name: "dimensions",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const types = readPackFile<readonly DimensionSeed[]>(ctx.packRoot, "dimensions", "branch.json");
    let inserted = 0;
    for (const type of types) {
      const created = await tx<{ id: string }[]>`
        insert into app.dimension_type (tenant_id, company_id, code, name_en)
        values (${ctx.tenantId}, ${ctx.companyId}, ${type.code}, ${type.nameEn})
        on conflict (company_id, code) do nothing
        returning id::text as id`;
      inserted += created.length;
      const [row] = created.length > 0 ? created : await tx<{ id: string }[]>`
        select id::text as id from app.dimension_type where company_id = ${ctx.companyId} and code = ${type.code}`;
      for (const value of type.values) {
        const v = await tx<{ id: string }[]>`
          insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
          values (${ctx.tenantId}, ${row!.id}, ${value.code}, ${value.nameEn})
          on conflict (dimension_type_id, code) do nothing
          returning id::text as id`;
        inserted += v.length;
      }
    }
    return inserted;
  },
};
```

`packages/db/src/seed/fiscal-periods.ts`:

```ts
import type { Sql } from "postgres";
import { readPackFile } from "./packs";
import type { LoaderContext, PackLoader } from "./packs";

interface CalendarSeed { readonly periodsPerYear: 12; readonly status: "open" }

/** UTC-only date arithmetic: `effective_date` is a `date` and a fiscal period is a calendar fact, never a moment. */
function monthBounds(year: number, monthIndex: number): { startsOn: string; endsOn: string } {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));       // day 0 of the next month is the last of this one
  return { startsOn: start.toISOString().slice(0, 10), endsOn: end.toISOString().slice(0, 10) };
}

/**
 * spec:2001: "fiscal periods for the current year". Twelve calendar months from the owner's fiscal-year start
 * month (OWNER GATE OD-21, `--fiscal-year-start`), all `open`; closing and locking are 1A's.
 *
 * **The conflict clause has no target on purpose.** `app.fiscal_period` carries no unique constraint on
 * `(company_id, starts_on)` — its guard is `exclude using gist (company_id with =, daterange(starts_on, ends_on,
 * '[]') with &&)` (plan0A:1480). Postgres accepts an exclusion constraint as the arbiter of `ON CONFLICT DO
 * NOTHING` **only** in the targetless form; naming a target would raise "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification" on the first re-run.
 */
export const fiscalPeriodsLoader: PackLoader = {
  name: "fiscal-periods",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const calendar = readPackFile<CalendarSeed>(ctx.packRoot, "fiscal-periods", "monthly.json");
    const firstMonthIndex = ctx.config.fiscalYearStartMonth - 1;
    let inserted = 0;
    for (let i = 0; i < calendar.periodsPerYear; i++) {
      const { startsOn, endsOn } = monthBounds(ctx.config.fiscalYear, firstMonthIndex + i);
      const rows = await tx<{ id: string }[]>`
        insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on, status)
        values (${ctx.tenantId}, ${ctx.companyId}, ${startsOn}, ${endsOn}, ${calendar.status}::app.period_status)
        on conflict do nothing
        returning id::text as id`;
      inserted += rows.length;
    }
    return inserted;
  },
};
```

- [ ] **Step 5: Register both loaders and run the tests**

In `packages/db/src/seed/index.ts`, `LOADERS` becomes:

```ts
const LOADERS: Partial<Record<SubPack, PackLoader>> = {
  roles: rolesLoader,
  dimensions: dimensionsLoader,
  "fiscal-periods": fiscalPeriodsLoader,
  // chart-of-accounts arrives in Task 11.
};
```

Run: `cd packages/db && bun run test -- test/seed-dimensions.test.ts test/seed-periods.test.ts`
Expected: PASS — 3 + 3 tests.

If the April case ends in `2027-03-31` but the January case's February is `2026-02-29`, `monthBounds` used local time: `Date.UTC` is required in both calls.
If the re-run inserts twelve rows again, the `on conflict` clause has a target — remove it (see the comment above).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): dimensions and fiscal-periods sub-packs and loaders [0C T10]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: the `chart-of-accounts` sub-pack — `0c-base.json`, the loader, and `company.fx_rounding_account_id`

§4.15's register assigns 0C **exactly eleven leaf codes** — `1000`, `1100`, `1200`, `1300`, `2100`, `4000`, `4900`, `5000`, `5900`, `5910`, `5920` — plus whatever `is_group = true` parents the pack wants for presentation. spec:2001 then requires the FX-rounding account to be linked: "chart of accounts (including the FX-rounding account, then set `company.fx_rounding_account_id`)".

**Files:**
- Create: `packages/db/seed/my/chart-of-accounts/0c-base.json`, `packages/db/src/seed/chart-of-accounts.ts`
- Modify: `packages/db/src/seed/index.ts` (`LOADERS`)
- Test: `packages/db/test/seed-chart.test.ts`

**Interfaces:**
- Consumes: Task 6's `PackLoader` / `readPackFile`; Plan 0A's `app.account` (`unique (company_id, code)`, `is_group`, `parent_id` composite FK) and `app.company.fx_rounding_account_id` with its composite FK `company_fx_rounding_account_fk`.
- Produces: `export const chartOfAccountsLoader: PackLoader`, and the file shape §4.15 fixes:

```ts
export interface AccountSeed { readonly code: string; readonly nameEn: string; readonly nameAr: string; readonly type: "asset" | "liability" | "equity" | "income" | "expense"; readonly parentCode?: string; readonly currency?: string; readonly isGroup?: boolean }
export const FX_ROUNDING_ACCOUNT_CODE = "5920";
```

**Code format, enforced here and nowhere else.** §4.15 freezes `^[1-5][0-9]{3}$` with the first digit equal to the `account_type` in the `app.account_type` enum's own order (`1` asset, `2` liability, `3` equity, `4` income, `5` expense). It is **not** a DDL CHECK — a tenant may add accounts under `accounting.account.manage` with any code its accountant wants — so the loader validates the pack and throws `SeedError` naming the file and the code.

- [ ] **Step 1: Write `packages/db/seed/my/chart-of-accounts/0c-base.json`**

Five group parents (unregistered by §4.15 — "group codes are unregistered … and no policy resolves them") then the eleven leaves, in code order. **Every `nameEn` below is §4.15's `name_en` column, character for character** — `1200` is `Trade receivables (AR control)` and `2100` is `Trade payables (AP control)`, because resolution is by code but the register is the authority for the literal, and 4B's ageing tie-out reads these names in its report headings. `isGroup` is the field §4.15's declared shape carries for exactly this purpose (folded in by §4.18 round 1; Task 1 Step 0 greps for it); the parent rows cannot be expressed without it.

```json
[
  { "code": "1", "nameEn": "Assets", "nameAr": "الأصول", "type": "asset", "isGroup": true },
  { "code": "2", "nameEn": "Liabilities", "nameAr": "الخصوم", "type": "liability", "isGroup": true },
  { "code": "3", "nameEn": "Equity", "nameAr": "حقوق الملكية", "type": "equity", "isGroup": true },
  { "code": "4", "nameEn": "Income", "nameAr": "الإيرادات", "type": "income", "isGroup": true },
  { "code": "5", "nameEn": "Expenses", "nameAr": "المصروفات", "type": "expense", "isGroup": true },

  { "code": "1000", "nameEn": "Cash on hand", "nameAr": "النقد في الصندوق", "type": "asset", "parentCode": "1" },
  { "code": "1100", "nameEn": "Bank", "nameAr": "البنك", "type": "asset", "parentCode": "1" },
  { "code": "1200", "nameEn": "Trade receivables (AR control)", "nameAr": "الذمم المدينة التجارية", "type": "asset", "parentCode": "1" },
  { "code": "1300", "nameEn": "Inventory control", "nameAr": "مراقبة المخزون", "type": "asset", "parentCode": "1" },
  { "code": "2100", "nameEn": "Trade payables (AP control)", "nameAr": "الذمم الدائنة التجارية", "type": "liability", "parentCode": "2" },
  { "code": "4000", "nameEn": "Sales", "nameAr": "المبيعات", "type": "income", "parentCode": "4" },
  { "code": "4900", "nameEn": "Foreign-exchange gain", "nameAr": "أرباح فروق العملة", "type": "income", "parentCode": "4" },
  { "code": "5000", "nameEn": "Cost of goods sold", "nameAr": "تكلفة البضاعة المباعة", "type": "expense", "parentCode": "5" },
  { "code": "5900", "nameEn": "Other operating expense", "nameAr": "مصروفات تشغيلية أخرى", "type": "expense", "parentCode": "5" },
  { "code": "5910", "nameEn": "Foreign-exchange loss", "nameAr": "خسائر فروق العملة", "type": "expense", "parentCode": "5" },
  { "code": "5920", "nameEn": "FX rounding", "nameAr": "تقريب فروق العملة", "type": "expense", "parentCode": "5" }
]
```

- [ ] **Step 2: Write the failing test `packages/db/test/seed-chart.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { seed, SeedError } from "../src/seed";
import { seedTenant } from "./fixtures";
import { startDb, type Db } from "./harness";

const ZERO_C_LEAVES = ["1000", "1100", "1200", "1300", "2100", "4000", "4900", "5000", "5900", "5910", "5920"];

describe("the chart-of-accounts loader — §4.15's eleven 0C leaves and the FX-rounding link (spec:2001)", () => {
  let db: Db; let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let companyId = "";
  beforeAll(async () => {
    db = await startDb(); migrator = createDb(db.url("app_migrator"));
    ({ companyId } = await seed(migrator, parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv), new StubSeedAuthAdmin()));
  });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("seeds exactly the eleven registered leaves, and every group parent is is_group", async () => {
    const rows = await db.admin<{ code: string; is_group: boolean; type: string }[]>`
      select code, is_group, type::text from app.account where company_id = ${companyId} order by code`;
    expect(rows.filter((r) => !r.is_group).map((r) => r.code)).toEqual(ZERO_C_LEAVES);
    expect(rows.filter((r) => r.is_group).map((r) => r.code)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("the first digit is the account_type in the enum's own order (§4.15's format rule)", async () => {
    const digit: Record<string, string> = { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" };
    const rows = await db.admin<{ code: string; type: string }[]>`
      select code, type::text from app.account where company_id = ${companyId}`;
    for (const r of rows) expect(r.code[0], r.code).toBe(digit[r.type]);
  });

  it("every leaf hangs off its group parent through the composite FK", async () => {
    const rows = await db.admin<{ code: string; parent_code: string | null }[]>`
      select a.code, p.code as parent_code from app.account a left join app.account p on p.id = a.parent_id
       where a.company_id = ${companyId} and a.is_group = false order by a.code`;
    for (const r of rows) expect(r.parent_code, r.code).toBe(r.code[0]);
  });

  it("company.fx_rounding_account_id points at 5920 immediately after insertion (spec:2001)", async () => {
    const [row] = await db.admin<{ code: string }[]>`
      select a.code from app.company c join app.account a on a.id = c.fx_rounding_account_id where c.id = ${companyId}`;
    expect(row!.code).toBe("5920");
  });

  it("bilingual labels are columns, never a blob (spec:2045)", async () => {
    const [row] = await db.admin<{ name_en: string; name_ar: string }[]>`
      select name_en, name_ar from app.account where company_id = ${companyId} and code = '5920'`;
    expect(row!.name_en).toBe("FX rounding");
    expect(row!.name_ar.length).toBeGreaterThan(0);
  });

  it("re-running inserts nothing and writes no audit row — the fx link update is `is distinct from`-guarded", async () => {
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    const again = await seed(migrator, parseSeedArgs(["--tenant", tenantId, "--only", "chart-of-accounts"], {} as NodeJS.ProcessEnv), new StubSeedAuthAdmin());
    expect(again.applied["chart-of-accounts"]).toBe(0);
    const [after] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    expect(after!.n).toBe(before!.n);
  });

  it("the pack does not collide with Plan 0A's fixture accounts 1000 Cash and 4000 Sales (§4.15)", async () => {
    // `seedTenant` creates its company with code 'HQ' (plan0A:1591) and `parseSeedArgs`'s default
    // `companyCode` is "HQ" (Task 6), so `bootstrapCompany`'s `on conflict (tenant_id, code) do nothing`
    // adopts the fixture's own company row and the loader writes into it. The collision is real, not avoided
    // by writing into a second company — which is exactly what this case has to prove.
    const s = await seedTenant(db, "Fixture");
    const before = await db.admin<{ id: string; code: string; name_en: string }[]>`
      select id::text as id, code, name_en from app.account
       where company_id = ${s.company} and code in ('1000', '4000') order by code`;
    expect(before.map((r) => r.id).sort()).toEqual([s.cash, s.sales].sort());

    const cfg = parseSeedArgs(["--tenant", s.tenant, "--only", "chart-of-accounts"], {} as NodeJS.ProcessEnv);
    const result = await seed(migrator, cfg, new StubSeedAuthAdmin());
    expect(result.companyId).toBe(s.company);      // the loader targeted the fixture's company, not a new one

    const after = await db.admin<{ id: string; code: string; name_en: string }[]>`
      select id::text as id, code, name_en from app.account
       where company_id = ${s.company} and code in ('1000', '4000') order by code`;
    expect(after).toHaveLength(2);                 // one each — no duplicate row
    expect(after).toEqual(before);                 // adopted, not overwritten: same ids, and 'Cash'/'Sales' intact
  });

  it("a code that breaks the format is rejected by name, not silently loaded (ERR_VALIDATION_FAILED)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dulja-bad-"));
    for (const d of ["chart-of-accounts", "dimensions", "fiscal-periods"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "dimensions", "branch.json"), "[]");
    writeFileSync(join(root, "fiscal-periods", "monthly.json"), '{"periodsPerYear":12,"status":"open"}');
    writeFileSync(join(root, "chart-of-accounts", "0c-base.json"),
      '[{"code":"9999","nameEn":"Bad","nameAr":"سيئ","type":"expense"}]');
    const cfg = parseSeedArgs(["--tenant", randomUUID(), "--pack", root], {} as NodeJS.ProcessEnv);
    await expect(seed(migrator, cfg, new StubSeedAuthAdmin())).rejects.toThrow(SeedError);
    await expect(seed(migrator, cfg, new StubSeedAuthAdmin())).rejects
      .toThrow(/chart-of-accounts\/0c-base\.json: account code '9999' does not match \^\[1-5\]\[0-9\]\{3\}\$ with first digit 5 for type expense/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/seed-chart.test.ts`
Expected: FAIL — `no loader for sub-pack chart-of-accounts`.

- [ ] **Step 4: Write `packages/db/src/seed/chart-of-accounts.ts`**

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { SeedError } from "./types";
import { readPackFile } from "./packs";
import type { LoaderContext, PackLoader } from "./packs";

export interface AccountSeed {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly type: "asset" | "liability" | "equity" | "income" | "expense";
  readonly parentCode?: string;
  readonly currency?: string;
  readonly isGroup?: boolean;
}

/** §4.15: `company.fx_rounding_account_id` is set to this code immediately after it is inserted (spec:2001). */
export const FX_ROUNDING_ACCOUNT_CODE = "5920";

/** §4.15's frozen format: four digits, first digit = the account_type in the app.account_type enum's own order. */
const TYPE_DIGIT: Readonly<Record<AccountSeed["type"], string>> = {
  asset: "1", liability: "2", equity: "3", income: "4", expense: "5",
};
const LEAF_CODE = /^[1-5][0-9]{3}$/;

function validate(file: string, rows: readonly AccountSeed[]): void {
  for (const a of rows) {
    if (a.isGroup) continue;                                   // group codes are unregistered by §4.15
    if (!LEAF_CODE.test(a.code) || a.code[0] !== TYPE_DIGIT[a.type]) {
      throw new SeedError(
        `chart-of-accounts/${file}: account code '${a.code}' does not match ^[1-5][0-9]{3}$ with first digit ${TYPE_DIGIT[a.type]} for type ${a.type}`,
      );
    }
  }
}

/**
 * §3.4.8's "add a file, never a loader" rule made concrete: every `.json` in the sub-pack is loaded, so 3C, 3D,
 * 5A, 6A, 6D, 8B and 9B each add `<slice>.json` (§4.15's file-per-slice layout) and none of them edits this file
 * or a shared chart. Files are applied in name order, which puts `0c-base.json` and its group parents first.
 *
 * A parent is resolved by code within the same run, so a later slice's file may hang rows off 0C's groups.
 */
export const chartOfAccountsLoader: PackLoader = {
  name: "chart-of-accounts",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const files = readdirSync(join(ctx.packRoot, "chart-of-accounts")).filter((f) => f.endsWith(".json")).sort();
    let inserted = 0;

    for (const file of files) {
      const rows = readPackFile<readonly AccountSeed[]>(ctx.packRoot, "chart-of-accounts", file);
      validate(file, rows);
      for (const a of rows) {
        const parent = a.parentCode
          ? (await tx<{ id: string }[]>`select id::text as id from app.account where company_id = ${ctx.companyId} and code = ${a.parentCode}`)[0]
          : undefined;
        if (a.parentCode && !parent) throw new SeedError(`chart-of-accounts/${file}: account '${a.code}' names parent '${a.parentCode}', which is not in the pack`);
        const created = await tx<{ id: string }[]>`
          insert into app.account (tenant_id, company_id, code, name_en, name_ar, type, parent_id, is_group, currency)
          values (${ctx.tenantId}, ${ctx.companyId}, ${a.code}, ${a.nameEn}, ${a.nameAr},
                  ${a.type}::app.account_type, ${parent?.id ?? null}, ${a.isGroup ?? false}, ${a.currency ?? null})
          on conflict (company_id, code) do nothing
          returning id::text as id`;
        inserted += created.length;
      }
    }

    // spec:2001 "then set company.fx_rounding_account_id". `is distinct from` keeps the re-run silent: an
    // unguarded UPDATE fires the AFTER ROW audit trigger every deploy, which would break "changes nothing".
    const [fx] = await tx<{ id: string }[]>`
      select id::text as id from app.account where company_id = ${ctx.companyId} and code = ${FX_ROUNDING_ACCOUNT_CODE}`;
    if (!fx) throw new SeedError(`chart-of-accounts: the pack does not contain the FX-rounding account ${FX_ROUNDING_ACCOUNT_CODE} (§4.15, spec:2001)`);
    await tx`update app.company set fx_rounding_account_id = ${fx.id}
              where id = ${ctx.companyId} and fx_rounding_account_id is distinct from ${fx.id}`;

    return inserted;
  },
};
```

- [ ] **Step 5: Register the loader, run the test, commit**

`LOADERS` gains `"chart-of-accounts": chartOfAccountsLoader`.

Run: `cd packages/db && bun run test -- test/seed-chart.test.ts && bun run typecheck`
Expected: PASS — 8 tests.

If the fixture-collision test fails with a unique violation, the `on conflict (company_id, code)` target is missing — `app.account`'s constraint is on `(company_id, code)`, not `(tenant_id, code)`.

```bash
git add -A
git commit -m "feat(db): chart-of-accounts sub-pack, the eleven 0C leaves, fx_rounding_account_id [0C T11]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: definition of done 0.7b — twice changes nothing, the pack shape, and the owner's first login

§5.0 row 0.7b, verbatim: "Running it twice changes nothing; the principal + membership inserts succeed under `FORCE ROW LEVEL SECURITY` (regression test for v1.1 fix #2); the owner logs in, enrols MFA at `aal1`, and sees an empty but fully configured company." Tasks 7–11 each proved their own half; this task proves the three clauses **as one run** and appends 0C's block to `legacy-025`.

**Files:**
- Create: `packages/db/test/seed-idempotent.test.ts`, `apps/api/test/routes/first-login.test.ts`
- Modify: `packages/db/package.json` (the `"./seed"` subpath export — this task's one production change), `tests/regression/legacy-025.test.ts` (append one describe block), `tests/regression/legacy-039.test.ts` (append one `it` to 0C's own block)
- Test: all of the above

**Interfaces:**
- Consumes: Task 9's assembled `seed()`; 0B's `startApi()`, `ApiRequest`, `tokenFor`, `AAL1_PATHS`, `GET /v1/session`, `GET /v1/companies`.
- Produces: `packages/db`'s **`"./seed"` subpath export** — `"./seed": "./src/seed/index.ts"`, the only route by which anything outside `packages/db` may reach `seed`, `parseSeedArgs` or `StubSeedAuthAdmin`. No other new interface: this task is the DoD proof.

- [ ] **Step 1: Write `packages/db/test/seed-idempotent.test.ts`**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { seed } from "../src/seed";
import { startDb, type Db } from "./harness";

/** Every table the seed writes, plus the two that would betray a silent re-write. */
const TOUCHED = [
  "app.tenant", "app.principal", "app.membership", "app.company", "app.role", "app.role_permission",
  "app.role_assignment", "app.dimension_type", "app.dimension_value", "app.fiscal_period", "app.account",
  "app.audit_log", "pgboss.tenant_registry",
] as const;

describe("§5.0 row 0.7b — running it twice changes nothing (spec:2317)", () => {
  let db: Db; let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  const auth = new StubSeedAuthAdmin();
  const cfg = () => parseSeedArgs(["--tenant", tenantId, "--owner-email", "owner@example.my", "--fiscal-year", "2026"], {} as NodeJS.ProcessEnv);

  const census = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of TOUCHED) {
      const [row] = await db.admin.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
      out[t] = row!.n;
    }
    return out;
  };

  beforeAll(async () => { db = await startDb(); migrator = createDb(db.url("app_migrator")); });
  afterAll(async () => { await migrator.end(); await db.stop(); });

  it("the first run creates the tenant and reports what it applied", async () => {
    const r = await seed(migrator, cfg(), auth);
    expect(r.created).toBe(true);
    expect(r.tenantId).toBe(tenantId);
    expect(r.companyId).not.toBe("");
    expect(r.ownerPrincipalId).not.toBe("");
    expect(r.applied["fiscal-periods"]).toBe(12);
    expect(r.applied["chart-of-accounts"]).toBe(16);      // eleven leaves + five group parents
    expect(r.applied.dimensions).toBe(2);                 // BRANCH + head office
    expect(r.applied.roles).toBeGreaterThan(0);
  });

  it("the second run inserts nothing anywhere — including app.audit_log", async () => {
    const before = await census();
    const r = await seed(migrator, cfg(), auth);
    expect(r.created).toBe(false);
    expect(Object.values(r.applied)).toEqual([0, 0, 0, 0]);
    expect(await census()).toEqual(before);
  });

  it("a third run under --only re-applies one pack and still changes nothing", async () => {
    const before = await census();
    for (const pack of ["roles", "dimensions", "fiscal-periods", "chart-of-accounts"]) {
      await seed(migrator, parseSeedArgs(["--tenant", tenantId, "--only", pack, "--fiscal-year", "2026"], {} as NodeJS.ProcessEnv), auth);
    }
    expect(await census()).toEqual(before);
  });

  it("the company is fully configured: base currency, timezone, fx-rounding account, twelve open periods, a branch", async () => {
    const [c] = await db.admin<{ base_currency: string; timezone: string; fx: string | null }[]>`
      select base_currency, timezone, fx_rounding_account_id::text as fx from app.company where tenant_id = ${tenantId}`;
    expect(c!.base_currency).toBe("MYR");
    expect(c!.timezone).toBe("Asia/Kuala_Lumpur");
    expect(c!.fx).not.toBeNull();
    const [p] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.fiscal_period where tenant_id = ${tenantId} and status = 'open'`;
    expect(p!.n).toBe(12);
    const [b] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
       where dt.code = 'BRANCH' and dv.code = 'HQ' and dv.tenant_id = ${tenantId}`;
    expect(b!.n).toBe(1);
  });

  it("but empty: no document, no ledger entry (spec:2317 'an empty but fully configured company')", async () => {
    const [d] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.document where tenant_id = ${tenantId}`;
    const [l] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where tenant_id = ${tenantId}`;
    expect([d!.n, l!.n]).toEqual([0, 0]);
  });
});
```

> `db.admin.unsafe` inside a test is legal: `packages/db/test/**` is on the `no-bare-db` allow-list and the table names come from a `const` array in this file, not from input (`no-sql-concat` checks for a non-literal argument, and this one is a literal from a frozen list — if the rule flags it, list the thirteen counts as thirteen tagged templates instead).

- [ ] **Step 2: Run it — this one must PASS on the first try**

Run: `cd packages/db && bun run test -- test/seed-idempotent.test.ts`
Expected: PASS — 5 tests.

This is the one step in the plan that does **not** begin red, and that is deliberate: Tasks 7–11 each built and proved their half, and this file is the definition-of-done proof that the halves compose. **A failure here is a defect in Tasks 7–11, not work for this task** — the "if it fails" notes at the end of this task name which one. Steps 3–6 below are the ordinary red-green pair for this task's one production change.

- [ ] **Step 3: Write `apps/api/test/routes/first-login.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@dulja/db";
// The seed reaches the test tier through the "./seed" subpath export (added in Step 5 below), never through
// @dulja/db's main entry: that entry is imported by apps/api's production code, and re-exporting the seed there
// would put @supabase/supabase-js and the service-role admin client on the request-serving path (legacy-039).
import { StubSeedAuthAdmin, parseSeedArgs, seed } from "@dulja/db/seed";
import { randomUUID } from "node:crypto";
import { startApi, type StartedApi } from "../support/app";

describe("§5.0 row 0.7b — the owner logs in, enrols MFA at aal1, and sees the company (spec:2004, 2317)", () => {
  let api: StartedApi;
  let ownerPrincipalId = "";
  let companyId = "";

  beforeAll(async () => {
    api = await startApi();
    const migrator = createDb(api.db.url("app_migrator"));
    const cfg = parseSeedArgs(["--tenant", randomUUID(), "--owner-email", "owner@example.my"], {} as NodeJS.ProcessEnv);
    const r = await seed(migrator, cfg, new StubSeedAuthAdmin());
    ownerPrincipalId = r.ownerPrincipalId;
    companyId = r.companyId;
    await migrator.end();
  });
  afterAll(async () => { await api.stop(); });

  it("at aal1 the owner reaches GET /v1/session and nothing else", async () => {
    const session = await api.request({ method: "GET", path: "/v1/session", as: ownerPrincipalId, aal: "aal1" });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ principalId: ownerPrincipalId, aal: "aal1" });
    const blocked = await api.request({ method: "GET", path: "/v1/companies", as: ownerPrincipalId, aal: "aal1" });
    expect(blocked.status).toBe(401);
    expect((await blocked.json()).code).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("after enrolling, the owner sees one fully configured company", async () => {
    const res = await api.request({ method: "GET", path: "/v1/companies", as: ownerPrincipalId });
    expect(res.status).toBe(200);
    // 0B's ListEnvelope is `{ items, next_cursor }` (§4.2.8) — not `{ data }`.
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: companyId, code: "HQ", baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur" });
  });

  it("and the audit log the owner may read is not empty — every seed write was audited (spec:2286)", async () => {
    const res = await api.request({ method: "GET", path: "/v1/admin/audit-log?limit=5", as: ownerPrincipalId });
    expect(res.status).toBe(200);
    expect((await res.json()).items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/routes/first-login.test.ts`
Expected: FAIL on resolution. The wording depends on which resolver reports it, so accept either: Vite's (Vitest's own) `Missing "./seed" specifier in "@dulja/db" package`, or Node's `Package subpath './seed' is not defined by "exports" in …/packages/db/package.json`. At this point `packages/db`'s `exports` map holds `"."`, 0B's `"./test"` and Task 2's `"./provision/verify-supabase"` — and no `"./seed"`; inside the package the seed is reached by a relative import, which needs no entry.

- [ ] **Step 5: Add the `"./seed"` subpath export — and only that**

This is the task's one production change. `packages/db/package.json` `exports` gains one entry, beside 0B's `"./test"`:

```json
    "./seed": "./src/seed/index.ts",
```

`packages/db/src/index.ts` is **not** touched. `export * from "./seed"` there would pull `@supabase/supabase-js` and the service-role admin client into the import graph of every `apps/api` and `apps/worker` module that imports `withTenant` — the coupling `tests/regression/legacy-039.test.ts` forbids, and one its textual grep over three application files cannot see, because the path is transitive. The subpath keeps the seed reachable from the test tier and from nowhere on the serving path.

Then append one `it` to **0C's own** `describe` block in `tests/regression/legacy-039.test.ts` (Task 6's file, this slice's, so §3.7.3 does not apply):

```ts
  it("the seed is reachable only through the ./seed subpath, and no production file uses it", () => {
    const manifest = JSON.parse(repoFile("packages/db/package.json")) as { exports: Record<string, string> };
    expect(manifest.exports["./seed"]).toBe("./src/seed/index.ts");
    for (const file of ["apps/api/src/app.ts", "apps/api/src/index.ts", "apps/worker/src/index.ts"]) {
      expect(repoFile(file), file).not.toContain("@dulja/db/seed");
    }
  });
```

Refresh the workspace links so `apps/api`'s test tier resolves the new subpath:

```bash
bun install
```

- [ ] **Step 6: Run it to verify it passes**

Run: `cd apps/api && bun run test -- test/routes/first-login.test.ts && cd ../../tests && bun run test -- regression/legacy-039.test.ts`
Expected: PASS — 3 + 6 tests.

If the import still fails, `apps/api/package.json` has no `@dulja/db` dependency edge at all — 0B declares one for `createDb` and production `withTenant`, so its absence is a 0B defect, not a missing export.

- [ ] **Step 7: Append the `legacy-025` block**

The `describe` goes at the **end** of the file; the `repoFile` import goes into the file's **existing import block at the top** (Task 5 Step 7 explains why, and why that is not an edit to 0B's block under §3.7.3). `describe`, `expect`, `it` and `sharedDb` are already imported there.

```ts
// (top of file, in the existing import block)
import { repoFile } from "../support/regression";       // added by slice 0C (Task 2 Step 5)

// ── appended by slice 0C, at the end of the file ──────────────────────────────
describe("LEGACY-025 `procQuickLogin` grants a full administrator session with no credentials — 0C", () => {
  it("the bootstrap administrator is granted BY the system principal, never self-granted (R5)", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ granted_by: string; principal_id: string }[]>`
      select ra.granted_by::text, ra.principal_id::text from app.role_assignment ra
        join app.role r on r.id = ra.role_id join app.principal p on p.id = ra.granted_by
       where r.code = 'admin' and p.kind = 'system'`;
    for (const r of rows) expect(r.granted_by).not.toBe(r.principal_id);
  });

  it("there is no credential-free path to an admin session: the seed creates no password and no session", () => {
    const owner = repoFile("packages/db/src/seed/owner.ts");
    expect(owner).not.toMatch(/password|token|session|jwt/i);
    // The application never stores or compares a password — AuthN is Supabase's (spec:2131, LEGACY-028).
    expect(owner).toContain("authAdmin");
  });
});
```

- [ ] **Step 8: Run everything and commit**

Run: `cd packages/db && bun run test && cd ../../apps/api && bun run test -- test/routes/first-login.test.ts && cd ../../tests && bun run test -- regression/legacy-025.test.ts regression/legacy-039.test.ts`
Expected: PASS — 5 + 3 + (0B's block + 2) + 6 tests.

If the second census differs by exactly one `app.audit_log` row, an `update` is unguarded: every `update` in the seed carries `where … is distinct from …` (ADR 0012 decision 4).
If `applied["chart-of-accounts"]` is 11 rather than 16, the group parents were filtered out of the count — they are real `app.account` rows and are counted.
If Step 2 failed with a `TypeError` on `principal!.id`, the defect is Task 9's `bootstrapOwner`, not this task: it must SELECT `app.principal` **before** the insert, never between the principal and membership inserts (Task 9 Step 5's header comment).

```bash
git add -A
git commit -m "test(db): definition of done 0.7b — idempotent seed, first login, fully configured company [0C T12]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13 — **OWNER GATE OD-22**: observability — one trace from Worker to container to Postgres, and Sentry

> **This task is isolated for owner decision OD-22** (contracts §2.12: "Sentry organisation"; spec:2402, §5.3 row "0.14").
>
> **Owner provides:** a Sentry organisation (or the go-ahead to create one) and the DSN for `dulja-api` and `dulja-worker`; and, for tracing, an OTLP endpoint — Sentry's own OTLP ingest, or any collector.
> **Verify with:** deploy, `curl -s https://api.dulja.example/v1/session -H "Authorization: Bearer <token>"`, then open the trace viewer and confirm one trace spans Worker → container → Postgres carrying `dulja.tenant_id` and `dulja.actor_id` — §5.0 row 0.14 verbatim: "One request is visible end to end in the trace viewer with tenant and actor attached."
> **Default written into this plan:** `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are unset, so Sentry is disabled and OTel exports to an in-memory span exporter. The **same assertions** run against that exporter in `apps/api/test/otel.test.ts`, so "one trace, tenant and actor attached" is proved locally today.
> **If the owner declines Sentry:** delete `apps/api/src/sentry.ts` and `apps/worker/src/sentry.ts` and their two call sites. OTel and the trace assertions are unaffected — they are the half §4.9 calls load-bearing.

**Files:**
- Create: `apps/api/src/otel.ts`, `apps/api/src/sentry.ts`, `apps/worker/src/otel.ts`, `apps/worker/src/sentry.ts`, `docs/adr/0013-observability-otel-sentry.md`
- Modify: `apps/api/src/index.ts` (two calls before `createApp`; `createDb` gains the tracer), `apps/api/src/app.ts` (register `otelMiddleware()` **ahead of** `requestId()` — a change to §4.2.3's fixed middleware order, listed as a contract addition), `apps/api/src/middleware/request-id.ts` (read the trace id from the active span), `apps/api/src/middleware/auth.ts` (set the two span attributes once the principal resolves), `apps/api/test/support/app.ts` (pass `debug: pgDebugTracer()` to its `createDb`), `packages/db/src/client.ts` (`DbOptions.debug`), `apps/worker/src/index.ts` (two calls before `boss.start()`)
- Test: `apps/api/test/otel.test.ts`

**Interfaces:**
- Consumes: 0B's `requestId()` middleware (which already parses `traceparent` and falls back to the request id — "0C replaces this with the OpenTelemetry context and the value keeps the same field name"), `AppEnv`, `RequestContext`; Task 3's edge Worker, which mints the `traceparent` when the client sends none.
- Produces:

```ts
// apps/api/src/otel.ts
export interface TelemetryHandle { readonly enabled: boolean; shutdown(): Promise<void> }
/** Starts the Node SDK with the OTLP HTTP trace exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set, and an
 *  in-memory exporter otherwise. Instruments postgres.js through its `debug` hook, not a monkey-patch. */
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle;
/** Extracts the inbound `traceparent` and opens ONE server span per request, active for the whole chain.
 *  Registered FIRST in createApp — ahead of requestId() — so every later middleware and every Postgres
 *  statement runs inside it. Without it `trace.getSpan(context.active())` is undefined and nothing below works. */
export function otelMiddleware(): MiddlewareHandler<AppEnv>;
/** Attaches the two attributes §5.0 row 0.14 requires to the active span. Called once, by the auth middleware. */
export function setPrincipalAttributes(ctx: { tenantId: string; actorId: string; requestId: string }): void;
/** postgres.js's own `debug` hook, passed through `createDb({ debug })` — no monkey-patching, no parameter values. */
export function pgDebugTracer(): (connection: number, query: string) => void;
/** Test-only: the spans the in-memory exporter has collected. */
export function collectedSpans(): readonly { name: string; traceId: string; attributes: Record<string, unknown> }[];
/** Test-only: clears the in-memory exporter, so one case never asserts over another case's spans. */
export function resetSpans(): void;

// apps/worker/src/otel.ts — the worker half. NO otelMiddleware / setPrincipalAttributes / pgDebugTracer /
// collectedSpans / resetSpans, and no `hono` or `AppEnv` import: the worker serves no HTTP request.
export interface TelemetryHandle { readonly enabled: boolean; shutdown(): Promise<void> }
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle;

// apps/worker/src/sentry.ts
export function startSentry(opts: { appEnv: string; serviceName: string }): boolean;
```

**Why a middleware is required, not optional.** `NodeSDK` with no HTTP instrumentation opens no span of its own, and `startApi()` calls the Hono app in-process rather than over a socket — so without `otelMiddleware()` there is no active span, `setPrincipalAttributes` is a silent no-op, `traceparent` is never extracted, and every assertion in this task's test fails. Registering it ahead of `requestId()` changes §4.2.3's fixed middleware order (`requestId → logger → auth → idempotency → requirePermission → handler` becomes `otel → requestId → …`), which is why it is recorded as a contract addition rather than slipped in.

- [ ] **Step 1: Verify the exporter's option names (assumption 7)**

`apps/worker` gets `@opentelemetry/sdk-trace-base` too, not only `apps/api`: its `otel.ts` imports `InMemorySpanExporter` and `SimpleSpanProcessor` from it, and a package that resolves only through hoisting is a phantom dependency the `dependency-rule` lint and Renovate both treat as a defect (spec:104 — the lockfile owns versions, and the manifest owns the edge).

```bash
bun add --cwd apps/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/api @opentelemetry/resources @opentelemetry/sdk-trace-base @sentry/node
bun add --cwd apps/worker @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/api @opentelemetry/sdk-trace-base @sentry/node
node -p "require('@opentelemetry/sdk-node/package.json').version" 
node -p "const p=require('path'),f=require('fs'),d=p.dirname(require.resolve('@opentelemetry/sdk-node/package.json'));f.readFileSync(p.join(d,'build/src/sdk.d.ts'),'utf8')" | grep -nE "traceExporter|spanProcessors?|resource|serviceName|start\(|shutdown\("
```

Record in ADR 0013 (Step 6): the constructor option carrying the exporter, the option carrying the resource/service name, and whether `start()` returns a promise. **If the SDK's field for the service name differs**, only `apps/api/src/otel.ts` and `apps/worker/src/otel.ts` change.

- [ ] **Step 2: Write the failing test `apps/api/test/otel.test.ts`**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectedSpans, resetSpans, startTelemetry } from "../src/otel";
import { startApi, type StartedApi } from "./support/app";
import { seedTenant, type Seed } from "@dulja/db/test";

// Telemetry starts at module evaluation, before startApi(), so the SDK is running for the first request.
const telemetry = startTelemetry({ serviceName: "dulja-api", appEnv: "dev" });

describe("§5.0 row 0.14 — one request visible end to end with tenant and actor attached (spec:2324)", () => {
  let api: StartedApi; let s: Seed;

  beforeAll(async () => { api = await startApi(); s = await seedTenant(api.db, "Alpha"); });
  beforeEach(() => { resetSpans(); });                 // each case asserts over its own request's spans only
  afterAll(async () => { await telemetry.shutdown(); await api.stop(); });

  it("an inbound traceparent is continued, not replaced — the Worker's trace id survives into the container", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await api.request({
      method: "GET", path: "/v1/session", as: s.human,
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.status).toBe(200);
    const spans = collectedSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((sp) => sp.traceId === traceId)).toBe(true);
  });

  it("the request span carries tenant, actor and request id (the four fields of spec:2063)", async () => {
    await api.request({ method: "GET", path: "/v1/session", as: s.human });
    const span = collectedSpans().find((sp) => sp.name.includes("/v1/session"));
    expect(span!.attributes["dulja.tenant_id"]).toBe(s.tenant);
    expect(span!.attributes["dulja.actor_id"]).toBe(s.human);
    expect(String(span!.attributes["dulja.request_id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the database statements of that request are children of it — Worker → container → Postgres is one trace", async () => {
    await api.request({ method: "GET", path: "/v1/companies", as: s.human });
    const spans = collectedSpans();
    const request = spans.find((sp) => sp.name.includes("/v1/companies"))!;
    const db = spans.filter((sp) => sp.name.startsWith("pg "));
    expect(db.length).toBeGreaterThan(0);
    expect(db.every((sp) => sp.traceId === request.traceId)).toBe(true);
  });

  it("no span attribute carries a token, a password or a PIN (spec:2063, forbidden-log-fields)", async () => {
    await api.request({ method: "GET", path: "/v1/session", as: s.human });
    for (const span of collectedSpans()) {
      for (const key of Object.keys(span.attributes)) {
        expect(key, `${span.name}.${key}`).not.toMatch(/token|password|authorization|card|pin|secret/i);
      }
    }
  });

  it("with no OTLP endpoint configured telemetry still runs — the default is in-memory, never a crash (OD-22)", () => {
    expect(telemetry.enabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/otel.test.ts`
Expected: FAIL — `Failed to resolve import "../src/otel" from "test/otel.test.ts"`. (After Step 4 creates the module but before Step 5 wires the call sites, the same command fails differently and usefully: the first three cases fail on `expect(spans.length).toBeGreaterThan(0)` — received `0` — because no middleware opens a span. That is the failure Step 5's rationale block predicts.)

- [ ] **Step 4: Write `apps/api/src/otel.ts` and `apps/api/src/sentry.ts`**

```ts
// apps/api/src/otel.ts
import { context, propagation, SpanKind, trace, type Span } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./context";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface TelemetryHandle { readonly enabled: boolean; shutdown(): Promise<void> }

const memory = new InMemorySpanExporter();

/**
 * §4.9: "Distributed tracing; RED metrics per endpoint". §5.0 row 0.14 is the acceptance check: one request
 * visible end to end with tenant and actor attached. The edge Worker mints or forwards `traceparent` (Task 3);
 * 0B's request-id middleware already reads it, and this module makes the value a real span context so the
 * container's spans and Postgres's statements land in the caller's trace rather than starting a new one.
 *
 * The DEFAULT is the in-memory exporter, so a missing OTEL_EXPORTER_OTLP_ENDPOINT (OWNER GATE OD-22) degrades to
 * "traces are collected and dropped", never to a crash on boot.
 */
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const exporter = endpoint ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }) : memory;
  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

/**
 * One server span per request, opened from the *inbound* trace context so the Worker's trace id continues into
 * the container instead of a new trace starting here. `startActiveSpan` makes it the active span for everything
 * awaited inside, which is what lets `setPrincipalAttributes` and `pgDebugTracer` find it.
 * Registered first in `createApp`, ahead of `requestId()` (contract addition to §4.2.3's order).
 */
export function otelMiddleware(): MiddlewareHandler<AppEnv> {
  const tracer = trace.getTracer("dulja-api");
  return async (c, next) => {
    const carrier: Record<string, string> = {};
    const inbound = c.req.header("traceparent");
    if (inbound) carrier["traceparent"] = inbound;
    const parent = propagation.extract(context.active(), carrier);
    const path = new URL(c.req.url).pathname;
    await tracer.startActiveSpan(`${c.req.method} ${path}`, { kind: SpanKind.SERVER }, parent, async (span) => {
      try {
        await next();
      } finally {
        span.setAttribute("http.request.method", c.req.method);
        span.setAttribute("url.path", path);
        span.setAttribute("http.response.status_code", c.res.status);
        span.end();
      }
    });
  };
}

/** §5.0 row 0.14's "with tenant and actor attached". Called once per request by the auth middleware. */
export function setPrincipalAttributes(ctx: { tenantId: string; actorId: string; requestId: string }): void {
  const span: Span | undefined = trace.getSpan(context.active());
  span?.setAttributes({
    "dulja.tenant_id": ctx.tenantId,
    "dulja.actor_id": ctx.actorId,
    "dulja.request_id": ctx.requestId,
  });
}

export function collectedSpans(): readonly { name: string; traceId: string; attributes: Record<string, unknown> }[] {
  return memory.getFinishedSpans().map((s: ReadableSpan) => ({
    name: s.name, traceId: s.spanContext().traceId, attributes: s.attributes as Record<string, unknown>,
  }));
}

/** Test-only: clear the in-memory exporter so one case's assertions never see another case's spans. */
export function resetSpans(): void { memory.reset(); }

/**
 * postgres.js reports every statement through its `debug` hook, which is the documented seam and needs no
 * monkey-patching. `createDb` is 0B's; this factory is passed to it from index.ts.
 * The SQL text is the *prepared* text — parameters are never attached, so no value reaches a span (spec:2063).
 */
export function pgDebugTracer(): (connection: number, query: string) => void {
  const tracer = trace.getTracer("dulja-pg");
  return (_connection, query) => {
    const span = tracer.startSpan(`pg ${query.split(/\s+/)[0]?.toLowerCase() ?? "query"}`);
    span.setAttribute("db.system", "postgresql");
    span.setAttribute("db.statement", query.slice(0, 500));
    span.end();
  };
}
```

```ts
// apps/api/src/sentry.ts
import * as Sentry from "@sentry/node";

/** OWNER GATE OD-22. With no DSN this is a no-op; nothing else in the application knows the difference. */
export function startSentry(opts: { appEnv: string; serviceName: string }): boolean {
  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: opts.appEnv,
    serverName: opts.serviceName,
    tracesSampleRate: opts.appEnv === "production" ? 0.1 : 1.0,
    // spec:2063 "never a token, password, or full card number" — the same predicate as the forbidden-log-fields lint.
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) for (const key of Object.keys(headers)) if (/token|password|authorization|card|pin|secret/i.test(key)) delete headers[key];
      return event;
    },
  });
  return true;
}
```

The worker's two files are **not** copies of the API's: the worker serves no HTTP request, so it has no middleware, no principal attributes, no `postgres.js` tracer and no span-collection seam, and it must import neither `hono` nor `AppEnv`. Both are written out here in full.

```ts
// apps/worker/src/otel.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export interface TelemetryHandle { readonly enabled: boolean; shutdown(): Promise<void> }

/**
 * The worker half of ADR 0013. `apps/worker` is a pg-boss poller with no HTTP surface beyond `health.ts`, so this
 * module is `startTelemetry` and nothing else — no `otelMiddleware`, no `setPrincipalAttributes`, no
 * `pgDebugTracer`, no `collectedSpans`/`resetSpans`. A job's tenant and actor are attributes the job handler sets
 * on its own span through `@opentelemetry/api` (0D's `handler.ts`); this file only starts the SDK.
 *
 * Same default as the API's (OWNER GATE OD-22): no `OTEL_EXPORTER_OTLP_ENDPOINT` means an in-memory exporter, so
 * a worker container boots and polls with observability unconfigured rather than crashing on start.
 */
export function startTelemetry(opts: { serviceName: string; appEnv: string }): TelemetryHandle {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const exporter = endpoint
    ? new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
    : new InMemorySpanExporter();
  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
```

```ts
// apps/worker/src/sentry.ts
import * as Sentry from "@sentry/node";

/**
 * OWNER GATE OD-22. With no DSN this is a no-op; nothing else in the worker knows the difference.
 * The `beforeSend` scrub is reproduced rather than shared: `apps/worker` and `apps/api` are sibling apps and
 * §3.1's dependency rule forbids one importing the other, and the predicate is the same one the
 * `forbidden-log-fields` lint applies (spec:2063 "never a token, password, or full card number").
 */
export function startSentry(opts: { appEnv: string; serviceName: string }): boolean {
  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: opts.appEnv,
    serverName: opts.serviceName,
    tracesSampleRate: opts.appEnv === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) for (const key of Object.keys(headers)) if (/token|password|authorization|card|pin|secret/i.test(key)) delete headers[key];
      return event;
    },
  });
  return true;
}
```

- [ ] **Step 5: Wire the four call sites**

`apps/api/src/index.ts`, immediately after `config` is read and **before** `createApp`:

```ts
import { pgDebugTracer, startTelemetry } from "./otel";
import { startSentry } from "./sentry";

const telemetry = startTelemetry({ serviceName: "dulja-api", appEnv: config.appEnv });
const sentryEnabled = startSentry({ appEnv: config.appEnv, serviceName: "dulja-api" });
// … and the db is created with the tracer attached:
  db: createDb(config.databaseUrl, { debug: pgDebugTracer() }),
```

> `createDb`'s `DbOptions` is `{ max?: number }` (§4.2.2). Add `debug?: (connection: number, query: string) => void` to it and forward it to postgres.js — an **additive** change to 0B's `packages/db/src/client.ts` and to §4.2.2, recorded in this plan's Self-Review as a contract addition.

`apps/api/src/app.ts` — one line, **before** `requestId()` in the middleware chain, so the span wraps everything:

```ts
import { otelMiddleware } from "./otel";
// … the first `app.use` in createApp:
  app.use("*", otelMiddleware());
  app.use("*", requestId());
  // … the rest of §4.2.3's order is unchanged.
```

`apps/api/src/middleware/request-id.ts` — one line, where 0B left the seam ("0C replaces this with the OpenTelemetry context and the value keeps the same field name"):

```ts
import { context, trace } from "@opentelemetry/api";
// … replace the traceId fallback:
    const active = trace.getSpan(context.active())?.spanContext().traceId;
    c.set("traceId", active ?? tp?.[1] ?? id);
```

`apps/api/test/support/app.ts` — one option, so the "pg spans share the trace" assertion has spans to find. 0B builds its own connection there; it becomes:

```ts
import { pgDebugTracer } from "../../src/otel";
// …
  const db = createDb(container.url("app_rw"), { debug: pgDebugTracer() });
```

`apps/api/src/middleware/auth.ts` — one line, immediately after the `RequestContext` is built:

```ts
setPrincipalAttributes({ tenantId: ctx.tenantId, actorId: ctx.actorId, requestId: ctx.requestId });
```

`apps/worker/src/index.ts` — two lines, before `await boss.start()`:

```ts
startTelemetry({ serviceName: "dulja-worker", appEnv: process.env["APP_ENV"] ?? "dev" });
startSentry({ appEnv: process.env["APP_ENV"] ?? "dev", serviceName: "dulja-worker" });
```

- [ ] **Step 6: Write ADR 0013 and run the tests**

`docs/adr/0013-observability-otel-sentry.md`:

```markdown
# ADR 0013: Observability — OpenTelemetry for traces, Sentry for errors, one `request_id` end to end

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C

## Context

spec §4.9 requires distributed tracing, RED metrics per endpoint, and structured logs carrying `tenant_id`,
`actor_id`, `request_id` and `trace_id` on every line (spec:2063). §5.0 row 0.14's acceptance check is a single
sentence: one request visible end to end in the trace viewer with tenant and actor attached. The system spans
three runtimes — a Workers isolate, a Bun container and Postgres — so "end to end" means the trace id has to
survive two hops.

## Decision

1. **W3C `traceparent` is the carrier.** The edge Worker forwards the caller's header or mints one (Task 3);
   0B's request-id middleware already reads it, and this ADR makes the parsed value the active span context.
2. **`request_id` and `trace_id` stay separate fields.** A retried request keeps its trace and gets a new request
   id; conflating them would lose that.
3. **Postgres spans come from postgres.js's own `debug` hook**, passed through `createDb`'s options — no
   monkey-patching, and the hook receives the *prepared* statement text, so no parameter value can reach a span.
4. **Span attributes are `dulja.tenant_id`, `dulja.actor_id`, `dulja.request_id`**, set once by the auth
   middleware. A test asserts that no attribute key matches `/token|password|authorization|card|pin|secret/i` —
   the span twin of the `forbidden-log-fields` lint.
5. **Both exporters degrade, never crash.** No `OTEL_EXPORTER_OTLP_ENDPOINT` → an in-memory exporter (which is
   also what the tests assert against); no `SENTRY_DSN` → Sentry is not initialised. That is OD-22's default.
6. **Not decided here:** the ledger-integrity SLI (spec:2246) is 1B's, on top of 0D's integrity job; RED metrics
   and SLO alerting land with the report engine's own instrumentation.

## Consequences

- `createDb`'s options gain `debug?`, an additive change to contracts §4.2.2.
- Trace continuity is asserted in CI against the in-memory exporter, so the owner's Sentry account is needed to
  *view* traces, never to prove they are correct.
```

Run: `cd apps/api && bun run test -- test/otel.test.ts && cd ../.. && bun run lint && bun run lint:rules && bun run typecheck`
Expected: PASS — 5 tests; `lint:rules` reports no `forbidden-log-fields` violation.

If every span has a different trace id, the SDK started **after** the first request: `startTelemetry` must run before `createApp` and before any `createDb`.
If `collectedSpans()` is empty on every case, `resetSpans()` was called but `otelMiddleware()` was not registered — or was registered after `requestId()`. It is first; that is the whole reason §4.2.3's order changed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): OpenTelemetry traces and Sentry, one request_id Worker to container to Postgres (OD-22, ADR 0013) [0C T13]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: the Phase 0 exit gate — tests 12, 13 and 14 against staging, and the slice close-out

0C's card owns no new acceptance test but is where **12, 13 and 14 run in CI against staging** (§2.1). Plan 0A proved 12 and 13 at the data layer and 0B at the endpoint layer, both on Testcontainers; this task runs the same suites against a real Supabase project reached through a real container, which is the only place "the tenant-isolation suite passes against every endpoint" is true of the deployed system.

**Files:**
- Modify: `.github/workflows/ci.yml` (a `staging-gate` job), `docs/runbooks/deploy.md` (the exit-gate section), root `package.json` (the `test:staging` script)
- Create: `tests/staging/phase-0-exit.test.ts`, `tests/staging/vitest.config.ts`
- Test: `tests/staging/phase-0-exit.test.ts`

**Interfaces:**
- Consumes: 0B's `tests/invariants/tenant-isolation.test.ts` (test 12), `tests/invariants/auth-bypass.test.ts` (test 11) and `packages/db/test/audit.test.ts` (test 13); **Plan 0A's "who can do X in company Y" one-query form** (plan0A:1150–1158; the query itself, not a helper — there is no `whoCan()` in the contracts registry and this plan does not invent one) for test 14; Task 2's `verifySupabase` and `formatPosture`; Task 5's deploy workflow and its seeded staging tenant.
- Produces: `tests/staging/` — a **directory inside the existing `tests` workspace** with its own Vitest config, run **against a deployed URL** by the root script `test:staging`, never by `bun run test`, and skipped when `STAGING_BASE_URL` is unset.

**How this suite is invoked, and why it is not a workspace.** `tests/vitest.config.ts` is frozen by contracts:1173 as `include: ["invariants/**/*.test.ts", "regression/**/*.test.ts", "golden/**/*.test.ts"]`, so `staging/**` is never collected by `bun run --cwd tests test` — deliberately: it needs a deployed environment. Making `tests/staging` a second **workspace** would nest a package inside the `tests` package and add a row to §3.1's frozen `workspaces` array for the sake of one `describe`; avoiding that question is cheaper than testing how Bun and turbo each resolve it. Instead it is a plain directory with its own Vitest config, reached by one root script:

```json
    "test:staging": "node node_modules/vitest/vitest.mjs run --config tests/staging/vitest.config.ts",
```

and the config sets its own `root`, so the command works from the repository root, from CI, and from anywhere else.

- [ ] **Step 1: Write `tests/staging/vitest.config.ts` and the failing suite**

`tests/staging/vitest.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate from tests/vitest.config.ts: these run against a deployed environment, start no container, and skip
 * entirely when STAGING_BASE_URL is unset — so a developer's `bun run test` never needs the cloud.
 *
 * `root` is set explicitly to this file's own directory. Without it, `include: ["*.test.ts"]` is resolved against
 * the *runner's* working directory, so `bun run test:staging` from the repository root would collect nothing and
 * exit 0 — a green run that tested the Phase 0 exit gate not at all.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { include: ["*.test.ts"], testTimeout: 120_000, fileParallelism: false },
});
```

`tests/staging/phase-0-exit.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPosture, REPO_ROOT, verifySupabase } from "@dulja/db/provision/verify-supabase";

const base = process.env["STAGING_BASE_URL"];
const rwUrl = process.env["DATABASE_URL"];
const adminUrl = process.env["DATABASE_URL_MIGRATOR"];
const gate = base && rwUrl && adminUrl ? describe : describe.skip;

/**
 * The Phase 0 exit gate (contracts §2.1): "every §5.0 row green **and** tests 11, 12, 13, 14, 27 pass in CI".
 * Tests 11, 12, 13, 14 and 27 run against Testcontainers on every PR (0B, 0D). This suite re-runs the parts that
 * can only be true of a *deployed* system: the posture of the real database, the edge/container split, and the
 * fact that the seeded tenant is reachable through the Worker and isolated at the data layer.
 */
gate("Phase 0 exit gate — against staging", () => {
  it("row 0.2: the deployed database's posture is the four expected lines", async () => {
    const checks = await verifySupabase({ rwUrl: rwUrl!, adminUrl: adminUrl!, configFiles: [join(REPO_ROOT, "infra/wrangler.jsonc")] });
    expect(formatPosture(checks)).toBe("rls-forced: ok\nbypassrls-probe: refused\napp_auth-login: refused\npooler-url: absent");
  });

  it("row 0.5: /healthz answers 200 through the Worker", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("row 0.5: an unauthenticated /v1 call is refused at the edge, with RateLimit headers present", async () => {
    const res = await fetch(`${base}/v1/companies`);
    expect(res.status).toBe(401);
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
    expect((await res.json()).code).toBe("ERR_AUTH_TOKEN_INVALID");
  });

  it("test 12 at the deployed data layer: app_rw with no set_config sees nothing", async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(rwUrl!, { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from app.company`;
      expect(row!.n).toBe(0);
    } finally { await sql.end(); }
  });

  it("test 13 at the deployed data layer: app_rw cannot UPDATE or DELETE an audit row", async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(rwUrl!, { max: 1, onnotice: () => {} });
    try {
      await expect(sql`update app.audit_log set action = 'x'`).rejects.toThrow(/permission denied|violates/);
      await expect(sql`delete from app.audit_log`).rejects.toThrow(/permission denied|violates/);
    } finally { await sql.end(); }
  });

  it("test 14 against the seeded staging tenant: 'who can manage users in company X' is one query", async () => {
    // Contracts §6.1 places test 14 with 0D — "the 0A query against the seeded catalogue". This is that query,
    // verbatim from plan0A:1150–1158, run against the tenant `bun run seed` created on staging: principal ⋈
    // role_assignment ⋈ role_permission, filtered on expires_at. There is no `whoCan()` helper in the interface
    // registry, so none is invented here.
    const { default: postgres } = await import("postgres");
    const sql = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const tenantId = process.env["STAGING_TENANT_ID"]!;
    try {
      await sql`select set_config('app.tenant_id', ${tenantId}, false)`;
      const [company] = await sql<{ id: string }[]>`select id::text as id from app.company where tenant_id = ${tenantId}`;
      const who = await sql<{ id: string; display_name: string }[]>`
        select distinct p.id::text as id, p.display_name
          from app.principal p
          join app.role_assignment ra on ra.principal_id = p.id
          join app.role_permission rp on rp.role_id = ra.role_id
         where ra.company_id = ${company!.id} and rp.permission_code = 'admin.user.manage'
           and (ra.expires_at is null or ra.expires_at > now())
         order by p.display_name`;
      // Exactly the bootstrap owner: the seed grants `admin` to one human principal and to no one else.
      expect(who).toHaveLength(1);
      const [owner] = await sql<{ id: string; kind: string }[]>`
        select p.id::text as id, p.kind::text from app.principal p
          join app.membership m on m.principal_id = p.id
         where m.tenant_id = ${tenantId} and p.kind = 'human'`;
      expect(who[0]!.id).toBe(owner!.id);
      // …and the answer is one query, not a walk: the same statement with a different permission code returns none.
      const nobody = await sql<{ id: string }[]>`
        select distinct p.id::text as id from app.principal p
          join app.role_assignment ra on ra.principal_id = p.id
          join app.role_permission rp on rp.role_id = ra.role_id
         where ra.company_id = ${company!.id} and rp.permission_code = 'pos.ticket.sell'
           and (ra.expires_at is null or ra.expires_at > now())`;
      expect(nobody).toEqual([]);          // `admin` excludes pos.ticket.sell (§4.2.1, Task 8)
    } finally { await sql.end(); }
  });

  it("row 0.7b: the seeded tenant is fully configured on staging", async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const tenantId = process.env["STAGING_TENANT_ID"]!;
    try {
      await sql`select set_config('app.tenant_id', ${tenantId}, false)`;
      const [c] = await sql<{ n: number }[]>`select count(*)::int as n from app.company where fx_rounding_account_id is not null`;
      const [p] = await sql<{ n: number }[]>`select count(*)::int as n from app.fiscal_period where status = 'open'`;
      const [r] = await sql<{ n: number }[]>`select count(*)::int as n from app.role where is_system`;
      expect([c!.n, p!.n, r!.n]).toEqual([1, 12, 9]);
    } finally { await sql.end(); }
  });
});
```

> `set_config(..., false)` — session scope, not transaction scope — is used here because this suite runs raw
> statements outside `withTenant` deliberately: it is testing the *deployed database*, not the application, and
> `packages/db/test/**` plus `tests/**` are on the `no-bare-db` allow-list.
> `@dulja/db/provision/verify-supabase` needs an `exports` entry in `packages/db/package.json`:
> `"./provision/verify-supabase": "./provision/verify-supabase.ts"` — added by Task 2 (its Files list names it).

- [ ] **Step 2: Run it to verify the runner cannot find it yet**

Run: `bun run test:staging`
Expected: FAIL — `error: Script not found "test:staging"`.

- [ ] **Step 3: Add the root script, and run it twice — once skipped, once against nothing**

Root `package.json` scripts gain, beside `seed`:

```json
    "test:staging": "node node_modules/vitest/vitest.mjs run --config tests/staging/vitest.config.ts",
```

**Run 1 — the developer loop.** `STAGING_BASE_URL` unset:

```bash
bun run test:staging
```

Expected: exit 0, `Test Files 1 skipped`, `Tests 7 skipped`. **`0 skipped` is a failure, not a pass**: it means the config's `root` is wrong and the runner collected no file. That is the whole reason `root` is set.

**Run 2 — proof the suite is not vacuously green.** Point it at a host that is not listening:

```bash
STAGING_BASE_URL=http://127.0.0.1:1 STAGING_TENANT_ID=00000000-0000-0000-0000-000000000000 \
DATABASE_URL="postgres://app_rw:x@127.0.0.1:1/postgres" DATABASE_URL_MIGRATOR="postgres://app_migrator:x@127.0.0.1:1/postgres" \
  bun run test:staging
```

Expected: FAIL — every case errors on `ECONNREFUSED`. A suite that passes here would be asserting nothing.

- [ ] **Step 4: Add the `staging-gate` job to `.github/workflows/ci.yml`**

Beside Plan 0A's `checks` job, unchanged:

```yaml
  staging-gate:
    # The Phase 0 exit gate (contracts §2.1). Runs only after a staging deploy, never on a pull request, because
    # it asserts facts about a deployed environment rather than about the code.
    if: github.ref == 'refs/heads/main'
    needs: [checks]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: bun install --frozen-lockfile
      # The root script, from the repository root — no `working-directory`. The config sets its own `root`, so
      # the include pattern resolves the same way here as it does on a developer's machine.
      - run: bun run test:staging
        env:
          STAGING_BASE_URL: https://api.dulja.example
          STAGING_TENANT_ID: ${{ vars.STAGING_TENANT_ID }}
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          DATABASE_URL_MIGRATOR: ${{ secrets.DATABASE_URL_MIGRATOR }}
```

- [ ] **Step 5: Add the exit-gate section to `docs/runbooks/deploy.md`**

```markdown
## The Phase 0 exit gate

Phase 0 exits when every §5.0 row is green **and** acceptance tests 11, 12, 13, 14 and 27 pass in CI, plus the
catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36
against the Phase 0 catalogue (contracts §2.1). Where each runs:

| Test | Where it runs on every PR | Where it runs against staging |
|---|---|---|
| 11 no auth bypass | `tests/invariants/auth-bypass.test.ts` (0B) | — |
| 12 tenant isolation | `tests/invariants/tenant-isolation.test.ts` (0B) | `tests/staging/phase-0-exit.test.ts` |
| 13 audit completeness | `packages/db/test/audit.test.ts` (0A), 0B's API paths | `tests/staging/phase-0-exit.test.ts` |
| 14 permission query | `packages/db/test/roles-seed.test.ts` (0D), on 0A's one-query form | `tests/staging/phase-0-exit.test.ts` — "who can manage users in company X" against the seeded tenant, answered by one `principal ⋈ role_assignment ⋈ role_permission` statement |
| 27 no SQL text across the API | `scripts/lint/rules/no-sql-concat.ts` (0B) | — |
| 36 catalogue clauses | 0D Task 15 | the nine seeded roles are asserted in the staging suite |

`bun run test:staging` runs the staging suite from the repository root against any deployed environment; with
`STAGING_BASE_URL` unset every case skips, so the developer loop never needs the cloud. It is **not** part of
`bun run test`: `tests/vitest.config.ts` collects `invariants/`, `regression/` and `golden/` only.
```

- [ ] **Step 6: Run the whole toolchain one last time and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: every workspace green. The staging suite is **not** in this run at all — `tests/vitest.config.ts`'s frozen `include` (contracts:1173) collects `invariants/`, `regression/` and `golden/` and nothing else, so `bun run test` neither runs nor reports it. It is invoked explicitly:

```bash
bun run test:staging      # 7 skipped without STAGING_BASE_URL — see Step 3
```

Then, once OD-19 and OD-20 have landed and the deploy has run:

```bash
STAGING_BASE_URL=https://api.dulja.example STAGING_TENANT_ID=<id> \
DATABASE_URL=… DATABASE_URL_MIGRATOR=… bun run test:staging
```

Expected: 7 passed. That output is the evidence for the Phase 0 exit gate; attach it to the PR.

```bash
git add -A
git commit -m "test(staging): Phase 0 exit gate — rows 0.2, 0.5, 0.7b and tests 12, 13 against staging [0C T14]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Run against the spec sections in the header, the contracts document §2.1 (0C card), §3, §4, §5 and §6, and the writing-plans skill.

### 1. Card coverage — every 0C deliverable, and the task that ships it

| 0C card deliverable | Task |
|---|---|
| Supabase provisioning runbook + `packages/db/provision/verify-supabase.ts` probe (four assertions of spec:2311) | T2 |
| `provision/roles.sql` applied as the `postgres` role; PITR; staging project alongside | T2 (runbook §2, §5, §6) |
| `infra/` — container `Dockerfile` (one image, two entrypoints), `wrangler.jsonc`, Renovate | T1, T4 |
| `apps/edge` — JWT pre-check, `RateLimit-*`, `/v1/*` via `getContainer(env.API, "api")`, `sleepAfter: "10m"`, Cron Trigger, R2 update feed | T3, T4 |
| GitHub Actions deploy-to-staging beside `checks`; secrets as Cloudflare bindings per §4.11; `DATABASE_URL` / `DATABASE_URL_MIGRATOR` | T5 |
| `bun run seed` — `packages/db/src/cli.ts seed`, the §3.8 six-step sequence, idempotent, as `app_migrator`, never an endpoint | T6 (seam), T7 (steps 1–3), T9 (step 4), T12 (proof) |
| the `--only <sub-pack>` flag and §3.4.8's sub-pack ordering rule | T6, T8, T10, T11 |
| `packages/db/seed/my/` — chart of accounts + FX-rounding link, BRANCH + head office, fiscal periods, **nothing else** | T10, T11; the "nothing else" is `assertPackShape` in T6 |
| `0c-base.json` = §4.15's eleven 0C leaves + presentation parents | T11 |
| `company.fx_rounding_account_id` set immediately after `5920` is inserted (spec:2001) | T11 |
| the per-tenant role-grant applier (§3.6.4) | T8 |
| observability: OTel Worker → container → Postgres on one `request_id`; Sentry in the API | T13 |
| deploy step `bun run --cwd apps/worker jobs:install` | T5 |
| §5.0 rows 0.2 / 0.5 / 0.7b / 0.14 | T2 / T4 / T12 / T13 |
| Phase 0 DoD clause "A tenant is created" | T7, T12 |
| runs 12, 13, 14 in CI against staging | T14 |
| re-runs test 36's seed clauses (nine roles; `admin` minus `pos.ticket.sell` and `pos.sync.*`) | T8 |
| regression files created `legacy-039`, `legacy-081`; appended `legacy-025`, `legacy-080`, `legacy-087` | T6, T2, T12, T5, T5 |
| ADRs 0011 (topology), 0012 (seed-pack format), 0013 (observability) | T1/T4, T6, T13 |
| the contracts-register entries every one of the above depends on (hazard 32) — folded in by §4.18 round 1 | T1 Step 0, the fourteen-string grep gate |

**Nothing on the card is unassigned.** **Not delivered here, by contract:** the `document-types/` sub-pack and the `JOURNAL` policy (1A — F-21, §4.3.7); `tax_code` rows (5A — F-23); the restore drill (1B, acceptance test 24); the ledger-integrity SLI's real Σdebit = Σcredit (1B); the signed installer and the update feed's *consumer* (0E); the branch-scoping half of test 36 (6C).

### 2. Placeholder scan

Pattern searched, widened after the first pass let one through:
`TBD|TODO|implement later|fill in|add appropriate|handle edge cases|similar to Task|as in Task|see Task .* for|copy|the same .* files?|change that one|and so on|etc\.` plus a bare `…` standing in for content.

**One was found and fixed.** Task 13 Step 4 previously said `apps/worker/src/otel.ts` and `apps/worker/src/sentry.ts` "are the same two files with `serviceName: \"dulja-worker\"`; write them by copying and changing that one string". That is the "similar to Task N" class the skill and hazard 35 both name as a plan failure, and it was not even true: the worker versions drop `otelMiddleware`, `setPrincipalAttributes`, `pgDebugTracer`, `collectedSpans`, `resetSpans` and the `hono`/`AppEnv` imports. Both files are now written out in full in that step, and both appear in the task's Produces block.

**Nothing else matched.** Every code step carries the real file content; every test asserts exact strings (`rls-forced: ok`, `unknown DULJA_ENTRYPOINT 'wrker' — expected api or worker`, `unexpected sub-pack: tax — tax/ is slice 5A's`, `account code '9999' does not match ^[1-5][0-9]{3}$…`, `ERR_AUTH_AAL_INSUFFICIENT`). Five places name a value the executor reads from a command instead of from this plan — the `@cloudflare/containers` field names (T3 S1), the `@supabase/supabase-js` admin surface (T9 S1), the OTel SDK option names (T13 S1), the two `<VERSION>` slots in ADRs 0011 and 0013, and the `^<resolved>` ranges in the `apps/edge` manifest that T3 S1's two `bun add` calls write — and each is an explicit verification step with the exact command, following 0D's ADR-0007 precedent for spec:93. The last of those is the one place where writing a literal would itself be the defect: spec:104 gives the lockfile the versions. Writing a guess there would be the defect. `dulja.example` is a **placeholder domain**, named as such, replaced by one string when OD-20 lands (T4's gate block says where).

### 3. Hazard check (contracts §5)

- **1 (no statutory rate):** 0C states no rate, threshold or formula. The chart of accounts carries codes and bilingual names only; `4900`/`5910`/`5920` are FX accounts with no rate attached.
- **2 (no invented MyInvois detail):** nothing in 0C names LHDN. `tax/` is explicitly excluded and `assertPackShape` fails the run naming 5A if it appears.
- **5 (owner-account tasks):** T2, T4, T9 and T13 each carry "Owner provides / Verify with / Default written into this plan / If the owner …", with a local equivalent — `startDb()`, `wrangler dev`, `StubSeedAuthAdmin`, the in-memory span exporter.
- **6 (one task per OD item):** OD-19 → T2, OD-20 → T4, OD-04 → T8, OD-21 → T9, OD-22 → T13. Each is droppable without renumbering a neighbour's interfaces.
- **8 (Plan 0A names never renamed):** `startDb`, `Db`, `uuidv7`, `seedTenant`, `Seed`, the test `withTenant`, `lintSchema`, `up`/`down`/`listApplied`, `provision/roles.sql`, `app.resolve_principal`, `app.actor_has` are used exactly as they are. **0A's `provision/roles.sql` is not edited** — T2 documents running it, and `verify-supabase.ts` is a new sibling file.
- **9 (`fixtures.ts` additive, §4.17 only):** 0C adds **no** fixture helper. `seedTenant` is consumed unmodified in T11's collision test, and that test now proves what it claims: `seedTenant` writes its company with code `'HQ'` (plan0A:1591) and `parseSeedArgs` defaults `companyCode` to `"HQ"` (T6), so `bootstrapCompany` adopts the fixture's own company and the loader really does attempt `1000` and `4000` against it. The case asserts the row **ids** are unchanged either side of the run, not merely that the count is two — "adopted, not duplicated" as a fact rather than an arithmetic coincidence.
- **10 (per-tenant rows are not migration data):** 0C writes **zero** migrations; its number 0009 stays reserved.
- **13 (`lint-schema.ts` is a hotspot):** 0C creates no table and edits no linter set.
- **14 (numbers allocated, never renumbered):** migration 0009 unused; ADRs 0011, 0012, 0013 used, 0014–0015 free.
- **15 (two `withTenant`s):** every seed module uses the **production** `withTenant(sql, ctx, fn)` from `packages/db/src/with-tenant.ts`; the test helper appears only in test files that already had it.
- **20 (jobs run as the system principal):** the seed is not a job, but it runs as the tenant's system principal for exactly the same reason — every audit row it writes carries a server-supplied actor.
- **21 (`sql.unsafe` has three homes):** 0C adds none. The one `db.admin.unsafe` in T12 is in `packages/db/test/**`, on the allow-list, over a frozen `const` array; T12 Step 1 says what to do if `no-sql-concat` still flags it.
- **22 (nothing outside `posting/` writes ledger or movement tables):** 0C writes none. T12 asserts `ledger_entry` is empty after the seed.
- **26 (the permission vocabulary is closed):** 0C adds no code and reads the catalogue from `app.permission`.
- **29 (UI):** 0C ships no screen; OD-24 does not apply.
- **32 (no invented literal in a shared namespace):** the eleven account codes are §4.15's own; the five group parents are explicitly unregistered by §4.15; no document-type code, report code or `DatasetId` is written. **One `ERR_*` is added — `ERR_RATE_LIMITED` (429, edge Worker)** — and the rule is followed, not bypassed: §4.2.4's table already allocates the code and Task 1 Step 0 greps for that row before Task 3 raises it, because the allocated space had no 429 member and spec:2204 makes rate limiting v1. It is listed in §5 below and in the header's namespaces line.
- **33 (the slice that seeds a policy seeds its accounts):** 0C seeds no policy, and the eleven accounts it does seed are the ones §4.15 assigns it — every later consumer (`item.*_account_id`, `party.*_account_id`, `bank_statement.bank_account_id`) resolves them and re-seeds nothing.
- **32, second half (the register is amended *first*):** the amendment **has been made** — contracts §4.18 round 1 folded every one of this slice's register entries into §2.12, §3.1 (three), §3.4.8, §2.1, §3.9, §3.11, §4.2.2, §4.2.12, §4.2.3, §4.2.4 (two) and §4.15, and left the `| … | 0C | plan |` rows recording it. **Task 1 Step 0 is therefore a grep gate over those fourteen strings, not an edit**: re-applying a "replace A with B" whose A no longer exists would stall an executor, and re-adding a row that is already there would duplicate it in a register twenty-nine plans read. Step 0b commits only if a grep reported `MISSING` and the step restored it. The slice is **fourteen commits across fourteen tasks** in the normal case, fifteen only if the contracts document has drifted since 2026-09-08.
- **35 (real code, failing test first, a commit per task):** every task follows write-failing-test → run it and see the exact failure → implement → run it → commit. **T1** Step 6 was the last exception and no longer is: it writes `apps/worker/test/health.test.ts` and the `test:bun` script **first**, runs `bun run test:bun` and expects `Cannot find module '../src/health'`, and only then writes the module and the two `index.ts` lines. **T2** Step 5 likewise now runs `legacy-081` against the absent `docs/runbooks/supabase-provisioning.md` and expects the `ENOENT` from `repoFile`, before Step 6 writes the runbook. The three later tasks that used to skip the observation step carry it too: **T12** Step 2 (the idempotence file, which must pass on the first try, and why that is deliberate) and Steps 4–6 (the `@dulja/db/seed` import, red then green, with the manifest change as its own numbered step rather than a block-quote note); **T13** Step 3 (`Failed to resolve import "../src/otel"`, and the second, more useful failure once the module exists but the middleware is unwired); **T14** Steps 2–3 (`Script not found "test:staging"`, then the suite pointed at a dead host so a green run cannot be vacuous).

### 4. Type and literal consistency

- `SubPack`'s four members are identical in `SUB_PACKS` (T6), `parseSeedArgs`'s error message (T6), `LOADERS` (T8, T10, T11), `SeedResult.applied` (T6) and the `--only` tests.
- `PHASE_0_SUB_PACK_DIRECTORIES` (three names) is a different list from `SUB_PACKS` (four) on purpose — `roles` is TypeScript data in `packages/db/seed/roles.ts` (§5.2), not a directory under `my/`; both lists are asserted in T6.
- `DULJA_ENTRYPOINT`'s two values are identical in `entrypoint.sh` (T1), the `Dockerfile`'s default (T1), `containerSecrets` (T5) and both container classes (T3).
- The binding names `API`, `WORKER`, `UPDATE_FEED`, `ATTACHMENTS`, `RATE_LIMIT` are written once in `apps/edge/src/env.ts` and asserted against `infra/wrangler.jsonc` in T4.
- The four posture words (`ok`, `refused`, `refused`, `absent`) appear in `formatPosture` (T2), the local test (T2), the runbook (T2) and the staging suite (T14) — one spelling.
- `FX_ROUNDING_ACCOUNT_CODE = "5920"` is the only place that literal is written in code; the pack file and §4.15 agree.
- `SeedConfig` is one interface, produced by `parseSeedArgs` and consumed by `bootstrapIdentity`, `bootstrapCompany`, `bootstrapOwner` and all four loaders through `LoaderContext`.
- `PackLoader.load` returns "rows inserted", and every idempotence test asserts `0` on the second run — one meaning across four loaders.

### 5. Contract additions this plan makes

**These are not "recorded for folding back" — they are folded in.** Contracts §4.18 round 1 carried each of them into the register it belongs to, and **Task 1 Step 0 verifies all fourteen strings are still there** before any task uses one of the names. Items marked **[T1S0]** below are the register entries that step greps for (it lists the verbatim text of each, so a drifted one can be restored); the rest are new surfaces this slice introduces that no §4 subsection covers, and they are recorded here for the roadmap.

1. **[T1S0]** **`packages/db/seed/my/dimensions/` and `packages/db/seed/my/fiscal-periods/`** — §3.1's sub-pack list once held six directories and neither of these; the 0C card names both as pack contents, and §3.1 now lists all eight.
2. **[T1S0]** **The `--only` loader names `roles`, `dimensions`, `fiscal-periods`** beside §3.4.8's `chart-of-accounts`, and the frozen application order between them.
3. **`SeedAuthAdmin` / `SupabaseSeedAuthAdmin` / `StubSeedAuthAdmin`** in `packages/db/src/seed/auth-admin.ts` — 0B's `AuthAdmin` is in `apps/api` and packages never import apps (§3.1).
4. **`SeedConfig`, `SeedResult`, `SeedError`, `SeedConfigError`, `PackLoader`, `LoaderContext`, `seed()`, `parseSeedArgs`, `assertPackShape`, `readPackFile`** — §4.2.13 registers the loader seam and says the rest of the seed CLI "is 0C's alone and is not registered", so these are recorded here rather than there. **`SeedConfigError` is scoped on purpose**: contracts §4.2.3 owns the bare name `ConfigError` for `apps/api/src/config.ts`, and 8A adds a second `packages/db` one at `hr/config-error.ts` — one spelling per thing (hazard 9). It is the class `packages/db/src/cli.ts` maps to exit code 2.
5. **`apps/worker/src/health.ts` / `startWorkerHealth`** — spec:1157 says "ping the `worker` container" and names no endpoint; 0D's worker has no listener (ADR 0011).
6. **`Env` binding names `API`, `WORKER`, `RATE_LIMIT`** — §3.11 registers only the two R2 bindings.
7. **`containerSecrets(env, entrypoint)`** — the exact set of variables the container receives.
8. **[T1S0]** **`DbOptions.debug`** — an additive field on §4.2.2's `createDb` options, so Postgres spans come from postgres.js's own hook rather than a monkey-patch (ADR 0013).
9. **[T1S0]** **ADR 0013 = observability** — §3.9's ADR-range table and §2.1's 0C card named only 0011 and 0012 for 0C; both now name 0013 and mark 0014–0015 unused.
10. **The seed CLI's exit codes** (0/1/2/3) and **`.github/workflows/deploy-staging.yml`** as the workflow's name.
11. **[T1S0]** **`packages/db` `exports` gains `"./provision/verify-supabase"`** (T2, so the staging suite can import the probe) **and `"./seed"`** (T12, so `apps/api`'s test tier can drive the bootstrap). The seed is deliberately **not** re-exported from `packages/db/src/index.ts`: `auth-admin.ts` imports `@supabase/supabase-js`, and a barrel re-export would put the service-role admin client on the import graph of every `apps/api` and `apps/worker` module that imports `withTenant`. `tests/regression/legacy-039.test.ts` asserts both halves — the barrel is clean, the subpath exists.
12. **[T1S0]** **`infra` joins the root `workspaces` array** (§3.1 fixed it as `["packages/*", "apps/*", "tests"]` and now records the `"infra"` append), with its row in §3.1's workspace table. **`tests/staging` does not** — it is a directory inside the existing `tests` workspace with its own Vitest config, invoked by the new root script `test:staging`, so the frozen array gains nothing for the sake of one `describe`.
13. **[T1S0]** **`ERR_RATE_LIMITED`, status 429, raised by `apps/edge`** — its row in §4.2.4's allocated table (verified present by T1 S0) **and** a row in `packages/contracts/src/errors.ts` in the PR that raises it (T3 S4), which is the two-part rule contracts:1548 states. No existing code fits 429.
14. **[T1S0]** **`otelMiddleware()` is registered ahead of `requestId()`**, so §4.2.3's fixed middleware order becomes `otel → requestId → logger → auth → idempotency → requirePermission → handler`. Without an active span nothing else in ADR 0013 functions (T13's rationale block).
15. **`tests/support/regression.ts` gains `repoFile()`** (additive; 0B's file) — Vitest runs the `tests` workspace from `tests/`, so every repository path a regression file reads must be resolved. It **imports `REPO_ROOT` from `./source`** rather than declaring a second one: 0B exports it from `tests/support/source.ts` and contracts §4.17.1 registers that as the only `REPO_ROOT` in the test tier. (§4.18's round-1 open item 3 records an earlier draft of this plan that did redeclare it; the text above is the resolution §4.17.1 asked for, and this plan carries it.)
    **A second, differently-tiered `REPO_ROOT` does exist and is deliberate:** `packages/db/provision/verify-supabase.ts` declares its own `export const REPO_ROOT` — a **package-tier** constant, `fileURLToPath(new URL("../../..", import.meta.url))`, and a different thing from §4.17.1's test-tier one. It has to be: `packages/db` may not import from `tests/` (§3.1), the script runs under Bun from `packages/db` while the test tier runs under Node from `tests/`, and the two resolve the same directory by different relative depths. Named here so a later slice reading "REPO_ROOT" knows there are two, which file owns each, and that neither imports the other.
16. **`apps/api/test/support/app.ts` passes `debug: pgDebugTracer()` to its `createDb`**, so the Postgres spans of a route test land in the request's trace.
17. **[T1S0]** **`OTEL_EXPORTER_OTLP_ENDPOINT`** joins §3.11's inventory — `| OTEL_EXPORTER_OTLP_ENDPOINT | api, worker | 0C | OTLP trace ingest; unset means the in-memory exporter (OD-22) |`. It is read by both `otel.ts` files, asserted by name in `apps/edge/test/containers.test.ts`, and set with `wrangler secret put` in the deploy runbook.
18. **[T1S0]** **`isGroup?: boolean` on §4.15's declared file shape** — the register once fixed `{ code, nameEn, nameAr, type, parentCode?, currency? }`, and `0c-base.json`'s five presentation parents cannot be expressed without the field; the shape now carries it. §4.15 already says group codes are unregistered; this makes the shape say so too.
19. **[T1S0]** **§2.12's OD-04 gate for 0C** reads "the roles-loader task (0C T8 …)" rather than "seed step 4 task", matching this plan's Task 8. Task 8's gate block states why, and what "droppable" means for a task that is not deletable.
20. **The root `.dockerignore`** (not `infra/.dockerignore`): Docker reads it from the build *context* root, which `infra/Dockerfile`'s own header fixes as the repository root. `tests` and `**/test` are absent from it because `tests` is a workspace whose manifest the `deps` stage must copy; `infra/test/dockerfile.test.ts` enforces both halves — every workspace has a `COPY <ws>/package.json` line, and no ignore pattern shadows a copied path.
21. **The root script `test:staging`** and `apps/edge`'s split into `src/router.ts` (pure), `src/container-env.ts` (pure) and `src/index.ts` / `src/containers.ts` (the only two modules importing `@cloudflare/containers`, and the only two no test may load — `Container` extends `DurableObject`, so the module resolves `cloudflare:workers`, which Node does not have).
22. **`infra/wrangler.jsonc`'s `image_build_context: ".."`** on both container entries. Wrangler's default context is the directory of `image`; this Dockerfile needs the repository root. Asserted in `infra/test/wrangler.test.ts`, together with the fact that the Worker is routed on **one** hostname — the update feed is the `/updates/*` path under it, which is the single URL `docs/runbooks/deploy.md` hands to 0E.

### 6. Spec questions this plan could not resolve, and the assumption it made

1. **spec:2001's bootstrap step 5 lists "document types with policy v1" and "tax codes"**, neither of which can run at Phase 0. The contracts document already proposes dropping both (Appendix A #2, F-23); 0C implements that resolution and `assertPackShape` fails loudly, naming 1A and 5A, if either directory appears early.
2. **The fiscal-year start month has no home in the spec's data model.** It is an OD-21 value, it is needed once (to generate the first year's periods) and `app.company` has no column for it. 0C passes it on `SeedConfig` and does not add a column; 1A, which owns period close and the next year's periods, may want one — flagged for that slice.
3. **§3.7.2 requires a probe for "every job name in `JOBS`"**, and 0D already recorded the narrowing to *registered* handlers (its assumption 8). 0C adds no job and no route, so it neither widens nor narrows that further; the note is repeated here so the roadmap folds one resolution, not two.
4. **The `no-console` override glob is `packages/*/src/cli.ts`** and no plan may widen it (§3.2). `apps/edge` runs on a runtime with no `process.stdout`, so `apps/edge/src/log.ts` carries one inline `oxlint-disable-next-line` with a reason. If the reviewer prefers a config override, it belongs in the contracts document, not in this plan.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-0c-cloud-seed-observability.md`.**

**Before Task 1's own work: Step 0 is a gate, not an edit.** Every register entry this slice adds was folded into the contracts document by its §4.18 round 1, so Step 0 runs fourteen exact-string greps and expects fourteen `PRESENT` lines. It amends nothing unless one reports `MISSING`, and Step 0b commits only in that case — so the normal run is **fourteen commits across fourteen tasks**. Do not re-apply the amendments: a duplicated row in a register twenty-nine other plans read is worse than the drift it would be trying to fix.

**Prerequisites.** Tasks 1–5, 13 and 14 need only **0B** merged. Tasks 6–12 need **0D** merged as well: they consume `packages/db/seed/roles.ts` (`ROLES`, `adminPermissions`), `pgboss.tenant_registry` from migration 0004, and the `jobs:install` script. §6.3's graph says the same thing — "0C (seed task; infra tasks may start after 0B)".

**Next slice in dependency order: 0E** — `docs/superpowers/plans/2026-09-05-dulja-phase-0e-desktop-i18n-shell.md`. Its installer and auto-update tasks consume three things from here: the **R2 `UPDATE_FEED` binding** and the `/updates/*` route (Task 3), the **staging deployment** to log in against (Tasks 4 and 5), and the **seeded owner** whose first login at `aal1` the shell must handle (Tasks 9 and 12). 0E's other tasks — `packages/i18n`, `packages/ui`, the PDF-engine spike — need only 0B.

**What this slice hands forward, by name:** `bun run seed --tenant <id> [--only <sub-pack>]` and the four loaders, for every later slice that adds a sub-pack (1A `document-types`, 2C `templates`, 5A `tax`, 7A `reports`, 8A `statutory`) or a chart file (3C, 3D, 5A, 6A, 6D, 8B, 9B — §4.15's file-per-slice layout); `PackLoader`, `LoaderContext`, `readPackFile` and `assertPackShape`, which each of those extends (the CLI's configuration failure is **`SeedConfigError`**, not `ConfigError` — that bare name is `apps/api/src/config.ts`'s, §4.2.3); the eleven §4.15 accounts and `company.fx_rounding_account_id`, which 1A's posting service and 4B's FX both resolve; `pgboss.tenant_registry` populated, which every scheduled job iterates through `eachTenant`; `infra/Dockerfile` and `infra/wrangler.jsonc`, which every later deploy reuses unchanged; `verifySupabase` / `formatPosture` for 1B's restore drill; `startTelemetry` / `setPrincipalAttributes` for 1B's ledger-integrity SLI and 7A's report timings; and the staging environment itself, which is where Phase 0 exits.

**Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Tasks 1–5 and 6–12 form two chains that can run in parallel once 0D is merged; 13 and 14 come last.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints after Tasks 5, 9 and 12.

Which approach?

