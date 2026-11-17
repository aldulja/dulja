# Dulja Phase 0 — Plan 0B: API core I — identity, tenant transactions, errors, idempotency, permission catalogue, root test tree

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Dulja HTTP surface — a Hono API whose every request resolves a real principal from a Supabase JWT, runs inside one `withTenant` transaction, returns RFC 9457 problems from a single code registry, is idempotent on every unsafe method, and is gated by a version-controlled permission catalogue — together with the root `tests/` tree that proves tenant isolation and auth-bypass resistance across every registered route.

**Architecture:** Three tiers, in the dependency order spec:2389 fixes. `packages/contracts` (Zod schemas, the `ERR_*` registry, the permission catalogue, the `Logger` type) imports only `@dulja/domain`; `packages/db` grows the production `createDb` / `withTenant` / `resolvePrincipal` / `systemContext` seam plus Drizzle read mirrors of migration 0001; `apps/api` mounts a fixed middleware chain — request id → logger → auth → idempotency → `requirePermission` → handler — over a `ROUTES` registry that both the OpenAPI generator and the root tenant-isolation harness iterate. Nothing in `apps/api` issues SQL except through a `tx` handed to it by `withTenant`, and five new lint rules in `scripts/lint/` make that mechanical rather than cultural.

**Tech Stack:** Bun 1.4 · TypeScript strict · Hono + `@hono/zod-openapi` + Zod · `postgres.js` · Drizzle ORM + Drizzle Kit (diff generator only) · `jose` (JWKS/JWT) · PostgreSQL 18 (Testcontainers) · Vitest under Node 24 · oxlint/oxfmt · Turborepo. Versions are owned by the lockfile — no version literal appears in any source file (spec:104).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 (spec:83–110), §3.2.1–3.2.4 (spec:1086–1162), §3.8 (spec:1362–1370, 1451–1466, 1546–1571, 1907–1919, 1983–2004), §3.9 (spec:2033–2064), §4.1 (spec:2119–2128), §4.2 / §4.2.1 / §4.2.2 (spec:2130–2179), §4.5 (spec:2197–2206), §4.9 (spec:2241–2247), §4.11 (spec:2258–2274), §5.0 rows 0.6 and 0.7 (spec:2315–2316), §5.2 (spec:2348–2389), Part VI tests 11, 12, 13, 14, 27, 36 (spec:2429–2432, 2445, 2454). Cross-plan contract: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`. Fixed input: `docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md` (Plan 0A — merged, verified on PostgreSQL 18, immovable).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 0B — API core I: identity, tenant transactions, errors, idempotency, permission catalogue, root test tree. **Phase:** 0. **Phase gate:** this plan starts when **Plan 0A is merged** and its twelve tasks are green in CI. 0B is the entry slice of the contracts catalogue and depends on no other slice (contracts §6.4). Phase 0 exits only when 0B, 0D, 0C and 0E are all green (spec:2327); this plan does not exit the phase.
- **Depends on (merged):** Plan 0A only. Consumed by exact name: `startDb`, `Db`, `StartOptions`, `Role`, `MIGRATIONS_DIR`, `ROLES_SQL`, `withTenant` (the **4-argument test** helper), `uuidv7`, `seedTenant`, `Seed`, `draftDocument`, `schemaFingerprint`, `up`, `down`, `listApplied`, `discover`, `Migration`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.resolve_principal`, `app.actor_has`, `app.current_tenant`, `app.current_actor`, `app.forbid_self_grant`, `app.assert_assignment_kind`, `app.keep_last_admin_assignment`, `app.keep_last_admin_permission`, `app.stamp_actor` (contracts §4.1).
- **Migration numbers:** 0002–0003 — this plan writes exactly one file, `0002_seed_permission_phase0.sql` with `0002.down.sql`; **0003 stays unused** (contracts §3.4.1 — gaps are fine, `discover()` sorts whatever exists). **ADR numbers:** 0003–0006 — 0003 error envelope, 0004 idempotency, 0005 identity chain and the Supabase JWKS form, 0006 route/registry/probe conventions.
- **Interfaces consumed:** contracts §4.1 (the whole Plan 0A surface), §3.4.6 (the exact generalised reversibility test), §3.5.2–§3.5.4 (linter sets and the pinned DELETE list — this slice changes neither), §3.6.1–§3.6.3 (catalogue module, codes, build checks), §3.7.1–§3.7.5 (test layout, isolation harness, regression ownership, lint rules), §3.11 (environment variable names).
- **Interfaces produced:** contracts §4.2.2 (`createDb`, `TenantContext`, `withTenant`, `systemContext`), §4.2.3 (`Logger`, `RequestContext`, `AppEnv`, the middleware order), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError`, `fromDatabaseError` — the 25-code 0B subset), §4.2.5 (`PERMISSIONS`, `PERMISSION`, `isMutating`, `requirePermission`, `ScopeSource`), §4.2.7 (`RouteModule`, `ROUTES`, `createApp`, `PROBES`), §4.2.8 (`packages/contracts/src/common.ts`), §4.2.9 (idempotency semantics), §4.2.12 (`@dulja/db/test` subpath, `ApiRequest`, `StartedApi`, `startApi`).
- **Owner decisions:** **OD-01** (v1.1 changelog #2 — `principal` RLS split into SELECT/UPDATE + INSERT policies, *Confirm*) and **OD-02** (v1.1 changelog #3 — `resolve_principal` owned by `app_auth`, *Confirm*) → **Task 5, the single isolated gate task**. Neither blocks merge: both are **already built by Plan 0A Task 5** and this plan is written against them as built (contracts §2.12 default: "as built"). **If OD-01 is rejected:** only Task 5's identity chain and Task 8's invite handler change — the handler stops relying on the `principal_insert` policy, and the insert order (principal without `RETURNING`, then `membership`, one transaction) is replaced by whatever policy shape the owner confirms; no other task's files move. **If OD-02 is rejected:** `resolvePrincipal`'s SQL text is unchanged (it calls `app.resolve_principal(sub)` either way), but the auth-bypass assertion in Task 13 (`tests/invariants/auth-bypass.test.ts`, last `it`) that "`select * from app.principal` as `app_rw` with no `set_config` returns zero rows while `resolve_principal` returns one" is replaced by whatever door the owner confirms. No other OD item touches this slice; **OD-24 does not apply — 0B ships no screen** (contracts Appendix A #5 lists the eighteen slices that do, and 0B is not one).
- **Part VI tests owned / re-run:** **owned 11, 12, 13, 27** (12 and 13 were proven at the data layer by Plan 0A — plan0A:2940, 2943; 0B proves the endpoint and API-write paths). **Re-runs: none.** **§3.0.4 rows owned:** spec:1065 Cross-cutting — "Tenancy + RLS, identity, RBAC with nine roles, branch scoping, segregation of duties, audit log, idempotent API" (segregation of duties is completed by 2B and branch isolation by 6C; both list the row under re-runs). **Regression files created:** `legacy-025, 026, 027, 028, 034, 035, 036, 037, 043, 047, 068, 069, 078, 082, 083, 084` (full scenarios this slice's own work proves); thin files for the twenty-one remaining Plan 0A-proven defects `legacy-003, 012, 013, 021, 029, 030, 031, 032, 033, 040, 041, 042, 044, 050, 051, 053, 070, 072, 073, 074, 080`; and `legacy-023, 045, 065, 071, 075, 087` for structural facts 0A fixed — **forty-three files, all created in Task 14**. **Appended to:** none (0B is first in execution order for every file it touches). `legacy-024` is 1A's.
- **Shared namespaces this slice writes into:** document-type codes (§4.14) **none**; account codes (§4.15) **none seeded, none consumed**; report codes (§4.16.1) **none** and `DatasetId` members (§4.16.2) **none**; `fixtures.ts` helpers (§4.17) **none** — §4.17 assigns 0B no helper, and this plan adds none (`packages/db/test/fixtures.ts` is not modified by any task). The one shared namespace this slice writes is the `ERR_*` space (§4.2.4): exactly the twenty-five codes §4.2.4 names as "0B's subset", no more.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-05.

### Assumptions this plan rests on

Every one is a place where the spec or the contracts document is silent or in tension; each is resolved here, once, and the resolution is repeated in the task that first needs it.

1. **`createApp`'s dependency object grows two members.** Contracts §4.2.7 freezes `createApp(deps: { db: Sql; jobs: JobClient; logger: Logger })`. Two more are unavoidable and are added here: **`authAdmin: AuthAdmin`** (the Supabase admin-invite port — spec:2132 requires the invite endpoint to create a principal from a `sub` the *server* obtained) and **`verifier: JwtVerifier`** (so route tests verify real signatures against a local JWKS instead of stubbing the auth middleware away). The final signature is fixed in **Task 4** so Tasks 5–12 pass the same object.
2. **`SUPABASE_SERVICE_ROLE_KEY` is not assumed to live in the container.** Contracts §3.11 marks the key "seed CLI **only** (never in the container)", while spec:2132 puts the admin-invite call behind the invite endpoint. The plan resolves the tension by **inverting the dependency**: `apps/api` depends on the `AuthAdmin` **port**, never on Supabase. 0B ships two implementations — `StubAuthAdmin` (deterministic `sub`; used by every test and by `dev`) and `SupabaseAuthAdmin` (the REST admin-invite call). **Which implementation the deployed container is given, and therefore whether the key reaches it, is 0C's wiring decision, recorded in ADR 0011 (0C's topology ADR).** 0B's endpoint, tests and OpenAPI entry are identical either way. Stated in ADR 0005.
3. **`ScopeSource` gains a fourth, tenant-scoped variant `{ company: "any" }`.** `app.actor_has` is company-keyed, but `/v1/admin/users`, `/v1/admin/roles`, `/v1/admin/audit-log` and `GET|POST /v1/companies` carry no company id in path or body. `{ company: "any" }` evaluates `exists (select 1 from app.company c where app.actor_has($code, c.id))` — RLS has already narrowed `app.company` to the caller's tenant, so this asks "does the actor hold the code in *any* company of this tenant" and never widens past the tenant. **One route uses the variant even though it does carry a company id:** `GET /v1/companies/{companyId}` (Task 10). A `path:companyId` gate there would refuse another tenant's id at the middleware and answer 403, telling the caller that id exists somewhere; with `{ company: "any" }` the handler runs and RLS makes the row simply absent — 404, the answer `tests/invariants/probes.ts` records and the "never a leak" rule wants. The `PATCH` on the same path keeps `path:companyId`: a write must name its company. Role assignments avoid the variant entirely by mounting at `/v1/companies/{companyId}/role-assignments` (`role_assignment` has a `company_id`; `role` does not). **These endpoints are not self-bootstrapping, and nothing here claims they are:** because `role_assignment` is company-keyed, a tenant with zero companies has zero assignments, so no human passes `{ company: "any" }` and `POST /v1/companies` is unreachable on a bare tenant. The first company and the owner's first `admin` assignment come from **0C's seed CLI, running as the system principal** (spec:1996–2002, task 0.7b; §5.0 row 0.7b) — which is also why `forbid_self_grant` holds for that first grant. 0B's endpoints assume at least one company already exists.
4. **`resolvePrincipal(sql, authSubject)` is a new `@dulja/db` export.** The identity middleware must call `app.resolve_principal(sub)` *before* a tenant is known, i.e. outside `withTenant` — which the `no-bare-db` lint forbids in `apps/**`. The call therefore lives in `packages/db/src/with-tenant.ts` (already on the lint allow-list, and already the home of `systemContext`, which needs the same call).
5. **The `jobs` type files are 0B's; the pg-boss adapter is 0D's.** `createApp` cannot compile without `JobClient`, and `JobClient` is a 0D interface (contracts §4.2.6). 0B ships **types only** — `packages/db/src/jobs/names.ts` (the `JOBS` const, verbatim from §4.2.6), `payloads.ts` (`JobPayload`, an index-signature interface grown additively) and `jobs/enqueue.ts` (`JobEnvelope`, `EnqueueOptions`, `JobClient`) — and **no pg-boss import, no `createJobClient`**. 0D adds `createJobClient` and migration 0004 to those same files. Tests pass a stub whose `enqueue` throws.
6. **`GET /v1/session` is the concrete `aal1` exemption.** Spec:2004 requires "every route except the MFA-enrolment routes" to demand `aal2`, but 0B has no enrolment route (enrolment happens in Supabase, from 0E's shell). Without one exempt route the gate is untestable and the DoD clause 0C must satisfy — "the owner logs in, enrols MFA at `aal1`, and sees an empty but fully configured company" (spec:2317) — has nothing to call. 0B therefore ships `GET /v1/session`: authenticated, `aal1`-tolerant, no permission code, returning the caller's principal, tenant, kind and `aal`.
7. **The `error-codes` lint excludes the `ERRORS` object literal — not the file that holds it.** Contracts §4.2.4 says the check fails when a code present in `ERRORS` has no occurrence in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**`. `packages/contracts/src/errors.ts` is inside `packages/**/src/**`, so its own definition would satisfy every code trivially — the only reading under which spec:2051 ("a code no code raises fails the build") means anything is one that excises the definition. But excising the whole *file* goes too far: `fromDatabaseError` lives in it and is the sole raiser of `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE` and `ERR_CONFLICT_REFERENCE`, which would then pass only because test files mention them as assertion strings, and deleting a test would fail the build for the wrong reason. The rule therefore excises the text between `export const ERRORS = {` and `} as const satisfies Record<string, ErrorDef>;` and scans everything else, including the rest of that file (Task 12).
8. **`no-bare-db`'s allow-list grows by two entries, and its patterns admit a generic argument.** (a) `apps/*/test/**` — `apps/api/test/support/app.ts` legitimately constructs the pool it hands to `createApp`; contracts §3.7.5 allow-lists `packages/db/test/**` for the same reason and simply predates `apps/api/test/`. (b) `packages/db/src/lint-schema.ts` — Plan 0A's schema linter reads the catalogue with a `sql`-tagged template (plan0A:2716–2730), before any tenant exists and over no tenant-scoped table, so `withTenant` would be meaningless there. (`packages/db/src/cli.ts` needs no entry: it only calls `postgres(url)` and `sql.end()`.) (c) Both patterns admit an optional generic argument — ``sql<Row[]>`…` ``, ``db.admin<Row[]>`…` `` — because that is how every postgres.js query in Plan 0A and in this plan is written; a pattern demanding the backtick immediately after the identifier would match none of them and spec:2053's guarantee would be a no-op for the only idiom anyone uses. Contracts §3.7.5 needs all three recorded.
9. **Exactly two Plan 0A *test* files are edited.** `packages/db/test/privileges.test.ts` — its `up → down → up` body is replaced with the exact text contracts §3.4.6 mandates for "0B Task 1", because it hard-codes `[1]` and would fail the moment migration 0002 exists (Task 1). `packages/db/test/tenant-isolation.test.ts` — its `insert into app.permission …` at plan0A:1118 gains `on conflict (code) do nothing`, because migration 0002 now seeds `admin.user.manage` and the bare insert would raise a unique violation (Task 7). **No other Plan 0A test file is modified**; `harness.ts` and `fixtures.ts` are untouched (contracts §4.1: `fixtures.ts` grows only additively, and §4.17 assigns 0B no helper). Repository-level files Plan 0A created are *extended additively*, which is the normal course for every slice and not an edit to 0A's behaviour: root `package.json` (a `workspaces` entry and a script — Tasks 12, 13), `.github/workflows/ci.yml` (new steps — Tasks 4, 12, 13, 14), `CLAUDE.md` ("Current phase" only — Task 15, per contracts §3.8), `packages/db/package.json` and `packages/db/src/index.ts` (new exports — Tasks 1, 2, 4).
10. **Root `tests/` shares containers deliberately, and the count is four.** Forty-three regression files at one `startDb()` each would be forty-three container starts. `tests/vitest.config.ts` therefore sets `isolate: false` with a single thread alongside the `fileParallelism: false` contracts §3.7.1 requires, and the run holds exactly **four** containers: one memoised `startDb()` in `tests/support/regression.ts` (every thin and structural regression file — Task 13), one memoised `startApi()` in `tests/support/api.ts` (every full regression file that speaks HTTP — Task 14), and two more, one per invariant suite (`tenant-isolation.test.ts` and `auth-bypass.test.ts` each call `startApi()` in their own `beforeAll` and stop it in `afterAll` — Task 13). **`sharedDb()` and `sharedApi()` are different databases**: `startApi()` runs its own `startDb()`, so the `Seed`s of one are invisible to the other and no file may mix them. Containers are reaped by Testcontainers' Ryuk on process exit locally; in CI `TESTCONTAINERS_RYUK_DISABLED=true` is already set and GitHub runners are ephemeral (plan0A:2862). `packages/*/test` and `apps/*/test` keep Plan 0A's one-container-per-file shape unchanged.
11. **The Supabase JWKS URL is never constructed.** `SUPABASE_JWKS_URL` holds the complete URL (contracts §3.11). Task 5 fetches the authority's current documentation, records the observed form in ADR 0005, and the code only ever does `createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL))` (contracts Appendix A #3).
12. **`app.permission` is empty after migration 0001.** Plan 0A inserts permission rows only inside its own test files (plan0A:1118), never in `0001_foundations.sql`. Migration 0002 is therefore the first writer of that table, and Task 7's both-directions catalogue test can assert exact set equality.

13. **Every name this slice adds beyond the frozen registry, in one list.** Contracts §4 says a plan "may add members only by amending this document"; the amendment has not been made yet, so the list lives here and **must be carried into the contracts document before 0C or 0D consumes any of it**. Named in the assumptions above: `AppDeps` + `authAdmin` and `verifier` (1), `ScopeSource { company: "any" }` (3), `resolvePrincipal` (4), the `jobs/` type files (5), `AAL1_PATHS` and the `GET /v1/session` exemption (6), the `error-codes` literal excision (7), the `no-bare-db` allow-list and generic-argument change (8). **Two more lint-rule allowances, both forced by Plan 0A files this slice may not edit, and both owed to contracts §3.7.5 (and §3.3 for the second):** (a) `dependency-rule` gains a **named-allowance set** keyed `<file path>|<package root>`, holding exactly one entry — `packages/db/test/permission-catalogue.test.ts|@dulja/contracts` — because contracts §3.6.3 freezes that path for the both-directions catalogue check while `packages/db`'s tier is `["@dulja/domain"]`, so the contract-mandated test would otherwise be a lint violation. It is a named file, not a `packages/*/test/**` carve-out, so `packages/domain/test/**` reaching `@dulja/db` is still caught. The same rule also gains **`ESCAPE_ALLOW`**, a second named-allowance set for the *relative-path escape* check — contracts §4.17.1 places on this file the allowances that let `apps/api/test/**` and `apps/worker/test/**` import the root test tier's shared helpers, and `ALLOW` cannot serve them because it is keyed on a `@dulja/*` package root while those imports are relative. §4.17.1's closing sentence names `tests/invariants/support/**`, but the table directly above it registers `grantAdmin`/`problemOf`/`sharedApi`/`fullRegression` in **`tests/support/api.ts`**, which 0D, 2A and 2C all import from `apps/api/test/routes/**`; both roots are therefore listed, and nothing wider — `apps/api/src/**` reaching `tests/` is still a violation. Matched by no file in this slice; proved by Task 12 Step 1's four cases. (b) `no-sql-concat`'s `UNSAFE_ALLOW` gains **`packages/db/test/harness.ts` and `packages/db/test/roles.test.ts`**, which apply `packages/db/roles.sql` with `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` (plan0A:476, 553) — a checked-in .sql file read from disk, the same case as `migrate.ts`; contracts §3.3's "`sql.unsafe` is permitted in exactly three places" predates Plan 0A's harness. Task 14's `legacy-036` allowed set carries the same fourth entry, because the two must agree. Named nowhere else until now: **`PoolerUrlError`** (Task 2 — §4.2.2 names only the thrown code), **`buildRoutes(deps)`** (Task 8 — §4.2.7 freezes `ROUTES` as a const; `ROUTES` survives as `buildRoutes({ authAdmin: new StubAuthAdmin() })`), **`parseFilters` / `FILTER_OPS` / `FilterClause`** (Task 3), **`IdempotencyHeader`** (Task 11 — declared in `apps/api/src/routes/idempotency-header.ts` and re-exported from `apps/api/src/routes/index.ts`, because a `const` in `index.ts`'s own body is a temporal-dead-zone `ReferenceError` for every route module `index.ts` imports; both import paths are the same binding), **`RECLAIM_AFTER_SECONDS`** (Task 6), **`assertRouteGates`**, **`readConfig` / `ConfigError` / `ApiConfig`**, **`createLogger`**, **`encodeCursor` / `decodeCursor`**, **`TenantContextError`'s widened code union**, **`loadPrincipals`**, **`signToken`** (Task 5 — needed for the expired and wrong-issuer shapes contracts §3.7.2 requires), **`TENANT_FREE`** (Task 13), the **`"./routes"` export of `apps/api`** (Task 13), and the **`{ company: "any" }` gate on `GET /v1/companies/{companyId}`** (Task 10 — a `path:companyId` gate would answer 403 for another tenant's id and leak its existence). One structural fact belongs on the same list: **`tests/**` is outside every lint root** — `scripts/lint/run.ts` walks `apps`, `packages` and `scripts` only — which is what makes `tests/support/ledger.ts`'s direct `app.ledger_entry` insert legal against 1A's `posting-only-tables` rule. If a later slice adds `tests` to `ROOTS`, that rule needs `tests/support/**` on its allow-list or every thin ledger regression fails lint.

---

## Global Constraints

Copied verbatim from spec §0.2 (spec:97–106). Every task's requirements implicitly include this section.

**Never**, at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (LEGACY-036/037/069);
- issue DDL from application code (LEGACY-053);
- disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053);
- gate an audit write on any flag (LEGACY-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

Additionally binding on every task of this plan:

| Constraint | Exact value | Source |
|---|---|---|
| Identifiers | `uuidv7()` server-side for everything; never a sequential integer as a public identifier | spec:2037 |
| Time | all timestamps `timestamptz` in UTC; `effective_date` is a `date` entered by the user | spec:2039 |
| Money | `numeric(19,4)`; no `number` ever holds a monetary value | spec:2041 |
| Naming | `snake_case`, **singular** table names in SQL; `camelCase` / `PascalCase` in TypeScript; `name_en` / `name_ar` on translated master data | spec:2045 |
| Deletion | financial rows never; master data `archived_at`, never `DELETE` | spec:2049 |
| Error codes | `ERR_<DOMAIN>_<REASON>`, enumerated in one file, "a code no code raises fails the build" | spec:2051 |
| Database access | every query, reads included, inside `withTenant(tx => …)`; a lint rule forbids bare `db.` calls | spec:2053 |
| API | `/v1/…`; cursor pagination; `Idempotency-Key` required on POST/PUT/PATCH/DELETE; `application/problem+json`; OpenAPI generated from Zod, committed, diffed in CI | spec:2055 |
| Migrations | one migration per PR; forward-only in production; hand-written `NNNN.down.sql`; CI applies down then up again | spec:2057 |
| Logging | structured JSON with `tenant_id`, `actor_id`, `request_id`, `trace_id` on every line; never a token, password or full card number | spec:2063 |
| Connections | session mode / direct (port 5432) only — never the transaction-mode pooler (6543) | spec:1366, 1090 |
| Commits | conventional commits, subject `<type>(<scope>): <summary> [0B T<n>]`, every commit ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` | contracts §3.8 |
| Dependency rule | `domain` imports nothing internal; `db` and `contracts` import `domain`; `api`/`worker`/`pos`/`backoffice` import packages, never each other | spec:2389 |

---

## File structure

Everything this plan creates or modifies. One responsibility per file; the task that owns it is in the right column.

```
/
├─ package.json                             MODIFY: scripts += lint:rules (T12); workspaces += "tests" (T13) T12, T13
├─ .github/workflows/ci.yml                 MODIFY: + openapi diff, + lint:rules, + the tests workspace    T11, T12, T13
├─ CLAUDE.md                                MODIFY: "Current phase" names 0B, 0D, 0C, 0E                    T15
├─ docs/adr/
│  ├─ 0003-problem-json-error-envelope.md                                                                   T3
│  ├─ 0004-idempotency-three-transaction-reservation.md                                                     T6
│  ├─ 0005-identity-chain-and-supabase-jwks.md                                                              T5
│  └─ 0006-route-registry-and-isolation-probes.md                                                           T4
├─ scripts/lint/
│  ├─ run.ts                                loads rules/*.ts, prints `<file>:<line> <rule> <detail>`, exit 1 T12
│  ├─ types.ts                              LintRule, LintViolation, SourceFile                             T12
│  └─ rules/
│     ├─ no-bare-db.ts                      only `tx` may tag SQL outside the allow-list                    T12
│     ├─ no-sql-concat.ts                   `.unsafe(` with a non-literal; SQL built by concatenation       T12
│     ├─ dependency-rule.ts                 spec:2389 tiers + the domain→payroll prohibition (spec:2366)    T12
│     ├─ forbidden-log-fields.ts            logger call keys matching /token|password|…/i                   T12
│     └─ error-codes.ts                     a code in ERRORS with no raise site                             T12
├─ packages/db/
│  ├─ package.json                          MODIFY: exports "./test"; script db:status; drizzle deps        T1
│  ├─ drizzle.config.ts                     Drizzle Kit as the diff generator only (ADR-0002)               T1
│  ├─ migrations/0002_seed_permission_phase0.sql   the five admin.* codes                                   T7
│  ├─ migrations/0002.down.sql                     deletes exactly those five                               T7
│  ├─ src/
│  │  ├─ index.ts                           MODIFY: re-export client / with-tenant / jobs / schema          T1, T2, T4
│  │  ├─ client.ts                          createDb(url, opts) — refuses :6543                             T2
│  │  ├─ with-tenant.ts                     TenantContext, withTenant, resolvePrincipal, systemContext      T2
│  │  ├─ jobs/names.ts                      JOBS registry (types only; the adapter is 0D's)                 T4
│  │  ├─ jobs/payloads.ts                   JobPayload — grown additively per slice                         T4
│  │  ├─ jobs/enqueue.ts                    JobEnvelope, EnqueueOptions, JobClient (interfaces only)        T4
│  │  └─ schema/                            Drizzle read mirrors of the 0001 tables 0B reads                T1
│  │     ├─ index.ts, tenant.ts, principal.ts, membership.ts, company.ts, role.ts, permission.ts,
│  │     └─ role-permission.ts, role-assignment.ts, role-assignment-branch.ts, dimension.ts,
│  │        audit-log.ts, idempotency-key.ts
│  └─ test/
│     ├─ index.ts                           `export * from "./harness"; export * from "./fixtures";`        T1
│     ├─ privileges.test.ts                 MODIFY: the §3.4.6 generalised up→down→up + fingerprint         T1
│     ├─ tenant-isolation.test.ts           MODIFY: permission insert gains `on conflict do nothing`        T7
│     ├─ schema-mirror.test.ts              every Drizzle mirror column exists in information_schema        T1
│     ├─ client.test.ts                     createDb refuses :6543                                          T2
│     ├─ with-tenant.test.ts                isolation level, set_config, retry, nesting, systemContext      T2
│     └─ permission-catalogue.test.ts       app.permission set == PERMISSIONS set, both directions          T7
├─ packages/contracts/
│  ├─ package.json                          @dulja/contracts; scripts typecheck, test, openapi:generate     T3
│  ├─ tsconfig.json, vitest.config.ts                                                                       T3
│  ├─ openapi.json                          generated, committed, diffed in CI                              T11
│  ├─ permissions.ts                        the catalogue (the spec's literal path, spec:2135)              T3, T7
│  └─ src/
│     ├─ index.ts                           the package's public surface                                    T3
│     ├─ common.ts                          Uuid/Date/Timestamp/Money/Quantity/Rate/Cursor/List schemas     T3
│     ├─ errors.ts                          Problem, ERRORS, ErrCode, AppError, fromDatabaseError           T3
│     ├─ logger.ts                          Logger type + createLogger (drops forbidden fields)             T3
│     ├─ session.ts                         SessionSchema                                                   T5
│     └─ admin/
│        ├─ user.ts                         UserSchema, InviteUserBody, UserQuery, UserList                 T8
│        ├─ role.ts                         RoleSchema, CreateRoleBody, UpdateRoleBody, RolePermissionsBody T9
│        ├─ role-assignment.ts              RoleAssignmentSchema, CreateRoleAssignmentBody, BranchBody      T9
│        ├─ company.ts                      CompanySchema, CreateCompanyBody, UpdateCompanyBody            T10
│        └─ audit-log.ts                    AuditLogEntrySchema, AuditLogQuery, AuditLogList                T10
├─ apps/api/
│  ├─ package.json, tsconfig.json, vitest.config.ts                                                         T4
│  ├─ src/
│  │  ├─ index.ts                           container entrypoint: config → createDb → createApp → serve     T4
│  │  ├─ config.ts                          reads and validates the §3.11 environment                       T4
│  │  ├─ context.ts                         RequestContext, AppEnv                                          T4
│  │  ├─ app.ts                             createApp(deps) — mounts ROUTES, the fixed middleware chain      T4
│  │  ├─ problem.ts                         toProblem / toProblemResponse — the one place a Problem is built T4
│  │  ├─ auth-admin.ts                      AuthAdmin port, SupabaseAuthAdmin, StubAuthAdmin                 T5
│  │  ├─ verifier.ts                        JwtVerifier port + createJwtVerifier (jose)                      T5
│  │  ├─ openapi.ts                         writes packages/contracts/openapi.json                           T11
│  │  ├─ middleware/request-id.ts           X-Request-Id in and out, trace_id                                T4
│  │  ├─ middleware/logger.ts               child logger with the four preset fields                         T4
│  │  ├─ middleware/auth.ts                 verify → aal gate → resolve_principal → membership → ctx          T5
│  │  ├─ middleware/idempotency.ts          the three-transaction reservation of §4.2.9                       T6
│  │  ├─ middleware/require-permission.ts   ScopeSource + the actor_has pre-flight                            T7
│  │  └─ routes/
│  │     ├─ index.ts                        RouteModule, ROUTES; re-exports IdempotencyHeader                T4, T11
│  │     ├─ idempotency-header.ts           IdempotencyHeader — a leaf module, so index.ts's cycle is safe   T11
│  │     ├─ health.ts                       GET /healthz                                                      T4
│  │     ├─ session.ts                      GET /v1/session (the aal1 exemption)                              T5
│  │     ├─ companies.ts                    /v1/companies                                                     T10
│  │     └─ admin/{users,roles,role-assignments,audit-log}.ts                                                 T8–T10
│  └─ test/
│     ├─ support/app.ts                     startApi(), ApiRequest, StartedApi, tokenFor                      T5
│     ├─ routes/health.test.ts                                                                                T4
│     ├─ middleware/{auth,idempotency,require-permission}.test.ts                                              T5, T6, T7
│     └─ routes/{session,companies}.test.ts, routes/admin/{users,roles,role-assignments,audit-log}.test.ts     T5, T8–T10
└─ tests/                                   the root workspace (@dulja/tests)                                  T13
   ├─ package.json, tsconfig.json, vitest.config.ts                                                            T13
   ├─ support/regression.ts                 sharedDb(), thinRegression()                                       T13
   ├─ support/api.ts                        sharedApi(), grantAdmin(), fullRegression(), problemOf()           T14
   ├─ support/source.ts                     REPO_ROOT, sourceFiles() — the repo walk the source facts need     T14
   ├─ support/ledger.ts                     postLines() — plan0A:1908's ledger_entry insert, for tests/        T14
   ├─ invariants/probes.ts                  PROBES keyed by RouteModule.path                                   T13
   ├─ invariants/tenant-isolation.test.ts   test 12 over every route and job                                   T13
   ├─ invariants/auth-bypass.test.ts        test 11 — every known bypass shape                                  T13
   ├─ golden/.gitkeep, e2e/.gitkeep         directories the later slices fill                                   T13
   └─ regression/legacy-NNN.test.ts × 43       16 full · 21 thin · 6 structural (contracts §3.7.3)                 T14
```

---

### Task 1: Plan 0A carry-over — reversibility beyond migration 0001, the `@dulja/db/test` subpath, `db:status`, and the Drizzle read mirrors

Nothing in this slice can add a migration until Plan 0A's reversibility test stops hard-coding `[1]`, and nothing outside `packages/db` can import `startDb` until the package exports its test directory. Both, plus the Drizzle mirrors every later read endpoint queries, land here.

**Files:**
- Modify: `packages/db/package.json`, `packages/db/test/privileges.test.ts` (the `up → down → up` `it` block and `schemaFingerprint`), `packages/db/src/index.ts`, `.gitignore`
- Create: `packages/db/test/index.ts`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/schema/tenant.ts`, `principal.ts`, `membership.ts`, `company.ts`, `role.ts`, `permission.ts`, `role-permission.ts`, `role-assignment.ts`, `role-assignment-branch.ts`, `dimension.ts`, `audit-log.ts`, `idempotency-key.ts`
- Test: `packages/db/test/schema-mirror.test.ts`

**Interfaces:**
- Consumes: `up`, `down`, `listApplied` from `../src/migrate` (plan0A:2802); `MIGRATIONS_DIR`, `startDb`, `Db` from `./harness` (plan0A:443–510); `schemaFingerprint` from `./privileges.test.ts` (plan0A:2445–2456); `seedTenant`, `draftDocument`, `Seed` from `./fixtures` (plan0A:1563–1611).
- Produces: subpath export `@dulja/db/test` resolving to `packages/db/test/index.ts`, which re-exports every `harness.ts` and `fixtures.ts` symbol (contracts §4.2.12); package script `db:status`; Drizzle table objects `tenantTable`, `principalTable`, `membershipTable`, `companyTable`, `roleTable`, `permissionTable`, `rolePermissionTable`, `roleAssignmentTable`, `roleAssignmentBranchTable`, `dimensionTypeTable`, `dimensionValueTable`, `auditLogTable`, `idempotencyKeyTable`, all exported from `packages/db/src/schema/index.ts` and re-exported from `@dulja/db` as the namespace `schema`.

- [ ] **Step 1: Replace the reversibility test body with the exact generalised text (contracts §3.4.6)**

In `packages/db/test/privileges.test.ts`, replace the whole `it("up → down → up …")` block with this — the text is fixed by the contracts document and is copied character for character:

```ts
  it("up → down → up reproduces the schema byte for byte (task 0.3 acceptance; §3.9 'reversible')", async () => {
    const before = await schemaFingerprint(db.admin);
    const applied = await listApplied(db.migrator);                       // ascending: [1, 2, …]
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].reverse());
    const [n] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
    expect(n!.n).toBe(0);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await schemaFingerprint(db.admin)).toBe(before);
  });
```

and change the file's import of the runner from `import { down, up } from "../src/migrate";` to:

```ts
import { down, listApplied, up } from "../src/migrate";
```

- [ ] **Step 2: Extend `schemaFingerprint` with the two catalog queries a forgotten enum label or grant would slip past**

In the same file, add these two entries to the `Promise.all([...])` array inside `schemaFingerprint`, after the existing `pg_class` query (contracts §3.4.6):

```ts
    sql`select t.typname, e.enumlabel, e.enumsortorder from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typnamespace = 'app'::regnamespace order by 1, 3`,
    sql`select table_name, privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' order by 1, 2`,
```

- [ ] **Step 3: Run the suite to see the old assumption replaced and the new one hold**

Run: `bun run --cwd packages/db test -- test/privileges.test.ts`
Expected: PASS. `listApplied` returns `[1]` today, so `[...applied].reverse()` is `[1]` and the test is behaviourally identical — but it is now correct for `[1, 2]`. A failure of `listApplied is not a function` means the import in Step 1 was not applied.

- [ ] **Step 4: Add the `./test` subpath export and `db:status`**

`packages/db/test/index.ts`:

```ts
// The test surface every other workspace imports (contracts §4.2.12). Root `tests/` and `apps/*/test` import
// startDb / seedTenant / draftDocument / uuidv7 / Seed / Db from "@dulja/db/test"; the PRODUCTION withTenant
// comes from "@dulja/db" instead — the 4-argument helper re-exported here is the test one (contracts §4.1).
export * from "./harness";
export * from "./fixtures";
```

In `packages/db/package.json`, replace the `exports` object and the `scripts` object with exactly:

```json
  "exports": {
    ".": "./src/index.ts",
    "./test": "./test/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "db:migrate": "bun run src/cli.ts up",
    "db:rollback": "bun run src/cli.ts down",
    "db:status": "bun run src/cli.ts status",
    "db:lint": "bun run src/cli.ts lint"
  }
```

`db:status` is the one script Plan 0A's CLI supports but never exposed (contracts §4.1).

- [ ] **Step 5: Install Drizzle and write the config**

```bash
cd packages/db && bun add drizzle-orm && bun add -d drizzle-kit && cd ../..
```

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

// ADR-0002: Drizzle Kit stays in the toolchain as the DIFF GENERATOR only. `drizzle-kit generate` produces a
// candidate up file which is renamed into the writing slice's migration range, hand-edited (policies, app_meta
// calls, comments no generator emits) and paired with a hand-written NNNN.down.sql. packages/db/src/migrate.ts
// is what applies migrations; drizzle's own applier and journal are not used (spec:2057, contracts §3.4.9).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./.drizzle",                                   // scratch: generated candidates, never applied from here
  dbCredentials: { url: process.env["DATABASE_URL_MIGRATOR"] ?? "" },
  schemaFilter: ["app"],
  verbose: true,
  strict: true,
});
```

Append `.drizzle/` to `.gitignore`.

- [ ] **Step 6: Write the failing mirror test**

`packages/db/test/schema-mirror.test.ts`:

```ts
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { startDb, type Db } from "./harness";

describe("Drizzle read mirrors — every mirrored column exists in the real schema (contracts §3.4.9)", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("thirteen mirrors name real tables in schema app, with real columns", async () => {
    const actual = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = 'app'`;
    const real = new Set(actual.map((r) => `${r.table_name}.${r.column_name}`));

    const mirrored = Object.values(schema).filter(
      (t): t is PgTable => typeof t === "object" && t !== null && Symbol.for("drizzle:Name") in t,
    );
    expect(mirrored).toHaveLength(13);

    const missing: string[] = [];
    for (const table of mirrored) {
      const cfg = getTableConfig(table);
      expect(cfg.schema, cfg.name).toBe("app");
      for (const col of cfg.columns) if (!real.has(`${cfg.name}.${col.name}`)) missing.push(`${cfg.name}.${col.name}`);
    }
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/schema-mirror.test.ts`
Expected: FAIL — `Cannot find module '../src/schema'`.

- [ ] **Step 8: Write the mirrors**

`packages/db/src/schema/tenant.ts`:

```ts
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Schema `app` — every mirror below lives in it. Mirrors are READ models for apps/api (contracts §3.4.9);
 *  writes to ledger, movement and projection tables are postgres.js tagged templates in packages/db/src/posting. */
export const app = pgSchema("app");

export const tenantTable = app.table("tenant", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/principal.ts`:

```ts
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const principalTable = app.table("principal", {
  id: uuid("id").primaryKey(),
  kind: text("kind").$type<"human" | "system" | "terminal">().notNull(),
  authSubject: text("auth_subject").notNull(),
  email: text("email"),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/membership.ts`:

```ts
import { timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const membershipTable = app.table("membership", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/company.ts`:

```ts
import { char, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const companyTable = app.table("company", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  baseCurrency: char("base_currency", { length: 3 }).notNull(),
  timezone: text("timezone").notNull(),
  fxRoundingAccountId: uuid("fx_rounding_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/role.ts`:

```ts
import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const roleTable = app.table("role", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  description: text("description"),
  isSystem: boolean("is_system").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/permission.ts`:

```ts
import { boolean, text } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** Global catalogue: no tenant_id, no RLS, read-only for app_rw (plan0A:1254). */
export const permissionTable = app.table("permission", {
  code: text("code").primaryKey(),
  module: text("module").$type<"admin" | "accounting" | "inventory" | "hr" | "pos">().notNull(),
  mutating: boolean("mutating").notNull(),
  description: text("description").notNull(),
});
```

`packages/db/src/schema/role-permission.ts`:

```ts
import { text, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const rolePermissionTable = app.table("role_permission", {
  tenantId: uuid("tenant_id").notNull(),
  roleId: uuid("role_id").notNull(),
  permissionCode: text("permission_code").notNull(),
});
```

`packages/db/src/schema/role-assignment.ts`:

```ts
import { timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const roleAssignmentTable = app.table("role_assignment", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  roleId: uuid("role_id").notNull(),
  companyId: uuid("company_id").notNull(),
  grantedBy: uuid("granted_by").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
```

`packages/db/src/schema/role-assignment-branch.ts`:

```ts
import { uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const roleAssignmentBranchTable = app.table("role_assignment_branch", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  roleId: uuid("role_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
});
```

`packages/db/src/schema/dimension.ts`:

```ts
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const dimensionTypeTable = app.table("dimension_type", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const dimensionValueTable = app.table("dimension_value", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  dimensionTypeId: uuid("dimension_type_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/audit-log.ts`:

```ts
import { bigint, customType, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Append-only, hash-chained. app_rw holds SELECT and INSERT only (plan0A:1985). */
export const auditLogTable = app.table("audit_log", {
  seq: bigint("seq", { mode: "bigint" }).primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  action: text("action").$type<"insert" | "update" | "delete">().notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  prevHash: bytea("prev_hash"),
  hash: bytea("hash").notNull(),
});
```

`packages/db/src/schema/idempotency-key.ts`:

```ts
import { customType, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const idempotencyKeyTable = app.table("idempotency_key", {
  tenantId: uuid("tenant_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  key: text("key").notNull(),
  requestHash: bytea("request_hash").notNull(),
  responseCode: integer("response_code"),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/index.ts`:

```ts
export { app, tenantTable } from "./tenant";
export { principalTable } from "./principal";
export { membershipTable } from "./membership";
export { companyTable } from "./company";
export { roleTable } from "./role";
export { permissionTable } from "./permission";
export { rolePermissionTable } from "./role-permission";
export { roleAssignmentTable } from "./role-assignment";
export { roleAssignmentBranchTable } from "./role-assignment-branch";
export { dimensionTypeTable, dimensionValueTable } from "./dimension";
export { auditLogTable } from "./audit-log";
export { idempotencyKeyTable } from "./idempotency-key";
```

- [ ] **Step 9: Re-export the mirrors from the package entry point**

`packages/db/src/index.ts` becomes:

```ts
export { discover, down, listApplied, up, type Migration } from "./migrate";
export { AUDIT_EXEMPT, IMMUTABLE, lintSchema, type Violation } from "./lint-schema";
export * as schema from "./schema";
```

- [ ] **Step 10: Run the mirror test to verify it passes**

Run: `bun run --cwd packages/db test -- test/schema-mirror.test.ts`
Expected: PASS — 13 mirrors, zero missing columns. A typo such as `created_ad` fails the test naming `<table>.created_ad`.

- [ ] **Step 11: Run the whole db suite and the root gates**

Run: `bun run --cwd packages/db test` then `bun run lint && bun run format:check && bun run typecheck`
Expected: all green; ten db test files pass.

- [ ] **Step 12: Commit**

```bash
git add packages/db .gitignore bun.lock
git commit -m "$(cat <<'EOF'
chore(db): generalise reversibility past 0001, export @dulja/db/test, add Drizzle read mirrors [0B T1]

privileges.test.ts no longer hard-codes [1] (contracts §3.4.6) and schemaFingerprint
now covers enum labels and app_rw grants, so migration 0002 can land in Task 7.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `createDb`, the production `withTenant`, `resolvePrincipal` and `systemContext`

The production transaction seam. It differs from Plan 0A's test helper in four ways the spec demands (spec:1368): an explicit `READ COMMITTED` begin, a `TenantContext` object rather than two loose ids, one retry on `40P01` / `40001`, and a refusal to nest.

**Files:**
- Create: `packages/db/src/client.ts`, `packages/db/src/with-tenant.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/client.test.ts`, `packages/db/test/with-tenant.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `uuidv7` from `./harness`; `seedTenant`, `Seed` from `./fixtures`; `app.resolve_principal(text)` (plan0A:1451–1462).
- Produces, verbatim from contracts §4.2.2 plus the one addition of assumption 4:

```ts
// packages/db/src/client.ts
export interface DbOptions { max?: number }
export function createDb(url: string, opts?: DbOptions): Sql;          // throws PoolerUrlError (ERR_DB_POOLER_URL) on ':6543'
export class PoolerUrlError extends Error { readonly code: "ERR_DB_POOLER_URL" }

// packages/db/src/with-tenant.ts
export interface TenantContext { readonly tenantId: string; readonly actorId: string; readonly requestId: string }
export class TenantContextError extends Error { readonly code: "ERR_TENANT_CONTEXT_MISSING" | "ERR_TENANT_CONTEXT_NESTED" }
export interface ResolvedPrincipal { readonly principalId: string; readonly tenantId: string; readonly kind: "human" | "system" | "terminal" }
export function withTenant<T>(sql: Sql, ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T>;
export function resolvePrincipal(sql: Sql, authSubject: string): Promise<ResolvedPrincipal[]>;
export function systemContext(sql: Sql, tenantId: string, requestId: string): Promise<TenantContext>;
```

- [ ] **Step 1: Write the failing test for `createDb`**

`packages/db/test/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDb, PoolerUrlError } from "../src/client";

describe("createDb — session mode only (spec:1090, 1366; §5.0 row 0.2)", () => {
  it("refuses a transaction-mode pooler URL and redacts the password in the message", () => {
    const url = "postgres://app_rw:hunter2@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
    expect(() => createDb(url)).toThrow(PoolerUrlError);
    try {
      createDb(url);
    } catch (e) {
      const err = e as PoolerUrlError;
      expect(err.code).toBe("ERR_DB_POOLER_URL");
      expect(err.message).toContain("ERR_DB_POOLER_URL");
      expect(err.message).toContain("6543");
      expect(err.message).not.toContain("hunter2");
    }
  });

  it("accepts a direct 5432 URL and defaults the pool to four connections (spec:1160 'one small pool per instance')", () => {
    const sql = createDb("postgres://app_rw:pw@127.0.0.1:5432/postgres");
    expect(sql.options.max).toBe(4);
    expect(createDb("postgres://app_rw:pw@127.0.0.1:5432/postgres", { max: 1 }).options.max).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/client.test.ts`
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 3: Write `packages/db/src/client.ts`**

```ts
import postgres, { type Sql } from "postgres";

/** "One small pool per instance" (spec:1160). */
export interface DbOptions { max?: number }

/** Hides the password of any postgres URL before it reaches a log line or an error message (spec:2063). */
function redact(url: string): string {
  return url.replace(/(\/\/[^:@/]*):[^@/]*@/, "$1:***@");
}

export class PoolerUrlError extends Error {
  readonly code = "ERR_DB_POOLER_URL" as const;
  constructor(url: string) {
    super(
      `ERR_DB_POOLER_URL: ${redact(url)} names port 6543, the Supabase transaction-mode pooler. ` +
        "Dulja needs one connection held for a whole transaction — set_config(..., true), the numbering advisory " +
        "lock and DEFERRABLE constraints all die in transaction mode (spec §3.2.1). Use session mode or a direct " +
        "connection on 5432.",
    );
    this.name = "PoolerUrlError";
  }
}

/**
 * The one place a postgres.js pool is constructed. Every caller (apps/api, apps/worker, the seed CLI) goes
 * through it, so the 6543 refusal cannot be forgotten in one entry point (§5.0 row 0.2 acceptance).
 */
export function createDb(url: string, opts: DbOptions = {}): Sql {
  if (url.includes(":6543")) throw new PoolerUrlError(url);
  return postgres(url, { max: opts.max ?? 4, onnotice: () => {} });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run --cwd packages/db test -- test/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `withTenant`, `resolvePrincipal` and `systemContext`**

`packages/db/test/with-tenant.test.ts`:

```ts
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { resolvePrincipal, systemContext, withTenant } from "../src/with-tenant";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, type Db } from "./harness";

describe("production withTenant — spec:1368, 2053; contracts §4.2.2", () => {
  let db: Db; let a: Seed; let b: Seed; let rw: Sql;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    rw = createDb(db.url("app_rw"));
  });
  afterAll(async () => { await rw.end(); await db.stop(); });

  const ctx = (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: "0192f000-0000-7000-8000-000000000001" });

  it("opens the transaction at READ COMMITTED and sets both session variables before anything else", async () => {
    const seen = await withTenant(rw, ctx(a), async (tx) => {
      const [row] = await tx<{ level: string; tenant: string; actor: string }[]>`
        select current_setting('transaction_isolation') as level,
               app.current_tenant()::text as tenant, app.current_actor()::text as actor`;
      return row!;
    });
    expect(seen).toEqual({ level: "read committed", tenant: a.tenant, actor: a.human });
  });

  it("sees only its own tenant's rows — the isolation the API depends on (acceptance test 12)", async () => {
    const ids = await withTenant(rw, ctx(a), (tx) =>
      tx<{ id: string }[]>`select id from app.company`.then((rows) => rows.map((r) => r.id)));
    expect(ids).toEqual([a.company]);
  });

  it("refuses a context with no tenant or no actor — there are no anonymous writes (spec:1919)", async () => {
    await expect(withTenant(rw, { tenantId: "", actorId: a.human, requestId: "r" }, async () => 1))
      .rejects.toThrow(/ERR_TENANT_CONTEXT_MISSING/);
    await expect(withTenant(rw, { tenantId: a.tenant, actorId: "", requestId: "r" }, async () => 1))
      .rejects.toThrow(/ERR_TENANT_CONTEXT_MISSING/);
  });

  it("refuses to nest — a tx is passed down, never re-wrapped", async () => {
    await expect(withTenant(rw, ctx(a), (tx) => withTenant(tx, ctx(a), async () => 1)))
      .rejects.toThrow(/ERR_TENANT_CONTEXT_NESTED/);
  });

  it("retries exactly once on a deadlock and does not retry anything else", async () => {
    let calls = 0;
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    await expect(withTenant(rw, ctx(a), async () => { calls += 1; throw deadlock; })).rejects.toThrow("deadlock detected");
    expect(calls).toBe(2);

    calls = 0;
    const other = Object.assign(new Error("boom"), { code: "23505" });
    await expect(withTenant(rw, ctx(a), async () => { calls += 1; throw other; })).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("a real 40P01 between two connections is retried and succeeds the second time", async () => {
    const other = createDb(db.url("app_rw"), { max: 1 });
    const id1 = await uuidv7(db.admin), id2 = await uuidv7(db.admin);
    await withTenant(rw, ctx(a), async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values
        (${id1}, ${a.tenant}, 'x1', 'X1'), (${id2}, ${a.tenant}, 'x2', 'X2')`;
    });
    // Two transactions taking the same two rows in opposite order deadlock; Postgres kills one with 40P01.
    const forward = withTenant(rw, ctx(a), async (tx) => {
      await tx`update app.role set name_en = 'A1' where id = ${id1}`;
      await new Promise((r) => setTimeout(r, 300));
      await tx`update app.role set name_en = 'A2' where id = ${id2}`;
      return "forward";
    });
    const backward = withTenant(other, ctx(a), async (tx) => {
      await tx`update app.role set name_en = 'B2' where id = ${id2}`;
      await new Promise((r) => setTimeout(r, 300));
      await tx`update app.role set name_en = 'B1' where id = ${id1}`;
      return "backward";
    });
    expect(await Promise.all([forward, backward])).toEqual(["forward", "backward"]);   // the loser retried and won
    await other.end();
  });

  it("resolvePrincipal answers with no tenant set, and returns nothing for an unknown subject (v1.1 fix #3)", async () => {
    expect(await resolvePrincipal(rw, `system:${a.tenant}`))
      .toEqual([{ principalId: a.system, tenantId: a.tenant, kind: "system" }]);
    expect(await resolvePrincipal(rw, "sub-that-does-not-exist")).toEqual([]);
    expect(await rw<{ id: string }[]>`select id from app.principal`).toEqual([]);   // …while direct reads see nothing
  });

  it("systemContext resolves the tenant's own system principal, never another tenant's", async () => {
    expect(await systemContext(rw, a.tenant, "req-1")).toEqual({ tenantId: a.tenant, actorId: a.system, requestId: "req-1" });
    expect(await systemContext(rw, b.tenant, "req-2")).toEqual({ tenantId: b.tenant, actorId: b.system, requestId: "req-2" });
    await expect(systemContext(rw, "0192f000-0000-7000-8000-0000000000ff", "req-3"))
      .rejects.toThrow(/ERR_TENANT_CONTEXT_MISSING/);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/with-tenant.test.ts`
Expected: FAIL — `Cannot find module '../src/with-tenant'`.

- [ ] **Step 7: Write `packages/db/src/with-tenant.ts`**

```ts
import type { Sql } from "postgres";

/** The three things every transaction and every log line needs (contracts §4.2.2, spec:2063). */
export interface TenantContext {
  readonly tenantId: string;      // uuid
  readonly actorId: string;       // uuid — the acting principal (a terminal for POS postings, the system principal for jobs)
  readonly requestId: string;     // uuidv7 minted by the request-id middleware or the job runner
}

export class TenantContextError extends Error {
  constructor(readonly code: "ERR_TENANT_CONTEXT_MISSING" | "ERR_TENANT_CONTEXT_NESTED", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TenantContextError";
  }
}

export interface ResolvedPrincipal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly kind: "human" | "system" | "terminal";
}

/** postgres.js hands the callback a transaction handle that carries `savepoint`; a pool handle does not. */
function isTransaction(sql: Sql): boolean {
  return typeof (sql as unknown as { savepoint?: unknown }).savepoint === "function";
}

function sqlState(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

async function once<T>(sql: Sql, ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
  // `begin isolation level read committed` is explicit rather than inherited: the audit chain takes a per-tenant
  // advisory lock and then SELECTs the previous holder's committed row, which a REPEATABLE READ snapshot hides
  // (plan0A:2281). set_config(..., true) is transaction-local, so it must be the first statement (spec:1368).
  return (await sql.begin("isolation level read committed", async (tx) => {
    await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.actor_id', ${ctx.actorId}, true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

/**
 * One transaction, at READ COMMITTED, with the two session variables set before anything else, retried exactly
 * once on 40P01 (deadlock) or 40001 (serialisation failure) — safe because every unsafe API call is idempotent
 * by key (spec:1368). A second failure, and every other error, propagates untouched.
 */
export async function withTenant<T>(sql: Sql, ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!ctx.tenantId || !ctx.actorId) {
    throw new TenantContextError(
      "ERR_TENANT_CONTEXT_MISSING",
      `a transaction needs both a tenant and an actor (got tenantId=${JSON.stringify(ctx.tenantId)}, actorId=${JSON.stringify(ctx.actorId)})`,
    );
  }
  if (isTransaction(sql)) {
    throw new TenantContextError(
      "ERR_TENANT_CONTEXT_NESTED",
      "withTenant was handed a transaction. Pass the existing `tx` down to the helper instead of opening a second transaction",
    );
  }
  try {
    return await once(sql, ctx, fn);
  } catch (e) {
    const state = sqlState(e);
    if (state === "40P01" || state === "40001") return await once(sql, ctx, fn);
    throw e;
  }
}

/**
 * The one door that runs before a tenant is known (plan0A:1451–1462): SECURITY DEFINER, owned by app_auth,
 * EXECUTE granted to app_rw only. Deliberately NOT inside withTenant — the caller has no tenant yet. This is why
 * the `no-bare-db` lint allow-lists this file (contracts §3.7.5).
 */
export async function resolvePrincipal(sql: Sql, authSubject: string): Promise<ResolvedPrincipal[]> {
  const rows = await sql<{ principal_id: string; tenant_id: string; kind: ResolvedPrincipal["kind"] }[]>`
    select principal_id, tenant_id, kind from app.resolve_principal(${authSubject})`;
  return rows.map((r) => ({ principalId: r.principal_id, tenantId: r.tenant_id, kind: r.kind }));
}

/** Jobs act as the tenant's system principal, never a human (spec:2179; contracts hazard 20). */
export async function systemContext(sql: Sql, tenantId: string, requestId: string): Promise<TenantContext> {
  const [row] = (await resolvePrincipal(sql, `system:${tenantId}`)).filter(
    (r) => r.tenantId === tenantId && r.kind === "system",
  );
  if (!row) {
    throw new TenantContextError("ERR_TENANT_CONTEXT_MISSING", `tenant ${tenantId} has no system principal`);
  }
  return { tenantId, actorId: row.principalId, requestId };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `bun run --cwd packages/db test -- test/with-tenant.test.ts`
Expected: PASS (8 tests). The deadlock test takes about a second; if it flakes, raise both `setTimeout` values to 500 ms — the interleave, not the timing, is the assertion.

- [ ] **Step 9: Export the new surface**

`packages/db/src/index.ts` becomes:

```ts
export { createDb, PoolerUrlError, type DbOptions } from "./client";
export { discover, down, listApplied, up, type Migration } from "./migrate";
export { AUDIT_EXEMPT, IMMUTABLE, lintSchema, type Violation } from "./lint-schema";
export {
  resolvePrincipal, systemContext, TenantContextError, withTenant,
  type ResolvedPrincipal, type TenantContext,
} from "./with-tenant";
export * as schema from "./schema";
```

- [ ] **Step 10: Run the whole db suite and the root gates**

Run: `bun run --cwd packages/db test` then `bun run lint && bun run typecheck`
Expected: green.

- [ ] **Step 11: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): production withTenant, createDb, resolvePrincipal and systemContext [0B T2]

READ COMMITTED is explicit, set_config runs first, 40P01/40001 retries once,
nesting throws. resolvePrincipal is the pre-tenant door the API's auth chain uses.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 3: `@dulja/contracts` — common Zod schemas, the `ERR_*` registry, the structured logger (ADR 0003)

The package `apps/api`, `apps/worker` and both desktop apps read their vocabulary from. It imports nothing internal except `@dulja/domain`, which does not exist yet (0D) — so at this task it imports nothing internal at all, which is the tier the dependency rule wants anyway.

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/vitest.config.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/common.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/logger.ts`, `docs/adr/0003-problem-json-error-envelope.md`
- Test: `packages/contracts/test/errors.test.ts`, `packages/contracts/test/logger.test.ts`, `packages/contracts/test/common.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, verbatim from contracts §4.2.4, §4.2.8 and §4.2.3:

```ts
export interface Problem { type: `urn:dulja:error:${ErrCode}`; title: string; status: number; detail: string;
  instance: string; code: ErrCode; remedy: string; requestId: string; errors?: { path: string; message: string }[] }
export interface ErrorDef { status: number; title: string; remedy: string }
export const ERRORS: Record<string, ErrorDef>;     // the 25-code 0B subset
export type ErrCode = keyof typeof ERRORS;
export class AppError extends Error { constructor(readonly code: ErrCode, readonly detail: string, readonly extra?: Partial<Problem>) }
export function fromDatabaseError(e: unknown): AppError;
export type LogFields = Record<string, unknown>;
export interface Logger { debug/info/warn/error(fields: LogFields, msg: string): void; child(fields: LogFields): Logger }
export function createLogger(opts?: { level?: "debug" | "info" | "warn" | "error"; sink?: (line: string) => void; base?: LogFields }): Logger;
// common.ts: UuidSchema, DateSchema, TimestampSchema, CurrencySchema, MoneySchema, QuantitySchema, RateSchema,
//            CursorSchema, ListEnvelope, ListQuery, ProblemSchema, encodeCursor, decodeCursor
```

- [ ] **Step 1: Scaffold the package**

`packages/contracts/package.json`:

```json
{
  "name": "@dulja/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./permissions": "./permissions.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "openapi:generate": "bun run --cwd ../../apps/api openapi:generate"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "permissions.ts", "vitest.config.ts"] }
```

`packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
```

```bash
cd packages/contracts && bun add zod && cd ../..
```

- [ ] **Step 2: Write the failing tests**

`packages/contracts/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AppError, ERRORS, fromDatabaseError } from "../src/errors";

describe("the ERR_* registry — spec:2051, contracts §4.2.4", () => {
  it("holds exactly the twenty-five codes contracts §4.2.4 assigns to 0B", () => {
    expect(Object.keys(ERRORS).sort()).toEqual([
      "ERR_ACTOR_IMMUTABLE", "ERR_AUTH_AAL_INSUFFICIENT", "ERR_AUTH_NO_MEMBERSHIP", "ERR_AUTH_TOKEN_INVALID",
      "ERR_CONFLICT_REFERENCE", "ERR_CONFLICT_UNIQUE", "ERR_DB_POOLER_URL", "ERR_IDEMPOTENCY_IN_FLIGHT",
      "ERR_IDEMPOTENCY_KEY_MISSING", "ERR_IDEMPOTENCY_KEY_REUSED", "ERR_INTERNAL", "ERR_LEDGER_UNBALANCED",
      "ERR_NOT_FOUND", "ERR_PERIOD_NOT_OPEN", "ERR_RBAC_FORBIDDEN", "ERR_RBAC_KIND", "ERR_RBAC_LAST_ADMIN",
      "ERR_RBAC_SELF_ESCALATION", "ERR_RBAC_SELF_GRANT", "ERR_RLS_DENIED", "ERR_ROUTE_GATE_READONLY",
      "ERR_TABLE_IMMUTABLE", "ERR_TENANT_CONTEXT_MISSING", "ERR_TENANT_CONTEXT_NESTED", "ERR_VALIDATION_FAILED",
    ]);
  });

  it("every code carries a status, a title and a remedy — the three things LEGACY-084 lacked", () => {
    for (const [code, def] of Object.entries(ERRORS)) {
      expect(code, code).toMatch(/^ERR_[A-Z0-9_]+$/);
      expect(def.status, code).toBeGreaterThanOrEqual(400);
      expect(def.title.length, code).toBeGreaterThan(0);
      expect(def.remedy.length, code).toBeGreaterThan(0);
    }
  });

  it("an AppError names the offending entity in its detail and knows its status", () => {
    const e = new AppError("ERR_NOT_FOUND", "company 0192f000-0000-7000-8000-000000000001 does not exist");
    expect(e.code).toBe("ERR_NOT_FOUND");
    expect(ERRORS[e.code].status).toBe(404);
    expect(e.detail).toContain("0192f000");
  });

  it("maps a check_violation carrying a DB token to that token's code", () => {
    const e = fromDatabaseError({ code: "23514", message: "ERR_RBAC_SELF_GRANT: a principal cannot change their own role assignments" });
    expect(e.code).toBe("ERR_RBAC_SELF_GRANT");
    expect(e.detail).toBe("a principal cannot change their own role assignments");
  });

  it("maps the SQLSTATEs contracts §4.2.4 pins, and hides everything else behind ERR_INTERNAL", () => {
    expect(fromDatabaseError({ code: "42501", message: "permission denied" }).code).toBe("ERR_RLS_DENIED");
    expect(fromDatabaseError({ code: "23505", message: "duplicate key" }).code).toBe("ERR_CONFLICT_UNIQUE");
    expect(fromDatabaseError({ code: "23503", message: "violates foreign key" }).code).toBe("ERR_CONFLICT_REFERENCE");
    const unknown = fromDatabaseError({ code: "22P02", message: "invalid input syntax for type uuid: \"nope\"" });
    expect(unknown.code).toBe("ERR_INTERNAL");
    expect(unknown.detail).not.toContain("nope");                 // never echo the driver's text (LEGACY-083)
    expect(unknown.extra?.["sqlstate"]).toBe("22P02");            // …but keep it for the log line
  });

  it("a check_violation with no token is ERR_INTERNAL, not a silently swallowed success (LEGACY-083)", () => {
    expect(fromDatabaseError({ code: "23514", message: "new row violates check constraint \"chk_x\"" }).code).toBe("ERR_INTERNAL");
  });
});
```

`packages/contracts/test/logger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";

describe("structured JSON logger — spec:2063", () => {
  const capture = () => { const lines: string[] = []; return { lines, sink: (l: string) => lines.push(l) }; };

  it("emits one JSON object per line with level, msg, time and the given fields", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).info({ tenant_id: "t", actor_id: "a", request_id: "r", trace_id: "x" }, "request completed");
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: "info", msg: "request completed", tenant_id: "t", actor_id: "a", request_id: "r", trace_id: "x" });
    expect(typeof line.time).toBe("string");
  });

  it("child() presets fields on every later call", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).child({ request_id: "r1" }).warn({ path: "/v1/companies" }, "slow");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", request_id: "r1", path: "/v1/companies" });
  });

  it("drops a forbidden field and says so, instead of logging the secret (spec:2063)", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).info({ authorization: "Bearer x", pin: "1234", tenant_id: "t" }, "hi");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", msg: "forbidden_log_field", fields: ["authorization", "pin"] });
    const emitted = JSON.parse(lines[1]!);
    expect(emitted).toMatchObject({ tenant_id: "t" });
    expect(emitted).not.toHaveProperty("authorization");
    expect(emitted).not.toHaveProperty("pin");
    expect(lines.join("")).not.toContain("Bearer x");
  });

  it("respects the level floor", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: "warn" });
    log.debug({}, "d"); log.info({}, "i"); log.warn({}, "w"); log.error({}, "e");
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });
});
```

`packages/contracts/test/common.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, ListEnvelope, ListQuery, MoneySchema, QuantitySchema, RateSchema } from "../src/common";
import { z } from "zod";

describe("common wire schemas — contracts §4.2.8", () => {
  it("money is { amount, currency } at exactly four decimal places", () => {
    expect(MoneySchema.safeParse({ amount: "1234.5000", currency: "MYR" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "-1.0000", currency: "MYR" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "1234.50", currency: "MYR" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: 1234.5, currency: "MYR" }).success).toBe(false);   // never a number (spec:2041)
    expect(MoneySchema.safeParse({ amount: "1.0000", currency: "myr" }).success).toBe(false);
  });

  it("quantities are six-dp strings and rates eight-dp strings", () => {
    expect(QuantitySchema.safeParse("12.000000").success).toBe(true);
    expect(QuantitySchema.safeParse("12.0000").success).toBe(false);
    expect(RateSchema.safeParse("4.68000000").success).toBe(true);
    expect(RateSchema.safeParse("4.68").success).toBe(false);
  });

  it("a list response is { items, next_cursor } and the default page is 100", () => {
    const List = ListEnvelope(z.object({ id: z.string() }));
    expect(List.safeParse({ items: [{ id: "a" }], next_cursor: null }).success).toBe(true);
    expect(ListQuery.parse({})).toEqual({ limit: 100 });
    expect(ListQuery.safeParse({ limit: "1001" }).success).toBe(false);
  });

  it("a cursor round-trips through base64url and rejects a tampered one", () => {
    const c = encodeCursor({ k: ["2026-01-02T00:00:00.000Z"], id: "0192f000-0000-7000-8000-000000000001" });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual({ k: ["2026-01-02T00:00:00.000Z"], id: "0192f000-0000-7000-8000-000000000001" });
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(/ERR_VALIDATION_FAILED/);
    expect(() => decodeCursor(Buffer.from("[]").toString("base64url"))).toThrow(/ERR_VALIDATION_FAILED/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/contracts && bun run test`
Expected: FAIL — `Cannot find module '../src/errors'` (and the same for `logger`, `common`).

- [ ] **Step 4: Write `packages/contracts/src/errors.ts`**

```ts
/**
 * The one file spec:2051 demands: "Codes are enumerated in one file; a code no code raises fails the build."
 * The build check is scripts/lint/rules/error-codes.ts (0B). The full v1 code SPACE is reserved in the contracts
 * document §4.2.4; this file holds only the codes whose raiser has shipped, so the check stays green at every phase.
 */
export interface ErrorDef {
  /** HTTP status of the problem response. */
  readonly status: number;
  /** Short English title from the registry — never the offending value. */
  readonly title: string;
  /** What the caller can do about it. */
  readonly remedy: string;
}

export const ERRORS = {
  ERR_VALIDATION_FAILED:      { status: 400, title: "Request failed validation",             remedy: "Correct the fields listed in `errors` and send the request again." },
  ERR_IDEMPOTENCY_KEY_MISSING:{ status: 400, title: "Idempotency-Key header required",       remedy: "Send an Idempotency-Key header (any string up to 200 characters) on every POST, PUT, PATCH and DELETE." },
  ERR_AUTH_TOKEN_INVALID:     { status: 401, title: "Access token invalid",                  remedy: "Sign in again to obtain a fresh access token." },
  ERR_AUTH_AAL_INSUFFICIENT:  { status: 401, title: "Multi-factor authentication required",  remedy: "Enrol a second factor and sign in again; only GET /v1/session is reachable at aal1." },
  ERR_AUTH_NO_MEMBERSHIP:     { status: 403, title: "No membership in any tenant",           remedy: "Ask an administrator of the tenant to invite this account." },
  ERR_RBAC_FORBIDDEN:         { status: 403, title: "Permission denied",                     remedy: "Ask an administrator to assign a role holding this permission in this company." },
  ERR_RLS_DENIED:             { status: 403, title: "Row is outside this tenant",            remedy: "Check the identifiers in the request; a row of another tenant is never reachable." },
  ERR_NOT_FOUND:              { status: 404, title: "Resource not found",                    remedy: "Check the identifier; it may have been archived, or belong to another tenant." },
  ERR_RBAC_SELF_GRANT:        { status: 409, title: "A principal cannot grant to themselves", remedy: "Ask a second administrator to make this change." },
  ERR_RBAC_SELF_ESCALATION:   { status: 409, title: "A principal cannot widen a role they hold", remedy: "Ask a second administrator to change this role's permissions." },
  ERR_RBAC_KIND:              { status: 409, title: "Role and principal kind do not match",  remedy: "Assign pos_terminal only to a terminal principal, and no other role to one." },
  ERR_RBAC_LAST_ADMIN:        { status: 409, title: "The last administrator cannot be removed", remedy: "Assign admin.user.manage to a second principal first." },
  ERR_ACTOR_IMMUTABLE:        { status: 409, title: "An actor column cannot be rewritten",   remedy: "Actor columns are stamped from the session and never supplied by the caller." },
  ERR_TABLE_IMMUTABLE:        { status: 409, title: "This row is append-only",               remedy: "Post a correcting entry instead of altering the original." },
  ERR_IDEMPOTENCY_KEY_REUSED: { status: 409, title: "Idempotency key reused with a different request", remedy: "Use a fresh Idempotency-Key for a different request body or path." },
  ERR_IDEMPOTENCY_IN_FLIGHT:  { status: 409, title: "An identical request is still running", remedy: "Wait for the seconds given in Retry-After and send the same request again." },
  ERR_CONFLICT_UNIQUE:        { status: 409, title: "A row with this key already exists",    remedy: "Change the code or name that must be unique, or update the existing row." },
  ERR_CONFLICT_REFERENCE:     { status: 409, title: "A referenced row does not exist or is still referenced", remedy: "Create the referenced row first, or remove the rows that reference this one." },
  ERR_LEDGER_UNBALANCED:      { status: 422, title: "Debits do not equal credits",           remedy: "Correct the lines so the document balances in every currency before posting." },
  ERR_PERIOD_NOT_OPEN:        { status: 422, title: "The fiscal period is not open",         remedy: "Post into an open period, or ask a principal with accounting.period.reopen to reopen it with a reason." },
  ERR_TENANT_CONTEXT_MISSING: { status: 500, title: "No tenant context on the transaction",  remedy: "This is a server defect — report the request id." },
  ERR_TENANT_CONTEXT_NESTED:  { status: 500, title: "Nested transaction",                    remedy: "This is a server defect — report the request id." },
  ERR_DB_POOLER_URL:          { status: 500, title: "Database URL is a transaction-mode pooler", remedy: "This is a deployment defect — the container must use a session-mode or direct URL on port 5432." },
  ERR_ROUTE_GATE_READONLY:    { status: 500, title: "An unsafe route is gated by a read-only permission", remedy: "This is a server defect caught at boot — gate the route with a mutating permission code." },
  ERR_INTERNAL:               { status: 500, title: "Unexpected server error",               remedy: "Report the request id; the details are in the server log, never in this response." },
} as const satisfies Record<string, ErrorDef>;

export type ErrCode = keyof typeof ERRORS;

export interface Problem {
  type: `urn:dulja:error:${ErrCode}`;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrCode;
  remedy: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

/** Every error the API answers with is one of these. `detail` names the specific entity (spec:2051). */
export class AppError extends Error {
  constructor(readonly code: ErrCode, readonly detail: string, readonly extra?: Partial<Problem> & { sqlstate?: string }) {
    super(`${code}: ${detail}`);
    this.name = "AppError";
  }
  get status(): number { return ERRORS[this.code].status; }
}

const DB_TOKEN = /^(ERR_[A-Z0-9_]+): (.*)$/s;

/**
 * postgres.js error → AppError. A CHECK violation whose message starts with a DB token carries that token
 * (plan0A:1130–1141); the pinned SQLSTATEs map by contract; everything else becomes ERR_INTERNAL with the
 * SQLSTATE kept in `extra` for the log line and stripped from the response (the inverse of LEGACY-083/084).
 */
export function fromDatabaseError(e: unknown): AppError {
  const err = e as { code?: unknown; message?: unknown };
  const sqlstate = typeof err.code === "string" ? err.code : undefined;
  const message = typeof err.message === "string" ? err.message : "";
  if (sqlstate === "23514") {
    const m = DB_TOKEN.exec(message);
    if (m && m[1]! in ERRORS) return new AppError(m[1] as ErrCode, m[2]!, { sqlstate });
  }
  if (sqlstate === "42501") return new AppError("ERR_RLS_DENIED", "the row belongs to another tenant, or the role lacks the privilege", { sqlstate });
  if (sqlstate === "23505") return new AppError("ERR_CONFLICT_UNIQUE", "a row with this key already exists in this tenant", { sqlstate });
  if (sqlstate === "23503") return new AppError("ERR_CONFLICT_REFERENCE", "a referenced row does not exist, or this row is still referenced", { sqlstate });
  // A CONDITIONAL SPREAD, not `{ sqlstate }`. The four branches above narrowed `sqlstate` to a string literal by
  // `===`; this line did not, so here it is still `string | undefined`. `tsconfig.base.json` sets
  // `exactOptionalPropertyTypes: true` (plan0A:274–288), under which an object literal may not supply an
  // explicit `undefined` for the optional `sqlstate?: string` — TS2379, and Step 10's `bun run typecheck` gate
  // would never be green. The type itself is left alone: contracts §4.2.4 freezes `extra?: Partial<Problem>` and
  // this plan has already widened it once.
  return new AppError("ERR_INTERNAL", "the request could not be completed", { ...(sqlstate !== undefined ? { sqlstate } : {}) });
}
```

- [ ] **Step 5: Write `packages/contracts/src/logger.ts`**

```ts
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  /** Returns a logger with these fields merged into every later call (spec:2063). */
  child(fields: LogFields): Logger;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The runtime twin of the `forbidden-log-fields` lint (contracts §3.7.5; spec:2063 "never a token, password…"). */
export const FORBIDDEN_LOG_FIELD = /token|password|authorization|card|pin|secret/i;

export interface LoggerOptions {
  level?: LogLevel;
  /** Where a finished line goes. Defaults to stdout; tests pass a collector. */
  sink?: (line: string) => void;
  base?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const sink = opts.sink ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const base = opts.base ?? {};

  const emit = (lvl: LogLevel, fields: LogFields, msg: string): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const merged: LogFields = { ...base, ...fields };
    const dropped = Object.keys(merged).filter((k) => FORBIDDEN_LOG_FIELD.test(k));
    for (const k of dropped) delete merged[k];
    if (dropped.length > 0) {
      sink(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg: "forbidden_log_field", fields: dropped }));
    }
    sink(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...merged }));
  };

  return {
    debug: (f, m) => emit("debug", f, m),
    info: (f, m) => emit("info", f, m),
    warn: (f, m) => emit("warn", f, m),
    error: (f, m) => emit("error", f, m),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}
```

- [ ] **Step 6: Write `packages/contracts/src/common.ts`**

```ts
import { z } from "zod";
import { AppError } from "./errors";

export const UuidSchema = z.string().uuid();
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);                  // effective_date and every `date` column
export const TimestampSchema = z.string().datetime({ offset: true });               // timestamptz, RFC 3339 UTC
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const MoneySchema = z.object({ amount: z.string().regex(/^-?\d+\.\d{4}$/), currency: CurrencySchema });   // Money.toJSON (0D)
export const QuantitySchema = z.string().regex(/^-?\d+\.\d{6}$/);                   // Quantity.toJSON (0D)
export const RateSchema = z.string().regex(/^\d+\.\d{8}$/);
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);                    // opaque base64url of { k, id }

export const ListEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });

export const ListQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  sort: z.string().optional(),
  fields: z.string().optional(),
});

export const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number(), detail: z.string(), instance: z.string(),
  code: z.string(), remedy: z.string(), requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

/** Keyset pagination: the cursor is the last row's sort values plus its id (contracts §4.2.8). */
export interface Cursor { k: unknown[]; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new AppError("ERR_VALIDATION_FAILED", `cursor ${JSON.stringify(raw)} is not a valid cursor`);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new AppError("ERR_VALIDATION_FAILED", "cursor is not decodable — start the listing again without a cursor"); }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Cursor).k) || typeof (parsed as Cursor).id !== "string") {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor does not carry a sort key and an id — start the listing again without a cursor");
  }
  return parsed as Cursor;
}

/** The filter grammar of contracts §4.2.8: `filter[<field>][<op>]=<value>`. No field name ever reaches SQL as text. */
export const FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface FilterClause { field: string; op: FilterOp; value: string }

/** Parses the query string's filter[…][…] pairs into clauses. Unknown fields are rejected by the caller, which
 *  owns the whitelist of columns — a field name is never interpolated (test 27). */
export function parseFilters(query: Record<string, string | string[]>): FilterClause[] {
  const out: FilterClause[] = [];
  for (const [key, raw] of Object.entries(query)) {
    const m = /^filter\[([a-z_]+)\]\[([a-z]+)\]$/.exec(key);
    if (!m) continue;
    const op = m[2] as FilterOp;
    if (!(FILTER_OPS as readonly string[]).includes(op)) {
      throw new AppError("ERR_VALIDATION_FAILED", `filter operator ${JSON.stringify(op)} is not one of ${FILTER_OPS.join(", ")}`);
    }
    out.push({ field: m[1]!, op, value: Array.isArray(raw) ? raw[0]! : raw });
  }
  return out;
}
```

- [ ] **Step 7: Write `packages/contracts/src/index.ts`**

```ts
export * from "./common";
export * from "./errors";
export * from "./logger";
export * from "./permissions-re-export";
```

…and, because `permissions.ts` lives at the package root (spec:2135's literal path) while `src/` is the entry point, add the one-line bridge `packages/contracts/src/permissions-re-export.ts`:

```ts
export * from "../permissions";
```

`permissions.ts` itself arrives in Task 7; until then create it as an empty module so the bridge compiles:

```bash
printf '// The permission catalogue (spec:2135). Populated in Task 7.\nexport {};\n' > packages/contracts/permissions.ts
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/contracts && bun run test`
Expected: PASS (14 tests across three files).

- [ ] **Step 9: Write ADR 0003**

`docs/adr/0003-problem-json-error-envelope.md`:

```markdown
# ADR-0003 — RFC 9457 `application/problem+json` with `code` and `remedy`, from one registry

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0B

## Context
spec:2051 requires every API error to carry a stable machine-readable code, a human message naming the specific
entity, and a remedy — the inverse of LEGACY-084, where messages were neither actionable nor conventional, and of
LEGACY-083, where one handler in 33,179 lines swallowed the error. spec:2205 fixes the media type as RFC 9457
`application/problem+json`. RFC 9457 defines `type`, `title`, `status`, `detail` and `instance`; it says nothing
about a machine code or a remedy, and it invites extension members.

## Decision
Two extension members, `code` and `remedy`, plus `requestId`, and an optional `errors` array used only by
`ERR_VALIDATION_FAILED`. `type` is the URN `urn:dulja:error:<CODE>` — a URN, not an HTTP URL, so no domain is
invented and no documentation host has to exist. `packages/contracts/src/errors.ts` is the single registry of
shipped codes; the contracts document §4.2.4 is the registry of the whole reserved code space, so two slices can
never spell one condition two ways. `fromDatabaseError` is the only translator from a driver error, and it never
echoes driver text: an unmapped SQLSTATE becomes `ERR_INTERNAL` with the SQLSTATE kept for the log line.

## Consequences
- `scripts/lint/rules/error-codes.ts` (Task 12 writes it; Task 14 only consumes it) fails the build for a code in `ERRORS` with no raise site.
- Every slice adds its rows to the contracts table first and to `ERRORS` in the PR that raises them.
- A caller can branch on `code` without parsing English; the OpenAPI document ships `ProblemSchema` on every route.
```

- [ ] **Step 10: Run the root gates and commit**

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```bash
git add packages/contracts docs/adr/0003-problem-json-error-envelope.md package.json bun.lock
git commit -m "feat(contracts): common schemas, the ERR_* registry and the structured logger [0B T3]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: `apps/api` skeleton — config, request context, the fixed middleware chain, the problem handler, `/healthz`, the `ROUTES` registry (ADR 0006)

The application object every later task hangs a route on. It boots with no routes but `/healthz`, and it already answers every failure as `application/problem+json` — so no later task has to invent an error path.

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/src/config.ts`, `apps/api/src/context.ts`, `apps/api/src/ports.ts`, `apps/api/src/problem.ts`, `apps/api/src/middleware/request-id.ts`, `apps/api/src/middleware/logger.ts`, `apps/api/src/routes/index.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `packages/db/src/jobs/names.ts`, `packages/db/src/jobs/payloads.ts` (**a types-only stub — 0D Task 6 replaces its body**), `packages/db/src/jobs/enqueue.ts`, `docs/adr/0006-route-registry-and-isolation-probes.md`
- Modify: `packages/db/src/index.ts`
- Test: `apps/api/test/routes/health.test.ts`

**Interfaces:**
- Consumes: `createDb`, `type TenantContext`, `withTenant` from `@dulja/db` (Task 2); `AppError`, `ERRORS`, `fromDatabaseError`, `type ErrCode`, `type Logger`, `type Problem`, `createLogger` from `@dulja/contracts` (Task 3).
- Produces:

```ts
// apps/api/src/context.ts  (contracts §4.2.3, plus requestId/traceId — set before auth resolves a ctx)
export interface RequestContext extends TenantContext { readonly principalKind: "human" | "system" | "terminal"; readonly aal: "aal1" | "aal2" }
export type AppEnv = { Variables: {
  ctx: RequestContext;
  withTenant: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  logger: Logger;
  requestId: string;
  traceId: string;
} };

// apps/api/src/ports.ts — the two seams apps/api owns but does not implement
export interface VerifiedToken { readonly sub: string; readonly aal: "aal1" | "aal2" }
export type JwtVerifier = (token: string) => Promise<VerifiedToken>;
export interface InvitedUser { readonly sub: string; readonly email: string }
export interface AuthAdmin { inviteUser(email: string): Promise<InvitedUser> }

// apps/api/src/routes/index.ts  (contracts §4.2.7, verbatim)
export interface RouteModule { readonly path: string; readonly router: OpenAPIHono<AppEnv>;
  readonly permissions: readonly PermissionCode[]; readonly auth: "human" | "terminal" | "public" }
export const ROUTES: readonly RouteModule[];

// apps/api/src/app.ts
export interface AppDeps { db: Sql; jobs: JobClient; logger: Logger; authAdmin: AuthAdmin; verifier: JwtVerifier }
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv>;

// apps/api/src/problem.ts
export function toProblem(c: Context<AppEnv>, e: unknown): Problem;
export function toProblemResponse(c: Context<AppEnv>, e: unknown): Response;

// packages/db/src/jobs/*  — TYPES ONLY; the pg-boss adapter and createJobClient are 0D's (contracts §4.2.6).
// `payloads.ts` in particular ships here as a STUB: 0B needs a `JobPayload` for `JobClient.enqueue`'s signature
// but owns no job, so it declares the widest form and 0D Task 6 replaces the file with the registered
// `extends Record<JobName, unknown>` map (contracts §4.2.6). `JobPayload[N]` is `unknown` under both, so every
// 0B reference below typechecks unchanged across that replacement, and no 0B call site is edited by 0D.
export const JOBS: { readonly [name: string]: { readonly schedule: string | null; readonly owner: string } };
export type JobName = keyof typeof JOBS;
export interface JobPayload { [name: string]: unknown }   // STUB — 0D Task 6 replaces it with `extends Record<JobName, unknown>` (contracts §4.2.6)
export interface JobEnvelope<T = unknown> { readonly tenantId: string; readonly requestId: string; readonly payload: T }
export interface EnqueueOptions { singletonKey?: string; startAfterSeconds?: number; retryLimit?: number; retryDelaySeconds?: number }
export interface JobClient { enqueue<N extends JobName>(tx: Sql, name: N, job: JobEnvelope<JobPayload[N]>, opts?: EnqueueOptions): Promise<string> }
```

- [ ] **Step 1: Scaffold the workspace**

`apps/api/package.json`:

```json
{
  "name": "@dulja/api",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "dev": "bun run --watch src/index.ts",
    "openapi:generate": "bun run src/openapi.ts"
  }
}
```

`apps/api/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }
```

`apps/api/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Route tests start a Testcontainers Postgres each; they are slow and must not race for ports.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 180_000, fileParallelism: false },
});
```

```bash
cd apps/api && bun add hono @hono/zod-openapi zod uuid && bun add -d @types/node && cd ../..
```

`openapi:generate` names `src/openapi.ts`, which Task 12 writes; the script line lands now so `packages/contracts`'s own `openapi:generate` (Task 3) has a target from the first day.

- [ ] **Step 2: Write the job type files (types only — the adapter is 0D's)**

`packages/db/src/jobs/names.ts` — the registry verbatim from contracts §4.2.6. A job name not listed here fails the build:

```ts
export const JOBS = {
  "accounting.ledger.integrity_check": { schedule: "0 2 * * *", owner: "1B" },   // scaffolded in 0D
  "accounting.projection.rebuild":     { schedule: "0 3 * * *", owner: "4B" },   // party_ageing, item_profitability
  "inventory.projection.rebuild":      { schedule: "0 3 * * *", owner: "3B" },   // stock_valuation
  "accounting.period.month_end":       { schedule: "0 1 1 * *", owner: "1B" },
  "accounting.tax.submit":             { schedule: null,        owner: "5B" },
  "admin.idempotency_key.purge":       { schedule: "*/30 * * * *", owner: "0D" },
  "admin.export.run":                  { schedule: null,        owner: "7C" },
  "admin.import.run":                  { schedule: null,        owner: "9B" },
  "inventory.cost.replay":             { schedule: null,        owner: "3B" },
  "inventory.lot.expiry_warning":      { schedule: "0 6 * * *", owner: "3A" },
  "pos.sync.apply":                    { schedule: null,        owner: "6A" },
  "pos.cashier.compare":               { schedule: "30 2 * * *", owner: "6C" },
  "reporting.render":                  { schedule: null,        owner: "7A" },
  "hr.employee_ytd.rebuild":           { schedule: "0 4 * * *", owner: "8C" },
  "hr.rate_table.lapse_warning":       { schedule: "0 7 * * *", owner: "8A" },
  "hr.encryption_key.rotate":          { schedule: null,        owner: "8D" },
} as const;
export type JobName = keyof typeof JOBS;
```

`packages/db/src/jobs/payloads.ts` — **a types-only stub; 0D Task 6 replaces this file's body**, because 0B ships no job of its own and only needs a `JobPayload` for `JobClient.enqueue`'s signature. The registered shape is 0D's `extends Record<JobName, unknown>` (contracts §4.2.6); the index signature below is the same thing minus the `JobName` constraint 0B cannot yet impose meaningfully, and `JobPayload[N]` is `unknown` under both, so nothing 0B writes changes when 0D lands:

```ts
/**
 * STUB (slice 0B) — 0D replaces this file with the registered map keyed by `JobName` (contracts §4.2.6).
 *
 * The payload type of each job, grown additively per slice: a slice adds one line for its own job name and
 * touches no other. The index signature keeps `JobPayload[N]` well-typed for names no slice has narrowed yet.
 */
export interface JobPayload { [name: string]: unknown }
```

`packages/db/src/jobs/enqueue.ts` — interfaces only. **0D adds `createJobClient` and the pg-boss import to this file**; 0B must not import pg-boss, which is not installed yet:

```ts
import type { Sql } from "postgres";
import type { JobName } from "./names";
import type { JobPayload } from "./payloads";

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
   * never on rollback (spec:2321). Returns the pg-boss job id. The implementation is 0D's (contracts §4.2.6).
   */
  enqueue<N extends JobName>(tx: Sql, name: N, job: JobEnvelope<JobPayload[N]>, opts?: EnqueueOptions): Promise<string>;
}
```

Append to `packages/db/src/index.ts`:

```ts
export { JOBS, type JobName } from "./jobs/names";
export type { JobPayload } from "./jobs/payloads";
export type { EnqueueOptions, JobClient, JobEnvelope } from "./jobs/enqueue";
```

- [ ] **Step 3: Write the failing test**

`apps/api/test/routes/health.test.ts`:

```ts
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { createLogger } from "@dulja/contracts";
import { createApp } from "../../src/app";

const deps = {
  db: null as unknown as Sql,                                              // /healthz touches no database
  jobs: { enqueue: () => { throw new Error("no job client in this test"); } },
  logger: createLogger({ sink: () => {} }),
  authAdmin: { inviteUser: () => { throw new Error("no auth admin in this test"); } },
  verifier: () => { throw new Error("no verifier in this test"); },
} as never;

describe("the api skeleton — spec:2314, 2055, 2063", () => {
  it("GET /healthz is public, returns 200 and echoes a request id", async () => {
    const res = await createApp(deps).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a caller-supplied request id, and mints one when the header is not a uuid", async () => {
    const given = "0192f000-0000-7000-8000-0000000000aa";
    const echoed = await createApp(deps).request("/healthz", { headers: { "X-Request-Id": given } });
    expect(echoed.headers.get("X-Request-Id")).toBe(given);
    const minted = await createApp(deps).request("/healthz", { headers: { "X-Request-Id": "'; drop table app.tenant --" } });
    expect(minted.headers.get("X-Request-Id")).not.toContain("drop table");
  });

  it("an unknown path is an RFC 9457 problem, not an HTML 404", async () => {
    const res = await createApp(deps).request("/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_NOT_FOUND");
    expect(body.type).toBe("urn:dulja:error:ERR_NOT_FOUND");
    expect(body.instance).toBe("/v1/nope");
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(body.remedy.length).toBeGreaterThan(0);
  });

  it("a thrown driver error becomes ERR_INTERNAL and never echoes the driver text (LEGACY-083)", async () => {
    const app = createApp(deps);
    app.get("/boom", () => { throw Object.assign(new Error('relation "app.secret" does not exist'), { code: "42P01" }); });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_INTERNAL");
    expect(JSON.stringify(body)).not.toContain("app.secret");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run --cwd apps/api test`
Expected: FAIL — `Cannot find module '../../src/app'`.

- [ ] **Step 5: Write `apps/api/src/config.ts`**

```ts
import type { LogLevel } from "@dulja/contracts";

/** The §3.11 environment, read once at boot. Names are frozen by the contracts document; 0C supplies the values. */
export interface ApiConfig {
  readonly appEnv: "dev" | "staging" | "production";
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly supabaseJwksUrl: string;
  readonly supabaseJwtIssuer: string;
  readonly port: number;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is not set — see docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md §3.11`);
  return v;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const appEnv = env["APP_ENV"] ?? "dev";
  if (appEnv !== "dev" && appEnv !== "staging" && appEnv !== "production") {
    throw new ConfigError(`APP_ENV must be dev, staging or production (got ${JSON.stringify(appEnv)})`);
  }
  const level = env["LOG_LEVEL"] ?? "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error (got ${JSON.stringify(level)})`);
  }
  return {
    appEnv,
    logLevel: level,
    databaseUrl: required(env, "DATABASE_URL"),
    supabaseJwksUrl: required(env, "SUPABASE_JWKS_URL"),
    supabaseJwtIssuer: required(env, "SUPABASE_JWT_ISSUER"),
    port: Number(env["PORT"] ?? "8080"),
  };
}
```

- [ ] **Step 6: Write `apps/api/src/context.ts` and `apps/api/src/ports.ts`**

`apps/api/src/context.ts`:

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "@dulja/db";
import type { Logger } from "@dulja/contracts";

export interface RequestContext extends TenantContext {
  readonly principalKind: "human" | "system" | "terminal";
  readonly aal: "aal1" | "aal2";
}

/**
 * Contracts §4.2.3. `requestId` and `traceId` are separate variables because the request-id middleware runs
 * BEFORE auth: a 401 problem still has to carry a request id, and `ctx` does not exist yet at that point.
 */
export type AppEnv = {
  Variables: {
    ctx: RequestContext;                                          // set by the identity middleware (Task 5)
    withTenant: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;   // = withTenant(db, c.var.ctx, fn) — spec:1368
    logger: Logger;                                               // fields tenant_id, actor_id, request_id, trace_id preset
    requestId: string;
    traceId: string;
  };
};
```

`apps/api/src/ports.ts`:

```ts
/**
 * The two seams apps/api declares and does not implement, so the app object can be built in a test without
 * Supabase. Implementations land in Task 5 (`verifier.ts`, `auth-admin.ts`); which AuthAdmin the deployed
 * container is given is 0C's wiring decision (ADR 0005, ADR 0011).
 */
export interface VerifiedToken {
  readonly sub: string;                    // the Supabase subject → app.principal.auth_subject
  readonly aal: "aal1" | "aal2";           // spec:2004 — anything below aal2 reaches only the exempt routes
}
export type JwtVerifier = (token: string) => Promise<VerifiedToken>;

export interface InvitedUser {
  readonly sub: string;
  readonly email: string;
}

/** spec:2132: a principal is created from the `sub` the SERVER obtained, never from a client-supplied subject. */
export interface AuthAdmin {
  inviteUser(email: string): Promise<InvitedUser>;
}
```

- [ ] **Step 7: Write `apps/api/src/problem.ts`**

```ts
import type { Context } from "hono";
import { ZodError } from "zod";
import { AppError, ERRORS, fromDatabaseError, type ErrCode, type Problem } from "@dulja/contracts";
import { TenantContextError } from "@dulja/db";
import type { AppEnv } from "./context";

/** A postgres.js error carries a five-character SQLSTATE in `code`. */
function isDatabaseError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string"
    && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);
}

function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) {
    return new AppError("ERR_VALIDATION_FAILED", "one or more fields are invalid", {
      errors: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (e instanceof TenantContextError) return new AppError(e.code as ErrCode, e.message.replace(/^ERR_[A-Z_]+: /, ""));
  if (isDatabaseError(e)) return fromDatabaseError(e);
  return new AppError("ERR_INTERNAL", "the request could not be completed");
}

/** The one place a Problem is constructed (ADR 0003). `detail` names the entity; driver text never reaches it. */
export function toProblem(c: Context<AppEnv>, e: unknown): Problem {
  const err = asAppError(e);
  const def = ERRORS[err.code];
  const problem: Problem = {
    type: `urn:dulja:error:${err.code}`,
    title: def.title,
    status: def.status,
    detail: err.detail,
    instance: new URL(c.req.url).pathname,
    code: err.code,
    remedy: def.remedy,
    requestId: c.get("requestId") ?? "",
  };
  return err.extra?.errors ? { ...problem, errors: err.extra.errors } : problem;
}

export function toProblemResponse(c: Context<AppEnv>, e: unknown): Response {
  const problem = toProblem(c, e);
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "X-Request-Id": problem.requestId,
  };
  if (problem.code === "ERR_IDEMPOTENCY_IN_FLIGHT") headers["Retry-After"] = "2";
  return new Response(JSON.stringify(problem), { status: problem.status, headers });
}
```

- [ ] **Step 8: Write the two always-on middlewares**

`apps/api/src/middleware/request-id.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { v7 as newUuidV7 } from "uuid";
import type { AppEnv } from "../context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** W3C traceparent: version-traceid-spanid-flags. Only the 32-hex trace id is taken. */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

/**
 * spec:2063 wants request_id and trace_id on every line. An incoming X-Request-Id is honoured only when it is a
 * uuid — a caller-supplied string would otherwise reach the log and the audit context unvalidated (LEGACY-026).
 * In 0B `trace_id` comes from `traceparent` when present and falls back to the request id; 0C replaces this with
 * the OpenTelemetry context and the value keeps the same field name.
 */
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const given = c.req.header("X-Request-Id");
    const id = given && UUID.test(given) ? given : newUuidV7();
    const tp = TRACEPARENT.exec(c.req.header("traceparent") ?? "");
    c.set("requestId", id);
    c.set("traceId", tp?.[1] ?? id);
    c.header("X-Request-Id", id);
    await next();
    c.header("X-Request-Id", id);   // also on responses a handler replaced wholesale
  };
}
```

`apps/api/src/middleware/logger.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import type { Logger } from "@dulja/contracts";
import type { AppEnv } from "../context";

/** Presets the four fields spec:2063 requires; tenant_id and actor_id are re-bound by the auth middleware. */
export function loggerMiddleware(base: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const log = base.child({ request_id: c.get("requestId"), trace_id: c.get("traceId"), tenant_id: null, actor_id: null });
    c.set("logger", log);
    const started = Date.now();
    await next();
    log.info({ method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - started }, "request");
  };
}
```

- [ ] **Step 9: Write the route registry and `/healthz`**

`apps/api/src/routes/health.ts`:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context";

export const healthRoutes = new OpenAPIHono<AppEnv>();

healthRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["health"],
    summary: "Liveness probe — reachable through the edge Worker, never publicly (spec:2314)",
    responses: {
      200: { description: "The container is up", content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } } },
    },
  }),
  (c) => c.json({ status: "ok" as const }),
);
```

`apps/api/src/routes/index.ts`:

```ts
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PermissionCode } from "@dulja/contracts";
import type { AppEnv } from "../context";
import { healthRoutes } from "./health";

/**
 * Contracts §4.2.7. Production only — no test type is reachable from here, because a route module must not
 * depend on Testcontainers (§3.1). The tenant-isolation probe for each entry lives in tests/invariants/probes.ts.
 */
export interface RouteModule {
  readonly path: string;                              // mount prefix, e.g. "/v1/companies/:companyId/role-assignments"
  readonly router: OpenAPIHono<AppEnv>;
  readonly permissions: readonly PermissionCode[];    // every code this module evaluates (the catalogue check reads it)
  readonly auth: "human" | "terminal" | "public";     // /healthz is public; /v1/sync/* is terminal (6A)
}

export const ROUTES: readonly RouteModule[] = [
  { path: "/healthz", router: healthRoutes, permissions: [], auth: "public" },
];
```

`PermissionCode` does not exist until Task 7 populates `permissions.ts`; the empty module created in Task 3 exports nothing, so add the placeholder-free type alias to `packages/contracts/permissions.ts` now — one line that Task 7 replaces with the real catalogue:

```ts
// The permission catalogue (spec:2135). Task 7 replaces this file with PERMISSIONS, PERMISSION and isMutating.
export type PermissionCode = string;
```

- [ ] **Step 10: Write `apps/api/src/app.ts`**

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import type { Logger } from "@dulja/contracts";
import { AppError } from "@dulja/contracts";
import type { JobClient } from "@dulja/db";
import type { AppEnv } from "./context";
import { loggerMiddleware } from "./middleware/logger";
import { requestId } from "./middleware/request-id";
import { toProblemResponse } from "./problem";
import { ROUTES } from "./routes";
import type { AuthAdmin, JwtVerifier } from "./ports";

export interface AppDeps {
  db: Sql;
  jobs: JobClient;
  logger: Logger;
  authAdmin: AuthAdmin;      // contracts §4.2.7 + this plan's assumption 1
  verifier: JwtVerifier;     // contracts §4.2.7 + this plan's assumption 1
}

/**
 * The middleware order is fixed by contracts §4.2.3: requestId → logger → auth → idempotency → requirePermission
 * → handler. `auth` and `idempotency` are registered on "/v1/*" in Tasks 5 and 6; `requirePermission` is per route.
 * Zod validation failures are turned into ERR_VALIDATION_FAILED by the defaultHook so no handler repeats it.
 */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {                 // no `c` parameter: it is unused, and oxlint's correctness set
      if (!result.success) {                   // reports an unused one (a shorter callback is assignable)
        throw new AppError("ERR_VALIDATION_FAILED", "one or more fields are invalid", {
          errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
    },
  });

  app.use("*", requestId());
  app.use("*", loggerMiddleware(deps.logger));

  app.onError((e, c) => {
    const problem = toProblemResponse(c, e);
    if (problem.status >= 500) {
      c.get("logger")?.error({ err: String(e), sqlstate: (e as { extra?: { sqlstate?: string } }).extra?.sqlstate }, "unhandled");
    }
    return problem;
  });
  app.notFound((c) => toProblemResponse(c, new AppError("ERR_NOT_FOUND", `no route matches ${c.req.method} ${new URL(c.req.url).pathname}`)));

  for (const module of ROUTES) app.route(module.path, module.router);
  return app;
}
```

`deps.db`, `deps.jobs` and `deps.authAdmin` are unused until Tasks 5–8 wire them; they are in the signature now so no later task changes it. Add `void deps.db; void deps.jobs; void deps.authAdmin; void deps.verifier;` immediately above `return app;` so oxlint's `correctness` set (`no-unused-vars` — `.oxlintrc.json`, plan0A:290) stays quiet, and delete those lines as each becomes used. `tsconfig.base.json` sets no `noUnusedParameters` (plan0A:274–288), so the lint, not the compiler, is what these silence.

- [ ] **Step 11: Specify the container entrypoint `apps/api/src/index.ts`**

A top-level `export default` cannot sit inside a `try`, so the config read is what the `try` wraps and the module body continues after it. This is the exact shape — there is no other version of this file:

```ts
import { createDb } from "@dulja/db";
import { createLogger } from "@dulja/contracts";
import { createApp } from "./app";
import { ConfigError, readConfig, type ApiConfig } from "./config";
import { StubAuthAdmin } from "./auth-admin";
import { createJwtVerifier } from "./verifier";

let config: ApiConfig;
try {
  config = readConfig();
} catch (e) {
  if (e instanceof ConfigError) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  throw e;
}

const logger = createLogger({ level: config.logLevel, base: { app_env: config.appEnv } });
const app = createApp({
  db: createDb(config.databaseUrl),
  jobs: { enqueue: () => { throw new Error("the job client is wired in slice 0D"); } },
  logger,
  authAdmin: new StubAuthAdmin(),
  verifier: createJwtVerifier({ jwksUrl: config.supabaseJwksUrl, issuer: config.supabaseJwtIssuer }),
});
logger.info({ port: config.port }, "api listening");

export default { port: config.port, fetch: app.fetch };
```

`StubAuthAdmin` and `createJwtVerifier` arrive in Task 5. Until then this file does not compile, so **create `apps/api/src/index.ts` at the end of Task 5, not here** — Step 11 is the specification of that file, and Task 5 Step 9 writes it.

- [ ] **Step 12: Run the health test to verify it passes**

Run: `bun run --cwd apps/api test`
Expected: PASS (4 tests).

- [ ] **Step 13: Write ADR 0006**

`docs/adr/0006-route-registry-and-isolation-probes.md`:

```markdown
# ADR-0006 — A `ROUTES` registry in production, an isolation-probe registry in the test tier

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0B

## Context
spec:2128 requires "a suite that attempts cross-tenant read/write through **every endpoint** and every background
job, run in CI", and spec:2055 requires an OpenAPI document generated from the same route definitions. Both need
one enumerable list of routes. The obvious shape — put the isolation probe on the route module itself — would
make every file in `apps/api/src/routes/` depend on `Db` and `Seed` from `@dulja/db/test`, and therefore on
Testcontainers, which the §5.2 dependency rule forbids of an app-tier module.

## Decision
`apps/api/src/routes/index.ts` exports `ROUTES: readonly RouteModule[]` with `{ path, router, permissions, auth }`
and nothing test-shaped. The probes live in the test tier, in `tests/invariants/probes.ts`, keyed by the exact
`RouteModule.path` string. `tests/invariants/tenant-isolation.test.ts` fails the build when a `ROUTES` entry has
no `PROBES[path]`, and when a `PROBES` key matches no route — so the guarantee "every endpoint is probed" holds
without the production module knowing what a probe is.

URL scheme: tenant-scoped resources at `/v1/admin/<resource>` and `/v1/companies`; company-scoped resources at
`/v1/companies/{companyId}/<resource>` with no module segment (resource names are unique); terminal routes at
`/v1/sync/<resource>` (6A); async job status at `/v1/jobs/{jobId}`; `/healthz` outside `/v1`. Every `documents`
route is generic over document types — a type-specific route is a convention violation (contracts §4.2.7).

## Consequences
- Adding a route without a probe fails CI, which is the mechanical form of spec:2128.
- `createApp(deps)` takes its dependencies as an object so a test can substitute the database, the job client,
  the JWT verifier and the Supabase admin port without touching any route file.
- 6A registers `/v1/sync/*` middleware **before** the `/v1/*` human chain, because Hono runs matching middleware
  in registration order.
```

- [ ] **Step 14: Run the root gates and commit**

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```bash
git add apps/api packages/db/src/jobs packages/db/src/index.ts packages/contracts/permissions.ts \
        docs/adr/0006-route-registry-and-isolation-probes.md package.json bun.lock
git commit -m "$(cat <<'EOF'
feat(api): Hono skeleton, request context, problem envelope, ROUTES registry [0B T4]

/healthz answers 200 through a fixed middleware chain; every failure, including a
404 and an unmapped SQLSTATE, is application/problem+json carrying the request id.
packages/db/src/jobs holds the JOBS registry and the JobClient TYPES only — the
pg-boss adapter is slice 0D's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 5: **OWNER GATE OD-01 / OD-02** — the identity chain, `GET /v1/session`, and `startApi()` (ADR 0005)

> **Owner gate.** This is the one isolated task carrying **OD-01** (v1.1 changelog #2 — the `principal` RLS split into SELECT/UPDATE + INSERT policies) and **OD-02** (v1.1 changelog #3 — `resolve_principal` owned by `app_auth`). Both are marked *Confirm* in the spec header (spec:15–16) and both are **already built by Plan 0A Task 5**; the contracts default is "as built", so **nothing here blocks merge**. *If OD-01 is rejected:* this task's `authenticate` is unchanged, and only Task 8's invite handler moves — the "insert `principal` without `RETURNING`, then `membership`, in one transaction" shape is replaced by whatever the owner confirms. *If OD-02 is rejected:* `resolvePrincipal`'s SQL is unchanged, and only the `resolve_principal` clause of Task 14's auth-bypass suite is rewritten. No file outside those two moves.

**Files:**
- Create: `apps/api/src/verifier.ts`, `apps/api/src/auth-admin.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/session.ts`, `apps/api/src/index.ts`, `packages/contracts/src/session.ts`, `apps/api/test/support/app.ts`, `docs/adr/0005-identity-chain-and-supabase-jwks.md`
- Modify: `apps/api/src/app.ts`, `apps/api/src/routes/index.ts`, `packages/contracts/src/index.ts`
- Test: `apps/api/test/middleware/auth.test.ts`, `apps/api/test/routes/session.test.ts`

**Interfaces:**
- Consumes: `createApp`, `AppDeps`, `AppEnv`, `RequestContext`, `AuthAdmin`, `JwtVerifier`, `VerifiedToken`, `toProblemResponse`, `ROUTES` (Task 4); `createDb`, `resolvePrincipal`, `withTenant` from `@dulja/db` (Task 2); `startDb`, `seedTenant`, `uuidv7`, `Db`, `Seed` from `@dulja/db/test` (Task 1); `AppError`, `createLogger` from `@dulja/contracts` (Task 3).
- Produces:

```ts
// apps/api/src/verifier.ts
export function createJwtVerifier(opts: { jwksUrl: string; issuer: string }): JwtVerifier;
export function createJwtVerifierWithKeys(opts: { keys: JWTVerifyGetKey; issuer: string }): JwtVerifier;

// apps/api/src/auth-admin.ts
export class SupabaseAuthAdmin implements AuthAdmin { constructor(opts: { url: string; serviceRoleKey: string; invitePath: string }) }
export class StubAuthAdmin implements AuthAdmin { constructor(seed?: string) }        // sub = `stub:${sha256(email)}`

// apps/api/src/middleware/auth.ts
export const AAL1_PATHS: ReadonlySet<string>;                                          // { "/v1/session" }
export function authenticate(deps: { db: Sql; verifier: JwtVerifier }): MiddlewareHandler<AppEnv>;

// packages/contracts/src/session.ts
export const SessionSchema: z.ZodObject<{ principalId; tenantId; principalKind; aal; displayName; email }>;

// apps/api/test/support/app.ts  (contracts §4.2.12, verbatim shapes)
export interface ApiRequest { method; path; body?; form?; as?; aal?; idempotencyKey?; headers? }
export interface StartedApi { db: Db; app: OpenAPIHono<AppEnv>; tokenFor(principalId: string, aal?: "aal1" | "aal2"): string;
  signToken(claims: Record<string, unknown>): string;      // added by 0B — contracts §4.2.12 addition to record
  request(input: ApiRequest): Promise<Response>; stop(): Promise<void> }
export function startApi(): Promise<StartedApi>;
export const TEST_ISSUER = "https://test.dulja.invalid/auth/v1";
```

- [ ] **Step 1: Write the failing tests**

`apps/api/test/middleware/auth.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, TEST_ISSUER, type StartedApi } from "../support/app";

describe("identity chain — spec:2004, 2132, §5.0 row 0.6; acceptance test 11", () => {
  let api: StartedApi; let a: Seed;
  beforeAll(async () => { api = await startApi(); a = await seedTenant(api.db, "Alpha"); });
  afterAll(async () => { await api.stop(); });

  const problem = async (res: Response) => (await res.json()) as Problem;

  it("no Authorization header is ERR_AUTH_TOKEN_INVALID, not a 500", async () => {
    const res = await api.request({ method: "GET", path: "/v1/session" });
    expect(res.status).toBe(401);
    expect((await problem(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
  });

  it("a token signed by another key, with the wrong issuer, or expired is refused", async () => {
    // `tokenFor` always writes iss: TEST_ISSUER and exp: now + 600, so expiry and issuer are exercised through
    // `signToken`, which signs an arbitrary claim set with the same key and kid. `sub` is the seeded owner's
    // real auth_subject (plan0A:1586) so the 401 proves jose's exp/iss checks fired, not a missing membership.
    const now = Math.floor(Date.now() / 1000);
    const sub = `human:${a.tenant}`;
    for (const header of [
      "Bearer not.a.jwt",
      `Bearer ${api.tokenFor(a.human)}x`,                                   // signature tampered
      `Bearer ${api.signToken({ sub, aal: "aal2", iss: TEST_ISSUER, iat: now - 3600, exp: now - 60 })}`,          // expired
      `Bearer ${api.signToken({ sub, aal: "aal2", iss: "https://other.invalid/auth/v1", iat: now, exp: now + 600 })}`,  // wrong issuer
    ]) {
      const res = await api.request({ method: "GET", path: "/v1/session", headers: { Authorization: header } });
      expect(res.status, header).toBe(401);
      expect((await problem(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
    }
  });

  it("a valid token whose sub has no membership is 403 ERR_AUTH_NO_MEMBERSHIP", async () => {
    const orphan = await uuidv7(api.db.admin);
    const res = await api.request({ method: "GET", path: "/v1/session", as: orphan });
    expect(res.status).toBe(403);
    expect((await problem(res)).code).toBe("ERR_AUTH_NO_MEMBERSHIP");
  });

  it("aal1 reaches GET /v1/session and nothing else (spec:2004)", async () => {
    const ok = await api.request({ method: "GET", path: "/v1/session", as: a.human, aal: "aal1" });
    expect(ok.status).toBe(200);
    const blocked = await api.request({ method: "GET", path: "/v1/companies", as: a.human, aal: "aal1" });
    expect(blocked.status).toBe(401);
    expect((await problem(blocked)).code).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("a forged X-Tenant-Id or X-Actor-Id header changes nothing — identity comes from the token (LEGACY-026)", async () => {
    const b = await seedTenant(api.db, "Beta");
    const res = await api.request({
      method: "GET", path: "/v1/session", as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: a.tenant, principalId: a.human });
  });

  it("/healthz needs no token at all", async () => {
    expect((await api.request({ method: "GET", path: "/healthz" })).status).toBe(200);
  });
});
```

`apps/api/test/routes/session.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

describe("GET /v1/session — the aal1 exemption the owner's first login needs (spec:2317)", () => {
  let api: StartedApi; let a: Seed;
  beforeAll(async () => { api = await startApi(); a = await seedTenant(api.db, "Alpha"); });
  afterAll(async () => { await api.stop(); });

  it("returns the caller's principal, tenant, kind and aal, and no permission is required", async () => {
    const res = await api.request({ method: "GET", path: "/v1/session", as: a.human, aal: "aal1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principalId: a.human, tenantId: a.tenant, principalKind: "human", aal: "aal1",
      displayName: "Alpha owner", email: null,
    });
  });

  it("reports aal2 once the caller has enrolled", async () => {
    const res = await api.request({ method: "GET", path: "/v1/session", as: a.human });
    expect(await res.json()).toMatchObject({ aal: "aal2" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd apps/api test -- test/middleware/auth.test.ts`
Expected: FAIL — `Cannot find module '../support/app'`.

- [ ] **Step 3: Write `apps/api/src/verifier.ts`**

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "@dulja/contracts";
import type { JwtVerifier, VerifiedToken } from "./ports";

/** Supabase puts the assurance level in `aal`; anything not "aal2" is treated as aal1 (spec:2004, fail closed). */
function readAal(payload: Record<string, unknown>): "aal1" | "aal2" {
  return payload["aal"] === "aal2" ? "aal2" : "aal1";
}

export function createJwtVerifierWithKeys(opts: { keys: JWTVerifyGetKey; issuer: string }): JwtVerifier {
  return async (token: string): Promise<VerifiedToken> => {
    try {
      const { payload } = await jwtVerify(token, opts.keys, { issuer: opts.issuer });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new AppError("ERR_AUTH_TOKEN_INVALID", "the access token carries no subject");
      }
      return { sub: payload.sub, aal: readAal(payload as Record<string, unknown>) };
    } catch (e) {
      if (e instanceof AppError) throw e;
      // jose distinguishes expiry, issuer and signature; the caller learns none of it — an oracle is a bypass aid.
      throw new AppError("ERR_AUTH_TOKEN_INVALID", "the access token could not be verified");
    }
  };
}

/**
 * Production. `jwksUrl` is the COMPLETE URL from SUPABASE_JWKS_URL (contracts §3.11) — never assembled from a
 * project ref here, because the path is Supabase's to change and ADR 0005 records the form observed at execution.
 */
export function createJwtVerifier(opts: { jwksUrl: string; issuer: string }): JwtVerifier {
  return createJwtVerifierWithKeys({ keys: createRemoteJWKSet(new URL(opts.jwksUrl)), issuer: opts.issuer });
}
```

```bash
cd apps/api && bun add jose && cd ../..
```

- [ ] **Step 4: Write `apps/api/src/auth-admin.ts`**

```ts
import { createHash } from "node:crypto";
import { AppError } from "@dulja/contracts";
import type { AuthAdmin, InvitedUser } from "./ports";

/**
 * spec:2132: "Inviting a user creates the `principal` from the `sub` returned by the Supabase admin invite call,
 * never from a subject supplied by the client." apps/api depends on this PORT, never on Supabase, so whether the
 * service-role key reaches the container is a deployment choice 0C records in ADR 0011 (contracts §3.11 keeps the
 * key with the seed CLI). Both implementations satisfy the same tests.
 */
export class SupabaseAuthAdmin implements AuthAdmin {
  constructor(private readonly opts: { url: string; serviceRoleKey: string; invitePath: string }) {}

  async inviteUser(email: string): Promise<InvitedUser> {
    const res = await fetch(new URL(this.opts.invitePath, this.opts.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      throw new AppError("ERR_INTERNAL", `the identity provider refused the invitation for ${email} (status ${res.status})`);
    }
    const body = (await res.json()) as { id?: unknown; email?: unknown };
    if (typeof body.id !== "string") {
      throw new AppError("ERR_INTERNAL", `the identity provider returned no subject for ${email}`);
    }
    return { sub: body.id, email };
  }
}

/** Dev and every test: a deterministic subject, so a test can invite the same address twice and get one principal. */
export class StubAuthAdmin implements AuthAdmin {
  constructor(private readonly seed = "stub") {}
  inviteUser(email: string): Promise<InvitedUser> {
    const sub = `${this.seed}:${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32)}`;
    return Promise.resolve({ sub, email });
  }
}
```

`invitePath` is a constructor argument and not a literal in the class body **on purpose**: it is the one Supabase detail this slice must verify rather than assume. Step 8 verifies it and records it in ADR 0005; 0C passes the verified value from configuration.

- [ ] **Step 5: Write `apps/api/src/middleware/auth.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { resolvePrincipal, withTenant } from "@dulja/db";
import type { AppEnv, RequestContext } from "../context";
import type { JwtVerifier } from "../ports";

/**
 * The MFA-enrolment exemption of spec:2004. GET /v1/session is the only route an `aal1` session reaches: the
 * back office calls it immediately after the owner's first login to learn that enrolment is outstanding, which
 * is the "logs in, enrols MFA at aal1" clause of §5.0 row 0.7b. Enrolment itself happens in Supabase, not here.
 */
export const AAL1_PATHS: ReadonlySet<string> = new Set(["/v1/session"]);

export function authenticate(deps: { db: Sql; verifier: JwtVerifier }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new AppError("ERR_AUTH_TOKEN_INVALID", "the request carries no Bearer access token");

    const { sub, aal } = await deps.verifier(token);

    const path = new URL(c.req.url).pathname;
    if (aal !== "aal2" && !AAL1_PATHS.has(path)) {
      throw new AppError("ERR_AUTH_AAL_INSUFFICIENT", `${path} requires a second authentication factor (this session is ${aal})`);
    }

    // The ONE door that runs before a tenant is known (plan0A:1451; OD-02 — as built). A client-supplied
    // X-Tenant-Id or X-Actor-Id is never read: identity comes from the verified token only (LEGACY-026, LEGACY-042).
    const rows = await resolvePrincipal(deps.db, sub);
    if (rows.length === 0) throw new AppError("ERR_AUTH_NO_MEMBERSHIP", "this account is not a member of any tenant");
    if (rows.length > 1) throw new AppError("ERR_INTERNAL", "the subject resolves to more than one membership");
    const row = rows[0]!;

    const ctx: RequestContext = {
      tenantId: row.tenantId,
      actorId: row.principalId,
      requestId: c.get("requestId"),
      principalKind: row.kind,
      aal,
    };
    c.set("ctx", ctx);
    c.set("withTenant", (fn) => withTenant(deps.db, ctx, fn));
    c.set("logger", c.get("logger").child({ tenant_id: ctx.tenantId, actor_id: ctx.actorId }));
    await next();
  };
}
```

- [ ] **Step 6: Write `packages/contracts/src/session.ts` and `apps/api/src/routes/session.ts`**

`packages/contracts/src/session.ts`:

```ts
import { z } from "zod";
import { UuidSchema } from "./common";

export const SessionSchema = z.object({
  principalId: UuidSchema,
  tenantId: UuidSchema,
  principalKind: z.enum(["human", "system", "terminal"]),
  aal: z.enum(["aal1", "aal2"]),
  displayName: z.string(),
  email: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
```

Add `export * from "./session";` to `packages/contracts/src/index.ts`.

`apps/api/src/routes/session.ts`:

```ts
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ProblemSchema, SessionSchema } from "@dulja/contracts";
import type { AppEnv } from "../context";

export const sessionRoutes = new OpenAPIHono<AppEnv>();

sessionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["session"],
    summary: "Who am I — the one route an aal1 session may call (spec:2004)",
    responses: {
      200: { description: "The caller's principal", content: { "application/json": { schema: SessionSchema } } },
      401: { description: "No or invalid token", content: { "application/problem+json": { schema: ProblemSchema } } },
      403: { description: "No membership", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const [row] = await c.var.withTenant((tx) => tx<{ display_name: string; email: string | null }[]>`
      select display_name, email from app.principal where id = ${ctx.actorId}`);
    return c.json({
      principalId: ctx.actorId,
      tenantId: ctx.tenantId,
      principalKind: ctx.principalKind,
      aal: ctx.aal,
      displayName: row?.display_name ?? "",
      email: row?.email ?? null,
    });
  },
);
```

Register it in `apps/api/src/routes/index.ts`. Add the import beside the existing `import { healthRoutes } from "./health";`:

```ts
import { sessionRoutes } from "./session";
```

and the entry, after `/healthz`, inside the `ROUTES` array Task 4 Step 9 wrote:

```ts
  { path: "/v1/session", router: sessionRoutes, permissions: [], auth: "human" },
```

- [ ] **Step 7: Mount the chain in `createApp`**

In `apps/api/src/app.ts`, immediately after the `loggerMiddleware` registration and before `app.onError`, add:

```ts
  // Everything under /v1 needs a resolved principal; /healthz does not. 6A registers its /v1/sync/* terminal
  // chain BEFORE this line, because Hono runs matching middleware in registration order (ADR 0006).
  app.use("/v1/*", authenticate({ db: deps.db, verifier: deps.verifier }));
```

with `import { authenticate } from "./middleware/auth";`, and delete `void deps.db;` and `void deps.verifier;`.

- [ ] **Step 8: Verify the Supabase details and write ADR 0005**

Fetch Supabase's **current** GoTrue/Auth documentation and record three things — do not take them from memory (contracts Appendix A #3): the JWKS endpoint path for a project, the issuer claim's exact form, and the admin invite endpoint's path, request body and the field that carries the new user's id. Then write `docs/adr/0005-identity-chain-and-supabase-jwks.md`:

```markdown
# ADR-0005 — The identity chain: JWKS verification, `resolve_principal`, and the invite port

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0B

## Context
spec:2130 delegates authentication to Supabase Auth and requires the API to reject any JWT whose `aal` claim is
below `aal2`, exempting only the MFA-enrolment path (spec:2004). spec:2132 requires an invited user's `principal`
to be created from the `sub` the **server** obtained from the Supabase admin invite call. Contracts §3.11 assigns
`SUPABASE_SERVICE_ROLE_KEY` to the seed CLI and says "never in the container". Those two pull in opposite
directions, and the JWKS URL and admin-invite path are Supabase's to change, so neither may be guessed.

## Decision
1. **Verification.** `jose`'s `createRemoteJWKSet(new URL(SUPABASE_JWKS_URL))` plus `jwtVerify(token, keys,
   { issuer: SUPABASE_JWT_ISSUER })`. `SUPABASE_JWKS_URL` holds the **complete** URL; no code assembles it from a
   project reference. Verified against Supabase's documentation on `<fill at execution — Step 8>`: JWKS path
   `<fill at execution — Step 8>`, issuer form `<fill at execution — Step 8>`. These three slots are deliberately
   empty in the plan: contracts Appendix A #3 forbids writing a vendor path from memory, so Step 8 fetches the
   authority's current documentation and records what it says. They are the only unfilled text in this plan.
   The verifier reports one failure — `ERR_AUTH_TOKEN_INVALID` — for expiry, issuer and signature
   alike, so the endpoint is not an oracle.
2. **`aal`.** Anything that is not exactly `"aal2"` is treated as `aal1` (fail closed). `AAL1_PATHS` is the single
   set of exempt paths and holds exactly `/v1/session`.
3. **Membership.** `app.resolve_principal(sub)` — SECURITY DEFINER, owned by `app_auth`, EXECUTE for `app_rw`
   only (**OD-02**, as built by Plan 0A). Zero rows → `ERR_AUTH_NO_MEMBERSHIP`; the API never reads
   `app.principal` directly before a tenant is set, and a direct read as `app_rw` with no `set_config` returns
   nothing (Task 14 asserts both halves).
4. **Invitation is a port.** `AuthAdmin.inviteUser(email)` returns `{ sub, email }`. `StubAuthAdmin` (deterministic
   sub) is used in dev and in every test; `SupabaseAuthAdmin` takes `url`, `serviceRoleKey` and `invitePath` as
   constructor arguments — verified admin invite path `<fill at execution — Step 8>`, subject field
   `<fill at execution — Step 8>`. **Which
   implementation the deployed container receives, and therefore whether the service-role key reaches it, is 0C's
   wiring decision, recorded in ADR 0011.** 0B's endpoint, its tests and its OpenAPI entry are identical either way.
5. **Nothing is read from a request header.** `X-Tenant-Id`, `X-Actor-Id`, a body field named `tenant_id` and a
   query parameter naming a session variable are all ignored; the tenant and actor come from the verified token
   through `resolve_principal` (LEGACY-025, 026, 042).

## Consequences
- A Supabase change to the JWKS path is a configuration change, not a code change.
- The identity middleware is the only writer of `c.var.ctx` and `c.var.withTenant`; a handler cannot widen scope.
- **OD-01 / OD-02:** written against Plan 0A as built. A rejection of OD-01 changes only Task 8's invite handler;
  a rejection of OD-02 changes only Task 14's `resolve_principal` bypass assertion.
```

- [ ] **Step 9: Write `apps/api/test/support/app.ts` and the container entrypoint**

`apps/api/test/support/app.ts` — the shape is frozen by contracts §4.2.12 and every route test in every slice uses it unchanged:

```ts
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createLocalJWKSet, exportJWK, type JSONWebKeySet } from "jose";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import { createLogger } from "@dulja/contracts";
import { createDb } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { createApp } from "../../src/app";
import { StubAuthAdmin } from "../../src/auth-admin";
import type { AppEnv } from "../../src/context";
import { createJwtVerifierWithKeys } from "../../src/verifier";

export const TEST_ISSUER = "https://test.dulja.invalid/auth/v1";

const b64 = (o: object): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/** RS256 signing with node:crypto so `tokenFor` can stay synchronous, as contracts §4.2.12 freezes it.
 *  Verification is still real `jose` against a real JWKS — only the signing side is hand-rolled. */
function signRs256(key: KeyObject, payload: object): string {
  const input = `${b64({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(input).end().sign(key).toString("base64url");
  return `${input}.${sig}`;
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                       // '/v1/…', no origin; query string included in the path
  body?: unknown;                     // JSON.stringify'd with Content-Type: application/json unless `form` is set
  form?: FormData;                    // multipart (2C attachment upload); mutually exclusive with `body`
  as?: string;                        // principal id → Authorization: Bearer tokenFor(as, aal); omit for an unauthenticated call
  aal?: "aal1" | "aal2";              // default "aal2"
  idempotencyKey?: string | null;     // default: a fresh uuidv7 for every unsafe method; null sends NO header
  headers?: Record<string, string>;   // merged last — wins over every header above
}

export interface StartedApi {
  db: Db;
  app: OpenAPIHono<AppEnv>;
  tokenFor(principalId: string, aal?: "aal1" | "aal2"): string;
  /** Signs an ARBITRARY claim set with the same key and `kid` — the only way to mint the expired and
   *  wrong-issuer tokens contracts §3.7.2 requires the bypass suite to attempt, since `tokenFor` always writes
   *  `iss: TEST_ISSUER` and `exp: now + 600`. Not in contracts §4.2.12 — added by slice 0B. */
  signToken(claims: Record<string, unknown>): string;
  /** Refreshes the principal → auth_subject map. `request({ as })` calls it on a miss; a test that hands a raw
   *  token to `headers` calls it itself before `tokenFor`. Not in contracts §4.2.12 — added by slice 0B. */
  loadPrincipals(): Promise<void>;
  request(input: ApiRequest): Promise<Response>;
  stop(): Promise<void>;
}

export async function startApi(): Promise<StartedApi> {
  const db = await startDb();
  const rw = createDb(db.url("app_rw"));

  // A real RS256 key pair and a real local JWKS, so the production verifier code path — signature, issuer and
  // expiry — is what the tests exercise. Only the key source differs from production.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };

  const app = createApp({
    db: rw,
    jobs: { enqueue: () => { throw new Error("no job client in route tests — slice 0D wires pg-boss"); } },
    logger: createLogger({ sink: () => {} }),
    authAdmin: new StubAuthAdmin(),
    verifier: createJwtVerifierWithKeys({ keys: createLocalJWKSet(jwks), issuer: TEST_ISSUER }),
  });

  // principal id → auth_subject. A principal the map has never seen is signed with its own id as the subject,
  // which resolves to no membership — exactly the case the orphan-token test wants.
  const subjects = new Map<string, string>();
  const loadPrincipals = async (): Promise<void> => {
    const rows = await db.admin<{ id: string; auth_subject: string }[]>`select id, auth_subject from app.principal`;
    for (const r of rows) subjects.set(r.id, r.auth_subject);
  };

  const tokenFor = (principalId: string, aal: "aal1" | "aal2" = "aal2"): string => {
    const now = Math.floor(Date.now() / 1000);
    return signRs256(privateKey, {
      sub: subjects.get(principalId) ?? principalId,
      aal, iss: TEST_ISSUER, iat: now, exp: now + 600,
    });
  };

  const signToken = (claims: Record<string, unknown>): string => signRs256(privateKey, claims);

  return {
    db, app, tokenFor, signToken, loadPrincipals,
    async request(input) {
      if (input.as && !subjects.has(input.as)) await loadPrincipals();
      const headers: Record<string, string> = {};
      if (input.as) headers["Authorization"] = `Bearer ${tokenFor(input.as, input.aal ?? "aal2")}`;
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (["POST", "PUT", "PATCH", "DELETE"].includes(input.method) && input.idempotencyKey !== null) {
        headers["Idempotency-Key"] = input.idempotencyKey ?? newUuidV7();
      }
      Object.assign(headers, input.headers ?? {});
      // The key is OMITTED when there is no body, never set to `undefined`. `RequestInit.body` is declared
      // `body?: BodyInit | null`, and `exactOptionalPropertyTypes: true` (plan0A:274–288) forbids an object
      // literal supplying an explicit `undefined` for an optional property — TS2379 on every GET this helper
      // makes. Same rule, same shape as `fromDatabaseError`'s conditional spread (Task 3 Step 4).
      const body = input.form ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
      return app.request(input.path, body === undefined
        ? { method: input.method, headers }
        : { method: input.method, headers, body });
    },
    async stop() { await rw.end(); await db.stop(); },
  };
}
```

Then create `apps/api/src/index.ts` exactly as specified in Task 4 Step 11 — one code block, the `try` around `readConfig()` only and the `export default` at top level — now that `StubAuthAdmin` and `createJwtVerifier` exist.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test`
Expected: PASS — `health.test.ts` 4, `auth.test.ts` 6, `session.test.ts` 2.

- [ ] **Step 11: Run the root gates and commit**

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`

```bash
git add apps/api packages/contracts/src docs/adr/0005-identity-chain-and-supabase-jwks.md bun.lock
git commit -m "$(cat <<'EOF'
feat(api): JWKS verification, resolve_principal, the aal2 gate and GET /v1/session [0B T5]

Identity comes from the verified token only; X-Tenant-Id and X-Actor-Id are never
read. The Supabase admin invite is a port (AuthAdmin), so apps/api never depends on
Supabase and 0C decides where the service-role key lives. OD-01/OD-02: as built by 0A.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: the `Idempotency-Key` middleware (ADR 0004)

Three transactions, deliberately: the reservation must commit before the handler runs, or a concurrent duplicate could not see the in-flight row it has to answer `ERR_IDEMPOTENCY_IN_FLIGHT` for (contracts §4.2.9).

**Files:**
- Create: `apps/api/src/middleware/idempotency.ts`, `docs/adr/0004-idempotency-three-transaction-reservation.md`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/middleware/idempotency.test.ts`

**Interfaces:**
- Consumes: `AppEnv`, `toProblemResponse` (Task 4); `withTenant` from `@dulja/db` (Task 2); `AppError` (Task 3); `startApi` (Task 5); `app.idempotency_key (tenant_id, principal_id, key, request_hash, response_code, response_body, created_at, expires_at)` (plan0A:1907–1917).
- Produces: `export function idempotency(db: Sql): MiddlewareHandler<AppEnv>` and `export const RECLAIM_AFTER_SECONDS = 120`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/middleware/idempotency.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

describe("Idempotency-Key — spec:2055, 2201; contracts §4.2.9", () => {
  let api: StartedApi; let a: Seed;
  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha");
    // A tiny unsafe route with a side effect the test can count, mounted for this suite only.
    api.app.post("/v1/probe", async (c) => {
      await c.var.withTenant((tx) => tx`insert into app.role (tenant_id, code, name_en) values (${a.tenant}, ${crypto.randomUUID().slice(0, 8)}, 'Probe')`);
      return c.json({ ok: true }, 201);
    });
    api.app.post("/v1/boom", () => { throw new Error("handler exploded"); });
  });
  afterAll(async () => { await api.stop(); });

  const roleCount = async (): Promise<number> => {
    const [row] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.role where tenant_id = ${a.tenant}`;
    return row!.n;
  };

  it("an unsafe method without the header is 400 ERR_IDEMPOTENCY_KEY_MISSING", async () => {
    const res = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: {}, idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a GET needs no key", async () => {
    expect((await api.request({ method: "GET", path: "/v1/session", as: a.human })).status).toBe(200);
  });

  it("the same key and body replays the stored response and runs the handler once", async () => {
    const before = await roleCount();
    const key = "replay-1";
    const first = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: { n: 1 }, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const second = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: { n: 1 }, idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual({ ok: true });
    expect(await roleCount()).toBe(before + 1);                       // exactly one side effect
  });

  it("the same key with a different body is 409 ERR_IDEMPOTENCY_KEY_REUSED and does not run the handler", async () => {
    const key = "reused-1";
    await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: { n: 1 }, idempotencyKey: key });
    const before = await roleCount();
    const res = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: { n: 2 }, idempotencyKey: key });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
    expect(await roleCount()).toBe(before);
  });

  it("a concurrent duplicate with the SAME hash is 409 ERR_IDEMPOTENCY_IN_FLIGHT with Retry-After", async () => {
    // A live reservation: response_code null, younger than the 120 s reclaim window, and carrying the hash the
    // middleware computes for POST /v1/probe with body {} — sha256(method \n path \n canonical body).
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash)
               values (${a.tenant}, ${a.human}, 'in-flight-1',
                       sha256(convert_to('POST' || chr(10) || '/v1/probe' || chr(10) || '{}', 'UTF8')))`;
    });
    const res = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: {}, idempotencyKey: "in-flight-1" });
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_IN_FLIGHT");
  });

  it("a live reservation whose hash differs answers ERR_IDEMPOTENCY_KEY_REUSED, which outranks in-flight", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash)
               values (${a.tenant}, ${a.human}, 'in-flight-2', sha256('something else'::bytea))`;
    });
    const res = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: {}, idempotencyKey: "in-flight-2" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
  });

  it("a reservation older than 120 seconds is reclaimed instead of poisoning the key for 24 hours", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, created_at)
               values (${a.tenant}, ${a.human}, 'stale-1', sha256('x'::bytea), now() - interval '10 minutes')`;
    });
    const res = await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: {}, idempotencyKey: "stale-1" });
    expect(res.status).toBe(201);
  });

  it("a failing handler is recorded, so a retry replays the failure instead of re-running the write", async () => {
    const key = "boom-1";
    const first = await api.request({ method: "POST", path: "/v1/boom", as: a.human, body: {}, idempotencyKey: key });
    expect(first.status).toBe(500);
    const second = await api.request({ method: "POST", path: "/v1/boom", as: a.human, body: {}, idempotencyKey: key });
    expect(second.status).toBe(500);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await second.json()) as Problem).code).toBe("ERR_INTERNAL");
  });

  it("one principal cannot replay another principal's key (LEGACY-042)", async () => {
    const b = await seedTenant(api.db, "Beta");
    const key = "cross-1";
    await api.request({ method: "POST", path: "/v1/probe", as: a.human, body: { n: 1 }, idempotencyKey: key });
    const res = await api.request({ method: "GET", path: "/v1/session", as: b.human, headers: { "Idempotency-Key": key } });
    expect(res.status).toBe(200);                                     // a GET ignores the header entirely
    const rows = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.idempotency_key where key = ${key}`;
    expect(rows[0]!.n).toBe(1);                                       // and no row was created for Beta
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/middleware/idempotency.test.ts`
Expected: FAIL — every unsafe request answers 201 or 500 with no key handling; the first assertion fails with `expected 201 to be 400`.

- [ ] **Step 3: Write `apps/api/src/middleware/idempotency.ts`**

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import type { AppEnv } from "../context";
import { toProblemResponse } from "../problem";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** A reservation whose process died is taken over after this long, so a crash cannot poison a key for 24 h. */
export const RECLAIM_AFTER_SECONDS = 120;

type Reservation =
  | { kind: "fresh" }
  | { kind: "reused" }
  | { kind: "in_flight" }
  | { kind: "replay"; status: number; body: unknown };

/**
 * spec:2055 requires the header on every unsafe method — the POS sells over a shop connection that drops.
 * Three transactions (contracts §4.2.9): reserve and COMMIT, run the handler, record the response. The
 * reservation must be visible to a concurrent duplicate, which it would not be if it shared the handler's
 * transaction. `POST /v1/sync/tickets` carries this header AND dedups per ticket on client_ref (6A) — two
 * layers, both required (spec:1304, 2201).
 */
export function idempotency(db: Sql): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!UNSAFE.has(c.req.method)) return next();

    const key = c.req.header("Idempotency-Key");
    if (!key) {
      throw new AppError("ERR_IDEMPOTENCY_KEY_MISSING",
        `${c.req.method} ${new URL(c.req.url).pathname} requires an Idempotency-Key header`);
    }
    if (key.length > 200) {
      throw new AppError("ERR_VALIDATION_FAILED", `Idempotency-Key is ${key.length} characters; the maximum is 200`);
    }

    const path = new URL(c.req.url).pathname;
    const raw = await c.req.text();                       // Hono caches the body, so the handler can still read it
    const hash = createHash("sha256").update(`${c.req.method}\n${path}\n${canonical(raw)}`).digest();
    const ctx = c.get("ctx");

    const reservation = await withTenant(db, ctx, async (tx): Promise<Reservation> => {
      const claimed = await tx<{ ok: number }[]>`
        insert into app.idempotency_key (tenant_id, principal_id, key, request_hash)
        values (${ctx.tenantId}, ${ctx.actorId}, ${key}, ${hash})
        on conflict (tenant_id, principal_id, key) do update
           set request_hash = excluded.request_hash, created_at = now()
         where app.idempotency_key.response_code is null
           and app.idempotency_key.created_at < now() - make_interval(secs => ${RECLAIM_AFTER_SECONDS})
        returning 1 as ok`;
      if (claimed.length > 0) return { kind: "fresh" };

      const [existing] = await tx<{ request_hash: Buffer; response_code: number | null; response_body: unknown }[]>`
        select request_hash, response_code, response_body from app.idempotency_key
         where tenant_id = ${ctx.tenantId} and principal_id = ${ctx.actorId} and key = ${key}`;
      if (!existing) return { kind: "fresh" };
      const same = existing.request_hash.length === hash.length && timingSafeEqual(existing.request_hash, hash);
      if (!same) return { kind: "reused" };
      if (existing.response_code === null) return { kind: "in_flight" };
      return { kind: "replay", status: existing.response_code, body: existing.response_body };
    });

    if (reservation.kind === "reused") {
      throw new AppError("ERR_IDEMPOTENCY_KEY_REUSED",
        `Idempotency-Key ${JSON.stringify(key)} was already used for a different ${c.req.method} request`);
    }
    if (reservation.kind === "in_flight") {
      throw new AppError("ERR_IDEMPOTENCY_IN_FLIGHT",
        `an identical request with Idempotency-Key ${JSON.stringify(key)} is still running`);
    }
    if (reservation.kind === "replay") {
      return new Response(JSON.stringify(reservation.body), {
        status: reservation.status,
        headers: {
          "content-type": reservation.status >= 400 ? "application/problem+json" : "application/json",
          "Idempotency-Replayed": "true",
          "X-Request-Id": c.get("requestId"),
        },
      });
    }

    // Third transaction: record whatever happened — success OR failure — so a retry replays it rather than
    // re-running the write. The error is converted here, not re-thrown, because app.onError would otherwise
    // build the response after this middleware has already unwound.
    let res: Response;
    try { await next(); res = c.res; }
    catch (e) { res = toProblemResponse(c, e); }

    const text = await res.clone().text();
    let stored: unknown = null;
    try { stored = text.length > 0 ? JSON.parse(text) : null; } catch { stored = null; }
    await withTenant(db, ctx, (tx) => tx`
      update app.idempotency_key set response_code = ${res.status}, response_body = ${tx.json(stored)}
       where tenant_id = ${ctx.tenantId} and principal_id = ${ctx.actorId} and key = ${key}`);

    c.res = res;
    return undefined;
  };
}

/** Same body, same hash, whatever the key order or whitespace. A non-JSON body hashes as its raw bytes. */
function canonical(raw: string): string {
  if (raw.length === 0) return "";
  try { return stable(JSON.parse(raw)); } catch { return raw; }
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
```

- [ ] **Step 4: Register it after `authenticate` in `createApp`**

In `apps/api/src/app.ts`, directly below the `authenticate` line:

```ts
  app.use("/v1/*", idempotency(deps.db));
```

with `import { idempotency } from "./middleware/idempotency";`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/middleware/idempotency.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Write ADR 0004**

`docs/adr/0004-idempotency-three-transaction-reservation.md`:

```markdown
# ADR-0004 — Idempotency as a committed reservation, then the handler, then the response

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0B

## Context
spec:2055 and spec:2201 require an `Idempotency-Key` on every unsafe method — a POS terminal on a shop connection
will resend. `app.idempotency_key` (plan0A:1907) is keyed `(tenant_id, principal_id, key)` with a `request_hash`
and a nullable `response_code`; spec's own comment says a null `response_code` means "in flight → concurrent
duplicate gets 409 + Retry-After". That is only expressible if the reservation is visible to another connection
before the handler finishes.

## Decision
Three transactions. (1) Reserve: `insert … on conflict … do update … where response_code is null and created_at <
now() - 120 seconds` and COMMIT. A returned row means the key is ours (fresh, or reclaimed from a dead process).
No row means the key exists: a differing `request_hash` is `ERR_IDEMPOTENCY_KEY_REUSED`, a null `response_code`
is `ERR_IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 2`, and a stored code is a replay carrying
`Idempotency-Replayed: true`. (2) The handler, in its own `withTenant`. (3) Record the status and body — **for a
failure too**, so a retry replays the failure rather than re-running a partially applied write.

The request hash is `sha256(method \n path \n canonical-JSON body)`; canonicalisation sorts object keys so
whitespace and key order do not create a false `ERR_IDEMPOTENCY_KEY_REUSED`. Comparison is `timingSafeEqual`.
Rows expire after 24 hours (plan0A:2557) and are purged by `admin.idempotency_key.purge` (0D).

## Consequences
- The reclaim window is 120 seconds: a crashed request blocks its key for two minutes, not a day.
- A handler that writes and then fails is not re-run by a retry — the failure is the recorded outcome; the caller
  must use a new key to try again, which is what "idempotent" means for a non-idempotent side effect.
- 6A's `POST /v1/sync/tickets` carries this header **and** dedups per ticket on `client_ref`: two layers, both
  required (spec:1304).
```

- [ ] **Step 7: Run the root gates and commit**

Run: `bun run lint && bun run format:check && bun run typecheck && bun run test`

```bash
git add apps/api docs/adr/0004-idempotency-three-transaction-reservation.md
git commit -m "$(cat <<'EOF'
feat(api): Idempotency-Key middleware over app.idempotency_key [0B T6]

Reservation commits before the handler so a concurrent duplicate can see it; a
failing handler is recorded and replayed; a dead reservation is reclaimed after 120s.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: the permission catalogue, migration `0002_seed_permission_phase0.sql`, `requirePermission`, and the read-only-gate boot check

**Files:**
- Create: `packages/db/migrations/0002_seed_permission_phase0.sql`, `packages/db/migrations/0002.down.sql`, `apps/api/src/middleware/require-permission.ts`, `packages/db/test/permission-catalogue.test.ts`
- Modify: `packages/contracts/permissions.ts` (replace the Task 4 one-liner), `apps/api/src/app.ts`, `packages/db/test/tenant-isolation.test.ts` (plan0A:1118 — one clause)
- Test: `packages/db/test/permission-catalogue.test.ts`, `apps/api/test/middleware/require-permission.test.ts`

**Interfaces:**
- Consumes: `app.permission (code, module, mutating, description)` with `check (code like module || '.%' and code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$')` (plan0A:1313–1320); `app.actor_has(p_code, p_company_id, p_branch_id default null)` (plan0A:1364); `AppEnv`, `AppError`, `startApi`, `withTenant`.
- Produces, verbatim from contracts §4.2.5 plus the `{ company: "any" }` variant of assumption 3:

```ts
// packages/contracts/permissions.ts
export type PermissionModule = "admin" | "accounting" | "inventory" | "hr" | "pos";
export type PermissionAction =
  | "read" | "manage" | "create" | "post" | "approve" | "reverse" | "close" | "reopen" | "override" | "export"
  | "reconcile" | "sell" | "discount" | "return" | "return_blind" | "void" | "prepare" | "pay" | "record" | "request"
  | "check" | "clock" | "manage_pin" | "resolve" | "pull" | "push" | "file" | "generate"
  | "assign" | "read_sensitive" | "verify" | "own" | "close_any";
export type SliceId =
  | "0B" | "0D" | "1A" | "1B" | "2A" | "2B" | "3A" | "3B" | "3C" | "3D" | "4A" | "4B"
  | "5A" | "5B" | "6A" | "6B" | "6C" | "6D" | "7A" | "7C" | "8A" | "8B" | "8C" | "8D";
export interface PermissionDef { readonly code: `${PermissionModule}.${string}.${PermissionAction}`;
  readonly module: PermissionModule; readonly mutating: boolean; readonly description: string; readonly phase: SliceId }
export const PERMISSIONS: readonly PermissionDef[];      // five entries after 0B
export type PermissionCode = (typeof PERMISSIONS)[number]["code"];
export const PERMISSION: { readonly [K in PermissionCode]: K };
export function isMutating(code: PermissionCode): boolean;

// apps/api/src/middleware/require-permission.ts
export type ScopeSource =
  | { company: "path:companyId"; branch?: "body:branchId" | "query:branchId" | "document" }
  | { company: "body:companyId"; branch?: "body:branchId" }
  | { company: "terminal" }
  | { company: "any" };                                   // 0B addition — tenant-scoped admin routes
export function requirePermission(code: PermissionCode, scope: ScopeSource): MiddlewareHandler<AppEnv>;
export function assertRouteGates(app: OpenAPIHono<AppEnv>): void;   // throws ERR_ROUTE_GATE_READONLY at boot
```

- [ ] **Step 1: Write the failing catalogue test**

`packages/db/test/permission-catalogue.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { startDb, type Db } from "./harness";

describe("app.permission ↔ packages/contracts/permissions.ts — spec:2135, contracts §3.6.3", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("the seeded catalogue equals the exported catalogue, in both directions", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission order by code`;
    const seeded = rows.map((r) => `${r.code}|${r.module}|${r.mutating}`);
    const exported = [...PERMISSIONS].map((p) => `${p.code}|${p.module}|${p.mutating}`).sort();
    expect(seeded).toEqual(exported);
  });

  it("holds exactly the five Phase 0 admin codes, with admin.audit_log.read non-mutating (§3.6.2)", async () => {
    const rows = await db.migrator<{ code: string; mutating: boolean }[]>`
      select code, mutating from app.permission order by code`;
    expect(rows).toEqual([
      { code: "admin.audit_log.read", mutating: false },
      { code: "admin.company.manage", mutating: true },
      { code: "admin.role.assign", mutating: true },
      { code: "admin.role.manage", mutating: true },
      { code: "admin.user.manage", mutating: true },
    ]);
  });

  it("every exported code satisfies the table's own CHECK grammar", async () => {
    for (const p of PERMISSIONS) {
      expect(p.code, p.code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
      expect(p.code.startsWith(`${p.module}.`), p.code).toBe(true);
      expect(p.description.length, p.code).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: FAIL — `PERMISSIONS` is not exported by `packages/contracts/permissions.ts`, and `app.permission` is empty.

- [ ] **Step 3: Write `packages/contracts/permissions.ts` (replacing the Task 4 one-liner in full)**

```ts
/** The version-controlled permission catalogue (spec:2135). A code no handler evaluates fails the build, and a
 *  handler naming a code that is not here fails the build — scripts/lint/rules/permission-catalogue.ts (0D). */
export type PermissionModule = "admin" | "accounting" | "inventory" | "hr" | "pos";

export type PermissionAction =
  | "read" | "manage" | "create" | "post" | "approve" | "reverse" | "close" | "reopen" | "override" | "export"
  | "reconcile" | "sell" | "discount" | "return" | "return_blind" | "void" | "prepare" | "pay" | "record" | "request"
  | "check" | "clock" | "manage_pin" | "resolve" | "pull" | "push" | "file" | "generate"
  | "assign" | "read_sensitive" | "verify" | "own" | "close_any";        // used by the spec's own catalogue (C2)

export type SliceId =
  | "0B" | "0D" | "1A" | "1B" | "2A" | "2B" | "3A" | "3B" | "3C" | "3D" | "4A" | "4B"
  | "5A" | "5B" | "6A" | "6B" | "6C" | "6D" | "7A" | "7C" | "8A" | "8B" | "8C" | "8D";

export interface PermissionDef {
  readonly code: `${PermissionModule}.${string}.${PermissionAction}`;
  readonly module: PermissionModule;
  readonly mutating: boolean;
  readonly description: string;
  readonly phase: SliceId;                 // the slice that introduced the handler
}

/** Grown additively, one block per introducing slice (contracts §3.6.2). Slice 0B: the five admin codes. */
export const PERMISSIONS = [
  { code: "admin.user.manage",     module: "admin", mutating: true,  phase: "0B", description: "Invite people to the tenant, list them, and expire their access" },
  { code: "admin.role.manage",     module: "admin", mutating: true,  phase: "0B", description: "Create roles and change the permissions a role grants" },
  { code: "admin.role.assign",     module: "admin", mutating: true,  phase: "0B", description: "Assign a role to a principal in a company and restrict it to branches" },
  { code: "admin.company.manage",  module: "admin", mutating: true,  phase: "0B", description: "Create and maintain companies and their configuration" },
  { code: "admin.audit_log.read",  module: "admin", mutating: false, phase: "0B", description: "Read the append-only audit log" },
] as const satisfies readonly PermissionDef[];

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

/** PERMISSION["admin.user.manage"] — a typo is a compile error, and the lint can find every reference. */
export const PERMISSION = Object.fromEntries(PERMISSIONS.map((p) => [p.code, p.code])) as {
  readonly [K in PermissionCode]: K;
};

const MUTATING = new Map<string, boolean>(PERMISSIONS.map((p) => [p.code, p.mutating]));
export function isMutating(code: PermissionCode): boolean {
  return MUTATING.get(code) ?? true;      // unknown ⇒ treated as mutating: fail closed (spec:2178 R7)
}
```

Delete `packages/contracts/src/permissions-re-export.ts` and replace its line in `src/index.ts` with `export * from "../permissions";` — the bridge existed only while the file was empty.

- [ ] **Step 4: Write `packages/db/migrations/0002_seed_permission_phase0.sql`**

```sql
-- 0002_seed_permission_phase0.sql — the five Phase 0 admin codes (spec:2135, contracts §3.6.2).
-- app.permission is the ONE table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313), so
-- FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366). Role grants over these codes are per-tenant seed-pack data (0C).
-- `do update` rather than `do nothing`: re-running the migration on staging must correct a drifted description.

-- ── 1. the Phase 0 catalogue ──────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('admin.user.manage',    'admin', true,  'Invite people to the tenant, list them, and expire their access'),
  ('admin.role.manage',    'admin', true,  'Create roles and change the permissions a role grants'),
  ('admin.role.assign',    'admin', true,  'Assign a role to a principal in a company and restrict it to branches'),
  ('admin.company.manage', 'admin', true,  'Create and maintain companies and their configuration'),
  ('admin.audit_log.read', 'admin', false, 'Read the append-only audit log')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
```

`packages/db/migrations/0002.down.sql`:

```sql
-- Reverse of 0002: remove exactly the five codes it inserted, nothing else. The FK from
-- app.role_permission.permission_code blocks the delete while any tenant still grants one of them, which is the
-- correct signal — re-run the role seed for that tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'admin.user.manage', 'admin.role.manage', 'admin.role.assign', 'admin.company.manage', 'admin.audit_log.read');
```

- [ ] **Step 5: Repair Plan 0A's one colliding insert**

`packages/db/test/tenant-isolation.test.ts` (plan0A:1118) inserts three permission rows in `beforeAll`, one of which — `admin.user.manage` — migration 0002 now seeds. Add the conflict clause to that statement and nothing else:

```ts
    await db.migrator`insert into app.permission (code, module, mutating, description) values
      ('accounting.purchase.post', 'accounting', true, 'Post a purchase document'),
      ('accounting.sales.post',    'accounting', true, 'Post a sales document'),
      ('admin.user.manage',        'admin',      true, 'Manage users')
      on conflict (code) do nothing`;
```

This is the second and last Plan 0A file this slice edits (the first was `privileges.test.ts` in Task 1).

- [ ] **Step 6: Run the catalogue test and the reversibility test**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/privileges.test.ts test/tenant-isolation.test.ts`
Expected: PASS. `privileges.test.ts` proves migration 0002 rolls back and re-applies with an identical fingerprint — the reason Task 1 came first.

- [ ] **Step 7: Write the failing middleware test**

`apps/api/test/middleware/require-permission.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { requirePermission, assertRouteGates } from "../../src/middleware/require-permission";
import { startApi, type StartedApi } from "../support/app";

describe("requirePermission — spec:2173 pre-flight over app.actor_has; acceptance test 11", () => {
  let api: StartedApi; let a: Seed;

  /** Gives `a.human` a role holding `code` in `a.company`, granted by the system principal (no self-grant). */
  const grant = async (code: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, ${`r-${code}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha");
    api.app.get("/v1/gate-any", requirePermission(PERMISSION["admin.user.manage"], { company: "any" }), (c) => c.json({ ok: true }));
    api.app.get("/v1/companies/:companyId/gate-path",
      requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" }), (c) => c.json({ ok: true }));
  });
  afterAll(async () => { await api.stop(); });

  it("refuses a principal holding nothing, naming the code in the detail", async () => {
    const res = await api.request({ method: "GET", path: "/v1/gate-any", as: a.human });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(body.detail).toContain("admin.user.manage");
  });

  it("admits the principal once an unexpired assignment grants the code in any company of the tenant", async () => {
    await grant("admin.user.manage");
    expect((await api.request({ method: "GET", path: "/v1/gate-any", as: a.human })).status).toBe(200);
  });

  it("an expired assignment grants nothing (test 36)", async () => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`update app.role_assignment set expires_at = now() - interval '1 day'
                where principal_id = ${a.human} and company_id = ${a.company}`;
    });
    expect((await api.request({ method: "GET", path: "/v1/gate-any", as: a.human })).status).toBe(403);
  });

  it("a company id from another tenant is 403, never a leak of its existence", async () => {
    const b = await seedTenant(api.db, "Beta");
    const res = await api.request({ method: "GET", path: `/v1/companies/${b.company}/gate-path`, as: a.human });
    expect(res.status).toBe(403);
  });

  it("assertRouteGates refuses an unsafe route gated by a non-mutating code at boot (spec:2178 R7)", () => {
    api.app.post("/v1/bad-gate", requirePermission(PERMISSION["admin.audit_log.read"], { company: "any" }), (c) => c.json({}));
    expect(() => assertRouteGates(api.app)).toThrow(/ERR_ROUTE_GATE_READONLY.*admin\.audit_log\.read/s);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/middleware/require-permission.test.ts`
Expected: FAIL — `Cannot find module '../../src/middleware/require-permission'`.

- [ ] **Step 9: Write `apps/api/src/middleware/require-permission.ts`**

```ts
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "@dulja/contracts";
import { isMutating, type PermissionCode } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";

export type ScopeSource =
  | { company: "path:companyId"; branch?: "body:branchId" | "query:branchId" | "document" }   // "document": the branch of :documentId
  | { company: "body:companyId"; branch?: "body:branchId" }
  | { company: "terminal" }                                                                   // /v1/sync/*: from pos_terminal (6A)
  | { company: "any" };                                                                       // tenant-scoped admin routes (0B)

const GATE = Symbol.for("dulja.permissionGate");
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function resolveScope(c: Context<AppEnv>, scope: ScopeSource): Promise<{ companyId: string | null; branchId: string | null }> {
  if (scope.company === "any") return { companyId: null, branchId: null };
  if (scope.company === "terminal") {
    throw new AppError("ERR_INTERNAL", "the terminal scope source is introduced with the sync routes in slice 6A");
  }
  const companyId = scope.company === "path:companyId" ? c.req.param("companyId") : await bodyField(c, "companyId");
  if (!companyId) throw new AppError("ERR_VALIDATION_FAILED", "the request names no company");
  let branchId: string | null = null;
  if (scope.branch === "body:branchId") branchId = await bodyField(c, "branchId");
  else if (scope.branch === "query:branchId") branchId = new URL(c.req.url).searchParams.get("branchId");
  else if (scope.branch === "document") {
    const documentId = c.req.param("documentId");
    const [row] = await c.var.withTenant((tx) => tx<{ branch_id: string }[]>`
      select branch_id from app.document where id = ${documentId ?? null}`);
    branchId = row?.branch_id ?? null;
  }
  return { companyId, branchId };
}

async function bodyField(c: Context<AppEnv>, name: string): Promise<string | null> {
  try {
    const body = (await c.req.json()) as Record<string, unknown> | null;   // Hono caches the parsed body
    return typeof body?.[name] === "string" ? (body[name] as string) : null;
  } catch { return null; }
}

/**
 * A PRE-FLIGHT, not the control (spec:2173, LEGACY-032): it calls app.actor_has inside the request's own
 * withTenant so the caller gets a good error, while RLS policies and triggers remain the actual enforcement.
 * A NULL branch asks for company-wide authority and is granted only by an assignment with no branch rows, so a
 * branch-restricted principal never gains anything by omitting the branch (LEGACY-042, LEGACY-050).
 */
export function requirePermission(code: PermissionCode, scope: ScopeSource): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const { companyId, branchId } = await resolveScope(c, scope);
    const allowed = await c.var.withTenant(async (tx) => {
      if (companyId === null) {
        // RLS has already narrowed app.company to this tenant, so "any company of the tenant" never widens past it.
        const [row] = await tx<{ ok: boolean }[]>`
          select exists (select 1 from app.company c where app.actor_has(${code}, c.id)) as ok`;
        return row!.ok;
      }
      const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${companyId}, ${branchId}) as ok`;
      return row!.ok;
    });
    if (!allowed) {
      throw new AppError("ERR_RBAC_FORBIDDEN",
        `principal ${c.var.ctx.actorId} does not hold ${code}${companyId ? ` in company ${companyId}` : " in any company of this tenant"}`);
    }
    await next();
  };
  return Object.assign(handler, { [GATE]: code });
}

/**
 * spec:2178 R7, the build half: "a mutating handler can never be gated by a read code (the build fails)". Called
 * once by createApp after ROUTES are mounted, so a mis-gated route cannot reach staging.
 */
export function assertRouteGates(app: OpenAPIHono<AppEnv>): void {
  const bad: string[] = [];
  for (const route of app.routes) {
    const code = (route.handler as unknown as Record<symbol, unknown>)[GATE];
    if (typeof code === "string" && UNSAFE.has(route.method) && !isMutating(code as PermissionCode)) {
      bad.push(`${route.method} ${route.path} is gated by ${code}, which is mutating = false`);
    }
  }
  if (bad.length > 0) {
    throw new AppError("ERR_ROUTE_GATE_READONLY", bad.join("; "));
  }
}
```

- [ ] **Step 10: Call the boot check from `createApp`**

In `apps/api/src/app.ts`, replace `return app;` with:

```ts
  assertRouteGates(app);
  return app;
```

and add `import { assertRouteGates } from "./middleware/require-permission";`.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/middleware/require-permission.test.ts` then `bun run --cwd packages/db test`
Expected: PASS (5 + the db suite).

- [ ] **Step 12: Commit**

```bash
git add packages/db packages/contracts apps/api
git commit -m "$(cat <<'EOF'
feat: Phase 0 permission catalogue, migration 0002, requirePermission [0B T7]

Five admin.* codes, seeded and asserted equal to permissions.ts in both directions.
requirePermission is a pre-flight over app.actor_has; assertRouteGates refuses an
unsafe route gated by a mutating=false code at boot (spec:2178 R7).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `/v1/admin/users` — invite, list, expire (`admin.user.manage`)

The "users invited" half of the Phase 0 definition of done. The invite handler is where spec:2132 lands: the `sub` comes from the server's `AuthAdmin`, never from the request.

**Files:**
- Create: `packages/contracts/src/admin/user.ts`, `apps/api/src/routes/admin/users.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`
- Test: `apps/api/test/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `PERMISSION` (Task 7); `AuthAdmin` (Task 4/5); `ListEnvelope`, `ListQuery`, `UuidSchema`, `ProblemSchema`, `AppError`, `encodeCursor`, `decodeCursor` (Task 3); `startApi` (Task 5).
- Produces: `UserSchema`, `InviteUserBody`, `UserQuery`, `UserList` in `@dulja/contracts`; `userRoutes` mounted at `/v1/admin/users`; the `ROUTES` entry `{ path: "/v1/admin/users", permissions: ["admin.user.manage"], auth: "human" }`. **Expiring a user** is defined as `update app.role_assignment set expires_at = now()` for every unexpired assignment of that principal — `app_rw` holds no DELETE on `membership` or `principal` (contracts §3.5.4) and master data is never deleted (spec:2049); `keep_last_admin_assignment` surfaces as `ERR_RBAC_LAST_ADMIN`.

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/admin/user.ts`:

```ts
import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const UserSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  email: z.string().nullable(),
  kind: z.enum(["human", "system", "terminal"]),
  createdAt: TimestampSchema,
  activeAssignments: z.number().int(),      // unexpired role_assignment rows — 0 means "expired out of the tenant"
});

export const InviteUserBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
});

export const UserQuery = ListQuery.extend({ kind: z.enum(["human", "system", "terminal"]).optional() });
export const UserList = ListEnvelope(UserSchema);
```

Add `export * from "./admin/user";` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing test**

`apps/api/test/routes/admin/users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/admin/users — spec:2132, §5.0 row 0.7b 'users invited'", () => {
  let api: StartedApi; let a: Seed; let b: Seed;

  const grantAdmin = async (s: Seed): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system) values (${roleId}, ${s.tenant}, 'admin', 'Administrator', true)`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, 'admin.user.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    await grantAdmin(a); await grantAdmin(b);
  });
  afterAll(async () => { await api.stop(); });

  it("invites a user: the subject comes from the server, the principal and membership land in one transaction", async () => {
    const res = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "clerk@example.test", displayName: "Clerk" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; email: string };
    expect(created.email).toBe("clerk@example.test");

    const rows = await api.db.admin<{ auth_subject: string; n: number }[]>`
      select p.auth_subject, (select count(*)::int from app.membership m where m.principal_id = p.id) as n
        from app.principal p where p.id = ${created.id}`;
    expect(rows[0]!.auth_subject).toMatch(/^stub:[0-9a-f]{32}$/);      // server-obtained, never client-supplied
    expect(rows[0]!.n).toBe(1);
  });

  it("a client-supplied subject is ignored — the body has no such field (spec:2132)", async () => {
    const res = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "forger@example.test", displayName: "Forger", authSubject: "system:evil", sub: "system:evil" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const [row] = await api.db.admin<{ auth_subject: string }[]>`select auth_subject from app.principal where id = ${created.id}`;
    expect(row!.auth_subject).not.toContain("evil");
  });

  it("inviting the same address twice is one principal (the stub subject is deterministic)", async () => {
    const first = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human, body: { email: "twice@example.test", displayName: "Twice" } });
    const second = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human, body: { email: "twice@example.test", displayName: "Twice" } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(((await second.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("lists only this tenant's principals, newest first, with a working cursor", async () => {
    const page = await api.request({ method: "GET", path: "/v1/admin/users?limit=2", as: a.human });
    const body = (await page.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
    const next = await api.request({ method: "GET", path: `/v1/admin/users?limit=2&cursor=${body.next_cursor}`, as: a.human });
    const page2 = (await next.json()) as { items: { id: string }[] };
    expect(page2.items.map((i) => i.id)).not.toContain(body.items[0]!.id);

    const all = await api.request({ method: "GET", path: "/v1/admin/users?limit=1000", as: a.human });
    const ids = ((await all.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).not.toContain(b.human);                                // acceptance test 12, endpoint path
  });

  it("expiring a user expires every unexpired assignment and leaves the principal in place (spec:2049)", async () => {
    const invited = (await (await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "leaver@example.test", displayName: "Leaver" } })).json()) as { id: string };
    const roleId = (await api.db.admin<{ id: string }[]>`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`)[0]!.id;
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.tenant}, ${invited.id}, ${roleId}, ${a.company})`;
    });
    const res = await api.request({ method: "POST", path: `/v1/admin/users/${invited.id}/expire`, as: a.human });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: invited.id, expiredAssignments: 1 });
    const [still] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.principal where id = ${invited.id}`;
    expect(still!.n).toBe(1);
  });

  it("the last administrator cannot be expired (spec:2179 R5)", async () => {
    const res = await api.request({ method: "POST", path: `/v1/admin/users/${a.human}/expire`, as: a.human });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_LAST_ADMIN");
  });

  // Titled for what it proves. A principal that simply lacks the code is refused in
  // `apps/api/test/middleware/require-permission.test.ts`; this case is about the ONE principal that always
  // holds every code — `actor_has` short-circuits true for `kind = 'system'` in the current tenant
  // (plan0A:1366–1368) — and shows that even that principal is bounded by its tenant.
  it("one tenant's system principal holds every code there and none in another tenant", async () => {
    const res = await api.request({ method: "GET", path: "/v1/admin/users", as: a.system });
    expect(res.status).toBe(200);                                      // the system principal passes actor_has by design
    const outsider = await api.request({ method: "POST", path: "/v1/admin/users", as: b.system, body: { email: "x@y.test", displayName: "X" } });
    expect(outsider.status).toBe(201);                                 // …in ITS OWN tenant only
    const [leak] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.membership where tenant_id = ${a.tenant} and principal_id in
        (select id from app.principal where email = 'x@y.test')`;
    expect(leak!.n).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/admin/users.test.ts`
Expected: FAIL — every request answers 404 `ERR_NOT_FOUND`; the first assertion fails with `expected 404 to be 201`.

- [ ] **Step 4: Write `apps/api/src/routes/admin/users.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import { AppError, decodeCursor, encodeCursor, InviteUserBody, ProblemSchema, UserList, UserQuery, UserSchema, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import type { AuthAdmin } from "../../ports";

/** The invite port is injected once, at mount time, so no handler reaches for a module-level singleton. */
export function createUserRoutes(authAdmin: AuthAdmin): OpenAPIHono<AppEnv> {
  const users = new OpenAPIHono<AppEnv>();
  const gate = requirePermission(PERMISSION["admin.user.manage"], { company: "any" });

  users.openapi(
    createRoute({
      method: "post", path: "/", tags: ["admin"], middleware: [gate] as const,
      summary: "Invite a person to this tenant (spec:2132 — the subject comes from the identity provider)",
      request: { body: { content: { "application/json": { schema: InviteUserBody } } } },
      responses: {
        201: { description: "The principal", content: { "application/json": { schema: UserSchema } } },
        409: { description: "Already a member", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { email, displayName } = c.req.valid("json");
      // spec:2132: the sub is obtained by the SERVER. A client-supplied subject would let one tenant
      // pre-register another tenant's user, which is what app.principal's principal_insert policy assumes.
      const invited = await authAdmin.inviteUser(email);
      const id = newUuidV7();
      const created = await c.var.withTenant(async (tx) => {
        // No RETURNING on the principal insert: principal_in_tenant only admits rows that already have a
        // membership, and the membership cannot exist yet (v1.1 fix #2, plan0A:1013; OD-01 as built).
        await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
                 values (${id}, 'human', ${invited.sub}, ${invited.email}, ${displayName})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${c.var.ctx.tenantId}, ${id})`;
        const [row] = await tx<{ id: string; display_name: string; email: string | null; kind: "human"; created_at: Date }[]>`
          select id, display_name, email, kind, created_at from app.principal where id = ${id}`;
        return row!;
      });
      return c.json({
        id: created.id, displayName: created.display_name, email: created.email,
        kind: created.kind, createdAt: created.created_at.toISOString(), activeAssignments: 0,
      }, 201);
    },
  );

  users.openapi(
    createRoute({
      method: "get", path: "/", tags: ["admin"], middleware: [gate] as const,
      summary: "List the people who may use this tenant",
      request: { query: UserQuery },
      responses: { 200: { description: "A page of principals", content: { "application/json": { schema: UserList } } } },
    }),
    async (c) => {
      const { cursor, limit, kind } = c.req.valid("query");
      const after = cursor ? decodeCursor(cursor) : null;
      // Keyset on (created_at desc, id desc). Field names are literals here — never interpolated (test 27).
      const rows = await c.var.withTenant((tx) => tx<{
        id: string; display_name: string; email: string | null; kind: "human" | "system" | "terminal";
        created_at: Date; active_assignments: number;
      }[]>`
        select p.id, p.display_name, p.email, p.kind, p.created_at,
               (select count(*)::int from app.role_assignment ra
                 where ra.principal_id = p.id and (ra.expires_at is null or ra.expires_at > now())) as active_assignments
          from app.principal p
          join app.membership m on m.principal_id = p.id and m.tenant_id = ${c.var.ctx.tenantId}
         where (${kind ?? null}::text is null or p.kind::text = ${kind ?? null})
           and (${after ? String(after.k[0]) : null}::timestamptz is null
                or (p.created_at, p.id) < (${after ? String(after.k[0]) : null}::timestamptz, ${after?.id ?? null}::uuid))
         order by p.created_at desc, p.id desc
         limit ${limit + 1}`);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return c.json({
        items: page.map((r) => ({
          id: r.id, displayName: r.display_name, email: r.email, kind: r.kind,
          createdAt: r.created_at.toISOString(), activeAssignments: r.active_assignments,
        })),
        next_cursor: rows.length > limit && last ? encodeCursor({ k: [last.created_at.toISOString()], id: last.id }) : null,
      });
    },
  );

  users.openapi(
    createRoute({
      method: "post", path: "/{userId}/expire", tags: ["admin"], middleware: [gate] as const,
      summary: "End a person's access — every unexpired assignment expires; the principal is kept (spec:2049)",
      request: { params: z.object({ userId: UuidSchema }) },
      responses: {
        200: { description: "How many assignments were expired", content: { "application/json": { schema: z.object({ id: UuidSchema, expiredAssignments: z.number().int() }) } } },
        404: { description: "No such principal in this tenant", content: { "application/problem+json": { schema: ProblemSchema } } },
        409: { description: "The last administrator", content: { "application/problem+json": { schema: ProblemSchema } } },
      },
    }),
    async (c) => {
      const { userId } = c.req.valid("param");
      const expired = await c.var.withTenant(async (tx) => {
        const [member] = await tx<{ id: string }[]>`
          select p.id from app.principal p
            join app.membership m on m.principal_id = p.id and m.tenant_id = ${c.var.ctx.tenantId}
           where p.id = ${userId}`;
        if (!member) throw new AppError("ERR_NOT_FOUND", `no principal ${userId} in this tenant`);
        const rows = await tx<{ principal_id: string }[]>`
          update app.role_assignment set expires_at = now()
           where principal_id = ${userId} and (expires_at is null or expires_at > now())
           returning principal_id`;
        return rows.length;
      });
      return c.json({ id: userId, expiredAssignments: expired });
    },
  );

  return users;
}
```

- [ ] **Step 5: Mount it**

`apps/api/src/routes/index.ts` cannot build this module without the port, so `ROUTES` becomes a function of the deps for modules that need one. After Task 5 the file imports only `OpenAPIHono` (type), `PermissionCode` (type), `AppEnv` (type), `healthRoutes` and `sessionRoutes`, so add these three lines first:

```ts
import type { AuthAdmin } from "../ports";
import { StubAuthAdmin } from "../auth-admin";
import { createUserRoutes } from "./admin/users";
```

then change the file's export to:

```ts
export function buildRoutes(deps: { authAdmin: AuthAdmin }): readonly RouteModule[] {
  return [
    { path: "/healthz", router: healthRoutes, permissions: [], auth: "public" },
    { path: "/v1/session", router: sessionRoutes, permissions: [], auth: "human" },
    { path: "/v1/admin/users", router: createUserRoutes(deps.authAdmin), permissions: ["admin.user.manage"], auth: "human" },
  ];
}

/** The registry the OpenAPI generator and the tenant-isolation harness iterate. Built with a stub port because
 *  neither cares which AuthAdmin is wired — only which routes and codes exist (ADR 0006). */
export const ROUTES: readonly RouteModule[] = buildRoutes({ authAdmin: new StubAuthAdmin() });
```

and in `apps/api/src/app.ts` replace `for (const module of ROUTES)` with `for (const module of buildRoutes({ authAdmin: deps.authAdmin }))`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd apps/api test -- test/routes/admin/users.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api
git commit -m "$(cat <<'EOF'
feat(api): /v1/admin/users — invite, list, expire [0B T8]

The invite subject comes from the AuthAdmin port, never from the request body;
principal and membership land in one transaction with no RETURNING. Expiring a user
expires their assignments and keeps the row (spec:2049); the last admin is refused.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 9: RBAC administration — `/v1/admin/roles` and `/v1/companies/{companyId}/role-assignments`

The "roles assigned" half of the Phase 0 definition of done. Two resources in one task because they share one error surface: every refusal here comes from a Plan 0A trigger (`forbid_self_grant`, `assert_assignment_kind`, `keep_last_admin_*`), and the handlers add no checks of their own — the pre-flight is `requirePermission`, the control is the data layer (LEGACY-032). **One exception, and it is the only one:** `role_assignment.principal_id` is a plain FK to the global `app.principal` and FK checks bypass RLS (plan0A:1331–1334, 2027), so no trigger can see that a foreign tenant's principal was named. The assignment handler makes that one membership check itself, inside the same `withTenant` (Step 5).

Role assignments mount **under a company** (`role_assignment` carries `company_id`), so they use `{ company: "path:companyId" }` and need no tenant-wide scope. Roles do not, so they use `{ company: "any" }`.

**Files:**
- Create: `packages/contracts/src/admin/role.ts`, `packages/contracts/src/admin/role-assignment.ts`, `apps/api/src/routes/admin/roles.ts`, `apps/api/src/routes/admin/role-assignments.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`
- Test: `apps/api/test/routes/admin/roles.test.ts`, `apps/api/test/routes/admin/role-assignments.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `PERMISSION`, `PERMISSIONS` (Task 7); `ListEnvelope`, `ListQuery`, `UuidSchema`, `ProblemSchema`, `AppError`, `encodeCursor`, `decodeCursor` (Task 3); `startApi` (Task 5); the 0001 tables `role`, `role_permission`, `role_assignment`, `role_assignment_branch` and the triggers on them (plan0A:1296–1360, 1386–1420).
- Produces: `RoleSchema`, `CreateRoleBody`, `UpdateRoleBody`, `RolePermissionsBody`, `RoleList`; `RoleAssignmentSchema`, `CreateRoleAssignmentBody`, `RoleAssignmentBranchBody`, `RoleAssignmentList`; `roleRoutes` at `/v1/admin/roles` (`admin.role.manage`) and `roleAssignmentRoutes` at `/v1/companies/:companyId/role-assignments` (`admin.role.assign`).

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/admin/role.ts`:

```ts
import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";   // no ListQuery: roles take the plain one

export const RoleSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  createdAt: TimestampSchema,
});
export const CreateRoleBody = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
});
export const UpdateRoleBody = CreateRoleBody.partial().omit({ code: true });
export const RolePermissionsBody = z.object({ permissions: z.array(z.string()).max(200) });
export const RoleList = ListEnvelope(RoleSchema);
```

`packages/contracts/src/admin/role-assignment.ts`:

```ts
import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const RoleAssignmentSchema = z.object({
  principalId: UuidSchema,
  roleId: UuidSchema,
  companyId: UuidSchema,
  grantedBy: UuidSchema,
  grantedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  branchIds: z.array(UuidSchema),           // empty = every branch of the company (spec:2166)
});
export const CreateRoleAssignmentBody = z.object({
  principalId: UuidSchema,
  roleId: UuidSchema,
  expiresAt: TimestampSchema.optional(),
  branchIds: z.array(UuidSchema).optional(),
});
export const RoleAssignmentBranchBody = z.object({ branchIds: z.array(UuidSchema) });
export const RoleAssignmentQuery = ListQuery.extend({ principalId: UuidSchema.optional() });
export const RoleAssignmentList = ListEnvelope(RoleAssignmentSchema);
```

Add both to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing tests**

`apps/api/test/routes/admin/roles.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/admin/roles — spec:2136, 2179 R5", () => {
  let api: StartedApi; let a: Seed;

  const grant = async (s: Seed, ...codes: string[]): Promise<string> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system) values (${roleId}, ${s.tenant}, 'admin', 'Administrator', true)`;
      for (const code of codes) await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${roleId}, ${s.company})`;
    });
    return roleId;
  };

  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha");
    await grant(a, "admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read");
  });
  afterAll(async () => { await api.stop(); });

  it("creates a role, lists it, and reports its permissions", async () => {
    const created = await api.request({ method: "POST", path: "/v1/admin/roles", as: a.human,
      body: { code: "clerk", nameEn: "Clerk", nameAr: "كاتب" } });
    expect(created.status).toBe(201);
    const role = (await created.json()) as { id: string; permissions: string[]; isSystem: boolean };
    expect(role).toMatchObject({ permissions: [], isSystem: false });

    const set = await api.request({ method: "PUT", path: `/v1/admin/roles/${role.id}/permissions`, as: a.human,
      body: { permissions: ["admin.audit_log.read"] } });
    expect(set.status).toBe(200);
    expect((await set.json()) as { permissions: string[] }).toMatchObject({ permissions: ["admin.audit_log.read"] });

    const list = await api.request({ method: "GET", path: "/v1/admin/roles?limit=100", as: a.human });
    const codes = ((await list.json()) as { items: { code: string }[] }).items.map((r) => r.code).sort();
    expect(codes).toEqual(["admin", "clerk"]);
  });

  it("a code that is not in the catalogue is refused by the FK, as ERR_CONFLICT_REFERENCE", async () => {
    const role = (await (await api.request({ method: "POST", path: "/v1/admin/roles", as: a.human,
      body: { code: "ghost", nameEn: "Ghost" } })).json()) as { id: string };
    const res = await api.request({ method: "PUT", path: `/v1/admin/roles/${role.id}/permissions`, as: a.human,
      body: { permissions: ["admin.invented.code"] } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_REFERENCE");
  });

  it("a principal cannot widen a role they hold — the trigger refuses, not the handler (spec:2179 R5)", async () => {
    const [adminRole] = await api.db.admin<{ id: string }[]>`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
    const res = await api.request({ method: "PUT", path: `/v1/admin/roles/${adminRole!.id}/permissions`, as: a.human,
      body: { permissions: ["admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read"] } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_SELF_ESCALATION");
  });

  it("a duplicate role code in the same tenant is ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({ method: "POST", path: "/v1/admin/roles", as: a.human, body: { code: "clerk", nameEn: "Clerk again" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });
});
```

`apps/api/test/routes/admin/role-assignments.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/role-assignments — spec:2166, 2179 R5/R8", () => {
  let api: StartedApi; let a: Seed; let clerkRole: string; let invited: string;

  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha");
    const adminRole = await uuidv7(api.db.admin); clerkRole = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system) values
        (${adminRole}, ${a.tenant}, 'admin', 'Administrator', true), (${clerkRole}, ${a.tenant}, 'clerk', 'Clerk', true)`;
      for (const code of ["admin.user.manage", "admin.role.assign"]) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${adminRole}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.tenant}, ${a.human}, ${adminRole}, ${a.company})`;
    });
    invited = ((await (await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "clerk@example.test", displayName: "Clerk" } })).json()) as { id: string }).id;
  });
  afterAll(async () => { await api.stop(); });

  it("assigns a role in a company, with branch rows, and lists it back", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/role-assignments`, as: a.human,
      body: { principalId: invited, roleId: clerkRole, branchIds: [a.hq] } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ principalId: invited, roleId: clerkRole, companyId: a.company, branchIds: [a.hq], grantedBy: a.human });

    const list = await api.request({ method: "GET", path: `/v1/companies/${a.company}/role-assignments?principalId=${invited}`, as: a.human });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("grantedBy is stamped from the session, not from the body (LEGACY-044)", async () => {
    const [row] = await api.db.admin<{ granted_by: string }[]>`
      select granted_by from app.role_assignment where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(row!.granted_by).toBe(a.human);
  });

  it("a principal cannot change their own assignments (spec:2179 R5)", async () => {
    const res = await api.request({ method: "POST", path: `/v1/companies/${a.company}/role-assignments`, as: a.human,
      body: { principalId: a.human, roleId: clerkRole } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_SELF_GRANT");
  });

  it("replacing the branch rows narrows the assignment; an empty list means every branch", async () => {
    const narrowed = await api.request({ method: "PUT",
      path: `/v1/companies/${a.company}/role-assignments/${invited}/${clerkRole}/branches`, as: a.human, body: { branchIds: [] } });
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toMatchObject({ branchIds: [] });
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment_branch where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(n!.n).toBe(0);
  });

  it("expiring the assignment is an update, never a delete (spec:2049)", async () => {
    const res = await api.request({ method: "DELETE",
      path: `/v1/companies/${a.company}/role-assignments/${invited}/${clerkRole}`, as: a.human });
    expect(res.status).toBe(200);
    const [row] = await api.db.admin<{ expires_at: Date | null }[]>`
      select expires_at from app.role_assignment where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(row!.expires_at).not.toBeNull();
  });

  it("another tenant's company id is 403, and its principal id is 409 ERR_CONFLICT_REFERENCE (never a leak)", async () => {
    const b = await seedTenant(api.db, "Beta");
    expect((await api.request({ method: "POST", path: `/v1/companies/${b.company}/role-assignments`, as: a.human,
      body: { principalId: invited, roleId: clerkRole } })).status).toBe(403);
    const cross = await api.request({ method: "POST", path: `/v1/companies/${a.company}/role-assignments`, as: a.human,
      body: { principalId: b.human, roleId: clerkRole } });
    expect(cross.status).toBe(409);
    expect(((await cross.json()) as Problem).code).toBe("ERR_CONFLICT_REFERENCE");
    // …and no junk row survives the attempt: the FK alone would have accepted it (plan0A:2027).
    const [junk] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment where principal_id = ${b.human}`;
    expect(junk!.n).toBe(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun run --cwd apps/api test -- test/routes/admin/roles.test.ts test/routes/admin/role-assignments.test.ts`
Expected: FAIL — both suites answer 404 `ERR_NOT_FOUND` on the first request.

- [ ] **Step 4: Write `apps/api/src/routes/admin/roles.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import { AppError, CreateRoleBody, decodeCursor, encodeCursor, ListQuery, ProblemSchema, RoleList, RolePermissionsBody, RoleSchema, UpdateRoleBody, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

export const roleRoutes = new OpenAPIHono<AppEnv>();
const gate = requirePermission(PERMISSION["admin.role.manage"], { company: "any" });

type RoleRow = { id: string; code: string; name_en: string; name_ar: string | null; description: string | null; is_system: boolean; created_at: Date; permissions: string[] };
const toRole = (r: RoleRow) => ({
  id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, description: r.description,
  isSystem: r.is_system, permissions: r.permissions, createdAt: r.created_at.toISOString(),
});

roleRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["admin"], middleware: [gate] as const, summary: "Create a role",
    request: { body: { content: { "application/json": { schema: CreateRoleBody } } } },
    responses: {
      201: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      409: { description: "Duplicate code", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const id = newUuidV7();
    const row = await c.var.withTenant(async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, name_ar, description)
               values (${id}, ${c.var.ctx.tenantId}, ${body.code}, ${body.nameEn}, ${body.nameAr ?? null}, ${body.description ?? null})`;
      const [r] = await tx<Omit<RoleRow, "permissions">[]>`
        select id, code, name_en, name_ar, description, is_system, created_at from app.role where id = ${id}`;
      return r!;
    });
    return c.json(toRole({ ...row, permissions: [] }), 201);
  },
);

roleRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["admin"], middleware: [gate] as const, summary: "List roles",
    request: { query: ListQuery },
    responses: { 200: { description: "A page of roles", content: { "application/json": { schema: RoleList } } } },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant((tx) => tx<RoleRow[]>`
      select r.id, r.code, r.name_en, r.name_ar, r.description, r.is_system, r.created_at,
             coalesce(array_agg(rp.permission_code order by rp.permission_code)
                      filter (where rp.permission_code is not null), '{}') as permissions
        from app.role r left join app.role_permission rp on rp.role_id = r.id
       where (${after ? after.id : null}::uuid is null or r.id > ${after ? after.id : null}::uuid)
       group by r.id order by r.id limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      items: page.map(toRole),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null,
    });
  },
);

roleRoutes.openapi(
  createRoute({
    method: "patch", path: "/{roleId}", tags: ["admin"], middleware: [gate] as const, summary: "Rename a role",
    request: { params: z.object({ roleId: UuidSchema }), body: { content: { "application/json": { schema: UpdateRoleBody } } } },
    responses: {
      200: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      404: { description: "No such role", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { roleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<Omit<RoleRow, "permissions">[]>`
        update app.role set
          name_en     = coalesce(${body.nameEn ?? null}, name_en),
          name_ar     = coalesce(${body.nameAr ?? null}, name_ar),
          description = coalesce(${body.description ?? null}, description)
         where id = ${roleId}
         returning id, code, name_en, name_ar, description, is_system, created_at`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no role ${roleId} in this tenant`);
      const perms = await tx<{ permission_code: string }[]>`
        select permission_code from app.role_permission where role_id = ${roleId} order by 1`;
      return { ...updated[0]!, permissions: perms.map((p) => p.permission_code) };
    });
    return c.json(toRole(row));
  },
);

roleRoutes.openapi(
  createRoute({
    method: "put", path: "/{roleId}/permissions", tags: ["admin"], middleware: [gate] as const,
    summary: "Replace the permissions a role grants — the reviewed diff of spec:2152, at run time",
    request: { params: z.object({ roleId: UuidSchema }), body: { content: { "application/json": { schema: RolePermissionsBody } } } },
    responses: {
      200: { description: "The role", content: { "application/json": { schema: RoleSchema } } },
      409: { description: "Self-escalation, last admin, or an unknown code", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { roleId } = c.req.valid("param");
    const { permissions } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const [exists] = await tx<{ id: string }[]>`select id from app.role where id = ${roleId}`;
      if (!exists) throw new AppError("ERR_NOT_FOUND", `no role ${roleId} in this tenant`);
      // forbid_self_grant and keep_last_admin_permission fire on both statements; the handler adds no check.
      await tx`delete from app.role_permission where role_id = ${roleId}
                and permission_code <> all(${permissions}::text[])`;
      for (const code of permissions) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${c.var.ctx.tenantId}, ${roleId}, ${code}) on conflict do nothing`;
      }
      const [r] = await tx<Omit<RoleRow, "permissions">[]>`
        select id, code, name_en, name_ar, description, is_system, created_at from app.role where id = ${roleId}`;
      const perms = await tx<{ permission_code: string }[]>`
        select permission_code from app.role_permission where role_id = ${roleId} order by 1`;
      return { ...r!, permissions: perms.map((p) => p.permission_code) };
    });
    return c.json(toRole(row));
  },
);
```

- [ ] **Step 5: Write `apps/api/src/routes/admin/role-assignments.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, CreateRoleAssignmentBody, ProblemSchema, RoleAssignmentBranchBody, RoleAssignmentList, RoleAssignmentQuery, RoleAssignmentSchema, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

export const roleAssignmentRoutes = new OpenAPIHono<AppEnv>();
const gate = requirePermission(PERMISSION["admin.role.assign"], { company: "path:companyId" });
const Key = z.object({ companyId: UuidSchema, principalId: UuidSchema, roleId: UuidSchema });

type AssignmentRow = { principal_id: string; role_id: string; company_id: string; granted_by: string; granted_at: Date; expires_at: Date | null; branch_ids: string[] };
const toAssignment = (r: AssignmentRow) => ({
  principalId: r.principal_id, roleId: r.role_id, companyId: r.company_id, grantedBy: r.granted_by,
  grantedAt: r.granted_at.toISOString(), expiresAt: r.expires_at?.toISOString() ?? null, branchIds: r.branch_ids,
});


roleAssignmentRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["admin"], middleware: [gate] as const,
    summary: "Assign a role in this company, optionally restricted to branches (spec:2166)",
    request: { params: z.object({ companyId: UuidSchema }), body: { content: { "application/json": { schema: CreateRoleAssignmentBody } } } },
    responses: {
      201: { description: "The assignment", content: { "application/json": { schema: RoleAssignmentSchema } } },
      409: { description: "Self-grant, wrong kind, or an unknown principal or role", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      // The ONE check the data layer cannot make for us. `role_assignment.principal_id` is a PLAIN FK to the
      // global `app.principal` (plan0A:1331–1334), not a composite `(tenant_id, principal_id)` one, and FK
      // checks bypass RLS (plan0A:2027) — so another tenant's principal id satisfies it. `assert_assignment_kind`
      // then reads `select kind from app.principal where id = new.principal_id` as `app_rw` under FORCE RLS:
      // zero rows, `v_kind` NULL, both branches NULL, no exception. Membership is the tenant-scoped fact, so ask
      // for it — RLS supplies the tenant — and a miss is a reference conflict, never a junk assignment row.
      const [member] = await tx<{ principal_id: string }[]>`
        select principal_id from app.membership where principal_id = ${body.principalId}`;
      if (!member) throw new AppError("ERR_CONFLICT_REFERENCE", `no principal ${body.principalId} in this tenant`);
      // granted_by is stamped by the trigger; a value in the statement is overwritten (plan0A:2373, LEGACY-044).
      // forbid_self_grant and assert_assignment_kind fire on the insert; the handler adds no OTHER check —
      // a cross-tenant `role_id` is already refused by the composite `(tenant_id, role_id)` FK.
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id, expires_at)
               values (${c.var.ctx.tenantId}, ${body.principalId}, ${body.roleId}, ${companyId}, ${body.expiresAt ?? null})`;
      for (const branchId of body.branchIds ?? []) {
        await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
                 values (${c.var.ctx.tenantId}, ${body.principalId}, ${body.roleId}, ${companyId}, ${branchId})`;
      }
      return readOne(tx, companyId, body.principalId, body.roleId);
    });
    return c.json(toAssignment(row), 201);
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["admin"], middleware: [gate] as const, summary: "List this company's assignments",
    request: { params: z.object({ companyId: UuidSchema }), query: RoleAssignmentQuery },
    responses: { 200: { description: "A page of assignments", content: { "application/json": { schema: RoleAssignmentList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const { limit, principalId } = c.req.valid("query");
    const rows = await c.var.withTenant((tx) => tx<AssignmentRow[]>`
      select ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at,
             coalesce(array_agg(b.branch_id) filter (where b.branch_id is not null), '{}') as branch_ids
        from app.role_assignment ra
        left join app.role_assignment_branch b
               on b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
       where ra.company_id = ${companyId}
         and (${principalId ?? null}::uuid is null or ra.principal_id = ${principalId ?? null}::uuid)
       group by ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at
       order by ra.granted_at desc, ra.principal_id desc limit ${limit}`);
    return c.json({ items: rows.map(toAssignment), next_cursor: null });
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "put", path: "/{principalId}/{roleId}/branches", tags: ["admin"], middleware: [gate] as const,
    summary: "Replace the branch rows of one assignment — an empty list means every branch of the company",
    request: { params: Key, body: { content: { "application/json": { schema: RoleAssignmentBranchBody } } } },
    responses: {
      200: { description: "The assignment", content: { "application/json": { schema: RoleAssignmentSchema } } },
      404: { description: "No such assignment", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, principalId, roleId } = c.req.valid("param");
    const { branchIds } = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      await tx`delete from app.role_assignment_branch
                where principal_id = ${principalId} and role_id = ${roleId} and company_id = ${companyId}`;
      for (const branchId of branchIds) {
        await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
                 values (${c.var.ctx.tenantId}, ${principalId}, ${roleId}, ${companyId}, ${branchId})`;
      }
      return readOne(tx, companyId, principalId, roleId);
    });
    return c.json(toAssignment(row));
  },
);

roleAssignmentRoutes.openapi(
  createRoute({
    method: "delete", path: "/{principalId}/{roleId}", tags: ["admin"], middleware: [gate] as const,
    summary: "End an assignment — expires_at is set; the row is never deleted (spec:2049)",
    request: { params: Key },
    responses: {
      200: { description: "The expired assignment", content: { "application/json": { schema: RoleAssignmentSchema } } },
      409: { description: "The last administrator", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId, principalId, roleId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<{ principal_id: string }[]>`
        update app.role_assignment set expires_at = now()
         where principal_id = ${principalId} and role_id = ${roleId} and company_id = ${companyId}
         returning principal_id`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no assignment of role ${roleId} to principal ${principalId} in company ${companyId}`);
      return readOne(tx, companyId, principalId, roleId);
    });
    return c.json(toAssignment(row));
  },
);

async function readOne(tx: Parameters<Parameters<AppEnv["Variables"]["withTenant"]>[0]>[0],
                       companyId: string, principalId: string, roleId: string): Promise<AssignmentRow> {
  const [row] = await tx<AssignmentRow[]>`
    select ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at,
           coalesce(array_agg(b.branch_id) filter (where b.branch_id is not null), '{}') as branch_ids
      from app.role_assignment ra
      left join app.role_assignment_branch b
             on b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
     where ra.principal_id = ${principalId} and ra.role_id = ${roleId} and ra.company_id = ${companyId}
     group by ra.principal_id, ra.role_id, ra.company_id, ra.granted_by, ra.granted_at, ra.expires_at`;
  if (!row) throw new AppError("ERR_NOT_FOUND", `no assignment of role ${roleId} to principal ${principalId} in company ${companyId}`);
  return row;
}
```


- [ ] **Step 6: Mount both modules**

In `apps/api/src/routes/index.ts`, add the two imports:

```ts
import { roleRoutes } from "./admin/roles";
import { roleAssignmentRoutes } from "./admin/role-assignments";
```

and the two entries, inside `buildRoutes`:

```ts
    { path: "/v1/admin/roles", router: roleRoutes, permissions: ["admin.role.manage"], auth: "human" },
    { path: "/v1/companies/:companyId/role-assignments", router: roleAssignmentRoutes, permissions: ["admin.role.assign"], auth: "human" },
```

- [ ] **Step 7: Run the tests and commit**

Run: `bun run --cwd apps/api test -- test/routes/admin/`
Expected: PASS — users 7, roles 4, assignments 6.

```bash
git add packages/contracts apps/api
git commit -m "$(cat <<'EOF'
feat(api): role and role-assignment administration [0B T9]

Every refusal comes from a Plan 0A trigger — forbid_self_grant, assert_assignment_kind,
keep_last_admin_* — surfaced as a problem code (LEGACY-032). The one check a trigger cannot
make is membership: principal_id is a plain FK and FK checks bypass RLS, so the assignment
handler asks for the membership row and answers ERR_CONFLICT_REFERENCE on a miss.
granted_by is stamped from the session; ending an assignment sets expires_at.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `/v1/companies` and `/v1/admin/audit-log`

The last two admin surfaces, and the place cursor pagination and the filter grammar are proved end to end — the audit log is the largest table any Phase 0 endpoint reads and is keyed by `seq`, not `id`.

**Files:**
- Create: `packages/contracts/src/admin/company.ts`, `packages/contracts/src/admin/audit-log.ts`, `apps/api/src/routes/companies.ts`, `apps/api/src/routes/admin/audit-log.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`
- Test: `apps/api/test/routes/companies.test.ts`, `apps/api/test/routes/admin/audit-log.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `PERMISSION` (Task 7); `encodeCursor`, `decodeCursor`, `ListEnvelope`, `ListQuery` (Task 3); `app.audit_log (seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after)` (plan0A:2256–2272). **`parseFilters` is deliberately not in that list.** It ships in Task 3 because contracts §4.2.8 names it, but the audit-log handler reads the flat `AuditLogQuery` fields (`tableName`, `actorId`, `action`, `from`, `to`) that §4.2.8 Layer 1 grandfathers, and no 0B file calls `parseFilters` — the first caller is a later slice's list endpoint.
- Produces: `CompanySchema`, `CreateCompanyBody`, `UpdateCompanyBody`, `CompanyList`; `AuditLogEntrySchema`, `AuditLogQuery`, `AuditLogList`; `companyRoutes` at `/v1/companies` (`admin.company.manage`) and `auditLogRoutes` at `/v1/admin/audit-log` (`admin.audit_log.read`).

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/admin/company.ts`:

```ts
import { z } from "zod";
import { CurrencySchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const CompanySchema = z.object({
  id: UuidSchema, code: z.string(), name: z.string(),
  baseCurrency: CurrencySchema, timezone: z.string(), createdAt: TimestampSchema,
});
export const CreateCompanyBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{1,20}$/),
  name: z.string().min(1).max(200),
  baseCurrency: CurrencySchema,
  timezone: z.string().min(1).max(64).default("Asia/Kuala_Lumpur"),      // spec:2039 first customer
});
export const UpdateCompanyBody = z.object({ name: z.string().min(1).max(200).optional(), timezone: z.string().min(1).max(64).optional() });
export const CompanyList = ListEnvelope(CompanySchema);
```

`packages/contracts/src/admin/audit-log.ts`:

```ts
import { z } from "zod";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const AuditLogEntrySchema = z.object({
  seq: z.string(),                          // bigint on the wire is a string — a number would lose precision
  actorId: UuidSchema,
  occurredAt: TimestampSchema,
  tableName: z.string(),
  rowId: z.string(),
  action: z.enum(["insert", "update", "delete"]),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
/** The declared filterable fields — anything else is ERR_VALIDATION_FAILED and no name reaches SQL (test 27). */
export const AuditLogQuery = ListQuery.extend({
  tableName: z.string().max(63).optional(),
  actorId: UuidSchema.optional(),
  action: z.enum(["insert", "update", "delete"]).optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  /**
   * `ListQuery` declares `sort`, but no Phase 0 resource honours a caller-supplied sort key: the audit log is
   * always `seq desc`. A non-empty value is therefore a 400 naming the field, not a silently ignored parameter —
   * which is what makes `?sort=seq;drop table app.tenant` an ERR_VALIDATION_FAILED rather than a 200. The
   * override is an EMPTY-STRING bound on the same key, not a `.refine(...)`: `@hono/zod-openapi` generates query
   * parameters from a `ZodObject`, and a `.refine` would wrap the schema in `ZodEffects`. `.strict()` is likewise
   * avoided — `legacy-036` sends undeclared `where=` and `filter=` keys and expects them stripped, not rejected.
   */
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
});
export const AuditLogList = ListEnvelope(AuditLogEntrySchema);
```

- [ ] **Step 2: Write the failing tests**

`apps/api/test/routes/companies.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

describe("/v1/companies — spec:2320 configuration through the API", () => {
  let api: StartedApi; let a: Seed; let b: Seed;
  const grant = async (s: Seed, code: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${s.tenant}, ${`r-${code}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${roleId}, ${s.company})`;
    });
  };
  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    await grant(a, "admin.company.manage"); await grant(b, "admin.company.manage");
  });
  afterAll(async () => { await api.stop(); });

  it("creates a company with MYR and the default timezone, and reads it back", async () => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human, body: { code: "BR1", name: "Branch One", baseCurrency: "MYR" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const one = await api.request({ method: "GET", path: `/v1/companies/${created.id}`, as: a.human });
    expect(await one.json()).toMatchObject({ code: "BR1", baseCurrency: "MYR", timezone: "Asia/Kuala_Lumpur" });
  });

  it("a lower-case currency or a bad code is ERR_VALIDATION_FAILED naming the field", async () => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human, body: { code: "br 2", name: "X", baseCurrency: "myr" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Problem;
    expect(body.code).toBe("ERR_VALIDATION_FAILED");
    expect(body.errors?.map((e) => e.path).sort()).toEqual(["baseCurrency", "code"]);
  });

  it("lists only this tenant's companies, and another tenant's id is 404 not 403 (never a leak)", async () => {
    const list = await api.request({ method: "GET", path: "/v1/companies?limit=100", as: a.human });
    const ids = ((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);
    expect((await api.request({ method: "GET", path: `/v1/companies/${b.company}`, as: a.human })).status).toBe(404);
  });

  it("renaming a company writes an audit row with the server-supplied actor (acceptance test 13)", async () => {
    await api.request({ method: "PATCH", path: `/v1/companies/${a.company}`, as: a.human, body: { name: "Alpha HQ renamed" } });
    const [row] = await api.db.admin<{ actor_id: string; action: string }[]>`
      select actor_id, action from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'company' and row_id = ${a.company} order by seq desc limit 1`;
    expect(row).toEqual({ actor_id: a.human, action: "update" });
  });
});
```

`apps/api/test/routes/admin/audit-log.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/admin/audit-log — spec:2124, acceptance test 13; LEGACY-029, 030, 040", () => {
  let api: StartedApi; let a: Seed; let b: Seed;
  beforeAll(async () => {
    api = await startApi(); a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'auditor', 'Auditor')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  });
  afterAll(async () => { await api.stop(); });

  it("returns this tenant's rows only, newest first, seq as a string", async () => {
    const res = await api.request({ method: "GET", path: "/v1/admin/audit-log?limit=5", as: a.human });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { seq: string; tableName: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.items[0]!.seq).toBe("string");
    const seqs = body.items.map((i) => BigInt(i.seq));
    expect([...seqs].sort((x, y) => (x < y ? 1 : -1))).toEqual(seqs);        // descending

    const mine = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${b.tenant}`;
    expect(mine[0]!.n).toBeGreaterThan(0);                                    // Beta has rows…
    const all = await api.request({ method: "GET", path: "/v1/admin/audit-log?limit=1000", as: a.human });
    const tenants = new Set(((await all.json()) as { items: { rowId: string }[] }).items.map((i) => i.rowId));
    expect(tenants.has(b.company)).toBe(false);                               // …and none of them are visible here
  });

  it("pages with a cursor without repeating or skipping a row", async () => {
    const first = (await (await api.request({ method: "GET", path: "/v1/admin/audit-log?limit=3", as: a.human })).json()) as
      { items: { seq: string }[]; next_cursor: string | null };
    const second = (await (await api.request({ method: "GET", path: `/v1/admin/audit-log?limit=3&cursor=${first.next_cursor}`, as: a.human })).json()) as
      { items: { seq: string }[] };
    const overlap = first.items.map((i) => i.seq).filter((s) => second.items.some((x) => x.seq === s));
    expect(overlap).toEqual([]);
  });

  it("filters on the declared fields and rejects an undeclared one (test 27)", async () => {
    const filtered = await api.request({ method: "GET", path: "/v1/admin/audit-log?tableName=company&action=insert&limit=50", as: a.human });
    const items = ((await filtered.json()) as { items: { tableName: string; action: string }[] }).items;
    expect(items.every((i) => i.tableName === "company" && i.action === "insert")).toBe(true);

    const injected = await api.request({ method: "GET", path: "/v1/admin/audit-log?sort=seq;drop%20table%20app.tenant", as: a.human });
    expect(injected.status).toBe(400);
    expect(((await injected.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    const [still] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.tenant`;
    expect(still!.n).toBeGreaterThan(0);
  });

  it("a principal without admin.audit_log.read is refused", async () => {
    expect((await api.request({ method: "GET", path: "/v1/admin/audit-log", as: b.human })).status).toBe(403);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun run --cwd apps/api test -- test/routes/companies.test.ts test/routes/admin/audit-log.test.ts`
Expected: FAIL — both answer 404 `ERR_NOT_FOUND`.

- [ ] **Step 4: Write `apps/api/src/routes/companies.ts`**

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { v7 as newUuidV7 } from "uuid";
import { AppError, CompanyList, CompanySchema, CreateCompanyBody, decodeCursor, encodeCursor, ListQuery, ProblemSchema, UpdateCompanyBody, UuidSchema } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { requirePermission } from "../middleware/require-permission";

export const companyRoutes = new OpenAPIHono<AppEnv>();
const anyCompany = requirePermission(PERMISSION["admin.company.manage"], { company: "any" });
const thisCompany = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });

type CompanyRow = { id: string; code: string; name: string; base_currency: string; timezone: string; created_at: Date };
const toCompany = (r: CompanyRow) => ({
  id: r.id, code: r.code, name: r.name, baseCurrency: r.base_currency, timezone: r.timezone, createdAt: r.created_at.toISOString(),
});

companyRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["admin"], middleware: [anyCompany] as const, summary: "Create a company",
    request: { body: { content: { "application/json": { schema: CreateCompanyBody } } } },
    responses: {
      201: { description: "The company", content: { "application/json": { schema: CompanySchema } } },
      400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const id = newUuidV7();
    const row = await c.var.withTenant(async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency, timezone)
               values (${id}, ${c.var.ctx.tenantId}, ${body.code}, ${body.name}, ${body.baseCurrency}, ${body.timezone})`;
      const [r] = await tx<CompanyRow[]>`select id, code, name, base_currency, timezone, created_at from app.company where id = ${id}`;
      return r!;
    });
    return c.json(toCompany(row), 201);
  },
);

companyRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["admin"], middleware: [anyCompany] as const, summary: "List companies",
    request: { query: ListQuery },
    responses: { 200: { description: "A page of companies", content: { "application/json": { schema: CompanyList } } } },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant((tx) => tx<CompanyRow[]>`
      select id, code, name, base_currency, timezone, created_at from app.company
       where (${after ? after.id : null}::uuid is null or id > ${after ? after.id : null}::uuid)
       order by id limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({ items: page.map(toCompany), next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.id }) : null });
  },
);

// `anyCompany`, NOT `thisCompany`, on the read. `thisCompany` would evaluate `actor_has(code, <other tenant's
// company>)` and answer 403 before the handler ran — telling the caller "that id exists but is not yours",
// which is the leak spec:2049's "never a leak" rule and `tests/invariants/probes.ts` both forbid. With
// `{ company: "any" }` the gate passes on the caller's own tenant, the handler runs, and RLS makes another
// tenant's row simply absent: 404. The mutation below keeps `thisCompany` — a write must name its company.
companyRoutes.openapi(
  createRoute({
    method: "get", path: "/{companyId}", tags: ["admin"], middleware: [anyCompany] as const, summary: "Read one company",
    request: { params: z.object({ companyId: UuidSchema }) },
    responses: {
      200: { description: "The company", content: { "application/json": { schema: CompanySchema } } },
      404: { description: "Not in this tenant", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const row = await c.var.withTenant(async (tx) => {
      const [r] = await tx<CompanyRow[]>`select id, code, name, base_currency, timezone, created_at from app.company where id = ${companyId}`;
      if (!r) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
      return r;
    });
    return c.json(toCompany(row));
  },
);

companyRoutes.openapi(
  createRoute({
    method: "patch", path: "/{companyId}", tags: ["admin"], middleware: [thisCompany] as const,
    summary: "Rename a company or change its timezone — base_currency is immutable once postings exist",
    request: { params: z.object({ companyId: UuidSchema }), body: { content: { "application/json": { schema: UpdateCompanyBody } } } },
    responses: {
      200: { description: "The company", content: { "application/json": { schema: CompanySchema } } },
      404: { description: "Not in this tenant", content: { "application/problem+json": { schema: ProblemSchema } } },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.var.withTenant(async (tx) => {
      const updated = await tx<CompanyRow[]>`
        update app.company set name = coalesce(${body.name ?? null}, name), timezone = coalesce(${body.timezone ?? null}, timezone)
         where id = ${companyId} returning id, code, name, base_currency, timezone, created_at`;
      if (updated.length === 0) throw new AppError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
      return updated[0]!;
    });
    return c.json(toCompany(row));
  },
);
```

`companyRoutes` mounts at `/v1/companies`, and `GET /v1/companies/{companyId}` sits on the same prefix as `/v1/companies/:companyId/role-assignments`; Hono matches the more specific pattern first, so no ordering work is needed.

- [ ] **Step 5: Write `apps/api/src/routes/admin/audit-log.ts`**

```ts
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { AuditLogList, AuditLogQuery, decodeCursor, encodeCursor } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

export const auditLogRoutes = new OpenAPIHono<AppEnv>();

auditLogRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["admin"],
    middleware: [requirePermission(PERMISSION["admin.audit_log.read"], { company: "any" })] as const,
    summary: "Read the append-only audit log (spec:2124). Every filterable field is declared in AuditLogQuery; a field name never reaches SQL as text (test 27).",
    request: { query: AuditLogQuery },
    responses: { 200: { description: "A page of audit rows", content: { "application/json": { schema: AuditLogList } } } },
  }),
  async (c) => {
    const { cursor, limit, tableName, actorId, action, from, to } = c.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await c.var.withTenant((tx) => tx<{
      seq: string; actor_id: string; occurred_at: Date; table_name: string; row_id: string;
      action: "insert" | "update" | "delete"; before: unknown; after: unknown;
    }[]>`
      select seq::text as seq, actor_id, occurred_at, table_name, row_id, action, before, after
        from app.audit_log
       where (${tableName ?? null}::text is null or table_name = ${tableName ?? null})
         and (${actorId ?? null}::uuid is null or actor_id = ${actorId ?? null}::uuid)
         and (${action ?? null}::text is null or action = ${action ?? null})
         and (${from ?? null}::date is null or occurred_at >= ${from ?? null}::date)
         and (${to ?? null}::date is null or occurred_at < (${to ?? null}::date + 1))
         and (${after ? after.id : null}::bigint is null or seq < ${after ? after.id : null}::bigint)
       order by seq desc limit ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      items: page.map((r) => ({
        seq: r.seq, actorId: r.actor_id, occurredAt: r.occurred_at.toISOString(), tableName: r.table_name,
        rowId: r.row_id, action: r.action, before: r.before ?? null, after: r.after ?? null,
      })),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.seq }) : null,
    });
  },
);
```

`ListQuery`'s `sort` is declared but no Phase 0 resource honours a caller-supplied sort key: the audit log is always `seq desc`, and users, roles and companies are keyed. The rejection is already in Step 1's `AuditLogQuery` — the `sort: z.string().max(0, …).optional()` override — and it is what makes the injection assertion in Step 2 a 400 rather than a silently ignored parameter. Nothing is added to the schema here.

- [ ] **Step 6: Mount both and run**

In `apps/api/src/routes/index.ts`, add the two imports:

```ts
import { companyRoutes } from "./companies";
import { auditLogRoutes } from "./admin/audit-log";
```

and the two entries, inside `buildRoutes`:

```ts
    { path: "/v1/companies", router: companyRoutes, permissions: ["admin.company.manage"], auth: "human" },
    { path: "/v1/admin/audit-log", router: auditLogRoutes, permissions: ["admin.audit_log.read"], auth: "human" },
```

Run: `bun run --cwd apps/api test`
Expected: PASS — health 4, auth 6, session 2, idempotency 9, require-permission 5, users 7, roles 4, assignments 6, companies 4, audit-log 4.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api
git commit -m "$(cat <<'EOF'
feat(api): /v1/companies and /v1/admin/audit-log [0B T10]

Keyset pagination on both; the audit log pages on seq and is read-only for app_rw.
Every filterable field is declared in Zod, so no field name reaches SQL as text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 11: the OpenAPI document — generated from Zod, committed, diffed in CI

**Files:**
- Create: `apps/api/src/openapi.ts`, `apps/api/src/routes/idempotency-header.ts`, `packages/contracts/openapi.json` (generated output, committed)
- Modify: `.github/workflows/ci.yml`, `apps/api/src/routes/index.ts` (one re-export line), `apps/api/src/routes/admin/users.ts`, `roles.ts`, `role-assignments.ts`, `apps/api/src/routes/companies.ts` (Step 4 — the `Idempotency-Key` header on ten operations)
- Test: `apps/api/test/openapi.test.ts`

**Interfaces:**
- Consumes: `createApp`, `AppDeps` (Task 4); `StubAuthAdmin` (Task 5); every route mounted by Tasks 4–10.
- Produces: `bun run --cwd apps/api openapi:generate` writing `packages/contracts/openapi.json`; the CI step that fails on a diff; **`IdempotencyHeader`**, declared in `apps/api/src/routes/idempotency-header.ts` and re-exported from `apps/api/src/routes/index.ts` — later slices (0D, 2A, 2C) import it as `IdempotencyHeader` from either module and get the same binding. The generator lives in `apps/api` because `packages/contracts` may not import an app (spec:2389) — the package's own `openapi:generate` script shells out to it (Task 3).

- [ ] **Step 1: Write the failing test**

`apps/api/test/openapi.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPENAPI_PATH } from "../src/openapi";

describe("the OpenAPI document — spec:2055, 2199", () => {
  const doc = buildOpenApiDocument();

  it("describes every route this slice mounts, under /v1 except the health probe", () => {
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/healthz",
      "/v1/admin/audit-log",
      "/v1/admin/roles",
      "/v1/admin/roles/{roleId}",
      "/v1/admin/roles/{roleId}/permissions",
      "/v1/admin/users",
      "/v1/admin/users/{userId}/expire",
      "/v1/companies",
      "/v1/companies/{companyId}",
      "/v1/companies/{companyId}/role-assignments",
      "/v1/companies/{companyId}/role-assignments/{principalId}/{roleId}",
      "/v1/companies/{companyId}/role-assignments/{principalId}/{roleId}/branches",
      "/v1/session",
    ]);
  });

  it("every unsafe operation documents an Idempotency-Key header (spec:2201)", () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const op = (item as Record<string, { parameters?: { name: string }[] }>)[method];
        if (!op) continue;
        expect(op.parameters?.map((p) => p.name), `${method.toUpperCase()} ${path}`).toContain("Idempotency-Key");
      }
    }
  });

  it("the committed document is byte-identical to the generated one (the CI diff check)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const committed = readFileSync(join(here, "..", "..", "..", OPENAPI_PATH), "utf8");
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/openapi.test.ts`
Expected: FAIL — `Cannot find module '../src/openapi'`.

- [ ] **Step 3: Write `apps/api/src/openapi.ts`**

```ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { createLogger } from "@dulja/contracts";
import { createApp } from "./app";
import { StubAuthAdmin } from "./auth-admin";

/** Repo-relative, so the generator and the test agree on one location (spec:2199 "committed, diffed in CI"). */
export const OPENAPI_PATH = "packages/contracts/openapi.json";

/**
 * getOpenAPIDocument() only walks the mounted route definitions, so the dependencies may be inert: no database
 * is opened and no token is verified. Throwing stubs make an accidental runtime call loud rather than silent.
 */
export function buildOpenApiDocument(): ReturnType<ReturnType<typeof createApp>["getOpenAPIDocument"]> {
  const app = createApp({
    db: null as unknown as Sql,
    jobs: { enqueue: () => { throw new Error("the OpenAPI generator runs no jobs"); } },
    logger: createLogger({ sink: () => {} }),
    authAdmin: new StubAuthAdmin(),
    verifier: () => { throw new Error("the OpenAPI generator verifies no tokens"); },
  });
  return app.getOpenAPIDocument({
    openapi: "3.1.0",
    info: { title: "Dulja API", version: "1", description: "Accounting, inventory, HR/payroll and POS. Errors are RFC 9457 application/problem+json (ADR-0003)." },
    servers: [{ url: "/", description: "Behind the Cloudflare edge Worker; the container has no public ingress (spec:1157)" }],
  });
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  writeFileSync(join(root, OPENAPI_PATH), `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${OPENAPI_PATH}\n`);
}
```

- [ ] **Step 4: Document the `Idempotency-Key` header on every unsafe operation**

`@hono/zod-openapi` documents only what a route's `request` declares, so add the header to each unsafe `createRoute` call written in Tasks 8–10. Declare it once, and **in a leaf module of its own** — `apps/api/src/routes/idempotency-header.ts`:

```ts
// apps/api/src/routes/idempotency-header.ts
import { z } from "@hono/zod-openapi";

/**
 * spec:2055 — required on POST/PUT/PATCH/DELETE. Declared here so every unsafe route documents it identically.
 *
 * WHY ITS OWN MODULE, and not `routes/index.ts` where the registry lives. `index.ts` imports every route module
 * (`./health`, `./session`, `./admin/users`, `./admin/roles`, `./admin/role-assignments`, `./companies`,
 * `./admin/audit-log`), and each of those route modules calls `createRoute({ … request: { headers:
 * IdempotencyHeader } })` at MODULE TOP LEVEL. Declaring `IdempotencyHeader` as a `const` in `index.ts`'s own
 * body would close an import cycle across a temporal dead zone: ESM evaluates a module's dependencies before
 * its body, so `admin/roles.ts` would evaluate — and dereference `IdempotencyHeader` — while `index.ts`'s body
 * had not yet run, and the API would fail to boot with `ReferenceError: Cannot access 'IdempotencyHeader'
 * before initialization`. This file imports nothing from `apps/api`, so it is a leaf: it is fully evaluated
 * before any route module's body runs, whichever module the process enters first.
 */
export const IdempotencyHeader = z.object({
  "Idempotency-Key": z.string().max(200).openapi({ description: "Idempotency key; a replay returns the stored response with Idempotency-Replayed: true", example: "0192f000-0000-7000-8000-000000000001" }),
});
```

Re-export it from `apps/api/src/routes/index.ts` so the name is reachable at the module contracts §4.2.7 registers, which is where 0D, 2A and 2C import it from. The line goes **first**, above `import { healthRoutes } from "./health";` and every other route import, because `export … from` is also an import edge and ESM evaluates a module's dependencies in source order: putting it first guarantees `idempotency-header.ts` is evaluated before the first route module, so even `import { IdempotencyHeader } from "../index"` resolves to an initialised binding under the cycle. A re-export is an *indirect* binding — it resolves at link time straight to the declaration in the leaf module — so both import paths yield one `z.object`, not two.

```ts
// apps/api/src/routes/index.ts — the FIRST line of the module, before the route imports
export { IdempotencyHeader } from "./idempotency-header";
```

Then add `headers: IdempotencyHeader` to the `request` object of every `post`, `put`, `patch` and `delete` route in `apps/api/src/routes/admin/users.ts`, `roles.ts`, `role-assignments.ts` and `apps/api/src/routes/companies.ts` — **ten** operations: users `POST /` and `POST /{userId}/expire`; roles `POST /`, `PATCH /{roleId}` and `PUT /{roleId}/permissions`; role-assignments `POST /`, `PUT /{principalId}/{roleId}/branches` and `DELETE /{principalId}/{roleId}`; companies `POST /` and `PATCH /{companyId}`. Each of the four files gains the import from the **leaf module, never from `../index`** — `apps/api/src/routes/companies.ts` gains

```ts
import { IdempotencyHeader } from "./idempotency-header";
```

and each of the three under `apps/api/src/routes/admin/` gains

```ts
import { IdempotencyHeader } from "../idempotency-header";
```

Step 1's test enumerates the document rather than this list, so it catches a miss either way; and Step 5's `openapi:generate` is the boot that would have thrown the `ReferenceError`, so a regression to the `index.ts` declaration fails this task's own step rather than a later slice's.

- [ ] **Step 5: Generate, run the test, and wire CI**

```bash
bun run --cwd apps/api openapi:generate
bun run --cwd apps/api test -- test/openapi.test.ts
```
Expected: `wrote packages/contracts/openapi.json`, then PASS (3 tests).

Add to `.github/workflows/ci.yml`, after the `bun run test` step:

```yaml
      - name: OpenAPI document is up to date
        run: |
          bun run --cwd apps/api openapi:generate
          git diff --exit-code -- packages/contracts/openapi.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/contracts/openapi.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(api): generate, commit and CI-diff the OpenAPI document [0B T11]

The generator lives in apps/api because packages/contracts may not import an app;
the package's openapi:generate script shells out to it. Every unsafe operation
documents the Idempotency-Key header.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `scripts/lint/` — the five custom rules and `bun run lint:rules` (acceptance test 27)

Five source-level rules that make the house rules mechanical. They read TypeScript text, not an AST library, because each pattern is line-anchored and a regex rule that reports `<file>:<line>` is what CI needs.

**Files:**
- Create: `scripts/lint/types.ts`, `scripts/lint/run.ts`, `scripts/lint/rules/no-bare-db.ts`, `no-sql-concat.ts`, `dependency-rule.ts`, `forbidden-log-fields.ts`, `error-codes.ts`
- Modify: root `package.json` (`lint:rules`), `.github/workflows/ci.yml`
- Test: `scripts/lint/lint.test.ts`

**Interfaces:**
- Consumes: `ERRORS` from `@dulja/contracts` (Task 3).
- Produces: `export interface SourceFile { path: string; text: string; lines: string[] }`, `export interface LintViolation { file: string; line: number; rule: string; detail: string }`, `export interface LintRule { name: string; run(files: SourceFile[]): LintViolation[] }`; `bun run lint:rules` printing `<file>:<line> <rule> <detail>` and exiting 1 on any violation (contracts §3.7.5).

- [ ] **Step 1: Write the failing test**

`scripts/lint/lint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SourceFile } from "./types";
import { rule as dependencyRule } from "./rules/dependency-rule";
import { rule as errorCodes } from "./rules/error-codes";
import { rule as forbiddenLogFields } from "./rules/forbidden-log-fields";
import { rule as noBareDb } from "./rules/no-bare-db";
import { rule as noSqlConcat } from "./rules/no-sql-concat";

const file = (path: string, text: string): SourceFile => ({ path, text, lines: text.split("\n") });

describe("scripts/lint — the mechanical half of spec §0.2 (acceptance test 27)", () => {
  it("no-bare-db: only `tx` may tag SQL outside the allow-list", () => {
    // Lines 4 and 5 are the TYPED forms the codebase actually writes; a rule that only matched a bare
    // backtick after the identifier would pass them silently and enforce nothing (spec:2053).
    const bad = file("apps/api/src/routes/x.ts",
      "const rows = await db`select 1`;\nawait sql`select 2`;\nawait db.begin(fn);\n" +
      "const typed = await sql<{ n: number }[]>`select 3`;\nconst m = await db.admin<{ n: number }[]>`select 4`;");
    expect(noBareDb.run([bad]).map((v) => v.line)).toEqual([1, 2, 3, 4, 5]);
    expect(noBareDb.run([file("apps/api/src/routes/y.ts", "await tx`select 1`;")])).toEqual([]);
    expect(noBareDb.run([file("apps/api/src/routes/y2.ts", "await tx<{ n: number }[]>`select 1`;")])).toEqual([]);
    expect(noBareDb.run([file("packages/db/src/with-tenant.ts", "await sql`select 1`;")])).toEqual([]);
    expect(noBareDb.run([file("packages/db/src/lint-schema.ts", "await sql<TableRow[]>`select relname from pg_class`;")])).toEqual([]);
    expect(noBareDb.run([file("apps/api/test/support/app.ts", "createApp({ db: rw });")])).toEqual([]);
  });

  it("no-sql-concat: a non-literal .unsafe( argument, or SQL built by concatenation", () => {
    const bad = file("apps/api/src/routes/x.ts",
      'await tx.unsafe("select * from " + table);\nconst q = `select * from ${t} where id = ${id}`;');
    expect(noSqlConcat.run([bad]).map((v) => v.line)).toEqual([1, 2]);
    expect(noSqlConcat.run([file("packages/db/src/migrate.ts", "await tx.unsafe(fileContents);")])).toEqual([]);
    // Plan 0A's harness reads packages/db/roles.sql from disk (plan0A:476) — a checked-in .sql file is code, not
    // input, and both 0A sites are on UNSAFE_ALLOW. Without the entry this one line fails `lint:rules` on a tree
    // that has changed nothing, which is the whole reason the allow-list grew.
    expect(noSqlConcat.run([file("packages/db/test/harness.ts", 'await admin.unsafe(readFileSync(ROLES_SQL, "utf8"));')])).toEqual([]);
    // The SAME call from a file that is not allow-listed is still a violation — the entries are paths, not a
    // blanket exemption for the `readFileSync` shape.
    expect(noSqlConcat.run([file("apps/api/src/routes/x2.ts", 'await tx.unsafe(readFileSync(p, "utf8"));')]).map((v) => v.line)).toEqual([1]);
    // A TYPED tag is still a tag — `tx<Row[]>`…`` and `db.admin<Row[]>`…`` bind their interpolations as
    // parameters, so this rule is silent on both; which tag is allowed at all is no-bare-db's question.
    expect(noSqlConcat.run([file("apps/api/src/routes/y.ts",
      "const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${companyId}) as ok`;")])).toEqual([]);
    expect(noSqlConcat.run([file("apps/api/test/routes/y.test.ts",
      "const [n] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.company where id = ${id}`;")])).toEqual([]);
    // A template nested inside a tagged one is a value, not a statement, and carries no SQL keyword of its own.
    expect(noSqlConcat.run([file("apps/api/test/routes/z.test.ts",
      "await tx`insert into app.role (id, code) values (${roleId}, ${`r-${code}`})`;")])).toEqual([]);
  });

  it("dependency-rule: the tiers of spec:2389 and the domain → payroll prohibition of spec:2366", () => {
    expect(dependencyRule.run([file("packages/domain/src/money/money.ts", 'import { x } from "@dulja/db";')])).toHaveLength(1);
    expect(dependencyRule.run([file("apps/api/src/app.ts", 'import { x } from "../../worker/src/handler";')])).toHaveLength(1);
    expect(dependencyRule.run([file("packages/domain/src/posting/evaluate.ts", 'import { x } from "../../payroll/calculator";')])).toHaveLength(1);
    expect(dependencyRule.run([file("packages/db/src/client.ts", 'import { x } from "@dulja/domain";')])).toEqual([]);
    expect(dependencyRule.run([file("packages/domain/payroll/calculator.ts", 'import { x } from "../src/money/money";')])).toEqual([]);
    // A subpath export of an allowed package is allowed: the tier list names packages, not entry points.
    expect(dependencyRule.run([file("apps/api/src/middleware/require-permission.ts", 'import { PERMISSION } from "@dulja/contracts/permissions";')])).toEqual([]);
    expect(dependencyRule.run([file("apps/api/test/support/app.ts", 'import { startDb } from "@dulja/db/test";')])).toEqual([]);
    expect(dependencyRule.run([file("packages/contracts/src/x.ts", 'import { y } from "@dulja/db/test";')])).toHaveLength(1);
    // The ONE named allowance in the rule's ALLOW set. Contracts §3.6.3 freezes this path for the
    // both-directions catalogue check, which cannot be written without the seeded table and the exported
    // catalogue in the same file; `packages/db`'s tier is ["@dulja/domain"], so without the entry the
    // contract-mandated test is itself a lint violation.
    expect(dependencyRule.run([file("packages/db/test/permission-catalogue.test.ts", 'import { PERMISSIONS } from "@dulja/contracts/permissions";')])).toEqual([]);
    // …and it is a named file, not a directory carve-out: any OTHER file, in the same directory, still violates.
    expect(dependencyRule.run([file("packages/db/test/other.test.ts", 'import { PERMISSIONS } from "@dulja/contracts/permissions";')])).toHaveLength(1);
    // A relative import that stays inside its own workspace is fine — including test → src, which every
    // apps/*/test/support module makes.
    expect(dependencyRule.run([file("apps/api/test/support/app.ts", 'import { createApp } from "../../src/app";')])).toEqual([]);
    expect(dependencyRule.run([file("packages/contracts/src/admin/company.ts", 'import { z } from "../common";')])).toEqual([]);
    // ESCAPE_ALLOW — contracts §4.17.1's one-way door. `apps/api/test/**` and `apps/worker/test/**` reach the
    // root test tier's shared helpers by relative path; `grantAdmin` is registered in `tests/support/api.ts`,
    // `postJournal` in `tests/invariants/support/post-journal.ts`, and 0D, 2A and 2C all write the first string
    // verbatim. Without these entries every route test in those slices is a lint violation.
    expect(dependencyRule.run([file("apps/api/test/routes/admin/x.test.ts", 'import { grantAdmin } from "../../../../../tests/support/api";')])).toEqual([]);
    expect(dependencyRule.run([file("apps/worker/test/jobs/y.test.ts", 'import { postJournal } from "../../../../tests/invariants/support/post-journal";')])).toEqual([]);
    // …and the door is one-way and narrow. Production code may not import the test tier, and the allowance
    // does not license `apps/api/test/**` to reach another app.
    expect(dependencyRule.run([file("apps/api/src/routes/x.ts", 'import { grantAdmin } from "../../../../tests/support/api";')])).toHaveLength(1);
    expect(dependencyRule.run([file("apps/api/test/routes/z.test.ts", 'import { h } from "../../../worker/src/handler";')])).toHaveLength(1);
  });

  it("forbidden-log-fields: a logger call whose object names a secret", () => {
    const bad = file("apps/api/src/routes/x.ts", 'logger.info({ authorization: h }, "hi");\nlog.warn({ card_number: n }, "hi");');
    expect(forbiddenLogFields.run([bad]).map((v) => v.line)).toEqual([1, 2]);
    expect(forbiddenLogFields.run([file("apps/api/src/routes/y.ts", 'logger.info({ tenant_id: t }, "hi");')])).toEqual([]);
  });

  it("error-codes: a code in ERRORS with no raise site anywhere (spec:2051)", () => {
    const withSites = [
      // Only the ERRORS literal is excised. A raise elsewhere in the SAME file — fromDatabaseError, the sole
      // raiser of ERR_RLS_DENIED — still counts, which is the whole point of excising the literal, not the file.
      file("packages/contracts/src/errors.ts",
        "export const ERRORS = {\n  ERR_NOT_FOUND: {}, ERR_INTERNAL: {}, ERR_RLS_DENIED: {},\n" +
        "} as const satisfies Record<string, ErrorDef>;\n" +
        'export function fromDatabaseError(e: unknown) { return new AppError("ERR_RLS_DENIED", String(e)); }'),
      file("apps/api/src/x.ts", 'throw new AppError("ERR_NOT_FOUND", "x");'),
    ];
    const missing = errorCodes.run(withSites).map((v) => v.detail);
    expect(missing.some((d) => d.includes("ERR_INTERNAL"))).toBe(true);      // only inside the excised literal
    expect(missing.some((d) => d.includes("ERR_NOT_FOUND"))).toBe(false);    // raised in another file
    expect(missing.some((d) => d.includes("ERR_RLS_DENIED"))).toBe(false);   // raised in the registry file itself
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run scripts/lint/lint.test.ts`
Expected: FAIL — `Cannot find module './types'`.

- [ ] **Step 3: Write `scripts/lint/types.ts` and `scripts/lint/run.ts`**

```ts
// scripts/lint/types.ts
export interface SourceFile { path: string; text: string; lines: string[] }
export interface LintViolation { file: string; line: number; rule: string; detail: string }
export interface LintRule { name: string; run(files: SourceFile[]): LintViolation[] }
```

```ts
// scripts/lint/run.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { LintRule, LintViolation, SourceFile } from "./types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOTS = ["apps", "packages", "scripts"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".drizzle", "openapi.json"]);

function collect(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { collect(full, out); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    out.push({ path: relative(ROOT, full).replaceAll("\\", "/"), text, lines: text.split("\n") });
  }
}

const files: SourceFile[] = [];
for (const r of ROOTS) collect(join(ROOT, r), files);

const rules: LintRule[] = [];
for (const entry of readdirSync(join(ROOT, "scripts", "lint", "rules")).sort()) {
  if (!entry.endsWith(".ts")) continue;
  const mod = (await import(`./rules/${entry}`)) as { rule: LintRule };
  rules.push(mod.rule);
}

const violations: LintViolation[] = rules.flatMap((r) => r.run(files));
for (const v of violations) process.stdout.write(`${v.file}:${v.line} ${v.rule} ${v.detail}\n`);
process.stdout.write(`${rules.length} rules, ${files.length} files, ${violations.length} violations\n`);
process.exit(violations.length > 0 ? 1 : 0);
```

- [ ] **Step 4: Write the five rules**

`scripts/lint/rules/no-bare-db.ts`:

```ts
import type { LintRule, LintViolation } from "../types";

/** spec:2053: "A lint rule forbids bare `db.` calls." Only a `tx` obtained from withTenant may tag SQL. */
const ALLOW = [
  "packages/db/src/migrate.ts", "packages/db/src/with-tenant.ts", "packages/db/src/client.ts",
  "packages/db/src/jobs/enqueue.ts",
  // Plan 0A's schema linter reads the catalogue with a `sql`-tagged template (plan0A:2716–2730). It runs before
  // any tenant exists and reads no tenant-scoped table, so withTenant would be meaningless there. Contracts
  // §3.7.5 predates the file; header assumption 8 records the addition. `packages/db/src/cli.ts` is NOT listed:
  // it only calls `postgres(url)` and `sql.end()`, neither of which this rule matches.
  "packages/db/src/lint-schema.ts",
];
const ALLOW_DIR = [/^packages\/db\/test\//, /^apps\/[a-z-]+\/test\//, /^scripts\/lint\//];
/**
 * `(?:<[^`]*>)?` is the optional generic argument list between the identifier and the backtick, or between the
 * member name and the call. Every postgres.js query in this codebase is written ``sql<Row[]>`…` `` or
 * ``db.admin<Row[]>`…` ``; a pattern demanding the backtick immediately after the identifier matches none of
 * them, which would make spec:2053's guarantee a no-op for the only idiom anyone writes (plan0A:2716–2730).
 */
const TAGGED = /(^|[^.\w])(db|sql)(?:<[^`]*>)?`/;
const MEMBER = /(^|[^.\w])db\.\w+(?:<[^`]*>)?\s*[(`]/;

export const rule: LintRule = {
  name: "no-bare-db",
  run(files) {
    const out: LintViolation[] = [];
    for (const f of files) {
      if (!/^(apps|packages)\//.test(f.path)) continue;
      if (ALLOW.includes(f.path) || ALLOW_DIR.some((d) => d.test(f.path))) continue;
      if (/^packages\/[a-z-]+\/(?!src\/)/.test(f.path)) continue;      // only src/ of a package is in scope
      f.lines.forEach((line, i) => {
        if (TAGGED.test(line)) out.push({ file: f.path, line: i + 1, rule: this.name, detail: "SQL tagged by `db` or `sql`; only a `tx` from withTenant may tag SQL (spec:2053)" });
        else if (MEMBER.test(line)) out.push({ file: f.path, line: i + 1, rule: this.name, detail: "a method called on `db`; open a transaction with withTenant instead (spec:2053)" });
      });
    }
    return out;
  },
};
```

`scripts/lint/rules/no-sql-concat.ts`:

```ts
import type { LintRule, LintViolation } from "../types";

/** spec:100 and acceptance test 27: SQL is never built by concatenation. `sql.unsafe` has a closed list of homes. */
const UNSAFE_ALLOW = [
  // The three contracts §3.3 names: the migration runner, the pg-boss transactional-enqueue adapter, and the
  // importer's Firebird reader (9A — the entry is a permission, not an obligation; the file does not exist yet).
  "packages/db/src/migrate.ts", "packages/db/src/jobs/enqueue.ts", "packages/importer/src/reader.ts",
  // Plan 0A, which predates §3.3's "exactly three places" and is immovable: its harness applies
  // `packages/db/roles.sql` with `await admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` (plan0A:476) and its
  // roles suite re-applies the same file to prove idempotence (plan0A:553). A checked-in .sql file read from
  // disk is code, not input — the identical case to migrate.ts — and neither file is reachable from a request.
  // Without these two entries `bun run lint:rules` reports two violations on a tree that has changed nothing,
  // and Step 6, Task 14's `legacy-036` and Task 15's final gate all fail. Contracts §3.3 is owed the amendment.
  "packages/db/test/harness.ts", "packages/db/test/roles.test.ts",
];
/** A SQL keyword, but never a method call: `.update(`, `.delete(` and `.select(` are JavaScript, not SQL. */
const KEYWORDS = /(^|[^.\w])(select|insert|update|delete|where|from|order by)\b/i;
/**
 * An UNTAGGED template literal — the opening backtick is preceded by neither an identifier character, nor `>`
 * (the close of a generic argument list, as in ``tx<{ ok: boolean }[]>`…` ``), nor `)` or `]`. Deciding WHICH
 * tag may carry SQL is `no-bare-db`'s job; this rule asks only whether a statement was assembled outside a
 * tagged template at all, because a tagged template binds its interpolations as parameters while a bare one
 * splices them in as text. Matching the tag name instead would miss every typed query the codebase writes.
 */
const UNTAGGED_TEMPLATE = /(?:^|[^A-Za-z0-9_$)\]>])`([^`]*)`/g;
const CONCAT = /["'][^"']*\b(select|from|where)\b[^"']*["']\s*\+/i;

export const rule: LintRule = {
  name: "no-sql-concat",
  run(files) {
    const out: LintViolation[] = [];
    for (const f of files) {
      if (!/^(apps|packages)\//.test(f.path)) continue;
      f.lines.forEach((line, i) => {
        const unsafe = /\.unsafe\(\s*([^)]*)\)/.exec(line);
        if (unsafe && !UNSAFE_ALLOW.includes(f.path) && !/^\s*["'`]/.test(unsafe[1] ?? "")) {
          out.push({ file: f.path, line: i + 1, rule: this.name, detail: ".unsafe() with a non-literal argument outside UNSAFE_ALLOW (contracts §3.3)" });
        }
        // A bare template literal, or a `+` chain, whose OWN text carries SQL keywords and an interpolation.
        let built = CONCAT.test(line);
        UNTAGGED_TEMPLATE.lastIndex = 0;
        for (let m = UNTAGGED_TEMPLATE.exec(line); m !== null && !built; m = UNTAGGED_TEMPLATE.exec(line)) {
          const body = m[1] ?? "";
          built = body.includes("${") && KEYWORDS.test(body);
        }
        if (built) {
          out.push({ file: f.path, line: i + 1, rule: this.name, detail: "SQL assembled from a string; use a `tx` tagged template with bound values (LEGACY-036, 037)" });
        }
      });
    }
    return out;
  },
};
```

`scripts/lint/rules/dependency-rule.ts`:

```ts
import type { LintRule, LintViolation } from "../types";

/** spec:2389 verbatim, plus the intra-package rule of spec:2366 ("core never imports HR"). */
const TIER: Record<string, readonly string[]> = {
  "packages/domain":    [],
  "packages/i18n":      [],
  "packages/db":        ["@dulja/domain"],
  "packages/contracts": ["@dulja/domain"],
  "packages/sync":      ["@dulja/domain", "@dulja/contracts"],
  "packages/ui":        ["@dulja/i18n"],
  "packages/importer":  ["@dulja/domain", "@dulja/db", "@dulja/contracts"],
  "apps/api":           ["@dulja/domain", "@dulja/db", "@dulja/contracts", "@dulja/sync"],
  "apps/worker":        ["@dulja/domain", "@dulja/db", "@dulja/contracts", "@dulja/sync"],
  "apps/edge":          ["@dulja/contracts"],
  "apps/pos":           ["@dulja/domain", "@dulja/contracts", "@dulja/sync", "@dulja/ui", "@dulja/i18n"],
  "apps/backoffice":    ["@dulja/domain", "@dulja/contracts", "@dulja/ui", "@dulja/i18n"],
  "apps/desktop":       [],
  // No `tests` row: `run.ts` walks apps, packages and scripts only, so a row keyed on `tests/` could never
  // match and a dead row invites a later slice to trust a check that never ran. The `tests` tier's one rule —
  // it reaches apps/api through the package entry `@dulja/api`, never a route file — is enforced by review and
  // by contracts §3.1, and `tests/support/ledger.ts` is outside every lint root for the same reason (T14).
};
const IMPORT = /^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/;

/**
 * Named allowances for the cross-package tier check, each carrying its reason on the line — the mechanism
 * contracts §4.17.1 already describes for the `apps/*/test/**` → `tests/invariants/support/**` imports 1B and
 * later slices make. The key is `<file path>|<package root>`: ONE file, ONE package. A blanket
 * `packages/*/test/**` carve-out is deliberately not taken — under it `packages/domain/test/x.test.ts`
 * importing `@dulja/db` would pass silently, and that is exactly the architecture bug spec:2389 exists to
 * catch. A later slice that must add a cross-package import under a package's `test/` directory adds a line
 * here, with its reason, in the same PR.
 */
const ALLOW = new Set([
  // contracts §3.6.3 freezes this path for the both-directions catalogue check, and the check cannot be written
  // without both halves in one file: the seeded `app.permission` rows (packages/db) and the exported catalogue
  // (@dulja/contracts). Test-only — `packages/db/src/**` still may not reach @dulja/contracts, which is what
  // keeps the runtime import graph of spec:2389 intact. Owed to contracts §3.7.5 / §3.1 as an amendment.
  "packages/db/test/permission-catalogue.test.ts|@dulja/contracts",
]);

/**
 * Named allowances for the OTHER half of this rule — the relative-path escape check below. Contracts §4.17.1
 * closes with: "Two files outside the `tests` workspace import from `tests/…` — `apps/worker/test/**` and
 * `apps/api/test/**` — through named allowances on `scripts/lint/rules/dependency-rule.ts`, each carrying its
 * reason on the line". `ALLOW` above cannot serve them: it is keyed on a `@dulja/*` package root, and these
 * imports are relative (`import { grantAdmin } from "../../../../../tests/support/api";`), so they trip the
 * escape check, not the tier check.
 *
 * `to` is a PREFIX of the RESOLVED path, not of the specifier — the specifier is five `..` segments and names
 * no directory the eye can match on. §4.17.1's own sentence says `tests/invariants/support/**`, but the table
 * directly above it registers `grantAdmin`, `problemOf`, `sharedApi` and `fullRegression` in
 * **`tests/support/api.ts`** and `postJournal` in `tests/invariants/support/post-journal.ts`, so both roots are
 * listed here; 0D, 2A and 2C all import `grantAdmin` by that exact string. Nothing wider is taken: an
 * `apps/api/src/**` file reaching `tests/` is still a violation (production code may not import a test tier),
 * and so is `apps/api/test/**` reaching `apps/worker/`. The direction is one-way and adds no `package.json`
 * dependency — §4.17.1 forbids that, because it would close a cycle in the workspace graph turbo walks.
 */
const ESCAPE_ALLOW: readonly { readonly from: RegExp; readonly to: string; readonly why: string }[] = [
  { from: /^apps\/api\/test\//,    to: "tests/support/",            why: "grantAdmin/problemOf — the one way a route test grants (contracts §4.17.1)" },
  { from: /^apps\/api\/test\//,    to: "tests/invariants/support/", why: "postJournal — from 1A onward the only way a test creates ledger rows (§4.17.1)" },
  { from: /^apps\/worker\/test\//, to: "tests/support/",            why: "the worker's route-test twin of the same grant (§4.17.1)" },
  { from: /^apps\/worker\/test\//, to: "tests/invariants/support/", why: "postJournal, for the job handlers that post (§4.17.1)" },
];

/**
 * Resolve a relative specifier against the importing file's directory, normalising `..`. A pattern match on the
 * text cannot do this job: from `apps/api/src/app.ts`, reaching the worker is `"../../worker/src/handler"` — it
 * never contains the substring `../apps/`. Resolving and then asking whether the result is still under the
 * owner's own workspace catches every escape and no legitimate intra-package import.
 */
function resolveRelative(fromPath: string, spec: string): string {
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export const rule: LintRule = {
  name: "dependency-rule",
  run(files) {
    const out: LintViolation[] = [];
    for (const f of files) {
      const owner = Object.keys(TIER).find((k) => f.path.startsWith(`${k}/`));
      if (!owner) continue;
      f.lines.forEach((line, i) => {
        const m = IMPORT.exec(line);
        if (!m) return;
        const spec = m[1]!;
        // Reduce to the package root before the membership test: `@dulja/contracts/permissions` and
        // `@dulja/db/test` are subpath exports of packages the tier already allows, and comparing the whole
        // specifier would report every one of them (spec:2389 is about packages, not about entry points).
        const pkg = spec.split("/").slice(0, 2).join("/");
        if (spec.startsWith("@dulja/") && !TIER[owner]!.includes(pkg) && !ALLOW.has(`${f.path}|${pkg}`)) {
          out.push({ file: f.path, line: i + 1, rule: this.name, detail: `${owner} may not import ${pkg} (spec:2389)` });
        }
        if (/^\.\.?\//.test(spec)) {
          const target = resolveRelative(f.path, spec);
          const allowed = ESCAPE_ALLOW.some((a) => a.from.test(f.path) && target.startsWith(a.to));
          if (!target.startsWith(`${owner}/`) && !allowed) {
            out.push({ file: f.path, line: i + 1, rule: this.name, detail: `${owner} reaches outside its own workspace by relative path (spec:2389)` });
          }
        }
        if (f.path.startsWith("packages/domain/src/") && /(^|\/)payroll\//.test(spec)) {
          out.push({ file: f.path, line: i + 1, rule: this.name, detail: "packages/domain/src may not import packages/domain/payroll — core never imports HR (spec:2366)" });
        }
      });
    }
    return out;
  },
};
```

`scripts/lint/rules/forbidden-log-fields.ts`:

```ts
import type { LintRule, LintViolation } from "../types";

/** spec:2063: "never a token, password, or full card number." The runtime twin lives in createLogger. */
const CALL = /\b(?:logger|log|c\.var\.logger)\.(?:debug|info|warn|error)\(\s*\{([^}]*)\}/;
const FORBIDDEN = /\b\w*(token|password|authorization|card|pin|secret)\w*\b/i;

export const rule: LintRule = {
  name: "forbidden-log-fields",
  run(files) {
    const out: LintViolation[] = [];
    for (const f of files) {
      if (!/^(apps|packages)\//.test(f.path)) continue;
      f.lines.forEach((line, i) => {
        const m = CALL.exec(line);
        if (!m) return;
        for (const key of m[1]!.split(",")) {
          const name = key.split(":")[0]?.trim() ?? "";
          if (name && FORBIDDEN.test(name)) {
            out.push({ file: f.path, line: i + 1, rule: this.name, detail: `log field ${JSON.stringify(name)} may carry a credential (spec:2063)` });
          }
        }
      });
    }
    return out;
  },
};
```

`scripts/lint/rules/error-codes.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERRORS } from "../../../packages/contracts/src/errors";
import type { LintRule, LintViolation } from "../types";

/**
 * spec:2051: "a code no code raises fails the build (the inverse of LEGACY-084)." Only the `ERRORS` OBJECT LITERAL
 * is excised, not the whole registry file: `fromDatabaseError` lives in that same file and is the only raiser of
 * ERR_RLS_DENIED, ERR_CONFLICT_UNIQUE and ERR_CONFLICT_REFERENCE, so excluding the file wholesale would leave
 * those three satisfied by nothing but assertion strings in test files — and deleting a test would then fail the
 * build for the wrong reason. DB-raised tokens count through the SQL text of packages/db/migrations/**, which
 * `run.ts` does not collect, so those are read here directly. Static imports, not `require`: every workspace is
 * `"type": "module"` and `scripts/lint/lint.test.ts` runs this rule under Vitest on Node 24, where `require` is
 * not defined in module scope.
 */
const REGISTRY = "packages/contracts/src/errors.ts";
const LITERAL_START = "export const ERRORS = {";
const LITERAL_END = "} as const satisfies Record<string, ErrorDef>;";
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "db", "migrations");

/** The file's text with the registry literal removed; every other line of that file still counts as a raise. */
function searchable(f: { path: string; text: string }): string {
  if (f.path !== REGISTRY) return f.text;
  const start = f.text.indexOf(LITERAL_START);
  const end = start === -1 ? -1 : f.text.indexOf(LITERAL_END, start);
  // Fail closed: if the literal has been reshaped, drop the whole file rather than let it satisfy every code.
  if (start === -1 || end === -1) return "";
  return f.text.slice(0, start) + f.text.slice(end + LITERAL_END.length);
}

export const rule: LintRule = {
  name: "error-codes",
  run(files) {
    const haystack = `${files.map(searchable).join("\n")}\n${migrationText()}`;
    return Object.keys(ERRORS)
      .filter((code) => !haystack.includes(code))
      .map((code): LintViolation => ({
        file: REGISTRY, line: 1, rule: "error-codes",
        detail: `${code} is in ERRORS but nothing raises it — remove it or raise it (spec:2051)`,
      }));
  },
};

function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}
```

- [ ] **Step 5: Wire the script and CI**

Root `package.json` scripts gain `"lint:rules": "bun run scripts/lint/run.ts"`. **The `workspaces` array is not touched here.** `"tests"` joins it in **Task 13 Step 1**, in the same commit that creates `tests/package.json`, so no commit in this repository ever names a workspace directory that has no manifest — Step 6 below runs `bun run lint:rules` between the two commits, and a literal `workspaces` entry pointing at a manifest-less directory is a window this plan has no reason to open.

`.github/workflows/ci.yml`, after `bun run lint`:

```yaml
      - run: bun run lint:rules
```

- [ ] **Step 6: Run everything and fix what the rules find**

Run: `node node_modules/vitest/vitest.mjs run scripts/lint/lint.test.ts` then `bun run lint:rules`
Expected: the unit test PASSES (5 tests — cases were added inside the existing five `it` blocks, not as new ones); `lint:rules` prints `5 rules, N files, 0 violations` and exits 0. **Two of those zeroes are bought by allow-list entries, and both are Plan 0A files this slice may not edit:** `dependency-rule`'s `ALLOW` carries `packages/db/test/permission-catalogue.test.ts|@dulja/contracts` (the path contracts §3.6.3 freezes for the catalogue check), and `no-sql-concat`'s `UNSAFE_ALLOW` carries `packages/db/test/harness.ts` and `packages/db/test/roles.test.ts` (both apply `packages/db/roles.sql` with `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))`, plan0A:476 and 553). If either entry is dropped, this step reports violations in files nothing in this slice changed. **`dependency-rule`'s third allowance set, `ESCAPE_ALLOW`, matches nothing in this slice's tree and is still required here**: contracts §4.17.1 puts the named allowances for `apps/api/test/**` and `apps/worker/test/**` → the root test tier on this file, and no 0B file makes that import, so it is Step 1's four unit cases — not this run — that prove it works. It is written now because 0D, 2A and 2C each import `grantAdmin` from `tests/support/api.ts` by relative path and none of them owns this rule; without it their first route test fails `lint:rules`. The other half of §4.17.1's mechanism — an `include` entry in the consuming workspace's `tsconfig.json` — is **not** added to `apps/api/tsconfig.json` here: Task 4 writes that file before `tests/` exists (Task 13), so the slice whose test first makes the import adds the `include` in the same PR as the import. If `error-codes` names a code, either the raiser was not written or the code does not belong in `ERRORS` yet — all twenty-five have raisers after Tasks 2–10 (`ERR_ROUTE_GATE_READONLY` in `assertRouteGates`, `ERR_NOT_FOUND` in the handlers, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE` and `ERR_CONFLICT_REFERENCE` in `fromDatabaseError` — which sits in the registry file but outside the excised `ERRORS` literal, so the rule counts it — the eight DB tokens in `0001_foundations.sql`, `ERR_PERIOD_NOT_OPEN` and `ERR_LEDGER_UNBALANCED` likewise).

- [ ] **Step 7: Commit**

```bash
git add scripts/lint package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
chore(ci): five custom lint rules and bun run lint:rules [0B T12]

no-bare-db, no-sql-concat (acceptance test 27), dependency-rule, forbidden-log-fields
and error-codes. Each prints <file>:<line> <rule> <detail> and CI exits 1 on any.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 13: the root `tests/` workspace, the probe registry, and the two invariant suites (acceptance tests 11 and 12)

**This task and Task 14 have no red step, and the omission is deliberate.** Every other task in this plan writes a failing test, runs it to see the exact stated failure, implements, then runs it green. Tasks 13 and 14 author tests over behaviour Tasks 1–12 have already shipped and green: the only failure a pre-write run could produce is `Cannot find module "./support/regression"`, which proves nothing about the assertion being written. Red-first is preserved where it carries information — Step 3's coverage gate fails the build when a `ROUTES` entry has no `PROBES` entry, and Step 6's run is where an assertion that does not hold shows up.

**Files:**
- Create: `tests/package.json`, `tests/tsconfig.json`, `tests/vitest.config.ts`, `tests/support/regression.ts`, `tests/invariants/probes.ts`, `tests/invariants/tenant-isolation.test.ts`, `tests/invariants/auth-bypass.test.ts`, `tests/golden/.gitkeep`, `tests/e2e/.gitkeep`, `tests/regression/.gitkeep`
- Modify: root `package.json` (`workspaces` gains `"tests"` — Task 12 deliberately left it alone so no commit names a manifest-less workspace), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `ROUTES`, `RouteModule`, `createApp` from `apps/api` **through its package entry only** (`@dulja/api`, never a route file — contracts §3.1); `JOBS` from `@dulja/db`; `startDb`, `seedTenant`, `draftDocument`, `uuidv7`, `Db`, `Seed` from `@dulja/db/test`; `withTenant` (production) from `@dulja/db`; `startApi`, `ApiRequest` from `apps/api/test/support/app`.
- Produces: `export const PROBES: Readonly<Record<string, IsolationProbe>>` keyed by `RouteModule.path` and `export interface IsolationProbe` (contracts §4.2.7); `export function sharedDb(): Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }>`, `export interface ThinContext` and `export function thinRegression(legacyDefect: string, heading: string, cites: string, body: (ctx: ThinContext) => Promise<void>): void` — all four consumed by Task 14.

- [ ] **Step 1: Scaffold the workspace**

`tests/package.json`:

```json
{
  "name": "@dulja/tests",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../node_modules/vitest/vitest.mjs run",
    "test:e2e": "playwright test"
  }
}
```

In root `package.json`, change `workspaces` to `["packages/*", "apps/*", "tests"]` (contracts §3.1 — turbo's `test` pipeline only sees workspace packages, so `tests/` must be one). It lands here rather than in Task 12 because `tests/package.json` is created in this same step and committed in this same commit: at no point does the array name a directory with no manifest.

`tests/tsconfig.json`: `{ "extends": "../tsconfig.base.json", "include": ["support", "invariants", "regression", "golden", "vitest.config.ts"] }`

`tests/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

/**
 * `fileParallelism: false` is the contracts §3.7.1 requirement. `isolate: false` with one thread is this slice's
 * addition: forty-five files at one Testcontainers start each is forty-five containers, so tests/support's
 * memoised startDb() is shared across the whole run. Ryuk reaps the container on exit locally; in CI
 * TESTCONTAINERS_RYUK_DISABLED is set and the runner is ephemeral (plan0A:2862).
 */
export default defineConfig({
  test: {
    include: ["invariants/**/*.test.ts", "regression/**/*.test.ts", "golden/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    isolate: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
```

`tests/golden/.gitkeep`, `tests/e2e/.gitkeep` and `tests/regression/.gitkeep` are empty files that keep the four directories §5.2 names in the tree from the first commit.

- [ ] **Step 2: Write `tests/support/regression.ts`**

```ts
import { describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createDb } from "@dulja/db";
import { seedTenant, startDb, type Db, type Seed } from "@dulja/db/test";
import type { Sql } from "postgres";

let started: Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }> | undefined;

/** One container for the whole `tests` run (see vitest.config.ts). `a` and `b` are two seeded tenants. */
export function sharedDb(): Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }> {
  started ??= (async () => {
    const db = await startDb();
    return { db, rw: createDb(db.url("app_rw")), a: await seedTenant(db, "Alpha"), b: await seedTenant(db, "Beta") };
  })();
  return started;
}

export interface ThinContext { db: Db; rw: Sql; a: Seed; b: Seed; withTenant: typeof withTenant; expect: typeof expect }

/**
 * The shape of every thin regression file (contracts §3.7.3): one `describe` naming the defect and the slice,
 * one `it` re-running the minimal scenario through the PRODUCTION withTenant — or, for a structural fact, over
 * information_schema / lintSchema — and citing the Plan 0A test that first proved it.
 */
export function thinRegression(
  legacyDefect: string, heading: string, cites: string, body: (ctx: ThinContext) => Promise<void>,
): void {
  describe(`${legacyDefect} ${heading} — 0B`, () => {
    it(`holds through the production API layer (first proven by ${cites})`, async () => {
      const ctx = await sharedDb();
      await body({ ...ctx, withTenant, expect });
    });
  });
}
```

- [ ] **Step 3: Write `tests/invariants/probes.ts`**

```ts
import { seedTenant, uuidv7, type Db, type Seed } from "@dulja/db/test";

/** contracts §4.2.7. The probe lives in the test tier because it uses Db and Seed; a production route module
 *  must not depend on Testcontainers (§3.1, ADR 0006). One entry per RouteModule.path, or the harness fails. */
export interface IsolationProbe {
  /** Seeds whatever the victim tenant owns and returns the request tenant A will make against tenant B's rows. */
  seed(db: Db, owner: Seed): Promise<{ path: string; method: string; body?: unknown }>;
  expect: 403 | 404;
}

export const PROBES: Readonly<Record<string, IsolationProbe>> = {
  "/healthz": {
    seed: () => Promise.resolve({ path: "/healthz", method: "GET" }),
    expect: 404,                                        // public and tenant-free: the harness skips its assertion
  },
  "/v1/session": {
    seed: () => Promise.resolve({ path: "/v1/session", method: "GET" }),
    expect: 404,                                        // tenant-free: answers about the CALLER, never a row
  },
  "/v1/admin/users": {
    seed: (_db, owner) => Promise.resolve({ path: `/v1/admin/users/${owner.human}/expire`, method: "POST", body: {} }),
    expect: 404,
  },
  "/v1/admin/roles": {
    seed: async (db, owner) => {
      const roleId = await uuidv7(db.admin);
      await db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${owner.tenant}, true), set_config('app.actor_id', ${owner.system}, true)`;
        await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${owner.tenant}, 'probe', 'Probe')`;
      });
      return { path: `/v1/admin/roles/${roleId}`, method: "PATCH", body: { nameEn: "Stolen" } };
    },
    expect: 404,
  },
  "/v1/companies": {
    seed: (_db, owner) => Promise.resolve({ path: `/v1/companies/${owner.company}`, method: "GET" }),
    expect: 404,                                        // GET /{companyId} is gated `{ company: "any" }`, so the
  },                                                    // handler runs and RLS — not the gate — answers (T10)
  "/v1/companies/:companyId/role-assignments": {
    seed: (_db, owner) => Promise.resolve({
      path: `/v1/companies/${owner.company}/role-assignments`, method: "POST",
      body: { principalId: owner.human, roleId: owner.hq },
    }),
    expect: 403,                                        // requirePermission refuses the company before any row is read
  },
  "/v1/admin/audit-log": {
    seed: (_db, owner) => Promise.resolve({ path: `/v1/admin/audit-log?actorId=${owner.human}&limit=100`, method: "GET" }),
    // This module's only route is a list, so the answer is 200 and the harness takes its 200 branch — `expect`
    // is not read here. 404 is the recorded value because a leak from this module could only be a row read.
    expect: 404,
  },
};

/** Paths whose answer is about the caller, not about a row, so "zero cross-tenant rows" is the only assertion. */
export const TENANT_FREE = new Set(["/healthz", "/v1/session"]);
```

- [ ] **Step 4: Write `tests/invariants/tenant-isolation.test.ts` (acceptance test 12)**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS } from "@dulja/db";
import { ROUTES } from "@dulja/api";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { PROBES, TENANT_FREE } from "./probes";

describe("acceptance test 12 — every endpoint and every job, cross-tenant, rejected at the data layer", () => {
  let api: StartedApi; let a: Seed; let b: Seed;

  const grantEverything = async (s: Seed): Promise<void> => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      const [role] = await tx<{ id: string }[]>`insert into app.role (tenant_id, code, name_en, is_system)
        values (${s.tenant}, 'admin', 'Administrator', true) returning id`;
      for (const code of ["admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read"]) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${role!.id}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${role!.id}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    await grantEverything(a); await grantEverything(b);
  });
  afterAll(async () => { await api.stop(); });

  it("every registered route has a probe, and every probe names a registered route (the build gate)", () => {
    const paths = ROUTES.map((r) => r.path).sort();
    expect(Object.keys(PROBES).sort()).toEqual(paths);
  });

  for (const route of ROUTES) {
    it(`${route.path} refuses tenant A acting on tenant B's rows`, async () => {
      const probe = PROBES[route.path]!;
      const req = await probe.seed(api.db, b);                        // B owns the row
      const before = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${b.tenant}`;
      const res = await api.request({ method: req.method as "GET", path: req.path, as: a.human, body: req.body });

      if (TENANT_FREE.has(route.path)) {
        expect([200, 401]).toContain(res.status);
      } else if (res.status === 200) {
        // A list endpoint answers 200 with none of B's rows — the RLS refusal is invisible, which is the point.
        const body = (await res.json()) as { items?: { id?: string; rowId?: string }[] };
        const ids = (body.items ?? []).flatMap((i) => [i.id, i.rowId]).filter(Boolean);
        expect(ids).not.toContain(b.company);
        expect(ids).not.toContain(b.human);
      } else {
        // The RECORDED value, not a set. A 403 where the probe says 404 means the gate refused before the
        // handler ran, so the caller learns "that id exists, just not for you" — exactly the leak `expect` was
        // put on IsolationProbe to catch (contracts §4.2.7). A loose `toContain` would hide it.
        expect(res.status, `${req.method} ${req.path}`).toBe(probe.expect);
      }

      const after = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.audit_log where tenant_id = ${b.tenant}`;
      expect(after[0]!.n, "no write reached the victim tenant").toBe(before[0]!.n);
    });
  }

  it("every job name is registered, and a payload naming another tenant is refused by systemContext", async () => {
    expect(Object.keys(JOBS).length).toBeGreaterThan(0);
    // 0B ships no handlers; the harness asserts the registry is enumerable so 0D's handlers inherit the loop.
    // Each handler resolves its context with systemContext(sql, job.tenantId, …), which can only ever produce
    // that tenant's own system principal — a payload naming tenant B under tenant A's envelope reads nothing.
    // Two or three dotted segments: the frozen registry holds `reporting.render` alongside the three-segment
    // names (contracts §4.2.6), so a three-segment assertion would fail on the registry this task ships.
    for (const name of Object.keys(JOBS)) expect(name).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/);
  });
});
```

`apps/api/package.json` must export `ROUTES` for the `@dulja/api` import above: change its `exports` to `{ ".": "./src/app.ts", "./routes": "./src/routes/index.ts" }` and re-export from `src/app.ts`: `export { ROUTES, buildRoutes, type RouteModule } from "./routes";`. **All three names, exactly as contracts §4.2.7 spells the entry point** — "`src/app.ts` re-exports `{ ROUTES, buildRoutes, type RouteModule }`" — and `buildRoutes` is the authoritative constructor (§4.18 round 1), so a later slice needing to build the registry with its own deps has the door it expects rather than reaching for a route file. The tests tier imports `@dulja/api` only through this entry, never a route file (contracts §3.1).

- [ ] **Step 5: Write `tests/invariants/auth-bypass.test.ts` (acceptance test 11)**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { createDb, resolvePrincipal } from "@dulja/db";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, TEST_ISSUER, type StartedApi } from "../../apps/api/test/support/app";

describe("acceptance test 11 — no parameter, header or stored procedure grants elevated privilege", () => {
  let api: StartedApi; let a: Seed; let b: Seed;

  /**
   * Both tenants' humans hold every admin code IN THEIR OWN TENANT. A bypass suite must fail for the bypass and
   * for nothing else: without a grant, `GET /v1/companies` answers 403 and a case that reads `.items` off the
   * body throws a TypeError instead of asserting anything. `seedTenant` creates no role (plan0A:1571–1600), so
   * the suite makes its own — the same shape `tenant-isolation.test.ts` uses.
   */
  const grantEverything = async (s: Seed): Promise<void> => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      const [role] = await tx<{ id: string }[]>`insert into app.role (tenant_id, code, name_en, is_system)
        values (${s.tenant}, 'admin', 'Administrator', true) returning id`;
      for (const code of ["admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read"]) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${role!.id}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${s.tenant}, ${s.human}, ${role!.id}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha"); b = await seedTenant(api.db, "Beta");
    await grantEverything(a); await grantEverything(b);
    await api.loadPrincipals();
  });
  afterAll(async () => { await api.stop(); });

  const code = async (res: Response) => ((await res.json()) as Problem).code;

  it("a forged X-Tenant-Id / X-Actor-Id is ignored (LEGACY-026)", async () => {
    const res = await api.request({ method: "GET", path: "/v1/session", as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human } });
    expect(await res.json()).toMatchObject({ tenantId: a.tenant, principalId: a.human });
  });

  it("aal1 on a non-exempt route is refused (spec:2004)", async () => {
    expect(await code(await api.request({ method: "GET", path: "/v1/companies", as: a.human, aal: "aal1" }))).toBe("ERR_AUTH_AAL_INSUFFICIENT");
  });

  it("an expired token, a wrong issuer and a foreign signature are all ERR_AUTH_TOKEN_INVALID and indistinguishable", async () => {
    const forged = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0.AAAA";
    // Expiry and issuer are the two shapes contracts §3.7.2 names that `tokenFor` cannot produce: it always
    // writes iss: TEST_ISSUER and exp: now + 600. `signToken` signs an arbitrary claim set with the same key.
    const now = Math.floor(Date.now() / 1000);
    const sub = `human:${a.tenant}`;                       // the seeded owner's real subject (plan0A:1586)
    for (const t of [forged, `${api.tokenFor(a.human)}tampered`, "Bearer",
      api.signToken({ sub, aal: "aal2", iss: TEST_ISSUER, iat: now - 3600, exp: now - 60 }),
      api.signToken({ sub, aal: "aal2", iss: "https://other.invalid/auth/v1", iat: now, exp: now + 600 })]) {
      const res = await api.request({ method: "GET", path: "/v1/session", headers: { Authorization: `Bearer ${t}` } });
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("ERR_AUTH_TOKEN_INVALID");
    }
  });

  it("a valid signature over a subject with no membership grants nothing (LEGACY-025, 043)", async () => {
    expect(await code(await api.request({ method: "GET", path: "/v1/session", as: "00000000-0000-7000-8000-000000000000" })))
      .toBe("ERR_AUTH_NO_MEMBERSHIP");
  });

  it("a body field named tenant_id does not move the session (LEGACY-035)", async () => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "SNEAK", name: "Sneak", baseCurrency: "MYR", tenant_id: b.tenant, tenantId: b.tenant } });
    expect([201, 403]).toContain(res.status);
    const [leak] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.company where tenant_id = ${b.tenant} and code = 'SNEAK'`;
    expect(leak!.n).toBe(0);
  });

  it("a query parameter that names a session variable does nothing (LEGACY-027)", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies?limit=100&app.tenant_id=${b.tenant}&set_config=1`, as: a.human });
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).not.toContain(b.company);
  });

  it("an Idempotency-Key cannot be replayed across principals (LEGACY-042)", async () => {
    const key = "bypass-replay";
    await api.request({ method: "POST", path: "/v1/companies", as: a.human, body: { code: "K1", name: "K1", baseCurrency: "MYR" }, idempotencyKey: key });
    const other = await api.request({ method: "POST", path: "/v1/companies", as: b.human, body: { code: "K1", name: "K1", baseCurrency: "MYR" }, idempotencyKey: key });
    expect(other.headers.get("Idempotency-Replayed")).toBeNull();     // a different principal, a different key row
    const [rows] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.idempotency_key where key = ${key}`;
    expect(rows!.n).toBe(2);
  });

  it("app_rw with no set_config reads nothing, while resolve_principal still answers (v1.1 fix #3; OD-02)", async () => {
    const rw = createDb(api.db.url("app_rw"));
    expect(await rw<{ id: string }[]>`select id from app.principal`).toEqual([]);
    expect(await rw<{ id: string }[]>`select id from app.company`).toEqual([]);
    const resolved = await resolvePrincipal(rw, `human:${a.tenant}`);
    expect(resolved).toHaveLength(1);
    await rw.end();
  });

  it("app_rw cannot write a row for another tenant even with the uuid in hand (LEGACY-035)", async () => {
    const rw = createDb(api.db.url("app_rw"));
    await expect(rw.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.tenant}, 'X', 'Forged', 'MYR')`;
    })).rejects.toThrow(/row-level security/);
    await rw.end();
  });
});
```

- [ ] **Step 6: Wire CI and run**

`.github/workflows/ci.yml`: `bun run test` already runs every workspace through turbo, and `tests` is now one — confirm the run reports `@dulja/tests`.

Run: `bun run --cwd tests test`
Expected: PASS — the probe-coverage gate, seven route probes, the job-registry check, and nine bypass shapes.

- [ ] **Step 7: Commit**

```bash
git add tests apps/api/package.json apps/api/src/app.ts package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
test(invariants): the root tests workspace, probe registry, isolation and bypass suites [0B T13]

Acceptance tests 11 and 12 through the API. A ROUTES entry with no PROBES entry, or a
probe naming no route, fails the build (ADR 0006).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: the forty-three `tests/regression/legacy-NNN.test.ts` files (contracts §3.7.3)

`spec:2059` requires one regression file per Part I defect touched. Contracts §3.7.3 makes the **first slice in execution order** the creator, and 0B is first for forty-three of them: sixteen **full** files whose scenario this slice's own work proves through HTTP, twenty-one **thin** files re-running a Plan 0A data-layer proof through the *production* `withTenant`, and six **structural** files for facts 0A fixed without a dedicated test. Every later slice appends a `describe("… — <slice id>")` block to these same files and never edits the block written here.

`legacy-024` is **not** in this list: contracts §3.7.3 names **1A** as its creator, marked `it.skip` until OD-27 answers Part VII #6. Do not create it here.

**No red step here either, for the reason Task 13 states.** These forty-three files assert against behaviour Tasks 1–12 already shipped; a run before the file exists reports `Cannot find module`, not a failing assertion. Step 6 is the run that matters, and Step 7 is the mechanical count.

**Files:**
- Create: `tests/support/api.ts`, `tests/support/source.ts`, `tests/support/ledger.ts`
- Create (16 full): `tests/regression/legacy-025.test.ts`, `legacy-026`, `legacy-027`, `legacy-028`, `legacy-034`, `legacy-035`, `legacy-036`, `legacy-037`, `legacy-043`, `legacy-047`, `legacy-068`, `legacy-069`, `legacy-078`, `legacy-082`, `legacy-083`, `legacy-084` (`.test.ts` each)
- Create (21 thin): `tests/regression/legacy-003.test.ts`, `legacy-012`, `legacy-013`, `legacy-021`, `legacy-029`, `legacy-030`, `legacy-031`, `legacy-032`, `legacy-033`, `legacy-040`, `legacy-041`, `legacy-042`, `legacy-044`, `legacy-050`, `legacy-051`, `legacy-053`, `legacy-070`, `legacy-072`, `legacy-073`, `legacy-074`, `legacy-080` (`.test.ts` each)
- Create (6 structural): `tests/regression/legacy-023.test.ts`, `legacy-045`, `legacy-065`, `legacy-071`, `legacy-075`, `legacy-087` (`.test.ts` each)
- Modify: `apps/api/src/app.ts` — one added line, `export { ConfigError, readConfig, type ApiConfig } from "./config";`, so `legacy-082` reaches the config through the `@dulja/api` package entry rather than a source file (contracts §3.1; the same rule Task 13 followed for `ROUTES`)
- Delete: `tests/regression/.gitkeep` (the directory now holds forty-three files)

**Interfaces:**
- Consumes: `sharedDb`, `thinRegression`, `ThinContext` (Task 13); `startApi`, `StartedApi` from `apps/api/test/support/app` (Task 5 — a test-support module, the same cross-workspace import Task 13 already makes); `ROUTES`, `readConfig`, `ConfigError` from `@dulja/api` (Tasks 4, 13); `seedTenant`, `draftDocument`, `uuidv7`, `AUDIT_EXEMPT`, `MIGRATIONS_DIR`, `type Db`, `type Seed` from `@dulja/db/test` and `@dulja/db`; `withTenant`, `lintSchema`, `discover`, `listApplied` from `@dulja/db`; `type Problem`, `ERRORS`, `PERMISSIONS` from `@dulja/contracts` (Tasks 3, 7); `type SourceFile` from `scripts/lint/types` and `rule as noSqlConcat` from `scripts/lint/rules/no-sql-concat` (Task 12).
- Produces: `export async function grantAdmin(api: StartedApi, s: Seed): Promise<void>`; `export function sharedApi(): Promise<{ api: StartedApi; a: Seed; b: Seed }>`; `export interface FullContext { api: StartedApi; a: Seed; b: Seed; expect: typeof expect }`; `export function fullRegression(legacyDefect: string, heading: string, cases: Record<string, (ctx: FullContext) => Promise<void>>): void`; `export async function problemOf(res: Response): Promise<Problem>`; `export const REPO_ROOT: string` and `export function sourceFiles(roots?: string[]): SourceFile[]`; `export interface Line` and `export async function postLines(tx: Sql, s: Seed, docId: string, lines: Line[], periodId?: string): Promise<void>`. Every later slice writing a full regression file uses `fullRegression` + `sharedApi`; every later slice writing a thin one uses Task 13's `thinRegression` + `sharedDb`.

- [ ] **Step 1: Write the three support modules**

`tests/support/api.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/**
 * The FULL regression files of contracts §3.7.3 speak HTTP, so they need an app, not just a pool.
 *
 * `startApi()` opens its OWN Testcontainers database (it calls `startDb()` internally), so the `Seed`s handed out
 * here are NOT the `Seed`s of `tests/support/regression.ts`: they live in a different database. A regression file
 * uses `sharedApi()` or `sharedDb()`, never both. One memoised start serves the whole `tests` run — the workspace
 * is single-threaded with `isolate: false` (tests/vitest.config.ts), so the module instance is shared.
 */
let started: Promise<{ api: StartedApi; a: Seed; b: Seed }> | undefined;

/**
 * Grants the five Phase 0 codes through a real `role` + `role_permission` + `role_assignment` chain, acting as the
 * tenant's SYSTEM principal — `app.forbid_self_grant` (plan0A:1385) refuses a principal granting to itself, and
 * `app.assert_assignment_kind` refuses a non-terminal role on a terminal. Identical to the harness in
 * `tests/invariants/tenant-isolation.test.ts`; duplicated rather than exported from a `.test.ts` file, which would
 * re-run that suite's `describe` on import.
 */
export async function grantAdmin(api: StartedApi, s: Seed): Promise<void> {
  await api.db.migrator.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
    const [role] = await tx<{ id: string }[]>`insert into app.role (tenant_id, code, name_en, is_system)
      values (${s.tenant}, 'admin', 'Administrator', true) returning id`;
    for (const code of ["admin.user.manage", "admin.role.manage", "admin.role.assign", "admin.company.manage", "admin.audit_log.read"]) {
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${role!.id}, ${code})`;
    }
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
      values (${s.tenant}, ${s.human}, ${role!.id}, ${s.company})`;
  });
}

export function sharedApi(): Promise<{ api: StartedApi; a: Seed; b: Seed }> {
  started ??= (async () => {
    const api = await startApi();
    const a = await seedTenant(api.db, "Alpha");
    const b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    await api.loadPrincipals();
    return { api, a, b };
  })();
  return started;
}

export async function problemOf(res: Response): Promise<Problem> {
  return (await res.json()) as Problem;
}

export interface FullContext { api: StartedApi; a: Seed; b: Seed; expect: typeof expect }

/**
 * The shape of every FULL regression file (contracts §3.7.3): one `describe` naming the defect and the slice, one
 * `it` per scenario. The cases object is walked at collection time (synchronously — vitest forbids an async
 * `describe` body); each `it` awaits the memoised app itself.
 */
export function fullRegression(
  legacyDefect: string, heading: string, cases: Record<string, (ctx: FullContext) => Promise<void>>,
): void {
  describe(`${legacyDefect} ${heading} — 0B`, () => {
    for (const [name, fn] of Object.entries(cases)) {
      it(name, async () => {
        const { api, a, b } = await sharedApi();
        await fn({ api, a, b, expect });
      });
    }
  });
}
```

`tests/support/source.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "../../scripts/lint/types";

/** The repository root, two levels up from tests/support/. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP = new Set(["node_modules", "dist", ".turbo", ".drizzle", ".git", "openapi.json"]);

/**
 * Re-walks the tree `scripts/lint/run.ts` scans (its `ROOTS`), producing the `SourceFile` shape Task 12 froze.
 * `run.ts` is a CLI — it walks, prints and calls `process.exit` — so it exports no walker and the walk is repeated
 * here. `node:fs`, never `Bun.Glob`: the `tests` workspace runs under Node 24 via Vitest (D5).
 */
export function sourceFiles(roots: string[] = ["apps", "packages", "scripts"]): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      out.push({ path: relative(REPO_ROOT, full).replaceAll("\\", "/"), text, lines: text.split("\n") });
    }
  };
  for (const r of roots) walk(join(REPO_ROOT, r));
  return out;
}
```

`tests/support/ledger.ts`:

```ts
import type { Sql } from "postgres";
import type { Seed } from "@dulja/db/test";

export interface Line { account: string; debit?: string; credit?: string; currency?: string; rate?: string }

/**
 * The exact `app.ledger_entry` insert the posting service must reproduce — column list and
 * `base_* = round(value × rate, 4)` copied from `packages/db/test/ledger.test.ts` (plan0A:1908–1923; contracts
 * §4.1 names that helper as the reference). Copied rather than imported: that file is a `.test.ts` with a
 * top-level `describe`, and importing it would re-run Plan 0A's ledger suite inside the `tests` workspace.
 *
 * Nothing outside these regression files may write a ledger table (contracts hazard 22, the `posting-only-tables`
 * lint of 1A) — but `scripts/lint/run.ts` walks `apps`, `packages` and `scripts` only, so `tests/**` is outside
 * every lint root, and `tests/**` is where the defect being regressed has to be re-attempted. That exemption is
 * structural, not recorded in contracts §3.7.5, so header assumption 13 carries it: a later slice that adds
 * `tests` to `ROOTS` must put `tests/support/**` on `posting-only-tables`'s allow-list in the same PR, or every
 * thin ledger regression fails lint. When 1A ships `postDocument`, these files keep this helper: they assert the
 * DATABASE refuses the defect, not that the service avoids it.
 */
export async function postLines(tx: Sql, s: Seed, docId: string, lines: Line[], periodId = s.period): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n += 1;
    const rate = l.rate ?? "1";
    await tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit,
       effective_date, fiscal_period_id, posting_policy_id)
      values (${s.tenant}, ${s.company}, ${docId}, ${n}, ${l.account}, ${l.debit ?? "0"}, ${l.credit ?? "0"}, ${l.currency ?? "MYR"}, ${rate},
              round(${l.debit ?? "0"}::numeric * ${rate}::numeric, 4), round(${l.credit ?? "0"}::numeric * ${rate}::numeric, 4),
              '2026-01-15', ${periodId}, ${s.policy})`;
  }
}
```

- [ ] **Step 2: Write the first eight full files — identity and authorisation (025, 026, 027, 028, 034, 035, 043, 047)**

`tests/regression/legacy-025.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-025", "`procQuickLogin` grants a full administrator session with no credentials", {
  "no Authorization header reaches nothing — not even the aal1-exempt session route": async ({ api, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/session" });
    expect(res.status).toBe(401);
    expect((await problemOf(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
  },

  "there is no credential-free door into any registered route": async ({ api, expect }) => {
    for (const path of ["/v1/session", "/v1/companies", "/v1/admin/users", "/v1/admin/roles", "/v1/admin/audit-log"]) {
      const res = await api.request({ method: "GET", path });
      expect(res.status).toBe(401);
      expect((await problemOf(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
    }
  },

  "administrator authority is a role assignment, never a side effect of signing in": async ({ api, a, expect }) => {
    const invite = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "legacy025@example.test", displayName: "LEGACY-025" } });
    expect(invite.status).toBe(201);
    const created = (await invite.json()) as { id: string };
    await api.loadPrincipals();

    // A real, valid, aal2 token for a real member of the tenant — and it can read nothing an admin reads.
    const listed = await api.request({ method: "GET", path: "/v1/admin/users", as: created.id });
    expect(listed.status).toBe(403);
    expect((await problemOf(listed)).code).toBe("ERR_RBAC_FORBIDDEN");
  },
});
```

`tests/regression/legacy-026.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-026", "Session identity is unauthenticated, client-writable context", {
  "the tenant and actor come from the verified token, never from a header": async ({ api, a, b, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/session", as: a.human,
      headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human, "X-Principal-Id": b.human } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: a.tenant, principalId: a.human, principalKind: "human" });
  },

  "a body field named tenant_id is stripped by the schema and never reaches the row": async ({ api, a, b, expect }) => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "LEGACY026", name: "LEGACY-026", baseCurrency: "MYR", tenant_id: b.tenant, tenantId: b.tenant } });
    expect(res.status).toBe(201);
    const [row] = await api.db.admin<{ tenant_id: string }[]>`
      select tenant_id from app.company where code = 'LEGACY026'`;
    expect(row!.tenant_id).toBe(a.tenant);
  },

  "the session variables the database reads are set by withTenant, and app_rw cannot set them itself": async ({ api, b, expect }) => {
    // A connection that never entered withTenant sees nothing: current_tenant() is the only door, and it is
    // written by the server (plan0A:957), not by anything the caller can send.
    const rows = await api.db.rw<{ n: number }[]>`select count(*)::int as n from app.company`;
    expect(rows[0]!.n).toBe(0);
    const forged = await api.db.rw<{ n: number }[]>`
      select count(*)::int as n from app.company where tenant_id = ${b.tenant}`;
    expect(forged[0]!.n).toBe(0);
  },
});
```

`tests/regression/legacy-027.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-027", "One client-settable variable disables every write-time control", {
  "a query parameter naming a session variable is stripped and changes nothing": async ({ api, a, b, expect }) => {
    const res = await api.request({ method: "GET", as: a.human,
      path: `/v1/companies?limit=100&app.tenant_id=${b.tenant}&set_config=1&silent=1&audit=off` });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);
  },

  "setting any app.* GUC by hand does not switch off RLS, the audit trigger or the actor stamp": async ({ api, a, expect }) => {
    const before = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
    await api.db.rw.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      // Every off-switch the legacy system had, invented back: none of them exists, and setting them is inert.
      await tx`select set_config('app.silent', '1', true), set_config('app.audit', 'off', true),
                      set_config('app.skip_checks', 'true', true), set_config('app.admin', '1', true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY027', 'LEGACY-027', 'MYR')`;
    });
    const after = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  },

  "there is no session setting that lets app_rw write another tenant's row": async ({ api, a, b, expect }) => {
    await expect(api.db.rw.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`select set_config('app.bypass_rls', 'on', true), set_config('row_security', 'off', true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.tenant}, 'LEGACY027X', 'Forged', 'MYR')`;
    })).rejects.toThrow(/row-level security|permission denied/);
  },
});
```

`tests/regression/legacy-028.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-028", "Passwords are stored and compared in cleartext", {
  "no identity table in schema app has a password or credential column": async ({ api, expect }) => {
    // Scoped to the identity tables, not schema-wide: 6A's `terminal_enrolment` and 8A's HR envelope carry
    // legitimate secret material, and this block cannot be edited when they land (contracts §3.7.3). The defect
    // was `Users.Password` in cleartext, and these three tables are where such a column would go.
    const cols = await api.db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and table_name in ('principal', 'membership', 'tenant')
         and (column_name ~* 'password' or column_name ~* 'passwd' or column_name ~* 'secret'
              or column_name ~* 'credential' or column_name ~* 'api_key')`;
    expect(cols).toEqual([]);
  },

  "a principal is a subject reference, not a credential store": async ({ api, expect }) => {
    const cols = await api.db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'principal' order by column_name`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("auth_subject");
    expect(names.filter((n) => /pass|secret|hash|token/i.test(n))).toEqual([]);
  },

  "the API never accepts a password: the invite body is e-mail and display name only": async ({ api, a, expect }) => {
    const res = await api.request({ method: "POST", path: "/v1/admin/users", as: a.human,
      body: { email: "legacy028@example.test", displayName: "LEGACY-028", password: "hunter2" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const [row] = await api.db.admin<{ auth_subject: string }[]>`
      select auth_subject from app.principal where id = ${created.id}`;
    expect(row!.auth_subject).toMatch(/^stub:[0-9a-f]{32}$/);       // server-obtained subject; the password went nowhere
  },
});
```

`tests/regression/legacy-034.test.ts`:

```ts
import { PERMISSIONS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-034", "`Grants` — the document-level permission table — is never read by any code", {
  "the permission table is real data that the database itself reads, not a table nothing consults": async ({ api, expect }) => {
    // `Grants` existed and was never queried. `app.permission` is the FK target of every `role_permission` row
    // and the argument of `app.actor_has` (plan0A:985–1004), so a code that is not here cannot be granted and a
    // grant that is here is what the predicate answers about. (`actor_has` is never called from `db.admin`: it
    // reads `app.current_actor()`, which only exists inside a `withTenant` transaction.)
    const rows = await api.db.admin<{ code: string }[]>`select code from app.permission order by code`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).sort());

    const fks = await api.db.admin<{ conname: string }[]>`
      select c.conname from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_class r on r.oid = c.confrelid
       where t.relname = 'role_permission' and r.relname = 'permission' and c.contype = 'f'`;
    expect(fks.length).toBe(1);
  },

  "withdrawing the grant closes the route on the very next request": async ({ api, a, expect }) => {
    const ok = await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human });
    expect(ok.status).toBe(200);

    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`delete from app.role_permission
                where tenant_id = ${a.tenant} and permission_code = 'admin.audit_log.read'`;
    });

    const denied = await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human });
    expect(denied.status).toBe(403);
    expect((await problemOf(denied)).code).toBe("ERR_RBAC_FORBIDDEN");

    await api.db.migrator.begin(async (tx) => {                     // restore: later files in this run need it
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      const [role] = await tx<{ id: string }[]>`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${role!.id}, 'admin.audit_log.read')`;
    });
    expect((await api.request({ method: "GET", path: "/v1/admin/audit-log", as: a.human })).status).toBe(200);
  },
});
```

`tests/regression/legacy-035.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-035", "Tenant (Site) scoping is a client convention", {
  "reading another tenant's row by its uuid is 404, not a row": async ({ api, a, b, expect }) => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${b.company}`, as: a.human });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  },

  "writing into another tenant's row by its uuid is refused and leaves it untouched": async ({ api, a, b, expect }) => {
    const [before] = await api.db.admin<{ name: string }[]>`select name from app.company where id = ${b.company}`;
    const res = await api.request({ method: "PATCH", path: `/v1/companies/${b.company}`, as: a.human,
      body: { name: "Taken over" } });
    expect([403, 404]).toContain(res.status);
    const [after] = await api.db.admin<{ name: string }[]>`select name from app.company where id = ${b.company}`;
    expect(after!.name).toBe(before!.name);
  },

  "the list endpoint is scoped by the transaction, not by a WHERE the caller could drop": async ({ api, a, b, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/companies?limit=1000", as: a.human });
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);
  },

  "app_rw itself cannot insert a row for another tenant even holding the uuid": async ({ api, a, b, expect }) => {
    await expect(api.db.rw.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.human}, true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.tenant}, 'LEGACY035', 'Forged', 'MYR')`;
    })).rejects.toThrow(/row-level security/);
  },
});
```

`tests/regression/legacy-043.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-043", "Failed authentication returns a row instead of raising", {
  "every failure shape is a problem document with a 401 status, never a body of data": async ({ api, expect }) => {
    const forged = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0.AAAA";
    for (const token of [forged, "Bearer", "", "null", "undefined"]) {
      const res = await api.request({ method: "GET", path: "/v1/session", headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_AUTH_TOKEN_INVALID");
      expect(problem.status).toBe(401);
    }
  },

  "a valid signature over a subject with no membership is refused, and says so distinctly": async ({ api, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/session", as: "00000000-0000-7000-8000-00000000dead" });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_AUTH_NO_MEMBERSHIP");
  },

  "resolve_principal answers with zero rows for an unknown subject — it does not invent one": async ({ api, expect }) => {
    const rows = await api.db.admin<{ principal_id: string }[]>`select * from app.resolve_principal('supabase:not-a-user')`;
    expect(rows).toEqual([]);
  },
});
```

`tests/regression/legacy-047.test.ts`:

```ts
import { ROUTES } from "@dulja/api";
import { ERRORS, PERMISSIONS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-047", "Only 7 of ~55 permission flags are ever read by the database", {
  "the catalogue and the seeded table are the same set, in both directions": async ({ api, expect }) => {
    const rows = await api.db.admin<{ code: string }[]>`select code from app.permission order by code`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).sort());
  },

  "every catalogue code is the gate of at least one registered route": async ({ expect }) => {
    // `RouteModule.permissions` (contracts §4.2.7) is the mounted truth — the OpenAPI document, the isolation
    // harness and the boot-time read-only gate all read the same ROUTES array, so a code gated here is a code
    // the database is actually asked about. The full `permission-catalogue` build check is 0D's (§3.6.3); this
    // is its Phase 0 half: five codes, five gates, no orphan.
    const gated = new Set(ROUTES.flatMap((r) => [...r.permissions] as string[]));
    for (const p of PERMISSIONS) expect([...gated]).toContain(p.code);
  },

  "a code that is not in the catalogue cannot be granted": async ({ api, a, expect }) => {
    await expect(api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      const [role] = await tx<{ id: string }[]>`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${role!.id}, 'admin.invented.code')`;
    })).rejects.toThrow(/foreign key|permission/i);
    expect(Object.keys(ERRORS)).toContain("ERR_RBAC_FORBIDDEN");
  },
});
```

- [ ] **Step 3: Write the eight remaining full files — SQL text, configuration and error handling (036, 037, 068, 069, 078, 082, 083, 084)**

`tests/regression/legacy-036.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rule as noSqlConcat } from "../../scripts/lint/rules/no-sql-concat";
import { fullRegression, problemOf } from "../support/api";
import { sourceFiles } from "../support/source";

describe("LEGACY-036 Six procedures accept a raw SQL predicate as a parameter — 0B (source)", () => {
  it("no shipped source builds SQL by concatenation or hands `.unsafe` a non-literal (acceptance test 27)", () => {
    const violations = noSqlConcat.run(sourceFiles());
    expect(violations.map((v) => `${v.file}:${v.line} ${v.detail}`)).toEqual([]);
  });

  it("`sql.unsafe` appears only in the homes contracts §3.3 allows, plus Plan 0A's roles.sql loader", () => {
    // This case greps `f.text` directly instead of going through the rule, so it needs two narrowings the
    // FIRST case does not. (a) `sourceFiles(["apps", "packages"])`, NOT the default
    // `["apps", "packages", "scripts"]`: `no-sql-concat` opens with
    // `if (!/^(apps|packages)\//.test(f.path)) continue;`, so those two roots are the tree the rule polices and
    // the only tree the "where does `.unsafe(` live" question is about — and under the default root list
    // `scripts/lint/rules/no-sql-concat.ts` is itself reported, because it names `.unsafe(` in its own violation
    // message and in its allow-list comments. The file that DEFINES the check is not a caller of it.
    // (b) `.test.tsx?$` is excluded: `scripts/lint/lint.test.ts` carries `await tx.unsafe("select * from " +
    // table)` as a FIXTURE, and `packages/db/test/roles.test.ts` (plan0A:553) is a real but allow-listed caller.
    const callers = sourceFiles(["apps", "packages"])
      .filter((f) => !/\.test\.tsx?$/.test(f.path) && /\.unsafe\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    // A SUBSET check, for two reasons. packages/importer/src/reader.ts is 9A's and does not exist yet. And the
    // fourth entry is Plan 0A's `packages/db/test/harness.ts`, which applies `packages/db/roles.sql` with
    // `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` (plan0A:476) — a checked-in .sql file read from disk, the
    // same case as migrate.ts — and which survives the `.test.tsx?$` filter above because it is not a test file.
    // `packages/db/test/roles.test.ts` makes the identical call (plan0A:553) and the filter removes it. Both are
    // on `no-sql-concat`'s UNSAFE_ALLOW (Task 12), and this list must agree with that one or the two checks
    // contradict each other. Contracts §3.3's "exactly three places" predates Plan 0A's harness and is owed the
    // amendment. Plan 0A is immovable, so the allow-lists move, not the harness.
    for (const c of callers) {
      expect([
        "packages/db/src/migrate.ts", "packages/db/src/jobs/enqueue.ts", "packages/importer/src/reader.ts",
        "packages/db/test/harness.ts",
      ]).toContain(c);
    }
  });
});

fullRegression("LEGACY-036", "Six procedures accept a raw SQL predicate as a parameter", {
  "no endpoint accepts a predicate: an undeclared filter key is stripped, never spliced": async ({ api, a, expect }) => {
    const res = await api.request({ method: "GET", as: a.human,
      path: `/v1/admin/audit-log?limit=5&where=${encodeURIComponent("1=1 or tenant_id is not null")}&filter=${encodeURIComponent("true")}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { tableName: string }[] };
    expect(Array.isArray(body.items)).toBe(true);
  },

  "a declared filter is a parameter: SQL metacharacters in it match nothing and destroy nothing": async ({ api, a, expect }) => {
    const res = await api.request({ method: "GET", as: a.human,
      path: `/v1/admin/audit-log?tableName=${encodeURIComponent("company'; drop table app.company; --")}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    const [still] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app' and table_name = 'company'`;
    expect(still!.n).toBe(1);
  },

  "a value outside the declared enum is a validation problem, and no name reaches SQL": async ({ api, a, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/admin/audit-log?action=drop", as: a.human });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  },
});
```

`tests/regression/legacy-037.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

const INJECTIONS = [
  "Robert'); drop table app.company; --",
  "'||(select auth_subject from app.principal limit 1)||'",
  "x' union select null,null,null,null --",
  "\\'; update app.company set name = 'owned'; --",
];

fullRegression("LEGACY-037", "Four procedures interpolate unescaped user strings into SQL literals", {
  "an injection string is stored and returned byte-identically, and nothing else changes": async ({ api, a, expect }) => {
    let n = 0;
    for (const evil of INJECTIONS) {
      n += 1;
      const created = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
        body: { code: `LEGACY037${n}`, name: evil, baseCurrency: "MYR" } });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const read = await api.request({ method: "GET", path: `/v1/companies/${id}`, as: a.human });
      expect(((await read.json()) as { name: string }).name).toBe(evil);
    }

    const [tables] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app' and table_name = 'company'`;
    expect(tables!.n).toBe(1);
    const [owned] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.company where name = 'owned'`;
    expect(owned!.n).toBe(0);
  },

  "an injection string in a path parameter is a validation problem, not a query": async ({ api, a, expect }) => {
    const res = await api.request({ method: "GET", as: a.human,
      path: `/v1/companies/${encodeURIComponent("1 or 1=1")}` });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  },

  "an injection string in an Idempotency-Key is a key, not a fragment": async ({ api, a, expect }) => {
    const key = "k'; delete from app.idempotency_key; --";
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "LEGACY037K", name: "Key", baseCurrency: "MYR" }, idempotencyKey: key });
    expect(res.status).toBe(201);
    const [row] = await api.db.admin<{ key: string }[]>`select key from app.idempotency_key where key = ${key}`;
    expect(row!.key).toBe(key);
  },
});
```

`tests/regression/legacy-068.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fullRegression } from "../support/api";
import { sourceFiles } from "../support/source";

/** The legacy fix for missing indexes was a pinned plan (`PLAN JOIN (…)`, `+ INDEX (…)`); Dulja's fix is the
 *  index itself, and no plan directive anywhere. Both halves are asserted. */
describe("LEGACY-068 23 hardcoded query plans, two pinning implicitly-generated index names — 0B (source)", () => {
  it("no source file pins an optimiser plan or names an index in a query", () => {
    const offenders = sourceFiles()
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .filter((l) => /\bPLAN\s+(JOIN|SORT|MERGE)\b/i.test(l.text) || /\/\*\+\s*index/i.test(l.text) || /\bset\s+enable_(seqscan|indexscan|hashjoin|mergejoin)\b/i.test(l.text));
    expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([]);
  });
});

fullRegression("LEGACY-068", "23 hardcoded query plans, two pinning implicitly-generated index names", {
  "the index the ledger reports need exists, so no plan needs pinning": async ({ api, expect }) => {
    const idx = await api.db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry' order by indexname`;
    expect(idx.map((i) => i.indexname)).toContain("ledger_entry_account_date_idx");
  },

  "the planner is free: the same statement is planned by Postgres, with no directive in the SQL text": async ({ api, a, expect }) => {
    const plan = await api.db.admin<{ "QUERY PLAN": string }[]>`
      explain select id from app.ledger_entry where company_id = ${a.company} and effective_date >= '2026-01-01'`;
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.map((p) => p["QUERY PLAN"]).join("\n")).not.toMatch(/PLAN\s+JOIN/i);
  },
});
```

`tests/regression/legacy-069.test.ts`:

```ts
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-069", "Every report query is rebuilt, re-parsed and re-planned on each call, into fixed-size buffers", {
  "the free-text columns this slice reads are unbounded: nothing can be silently truncated by a buffer": async ({ api, expect }) => {
    // Named tables, not a schema-wide sweep: later slices add tables and cannot edit this block (§3.7.3).
    // Every one of these is `text`, never `varchar(n)` — an over-length value is refused by the schema at the
    // API boundary (next case), never trimmed to fit a declared width.
    const cols = await api.db.admin<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'app'
         and table_name in ('company', 'principal', 'role', 'permission', 'account', 'document', 'audit_log')
         and data_type = 'character varying'`;
    expect(cols).toEqual([]);
  },

  "an over-length value is REFUSED at the schema boundary, never trimmed to fit": async ({ api, a, expect }) => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "LEGACY069A", name: "x".repeat(201), baseCurrency: "MYR" } });   // CreateCompanyBody: max(200)
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.some((e) => e.path.includes("name"))).toBe(true);
  },

  "a value at the declared limit round-trips byte-identically": async ({ api, a, expect }) => {
    const name = "ن".repeat(200);                  // 200 characters, 400 bytes: a byte buffer would have cut it
    const created = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "LEGACY069B", name, baseCurrency: "MYR" } });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const read = await api.request({ method: "GET", path: `/v1/companies/${id}`, as: a.human });
    expect(((await read.json()) as { name: string }).name).toBe(name);
  },
});
```

`tests/regression/legacy-078.test.ts`:

```ts
import { PERMISSIONS } from "@dulja/contracts";
import { fullRegression } from "../support/api";

fullRegression("LEGACY-078", "Behaviour-governing configuration lives in opaque blobs", {
  "permissions are a version-controlled list, not a bitmask blob": async ({ api, expect }) => {
    const cols = await api.db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'permission' and column_name = 'code'`;
    expect(cols[0]!.data_type).toBe("text");
    expect([...PERMISSIONS].every((p) => /^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(p.code))).toBe(true);
    const blobs = await api.db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'permission' and data_type in ('bytea', 'bit', 'bit varying')`;
    expect(blobs).toEqual([]);
  },

  "posting policies and document types are jsonb — queryable and diffable — never an opaque blob": async ({ api, expect }) => {
    // Named columns, not a schema-wide sweep: 8A's `employee_sensitive` envelope (§4.12.5) is legitimately
    // `bytea`, and this block cannot be edited when it lands (contracts §3.7.3). The defect was configuration
    // that GOVERNS BEHAVIOUR living in a blob; these are the two Phase 0 columns that do.
    for (const [table, column] of [["posting_policy", "definition"], ["document_type", "options"]] as const) {
      const [col] = await api.db.admin<{ data_type: string }[]>`
        select data_type from information_schema.columns
         where table_schema = 'app' and table_name = ${table} and column_name = ${column}`;
      if (col) expect(col.data_type, `${table}.${column}`).toBe("jsonb");
    }
    const [policy] = await api.db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'posting_policy' and column_name = 'definition'`;
    expect(policy!.data_type).toBe("jsonb");        // this one must exist: migration 0001 creates it
  },

  "the seeded catalogue is exactly the file, so a diff of the file is a diff of behaviour": async ({ api, expect }) => {
    const rows = await api.db.admin<{ code: string }[]>`select code from app.permission order by code`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).sort());
  },
});
```

`tests/regression/legacy-082.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "@dulja/api";     // the package entry, never a source file (§3.1)
import { sourceFiles } from "../support/source";

/** No container start: the defect was a literal in shipped code, and its fix is that every address the server
 *  needs is a named environment variable read once at boot (contracts §3.11). */
describe("LEGACY-082 Licensing is pinned to a hardcoded private IP address — 0B", () => {
  const env = { APP_ENV: "dev", LOG_LEVEL: "info", DATABASE_URL: "postgres://u:p@localhost:5432/d",
    SUPABASE_JWKS_URL: "https://example.test/keys", SUPABASE_JWT_ISSUER: "https://example.test" };

  it("every address the API needs comes from a named variable, and a missing one fails loudly at boot", () => {
    expect(readConfig(env).databaseUrl).toBe(env.DATABASE_URL);
    for (const name of ["DATABASE_URL", "SUPABASE_JWKS_URL", "SUPABASE_JWT_ISSUER"] as const) {
      const without = { ...env, [name]: "" };
      expect(() => readConfig(without)).toThrow(ConfigError);
      expect(() => readConfig(without)).toThrow(new RegExp(`^${name} is not set`));
    }
  });

  it("no shipped source contains a hard-coded routable or private IPv4 host", () => {
    // 0.0.0.0 (bind-any) and 127.0.0.1 (loopback) are addresses of THIS process, not of a remote service, and are
    // the only two allowed; anything else is a pinned peer, which is the defect.
    const ALLOWED = new Set(["0.0.0.0", "127.0.0.1"]);
    const offenders = sourceFiles()
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .flatMap((l) => (l.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).map((ip) => ({ ...l, ip })))
      .filter((l) => !ALLOWED.has(l.ip));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.ip}`)).toEqual([]);
  });
});
```

`tests/regression/legacy-083.test.ts`:

```ts
import { ERRORS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-083", "One error handler in 33,179 lines, and it swallows the error", {
  "a database error is classified and surfaced, never swallowed into a success": async ({ api, a, expect }) => {
    const body = { code: "LEGACY083", name: "First", baseCurrency: "MYR" };
    expect((await api.request({ method: "POST", path: "/v1/companies", as: a.human, body })).status).toBe(201);

    // A DIFFERENT Idempotency-Key, so the reservation cannot mask it: the unique violation reaches the handler.
    const dup = await api.request({ method: "POST", path: "/v1/companies", as: a.human, body });
    expect(dup.status).toBe(409);
    const problem = await problemOf(dup);
    expect(problem.code).toBe("ERR_CONFLICT_UNIQUE");
    expect(problem.status).toBe(409);
  },

  "no registry code can be answered with a 2xx — every one is a failure status": async ({ expect }) => {
    for (const [code, def] of Object.entries(ERRORS)) {
      expect(def.status, code).toBeGreaterThanOrEqual(400);
      expect(def.status, code).toBeLessThan(600);
    }
    // Containment, not equality: 0D and every later slice add codes to this registry and may not edit this
    // block (contracts §3.7.3), so the assertion is that 0B's own twenty-five are still all present.
    for (const code of ["ERR_VALIDATION_FAILED", "ERR_IDEMPOTENCY_KEY_MISSING", "ERR_AUTH_TOKEN_INVALID",
      "ERR_AUTH_AAL_INSUFFICIENT", "ERR_AUTH_NO_MEMBERSHIP", "ERR_RBAC_FORBIDDEN", "ERR_RLS_DENIED",
      "ERR_NOT_FOUND", "ERR_RBAC_SELF_GRANT", "ERR_RBAC_SELF_ESCALATION", "ERR_RBAC_KIND", "ERR_RBAC_LAST_ADMIN",
      "ERR_ACTOR_IMMUTABLE", "ERR_TABLE_IMMUTABLE", "ERR_IDEMPOTENCY_KEY_REUSED", "ERR_IDEMPOTENCY_IN_FLIGHT",
      "ERR_CONFLICT_UNIQUE", "ERR_CONFLICT_REFERENCE", "ERR_LEDGER_UNBALANCED", "ERR_PERIOD_NOT_OPEN",
      "ERR_TENANT_CONTEXT_MISSING", "ERR_TENANT_CONTEXT_NESTED", "ERR_DB_POOLER_URL",
      "ERR_ROUTE_GATE_READONLY", "ERR_INTERNAL"]) {
      expect(Object.keys(ERRORS)).toContain(code);
    }
  },

  "every failure carries the request id that finds it in the log": async ({ api, a, expect }) => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${a.tenant}`, as: a.human });
    expect(res.status).toBe(404);
    const problem = await problemOf(res);
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Request-Id")).toBe(problem.requestId);
  },
});
```

`tests/regression/legacy-084.test.ts`:

```ts
import { ERRORS } from "@dulja/contracts";
import { fullRegression, problemOf } from "../support/api";

fullRegression("LEGACY-084", "Error messages are not actionable and the code convention is broken", {
  "every registry entry has a title and a remedy, and every code follows ERR_<DOMAIN>_<REASON>": async ({ expect }) => {
    for (const [code, def] of Object.entries(ERRORS)) {
      expect(code).toMatch(/^ERR_[A-Z]+(?:_[A-Z0-9]+)+$/);
      expect(def.title.length, code).toBeGreaterThan(0);
      expect(def.remedy.length, code).toBeGreaterThan(0);
      expect(def.remedy, code).not.toMatch(/^(error|failed|invalid)\.?$/i);
    }
  },

  "a real validation failure names the field and says what to do about it": async ({ api, a, expect }) => {
    const res = await api.request({ method: "POST", path: "/v1/companies", as: a.human,
      body: { code: "not lower case!", name: "", baseCurrency: "RINGGIT" } });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.title).toBe(ERRORS.ERR_VALIDATION_FAILED.title);
    expect(problem.remedy).toBe(ERRORS.ERR_VALIDATION_FAILED.remedy);
    expect(problem.instance).toContain("/v1/companies");
    const paths = (problem.errors ?? []).map((e) => e.path);
    for (const field of ["code", "name", "baseCurrency"]) expect(paths.join(" ")).toContain(field);
  },

  "the response is a problem document, so a client can branch on `code` without parsing prose": async ({ api, expect }) => {
    const res = await api.request({ method: "GET", path: "/v1/session" });
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const problem = await problemOf(res);
    for (const key of ["type", "title", "status", "detail", "instance", "code", "remedy", "requestId"]) {
      expect(Object.keys(problem)).toContain(key);
    }
  },
});
```

- [ ] **Step 4: Write the twenty-one thin files (contracts §3.7.3 — the Plan 0A-proven defects)**

Each is one `thinRegression(...)` call: the minimal scenario re-run through the **production** `withTenant` (or, for a privilege or catalogue fact, a catalog read), citing the Plan 0A test that first proved it. `ctx` is Task 13's `ThinContext` — `{ db, rw, a, b, withTenant, expect }`, where `rw` is the production `createDb` pool and `withTenant` the production three-argument helper.

`tests/regression/legacy-003.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression("LEGACY-003", "Nothing enforces that debits equal credits",
  "packages/db/test/ledger.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-003" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(withTenant(rw, ctx, (tx) =>
      postLines(tx, a, doc, [{ account: a.cash, debit: "100" }, { account: a.sales, credit: "90" }]),
    )).rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
    const [c] = await withTenant(rw, ctx, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where document_id = ${doc}`);
    expect(c!.n).toBe(0);                                  // deferred to COMMIT: nothing from it survives
  });
```

`tests/regression/legacy-012.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression("LEGACY-012", "Base-currency amounts are never derived from value × rate, and the rate is never validated",
  "packages/db/test/ledger.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-012" };

    const ok = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) => postLines(tx, a, ok, [
      { account: a.cash, debit: "100", currency: "EUR", rate: "4.85" },
      { account: a.sales, credit: "100", currency: "EUR", rate: "4.85" }]));
    const [line] = await withTenant(rw, ctx, (tx) =>
      tx<{ base_debit: string }[]>`select base_debit from app.ledger_entry where document_id = ${ok} and line_no = 1`);
    expect(line!.base_debit).toBe("485.0000");             // derived, at scale 4, HALF_AWAY_FROM_ZERO

    const bad = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(withTenant(rw, ctx, (tx) => tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
       base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${bad}, 1, ${a.cash}, 100, 0, 'USD', 4.2, 500, 0, '2026-01-15', ${a.period}, ${a.policy})`,
    )).rejects.toThrow(/check constraint/);                 // a hand-typed base amount is refused
  });
```

`tests/regression/legacy-013.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression("LEGACY-013", "Reversal reads *current* document-type flags instead of what was originally applied",
  "packages/db/test/documents.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-013" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) => postLines(tx, a, doc,
      [{ account: a.cash, debit: "7" }, { account: a.sales, credit: "7" }]));

    // The rule that produced the row is PINNED on the row, not looked up when a reversal is written.
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'ledger_entry' and column_name = 'posting_policy_id'`;
    expect(col!.is_nullable).toBe("NO");
    const rows = await withTenant(rw, ctx, (tx) =>
      tx<{ posting_policy_id: string }[]>`select posting_policy_id from app.ledger_entry where document_id = ${doc}`);
    expect(rows.map((r) => r.posting_policy_id)).toEqual([a.policy, a.policy]);
  });
```

`tests/regression/legacy-021.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-021", "Accounts can be deleted with posted entries; the ID generator then rewinds and reuses their IDs",
  "packages/db/test/privileges.test.ts", async ({ db, expect }) => {
    const [priv] = await db.admin<{ del: boolean }[]>`
      select has_table_privilege('app_rw', 'app.account', 'delete') as del`;
    expect(priv!.del).toBe(false);                          // §3.5.4: the DELETE list does not include account

    const [archived] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'archived_at'`;
    expect(archived!.n).toBe(1);                            // spec:2049: master data is archived, never deleted

    const [id] = await db.admin<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'id'`;
    expect(id!.column_default).toMatch(/uuidv7\(\)/);        // no max()+1 generator to rewind, no id to re-issue

    // `audit_log.seq` is an identity column that never goes backwards, and no BUSINESS identifier is one — so
    // deleting a row can never free an id for reuse. Containment plus a targeted absence, because later slices
    // add tables and cannot edit this block (§3.7.3).
    const identities = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and is_identity = 'YES' order by table_name, column_name`;
    expect(identities).toContainEqual({ table_name: "audit_log", column_name: "seq" });
    expect(identities.filter((i) => i.column_name === "id")).toEqual([]);
  });
```

`tests/regression/legacy-029.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-029", "The audit trail records no actor and is a freely writable table",
  "packages/db/test/audit.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-029" };
    await withTenant(rw, ctx, (tx) =>
      tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY029', 'LEGACY-029', 'MYR')`);

    const [row] = await db.admin<{ actor_id: string; action: string }[]>`
      select actor_id, action from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'company' order by seq desc limit 1`;
    expect(row!.actor_id).toBe(a.human);                    // the session actor, not a parameter
    expect(row!.action).toBe("insert");

    const [priv] = await db.admin<{ upd: boolean; del: boolean }[]>`
      select has_table_privilege('app_rw', 'app.audit_log', 'update') as upd,
             has_table_privilege('app_rw', 'app.audit_log', 'delete') as del`;
    expect(priv).toEqual({ upd: false, del: false });       // append-only, by privilege as well as by trigger
  });
```

`tests/regression/legacy-030.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-030", "A login parameter switches the audit trail off",
  "packages/db/test/audit.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-030" };
    const [before] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;

    await withTenant(rw, ctx, async (tx) => {
      // Every off-switch the legacy system had, invented back inside the transaction. None exists; all are inert
      // — an unknown `app.*` GUC is just a string nothing reads.
      await tx`select set_config('app.silent', '1', true), set_config('app.audit', 'off', true),
                      set_config('app.no_audit', 'true', true), set_config('app.login_silent', '1', true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY030', 'LEGACY-030', 'MYR')`;
    });

    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
    expect(after!.n).toBe(before!.n + 1);

    // The one setting Postgres really does have for silencing triggers is superuser-only, and `app_rw` is not
    // one — so the legacy design (an off-switch the caller supplies) has no equivalent here at all. This is a
    // separate statement because the refusal aborts its transaction; folding it into the block above would stop
    // the insert before the audit assertion could run.
    await expect(withTenant(rw, ctx, (tx) =>
      tx`select set_config('session_replication_role', 'replica', true)`)).rejects.toThrow(/permission denied/i);
  });
```

`tests/regression/legacy-031.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression("LEGACY-031", "Period locks live on a sibling table, are per-privilege-tier, and do not reach the line items",
  "packages/db/test/ledger.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-031" };
    for (const [period, date] of [[a.closedPeriod, "2026-02-10"], [a.lockedPeriod, "2026-03-10"]] as const) {
      const doc = await draftDocument(db, a, { periodId: period, effectiveDate: date, clientRef: await uuidv7(db.admin) });
      await expect(withTenant(rw, ctx, (tx) => postLines(tx, a, doc,
        [{ account: a.cash, debit: "1" }, { account: a.sales, credit: "1" }], period),
      )).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);            // refused on the LINE, for every privilege tier
    }
  });
```

`tests/regression/legacy-032.test.ts`:

```ts
import { uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-032", "A user can raise a document's approval level above their own",
  "packages/db/test/tenant-isolation.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-032" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'legacy032', 'LEGACY-032')`;
    });

    await expect(withTenant(rw, ctx, (tx) =>
      tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
         values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`,
    )).rejects.toThrow(/ERR_RBAC_SELF_GRANT/);              // a principal cannot widen its own authority
  });
```

`tests/regression/legacy-033.test.ts`:

```ts
import { lintSchema } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-033", "Confidentiality levels are a read-time display filter with a caller-supplied off switch",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.rule === "extra_permissive_policy")).toEqual([]);
    // A PERMISSIVE gate would be OR-ed away by tenant_isolation; every gate is AS RESTRICTIVE, so a filter
    // cannot be dropped by the caller — there is no read-time switch to supply (plan0A:2611, 2753).
    const permissive = await db.admin<{ tablename: string; policyname: string }[]>`
      select tablename, policyname from pg_policies where schemaname = 'app' and permissive = 'PERMISSIVE'
         and policyname not like '%tenant_isolation%' and policyname not like 'principal_%'`;
    expect(permissive).toEqual([]);
  });
```

`tests/regression/legacy-040.test.ts`:

```ts
import { uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-040", "Deletions are logged less reliably than inserts, and can erase the document header",
  "packages/db/test/audit.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-040" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'legacy040', 'LEGACY-040')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
    });

    // role_permission is one of the three tables app_rw may DELETE (contracts §3.5.4) — so the delete path is
    // reachable, and it is audited exactly as the insert was, with the row's prior image.
    await withTenant(rw, ctx, (tx) =>
      tx`delete from app.role_permission where tenant_id = ${a.tenant} and role_id = ${roleId}`);

    const [row] = await db.admin<{ action: string; before: unknown; actor_id: string }[]>`
      select action, before, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'role_permission' order by seq desc limit 1`;
    expect(row!.action).toBe("delete");
    expect(row!.before).not.toBeNull();
    expect(row!.actor_id).toBe(a.human);
  });
```

`tests/regression/legacy-041.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";

thinRegression("LEGACY-041", "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "packages/db/test/ledger.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-041" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) => postLines(tx, a, doc,
      [{ account: a.cash, debit: "10" }, { account: a.sales, credit: "10" }]));

    // Braces: the trigger refuses even the schema owner. Belt: app_rw has no privilege at all.
    await expect(db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`delete from app.ledger_entry where document_id = ${doc}`;
    })).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(rw, ctx, (tx) =>
      tx`delete from app.ledger_entry where document_id = ${doc}`)).rejects.toThrow(/permission denied/);

    const [c] = await withTenant(rw, ctx, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where document_id = ${doc}`);
    expect(c!.n).toBe(2);
  });
```

`tests/regression/legacy-042.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-042", "Ownership and paid-record checks fail open when the user row is missing",
  "packages/db/test/ledger.test.ts", async ({ rw, a, withTenant, expect }) => {
    const GHOST = "00000000-0000-7000-8000-0000000042ff";
    // The predicate answers about a principal that does not exist: FALSE, never NULL, never true. A missing user
    // row closes the door instead of opening it (plan0A:985–1004 — actor_has never fails open).
    const [ghost] = await withTenant(rw, { tenantId: a.tenant, actorId: GHOST, requestId: "legacy-042" }, (tx) =>
      tx<{ company: boolean; branch: boolean; unknown_code: boolean }[]>`
        select app.actor_has('admin.user.manage', ${a.company})            as company,
               app.actor_has('admin.user.manage', ${a.company}, ${a.hq})   as branch,
               app.actor_has('admin.never.granted', ${a.company})          as unknown_code`);
    expect(ghost).toEqual({ company: false, branch: false, unknown_code: false });
    // false, never null: `expect(x).toBe(false)` would pass on null under a loose check, so the whole row is
    // compared. Company-wide, branch-scoped and unknown-code all close, which is what "never fails open" means.
  });
```

`tests/regression/legacy-044.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-044", "Session records are caller-controlled and attributable to the wrong user",
  "packages/db/test/audit.test.ts", async ({ db, rw, a, b, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-044" };
    // The statement supplies another tenant's principal as created_by; the stamp trigger overwrites it from the
    // session, so a DEFAULT is not the only control and a caller cannot mis-attribute a write (plan0A:2365).
    await withTenant(rw, ctx, (tx) =>
      tx`insert into app.company (tenant_id, code, name, base_currency, created_by)
         values (${a.tenant}, 'LEGACY044', 'LEGACY-044', 'MYR', ${b.human})`);

    const [row] = await db.admin<{ created_by: string }[]>`
      select created_by from app.company where tenant_id = ${a.tenant} and code = 'LEGACY044'`;
    expect(row!.created_by).toBe(a.human);

    await expect(withTenant(rw, ctx, (tx) =>
      tx`update app.company set created_by = ${b.human} where tenant_id = ${a.tenant} and code = 'LEGACY044'`,
    )).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
  });
```

`tests/regression/legacy-050.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-050", "NULL dimension values make aggregates accumulate orphans and lose all decrements",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'ledger_entry_dimension' order by column_name`;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName["dimension_value_id"]).toBe("NO");
    expect(byName["dimension_type_id"]).toBe("NO");         // a NULL dimension cannot enter the join table at all

    const fks = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'ledger_entry_dimension' and c.contype = 'f'`;
    expect(fks.length).toBeGreaterThan(0);                  // and every value is a real row, not free text
  });
```

`tests/regression/legacy-051.test.ts`:

```ts
import { draftDocument, uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-051", "Document numbering races on first use, has no uniqueness constraint, and cannot be gapless",
  "packages/db/test/documents.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-051" };
    const first = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    const second = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });

    await withTenant(rw, ctx, (tx) =>
      tx`update app.document set number = 90001, fiscal_period_id = ${a.period} where id = ${first}`);
    await expect(withTenant(rw, ctx, (tx) =>
      tx`update app.document set number = 90001, fiscal_period_id = ${a.period} where id = ${second}`,
    )).rejects.toThrow(/duplicate key|unique/i);            // unique (company_id, series, fiscal_period_id, number)

    // And the gap is explainable rather than mysterious: a number issued and never posted has a row of its own.
    const [voidTable] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'document_number_void'`;
    expect(voidTable!.n).toBe(1);
  });
```

`tests/regression/legacy-053.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-053", "Runtime DDL disables integrity machinery mid-transaction",
  "packages/db/test/privileges.test.ts", async ({ rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-053" };
    const [create] = await withTenant(rw, ctx, (tx) =>
      tx<{ ok: boolean }[]>`select has_schema_privilege('app_rw', 'app', 'create') as ok`);
    expect(create!.ok).toBe(false);                         // the app role owns nothing and can create nothing

    // Literal tagged templates, one per statement: `sql.unsafe` has exactly three homes and none of them is a
    // test (contracts §3.3, hazard 21), and DDL text cannot be a bind parameter in any case.
    await expect(withTenant(rw, ctx, (tx) => tx`alter table app.company disable trigger all`))
      .rejects.toThrow(/must be owner|permission denied/i);
    await expect(withTenant(rw, ctx, (tx) => tx`alter table app.ledger_entry disable row level security`))
      .rejects.toThrow(/must be owner|permission denied/i);
    await expect(withTenant(rw, ctx, (tx) => tx`drop trigger audit_row on app.company`))
      .rejects.toThrow(/must be owner|permission denied/i);
    await expect(withTenant(rw, ctx, (tx) => tx`create table app.sneaky (id uuid)`))
      .rejects.toThrow(/permission denied/i);
  });
```

`tests/regression/legacy-070.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-070", "Index coverage is thin on exactly the columns reports filter by",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const idx = await db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry'`;
    expect(idx.map((i) => i.indexname)).toContain("ledger_entry_account_date_idx");

    // The columns the §4.16 reports filter by are covered by real indexes rather than by pinned plans: the
    // ledger by (company_id, account_id, effective_date) and (company_id, effective_date), the document by its
    // numbering tuple. Coverage is the fix; LEGACY-068's plan pinning was the workaround for its absence.
    expect(idx.map((i) => i.indexname)).toContain("ledger_entry_company_date_idx");
    const docIdx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'document'`;
    expect(docIdx.some((i) => /company_id.*series.*fiscal_period_id.*number/s.test(i.indexdef))).toBe(true);
  });
```

`tests/regression/legacy-072.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-072", "Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const [checks] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint c join pg_class t on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = 'app' and c.contype = 'c'`;
    expect(checks!.n).toBeGreaterThan(0);

    // Mutually exclusive states are one discriminator (an enum or a CHECK), never a fan of booleans.
    const [accountType] = await db.admin<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'type'`;
    expect(accountType!.udt_name).toBe("account_type");

    // `AccTypes` carried thirty booleans and zero CHECKs. `app.account` carries exactly one — `is_group`, which
    // is genuinely two-valued and orthogonal to `type` — and its five mutually exclusive states are the enum.
    const accountBooleans = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and data_type = 'boolean' order by column_name`;
    expect(accountBooleans.map((c) => c.column_name)).toEqual(["is_group"]);

    // And no column encodes an amount as a float, which is the same class of untyped defect (spec:2041).
    const floats = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and data_type in ('real', 'double precision')`;
    expect(floats).toEqual([]);
  });
```

`tests/regression/legacy-073.test.ts`:

```ts
import { lintSchema } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-073", "Referential integrity is enforced inconsistently for the same logical relationship",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.rule === "composite_fk")).toEqual([]);
    // Every tenant-scoped reference is the composite (tenant_id, x) form, so the same logical relationship is
    // enforced the same way everywhere; only tenant, principal and permission take a plain FK (contracts §4.1).
    expect(violations).toEqual([]);
  });
```

`tests/regression/legacy-074.test.ts`:

```ts
import { lintSchema } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-074", "42 of 460 tables have no primary key",
  "packages/db/test/schema-lint.test.ts", async ({ db, expect }) => {
    const noPk = await db.admin<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind = 'r'
         and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')
       order by c.relname`;
    expect(noPk.map((t) => t.relname)).toEqual([]);
    expect((await lintSchema(db.admin)).filter((v) => v.rule === "id_column")).toEqual([]);
  });
```

`tests/regression/legacy-080.test.ts`:

```ts
import { discover, listApplied } from "@dulja/db";
import { MIGRATIONS_DIR } from "@dulja/db/test";
import { existsSync } from "node:fs";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-080", "Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers",
  "packages/db/test/migrate.test.ts", async ({ db, expect }) => {
    const applied = await listApplied(db.migrator);
    expect(applied).toEqual([...applied].sort((x, y) => x - y));
    expect(new Set(applied).size).toBe(applied.length);     // one monotonic version, not thousands of counters

    const migrations = discover(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) expect(existsSync(m.downPath)).toBe(true);   // every step is reversible, in place

    const known = new Set(migrations.map((m) => m.version));
    for (const v of applied) expect(known.has(v), `applied migration ${v} has no file`).toBe(true);
  });
```

- [ ] **Step 5: Write the six structural files (contracts §3.7.3 — facts 0A fixed without a dedicated test)**

`tests/regression/legacy-023.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-023", "Audit sequence numbers are renumbered retroactively and collide across document classes",
  "packages/db/test/audit.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-023" };
    const seqOf = async (): Promise<number> => {
      const [row] = await db.admin<{ seq: string }[]>`
        select coalesce(max(seq), 0)::text as seq from app.audit_log where tenant_id = ${a.tenant}`;
      return Number(row!.seq);
    };
    const before = await seqOf();
    await withTenant(rw, ctx, (tx) =>
      tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY023A', 'A', 'MYR')`);
    const mid = await seqOf();
    await withTenant(rw, ctx, (tx) =>
      tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'LEGACY023B', 'B', 'MYR')`);
    const after = await seqOf();
    expect(mid).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(mid);                     // one ascending stream, never renumbered

    // `seq` is a generated identity: nothing can supply or rewrite it, so it cannot be renumbered afterwards,
    // and it is one stream per table — not one per document class that could collide with another.
    const [identity] = await db.admin<{ is_identity: string; is_generated: string }[]>`
      select is_identity, is_generated from information_schema.columns
       where table_schema = 'app' and table_name = 'audit_log' and column_name = 'seq'`;
    expect(identity!.is_identity).toBe("YES");
    const [priv] = await db.admin<{ upd: boolean }[]>`
      select has_column_privilege('app_rw', 'app.audit_log', 'seq', 'update') as upd`;
    expect(priv!.upd).toBe(false);
  });
```

`tests/regression/legacy-045.test.ts`:

```ts
import { uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-045", "Department scoping is a report parameter, not an access control",
  "packages/db/test/tenant-isolation.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-045" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'legacy045', 'LEGACY-045')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });

    // Branch scope is data on the assignment (role_assignment_branch), read by the same predicate every route
    // uses — not a parameter a report could pass differently. No branch row means company-wide.
    const [wide] = await withTenant(rw, ctx, (tx) =>
      tx<{ ok: boolean }[]>`select app.actor_has('admin.audit_log.read', ${a.company}, ${a.hq}) as ok`);
    expect(wide!.ok).toBe(true);

    const otherBranch = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
               values (${otherBranch}, ${a.tenant}, ${a.branchType}, 'LEGACY045B', 'Other branch')`;
      // The branch row carries the assignment's whole natural key — role_assignment has no surrogate id
      // (plan0A: primary key (principal_id, role_id, company_id, branch_id), composite FK back to it).
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company}, ${a.hq})`;
    });

    const [narrowed] = await withTenant(rw, ctx, (tx) =>
      tx<{ hq: boolean; other: boolean }[]>`
        select app.actor_has('admin.audit_log.read', ${a.company}, ${a.hq})         as hq,
               app.actor_has('admin.audit_log.read', ${a.company}, ${otherBranch})  as other`);
    expect(narrowed).toEqual({ hq: true, other: false });   // scoping is enforced, not merely displayed
  });
```

`tests/regression/legacy-065.test.ts`:

```ts
import { AUDIT_EXEMPT, lintSchema } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-065", "Unreachable dead code in the audit trigger",
  "packages/db/test/audit.test.ts", async ({ db, expect }) => {
    // One generic trigger function, attached by one procedure, with no per-table branches to go stale: there is
    // no branch to become unreachable. Every non-exempt table carries it, and the linter says so.
    expect((await lintSchema(db.admin)).filter((v) => v.rule === "audit_trigger")).toEqual([]);

    const fns = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname like 'audit%' order by p.proname`;
    // Containment, not equality: later slices may add an audit helper and cannot edit this block (§3.7.3).
    for (const name of ["audit_chain", "audit_row"]) expect(fns.map((f) => f.proname)).toContain(name);

    const attached = await db.admin<{ relname: string }[]>`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and t.tgname = 'audit_row' and not t.tgisinternal order by c.relname`;
    expect(attached.length).toBeGreaterThan(0);
    for (const r of attached) expect(AUDIT_EXEMPT.has(r.relname)).toBe(false);
  });
```

`tests/regression/legacy-071.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-071", "Tree-integrity checks run a recursive procedure per row inside triggers",
  "packages/db/test/schema-lint.test.ts", async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-071" };
    // No trigger on a hierarchical table calls a recursive routine: the only triggers are the generic audit,
    // stamp and immutability ones. A tree is read with a recursive CTE at query time, never validated row by
    // row inside a write path.
    const triggers = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relname = 'account' and not t.tgisinternal order by t.tgname`;
    for (const t of triggers) expect(t.tgname).toMatch(/^(audit_row|stamp_[a-z_]+|account_immutable)$/);

    // Scoped to TRIGGER functions, not to every routine: a recursive CTE in a report or a service function is
    // fine and later slices will write them — the defect was running one per row inside a write path.
    const recursive = await db.admin<{ proname: string }[]>`
      select distinct p.proname from pg_trigger t
        join pg_proc p on p.oid = t.tgfoid
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and not t.tgisinternal
         and (p.prosrc ~* 'with recursive' or p.prosrc ~* 'perform app\.[a-z_]*tree')`;
    expect(recursive).toEqual([]);

    // And the read path that needs the tree is a single recursive CTE, planned once by Postgres.
    const rows = await withTenant(rw, ctx, (tx) => tx<{ id: string; depth: number }[]>`
      with recursive tree as (
        select id, parent_id, 0 as depth from app.account where parent_id is null
        union all
        select a.id, a.parent_id, tree.depth + 1 from app.account a join tree on a.parent_id = tree.id)
      select id, depth from tree order by depth, id`);
    expect(Array.isArray(rows)).toBe(true);
  });
```

`tests/regression/legacy-075.test.ts`:

```ts
import { thinRegression } from "../support/regression";

thinRegression("LEGACY-075", "Deployment template placeholders were never substituted in shipped objects",
  "packages/db/test/privileges.test.ts", async ({ db, expect }) => {
    const objects = await db.admin<{ kind: string; name: string }[]>`
      select 'relation' as kind, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('app', 'app_meta') and c.relkind in ('r', 'v', 'i', 'S')
      union all
      select 'routine', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('app', 'app_meta')`;
    expect(objects.filter((o) => /%|\$\{|<name>/i.test(o.name))).toEqual([]);

    const bodies = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'app_meta') and p.prosrc like '%"%Name%"%'`;
    expect(bodies).toEqual([]);

    // Every object states its own identity, so grepping a name finds the definition and not only the call sites.
    expect(objects.every((o) => /^[a-z][a-z0-9_]*$/.test(o.name) || o.kind === "relation")).toBe(true);
  });
```

`tests/regression/legacy-087.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../support/source";

/** A source-only fact: nothing about a developer's machine may be readable from a shipped file. */
describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0B", () => {
  it("no shipped source contains an absolute developer path", () => {
    const PATTERNS = [/[A-Za-z]:\\\\?(?:Users|Documents|Projects|Dev)\b/i, /\/(?:Users|home)\/[a-z0-9._-]+\//i, /\/mnt\/[cd]\//i];
    const offenders = sourceFiles()
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .filter((l) => PATTERNS.some((p) => p.test(l.text)));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text.trim()}`)).toEqual([]);
  });

  it("every path a shipped file resolves is relative to the module or to a named environment variable", () => {
    const resolvers = sourceFiles().filter((f) => /\bjoin\(|\bresolve\(/.test(f.text));
    for (const f of resolvers) {
      // `import.meta.url`, `process.cwd()` or an env value — never a literal root.
      const literalRoots = f.lines.filter((l) => /\b(join|resolve)\(\s*["'`]\//.test(l));
      expect(literalRoots, f.path).toEqual([]);
    }
  });
});
```

- [ ] **Step 6: Run the whole `tests` workspace**

Run: `bun run --cwd tests test`

Expected: **PASS — 45 files**. Two invariant files (Task 13) and forty-three regression files: 16 full (`legacy-025, 026, 027, 028, 034, 035, 036, 037, 043, 047, 068, 069, 078, 082, 083, 084`), 21 thin (`legacy-003, 012, 013, 021, 029, 030, 031, 032, 033, 040, 041, 042, 044, 050, 051, 053, 070, 072, 073, 074, 080`), 6 structural (`legacy-023, 045, 065, 071, 075, 087`). **Four** Testcontainers starts for the whole run — `sharedDb()`, `sharedApi()`, and one for each of the two invariant suites — and the run reports `@dulja/tests`.

If a full file fails with `relation "app.company" does not exist`, the file has mixed `sharedApi()` with `sharedDb()`: they are different databases (Step 1's header comment). If a thin file fails with `duplicate key value violates unique constraint` on `app.company`, two files chose the same `code` literal — every file's literals are `LEGACY<nnn>`-prefixed for exactly this reason, because all twenty-seven thin and structural files share one database and one pair of tenants.

- [ ] **Step 7: Verify the count and the naming rule**

```bash
ls tests/regression/*.test.ts | wc -l
ls tests/regression/ | grep -v '^legacy-[0-9]\{3\}\.test\.ts$' || true
grep -L 'describe(' tests/regression/*.test.ts || true
```

Expected: `43`; the second command prints nothing (no suffixed names — `legacy-009-pos.test.ts` is forbidden by contracts §3.7.3, and `.gitkeep` is gone); the third prints nothing directly and every file reaches a `describe` through `thinRegression` or `fullRegression`.

```bash
test ! -e tests/regression/legacy-024.test.ts && echo "legacy-024 correctly absent (1A creates it)"
```

Expected: `legacy-024 correctly absent (1A creates it)`.

- [ ] **Step 8: Commit**

```bash
git rm --cached tests/regression/.gitkeep
rm -f tests/regression/.gitkeep
git add tests/support tests/regression
git commit -m "$(cat <<'EOF'
test(regression): the forty-three legacy-NNN files this slice creates [0B T14]

16 full scenarios through the HTTP surface, 21 thin re-runs of Plan 0A data-layer
proofs through the production withTenant, 6 structural facts. Contracts §3.7.3:
0B is first in execution order for all forty-three; later slices append a
describe block and never edit these. legacy-024 is 1A's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `CLAUDE.md` — the "Current phase" section

Contracts §3.8: the last task of a slice that completes a phase rewrites "Current phase", and **0B's last task rewrites it to name 0B, 0D, 0C, 0E**. 0B does not complete Phase 0 — 0D, 0C and 0E follow — so the section says which slice is done and which are open, and it does not claim the phase gate.

**Files:**
- Modify: `CLAUDE.md` (the "Current phase" section only — no other section of that file is touched by this slice)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing an executor imports. The section's headings (`## Current phase`) are the anchor the PR template checks (plan0A:2872 — "This PR belongs to the phase named in `CLAUDE.md`").

- [ ] **Step 1: Replace the section**

`CLAUDE.md` currently reads, exactly as Plan 0A Task 12 left it (plan0A:2903–2908):

```markdown
## Current phase
**Phase 0 — Foundations.** Plan 0A (`docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md`) is complete: monorepo, migration 0001, schema linter, CI.
Next: Plan 0B (identity, tenant transactions, errors, idempotency, permission catalogue), then 0D (`Money`, currency, dimensions, pg-boss), 0C (Supabase, Cloudflare, bootstrap seed, observability) and 0E (Electron and i18n shell, back office). All of them, and every phase after, are already written: see the plan catalogue and the frozen cross-plan contracts in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.
Phase 0 exits only when every §5.0 row is green and acceptance tests 12, 13, 14 pass in CI.
```

Replace those five lines — heading included, nothing above or below — with:

```markdown
## Current phase
**Phase 0 — Foundations.** Plan 0A (`docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md`) and Plan 0B (`docs/superpowers/plans/2026-09-05-dulja-phase-0b-api-core-identity.md`) are complete: monorepo, migrations 0001–0002, schema linter, CI; and the API core — `createDb` / `withTenant` / `resolvePrincipal`, the Hono app with its fixed middleware chain, RFC 9457 problems from one `ERR_*` registry, `Idempotency-Key`, the permission catalogue and `requirePermission`, the admin endpoints (users, roles, role assignments, companies, audit log), the generated `packages/contracts/openapi.json`, `bun run lint:rules`, and the root `tests/` workspace with the tenant-isolation and auth-bypass invariant suites.
Open in this phase: **0D** (`Money`, currency, dimensions, custom fields, the pg-boss adapter and its handlers), **0C** (Supabase and Cloudflare provisioning, the bootstrap seed pack, observability) and **0E** (the Electron and i18n shell, the back office). All of them, and every phase after, are already written: see the plan catalogue and the frozen cross-plan contracts in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.
Phase 0 exits only when every §5.0 row is green and acceptance tests 12, 13, 14 pass in CI. **0B does not exit the phase**: it owns tests 11, 12, 13 and 27; **test 14 ("Permission query") is 0D's** (contracts §6.1), and test 12's job half needs 0D's pg-boss handlers.

**Working on a Phase 0 slice?** Read the slice's card in the contracts document (§2) before its plan: the card, not the plan, is the authority on migration numbers, ADR numbers, owned tests and shared-namespace entries.
```

- [ ] **Step 2: Verify**

```bash
grep -n -A 6 '^## Current phase' CLAUDE.md
```

Expected: the new text, with `0A` and `0B` named as complete and `0D`, `0C`, `0E` named as open. No other section of `CLAUDE.md` differs — confirm with `git diff --stat CLAUDE.md`, which must report one file changed and no more than the lines of this section.

- [ ] **Step 3: Run the full gate one last time**

```bash
bun run lint && bun run format:check && bun run lint:rules && bun run typecheck && bun run test
```

Expected: all green. `lint:rules` prints `5 rules, <n> files, 0 violations`. The test run reports `@dulja/db` (nine files plus 0B's four: `client`, `with-tenant`, `schema-mirror`, `permission-catalogue`), `@dulja/contracts`, `@dulja/api` and `@dulja/tests` (45 files). `git diff --exit-code -- packages/contracts/openapi.json` is clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md current phase names 0B complete, 0D/0C/0E open [0B T15]

Contracts §3.8: 0B's last task rewrites the section. 0B does not exit Phase 0.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Then — **only if the owner has asked for it** — push and open the PR against the template of plan0A:2868–2880. Pushing is the owner's call and is not part of this plan's definition of done (plan0A:2927).

---

## Self-Review

Run against the contracts card for 0B (§2, lines 44–74), the spec sections the card lists, and the writing-plans skill. Findings were fixed inline; what follows is the evidence.

**1. Card "Delivers" coverage — every bullet maps to a task.**

| Card bullet | Task |
|---|---|
| `apps/api` Hono app, `/healthz`, `/v1` prefix, request-id, structured logger with the four fields, forbidden-field lint | T4 (app, `/healthz`, request-id, logger middleware), T3 (`createLogger`), T12 (`forbidden-log-fields`) |
| `packages/contracts` skeleton (`common.ts`, `errors.ts`, `permissions.ts`) | T3 (`common.ts`, `errors.ts`, `logger.ts`), T7 (`permissions.ts`) |
| OpenAPI generated, committed to `packages/contracts/openapi.json`, diffed in CI | T11 |
| `createDb(url)` refusing 6543; production `withTenant`; `TenantContext`; the `./test` subpath | T2 (`createDb`, `withTenant`, `TenantContext`), T1 (`./test` subpath) |
| generalising `privileges.test.ts` per §3.4.6 | T1 |
| identity chain: JWKS, `resolve_principal`, membership rejection, `aal2` gate with the exemption | T5 (**the OD-01 / OD-02 gate task**) |
| invite endpoint creating principal + membership in one transaction, no `RETURNING` | T8 |
| RFC 9457 envelope, `ERR_*` registry, `check_violation` → problem, "a code no code raises fails the build" | T3 (envelope + registry + `fromDatabaseError`), T12 (`error-codes` rule) |
| `Idempotency-Key` middleware with the §4.2.9 409 semantics | T6 |
| `permissions.ts` with the five `admin.*` codes; migration `0002_seed_permission_phase0.sql`; `requirePermission`; the `ROUTES` registry | T7 (catalogue, migration, `requirePermission`), T4 (`ROUTES`) |
| admin endpoints: users, roles, role assignments and branch rows, companies, audit-log read | T8, T9, T10 |
| root `tests/` workspace added to `workspaces`; the isolation harness (test 12) and bypass suite (test 11); `scripts/lint/` wired into `lint:rules` and CI | T13, T12 |
| thin regression files for the Plan 0A-proven defects (§3.7.3) | **T14** |
| `CLAUDE.md` "Current phase" rewritten | **T15** |

**2. Definition of done — the card's verbatim clauses.** "Users invited" → T8 (`POST /v1/admin/users`, asserted end-to-end). "Roles assigned" → T9 (`/v1/companies/{companyId}/role-assignments`). "Every write audited with server-supplied actor" → T10's acceptance-test-13 case plus T14's `legacy-029`, `legacy-030`, `legacy-040`, `legacy-044`. "The tenant-isolation suite passes against every endpoint" → T13, which fails the build when a `ROUTES` entry has no `PROBES` entry. The whole of the §5.0 row 0.6 cell — "connected as `app_rw` with no `set_config`, `resolve_principal(<subject>)` returns one row while `select * from app.principal` returns none" — is the last `it` of T13's `auth-bypass.test.ts`, repeated from the other side in T14's `legacy-026` and `legacy-043`.

**3. Acceptance tests owned.** 11 → T13 `auth-bypass.test.ts` (nine bypass shapes) with T14's `legacy-025`, `legacy-026`, `legacy-027`, `legacy-035`, `legacy-043` re-attempting them one defect at a time. 12 → T13 `tenant-isolation.test.ts` over `ROUTES` and `JOBS`. 13 → T10 (`renaming a company writes an audit row with the server-supplied actor`) and T14's `legacy-029`/`legacy-040`. 27 → T12 (`no-sql-concat`, `no-bare-db`) with T14's `legacy-036` running the rule over the real tree. **Re-runs: none**, as the card states.

**4. Owner gates.** OD-01 and OD-02 are **one** task — T5 — and no other task states an assumption about either. Neither blocks merge (§2.12 default "as built"). The rejection consequences are written in the header's Owner-decisions bullet and repeated in T5. OD-24 does not apply: 0B ships no screen. No other OD item is mentioned anywhere in this plan, which is correct — hazard 6 forbids spreading a ⚠️ item across tasks.

**5. Hazards (contracts §5) checked one by one.** #1, #2, #3: no statutory rate, no MyInvois detail, no Firebird assumption appears anywhere in this plan — a text search for `EPF`, `SOCSO`, `PCB`, `MyInvois`, `LHDN`, `gbak`, `Firebird` finds nothing outside the Part I defect headings quoted in T14, which are descriptions of the legacy system and state no rate. #5: no owner-account task — 0B provisions nothing. #8: every Plan 0A name is used exactly as §4.1 spells it, and the two `withTenant`s are kept apart (#15) — `packages/db/test/**` uses the 4-argument test helper, `tests/**` and `apps/**` use the production 3-argument one. #9: `fixtures.ts` is not modified by any task. #10: migration 0002 writes only `app.permission`, the one global table. #11: no enum label is added. #12: T1 generalises the reversibility test before migration 0002 exists (T7). #13: `lint-schema.ts` set membership is unchanged — 0B adds no table. #14: migration 0002 and ADRs 0003–0006 are exactly the allocated ranges, and 0003 is deliberately left unused. #21: this slice writes **no** new `sql.unsafe` call site — `packages/db/src/migrate.ts` and `jobs/enqueue.ts` are Plan 0A's and 0D's, and T14's `legacy-053` was rewritten to use literal tagged templates rather than `.unsafe`. The one correction the audit forced (§8c below): Plan 0A's `packages/db/test/harness.ts` and `roles.test.ts` each call `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` (plan0A:476, 553), so "three homes" was already false in the tree this slice inherits; both are on T12's `UNSAFE_ALLOW` and `harness.ts` is in `legacy-036`'s subset. #26: the five codes are exactly spec:2146–2150's `admin.*` set — no code is invented. #27: no `service` principal kind. #31: every `ROUTES` entry has a `PROBES` entry and the harness fails the build otherwise. #32: the shared-namespace bullet in the header names all five registers, and the only one this slice writes is `ERR_*` — exactly the twenty-five §4.2.4 assigns it, verified by counting `Object.keys(ERRORS)` in T14's `legacy-083`. #35: no placeholder (see 7 below).

**6. Type and name consistency across tasks.** `createApp(deps: AppDeps)` with the five members is fixed in T4 and every later task constructs the same object. `ScopeSource`'s four variants are declared in T7 and only those four are used in T8–T10. `thinRegression(legacyDefect, heading, cites, body)` is four-argument in T13's implementation, in T13's Produces block (corrected) and in all twenty-seven T14 call sites. `ThinContext` is `{ db, rw, a, b, withTenant, expect }` in T13 and every T14 thin file destructures a subset of exactly those names. `FullContext` is `{ api, a, b, expect }` in T14's `tests/support/api.ts` and every full file destructures a subset of exactly those. `Seed` fields used in T14 — `tenant`, `system`, `human`, `company`, `period`, `closedPeriod`, `lockedPeriod`, `cash`, `sales`, `policy`, `branchType`, `hq` — are all in contracts §4.1's list. Every `ERR_*` string asserted in T14 is one of the twenty-five defined in T3. `RouteModule.permissions` (not `permission`) is what T14's `legacy-047` reads, matching T4.

**7. Placeholder scan.** `grep -nE "TBD|TODO|implement later|fill in|similar to Task|and so on|add appropriate|handle edge cases"` over this file returns **zero** matches outside this sentence and the No-Placeholders reminder in the Global Constraints table. Every code step carries the code; every command step carries the command and its expected output. The four `<fill at execution — Step 8>` slots in ADR-0005 are the single deliberate exception, and they are labelled as such: contracts Appendix A #3 forbids writing a vendor's JWKS path or invite path from memory, so Task 5 Step 8 fetches the authority's current documentation and fills them in. Every remaining `…` in this file is a spread operator, a real ellipsis inside English prose, or an elision inside a comment whose subject is spelled out in full at the step that writes it.

**8. Fixed inline during review.**
- The header's File-structure column said `T14` / `T15` for files that Tasks 11, 12 and 13 actually own (the writer merged role assignments into T9, shifting every later number by one). Corrected throughout, and `tests/support/api.ts` added to the tree.
- Header assumption 9 claimed "two Plan 0A files are edited, and only two" while T1, T12, T13 and T15 also touch `packages/db/package.json`, `packages/db/src/index.ts`, root `package.json`, `ci.yml` and `CLAUDE.md`. Reworded to "two Plan 0A **test** files", with the repository-level additive extensions listed.
- Header assumption 10 claimed one shared container for the whole `tests` run, which the two invariant suites (each calling `startApi()`) already contradicted, and `sharedApi()` adds a third. Reworded with the warning that `sharedDb()` and `sharedApi()` are different databases; the count itself is corrected to four two bullets below.
- T13's Produces block declared `thinRegression(n, heading, body)` — three arguments — against its own four-argument implementation. Corrected.
- T14's `legacy-047` first drafted its "every code gates a route" assertion against a served `/openapi.json`, which no task mounts; rewritten against `ROUTES` from `@dulja/api`, the entry T13 already established.
- T14's `legacy-053` first used `tx.unsafe(ddl)` in a loop, against hazard 21; rewritten as four literal tagged templates.
- T14's `legacy-021` first read `pg_attrdef` through a four-way join and asserted `information_schema.sequences` is empty — which `audit_log.seq bigint generated always as identity` (plan0A:2261) makes false. Rewritten against `information_schema.columns.column_default` and `is_identity`.
- T14's `legacy-070` first asserted that `tenant_id` leads an index on every tenant-scoped table, which `document_series` (PK `(company_id, series, fiscal_period_id)`) and `ledger_entry_dimension` (PK `(entry_id, dimension_type_id)`) falsify. Rewritten against the two named ledger indexes and the document numbering index.
- T14's `legacy-072` first asserted no table has more than three boolean columns, which nothing in migration 0001 guarantees. Rewritten against `app.account` (zero booleans, an `account_type` enum) and the absence of any `real`/`double precision` column.
- T14's `legacy-042` first asserted `actor_has` is false for the seeded human, which depends on what `seedTenant` grants — unstated in §4.1. Rewritten to compare the whole row for a principal that provably does not exist, across company-wide, branch-scoped and unknown-code forms.
- T14's `legacy-034` first called `app.actor_has` from `db.admin`, outside any `withTenant` transaction — where `app.current_actor()` has no value and the statement, not the assertion, would fail. Rewritten to assert the catalogue and its foreign key from the catalog, and to prove enforcement through the HTTP path in the same file's second case. **The rule this makes general: no test calls `actor_has`, `current_actor` or `current_tenant` outside a `withTenant` body.**
- T14's `legacy-045` first inserted `app.role_assignment_branch (tenant_id, role_assignment_id, branch_id)`; that table has no surrogate key — its columns are `(tenant_id, principal_id, role_id, company_id, branch_id)` with a composite FK back to `role_assignment` (plan0A). Corrected.
- T14's `legacy-030` folded `set_config('session_replication_role', 'replica', true)` into the transaction that then inserts a company. That parameter is **superuser-only**: `app_rw` gets `permission denied to set parameter`, the transaction aborts, and the audit assertion never runs. Split into its own `rejects.toThrow(/permission denied/i)` — which is the stronger regression anyway, because it is the one real Postgres trigger-silencer and it is closed to the app role.
- T14's `legacy-036` walked `scripts/` looking for `.unsafe(` call sites, which would have matched the **fixture string** inside `scripts/lint/lint.test.ts` (Task 12) — the very file that proves the rule fires. Test files are now excluded from that scan.
- T14's `legacy-071` searched every `app` routine for `with recursive`; a later slice's report function would falsify it. Scoped to trigger functions, which is the actual claim ("per row inside triggers").
- T14's `legacy-072` asserted `app.account` has **no** boolean column; it has one, `is_group` (plan0A). Corrected to exactly `["is_group"]`, with the reason it is not a state flag.
- T14's `legacy-082` imported `apps/api/src/config` by relative path, against contracts §3.1 ("through its package entry only") — the rule Task 13 already followed for `ROUTES`. `apps/api/src/app.ts` now re-exports `readConfig`, `ConfigError` and `ApiConfig`, and the test imports `@dulja/api`.
- Header assumption 10 and Task 14 Step 6 said **three** containers; the two invariant suites each start their own, so the true count is **four**. Corrected in both places.
- The File-structure `ci.yml` row listed T14, which modifies no workflow. Removed.
- Task 15's CLAUDE.md text claimed test 14 is 2B's and about `document_event`. Contracts §6.1 row 14 says **"Permission query", owned by 0D**. Corrected — a wrong ownership statement in the agent entry point misdirects every later session.

**8a. Fixed in the review pass after the first draft.** Each of these was a defect an executor would have hit at a specific step, not a stylistic note.

- **T10 Step 5 did not compile.** The audit-log route's `summary:` string was broken across two physical lines inside double quotes — a syntax error on the first `bun run typecheck`. Joined onto one line.
- **`no-sql-concat` reported four production queries this plan writes.** Its template branch exempted only a bare ``tx`…` ``, but every typed query is written ``tx<{ ok: boolean }[]>`…` `` — `tx`, then a generic argument, then the backtick. `require-permission.ts`, `roles.ts` and `companies.ts` (twice) each carried both delimiters and an interpolation on one line and tripped it, so Task 12 Step 6's "0 violations" and Task 15's final gate could not pass. Rewritten to fire on an **untagged** template only — the opening backtick preceded by neither an identifier character nor `>`, `)` or `]` — with the SQL-keyword test applied to the literal's own body rather than to the whole line, so `.update(` on a JavaScript object and a nested ``${`r-${code}`}`` are not statements. Which tag may carry SQL is `no-bare-db`'s question, and saying so once removed the duplication. **Do not "tighten" this back into tag-name matching:** the rule is now silent on every tagged template, which is deliberate. A hostile `` String.raw`select ${x}` `` slips past it — and is caught where it would have to be consumed, by the `.unsafe(` branch, since a plain string cannot reach the driver any other way; `db` and `sql` as tags are `no-bare-db`'s. The guarantee holds by composition of the two rules, and any attempt to make one rule carry both reintroduces the four false positives on this plan's own queries.
- **`no-bare-db` matched nothing anyone writes.** Same root cause from the other side: `` /(db|sql)`/ `` and `/db\.\w+\(/` both demand the backtick or the dot immediately after the identifier, so `` sql<TableRow[]>`…` `` (plan0A:2716–2730) and `` db.admin<Row[]>`…` `` slipped through untouched and spec:2053's mechanical guarantee was a no-op. Both patterns now admit an optional generic argument; `packages/db/src/lint-schema.ts` joins the allow-list because it legitimately reads the catalogue that way; the unit test gained the two typed forms as violations 4 and 5.
- **`dependency-rule` reported every subpath import.** It compared whole specifiers against a tier list of package roots, so `@dulja/contracts/permissions` (six files) and `@dulja/db/test` (every file under `apps/api/test/`) were violations. The specifier is now reduced to its package root before the membership test. The dead `tests` row was deleted rather than repaired: `run.ts` walks apps, packages and scripts only, so it could never match, and a dead row invites a later slice to trust a check that never ran. **Found while verifying that fix, and not on the review list:** the same rule's relative-path branch tested `/\.\.\/(apps|packages)\//` against the specifier text, which the rule's *own* unit-test case — `apps/api/src/app.ts` importing `"../../worker/src/handler"` — does not contain (from `src/`, the escape is `../../worker/`, never `../apps/`), so the case asserted a violation the pattern could never produce and Task 12's suite would have failed. The branch now resolves the specifier against the importing file's directory and asks whether the result still sits under the owner's workspace, which catches every escape and passes every intra-package import; two such imports were added to the case as negatives.
- **`error-codes.ts` used `require()` in an ESM module**, so its own case in `scripts/lint/lint.test.ts` threw `ReferenceError` under Vitest on Node 24 (it worked only under `bun run lint:rules`). Static imports now, with the migrations directory derived from `import.meta.url` as `run.ts` does. In the same pass the exclusion was narrowed from the whole registry file to the `ERRORS` **object literal**, so `fromDatabaseError` — the only raiser of `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE` and `ERR_CONFLICT_REFERENCE` — counts as the raise site it is, instead of those three passing on assertion strings in test files. Header assumption 7 and the fixture were rewritten to match.
- **The invariant suite's job-name assertion failed on the registry it ships.** `/^[a-z_]+\.[a-z_]+\.[a-z_]+$/` requires three segments; the frozen `JOBS` holds `reporting.render`. Relaxed to `{1,2}`.
- **`auth-bypass.test.ts` read `.items` off a 403 body.** Its `beforeAll` seeded two tenants but granted no role, so `GET /v1/companies` answered 403 and the LEGACY-027 case threw a TypeError instead of asserting. It now grants the five admin codes to each tenant's human with the same `grantEverything` shape `tenant-isolation.test.ts` uses — inlined, not imported from `tests/support/api.ts`, which Task 14 has not written yet.
- **`GET /v1/companies/{companyId}` answered 403, not the 404 its own test and probe expected.** Gating a read with `{ company: "path:companyId" }` refuses another tenant's id at the middleware, which tells the caller the id exists. Regated `{ company: "any" }` so the handler runs and RLS produces the 404 the "never a leak" rule wants; `PATCH` keeps `thisCompany`. With the status now honest, the isolation harness asserts `toBe(probe.expect)` instead of `toContain([403, 404])` — the loose form was what let the mismatch hide, and it made `IsolationProbe.expect` dead. The same change repairs a second suite: `companies.test.ts`'s first case creates a company and reads it back, and under `path:companyId` the caller held no assignment in the company it had just created, so the read would have been 403.
- **`legacy-026` asserted a `kind` field the session payload has never had.** `SessionSchema` names it `principalKind`. Corrected.
- **A cross-tenant `principalId` was accepted by the role-assignment handler.** `role_assignment.principal_id` is a plain FK to the global `app.principal` and FK checks bypass RLS (plan0A:1331–1334, 2027), so `assert_assignment_kind` reads zero rows, `v_kind` is NULL, both branches are NULL, and the insert succeeded — while the test asserted 409. A membership pre-check inside the same `withTenant` now raises `ERR_CONFLICT_REFERENCE`, the test asserts the code and that no junk row survives, and Task 9's "the handlers add no checks of their own" is amended to name this one exception.
- **Acceptance test 11 named expiry and issuer but exercised neither.** `tokenFor` always writes `iss: TEST_ISSUER` and `exp: now + 600`. `StartedApi` gains `signToken(claims)` — the same key and `kid`, an arbitrary claim set — and both suites' existing loops gained an expired token and a wrong-issuer token, so no test count moved. Contracts §3.7.2 lists both shapes; nothing proved jose's `exp`/`iss` checks were wired.
- **`AuditLogQuery`'s `sort` rejection was prose only.** Step 5 described adding a `.refine`, no code step performed it, and the injection assertion depended on it. The bound is now in Step 1's schema as `sort: z.string().max(0, …).optional()` — an override on the same key, because `@hono/zod-openapi` generates query parameters from a `ZodObject` and a `.refine` would wrap it in `ZodEffects`, while `.strict()` would break `legacy-036`'s undeclared-key case.
- Smaller: T11 Step 4 said nine unsafe operations where there are ten (now listed by name); `packages/contracts/src/admin/role.ts` imported an unused `ListQuery`, which oxlint's `correctness` set reports; `createApp`'s `defaultHook` took an unused `c`, and the note beside it cited a `noUnusedParameters` option `tsconfig.base.json` does not set; ADR-0003 credited Task 14 with a rule Task 12 writes; Task 7's Produces block spelled `PermissionAction` and `SliceId` with an ellipsis where the plan's own rule wants the text; ADR-0005's four unfilled vendor slots now read `<fill at execution — Step 8>` so they are not mistaken for an unfinished draft; assumption 3 now says outright that the first company and the owner's first `admin` assignment come from 0C's bootstrap seed; and a case titled "a principal without admin.user.manage is refused" whose assertion was `expect([200, 403]).toContain(...)` is retitled to what it proves and asserts the deterministic 200 (`actor_has` short-circuits true for `kind = 'system'`, plan0A:1366–1368).
- **Rejected, with the line that refutes it.** A review note held that `legacy-036`'s first case fails because `sourceFiles()` reaches `scripts/lint/lint.test.ts`, whose fixture string carries SQL. It does reach it — but `no-sql-concat` opens with `if (!/^(apps|packages)\//.test(f.path)) continue;`, so the rule never looks at a `scripts/` path. The `.test.ts` exclusion in the file's *second* case is genuinely needed, because that case greps `f.text` itself instead of going through the rule. The first case is left scanning test files on purpose: that is where a real concatenation would otherwise hide.
- **Recorded, not fixed here.** Every name this slice adds beyond contracts §4 is now listed in header assumption 13, including the ones no assumption previously mentioned. The contracts document is outside this plan's write scope; the amendment is owed before 0C or 0D consumes any of them. The same applies to §3.4.2 / §3.6.3, which spell the permission-seed file `NNNN_seed_permission_phase<n><letter>.sql` while the 0B card and the slice definition both say `0002_seed_permission_phase0.sql`. Both names match `discover()`'s regex so nothing breaks, and this plan follows the card; the contradiction is the contracts document's to settle before 1A writes `phase1a`.

**8b. The containment rule these fixes established.** A 0B regression block is frozen the moment it merges: contracts §3.7.3 lets later slices *append* a `describe` and forbids editing this one. So **a 0B block asserts on objects migration 0001 or 0002 created, or it asserts containment — never schema-wide exact equality on something a later slice will legitimately extend.** Applied to: `ERRORS` (`toContain` each of the twenty-five, not `toHaveLength(25)`, because 0D adds codes), `app` audit functions (`toContain`, not `toEqual`), identity columns (`toContainEqual` plus a targeted absence), `bytea` columns (the two named policy columns, because 8A's `employee_sensitive` envelope is legitimately `bytea` — §4.12.5), credential columns (`principal`/`membership`/`tenant` only, because 6A's `terminal_enrolment` may carry secret material), and `varchar` columns (the seven tables this slice reads). Three schema-wide sweeps are deliberately **kept**, because each is a permanent invariant no slice may ever break: no `real`/`double precision` column anywhere (spec:2041), every `app` table has a primary key, and `lintSchema` reports zero violations (contracts §3.5.2 — "the shipped schema must report zero violations after every migration").

**8c. Fixed in the independent-audit pass (the third review of this file).** An auditor read the plan against the contracts document, Plan 0A and the spec. Each item below was verified at the source it cites before the fix was made.

- **`dependency-rule` flagged the contract-mandated catalogue test, so Task 12 Step 6's "0 violations" could not pass.** `run.ts` collects every `.ts` under `apps`, `packages` and `scripts`, and `dependency-rule` resolves an owner by path prefix with no test-directory carve-out — so `packages/db/test/permission-catalogue.test.ts` (T7 Step 1) importing `@dulja/contracts/permissions` is owned by `packages/db`, whose tier is `["@dulja/domain"]`, and reduced to `@dulja/contracts` it is one violation. Contracts §3.6.3 freezes that path, so the test does not move: the rule gains a **named-allowance set** keyed `<file path>|<package root>` with one entry and the reason on the line — the mechanism §4.17.1 already describes for the `apps/*/test/**` → `tests/invariants/support/**` imports. A blanket `packages/*/test/**` carve-out was rejected: under it `packages/domain/test/x.test.ts` importing `@dulja/db` would pass silently, which is the architecture bug spec:2389 exists to catch. Two cases were added **inside** the rule's existing `it` (the allowed pair green, another file in the same directory still red), so Step 6's "5 tests" is unchanged. The earlier `dependency-rule` fix in §8a corrected subpath imports from `apps/api` and never asked what the rule sees under `packages/*/test/**`.
- **`no-sql-concat` fired on Plan 0A's two `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` sites.** The `.unsafe(` branch's only path filter is `/^(apps|packages)\//`, so test directories are in scope; `[^)]*` captures `readFileSync(ROLES_SQL, "utf8"`, which starts with neither quote nor backtick, and neither `packages/db/test/harness.ts` (plan0A:476) nor `packages/db/test/roles.test.ts` (plan0A:553) was on `UNSAFE_ALLOW`. Two violations on a tree this slice has not touched, breaking Task 12 Step 6, Task 15's final gate and **both** cases of T14's `legacy-036` — case 2's `.test.tsx?$` filter removes `roles.test.ts` but not `harness.ts`. Both paths joined `UNSAFE_ALLOW` with the reason on the line (a checked-in .sql file read from disk is code, not input — the identical case to `migrate.ts`), `legacy-036`'s allowed set gained `packages/db/test/harness.ts` so the two agree, its title no longer claims "exactly the three homes", and the harness form was added to T12 Step 1 as a negative with the unallowed twin as a positive. Plan 0A is immovable, so the allow-lists moved, not the harness.
- **Found while verifying that fix, and not on the auditor's list: `legacy-036`'s second case reported the rule file as a caller of itself.** `sourceFiles()` defaults to `["apps", "packages", "scripts"]` (T14 Step 1), and `scripts/lint/rules/no-sql-concat.ts` contains the literal `.unsafe(` in its own violation message — and now in its allow-list comments too. It is not a `.test.ts`, so the case's `.test.tsx?$` filter does not remove it, and `expect([…the allowed paths]).toContain("scripts/lint/rules/no-sql-concat.ts")` fails: Task 14 Step 6's "PASS — 45 files" was unreachable, and the defect predates this audit — the §8a fix narrowed the *test-file* half of the same scan and never asked about the rule file. The case now calls `sourceFiles(["apps", "packages"])`, which is exactly the tree the rule itself polices (`if (!/^(apps|packages)\//.test(f.path)) continue;`), with the reason on the line. The **first** case is unchanged and still passes `sourceFiles()` with the default roots: it runs the rule, and the rule skips `scripts/` on its own. In the same pass the rule's violation message stopped saying "outside the three allowed homes" (it is five) and two comments stopped citing a plan section by number, which means nothing in a repository file.
- **`fromDatabaseError`'s last line did not compile.** `const sqlstate = typeof err.code === "string" ? err.code : undefined` is `string | undefined`; the four SQLSTATE branches narrow it by `===`, the trailing `return new AppError("ERR_INTERNAL", …, { sqlstate })` does not, and `exactOptionalPropertyTypes: true` (plan0A:274–288) rejects an explicit `undefined` for an optional property — TS2379, with T3 Step 10's typecheck gate stating "Expected: green". Rewritten as a conditional spread rather than by widening the declared type, because contracts §4.2.4 freezes `extra?: Partial<Problem>` and this plan has already widened it once. **The same rule bites a second site the auditor flagged but could not confirm from the plan alone, and it does reproduce:** `startApi`'s `app.request(input.path, { …, body: input.form ?? (… ? undefined : …) })` passes an explicit `undefined` for `RequestInit`'s `body?: BodyInit | null` on every GET. T5 Step 9 now builds the init object with a ternary that omits the key.
- **Tasks 13 and 14 went straight to a green run with no red step.** Both are pure test-authoring tasks over behaviour Tasks 1–12 already shipped, so a pre-write run reports `Cannot find module` and proves nothing. Rather than synthesise a red step that carries no information, each task now states the deviation and names the step that does carry it (T13's coverage gate, both tasks' Step 6). Task 1 Step 3 already explained its own PASS-first shape.
- **The `workspaces` edit moved from Task 12 to Task 13.** Task 12 Step 5 added `"tests"` and Step 7 committed `package.json`, while `tests/package.json` was not created until Task 13 Step 1 — a window, spanning Step 6's `bun run lint:rules`, in which the array names a directory with no manifest. The array now changes in Task 13 Step 1, in the same commit as the manifest; Task 12 keeps only the `lint:rules` script. The File-structure row and Task 13's Modify line say so.
- **Tasks 5, 8, 9 and 10 mounted routes without showing the imports.** Task 8 Step 5's `buildRoutes` body references `createUserRoutes`, `StubAuthAdmin` and the `AuthAdmin` type, none of which `apps/api/src/routes/index.ts` imported after Task 5; Tasks 9 and 10 had the same shape, and Task 5 Step 6 said "add the import and the entry" while showing only the entry. All four steps now list the exact import lines, as Task 5 Step 7 already did for `authenticate`.
- **Task 13's `src/app.ts` re-export omitted `buildRoutes`.** Contracts §4.2.7: "`src/app.ts` re-exports `{ ROUTES, buildRoutes, type RouteModule }`", and `buildRoutes` is the authoritative constructor (§4.18 round 1). All three names are now re-exported.
- **Task 4 Step 11 showed a version of `apps/api/src/index.ts` that cannot compile before showing the correct one** — `export default` inside a `try` — with three instructions about one file in one step, and an `// eslint-disable-next-line` comment in a repository that lints with oxlint. The non-compiling block is deleted; one code block remains, and Task 5 Step 9's back-reference no longer speaks of "the second form".
- **Smaller:** Task 5's heading used an em dash where every other task uses `### Task N:`, so a mechanical `^### Task \d+:` scan found fourteen of fifteen — rewritten as `### Task 5: **OWNER GATE OD-01 / OD-02** — …`; Task 10's Consumes block listed `parseFilters`, which ships in Task 3 for later slices and which no 0B file calls (the audit-log handler reads the flat `AuditLogQuery` fields §4.2.8 Layer 1 grandfathers) — removed, with the reason stated; Task 14 Step 2 was titled "the sixteen full files" while writing eight — retitled "the first eight".
- **Owed to the contracts document by this pass, on top of what §8 already lists:** §3.7.5 gains `dependency-rule`'s named-allowance mechanism and its one 0B entry, and §3.3 / §3.7.5 gain the fourth and fifth `sql.unsafe` homes (`packages/db/test/harness.ts`, `packages/db/test/roles.test.ts`) — "exactly three places" was written before Plan 0A's harness was read. Neither changes a shipped name; both are records of what the rules must permit for a green tree. **Not fixed, and not this plan's to fix:** no workspace-internal `dependencies` entry is declared anywhere in this plan — `apps/api` imports `@dulja/db` and `@dulja/contracts`, and `packages/db/test` imports `@dulja/contracts/permissions`, on Bun's workspace symlinking alone. It is uniform across the plan rather than introduced by any one task, and 0C or 0D should settle whether the manifests declare them.

**8d. Applied from neighbouring slices' handoffs (the cross-plan pass).** Each was raised by the fixer of another plan against this file, verified here at the source it cites, then applied — or rejected with the line that refutes it.

- **`IdempotencyHeader` as a `const` in `apps/api/src/routes/index.ts` is a temporal-dead-zone crash, not merely a cycle.** Raised by 0D. Verified: `routes/index.ts` imports every route module, and `admin/roles.ts`, `admin/role-assignments.ts`, `companies.ts` and `admin/users.ts` all build their `createRoute({ … })` calls at module top level (T9 Step 1, T10 Step 1, T8 Step 1) — so ESM evaluates them, and dereferences `IdempotencyHeader`, before `index.ts`'s own body runs. `ReferenceError: Cannot access 'IdempotencyHeader' before initialization` on the first `openapi:generate`, and on every boot. It also breaks the other way round: entered through a route module, `index.ts`'s top-level `ROUTES = buildRoutes({ … })` dereferences `roleRoutes` before that module finishes. T11 Step 4 now declares the schema in the leaf module `apps/api/src/routes/idempotency-header.ts`, has the four route files import it from there, and re-exports it from `routes/index.ts` **as that module's first line** — a re-export is an indirect binding resolved at link time, and putting the edge first makes the leaf the first dependency evaluated, so 0D's, 2A's and 2C's `import { IdempotencyHeader } from "../index"` resolves to the same initialised `z.object`. The Files block, the File-structure tree and assumption 13 name the new module.
- **`dependency-rule` had no allowance at all for the `apps/*/test/**` → `tests/**` imports contracts §4.17.1 puts on this file — and the raiser understated it.** Raised by 0D as "widen the allowance regex from `tests/invariants/support/**` to `tests/support/**`". Verified, and it is worse than that: this file's `ALLOW` set is keyed `<file path>|<package root>` and is consulted **only** by the `@dulja/*` tier check, while `import { grantAdmin } from "../../../../../tests/support/api";` is relative and trips the *escape* branch, which had no allowance mechanism whatsoever. So there was no regex to widen. T12 Step 4 gains a second set, `ESCAPE_ALLOW`, matched on the **resolved** path (the specifier is five `..` segments and names no directory), covering `apps/api/test/**` and `apps/worker/test/**` against both `tests/support/` and `tests/invariants/support/` — both roots, because §4.17.1's closing sentence says `tests/invariants/support/**` while the table above it registers `grantAdmin`, `problemOf`, `sharedApi` and `fullRegression` in `tests/support/api.ts`. Step 1's `dependency-rule` case gains four assertions inside the existing `it` (two allowed, plus `apps/api/src/**` reaching `tests/` and `apps/api/test/**` reaching `apps/worker/` still red), so Step 6's "5 tests" is unchanged. The set matches no file in this slice; Step 6 says so, and says why it is written here anyway.
- **Rejected: "`sharedDb()`'s return shape may not match `const { db } = await sharedDb()`" (raised by 3D, citing contracts §4.18 open item 5).** T13 Step 2 declares `export function sharedDb(): Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }>` and T13's Produces block spells it identically; contracts §4.17.1 describes the same thing as "one `Db` + `rw` + two `Seed`s". `const { db } = await sharedDb()` and `const { db, rw } = await sharedDb()` both destructure that object correctly, so 3B's and 3A's files — and 3D's two — need no change. §4.18 item 5 was filed against **1A's** use sites, and 1A's own audit pass has already closed it from the plan side (1a:6361: "the import is now `from \"../support/regression\"` … This closes contracts §4.18's round-1 open item (5) from the plan side: the use sites were wrong, §4.17.1 was right"). Nothing to change in this file; the bookkeeping close belongs to the contracts document, which is outside this plan's write scope.
- **Owed to the contracts document by this pass, on top of what §8 and §8c already list.** §4.2.7 should record that `IdempotencyHeader` is declared in `apps/api/src/routes/idempotency-header.ts` and re-exported from `apps/api/src/routes/index.ts` — the registered import path is unchanged, so no consuming plan needs an edit, but a slice that reads §4.2.7 and re-declares the schema in `index.ts` reintroduces the crash. §4.17.1's closing sentence should read `tests/support/**` **and** `tests/invariants/support/**`, matching its own table. §4.18 open item 5 can be marked closed: 1A's use sites were the error, §4.17.1's shape was right, and 1a:6361 records the correction.

**9. Known gaps, stated rather than hidden.** Migration **0003 is unused** — the range is allocated, gaps are legal (§3.4.1), and no later plan may claim it. The `jobs/` files ship **types only**; `createJobClient` and the pg-boss migration are 0D's, and T13's job loop therefore asserts the registry's shape rather than a running handler. `packages/importer/src/reader.ts` appears in the `no-sql-concat` allow-list and in `legacy-036`'s assertion as a **subset** check precisely because 9A has not created it yet.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-0b-api-core-identity.md`.** Fifteen tasks, in order; Task 5 is the isolated owner-gate task (OD-01, OD-02) and does not block merge.

Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
**REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`. Fresh subagent per task plus two-stage review.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.
**REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

**Which approach?**

**Before Task 1, whichever is chosen:**
- Work in an isolated worktree (`superpowers:using-git-worktrees`) branched from the commit that merged Plan 0A. Confirm with `git log --oneline -1` that Plan 0A's final commit is the parent and that `bun run test` is green *before* any change — Task 1 begins by editing a Plan 0A test file, and a red baseline would be indistinguishable from a regression.
- `docker` must be running: every task from Task 1 onward starts a Testcontainers PostgreSQL 18 container.
- Tasks run **in order**. T2 needs T1's `./test` subpath; T4 needs T3's `Logger` and `ERRORS`; T5–T7 need T4's `createApp` signature; T8–T10 need T7's `requirePermission`; T11 needs every route mounted; T12 needs T3's `ERRORS`; T13 needs T4's `ROUTES` and T5's `startApi`; T14 needs T13's `sharedDb`/`thinRegression`; T15 is last, per contracts §3.8.
- **Three lint allow-list entries in Task 12 are load-bearing and must not be "tidied" away** (Self-Review 8c): `dependency-rule`'s named allowance for `packages/db/test/permission-catalogue.test.ts|@dulja/contracts`, and `no-sql-concat`'s `UNSAFE_ALLOW` entries for `packages/db/test/harness.ts` and `packages/db/test/roles.test.ts`. All three exist because Plan 0A files, which this slice may not edit, would otherwise fail `bun run lint:rules` on a tree nothing changed. Task 14's `legacy-036` carries the matching fourth path; the two lists must stay in agreement. Contracts §3.7.5 and §3.3 are owed the amendment.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and carries the `[0B T<n>]` suffix in its subject. One migration in this whole plan — `0002_seed_permission_phase0.sql` in Task 7 — so only that PR carries a migration (spec:2057).
- Pushing to GitHub is the owner's call and is not part of any task's definition of done (plan0A:2927).

**When 0B is merged**, the next slices are **0D**, **0C** and **0E**; 0D and 0E may proceed in parallel with 0C. Their plans and the frozen names they share with this one are in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.
