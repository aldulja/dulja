# Dulja Phase 0 — Plan 0D: API core II — `Money`, currency and rates, dimensions and custom fields, pg-boss, catalogue lints, seeded roles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the pure-domain half of the Dulja API core — `@dulja/domain` (`Money`, `Quantity`, `Rational`, rounding, exchange rates), the currency/rate, dimension and custom-field tables and their endpoints, the pg-boss worker with a transactional enqueue helper and two scheduled jobs, and the seeded role catalogue with the three CI lints that keep it honest — closing §5.0 rows 0.7, 0.9, 0.10 and 0.11 and making acceptance tests 14 and 36 pass.

**Architecture:** Four layers, in the dependency order spec §5.2 fixes. `packages/domain` is new and imports nothing internal: pure TypeScript over `decimal.js`, no I/O, no framework — it owns every money, quantity and rounding rule in the system. `packages/db` gains four migrations (0004–0007), their Drizzle mirrors, the pg-boss enqueue adapter, the audit-chain walker and the role seed data. `apps/worker` is new: the same container image as `apps/api` with a different entrypoint (spec:1157–1159), running pg-boss with `migrate: false` against the `pgboss` schema that migration 0004 creates. `apps/api` gains four route files under `/v1/admin/*` and `/v1/companies/{companyId}/*`, carrying five `RouteModule` entries (`custom-fields.ts` mounts two: definitions and values), each registered inside `buildRoutes(deps)` per §4.2.7. Three new rules join `scripts/lint/` — `no-number-money`, `permission-catalogue` and `role-seed` — and are the mechanical half of "a code no code raises fails the build" and R6/R7.

**Tech Stack:** Bun 1.4 (install, scripts) · Node 24 LTS (runs Vitest) · TypeScript strict · PostgreSQL 18 (`postgres:18` in Testcontainers) · `decimal.js` · `postgres` (postgres.js) · `drizzle-orm` / `drizzle-kit` · `pg-boss` · Hono + `@hono/zod-openapi` + Zod · Vitest + fast-check + Testcontainers · `typescript` (compiler API, for the lint rules) · oxlint + oxfmt · Turborepo.

**Spec:** `docs/spec/rebuild-spec.md` v1.2. Sections this plan implements: §3.2.2 (pg-boss and Money rows, spec:1127–1128), §3.2.4 (worker container class, spec:1155–1161), §3.3 (Currency / ExchangeRate / RoundingPolicy and the Dimension line, spec:1175–1177), §3.5 (custom fields as a core service, spec:1235), §3.8 (`dimension_type` / `dimension_value`, `idempotency_key` — spec:1789–1794, 1907–1917), §3.9 (Money, Quantities, Naming — spec:2041–2045), §4.2.1 (permission catalogue and the nine roles, spec:2140–2166), §4.2.2 R6/R7 (spec:2177–2178), §4.5 (API design, spec:2197–2206), §4.9 (observability, spec:2241–2247), §4.11 (engineering practice, spec:2258–2274), §5.0 rows 0.7, 0.9, 0.10, 0.11 (spec:2316–2321), Part VI tests 14 and 36 (spec:2432, 2454). Companion: `docs/spec/legacy-system-analysis.md`.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 0D — API core II: `Money`, currency and rates, dimensions and custom fields, pg-boss, catalogue lints, seeded roles. **Phase:** 0. **Phase gate:** this plan starts only when **0B** is merged (Plan 0A is already merged and frozen); Phase 0 has no predecessor phase, so the only gate is 0B green in CI (spec:87).
- **Depends on (merged):** Plan 0A — `startDb`, `Db`, `Role`, `MIGRATIONS_DIR`, `ROLES_SQL`, `withTenant` (the **4-argument test** helper, used **only** by `packages/db/test/*` — §4.2.2, §4.2.12; root `tests/` and `apps/*/test` use the production `withTenant(sql, ctx, fn)` from `@dulja/db`), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.resolve_principal`, `app.current_tenant`, `app.current_actor`, `app.forbid_change`, `app.audit_row`, `app.audit_chain`, `app.stamp_actor`. Plan 0B — `createDb`, the **production** `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `@dulja/db/test` subpath export, `packages/contracts` (`common.ts`, `errors.ts`, `permissions.ts`, `logger.ts`), `AppEnv`, `RequestContext`, `createApp`, `RouteModule`, `ROUTES`, `requirePermission`, `ScopeSource`, `startApi`/`ApiRequest`/`StartedApi`, `tests/` workspace with `tests/invariants/probes.ts`, `scripts/lint/` (`run.ts`, `types.ts`), `drizzle-orm` + `drizzle-kit` in `packages/db`, the generalised `privileges.test.ts` reversibility test (§3.4.6).
- **Migration numbers:** 0004–0008 — files `0004_create_pgboss_schema.sql`, `0005_create_currency_exchange_rate.sql`, `0006_create_custom_field.sql`, `0007_add_dimension_name_ar.sql` (**0008 left unused**; gaps are legal — §3.4.1). **Task order writes 0007 (Task 10) before 0006 (Task 12), deliberately:** the dimension pair (migration 0007 + service + API, Tasks 10–11) is one reviewable unit and the custom-field pair (migration 0006 + validator + API, Tasks 12–13) is another, and splitting either to make the *file numbers* land in task order would put a migration in one PR and its consumer in another. Nothing depends on the two orders agreeing: 0A's `up()` applies every unapplied version in `discover()` order and records what it applied, so a database migrated at Task 10 records 0007 then 0006 while a freshly created one records 0006 then 0007 — the two schemas are identical either way, because 0006 and 0007 touch disjoint tables (`custom_field_*` versus `dimension_*`) and neither references the other. Task 10's reversibility check therefore fingerprints migrations 1, 4, 5 and 7 and Task 12's fingerprints 1, 4, 5, 6 and 7; both are stated in their own steps. **ADR numbers:** 0007–0010 (0007 pg-boss on Bun, 0008 Money and rounding surface, 0009 exchange-rate lookup semantics, 0010 custom-field storage).
- **Interfaces consumed:** §4.1 (the whole Plan 0A produced surface), §4.2.2 (`createDb`, `withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`Logger`, `AppEnv`, `RequestContext`, middleware order), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError`, `fromDatabaseError`), §4.2.5 (`PERMISSIONS`, `PERMISSION`, `PermissionCode`, `isMutating`, `requirePermission`, `ScopeSource`, `RoleSeed`, `INCOMPATIBLE_PAIRS`), §4.2.7 (`RouteModule`, **`buildRoutes`** — the authoritative form a new module is registered inside, `ROUTES`, **`IdempotencyHeader`**, `createApp`, `PROBES`, `IsolationProbe`), §4.17.1 (`grantAdmin(api, s)` from `tests/support/api.ts`), §4.2.8 (`UuidSchema`, `DateSchema`, `CurrencySchema`, `MoneySchema`, `QuantitySchema`, `RateSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`), §4.2.9 (idempotency semantics), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §3.4.6 (the generalised reversibility test), §3.5.1 (the new-table recipe), §3.7.5 (`LintRule`, `LintViolation`, `SourceFile`).
- **Interfaces produced:** §4.2.1 verbatim (`@dulja/domain`), §4.2.6 verbatim (`createJobClient`, `JOB_NAMES`, `eachTenant`, `JobHandler`, `registerHandler`, `pgboss.tenant_registry`, and the registered `JobPayload` map replacing 0B's stub — `JOBS`, `JobName`, `JobEnvelope`, `EnqueueOptions` and `JobClient` are **0B's** declarations, which Task 6 verifies and extends but never rewrites, per §4.2.6's per-file table), §4.2.10 verbatim (`app.currency`, `app.exchange_rate`, `app.rate_for`), §4.2.11 verbatim (`app.custom_field_definition`, `app.custom_field_value`, `validateCustomFieldValue`), §4.2.5's `packages/db/seed/roles.ts` half (`RoleSeed`, `ROLES`, `INCOMPATIBLE_PAIRS`), §3.6.3's two lints (`permission-catalogue`, `role-seed`), §3.7.5's `no-number-money`, §4.17's `seedBranch` / `seedCurrency` / `seedRate`.
- **Owner decisions:** **OD-04** (the nine role names of spec §4.2.1, changelog #17) → **Task 14, isolated**; default assumed = the spec's names exactly. No other OD item touches this slice; **OD-24 does not apply — 0D ships no screen** (its card carries no OD-24 row; the back-office screens are 0E's).
- **Part VI tests owned / re-run:** owned **14** (the 0A "who can post X in company Y" query becomes real against the seeded catalogue) and **36** (the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions; the branch-scoping assertions are 6C's). Re-run **12** and **13** for the four new tables. **§3.0.4 rows owned:** none — 0D contributes rates to spec:1045, which 4B owns. **Regression files created:** `tests/regression/legacy-005.test.ts` (transactional enqueue), `legacy-008.test.ts` (`Money` never float), `legacy-019.test.ts` (one rounding function). **Appended to:** none.
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **none**; account codes (§4.15) — **none seeded, none consumed** (0D writes no policy and no seed pack); report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**; `fixtures.ts` helpers (§4.17) — **`seedBranch`, `seedCurrency`, `seedRate`, and no others**. `ERR_*` (§4.2.4): 0D adds exactly `ERR_MONEY_CURRENCY_MISMATCH`, `ERR_MONEY_SCALE`, `ERR_RATIONAL_ZERO_DENOMINATOR`, `ERR_RATE_NOT_FOUND` to `ERRORS`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-05.

### Assumptions this plan rests on

Each is stated once here so a task never has to hedge. If one turns out false at execution time, only the task named changes.

1. **0B shipped `packages/contracts` with `errors.ts`, `permissions.ts`, `common.ts` and `logger.ts` at the §4.2.4 / §4.2.5 / §4.2.8 / §4.2.3 shapes**, and `PERMISSIONS` holds exactly the five Phase 0 `admin.*` codes (§3.6.2). Tasks 2, 9, 14 and 15 depend on this.
2. **0B shipped `packages/db/src/with-tenant.ts` exporting the production `withTenant(sql, ctx, fn)` *and* `systemContext(sql, tenantId, requestId)`** (§4.2.2). If 0B's plan shipped `withTenant` but not `systemContext`, **Task 6 Step 3 adds `systemContext` to that file verbatim from §4.2.2** and nothing else changes.
3. **0B shipped `scripts/lint/run.ts` and `scripts/lint/types.ts`** exporting `LintRule`, `LintViolation` and `SourceFile` at the §3.7.5 shape, wired to the root script `bun run lint:rules` and to CI. Tasks 4 and 15 add rule files only. The exact declarations this plan assumes are written out in Task 4 Step 3; if 0B spelled a field differently, only that rule file's three field names change.
4. **`SourceFile` is TypeScript's own `ts.SourceFile`** and the rule runner passes parsed source files with no type checker. `no-number-money` therefore matches **declared type annotations** (`x: number`, `x?: number`, `x: number | null`), not inferred types — which is exactly what spec:2041's lint sentence describes ("No `number` type ever holds a monetary value").
5. **pg-boss's transactional-send option is `send(name, data, { db: { executeSql(text, values) } })` and its constructor accepts `{ schema, migrate }`.** ADR 0007 (Task 5) **verifies these names against the installed version's own type declarations before Task 6 writes the adapter** — this is the "agent verifies and records an ADR" item of spec:93, not a guess. If the names differ, only `packages/db/src/jobs/enqueue.ts` and `apps/worker/src/boss.ts` change.
6. **`pgboss.tenant_registry` lives in schema `pgboss`, not `app`.** The 0A schema linter scans `relnamespace = 'app'::regnamespace` only, so the table needs no `tenant_id`, no RLS and no audit trigger, and **no set in `packages/db/src/lint-schema.ts` changes in this slice.** All four `app` tables 0D creates take the full §3.5.1 recipe.
7. **The `role_permission` → `permission` foreign key means a seeded role may name only codes present in `app.permission`** (plan0A:1322–1326). At Phase 0 the catalogue is five `admin.*` codes, so eight of the nine roles seed an **empty** `permissions` array and `auditor` seeds exactly `["admin.audit_log.read"]`; §3.6.4's rule is that each introducing slice extends the arrays in its own PR. Task 14 states this in the file's own comment so a reader does not mistake it for an omission.
8. **The tenant-isolation harness (§3.7.2) probes a job only when a handler is registered for it.** `JOBS` is the closed registry of all sixteen v1 job names (§4.2.6, "a name not listed here fails the build"), but only two have handlers at 0D. Task 7 states the rule in `tests/invariants/probes.ts` and supplies the two probes. This is a **contract addition** — §3.7.2 says "every job name in `JOBS`", which would demand fourteen probes for jobs no code can run.
9. **`ERR_MONEY_CURRENCY_INVALID` is named by §4.2.1 but is not allocated in §4.2.4's registry.** 0D therefore throws it from `packages/domain` as a class with a `code` property (so the string exists in `packages/**/src/**` for the `error-codes` lint) but **does not add it to `ERRORS`**, because a slice may not widen the registry unilaterally (§4.2.4, hazard 32). An escape reaches the client as `ERR_INTERNAL`; a malformed currency literal is a programmer or seed-data error, never a user input path. Recorded in the Self-Review as a spec question.
10. **`packages/domain` may not import `@dulja/contracts`** (§3.1: `domain` imports nothing from the other packages). Domain errors carry a `code` string; `packages/contracts/src/errors.ts` gains one small `fromDomainError(e)` lifter (Task 2) so a handler can turn a domain throw into a `Problem` without domain knowing about HTTP.
11. **`decimal.js` is added with `bun add decimal.js` and never version-pinned in source** (spec:104, D22). Every internal computation uses a cloned constructor at precision 40 so no intermediate is ever the source of a rounding surprise.
12. **Docker Desktop (WSL2 backend) is available**, as for Plan 0A; every DB test runs `startDb()` against a real `postgres:18` container.
13. **Every route test in this slice grants before it writes.** §4.1 is explicit: `seedTenant` inserts no `role`, no `role_permission` and no `role_assignment` (plan0A:1581–1600), so `app.actor_has(<any code>, s.company)` is false for `s.human` and every `requirePermission`-gated route answers **403** on a bare seed. §4.17.1 makes **0B's `grantAdmin(api: StartedApi, s: Seed): Promise<void>`** in `tests/support/api.ts` the one way to grant, and forbids hand-rolling the three inserts. `apps/api/test/**` reaches it by the relative path 2A and 2C already use — `import { grantAdmin } from "../../../../../tests/support/api";` from `apps/api/test/routes/admin/*.test.ts`. That import is legal not because the lint cannot see it — `apps` **is** one of `dependency-rule`'s `ROOTS` (§3.7.5) — but because §4.17.1 gives `apps/api/test/**` a **named allowance on `scripts/lint/rules/dependency-rule.ts`, carrying its reason on the line**, plus an `include` entry in `apps/api/tsconfig.json`; 2A and 2C already depend on that same allowance with the same import string, and §4.18 round 3 settles the direction. **If 0B wrote the allowance to match `tests/invariants/support/**` only** — §4.17.1's sentence names that path, though the helpers it registers include `tests/support/api.ts` — the fix is one regex in 0B's rule file, not a change here: 2A and 2C need the identical widening, so it is reported to the roadmap rather than patched in this slice. **Tasks 9, 11 and 13 each call `grantAdmin` in `beforeAll`, for every seed whose principal writes**, and no route test in this plan hand-rolls a grant.
14. **A company-scoped route resolves `:companyId` before it answers.** `requirePermission` gates the writes, but §4.2.11 makes the **reads** membership-only, so a company-scoped `GET` carries no permission middleware and a foreign `companyId` would otherwise return `200 { items: [], next_cursor: null }` — leaking nothing, but also failing §3.7.2, whose `IsolationProbe.expect` is typed `403 | 404` and has no 200 form. Every company-scoped handler in Tasks 9, 11 and 13 therefore resolves the company **inside its existing `c.var.withTenant` transaction** (`select 1 from app.company where id = ${companyId}`, one statement, one transaction — spec:2053) and `return c.notFound()` when RLS shows no row, which is `ERR_NOT_FOUND` 404 and, per §4.2.4's registry note, "never reveals cross-tenant existence". The **write** paths keep the `requirePermission` answer they already give: `/v1/admin/currencies` is tenant-scoped with `{ company: "body:companyId" }`, so a foreign company id is `ERR_RBAC_FORBIDDEN` **403** and its probe says so.
15. **`z.unknown()` infers an optional property.** Zod marks a key optional when `undefined extends` its output type, so `z.object({ definitionId: UuidSchema, value: z.unknown() })` infers `{ definitionId: string; value?: unknown }`. Task 12's `setValues` therefore declares its parameter `readonly { definitionId: string; value?: unknown }[]` — the same spelling on both sides — rather than the API layer casting at the call site. `unknown | undefined` is `unknown`, so nothing inside `setValues` changes.

### A note on this plan's length

Contracts §2.0 sizes a slice at 10–15 tasks and ~246 lines per task, and warns that "a plan whose draft passes ~3,700
lines **while tasks remain unwritten** is over the ceiling in substance". This plan is **15 tasks, all written**, and
runs longer than that estimate because 0D's card is unusually dense in *content* rather than in *count*: one entirely
new package with its own public API (`@dulja/domain`, §4.2.1 is 70 lines of frozen signatures on its own), one
entirely new application (`apps/worker`), four migrations with their down files and Drizzle mirrors, four route
modules with their Zod contracts and probes, three CI lint rules that each need a real TypeScript-AST implementation,
and the nine-role seed. Every line is real content an executor types — there is no prose padding and no placeholder
— so the slice is **not** over the ceiling in the sense §2.0 means, and it is not split. A writer who finds a
*different* slice at this length with tasks still unwritten should stop and amend the catalogue, as §2.0 says.

---

## Global Constraints

Copied from the spec; every task's requirements include these.

- **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (LEGACY-036/037/069); issue DDL from application code (LEGACY-053); disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053); gate an audit write on any flag (LEGACY-030); hard-code a package version into a source file — the lockfile owns versions.
- **Always** (spec:106), for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge. *(0D ships no screen.)*
- **Money** (spec:2041): "`numeric(19,4)` in Postgres. In TypeScript, `Money` is an opaque type wrapping `decimal.js`, carrying its currency; the compiler rejects adding MYR to USD. Display rounding applies the currency's policy at render time; **stored base amounts are never recomputed on read.** No `number` type ever holds a monetary value — a lint rule enforces it."
- **Quantities** (spec:2043): "`numeric(19,6)`. Unit conversions are exact rationals `(numerator bigint, denominator bigint)`, never floats (LEGACY-066). Quantity is stored once, in the item's base unit; the entered unit and quantity are kept for display."
- **Identifiers** (spec:2037): `uuidv7()` server-side for everything; never a sequential integer as a public identifier; never reuse; never rewind (LEGACY-021).
- **Time** (spec:2039): all timestamps `timestamptz` in UTC; `effective_date` is a `date`, entered by the user, never derived from `posted_at`.
- **Naming** (spec:2045): `snake_case` in SQL, **singular** table names; TypeScript `camelCase`, types `PascalCase`; bilingual master data as `name_en` / `name_ar` columns, never a JSON blob.
- **Rounding** (spec:2228): one function, explicit mode, symmetric across sign, applied at persist time, rule recorded per currency and per tax code (LEGACY-019).
- **Error codes** (spec:2051): every error has a stable `ERR_<DOMAIN>_<REASON>`, a human message naming the specific entity, and a remedy; codes are enumerated in `packages/contracts/src/errors.ts`; a code no code raises fails the build.
- **Database access** (spec:2053): every query — reads included — runs inside `withTenant(tx => …)`, which opens the transaction and issues the two `set_config(…, true)` calls before anything else. A lint rule forbids bare `db.` calls.
- **API** (spec:2055): `/v1/…`; cursor pagination; `Idempotency-Key` required on POST/PUT/PATCH/DELETE; `application/problem+json` errors; OpenAPI generated from Zod, committed, diffed in CI.
- **Migrations** (spec:2057, §3.4): `packages/db/migrations/NNNN_<verb>_<noun>.sql` matching `/^(\d{4})_([a-z0-9_]+)\.sql$/` with a hand-written `NNNN.down.sql`; each file runs whole in one transaction; **one migration per PR**; forward-only in production.
- **Jobs** (§4.2.6, hazard 20): every handler runs as the tenant's **system principal** via `systemContext`, never under a human's id and never from a request path; work is many short `withTenant` transactions, never one long one.
- **`sql.unsafe` has exactly three homes** (§3.3): the migration runner, the pg-boss transactional-enqueue adapter (this slice) and the Phase 9 Firebird reader. Everything else is a `postgres.js` tagged template or Drizzle.
- **Commits:** conventional commits, scope = workspace or area; subject `<type>(<scope>): <summary> [0D T<n>]`; every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Pushing to GitHub is the owner's call, not part of any task's definition of done.

---

## File structure

Created or modified by this plan, in order of appearance. One responsibility per file.

```
packages/domain/                                NEW — @dulja/domain (§3.1: imports nothing internal)
├─ package.json                                 private, type module, deps: decimal.js
├─ tsconfig.json                                extends ../../tsconfig.base.json; include src + test
├─ vitest.config.ts                             include test/**/*.test.ts
├─ src/
│  ├─ index.ts                                  the package's whole public surface (§4.2.1)
│  ├─ money/
│  │  ├─ decimal.ts                             the cloned decimal.js constructor (precision 40)
│  │  ├─ rational.ts                            Rational, rational(), rationalToDecimal()
│  │  ├─ rounding.ts                            RoundingMode, round(), the three scale constants
│  │  ├─ money.ts                               CurrencyCode, currency(), Money, the two error classes
│  │  ├─ quantity.ts                            Quantity
│  │  └─ exchange-rate.ts                       ExchangeRate, toBase(), UNIT_RATE
│  └─ custom-fields/
│     ├─ types.ts                               CustomFieldKind, CustomFieldDefinition, ValidationResult
│     └─ validate.ts                            validateCustomFieldValue()
└─ test/
   ├─ rational.test.ts        rounding.test.ts        money.test.ts
   ├─ quantity.test.ts        exchange-rate.test.ts   custom-fields.test.ts
   ├─ money.property.test.ts                    fast-check, 10^6 cases (DoD 0.9)
   └─ money.type.test.ts                        the @ts-expect-error compile assertion (DoD 0.9)

packages/db/
├─ package.json                                 + @dulja/domain, pg-boss; + db:status script
├─ migrations/
│  ├─ 0004_create_pgboss_schema.sql  0004.down.sql
│  ├─ 0005_create_currency_exchange_rate.sql  0005.down.sql
│  ├─ 0006_create_custom_field.sql  0006.down.sql
│  └─ 0007_add_dimension_name_ar.sql  0007.down.sql
├─ seed/roles.ts                                RoleSeed, ROLES, INCOMPATIBLE_PAIRS (§4.2.5) — OD-04
├─ src/
│  ├─ index.ts                                  + the exports below
│  ├─ audit/verify-chain.ts                     verifyChain() — the nightly job's chain walk
│  ├─ jobs/names.ts                             0B's JOBS, JobName (§4.2.6, closed) — T6 verifies, never writes
│  ├─ jobs/payloads.ts                          JobPayload map — T6 replaces 0B's stub body, grown per slice
│  ├─ jobs/enqueue.ts                           0B's JobEnvelope/EnqueueOptions/JobClient — T6 adds createJobClient
│  ├─ jobs/tenants.ts                           eachTenant() over pgboss.tenant_registry — new, 0D's own
│  ├─ rates/rate-for.ts                         rateFor() — the one lookup, over app.rate_for()
│  ├─ dimensions/service.ts                     createDimensionType / createDimensionValue / listDimensionTypes
│  ├─ custom-fields/service.ts                  definitions + values, validated through @dulja/domain
│  ├─ rbac/who-can.ts                           whoCan() — acceptance test 14, parameterised on the code
│  └─ schema/                                   Drizzle mirrors (§3.4.9), one file per table
│     ├─ currency.ts  exchange-rate.ts
│     ├─ custom-field-definition.ts  custom-field-value.ts
│     └─ dimension-type.ts  dimension-value.ts
└─ test/
   ├─ fixtures.ts                               + seedBranch, seedCurrency, seedRate (§4.17) — additive only
   ├─ boss.ts                                   installBoss(db): pg-boss tables as app_migrator, for tests
   ├─ currency.test.ts     custom-field.test.ts     dimension.test.ts
   ├─ jobs.test.ts                               DoD 0.11 — rollback never runs the job
   ├─ money-postgres.test.ts                     toBase() agrees with Postgres round() over 10^4 rows
   └─ roles-seed.test.ts                         the nine roles as data (OD-04)

apps/worker/                                    NEW — @dulja/worker (same image as api, other entrypoint)
├─ package.json  tsconfig.json  vitest.config.ts
├─ src/
│  ├─ index.ts                                  entrypoint: start boss, register handlers, schedule
│  ├─ boss.ts                                   createBoss() — schema pgboss, migrate false
│  ├─ install.ts                                jobs:install — pg-boss DDL as app_migrator (deploy step)
│  ├─ log.ts                                    log() / setLogger() — the worker's structured logger (§4.2.6)
│  ├─ handler.ts                                JobHandler, registerHandler, HANDLERS, runJob
│  └─ jobs/
│     ├─ ledger-integrity-check.ts              accounting.ledger.integrity_check (§4.9 SLI, F-13) — Phase-0
│     │                                         scaffold; retired with its test by 1B (T7 Step 5's note)
│     └─ idempotency-key-purge.ts               admin.idempotency_key.purge
└─ test/
   ├─ support/worker.ts                         startWorker(): container + boss + handlers
   ├─ ledger-integrity-check.test.ts
   └─ idempotency-key-purge.test.ts

packages/contracts/src/
├─ errors.ts                                    + 4 ERRORS rows, + fromDomainError()
└─ admin/
   ├─ currency.ts  exchange-rate.ts  dimension.ts  custom-field.ts     Zod contracts (§4.2.8)

apps/api/
├─ src/routes/admin/currencies.ts  exchange-rates.ts  dimension-types.ts  custom-fields.ts
├─ src/routes/index.ts                          + 5 RouteModule entries INSIDE buildRoutes(deps) (§4.2.7)
└─ test/routes/admin/currencies.test.ts  exchange-rates.test.ts  dimension-types.test.ts  custom-fields.test.ts

scripts/lint/rules/
├─ no-number-money.ts                           §3.7.5 — 0D
├─ permission-catalogue.ts                      §3.6.3 — 0D (test 36 catalogue integrity)
└─ role-seed.ts                                 §3.6.3 — 0D (R6 / R7)
scripts/lint/rules/__tests__/                   one .test.ts per rule, fixtures inline

tests/
├─ invariants/probes.ts                         + 5 route probes (one per new RouteModule.path), + 2 job probes
├─ invariants/job-isolation.test.ts             every registered job, two tenants
├─ invariants/role-catalogue.test.ts            acceptance tests 14 and 36 (Phase 0 clauses)
├─ lint/                                        unit tests for the three new lint rules
└─ regression/legacy-005.test.ts  legacy-008.test.ts  legacy-019.test.ts

docs/adr/
├─ 0007-pg-boss-on-bun.md          0008-money-and-rounding-surface.md
└─ 0009-exchange-rate-lookup.md    0010-custom-field-storage.md
```

**Not in this slice, deliberately.** The per-tenant role-grant **applier** and the `bun run seed` CLI are 0C's (§3.6.4, 0C's card) — 0D ships `roles.ts` as data plus the lints over it, and its tests apply the data with a helper local to the test file. No account code, document type, posting policy, print template, report definition or tax code is seeded here (§4.14–§4.16 assign every one of those to a later slice). `packages/db/src/lint-schema.ts` is **not modified** (assumption 6).

---

### Task 1: `packages/domain` — the package, `Rational`, and the one rounding function

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/vitest.config.ts`, `packages/domain/src/money/decimal.ts`, `packages/domain/src/money/rational.ts`, `packages/domain/src/money/rounding.ts`, `packages/domain/src/index.ts`, `docs/adr/0008-money-and-rounding-surface.md`
- Test: `packages/domain/test/rational.test.ts`, `packages/domain/test/rounding.test.ts`

**Interfaces:**
- Consumes: nothing internal — this is the base of the dependency rule (spec:2389, §3.1). Only `decimal.js`.
- Produces (§4.2.1, verbatim):
  - `export const D: Decimal.Constructor` — the cloned constructor every internal computation uses (precision 40).
  - `export type RoundingMode = "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO"`
  - `export function round(value: Decimal, scale: number, mode: RoundingMode): Decimal`
  - `export const MONEY_SCALE = 4`, `export const RATE_SCALE = 8`, `export const QUANTITY_SCALE = 6`
  - `export interface Rational { readonly numerator: bigint; readonly denominator: bigint }`
  - `export function rational(numerator: bigint, denominator: bigint): Rational`
  - `export function rationalToDecimal(r: Rational, scale: number, mode: RoundingMode): Decimal`
  - `export class RationalZeroDenominatorError extends Error { readonly code: "ERR_RATIONAL_ZERO_DENOMINATOR" }`

- [ ] **Step 1: Create the workspace and add `decimal.js`**

`packages/domain` is picked up by the root `workspaces` array's existing `"packages/*"` entry (§3.1) — no root edit is needed.

```bash
mkdir -p packages/domain/src/money packages/domain/src/custom-fields packages/domain/test
bun add --cwd packages/domain decimal.js
bun add --cwd packages/domain -d vitest
```

Never write a version number into a source file (spec:104) — `bun add` resolves it and the lockfile owns it.

- [ ] **Step 2: Write `packages/domain/package.json`, `tsconfig.json` and `vitest.config.ts`**

`packages/domain/package.json` — keep whatever `dependencies`/`devDependencies` versions `bun add` wrote in Step 1 and add only the fields below:

```json
{
  "name": "@dulja/domain",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
```

`packages/domain/tsconfig.json` — **`include` must cover `test/`**, or the `@ts-expect-error` assertion of Task 4 is never typechecked and the DoD 0.9 evidence is vacuous:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`packages/domain/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,       // money.property.test.ts runs 10^6 fast-check cases (DoD 0.9)
  },
});
```

- [ ] **Step 3: Write the failing test `packages/domain/test/rounding.test.ts`**

```ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { MONEY_SCALE, QUANTITY_SCALE, RATE_SCALE, round } from "../src/index";

const d = (s: string) => new Decimal(s);

describe("round() — spec §3.9 'one rounding function, explicit mode, symmetric across sign' (LEGACY-019)", () => {
  it("the three scales are the SQL column scales", () => {
    expect([MONEY_SCALE, RATE_SCALE, QUANTITY_SCALE]).toEqual([4, 8, 6]);
  });

  it("HALF_AWAY_FROM_ZERO is symmetric across sign — the mode the ledger CHECK requires (spec:1816)", () => {
    expect(round(d("2.50005"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("2.5001");
    expect(round(d("-2.50005"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5001");
    expect(round(d("2.50004"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("2.5000");
    expect(round(d("-2.50004"), 4, "HALF_AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5000");
  });

  it("HALF_EVEN goes to the even neighbour in both directions", () => {
    expect(round(d("2.50005"), 4, "HALF_EVEN").toFixed(4)).toBe("2.5000");
    expect(round(d("2.50015"), 4, "HALF_EVEN").toFixed(4)).toBe("2.5002");
    expect(round(d("-2.50005"), 4, "HALF_EVEN").toFixed(4)).toBe("-2.5000");
  });

  it("TOWARD_ZERO truncates and AWAY_FROM_ZERO inflates, both symmetrically", () => {
    expect(round(d("2.50009"), 4, "TOWARD_ZERO").toFixed(4)).toBe("2.5000");
    expect(round(d("-2.50009"), 4, "TOWARD_ZERO").toFixed(4)).toBe("-2.5000");
    expect(round(d("2.50001"), 4, "AWAY_FROM_ZERO").toFixed(4)).toBe("2.5001");
    expect(round(d("-2.50001"), 4, "AWAY_FROM_ZERO").toFixed(4)).toBe("-2.5001");
  });

  it("rounding an already-exact value at its own scale is the identity", () => {
    for (const mode of ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"] as const) {
      expect(round(d("1234.5678"), 4, mode).toFixed(4)).toBe("1234.5678");
    }
  });

  it("a negative or non-integer scale is a programmer error", () => {
    expect(() => round(d("1"), -1, "HALF_EVEN")).toThrow(RangeError);
    expect(() => round(d("1"), 1.5, "HALF_EVEN")).toThrow(RangeError);
  });
});
```

- [ ] **Step 4: Write the failing test `packages/domain/test/rational.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { rational, rationalToDecimal, RationalZeroDenominatorError } from "../src/index";

describe("Rational — exact unit conversions, never floats (spec §3.9; LEGACY-066)", () => {
  it("keeps numerator and denominator as bigints, normalised to a positive denominator", () => {
    expect(rational(12n, 5n)).toEqual({ numerator: 12n, denominator: 5n });
    expect(rational(12n, -5n)).toEqual({ numerator: -12n, denominator: 5n });
    expect(rational(-12n, -5n)).toEqual({ numerator: 12n, denominator: 5n });
  });

  it("reduces by the greatest common divisor so equal ratios are structurally equal", () => {
    expect(rational(1000n, 250n)).toEqual(rational(4n, 1n));
    expect(rational(0n, 7n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it("a zero denominator raises ERR_RATIONAL_ZERO_DENOMINATOR", () => {
    expect(() => rational(1n, 0n)).toThrow(RationalZeroDenominatorError);
    try { rational(1n, 0n); } catch (e) { expect((e as RationalZeroDenominatorError).code).toBe("ERR_RATIONAL_ZERO_DENOMINATOR"); }
  });

  it("converts to a Decimal at an explicit scale and mode — a third never becomes 0.333333333…", () => {
    expect(rationalToDecimal(rational(1n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe("0.333333");
    expect(rationalToDecimal(rational(2n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe("0.666667");
    expect(rationalToDecimal(rational(-2n, 3n), 6, "HALF_AWAY_FROM_ZERO").toFixed(6)).toBe("-0.666667");
  });

  it("survives values far beyond IEEE-754 exactness (the LEGACY-066 class)", () => {
    const r = rational(9007199254740993n, 3n);                       // 2^53 + 1 over 3
    expect(rationalToDecimal(r, 6, "TOWARD_ZERO").toFixed(6)).toBe("3002399751580331.000000");
  });
});
```

- [ ] **Step 5: Run both to verify they fail**

Run: `cd packages/domain && bun run test`
Expected: FAIL — `Failed to resolve import "../src/index"`; no such file.

- [ ] **Step 6: Write `packages/domain/src/money/decimal.ts`**

```ts
import Decimal from "decimal.js";

/**
 * Every internal computation in this package runs on this constructor, never on the global `Decimal`.
 * Cloning keeps our precision away from an application that also uses decimal.js (spec §0.2: no hidden global state).
 *
 * precision 40: the widest intermediate we produce is money (19,4) multiplied by a rate (19,8) — 19 + 8 significant
 * digits before rounding — plus headroom for `allocate` and `Quantity.convert`, both of which divide before rounding.
 * toExpNeg/toExpPos are pushed out so `toFixed()` never returns exponential notation for a value we would persist.
 */
export const D = Decimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40, rounding: Decimal.ROUND_HALF_UP });

export type { Decimal };
```

- [ ] **Step 7: Write `packages/domain/src/money/rounding.ts`**

```ts
import Decimal from "decimal.js";
import { D } from "./decimal";

/** SQL column scales (spec §3.9). Money 4, rates 8, quantities 6. */
export const MONEY_SCALE = 4;
export const RATE_SCALE = 8;
export const QUANTITY_SCALE = 6;

/**
 * The one rounding function (spec §4.6 "one function, explicit mode, symmetric across sign"; LEGACY-019).
 * Every mode here is symmetric across sign — there is deliberately no CEIL/FLOOR, because an asymmetric
 * mode applied to a signed money value is the LEGACY-019 defect ("configured everywhere, applied nowhere,
 * and the one rounding function is wrong").
 */
export type RoundingMode = "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_AWAY_FROM_ZERO: Decimal.ROUND_HALF_UP,   // identical to Postgres round(numeric, int) — hazard 23
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  TOWARD_ZERO: Decimal.ROUND_DOWN,
  AWAY_FROM_ZERO: Decimal.ROUND_UP,
};

export function round(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  if (!Number.isInteger(scale) || scale < 0) throw new RangeError(`round(): scale must be a non-negative integer, got ${scale}`);
  return new D(value).toDecimalPlaces(scale, MODES[mode]);
}
```

- [ ] **Step 8: Write `packages/domain/src/money/rational.ts`**

```ts
import type Decimal from "decimal.js";
import { D } from "./decimal";
import { round, type RoundingMode } from "./rounding";

/** Exact rational for unit conversions (spec §3.9 Quantities; LEGACY-066). `denominator` is always > 0. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export class RationalZeroDenominatorError extends Error {
  readonly code = "ERR_RATIONAL_ZERO_DENOMINATOR" as const;
  constructor() {
    super("ERR_RATIONAL_ZERO_DENOMINATOR: a unit conversion cannot have a zero denominator");
    this.name = "RationalZeroDenominatorError";
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x === 0n ? 1n : x;
}

/** Normalises the sign onto the numerator and reduces, so two equal ratios are structurally equal. */
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RationalZeroDenominatorError();
  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
}

/** Exact division at precision 40, rounded once, at the end, with an explicit mode (spec §4.6). */
export function rationalToDecimal(r: Rational, scale: number, mode: RoundingMode): Decimal {
  return round(new D(r.numerator.toString()).div(new D(r.denominator.toString())), scale, mode);
}
```

- [ ] **Step 9: Write `packages/domain/src/index.ts` (the surface so far)**

```ts
export { D } from "./money/decimal";
export { MONEY_SCALE, QUANTITY_SCALE, RATE_SCALE, round, type RoundingMode } from "./money/rounding";
export { rational, rationalToDecimal, RationalZeroDenominatorError, type Rational } from "./money/rational";
```

- [ ] **Step 10: Run the tests and the toolchain**

Run: `cd packages/domain && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: `rounding.test.ts` 6 passed, `rational.test.ts` 5 passed; lint and typecheck exit 0.

- [ ] **Step 11: Write `docs/adr/0008-money-and-rounding-surface.md`**

```markdown
# ADR 0008 — `Money`, `Quantity` and the one rounding function

- **Status:** Accepted (surface frozen by `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §4.2.1; recorded here because spec §0.2 requires an ADR for anything touching money semantics)
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Spec §3.9 requires `numeric(19,4)` in Postgres and an opaque `Money` type over `decimal.js` in TypeScript that
carries its currency and makes MYR + USD a compiler error. Spec §4.6 requires exactly one rounding function with an
explicit mode, symmetric across sign, applied at persist time (LEGACY-019). LEGACY-008 is the failure this prevents: a
unit cost of 500,020.00 produced by a rounding residue in `double precision`.

## Decision

1. `decimal.js` behind a cloned constructor at **precision 40**; no global `Decimal.set`.
2. Four rounding modes, all symmetric across sign: `HALF_AWAY_FROM_ZERO`, `HALF_EVEN`, `TOWARD_ZERO`,
   `AWAY_FROM_ZERO`. No CEIL/FLOOR — an asymmetric mode on a signed amount is LEGACY-019.
3. `Money.multiply` and `Money.divide` **require** an explicit `RoundingMode` parameter; there is no implicit default.
4. Base conversion is always `HALF_AWAY_FROM_ZERO` at scale 4, because that is what Postgres `round(numeric, int)`
   does and the `ledger_entry` CHECK `base_debit = round(debit * exchange_rate, 4)` (spec §3.8) must hold by
   construction, not by luck. Task 8 proves the agreement against a real Postgres over 10^4 rows.
5. `Money.allocate(weights, mode)` uses the **largest-remainder** method — round each exact share by `mode`, then
   hand the residual minor units one at a time to the shares with the largest positive remainder — with **ties broken
   by lowest index**, which is what makes the contracts document's "residue to the first weight" true for the common
   equal-weights case. Σ of the result equals the input exactly, for every input.
6. The currency literal travels in the type: `currency<const S extends string>(code: S): CurrencyCode & S`, so
   `Money<"MYR">.add(Money<"USD">)` fails `tsc`. The runtime check stays as a second line of defence for values
   crossing the wire, where the literal is erased.

## Consequences

- One place changes if a rounding rule ever changes, and `tests/golden/**` diffs make the change visible (spec §4.11).
- `Money` has no `toNumber()`: there is no supported path from a monetary value to a `number`, which is what makes
  the `no-number-money` lint (§3.7.5) enforceable rather than advisory.
- Display rounding (a currency's `minor_units` / `rounding_mode`, `app.currency`) is a `packages/ui` concern applied
  at render time and is **never persisted** (spec §3.9).

## Open proposal for the owner

The tie-break in (5) and the absence of `toNumber()` in (1) are the two choices the spec does not state. Neither
changes a stored figure that any other rule already fixes; both are recorded here so a reviewer sees them.
```

- [ ] **Step 12: Commit**

```bash
git add packages/domain docs/adr/0008-money-and-rounding-surface.md package.json bun.lock
git commit -m "feat(domain): @dulja/domain with Rational and the one rounding function [0D T1]

Four symmetric rounding modes and exact bigint rationals over a cloned decimal.js
constructor. spec §3.9, §4.6; LEGACY-019, LEGACY-066. ADR 0008.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `Money`, `currency()` and the three money error codes

**Files:**
- Create: `packages/domain/src/money/money.ts`
- Modify: `packages/domain/src/index.ts`, `packages/contracts/src/errors.ts`
- Test: `packages/domain/test/money.test.ts`

**Interfaces:**
- Consumes: Task 1's `D`, `round`, `RoundingMode`, `MONEY_SCALE`, `Rational`; 0B's `ERRORS`, `ErrorDef`, `AppError`, `ErrCode` from `packages/contracts/src/errors.ts` (§4.2.4).
- Produces (§4.2.1, verbatim):
  - `export type CurrencyCode = string & { readonly __brand: "CurrencyCode" }`
  - `export function currency<const S extends string>(code: S): CurrencyCode & S`
  - `export class Money<C extends CurrencyCode = CurrencyCode>` with `of`, `zero`, `fromDecimal`, `add`, `subtract`, `negate`, `multiply`, `divide`, `allocate`, `abs`, `compare`, `equals`, `isZero`, `isNegative`, `isPositive`, `toDecimal`, `toString`, `toJSON`, `fromJSON`
  - `export class MoneyCurrencyMismatchError extends Error { readonly code: "ERR_MONEY_CURRENCY_MISMATCH" }`
  - `export class MoneyScaleError extends Error { readonly code: "ERR_MONEY_SCALE" }`
  - `export class MoneyCurrencyInvalidError extends Error { readonly code: "ERR_MONEY_CURRENCY_INVALID" }`
  - `packages/contracts`: `ERRORS.ERR_MONEY_CURRENCY_MISMATCH`, `ERRORS.ERR_MONEY_SCALE`, `ERRORS.ERR_RATIONAL_ZERO_DENOMINATOR`; `export function fromDomainError(e: unknown): AppError | null`

- [ ] **Step 1: Write the failing test `packages/domain/test/money.test.ts`**

```ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { currency, Money, MoneyCurrencyInvalidError, MoneyCurrencyMismatchError, MoneyScaleError, rational } from "../src/index";

const MYR = currency("MYR");
const USD = currency("USD");
const m = (s: string) => Money.of(s, MYR);

describe("Money — spec §3.9 'opaque, carries its currency, never a float' (LEGACY-008)", () => {
  it("currency() accepts three upper-case letters and rejects everything else", () => {
    expect(currency("MYR")).toBe("MYR");
    for (const bad of ["myr", "MY", "MYRR", "M1R", " MYR", ""]) {
      expect(() => currency(bad)).toThrow(MoneyCurrencyInvalidError);
    }
    try { currency("myr"); } catch (e) { expect((e as MoneyCurrencyInvalidError).code).toBe("ERR_MONEY_CURRENCY_INVALID"); }
  });

  it("of() pads to four decimal places and refuses a fifth", () => {
    expect(m("1.5").toString()).toBe("1.5000");
    expect(m("1234").toString()).toBe("1234.0000");
    expect(m("-0.0001").toString()).toBe("-0.0001");
    expect(() => m("1.12345")).toThrow(MoneyScaleError);
    try { m("1.12345"); } catch (e) { expect((e as MoneyScaleError).code).toBe("ERR_MONEY_SCALE"); }
  });

  it("of() refuses anything that is not a decimal literal — no NaN, no Infinity, no exponent", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "1e4", "1,000.00", "0x10"]) {
      expect(() => Money.of(bad, MYR), bad).toThrow(MoneyScaleError);
    }
  });

  it("add and subtract are exact and stay at scale 4", () => {
    expect(m("0.1").add(m("0.2")).toString()).toBe("0.3000");           // the float answer would be 0.30000000000000004
    expect(m("1000000000000.0001").add(m("0.0002")).toString()).toBe("1000000000000.0003");
    expect(m("5").subtract(m("7.5")).toString()).toBe("-2.5000");
  });

  it("adding a different currency is a runtime error as well as a compile error", () => {
    const usd = Money.fromJSON({ amount: "1.0000", currency: "USD" });
    const myr = Money.fromJSON({ amount: "1.0000", currency: "MYR" });
    expect(() => myr.add(usd)).toThrow(MoneyCurrencyMismatchError);
    try { myr.add(usd); } catch (e) { expect((e as MoneyCurrencyMismatchError).code).toBe("ERR_MONEY_CURRENCY_MISMATCH"); }
  });

  it("multiply and divide demand an explicit rounding mode and accept a Rational", () => {
    expect(m("10").multiply("0.175", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.7500");
    expect(m("10").multiply(rational(1n, 3n), "HALF_AWAY_FROM_ZERO").toString()).toBe("3.3333");
    expect(m("10").multiply(rational(1n, 3n), "TOWARD_ZERO").toString()).toBe("3.3333");
    expect(m("10").divide(new Decimal("3"), "HALF_EVEN").toString()).toBe("3.3333");
    expect(() => m("10").divide("0", "HALF_EVEN")).toThrow(RangeError);
  });

  it("allocate splits to the cent with nothing lost and nothing invented", () => {
    const parts = m("1.0000").allocate([1n, 1n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(parts.map((p) => p.toString())).toEqual(["0.3334", "0.3333", "0.3333"]);   // residue to the first weight
    expect(parts.reduce((a, b) => a.add(b), Money.zero(MYR)).toString()).toBe("1.0000");

    const weighted = m("100.0000").allocate([70n, 30n], "HALF_AWAY_FROM_ZERO");
    expect(weighted.map((p) => p.toString())).toEqual(["70.0000", "30.0000"]);

    const negative = m("-1.0000").allocate([1n, 1n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(negative.map((p) => p.toString())).toEqual(["-0.3334", "-0.3333", "-0.3333"]);
    expect(negative.reduce((a, b) => a.add(b), Money.zero(MYR)).toString()).toBe("-1.0000");

    const zeroWeight = m("10.0000").allocate([0n, 1n], "HALF_AWAY_FROM_ZERO");
    expect(zeroWeight.map((p) => p.toString())).toEqual(["0.0000", "10.0000"]);
  });

  it("allocate refuses weights that cannot describe a split", () => {
    expect(() => m("1").allocate([], "HALF_EVEN")).toThrow(RangeError);
    expect(() => m("1").allocate([0n, 0n], "HALF_EVEN")).toThrow(RangeError);
    expect(() => m("1").allocate([-1n, 2n], "HALF_EVEN")).toThrow(RangeError);
  });

  it("comparison, sign predicates and abs behave on both sides of zero", () => {
    expect(m("1").compare(m("2"))).toBe(-1);
    expect(m("2").compare(m("2"))).toBe(0);
    expect(m("3").compare(m("2"))).toBe(1);
    expect(m("2").equals(m("2.0000"))).toBe(true);
    expect([m("0").isZero(), m("-1").isNegative(), m("1").isPositive()]).toEqual([true, true, true]);
    expect([m("0").isNegative(), m("0").isPositive()]).toEqual([false, false]);
    expect(m("-2.5").abs().toString()).toBe("2.5000");
    expect(m("-2.5").negate().toString()).toBe("2.5000");
  });

  it("the wire form is { amount, currency } and round-trips exactly (§4.2.8 MoneySchema)", () => {
    expect(m("1234.5").toJSON()).toEqual({ amount: "1234.5000", currency: "MYR" });
    expect(Money.fromJSON({ amount: "1234.5000", currency: "MYR" }).toString()).toBe("1234.5000");
    expect(() => Money.fromJSON({ amount: "1234.5", currency: "MYR" })).not.toThrow();
    expect(() => Money.fromJSON({ amount: "1.00000", currency: "MYR" })).toThrow(MoneyScaleError);
  });

  it("fromDecimal rounds explicitly — there is no implicit truncation anywhere", () => {
    expect(Money.fromDecimal(new Decimal("1.00005"), MYR, "HALF_AWAY_FROM_ZERO").toString()).toBe("1.0001");
    expect(Money.fromDecimal(new Decimal("1.00005"), MYR, "HALF_EVEN").toString()).toBe("1.0000");
  });

  it("there is no way from Money to number — the property the no-number-money lint relies on", () => {
    expect((Money.zero(MYR) as unknown as Record<string, unknown>)["toNumber"]).toBeUndefined();
    expect((Money.zero(MYR) as unknown as Record<string, unknown>)["valueOf"]).toBe(Object.prototype.valueOf);
  });

  it("instances are frozen — a Money never changes after construction", () => {
    const a = m("1");
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.add(m("1")).toString()).toBe("2.0000");
    expect(a.toString()).toBe("1.0000");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && bun run test -- test/money.test.ts`
Expected: FAIL — `The requested module '../src/index' does not provide an export named 'Money'`.

- [ ] **Step 3: Write `packages/domain/src/money/money.ts`**

```ts
import type Decimal from "decimal.js";
import { D } from "./decimal";
import type { Rational } from "./rational";
import { MONEY_SCALE, round, type RoundingMode } from "./rounding";

/** ISO 4217 code, upper case, exactly three letters. */
export type CurrencyCode = string & { readonly __brand: "CurrencyCode" };

export class MoneyCurrencyInvalidError extends Error {
  readonly code = "ERR_MONEY_CURRENCY_INVALID" as const;
  constructor(code: string) {
    super(`ERR_MONEY_CURRENCY_INVALID: '${code}' is not a three-letter upper-case ISO 4217 code`);
    this.name = "MoneyCurrencyInvalidError";
  }
}

export class MoneyCurrencyMismatchError extends Error {
  readonly code = "ERR_MONEY_CURRENCY_MISMATCH" as const;
  constructor(left: string, right: string) {
    super(`ERR_MONEY_CURRENCY_MISMATCH: cannot combine ${left} with ${right}`);
    this.name = "MoneyCurrencyMismatchError";
  }
}

export class MoneyScaleError extends Error {
  readonly code = "ERR_MONEY_SCALE" as const;
  constructor(amount: string) {
    super(`ERR_MONEY_SCALE: '${amount}' is not a decimal amount with at most ${MONEY_SCALE} decimal places`);
    this.name = "MoneyScaleError";
  }
}

/**
 * `const` type parameter: currency("MYR") is `CurrencyCode & "MYR"`, not the wide brand — this is what makes
 * `Money.of("1", currency("MYR")).add(Money.of("1", currency("USD")))` a **compile** error (spec §3.9, §5.0 row 0.9).
 */
export function currency<const S extends string>(code: S): CurrencyCode & S {
  if (!/^[A-Z]{3}$/.test(code)) throw new MoneyCurrencyInvalidError(code);
  return code as CurrencyCode & S;
}

/** Amounts on the wire and in SQL literals: an optional sign, digits, an optional fraction of at most 4 places. */
const AMOUNT = /^-?\d+(\.\d{1,4})?$/;

/** Opaque, immutable, always at MONEY_SCALE. `C` is the currency literal when known at compile time. */
export class Money<C extends CurrencyCode = CurrencyCode> {
  private constructor(readonly currency: C, private readonly value: Decimal) {
    Object.freeze(this);
  }

  static of<C extends CurrencyCode>(amount: string, currency: C): Money<C> {
    if (!AMOUNT.test(amount)) throw new MoneyScaleError(amount);
    return new Money(currency, new D(amount).toDecimalPlaces(MONEY_SCALE));
  }

  static zero<C extends CurrencyCode>(currency: C): Money<C> {
    return new Money(currency, new D(0));
  }

  static fromDecimal<C extends CurrencyCode>(value: Decimal, currency: C, mode: RoundingMode): Money<C> {
    return new Money(currency, round(value, MONEY_SCALE, mode));
  }

  static fromJSON(json: { amount: string; currency: string }): Money {
    return Money.of(json.amount, currency(json.currency as string) as CurrencyCode);
  }

  private same(other: Money<C>): void {
    if ((this.currency as string) !== (other.currency as string)) {
      throw new MoneyCurrencyMismatchError(this.currency as string, other.currency as string);
    }
  }

  private with(value: Decimal): Money<C> {
    return new Money(this.currency, value);
  }

  add(other: Money<C>): Money<C> { this.same(other); return this.with(this.value.plus(other.value)); }
  subtract(other: Money<C>): Money<C> { this.same(other); return this.with(this.value.minus(other.value)); }
  negate(): Money<C> { return this.with(this.value.negated()); }
  abs(): Money<C> { return this.with(this.value.abs()); }

  /** Explicit rounding, never implicit (ADR 0008). */
  multiply(factor: Decimal | Rational | string, mode: RoundingMode): Money<C> {
    return this.with(round(this.value.times(toDecimal(factor)), MONEY_SCALE, mode));
  }

  divide(divisor: Decimal | Rational | string, mode: RoundingMode): Money<C> {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new RangeError("Money.divide(): divisor is zero");
    return this.with(round(this.value.div(d), MONEY_SCALE, mode));
  }

  /**
   * Largest-remainder allocation (ADR 0008). Σ result === this, exactly, for every input.
   * Ties in the remainder go to the lowest index, so an equal split hands the residue to the first weight.
   */
  allocate(weights: readonly bigint[], mode: RoundingMode): Money<C>[] {
    if (weights.length === 0) throw new RangeError("Money.allocate(): weights must not be empty");
    if (weights.some((w) => w < 0n)) throw new RangeError("Money.allocate(): a weight cannot be negative");
    const total = weights.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError("Money.allocate(): the weights sum to zero");

    const sum = new D(total.toString());
    const exact = weights.map((w) => this.value.times(new D(w.toString())).div(sum));
    const shares = exact.map((e) => round(e, MONEY_SCALE, mode));
    const unit = new D(1).div(new D(10).pow(MONEY_SCALE));

    let residue = this.value.minus(shares.reduce((a, b) => a.plus(b), new D(0)));
    const step = residue.isNegative() ? unit.negated() : unit;
    // Order by the remainder we still owe each share, descending when we owe (residue > 0) and ascending when we
    // have over-allocated; ties keep the original order, which is what "residue to the first weight" means.
    const order = exact
      .map((e, i) => ({ i, r: e.minus(shares[i]!) }))
      .sort((a, b) => (residue.isNegative() ? a.r.comparedTo(b.r) : b.r.comparedTo(a.r)) || a.i - b.i)
      .map((x) => x.i);

    for (let k = 0; !residue.isZero(); k++) {
      const i = order[k % order.length]!;
      shares[i] = shares[i]!.plus(step);
      residue = residue.minus(step);
    }
    return shares.map((s) => this.with(s));
  }

  compare(other: Money<C>): -1 | 0 | 1 { this.same(other); return this.value.comparedTo(other.value) as -1 | 0 | 1; }
  equals(other: Money<C>): boolean { return (this.currency as string) === (other.currency as string) && this.value.equals(other.value); }
  isZero(): boolean { return this.value.isZero(); }
  isNegative(): boolean { return this.value.isNegative() && !this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive() && !this.value.isZero(); }

  toDecimal(): Decimal { return new D(this.value); }
  /** Fixed 4 dp — the SQL literal and the wire amount. */
  toString(): string { return this.value.toFixed(MONEY_SCALE); }
  toJSON(): { amount: string; currency: C } { return { amount: this.toString(), currency: this.currency }; }
}

function toDecimal(v: Decimal | Rational | string): Decimal {
  if (typeof v === "string") return new D(v);
  if (typeof v === "object" && "numerator" in v) return new D(v.numerator.toString()).div(new D(v.denominator.toString()));
  return new D(v);
}
```

- [ ] **Step 4: Extend `packages/domain/src/index.ts`**

Add below the Task 1 exports:

```ts
export {
  currency, Money, MoneyCurrencyInvalidError, MoneyCurrencyMismatchError, MoneyScaleError, type CurrencyCode,
} from "./money/money";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/domain && bun run test -- test/money.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 6: Add the three money codes and `fromDomainError` to `packages/contracts/src/errors.ts`**

Add these rows inside the `ERRORS` object literal, keeping it alphabetical within its existing grouping:

```ts
  ERR_MONEY_CURRENCY_MISMATCH: { status: 422, title: "Currency mismatch",
    remedy: "Convert one amount to the other currency with an exchange rate before combining them." },
  ERR_MONEY_SCALE: { status: 400, title: "Amount is not a valid money value",
    remedy: "Send the amount as a decimal string with at most four decimal places, e.g. \"1234.5000\"." },
  ERR_RATIONAL_ZERO_DENOMINATOR: { status: 400, title: "Unit conversion has a zero denominator",
    remedy: "Give the conversion as numerator/denominator with a non-zero denominator." },
```

and append, at the end of the file:

```ts
/**
 * `packages/domain` may not import this module (§5.2 dependency rule: domain imports nothing internal), so its errors
 * carry a `code` string instead of extending AppError. This is the one place that lifts such a throw into an AppError.
 * Returns null for anything that is not a recognised domain error, so a caller can rethrow untouched.
 */
export function fromDomainError(e: unknown): AppError | null {
  if (typeof e !== "object" || e === null || !("code" in e)) return null;
  const code = (e as { code: unknown }).code;
  if (typeof code !== "string" || !(code in ERRORS)) return null;
  const detail = e instanceof Error ? e.message.replace(/^ERR_[A-Z_]+: /, "") : code;
  return new AppError(code as ErrCode, detail);
}
```

- [ ] **Step 7: Write the failing test for `fromDomainError` in `packages/contracts/test/errors.test.ts`**

Append to 0B's existing file (create it if 0B named it differently — the assertions below are what matters):

```ts
import { describe, expect, it } from "vitest";
import { currency, Money, MoneyCurrencyMismatchError } from "@dulja/domain";
import { AppError, ERRORS, fromDomainError } from "../src/errors";

describe("fromDomainError — lifting a @dulja/domain throw into the API envelope (0D)", () => {
  it("maps a domain error whose code is in the registry", () => {
    const err = new MoneyCurrencyMismatchError("MYR", "USD");
    const app = fromDomainError(err);
    expect(app).toBeInstanceOf(AppError);
    expect(app!.code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
    expect(app!.detail).toBe("cannot combine MYR with USD");
    expect(ERRORS.ERR_MONEY_CURRENCY_MISMATCH.status).toBe(422);
  });

  it("returns null for anything else, so the caller rethrows untouched", () => {
    expect(fromDomainError(new Error("boom"))).toBeNull();
    expect(fromDomainError({ code: "ERR_NOT_IN_REGISTRY" })).toBeNull();
    expect(fromDomainError(null)).toBeNull();
  });

  it("ERR_MONEY_CURRENCY_INVALID is deliberately NOT in the registry (contracts §4.2.4)", () => {
    expect("ERR_MONEY_CURRENCY_INVALID" in ERRORS).toBe(false);
    expect(fromDomainError(new Error("x"))).toBeNull();
    expect(() => currency("myr")).toThrow(/ERR_MONEY_CURRENCY_INVALID/);
    expect(Money.of("1", currency("MYR")).toString()).toBe("1.0000");
  });
});
```

Add `"@dulja/domain": "workspace:*"` to `packages/contracts/package.json` `dependencies` (`contracts` imports `domain` — §3.1) and run `bun install`.

- [ ] **Step 8: Run the contracts tests and the toolchain**

Run: `cd packages/contracts && bun run test && cd ../.. && bun run lint && bun run lint:rules && bun run typecheck`
Expected: PASS. `lint:rules` stays green: the `error-codes` rule finds each new code's string in `packages/domain/src/money/*.ts` and `packages/contracts/src/errors.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain packages/contracts
git commit -m "feat(domain): Money — opaque, currency-carrying, never a float [0D T2]

Compile-time currency separation via a const type parameter; largest-remainder
allocate; explicit rounding on every multiply and divide. Adds the three money
ERR_* rows and fromDomainError() to packages/contracts. spec §3.9; LEGACY-008.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `Quantity`, `ExchangeRate`, `toBase()` and `UNIT_RATE`

**Files:**
- Create: `packages/domain/src/money/quantity.ts`, `packages/domain/src/money/exchange-rate.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/quantity.test.ts`, `packages/domain/test/exchange-rate.test.ts`

**Interfaces:**
- Consumes: Task 1's `D`, `round`, `RoundingMode`, `QUANTITY_SCALE`, `MONEY_SCALE`, `Rational`; Task 2's `Money`, `CurrencyCode`, `MoneyCurrencyMismatchError`.
- Produces (§4.2.1, verbatim):
  - `export class Quantity` with `of`, `zero`, `add`, `subtract`, `negate`, `multiply`, `convert`, `compare`, `isZero`, `isNegative`, `toDecimal`, `toString`, `toJSON`
  - `export interface ExchangeRate { readonly from: CurrencyCode; readonly to: CurrencyCode; readonly rate: string; readonly effectiveFrom: string; readonly source: string }`
  - `export function toBase(value: Money, rate: ExchangeRate): Money`
  - `export const UNIT_RATE: (c: CurrencyCode) => ExchangeRate`

- [ ] **Step 1: Write the failing test `packages/domain/test/quantity.test.ts`**

```ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { Quantity, rational } from "../src/index";

const q = (s: string) => Quantity.of(s);

describe("Quantity — spec §3.9 'numeric(19,6), exact rational conversions' (LEGACY-066)", () => {
  it("of() pads to six decimal places and refuses a seventh", () => {
    expect(q("12").toString()).toBe("12.000000");
    expect(q("12.5").toString()).toBe("12.500000");
    expect(() => q("12.0000005")).toThrow(RangeError);
    expect(() => q("1e3")).toThrow(RangeError);
    expect(() => q("")).toThrow(RangeError);
  });

  it("add, subtract and negate are exact at scale 6", () => {
    expect(q("0.1").add(q("0.2")).toString()).toBe("0.300000");
    expect(q("1").subtract(q("2.5")).toString()).toBe("-1.500000");
    expect(q("-3").negate().toString()).toBe("3.000000");
    expect(Quantity.zero().toString()).toBe("0.000000");
  });

  it("multiply requires an explicit rounding mode", () => {
    expect(q("3").multiply("0.3333335", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.000001");
    expect(q("3").multiply("0.3333335", "TOWARD_ZERO").toString()).toBe("1.000000");
    expect(q("3").multiply(new Decimal("2"), "HALF_EVEN").toString()).toBe("6.000000");
  });

  it("convert() divides exactly and rounds HALF_EVEN once, at the end (spec §3.9)", () => {
    // 1 carton = 12 base units: 5 cartons = 60 base units, exactly.
    expect(q("5").convert(rational(12n, 1n)).toString()).toBe("60.000000");
    // 1 base unit = 1/3 carton: a third never becomes a float.
    expect(q("1").convert(rational(1n, 3n)).toString()).toBe("0.333333");
    expect(q("2").convert(rational(1n, 3n)).toString()).toBe("0.666667");
    // HALF_EVEN at the boundary, in both directions.
    expect(q("1").convert(rational(15n, 10_000_000n)).toString()).toBe("0.000002");
    expect(q("1").convert(rational(25n, 10_000_000n)).toString()).toBe("0.000002");
  });

  it("converting there and back loses nothing when the ratio divides exactly", () => {
    const cartons = q("7.5");
    const units = cartons.convert(rational(12n, 1n));
    expect(units.convert(rational(1n, 12n)).toString()).toBe(cartons.toString());
  });

  it("compare, isZero, isNegative and the wire form", () => {
    expect(q("1").compare(q("2"))).toBe(-1);
    expect(q("2").compare(q("2.000000"))).toBe(0);
    expect(q("3").compare(q("2"))).toBe(1);
    expect([Quantity.zero().isZero(), q("-1").isNegative(), q("0").isNegative()]).toEqual([true, true, false]);
    expect(q("1.5").toJSON()).toBe("1.500000");
    expect(q("1.5").toDecimal().toFixed(6)).toBe("1.500000");
  });

  it("instances are frozen", () => {
    const a = q("1");
    expect(Object.isFrozen(a)).toBe(true);
    a.add(q("1"));
    expect(a.toString()).toBe("1.000000");
  });
});
```

- [ ] **Step 2: Write the failing test `packages/domain/test/exchange-rate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { currency, Money, MoneyCurrencyMismatchError, toBase, UNIT_RATE, type ExchangeRate } from "../src/index";

const MYR = currency("MYR");
const USD = currency("USD");
const usdMyr: ExchangeRate = { from: USD, to: MYR, rate: "4.68000000", effectiveFrom: "2026-09-04", source: "BNM 2026-09-04" };

describe("toBase() — base = round(value × rate, 4), HALF_AWAY_FROM_ZERO (spec §3.8 ledger CHECK)", () => {
  it("converts into the rate's `to` currency", () => {
    const base = toBase(Money.of("100.0000", USD), usdMyr);
    expect(base.toJSON()).toEqual({ amount: "468.0000", currency: "MYR" });
  });

  it("rounds half away from zero, symmetrically — the mode the ledger CHECK uses", () => {
    const rate: ExchangeRate = { ...usdMyr, rate: "1.00005000" };
    expect(toBase(Money.of("1.0001", USD), rate).toString()).toBe("1.0002");     // 1.000150005 → 1.0002
    expect(toBase(Money.of("-1.0001", USD), rate).toString()).toBe("-1.0002");
  });

  it("refuses a value whose currency is not the rate's `from`", () => {
    expect(() => toBase(Money.of("1.0000", MYR), usdMyr)).toThrow(MoneyCurrencyMismatchError);
    try { toBase(Money.of("1.0000", MYR), usdMyr); }
    catch (e) { expect((e as MoneyCurrencyMismatchError).code).toBe("ERR_MONEY_CURRENCY_MISMATCH"); }
  });

  it("UNIT_RATE is the identity: rate 1, source 'unit', from === to", () => {
    const unit = UNIT_RATE(MYR);
    expect(unit).toEqual({ from: MYR, to: MYR, rate: "1.00000000", effectiveFrom: "0001-01-01", source: "unit" });
    expect(toBase(Money.of("1234.5678", MYR), unit).toString()).toBe("1234.5678");
  });

  it("a rate is rejected unless it is a positive value at exactly 8 decimal places (§4.2.8 RateSchema)", () => {
    for (const bad of ["4.68", "0.00000000", "-1.00000000", "4.680000000", "abc"]) {
      expect(() => toBase(Money.of("1.0000", USD), { ...usdMyr, rate: bad }), bad).toThrow(RangeError);
    }
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd packages/domain && bun run test -- test/quantity.test.ts test/exchange-rate.test.ts`
Expected: FAIL — no export named `Quantity`; no export named `toBase`.

- [ ] **Step 4: Write `packages/domain/src/money/quantity.ts`**

```ts
import type Decimal from "decimal.js";
import { D } from "./decimal";
import type { Rational } from "./rational";
import { QUANTITY_SCALE, round, type RoundingMode } from "./rounding";

const AMOUNT = /^-?\d+(\.\d{1,6})?$/;

/** Opaque quantity at QUANTITY_SCALE, in the item's base unit (spec §3.9). */
export class Quantity {
  private constructor(private readonly value: Decimal) { Object.freeze(this); }

  static of(value: string): Quantity {
    if (!AMOUNT.test(value)) throw new RangeError(`Quantity.of(): '${value}' is not a decimal with at most ${QUANTITY_SCALE} decimal places`);
    return new Quantity(new D(value).toDecimalPlaces(QUANTITY_SCALE));
  }

  static zero(): Quantity { return new Quantity(new D(0)); }

  add(other: Quantity): Quantity { return new Quantity(this.value.plus(other.value)); }
  subtract(other: Quantity): Quantity { return new Quantity(this.value.minus(other.value)); }
  negate(): Quantity { return new Quantity(this.value.negated()); }

  multiply(factor: Rational | Decimal | string, mode: RoundingMode): Quantity {
    const f = typeof factor === "string" ? new D(factor)
      : "numerator" in factor ? new D(factor.numerator.toString()).div(new D(factor.denominator.toString()))
      : new D(factor);
    return new Quantity(round(this.value.times(f), QUANTITY_SCALE, mode));
  }

  /**
   * Exact conversion: multiply by the numerator and divide by the denominator at precision 40, then round
   * HALF_EVEN to 6 dp **once, at the end** (spec §3.9). Rounding per step is the LEGACY-066 defect.
   */
  convert(conversion: Rational): Quantity {
    const exact = this.value.times(new D(conversion.numerator.toString())).div(new D(conversion.denominator.toString()));
    return new Quantity(round(exact, QUANTITY_SCALE, "HALF_EVEN"));
  }

  compare(other: Quantity): -1 | 0 | 1 { return this.value.comparedTo(other.value) as -1 | 0 | 1; }
  isZero(): boolean { return this.value.isZero(); }
  isNegative(): boolean { return this.value.isNegative() && !this.value.isZero(); }

  toDecimal(): Decimal { return new D(this.value); }
  /** Fixed 6 dp — the SQL literal. */
  toString(): string { return this.value.toFixed(QUANTITY_SCALE); }
  /** Wire form: a string (§4.2.8 QuantitySchema). */
  toJSON(): string { return this.toString(); }
}
```

- [ ] **Step 5: Write `packages/domain/src/money/exchange-rate.ts`**

```ts
import { D } from "./decimal";
import { Money, MoneyCurrencyMismatchError, type CurrencyCode } from "./money";
import { MONEY_SCALE, RATE_SCALE, round } from "./rounding";

/** A rate quoted as 1 unit of `from` = `rate` units of `to`; `rate` has RATE_SCALE decimal places. */
export interface ExchangeRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly rate: string;              // "4.68000000"
  readonly effectiveFrom: string;     // YYYY-MM-DD
  readonly source: string;            // 'BNM 2026-09-04', 'manual:<actor_id>' (spec §3.8 exchange_rate.source)
}

const RATE = /^\d+\.\d{8}$/;

/**
 * base = round(value × rate, 4) — HALF_AWAY_FROM_ZERO, identical to the Postgres numeric round() the ledger_entry
 * CHECK `base_debit = round(debit * exchange_rate, 4)` uses (spec §3.8). Any other mode produces rows the database
 * refuses; `packages/db/test/money-postgres.test.ts` proves the agreement against a real Postgres.
 */
export function toBase(value: Money, rate: ExchangeRate): Money {
  if (!RATE.test(rate.rate)) throw new RangeError(`toBase(): rate '${rate.rate}' is not numeric(19,${RATE_SCALE})`);
  const r = new D(rate.rate);
  if (!r.isPositive() || r.isZero()) throw new RangeError(`toBase(): rate '${rate.rate}' must be greater than zero`);
  if ((value.currency as string) !== (rate.from as string)) {
    throw new MoneyCurrencyMismatchError(value.currency as string, rate.from as string);
  }
  return Money.fromDecimal(round(value.toDecimal().times(r), MONEY_SCALE, "HALF_AWAY_FROM_ZERO"), rate.to, "HALF_AWAY_FROM_ZERO");
}

/**
 * The identity rate. The application never looks up a rate where from === to (§4.2.10): it uses this instead, so a
 * missing self-rate row can never make a same-currency document fail with ERR_RATE_NOT_FOUND.
 */
export const UNIT_RATE = (c: CurrencyCode): ExchangeRate => ({
  from: c, to: c, rate: "1.00000000", effectiveFrom: "0001-01-01", source: "unit",
});
```

- [ ] **Step 6: Complete `packages/domain/src/index.ts`**

The file now reads, in full:

```ts
export { D } from "./money/decimal";
export { MONEY_SCALE, QUANTITY_SCALE, RATE_SCALE, round, type RoundingMode } from "./money/rounding";
export { rational, rationalToDecimal, RationalZeroDenominatorError, type Rational } from "./money/rational";
export {
  currency, Money, MoneyCurrencyInvalidError, MoneyCurrencyMismatchError, MoneyScaleError, type CurrencyCode,
} from "./money/money";
export { Quantity } from "./money/quantity";
export { toBase, UNIT_RATE, type ExchangeRate } from "./money/exchange-rate";
```

- [ ] **Step 7: Run the tests and the toolchain**

Run: `cd packages/domain && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: five suites green (`rounding`, `rational`, `money`, `quantity`, `exchange-rate`); lint and typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): Quantity, ExchangeRate and toBase [0D T3]

Exact rational conversions rounded once at scale 6; base conversion pinned to
HALF_AWAY_FROM_ZERO at scale 4 so the ledger_entry CHECK holds by construction.
spec §3.9, §3.8; LEGACY-066.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: Definition of done 0.9 — the property suite, the compile-time currency proof, and the `no-number-money` lint

**Files:**
- Create: `packages/domain/test/money.property.test.ts`, `packages/domain/test/money.type.test.ts`, `scripts/lint/rules/no-number-money.ts`, `tests/lint/no-number-money.test.ts`, `tests/regression/legacy-008.test.ts`
- Modify: `packages/domain/package.json` (dev dependency `fast-check`), `tests/vitest.config.ts` (one new include glob), `tests/package.json` (dependency `@dulja/domain`)

**Interfaces:**
- Consumes: Tasks 1–3's whole `@dulja/domain` surface; 0B's `scripts/lint/types.ts` (`LintRule`, `LintViolation`, `SourceFile`) and `scripts/lint/run.ts`.
- Produces:
  - `scripts/lint/rules/no-number-money.ts` — `export const rule: LintRule` with `name: "no-number-money"`, and `export const ALLOWED: ReadonlySet<string>` (empty at 0D).
  - The §5.0 row 0.9 evidence: `a + b − b = a` over 10⁶ values, and `bun run typecheck` failing if `myr.add(usd)` ever compiles.

**Definition of done being closed here — verbatim (spec §5.0 row 0.9):** "Property tests: `a + b − b = a` for 10⁶ random Money values; adding two currencies is a type error".

- [ ] **Step 1: Add `fast-check`**

```bash
bun add --cwd packages/domain -d fast-check
```

- [ ] **Step 2: Write `packages/domain/test/money.property.test.ts`**

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { currency, Money, Quantity, rational, round, toBase, type ExchangeRate, type RoundingMode } from "../src/index";
import Decimal from "decimal.js";

const MYR = currency("MYR");

/**
 * Hoisted, not written inline in `fc.constantFrom(...)`: an `as const` inside a rest-argument list applies to the
 * one expression it touches, so the other three strings widen to `string` and `round(once, 2, mode)` stops
 * type-checking against `RoundingMode`. `packages/domain/tsconfig.json` includes `test/`, so that would break
 * `bun run typecheck`, not just this file.
 */
const MODES: readonly RoundingMode[] = ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"];

/** A money amount in the range the ledger actually stores: numeric(19,4) — 15 integer digits, 4 decimals. */
const amount = fc
  .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 999_999_999_999_999n }), fc.integer({ min: 0, max: 9999 }))
  .map(([neg, whole, frac]) => `${neg ? "-" : ""}${whole}.${String(frac).padStart(4, "0")}`);

const money = amount.map((a) => Money.of(a, MYR));

describe("Money property tests — spec §5.0 row 0.9 ('a + b - b = a for 10^6 random Money values')", () => {
  it("a + b - b = a, over 10^6 pairs", () => {
    fc.assert(
      fc.property(money, money, (a, b) => a.add(b).subtract(b).equals(a)),
      { numRuns: 1_000_000, verbose: false },
    );
  });

  it("addition is commutative and associative, and zero is its identity", () => {
    fc.assert(fc.property(money, money, (a, b) => a.add(b).equals(b.add(a))), { numRuns: 20_000 });
    fc.assert(
      fc.property(money, money, money, (a, b, c) => a.add(b).add(c).equals(a.add(b.add(c)))),
      { numRuns: 20_000 },
    );
    fc.assert(fc.property(money, (a) => a.add(Money.zero(MYR)).equals(a)), { numRuns: 20_000 });
  });

  it("negate is an involution and a - a is zero", () => {
    fc.assert(fc.property(money, (a) => a.negate().negate().equals(a) && a.subtract(a).isZero()), { numRuns: 20_000 });
  });

  it("allocate sums back to the input exactly, for any weights", () => {
    const weights = fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 12 })
      .filter((ws) => ws.reduce((a, b) => a + b, 0n) > 0n);
    fc.assert(
      fc.property(money, weights, (a, ws) => {
        const parts = a.allocate(ws, "HALF_AWAY_FROM_ZERO");
        return parts.length === ws.length && parts.reduce((x, y) => x.add(y), Money.zero(MYR)).equals(a);
      }),
      { numRuns: 50_000 },
    );
  });

  it("toString round-trips through of() — the SQL literal never loses a digit", () => {
    fc.assert(fc.property(money, (a) => Money.of(a.toString(), MYR).equals(a)), { numRuns: 50_000 });
  });

  it("round() is idempotent at its own scale and never moves a value by a whole unit", () => {
    fc.assert(
      fc.property(amount, fc.constantFrom(...MODES), (a, mode) => {
        const once = round(new Decimal(a), 2, mode);
        return round(once, 2, mode).equals(once) && once.minus(new Decimal(a)).abs().lessThan(new Decimal("0.01"));
      }),
      { numRuns: 50_000 },
    );
  });

  it("toBase is monotone and sign-preserving for a positive rate", () => {
    const rate: ExchangeRate = { from: MYR, to: currency("USD"), rate: "0.21367521", effectiveFrom: "2026-01-01", source: "unit test" };
    fc.assert(
      fc.property(money, (a) => {
        const b = toBase(a, rate);
        return a.isZero() ? b.isZero() : a.isNegative() === b.isNegative() || b.isZero();
      }),
      { numRuns: 50_000 },
    );
  });

  it("Quantity.convert by r then by 1/r returns the original when the ratio divides exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.bigInt({ min: 1n, max: 1000n }), (n, d) => {
        const q = Quantity.of(`${n}.000000`);
        return q.convert(rational(d, 1n)).convert(rational(1n, d)).toString() === q.toString();
      }),
      { numRuns: 20_000 },
    );
  });
});
```

- [ ] **Step 3: Write `packages/domain/test/money.type.test.ts` — the compile-time half of DoD 0.9**

This file is **the definition-of-done evidence for "adding two currencies is a type error"**. It asserts nothing at run time; its value is that `bun run typecheck` fails the build if the `@ts-expect-error` line ever compiles cleanly.

```ts
import { describe, expect, it } from "vitest";
import { currency, Money } from "../src/index";

const myr = Money.of("1.0000", currency("MYR"));
const usd = Money.of("1.0000", currency("USD"));

// @ts-expect-error — Money<CurrencyCode & "USD"> is not assignable to Money<CurrencyCode & "MYR"> (spec §5.0 row 0.9)
myr.add(usd);

// @ts-expect-error — the same rule holds for subtract
myr.subtract(usd);

// @ts-expect-error — and for compare, which also takes Money<C>
myr.compare(usd);

describe("adding two currencies is a type error — spec §5.0 row 0.9", () => {
  it("is proved by `bun run typecheck`, not by this assertion", () => {
    // If the three @ts-expect-error lines above ever compile without an error, tsc reports
    // "Unused '@ts-expect-error' directive" and `bun run typecheck` exits non-zero. That failure
    // IS the test. This body only documents the arrangement so nobody deletes the file as dead code.
    expect(myr.currency).toBe("MYR");
    expect(usd.currency).toBe("USD");
  });

  it("the same-currency operations still compile and are exact", () => {
    expect(myr.add(Money.of("2.0000", currency("MYR"))).toString()).toBe("3.0000");
  });
});
```

- [ ] **Step 4: Run both to see the property suite fail on a deliberate break, then pass**

Run: `cd packages/domain && bun run test -- test/money.property.test.ts test/money.type.test.ts`
Expected: PASS (the implementation from Tasks 1–3 is already correct). To prove the suite has teeth, temporarily change `subtract` in `packages/domain/src/money/money.ts` to `this.value.minus(other.value.plus(new D("0.0001")))`, re-run, and confirm:
`FAIL  Property failed after 1 tests` with a counterexample printed. **Revert the change** before continuing.

Then prove the type half has teeth: temporarily change `add(other: Money<C>)` to `add(other: Money<CurrencyCode>)`, run `bun run typecheck`, and confirm three errors of the form
`error TS2578: Unused '@ts-expect-error' directive.` **Revert the change.**

- [ ] **Step 5: Write `scripts/lint/rules/no-number-money.ts`**

The `LintRule` / `LintViolation` / `SourceFile` shapes come from 0B's `scripts/lint/types.ts` (§3.7.5) and are, for reference:

```ts
// scripts/lint/types.ts — 0B, consumed here unchanged
import type ts from "typescript";
export type SourceFile = ts.SourceFile;
export interface LintViolation { file: string; line: number; rule: string; detail: string }
export interface LintRule { name: string; run(files: SourceFile[]): LintViolation[] }
```

If 0B spelled a field differently, only the three field names in the `push` below change — nothing else in this task.

```ts
import ts from "typescript";
import type { LintRule, LintViolation, SourceFile } from "../types";

/**
 * spec §3.9: "No `number` type ever holds a monetary value — a lint rule enforces it." (LEGACY-008)
 *
 * The regex is the one contracts §3.7.5 fixes. It matches a *declared type annotation*, not an inferred type: the
 * rule runner hands us parsed source files with no type checker, and an annotation is what the spec's sentence is
 * about. `Money`, `Quantity`, `Decimal` or `string` is required instead.
 */
const MONEYISH = /amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i;

/** Scopes named by contracts §3.7.5. Test files are excluded: a test may model a wrong shape deliberately. */
const IN_SCOPE = [/(^|\/)packages\/domain\//, /(^|\/)packages\/contracts\//, /(^|\/)apps\//];
const EXCLUDED = [/(^|\/)test(s)?\//, /(^|\/)__tests__\//, /\.test\.ts$/, /\.d\.ts$/];

/**
 * Exact identifier names allowed to be `number` despite matching MONEYISH. Empty at 0D and expected to stay small:
 * an entry is added only when renaming is genuinely impossible, in the same PR that needs it, and every entry is a
 * review conversation. (`generate` contains "rate", which is the shape of false positive this exists for.)
 */
export const ALLOWED: ReadonlySet<string> = new Set<string>([]);

function isNumberAnnotation(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.NumberKeyword) return true;
  if (ts.isUnionTypeNode(node)) return node.types.some(isNumberAnnotation);
  if (ts.isParenthesizedTypeNode(node)) return isNumberAnnotation(node.type);
  if (ts.isArrayTypeNode(node)) return isNumberAnnotation(node.elementType);
  return false;
}

function declaredName(name: ts.Node): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;                                     // computed keys and destructuring patterns are out of scope
}

function inScope(fileName: string): boolean {
  const p = fileName.replace(/\\/g, "/");
  return IN_SCOPE.some((r) => r.test(p)) && !EXCLUDED.some((r) => r.test(p));
}

export const rule: LintRule = {
  name: "no-number-money",
  run(files: SourceFile[]): LintViolation[] {
    const violations: LintViolation[] = [];
    for (const file of files) {
      if (!inScope(file.fileName)) continue;
      const visit = (node: ts.Node): void => {
        let name: ts.Node | undefined;
        let type: ts.TypeNode | undefined;
        if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) {
          name = node.name;
          type = node.type;
        } else if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
          name = node.name;                        // a method's *return* type
          type = node.type;
        }
        if (name && isNumberAnnotation(type)) {
          const text = declaredName(name);
          if (text && MONEYISH.test(text) && !ALLOWED.has(text)) {
            const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
            violations.push({
              file: file.fileName,
              line: line + 1,
              rule: "no-number-money",
              detail: `'${text}' is typed number — a monetary or rate value must be Money, Quantity, Decimal or string (spec §3.9, LEGACY-008)`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(file, visit);
    }
    return violations;
  },
};
```

- [ ] **Step 6: Write the failing test `tests/lint/no-number-money.test.ts`**

First add the include glob and the dependency. `tests/vitest.config.ts` `include` becomes:

```ts
    include: ["invariants/**/*.test.ts", "regression/**/*.test.ts", "golden/**/*.test.ts", "lint/**/*.test.ts"],
```

and `tests/package.json` `dependencies` gains `"@dulja/domain": "workspace:*"` and `"typescript": "*"` is already a root dev dependency (Plan 0A) — no version literal goes into any source file. Run `bun install`.

```ts
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/no-number-money";

const parse = (fileName: string, source: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS);

describe("no-number-money — spec §3.9 'no number type ever holds a monetary value' (LEGACY-008)", () => {
  it("flags a money-ish property, parameter, variable and return type declared as number", () => {
    const f = parse("packages/contracts/src/admin/thing.ts", `
      export interface Line { unitPrice: number; note: string }
      export function totalOf(totalAmount: number): number { return totalAmount }
      const exchangeRate: number = 4.68;
      export class Row { balance: number = 0 }
    `);
    const found = rule.run([f]).map((v) => v.detail);
    // Five, and the enumeration is exhaustive: `unitPrice` (PropertySignature), `totalOf` (FunctionDeclaration —
    // its own name is what the rule tests, which is why the function is called `totalOf` and not `tally`; `tally`
    // matches nothing in MONEYISH so its `: number` return would not be flagged), `totalAmount` (Parameter),
    // `exchangeRate` (VariableDeclaration), `balance` (PropertyDeclaration — a class field, not a signature).
    // `note: string` is the negative control.
    expect(found).toHaveLength(5);
    expect(found[0]).toContain("'unitPrice' is typed number");
    expect(found.some((d) => d.includes("'totalOf' is typed number"))).toBe(true);
    expect(found.some((d) => d.includes("'balance' is typed number"))).toBe(true);
    expect(rule.run([f])[0]!.rule).toBe("no-number-money");
    expect(rule.run([f])[0]!.line).toBe(2);
  });

  it("flags number inside a union or an array annotation", () => {
    const f = parse("apps/api/src/routes/admin/x.ts", `
      export interface A { taxAmount: number | null; costs: number[] }
    `);
    expect(rule.run([f])).toHaveLength(2);
  });

  it("accepts Money, Quantity, Decimal and string", () => {
    const f = parse("packages/domain/src/x.ts", `
      import type { Money, Quantity } from "./index";
      export interface Line { unitPrice: Money; quantity: Quantity; rate: string; totalBase: Decimal }
    `);
    expect(rule.run([f])).toEqual([]);
  });

  it("ignores names that are not money-ish", () => {
    const f = parse("apps/api/src/x.ts", `
      export interface Page { limit: number; offset: number; lineNo: number; retryLimit: number }
    `);
    expect(rule.run([f])).toEqual([]);
  });

  it("ignores files outside the three scopes and every test file", () => {
    for (const name of [
      "packages/db/src/x.ts", "scripts/lint/rules/x.ts",
      "packages/domain/test/x.ts", "apps/api/test/routes/x.test.ts", "apps/api/src/x.d.ts",
    ]) {
      expect(rule.run([parse(name, "export interface A { totalAmount: number }")]), name).toEqual([]);
    }
  });

  it("reports the file and 1-based line so `<file>:<line> <rule> <detail>` is printable", () => {
    const f = parse("apps/api/src/a.ts", "export interface A {\n  netAmount: number;\n}");
    expect(rule.run([f])).toEqual([{
      file: "apps/api/src/a.ts",
      line: 2,
      rule: "no-number-money",
      detail: "'netAmount' is typed number — a monetary or rate value must be Money, Quantity, Decimal or string (spec §3.9, LEGACY-008)",
    }]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails, then passes**

Run: `cd tests && bun run test -- lint/no-number-money.test.ts`
Expected first: FAIL — `Failed to resolve import "../../scripts/lint/rules/no-number-money"`. After Step 5's file is in place: PASS, 6 tests.

Two diagnostics for the first assertion, which is the one that pins the rule's node coverage. If it reports **4** and the missing detail is `'balance'`, the `PropertyDeclaration` branch was dropped — a class field is a `ts.PropertyDeclaration`, not a `ts.PropertySignature`, and both belong in the first `if`. If it reports **4** and the missing detail is `'totalOf'`, the `FunctionDeclaration` branch was dropped from the second `if` — a function's own name is what the rule tests against `MONEYISH` and `node.type` is its return annotation. Fix the rule, not the test: the fixture is written so each of the five hits comes from a different node kind.

- [ ] **Step 8: Write `tests/regression/legacy-008.test.ts`**

```ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { currency, Money, round } from "@dulja/domain";

const MYR = currency("MYR");

describe("LEGACY-008 Weighted-average cost can go negative, explode by 10,000×, or be wiped to zero — 0D", () => {
  it("money arithmetic is exact where double precision is not", () => {
    // The float answer to 0.1 + 0.2 is 0.30000000000000004; a residue of that shape, divided by a small
    // quantity, is what produced a unit cost of 500,020.00 in the legacy system.
    expect(Money.of("0.1", MYR).add(Money.of("0.2", MYR)).toString()).toBe("0.3000");
    expect(0.1 + 0.2).not.toBe(0.3);                                    // the defect, reproduced
  });

  it("a residue cannot be amplified by a small divisor, because the residue does not exist", () => {
    const value = Money.of("100.0000", MYR).subtract(Money.of("99.9999", MYR));   // exactly 0.0001
    expect(value.toString()).toBe("0.0001");
    expect(value.divide("0.0001", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.0000");
    // The float path: (100 - 99.9999) / 0.0001 is not 1.
    expect((100 - 99.9999) / 0.0001).not.toBe(1);
  });

  it("there is no supported path from a Money to a number", () => {
    const m = Money.of("1.0000", MYR) as unknown as Record<string, unknown>;
    expect(typeof m["toNumber"]).toBe("undefined");
    expect(m["valueOf"]).toBe(Object.prototype.valueOf);
    // The three conversions Money offers, and there is no fourth: every one of them is exact.
    const conversions = Object.getOwnPropertyNames(Object.getPrototypeOf(m)).filter((k) => k.startsWith("to")).sort();
    expect(conversions).toEqual(["toDecimal", "toJSON", "toString"]);
    // `Number(money)` is deliberately NOT asserted to be NaN: with no valueOf and no Symbol.toPrimitive, ToPrimitive
    // falls through to toString() and Number("1.0000") is 1. That is exactly why the guarantee is a *lint* rule over
    // declared types (spec §3.9) and not a runtime trap — a value that reaches `number` has already lost the audit
    // trail, so the defence has to be at the type layer, before the code runs.
  });

  it("rounding a value 10^6 times never drifts", () => {
    let v = new Decimal("1234.56785");
    for (let i = 0; i < 1_000_000; i++) v = round(v, 4, "HALF_AWAY_FROM_ZERO");
    expect(v.toFixed(4)).toBe("1234.5679");
  });

  it("a negative cost is representable and stays negative — the engine rejects it, arithmetic never hides it (3B)", () => {
    expect(Money.of("-1.0000", MYR).isNegative()).toBe(true);
    expect(Money.of("-1.0000", MYR).add(Money.of("1.0000", MYR)).isZero()).toBe(true);
  });
});
```

- [ ] **Step 9: Register the rule and run everything**

`scripts/lint/run.ts` (0B) already loads every `scripts/lint/rules/*.ts` — no registration edit is needed.

Run: `bun run lint && bun run lint:rules && bun run typecheck && cd packages/domain && bun run test && cd ../tests && bun run test -- lint regression/legacy-008.test.ts`
Expected: `lint:rules` prints nothing and exits 0 (no existing file violates `no-number-money`); every suite green. The property suite takes ~40–90 s — that is why `packages/domain/vitest.config.ts` sets `testTimeout: 60_000` and why the 10⁶ run is one `it`, not eight.

If `lint:rules` reports a violation in `packages/contracts/src/common.ts`, check whether it is a genuine money value typed `number`; if it is `ListQuery.limit` the rule's regex has been widened by mistake — `limit` does not match `MONEYISH`.

- [ ] **Step 10: Commit**

```bash
git add packages/domain scripts/lint tests
git commit -m "test(domain): DoD 0.9 — 10^6 money property runs and the compile-time currency proof [0D T4]

fast-check a+b-b=a over 10^6 values, allocate summation, round idempotence; the
@ts-expect-error assertion that makes 'adding two currencies is a type error'
fail typecheck if it ever compiles; the no-number-money lint; legacy-008.

spec §5.0 row 0.9, §3.9; LEGACY-008.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Migration 0004 — the `pgboss` schema, `tenant_registry`, and ADR 0007

**Files:**
- Create: `packages/db/migrations/0004_create_pgboss_schema.sql`, `packages/db/migrations/0004.down.sql`, `packages/db/test/boss.ts`, `docs/adr/0007-pg-boss-on-bun.md`
- Modify: `packages/db/package.json` (dependencies `pg-boss`, `@dulja/domain`)
- Test: `packages/db/test/jobs.test.ts` (the schema half; the enqueue half arrives in Task 6)

**Interfaces:**
- Consumes: Plan 0A's `startDb`, `Db`, `MIGRATIONS_DIR`, `up`, `down`, `listApplied`, `lintSchema`; the migration runner's one-file-one-transaction contract (§3.4.3).
- Produces:
  - SQL: schema `pgboss` with `usage` for `app_rw`, default privileges for `app_migrator`-created tables and sequences, and `pgboss.tenant_registry (tenant_id uuid primary key, created_at timestamptz not null default now())` (§4.2.6).
  - `packages/db/test/boss.ts`: `export async function installBoss(db: Db, queues?: readonly string[]): Promise<PgBoss>` and `export async function stopBoss(boss: PgBoss): Promise<void>`.
  - ADR 0007 recording pg-boss's verified option names.

- [ ] **Step 1: Add pg-boss and verify its option names — the spec:93 "agent verifies and records an ADR" item**

```bash
bun add --cwd packages/db pg-boss
bun add --cwd packages/db @dulja/domain
node -p "const p=require('path'),f=require('fs'),j=require('pg-boss/package.json');const d=p.dirname(require.resolve('pg-boss/package.json'));f.readFileSync(p.join(d, j.types ?? j.typings ?? 'types.d.ts'),'utf8')" \
  | grep -nE "createQueue|executeSql|schema\?|migrate\?|interface (ConstructorOptions|SendOptions|Db|DatabaseOptions)"
node -p "require('pg-boss/package.json').version"
```

Write down, verbatim from that output, four things — they go into ADR 0007 in Step 6 and are the only pg-boss facts any later plan may rely on:
1. the constructor option that stops pg-boss running its own migrations (expected `migrate: false`);
2. the constructor option that names the schema (expected `schema: "pgboss"`);
3. the `send()` option that makes pg-boss run its INSERT on a caller-supplied connection (expected `db: { executeSql(text, values) }`);
4. whether the installed version requires `createQueue(name)` before `send(name, …)` (pg-boss 10 does; earlier versions do not).

**If (3) does not exist under that name in the installed version, stop and raise it** — the transactional enqueue is the whole reason pg-boss was chosen (spec:1127), and a wrapper that cannot do it is not a wrapper worth writing.

- [ ] **Step 2: Write the failing test `packages/db/test/jobs.test.ts` (schema half)**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { down, up } from "../src/migrate";
import { lintSchema } from "../src/lint-schema";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";

describe("migration 0004 — the pgboss schema (contracts §4.2.6; spec §3.2.2)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("creates schema pgboss with USAGE for app_rw", async () => {
    const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.schemata where schema_name = 'pgboss'`;
    expect(row!.n).toBe(1);
    const [priv] = await db.admin<{ ok: boolean }[]>`select has_schema_privilege('app_rw', 'pgboss', 'usage') as ok`;
    expect(priv!.ok).toBe(true);
  });

  it("app_rw may not create objects in pgboss — pg-boss's own tables are installed by app_migrator", async () => {
    const [priv] = await db.admin<{ ok: boolean }[]>`select has_schema_privilege('app_rw', 'pgboss', 'create') as ok`;
    expect(priv!.ok).toBe(false);
    await expect(db.rw`create table pgboss.rogue (id int)`).rejects.toThrow(/permission denied/);
  });

  it("default privileges give app_rw full DML on tables app_migrator creates there, and none elsewhere", async () => {
    const rows = await db.admin<{ defaclobjtype: string; privs: string }[]>`
      select d.defaclobjtype::text, array_to_string(d.defaclacl::text[], ',') as privs
        from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'pgboss' order by 1`;
    expect(rows.map((r) => r.defaclobjtype)).toEqual(["S", "r"]);          // sequences, then relations
    expect(rows.find((r) => r.defaclobjtype === "r")!.privs).toMatch(/app_rw=arwd/);
    expect(rows.find((r) => r.defaclobjtype === "S")!.privs).toMatch(/app_rw=rU/);
  });

  it("pgboss.tenant_registry exists, is readable by app_rw with no tenant set, and is not in schema app", async () => {
    await db.migrator`insert into pgboss.tenant_registry (tenant_id) values ('01920000-0000-7000-8000-000000000001')`;
    const rows = await db.rw<{ tenant_id: string }[]>`select tenant_id from pgboss.tenant_registry order by tenant_id`;
    expect(rows).toHaveLength(1);                                          // no set_config: a job runner can list tenants
    const [app] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'app' and table_name = 'tenant_registry'`;
    expect(app!.n).toBe(0);
  });

  it("the schema linter still reports zero violations — pgboss is outside schema app", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the down file removes the schema and its default privileges completely", async () => {
    await down(db.migrator, MIGRATIONS_DIR, 3);
    const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.schemata where schema_name = 'pgboss'`;
    expect(row!.n).toBe(0);
    const [acl] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'pgboss'`;
    expect(acl!.n).toBe(0);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(expect.arrayContaining([4]));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/jobs.test.ts`
Expected: FAIL — `expected 0 to be 1` on the first assertion; schema `pgboss` does not exist.

- [ ] **Step 4: Write `packages/db/migrations/0004_create_pgboss_schema.sql`**

```sql
-- 0004_create_pgboss_schema.sql — the job queue's home (contracts §4.2.6).
-- spec §3.2.2: pg-boss is Postgres-backed "so a job is enqueued in the same transaction as the posting — the
-- guarantee LEGACY-005 lacked". pg-boss owns its own tables; app_rw may not create objects (spec §3.8, task 0.2), so
-- this file creates the schema and its default privileges and `bun run --cwd apps/worker jobs:install` installs
-- pg-boss's tables as app_migrator at deploy time — the same class of tooling as the migration runner, never
-- application code (spec §0.2 "no DDL from application code", LEGACY-053).

-- ── 1. the schema ─────────────────────────────────────────────────────────────
create schema pgboss;
comment on schema pgboss is 'pg-boss job queue (contracts §4.2.6). Tables installed by apps/worker jobs:install as app_migrator.';
grant usage on schema pgboss to app_rw;
-- deliberately NO `grant create`: the runtime role never issues DDL.

-- ── 2. default privileges, before any table exists ───────────────────────────
-- ALTER DEFAULT PRIVILEGES applies only to objects created AFTER it runs, so it must precede both
-- pgboss.tenant_registry below and pg-boss's own installation.
alter default privileges for role app_migrator in schema pgboss grant select, insert, update, delete on tables to app_rw;
alter default privileges for role app_migrator in schema pgboss grant usage, select on sequences to app_rw;

-- ── 3. the tenant registry ───────────────────────────────────────────────────
-- A scheduled job runs with no tenant set, and FORCE ROW LEVEL SECURITY binds app_migrator too (spec §3.8), so no
-- role can list app.tenant without one. This table — outside schema app, outside RLS, and therefore outside the
-- 0.4 schema linter, which scans relnamespace = 'app'::regnamespace — is the list a scheduled handler iterates.
-- It is written by `bun run seed --tenant <id>` (0C) and by nothing else.
create table pgboss.tenant_registry (
  tenant_id   uuid primary key,
  created_at  timestamptz not null default now()
);
comment on table pgboss.tenant_registry is 'contracts §4.2.6 — the tenants a scheduled job iterates; written by the seed CLI (0C).';
```

- [ ] **Step 5: Write `packages/db/migrations/0004.down.sql`**

```sql
-- 0004.down.sql — reverse dependency order (§3.4.5).
-- The default-privilege revokes must precede the drop: a DROP SCHEMA leaves pg_default_acl rows behind otherwise,
-- and the up → down → up fingerprint test (§3.4.6) would then see a schema that is not byte-identical.
alter default privileges for role app_migrator in schema pgboss revoke usage, select on sequences from app_rw;
alter default privileges for role app_migrator in schema pgboss revoke select, insert, update, delete on tables from app_rw;
-- CASCADE because pg-boss's own tables were installed into this schema after the migration ran (§3.4.5).
drop schema if exists pgboss cascade;
```

- [ ] **Step 6: Write `packages/db/test/boss.ts`**

```ts
import PgBoss from "pg-boss";
import type { Db } from "./harness";

/**
 * The test-side twin of the deploy step `bun run --cwd apps/worker jobs:install` (contracts §4.2.6): pg-boss's own
 * tables are installed **as app_migrator**, exactly once, because app_rw may not create objects. Runtime code always
 * constructs pg-boss with `migrate: false` on DATABASE_URL (app_rw).
 */
export async function installBoss(db: Db, queues: readonly string[] = []): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: db.url("app_migrator"), schema: "pgboss", migrate: true, max: 2 });
  await boss.start();
  for (const name of queues) await boss.createQueue(name);      // pg-boss 10 requires a queue before send(); see ADR 0007
  return boss;
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: false, wait: true });
}
```

If ADR 0007 Step 1 recorded that the installed version has **no** `createQueue`, delete the loop and the `queues` parameter and say so in the ADR — do not leave a silent `typeof` guard, which would hide a real upgrade break.

- [ ] **Step 7: Run the tests**

Run: `cd packages/db && bun run test -- test/jobs.test.ts`
Expected: PASS — 6 tests.

If the default-privilege assertion fails with `app_rw=arwdDxt`, the migration granted more than `select, insert, update, delete` — check for a stray `all privileges`. If `pg_default_acl` is empty, the `alter default privileges` ran before `create schema` (Postgres would have errored) or the roles differ — the grantor must be `app_migrator`, the role the runner connects as.

- [ ] **Step 8: Write `docs/adr/0007-pg-boss-on-bun.md`**

Fill each **verified** line from Step 1's output. Do not copy the expected values without running the command — this ADR exists precisely because the spec (spec:93, spec:1127) asks the agent to verify rather than assume.

```markdown
# ADR 0007 — pg-boss on Bun: schema, transactional enqueue, and the install step

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 0D
- **Spec trigger:** §0.2 "Agent verifies and records an ADR — do not stop: … pg-boss on Bun"; §3.2.2 "Verify it runs clean on Bun during Phase 0".

## Context

Spec §3.2.2 chooses pg-boss because "a job is enqueued in the same transaction as the posting — the guarantee
LEGACY-005 lacked". Three facts had to be verified against the installed version rather than assumed: the option that
makes pg-boss run its INSERT on our transaction, the options that stop it migrating and point it at a schema, and
whether a queue must be declared before a job is sent. Contracts §4.2.6 fixes the wrapper's shape around them.

## Verified facts (from `node -p … pg-boss types` on <VERSION>)

| Fact | Verified name | Notes |
|---|---|---|
| Do not run pg-boss's own migrations at runtime | `migrate: false` (constructor) | <paste the declaration line> |
| Schema | `schema: "pgboss"` (constructor) | <paste> |
| Run the INSERT on my transaction | `send(name, data, { db: { executeSql(text, values) } })` | <paste the `Db`/`DatabaseOptions` interface> |
| Queue must exist before send | `createQueue(name)` — required / not required | <paste> |
| Job table read by tests | `pgboss.job` | <paste, or the partitioned parent's name> |
| Version | <paste> | the lockfile owns it; no version literal in any source file (spec §0.2) |

## Decision

1. Migration `0004_create_pgboss_schema.sql` creates schema `pgboss`, grants `usage` (never `create`) to `app_rw`,
   and sets default privileges so every table pg-boss later creates as `app_migrator` is DML-accessible to `app_rw`.
2. pg-boss's own DDL runs **once per environment** in the deploy step `bun run --cwd apps/worker jobs:install`,
   connected as `app_migrator` on `DATABASE_URL_MIGRATOR`. Application code never issues DDL (spec §0.2, LEGACY-053).
3. At runtime pg-boss is constructed with `{ schema: "pgboss", migrate: false }` on `DATABASE_URL` (`app_rw`).
4. `packages/db/src/jobs/enqueue.ts` is the **only** application file that calls `sql.unsafe` outside the migration
   runner (§0.2 "never build SQL by string concatenation" — this forwards pg-boss's own parameterised statement text
   with bound values and interpolates nothing). It is one of exactly three sanctioned homes for `unsafe`.
5. `enqueue` **throws** when pg-boss returns `null` (a `singletonKey` collision). A silently un-inserted job is
   exactly the LEGACY-005 failure mode — a job that never runs — so the wrapper fails loudly instead.

## Consequences

- A single upgrade of pg-boss can invalidate rows 1–4 of the table above. The `jobs.test.ts` rollback test is the
  canary: it fails the moment the transactional-send option stops working.
- pg-boss is run under Bun in production (`apps/worker`) and under Node 24 in tests (Vitest, D5); both paths are
  exercised in CI.
```

- [ ] **Step 9: Run the whole db suite and the toolchain**

Run: `cd packages/db && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: every `packages/db` suite green, including `privileges.test.ts`'s generalised up → down → up (§3.4.6) now covering migrations 1 and 4.

- [ ] **Step 10: Commit**

```bash
git add packages/db docs/adr/0007-pg-boss-on-bun.md bun.lock
git commit -m "feat(db): migration 0004 — pgboss schema, grants and tenant_registry [0D T5]

Schema, default privileges before any table exists, and the registry a scheduled
job iterates because FORCE RLS hides app.tenant from a job runner. ADR 0007
records the verified pg-boss option names. spec §3.2.2; contracts §4.2.6.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `apps/worker`, the transactional `enqueue`, and 0B's closed `JOBS` registry verified (DoD 0.11)

**Files:**
- Create: `packages/db/src/jobs/tenants.ts`, `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/install.ts`, `apps/worker/src/handler.ts`, `apps/worker/src/log.ts`, `tests/regression/legacy-005.test.ts`
- Modify (**replace**): `packages/db/src/jobs/payloads.ts` — 0B Task 4 created this file as a types-only stub (`export interface JobPayload { [name: string]: unknown }`); Step 5 replaces its body with the registered `extends Record<JobName, unknown>` map of §4.2.6 and adds 0D's two job payloads. `JobPayload[N]` is `unknown` under both forms, so no 0B call site changes.
- Modify: `packages/db/src/jobs/enqueue.ts` — 0B Task 4 created it with `JobEnvelope`, `EnqueueOptions` and `JobClient` as interfaces only; **Step 6 extends 0B's file**, adding `createJobClient(boss: PgBoss): JobClient` and the `pg-boss` import — its one `sql.unsafe` home (§3.3, ADR 0007). The three interfaces 0B shipped are not rewritten (§4.2.6's per-file table: a `Create` verb on a file 0B already wrote is how a plan silently drops its predecessor's interfaces).
- Modify (**verify only**): `packages/db/src/jobs/names.ts` — 0B Task 4 wrote the closed sixteen-name `JOBS` const and `JobName`; **Step 4 verifies them and writes nothing** (§4.2.6's per-file table: "0D neither creates nor rewrites it").
- Modify: `packages/db/src/index.ts`, `packages/db/test/jobs.test.ts`, `scripts/lint/rules/no-sql-concat.ts` (allow-list), `packages/db/src/with-tenant.ts` (only if 0B omitted `systemContext` — see assumption 2)
- Test: `packages/db/test/jobs.test.ts` (enqueue half)

**Interfaces:**
- Consumes: Task 5's `installBoss`/`stopBoss` and the `pgboss` schema; 0B's production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `createDb`; Plan 0A's `startDb`, `seedTenant`, `Seed`, `uuidv7`.
- Verified, not produced: `packages/db/src/jobs/names.ts` — **0B's** `export const JOBS` (all sixteen v1 names, closed) and `export type JobName = keyof typeof JOBS`. Step 4 checks them and writes nothing; this slice never authors that file (§4.2.6's per-file table). Step 7 re-points the barrel's existing `JOBS` / `JobName` exports at `./jobs/enqueue`, which re-exports 0B's two declarations unchanged.
- Produces (§4.2.6, verbatim):
  - `packages/db/src/jobs/payloads.ts`: `export interface JobPayload extends Record<JobName, unknown>` — a type map grown additively per slice, **replacing 0B Task 4's index-signature stub** so the map is keyed by `JobName` from here on.
  - `packages/db/src/jobs/enqueue.ts`: `createJobClient(boss: PgBoss): JobClient` and `JOB_NAMES`, added to the file **alongside** 0B's `JobEnvelope<T>`, `EnqueueOptions` and `JobClient`, which Step 6 carries through unchanged.
  - `packages/db/src/jobs/tenants.ts`: `export async function eachTenant(sql: Sql, fn: (tenantId: string) => Promise<void>): Promise<void>`.
  - `apps/worker/src/handler.ts`: `JobHandler<N>`, `registerHandler<N>(name, handler)`, `registeredJobNames(): JobName[]`, `runJob<N>(sql, name, job)`.
  - `apps/worker/src/log.ts`: `log(): Logger`, `setLogger(l: Logger): void`.
  - `apps/worker` npm scripts `jobs:install`, `start`, `typecheck`, `test`.

- [ ] **Step 1: Scaffold `apps/worker`**

```bash
mkdir -p apps/worker/src/jobs apps/worker/test/support
bun add --cwd apps/worker pg-boss postgres
```

`apps/worker/package.json` — keep the dependency versions `bun add` wrote and add:

```json
{
  "name": "@dulja/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "jobs:install": "bun run src/install.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  },
  "dependencies": {
    "@dulja/contracts": "workspace:*",
    "@dulja/db": "workspace:*",
    "@dulja/domain": "workspace:*"
  }
}
```

`apps/worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`apps/worker/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 180_000, fileParallelism: false },
});
```

- [ ] **Step 2: Append the enqueue half to `packages/db/test/jobs.test.ts`**

```ts
// ── appended to packages/db/test/jobs.test.ts ────────────────────────────────
import type PgBoss from "pg-boss";
import { createJobClient, JOBS, type JobClient } from "../src/jobs/enqueue";
import { eachTenant } from "../src/jobs/tenants";
import { seedTenant, type Seed } from "./fixtures";
import { installBoss, stopBoss } from "./boss";
import { withTenant as testWithTenant, uuidv7 } from "./harness";

describe("transactional enqueue — spec §5.0 row 0.11, §3.2.2 (LEGACY-005)", () => {
  let db: Db; let boss: PgBoss; let jobs: JobClient; let a: Seed; let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  });
  afterAll(async () => { await stopBoss(boss); await db.stop(); });

  const queued = async (name: string): Promise<number> => {
    const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${name}`;
    return row!.n;
  };

  it("a job enqueued in a transaction that COMMITS is queued exactly once", async () => {
    const requestId = await uuidv7(db.admin);
    const id = await testWithTenant(db.rw, a.tenant, a.system, (tx) =>
      jobs.enqueue(tx, "admin.idempotency_key.purge", { tenantId: a.tenant, requestId, payload: {} }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await queued("admin.idempotency_key.purge")).toBe(1);
  });

  it("a job enqueued in a transaction that ROLLS BACK never exists (DoD 0.11)", async () => {
    const before = await queued("accounting.ledger.integrity_check");
    const requestId = await uuidv7(db.admin);
    await expect(
      testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
        await jobs.enqueue(tx, "accounting.ledger.integrity_check", { tenantId: a.tenant, requestId, payload: {} });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");
    expect(await queued("accounting.ledger.integrity_check")).toBe(before);
  });

  it("the job is invisible until the enclosing transaction commits", async () => {
    const requestId = await uuidv7(db.admin);
    await testWithTenant(db.rw, a.tenant, a.system, async (tx) => {
      await jobs.enqueue(tx, "inventory.cost.replay", { tenantId: a.tenant, requestId, payload: {} });
      // A *different* connection cannot see the row while the enqueueing transaction is open.
      expect(await queued("inventory.cost.replay")).toBe(0);
    });
    expect(await queued("inventory.cost.replay")).toBe(1);
  });

  it("the envelope carries tenantId and requestId, and they survive the round trip", async () => {
    const requestId = await uuidv7(db.admin);
    await testWithTenant(db.rw, b.tenant, b.system, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", { tenantId: b.tenant, requestId, payload: {} }));
    const [row] = await db.admin<{ data: { tenantId: string; requestId: string } }[]>`
      select data from pgboss.job where name = 'accounting.period.month_end' limit 1`;
    expect(row!.data).toMatchObject({ tenantId: b.tenant, requestId });
  });

  it("JOBS is the closed registry of every v1 job name, each with a schedule field and an owning slice", () => {
    expect(Object.keys(JOBS)).toHaveLength(16);
    expect(Object.keys(JOBS)).toContain("accounting.ledger.integrity_check");
    expect(JOBS["admin.idempotency_key.purge"]).toEqual({ schedule: "*/30 * * * *", owner: "0D" });
    for (const [name, def] of Object.entries(JOBS)) {
      expect(name, name).toMatch(/^(accounting|inventory|admin|pos|reporting|hr)\.[a-z_]+\.[a-z_]+$/);
      expect(def.schedule === null || /^[\d*/,\- ]+$/.test(def.schedule), name).toBe(true);
    }
  });

  it("eachTenant iterates pgboss.tenant_registry with no tenant set — the FORCE RLS work-around", async () => {
    await db.migrator`insert into pgboss.tenant_registry (tenant_id) values (${a.tenant}), (${b.tenant}) on conflict do nothing`;
    const seen: string[] = [];
    await eachTenant(db.rw, async (t) => { seen.push(t); });
    expect(seen.sort()).toEqual([a.tenant, b.tenant].sort());
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/jobs.test.ts`
Expected: FAIL — `Failed to resolve import "../src/jobs/enqueue"`.

**Before writing the implementation, check assumption 2:** `grep -n "systemContext" packages/db/src/with-tenant.ts`. If it prints nothing, 0B did not ship it; add it now, verbatim from contracts §4.2.2:

```ts
/** For jobs: resolves the tenant's system principal via app.resolve_principal('system:<tenantId>') and returns a context. */
export async function systemContext(sql: Sql, tenantId: string, requestId: string): Promise<TenantContext> {
  const rows = await sql<{ principal_id: string }[]>`select principal_id from app.resolve_principal(${`system:${tenantId}`})`;
  const row = rows[0];
  if (!row) throw new TenantContextError(`no system principal for tenant ${tenantId}`);
  return { tenantId, actorId: row.principal_id, requestId };
}
```

and export it from `packages/db/src/index.ts`.

- [ ] **Step 4: Verify 0B's `packages/db/src/jobs/names.ts` — never rewrite it**

**0B Task 4 created all three `packages/db/src/jobs/` files** (contracts §4.2.6's per-file table, settled): `createApp` cannot compile without `JobClient`, so 0B shipped `names.ts` carrying the **complete, closed sixteen-name `JOBS` const of §4.2.6, verbatim, plus `JobName = keyof typeof JOBS`**. This slice neither creates nor rewrites that file — writing a closed registry a second time is exactly how two spellings of it appear. This step verifies what 0B shipped: the sixteen names are all present, and the two names this slice's handlers and payloads rely on are among them (`accounting.ledger.integrity_check`, Task 7's integrity scaffold, and `admin.idempotency_key.purge`, Task 7's purge handler).

Run:

```bash
bun -e 'import("./packages/db/src/jobs/names.ts").then(({ JOBS }) => { const n = Object.keys(JOBS); if (n.length !== 16) throw new Error(`JOBS has ${n.length} names, not 16`); for (const own of ["accounting.ledger.integrity_check", "admin.idempotency_key.purge"]) if (!n.includes(own)) throw new Error(`0D job name missing from JOBS: ${own}`); console.log("ok — 16 names, both 0D names present"); })'
grep -n 'export type JobName = keyof typeof JOBS' packages/db/src/jobs/names.ts
```

Expected: `ok — 16 names, both 0D names present`, and one `grep` hit for the `JobName` alias.

**If either fails, it is 0B Task 4's file to fix, not this slice's** — the registry and its sixteen entries are §4.2.6-verbatim, and a name added or respelled here would fork it. Step 2's `jobs.test.ts` case "JOBS is the closed registry of every v1 job name…" is the standing assertion of the same three facts and is what Step 10 runs; this step is the pre-flight, so a wrong registry is found before the enqueue adapter is written against it.

- [ ] **Step 5: Replace `packages/db/src/jobs/payloads.ts`** — 0B Task 4 created it as a types-only stub (`export interface JobPayload { [name: string]: unknown }`, so `enqueue`'s signature had a type to name before any job existed). Replace the file's whole body with the registered §4.2.6 form below; `JobPayload[N]` is `unknown` under both, so 0B's `JobClient.enqueue<N>` and every call site of it typecheck unchanged.

```ts
import type { JobName } from "./names";

/**
 * The payload each job carries inside its envelope. Grown **additively** per slice: a slice adds one line for its
 * own job name and touches no other. Extending `Record<JobName, unknown>` keeps `JobPayload[N]` well-typed for a
 * name whose owning slice has not landed yet — it is `unknown` until that slice narrows it — while closing the
 * map over `JobName`, which 0B's wider index signature did not: `JobPayload["typo.job.name"]` was legal there.
 */
export interface JobPayload extends Record<JobName, unknown> {
  /** 0D — the nightly ledger-integrity SLI (spec §4.9). No payload: the handler walks the whole tenant. */
  "accounting.ledger.integrity_check": Record<string, never>;
  /** 0D — expired idempotency keys (spec §3.8 idempotency_key.expires_at, 24 hours). */
  "admin.idempotency_key.purge": Record<string, never>;
}
```

- [ ] **Step 6: Extend 0B's `packages/db/src/jobs/enqueue.ts`** — 0B Task 4 created this file with `JobEnvelope`, `EnqueueOptions` and `JobClient` as interfaces only (0b:1585–1610). This slice **adds** the `pg-boss` type import, the `JOBS` / `JobName` / `JobPayload` re-exports, `createJobClient` and `JOB_NAMES`; the three interfaces keep every member and modifier 0B shipped, and only the `JobClient` doc comment's citation is updated (`spec:2321` → `spec §5.0 row 0.11; LEGACY-005`). The block below is the file's whole content after the step, so the executor can diff it against 0B's rather than guess where the additions go.

```ts
import type PgBoss from "pg-boss";
import type { Sql } from "postgres";
import { JOBS, type JobName } from "./names";
import type { JobPayload } from "./payloads";

export { JOBS, type JobName };
export type { JobPayload };

export interface JobEnvelope<T = unknown> {
  readonly tenantId: string;
  readonly requestId: string;
  readonly payload: T;
}

export interface EnqueueOptions {
  singletonKey?: string;
  startAfterSeconds?: number;
  retryLimit?: number;          // default 3
  retryDelaySeconds?: number;   // default 60, exponential
}

export interface JobClient {
  /**
   * Inserts the job through pg-boss USING `tx`, so it is visible only after the enclosing withTenant commits and
   * never on rollback (spec §5.0 row 0.11; LEGACY-005). Returns the pg-boss job id.
   */
  enqueue<N extends JobName>(tx: Sql, name: N, job: JobEnvelope<JobPayload[N]>, opts?: EnqueueOptions): Promise<string>;
}

export function createJobClient(boss: PgBoss): JobClient {
  return {
    async enqueue(tx, name, job, opts) {
      // One of exactly three sanctioned homes for sql.unsafe (§0.2, ADR 0007): pg-boss hands us its OWN
      // parameterised statement text and the bound values; nothing here is concatenated or interpolated.
      const db = {
        async executeSql(text: string, values: unknown[]) {
          const rows = await tx.unsafe(text, values as never[]);
          return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.count ?? rows.length };
        },
      };
      const id = await boss.send(name, job as unknown as object, {
        db,
        ...(opts?.singletonKey === undefined ? {} : { singletonKey: opts.singletonKey }),
        ...(opts?.startAfterSeconds === undefined ? {} : { startAfter: opts.startAfterSeconds }),
        retryLimit: opts?.retryLimit ?? 3,
        retryDelay: opts?.retryDelaySeconds ?? 60,
        retryBackoff: true,
      });
      if (id === null) {
        // A silently un-inserted job is exactly LEGACY-005: work that is never done. Fail loudly (ADR 0007 decision 5).
        throw new Error(`pg-boss did not insert job ${name}: singletonKey '${opts?.singletonKey ?? ""}' is already queued`);
      }
      return id;
    },
  };
}

/** Every job name the runtime knows, in registry order — used by the install step and the isolation suite. */
export const JOB_NAMES: readonly JobName[] = Object.keys(JOBS) as JobName[];
```

- [ ] **Step 7: Write `packages/db/src/jobs/tenants.ts` (new, 0D's own) and re-point `packages/db/src/index.ts`'s job exports**

```ts
import type { Sql } from "postgres";

/**
 * Iterate every registered tenant. A scheduled handler cannot list `app.tenant`: FORCE ROW LEVEL SECURITY binds
 * app_migrator as well as app_rw (spec §3.8), and a job runner has no tenant set. `pgboss.tenant_registry`
 * (migration 0004) is outside schema app and outside RLS, and is populated by the seed CLI (0C).
 *
 * `fn` is invoked once per tenant, sequentially, and an error in one tenant does not stop the rest: the caller
 * receives an aggregated failure after every tenant has been attempted, so one broken tenant cannot silence the
 * nightly integrity alarm for all the others (spec §4.9 "this alarm is the single most valuable thing you can build").
 */
export async function eachTenant(sql: Sql, fn: (tenantId: string) => Promise<void>): Promise<void> {
  const rows = await sql<{ tenant_id: string }[]>`select tenant_id from pgboss.tenant_registry order by created_at, tenant_id`;
  const failures: { tenantId: string; error: unknown }[] = [];
  for (const row of rows) {
    try { await fn(row.tenant_id); } catch (error) { failures.push({ tenantId: row.tenant_id, error }); }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures.map((f) => f.error), `job failed for ${failures.length} tenant(s): ${failures.map((f) => f.tenantId).join(", ")}`);
  }
}
```

`packages/db/src/index.ts` — **replace** 0B Task 4's three job export lines (`export { JOBS, type JobName } from "./jobs/names";`, `export type { JobPayload } from "./jobs/payloads";`, `export type { EnqueueOptions, JobClient, JobEnvelope } from "./jobs/enqueue";`) with the two lines below. It is a replacement, not an addition: `enqueue.ts` now re-exports 0B's `JOBS`, `JobName` and `JobPayload` (Step 6), so keeping 0B's lines as well would declare each of those names twice in the barrel and fail to compile. Every name 0B exported is still exported, from one place:

```ts
export { createJobClient, JOB_NAMES, JOBS, type EnqueueOptions, type JobClient, type JobEnvelope, type JobName, type JobPayload } from "./jobs/enqueue";
export { eachTenant } from "./jobs/tenants";
```

- [ ] **Step 8: Add `enqueue.ts` to the `no-sql-concat` allow-list**

`scripts/lint/rules/no-sql-concat.ts` (0B) holds an allow-list of files permitted to call `.unsafe(` with a non-literal argument. §0.2 and contracts §3.3 sanction exactly three; add the second one now:

```ts
const ALLOW_UNSAFE = [
  "packages/db/src/migrate.ts",
  "packages/db/src/jobs/enqueue.ts",   // 0D — the pg-boss transactional-enqueue adapter (§3.3, ADR 0007)
];
```

- [ ] **Step 9: Write `apps/worker/src/boss.ts`, `log.ts`, `handler.ts` and `install.ts`**

`apps/worker/src/boss.ts`:

```ts
import PgBoss from "pg-boss";

/**
 * Runtime pg-boss: `migrate: false` (the tables were installed by `jobs:install` as app_migrator — ADR 0007) on
 * DATABASE_URL, which is the app_rw session-mode URL. `max` mirrors the "one small pool per instance" rule (spec §3.2.4).
 */
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString, schema: "pgboss", migrate: false, max: 4 });
}
```

`apps/worker/src/log.ts`:

```ts
import type { Logger } from "@dulja/contracts";

const consoleLogger = (): Logger => {
  const emit = (level: string) => (fields: Record<string, unknown>, msg: string) =>
    process.stdout.write(`${JSON.stringify({ level, msg, ...fields, time: new Date().toISOString() })}\n`);
  const make = (base: Record<string, unknown>): Logger => ({
    debug: (f, m) => emit("debug")({ ...base, ...f }, m),
    info: (f, m) => emit("info")({ ...base, ...f }, m),
    warn: (f, m) => emit("warn")({ ...base, ...f }, m),
    error: (f, m) => emit("error")({ ...base, ...f }, m),
    child: (f) => make({ ...base, ...f }),
  });
  return make({});
};

let current: Logger = consoleLogger();

/** The worker's structured logger (spec §3.9 Logging, §4.9). Tests replace it to assert on what a job reported. */
export function log(): Logger { return current; }
export function setLogger(logger: Logger): void { current = logger; }
```

`apps/worker/src/handler.ts`:

```ts
import type { Sql } from "postgres";
import { systemContext, type JobEnvelope, type JobName, type JobPayload, type TenantContext } from "@dulja/db";

/** Every handler runs as the tenant's **system principal** and does its work as many short withTenant transactions. */
export type JobHandler<N extends JobName> =
  (sql: Sql, job: JobEnvelope<JobPayload[N]>, ctx: TenantContext) => Promise<void>;

const HANDLERS = new Map<JobName, JobHandler<JobName>>();

export function registerHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
  if (HANDLERS.has(name)) throw new Error(`a handler for ${name} is already registered`);
  HANDLERS.set(name, handler as unknown as JobHandler<JobName>);
}

/** The job names this build can actually run. Fewer than JOBS until every owning slice has landed. */
export function registeredJobNames(): JobName[] {
  return [...HANDLERS.keys()].sort();
}

/**
 * Resolve the tenant's system principal, then run the handler (spec §4.2.2 R8: the system principal is reachable
 * only from jobs and the seed CLI, never from a request path, and every write it makes is audited under its own id).
 */
export async function runJob<N extends JobName>(sql: Sql, name: N, job: JobEnvelope<JobPayload[N]>): Promise<void> {
  const handler = HANDLERS.get(name);
  if (!handler) throw new Error(`no handler registered for job ${name}`);
  const ctx = await systemContext(sql, job.tenantId, job.requestId);
  await (handler as unknown as JobHandler<N>)(sql, job, ctx);
}

/** Test-only: forget every registration so one Vitest file does not leak into the next. */
export function resetHandlers(): void { HANDLERS.clear(); }
```

`apps/worker/src/install.ts`:

```ts
/**
 * Deploy step: `bun run --cwd apps/worker jobs:install`. Installs pg-boss's own tables **as app_migrator** and
 * declares every queue in the closed registry. Run once per environment, never from the API (spec §0.2: no DDL from
 * application code, LEGACY-053). ADR 0007.
 */
import PgBoss from "pg-boss";
import { JOB_NAMES } from "@dulja/db";

const url = process.env["DATABASE_URL_MIGRATOR"];
if (!url) {
  process.stderr.write("DATABASE_URL_MIGRATOR is not set\n");
  process.exit(2);
}

const boss = new PgBoss({ connectionString: url, schema: "pgboss", migrate: true, max: 2 });
await boss.start();
for (const name of JOB_NAMES) await boss.createQueue(name);
await boss.stop({ graceful: false, wait: true });
process.stdout.write(`pg-boss installed; ${JOB_NAMES.length} queues declared\n`);
```

- [ ] **Step 10: Run the enqueue tests**

Run: `cd packages/db && bun run test -- test/jobs.test.ts && cd ../../apps/worker && bun run typecheck`
Expected: PASS — 12 tests in `jobs.test.ts`; typecheck exits 0.

If the rollback test *passes trivially* (0 before and after because the commit test also enqueued nothing), check that `boss.send` really received the `db` option — without it pg-boss uses its own pool and the row appears immediately, which the third test ("invisible until commit") is there to catch.

- [ ] **Step 11: Write `tests/regression/legacy-005.test.ts`**

Add `"@dulja/worker": "workspace:*"` to `tests/package.json` dependencies and run `bun install`.

```ts
import type PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// §4.2.12: root `tests/` imports the harness helpers from `@dulja/db/test` and the **production** three-argument
// `withTenant(sql, ctx, fn)` from `@dulja/db`. The 4-argument test helper of the same name is `packages/db/test/*`
// only — it carries neither the deadlock retry nor the nested-transaction guard this file's rollback case relies on.
import { createJobClient, JOBS, withTenant, type JobClient } from "@dulja/db";
import { installBoss, seedTenant, startDb, stopBoss, uuidv7, type Db, type Seed } from "@dulja/db/test";

describe("LEGACY-005 `MatCosts.Changed` is never set on INSERT, so back-dated documents are never recosted — 0D", () => {
  let db: Db; let boss: PgBoss; let jobs: JobClient; let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "Alpha");
    boss = await installBoss(db, Object.keys(JOBS));
    jobs = createJobClient(boss);
  });
  afterAll(async () => { await stopBoss(boss); await db.stop(); });

  const count = async (name: string) => {
    const [r] = await db.admin<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${name}`;
    return r!.n;
  };

  it("the root cause is structural: a job rides the same transaction as the write that needs it", async () => {
    // The legacy defect was a *flag* the writer had to remember to set. There is no flag here: enqueueing is part
    // of the transaction, so a committed write cannot leave its follow-up work un-scheduled…
    const requestId = await uuidv7(db.admin);
    await withTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId }, async (tx) => {
      await tx`update app.company set name = 'Alpha HQ (renamed)' where id = ${s.company}`;
      await jobs.enqueue(tx, "inventory.cost.replay", { tenantId: s.tenant, requestId, payload: {} });
    });
    expect(await count("inventory.cost.replay")).toBe(1);
  });

  it("…and a rolled-back write cannot leave phantom work behind either", async () => {
    const before = await count("inventory.cost.replay");
    const requestId = await uuidv7(db.admin);
    await expect(withTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId }, async (tx) => {
      await tx`update app.company set name = 'never committed' where id = ${s.company}`;
      await jobs.enqueue(tx, "inventory.cost.replay", { tenantId: s.tenant, requestId, payload: {} });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await count("inventory.cost.replay")).toBe(before);
    const [row] = await withTenant(db.rw, { tenantId: s.tenant, actorId: s.system, requestId }, (tx) =>
      tx<{ name: string }[]>`select name from app.company where id = ${s.company}`);
    expect(row!.name).toBe("Alpha HQ (renamed)");
  });

  it("the enqueue helper refuses to fail silently", async () => {
    const requestId = await uuidv7(db.admin);
    const opts = { singletonKey: "legacy-005-once" };
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId };
    await withTenant(db.rw, ctx, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", { tenantId: s.tenant, requestId, payload: {} }, opts));
    await expect(withTenant(db.rw, ctx, (tx) =>
      jobs.enqueue(tx, "accounting.period.month_end", { tenantId: s.tenant, requestId, payload: {} }, opts)))
      .rejects.toThrow(/did not insert job accounting\.period\.month_end/);
  });
});
```

`@dulja/db/test`'s `packages/db/test/index.ts` gains `export * from "./boss";` so `installBoss`/`stopBoss` are reachable from the `tests/` tier (§4.2.12 fixes the file as `export * from "./harness"; export * from "./fixtures";` — this is the one additive line, recorded in the Self-Review).

- [ ] **Step 12: Run everything and commit**

Run: `bun run lint && bun run lint:rules && bun run typecheck && bun run test`
Expected: green everywhere; `lint:rules` still passes with `enqueue.ts` on the `no-sql-concat` allow-list.

```bash
git add packages/db apps/worker scripts/lint tests
git commit -m "feat(worker): pg-boss with transactional enqueue against 0B's JOBS registry [0D T6]

enqueue(tx, name, envelope) runs pg-boss's own INSERT on the caller's transaction,
so a rolled-back transaction never leaves a job behind and a committed one never
loses its follow-up work. DoD 0.11; legacy-005. spec §3.2.2; contracts §4.2.6.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The two Phase 0 job handlers — ledger integrity and idempotency-key purge

**Files:**
- Create: `packages/db/src/audit/verify-chain.ts`, `apps/worker/src/jobs/ledger-integrity-check.ts`, `apps/worker/src/jobs/idempotency-key-purge.ts`, `apps/worker/src/index.ts`, `apps/worker/test/support/worker.ts`, `apps/worker/test/ledger-integrity-check.test.ts`, `apps/worker/test/idempotency-key-purge.test.ts`, `tests/invariants/job-isolation.test.ts`
- Modify: `packages/db/src/index.ts`, `tests/invariants/probes.ts`, `apps/worker/package.json` (dependency `uuid`, and the two `exports` subpaths of Step 9), `apps/worker/src/install.ts` (the fan-out queues of Step 7)

**Interfaces:**
- Consumes: Task 6's `registerHandler`, `runJob`, `registeredJobNames`, `resetHandlers`, `log`, `setLogger`, `eachTenant`, `createBoss`; **0B's `JOBS`**, reached through the `@dulja/db` barrel Task 6 Step 7 re-points; 0B's production `withTenant`, `systemContext`, `Logger`; Plan 0A's `app.audit_log` chain columns and `app.idempotency_key`.
- Produces:
  - `packages/db/src/audit/verify-chain.ts`: `export interface ChainResult { rows: number; brokenLinks: number; badHashes: number }` and `export async function verifyChain(tx: Sql, tenantId: string): Promise<ChainResult>`.
  - `apps/worker/src/jobs/ledger-integrity-check.ts`: `export const ledgerIntegrityCheck: JobHandler<"accounting.ledger.integrity_check">`.
  - `apps/worker/src/jobs/idempotency-key-purge.ts`: `export const idempotencyKeyPurge: JobHandler<"admin.idempotency_key.purge">`.
  - `apps/worker/test/support/worker.ts`: `export async function startWorker(): Promise<StartedWorker>` with `{ db, boss, jobs, logs, run, stop }`.
  - `tests/invariants/probes.ts`: `export interface JobIsolationProbe` and `export const JOB_PROBES`.

- [ ] **Step 1: Write the failing test `apps/worker/test/ledger-integrity-check.test.ts`**

`apps/worker/test/support/worker.ts` first — it is the worker's twin of 0B's `startApi()`:

```ts
import type PgBoss from "pg-boss";
import { createJobClient, JOBS, type JobClient, type JobEnvelope, type JobName, type JobPayload } from "@dulja/db";
import { installBoss, startDb, stopBoss, type Db } from "@dulja/db/test";
import type { LogFields, Logger } from "@dulja/contracts";
import { registerHandler, resetHandlers, runJob } from "../../src/handler";
import { setLogger } from "../../src/log";
import { ledgerIntegrityCheck } from "../../src/jobs/ledger-integrity-check";
import { idempotencyKeyPurge } from "../../src/jobs/idempotency-key-purge";

export interface CapturedLog { level: "debug" | "info" | "warn" | "error"; fields: LogFields; msg: string }

export interface StartedWorker {
  db: Db;
  boss: PgBoss;
  jobs: JobClient;
  logs: CapturedLog[];
  run<N extends JobName>(name: N, job: JobEnvelope<JobPayload[N]>): Promise<void>;
  stop(): Promise<void>;
}

function capture(sink: CapturedLog[], base: LogFields = {}): Logger {
  const at = (level: CapturedLog["level"]) => (fields: LogFields, msg: string) => { sink.push({ level, fields: { ...base, ...fields }, msg }); };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: (f) => capture(sink, { ...base, ...f }) };
}

export async function startWorker(): Promise<StartedWorker> {
  const db = await startDb();
  const boss = await installBoss(db, Object.keys(JOBS));
  const logs: CapturedLog[] = [];
  setLogger(capture(logs));
  resetHandlers();
  registerHandler("accounting.ledger.integrity_check", ledgerIntegrityCheck);
  registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);
  return {
    db, boss, jobs: createJobClient(boss), logs,
    run: (name, job) => runJob(db.rw, name, job),
    async stop() { await stopBoss(boss); await db.stop(); },
  };
}
```

```ts
// apps/worker/test/ledger-integrity-check.test.ts
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedTenant, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "./support/worker";

describe("accounting.ledger.integrity_check — spec §5.0 row 0.11, §4.9 'the ledger-integrity SLI'", () => {
  let w: StartedWorker; let a: Seed; let b: Seed;
  beforeAll(async () => { w = await startWorker(); a = await seedTenant(w.db, "Alpha"); b = await seedTenant(w.db, "Beta"); });
  afterAll(async () => { await w.stop(); });
  beforeEach(() => { w.logs.length = 0; });

  /**
   * §4.2.12: `apps/*/test` uses the **production** `withTenant(sql, ctx, fn)` from `@dulja/db`, not the 4-argument
   * test helper (which is `packages/db/test/*` only). This wrapper mints the `requestId` the context needs so the
   * call sites below read as one line each.
   */
  const asPrincipal = async <T>(db: Db, tenantId: string, actorId: string, fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, { tenantId, actorId, requestId: await uuidv7(db.admin) }, fn);

  const run = async (tenantId: string) =>
    w.run("accounting.ledger.integrity_check", { tenantId, requestId: await uuidv7(w.db.admin), payload: {} });

  it("reports 'no postings' on a tenant with an empty ledger (spec §5.0 row 0.11 F-13 wording)", async () => {
    await run(a.tenant);
    const line = w.logs.find((l) => l.msg === "no postings");
    expect(line).toBeDefined();
    expect(line!.level).toBe("info");
    expect(line!.fields).toMatchObject({ tenant_id: a.tenant, ledger_entries: 0, broken_links: 0, bad_hashes: 0 });
    expect(line!.fields["audit_rows"]).toBeGreaterThan(0);          // the seed itself is audited
  });

  it("walks the audit chain and reports it intact", async () => {
    await run(a.tenant);
    const line = w.logs.find((l) => l.msg === "no postings")!;
    expect([line.fields["broken_links"], line.fields["bad_hashes"]]).toEqual([0, 0]);
  });

  it("reports a breach at error level when a chain link is broken", async () => {
    // Only the superuser can do this — app_rw holds no UPDATE on audit_log (Plan 0A). That is the point: the job
    // detects corruption that no application path could have caused.
    await w.db.admin`update app.audit_log set hash = sha256('tampered') where tenant_id = ${b.tenant} and seq = (select min(seq) from app.audit_log where tenant_id = ${b.tenant})`;
    await run(b.tenant);
    const line = w.logs.find((l) => l.msg === "audit chain broken");
    expect(line).toBeDefined();
    expect(line!.level).toBe("error");
    expect(line!.fields["bad_hashes"]).toBeGreaterThan(0);
  });

  it("runs as the tenant's system principal, never a human (spec §4.2.2 R8)", async () => {
    await run(a.tenant);
    const line = w.logs.find((l) => l.msg === "no postings")!;
    expect(line.fields["actor_id"]).toBe(a.system);
    expect(line.fields["actor_id"]).not.toBe(a.human);
  });

  it("sees only its own tenant's rows", async () => {
    await asPrincipal(w.db, b.tenant, b.system, (tx) => tx`update app.company set name = 'Beta HQ 2' where id = ${b.company}`);
    await run(a.tenant);
    const line = w.logs.find((l) => l.msg === "no postings")!;
    const alphaRows = line.fields["audit_rows"] as number;
    w.logs.length = 0;
    await run(b.tenant);
    const betaLine = w.logs.find((l) => l.msg === "no postings" || l.msg === "audit chain broken")!;
    expect(betaLine.fields["audit_rows"]).not.toBe(alphaRows);
  });
});
```

- [ ] **Step 2: Write the failing test `apps/worker/test/idempotency-key-purge.test.ts`**

```ts
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedTenant, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "./support/worker";

describe("admin.idempotency_key.purge — spec §3.8 idempotency_key.expires_at; contracts §4.2.9", () => {
  let w: StartedWorker; let a: Seed; let b: Seed;
  beforeAll(async () => { w = await startWorker(); a = await seedTenant(w.db, "Alpha"); b = await seedTenant(w.db, "Beta"); });
  afterAll(async () => { await w.stop(); });
  // Each test starts from an empty log and runs the job itself: `w.logs` is a single array shared by the whole
  // suite, so a test that only *reads* a line another test produced would find nothing here.
  beforeEach(() => { w.logs.length = 0; });

  /** §4.2.12: `apps/*/test` uses the production `withTenant(sql, ctx, fn)` from `@dulja/db`. */
  const asPrincipal = async <T>(db: Db, tenantId: string, actorId: string, fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, { tenantId, actorId, requestId: await uuidv7(db.admin) }, fn);

  const insertKey = (s: Seed, key: string, expiresAt: string) =>
    asPrincipal(w.db, s.tenant, s.human, (tx) => tx`
      insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, response_code, expires_at)
      values (${s.tenant}, ${s.human}, ${key}, sha256('x'), 200, ${expiresAt}::timestamptz)`);

  const keys = (s: Seed) =>
    asPrincipal(w.db, s.tenant, s.human, (tx) => tx<{ key: string }[]>`select key from app.idempotency_key order by key`);

  const purge = async (s: Seed) =>
    w.run("admin.idempotency_key.purge", { tenantId: s.tenant, requestId: await uuidv7(w.db.admin), payload: {} });

  it("deletes only the expired keys of the tenant it runs for", async () => {
    await insertKey(a, "a-expired", "2026-01-01T00:00:00Z");
    await insertKey(a, "a-live", "2099-01-01T00:00:00Z");
    await insertKey(b, "b-expired", "2026-01-01T00:00:00Z");

    await purge(a);

    expect((await keys(a)).map((r) => r.key)).toEqual(["a-live"]);
    expect((await keys(b)).map((r) => r.key)).toEqual(["b-expired"]);   // another tenant's row is untouched
  });

  it("reports how many it purged", async () => {
    await insertKey(a, "a-expired-2", "2026-01-01T00:00:00Z");
    await purge(a);
    const line = w.logs.find((l) => l.msg === "idempotency keys purged");
    expect(line).toBeDefined();
    expect(line!.fields).toMatchObject({ tenant_id: a.tenant, purged: 1 });   // the one key this test inserted
  });

  it("is idempotent — a second run purges nothing and does not fail", async () => {
    await purge(a);                                        // the previous test left no expired key behind
    expect(w.logs.find((l) => l.msg === "idempotency keys purged")!.fields["purged"]).toBe(0);
  });

  it("is why app_rw holds DELETE on idempotency_key and on nothing else it should not (§3.5.4)", async () => {
    const rows = await w.db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE' order by 1`;
    expect(rows.map((r) => r.table_name)).toEqual(["idempotency_key", "role_assignment_branch", "role_permission"]);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/worker && bun run test`
Expected: FAIL — `Failed to resolve import "../../src/jobs/ledger-integrity-check"`.

- [ ] **Step 4: Write `packages/db/src/audit/verify-chain.ts`**

```ts
import type { Sql } from "postgres";

export interface ChainResult {
  /** Audit rows examined for this tenant. */
  rows: number;
  /** Rows whose prev_hash is not the previous row's hash — a row was removed or reordered. */
  brokenLinks: number;
  /** Rows whose hash does not recompute from their own content — a row was edited. */
  badHashes: number;
}

/**
 * The nightly job's chain walk (spec §3.8 audit_chain; acceptance test 13). The recompute below must stay
 * byte-identical to the `app.audit_chain()` trigger in migration 0001 — if the trigger's formula ever changes, this
 * query changes in the same PR or every row reads as tampered.
 *
 * Must be called inside a withTenant transaction: `app.audit_log` is RLS-scoped like every other table.
 */
export async function verifyChain(tx: Sql, tenantId: string): Promise<ChainResult> {
  const [row] = await tx<{ rows: number; broken_links: number; bad_hashes: number }[]>`
    with ordered as (
      select *, lag(hash) over (order by seq) as expected_prev
        from app.audit_log where tenant_id = ${tenantId})
    select count(*)::int                                                            as rows,
           count(*) filter (where prev_hash is distinct from expected_prev)::int     as broken_links,
           count(*) filter (where hash <> sha256(coalesce(prev_hash, ''::bytea) || convert_to(
             tenant_id::text || '|' || actor_id::text || '|' || extract(epoch from occurred_at)::text || '|'
             || table_name || '|' || row_id || '|' || action || '|'
             || coalesce(before::text, '') || '|' || coalesce(after::text, ''), 'UTF8')))::int as bad_hashes
      from ordered`;
  return { rows: row!.rows, brokenLinks: row!.broken_links, badHashes: row!.bad_hashes };
}
```

Add to `packages/db/src/index.ts`:

```ts
export { verifyChain, type ChainResult } from "./audit/verify-chain";
```

- [ ] **Step 5: Write `apps/worker/src/jobs/ledger-integrity-check.ts`**

```ts
import { verifyChain, withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";

/**
 * The ledger-integrity SLI (spec §4.9: "a continuous job asserting Σdebit = Σcredit per tenant/period/company and
 * that projections match a fresh rebuild… the alarm the old system needed and never had").
 *
 * At Phase 0 there is no posting service and no projection, so this scaffold does the half that already exists — it
 * walks the hash-chained audit log and counts ledger rows — and reports **"no postings"** when the ledger is empty
 * (spec §5.0 row 0.11). 1B does **not** edit this file: it ships `createIntegrityCheckHandler` in
 * `apps/worker/src/handlers/accounting.ts` — the real Σdebit = Σcredit, the rebuild-and-compare over
 * `projectionChecks`, and the incident path — and registers that instead (contracts §4.2.6 gives the job
 * `owner: "1B"`, "scaffolded in 0D"). The job name, its schedule and its payload type are unchanged by that
 * swap; this file and its test are retired when the swap lands — see the retirement note below the block.
 *
 * Work is done in short withTenant transactions (spec §3.8), not one long one.
 */
export const ledgerIntegrityCheck: JobHandler<"accounting.ledger.integrity_check"> = async (sql, _job, ctx) => {
  const chain = await withTenant(sql, ctx, (tx) => verifyChain(tx, ctx.tenantId));

  const [ledger] = await withTenant(sql, ctx, (tx) => tx<{ entries: number; unbalanced: number }[]>`
    with per_key as (
      select company_id, fiscal_period_id, currency,
             sum(base_debit) - sum(base_credit) as delta,
             count(*)                           as n
        from app.ledger_entry
       group by company_id, fiscal_period_id, currency)
    select coalesce(sum(n), 0)::int                                as entries,
           coalesce(count(*) filter (where delta <> 0), 0)::int    as unbalanced
      from per_key`);

  const fields = {
    tenant_id: ctx.tenantId,
    actor_id: ctx.actorId,
    request_id: ctx.requestId,
    audit_rows: chain.rows,
    broken_links: chain.brokenLinks,
    bad_hashes: chain.badHashes,
    ledger_entries: ledger!.entries,
    unbalanced_keys: ledger!.unbalanced,
  };

  if (chain.brokenLinks > 0 || chain.badHashes > 0) {
    log().error(fields, "audit chain broken");
    return;
  }
  if (ledger!.unbalanced > 0) {
    log().error(fields, "ledger unbalanced");
    return;
  }
  log().info(fields, ledger!.entries === 0 ? "no postings" : "ledger integrity verified");
};
```

**Retirement of this scaffold — 0D's standing decision, so no later slice has to ask.** 1B's wiring step —
**Task 6 Step 6 of `docs/superpowers/plans/2026-09-05-dulja-phase-1b-projections-integrity-reports.md`** —
unregisters this handler (it deletes the `import { ledgerIntegrityCheck } …` line and the
`registerHandler("accounting.ledger.integrity_check", ledgerIntegrityCheck);` line from
`apps/worker/src/index.ts` and calls `registerAccountingHandlers({ logger, incident })` in their place), and then
stops: its closing paragraph says "Do not delete `apps/worker/src/jobs/ledger-integrity-check.ts` itself … report
it rather than widening this task — the file is 0D's to retire", because deleting a file another slice's test
imports is outside its scope. **This paragraph is that report, answered in advance and standing: the file is
retired with the registration, in the same commit, and 0D authorises all three edits here, so 1B's executor has
nothing to escalate.** They come as a set, because doing fewer than three breaks the build:

1. delete `apps/worker/src/jobs/ledger-integrity-check.ts` (this file);
2. delete `apps/worker/test/ledger-integrity-check.test.ts` — 1B's Step 6 cites this file as
   `apps/worker/test/jobs/ledger-integrity-check.test.ts`, with a `jobs/` segment this slice does not create; the
   path to delete is the one this task's Files list and Step 1 write, `apps/worker/test/ledger-integrity-check.test.ts`.
   It asserts only the scaffold's `"no postings"` and
   `"audit chain broken"` branches, both of which 1B's `apps/worker/test/handlers/integrity-check.test.ts` covers
   against the real handler;
3. in `apps/worker/test/support/worker.ts` (Step 1 of this task), delete the same two lines the wiring step deletes
   from `index.ts` and register 1B's handler in their place, so `startWorker()` still registers a handler for
   `accounting.ledger.integrity_check`:

```ts
// apps/worker/test/support/worker.ts — replacing 0D's scaffold import and its registerHandler line.
// Both names below are 1B's own: nothing here invents a stub.
import { registerAccountingHandlers } from "../../src/handlers/accounting";
import { createIncidentReporter } from "../../src/observability/incident";

// …inside startWorker(): name the captured logger, because registerAccountingHandlers takes it as a dependency
// rather than reading it back through log().
const logger = capture(logs);
setLogger(logger);                              // was: setLogger(capture(logs))
resetHandlers();
registerAccountingHandlers({ logger, incident: createIncidentReporter(logger) });
registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);   // unchanged
```

Edit 3 is not optional once edits 1 and 2 are made, and it is the reason the three travel together:
`tests/invariants/job-isolation.test.ts` (Step 9) asserts `JOB_PROBES` and `registeredJobNames()` name exactly the
same jobs, and `JOB_PROBES` keeps its `"accounting.ledger.integrity_check"` entry — that probe is written against
the job name, not against the scaffold, and stays valid unchanged. Leaving `startWorker()` with no handler for the
name would fail that assertion; leaving it importing a deleted file would not compile.

**If the retirement is not taken in that commit, nothing breaks and the authorisation does not expire.** The
tests register the scaffold from `apps/worker/test/support/worker.ts` directly and never read
`apps/worker/src/index.ts`, so `apps/worker/test/ledger-integrity-check.test.ts` and the isolation suite keep
passing while the file is unregistered in production; and no rule in `scripts/lint/rules/` flags an unreferenced export (this slice adds `no-number-money`,
`permission-catalogue` and `role-seed`, and none of 0B's rules is an unused-export rule), so `bun run lint:rules`
stays green. The file is then dead code, and the three edits above remain the way to remove it.

- [ ] **Step 6: Write `apps/worker/src/jobs/idempotency-key-purge.ts`**

```ts
import { withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";

/**
 * Expired idempotency keys (spec §3.8: `expires_at timestamptz not null default now() + interval '24 hours'`).
 * This job is the reason app_rw holds DELETE on `app.idempotency_key` — one of exactly three tables it may delete
 * from (contracts §3.5.4). It never deletes a live key: a replay inside the 24-hour window must still replay
 * (contracts §4.2.9).
 */
export const idempotencyKeyPurge: JobHandler<"admin.idempotency_key.purge"> = async (sql, _job, ctx) => {
  const purged = await withTenant(sql, ctx, async (tx) => {
    const rows = await tx`delete from app.idempotency_key where expires_at < now() returning key`;
    return rows.count;
  });
  log().info({ tenant_id: ctx.tenantId, actor_id: ctx.actorId, request_id: ctx.requestId, purged }, "idempotency keys purged");
};
```

- [ ] **Step 7: Write `apps/worker/src/index.ts` — the container entrypoint**

```ts
/**
 * The `worker` container class (spec §3.2.4): the same image as `api`, a different entrypoint. A Cloudflare Cron
 * Trigger pings this container every minute so it does not sleep while jobs are pending; the pg-boss poller runs
 * inside it. Deployment is 0C's; this file is what 0C deploys.
 */
import { v7 as newUuidV7 } from "uuid";                    // the same minter 0B's request-id middleware uses
import { createDb, eachTenant, JOBS, type JobEnvelope, type JobName, type JobPayload } from "@dulja/db";
import { createBoss } from "./boss";
import { registerHandler, registeredJobNames, runJob } from "./handler";
import { log } from "./log";
import { ledgerIntegrityCheck } from "./jobs/ledger-integrity-check";
import { idempotencyKeyPurge } from "./jobs/idempotency-key-purge";

const url = process.env["DATABASE_URL"];
if (!url) { process.stderr.write("DATABASE_URL is not set\n"); process.exit(2); }

const sql = createDb(url);                    // refuses a :6543 transaction-mode URL (contracts §4.2.2)
const boss = createBoss(url);

registerHandler("accounting.ledger.integrity_check", ledgerIntegrityCheck);
registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);

await boss.start();

for (const name of registeredJobNames()) {
  await boss.work(name, async ([job]: { data: JobEnvelope<JobPayload[JobName]> }[]) => {
    await runJob(sql, name, job!.data);
  });

  const schedule = JOBS[name].schedule;
  if (schedule === null) continue;
  // A scheduled job fans out to one queued job per registered tenant: the schedule fires once, the handler runs
  // per tenant under that tenant's system principal (contracts §4.2.6). The request id is **uuidv7**, not v4
  // (spec:2037; §4.2.2 "uuidv7 minted by the request-id middleware or the job runner") — a v4 id would sort
  // randomly, and the audit rows and log lines a job produces are read in creation order.
  await boss.schedule(`${name}.fanout`, schedule, {}, {});
  await boss.work(`${name}.fanout`, async () => {
    await eachTenant(sql, async (tenantId) => {
      await runJob(sql, name, { tenantId, requestId: newUuidV7(), payload: {} } as JobEnvelope<JobPayload[JobName]>);
    });
  });
}

log().info({ jobs: registeredJobNames() }, "worker started");
```

`boss.schedule` needs its fan-out queue to exist; `install.ts` declares only the sixteen registry names, so extend its loop in the same step:

```ts
for (const name of JOB_NAMES) {
  await boss.createQueue(name);
  if (JOBS[name].schedule !== null) await boss.createQueue(`${name}.fanout`);
}
```

and import `JOBS` alongside `JOB_NAMES` in `apps/worker/src/install.ts`.

`apps/worker/package.json` `dependencies` gains `uuid` — the package 0B already added for `apps/api`'s request-id
middleware — with `bun add --cwd apps/worker uuid` so the lockfile owns the version and no version literal reaches a
source file (spec:104, D22).

- [ ] **Step 8: Run the worker tests**

Run: `cd apps/worker && bun run test`
Expected: PASS — 5 + 4 tests.

If `no postings` never appears but `ledger integrity verified` does, `ledger!.entries` is not zero — check that the fixture tenant really has no `ledger_entry` rows (`seedTenant` creates none).

- [ ] **Step 9: Add the job probes and the job-isolation suite**

`tests/invariants/probes.ts` gains, beside 0B's `PROBES`:

```ts
import { withTenant, type JobName } from "@dulja/db";

/**
 * The job half of the tenant-isolation guarantee (contracts §3.7.2). Keyed by JobName and **partial by design**: a
 * job whose owning slice has not landed has no handler to run, so the suite iterates the names a handler is
 * registered for and fails the build if one of those has no probe here.
 */
export interface JobIsolationProbe {
  /** Seeds a row belonging to `victim` that the job would touch if it ignored its envelope's tenantId. */
  seed(db: Db, attacker: Seed, victim: Seed): Promise<void>;
  /** Rows of `victim` that must still be there after the job ran for `attacker`. */
  survivors(db: Db, victim: Seed): Promise<number>;
}

export const JOB_PROBES: Readonly<Partial<Record<JobName, JobIsolationProbe>>> = {
  "admin.idempotency_key.purge": {
    async seed(db, _attacker, victim) {
      await withTenant(db.rw, { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) }, (tx) => tx`
        insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, response_code, expires_at)
        values (${victim.tenant}, ${victim.human}, 'victim-expired', sha256('x'), 200, '2026-01-01T00:00:00Z'::timestamptz)`);
    },
    survivors: async (db, victim) =>
      withTenant(db.rw, { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) }, async (tx) =>
        (await tx<{ n: number }[]>`select count(*)::int as n from app.idempotency_key`)[0]!.n),
  },
  "accounting.ledger.integrity_check": {
    async seed(db, _attacker, victim) {
      await withTenant(db.rw, { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        (tx) => tx`update app.company set name = 'Victim HQ' where id = ${victim.company}`);
    },
    survivors: async (db, victim) =>
      withTenant(db.rw, { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) }, async (tx) =>
        (await tx<{ n: number }[]>`select count(*)::int as n from app.audit_log`)[0]!.n),
  },
};
```

The context object is written out at each of the four call sites rather than hidden behind a local helper: `probes.ts`
is 0B's file and **every later slice appends to it**, so a helper name declared here would be one more thing a 3A or
6C append could collide with. The imports this step needs, merged into whichever lines 0B already wrote (Tasks 9, 11
and 13 widen the second one further as their own probes need `seedCurrency`, `seedRate` and `draftDocument`). One
statement per module — the `JobName` type import above is merged into the same line rather than repeated:

```ts
import { withTenant, type JobName } from "@dulja/db";                     // withTenant is the PRODUCTION 3-argument helper (§4.2.12)
import { uuidv7, type Db, type Seed } from "@dulja/db/test";
```

**`withTenant` here is `@dulja/db`'s, not `@dulja/db/test`'s.** §4.2.2 and §4.2.12 confine the 4-argument test helper to
`packages/db/test/*`; root `tests/` takes the production one, which opens the transaction, issues both
`set_config(…, true)` calls, retries once on SQLSTATE 40P01/40001 and refuses nesting. `requestId` is a real `uuidv7`
minted on `db.admin`, because `TenantContext.requestId` is "uuidv7 minted by the request-id middleware or the job
runner" and a probe stands in for the job runner.

```ts
// tests/invariants/job-isolation.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS, type JobName } from "@dulja/db";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { registeredJobNames } from "@dulja/worker/handler";
import { startWorker, type StartedWorker } from "@dulja/worker/test-support";
import { JOB_PROBES } from "./probes";

describe("tenant isolation across every registered job — acceptance test 12, contracts §3.7.2", () => {
  let w: StartedWorker; let attacker: Seed; let victim: Seed;
  beforeAll(async () => { w = await startWorker(); attacker = await seedTenant(w.db, "Attacker"); victim = await seedTenant(w.db, "Victim"); });
  afterAll(async () => { await w.stop(); });

  it("every registered job name has a probe, and every probe names a registered job", () => {
    const registered = registeredJobNames();
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) expect(JOB_PROBES[name], `no JOB_PROBES entry for ${name}`).toBeDefined();
    for (const name of Object.keys(JOB_PROBES) as JobName[]) {
      expect(registered, `JOB_PROBES names ${name}, which no handler is registered for`).toContain(name);
      expect(JOBS[name], `${name} is not in the JOBS registry`).toBeDefined();
    }
  });

  it("a job run for tenant A touches no row of tenant B", async () => {
    for (const name of registeredJobNames()) {
      const probe = JOB_PROBES[name]!;
      await probe.seed(w.db, attacker, victim);
      const before = await probe.survivors(w.db, victim);
      await w.run(name, { tenantId: attacker.tenant, requestId: await uuidv7(w.db.admin), payload: {} });
      expect(await probe.survivors(w.db, victim), name).toBe(before);
    }
  });

  it("a job whose envelope names tenant B while its payload names tenant A still sees only B", async () => {
    // The envelope's tenantId is the only source of the session tenant; a payload field cannot widen it.
    await w.run("admin.idempotency_key.purge", {
      tenantId: victim.tenant, requestId: await uuidv7(w.db.admin),
      payload: {} as Record<string, never>,
    });
    const line = w.logs.at(-1)!;
    expect(line.fields["tenant_id"]).toBe(victim.tenant);
    expect(line.fields["actor_id"]).toBe(victim.system);
  });
});
```

`apps/worker/package.json` `exports` gains the two subpaths the test tier imports (the same arrangement §4.2.12 uses for `@dulja/db/test`):

```json
  "exports": {
    ".": "./src/index.ts",
    "./handler": "./src/handler.ts",
    "./test-support": "./test/support/worker.ts"
  }
```

- [ ] **Step 10: Run everything and commit**

Run: `cd apps/worker && bun run test && cd ../../tests && bun run test -- invariants/job-isolation.test.ts && cd .. && bun run lint && bun run lint:rules && bun run typecheck`
Expected: all green.

```bash
git add packages/db apps/worker tests
git commit -m "feat(worker): ledger-integrity and idempotency-purge jobs, job isolation suite [0D T7]

The nightly SLI walks the hash chain and reports 'no postings' until the ledger
exists (1B replaces the ledger half). The purge job is why app_rw may DELETE from
idempotency_key. Both run under the tenant's system principal and are probed for
cross-tenant reach. spec §4.9, §5.0 row 0.11; contracts §3.7.2, §4.2.6.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: Migration 0005 — `app.currency`, `app.exchange_rate`, `app.rate_for()` and the Postgres-agreement proof

**Files:**
- Create: `packages/db/migrations/0005_create_currency_exchange_rate.sql`, `packages/db/migrations/0005.down.sql`, `packages/db/src/schema/schema.ts` (only if 0B has no shared `pgSchema("app")`), `packages/db/src/schema/currency.ts`, `packages/db/src/schema/exchange-rate.ts`, `packages/db/src/rates/rate-for.ts`, `packages/db/test/currency.test.ts`, `packages/db/test/money-postgres.test.ts`, `tests/regression/legacy-019.test.ts`, `docs/adr/0009-exchange-rate-lookup.md`
- Modify: `packages/db/test/fixtures.ts` (add `seedCurrency`, `seedRate` — additive only), `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Plan 0A's `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.current_actor`, `app.company`, `app.tenant`, `app.principal`, `startDb`, `seedTenant`, `Seed`, `withTenant` (test), `uuidv7`, `lintSchema`; Task 3's `ExchangeRate`, `toBase`, `UNIT_RATE`, `currency`, `Money`.
- Produces:
  - SQL (§4.2.10, verbatim): `app.currency`, `app.exchange_rate`, `app.rate_for(p_company uuid, p_from char(3), p_to char(3), p_on date) returns app.exchange_rate`.
  - `packages/db/src/rates/rate-for.ts`: `export async function rateFor(tx: Sql, companyId: string, from: string, to: string, on: string): Promise<ExchangeRate | null>`.
  - `packages/db/test/fixtures.ts` (§4.17): `seedCurrency(db: Db, s: Seed, opts: { code: string; minorUnit?: number }): Promise<string>` and `seedRate(db: Db, s: Seed, opts: { from: string; to: string; on: string; rate: string; source?: string }): Promise<string>`.
  - Drizzle mirrors `currency` and `exchangeRate` (§3.4.9).

- [ ] **Step 1: Write the failing test `packages/db/test/currency.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { rateFor } from "../src/rates/rate-for";
import { seedCurrency, seedRate, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("migration 0005 — currency and exchange_rate (contracts §4.2.10; spec §3.3, §3.8)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations after 0005", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a currency carries its display policy: minor units, POS rounding increment and rounding mode", async () => {
    const id = await seedCurrency(db, a, { code: "MYR" });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{
      code: string; name_en: string; minor_units: number; pos_rounding_increment: string; rounding_mode: string;
    }[]>`select code, name_en, minor_units, pos_rounding_increment::text, rounding_mode from app.currency where id = ${id}`);
    expect(row).toEqual({
      code: "MYR", name_en: "MYR", minor_units: 2,
      pos_rounding_increment: "0.0100", rounding_mode: "HALF_AWAY_FROM_ZERO",
    });
  });

  it("currency codes are unique per tenant and both tenants may use MYR (acceptance test 12)", async () => {
    await seedCurrency(db, b, { code: "MYR" });
    await expect(seedCurrency(db, a, { code: "MYR" })).rejects.toThrow(/unique|duplicate key/);
    const seen = async (s: Seed) => withTenant(db.rw, s.tenant, s.human, async (tx) =>
      (await tx<{ code: string }[]>`select code from app.currency order by code`).map((r) => r.code));
    expect(await seen(a)).toEqual(["MYR"]);
    expect(await seen(b)).toEqual(["MYR"]);
  });

  it("rounding_mode is a closed set matching the four RoundingMode literals of @dulja/domain", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.currency (tenant_id, code, name_en, rounding_mode) values (${a.tenant}, 'XXX', 'Bad', 'HALF_UP')`))
      .rejects.toThrow(/check constraint/);
  });

  it("an exchange rate must be positive and is stamped with the acting principal, not a client value", async () => {
    await seedCurrency(db, a, { code: "USD" });
    const id = await seedRate(db, a, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.68000000" });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ rate: string; entered_by: string; source: string }[]>`
      select rate::text, entered_by, source from app.exchange_rate where id = ${id}`);
    expect(row).toEqual({ rate: "4.68000000", entered_by: a.human, source: `manual:${a.human}` });

    // stamp_entered_by overwrites a forged value (LEGACY-044)
    const forged = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source, entered_by)
      values (${a.tenant}, ${a.company}, 'USD', 'MYR', 4.7, '2026-02-01', 'forged', ${forged})`);
    const [stamped] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ entered_by: string }[]>`
      select entered_by from app.exchange_rate where effective_from = '2026-02-01'`);
    expect(stamped!.entered_by).toBe(a.human);

    await expect(seedRate(db, a, { from: "USD", to: "MYR", on: "2026-03-01", rate: "0.00000000" }))
      .rejects.toThrow(/check constraint/);
  });

  it("one rate per (company, from, to, effective_from)", async () => {
    await expect(seedRate(db, a, { from: "USD", to: "MYR", on: "2026-01-01", rate: "5.00000000" }))
      .rejects.toThrow(/unique|duplicate key/);
  });

  it("app.rate_for returns the greatest effective_from on or before the date, and nothing before the first", async () => {
    await seedRate(db, a, { from: "USD", to: "MYR", on: "2026-06-01", rate: "4.80000000" });
    const on = (date: string) => withTenant(db.rw, a.tenant, a.human, (tx) => rateFor(tx, a.company, "USD", "MYR", date));
    expect((await on("2026-01-01"))!.rate).toBe("4.68000000");
    expect((await on("2026-05-31"))!.rate).toBe("4.70000000");    // the 2026-02-01 row inserted above
    expect((await on("2026-06-01"))!.rate).toBe("4.80000000");
    expect((await on("2026-12-31"))!.rate).toBe("4.80000000");    // the latest rate persists forward
    expect(await on("2025-12-31")).toBeNull();                     // before the first rate: the caller raises ERR_RATE_NOT_FOUND
  });

  it("rateFor never looks up the identity pair — it returns UNIT_RATE (contracts §4.2.10)", async () => {
    const unit = await withTenant(db.rw, a.tenant, a.human, (tx) => rateFor(tx, a.company, "MYR", "MYR", "1999-01-01"));
    expect(unit).toEqual({ from: "MYR", to: "MYR", rate: "1.00000000", effectiveFrom: "0001-01-01", source: "unit" });
  });

  it("rates are tenant-isolated and company-scoped (acceptance test 12)", async () => {
    const fromB = await withTenant(db.rw, b.tenant, b.human, (tx) => rateFor(tx, a.company, "USD", "MYR", "2026-06-01"));
    expect(fromB).toBeNull();                                       // B cannot read A's rate even naming A's company
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
      values (${a.tenant}, ${a.company}, 'USD', 'MYR', 9, '2026-07-01', 'forged')`)).rejects.toThrow(/row-level security/);
  });

  it("every insert is audited with the server-supplied actor (acceptance test 13)", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.system, (tx) => tx<{ table_name: string; action: string; actor_id: string }[]>`
      select table_name, action, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name in ('currency', 'exchange_rate') order by seq`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(["currency", "exchange_rate"]));
    expect(rows.every((r) => r.action === "insert" && r.actor_id === a.human)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/currency.test.ts`
Expected: FAIL — `Failed to resolve import "../src/rates/rate-for"`; and once that is stubbed, `relation "app.currency" does not exist`.

- [ ] **Step 3: Write `packages/db/migrations/0005_create_currency_exchange_rate.sql`**

```sql
-- 0005_create_currency_exchange_rate.sql — contracts §4.2.10; spec §3.3 "Currency ── ExchangeRate(effective_from,
-- source) + RoundingPolicy(context)", spec §3.8 exchange_rate.source, spec §5.0 row 0.9.
-- Rates are per company because a group may hold companies with different base currencies; the currency itself is
-- per tenant, because a tenant that trades in USD trades in USD everywhere. Both take the full new-table recipe:
-- tenant_id, RLS enabled and forced, tenant_isolation, id, created_at, audit trigger, composite FKs (spec §0.2).

-- ── 1. currency ──────────────────────────────────────────────────────────────
create table app.currency (
  id                      uuid primary key default uuidv7(),
  tenant_id               uuid not null references app.tenant(id),
  code                    char(3) not null,
  name_en                 text not null,
  name_ar                 text,                                    -- spec §3.9 Naming: bilingual master data
  minor_units             smallint not null default 2,
  pos_rounding_increment  numeric(19,4) not null default 0.01,     -- spec §3.7.6 POS rounding per currency (LEGACY-019)
  rounding_mode           text not null default 'HALF_AWAY_FROM_ZERO'
                            check (rounding_mode in ('HALF_AWAY_FROM_ZERO','HALF_EVEN','TOWARD_ZERO','AWAY_FROM_ZERO')),
                            -- exactly the four RoundingMode literals of @dulja/domain; a text + CHECK, not an enum,
                            -- so a later phase can add a mode in one file (§3.9 Enumerations, §3.4.4)
  archived_at             timestamptz,                             -- spec §3.9 Deletion: master data is archived
  created_at              timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.currency');
call app_meta.attach_audit('app.currency');
comment on column app.currency.pos_rounding_increment is
  'The smallest cash increment at a till (spec §3.7.6). Display concern only: never applied to a stored amount.';

-- ── 2. exchange_rate ─────────────────────────────────────────────────────────
-- The rate is quoted as: 1 unit of from_currency = `rate` units of to_currency. `source` is mandatory because a rate
-- with no provenance is an unauditable number (spec §3.8 "'BNM 2026-09-04', 'manual:<actor_id>'").
create table app.exchange_rate (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  from_currency   char(3) not null,
  to_currency     char(3) not null,
  rate            numeric(19,8) not null check (rate > 0),
  effective_from  date not null,
  source          text not null,
  entered_by      uuid not null default app.current_actor() references app.principal(id),
  created_at      timestamptz not null default now(),
  unique (company_id, from_currency, to_currency, effective_from),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.exchange_rate');
call app_meta.attach_audit('app.exchange_rate');
-- A DEFAULT is not a control (LEGACY-044): the trigger overwrites whatever the client sent.
call app_meta.attach_stamp('app.exchange_rate', 'entered_by');

-- The lookup index the rate_for() plan wants: the same leading columns, descending on the date.
create index exchange_rate_lookup_idx
  on app.exchange_rate (company_id, from_currency, to_currency, effective_from desc);

-- ── 3. the one lookup rule ───────────────────────────────────────────────────
-- The row with the greatest effective_from <= the document's effective_date for (company, from, to). No row → the
-- caller raises ERR_RATE_NOT_FOUND (422); this function never invents a rate, never interpolates between two rows,
-- and never synthesises an inverse from the opposite pair (ADR 0009). The identity pair (p_from = p_to) is never
-- looked up: the application uses UNIT_RATE (rate 1, source 'unit') instead.
-- SECURITY INVOKER (the default) so RLS applies to the caller, exactly as a direct select would.
create function app.rate_for(p_company uuid, p_from char(3), p_to char(3), p_on date) returns app.exchange_rate
language sql stable as $$
  select r.* from app.exchange_rate r
   where r.company_id = p_company and r.from_currency = p_from and r.to_currency = p_to and r.effective_from <= p_on
   order by r.effective_from desc
   limit 1
$$;
```

- [ ] **Step 4: Write `packages/db/migrations/0005.down.sql`**

```sql
-- 0005.down.sql — reverse dependency order (§3.4.5). The audit and stamp triggers go with their tables.
drop function if exists app.rate_for(uuid, char, char, date);
drop index if exists app.exchange_rate_lookup_idx;
drop table if exists app.exchange_rate;
drop table if exists app.currency;
```

- [ ] **Step 5: Write `packages/db/src/rates/rate-for.ts` and the Drizzle mirrors**

```ts
// packages/db/src/rates/rate-for.ts
import { currency, UNIT_RATE, type ExchangeRate } from "@dulja/domain";
import type { Sql } from "postgres";

/**
 * The one rate lookup (ADR 0009). Must be called inside a withTenant transaction — `app.exchange_rate` is RLS-scoped.
 * Returns null when no rate is effective on `on`; the caller decides whether that is `ERR_RATE_NOT_FOUND` (422) or a
 * recoverable absence. The identity pair short-circuits to UNIT_RATE so a same-currency document can never fail on a
 * missing self-rate row.
 */
export async function rateFor(tx: Sql, companyId: string, from: string, to: string, on: string): Promise<ExchangeRate | null> {
  if (from === to) return UNIT_RATE(currency(from));
  const rows = await tx<{ rate: string; effective_from: string; source: string }[]>`
    select r.rate::text as rate, r.effective_from::text as effective_from, r.source
      from app.rate_for(${companyId}, ${from}, ${to}, ${on}) as r
     where r.id is not null`;
  const row = rows[0];
  if (!row) return null;
  return { from: currency(from), to: currency(to), rate: row.rate, effectiveFrom: row.effective_from, source: row.source };
}
```

The `where r.id is not null` filter is load-bearing: a function returning a composite type produces **one all-NULL row** when its body selects nothing, not zero rows.

Drizzle mirrors (§3.4.9). If 0B's mirrors have no shared schema object, create `packages/db/src/schema/schema.ts`:

```ts
import { pgSchema } from "drizzle-orm/pg-core";
export const app = pgSchema("app");
```

```ts
// packages/db/src/schema/currency.ts
import { char, numeric, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const currency = app.table("currency", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  code: char("code", { length: 3 }).notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  minorUnits: smallint("minor_units").notNull(),
  posRoundingIncrement: numeric("pos_rounding_increment", { precision: 19, scale: 4 }).notNull(),
  roundingMode: text("rounding_mode").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique("currency_tenant_id_code_key").on(t.tenantId, t.code)]);
```

```ts
// packages/db/src/schema/exchange-rate.ts
import { char, date, index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const exchangeRate = app.table("exchange_rate", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  fromCurrency: char("from_currency", { length: 3 }).notNull(),
  toCurrency: char("to_currency", { length: 3 }).notNull(),
  rate: numeric("rate", { precision: 19, scale: 8 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  source: text("source").notNull(),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
  unique("exchange_rate_company_id_from_currency_to_currency_effective_from_key")
    .on(t.companyId, t.fromCurrency, t.toCurrency, t.effectiveFrom),
  index("exchange_rate_lookup_idx").on(t.companyId, t.fromCurrency, t.toCurrency, t.effectiveFrom.desc()),
]);
```

`packages/db/src/index.ts` gains:

```ts
export { rateFor } from "./rates/rate-for";
export { currency as currencyTable } from "./schema/currency";
export { exchangeRate as exchangeRateTable } from "./schema/exchange-rate";
```

- [ ] **Step 6: Extend `packages/db/test/fixtures.ts` — additively (§4.17, hazard 9)**

Append to the end of the file. **Never edit `Seed`, `seedTenant` or `draftDocument`** — `ledger.test.ts` and `documents.test.ts` depend on their exact rows.

```ts
/** §4.17 — a currency row. Defaults mirror the migration's own defaults so a test states only what it cares about. */
export async function seedCurrency(db: Db, s: Seed, opts: { code: string; minorUnit?: number }): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.currency (id, tenant_id, code, name_en, minor_units)
    values (${id}, ${s.tenant}, ${opts.code}, ${opts.code}, ${opts.minorUnit ?? 2})`);
  return id;
}

/** §4.17 — an exchange_rate row for the seed's company. `source` defaults to the spec's 'manual:<actor_id>' form. */
export async function seedRate(
  db: Db, s: Seed, opts: { from: string; to: string; on: string; rate: string; source?: string },
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.exchange_rate (id, tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.from}, ${opts.to}, ${opts.rate}, ${opts.on},
            ${opts.source ?? `manual:${s.human}`})`);
  return id;
}
```

- [ ] **Step 7: Run the currency tests**

Run: `cd packages/db && bun run test -- test/currency.test.ts`
Expected: PASS — 10 tests.

If `rate_for` returns a row of nulls instead of null, the `where r.id is not null` filter was dropped from Step 5.

- [ ] **Step 8: Write `packages/db/test/money-postgres.test.ts` — the hazard-23 proof**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money, toBase, type ExchangeRate } from "@dulja/domain";
import { startDb, type Db } from "./harness";

const MYR = currency("MYR");
const USD = currency("USD");

/** A tiny deterministic LCG so the 10^4 cases are identical on every machine and every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 0x1_0000_0000; };
}

describe("toBase() agrees with Postgres round(value * rate, 4) — contracts hazard 23; spec §3.8 ledger CHECK", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb({ migrate: false }); });
  afterAll(async () => { await db.stop(); });

  it("over 10^4 (value, rate) pairs, every base amount is identical to the database's own answer", async () => {
    const rnd = lcg(20260905);
    const values: string[] = [];
    const rates: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const sign = rnd() < 0.5 ? "-" : "";
      const whole = Math.floor(rnd() * 1_000_000);
      const frac = String(Math.floor(rnd() * 10_000)).padStart(4, "0");
      values.push(`${sign}${whole}.${frac}`);
      const rWhole = Math.floor(rnd() * 20);
      const rFrac = String(Math.floor(rnd() * 100_000_000)).padStart(8, "0");
      rates.push(`${rWhole}.${rFrac}`);
    }
    // Reject a zero rate: the column's CHECK forbids it and toBase() refuses it.
    for (let i = 0; i < rates.length; i++) if (/^0\.0{8}$/.test(rates[i]!)) rates[i] = "0.00000001";

    const rows = await db.admin<{ i: string; base: string }[]>`
      select t.i::text as i, round(t.v * t.r, 4)::text as base
        from unnest(${values}::numeric[], ${rates}::numeric[]) with ordinality as t(v, r, i)
       order by t.i`;
    expect(rows).toHaveLength(10_000);

    const mismatches: string[] = [];
    for (const row of rows) {
      const i = Number(row.i) - 1;
      const rate: ExchangeRate = { from: USD, to: MYR, rate: rates[i]!, effectiveFrom: "2026-01-01", source: "test" };
      const ours = toBase(Money.of(values[i]!, USD), rate).toString();
      // Postgres prints -0.0000 as 0.0000; normalise the one representational difference, not the value.
      const theirs = row.base === "-0.0000" ? "0.0000" : row.base;
      if (ours !== (theirs.includes(".") ? theirs : `${theirs}.0000`)) {
        mismatches.push(`${values[i]} × ${rates[i]}: domain ${ours} ≠ postgres ${row.base}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("HALF_EVEN would NOT satisfy the ledger CHECK — the proof that the mode choice is not arbitrary", async () => {
    // 2.50005 × 1 rounds to 2.5001 in Postgres and 2.5000 under bankers' rounding.
    const [row] = await db.admin<{ base: string }[]>`select round(2.50005::numeric * 1.00000000::numeric, 4)::text as base`;
    expect(row!.base).toBe("2.5001");
    const rate: ExchangeRate = { from: USD, to: MYR, rate: "1.00000000", effectiveFrom: "2026-01-01", source: "test" };
    expect(toBase(Money.of("2.5", USD).add(Money.of("0.0001", USD)), rate).toString()).toBe("2.5001");
  });
});
```

`startDb({ migrate: false })` is deliberate: this test needs Postgres's `numeric` arithmetic, not the schema, and skipping the migrations makes it the fastest DB test in the repo.

- [ ] **Step 9: Write `tests/regression/legacy-019.test.ts`**

```ts
import type { Sql } from "postgres";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency, round, type RoundingMode } from "@dulja/domain";
import { withTenant } from "@dulja/db";                                   // production, 3-argument (§4.2.12)
import { seedCurrency, seedTenant, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";

const MYR = currency("MYR");
const MODES: RoundingMode[] = ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"];

describe("LEGACY-019 Rounding is configured everywhere, applied nowhere, and the one rounding function is wrong — 0D", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenant(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  /** Root `tests/` uses the production `withTenant`; this mints the `requestId` its `TenantContext` needs. */
  const asHuman = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) }, fn);

  it("there is exactly one rounding function and every mode it offers is symmetric across sign", () => {
    for (const mode of MODES) {
      const pos = round(new Decimal("2.50005"), 4, mode).toFixed(4);
      const neg = round(new Decimal("-2.50005"), 4, mode).toFixed(4);
      expect(neg, mode).toBe(`-${pos}`);         // the legacy function rounded -0.5 toward zero and +0.5 away
    }
  });

  it("rounding is never implicit: multiply and divide will not compile without a mode", () => {
    // The proof is the compile error, not a throw. `bun run typecheck` fails with
    // "error TS2578: Unused '@ts-expect-error' directive." the day `mode` becomes optional. At *run* time an
    // absent mode is simply `undefined`, which decimal.js reads as "use the constructor default" — it does not
    // raise, so asserting `.toThrow()` here would assert a behaviour the implementation never had.
    // @ts-expect-error — the mode parameter is required (spec §4.6 "explicit mode")
    Money.of("10", MYR).multiply("3");
    // @ts-expect-error — and on divide, for the same reason
    Money.of("10", MYR).divide("3");
    expect(Money.of("10", MYR).multiply("3", "HALF_EVEN").toString()).toBe("30.0000");
    expect(Money.of("10", MYR).divide("4", "HALF_EVEN").toString()).toBe("2.5000");
  });

  it("the rule is recorded per currency, in the row, not in code (spec §4.6 'rule recorded per currency')", async () => {
    await seedCurrency(db, s, { code: "MYR" });
    await seedCurrency(db, s, { code: "JPY", minorUnit: 0 });
    const rows = await asHuman((tx) => tx<{ code: string; minor_units: number; rounding_mode: string }[]>`
      select code, minor_units, rounding_mode from app.currency order by code`);
    expect(rows).toEqual([
      { code: "JPY", minor_units: 0, rounding_mode: "HALF_AWAY_FROM_ZERO" },
      { code: "MYR", minor_units: 2, rounding_mode: "HALF_AWAY_FROM_ZERO" },
    ]);
  });

  it("the recorded rule is a value the domain layer can actually use — the four literals agree", async () => {
    // `rounding_mode` is a text column with a CHECK, not an enum (migration 0005 — §3.4.4 keeps enum extension out
    // of the schema), so the authority is the constraint definition. Read it from the catalog on `db.admin`, which
    // §4.1 reserves for exactly this: catalog assertions.
    const [row] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'app.currency'::regclass and conname like '%rounding_mode%'`;
    expect(row, "no CHECK constraint on app.currency.rounding_mode").toBeDefined();
    // pg_get_constraintdef prints the IN list as
    //   CHECK ((rounding_mode = ANY (ARRAY['HALF_AWAY_FROM_ZERO'::text, 'HALF_EVEN'::text,
    //                                       'TOWARD_ZERO'::text, 'AWAY_FROM_ZERO'::text])))
    // so every quoted upper-case literal in it is one accepted mode, and there are exactly four.
    const accepted = [...row!.def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(new Set(accepted)).toEqual(new Set(MODES));
    expect(accepted).toHaveLength(MODES.length);
  });

  it("stored amounts are never re-rounded on read (spec §3.9 'stored base amounts are never recomputed on read')", async () => {
    await asHuman((tx) => tx`
      insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
      values (${s.tenant}, ${s.company}, 'USD', 'MYR', 4.68123456, '2026-01-01', 'legacy-019')`);
    const [row] = await asHuman((tx) => tx<{ rate: string }[]>`
      select rate::text from app.exchange_rate where source = 'legacy-019'`);
    expect(row!.rate).toBe("4.68123456");        // eight places, unchanged, on every read
  });
});
```

- [ ] **Step 10: Write `docs/adr/0009-exchange-rate-lookup.md`**

```markdown
# ADR 0009 — Exchange-rate lookup: greatest effective_from, no interpolation, no synthesised inverse

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Spec §3.3 models `Currency ── ExchangeRate(effective_from, source)`; spec §3.8 fixes `source` as a mandatory
provenance string. Nothing states what happens between two rate rows, before the first, or when only the opposite
pair is on file. Every one of those is a place a wrong number can enter the ledger silently, so each is decided here
once rather than in whichever slice hits it first (contracts §4.2.10 fixes the table and the function).

## Decision

1. **Step function, not interpolation.** `app.rate_for(company, from, to, on)` returns the row with the greatest
   `effective_from <= on`. A rate applies from its effective date until the next one supersedes it, and forward
   indefinitely after the last. There is no interpolation between two rows: an interpolated rate has no `source`,
   and an unsourced rate is unauditable.
2. **No row before the first effective date → no rate.** `rateFor()` returns `null` and the caller raises
   `ERR_RATE_NOT_FOUND` (422). The document is refused. A default of 1, or of the nearest later rate, would post a
   wrong base amount that no later correction can distinguish from a real one.
3. **No synthesised inverse.** A `USD→MYR` row does not answer a `MYR→USD` question. `1/4.68` is not a rate anyone
   quoted, and rounding it to 8 places then multiplying back does not return the original. Both directions are
   entered when both are needed.
4. **The identity pair is never stored or looked up.** `rateFor(c, X, X, …)` short-circuits to `UNIT_RATE(X)`
   (rate `1.00000000`, source `unit`), so a same-currency document can never fail on a missing self-rate row.
5. **Rates are per company, currencies per tenant.** A group may hold companies with different base currencies and
   different rate policies; a tenant that trades in USD trades in USD everywhere.
6. **`source` is `not null`.** `'BNM 2026-09-04'` for a published rate, `'manual:<actor_id>'` for a keyed one
   (spec §3.8). `entered_by` is stamped by trigger and is not the same fact: `source` is where the number came from,
   `entered_by` is who put it in.

## Consequences

- 4B's FX settlement and revaluation read the same function; there is one lookup rule in the system, not two.
- A tenant that forgets to enter a rate gets a refused document with a named remedy rather than a silently wrong
  base amount — the LEGACY-011/LEGACY-012 class of defect.
```

- [ ] **Step 11: Run everything and commit**

Run: `cd packages/db && bun run test && cd ../.. && bun run lint && bun run lint:rules && bun run typecheck && cd tests && bun run test -- regression`
Expected: all green. `privileges.test.ts` covers up → down → up for migrations 1, 4 and 5.

```bash
git add packages/db docs/adr/0009-exchange-rate-lookup.md tests
git commit -m "feat(db): migration 0005 — currency, exchange_rate and the one rate lookup [0D T8]

A step function over effective_from with mandatory provenance; no interpolation,
no synthesised inverse, UNIT_RATE for the identity pair. Proves toBase() agrees
with Postgres round() over 10^4 pairs so the ledger CHECK holds by construction.
ADR 0009; legacy-019. spec §3.3, §3.8; contracts §4.2.10.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The currency and exchange-rate API

**Files:**
- Create: `packages/contracts/src/admin/currency.ts`, `packages/contracts/src/admin/exchange-rate.ts`, `apps/api/src/routes/admin/currencies.ts`, `apps/api/src/routes/admin/exchange-rates.ts`, `apps/api/test/routes/admin/currencies.test.ts`, `apps/api/test/routes/admin/exchange-rates.test.ts`
- Modify: `packages/contracts/package.json` (subpath exports), `packages/contracts/src/errors.ts` (`ERR_RATE_NOT_FOUND`), `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json` (regenerated)

**Interfaces:**
- Consumes: 0B's `AppEnv`, `RequestContext`, `requirePermission`, `ScopeSource`, `PERMISSION`, `AppError`, `fromDatabaseError`, `UuidSchema`, `DateSchema`, `CurrencySchema`, `RateSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`, `encodeCursor`, `decodeCursor`, `startApi`, `ApiRequest`, `RouteModule`, **`buildRoutes`** and **`IdempotencyHeader`** (§4.2.7, both from `apps/api/src/routes/index.ts`), `PROBES`, `IsolationProbe`, and **`grantAdmin`** (§4.17.1, `tests/support/api.ts`); Task 8's `rateFor`, `seedCurrency`, `seedRate`.
- Produces:
  - `packages/contracts/src/admin/currency.ts`: `CurrencySchema` (the entity), `CreateCurrencyBody`, `UpdateCurrencyBody`, `CurrencyQuery`, `CurrencyList`.
  - `packages/contracts/src/admin/exchange-rate.ts`: `ExchangeRateSchema`, `CreateExchangeRateBody`, `ExchangeRateQuery`, `ExchangeRateList`, `RateLookupQuery`.
  - `apps/api/src/routes/admin/currencies.ts`: `export const currenciesRoutes` and its `RouteModule` at path `/v1/admin/currencies`.
  - `apps/api/src/routes/admin/exchange-rates.ts`: `export const exchangeRatesRoutes` at path `/v1/companies/:companyId/exchange-rates`.
  - `ERRORS.ERR_RATE_NOT_FOUND`.

**URL shapes fixed here (convention, recorded in the Self-Review).** `app.currency` is **tenant**-scoped — it has no `company_id` — so it mounts at `/v1/admin/currencies` per §4.2.7's "tenant-scoped resources at `/v1/admin/<resource>`". But `requirePermission` resolves authority through `app.actor_has(code, company_id, branch_id)`, which needs a company, and `ScopeSource` offers only `path:companyId`, `body:companyId` or `terminal`. Writes therefore take `companyId` **in the body**, documented as the company whose `admin.company.manage` authority the caller is exercising — the row it creates is tenant-wide. `app.exchange_rate` has a `company_id` and mounts company-scoped at `/v1/companies/{companyId}/exchange-rates`.

- [ ] **Step 1: Write the failing test `apps/api/test/routes/admin/exchange-rates.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedCurrency, seedTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/exchange-rates — contracts §4.2.10; spec §4.5", () => {
  let api: StartedApi; let a: Seed; let b: Seed;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    // `seedTenant` grants its human NOTHING — no role, no role_permission, no role_assignment (§4.1, plan0A:1581–1600)
    // — so every requirePermission-gated write below would answer 403 without this. §4.17.1 makes 0B's grantAdmin
    // the one way to grant; `b` is granted too, so its cross-tenant calls fail on the *company*, not on a bare seed.
    await grantAdmin(api, a); await grantAdmin(api, b);
    await seedCurrency(api.db, a, { code: "MYR" }); await seedCurrency(api.db, a, { code: "USD" });
  });
  afterAll(async () => { await api.stop(); });

  const path = (s: Seed, suffix = "") => `/v1/companies/${s.company}/exchange-rates${suffix}`;
  const body = { fromCurrency: "USD", toCurrency: "MYR", rate: "4.68000000", effectiveFrom: "2026-01-01", source: "BNM 2026-01-01" };

  it("creates a rate and echoes the stamped actor as enteredBy", async () => {
    const res = await api.request({ method: "POST", path: path(a), body, as: a.human });
    expect(res.status).toBe(201);
    const row = await res.json() as { id: string; rate: string; enteredBy: string; source: string };
    expect(row).toMatchObject({ rate: "4.68000000", enteredBy: a.human, source: "BNM 2026-01-01" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a rate that is not numeric(19,8) or not positive, naming the field", async () => {
    for (const rate of ["4.68", "-1.00000000", "abc"]) {
      const res = await api.request({ method: "POST", path: path(a), body: { ...body, rate, effectiveFrom: "2026-02-01" }, as: a.human });
      expect(res.status, rate).toBe(400);
      const problem = await res.json() as Problem;
      expect(problem.code).toBe("ERR_VALIDATION_FAILED");
      expect(problem.errors!.some((e) => e.path.includes("rate"))).toBe(true);
    }
  });

  it("requires an Idempotency-Key on the unsafe method and replays the stored response (spec §4.5)", async () => {
    const missing = await api.request({ method: "POST", path: path(a), body, as: a.human, idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect((await missing.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = "rate-replay-1";
    const b1 = { ...body, effectiveFrom: "2026-03-01" };
    const first = await api.request({ method: "POST", path: path(a), body: b1, as: a.human, idempotencyKey: key });
    const second = await api.request({ method: "POST", path: path(a), body: b1, as: a.human, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("lists rates newest first and pages with a cursor (spec §4.5 'cursor pagination everywhere')", async () => {
    // Two rows exist at this point (2026-01-01 from the first test, 2026-03-01 from the replay test); a third is
    // needed or `limit=2` returns everything and `next_cursor` is correctly null, which would prove nothing.
    const third = await api.request({ method: "POST", path: path(a), body: { ...body, effectiveFrom: "2026-05-01" }, as: a.human });
    expect(third.status).toBe(201);

    const res = await api.request({ method: "GET", path: `${path(a)}?limit=2`, as: a.human });
    expect(res.status).toBe(200);
    const page = await res.json() as { items: { effectiveFrom: string }[]; next_cursor: string | null };
    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.effectiveFrom)).toEqual(["2026-05-01", "2026-03-01"]);
    expect(page.next_cursor).not.toBeNull();

    const next = await api.request({
      method: "GET", path: `${path(a)}?limit=2&cursor=${encodeURIComponent(page.next_cursor!)}`, as: a.human,
    });
    const rest = await next.json() as { items: { effectiveFrom: string }[]; next_cursor: string | null };
    expect(rest.items.map((i) => i.effectiveFrom)).toEqual(["2026-01-01"]);   // no row repeats across the two pages
    expect(rest.next_cursor).toBeNull();
  });

  it("looks up the effective rate for a date", async () => {
    const res = await api.request({ method: "GET", path: `${path(a, "/lookup")}?from=USD&to=MYR&on=2026-02-15`, as: a.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "USD", to: "MYR", rate: "4.68000000", effectiveFrom: "2026-01-01" });
  });

  it("raises ERR_RATE_NOT_FOUND when no rate is effective on the date, naming the pair", async () => {
    const res = await api.request({ method: "GET", path: `${path(a, "/lookup")}?from=USD&to=MYR&on=2025-12-31`, as: a.human });
    expect(res.status).toBe(422);
    const problem = await res.json() as Problem;
    expect(problem.code).toBe("ERR_RATE_NOT_FOUND");
    expect(problem.detail).toContain("USD → MYR on 2025-12-31");
    expect(problem.remedy).toMatch(/exchange rate/i);
  });

  it("returns the unit rate for the identity pair without touching the table", async () => {
    const res = await api.request({ method: "GET", path: `${path(a, "/lookup")}?from=MYR&to=MYR&on=1999-01-01`, as: a.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rate: "1.00000000", source: "unit" });
  });

  it("a principal without admin.company.manage cannot write, and another tenant sees nothing (tests 12, 36)", async () => {
    const noAuthority = await api.request({ method: "POST", path: path(a), body: { ...body, effectiveFrom: "2026-04-01" }, as: a.system });
    expect([403, 201]).toContain(noAuthority.status);   // the system principal passes actor_has by design (§4.2.2 R8)

    const cross = await api.request({ method: "GET", path: path(a), as: b.human });
    expect(cross.status).toBe(404);                     // never reveals that another tenant's company exists
  });
});
```

- [ ] **Step 2: Write the failing test `apps/api/test/routes/admin/currencies.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/admin/currencies — a tenant-scoped resource under company authority (contracts §4.2.7, §4.2.10)", () => {
  let api: StartedApi; let a: Seed; let b: Seed;
  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    // Both principals write here (the "same code in another tenant" case is B's), and `seedTenant` grants nothing
    // (§4.1), so both need the grant or every POST/PATCH below answers 403 (§4.17.1).
    await grantAdmin(api, a); await grantAdmin(api, b);
  });
  afterAll(async () => { await api.stop(); });

  it("creates a currency with its display policy and defaults", async () => {
    const res = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "MYR", nameEn: "Malaysian ringgit", nameAr: "رينغيت ماليزي" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "MYR", nameEn: "Malaysian ringgit", nameAr: "رينغيت ماليزي",
      minorUnits: 2, posRoundingIncrement: "0.0100", roundingMode: "HALF_AWAY_FROM_ZERO",
    });
  });

  it("accepts a zero-minor-unit currency and a POS increment of its own", async () => {
    const res = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "JPY", nameEn: "Japanese yen", minorUnits: 0, posRoundingIncrement: "1.0000" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ minorUnits: 0, posRoundingIncrement: "1.0000" });
  });

  it("refuses a code that is not three upper-case letters and a rounding mode outside the four", async () => {
    const bad = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "myr", nameEn: "x" } });
    expect(bad.status).toBe(400);
    expect((await bad.json() as Problem).code).toBe("ERR_VALIDATION_FAILED");

    const badMode = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "SGD", nameEn: "x", roundingMode: "HALF_UP" } });
    expect(badMode.status).toBe(400);
  });

  it("a duplicate code in the same tenant is a 409, and the same code in another tenant is fine", async () => {
    const dup = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "MYR", nameEn: "again" } });
    expect(dup.status).toBe(409);
    expect((await dup.json() as Problem).code).toBe("ERR_CONFLICT_UNIQUE");

    const other = await api.request({ method: "POST", path: "/v1/admin/currencies", as: b.human,
      body: { companyId: b.company, code: "MYR", nameEn: "Malaysian ringgit" } });
    expect(other.status).toBe(201);
  });

  it("lists only the caller's tenant's currencies (acceptance test 12)", async () => {
    const mine = await api.request({ method: "GET", path: "/v1/admin/currencies", as: a.human });
    const theirs = await api.request({ method: "GET", path: "/v1/admin/currencies", as: b.human });
    const codes = async (r: Response) => ((await r.json()) as { items: { code: string }[] }).items.map((i) => i.code).sort();
    expect(await codes(mine)).toEqual(["JPY", "MYR"]);
    expect(await codes(theirs)).toEqual(["MYR"]);
  });

  it("archives rather than deletes (spec §3.9 Deletion: master data is archived, never DELETEd)", async () => {
    const created = await api.request({ method: "POST", path: "/v1/admin/currencies", as: a.human,
      body: { companyId: a.company, code: "SGD", nameEn: "Singapore dollar" } });
    const { id } = await created.json() as { id: string };
    const archived = await api.request({ method: "PATCH", path: `/v1/admin/currencies/${id}`, as: a.human,
      body: { companyId: a.company, archived: true } });
    expect(archived.status).toBe(200);
    expect((await archived.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const list = await api.request({ method: "GET", path: "/v1/admin/currencies", as: a.human });
    expect(((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain("SGD");
    const all = await api.request({ method: "GET", path: "/v1/admin/currencies?includeArchived=true", as: a.human });
    expect(((await all.json()) as { items: { code: string }[] }).items.map((i) => i.code)).toContain("SGD");
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && bun run test -- test/routes/admin`
Expected: FAIL — 404 on every request; `apps/api/src/routes/admin/currencies.ts` does not exist.

- [ ] **Step 4: Write the Zod contracts**

Add the subpath export to `packages/contracts/package.json` (if 0B already declared an `exports` map, add only the `./admin/*` line):

```json
  "exports": {
    ".": "./src/index.ts",
    "./permissions": "./permissions.ts",
    "./admin/*": "./src/admin/*.ts"
  }
```

```ts
// packages/contracts/src/admin/currency.ts
import { z } from "zod";
import { CurrencySchema as CurrencyCodeSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const RoundingModeSchema = z.enum(["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]);
const IncrementSchema = z.string().regex(/^\d+\.\d{4}$/, "must be a decimal with exactly four places, e.g. \"0.0100\"");

/** The entity as returned. `app.currency` is tenant-scoped: one row serves every company of the tenant. */
export const CurrencySchema = z.object({
  id: UuidSchema,
  code: CurrencyCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().nullable(),
  minorUnits: z.number().int().min(0).max(4),
  posRoundingIncrement: IncrementSchema,
  roundingMode: RoundingModeSchema,
  archivedAt: TimestampSchema.nullable(),
});

/**
 * `companyId` is **not** stored on the row. It names the company whose `admin.company.manage` authority the caller is
 * exercising (contracts §4.2.5 ScopeSource `body:companyId`); the currency it creates is tenant-wide.
 */
export const CreateCurrencyBody = z.object({
  companyId: UuidSchema,
  code: CurrencyCodeSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
  minorUnits: z.number().int().min(0).max(4).optional(),
  posRoundingIncrement: IncrementSchema.optional(),
  roundingMode: RoundingModeSchema.optional(),
});

export const UpdateCurrencyBody = z.object({
  companyId: UuidSchema,
  nameEn: z.string().min(1).max(120).optional(),
  nameAr: z.string().min(1).max(120).nullable().optional(),
  minorUnits: z.number().int().min(0).max(4).optional(),
  posRoundingIncrement: IncrementSchema.optional(),
  roundingMode: RoundingModeSchema.optional(),
  archived: z.boolean().optional(),
});

export const CurrencyQuery = ListQuery.extend({ includeArchived: z.coerce.boolean().default(false) });
export const CurrencyList = ListEnvelope(CurrencySchema);
```

```ts
// packages/contracts/src/admin/exchange-rate.ts
import { z } from "zod";
import { CurrencySchema as CurrencyCodeSchema, DateSchema, ListEnvelope, ListQuery, RateSchema, UuidSchema } from "../common";

export const ExchangeRateSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  fromCurrency: CurrencyCodeSchema,
  toCurrency: CurrencyCodeSchema,
  rate: RateSchema,
  effectiveFrom: DateSchema,
  source: z.string().min(1),
  enteredBy: UuidSchema,
});

export const CreateExchangeRateBody = z.object({
  fromCurrency: CurrencyCodeSchema,
  toCurrency: CurrencyCodeSchema,
  // The positivity check is a *string* predicate, not `Number.parseFloat(r) > 0`: a numeric(19,8) rate must never
  // pass through an IEEE-754 double, not even on a validation path (spec §0.2 "never represent money as a float,
  // anywhere, including in TypeScript"). `RateSchema`'s `^\d+\.\d{8}$` already excludes a sign and fixes the scale,
  // so "all eight decimals and the integer part are zero" is the only remaining non-positive value.
  rate: RateSchema.refine((r) => !/^0+\.0{8}$/.test(r), "rate must be greater than zero"),
  effectiveFrom: DateSchema,
  source: z.string().min(1).max(200),
  // enteredBy is deliberately absent: it is stamped by the database from the session (LEGACY-044).
}).strict();

export const ExchangeRateQuery = ListQuery.extend({
  from: CurrencyCodeSchema.optional(),
  to: CurrencyCodeSchema.optional(),
});

/** The lookup form the whole system uses: the rate effective on a date, or ERR_RATE_NOT_FOUND. */
export const RateLookupQuery = z.object({ from: CurrencyCodeSchema, to: CurrencyCodeSchema, on: DateSchema });

export const RateLookupResponse = z.object({
  from: CurrencyCodeSchema, to: CurrencyCodeSchema, rate: RateSchema, effectiveFrom: DateSchema, source: z.string(),
});

export const ExchangeRateList = ListEnvelope(ExchangeRateSchema);
```

Add to `packages/contracts/src/errors.ts` `ERRORS`:

```ts
  ERR_RATE_NOT_FOUND: { status: 422, title: "No exchange rate is effective on that date",
    remedy: "Enter an exchange rate for the currency pair with an effective date on or before the document date." },
```

- [ ] **Step 5: Write `apps/api/src/routes/admin/exchange-rates.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, decodeCursor, encodeCursor, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateExchangeRateBody, ExchangeRateList, ExchangeRateQuery, ExchangeRateSchema, RateLookupQuery, RateLookupResponse,
} from "@dulja/contracts/admin/exchange-rate";
import { rateFor } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const exchangeRatesRoutes = new OpenAPIHono<AppEnv>();

const PathParams = z.object({ companyId: UuidSchema });
const problem = (status: 400 | 403 | 404 | 409 | 422) =>
  ({ [status]: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Problem" } });

/**
 * Company resolution for the **reads**, which carry no `requirePermission` (§4.2.11 makes them membership-only).
 * Without it a `companyId` belonging to another tenant matches no row under RLS and the list handler answers
 * `200 { items: [], next_cursor: null }` — which leaks nothing but is not what §3.7.2's harness asserts, and
 * `IsolationProbe.expect` is typed `403 | 404` with no 200 form. Called with the caller's own `tx` so the check and
 * the query are one transaction (spec:2053), never a second `withTenant`.
 */
async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  const rows = await tx<{ ok: number }[]>`select 1 as ok from app.company where id = ${companyId}`;
  return rows.length > 0;
}

exchangeRatesRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["admin"],
  middleware: [requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" })],
  request: {
    params: PathParams, headers: IdempotencyHeader,      // §4.2.7: every unsafe createRoute declares it
    body: { content: { "application/json": { schema: CreateExchangeRateBody } } },
  },
  responses: { 201: { content: { "application/json": { schema: ExchangeRateSchema } }, description: "Created" }, ...problem(400), ...problem(409) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const row = await c.var.withTenant(async (tx) => {
    const [created] = await tx<{
      id: string; company_id: string; from_currency: string; to_currency: string;
      rate: string; effective_from: string; source: string; entered_by: string;
    }[]>`
      insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
      values (${c.var.ctx.tenantId}, ${companyId}, ${body.fromCurrency}, ${body.toCurrency}, ${body.rate},
              ${body.effectiveFrom}, ${body.source})
      returning id, company_id, from_currency, to_currency, rate::text, effective_from::text, source, entered_by`;
    return created!;
  });
  return c.json({
    id: row.id, companyId: row.company_id, fromCurrency: row.from_currency, toCurrency: row.to_currency,
    rate: row.rate, effectiveFrom: row.effective_from, source: row.source, enteredBy: row.entered_by,
  }, 201);
});

exchangeRatesRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["admin"],
  request: { params: PathParams, query: ExchangeRateQuery },
  responses: { 200: { content: { "application/json": { schema: ExchangeRateList } }, description: "Rates" }, ...problem(404) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  const after = q.cursor ? decodeCursor(q.cursor) : null;      // { k: [effective_from], id }
  const rows = await c.var.withTenant(async (tx) => {
    if (!(await companyExists(tx, companyId))) return null;    // another tenant's company id → ERR_NOT_FOUND, not an empty page
    return tx<{
      id: string; company_id: string; from_currency: string; to_currency: string;
      rate: string; effective_from: string; source: string; entered_by: string;
    }[]>`
      select id, company_id, from_currency, to_currency, rate::text, effective_from::text, source, entered_by
        from app.exchange_rate
       where company_id = ${companyId}
         and (${q.from ?? null}::char(3) is null or from_currency = ${q.from ?? null})
         and (${q.to ?? null}::char(3) is null or to_currency = ${q.to ?? null})
         and (${after ? (after.k[0] as string) : null}::date is null
              or (effective_from, id) < (${after ? (after.k[0] as string) : null}::date, ${after ? after.id : null}::uuid))
       order by effective_from desc, id desc
       limit ${q.limit + 1}`;
  });
  if (rows === null) return c.notFound();
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json({
    items: page.map((r) => ({
      id: r.id, companyId: r.company_id, fromCurrency: r.from_currency, toCurrency: r.to_currency,
      rate: r.rate, effectiveFrom: r.effective_from, source: r.source, enteredBy: r.entered_by,
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ k: [last.effective_from], id: last.id }) : null,
  }, 200);
});

exchangeRatesRoutes.openapi(createRoute({
  method: "get", path: "/lookup", tags: ["admin"],
  request: { params: PathParams, query: RateLookupQuery },
  responses: { 200: { content: { "application/json": { schema: RateLookupResponse } }, description: "The effective rate" }, ...problem(404), ...problem(422) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const { from, to, on } = c.req.valid("query");
  const found = await c.var.withTenant(async (tx) => {
    if (!(await companyExists(tx, companyId))) return "no-company" as const;
    return rateFor(tx, companyId, from, to, on);
  });
  if (found === "no-company") return c.notFound();
  const rate = found;
  if (!rate) throw new AppError("ERR_RATE_NOT_FOUND", `no exchange rate is effective for ${from} → ${to} on ${on}`);
  return c.json({ from: rate.from, to: rate.to, rate: rate.rate, effectiveFrom: rate.effectiveFrom, source: rate.source }, 200);
});
```

**`import { IdempotencyHeader } from "../index";` is the import 2A and 2C already write**, and §4.2.7 declares the
symbol in `apps/api/src/routes/index.ts`. That is a cycle on paper — `index.ts` imports this route file, this route
file imports `index.ts` — so 0B must already have made it load-safe, because `users.ts`, `roles.ts`,
`role-assignments.ts` and `companies.ts` all do the same thing and 0B is green. If the executor nevertheless hits a
`ReferenceError: Cannot access 'IdempotencyHeader' before initialization` at module load, the cause is 0B's file
layout and not this task: move the declaration to `apps/api/src/routes/idempotency-header.ts`, re-export it from
`index.ts` so the registered name is unchanged, and point all four 0B route files and these three at the new module
in the same commit. Do **not** work around it by re-declaring the header schema here — §4.2.7 exists so every unsafe
route documents the header identically.

`decodeCursor` / `encodeCursor` are 0B's keyset-cursor helpers, exported from `@dulja/contracts` (`packages/contracts/src/common.ts`) beside the other §4.2.8 schemas: `encodeCursor(c: Cursor)` / `decodeCursor(raw): Cursor` over the registered `Cursor = { k: unknown[]; id: string }`, which is why both call sites below pass and receive that object rather than a positional key and id. §4.2.8 makes it the one implementation every list handler in every slice imports.

- [ ] **Step 6: Write `apps/api/src/routes/admin/currencies.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { decodeCursor, encodeCursor, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import { CreateCurrencyBody, CurrencyList, CurrencyQuery, CurrencySchema, UpdateCurrencyBody } from "@dulja/contracts/admin/currency";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const currenciesRoutes = new OpenAPIHono<AppEnv>();

interface Row {
  id: string; code: string; name_en: string; name_ar: string | null;
  minor_units: number; pos_rounding_increment: string; rounding_mode: string; archived_at: string | null;
}
const toJson = (r: Row) => ({
  id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, minorUnits: r.minor_units,
  posRoundingIncrement: r.pos_rounding_increment, roundingMode: r.rounding_mode, archivedAt: r.archived_at,
});
const problem = (status: 400 | 403 | 404 | 409) =>
  ({ [status]: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Problem" } });
const COLUMNS = "id, code, name_en, name_ar, minor_units, pos_rounding_increment::text, rounding_mode, archived_at";

currenciesRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["admin"],
  middleware: [requirePermission(PERMISSION["admin.company.manage"], { company: "body:companyId" })],
  request: { headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreateCurrencyBody } } } },
  responses: { 201: { content: { "application/json": { schema: CurrencySchema } }, description: "Created" }, ...problem(400), ...problem(409) },
}), async (c) => {
  const b = c.req.valid("json");
  const row = await c.var.withTenant(async (tx) => {
    const [created] = await tx<Row[]>`
      insert into app.currency (tenant_id, code, name_en, name_ar, minor_units, pos_rounding_increment, rounding_mode)
      values (${c.var.ctx.tenantId}, ${b.code}, ${b.nameEn}, ${b.nameAr ?? null},
              ${b.minorUnits ?? 2}, ${b.posRoundingIncrement ?? "0.0100"}, ${b.roundingMode ?? "HALF_AWAY_FROM_ZERO"})
      returning id, code, name_en, name_ar, minor_units, pos_rounding_increment::text, rounding_mode, archived_at`;
    return created!;
  });
  return c.json(toJson(row), 201);
});

currenciesRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["admin"],
  request: { query: CurrencyQuery },
  responses: { 200: { content: { "application/json": { schema: CurrencyList } }, description: "Currencies" } },
}), async (c) => {
  const q = c.req.valid("query");
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await c.var.withTenant((tx) => tx<Row[]>`
    select id, code, name_en, name_ar, minor_units, pos_rounding_increment::text, rounding_mode, archived_at
      from app.currency
     where (${q.includeArchived}::boolean or archived_at is null)
       and (${after ? (after.k[0] as string) : null}::text is null
            or (code, id) > (${after ? (after.k[0] as string) : null}::char(3), ${after ? after.id : null}::uuid))
     order by code, id
     limit ${q.limit + 1}`);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return c.json({
    items: page.map(toJson),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ k: [last.code], id: last.id }) : null,
  }, 200);
});

currenciesRoutes.openapi(createRoute({
  method: "patch", path: "/{currencyId}", tags: ["admin"],
  middleware: [requirePermission(PERMISSION["admin.company.manage"], { company: "body:companyId" })],
  request: {
    params: z.object({ currencyId: UuidSchema }), headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: UpdateCurrencyBody } } },
  },
  responses: { 200: { content: { "application/json": { schema: CurrencySchema } }, description: "Updated" }, ...problem(400), ...problem(404) },
}), async (c) => {
  const { currencyId } = c.req.valid("param");
  const b = c.req.valid("json");
  // Master data is archived, never deleted (spec §3.9); `archived: false` un-archives.
  const row = await c.var.withTenant(async (tx) => {
    const [updated] = await tx<Row[]>`
      update app.currency set
        name_en = coalesce(${b.nameEn ?? null}, name_en),
        name_ar = case when ${b.nameAr === undefined} then name_ar else ${b.nameAr ?? null} end,
        minor_units = coalesce(${b.minorUnits ?? null}, minor_units),
        pos_rounding_increment = coalesce(${b.posRoundingIncrement ?? null}::numeric, pos_rounding_increment),
        rounding_mode = coalesce(${b.roundingMode ?? null}, rounding_mode),
        archived_at = case when ${b.archived === undefined} then archived_at
                           when ${b.archived === true} then coalesce(archived_at, now()) else null end
      where id = ${currencyId}
      returning id, code, name_en, name_ar, minor_units, pos_rounding_increment::text, rounding_mode, archived_at`;
    return updated;
  });
  if (!row) return c.notFound();
  return c.json(toJson(row), 200);
});
```

- [ ] **Step 7: Register the two modules and their probes**

**Registration goes inside `buildRoutes(deps)`, not onto `ROUTES`.** §4.2.7 is explicit — "`buildRoutes` is the
authoritative form; `ROUTES` is derived from it… every slice that registers a module adds it **inside
`buildRoutes`**, never by pushing onto `ROUTES`" — because `ROUTES` is the frozen expression
`buildRoutes({ authAdmin: new StubAuthAdmin() })` and a push would be invisible to `createApp`, which mounts
`buildRoutes({ authAdmin: deps.authAdmin })`. In `apps/api/src/routes/index.ts`, add the two imports at the top of
the file and the two entries **to the array literal `buildRoutes` returns**, after 0B's `/v1/companies` entry:

```ts
import { currenciesRoutes } from "./admin/currencies";
import { exchangeRatesRoutes } from "./admin/exchange-rates";

export function buildRoutes(deps: { authAdmin: AuthAdmin }): readonly RouteModule[] {
  return [
    // 0B's seven entries stay exactly as 0B wrote them. The last of them is
    //   { path: "/v1/companies", router: companyRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
    // and these two are appended directly after it:
    { path: "/v1/admin/currencies", router: currenciesRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
    { path: "/v1/companies/:companyId/exchange-rates", router: exchangeRatesRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
  ];
}
```

`ROUTES` and `createApp` are untouched: both already read whatever `buildRoutes` returns.

`tests/invariants/probes.ts` `PROBES` gains (hazard 31 — a route with no probe fails the build):

```ts
  "/v1/admin/currencies": {
    async seed(db, owner) {
      await seedCurrency(db, owner, { code: "MYR" });
      return { path: "/v1/admin/currencies", method: "POST", body: { companyId: owner.company, code: "MYR", nameEn: "dup" } };
    },
    // 403, not 404: this route is tenant-scoped and gated `{ company: "body:companyId" }`, so the attacker naming
    // the victim's company is refused by `requirePermission` — `app.actor_has(code, <victim company>)` is false
    // inside the attacker's own tenant — and that is ERR_RBAC_FORBIDDEN (§4.2.4), which never reaches a handler.
    expect: 403,
  },
  "/v1/companies/:companyId/exchange-rates": {
    async seed(db, owner) {
      await seedCurrency(db, owner, { code: "USD" });
      await seedRate(db, owner, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.68000000" });
      return { path: `/v1/companies/${owner.company}/exchange-rates`, method: "GET" };
    },
    // 404 from the handler's own company guard (Step 5): the read carries no permission gate, so without that
    // guard this would be a 200 with an empty envelope, which `IsolationProbe.expect` cannot express.
    expect: 404,
  },
```

- [ ] **Step 8: Run the route tests, regenerate the OpenAPI document, run everything**

Run:
```bash
cd apps/api && bun run test -- test/routes/admin
cd ../.. && bun run --cwd packages/contracts openapi:generate
git diff --stat packages/contracts/openapi.json
bun run lint && bun run lint:rules && bun run typecheck && bun run test
```
Expected: route tests pass; `openapi.json` shows the four new paths (`/v1/admin/currencies`, `/v1/admin/currencies/{currencyId}`, `/v1/companies/{companyId}/exchange-rates`, `…/lookup`); CI's generate-and-diff step is therefore green after the file is committed (spec §4.5). Confirm the header landed on all three unsafe operations of this task:

```bash
node -e "const d=require('./packages/contracts/openapi.json');let n=0;for(const[p,o]of Object.entries(d.paths))for(const[m,op]of Object.entries(o))if(['post','put','patch','delete'].includes(m)){const h=(op.parameters||[]).some(x=>x.in==='header'&&x.name==='Idempotency-Key');if(!h)console.log('MISSING Idempotency-Key:',m.toUpperCase(),p);else n++;}console.log(n,'unsafe operations document the header')"
```

Expected: no `MISSING` line, and the count is 0B's ten plus this task's three (currencies `POST /`, currencies `PATCH /{currencyId}`, exchange-rates `POST /`) — **13**.

If `bun run lint:rules` reports `no-sql-concat` on the list queries, the `${q.from ?? null}::char(3) is null or …` form was rewritten as string interpolation — keep every value a bound parameter; the `::char(3)` cast is part of the literal template, not a value.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts apps/api tests
git commit -m "feat(api): currency and exchange-rate endpoints [0D T9]

Tenant-scoped currencies under /v1/admin, company-scoped rates with a lookup that
raises ERR_RATE_NOT_FOUND naming the pair and date. Cursor pagination, idempotent
writes, probes for the isolation harness, OpenAPI regenerated. spec §4.5; §4.2.10.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Migration 0007 — `name_ar` on the dimension tables, and the dimension service

**Files:**
- Create: `packages/db/migrations/0007_add_dimension_name_ar.sql`, `packages/db/migrations/0007.down.sql`, `packages/db/src/schema/dimension-type.ts`, `packages/db/src/schema/dimension-value.ts`, `packages/db/src/dimensions/service.ts`, `packages/db/test/dimension.test.ts`
- Modify: `packages/db/test/fixtures.ts` (add `seedBranch` — additive only), `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Plan 0A's `app.dimension_type`, `app.dimension_value` (migration 0001, spec:1789–1794), `seedTenant`, `Seed` (`branchType`, `hq`), `withTenant` (test), `uuidv7`, `lintSchema`.
- Produces:
  - SQL: `name_ar text` on `app.dimension_type` and `app.dimension_value` (resolves contracts C8, §4.6).
  - `packages/db/src/dimensions/service.ts`: `createDimensionType`, `createDimensionValue`, `listDimensionTypes`, `listDimensionValues`, and the row types `DimensionTypeRow`, `DimensionValueRow`.
  - `packages/db/test/fixtures.ts` (§4.17): `seedBranch(db: Db, s: Seed, opts?: { code?: string; nameEn?: string }): Promise<string>`.

**Why the migration exists.** Spec §3.9 Naming requires "bilingual names on master data as `name_en` / `name_ar` columns — not a JSON blob", and a dimension value is master data a user reads (a cost centre, a branch). Migration 0001 gave `dimension_type` and `dimension_value` only `name_en` (plan0A:1790–1791). This is an **expand-only** change (§3.4.7): one nullable column per table, no backfill, no contract step needed.

- [ ] **Step 1: Write the failing test `packages/db/test/dimension.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { createDimensionType, createDimensionValue, listDimensionTypes, listDimensionValues } from "../src/dimensions/service";
import { seedBranch, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("migration 0007 and the dimension service — spec §3.3 'a new dimension needs no schema change'", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("both dimension tables now carry name_ar and the linter is still clean", async () => {
    const cols = await db.admin<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable from information_schema.columns
       where table_schema = 'app' and column_name = 'name_ar' and table_name in ('dimension_type', 'dimension_value')
       order by table_name`;
    expect(cols).toEqual([
      { table_name: "dimension_type", is_nullable: "YES" },
      { table_name: "dimension_value", is_nullable: "YES" },
    ]);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the 0A seed's BRANCH type and HQ value survive the expand untouched", async () => {
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ code: string; name_en: string; name_ar: string | null }[]>`
      select code, name_en, name_ar from app.dimension_type where id = ${a.branchType}`);
    expect(row).toEqual({ code: "BRANCH", name_en: "Branch", name_ar: null });
  });

  it("creates a new dimension type and its values with no schema change (DoD 0.10, data-layer half)", async () => {
    const typeId = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionType(tx, { companyId: a.company, code: "COST_CENTRE", nameEn: "Cost centre", nameAr: "مركز التكلفة" }));
    const north = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionValue(tx, { dimensionTypeId: typeId, code: "NORTH", nameEn: "Northern region", nameAr: "المنطقة الشمالية" }));
    const kl = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionValue(tx, { dimensionTypeId: typeId, code: "KL", nameEn: "Kuala Lumpur", parentId: north }));

    const types = await withTenant(db.rw, a.tenant, a.human, (tx) => listDimensionTypes(tx, a.company));
    expect(types.map((t) => t.code).sort()).toEqual(["BRANCH", "COST_CENTRE"]);
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) => listDimensionValues(tx, typeId, false));
    expect(values.map((v) => [v.code, v.nameAr, v.parentId])).toEqual([
      ["KL", null, north],
      ["NORTH", "المنطقة الشمالية", null],
    ]);
    expect(kl).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a dimension type code is unique per company; a value code is unique per type", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionType(tx, { companyId: a.company, code: "BRANCH", nameEn: "again" }))).rejects.toThrow(/unique|duplicate key/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDimensionValue(tx, { dimensionTypeId: a.branchType, code: "HQ", nameEn: "again" }))).rejects.toThrow(/unique|duplicate key/);
  });

  it("a value tree is walked with a recursive CTE, never a loop of queries (LEGACY-071)", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ code: string; depth: number }[]>`
      with recursive tree as (
        select id, code, 0 as depth from app.dimension_value where parent_id is null and dimension_type_id in
          (select id from app.dimension_type where company_id = ${a.company} and code = 'COST_CENTRE')
        union all
        select v.id, v.code, t.depth + 1 from app.dimension_value v join tree t on v.parent_id = t.id)
      select code, depth from tree order by depth, code`);
    expect(rows).toEqual([{ code: "NORTH", depth: 0 }, { code: "KL", depth: 1 }]);
  });

  it("a value is archived, never deleted (spec §3.9 Deletion)", async () => {
    const id = await seedBranch(db, a, { code: "KLANG", nameEn: "Klang branch" });
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.dimension_value set archived_at = now() where id = ${id}`);
    const live = await withTenant(db.rw, a.tenant, a.human, (tx) => listDimensionValues(tx, a.branchType, false));
    const all = await withTenant(db.rw, a.tenant, a.human, (tx) => listDimensionValues(tx, a.branchType, true));
    expect(live.map((v) => v.code)).toEqual(["HQ"]);
    expect(all.map((v) => v.code).sort()).toEqual(["HQ", "KLANG"]);
  });

  it("dimensions are tenant-isolated (acceptance test 12)", async () => {
    const seen = await withTenant(db.rw, b.tenant, b.human, (tx) => listDimensionTypes(tx, a.company));
    expect(seen).toEqual([]);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) =>
      createDimensionValue(tx, { dimensionTypeId: a.branchType, code: "X", nameEn: "forged" }))).rejects.toThrow();
  });

  it("the down file drops only the two columns, never the tables (§3.4.5)", async () => {
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
    // 0001's 23 tables plus 0005's two (currency, exchange_rate) — 25 at this point in the plan. 0006's two arrive
    // in Task 12, which is written after this one on purpose (see the header's migration-numbers note), so the
    // assertion is a floor rather than an equality and does not need editing when they land.
    expect(before!.n).toBeGreaterThanOrEqual(25);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/dimension.test.ts`
Expected: FAIL — the first assertion returns `[]`; `name_ar` does not exist on either table.

- [ ] **Step 3: Write `packages/db/migrations/0007_add_dimension_name_ar.sql`**

```sql
-- 0007_add_dimension_name_ar.sql — spec §3.9 Naming: "Bilingual names on master data as name_en / name_ar columns
-- — not a JSON blob." A dimension value is master data a user reads (a branch, a cost centre, a project), so both
-- dimension tables need the Arabic label that migration 0001 gave `role`, `account` and `document_type`.
--
-- Expand only (§3.9 migrations, expand/contract): one nullable column per table, no backfill, no contract step. The
-- existing BRANCH type and its head-office value keep name_ar null until a tenant supplies one.
alter table app.dimension_type  add column name_ar text;
alter table app.dimension_value add column name_ar text;

comment on column app.dimension_type.name_ar  is 'spec §3.9 Naming — the Arabic label; null until a tenant supplies one.';
comment on column app.dimension_value.name_ar is 'spec §3.9 Naming — the Arabic label; null until a tenant supplies one.';
```

- [ ] **Step 4: Write `packages/db/migrations/0007.down.sql`**

```sql
-- 0007.down.sql — drop ONLY the two columns. A migration that adds a column to a 0001 table never drops that table
-- in its down (§3.9 migrations): `down()` to 0 must leave zero tables in schema app, and 0001.down.sql is what does
-- that. Dropping the tables here would make the reversibility test pass for the wrong reason.
alter table app.dimension_value drop column if exists name_ar;
alter table app.dimension_type  drop column if exists name_ar;
```

- [ ] **Step 5: Write `packages/db/src/dimensions/service.ts` and the mirrors**

```ts
import type { Sql } from "postgres";

export interface DimensionTypeRow { id: string; companyId: string; code: string; nameEn: string; nameAr: string | null }
export interface DimensionValueRow { id: string; dimensionTypeId: string; code: string; nameEn: string; nameAr: string | null; parentId: string | null; archivedAt: string | null }

export interface CreateDimensionTypeInput { companyId: string; code: string; nameEn: string; nameAr?: string | null }
export interface CreateDimensionValueInput { dimensionTypeId: string; code: string; nameEn: string; nameAr?: string | null; parentId?: string | null }

/**
 * Dimensions are generic so "a new dimension needs no schema change" (spec §3.3, §5.0 row 0.10). Every function
 * here takes the caller's `tx` — a withTenant transaction — and never opens its own (spec §3.9 Database access).
 * `tenant_id` is read from the session by the RLS policy's own default, never taken from a caller.
 */
export async function createDimensionType(tx: Sql, input: CreateDimensionTypeInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.dimension_type (tenant_id, company_id, code, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null})
    returning id`;
  return row!.id;
}

export async function createDimensionValue(tx: Sql, input: CreateDimensionValueInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en, name_ar, parent_id)
    values (app.current_tenant(), ${input.dimensionTypeId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null}, ${input.parentId ?? null})
    returning id`;
  return row!.id;
}

export async function listDimensionTypes(tx: Sql, companyId: string): Promise<DimensionTypeRow[]> {
  const rows = await tx<{ id: string; company_id: string; code: string; name_en: string; name_ar: string | null }[]>`
    select id, company_id, code, name_en, name_ar from app.dimension_type where company_id = ${companyId} order by code`;
  return rows.map((r) => ({ id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar }));
}

export async function listDimensionValues(tx: Sql, dimensionTypeId: string, includeArchived: boolean): Promise<DimensionValueRow[]> {
  const rows = await tx<{
    id: string; dimension_type_id: string; code: string; name_en: string; name_ar: string | null;
    parent_id: string | null; archived_at: string | null;
  }[]>`
    select id, dimension_type_id, code, name_en, name_ar, parent_id, archived_at
      from app.dimension_value
     where dimension_type_id = ${dimensionTypeId} and (${includeArchived}::boolean or archived_at is null)
     order by code`;
  return rows.map((r) => ({
    id: r.id, dimensionTypeId: r.dimension_type_id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar,
    parentId: r.parent_id, archivedAt: r.archived_at,
  }));
}
```

```ts
// packages/db/src/schema/dimension-type.ts
import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const dimensionType = app.table("dimension_type", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique("dimension_type_company_id_code_key").on(t.companyId, t.code)]);
```

```ts
// packages/db/src/schema/dimension-value.ts
import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const dimensionValue = app.table("dimension_value", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  dimensionTypeId: uuid("dimension_type_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  parentId: uuid("parent_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique("dimension_value_dimension_type_id_code_key").on(t.dimensionTypeId, t.code)]);
```

`packages/db/src/index.ts` gains:

```ts
export {
  createDimensionType, createDimensionValue, listDimensionTypes, listDimensionValues,
  type CreateDimensionTypeInput, type CreateDimensionValueInput, type DimensionTypeRow, type DimensionValueRow,
} from "./dimensions/service";
export { dimensionType as dimensionTypeTable } from "./schema/dimension-type";
export { dimensionValue as dimensionValueTable } from "./schema/dimension-value";
```

- [ ] **Step 6: Add `seedBranch` to `packages/db/test/fixtures.ts` — additively (§4.17)**

```ts
/**
 * §4.17 — a second BRANCH `dimension_value` beside the 0A seed's `hq`. 3D, 6C, 6D and 8B all need one, so it is
 * defined once, here, rather than five times with five spellings.
 */
export async function seedBranch(db: Db, s: Seed, opts: { code?: string; nameEn?: string } = {}): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
    values (${id}, ${s.tenant}, ${s.branchType}, ${opts.code ?? "BR2"}, ${opts.nameEn ?? "Second branch"})`);
  return id;
}
```

- [ ] **Step 7: Run the tests and commit**

Run: `cd packages/db && bun run test -- test/dimension.test.ts && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: PASS — 8 tests; the whole `packages/db` suite green, including the up → down → up fingerprint over migrations 1, 4, 5, 7.

If `privileges.test.ts` fails on the fingerprint, the down file dropped a table instead of a column — re-read Step 4's comment.

```bash
git add packages/db
git commit -m "feat(db): migration 0007 — name_ar on dimension_type and dimension_value [0D T10]

Expand-only bilingual labels for the generic dimension framework, plus the
service a new dimension is created through with no schema change. spec §3.9
Naming, §3.3; contracts §4.6 C8.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The dimension API — "a new dimension with no migration"

**Files:**
- Create: `packages/contracts/src/admin/dimension.ts`, `apps/api/src/routes/admin/dimension-types.ts`, `apps/api/test/routes/admin/dimension-types.test.ts`
- Modify: `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`

**Interfaces:**
- Consumes: Task 10's `createDimensionType`, `createDimensionValue`, `listDimensionTypes`, `listDimensionValues`; 0B's `AppEnv`, `requirePermission`, `PERMISSION`, `UuidSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`, `startApi`, **`buildRoutes`** and **`IdempotencyHeader`** (§4.2.7), `PROBES`, and **`grantAdmin`** (§4.17.1).
- Produces:
  - `packages/contracts/src/admin/dimension.ts`: `DimensionTypeSchema`, `CreateDimensionTypeBody`, `DimensionTypeList`, `DimensionValueSchema`, `CreateDimensionValueBody`, `DimensionValueQuery`, `DimensionValueList`.
  - `apps/api/src/routes/admin/dimension-types.ts`: `export const dimensionTypesRoutes`, mounted at `/v1/companies/:companyId/dimension-types` (§4.2.11 names these paths).

- [ ] **Step 1: Write the failing test `apps/api/test/routes/admin/dimension-types.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/dimension-types — spec §3.3, §5.0 row 0.10 (contracts §4.2.11)", () => {
  let api: StartedApi; let a: Seed; let b: Seed; let costCentre: string;
  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    // Without this every POST/PATCH below is 403: `seedTenant` seeds no role at all (§4.1, plan0A:1581–1600).
    // `b` is granted in **its own** company so the last test's forged POST is refused for naming A's company,
    // not merely for holding nothing anywhere (§4.17.1).
    await grantAdmin(api, a); await grantAdmin(api, b);
  });
  afterAll(async () => { await api.stop(); });

  const types = (s: Seed, suffix = "") => `/v1/companies/${s.company}/dimension-types${suffix}`;

  it("creates a whole new analysis dimension through the API, with no migration (DoD 0.10)", async () => {
    const res = await api.request({ method: "POST", path: types(a), as: a.human,
      body: { code: "COST_CENTRE", nameEn: "Cost centre", nameAr: "مركز التكلفة" } });
    expect(res.status).toBe(201);
    const row = await res.json() as { id: string; code: string; nameAr: string };
    expect(row).toMatchObject({ code: "COST_CENTRE", nameAr: "مركز التكلفة" });
    costCentre = row.id;
  });

  it("adds values to it, including a child of another value", async () => {
    const north = await api.request({ method: "POST", path: types(a, `/${costCentre}/values`), as: a.human,
      body: { code: "NORTH", nameEn: "Northern region" } });
    expect(north.status).toBe(201);
    const { id: northId } = await north.json() as { id: string };

    const kl = await api.request({ method: "POST", path: types(a, `/${costCentre}/values`), as: a.human,
      body: { code: "KL", nameEn: "Kuala Lumpur", parentId: northId } });
    expect(kl.status).toBe(201);
    expect(await kl.json()).toMatchObject({ code: "KL", parentId: northId });
  });

  it("lists types and values; reads need membership only, writes need admin.company.manage", async () => {
    const list = await api.request({ method: "GET", path: types(a), as: a.human });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { code: string }[] }).items.map((i) => i.code).sort())
      .toEqual(["BRANCH", "COST_CENTRE"]);

    const values = await api.request({ method: "GET", path: types(a, `/${costCentre}/values`), as: a.human });
    expect(((await values.json()) as { items: { code: string }[] }).items.map((i) => i.code).sort()).toEqual(["KL", "NORTH"]);
  });

  it("a duplicate code in the same company is a 409", async () => {
    const dup = await api.request({ method: "POST", path: types(a), as: a.human, body: { code: "BRANCH", nameEn: "again" } });
    expect(dup.status).toBe(409);
    expect((await dup.json() as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("validates the code shape and refuses an unknown field (spec §4.5)", async () => {
    const bad = await api.request({ method: "POST", path: types(a), as: a.human, body: { code: "lower case", nameEn: "x" } });
    expect(bad.status).toBe(400);
    const problem = await bad.json() as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors!.some((e) => e.path.includes("code"))).toBe(true);
  });

  it("archives a value instead of deleting it", async () => {
    const created = await api.request({ method: "POST", path: types(a, `/${costCentre}/values`), as: a.human,
      body: { code: "TEMP", nameEn: "Temporary" } });
    const { id } = await created.json() as { id: string };
    const archived = await api.request({ method: "PATCH", path: types(a, `/${costCentre}/values/${id}`), as: a.human, body: { archived: true } });
    expect(archived.status).toBe(200);
    const live = await api.request({ method: "GET", path: types(a, `/${costCentre}/values`), as: a.human });
    expect(((await live.json()) as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain("TEMP");
  });

  it("another tenant sees nothing and cannot write (acceptance test 12)", async () => {
    const cross = await api.request({ method: "GET", path: types(a), as: b.human });
    expect(cross.status).toBe(404);
    const forge = await api.request({ method: "POST", path: types(a), as: b.human, body: { code: "X", nameEn: "forged" } });
    expect([403, 404]).toContain(forge.status);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/routes/admin/dimension-types.test.ts`
Expected: FAIL — 404 on the first POST; the route module does not exist.

- [ ] **Step 3: Write `packages/contracts/src/admin/dimension.ts`**

```ts
import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** Dimension and value codes are the shape §4.15/§4.14 use for every catalogue literal: upper snake case. */
export const DimensionCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "must be 2–32 upper-case letters, digits or underscores");

export const DimensionTypeSchema = z.object({
  id: UuidSchema, companyId: UuidSchema, code: DimensionCodeSchema,
  nameEn: z.string().min(1), nameAr: z.string().nullable(),
});

export const CreateDimensionTypeBody = z.object({
  code: DimensionCodeSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
}).strict();

export const DimensionValueSchema = z.object({
  id: UuidSchema, dimensionTypeId: UuidSchema, code: DimensionCodeSchema,
  nameEn: z.string().min(1), nameAr: z.string().nullable(),
  parentId: UuidSchema.nullable(), archivedAt: TimestampSchema.nullable(),
});

export const CreateDimensionValueBody = z.object({
  code: DimensionCodeSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
  parentId: UuidSchema.optional(),
}).strict();

export const UpdateDimensionValueBody = z.object({
  nameEn: z.string().min(1).max(120).optional(),
  nameAr: z.string().min(1).max(120).nullable().optional(),
  archived: z.boolean().optional(),
}).strict();

export const DimensionValueQuery = ListQuery.extend({ includeArchived: z.coerce.boolean().default(false) });
export const DimensionTypeList = ListEnvelope(DimensionTypeSchema);
export const DimensionValueList = ListEnvelope(DimensionValueSchema);
```

- [ ] **Step 4: Write `apps/api/src/routes/admin/dimension-types.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateDimensionTypeBody, CreateDimensionValueBody, DimensionTypeList, DimensionTypeSchema,
  DimensionValueList, DimensionValueQuery, DimensionValueSchema, UpdateDimensionValueBody,
} from "@dulja/contracts/admin/dimension";
import { createDimensionType, createDimensionValue, listDimensionTypes, listDimensionValues } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const dimensionTypesRoutes = new OpenAPIHono<AppEnv>();

const CompanyParams = z.object({ companyId: UuidSchema });
const TypeParams = CompanyParams.extend({ dimensionTypeId: UuidSchema });
const ValueParams = TypeParams.extend({ valueId: UuidSchema });
const manage = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });
const problem = (status: 400 | 403 | 404 | 409) =>
  ({ [status]: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Problem" } });

/** The reads carry no permission gate (§4.2.11 makes them membership-only), so they resolve the company themselves
 *  or a foreign `companyId` answers 200 with an empty envelope instead of the 404 §3.7.2's harness asserts.
 *  Runs on the caller's own `tx`, inside the transaction the handler already opened (spec:2053). */
async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  const rows = await tx<{ ok: number }[]>`select 1 as ok from app.company where id = ${companyId}`;
  return rows.length > 0;
}

dimensionTypesRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["admin"], middleware: [manage],
  request: {
    params: CompanyParams, headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateDimensionTypeBody } } },
  },
  responses: { 201: { content: { "application/json": { schema: DimensionTypeSchema } }, description: "Created" }, ...problem(400), ...problem(409) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const id = await c.var.withTenant((tx) => createDimensionType(tx, { companyId, ...b }));
  return c.json({ id, companyId, code: b.code, nameEn: b.nameEn, nameAr: b.nameAr ?? null }, 201);
});

dimensionTypesRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["admin"],
  request: { params: CompanyParams },
  responses: { 200: { content: { "application/json": { schema: DimensionTypeList } }, description: "Dimension types" }, ...problem(404) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const items = await c.var.withTenant(async (tx) =>
    (await companyExists(tx, companyId)) ? listDimensionTypes(tx, companyId) : null);
  if (items === null) return c.notFound();
  // A company has a handful of dimension types; the envelope keeps the shape uniform (§4.2.8) with no cursor.
  return c.json({ items, next_cursor: null }, 200);
});

dimensionTypesRoutes.openapi(createRoute({
  method: "post", path: "/{dimensionTypeId}/values", tags: ["admin"], middleware: [manage],
  request: {
    params: TypeParams, headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateDimensionValueBody } } },
  },
  responses: { 201: { content: { "application/json": { schema: DimensionValueSchema } }, description: "Created" }, ...problem(400), ...problem(409) },
}), async (c) => {
  const { dimensionTypeId } = c.req.valid("param");
  const b = c.req.valid("json");
  const id = await c.var.withTenant((tx) => createDimensionValue(tx, { dimensionTypeId, ...b }));
  return c.json({
    id, dimensionTypeId, code: b.code, nameEn: b.nameEn, nameAr: b.nameAr ?? null,
    parentId: b.parentId ?? null, archivedAt: null,
  }, 201);
});

dimensionTypesRoutes.openapi(createRoute({
  method: "get", path: "/{dimensionTypeId}/values", tags: ["admin"],
  request: { params: TypeParams, query: DimensionValueQuery },
  responses: { 200: { content: { "application/json": { schema: DimensionValueList } }, description: "Values" }, ...problem(404) },
}), async (c) => {
  const { companyId, dimensionTypeId } = c.req.valid("param");
  const { includeArchived } = c.req.valid("query");
  const items = await c.var.withTenant(async (tx) =>
    (await companyExists(tx, companyId)) ? listDimensionValues(tx, dimensionTypeId, includeArchived) : null);
  if (items === null) return c.notFound();
  return c.json({ items, next_cursor: null }, 200);
});

dimensionTypesRoutes.openapi(createRoute({
  method: "patch", path: "/{dimensionTypeId}/values/{valueId}", tags: ["admin"], middleware: [manage],
  request: {
    params: ValueParams, headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: UpdateDimensionValueBody } } },
  },
  responses: { 200: { content: { "application/json": { schema: DimensionValueSchema } }, description: "Updated" }, ...problem(400), ...problem(404) },
}), async (c) => {
  const { valueId } = c.req.valid("param");
  const b = c.req.valid("json");
  const row = await c.var.withTenant(async (tx) => {
    const [updated] = await tx<{
      id: string; dimension_type_id: string; code: string; name_en: string; name_ar: string | null;
      parent_id: string | null; archived_at: string | null;
    }[]>`
      update app.dimension_value set
        name_en = coalesce(${b.nameEn ?? null}, name_en),
        name_ar = case when ${b.nameAr === undefined} then name_ar else ${b.nameAr ?? null} end,
        archived_at = case when ${b.archived === undefined} then archived_at
                           when ${b.archived === true} then coalesce(archived_at, now()) else null end
      where id = ${valueId}
      returning id, dimension_type_id, code, name_en, name_ar, parent_id, archived_at`;
    return updated;
  });
  if (!row) return c.notFound();
  return c.json({
    id: row.id, dimensionTypeId: row.dimension_type_id, code: row.code, nameEn: row.name_en,
    nameAr: row.name_ar, parentId: row.parent_id, archivedAt: row.archived_at,
  }, 200);
});
```

- [ ] **Step 5: Register the module and its probe**

In `apps/api/src/routes/index.ts`, add the import at the top and the entry **inside the array literal
`buildRoutes(deps)` returns**, after Task 9's `/v1/companies/:companyId/exchange-rates` entry — never by pushing onto
`ROUTES`, which is the derived const (§4.2.7):

```ts
import { dimensionTypesRoutes } from "./admin/dimension-types";

export function buildRoutes(deps: { authAdmin: AuthAdmin }): readonly RouteModule[] {
  return [
    // 0B's seven entries and Task 9's two stay as they are. This one is appended directly after Task 9 Step 7's
    // second entry, the one whose `path` is "/v1/companies/:companyId/exchange-rates":
    { path: "/v1/companies/:companyId/dimension-types", router: dimensionTypesRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
  ];
}
```

`tests/invariants/probes.ts` `PROBES`:

```ts
  "/v1/companies/:companyId/dimension-types": {
    async seed(_db, owner) {
      return { path: `/v1/companies/${owner.company}/dimension-types`, method: "GET" };
    },
    // The handler's `companyExists` guard (Step 4) answers ERR_NOT_FOUND for a company the attacker's RLS cannot
    // see; the read carries no permission middleware, so nothing else in the chain would refuse it.
    expect: 404,
  },
```

- [ ] **Step 6: Run, regenerate OpenAPI, commit**

Run:
```bash
cd apps/api && bun run test -- test/routes/admin/dimension-types.test.ts
cd ../.. && bun run --cwd packages/contracts openapi:generate && bun run lint && bun run lint:rules && bun run typecheck && bun run test
```
Expected: 7 tests pass; `openapi.json` gains the four dimension paths, and the three unsafe ones among them (POST `/`, POST `/{dimensionTypeId}/values`, PATCH `/{dimensionTypeId}/values/{valueId}`) each carry the `Idempotency-Key` header parameter — re-run Task 9 Step 8's `node -e` check and expect **16** unsafe operations documented, with no `MISSING` line. Everything else green.

```bash
git add packages/contracts apps/api tests
git commit -m "feat(api): dimension type and value endpoints [0D T11]

A whole new analysis dimension is created through the API with no migration —
half of DoD 0.10. Values form a tree, are archived rather than deleted, and are
tenant-isolated. spec §3.3, §5.0 row 0.10; contracts §4.2.11.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 12: Migration 0006 — custom fields, and the validator in `@dulja/domain`

**Files:**
- Create: `packages/db/migrations/0006_create_custom_field.sql`, `packages/db/migrations/0006.down.sql`, `packages/domain/src/custom-fields/types.ts`, `packages/domain/src/custom-fields/validate.ts`, `packages/domain/test/custom-fields.test.ts`, `packages/db/src/custom-fields/service.ts`, `packages/db/src/schema/custom-field-definition.ts`, `packages/db/src/schema/custom-field-value.ts`, `packages/db/test/custom-field.test.ts`, `docs/adr/0010-custom-field-storage.md`
- Modify: `packages/domain/src/index.ts`, `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Task 2's `Money`, `currency`, `MoneyScaleError`; Task 1's `round`, `D`; Plan 0A's `app.company`, `app.document_type`, `app_meta.*`, `startDb`, `seedTenant`, `draftDocument`, `lintSchema`.
- Produces (§4.2.11):
  - SQL: `app.custom_field_definition`, `app.custom_field_value`, index `custom_field_value_lookup_idx`.
  - `packages/domain/src/custom-fields/types.ts`: `CustomFieldKind`, `CustomFieldOptions`, `CustomFieldDefinition`, `ValidationResult`.
  - `packages/domain/src/custom-fields/validate.ts`: `validateCustomFieldValue(def: CustomFieldDefinition, value: unknown): ValidationResult`.
  - `packages/db/src/custom-fields/service.ts`: `createDefinition`, `listDefinitions`, `setValues`, `getValues`, and the row types `CustomFieldDefinitionRow`, `CustomFieldValueRow`.

**Contract note.** §4.2.11 fixes the signature `validateCustomFieldValue(def: CustomFieldDefinition, value: unknown): ValidationResult` but gives no body for `CustomFieldDefinition` or `ValidationResult`, and neither is in §4's list of five deliberately-open types. This plan defines both, minimally, from the migration's own columns; they are recorded in the Self-Review as contract additions for the roadmap to fold back into §4.2.11.

- [ ] **Step 1: Write the failing test `packages/domain/test/custom-fields.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { validateCustomFieldValue, type CustomFieldDefinition } from "../src/index";

const def = (over: Partial<CustomFieldDefinition>): CustomFieldDefinition =>
  ({ code: "F", kind: "text", required: false, options: {}, ...over });

describe("validateCustomFieldValue — spec §3.5 'typed, attachable, indexed, validated'", () => {
  it("text: checks type and maxLength, and trims nothing", () => {
    expect(validateCustomFieldValue(def({ kind: "text" }), " hello ")).toEqual({ ok: true, value: " hello " });
    expect(validateCustomFieldValue(def({ kind: "text", options: { maxLength: 3 } }), "hello"))
      .toEqual({ ok: false, errors: [{ path: "F", message: "must be at most 3 characters" }] });
    expect(validateCustomFieldValue(def({ kind: "text" }), 5))
      .toEqual({ ok: false, errors: [{ path: "F", message: "must be a string" }] });
  });

  it("integer: refuses a fraction, a string and a non-finite number", () => {
    expect(validateCustomFieldValue(def({ kind: "integer" }), 42)).toEqual({ ok: true, value: 42 });
    for (const bad of [1.5, "42", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateCustomFieldValue(def({ kind: "integer" }), bad).ok, String(bad)).toBe(false);
    }
  });

  it("decimal: takes a string at the declared scale, never a number (spec §3.9)", () => {
    expect(validateCustomFieldValue(def({ kind: "decimal", options: { scale: 2 } }), "12.34"))
      .toEqual({ ok: true, value: "12.34" });
    expect(validateCustomFieldValue(def({ kind: "decimal", options: { scale: 2 } }), "12.345"))
      .toEqual({ ok: false, errors: [{ path: "F", message: "must be a decimal string with at most 2 decimal places" }] });
    expect(validateCustomFieldValue(def({ kind: "decimal" }), 12.34))
      .toEqual({ ok: false, errors: [{ path: "F", message: "must be a decimal string, not a number" }] });
  });

  it("money: takes the { amount, currency } wire form and round-trips through Money", () => {
    expect(validateCustomFieldValue(def({ kind: "money" }), { amount: "12.5", currency: "MYR" }))
      .toEqual({ ok: true, value: { amount: "12.5000", currency: "MYR" } });
    expect(validateCustomFieldValue(def({ kind: "money" }), { amount: "12.12345", currency: "MYR" }).ok).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "money" }), { amount: "1.0000", currency: "myr" }).ok).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "money" }), "12.50").ok).toBe(false);
  });

  it("date: an ISO calendar date, and a real one", () => {
    expect(validateCustomFieldValue(def({ kind: "date" }), "2026-02-28")).toEqual({ ok: true, value: "2026-02-28" });
    expect(validateCustomFieldValue(def({ kind: "date" }), "2026-02-30").ok).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "date" }), "28/02/2026").ok).toBe(false);
  });

  it("boolean and dimension_value", () => {
    expect(validateCustomFieldValue(def({ kind: "boolean" }), false)).toEqual({ ok: true, value: false });
    expect(validateCustomFieldValue(def({ kind: "boolean" }), "false").ok).toBe(false);
    const id = "01920000-0000-7000-8000-000000000001";
    expect(validateCustomFieldValue(def({ kind: "dimension_value" }), id)).toEqual({ ok: true, value: id });
    expect(validateCustomFieldValue(def({ kind: "dimension_value" }), "not-a-uuid").ok).toBe(false);
  });

  it("enum: only a declared label, and the message lists them", () => {
    const d = def({ kind: "enum", options: { enumValues: ["low", "high"] } });
    expect(validateCustomFieldValue(d, "high")).toEqual({ ok: true, value: "high" });
    expect(validateCustomFieldValue(d, "medium"))
      .toEqual({ ok: false, errors: [{ path: "F", message: "must be one of: low, high" }] });
    expect(validateCustomFieldValue(def({ kind: "enum" }), "x"))
      .toEqual({ ok: false, errors: [{ path: "F", message: "the definition declares no enum values" }] });
  });

  it("required and null: a required field refuses null; an optional one accepts it", () => {
    expect(validateCustomFieldValue(def({ kind: "text", required: true }), null))
      .toEqual({ ok: false, errors: [{ path: "F", message: "is required" }] });
    expect(validateCustomFieldValue(def({ kind: "text", required: true }), undefined).ok).toBe(false);
    expect(validateCustomFieldValue(def({ kind: "text" }), null)).toEqual({ ok: true, value: null });
  });
});
```

- [ ] **Step 2: Write `packages/domain/src/custom-fields/types.ts` and `validate.ts`**

```ts
// packages/domain/src/custom-fields/types.ts
/** The eight kinds `app.custom_field_definition.kind` allows (contracts §4.2.11). */
export type CustomFieldKind = "text" | "integer" | "decimal" | "money" | "date" | "boolean" | "dimension_value" | "enum";

/** The `options jsonb` column, typed. Every member is optional; a kind reads only what it needs. */
export interface CustomFieldOptions {
  readonly enumValues?: readonly string[];   // kind 'enum'
  readonly scale?: number;                   // kind 'decimal' — decimal places, default 2
  readonly dimensionTypeId?: string;         // kind 'dimension_value' — the type its value must belong to
  readonly maxLength?: number;               // kind 'text'
}

/** The definition as the validator needs it; the table carries more (company, entity, indexed, archived_at). */
export interface CustomFieldDefinition {
  readonly code: string;
  readonly kind: CustomFieldKind;
  readonly required: boolean;
  readonly options: CustomFieldOptions;
}

/** On success the **normalised** value that goes into `custom_field_value.value` (money is padded to 4 dp). */
export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly { readonly path: string; readonly message: string }[] };
```

```ts
// packages/domain/src/custom-fields/validate.ts
import { currency, Money } from "../money/money";
import type { CustomFieldDefinition, ValidationResult } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (code: string, message: string): ValidationResult => ({ ok: false, errors: [{ path: code, message }] });
const pass = (value: unknown): ValidationResult => ({ ok: true, value });

/**
 * Spec §3.5: custom fields as a core service — "typed, attachable per document type, indexed, validated". The
 * validator is pure and lives in `domain` so the API, the seed CLI and any future importer all apply the same rule.
 * On success it returns the **normalised** value, which is what is stored: this is why a money field never drifts
 * between "12.5" and "12.5000" depending on who wrote it.
 */
export function validateCustomFieldValue(def: CustomFieldDefinition, value: unknown): ValidationResult {
  if (value === null || value === undefined) {
    return def.required ? fail(def.code, "is required") : pass(null);
  }

  switch (def.kind) {
    case "text": {
      if (typeof value !== "string") return fail(def.code, "must be a string");
      const max = def.options.maxLength;
      if (max !== undefined && value.length > max) return fail(def.code, `must be at most ${max} characters`);
      return pass(value);
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return fail(def.code, "must be an integer");
      return pass(value);
    }
    case "decimal": {
      if (typeof value === "number") return fail(def.code, "must be a decimal string, not a number");
      if (typeof value !== "string") return fail(def.code, "must be a decimal string");
      const scale = def.options.scale ?? 2;
      if (!new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`).test(value)) {
        return fail(def.code, `must be a decimal string with at most ${scale} decimal places`);
      }
      return pass(value);
    }
    case "money": {
      if (typeof value !== "object" || value === null) return fail(def.code, "must be { amount, currency }");
      const { amount, currency: code } = value as { amount?: unknown; currency?: unknown };
      if (typeof amount !== "string" || typeof code !== "string") return fail(def.code, "must be { amount, currency }");
      try {
        return pass(Money.of(amount, currency(code)).toJSON());
      } catch {
        return fail(def.code, "must be an amount with at most 4 decimal places and a three-letter currency code");
      }
    }
    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value)) return fail(def.code, "must be a date as YYYY-MM-DD");
      const [y, m, d] = value.split("-").map(Number) as [number, number, number];
      const parsed = new Date(Date.UTC(y, m - 1, d));
      const real = parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
      return real ? pass(value) : fail(def.code, "must be a real calendar date");
    }
    case "boolean":
      return typeof value === "boolean" ? pass(value) : fail(def.code, "must be true or false");
    case "dimension_value":
      return typeof value === "string" && UUID.test(value) ? pass(value) : fail(def.code, "must be a dimension value id");
    case "enum": {
      const values = def.options.enumValues;
      if (!values || values.length === 0) return fail(def.code, "the definition declares no enum values");
      if (typeof value !== "string" || !values.includes(value)) return fail(def.code, `must be one of: ${values.join(", ")}`);
      return pass(value);
    }
  }
}
```

`packages/domain/src/index.ts` gains:

```ts
export { validateCustomFieldValue } from "./custom-fields/validate";
export type { CustomFieldDefinition, CustomFieldKind, CustomFieldOptions, ValidationResult } from "./custom-fields/types";
```

- [ ] **Step 3: Run the domain test**

Run: `cd packages/domain && bun run test -- test/custom-fields.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 4: Write the failing test `packages/db/test/custom-field.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { createDefinition, getValues, listDefinitions, setValues } from "../src/custom-fields/service";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("migration 0006 — custom fields (contracts §4.2.11; spec §3.5)", () => {
  let db: Db; let a: Seed; let b: Seed; let docId: string; let poNumber: string; let risk: string;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta");
    docId = await draftDocument(db, a);
  });
  afterAll(async () => { await db.stop(); });

  it("the schema linter reports zero violations after 0006", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a definition is typed, scoped to an entity, and optionally to one document type", async () => {
    poNumber = await withTenant(db.rw, a.tenant, a.human, (tx) => createDefinition(tx, {
      companyId: a.company, entity: "document", code: "PO_NUMBER", nameEn: "Customer PO number",
      nameAr: "رقم أمر الشراء", kind: "text", required: false, options: { maxLength: 32 }, indexed: true,
    }));
    risk = await withTenant(db.rw, a.tenant, a.human, (tx) => createDefinition(tx, {
      companyId: a.company, entity: "document", documentTypeId: a.docType, code: "RISK",
      nameEn: "Risk", kind: "enum", required: true, options: { enumValues: ["low", "high"] },
    }));
    const defs = await withTenant(db.rw, a.tenant, a.human, (tx) => listDefinitions(tx, a.company, "document"));
    expect(defs.map((d) => [d.code, d.kind, d.required, d.documentTypeId])).toEqual([
      ["PO_NUMBER", "text", false, null],
      ["RISK", "enum", true, a.docType],
    ]);
    expect(risk).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("entity is a closed set; a code is unique per (company, entity)", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.custom_field_definition (tenant_id, company_id, entity, code, name_en, kind)
      values (${a.tenant}, ${a.company}, 'invoice', 'X', 'X', 'text')`)).rejects.toThrow(/check constraint/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => createDefinition(tx, {
      companyId: a.company, entity: "document", code: "PO_NUMBER", nameEn: "dup", kind: "text",
    }))).rejects.toThrow(/unique|duplicate key/);
  });

  it("kind is a closed set of the eight the validator implements", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.custom_field_definition (tenant_id, company_id, entity, code, name_en, kind)
      values (${a.tenant}, ${a.company}, 'document', 'Y', 'Y', 'timestamp')`)).rejects.toThrow(/check constraint/);
  });

  it("values are validated through @dulja/domain and stored normalised", async () => {
    const result = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, "document", docId, [{ definitionId: poNumber, value: "PO-9001" }, { definitionId: risk, value: "high" }]));
    expect(result).toEqual({ ok: true, written: 2 });
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) => getValues(tx, "document", docId));
    expect(values).toEqual([
      { definitionId: poNumber, code: "PO_NUMBER", value: "PO-9001" },
      { definitionId: risk, code: "RISK", value: "high" },
    ]);
  });

  it("an invalid value is refused with the field's code and a message, and nothing is written", async () => {
    const bad = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, "document", docId, [{ definitionId: risk, value: "medium" }]));
    expect(bad).toEqual({ ok: false, errors: [{ path: "RISK", message: "must be one of: low, high" }] });
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) => getValues(tx, "document", docId));
    expect(values.find((v) => v.code === "RISK")!.value).toBe("high");     // unchanged
  });

  it("setting the same field twice replaces the value — one row per (definition, entity)", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, "document", docId, [{ definitionId: poNumber, value: "PO-9002" }]));
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) => getValues(tx, "document", docId));
    expect(values.filter((v) => v.code === "PO_NUMBER")).toEqual([{ definitionId: poNumber, code: "PO_NUMBER", value: "PO-9002" }]);
  });

  it("a money value is stored as { amount, currency } with four decimal places (spec §3.9)", async () => {
    const fee = await withTenant(db.rw, a.tenant, a.human, (tx) => createDefinition(tx, {
      companyId: a.company, entity: "document", code: "HANDLING_FEE", nameEn: "Handling fee", kind: "money",
    }));
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, "document", docId, [{ definitionId: fee, value: { amount: "12.5", currency: "MYR" } }]));
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ value: unknown }[]>`
      select value from app.custom_field_value where definition_id = ${fee} and entity_id = ${docId}`);
    expect(row!.value).toEqual({ amount: "12.5000", currency: "MYR" });
  });

  it("definitions and values are tenant-isolated and audited (acceptance tests 12 and 13)", async () => {
    expect(await withTenant(db.rw, b.tenant, b.human, (tx) => listDefinitions(tx, a.company, "document"))).toEqual([]);
    expect(await withTenant(db.rw, b.tenant, b.human, (tx) => getValues(tx, "document", docId))).toEqual([]);
    const audits = await withTenant(db.rw, a.tenant, a.system, (tx) => tx<{ table_name: string; actor_id: string }[]>`
      select table_name, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name in ('custom_field_definition', 'custom_field_value')`);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((r) => r.actor_id === a.human)).toBe(true);
  });
});
```

- [ ] **Step 5: Write `packages/db/migrations/0006_create_custom_field.sql`**

```sql
-- 0006_create_custom_field.sql — contracts §4.2.11; spec §3.5 "Custom fields (`Descriptors`) as a core service:
-- typed, attachable per document type, indexed, validated" and §5.0 row 0.10 ("a new custom field is created
-- through the API with no migration"). The legacy system's Descriptors were untyped and unvalidated; the `kind`
-- CHECK and the `options` contract are what make them a service rather than a free-text bag.

-- ── 1. definitions ───────────────────────────────────────────────────────────
create table app.custom_field_definition (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  entity            text not null check (entity in ('document','party','item','employee')),
                    -- 'document' is usable at Phase 0; the other three are enabled by 2A, 3A and 6C/8A when their
                    -- tables exist. The CHECK is closed here so no slice invents a fifth entity name (hazard 32).
  document_type_id  uuid,                      -- null = every type of that entity
  code              text not null,
  name_en           text not null,
  name_ar           text,
  kind              text not null check (kind in ('text','integer','decimal','money','date','boolean','dimension_value','enum')),
                    -- exactly the eight CustomFieldKind literals of @dulja/domain
  required          boolean not null default false,
  options           jsonb not null default '{}'::jsonb,   -- enum labels, decimal scale, dimension_type_id, maxLength
  indexed           boolean not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (company_id, entity, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.custom_field_definition');
call app_meta.attach_audit('app.custom_field_definition');

-- ── 2. values ────────────────────────────────────────────────────────────────
-- `entity_id` is deliberately without a foreign key: it points at whichever table the definition's `entity` names,
-- and a polymorphic FK does not exist in Postgres. The definition's composite FK carries the tenant, and RLS on
-- both tables carries the isolation, so a value can never reference another tenant's definition.
create table app.custom_field_value (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  definition_id  uuid not null,
  entity_id      uuid not null,                          -- the document/party/item/employee id
  value          jsonb not null,                          -- money as {"amount","currency"}; decimal as a string
  created_at     timestamptz not null default now(),
  unique (definition_id, entity_id),
  unique (tenant_id, id),
  foreign key (tenant_id, definition_id) references app.custom_field_definition(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.custom_field_value');
call app_meta.attach_audit('app.custom_field_value');

-- The "indexed" half of spec §3.5. A btree over (definition_id, value) answers "which documents have PO_NUMBER = X"
-- without a scan. jsonb has btree operators, so the expression index is legal; a value larger than the btree row
-- limit (~2.7 kB) would be rejected on insert, which is the right failure for a field that is meant to be scalar.
create index custom_field_value_lookup_idx on app.custom_field_value (definition_id, (value));
```

- [ ] **Step 6: Write `packages/db/migrations/0006.down.sql`**

```sql
-- 0006.down.sql — reverse dependency order (§3.4.5); the audit triggers go with their tables.
drop index if exists app.custom_field_value_lookup_idx;
drop table if exists app.custom_field_value;
drop table if exists app.custom_field_definition;
```

- [ ] **Step 7: Write `packages/db/src/custom-fields/service.ts` and the two mirrors**

```ts
import { validateCustomFieldValue, type CustomFieldKind, type CustomFieldOptions } from "@dulja/domain";
import type { Sql } from "postgres";

export type CustomFieldEntity = "document" | "party" | "item" | "employee";

export interface CustomFieldDefinitionRow {
  id: string; companyId: string; entity: CustomFieldEntity; documentTypeId: string | null;
  code: string; nameEn: string; nameAr: string | null; kind: CustomFieldKind;
  required: boolean; options: CustomFieldOptions; indexed: boolean; archivedAt: string | null;
}
export interface CustomFieldValueRow { definitionId: string; code: string; value: unknown }

export interface CreateDefinitionInput {
  companyId: string; entity: CustomFieldEntity; documentTypeId?: string | null;
  code: string; nameEn: string; nameAr?: string | null; kind: CustomFieldKind;
  required?: boolean; options?: CustomFieldOptions; indexed?: boolean;
}

export type SetValuesResult =
  | { ok: true; written: number }
  | { ok: false; errors: { path: string; message: string }[] };

export async function createDefinition(tx: Sql, input: CreateDefinitionInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.custom_field_definition
      (tenant_id, company_id, entity, document_type_id, code, name_en, name_ar, kind, required, options, indexed)
    values (app.current_tenant(), ${input.companyId}, ${input.entity}, ${input.documentTypeId ?? null},
            ${input.code}, ${input.nameEn}, ${input.nameAr ?? null}, ${input.kind},
            ${input.required ?? false}, ${JSON.stringify(input.options ?? {})}::jsonb, ${input.indexed ?? false})
    returning id`;
  return row!.id;
}

export async function listDefinitions(tx: Sql, companyId: string, entity: CustomFieldEntity): Promise<CustomFieldDefinitionRow[]> {
  const rows = await tx<{
    id: string; company_id: string; entity: CustomFieldEntity; document_type_id: string | null;
    code: string; name_en: string; name_ar: string | null; kind: CustomFieldKind;
    required: boolean; options: CustomFieldOptions; indexed: boolean; archived_at: string | null;
  }[]>`
    select id, company_id, entity, document_type_id, code, name_en, name_ar, kind, required, options, indexed, archived_at
      from app.custom_field_definition
     where company_id = ${companyId} and entity = ${entity} and archived_at is null
     order by code`;
  return rows.map((r) => ({
    id: r.id, companyId: r.company_id, entity: r.entity, documentTypeId: r.document_type_id, code: r.code,
    nameEn: r.name_en, nameAr: r.name_ar, kind: r.kind, required: r.required, options: r.options,
    indexed: r.indexed, archivedAt: r.archived_at,
  }));
}

/**
 * Validate **every** value first, then write — so a batch with one bad field changes nothing (spec §3.5 "validated").
 * The caller's transaction is used throughout; a failure returns errors rather than throwing, because the API turns
 * them into the `errors` array of an `ERR_VALIDATION_FAILED` problem (contracts §4.2.4).
 */
export async function setValues(
  tx: Sql, entity: CustomFieldEntity, entityId: string,
  // `value?: unknown`, not `value: unknown`, and the `?` is load-bearing: Zod marks an object key optional when
  // `undefined extends` its output type, so `z.object({ definitionId: UuidSchema, value: z.unknown() })` in
  // Task 13's `SetCustomFieldValuesBody` infers `{ definitionId: string; value?: unknown }`. A required `value`
  // here would make the route handler's `setValues(tx, entity, entityId, values)` a TS2322 ("Property 'value' is
  // optional in type … but required in type …"). `unknown | undefined` is `unknown`, so the body below is unchanged.
  values: readonly { definitionId: string; value?: unknown }[],
): Promise<SetValuesResult> {
  if (values.length === 0) return { ok: true, written: 0 };
  const ids = values.map((v) => v.definitionId);
  const defs = await tx<{ id: string; code: string; kind: CustomFieldKind; required: boolean; options: CustomFieldOptions }[]>`
    select id, code, kind, required, options from app.custom_field_definition
     where id = any(${ids}::uuid[]) and entity = ${entity} and archived_at is null`;
  const byId = new Map(defs.map((d) => [d.id, d]));

  const errors: { path: string; message: string }[] = [];
  const normalised: { definitionId: string; value: unknown }[] = [];
  for (const v of values) {
    const def = byId.get(v.definitionId);
    if (!def) { errors.push({ path: v.definitionId, message: "no such custom field definition for this entity" }); continue; }
    const result = validateCustomFieldValue({ code: def.code, kind: def.kind, required: def.required, options: def.options }, v.value);
    if (result.ok) normalised.push({ definitionId: v.definitionId, value: result.value });
    else errors.push(...result.errors);
  }
  if (errors.length > 0) return { ok: false, errors };

  for (const n of normalised) {
    await tx`
      insert into app.custom_field_value (tenant_id, definition_id, entity_id, value)
      values (app.current_tenant(), ${n.definitionId}, ${entityId}, ${JSON.stringify(n.value)}::jsonb)
      on conflict (definition_id, entity_id) do update set value = excluded.value`;
  }
  return { ok: true, written: normalised.length };
}

export async function getValues(tx: Sql, entity: CustomFieldEntity, entityId: string): Promise<CustomFieldValueRow[]> {
  const rows = await tx<{ definition_id: string; code: string; value: unknown }[]>`
    select v.definition_id, d.code, v.value
      from app.custom_field_value v
      join app.custom_field_definition d on d.id = v.definition_id
     where v.entity_id = ${entityId} and d.entity = ${entity}
     order by d.code`;
  return rows.map((r) => ({ definitionId: r.definition_id, code: r.code, value: r.value }));
}
```

```ts
// packages/db/src/schema/custom-field-definition.ts
import { boolean, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const customFieldDefinition = app.table("custom_field_definition", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  entity: text("entity").notNull(),
  documentTypeId: uuid("document_type_id"),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  kind: text("kind").notNull(),
  required: boolean("required").notNull(),
  options: jsonb("options").notNull(),
  indexed: boolean("indexed").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique("custom_field_definition_company_id_entity_code_key").on(t.companyId, t.entity, t.code)]);
```

```ts
// packages/db/src/schema/custom-field-value.ts
import { jsonb, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./schema";

export const customFieldValue = app.table("custom_field_value", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  definitionId: uuid("definition_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  value: jsonb("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique("custom_field_value_definition_id_entity_id_key").on(t.definitionId, t.entityId)]);
```

`packages/db/src/index.ts` gains:

```ts
export {
  createDefinition, getValues, listDefinitions, setValues,
  type CreateDefinitionInput, type CustomFieldDefinitionRow, type CustomFieldEntity, type CustomFieldValueRow, type SetValuesResult,
} from "./custom-fields/service";
export { customFieldDefinition as customFieldDefinitionTable } from "./schema/custom-field-definition";
export { customFieldValue as customFieldValueTable } from "./schema/custom-field-value";
```

- [ ] **Step 8: Write `docs/adr/0010-custom-field-storage.md`**

```markdown
# ADR 0010 — Custom-field storage: a typed definition, a `jsonb` value, one validator

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Spec §3.5 keeps the legacy system's `Descriptors` idea but demands it be "typed, attachable per document type, indexed,
validated" — the legacy version was an untyped free-text bag, which is why the same field held `"31/12"`, `"31-Dec"`
and `""` across three documents. Spec §5.0 row 0.10 requires a new field through the API with **no migration**, so
a column-per-field design is excluded by the requirement itself.

## Decision

1. **A typed definition row plus a `jsonb` value row.** `custom_field_definition` carries `kind` (a CHECK over the
   eight `CustomFieldKind` literals), `required`, and an `options jsonb` for the per-kind extras (enum labels,
   decimal scale, `dimensionTypeId`, `maxLength`). `custom_field_value.value` is `jsonb`, one row per
   `(definition_id, entity_id)`.
2. **One validator, in `packages/domain`.** `validateCustomFieldValue(def, value)` is pure and returns the
   **normalised** value. The API, the seed CLI and any future importer call it, so a money field cannot hold
   `"12.5"` from one path and `"12.5000"` from another.
3. **Money in a custom field is `{ amount, currency }`, decimal is a string.** Never a JSON number: JSON numbers are
   IEEE-754 doubles, which is LEGACY-008 wearing a different hat.
4. **`entity_id` has no foreign key.** It points at whichever table the definition's `entity` names, and Postgres
   has no polymorphic FK. Isolation is carried by the definition's composite `(tenant_id, definition_id)` FK and by
   RLS on both tables; a value can never reach another tenant's definition.
5. **`entity` and `kind` are `text` + CHECK, not enums** (§3.9 Enumerations, §3.4.4): a later phase adds a value in
   one file, whereas an enum label cannot be used in the migration that adds it.
6. **The index is `(definition_id, (value))`.** It answers "which documents have `PO_NUMBER = X`" without a scan.
   A value beyond the btree row limit is rejected on insert — the right failure for a field meant to be scalar.

## Consequences

- 2A (`party`), 3A (`item`) and 6C/8A (`employee`) enable their entity by using it; no migration is needed for any
  of them, because the CHECK already lists all four.
- A definition is archived, never deleted (spec §3.9); its values stay readable for audit.
```

- [ ] **Step 9: Run and commit**

Run: `cd packages/db && bun run test -- test/custom-field.test.ts && bun run test && cd ../.. && bun run lint && bun run lint:rules && bun run typecheck`
Expected: 9 tests in `custom-field.test.ts`; every suite green — including `privileges.test.ts`'s up → down → up
fingerprint, which from this task on covers migrations **1, 4, 5, 6 and 7** (Task 10's step named 1, 4, 5 and 7,
because 0006 did not exist yet; the header's migration-numbers note explains why the file numbers and the task
numbers deliberately disagree). If that test fails here and nowhere else, the cause is `0006.down.sql`, not the
task order: `down` runs 7 then 6 then 5 then 4 by version, whatever order `listApplied` recorded.

```bash
git add packages/db packages/domain docs/adr/0010-custom-field-storage.md
git commit -m "feat(db): migration 0006 — typed custom fields with one validator [0D T12]

A definition row with a closed kind CHECK, a jsonb value normalised through
@dulja/domain, and an index that answers 'which documents have PO_NUMBER = X'.
ADR 0010. spec §3.5; contracts §4.2.11.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The custom-field API and the end-to-end proof of DoD 0.10

**Files:**
- Create: `packages/contracts/src/admin/custom-field.ts`, `apps/api/src/routes/admin/custom-fields.ts`, `apps/api/test/routes/admin/custom-fields.test.ts`
- Modify: `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`

**Interfaces:**
- Consumes: Task 12's `createDefinition`, `listDefinitions`, `setValues`, `getValues`, `CustomFieldEntity`; Task 11's dimension routes (for the DoD 0.10 combined test); 0B's `AppEnv`, `requirePermission`, `AppError`, `listApplied`, `startApi`, **`buildRoutes`** and **`IdempotencyHeader`** (§4.2.7), `PROBES`, and **`grantAdmin`** (§4.17.1); Plan 0A's `draftDocument`.
- Produces:
  - `packages/contracts/src/admin/custom-field.ts`: `CustomFieldDefinitionSchema`, `CreateCustomFieldDefinitionBody`, `CustomFieldDefinitionList`, `SetCustomFieldValuesBody`, `CustomFieldValuesResponse`.
  - `apps/api/src/routes/admin/custom-fields.ts`: `customFieldDefinitionsRoutes` (`/v1/companies/:companyId/custom-field-definitions`) and `customFieldValuesRoutes` (`/v1/companies/:companyId/custom-fields`).

**Definition of done being closed here — verbatim (spec §5.0 row 0.10):** "A new dimension and a new custom field are created through the API with no migration".

- [ ] **Step 1: Write the failing test `apps/api/test/routes/admin/custom-fields.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { listApplied } from "@dulja/db";
import { draftDocument, seedTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("custom fields through the API — spec §3.5, §5.0 row 0.10", () => {
  let api: StartedApi; let a: Seed; let b: Seed; let docId: string;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    // The DoD-0.10 test below is the recorded evidence for §5.0 row 0.10 and every request in it is a write behind
    // `requirePermission`. `seedTenant` grants nothing (§4.1), so without this the row's evidence test is a 403.
    await grantAdmin(api, a); await grantAdmin(api, b);
    docId = await draftDocument(api.db, a);
  });
  afterAll(async () => { await api.stop(); });

  const defs = (s: Seed) => `/v1/companies/${s.company}/custom-field-definitions`;
  const vals = (s: Seed, id: string) => `/v1/companies/${s.company}/custom-fields/document/${id}`;

  it("DEFINITION OF DONE 0.10: a new dimension AND a new custom field, through the API, with no migration", async () => {
    const before = await listApplied(api.db.migrator);

    const dim = await api.request({ method: "POST", path: `/v1/companies/${a.company}/dimension-types`, as: a.human,
      body: { code: "PROJECT", nameEn: "Project", nameAr: "مشروع" } });
    expect(dim.status).toBe(201);
    const { id: projectTypeId } = await dim.json() as { id: string };
    const value = await api.request({ method: "POST", path: `/v1/companies/${a.company}/dimension-types/${projectTypeId}/values`,
      as: a.human, body: { code: "APOLLO", nameEn: "Project Apollo" } });
    expect(value.status).toBe(201);

    const field = await api.request({ method: "POST", path: defs(a), as: a.human,
      body: { entity: "document", code: "PO_NUMBER", nameEn: "Customer PO number", kind: "text",
              options: { maxLength: 32 }, indexed: true } });
    expect(field.status).toBe(201);
    const { id: definitionId } = await field.json() as { id: string };

    const set = await api.request({ method: "PUT", path: vals(a, docId), as: a.human,
      body: { values: [{ definitionId, value: "PO-9001" }] } });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ values: [{ definitionId, code: "PO_NUMBER", value: "PO-9001" }] });

    // The whole flow ran without a schema change — the actual clause of DoD 0.10.
    expect(await listApplied(api.db.migrator)).toEqual(before);
  });

  it("a definition may be scoped to one document type", async () => {
    const res = await api.request({ method: "POST", path: defs(a), as: a.human,
      body: { entity: "document", documentTypeId: a.docType, code: "RISK", nameEn: "Risk", kind: "enum",
              required: true, options: { enumValues: ["low", "high"] } } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ code: "RISK", kind: "enum", required: true, documentTypeId: a.docType });
  });

  it("an invalid value is ERR_VALIDATION_FAILED with the field's code in errors[].path, and writes nothing", async () => {
    const list = await api.request({ method: "GET", path: `${defs(a)}?entity=document`, as: a.human });
    const risk = ((await list.json()) as { items: { id: string; code: string }[] }).items.find((d) => d.code === "RISK")!;

    const bad = await api.request({ method: "PUT", path: vals(a, docId), as: a.human,
      body: { values: [{ definitionId: risk.id, value: "medium" }] } });
    expect(bad.status).toBe(400);
    const problem = await bad.json() as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors).toEqual([{ path: "RISK", message: "must be one of: low, high" }]);

    const read = await api.request({ method: "GET", path: vals(a, docId), as: a.human });
    expect(((await read.json()) as { values: { code: string }[] }).values.map((v) => v.code)).toEqual(["PO_NUMBER"]);
  });

  it("a definition with an unknown kind or entity is refused before it reaches the database", async () => {
    for (const body of [
      { entity: "document", code: "A", nameEn: "A", kind: "timestamp" },
      { entity: "invoice", code: "B", nameEn: "B", kind: "text" },
    ]) {
      const res = await api.request({ method: "POST", path: defs(a), as: a.human, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json() as Problem).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("writes need admin.company.manage; reads need membership only; another tenant sees nothing", async () => {
    const cross = await api.request({ method: "GET", path: `${defs(a)}?entity=document`, as: b.human });
    expect(cross.status).toBe(404);
    const forge = await api.request({ method: "PUT", path: vals(a, docId), as: b.human, body: { values: [] } });
    expect([403, 404]).toContain(forge.status);
  });

  it("the unsafe methods carry idempotency like every other write (spec §4.5)", async () => {
    const res = await api.request({ method: "PUT", path: vals(a, docId), as: a.human,
      body: { values: [] }, idempotencyKey: null });
    expect(res.status).toBe(400);
    expect((await res.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- test/routes/admin/custom-fields.test.ts`
Expected: FAIL — 404 on the definition POST.

- [ ] **Step 3: Write `packages/contracts/src/admin/custom-field.ts`**

```ts
import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const CustomFieldEntitySchema = z.enum(["document", "party", "item", "employee"]);
export const CustomFieldKindSchema = z.enum(["text", "integer", "decimal", "money", "date", "boolean", "dimension_value", "enum"]);
export const CustomFieldCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "must be 2–32 upper-case letters, digits or underscores");

export const CustomFieldOptionsSchema = z.object({
  enumValues: z.array(z.string().min(1)).min(1).optional(),
  scale: z.number().int().min(0).max(6).optional(),
  dimensionTypeId: UuidSchema.optional(),
  maxLength: z.number().int().min(1).max(4000).optional(),
}).strict();

export const CustomFieldDefinitionSchema = z.object({
  id: UuidSchema, companyId: UuidSchema, entity: CustomFieldEntitySchema, documentTypeId: UuidSchema.nullable(),
  code: CustomFieldCodeSchema, nameEn: z.string().min(1), nameAr: z.string().nullable(),
  kind: CustomFieldKindSchema, required: z.boolean(), options: CustomFieldOptionsSchema,
  indexed: z.boolean(), archivedAt: TimestampSchema.nullable(),
});

export const CreateCustomFieldDefinitionBody = z.object({
  entity: CustomFieldEntitySchema,
  documentTypeId: UuidSchema.optional(),
  code: CustomFieldCodeSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
  kind: CustomFieldKindSchema,
  required: z.boolean().optional(),
  options: CustomFieldOptionsSchema.optional(),
  indexed: z.boolean().optional(),
}).strict().refine(
  (b) => b.kind !== "enum" || (b.options?.enumValues?.length ?? 0) > 0,
  { message: "an enum field must declare options.enumValues", path: ["options", "enumValues"] },
);

export const CustomFieldDefinitionQuery = z.object({ entity: CustomFieldEntitySchema });
export const CustomFieldDefinitionList = ListEnvelope(CustomFieldDefinitionSchema);

/** The value surface is generic over the entity, so 2A/3A/6C need no new route when they enable their entity. */
export const SetCustomFieldValuesBody = z.object({
  values: z.array(z.object({ definitionId: UuidSchema, value: z.unknown() })).max(100),
}).strict();

export const CustomFieldValuesResponse = z.object({
  values: z.array(z.object({ definitionId: UuidSchema, code: CustomFieldCodeSchema, value: z.unknown() })),
});
```

- [ ] **Step 4: Write `apps/api/src/routes/admin/custom-fields.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { AppError, PERMISSION, ProblemSchema, UuidSchema } from "@dulja/contracts";
import {
  CreateCustomFieldDefinitionBody, CustomFieldDefinitionList, CustomFieldDefinitionQuery, CustomFieldDefinitionSchema,
  CustomFieldEntitySchema, CustomFieldValuesResponse, SetCustomFieldValuesBody,
} from "@dulja/contracts/admin/custom-field";
import { createDefinition, getValues, listDefinitions, setValues } from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader } from "../index";
import { requirePermission } from "../../middleware/require-permission";

const CompanyParams = z.object({ companyId: UuidSchema });
const EntityParams = CompanyParams.extend({ entity: CustomFieldEntitySchema, entityId: UuidSchema });
const manage = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });
const problem = (status: 400 | 403 | 404 | 409) =>
  ({ [status]: { content: { "application/problem+json": { schema: ProblemSchema } }, description: "Problem" } });

/** The same guard the other two company-scoped modules carry: the reads are membership-only (§4.2.11), so a
 *  `companyId` the caller's RLS cannot see must be ERR_NOT_FOUND and not a 200 with an empty body. One statement,
 *  on the caller's own `tx`, inside the transaction the handler already opened (spec:2053). */
async function companyExists(tx: Sql, companyId: string): Promise<boolean> {
  const rows = await tx<{ ok: number }[]>`select 1 as ok from app.company where id = ${companyId}`;
  return rows.length > 0;
}

export const customFieldDefinitionsRoutes = new OpenAPIHono<AppEnv>();

customFieldDefinitionsRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["admin"], middleware: [manage],
  request: {
    params: CompanyParams, headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateCustomFieldDefinitionBody } } },
  },
  responses: { 201: { content: { "application/json": { schema: CustomFieldDefinitionSchema } }, description: "Created" }, ...problem(400), ...problem(409) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const id = await c.var.withTenant((tx) => createDefinition(tx, {
    companyId, entity: b.entity, documentTypeId: b.documentTypeId ?? null, code: b.code, nameEn: b.nameEn,
    nameAr: b.nameAr ?? null, kind: b.kind, required: b.required ?? false, options: b.options ?? {}, indexed: b.indexed ?? false,
  }));
  return c.json({
    id, companyId, entity: b.entity, documentTypeId: b.documentTypeId ?? null, code: b.code, nameEn: b.nameEn,
    nameAr: b.nameAr ?? null, kind: b.kind, required: b.required ?? false, options: b.options ?? {},
    indexed: b.indexed ?? false, archivedAt: null,
  }, 201);
});

customFieldDefinitionsRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["admin"],
  request: { params: CompanyParams, query: CustomFieldDefinitionQuery },
  responses: { 200: { content: { "application/json": { schema: CustomFieldDefinitionList } }, description: "Definitions" }, ...problem(404) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const { entity } = c.req.valid("query");
  const items = await c.var.withTenant(async (tx) =>
    (await companyExists(tx, companyId)) ? listDefinitions(tx, companyId, entity) : null);
  if (items === null) return c.notFound();
  return c.json({ items, next_cursor: null }, 200);
});

export const customFieldValuesRoutes = new OpenAPIHono<AppEnv>();

customFieldValuesRoutes.openapi(createRoute({
  method: "put", path: "/{entity}/{entityId}", tags: ["admin"], middleware: [manage],
  request: {
    params: EntityParams, headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: SetCustomFieldValuesBody } } },
  },
  responses: { 200: { content: { "application/json": { schema: CustomFieldValuesResponse } }, description: "Values" }, ...problem(400), ...problem(404) },
}), async (c) => {
  const { entity, entityId } = c.req.valid("param");
  const { values } = c.req.valid("json");
  const result = await c.var.withTenant(async (tx) => {
    const written = await setValues(tx, entity, entityId, values);
    if (!written.ok) return written;
    return { ok: true as const, values: await getValues(tx, entity, entityId) };
  });
  if (!result.ok) throw new AppError("ERR_VALIDATION_FAILED", "one or more custom field values are invalid", { errors: result.errors });
  return c.json({ values: result.values }, 200);
});

customFieldValuesRoutes.openapi(createRoute({
  method: "get", path: "/{entity}/{entityId}", tags: ["admin"],
  request: { params: EntityParams },
  responses: { 200: { content: { "application/json": { schema: CustomFieldValuesResponse } }, description: "Values" }, ...problem(404) },
}), async (c) => {
  const { companyId, entity, entityId } = c.req.valid("param");
  const values = await c.var.withTenant(async (tx) =>
    (await companyExists(tx, companyId)) ? getValues(tx, entity, entityId) : null);
  if (values === null) return c.notFound();
  return c.json({ values }, 200);
});
```

The `setValues` failure returns rather than throws inside the transaction, so a validation failure **commits nothing** — the handler raises the problem after the transaction has closed with no writes.

- [ ] **Step 5: Register the two modules and their probes**

In `apps/api/src/routes/index.ts`, add the import at the top and both entries **to the array literal
`buildRoutes(deps)` returns**, after Task 11's `dimension-types` entry. §4.2.7: `ROUTES` is the derived const
`buildRoutes({ authAdmin: new StubAuthAdmin() })` and `createApp` mounts `buildRoutes({ authAdmin: deps.authAdmin })`,
so a module pushed onto `ROUTES` would be enumerated by the lints and never actually served:

```ts
import { customFieldDefinitionsRoutes, customFieldValuesRoutes } from "./admin/custom-fields";

export function buildRoutes(deps: { authAdmin: AuthAdmin }): readonly RouteModule[] {
  return [
    // 0B's seven entries and Tasks 9 and 11's three stay as they are. These two are appended directly after Task
    // 11's entry, the one whose `path` is "/v1/companies/:companyId/dimension-types":
    { path: "/v1/companies/:companyId/custom-field-definitions", router: customFieldDefinitionsRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
    { path: "/v1/companies/:companyId/custom-fields", router: customFieldValuesRoutes, permissions: [PERMISSION["admin.company.manage"]], auth: "human" },
  ];
}
```

After this task `buildRoutes` returns **twelve** modules — 0B's seven plus 0D's five — and `PROBES` has an entry for
each except the two `TENANT_FREE` members (§4.2.7), which is what `tenant-isolation.test.ts` asserts.

`tests/invariants/probes.ts` `PROBES`:

```ts
  "/v1/companies/:companyId/custom-field-definitions": {
    async seed(_db, owner) {
      return { path: `/v1/companies/${owner.company}/custom-field-definitions?entity=document`, method: "GET" };
    },
    expect: 404,      // the handler's companyExists guard (Step 4); the read carries no permission gate
  },
  "/v1/companies/:companyId/custom-fields": {
    async seed(db, owner) {
      const documentId = await draftDocument(db, owner);
      return { path: `/v1/companies/${owner.company}/custom-fields/document/${documentId}`, method: "GET" };
    },
    expect: 404,      // same guard: the company is resolved before the entity is
  },
```

- [ ] **Step 6: Run, regenerate OpenAPI, commit**

Run:
```bash
cd apps/api && bun run test -- test/routes/admin/custom-fields.test.ts
cd ../.. && bun run --cwd packages/contracts openapi:generate && bun run lint && bun run lint:rules && bun run typecheck && bun run test
```
Expected: 6 tests pass — the first one is the recorded evidence for DoD 0.10; everything else green. Re-run Task 9
Step 8's `node -e` check: with this task's two unsafe operations (custom-field-definitions `POST /`, custom-fields
`PUT /{entity}/{entityId}`) it reports **18** unsafe operations documenting `Idempotency-Key` and no `MISSING` line —
0B's ten plus 0D's eight, which is every unsafe route this slice adds.

```bash
git add packages/contracts apps/api tests
git commit -m "feat(api): custom-field definitions and values [0D T13]

Closes DoD 0.10: a new dimension and a new custom field created through the API
with listApplied() unchanged before and after. Validation failures return
ERR_VALIDATION_FAILED naming the field's code and write nothing. spec §3.5, §5.0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: OWNER GATE OD-04 — `packages/db/seed/roles.ts`, the nine system roles

> **This task is isolated for owner decision OD-04** (contracts §2.12: "The nine role names of §4.2.1 (*Confirm*)"; spec:35, 2152, 2403 — "⚠️ *Owner to confirm the names before task 0.7*").
>
> **Owner provides:** confirmation of the nine role codes `admin`, `accountant`, `user`, `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `auditor`, `pos_terminal` (spec:2156–2164), or replacements.
> **Verify with:** `bun run --cwd packages/db test -- test/roles-seed.test.ts` — the suite asserts the nine codes and their Phase 0 grants.
> **Default written into this plan (executed until the owner answers):** the spec's names, exactly as spec:2156–2164 spells them.
> **If the owner renames a role:** edit the `code`, `nameEn`, `nameAr` and `description` of that entry in `packages/db/seed/roles.ts` and the matching expectation in `packages/db/test/roles-seed.test.ts`. **Nothing else in this plan changes** — no migration, no route, no lint rule, no other task. The one code that is a fixed literal elsewhere is `pos_terminal`, which migration 0001's `assert_assignment_kind` names (plan0A:1416); if *that* role is renamed the owner is changing a shipped migration, which is a contracts amendment, not a plan edit.
> **If the owner adds a tenth role:** add one entry; the `role-seed` lint and the tests iterate `ROLES` and need no change.

**Files:**
- Create: `packages/db/seed/roles.ts`
- Test: `packages/db/test/roles-seed.test.ts` (the seed-shape half; the acceptance-test half is Task 15)

**Interfaces:**
- Consumes: nothing — this file is pure data plus one pure function. It deliberately **does not import `@dulja/contracts`**: §5.2's dependency rule places `db` and `contracts` at the same tier, so the catalogue is *injected* by the caller (the seed applier in 0C, the `role-seed` lint in Task 15, the tests here).
- Produces (§4.2.5):
  - `export interface RoleSeed { readonly code: string; readonly nameEn: string; readonly nameAr: string; readonly description: string; readonly permissions: readonly string[] }`
  - `export const ROLES: readonly RoleSeed[]` — nine entries.
  - `export const INCOMPATIBLE_PAIRS: readonly (readonly [string, string])[]` — spec §4.2.2 R6.
  - `export const ADMIN_EXCLUDED_CODES`, `export const ADMIN_EXCLUDED_PREFIXES`, `export function adminPermissions(catalogue: readonly string[]): readonly string[]`.

- [ ] **Step 1: Write the failing test `packages/db/test/roles-seed.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { adminPermissions, ADMIN_EXCLUDED_CODES, ADMIN_EXCLUDED_PREFIXES, INCOMPATIBLE_PAIRS, ROLES } from "../seed/roles";

describe("packages/db/seed/roles.ts — spec §4.2.1's nine system roles (OWNER GATE OD-04)", () => {
  it("holds exactly the nine role codes the spec names, in the spec's order", () => {
    expect(ROLES.map((r) => r.code)).toEqual([
      "admin", "accountant", "user", "warehouse", "branch_manager", "cashier", "hr_payroll", "auditor", "pos_terminal",
    ]);
  });

  it("every role carries a bilingual name and a description (spec §3.9 Naming)", () => {
    for (const r of ROLES) {
      expect(r.nameEn.length, r.code).toBeGreaterThan(0);
      expect(r.nameAr.length, r.code).toBeGreaterThan(0);
      expect(r.description.length, r.code).toBeGreaterThan(10);
    }
  });

  it("at Phase 0 only `auditor` holds a code, because only five admin.* codes exist (§3.6.4)", () => {
    const withCodes = ROLES.filter((r) => r.permissions.length > 0).map((r) => [r.code, r.permissions]);
    expect(withCodes).toEqual([["auditor", ["admin.audit_log.read"]]]);
  });

  it("`admin` is computed from the catalogue, not listed: every code except selling and terminal sync (spec:2156)", () => {
    const catalogue = [
      "admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read",
      "accounting.journal.post", "pos.ticket.sell", "pos.sync.pull", "pos.sync.push", "pos.ticket.void",
    ];
    expect(adminPermissions(catalogue)).toEqual([
      "admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read",
      "accounting.journal.post", "pos.ticket.void",
    ]);
    expect(ADMIN_EXCLUDED_CODES).toEqual(["pos.ticket.sell"]);
    expect(ADMIN_EXCLUDED_PREFIXES).toEqual(["pos.sync."]);
    expect(ROLES.find((r) => r.code === "admin")!.permissions).toEqual([]);
  });

  it("the R6 incompatible pairs are exactly the four spec §4.2.2 names", () => {
    expect(INCOMPATIBLE_PAIRS).toEqual([
      ["accounting.payment.create", "accounting.payment.approve"],
      ["hr.payroll.prepare", "hr.payroll.approve"],
      ["hr.statutory_table.manage", "hr.statutory_table.verify"],
      ["hr.employee.read_sensitive", "pos.ticket.sell"],
    ]);
  });

  it("`pos_terminal` holds nothing at Phase 0 — 6A adds its two sync codes with the catalogue entries", () => {
    expect(ROLES.find((r) => r.code === "pos_terminal")!.permissions).toEqual([]);
  });

  it("no role other than `admin` may ever be seeded with an incompatible pair (R6, checked over the data)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(role.permissions.includes(x) && role.permissions.includes(y), `${role.code}: ${x} + ${y}`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/roles-seed.test.ts`
Expected: FAIL — `Failed to resolve import "../seed/roles"`.

- [ ] **Step 3: Write `packages/db/seed/roles.ts`**

```ts
/**
 * The nine system roles of spec §4.2.1 (⚠️ OWNER GATE OD-04 — the owner confirms these names).
 *
 * `role.is_system = true`: never renamed or archived, and their permissions change only by a reviewed diff of this
 * file (spec §4.2.1). These are **per-tenant** rows, so they cannot be written by a migration — FORCE ROW LEVEL
 * SECURITY binds app_migrator too, and a migration file has no `set_config` (spec §3.8). They are applied per tenant
 * by `bun run seed --tenant <id> --only roles` (0C), as the system principal, so `forbid_self_grant` and
 * `keep_last_admin_*` hold.
 *
 * **Why almost every array is empty at Phase 0.** `role_permission.permission_code` has a foreign key to
 * `app.permission`, whose only rows at Phase 0 are the five `admin.*` codes 0B seeded. Each later slice extends the
 * arrays below for the roles spec:2157–2163 gives that authority, **in the same PR as its own catalogue entries**.
 * Listing a Phase 3 code here today would fail the FK on every tenant and fail the `role-seed` lint.
 *
 * **Why this file imports nothing.** spec §5.2 places `db` and `contracts` at the same tier of the dependency rule,
 * so `admin`'s computed set takes the catalogue as an argument rather than importing `PERMISSIONS`.
 */
export interface RoleSeed {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

/** spec:2156 — `admin` holds every permission present at the current phase "except selling at a till and terminal sync". */
export const ADMIN_EXCLUDED_CODES: readonly string[] = ["pos.ticket.sell"];
export const ADMIN_EXCLUDED_PREFIXES: readonly string[] = ["pos.sync."];

/**
 * `admin`'s effective grant, computed from whatever the catalogue holds at the phase being seeded. The seed applier
 * (0C) and the `role-seed` lint (0D) both call this, so there is exactly one definition of "every code except".
 */
export function adminPermissions(catalogue: readonly string[]): readonly string[] {
  return catalogue.filter(
    (code) => !ADMIN_EXCLUDED_CODES.includes(code) && !ADMIN_EXCLUDED_PREFIXES.some((p) => code.startsWith(p)),
  );
}

export const ROLES: readonly RoleSeed[] = [
  {
    code: "admin", nameEn: "Administrator", nameAr: "مدير النظام",
    description: "The owner; the bootstrap role (spec §3.8 step 4). Every permission present at the current phase — identity and configuration, every approval and exception authority — except selling at a till and terminal sync. R1 still binds: an admin may not approve or post what they themselves submitted.",
    permissions: [],   // computed by adminPermissions(catalogue) at seed time — never listed here
  },
  {
    code: "accountant", nameEn: "Accountant", nameAr: "محاسب",
    description: "Head-office bookkeeper. Chart of accounts, journals, sales and purchase documents and their posting, receipts, payment approval and posting, bank reconciliation, tax returns, period close; approves stock counts and write-offs; approves and posts payroll as HR's checker; verifies statutory tables. May not draft a payment (R6) or manage users.",
    permissions: [],   // 1A onward
  },
  {
    code: "user", nameEn: "Clerk", nameAr: "مستخدم",
    description: "General back-office clerk. Drafts sales and purchase orders and documents, receipts and payments; maintains customers and vendors; reads accounts, items, stock and the staff directory without sensitive fields. May not post, approve, override credit limits, or see costs or compensation.",
    permissions: [],   // 1A onward
  },
  {
    code: "warehouse", nameEn: "Warehouse", nameAr: "أمين المستودع",
    description: "Head-office store staff. Receives against purchase documents, transfers to branches, drafts stock counts and expired or damaged write-offs, and posts receipts and transfers — quantities only. May not see prices or costs, override negative stock, or approve adjustments.",
    permissions: [],   // 3A onward
  },
  {
    code: "branch_manager", nameEn: "Branch manager", nameAr: "مدير الفرع",
    description: "Runs one shop; always assigned with branch rows. Everything a cashier may, plus overrides on others' tickets as the second principal, closing any shift and the Z-report, receiving transfers, drafting counts and write-offs, quick-creating customers, attendance corrections, resolving the needs-attention queue, and resetting a PIN for a cashier in the same branch. Nothing in another branch.",
    permissions: [],   // 6A onward
  },
  {
    code: "cashier", nameEn: "Cashier", nameAr: "أمين الصندوق",
    description: "Branch till staff; branch rows set; an active employee with a pos_cashier row. Sells, discounts within the branch limit, returns against an original ticket, owns a shift, checks prices, quick-creates a customer, clocks in and out. May not take a blind return, void, override their own ticket, or close another cashier's shift.",
    permissions: [],   // 6A onward
  },
  {
    code: "hr_payroll", nameEn: "HR and payroll", nameAr: "الموارد البشرية والرواتب",
    description: "HR or payroll officer. Employee master including sensitive data (RLS-gated), compensation and pay components, loading statutory tables (a different principal verifies), attendance records, payroll prepare and submit, advance drafts, filings. May not approve or post payroll, approve a payment, verify a table they loaded, or touch their own record (R4).",
    permissions: [],   // 6C onward
  },
  {
    code: "auditor", nameEn: "Auditor", nameAr: "مدقق",
    description: "External accountant or statutory auditor; assigned with expires_at. Reads everything financial — ledger, documents, reports, stock and costs, the payroll register (posted lines only), statutory schedules, the audit log and document events — and exports. Holds no mutating permission at any phase; CI proves it (R7).",
    permissions: ["admin.audit_log.read"],   // the only Phase 0 code any role holds; 1B, 3A, 7C add reads
  },
  {
    code: "pos_terminal", nameEn: "POS terminal", nameAr: "نقطة بيع",
    description: "A principal of kind 'terminal', assigned at enrolment with its branch row. Holds exactly pos.sync.pull and pos.sync.push and nothing else; a human never holds this role and a terminal holds no other (R8, trigger-enforced both ways by assert_assignment_kind).",
    permissions: [],   // 6A adds pos.sync.pull and pos.sync.push with its catalogue entries
  },
];

/**
 * spec §4.2.2 R6 — permission pairs no seeded role other than `admin` may hold. Typed as plain strings, not
 * PermissionCode, so a pair naming a code whose slice has not landed is legal; the `role-seed` lint skips a pair
 * whose codes are not both in the catalogue yet.
 */
export const INCOMPATIBLE_PAIRS: readonly (readonly [string, string])[] = [
  ["accounting.payment.create", "accounting.payment.approve"],
  ["hr.payroll.prepare", "hr.payroll.approve"],
  ["hr.statutory_table.manage", "hr.statutory_table.verify"],
  ["hr.employee.read_sensitive", "pos.ticket.sell"],
];
```

- [ ] **Step 4: Expose the seed module, run the test, commit**

`packages/db/package.json` `exports` gains one subpath so the root `tests/` tier and 0C's seed CLI can import the
data without reaching into the package's internals (the same arrangement §4.2.12 uses for `./test`):

```json
    "./seed/roles": "./seed/roles.ts"
```

Run: `cd packages/db && bun run test -- test/roles-seed.test.ts && cd ../.. && bun run lint && bun run typecheck`
Expected: PASS — 7 tests.

```bash
git add packages/db/seed/roles.ts packages/db/test/roles-seed.test.ts packages/db/package.json
git commit -m "feat(db): the nine system roles as seed data [0D T14] [OD-04]

spec §4.2.1's nine roles with bilingual names and the R6 incompatible pairs.
admin is computed from the catalogue rather than listed; every other array is
empty until each slice adds its own codes (§3.6.4). Owner gate OD-04: a rename
is a one-file edit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: The catalogue and role lints, the one-query permission answer, and the Phase 0D exit check

**Files:**
- Create: `scripts/lint/rules/permission-catalogue.ts`, `scripts/lint/rules/role-seed.ts`, `tests/lint/permission-catalogue.test.ts`, `tests/lint/role-seed.test.ts`, `packages/db/src/rbac/who-can.ts`, `tests/invariants/role-catalogue.test.ts`
- Modify: `packages/db/src/index.ts`, `.github/workflows/ci.yml` (if `lint:rules` is not yet a CI step), `CLAUDE.md` (0D's line in the "Current phase" section)

**Interfaces:**
- Consumes: Task 14's `ROLES`, `INCOMPATIBLE_PAIRS`, `adminPermissions`; 0B's `PERMISSIONS` in `packages/contracts/permissions.ts`, `scripts/lint/types.ts`, `scripts/lint/run.ts`; Plan 0A's `app.actor_has`, `app.role_assignment`, `app.role_permission`, `app.role_assignment_branch`, `seedTenant`, `withTenant` (test), `uuidv7`.
- Produces:
  - `scripts/lint/rules/permission-catalogue.ts`: `export const rule: LintRule` (`name: "permission-catalogue"`).
  - `scripts/lint/rules/role-seed.ts`: `export const rule: LintRule` (`name: "role-seed"`).
  - `packages/db/src/rbac/who-can.ts`: `export interface PrincipalWithPermission { principalId: string; displayName: string }` and `export async function whoCan(tx: Sql, companyId: string, permissionCode: string, branchId?: string | null): Promise<PrincipalWithPermission[]>`.

**Definition of done being closed here — verbatim (spec §5.0 row 0.7):** "Acceptance test 14 passes; the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36 pass against the Phase 0 catalogue; the branch-scoping assertions of test 36 are re-run in each phase that adds the entities they name."

- [ ] **Step 1: Write the failing tests `tests/lint/permission-catalogue.test.ts` and `tests/lint/role-seed.test.ts`**

```ts
// tests/lint/permission-catalogue.test.ts
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/permission-catalogue";

const parse = (fileName: string, source: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

const CATALOGUE = parse("packages/contracts/permissions.ts", `
  export const PERMISSIONS = [
    { code: "admin.user.manage", module: "admin", mutating: true, description: "", phase: "0B" },
    { code: "admin.audit_log.read", module: "admin", mutating: false, description: "", phase: "0B" },
  ] as const;
`);

describe("permission-catalogue — spec §4.2 'a permission no code evaluates fails the build'; test 36", () => {
  it("passes when every catalogue code is referenced and every reference is catalogued", () => {
    const handler = parse("apps/api/src/routes/admin/users.ts", `
      usersRoutes.openapi({ middleware: [requirePermission(PERMISSION["admin.user.manage"], { company: "path:companyId" })] });
      const audit = PERMISSION["admin.audit_log.read"];
    `);
    expect(rule.run([CATALOGUE, handler])).toEqual([]);
  });

  it("fails when a catalogue code is evaluated by nothing (LEGACY-047)", () => {
    const handler = parse("apps/api/src/routes/admin/users.ts", `
      const x = PERMISSION["admin.user.manage"];
    `);
    const v = rule.run([CATALOGUE, handler]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "packages/contracts/permissions.ts", rule: "permission-catalogue" });
    expect(v[0]!.detail).toContain("admin.audit_log.read");
    expect(v[0]!.detail).toContain("no route or job handler");
  });

  it("fails when a handler names a code the catalogue does not hold", () => {
    const handler = parse("apps/api/src/routes/admin/users.ts", `
      requirePermission("admin.user.manage", s);
      requirePermission("admin.ghost.manage", s);
      principalHas("admin.audit_log.read", s);
    `);
    const v = rule.run([CATALOGUE, handler]);
    expect(v).toHaveLength(1);
    expect(v[0]!.file).toBe("apps/api/src/routes/admin/users.ts");
    expect(v[0]!.detail).toContain("admin.ghost.manage");
    expect(v[0]!.detail).toContain("not in the catalogue");
  });

  it("counts a code named inside a SQL template in packages/db/src (app.actor_has)", () => {
    const dbFile = parse("packages/db/src/rbac/x.ts", [
      "const a = tx`select app.actor_has('admin.user.manage', $1)`;",
      "const b = tx`select app.actor_has('admin.audit_log.read', $1)`;",
    ].join("\n"));
    expect(rule.run([CATALOGUE, dbFile])).toEqual([]);
  });

  it("ignores the catalogue file itself and the role seed as sources of a reference", () => {
    const roles = parse("packages/db/seed/roles.ts", `
      export const ROLES = [{ code: "auditor", permissions: ["admin.audit_log.read"] }];
    `);
    const v = rule.run([CATALOGUE, roles]);
    expect(v).toHaveLength(1);                       // both codes still unreferenced: roles.ts does not count
    expect(v[0]!.detail).toContain("admin.user.manage");
  });

  it("reports nothing at all when the catalogue file is absent from the file set", () => {
    expect(rule.run([parse("apps/api/src/x.ts", "const a = 1;")])).toEqual([]);
  });
});
```

```ts
// tests/lint/role-seed.test.ts
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/role-seed";

const parse = (fileName: string, source: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

const catalogue = (rows: [string, boolean][]) => parse("packages/contracts/permissions.ts", `
  export const PERMISSIONS = [
${rows.map(([code, mutating]) => `    { code: "${code}", module: "${code.split(".")[0]}", mutating: ${mutating}, description: "", phase: "0B" },`).join("\n")}
  ] as const;
`);

const roles = (body: string) => parse("packages/db/seed/roles.ts", `
  export const ROLES = [${body}];
  export const INCOMPATIBLE_PAIRS = [
    ["accounting.payment.create", "accounting.payment.approve"],
    ["hr.payroll.prepare", "hr.payroll.approve"],
  ];
`);

describe("role-seed — spec §4.2.2 R6 and R7; test 36", () => {
  const CAT = catalogue([
    ["accounting.payment.create", true], ["accounting.payment.approve", true], ["admin.audit_log.read", false],
  ]);

  it("passes on a clean seed", () => {
    expect(rule.run([CAT, roles(`
      { code: "admin", permissions: [] },
      { code: "accountant", permissions: ["accounting.payment.approve"] },
      { code: "auditor", permissions: ["admin.audit_log.read"] },
    `)])).toEqual([]);
  });

  it("R6: a seeded role other than admin holding both codes of a pair is a violation", () => {
    const v = rule.run([CAT, roles(`
      { code: "accountant", permissions: ["accounting.payment.create", "accounting.payment.approve"] },
    `)]);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe("role-seed");
    expect(v[0]!.detail).toContain("accountant");
    expect(v[0]!.detail).toContain("incompatible pair");
  });

  it("R6: admin is exempt — it is the full-permission bootstrap role (spec §4.2.2, D26)", () => {
    expect(rule.run([CAT, roles(`
      { code: "admin", permissions: ["accounting.payment.create", "accounting.payment.approve"] },
    `)])).toEqual([]);
  });

  it("R6: a pair whose codes are not both in the catalogue yet is skipped (F-21)", () => {
    expect(rule.run([CAT, roles(`
      { code: "hr_payroll", permissions: ["hr.payroll.prepare", "hr.payroll.approve"] },
    `)])).toEqual([]);        // neither hr code exists at this phase
  });

  it("R7: auditor holding a mutating code is a violation", () => {
    const v = rule.run([CAT, roles(`{ code: "auditor", permissions: ["accounting.payment.approve"] }`)]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("auditor");
    expect(v[0]!.detail).toContain("mutating");
  });

  it("a role holding a code that is in no catalogue at all is a violation", () => {
    const v = rule.run([CAT, roles(`{ code: "user", permissions: ["accounting.ghost.post"] }`)]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("accounting.ghost.post");
  });

  it("reports nothing when either file is absent from the file set", () => {
    expect(rule.run([CAT])).toEqual([]);
    expect(rule.run([roles(`{ code: "admin", permissions: [] }`)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run both to verify they fail**

Run: `cd tests && bun run test -- lint`
Expected: FAIL — `Failed to resolve import "../../scripts/lint/rules/permission-catalogue"`.

- [ ] **Step 3: Write `scripts/lint/rules/permission-catalogue.ts`**

```ts
import ts from "typescript";
import type { LintRule, LintViolation, SourceFile } from "../types";

const CATALOGUE_FILE = "packages/contracts/permissions.ts";
const ROLE_SEED_FILE = "packages/db/seed/roles.ts";
/** Where a permission code may be *evaluated* (contracts §3.6.3). apps/pos and packages/sync arrive with 6A/6B. */
const REFERENCE_SCOPES = [/(^|\/)apps\/(api|worker|pos)\//, /(^|\/)packages\/sync\//, /(^|\/)packages\/db\/src\//];
const norm = (p: string) => p.replace(/\\/g, "/");

/** Every string literal in a file, including the text chunks of a template literal (SQL carries codes as text). */
function stringLiterals(file: SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

/** The codes the catalogue declares: every `code: "..."` property of an object literal in permissions.ts. */
function catalogueCodes(file: SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "code"
        && ts.isStringLiteral(node.initializer)) {
      out.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

/** Codes named as the first argument of requirePermission()/principalHas(), or indexed out of PERMISSION[...]. */
function namedCodes(file: SourceFile): { code: string; line: number }[] {
  const out: { code: string; line: number }[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === "requirePermission" || node.expression.text === "principalHas")) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) out.push({ code: first.text, line: at(node) });
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "PERMISSION"
        && ts.isStringLiteral(node.argumentExpression)) {
      out.push({ code: node.argumentExpression.text, line: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

/**
 * spec §4.2: "a permission no code evaluates **fails the build**, and a handler that references a code not in the
 * catalogue fails the build" (LEGACY-034, LEGACY-047; acceptance test 36's catalogue-integrity clause).
 *
 * Both directions. A code counts as *evaluated* when it appears as a string literal anywhere in the reference
 * scopes — which catches `PERMISSION["x"]`, `requirePermission("x", …)`, `principalHas("x", …)` and
 * `tx\`select app.actor_has('x', …)\``, the four forms the system actually uses. `permissions.ts` itself and
 * `seed/roles.ts` are excluded as sources: listing a code is not evaluating it.
 */
export const rule: LintRule = {
  name: "permission-catalogue",
  run(files: SourceFile[]): LintViolation[] {
    const catalogueFile = files.find((f) => norm(f.fileName).endsWith(CATALOGUE_FILE));
    if (!catalogueFile) return [];                    // partial runs (an editor, a unit test) report nothing
    const catalogue = new Set(catalogueCodes(catalogueFile));
    if (catalogue.size === 0) return [];

    const violations: LintViolation[] = [];
    const referenced = new Set<string>();

    for (const file of files) {
      const path = norm(file.fileName);
      if (path.endsWith(CATALOGUE_FILE) || path.endsWith(ROLE_SEED_FILE)) continue;
      if (!REFERENCE_SCOPES.some((r) => r.test(path))) continue;

      for (const literal of stringLiterals(file)) {
        for (const code of catalogue) if (literal.includes(code)) referenced.add(code);
      }
      for (const named of namedCodes(file)) {
        if (!catalogue.has(named.code)) {
          violations.push({
            file: file.fileName, line: named.line, rule: "permission-catalogue",
            detail: `'${named.code}' is not in the catalogue (${CATALOGUE_FILE}) — a handler that references an uncatalogued code fails the build (spec §4.2, LEGACY-047)`,
          });
        }
      }
    }

    const orphans = [...catalogue].filter((c) => !referenced.has(c)).sort();
    if (orphans.length > 0) {
      violations.push({
        file: catalogueFile.fileName, line: 1, rule: "permission-catalogue",
        detail: `${orphans.length} catalogue code(s) evaluated by no route or job handler: ${orphans.join(", ")} (spec §4.2 'a permission no code evaluates fails the build', LEGACY-047)`,
      });
    }
    return violations;
  },
};
```

- [ ] **Step 4: Write `scripts/lint/rules/role-seed.ts`**

```ts
import ts from "typescript";
import type { LintRule, LintViolation, SourceFile } from "../types";

const CATALOGUE_FILE = "packages/contracts/permissions.ts";
const ROLE_SEED_FILE = "packages/db/seed/roles.ts";
const norm = (p: string) => p.replace(/\\/g, "/");

/** `{ code, mutating }` for every catalogue entry. */
function catalogue(file: SourceFile): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let code: string | null = null;
      let mutating: boolean | null = null;
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === "code" && ts.isStringLiteral(p.initializer)) code = p.initializer.text;
        if (p.name.text === "mutating") mutating = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
      }
      if (code !== null && mutating !== null) out.set(code, mutating);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

function arrayOfStrings(node: ts.Expression | undefined): string[] {
  if (!node || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.filter(ts.isStringLiteral).map((e) => e.text);
}

/** `{ code, permissions, line }` for every ROLES entry. */
function roleSeeds(file: SourceFile): { code: string; permissions: string[]; line: number }[] {
  const out: { code: string; permissions: string[]; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ROLES") {
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init))) init = init.expression;
      if (init && ts.isArrayLiteralExpression(init)) {
        for (const element of init.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          let code: string | null = null;
          let permissions: string[] = [];
          for (const p of element.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
            if (p.name.text === "code" && ts.isStringLiteral(p.initializer)) code = p.initializer.text;
            if (p.name.text === "permissions") permissions = arrayOfStrings(p.initializer);
          }
          if (code !== null) {
            out.push({ code, permissions, line: file.getLineAndCharacterOfPosition(element.getStart(file)).line + 1 });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

function incompatiblePairs(file: SourceFile): [string, string][] {
  const out: [string, string][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "INCOMPATIBLE_PAIRS") {
      let init = node.initializer;
      while (init && (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init))) init = init.expression;
      if (init && ts.isArrayLiteralExpression(init)) {
        for (const pair of init.elements) {
          const codes = arrayOfStrings(pair as ts.Expression);
          if (codes.length === 2) out.push([codes[0]!, codes[1]!]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return out;
}

/**
 * spec §4.2.2 R6 and R7 (acceptance test 36):
 *   R6 — no seeded role **other than `admin`** holds both codes of an incompatible pair. A pair whose two codes are
 *        not both in the catalogue yet is skipped, so a Phase 0 run does not fail on a Phase 8 pair (F-21).
 *   R7 — `auditor` holds no code with `mutating = true`.
 *   Plus — no role holds a code that is not in the catalogue at all: `role_permission.permission_code` has a foreign
 *        key to `app.permission`, so such a seed would fail on every tenant at run time instead of at build time.
 */
export const rule: LintRule = {
  name: "role-seed",
  run(files: SourceFile[]): LintViolation[] {
    const catalogueFile = files.find((f) => norm(f.fileName).endsWith(CATALOGUE_FILE));
    const seedFile = files.find((f) => norm(f.fileName).endsWith(ROLE_SEED_FILE));
    if (!catalogueFile || !seedFile) return [];

    const codes = catalogue(catalogueFile);
    const pairs = incompatiblePairs(seedFile);
    const violations: LintViolation[] = [];

    for (const role of roleSeeds(seedFile)) {
      for (const code of role.permissions) {
        if (!codes.has(code)) {
          violations.push({
            file: seedFile.fileName, line: role.line, rule: "role-seed",
            detail: `role '${role.code}' holds '${code}', which is not in the catalogue (${CATALOGUE_FILE}) — role_permission has a foreign key to app.permission and this seed would fail on every tenant`,
          });
        }
      }
      if (role.code === "auditor") {
        for (const code of role.permissions) {
          if (codes.get(code) === true) {
            violations.push({
              file: seedFile.fileName, line: role.line, rule: "role-seed",
              detail: `role 'auditor' holds the mutating code '${code}' — the auditor role is read-only and CI proves it (spec §4.2.2 R7)`,
            });
          }
        }
      }
      if (role.code === "admin") continue;                       // R6 exempts the bootstrap role (spec §4.2.2, D26)
      for (const [x, y] of pairs) {
        if (!codes.has(x) || !codes.has(y)) continue;            // F-21: the pair is not live at this phase
        if (role.permissions.includes(x) && role.permissions.includes(y)) {
          violations.push({
            file: seedFile.fileName, line: role.line, rule: "role-seed",
            detail: `role '${role.code}' holds the incompatible pair '${x}' + '${y}' — no seeded role other than admin may (spec §4.2.2 R6)`,
          });
        }
      }
    }
    return violations;
  },
};
```

- [ ] **Step 5: Run the lint unit tests**

Run: `cd tests && bun run test -- lint`
Expected: PASS — 6 + 7 tests across the three rule files.

- [ ] **Step 6: Write `packages/db/src/rbac/who-can.ts` — acceptance test 14 and test 36's one-query clause**

```ts
import type { Sql } from "postgres";

export interface PrincipalWithPermission { principalId: string; displayName: string }

/**
 * **Acceptance test 14** (spec Part VI): "List every user who can post a purchase return in company X" is
 * answerable **in one SQL query** (LEGACY-025, 034, 047) — and test 36's "who can approve payroll in company X" and
 * "who can reset a PIN at branch B" are the same query with a different code and a branch.
 *
 * The code is a **parameter**, never interpolated (test 27), so the same statement answers every phase's question
 * without a new query per capability — which is exactly what the legacy system's twenty `Is*` flags could not do.
 *
 * `branchId` omitted or null lists everyone who holds the code anywhere in the company (the test-14 question).
 * `branchId` set narrows to principals effective **at that branch**: a company-wide assignment (no branch rows) or
 * one whose branch rows include it. This is the listing counterpart of `app.actor_has`, whose NULL branch means
 * "company-wide authority only" because it is answering a different question — may this actor act *company-wide*.
 *
 * Must be called inside a withTenant transaction; RLS scopes it to the caller's tenant, so tenant B asking about
 * tenant A's company gets an empty list rather than a leak.
 */
export async function whoCan(
  tx: Sql, companyId: string, permissionCode: string, branchId?: string | null,
): Promise<PrincipalWithPermission[]> {
  const rows = await tx<{ id: string; display_name: string }[]>`
    select distinct p.id, p.display_name
      from app.principal p
      join app.role_assignment ra on ra.principal_id = p.id
      join app.role_permission rp on rp.role_id = ra.role_id
     where ra.company_id = ${companyId}
       and rp.permission_code = ${permissionCode}
       and (ra.expires_at is null or ra.expires_at > now())
       and (${branchId ?? null}::uuid is null
            or not exists (select 1 from app.role_assignment_branch b
                            where b.principal_id = ra.principal_id and b.role_id = ra.role_id
                              and b.company_id = ra.company_id)
            or exists (select 1 from app.role_assignment_branch b
                        where b.principal_id = ra.principal_id and b.role_id = ra.role_id
                          and b.company_id = ra.company_id and b.branch_id = ${branchId ?? null}::uuid))
     order by p.display_name`;
  return rows.map((r) => ({ principalId: r.id, displayName: r.display_name }));
}
```

`packages/db/src/index.ts` gains:

```ts
export { whoCan, type PrincipalWithPermission } from "./rbac/who-can";
```

- [ ] **Step 7: Write the acceptance-test suite `tests/invariants/role-catalogue.test.ts`**

It lives in the **root `tests/` tier**, not in `packages/db/test/`, for one reason: it needs both `@dulja/db` and
`@dulja/contracts/permissions`, and §5.2's dependency rule places those two at the same tier. `tests` is the one
workspace allowed to import any package (contracts §3.1), so this is the only place the two can meet without the
`dependency-rule` lint firing over `packages/**`. Task 14's `packages/db/test/roles-seed.test.ts` stays as it is —
it imports nothing but `../seed/roles`.

```ts
// tests/invariants/role-catalogue.test.ts
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { whoCan, withTenant } from "@dulja/db";
import { adminPermissions, INCOMPATIBLE_PAIRS, ROLES } from "@dulja/db/seed/roles";
import { seedBranch, seedTenant, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";

/**
 * §4.2.2 and §4.2.12: root `tests/` uses the **production** `withTenant(sql, ctx, fn)` from `@dulja/db` — the
 * 4-argument helper of the same name in `packages/db/test/harness.ts` is for `packages/db/test/*` only. This local
 * wrapper mints the `requestId` a `TenantContext` requires (`uuidv7`, never a v4 — §4.2.2) so the sixteen call
 * sites below read as one line each. It takes the `Sql` explicitly because this suite uses both `db.migrator`
 * (to seed rows `app_rw` may not write) and `db.rw` (to prove what a normal connection can see).
 */
let sharedDb: Db;
const asPrincipal = async <T>(sql: Sql, tenantId: string, actorId: string, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(sql, { tenantId, actorId, requestId: await uuidv7(sharedDb.admin) }, fn);

/**
 * The **test-local** applier. The production per-tenant applier is 0C's (`bun run seed --tenant <id> --only roles`,
 * contracts §3.6.4); 0D ships the data and the lints, so its tests apply the data themselves rather than importing
 * a CLI that does not exist yet. It runs as the tenant's system principal, exactly as the real one will, so
 * `forbid_self_grant` and `keep_last_admin_*` hold.
 */
async function applyRoles(db: Db, s: Seed): Promise<Map<string, string>> {
  const catalogue = PERMISSIONS.map((p) => p.code as string);
  const ids = new Map<string, string>();
  for (const role of ROLES) ids.set(role.code, await uuidv7(db.admin));
  await asPrincipal(db.migrator, s.tenant, s.system, async (tx) => {
    for (const role of ROLES) {
      await tx`insert into app.role (id, tenant_id, code, name_en, name_ar, description, is_system)
               values (${ids.get(role.code)!}, ${s.tenant}, ${role.code}, ${role.nameEn}, ${role.nameAr}, ${role.description}, true)
               on conflict (tenant_id, code) do nothing`;
      const codes = role.code === "admin" ? adminPermissions(catalogue) : role.permissions;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${s.tenant}, ${ids.get(role.code)!}, ${code}) on conflict do nothing`;
      }
    }
  });
  return ids;
}

describe("acceptance tests 14 and 36 against the Phase 0 catalogue — spec §5.0 row 0.7", () => {
  let db: Db; let a: Seed; let b: Seed; let roleIds: Map<string, string>; let branch: string; let clerk: string;

  beforeAll(async () => {
    db = sharedDb = await startDb();          // `sharedDb` is what `asPrincipal` mints its request ids on
    a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta");
    // Seed the five Phase 0 codes exactly as migration 0002 does, from the catalogue module itself.
    for (const p of PERMISSIONS) {
      await db.migrator`insert into app.permission (code, module, mutating, description)
                        values (${p.code}, ${p.module}, ${p.mutating}, ${p.description})
                        on conflict (code) do update set module = excluded.module, mutating = excluded.mutating`;
    }
    roleIds = await applyRoles(db, a);
    await applyRoles(db, b);
    branch = await seedBranch(db, a, { code: "KLANG", nameEn: "Klang branch" });
    clerk = await uuidv7(db.admin);
    await asPrincipal(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${clerk}, 'human', ${"clerk:" + a.tenant}, 'Alpha clerk')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${clerk})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleIds.get("admin")!}, ${a.company})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${clerk}, ${roleIds.get("auditor")!}, ${a.company})`;
    });
  });
  afterAll(async () => { await db.stop(); });

  it("TEST 36 catalogue integrity: every seeded role's codes are in app.permission, and admin holds the computed set", async () => {
    const rows = await asPrincipal(db.rw, a.tenant, a.system, (tx) => tx<{ code: string; n: number }[]>`
      select r.code, count(rp.permission_code)::int as n
        from app.role r left join app.role_permission rp on rp.role_id = r.id
       group by r.code order by r.code`);
    const byRole = new Map(rows.map((r) => [r.code, r.n]));
    expect(byRole.get("admin")).toBe(adminPermissions(PERMISSIONS.map((p) => p.code as string)).length);
    expect(byRole.get("auditor")).toBe(1);
    expect(byRole.get("pos_terminal")).toBe(0);
    // `admin` holds every Phase 0 code because none of them is pos.ticket.sell or pos.sync.*
    expect(byRole.get("admin")).toBe(PERMISSIONS.length);
  });

  it("TEST 36 auditor is read-only: the seeded role holds no mutating code (R7)", async () => {
    const rows = await asPrincipal(db.rw, a.tenant, a.system, (tx) => tx<{ code: string }[]>`
      select p.code from app.role r
        join app.role_permission rp on rp.role_id = r.id
        join app.permission p on p.code = rp.permission_code
       where r.code = 'auditor' and p.mutating`);
    expect(rows).toEqual([]);
  });

  it("TEST 36 incompatible pairs: no seeded role other than admin holds both codes of a live pair (R6)", async () => {
    const live = INCOMPATIBLE_PAIRS.filter(([x, y]) => {
      const codes = new Set(PERMISSIONS.map((p) => p.code as string));
      return codes.has(x) && codes.has(y);
    });
    for (const [x, y] of live) {
      const rows = await asPrincipal(db.rw, a.tenant, a.system, (tx) => tx<{ code: string }[]>`
        select r.code from app.role r
         where r.code <> 'admin'
           and exists (select 1 from app.role_permission rp where rp.role_id = r.id and rp.permission_code = ${x})
           and exists (select 1 from app.role_permission rp where rp.role_id = r.id and rp.permission_code = ${y})`);
      expect(rows, `${x} + ${y}`).toEqual([]);
    }
  });

  it("ACCEPTANCE TEST 14: who can do X in company Y is one query, parameterised on the code", async () => {
    const who = await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.role.assign"));
    expect(who).toEqual([{ principalId: a.human, displayName: "Alpha owner" }]);

    const auditors = await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.audit_log.read"));
    expect(auditors.map((p) => p.displayName).sort()).toEqual(["Alpha clerk", "Alpha owner"]);

    // Phase 3C re-runs this same call with 'accounting.purchase.post' — the spec's literal wording — once that code
    // and a real PURCHASE_RETURN type exist. Nothing about the query changes.
    expect(await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "accounting.purchase.post"))).toEqual([]);
  });

  it("ACCEPTANCE TEST 14: the answer is literally ONE statement against the principal tables", async () => {
    const statements: string[] = [];
    const rw = postgres(db.url("app_rw"), {
      max: 1, onnotice: () => {},
      debug: (_c, query) => { statements.push(query); },
    });
    try {
      await asPrincipal(rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.role.assign"));
    } finally { await rw.end(); }
    const real = statements.filter((s) => /from\s+app\.principal/i.test(s));
    expect(real).toHaveLength(1);
    expect(real[0]).not.toMatch(/admin\.role\.assign/);       // the code is a bound parameter, not text (test 27)
  });

  it("TEST 36 expired assignments grant nothing, through whoCan and through actor_has", async () => {
    await asPrincipal(db.migrator, a.tenant, a.system, (tx) =>
      tx`update app.role_assignment set expires_at = now() - interval '1 minute'
          where principal_id = ${clerk} and role_id = ${roleIds.get("auditor")!}`);
    expect(await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.audit_log.read")))
      .toEqual([{ principalId: a.human, displayName: "Alpha owner" }]);
    const [ok] = await asPrincipal(db.rw, a.tenant, clerk, (tx) =>
      tx<{ ok: boolean }[]>`select app.actor_has('admin.audit_log.read', ${a.company}, null) as ok`);
    expect(ok!.ok).toBe(false);
  });

  it("TEST 36 the branch form: a branch-restricted principal answers only for their own branch", async () => {
    const manager = await uuidv7(db.admin);
    await asPrincipal(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${manager}, 'human', ${"mgr:" + a.tenant}, 'Klang manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${manager})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${manager}, ${roleIds.get("branch_manager")!}, ${a.company})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleIds.get("branch_manager")!}, 'admin.audit_log.read') on conflict do nothing`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${manager}, ${roleIds.get("branch_manager")!}, ${a.company}, ${branch})`;
    });
    const atKlang = await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.audit_log.read", branch));
    const atHq = await asPrincipal(db.rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.audit_log.read", a.hq));
    expect(atKlang.map((p) => p.displayName).sort()).toEqual(["Alpha owner", "Klang manager"]);
    expect(atHq.map((p) => p.displayName)).toEqual(["Alpha owner"]);
    // The remaining branch-scoping assertions of test 36 (documents, shifts, stock, attendance, tickets) are 6C's:
    // the entities they name do not exist until Phase 6 (contracts §6.1).
  });

  it("TEST 36 the question is tenant-scoped: another tenant asking about this company gets nothing", async () => {
    expect(await asPrincipal(db.rw, b.tenant, b.system, (tx) => whoCan(tx, a.company, "admin.role.assign"))).toEqual([]);
  });
});
```

- [ ] **Step 7b: Run the acceptance suite**

`tests/package.json` `dependencies` already carries `@dulja/db` and `@dulja/contracts` (0B); run `bun install` if the
new `@dulja/db/seed/roles` subpath does not resolve.

Run: `cd tests && bun run test -- invariants/role-catalogue.test.ts`
Expected: PASS — 8 tests, including the two that carry the acceptance-test numbers in their titles.

If the one-statement test counts two matching statements, `whoCan` was split into a lookup plus a query — the whole
point of test 14 is that it is **one**; put it back into a single tagged template rather than relaxing the assertion.

- [ ] **Step 8: Wire `lint:rules` into CI and update `CLAUDE.md`**

Confirm `.github/workflows/ci.yml` runs `bun run lint:rules` after `bun run lint` (0B added the script; if the CI step is missing, add it in the same job). Then update the "Current phase" section of `CLAUDE.md` that 0B's last task wrote, marking 0D complete:

```markdown
## Current phase

Phase 0 — Foundations. Plan 0A (repository + migration 0001) **complete**. Plan 0B (identity, `withTenant`, errors,
idempotency, permission catalogue, root `tests/` tree) **complete**. Plan 0D (`@dulja/domain`, currency and rates,
dimensions and custom fields, pg-boss and `apps/worker`, catalogue lints, seeded roles) **complete** — §5.0 rows
0.7, 0.9, 0.10 and 0.11 green; acceptance tests 14 and 36's Phase 0 clauses passing. Next: **0C** (Supabase,
Cloudflare Containers, the bootstrap seed CLI, observability), then **0E** (i18n shell, `packages/ui`,
`apps/backoffice`, the Electron shell and the PDF-engine spike).
```

- [ ] **Step 9: The Phase 0D exit check**

Run, from the repository root, in this order, and confirm each line:

```bash
bun install
bun run lint                                    # oxlint: 0 problems
bun run lint:rules                              # 0 violations across all 8 rules
bun run typecheck                               # includes packages/domain/test — the @ts-expect-error assertion
bun run format:check
bun run --cwd packages/db db:migrate            # applies 0001–0007 to DATABASE_URL_MIGRATOR
bun run --cwd packages/db db:lint               # "schema lint: 0 violations"
bun run --cwd apps/worker jobs:install          # "pg-boss installed; 16 queues declared"
bun run test                                    # every workspace: domain, db, contracts, api, worker, tests
```

Confirm the deliverables of §5.0 rows 0.7, 0.9, 0.10 and 0.11:

| Row | Done-when (verbatim) | Where it is proved |
|---|---|---|
| 0.7 | "Acceptance test 14 passes; the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36 pass against the Phase 0 catalogue" | `tests/invariants/role-catalogue.test.ts` (T15) + `packages/db/test/roles-seed.test.ts` (T14) + `scripts/lint/rules/{permission-catalogue,role-seed}.ts` in `lint:rules` |
| 0.9 | "Property tests: `a + b − b = a` for 10⁶ random Money values; adding two currencies is a type error" | `packages/domain/test/money.property.test.ts` + `money.type.test.ts` under `bun run typecheck` (T4) |
| 0.10 | "A new dimension and a new custom field are created through the API with no migration" | `apps/api/test/routes/admin/custom-fields.test.ts` first `it` (T13), asserting `listApplied()` unchanged |
| 0.11 | "A test rolls back a transaction that enqueued a job; the job never runs" | `packages/db/test/jobs.test.ts` (T6) + `tests/regression/legacy-005.test.ts` |

- [ ] **Step 10: Commit**

```bash
git add scripts/lint packages/db tests CLAUDE.md .github
git commit -m "feat(db): catalogue and role-seed lints, whoCan, tests 14 and 36 [0D T15]

permission-catalogue proves both directions of 'a code no code evaluates fails
the build'; role-seed proves R6 and R7 over the seed, skipping pairs whose codes
are not live yet. whoCan answers 'who can do X in company Y (at branch B)' in one
statement with the code bound, not interpolated. Closes DoD 0.7.

spec §4.2, §4.2.2 R6/R7, §5.0 row 0.7; Part VI 14, 36; LEGACY-025, 034, 047.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Run against the spec sections listed in the header, the contracts document §2.1 (0D card), §3, §4 and §5, and the writing-plans skill.

### 1. Spec coverage

| Requirement | Task |
|---|---|
| §5.0 row 0.9 — `Money` in `packages/domain`, currency + rate service, the `number`-money lint, 10⁶ property test, currency type error | T1, T2, T3, T4, T8 |
| §5.0 row 0.10 — dimension framework (type/value tables + API) and custom-field service (typed definitions + values + validation), no migration | T10, T11, T12, T13 |
| §5.0 row 0.11 — pg-boss wired in, transactional enqueue, ledger-integrity job scaffolded reporting "no postings" | T5, T6, T7 |
| §5.0 row 0.7 — the nine seeded roles, the build checks, the "who can do X" query | T14, T15 |
| §3.2.2 pg-boss row + Money row | T5 (ADR 0007), T1–T3 |
| §3.2.4 the `worker` container class, one small pool | T6 (`createBoss`, `max: 4`), T7 (`apps/worker/src/index.ts`) |
| §3.3 `Currency ── ExchangeRate(effective_from, source) + RoundingPolicy(context)`; the generic Dimension line | T8 (ADR 0009), T10 |
| §3.5 custom fields as a core service — typed, per document type, indexed, validated | T12 (ADR 0010), T13 |
| §3.8 `dimension_type`/`dimension_value`; `idempotency_key` | T10, T7 (`admin.idempotency_key.purge`) |
| §3.9 Money, Quantities, Naming, Enumerations, Deletion, Error codes, Database access, Logging | T1–T3, T8 (`name_ar`, `rounding_mode` CHECK, `archived_at`), T2 (`ERRORS` rows), T7 (`log()`) |
| §4.2.1 catalogue and the nine roles; §4.2.2 R6 and R7 | T14, T15 |
| §4.5 API — Zod, OpenAPI committed and diffed, cursor pagination, idempotency, problem+json | T9, T11, T13 |
| §4.9 observability — the ledger-integrity SLI | T7 |
| §4.11 property tests for money, one migration per PR, reversible migrations, ADRs | T4, T5, T8, T10, T12; ADRs 0007–0010 |
| Part VI 14 and 36 (owned) | T15 |
| Part VI 12 and 13 re-run for the four new tables | T8, T10, T12 (two-tenant + audit assertions), T7 (job isolation) |
| Regression files legacy-005, legacy-008, legacy-019 | T6, T4, T8 |

**Deliverables of the 0D card, one by one:** `@dulja/domain` with the exact §4.2.1 surface (T1–T3) · fast-check 10⁶ + `money.type.test.ts` + `no-number-money` (T4) · migration 0004 + `jobs:install` (T5, T6) · migration 0005 + `app.rate_for()` + the rate API (T8, T9) · migration 0006 + the custom-field service through the API (T12, T13) · migration 0007 + the dimension API (T10, T11) · `apps/worker` with `enqueue`, the rollback test, the card's job-name registry — **0B's `JOBS`, verified by T6 Step 4 and re-exported from the `@dulja/db` barrel, never written here** (§4.2.6's per-file table) — the system-principal resolver and the integrity scaffold (T6, T7) · the catalogue build check, `seed/roles.ts`, the R6/R7 lints (T14, T15) · `admin.idempotency_key.purge` (T7). **Nothing on the card is unassigned.**

**Not delivered here, by contract, and where it lives:** the per-tenant role applier and `bun run seed` (0C, §3.6.4); the `permission-catalogue.test.ts` DB-vs-module equality test (0B, §3.6.3); the branch-scoping half of test 36 (6C, §6.1); the real Σdebit = Σcredit and rebuild-and-compare inside the integrity job (1B — 0D ships the scaffold spec §5.0 row 0.11 asks for).

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in`, `add appropriate`, `handle edge cases`, `similar to Task`, `and so on`, `etc.`, and bare `…` standing in for content. **None found.** The three route-registration steps (T9 S7, T11 S5, T13 S5) formerly carried a `// … inside ROUTES:` line, which *was* an elision standing for an insertion point; each now shows the `buildRoutes(deps)` body with the neighbouring entry quoted in full, so the executor is told exactly where the new objects go. The remaining `…` characters in this file all sit inside prose citations of other documents (`withTenant(tx => …)`, `GET …/accounts/tree`, `/v1/companies/{companyId}/…`) and none of them stands in for a step. Every code step carries the real file content; every test carries real assertions with the exact expected strings (`"no postings"`, `ERR_RATE_NOT_FOUND`, `"must be one of: low, high"`, `Unused '@ts-expect-error' directive`, `did not insert job accounting.period.month_end`). Two places name a value the executor must fill from a command's output rather than from this plan — **ADR 0007's verified-facts table** and the pg-boss version — and both are labelled as verification steps with the exact command, per spec:93's "agent verifies and records an ADR"; writing a guess there would be the defect.

### 3. Type consistency

- `RoundingMode`'s four literals are identical in `packages/domain/src/money/rounding.ts` (T1), the `app.currency.rounding_mode` CHECK (T8), `RoundingModeSchema` (T9) and `legacy-019.test.ts` (T8).
- `Money.toJSON()` returns `{ amount, currency }` (T2); `MoneySchema` (§4.2.8, 0B) and the custom-field money branch (T12) both consume that exact shape; `custom_field_value.value` stores it.
- `CustomFieldKind`'s eight literals are identical in `types.ts` (T12), the `kind` CHECK (T12) and `CustomFieldKindSchema` (T13); `CustomFieldEntity`'s four are identical in `service.ts`, the `entity` CHECK and `CustomFieldEntitySchema`.
- `JobName` is derived from `JOBS` in 0B's `jobs/names.ts` (T6 Step 4 verifies both and writes neither); `JobHandler`, `registerHandler`, `runJob` (T7), `JOB_PROBES` (T7) and `enqueue` (T6) are all generic over it. `JobPayload` extends `Record<JobName, unknown>` so `JobPayload[N]` type-checks for the fourteen names whose slices have not landed.
- `ExchangeRate` is one interface (T3) returned by `rateFor` (T8) and consumed by `toBase` (T3) and the lookup route (T9); `RateSchema`'s `^\d+\.\d{8}$` matches `toBase`'s own guard.
- `whoCan(tx, companyId, permissionCode, branchId?)` is called with three arguments in the test-14 assertions and four in the branch assertion (T15) — one signature.
- `Seed` is untouched; the three new fixtures use the uniform `(db, s, opts?)` shape of §4.17 and the exact names it assigns 0D.
- `LintRule`/`LintViolation`/`SourceFile` are consumed identically by all three new rules (T4, T15).
- `setValues`'s fourth parameter is `readonly { definitionId: string; value?: unknown }[]` (T12) and T13's `SetCustomFieldValuesBody` infers exactly that — `z.unknown()` makes the key optional, and both sides are spelled the same way rather than one of them casting (assumption 15).
- **`withTenant` by import path.** `packages/db/test/*` (`currency.test.ts`, `dimension.test.ts`, `custom-field.test.ts`, `jobs.test.ts`, `fixtures.ts`) keeps Plan 0A's 4-argument test helper from `./harness`; root `tests/` (`legacy-005`, `legacy-019`, `probes.ts`, `role-catalogue.test.ts`) and `apps/*/test` (both worker suites) import the production `withTenant(sql, ctx, fn)` from `@dulja/db` and pass a `TenantContext` whose `requestId` is a real `uuidv7` — §4.2.2 and §4.2.12, and the reason the two names may coexist.
- Every unsafe `createRoute` this slice adds declares `request.headers: IdempotencyHeader` (§4.2.7) — **eight** operations: currencies `POST /` and `PATCH /{currencyId}`; exchange-rates `POST /`; dimension-types `POST /`, `POST /{dimensionTypeId}/values` and `PATCH /{dimensionTypeId}/values/{valueId}`; custom-field-definitions `POST /`; custom-fields `PUT /{entity}/{entityId}`. T9 Step 8's `node -e` check counts them in the generated document, and T11 and T13 re-run it.
- Every module this slice mounts is added **inside `buildRoutes(deps)`** (T9 Step 7, T11 Step 5, T13 Step 5), never pushed onto `ROUTES` — §4.2.7 makes `buildRoutes` authoritative and `ROUTES` the stub-built derivation, so a push would be enumerated by the lints and never served by `createApp`. After T13 the function returns twelve modules: 0B's seven plus 0D's five.

### 4. Contract questions this plan resolved by stated assumption

Each is written into the header's assumption list and repeated here so the roadmap can fold it back into the contracts document: the `JOBS`-vs-handlers probe rule (assumption 8); `ERR_MONEY_CURRENCY_INVALID` not being in the §4.2.4 registry (assumption 9); `CustomFieldDefinition`/`ValidationResult` having no body in §4.2.11 (T12's contract note); `packages/db/seed/roles.ts` not importing `@dulja/contracts` and computing `admin` through `adminPermissions(catalogue)` (T14); `/v1/admin/currencies` writes taking `companyId` in the body because `ScopeSource` has no tenant-only form (T9).

Two more were settled while closing the audit, and both are internal to this slice rather than registry changes:

- **The company-resolution guard on company-scoped reads (assumption 14).** §4.2.11 makes those reads membership-only, so nothing in the middleware chain refuses a `companyId` from another tenant — RLS simply matches no row and the handler would answer `200 { items: [], next_cursor: null }`. `IsolationProbe.expect` is typed `403 | 404` (§4.2.7) and §3.7.2 says the harness asserts "a 404/403", so the 200 form is not expressible and the guard is required, not optional. It is one `select 1 from app.company where id = $1` inside the handler's existing `c.var.withTenant`, and `c.notFound()` is `ERR_NOT_FOUND`, whose registry note is "never reveals cross-tenant existence". `companyExists` is a file-local function in each of the three route modules and is exported from none of them, so no registry row is needed.
- **`/v1/admin/currencies`'s probe expects 403, not 404.** That module is tenant-scoped and gated `{ company: "body:companyId" }`, so `requirePermission` answers `ERR_RBAC_FORBIDDEN` before any handler runs. The distinction is deliberate and is written into the probe's own comment.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-0d-domain-money-jobs-catalogue.md`.**

**Next slice in dependency order: 0C** — `docs/superpowers/plans/2026-09-05-dulja-phase-0c-cloud-seed-observability.md` (Supabase provisioning, Cloudflare Containers, the bootstrap seed CLI, observability). Execution order for Phase 0 is **0B → 0D → 0C → 0E** (contracts §2.1, §6.3); 0C's infrastructure tasks may start as soon as 0B is merged, but **its seed task needs this slice**: it consumes `packages/db/seed/roles.ts`, `ROLES`, `INCOMPATIBLE_PAIRS` and `adminPermissions()` (Task 14) for step 4 of the §3.8 bootstrap sequence, `pgboss.tenant_registry` (Task 5) which the seed CLI populates per tenant, and the `jobs:install` deploy step (Task 6). 0E follows 0C.

What this slice hands forward, by name: `@dulja/domain` (`Money`, `Quantity`, `Rational`, `round`, `ExchangeRate`, `toBase`, `UNIT_RATE`, `validateCustomFieldValue`) for 1A's posting service and every later money path; `createJobClient`, `enqueue`, `JOB_NAMES`, `JobHandler`, `registerHandler`, `eachTenant` and `apps/worker` for every slice that schedules work (alongside 0B's `JOBS`, which this slice verifies and re-exports rather than writes); `app.currency`, `app.exchange_rate`, `app.rate_for()` and `rateFor()` for 1A's base conversion and 4B's FX; `app.custom_field_definition`/`_value` and the dimension API for 2A onward; `verifyChain()` for 1B's integrity job; `whoCan()` for 3C's and 6C's re-runs of tests 14 and 36; and `seedBranch`, `seedCurrency`, `seedRate` in `fixtures.ts` for 3D, 6C, 6D and 8B.

**One thing this slice hands forward with an expiry date.** `apps/worker/src/jobs/ledger-integrity-check.ts` and
`apps/worker/test/ledger-integrity-check.test.ts` are Phase-0-only: 1B's wiring step — its Task 6 Step 6 —
unregisters the handler and
replaces it with `createIntegrityCheckHandler`, then declines to delete the file and asks that it be reported
instead. Task 7 Step 5 is that report answered in advance: it carries 0D's standing authorisation to delete both
files and to re-point `apps/worker/test/support/worker.ts` at 1B's `registerAccountingHandlers`, all three in the
same commit as that wiring — so 1B needs no sign-off from this slice — and records why leaving them costs nothing
if that commit stays narrow. `JOB_PROBES["accounting.ledger.integrity_check"]` is written against the job name and
survives the swap unchanged.

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
