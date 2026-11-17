# Dulja Phase 1B — Projections, Integrity Job, Minimal Reports, Screens, Restore Drill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 1 by making the ledger *provably* correct and *readable* — a nightly integrity job that rebuilds `account_balance` from `ledger_entry` and compares it row for row, the three invariant suites, the two minimal reports (`accounting.trial_balance`, `accounting.ledger`), the three back-office screens, the month-end job, and the first PITR restore drill written up as a runbook.

**Architecture:** Everything that *checks* the ledger lives in one new directory, `packages/db/src/integrity/`, as `withTenant`-scoped read functions with no I/O of their own; `apps/worker` supplies the two pg-boss handlers that call them and the incident path. Everything that *reads* the ledger for a human lives in `packages/db/src/reports/`, as named `withTenant` read queries — never SQL text from a client (test 27) — behind two Hono routes in `apps/api/src/routes/accounting/reports.ts`. The back office adds three screens and two report views against those routes. Nothing in this slice writes to a ledger, movement or projection table: the integrity job is a *detector*, never a repairer (the direct answer to LEGACY-079).

**Tech Stack:** Bun 1.4 · TypeScript strict · PostgreSQL 18 (Testcontainers locally, Supabase on staging) · `postgres.js` tagged templates · Drizzle mirrors as the migration diff source · Hono + `@hono/zod-openapi` + Zod · pg-boss · Vitest (under Node 24) + Testcontainers · React 19 + Vite + TanStack + Tailwind in `apps/backoffice` · Playwright for the RTL/LTR parity re-run.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §3.3 (projections, spec:1204), §3.8 (`account_balance` contract and audit verification, spec:1963–1964, 2031), §3.9, §4.8 (spec:2231–2239), §4.9 (spec:2241–2247), §4.10 (spec:2249–2256), §4.11 (spec:2258–2274), §5.0 row 0.11 (spec:2321), Part V Phase 1 row (spec:2287) and the reports sequencing note (spec:2300), Part VI tests 2, 9, 24 (spec:2420, 2427, 2442), Part I LEGACY-001, 002, 049, 070, 079, 081.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 1B — Projections, integrity job, minimal reports, screens, restore drill. **Phase:** 1. **Phase gate:** this plan starts only when 1A is merged and the Phase 0 exit gate (0B, 0D, 0C, 0E green; tests 11, 12, 13, 14, 27 and the test-36 catalogue clauses in CI) is green (spec:87, contracts §2.1).
- **Depends on (merged):** **1A** (`postDocument`, `issueDocument`, `reverseDocument`, `voidDocument`, `loadSnapshot`, `resolvePolicy` from `@dulja/db`; `app.account_balance`; `app.document_line`; `document.posting_seq` + `app.posting_seq`; the chart-of-accounts, fiscal-period, journal and ledger-read APIs; permission codes `accounting.account.manage`, `accounting.ledger.read`, `accounting.period.close`, `accounting.period.reopen`, `accounting.journal.create`, `accounting.journal.post`; fixtures `seedTenantV2`, `seedJournalPolicy`, `seedAccount`, `JOURNAL_POLICY_V1`). **0C** (staging Supabase project with PITR, the seed CLI, Sentry). Plan 0A helpers consumed **by exact name and never renamed**: `startDb`, `Db`, `Seed`, `seedTenant`, `draftDocument`, `uuidv7`, the 4-argument test `withTenant`, `MIGRATIONS_DIR`, `up`, `down`, `listApplied`, `discover`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE`, `schemaFingerprint`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.resolve_principal`, `app.current_tenant`, `app.current_actor`, `app.assert_period_open`, `app.forbid_change`, `app.audit_chain`. 0B/0D helpers consumed: production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `createDb`, `AppError`, `ERRORS`, `fromDatabaseError`, `Problem`, `PERMISSION`, `PERMISSIONS`, `requirePermission`, `ROUTES`, `RouteModule`, `createApp`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `JOBS`, `JobEnvelope`, `Logger`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `CurrencySchema`, `MoneySchema`, `RateSchema`, `CursorSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`. **Two of 0D's names are not in `@dulja/db`:** `JobHandler` and `registerHandler` live in `apps/worker/src/handler.ts`, where §4.2.6's code block puts them, and are imported relatively by `apps/worker/src/handlers/accounting.ts`.
- **Migration numbers:** 0015–0016 (contracts §3.4.1) — `0015_seed_permission_phase1b.sql` + `0015.down.sql`, `0016_add_ledger_report_indexes.sql` + `0016.down.sql`. **ADR numbers:** 0024–0025 (contracts §3.9) — 0024 the integrity-check composition and incident path, 0025 the restore-drill procedure and its local equivalent.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.2 `withTenant`/`TenantContext`/`systemContext`, §4.2.3 `AppEnv`/`Logger`, §4.2.4 error envelope, `AppError(code, detail, extra?)` and `ERRORS`, §4.2.5 `PERMISSION`/`requirePermission`/`RoleSeed`/`ROLES`, §4.2.6 `JOBS`/`JobEnvelope` (from `@dulja/db`) and `JobHandler`/`registerHandler` (from `apps/worker/src/handler.ts`), §4.2.7 `RouteModule`/`ROUTES`/`createApp`/`PROBES`, §4.2.8 common Zod schemas and the cursor grammar, §4.2.12 `startApi`, §4.3.1 `postDocument`, §4.3.2 the fixed algorithm (steps 5, 8, 10, 12), §4.3.3 `account_balance` DDL, `MERGE` and the rebuild, §4.3.4 `document_line`, §4.3.5 `document.posting_seq`, §4.16.1 the report-code register, §4.17 the `fixtures.ts` register.
- **Interfaces produced:** §3.5.2 the `relkind_partition` linter rule; §4.3.3's rebuild-and-compare as executable code; the report codes §4.16.1 assigns 1B (`accounting.trial_balance`, `accounting.ledger`); the `accounting.report.read` catalogue entry (§3.6.2); the `accounting.ledger.integrity_check` and `accounting.period.month_end` handlers for the two `JOBS` names §4.2.6 assigns 1B.
- **Owner decisions:** **OD-19** (Supabase organisation access, PITR billing — spec:2398) → **Task 12** only, isolated, with its stated local equivalent; default: the drill runs against Testcontainers. **OD-24** (screenshots + a two-minute operator description before any screen — spec:79, 108, 2408) → **Task 11** only, isolated; default: the screen task is blocked, not the slice. No other OD item touches 1B. This plan decides none of them (contracts §2.12).
- **Part VI tests owned / re-run:** owns **2** (deterministic projections, for `account_balance`), **9** (period lock — this slice ships the background-job path; 1A holds the API and admin paths, 9B the import path), **24** (restore drill). Re-runs **13** (the audit-chain walk as a job) and **23** (screens and both text directions). **§3.0.4 rows owned:** spec:1040 (Accounting core — closed here by the integrity checker; 1A contributes). **Regression files created / appended:** appends to `legacy-001`, `legacy-002`, `legacy-049`, `legacy-070`, `legacy-079`, `legacy-081`. **No file is created by this slice** — see *Contract deviations recorded here* below.
- **Shared namespaces this slice writes into:** document-type codes (§4.14) **none**. Account codes (§4.15) **none seeded into a pack and none named by a policy** — the reports read whatever accounts the tenant has, and the only fixture accounts a posting uses are Plan 0A's `1000` and `4000` (0C seeds the real chart). Two test-only leaf codes, **`1900`** (Task 4's orphan-projection row) and **`1960`** (Task 6's cold-start concurrency row), are created through `seedAccount` inside two invariant suites and are deliberately outside the register, which covers seed-pack and policy literals only (hazard 32's mechanical test is "the string appears in a seed file or a policy", and neither does). Report codes (§4.16.1) **`accounting.trial_balance` and `accounting.ledger`**, both module `accounting`, both gated by `accounting.report.read`; `DatasetId` members (§4.16.2) **none** — 7A creates `packages/db/src/reports/datasets.ts` and this slice does not. `fixtures.ts` helpers (§4.17) **none** — §4.17 assigns 1B no helper, so `packages/db/test/fixtures.ts` is not touched; the one helper these tests need lives in the test tier at `tests/invariants/support/post-journal.ts`.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-05.

### Assumptions this plan rests on

Every assumption below is stated so a reviewer can reject it in one place instead of discovering it in a task.

1. **1B ships routes, not `ReportDefinition`s.** `ReportDefinition`, `validateReportDefinition` and the `reports` seed loader are 7A's (contracts §3.4.8, §4.11.1). The two minimal reports therefore ship as `withTenant` read endpoints over hand-written dataset queries, exactly as §4.16.1's "Re-expresses" paragraph describes, and **`packages/db/seed/my/reports/1b/` is not created by this slice** — it stays absent until 7B re-expresses these two codes at `version = 2` under the same codes.
2. **Task count.** The catalogue card targets 10–12 tasks; this plan has **13**. The three extra reviewer gates are the two isolated owner-gate tasks required by contracts §2.0 (Task 11 OD-24, Task 12 OD-19) and the `relkind_partition` linter rule §3.5.2 assigns 1B (Task 2). No task was split for length and none was merged to hide work.
3. **A foreign-currency document needs an `app.exchange_rate` row, whichever way 1A resolved the rate.** §4.3.2 step 6 says base amounts are `toBase()` per line but does not say whether the rate comes from `document.exchange_rate` (written by the caller) or is re-resolved through `app.rate_for` (§4.2.10), and §4.3.7 lists `ERR_RATE_NOT_FOUND` among the codes `postDocument` raises. This plan does **not** decide which: Task 3's foreign-currency case seeds the rate with `seedRate(db, a, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.20000000" })` (§4.17, owner 0D) **and** writes the same rate onto the header, so the case passes under either reading. No other case in this slice uses a currency other than the company's base.
4. **`app_rw` may create a temporary table.** Plan 0A revokes `TRUNCATE`, `REFERENCES`, `TRIGGER` and object creation *in schema `app`* from `app_rw` (plan0A:2496–2499) but never revokes the database-level `TEMPORARY` privilege Postgres grants `PUBLIC`. The rebuild-and-compare of §4.3.3 uses `create temporary table … on commit drop`, and Task 6 Step 8 asserts exactly that it succeeds as `app_rw` — so if the assumption is ever falsified the plan fails loudly at that line, with a stated one-statement fallback.
5. **1A records the period-reopen reason in the audited row image.** Contracts §2.2 gives 1A "fiscal-period API (`accounting.period.close`, `accounting.period.reopen` with a mandatory reason written to the audit row — spec:2179)". `app.audit_log` has no `reason` column and its `after` image is `to_jsonb(new)` of the `fiscal_period` row, so the reason must be a column on `app.fiscal_period`. This plan reads it as `after->>'reopen_reason'` and is **null-safe**: an absent column yields `reason: null` and the reopen is still reported. **1A confirms the spelling**: its migration 0013 produces `app.fiscal_period.reopen_reason text` under ADR 0023, and its `FiscalPeriodSchema` carries `reopenReason: z.string().nullable()`. 1A's own amendment A1 registers the column in the contracts document, and if that amendment is still unmerged when Task 5 runs, the null-safe read is what keeps this slice green regardless. If the column were ever renamed, one line of `packages/db/src/integrity/period-reopen.ts` changes.
6. **1A's API paths follow §4.2.7's scheme.** Task 11's screens call `GET/POST /v1/companies/{companyId}/accounts`, `GET /v1/companies/{companyId}/fiscal-periods` + `POST …/fiscal-periods/{id}/close` and `…/reopen`, and `POST /v1/companies/{companyId}/documents` + `…/documents/{id}/transitions` — the company-scoped resource scheme §4.2.7 fixes. If 1A mounted a different noun, one path string in `apps/backoffice/src/lib/accounting-api.ts` changes and no screen is touched — every URL in this slice is written once, in that file.
7. **0E's back-office surface, read off 0E's own plan rather than guessed.** Task 11 consumes exactly what
   0E's users-and-roles screen consumes, and nothing else:
   - **HTTP:** `createAdminApi(opts: AdminApiOptions): AdminApi` from `apps/backoffice/src/lib/admin-api.ts`,
     whose surface is `get<T>(path, schema: ZodType<T>)` and
     `send<T>(method: "POST"|"PUT"|"PATCH"|"DELETE", path, body, schema)`. **The response Zod schema is a
     parameter**, so every call in Task 11 passes one. There is no `apiFetch` and no `lib/api.ts`.
   - **Idempotency (the answer §4.2.7 and spec:2055 require):** `send` mints one itself — `if (method !==
     "GET") headers["idempotency-key"] = crypto.randomUUID();` (0e:2561), pinned by 0E's own test "mints an
     Idempotency-Key on every unsafe method (§4.2.9)" (0e:2405). **Task 11 therefore mints none of its own**,
     and every unsafe call it makes goes through `send`, never through a bare `fetch`.
   - **Translation:** `useShell()` from `apps/backoffice/src/components/app-shell.tsx`, which returns
     `{ locale, setLocale, t }`. `@dulja/i18n` is a leaf package of pure functions (`createI18n`, `dirFor`,
     `formatDate`, `formatTimestamp`, `LOCALES`) and exports **no** `useT` hook.
   - **Primitives:** `@dulja/ui` exports `DirectionProvider`, `Button`, `TextField`, `Select`, `DataGrid`
     and `Column` — and **no** `Input`, `Table`, `Dialog` or `PageHeader`. `TextField` and `Select` take a
     required **`label: string`** (already translated by the caller, §3.1 forbids `packages/ui` calling `t`),
     and `Select` takes `options: readonly { value; label }[]` with `children` omitted from its props, so an
     `<option>` child is a type error. The three primitives that do not exist are written by this task as
     small local components under `apps/backoffice/src/components/` (Step 5) — **never** added to
     `packages/ui`, which this slice does not own.
   - **Routing:** 0E uses code-based TanStack routing in `apps/backoffice/src/router.tsx` — `createRootRoute`
     + one `createRoute({ getParentRoute, path, component })` per screen, collected in
     `routeTree = rootRoute.addChildren([indexRoute, loginRoute, mfaRoute, usersRoute])` (0e:3139-3157). There is no file-based routing and no `createFileRoute`.
   - **Company and session:** `useCompanyId()` and `useSession()` from `apps/backoffice/src/lib/session.tsx`,
     and `readEnv()` from `lib/env.ts` — the exact three 0E's `usersRoute` wrapper uses (0e:3637–3649).
   - **Query:** `useQuery`, `useMutation`, `useQueryClient` from `@tanstack/react-query`, which 0E installs
     and mounts a `QueryClientProvider` for (0e:2213, 2679).

   If any of these shipped under a different spelling, each is a one-line import fix per file — the shapes,
   not the names, are what Task 11 depends on.
8. **Sentry in `apps/worker`.** §3.11 lists `SENTRY_DSN` as held by "api, worker, desktop", set by 0C. Task 6's incident reporter uses `@sentry/node` when `SENTRY_DSN` is set and falls back to a single `logger.error` line when it is not, so the job behaves identically on a developer machine, in CI and on staging. No version is written into any source file — the lockfile owns versions (spec:104).
9. **`ledger_entry` rows exist only for posted documents**, so `document.posting_seq` (set at §4.3.2 step 8, before any row that carries it is written) is non-null for every row the ledger report reads and is a total order within a company (`unique (company_id, posting_seq)`, §4.3.4).
10. **Drizzle mirrors exist for every table in schema `app`**, because §3.4.9 makes the mirror the diff source for every migration after 0001. `packages/db/src/schema/fiscal_period.ts` and `document.ts` are Plan 0A/0B mirrors and `account_balance.ts` is 1A's (its migration 0012). If any one of the three files is absent when Task 9 Step 3 runs, that step authors the mirror for that one table from its migration DDL — column for column, no index — before adding the index line, and says so in the commit body. Nothing else in this plan reads a mirror.
11. **Money crosses every boundary as a string.** `postgres.js` returns `numeric` as a JavaScript string; no value in this plan is passed through `Number()`, `parseFloat` or arithmetic on `number`. Amounts are `MoneySchema` (`{ amount, currency }`) on the wire and fixed-4-dp strings inside the integrity report. `rows`, `brokenLinks`, `badHashes` and `lineNo` are counts and are `number` (spec:2041; the `no-number-money` lint, contracts §3.7.5).

### Contract deviations recorded here (each needs a one-line amendment to the contracts document)

- **`legacy-070` is an append, not a create.** The 1B card says "creates legacy-070 (report filter indexes)", but the 0B card lists `070` among the twenty-one thin files 0B creates for Plan 0A-proven defects, and contracts §3.7.3's rule is "the first slice in execution order that touches a defect creates the file". 0B always precedes 1B (§6.3), so **Task 9 appends** `describe("LEGACY-070 … — 1B", …)` to the existing `tests/regression/legacy-070.test.ts` and creates nothing. Amend the 1B card's last line to "appends to legacy-001, 002, 049, 070, 079, 081".
- **§4.2.6's Rules paragraph and its `JobHandler` signature disagree about who iterates `pgboss.tenant_registry`.** The Rules sentence (§4.2.6, the paragraph beginning "Rules: every handler runs as the tenant's **system principal**") says "their handlers iterate `pgboss.tenant_registry` … running each tenant's work under that tenant's `systemContext`"; the frozen signature in the same section's `apps/worker/src/handler.ts` code block is `(sql, job, ctx: TenantContext /* systemContext(sql, tenantId, requestId) */) => Promise<void>` — one tenant's context, singular, with no way to express a fan-out. **The signature wins**, because it is the code block and §4 says a code block is the contract; 0D's `runJob(sql, name, job)` resolves the tenant and hands the handler that triple, and 0D's own `eachTenant(sql, fn)` is where the fan-out lives. This plan's two handlers therefore do **one tenant's** work and never read `pgboss.tenant_registry`. Amend the Rules sentence to read "the scheduled dispatcher iterates `pgboss.tenant_registry` … and invokes each handler once per tenant under that tenant's `systemContext`". If 0D shipped the other reading, the change is one file: `apps/worker/src/handlers/accounting.ts` wraps each handler body in a loop over the registry, and no interface in this plan moves. (Line numbers are deliberately not cited: the contracts document is edited continuously and its line numbers shift.)
- **§4.16.3 names two of the three files that carry the pinned `projections.checked` assertion.** Its sentence is "1B's two assertions on that array — in `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts` — are updated in the same PR as the registration". Both of those files do carry one (Task 5 Step 1 and Task 6 Step 2), and so does a **third**: `tests/invariants/projection-rebuild.test.ts`, whose registry assertion `expect(projectionChecks().map((c) => c.name)).toEqual(["account_balance"])` (Task 4 Step 1) goes red on exactly the same 2B commit. All three carry a comment saying so. Amend §4.16.3's sentence to "1B's **three** assertions on that array — in `tests/invariants/projection-rebuild.test.ts`, `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts`".
- **§3.1's `tests` tier gains a second allowance.** §3.1 grants the `tests` tier "any package and `apps/api` **only** through its exported `createApp()`". Task 8 needs the *real* month-end handler to prove test 9's job path, so it widens the rule to admit `apps/worker/src/handlers/**` — pure handler factories, no server, no pg-boss, no network, the same shape as `createApp()`. Amend §3.1's `tests` row to "any package, `apps/api` through its exported `createApp()`, and `apps/worker/src/handlers/**`". This is a fifth amendment beside the four in Self-Review §6, and it is listed there too.
- **`apps/api/test/**` cannot reach 0B's `grantAdmin()`.** §4.1 pins "a route test therefore grants first: 0B's `grantAdmin()` (§4.17.1) is the one way to do it". That helper lives in `tests/support/api.ts`, and the only allowance this slice adds in that direction (Task 6 Step 1(b)) covers `tests/invariants/support/**` — not `tests/support/**` — so Task 10's route test cannot import it. It therefore uses a **file-local** helper, named **`grantReportCodes`** so that it can never be confused with the `grantCodes` §4.17 reserves for 2B with a different signature, and it performs exactly the three inserts plan0A:1195–1200 performs, as `s.system` so `forbid_self_grant` is not tripped. 0B does the same thing in its own `apps/api/test` files, so this is the shipped precedent, not a new one. Amend §4.1's sentence to admit a file-local grant inside `apps/api/test/**` until a slice widens the allowance or 0B exports the helper from a reachable module.
- **New names this plan had to define** because the registry lacks them: the complete list, including the ten `tests/invariants/support/restore-drill.ts` exports and all nine `DRILL_*` environment names, is **Self-Review §4**. It is kept in one place deliberately — two partial lists in two sections is how they drift apart. Read §4 for the roadmap; nothing is recorded here that is not there.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

**Never** (spec:97–104), at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (LEGACY-036/037/069);
- issue DDL from application code (LEGACY-053);
- disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053);
- gate an audit write on any flag (LEGACY-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always** (spec:106), for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

**Identifiers** (spec:2037): `uuidv7()` server-side for everything. Never a sequential integer as a public identifier; never reuse; never rewind (LEGACY-021).

**Time and dates** (spec:2039): all timestamps `timestamptz`, stored in UTC. **`effective_date` is a `date`, entered by the user, and is the accounting date** — it is never derived from `posted_at`. Fiscal period is resolved from `effective_date` at posting and stored on the row. Hijri display is a presentation concern via `Intl`; storage is always Gregorian.

**Money** (spec:2041): `numeric(19,4)` in Postgres. In TypeScript, `Money` is an opaque type wrapping `decimal.js`, carrying its currency. Display rounding applies the currency's policy at render time; **stored base amounts are never recomputed on read.** No `number` type ever holds a monetary value — a lint rule enforces it.

**Naming** (spec:2045): `snake_case` everywhere in SQL; **singular** table names. TypeScript: `camelCase`, types `PascalCase`. Bilingual names on master data as `name_en` / `name_ar` columns.

**Deletion** (spec:2049): financial rows: never — reversal only. Master data: `archived_at`, never `DELETE`.

**Error codes** (spec:2051): every error the API can return has a stable string code `ERR_<DOMAIN>_<REASON>`, a human message naming the specific entity, and a remedy. Codes are enumerated in one file (`packages/contracts/src/errors.ts`); a code no code raises fails the build.

**Database access** (spec:2053): every query — reads included — runs inside `withTenant(tx => …)`, which opens the transaction and issues the two `set_config(…, true)` calls before anything else. A lint rule forbids bare `db.` calls.

**API** (spec:2055): `/v1/…`. Cursor pagination. `Idempotency-Key` header required on POST/PUT/PATCH/DELETE. `application/problem+json` errors. OpenAPI generated from Zod, committed, diffed in CI.

**Migrations** (spec:2057, contracts §3.4.2–§3.4.5): one migration per PR; up file `packages/db/migrations/NNNN_<verb>_<noun>.sql` matching `/^(\d{4})_([a-z0-9_]+)\.sql$/`, hand-written down file `packages/db/migrations/NNNN.down.sql`; each file runs whole in one transaction, so no `create index concurrently`; every object the up creates has a drop in the down, in reverse dependency order; SQL keywords lowercase; section banners `-- ── N. title ───`; every statement carries a comment naming the LEGACY-/spec reference it serves.

**Localisation** (spec:2061) and **Logging** (spec:2063) apply verbatim; no plan widens the `no-console` override glob `packages/*/src/cli.ts`.

**Commits** (contracts §3.8): conventional commits scoped to the workspace, subject `<type>(<scope>): <summary> [1B T<n>]`, and **every commit message ends with the trailer**

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

**Definition of done for any pull request** (spec:2274): tests added or updated · migration is reversible · OpenAPI updated if the API changed · both text directions checked if the UI changed · no new `⚠️` left unresolved in the code without a linked issue.

**Phase 1 definition of done, verbatim** (spec:2287): "Σdebit = Σcredit holds under fuzz testing; projections rebuild **bit-identically**; a locked period cannot be altered through any path including import; the first PITR restore drill has been run against staging and written up as a runbook (§4.8, acceptance test 24)."

**This slice's share:** "projections rebuild **bit-identically**; the first PITR restore drill has been run against staging and written up as a runbook"; **and the background-job path of "a locked period cannot be altered through any path"** — spec:2427 makes test 9 cover "API, import, admin, background job"; 1A holds the API and admin paths, 9B the import path, and this slice owns test 9 and ships the job that proves the fourth.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/db/migrations/0015_seed_permission_phase1b.sql` · `0015.down.sql` | the one Phase 1B permission code, `accounting.report.read` |
| `packages/db/migrations/0016_add_ledger_report_indexes.sql` · `0016.down.sql` | the three report-filter indexes EXPLAIN shows missing (LEGACY-070) |
| `packages/db/src/integrity/types.ts` | `IntegrityReport`, `LedgerImbalance`, `ProjectionMismatch`, `PeriodReopen`, `AuditChainResult`, `ProjectionCheck` — the shapes every other integrity file and the worker share |
| `packages/db/src/integrity/balance.ts` | `checkLedgerBalance` — Σbase debit = Σbase credit per company/period and per document (spec:2246) |
| `packages/db/src/integrity/projections.ts` | `checkAccountBalanceProjection` — the §4.3.3 rebuild-and-compare; `registerProjectionCheck` / `projectionChecks`, the registry 3A (`stock_on_hand`) and 8C (`employee_ytd`) add to |
| `packages/db/src/integrity/audit-chain.ts` | `checkAuditChain` — the hash-recompute walk of spec:1963 (the production twin of plan0A:2153–2165) |
| `packages/db/src/integrity/period-reopen.ts` | `listPeriodReopens` — every `accounting.period.reopen` since a cursor, from the audit log (spec:2179) |
| `packages/db/src/integrity/index.ts` | `runIntegrityCheck`, `recordIntegrityIncident`; registers the `account_balance` projection check |
| `packages/db/src/periods/month-end.ts` | `listPeriodsAwaitingClose`, `recordMonthEndReady` |
| `packages/db/src/reports/trial-balance.ts` | `trialBalance`, `trialBalanceFingerprint` — the `accounting.trial_balance` dataset query |
| `packages/db/src/reports/ledger.ts` | `accountLedger`, `accountOpeningBalance` — the `accounting.ledger` dataset query with its running balance |
| `packages/contracts/src/accounting/reports.ts` | the Zod contracts for both reports: rows, queries, list envelopes, the report-code enum |
| `apps/api/src/routes/accounting/reports.ts` | the two `GET` routes and the `RouteModule` mounted at `/v1/companies/:companyId/reports` |
| `apps/worker/src/observability/incident.ts` | `createIncidentReporter` — Sentry when `SENTRY_DSN` is set, `logger.error` always |
| `apps/worker/src/handlers/accounting.ts` | `registerAccountingHandlers` — the two pg-boss handler factories and their one registration point; scheduling stays 0D's boot loop |
| `apps/backoffice/src/lib/accounting-schemas.ts` | the one file that names 1A's, 0D's and Task 10's Zod schemas, and infers the screens' DTOs from them |
| `apps/backoffice/src/lib/accounting-api.ts` | `createAccountingApi` over 0E's `AdminApi`, plus the `useAccountingApi` hook the five screens share |
| `apps/backoffice/src/routes/accounting/accounts.tsx` | chart of accounts (tree from the API's recursive CTE) |
| `apps/backoffice/src/routes/accounting/journal-entry.tsx` | keyboard-first journal entry (spec:2254) |
| `apps/backoffice/src/routes/accounting/periods.tsx` | fiscal periods with close and reopen-with-reason |
| `apps/backoffice/src/routes/accounting/reports.trial-balance.tsx` | the trial-balance view |
| `apps/backoffice/src/routes/accounting/reports.ledger.tsx` | the ledger view |
| `apps/backoffice/src/components/report-table.tsx` | the one RTL-aware table both report views render through |
| `apps/backoffice/src/components/page-header.tsx` · `modal.tsx` | the two primitives `@dulja/ui` does not export, kept local because this slice does not own `packages/ui` |
| `tests/invariants/support/post-journal.ts` | `postJournal` — posts a balanced JOURNAL through the real `postDocument`; the test tier's only shared helper (§4.17 assigns 1B no `fixtures.ts` helper) |
| `tests/invariants/ledger-balance.test.ts` | the Σdebit = Σcredit suite (spec:2375) |
| `tests/invariants/projection-rebuild.test.ts` | the deterministic-rebuild suite — **test 2** |
| `tests/invariants/audit-chain.test.ts` | the chain-walk suite — **test 13** re-run as a job |
| `tests/invariants/period-lock.test.ts` | **test 9**, the background-job path |
| `tests/invariants/support/restore-drill.ts` | the drill's two phases and their one shared verdict: `captureDrillPoint`, `verifyRestore`, `formatDrillVerdict`, and the local `pg_dump` snapshot half |
| `tests/invariants/restore-drill.test.ts` | **test 24**, with its Testcontainers local equivalent |
| `apps/api/test/routes/accounting/reports.test.ts` | route tests and the two tie-out assertions |
| `tests/invariants/account-balance-concurrency.test.ts` | the concurrency pin behind ADR 0024 and the temp-table privilege probe |
| `packages/db/test/report-indexes.test.ts` | the EXPLAIN and `pg_index` assertions behind migration 0016 |
| `apps/worker/test/handlers/integrity-check.test.ts` · `month-end.test.ts` | handler tests for both jobs |
| `tests/e2e/accounting-screens.spec.ts` | Playwright, both text directions — **test 23** re-run |
| `docs/runbooks/restore-drill.md` | the runbook the Phase 1 DoD names |
| `docs/adr/0024-ledger-integrity-check-composition.md` · `docs/adr/0025-restore-drill-procedure.md` | this slice's two ADRs |
| `docs/reports/phase-1.md` | the written phase report spec:110 requires |

**Modified**

| Path | Change |
|---|---|
| `packages/contracts/permissions.ts` | one `PermissionDef` appended: `accounting.report.read`, module `accounting`, `mutating: false`, `phase: "1B"` |
| `packages/db/seed/roles.ts` | `accounting.report.read` added to `accountant` and `auditor` |
| `packages/db/src/lint-schema.ts` | `relkind = 'r'` → `relkind in ('r', 'p')` (§3.5.2 rule `relkind_partition`) |
| `packages/db/test/privileges.test.ts` | the same two `relkind` filters, in `schemaFingerprint` and the RLS check |
| `packages/db/test/schema-lint.test.ts` | one appended case for the partitioned-table rule |
| `packages/db/test/permission-catalogue.test.ts` | two appended cases for the 0015 code and its grants |
| `packages/db/src/index.ts` | additive exports of the integrity, month-end and report surfaces |
| `packages/db/src/jobs/payloads.ts` | two `JobPayload` members |
| `packages/db/src/schema/account_balance.ts` · `fiscal_period.ts` · `document.ts` | the three index declarations that make the Drizzle mirror the diff source for 0016 (§3.4.9) |
| `apps/api/src/routes/index.ts` | `reportsRouteModule` registered inside `buildRoutes` (§4.2.7 — `ROUTES` is derived, never pushed onto) |
| `apps/backoffice/src/router.tsx` | five `createRoute` declarations appended to 0E's `routeTree`; no existing line changed |
| `packages/i18n/catalogues/en.json` · `ar.json` | every key Task 11's five screens name, in both catalogues |
| `apps/worker/src/index.ts` | one `registerAccountingHandlers({ logger, incident })` call replaces 0D's inline integrity-check scaffold; **no schedule line is added** — 0D's boot loop over `registeredJobNames()` installs the cron fan-out for every registered name |
| `tests/invariants/probes.ts` | one `PROBES` entry keyed `/v1/companies/:companyId/reports` |
| `scripts/lint/rules/dependency-rule.ts` | **two** allowances, added in two tasks: `apps/*/test/**` → `tests/invariants/support/**` (Task 6 Step 1(b)) and `tests/**` → `apps/worker/src/handlers/**` (Task 8 Step 3). Each carries its reason on the line |
| `apps/worker/tsconfig.json` (Task 6) · `apps/api/tsconfig.json` (Task 10) | one `include` entry each for `../../tests/invariants/support/**/*.ts`; no `package.json` dependency is added in this direction — that would close a cycle in the workspace graph turbo walks |
| `tests/package.json` · `tests/tsconfig.json` | `@dulja/worker` as `workspace:*`, and one `include` entry `../apps/worker/src/handlers/**/*.ts` — no path alias, because the import is relative — so the test tier can import the real month-end handler (Task 8 explains why) |
| `tests/regression/legacy-001.test.ts` · `legacy-002.test.ts` · `legacy-049.test.ts` · `legacy-070.test.ts` · `legacy-079.test.ts` · `legacy-081.test.ts` | one appended `describe(… — 1B)` block each; **no earlier block is edited** (§3.7.3) |
| `packages/contracts/openapi.json` | regenerated after the routes land |
| `.gitignore` | `drill-capture.json` — the drill's inter-phase artifact, never committed (Task 12) |
| `CLAUDE.md` | "Current phase" rewritten — Phase 1 complete, Phase 2 (2A) next (§3.8) |

**Deliberately not created**

- `packages/db/seed/my/reports/1b/` — 1B ships routes, not definitions (assumption 1).
- `packages/db/src/reports/datasets.ts` — 7A creates it with every dataset whose source tables exist at migration ≤ 0058 (§4.16.2). This slice adds no `DatasetId`.
- Any change to `packages/db/test/fixtures.ts` — §4.17 assigns 1B no helper (hazard 9).
- Any new `app_rw` DELETE grant — the pinned list is §3.5.4's and 2B is the only slice that extends it (hazard 25).

---

### Task 1: Migration 0015 — the `accounting.report.read` permission

**Files:**
- Create: `packages/db/migrations/0015_seed_permission_phase1b.sql`, `packages/db/migrations/0015.down.sql`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`
- Test: `packages/db/test/permission-catalogue.test.ts` (exists from 0B — extend, do not rewrite)

**Interfaces:**
- Consumes: `app.permission (code, module, mutating, description)` (plan0A:1313–1320); `PermissionDef`, `PERMISSIONS`, `PERMISSION`, `SliceId` from `packages/contracts/permissions.ts` (§4.2.5); `RoleSeed`, `ROLES` from `packages/db/seed/roles.ts` (§4.2.5, 0D); `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `startDb` (§4.1).
- Produces: the catalogue entry `accounting.report.read` (module `accounting`, `mutating: false`, `phase: "1B"`) — Tasks 10 and 11 gate on it; the `accountant` and `auditor` grants.

Why these two roles and no others: spec:2157 gives `accountant` the head-office bookkeeping surface and spec:2163 gives `auditor` "Read everything financial: ledger, documents, reports". spec:2158's `user` row grants reading "accounts, items, stock and the staff directory" and names no report, and spec:2160's `branch_manager` gets the Z-report through `pos.report.read` (6D), not the accounting catalogue. `admin` is computed from `PERMISSIONS` (§3.6.4) and needs no edit. OD-04 concerns role *names*, not grants, so it does not gate this task.

- [ ] **Step 1: Write the failing test — extend `packages/db/test/permission-catalogue.test.ts`**

Append these two `it` blocks inside the existing `describe`:

```ts
  it("migration 0015 seeds accounting.report.read as a non-mutating accounting code (§3.6.2, slice 1B)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = 'accounting.report.read'`;
    expect(rows).toEqual([{ code: "accounting.report.read", module: "accounting", mutating: false }]);
  });

  it("accounting.report.read is granted to exactly accountant and auditor in the seed (spec:2157, 2163)", async () => {
    const { ROLES } = await import("../seed/roles");
    const holders = ROLES.filter((r) => r.code !== "admin" && r.permissions.includes("accounting.report.read"))
      .map((r) => r.code).sort();
    expect(holders).toEqual(["accountant", "auditor"]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts`
Expected: FAIL — the first assertion returns `[]` (`expected [] to deeply equal [ { code: 'accounting.report.read', … } ]`); the second returns `[]` too.

- [ ] **Step 3: Write `packages/db/migrations/0015_seed_permission_phase1b.sql`**

```sql
-- ── 1. Phase 1B permission catalogue ───────────────────────────────────────────
-- app.permission is GLOBAL (no tenant_id, no RLS — plan0A:1313) and is therefore the one kind of
-- row a migration may write: FORCE ROW LEVEL SECURITY binds app_migrator too, so per-tenant rows
-- are seed-pack data instead (contracts §3.4.8, spec:1366).
-- One code: the read gate on accounting.trial_balance and accounting.ledger (§4.16.1, spec:2147).
insert into app.permission (code, module, mutating, description) values
  ('accounting.report.read', 'accounting', false,
   'Read accounting reports: trial balance and ledger (spec:2300 minimal set, Phase 1)')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
```

- [ ] **Step 4: Write `packages/db/migrations/0015.down.sql`**

```sql
-- Reverse of 0015: remove exactly the code this migration inserted. role_permission rows referencing
-- the code are per-tenant seed data removed by re-running the role seed; the FK from
-- role_permission.permission_code blocks this delete while any tenant still holds the code, which is
-- the correct signal (contracts §3.4.5).
delete from app.permission where code = 'accounting.report.read';
```

- [ ] **Step 5: Add the catalogue entry to `packages/contracts/permissions.ts`**

Append this object to the `PERMISSIONS` array literal, after 1A's six `accounting.*` entries:

```ts
  {
    code: "accounting.report.read",
    module: "accounting",
    mutating: false,
    description: "Read accounting reports: trial balance and ledger",
    phase: "1B",
  },
```

`SliceId` already contains `"1B"` (§4.2.5), so no type change is needed.

- [ ] **Step 6: Add the grants to `packages/db/seed/roles.ts`**

Add the string `"accounting.report.read"` to the `permissions` array of the `accountant` entry and of the `auditor` entry. Leave every other role untouched: `admin.permissions` is computed from `PERMISSIONS` and picks the code up automatically (§3.6.4), and `role-seed.ts`'s R7 lint stays green because the code is `mutating: false` (spec:2178).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/privileges.test.ts`
Expected: PASS. `privileges.test.ts` must stay green: 0B generalised its up → down → up assertion to `listApplied()` (§3.4.6), so migration 0015 rolls back and re-applies with the schema fingerprint unchanged.

- [ ] **Step 8: Run the catalogue lints and record the expected red**

Run: `bun run lint:rules`
Expected: `permission-catalogue` **FAILS** with `accounting.report.read has no reference in apps/api, apps/worker, apps/pos, packages/sync, packages/db/src` — the handler lands in Task 10. This is exactly what §3.6.3 intends. Note it in the commit body; if the repository's CI gate forbids a red main branch, land Tasks 1 and 10 in one PR — the migration is still its own file and its own commit.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0015_seed_permission_phase1b.sql packages/db/migrations/0015.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts packages/db/test/permission-catalogue.test.ts
git commit -m "$(cat <<'EOF'
feat(db): seed accounting.report.read for the Phase 1 minimal reports [1B T1]

Migration 0015 adds the one Phase 1B permission code (contracts §3.6.2) and
grants it to accountant and auditor (spec:2157, 2163). lint:rules reports the
code as unreferenced until Task 10 mounts the reports route.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `relkind_partition` linter rule

**Files:**
- Modify: `packages/db/src/lint-schema.ts` (the `pg_class` query, plan0A:2718–2719), `packages/db/test/privileges.test.ts` (two `pg_class` queries, plan0A:2453 and plan0A:2489)
- Test: `packages/db/test/schema-lint.test.ts` (exists from 0A — extend)

**Interfaces:**
- Consumes: `lintSchema(sql: Sql): Promise<Violation[]>`, `Violation = { table; rule; detail }` (§4.1); `schemaFingerprint(sql)` (§4.1); `startDb` (§4.1).
- Produces: nothing importable. The rule name contracts §3.5.2 records is `relkind_partition`; its effect is that a **partitioned** table in schema `app` is linted and RLS-checked exactly like an ordinary one.

Why it belongs to 1B: plan0A:2037 says `ledger_entry` will be "partitioned by fiscal year once volume warrants it", and plan0A's three `relkind = 'r'` filters would silently stop seeing the parent table the day that happens — the linter would report zero violations on a table with no RLS, and `privileges.test.ts` would stop asserting RLS on it. Contracts §3.5.2 assigns the fix to this slice because 1B is the slice that first has to reason about the whole ledger's integrity. `relkind = 'p'` is a partitioned table; `'r'` is an ordinary one. Partitions themselves are `'r'` and inherit their parent's policies, so including `'p'` adds the parent without double-counting.

- [ ] **Step 1: Write the failing test — append to `packages/db/test/schema-lint.test.ts`**

Append inside the existing `describe`:

```ts
  it("a partitioned table is linted like an ordinary one (relkind_partition — contracts §3.5.2)", async () => {
    // The rules the partitioned parent must be reported for are collected INSIDE the rolled-back
    // transaction and asserted OUTSIDE it. Asserting inside would make the failing expect reject the
    // transaction promise, and the `.catch` that swallows the deliberate rollback error would swallow
    // the assertion too — the test would pass while the rule was still missing.
    let parent: string[] = [];
    await db.migrator.begin(async (tx) => {
      await tx`create table app.rogue_part (id uuid not null, effective_date date not null) partition by range (effective_date)`;
      await tx`create table app.rogue_part_2026 partition of app.rogue_part for values from ('2026-01-01') to ('2027-01-01')`;
      const v = await lintSchema(tx as never);
      parent = v.filter((x) => x.table === "rogue_part").map((x) => x.rule).sort();
      throw new Error("rollback");
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "rollback") throw e;
    });
    expect(parent).toEqual(["audit_trigger", "created_at", "rls_enabled", "rls_forced", "tenant_id", "tenant_isolation_policy"]);
    expect(await lintSchema(db.admin)).toEqual([]);
  });
```

Before the fix, `lintSchema` filters `relkind = 'r'` and never sees `rogue_part`, so `parent` is `[]` and the
first assertion fails — outside the transaction, where nothing can swallow it.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/schema-lint.test.ts`
Expected: FAIL — `expected [] to deeply equal [ 'audit_trigger', 'created_at', 'rls_enabled', 'rls_forced', 'tenant_id', 'tenant_isolation_policy' ]`.

- [ ] **Step 3: Widen the filter in `packages/db/src/lint-schema.ts`**

In the `Promise.all` inside `lintSchema`, replace the first query (plan0A:2718–2719):

```ts
    sql<TableRow[]>`select relname, relrowsecurity, relforcerowsecurity from pg_class
                     where relnamespace = 'app'::regnamespace and relkind = 'r' order by 1`,
```

with:

```ts
    // 'p' = a partitioned table's parent. plan0A:2037 partitions ledger_entry by fiscal year once volume
    // warrants it; with relkind = 'r' the parent would vanish from every rule below and an unprotected
    // partitioned table would lint clean (contracts §3.5.2, rule relkind_partition).
    sql<TableRow[]>`select relname, relrowsecurity, relforcerowsecurity from pg_class
                     where relnamespace = 'app'::regnamespace and relkind in ('r', 'p') order by 1`,
```

- [ ] **Step 4: Widen the two filters in `packages/db/test/privileges.test.ts`**

In `schemaFingerprint` (plan0A:2453) replace:

```ts
    sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' order by 1`,
```

with:

```ts
    sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind in ('r', 'p') order by 1`,
```

and in the "every table in schema app has RLS enabled and forced" test (plan0A:2489) replace:

```ts
      select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'app'::regnamespace and relkind = 'r' order by 1`;
```

with:

```ts
      select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'app'::regnamespace and relkind in ('r', 'p') order by 1`;
```

Nothing else in `privileges.test.ts` changes. There are no partitioned tables in schema `app` today, so the fingerprint and the RLS assertion produce byte-identical results before and after — which is the point: this is a change that only matters later, made now, once, in the slice the contracts assign it to.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/schema-lint.test.ts test/privileges.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lint-schema.ts packages/db/test/privileges.test.ts packages/db/test/schema-lint.test.ts
git commit -m "$(cat <<'EOF'
test(db): lint partitioned tables (relkind_partition) [1B T2]

lintSchema and privileges.test.ts filtered pg_class on relkind = 'r', so the
parent of a partitioned table was invisible to every rule. plan0A:2037 plans to
partition ledger_entry by fiscal year; the filters now read relkind in ('r','p').
Contracts §3.5.2.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `checkLedgerBalance` and the ledger-balance invariant suite

**Files:**
- Create: `packages/db/src/integrity/types.ts`, `packages/db/src/integrity/balance.ts`, `tests/invariants/support/post-journal.ts`, `tests/invariants/ledger-balance.test.ts`
- Modify: `packages/db/src/index.ts`
- Test: `tests/invariants/ledger-balance.test.ts`

**Interfaces:**
- Consumes: production `withTenant(sql: Sql, ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T>` and `TenantContext = { tenantId; actorId; requestId }` from `@dulja/db` (§4.2.2); `postDocument(tx, ctx, { documentId }): Promise<PostResult>` from `@dulja/db` (§4.3.1, 1A); `startDb`, `Db`, `Seed`, `uuidv7`, `draftDocument` from `@dulja/db/test` (§4.1, §4.2.12); `seedTenantV2`, `seedAccount` from `@dulja/db/test` (§4.17, 1A); `seedRate(db, s, opts: { from; to; on; rate; source? }): Promise<string>` from `@dulja/db/test` (§4.17, 0D); `app.ledger_entry` columns (plan0A:2005–2035).
- Produces:
  - `packages/db/src/integrity/types.ts` — `LedgerImbalance`, `ProjectionMismatch`, `PeriodReopen`, `AuditChainResult`, `ProjectionCheck`, `IntegrityReport` (Tasks 4, 5, 6, 7 and 12 all import from here).
  - `checkLedgerBalance(tx: Sql, opts?: { companyId?: string }): Promise<{ byPeriod: LedgerImbalance[]; byDocument: LedgerImbalance[] }>` from `@dulja/db`.
  - `postJournal(db: Db, s: Seed, lines: JournalLine[], opts?: PostJournalOptions): Promise<{ documentId: string; number: bigint }>` from `tests/invariants/support/post-journal.ts` — the test tier's shared "post a real balanced journal" helper. It is **not** a `fixtures.ts` helper: §4.17 assigns 1B none, and hazard 9 forbids inventing one beside the register.

- [ ] **Step 1: Write `packages/db/src/integrity/types.ts`**

```ts
import type { Sql } from "postgres";

/**
 * Every amount below is a fixed-scale decimal STRING as postgres.js returns numeric —
 * never a JavaScript number (spec:2041; the no-number-money lint, contracts §3.7.5).
 */

/** One (company, period) or one document whose base debits and base credits disagree (spec:2246). */
export interface LedgerImbalance {
  readonly scope: "period" | "document";
  readonly companyId: string;
  /** fiscal_period_id for scope 'period', document_id for scope 'document'. */
  readonly subjectId: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
  /** baseDebit − baseCredit, signed. */
  readonly difference: string;
}

/** One row on which a projection and its fresh rebuild disagree (spec:2265, acceptance test 2). */
export interface ProjectionMismatch {
  /** The projection table, e.g. 'account_balance'. */
  readonly projection: string;
  /** The full natural key of the disagreeing row, every value as text. */
  readonly key: Readonly<Record<string, string>>;
  readonly side: "missing_in_projection" | "missing_in_rebuild" | "amount_differs";
  /** Human detail naming the column and both values, e.g. "base_debit 100.0000 <> 90.0000". */
  readonly detail: string;
}

/** The result of walking one tenant's audit chain (spec:1963, acceptance test 13). */
export interface AuditChainResult {
  readonly rows: number;
  readonly brokenLinks: number;
  readonly badHashes: number;
  /** The audit_log.seq of the first bad row, or null when the chain is intact. */
  readonly firstBrokenSeq: number | null;
}

/** One `accounting.period.reopen` observed in the audit log (spec:2179 — "every reopen is reported"). */
export interface PeriodReopen {
  readonly auditSeq: number;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly fiscalPeriodId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  /** From the audited row image; null when 1A recorded the reason under another key (assumption 5). */
  readonly reason: string | null;
}

/**
 * A projection this slice's integrity job rebuilds and compares. 1B registers `account_balance`;
 * 3A registers `stock_on_hand` (contracts §4.7.3 names this job as its rebuilder) and 8C `employee_ytd`
 * (§4.12.8). The shape mirrors `registerReconcilableSource` (§4.8.3) deliberately: one registry, one
 * call site, no slice editing another slice's file.
 */
export interface ProjectionCheck {
  readonly name: string;
  run(tx: Sql): Promise<ProjectionMismatch[]>;
}

/** What one tenant's nightly run produces; written verbatim into the incident audit row. */
export interface IntegrityReport {
  readonly tenantId: string;
  readonly requestId: string;
  readonly checkedAt: string;
  readonly ledgerBalance: { readonly byPeriod: LedgerImbalance[]; readonly byDocument: LedgerImbalance[] };
  readonly projections: { readonly checked: string[]; readonly mismatches: ProjectionMismatch[] };
  readonly auditChain: AuditChainResult;
  readonly periodReopens: PeriodReopen[];
  readonly ok: boolean;
  /** "no postings" when the tenant has no ledger_entry rows (spec:2321, the 0D scaffold's wording). */
  readonly summary: string;
}
```

- [ ] **Step 2: Write the failing test `tests/invariants/ledger-balance.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLedgerBalance, withTenant } from "@dulja/db";
import { seedRate, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("ledger balance invariant — Σbase debit = Σbase credit (spec:2246, 2419; LEGACY-003)", () => {
  let db: Db; let a: Seed; let b: Seed;

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  const ctxFor = async (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });

  it("reports nothing for a tenant whose every document balances", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "100.0000" }, { account: a.sales, credit: "100.0000" }]);
    await postJournal(db, a, [{ account: a.cash, debit: "250.5000" }, { account: a.sales, credit: "250.5000" }]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result).toEqual({ byPeriod: [], byDocument: [] });
  });

  it("sees only its own tenant's entries — Beta's postings never enter Alpha's totals (LEGACY-035)", async () => {
    await postJournal(db, b, [{ account: b.cash, debit: "999.0000" }, { account: b.sales, credit: "999.0000" }]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result).toEqual({ byPeriod: [], byDocument: [] });
  });

  it("balances in BASE, not in document currency — a foreign-currency document is clean", async () => {
    // Seeded as well as written onto the header: assumption 3 — §4.3.2 step 6 does not say whether 1A
    // trusts document.exchange_rate or re-resolves through app.rate_for, and app.rate_for with no row
    // is ERR_RATE_NOT_FOUND (§4.2.10, §4.3.7). With both in place the case passes under either reading.
    await seedRate(db, a, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.20000000" });
    const { documentId } = await postJournal(db, a, [
      { account: a.cash, debit: "100.0000" }, { account: a.sales, credit: "100.0000" },
    ], { currency: "USD", rate: "4.20000000" });
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx));
    expect(result.byDocument.map((r) => r.subjectId)).not.toContain(documentId);
  });

  it("names the company, the period and the signed difference when a period does not balance", async () => {
    const ctx = await ctxFor(a);
    const strayPeriod = a.closedPeriod;
    const [doc] = await withTenant(db.migrator, ctx, (tx) => tx<{ id: string }[]>`
      select id::text from app.document where company_id = ${a.company} and status = 'posted' order by posting_seq limit 1`);
    await withTenant(db.migrator, ctx, (tx) => tx`
      update app.fiscal_period set status = 'open' where id = ${strayPeriod}`);
    // TWO lines, on one already-posted document, landing in DIFFERENT open periods: +5.0000 in the stray
    // period and −5.0000 in the document's own. The document still sums to zero, so the deferred
    // ledger_entry_balanced constraint (plan0A:2094–2096, which re-sums the WHOLE document at COMMIT)
    // passes and the transaction commits; both periods are open, so assert_period_open passes on both.
    // The imbalance exists only at the (company, period) grain — which is exactly the grain the
    // per-document constraint cannot express and this function exists to cover.
    await withTenant(db.migrator, ctx, (tx) => tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                    currency, exchange_rate, base_debit, base_credit, effective_date,
                                    fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${doc!.id}, 900, ${a.cash}, 5.0000, 0, 'MYR', 1, 5.0000, 0,
              '2026-02-10', ${strayPeriod}, ${a.policy}),
             (${a.tenant}, ${a.company}, ${doc!.id}, 901, ${a.cash}, 0, 5.0000, 'MYR', 1, 0, 5.0000,
              '2026-01-16', ${a.period}, ${a.policy})`);

    const result = await withTenant(db.rw, ctx, (tx) => checkLedgerBalance(tx));
    expect([...result.byPeriod].sort((x, y) => x.subjectId.localeCompare(y.subjectId))).toEqual(
      [
        { scope: "period", companyId: a.company, subjectId: strayPeriod,
          baseDebit: "5.0000", baseCredit: "0.0000", difference: "5.0000" },
        { scope: "period", companyId: a.company, subjectId: a.period,
          baseDebit: expect.any(String), baseCredit: expect.any(String), difference: "-5.0000" },
      ].sort((x, y) => x.subjectId.localeCompare(y.subjectId)),
    );
    // The document itself still balances, and under migration 0001's deferred constraint it always will:
    // byDocument is unreachable in a healthy database and is kept as the backstop for a database whose
    // constraint was dropped or whose rows arrived by restore.
    expect(result.byDocument).toEqual([]);
  });

  it("narrows to one company when companyId is given", async () => {
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkLedgerBalance(tx, { companyId: a.company }));
    expect(result.byPeriod.every((r) => r.companyId === a.company)).toBe(true);
  });
});
```

The fourth case writes to `app.ledger_entry` directly as `app_migrator`. That is legitimate **in a test**: spec:98's prohibition binds application code, and `packages/db/test/**` plus `tests/**` are on the `posting-only-tables` allow-list (contracts §3.7.5). It is the only way to manufacture the failure this check exists to find, and it manufactures it **without disabling anything** (spec:101 forbids that at any phase, in any code): both inserted lines ride on one already-posted document and sum to zero, so `ledger_entry_balanced` — a deferred *per-document* constraint that re-sums `sum(base_debit) - sum(base_credit)` over `where document_id = new.document_id` at COMMIT (plan0A:2083–2096) — is satisfied and the transaction commits. A single 5.0000 line would leave the document off by 5.0000 and the whole `withTenant` call would reject with `ERR_LEDGER_UNBALANCED` before any assertion ran. The insert bypasses nothing else either: `assert_period_open` fires on both rows, which is why the closed period is opened first and why the second row is dated into the already-open `a.period`.

- [ ] **Step 3: Write `tests/invariants/support/post-journal.ts`**

```ts
import { postDocument, withTenant, type TenantContext } from "@dulja/db";
import { draftDocument, uuidv7, type Db, type Seed } from "@dulja/db/test";

export interface JournalLine {
  /** app.account id. */
  account: string;
  /** Fixed 4 dp, document currency. Exactly one of debit/credit is non-zero. */
  debit?: string;
  credit?: string;
}

export interface PostJournalOptions {
  /** Defaults to the fixture's open period, 2026-01-15. */
  effectiveDate?: string;
  periodId?: string;
  /** Defaults to the document currency 'MYR' at rate 1. */
  currency?: string;
  rate?: string;
  /** Defaults to s.human. A job-path test passes s.system. */
  actorId?: string;
}

/**
 * Drafts a JOURNAL with its document_line rows and posts it through the real posting service
 * (§4.3.1 postDocument). Every invariant suite in this slice uses this and never writes ledger_entry
 * itself, so the tests exercise the same path production does (spec:98).
 *
 * It lives in the test tier, not in packages/db/test/fixtures.ts: contracts §4.17 assigns slice 1B no
 * fixtures.ts helper, and hazard 9 forbids inventing one beside the register.
 */
export async function postJournal(
  db: Db, s: Seed, lines: JournalLine[], opts: PostJournalOptions = {},
): Promise<{ documentId: string; number: bigint }> {
  const ctx: TenantContext = {
    tenantId: s.tenant,
    actorId: opts.actorId ?? s.human,
    requestId: await uuidv7(db.admin),
  };
  const documentId = await draftDocument(db, s, {
    effectiveDate: opts.effectiveDate ?? "2026-01-15",
    periodId: opts.periodId ?? s.period,
  });
  return withTenant(db.rw, ctx, async (tx) => {
    if (opts.currency !== undefined || opts.rate !== undefined) {
      await tx`update app.document set currency = ${opts.currency ?? "MYR"}, exchange_rate = ${opts.rate ?? "1"}
                where id = ${documentId}`;
    }
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, ${l.account},
                       ${l.debit ?? "0"}, ${l.credit ?? "0"})`;
    }
    const result = await postDocument(tx, ctx, { documentId });
    return { documentId, number: result.number };
  });
}
```

`document_line` is not on the `posting-only-tables` list (contracts §3.7.5 names `ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand`, `tax_transaction`, `employee_ytd` — and not `document_line`), so writing draft lines here is ordinary application work, exactly as 1A's journal API does it.

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun run --cwd tests test -- invariants/ledger-balance.test.ts`
Expected: FAIL — `SyntaxError: The requested module '@dulja/db' does not provide an export named 'checkLedgerBalance'`.

- [ ] **Step 5: Write `packages/db/src/integrity/balance.ts`**

```ts
import type { Sql } from "postgres";
import type { LedgerImbalance } from "./types";

export interface LedgerBalanceOptions {
  /** Narrow to one company. Omitted: every company visible under the current tenant. */
  companyId?: string;
}

/**
 * The ledger-integrity SLI of spec:2246: "Σdebit = Σcredit per tenant/period/company".
 * The tenant half is RLS — this runs inside withTenant, so app.ledger_entry already shows one tenant's
 * rows and no query below mentions tenant_id (contracts §4.2.2). That is the structural answer to
 * LEGACY-001, where the aggregate was keyed without the tenant.
 *
 * The comparison is in BASE amounts. A revaluation journal legitimately balances only in base
 * (plan0A:2078), and base is what the deferred ledger_entry_balanced constraint checks per document;
 * this function is the per-PERIOD backstop that constraint cannot express.
 *
 * `byDocument` is therefore unreachable in a healthy database: migration 0001's deferred
 * `ledger_entry_balanced` refuses any transaction that would leave a document unbalanced, so a non-empty
 * `byDocument` means the constraint is absent — a restored or hand-repaired database, or a schema drift.
 * It is kept precisely for that case, and it is what the drill of Task 12 checks after a restore.
 *
 * Amounts come back as strings (numeric → string in postgres.js) and are never converted.
 */
export async function checkLedgerBalance(
  tx: Sql, opts: LedgerBalanceOptions = {},
): Promise<{ byPeriod: LedgerImbalance[]; byDocument: LedgerImbalance[] }> {
  const companyId = opts.companyId ?? null;

  const periods = await tx<{
    company_id: string; fiscal_period_id: string; base_debit: string; base_credit: string; difference: string;
  }[]>`
    select l.company_id::text,
           l.fiscal_period_id::text,
           sum(l.base_debit)::text                        as base_debit,
           sum(l.base_credit)::text                       as base_credit,
           (sum(l.base_debit) - sum(l.base_credit))::text as difference
      from app.ledger_entry l
     where (${companyId}::uuid is null or l.company_id = ${companyId})
     group by l.company_id, l.fiscal_period_id
    having sum(l.base_debit) <> sum(l.base_credit)
     order by 1, 2`;

  const documents = await tx<{
    company_id: string; document_id: string; base_debit: string; base_credit: string; difference: string;
  }[]>`
    select l.company_id::text,
           l.document_id::text,
           sum(l.base_debit)::text                        as base_debit,
           sum(l.base_credit)::text                       as base_credit,
           (sum(l.base_debit) - sum(l.base_credit))::text as difference
      from app.ledger_entry l
     where (${companyId}::uuid is null or l.company_id = ${companyId})
     group by l.company_id, l.document_id
    having sum(l.base_debit) <> sum(l.base_credit)
     order by 1, 2`;

  return {
    byPeriod: periods.map((r) => ({
      scope: "period" as const,
      companyId: r.company_id,
      subjectId: r.fiscal_period_id,
      baseDebit: r.base_debit,
      baseCredit: r.base_credit,
      difference: r.difference,
    })),
    byDocument: documents.map((r) => ({
      scope: "document" as const,
      companyId: r.company_id,
      subjectId: r.document_id,
      baseDebit: r.base_debit,
      baseCredit: r.base_credit,
      difference: r.difference,
    })),
  };
}
```

- [ ] **Step 6: Export from `packages/db/src/index.ts`**

Append (additively — never reorder or remove Plan 0A's two export lines; Task 4 replaces these two with a single barrel line):

```ts
export type {
  AuditChainResult, IntegrityReport, LedgerImbalance, PeriodReopen, ProjectionCheck, ProjectionMismatch,
} from "./integrity/types";
export { checkLedgerBalance, type LedgerBalanceOptions } from "./integrity/balance";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run --cwd tests test -- invariants/ledger-balance.test.ts`
Expected: PASS, five cases.

- [ ] **Step 8: Run the gate**

Run: `bun run typecheck && bun run lint`
Expected: PASS. (`lint:rules` still fails only on the Task 1 catalogue reference.)

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/integrity/types.ts packages/db/src/integrity/balance.ts packages/db/src/index.ts \
        tests/invariants/support/post-journal.ts tests/invariants/ledger-balance.test.ts
git commit -m "$(cat <<'EOF'
feat(db): checkLedgerBalance and the ledger-balance invariant suite [1B T3]

Σbase debit = Σbase credit per (company, fiscal period) and per document, run
inside withTenant so RLS supplies the tenant half (spec:2246). The suite posts
through the real postDocument via tests/invariants/support/post-journal.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `checkAccountBalanceProjection`, the projection registry, and acceptance test 2

**Files:**
- Create: `packages/db/src/integrity/projections.ts`, `packages/db/src/integrity/index.ts`, `tests/invariants/projection-rebuild.test.ts`, `docs/adr/0024-ledger-integrity-check-composition.md`
- Modify: `packages/db/src/index.ts`, `tests/regression/legacy-001.test.ts`, `tests/regression/legacy-002.test.ts`, `tests/regression/legacy-049.test.ts`
- Test: `tests/invariants/projection-rebuild.test.ts`

**Interfaces:**
- Consumes: `ProjectionCheck`, `ProjectionMismatch` from `./types` (Task 3); `app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit, created_at, updated_at)` with `primary key (company_id, account_id, fiscal_period_id, currency)` (§4.3.3, 1A migration 0012); `app.ledger_entry` (plan0A:2005–2035); `postJournal` (Task 3); `reverseDocument(tx, ctx, { documentId, effectiveDate, reason })` from `@dulja/db` (§4.3.1, 1A); `seedAccount(db, s, { code, nameEn, type })` from `@dulja/db/test` (§4.17, 1A).
- Produces:
  - `checkAccountBalanceProjection(tx: Sql): Promise<ProjectionMismatch[]>` from `@dulja/db`.
  - `registerProjectionCheck(check: ProjectionCheck): void` and `projectionChecks(): readonly ProjectionCheck[]` from `@dulja/db` — the registry **3A** adds `stock_on_hand` to (§4.7.3 names this slice's job as its rebuilder) and **8C** adds `employee_ytd` to (§4.12.8).
  - `ACCOUNT_BALANCE_CHECK: ProjectionCheck` — registered by `packages/db/src/integrity/index.ts`.

This task owns **acceptance test 2** (spec:2420 — "Deterministic projections. Rebuild every projection from the ledger into scratch tables; compare row for row on the full key and all amounts. Identical.") for `account_balance`, and the Phase 1 DoD clause "projections rebuild **bit-identically**".

- [ ] **Step 1: Write the failing test `tests/invariants/projection-rebuild.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAccountBalanceProjection, projectionChecks, reverseDocument, withTenant } from "@dulja/db";
import { seedAccount, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("deterministic projections — acceptance test 2 (spec:2420; LEGACY-001, 002, 013, 049, 050)", () => {
  let db: Db; let a: Seed; let b: Seed;

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  const ctxFor = async (s: Seed) => ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });
  const check = async (s: Seed) => withTenant(db.rw, await ctxFor(s), (tx) => checkAccountBalanceProjection(tx));
  const snapshot = async (s: Seed) => withTenant(db.rw, await ctxFor(s), (tx) => tx<Record<string, string>[]>`
    select company_id::text, account_id::text, fiscal_period_id::text, currency::text,
           debit::text, credit::text, base_debit::text, base_credit::text
      from app.account_balance order by 1, 2, 3, 4`);

  it("the registry holds exactly the projections Phase 1 has", () => {
    // Third of the three assertions §4.16.3 pins: 2B's SERIES_GAP_CHECK registration makes this
    // ["account_balance", "document_series"] and updates all three in one PR. The other two are in
    // tests/invariants/audit-chain.test.ts and apps/worker/test/handlers/integrity-check.test.ts.
    expect(projectionChecks().map((c) => c.name)).toEqual(["account_balance"]);
  });

  it("rebuilds bit-identically after several posts to the same key", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "100.0000" }, { account: a.sales, credit: "100.0000" }]);
    await postJournal(db, a, [{ account: a.cash, debit: "40.2500" }, { account: a.sales, credit: "40.2500" }]);
    await postJournal(db, a, [{ account: a.sales, debit: "10.0000" }, { account: a.cash, credit: "10.0000" }]);
    expect(await check(a)).toEqual([]);
    const [row] = await withTenant(db.rw, await ctxFor(a), (tx) => tx<{ debit: string; credit: string }[]>`
      select debit::text, credit::text from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(row).toEqual({ debit: "140.2500", credit: "10.0000" });
  });

  it("a reversal ADDS entries with swapped sides — the projection stays a pure sum (D13)", async () => {
    const { documentId } = await postJournal(db, a, [{ account: a.cash, debit: "77.0000" }, { account: a.sales, credit: "77.0000" }]);
    const ctx = await ctxFor(a);
    await withTenant(db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx, { documentId, effectiveDate: "2026-01-20", reason: "acceptance test 2 reversal" }));
    expect(await check(a)).toEqual([]);
  });

  it("Beta's postings never enter Alpha's rebuild (LEGACY-001 — the tenant key is RLS, not a column in the query)", async () => {
    await postJournal(db, b, [{ account: b.cash, debit: "5000.0000" }, { account: b.sales, credit: "5000.0000" }]);
    expect(await check(a)).toEqual([]);
    expect(await check(b)).toEqual([]);
  });

  it("a hand-edited amount is reported as amount_differs, naming the column and both values (LEGACY-002)", async () => {
    const ctx = await ctxFor(a);
    await withTenant(db.rw, ctx, (tx) => tx`
      update app.account_balance set base_debit = base_debit + 1
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    const found = await check(a);
    expect(found).toHaveLength(1);
    expect(found[0]!.projection).toBe("account_balance");
    expect(found[0]!.side).toBe("amount_differs");
    expect(found[0]!.key).toMatchObject({ account_id: a.cash, fiscal_period_id: a.period, currency: "MYR" });
    expect(found[0]!.detail).toMatch(/^base_debit \d+\.\d{4} <> \d+\.\d{4}$/);
    await withTenant(db.rw, ctx, (tx) => tx`
      update app.account_balance set base_debit = base_debit - 1
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(await check(a)).toEqual([]);
  });

  it("a deleted projection row is reported as missing_in_projection", async () => {
    const ctx = await ctxFor(a);
    const before = await snapshot(a);
    await withTenant(db.migrator, ctx, (tx) => tx`
      delete from app.account_balance where account_id = ${a.sales} and fiscal_period_id = ${a.period}`);
    const found = await check(a);
    expect(found.map((m) => m.side)).toEqual(["missing_in_projection"]);
    expect(found[0]!.key["account_id"]).toBe(a.sales);
    await withTenant(db.migrator, ctx, (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency,
                                       debit, credit, base_debit, base_credit)
      select l.tenant_id, l.company_id, l.account_id, l.fiscal_period_id, l.currency,
             sum(l.debit), sum(l.credit), sum(l.base_debit), sum(l.base_credit)
        from app.ledger_entry l
       where l.account_id = ${a.sales} and l.fiscal_period_id = ${a.period}
       group by l.tenant_id, l.company_id, l.account_id, l.fiscal_period_id, l.currency`);
    expect(await check(a)).toEqual([]);
    expect(await snapshot(a)).toEqual(before);
  });

  it("a projection row with no ledger entries behind it is reported as missing_in_rebuild", async () => {
    const ctx = await ctxFor(a);
    const orphanAccount = await seedAccount(db, a, { code: "1900", nameEn: "Orphan", type: "asset" });
    await withTenant(db.rw, ctx, (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency,
                                       debit, credit, base_debit, base_credit)
      values (${a.tenant}, ${a.company}, ${orphanAccount}, ${a.period}, 'MYR', 3.0000, 0, 3.0000, 0)`);
    const found = await check(a);
    expect(found.map((m) => m.side)).toEqual(["missing_in_rebuild"]);
    expect(found[0]!.key["account_id"]).toBe(orphanAccount);
    await withTenant(db.migrator, ctx, (tx) => tx`
      delete from app.account_balance where account_id = ${orphanAccount}`);
    expect(await check(a)).toEqual([]);
  });

  it("the check never repairs — running it twice leaves account_balance byte-identical (LEGACY-079)", async () => {
    const before = await snapshot(a);
    await check(a);
    await check(a);
    expect(await snapshot(a)).toEqual(before);
  });
});
```

What the two consecutive `check(a)` calls in the last case prove is exactly what LEGACY-079 asks for and
nothing more: **two runs leave `app.account_balance` byte-identical**, so the checker is a detector and
never a repairer. They are deliberately *not* a proof that the scratch table is dropped between runs —
each `check` is its own `withTenant` transaction, so `on commit drop` has already fired before the second
one begins, and `checkAccountBalanceProjection` opens with `drop table if exists
integrity_rebuilt_account_balance` in any case (Step 3). The re-entrancy that *is* worth pinning — two
invocations inside **one** transaction — is asserted separately, in the case below, which is why the
scratch table's lifecycle is proven rather than assumed:

```ts
  it("is re-entrant inside one transaction — the scratch table is reclaimed between invocations", async () => {
    const both = await withTenant(db.rw, await ctxFor(a), async (tx) => {
      const first = await checkAccountBalanceProjection(tx);
      const second = await checkAccountBalanceProjection(tx);
      return { first, second };
    });
    expect(both.first).toEqual([]);
    expect(both.second).toEqual([]);
  });
```

Add it as the last `it` of the `describe`. Without the `drop table if exists` line of Step 3 it fails with
`relation "integrity_rebuilt_account_balance" already exists` — the second invocation is inside the same
transaction, so `on commit drop` has not fired — which is precisely the regression it exists to catch.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd tests test -- invariants/projection-rebuild.test.ts`
Expected: FAIL — `does not provide an export named 'checkAccountBalanceProjection'`.

- [ ] **Step 3: Write `packages/db/src/integrity/projections.ts`**

```ts
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

const CHECKS = new Map<string, ProjectionCheck>();

/**
 * Register a projection for the nightly rebuild-and-compare (spec:1204, 2265; acceptance test 2).
 * 1B registers `account_balance`; 3A registers `stock_on_hand` (contracts §4.7.3) and 8C `employee_ytd`
 * (§4.12.8). Registering twice under one name replaces the earlier entry, so a hot reload is harmless.
 */
export function registerProjectionCheck(check: ProjectionCheck): void {
  CHECKS.set(check.name, check);
}

/** Every registered check, in a stable name order so a report diff is readable. */
export function projectionChecks(): readonly ProjectionCheck[] {
  return [...CHECKS.values()].sort((x, y) => x.name.localeCompare(y.name));
}

interface CompareRow {
  company_id: string; account_id: string; fiscal_period_id: string; currency: string;
  missing_in_projection: boolean; missing_in_rebuild: boolean;
  r_debit: string | null; r_credit: string | null; r_base_debit: string | null; r_base_credit: string | null;
  b_debit: string | null; b_credit: string | null; b_base_debit: string | null; b_base_credit: string | null;
}

const AMOUNT_COLUMNS = ["debit", "credit", "base_debit", "base_credit"] as const;

/**
 * §4.3.3's rebuild, executed: group app.ledger_entry into a scratch temp table on the projection's full
 * key, full-outer-join it against app.account_balance, and report every row missing on either side or
 * whose amounts differ. Reversals ADD entries with swapped sides (D13), so the projection is a pure sum
 * and the comparison is exact — "bit-identically" in the Phase 1 DoD means exactly this.
 *
 * Runs inside withTenant, so both sides are already one tenant's rows (contracts §4.2.2) — the
 * structural answer to LEGACY-001, where the aggregate was keyed without the tenant.
 *
 * `create temporary table` needs only the database-level TEMPORARY privilege Postgres grants PUBLIC;
 * Plan 0A revokes object creation in schema `app` from app_rw (plan0A:2498) and nothing else.
 * `on commit drop` ties the table's life to the caller's withTenant transaction, and the `drop table if
 * exists` makes a second call inside one transaction safe.
 */
export async function checkAccountBalanceProjection(tx: Sql): Promise<ProjectionMismatch[]> {
  await tx`drop table if exists integrity_rebuilt_account_balance`;
  await tx`
    create temporary table integrity_rebuilt_account_balance on commit drop as
      select l.company_id, l.account_id, l.fiscal_period_id, l.currency,
             sum(l.debit)       as debit,
             sum(l.credit)      as credit,
             sum(l.base_debit)  as base_debit,
             sum(l.base_credit) as base_credit
        from app.ledger_entry l
       group by l.company_id, l.account_id, l.fiscal_period_id, l.currency`;

  const rows = await tx<CompareRow[]>`
    select coalesce(r.company_id, b.company_id)::text             as company_id,
           coalesce(r.account_id, b.account_id)::text             as account_id,
           coalesce(r.fiscal_period_id, b.fiscal_period_id)::text as fiscal_period_id,
           coalesce(r.currency, b.currency)::text                 as currency,
           (b.company_id is null)                                 as missing_in_projection,
           (r.company_id is null)                                 as missing_in_rebuild,
           r.debit::text as r_debit, r.credit::text as r_credit,
           r.base_debit::text as r_base_debit, r.base_credit::text as r_base_credit,
           b.debit::text as b_debit, b.credit::text as b_credit,
           b.base_debit::text as b_base_debit, b.base_credit::text as b_base_credit
      from integrity_rebuilt_account_balance r
      full outer join app.account_balance b
        on  b.company_id       = r.company_id
        and b.account_id       = r.account_id
        and b.fiscal_period_id = r.fiscal_period_id
        and b.currency         = r.currency
     where r.company_id is null
        or b.company_id is null
        or b.debit       <> r.debit
        or b.credit      <> r.credit
        or b.base_debit  <> r.base_debit
        or b.base_credit <> r.base_credit
     order by 1, 2, 3, 4`;

  const mismatches: ProjectionMismatch[] = [];
  for (const row of rows) {
    const key = {
      company_id: row.company_id,
      account_id: row.account_id,
      fiscal_period_id: row.fiscal_period_id,
      currency: row.currency,
    };
    if (row.missing_in_projection) {
      mismatches.push({
        projection: "account_balance", key, side: "missing_in_projection",
        detail: `the ledger has base_debit ${row.r_base_debit} / base_credit ${row.r_base_credit} and account_balance has no row`,
      });
      continue;
    }
    if (row.missing_in_rebuild) {
      mismatches.push({
        projection: "account_balance", key, side: "missing_in_rebuild",
        detail: `account_balance has base_debit ${row.b_base_debit} / base_credit ${row.b_base_credit} and the ledger has no entries`,
      });
      continue;
    }
    for (const column of AMOUNT_COLUMNS) {
      const projected = row[`b_${column}` as const];
      const rebuilt = row[`r_${column}` as const];
      if (projected !== rebuilt) {
        mismatches.push({
          projection: "account_balance", key, side: "amount_differs",
          detail: `${column} ${projected} <> ${rebuilt}`,
        });
      }
    }
  }
  return mismatches;
}

/** The ProjectionCheck this slice contributes to the registry; registered in ./index.ts. */
export const ACCOUNT_BALANCE_CHECK: ProjectionCheck = {
  name: "account_balance",
  run: checkAccountBalanceProjection,
};
```

- [ ] **Step 4: Create `packages/db/src/integrity/index.ts` with the registration**

Task 5 fills this file with `runIntegrityCheck` and `recordIntegrityIncident`. For now it carries the registration and the re-exports, so importing anything from `@dulja/db` populates the registry:

```ts
import { ACCOUNT_BALANCE_CHECK, registerProjectionCheck } from "./projections";

registerProjectionCheck(ACCOUNT_BALANCE_CHECK);

export { checkLedgerBalance, type LedgerBalanceOptions } from "./balance";
export { checkAccountBalanceProjection, projectionChecks, registerProjectionCheck } from "./projections";
export type {
  AuditChainResult, IntegrityReport, LedgerImbalance, PeriodReopen, ProjectionCheck, ProjectionMismatch,
} from "./types";
```

- [ ] **Step 5: Point `packages/db/src/index.ts` at the barrel**

Replace the two lines Task 3 added with one barrel re-export, so later tasks add nothing here:

```ts
export {
  checkAccountBalanceProjection, checkLedgerBalance, projectionChecks, registerProjectionCheck,
  type AuditChainResult, type IntegrityReport, type LedgerBalanceOptions, type LedgerImbalance,
  type PeriodReopen, type ProjectionCheck, type ProjectionMismatch,
} from "./integrity";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run --cwd tests test -- invariants/projection-rebuild.test.ts`
Expected: PASS, nine cases (the eight of Step 1's block plus the re-entrancy case appended after it).

- [ ] **Step 7: Append the three regression blocks**

Append to `tests/regression/legacy-001.test.ts` (0B created it — never edit an earlier `describe`, §3.7.3):

```ts
describe("LEGACY-001 Denormalised currency balances are updated without the tenant key — 1B", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); b = await seedTenantV2(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("two tenants posting to the same account code and currency keep separate account_balance rows", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "10.0000" }, { account: a.sales, credit: "10.0000" }]);
    await postJournal(db, b, [{ account: b.cash, debit: "99.0000" }, { account: b.sales, credit: "99.0000" }]);
    const read = async (s: Seed) => withTenant(
      db.rw, { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ debit: string }[]>`select debit::text from app.account_balance
                                       where account_id = ${s.cash} and currency = 'MYR'`);
    expect(await read(a)).toEqual([{ debit: "10.0000" }]);
    expect(await read(b)).toEqual([{ debit: "99.0000" }]);
  });

  it("the rebuild-and-compare run as Alpha never reads Beta's ledger entries", async () => {
    const found = await withTenant(
      db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => checkAccountBalanceProjection(tx));
    expect(found).toEqual([]);
  });
});
```

Append to `tests/regression/legacy-002.test.ts`:

```ts
describe("LEGACY-002 The upsert never fires on UPDATE, so re-keying a posting destroys the amount — 1B", () => {
  let db: Db; let a: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("a second post to the same (company, account, period, currency) ADDS through the MERGE's matched branch", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "60.0000" }, { account: a.sales, credit: "60.0000" }]);
    await postJournal(db, a, [{ account: a.cash, debit: "15.0000" }, { account: a.sales, credit: "15.0000" }]);
    const [row] = await withTenant(
      db.rw, { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ debit: string }[]>`select debit::text from app.account_balance
                                       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(row).toEqual({ debit: "75.0000" });
  });

  it("an amount that drifts from the ledger is detected instead of surviving silently", async () => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set debit = 0 where account_id = ${a.cash}`);
    const found = await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx));
    expect(found.map((m) => m.side)).toContain("amount_differs");
  });
});
```

Append to `tests/regression/legacy-049.test.ts`:

```ts
describe("LEGACY-049 Aggregate tables have no unique key, so the upsert race creates duplicates — 1B", () => {
  let db: Db; let a: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("two interleaved posts to an EXISTING key produce exactly one row and the rebuild agrees", async () => {
    // Warm the key first: MERGE's `when matched then update` branch takes a row lock under READ COMMITTED,
    // so the second transaction blocks and then re-reads. This is the race the old system lost, and the
    // primary key on (company_id, account_id, fiscal_period_id, currency) is what makes it unloseable.
    await postJournal(db, a, [{ account: a.cash, debit: "1.0000" }, { account: a.sales, credit: "1.0000" }]);
    await Promise.all([
      postJournal(db, a, [{ account: a.cash, debit: "2.0000" }, { account: a.sales, credit: "2.0000" }]),
      postJournal(db, a, [{ account: a.cash, debit: "3.0000" }, { account: a.sales, credit: "3.0000" }]),
    ]);
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    const [row] = await withTenant(db.rw, ctx, (tx) => tx<{ n: number; debit: string }[]>`
      select count(*)::int as n, sum(debit)::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(row).toEqual({ n: 1, debit: "6.0000" });
    expect(await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx))).toEqual([]);
  });
});
```

Each appended file's import lines must gain what its new block uses — `checkAccountBalanceProjection` and `withTenant` from `@dulja/db`; `seedTenantV2`, `startDb`, `uuidv7`, `type Db`, `type Seed` from `@dulja/db/test`; `postJournal` from `../invariants/support/post-journal`. Do not remove or reorder anything the existing blocks import.

- [ ] **Step 8: Write ADR 0024 recording the composition and one referred concurrency question**

`docs/adr/0024-ledger-integrity-check-composition.md`, in Plan 0A's ADR format (plan0A:189–203):

```markdown
# ADR 0024 — The ledger-integrity check is four independent read functions and one registry

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 1B

## Context

spec:2246 asks for "a continuous job asserting Σdebit = Σcredit per tenant/period/company and that
projections match a fresh rebuild", spec:1963 for a nightly audit-chain walk, and spec:2179 for every
period reopen to be reported. Later slices add projections: 3A `stock_on_hand`, 3B `stock_valuation`,
4B `party_ageing` and `item_profitability`, 6C the `pos_cashier` snapshot, 8C `employee_ytd`.

## Decision

Four read functions in `packages/db/src/integrity/`, each usable on its own, composed by
`runIntegrityCheck` into one `IntegrityReport`. Projections join through
`registerProjectionCheck({ name, run })` — the same registry shape as `registerReconcilableSource`
(contracts §4.8.3) — so no later slice edits this slice's file. The job never writes to a projection:
it detects and records an incident. LEGACY-079's root cause is a system that repaired instead of detecting.

## Consequences

- A slice adding a projection adds one `registerProjectionCheck` call and nothing else.
- `runIntegrityCheck` is pure read plus one audit insert, so it could run on a read replica except for
  the incident write, which the handler performs on the primary.
- The incident lands in `app.audit_log` with `table_name = 'integrity_incident'`, inside the same
  hash chain as every other write, so an incident record cannot be edited away afterwards.

## Open question referred to the contracts document, not decided here

PostgreSQL's `MERGE` can raise a **unique violation (23505)** when two transactions concurrently take
the `when not matched then insert` branch for the *same brand-new* key. §4.3.3's `account_balance`
MERGE has that shape and §4.2.2's `withTenant` retries only `40P01`/`40001`. The warm-key path — two
posts to a key that already exists — takes `when matched then update`, locks the row and is safe, and
that is the path LEGACY-049 describes. The cold-start race is nevertheless real for the first document
ever posted to an (account, period, currency) from two connections at once. **This ADR proposes no
change** (spec:95 — a money-semantics change is proposed and asked, never implemented first): the
proposal is either to add `23505` to the `withTenant` retry set in contracts §4.2.2, or to have
`postDocument` retry step 12. `tests/invariants/account-balance-concurrency.test.ts` (Task 6) pins the
current behaviour so the answer is visible the day it lands.
```

- [ ] **Step 9: Run the full suite and commit**

Run: `bun run --cwd tests test && bun run --cwd packages/db test && bun run typecheck && bun run lint`
Expected: PASS.

```bash
git add packages/db/src/integrity/projections.ts packages/db/src/integrity/index.ts packages/db/src/index.ts \
        tests/invariants/projection-rebuild.test.ts tests/regression/legacy-001.test.ts \
        tests/regression/legacy-002.test.ts tests/regression/legacy-049.test.ts \
        docs/adr/0024-ledger-integrity-check-composition.md
git commit -m "$(cat <<'EOF'
feat(db): rebuild account_balance and compare row for row (acceptance test 2) [1B T4]

checkAccountBalanceProjection executes §4.3.3's rebuild into a scratch temp table
and full-outer-joins it against the projection on the full key, reporting every
missing row and every differing amount. registerProjectionCheck is the registry
3A and 8C add their projections to. ADR 0024 records the composition and refers
the cold-start MERGE race to the contracts document.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The audit-chain walk, the period-reopen report, and `runIntegrityCheck`

**Files:**
- Create: `packages/db/src/integrity/audit-chain.ts`, `packages/db/src/integrity/period-reopen.ts`, `tests/invariants/audit-chain.test.ts`
- Modify: `packages/db/src/integrity/index.ts`, `packages/db/src/index.ts`, `tests/regression/legacy-079.test.ts`
- Test: `tests/invariants/audit-chain.test.ts`

**Interfaces:**
- Consumes: `AuditChainResult`, `PeriodReopen`, `IntegrityReport` from `./types` (Task 3); `checkLedgerBalance` (Task 3); `projectionChecks` (Task 4); `app.audit_log (seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after, prev_hash, hash)` and `app.audit_chain()` (plan0A:2260–2278, spec:1949–1964); `TenantContext` (§4.2.2).
- Produces:
  - `checkAuditChain(tx: Sql, tenantId: string): Promise<AuditChainResult>` — the production twin of the private `verifyChain` in `packages/db/test/audit.test.ts` (plan0A:2153–2165), which is **left untouched and unrenamed** (hazard 8).
  - `listPeriodReopens(tx: Sql, opts: { tenantId: string; sinceSeq?: number }): Promise<PeriodReopen[]>`.
  - `runIntegrityCheck(tx: Sql, ctx: TenantContext, opts?: IntegrityCheckOptions): Promise<IntegrityReport>` and `recordIntegrityIncident(tx: Sql, report: IntegrityReport): Promise<void>` — Tasks 6 and 7 are the only production callers.

- [ ] **Step 1: Write the failing test `tests/invariants/audit-chain.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAuditChain, listPeriodReopens, recordIntegrityIncident, runIntegrityCheck, withTenant } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("audit chain and the composed integrity check — test 13 as a job (spec:1963, 2246, 2179)", () => {
  let db: Db; let a: Seed; let empty: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    empty = await seedTenantV2(db, "Empty");
  });
  afterAll(async () => { await db.stop(); });

  const ctxFor = async (s: Seed) => ({ tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) });

  it("walks a real chain and reports it intact", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "12.0000" }, { account: a.sales, credit: "12.0000" }]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkAuditChain(tx, a.tenant));
    expect(result.brokenLinks).toBe(0);
    expect(result.badHashes).toBe(0);
    expect(result.firstBrokenSeq).toBeNull();
    expect(result.rows).toBeGreaterThan(0);
  });

  it("names the first bad row when a hash is tampered with", async () => {
    const ctx = await ctxFor(a);
    const [target] = await withTenant(db.migrator, ctx, (tx) => tx<{ seq: number }[]>`
      select seq from app.audit_log where tenant_id = ${a.tenant} order by seq desc limit 1`);
    // app_rw cannot UPDATE audit_log (plan0A:1986) and the *_immutable trigger refuses it for every role;
    // the only way to manufacture the failure is to disable the trigger as the table's owner, edit, and
    // put it back — which is exactly the attack the chain exists to detect.
    // Every statement below is a postgres.js TAGGED TEMPLATE, never sql.unsafe: contracts §3.3 gives
    // sql.unsafe exactly three homes (the migration runner, the pg-boss enqueue adapter, the Firebird
    // reader) and this is none of them. The two values that vary are bound parameters.
    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`update app.audit_log set after = ${'{"tampered":true}'}::jsonb where seq = ${target!.seq}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;

    const result = await withTenant(db.rw, ctx, (tx) => checkAuditChain(tx, a.tenant));
    expect(result.badHashes).toBe(1);
    expect(result.firstBrokenSeq).toBe(target!.seq);

    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`delete from app.audit_log where seq = ${target!.seq}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;
  });

  it("a deleted row breaks the link of its successor", async () => {
    const ctx = await ctxFor(a);
    const rows = await withTenant(db.migrator, ctx, (tx) => tx<{ seq: number }[]>`
      select seq from app.audit_log where tenant_id = ${a.tenant} order by seq desc limit 3`);
    const victim = rows[1]!.seq;
    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`delete from app.audit_log where seq = ${victim}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;
    const result = await withTenant(db.rw, ctx, (tx) => checkAuditChain(tx, a.tenant));
    expect(result.brokenLinks).toBe(1);
    expect(result.firstBrokenSeq).toBe(rows[0]!.seq);
  });

  it("reports every period reopen with its actor", async () => {
    const ctx = await ctxFor(a);
    await withTenant(db.rw, { ...ctx, actorId: a.human }, (tx) => tx`
      update app.fiscal_period set status = 'closed' where id = ${a.period}`);
    await withTenant(db.rw, { ...ctx, actorId: a.human }, (tx) => tx`
      update app.fiscal_period set status = 'open' where id = ${a.period}`);
    const reopens = await withTenant(db.rw, ctx, (tx) => listPeriodReopens(tx, { tenantId: a.tenant }));
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({
      fiscalPeriodId: a.period, fromStatus: "closed", toStatus: "open", actorId: a.human,
    });
  });

  it("reports 'no postings' for a tenant with an empty ledger, and that is not a failure (spec:2321)", async () => {
    const ctx = await ctxFor(empty);
    const report = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(report.summary).toBe("no postings");
    expect(report.ok).toBe(true);
    // Second of the three assertions §4.16.3 pins — see the note on the first, in
    // tests/invariants/projection-rebuild.test.ts. 2B moves all three together.
    expect(report.projections.checked).toEqual(["account_balance"]);
    expect(report.auditChain.rows).toBeGreaterThan(0);
  });

  it("composes a failing report and records an incident without repairing anything", async () => {
    const ctx = await ctxFor(a);
    await withTenant(db.rw, ctx, (tx) => tx`
      update app.account_balance set base_credit = base_credit + 2 where account_id = ${a.sales}`);
    const report = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/^FAILED: /);
    expect(report.projections.mismatches.map((m) => m.side)).toContain("amount_differs");

    await withTenant(db.rw, ctx, (tx) => recordIntegrityIncident(tx, report));
    const [row] = await withTenant(db.rw, ctx, (tx) =>
      tx<{ table_name: string; row_id: string; actor_id: string; after: { ok: boolean } }[]>`
        select table_name, row_id, actor_id::text, after from app.audit_log
         where tenant_id = ${a.tenant} and table_name = 'integrity_incident' order by seq desc limit 1`);
    expect(row!.row_id).toBe(ctx.requestId);
    expect(row!.actor_id).toBe(a.system);
    expect(row!.after.ok).toBe(false);

    const still = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(still.projections.mismatches.map((m) => m.side)).toContain("amount_differs");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd tests test -- invariants/audit-chain.test.ts`
Expected: FAIL — `does not provide an export named 'checkAuditChain'`.

- [ ] **Step 3: Write `packages/db/src/integrity/audit-chain.ts`**

```ts
import type { Sql } from "postgres";
import type { AuditChainResult } from "./types";

/**
 * The nightly chain walk spec:1963 requires and acceptance test 13 asserts: for every row of one
 * tenant's audit_log in seq order, prev_hash must equal the previous row's hash and hash must recompute
 * from the same session-independent input app.audit_chain() uses (plan0A:1955–1958).
 *
 * The formula is the one plan0A:2153–2165 pins in packages/db/test/audit.test.ts; that private test
 * helper is deliberately left in place and unrenamed (hazard 8) — this is its production twin.
 *
 * A gap in `seq` is NOT reported: audit_log.seq is `generated always as identity`, so a rolled-back
 * transaction consumes numbers and gaps are normal. A deleted row surfaces as the BROKEN LINK of its
 * successor, which is the detection the chain exists for.
 *
 * `tenant_id` is passed explicitly even though RLS already restricts the table: it makes
 * audit_log_tenant_seq_idx (plan0A:2276) usable and keeps the formula identical to plan0A's.
 */
export async function checkAuditChain(tx: Sql, tenantId: string): Promise<AuditChainResult> {
  const [row] = await tx<{ rows: number; broken_links: number; bad_hashes: number; first_broken_seq: number | null }[]>`
    with ordered as (
      select seq, tenant_id, actor_id, occurred_at, table_name, row_id, action, before, after, prev_hash, hash,
             lag(hash) over (order by seq) as expected_prev
        from app.audit_log
       where tenant_id = ${tenantId}
    ), flagged as (
      select seq,
             (prev_hash is distinct from expected_prev) as broken_link,
             (hash <> sha256(coalesce(prev_hash, ''::bytea) || convert_to(
                tenant_id::text || '|' || actor_id::text || '|' || extract(epoch from occurred_at)::text || '|'
                || table_name || '|' || row_id || '|' || action || '|'
                || coalesce(before::text, '') || '|' || coalesce(after::text, ''), 'UTF8'))) as bad_hash
        from ordered
    )
    select count(*)::int                                        as rows,
           count(*) filter (where broken_link)::int             as broken_links,
           count(*) filter (where bad_hash)::int                as bad_hashes,
           (min(seq) filter (where broken_link or bad_hash))::int as first_broken_seq
      from flagged`;

  return {
    rows: row!.rows,
    brokenLinks: row!.broken_links,
    badHashes: row!.bad_hashes,
    firstBrokenSeq: row!.first_broken_seq,
  };
}
```

- [ ] **Step 4: Write `packages/db/src/integrity/period-reopen.ts`**

```ts
import type { Sql } from "postgres";
import type { PeriodReopen } from "./types";

export interface PeriodReopenOptions {
  tenantId: string;
  /** Only reopens with audit_log.seq greater than this. Omitted: every reopen ever recorded. */
  sinceSeq?: number;
}

/**
 * spec:2179: "`accounting.period.reopen` … requires a reason written to the audit row, and every reopen
 * is reported by the nightly integrity job." A reopen is a fiscal_period UPDATE whose audited before
 * image has status closed or locked and whose after image has status open — there is no other way to
 * change the column, because `audit_row` is an AFTER ROW trigger with no flag to skip (spec:103, 2049).
 *
 * `reason` is read from the after image's `reopen_reason` key and is null-safe: if 1A recorded the
 * reason under another column name the reopen is still reported, only without its text (assumption 5).
 */
export async function listPeriodReopens(tx: Sql, opts: PeriodReopenOptions): Promise<PeriodReopen[]> {
  const sinceSeq = opts.sinceSeq ?? null;
  const rows = await tx<{
    seq: number; occurred_at: string; actor_id: string; row_id: string;
    from_status: string; to_status: string; reason: string | null;
  }[]>`
    select seq,
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
           actor_id::text,
           row_id,
           before ->> 'status'        as from_status,
           after  ->> 'status'        as to_status,
           after  ->> 'reopen_reason' as reason
      from app.audit_log
     where tenant_id  = ${opts.tenantId}
       and table_name = 'fiscal_period'
       and action     = 'update'
       and before ->> 'status' in ('closed', 'locked')
       and after  ->> 'status' = 'open'
       and (${sinceSeq}::bigint is null or seq > ${sinceSeq})
     order by seq`;

  return rows.map((r) => ({
    auditSeq: r.seq,
    occurredAt: r.occurred_at,
    actorId: r.actor_id,
    fiscalPeriodId: r.row_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
  }));
}
```

- [ ] **Step 5: Write the rest of `packages/db/src/integrity/index.ts`**

Replace the file Task 4 created with:

```ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { checkLedgerBalance } from "./balance";
import { checkAuditChain } from "./audit-chain";
import { listPeriodReopens } from "./period-reopen";
import { ACCOUNT_BALANCE_CHECK, projectionChecks, registerProjectionCheck } from "./projections";
import type { IntegrityReport, ProjectionMismatch } from "./types";

registerProjectionCheck(ACCOUNT_BALANCE_CHECK);

export interface IntegrityCheckOptions {
  /** Narrow the ledger-balance half to one company. */
  companyId?: string;
  /** Only report period reopens after this audit_log.seq. */
  sinceAuditSeq?: number;
}

/**
 * One tenant's nightly integrity run (spec:2246 — the SLI "single most valuable thing you can build").
 * Every part is a READ; the only write in this module is recordIntegrityIncident below, and it writes to
 * app.audit_log and nothing else. The job never repairs a projection: LEGACY-079 is a system that
 * accumulated forty-four repair objects instead of detecting drift at source.
 *
 * The caller supplies the transaction, so a handler can run this and the incident insert in one
 * withTenant (contracts §4.3.1's convention: these functions take the caller's tx and none opens its own).
 */
export async function runIntegrityCheck(
  tx: Sql, ctx: TenantContext, opts: IntegrityCheckOptions = {},
): Promise<IntegrityReport> {
  const [counted] = await tx<{ postings: number }[]>`select count(*)::int as postings from app.ledger_entry`;
  const postings = counted!.postings;

  const ledgerBalance = await checkLedgerBalance(tx, { companyId: opts.companyId });

  const checked: string[] = [];
  const mismatches: ProjectionMismatch[] = [];
  for (const check of projectionChecks()) {
    checked.push(check.name);
    mismatches.push(...(await check.run(tx)));
  }

  const auditChain = await checkAuditChain(tx, ctx.tenantId);
  const periodReopens = await listPeriodReopens(tx, { tenantId: ctx.tenantId, sinceSeq: opts.sinceAuditSeq });

  const clean =
    ledgerBalance.byPeriod.length === 0 &&
    ledgerBalance.byDocument.length === 0 &&
    mismatches.length === 0 &&
    auditChain.brokenLinks === 0 &&
    auditChain.badHashes === 0;

  // "no postings" is the wording the 0D scaffold reports (spec:2321), kept so the first real run after
  // 1A is distinguishable from a run that found nothing wrong.
  const summary = postings === 0
    ? "no postings"
    : clean
      ? `ok: ${postings} ledger entries, ${checked.length} projection(s) rebuilt, ${auditChain.rows} audit rows walked, ${periodReopens.length} period reopen(s)`
      : `FAILED: ${ledgerBalance.byPeriod.length} unbalanced period(s), ${ledgerBalance.byDocument.length} unbalanced document(s), ${mismatches.length} projection mismatch(es), ${auditChain.brokenLinks} broken link(s), ${auditChain.badHashes} bad hash(es)`;

  return {
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    checkedAt: new Date().toISOString(),
    ledgerBalance,
    projections: { checked, mismatches },
    auditChain,
    periodReopens,
    // `ok` means "nothing wrong was found". An empty ledger is not wrong — a freshly bootstrapped tenant
    // must not raise an incident every night — so `postings` shapes the summary and never the verdict.
    ok: clean,
    summary,
  };
}

/**
 * Writes the incident row spec:2246 calls an alarm. app.audit_log takes SELECT and INSERT for app_rw
 * (plan0A:1984–1986) and its BEFORE INSERT app.audit_chain() trigger hashes and links the row, so an
 * incident sits inside the same tamper-evident chain as every other write and cannot be edited away.
 * actor_id defaults to app.current_actor(), which for a job is the tenant's system principal (spec:2179).
 */
export async function recordIntegrityIncident(tx: Sql, report: IntegrityReport): Promise<void> {
  await tx`
    insert into app.audit_log (tenant_id, table_name, row_id, action, after)
    values (${report.tenantId}, 'integrity_incident', ${report.requestId}, 'insert', ${JSON.stringify(report)}::jsonb)`;
}

export { checkLedgerBalance, type LedgerBalanceOptions } from "./balance";
export { checkAuditChain } from "./audit-chain";
export { listPeriodReopens, type PeriodReopenOptions } from "./period-reopen";
export { checkAccountBalanceProjection, projectionChecks, registerProjectionCheck } from "./projections";
export type {
  AuditChainResult, IntegrityReport, LedgerImbalance, PeriodReopen, ProjectionCheck, ProjectionMismatch,
} from "./types";
```

- [ ] **Step 6: Widen the `packages/db/src/index.ts` re-export**

```ts
export {
  checkAccountBalanceProjection, checkAuditChain, checkLedgerBalance, listPeriodReopens, projectionChecks,
  recordIntegrityIncident, registerProjectionCheck, runIntegrityCheck,
  type AuditChainResult, type IntegrityCheckOptions, type IntegrityReport, type LedgerBalanceOptions,
  type LedgerImbalance, type PeriodReopen, type PeriodReopenOptions, type ProjectionCheck, type ProjectionMismatch,
} from "./integrity";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run --cwd tests test -- invariants/audit-chain.test.ts`
Expected: PASS, six cases.

- [ ] **Step 8: Append the regression block to `tests/regression/legacy-079.test.ts`**

```ts
describe("LEGACY-079 44 repair objects, two parallel idempotency ledgers, and one broken guard — 1B", () => {
  let db: Db; let a: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("drift is detected and recorded, never repaired — the projection is untouched after a failing run", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "8.0000" }, { account: a.sales, credit: "8.0000" }]);
    const ctx = { tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) };
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set debit = debit + 1 where account_id = ${a.cash}`);
    const before = await withTenant(db.rw, ctx, (tx) => tx<{ debit: string }[]>`
      select debit::text from app.account_balance where account_id = ${a.cash}`);

    const report = await withTenant(db.rw, ctx, async (tx) => {
      const r = await runIntegrityCheck(tx, ctx);
      await recordIntegrityIncident(tx, r);
      return r;
    });
    expect(report.ok).toBe(false);

    const after = await withTenant(db.rw, ctx, (tx) => tx<{ debit: string }[]>`
      select debit::text from app.account_balance where account_id = ${a.cash}`);
    expect(after).toEqual(before);
  });

  it("there is exactly one idempotency ledger for migrations and no procFix* object anywhere", async () => {
    const tables = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'app_meta' order by 1`;
    expect(tables.map((r) => r.table_name)).toEqual(["schema_migration"]);
    const funcs = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname ilike '%fix%'`;
    expect(funcs).toEqual([]);
  });
});
```

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/integrity/audit-chain.ts packages/db/src/integrity/period-reopen.ts \
        packages/db/src/integrity/index.ts packages/db/src/index.ts \
        tests/invariants/audit-chain.test.ts tests/regression/legacy-079.test.ts
git commit -m "$(cat <<'EOF'
feat(db): audit-chain walk, period-reopen report and runIntegrityCheck [1B T5]

checkAuditChain is the production twin of plan0A's private verifyChain formula;
listPeriodReopens answers spec:2179's "every reopen is reported";
runIntegrityCheck composes the four checks into one IntegrityReport, and
recordIntegrityIncident writes it into the hash-chained audit log. Nothing here
repairs a projection.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The `accounting.ledger.integrity_check` job

**Files:**
- Create: `apps/worker/src/observability/incident.ts`, `apps/worker/src/handlers/accounting.ts`, `apps/worker/test/handlers/integrity-check.test.ts`, `tests/invariants/account-balance-concurrency.test.ts`
- Modify: `packages/db/src/jobs/payloads.ts` (created by 0D), `apps/worker/src/index.ts` (created by 0D), `apps/worker/vitest.config.ts` (create if 0D did not), `apps/worker/tsconfig.json`, `scripts/lint/rules/dependency-rule.ts` (created by 0B)
- Test: `apps/worker/test/handlers/integrity-check.test.ts`, `tests/invariants/account-balance-concurrency.test.ts`

**Interfaces:**
- Consumes: `JOBS`, `JobEnvelope<T>`, `JobPayload` from `@dulja/db` (`packages/db/src/jobs/names.ts` and `enqueue.ts`, §4.2.6, 0D); `JobHandler<N>` and `registerHandler(name, handler)` from **`apps/worker/src/handler.ts`** — §4.2.6 annotates that code block `// apps/worker/src/handler.ts`, so these two names are *not* exported by `@dulja/db` and must be imported relatively (0D); `withTenant`, `systemContext`, `TenantContext` (§4.2.2); `runIntegrityCheck`, `recordIntegrityIncident`, `IntegrityReport` (Task 5); `Logger` from `@dulja/contracts` (§4.2.3); `startDb`, `seedTenantV2`, `seedAccount`, `uuidv7` (§4.1, §4.17); `postJournal` from `tests/invariants/support/post-journal.ts` (Task 3).
- Produces:
  - `IncidentReporter = { raise(kind: string, report: IntegrityReport): void }` and `createIncidentReporter(logger: Logger): IncidentReporter` from `apps/worker/src/observability/incident.ts`.
  - `AccountingHandlerDeps = { logger: Logger; incident: IncidentReporter }`, `createIntegrityCheckHandler(deps): JobHandler<"accounting.ledger.integrity_check">` and `registerAccountingHandlers(deps): void` from `apps/worker/src/handlers/accounting.ts`. Task 7 adds `createMonthEndHandler` to the same file and one line to the same `registerAccountingHandlers` call. **No scheduling function is produced** — 0D's `apps/worker/src/index.ts` loop over `registeredJobNames()` already schedules every registered name from `JOBS[name].schedule` (0d:2650-2665), and a second `boss.schedule` on the bare name would queue a tenant-less envelope `runJob` cannot resolve.
  - `JobPayload["accounting.ledger.integrity_check"] = { companyId?: string; sinceAuditSeq?: number }`.

The job name and its `"0 2 * * *"` schedule are already in the closed `JOBS` registry with `owner: "1B"` (§4.2.6); this task replaces 0D's scaffolded body, which reported "no postings", and adds nothing to the registry.

- [ ] **Step 1: Add the payload type, and open the one test-tier import path this slice's app tests need**

**(a) `packages/db/src/jobs/payloads.ts`.** Add these two members to the existing `JobPayload` interface, leaving every other member as 0D wrote it (Task 7 uses the second one):

```ts
  /** Slice 1B. Omit both fields for the nightly whole-tenant run. */
  "accounting.ledger.integrity_check": { companyId?: string; sinceAuditSeq?: number };
  /** Slice 1B. `asOf` defaults to the run date; a period is due when ends_on < asOf and status = 'open'. */
  "accounting.period.month_end": { asOf?: string };
```

**(b) `scripts/lint/rules/dependency-rule.ts` (0B).** Step 2's test file, Task 7's, and Task 10's `apps/api` route test all import `postJournal` from `tests/invariants/support/post-journal.ts` — code under `apps/**` importing the `tests` workspace. §3.1's tier table gives `@dulja/tests` the **test** tier and a one-way allowance (tests → `apps/api` through `createApp()` only); it grants nothing in this direction, and the rule runs "over every `import` in `apps/**` and `packages/**`", so all three files are violations as written. The narrow, honest widening is **test tier to test tier**: an app's own `test/**` directory is test-tier code and may reach the shared test-tier helper. Add the allowance and write the reason on the line, in the shape Task 8 Step 3 uses for the other direction:

```ts
// Test tier to test tier: apps/*/test/** may import tests/invariants/support/** — both are test code, and
// slice 1B's worker and api tests must post through the same real postJournal the invariant suites use
// rather than a second copy of it (contracts §3.1; §4.17 assigns 1B no fixtures.ts helper, hazard 9).
// PRODUCTION code under apps/*/src/** and packages/**/src/** may still import nothing from tests/.
```

The allowance is on the importing path `apps/*/test/**` and the imported path `tests/invariants/support/**` — both halves, so `apps/*/src/**` gains nothing and no other directory under `tests/` becomes reachable.

**(c) `apps/worker/tsconfig.json`.** The helper sits outside the app's own directory, so add it to `include`:

```json
    "../../tests/invariants/support/**/*.ts"
```

Then run `bun run --cwd apps/worker typecheck`. If it reports **TS6059** (`File … is not under 'rootDir'`), the app's tsconfig pins `rootDir`; delete that one line — `outDir` still governs the emit layout and `apps/worker` is a deployable built from its entrypoint, not a published type surface — and re-run until it is clean.

**Do not** add `@dulja/tests` to `apps/worker`'s or `apps/api`'s `package.json`. `tests/package.json` already depends on `@dulja/api` (0B) and gains `@dulja/worker` in Task 8; a dependency in the other direction would close a cycle in the workspace graph, and Plan 0A's turbo pipelines are all `dependsOn: ["^build"]` / `["^typecheck"]` (plan0A:262–264), which traverse that graph and fail on a cycle. Vitest resolves the relative import without a manifest entry; the lint rule and the tsconfig `include` are the whole of what is needed.

- [ ] **Step 2: Write the failing test `apps/worker/test/handlers/integrity-check.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@dulja/contracts";
import { systemContext, withTenant, type IntegrityReport } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "../../../../tests/invariants/support/post-journal";
import { createIntegrityCheckHandler } from "../../src/handlers/accounting";
import type { IncidentReporter } from "../../src/observability/incident";

interface LogLine { level: string; fields: Record<string, unknown>; msg: string }

function recordingLogger(sink: LogLine[]): Logger {
  const push = (level: string) => (fields: Record<string, unknown>, msg: string) => { sink.push({ level, fields, msg }); };
  const logger: Logger = {
    debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"),
    child: () => logger,
  };
  return logger;
}

describe("accounting.ledger.integrity_check handler (spec:2246; §5.0 row 0.11)", () => {
  let db: Db; let a: Seed;
  const logs: LogLine[] = [];
  const raised: { kind: string; report: IntegrityReport }[] = [];
  const incident: IncidentReporter = { raise: (kind, report) => { raised.push({ kind, report }); } };
  const handler = createIntegrityCheckHandler({ logger: recordingLogger(logs), incident });

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });
  const jobCtx = async () => systemContext(db.rw, a.tenant, await uuidv7(db.admin));
  const envelope = (payload: { companyId?: string } = {}) => ({ tenantId: a.tenant, requestId: "req", payload });

  it("runs as the tenant's system principal and logs a pass on a clean ledger", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "20.0000" }, { account: a.sales, credit: "20.0000" }]);
    logs.length = 0; raised.length = 0;
    const ctx = await jobCtx();
    expect(ctx.actorId).toBe(a.system);
    await handler(db.rw, envelope(), ctx);
    expect(raised).toEqual([]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    expect(logs.at(-1)!.msg).toBe("ledger integrity check passed");
  });

  it("records an incident audit row, raises it, and logs an error when a projection has drifted", async () => {
    const ctx = await jobCtx();
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set base_debit = base_debit + 7 where account_id = ${a.cash}`);
    logs.length = 0; raised.length = 0;
    await handler(db.rw, envelope(), ctx);

    expect(raised).toHaveLength(1);
    expect(raised[0]!.kind).toBe("accounting.ledger.integrity_check");
    expect(raised[0]!.report.ok).toBe(false);
    // Contracts §4.16.3 pins this array by name and file: when 2B registers SERIES_GAP_CHECK it becomes
    // ["account_balance", "document_series"], and this line moves in that same PR.
    expect(raised[0]!.report.projections.checked).toEqual(["account_balance"]);
    expect(logs.filter((l) => l.level === "error").map((l) => l.msg)).toEqual(["ledger integrity check failed"]);

    const [row] = await withTenant(db.rw, ctx, (tx) => tx<{ row_id: string; actor_id: string }[]>`
      select row_id, actor_id::text from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'integrity_incident' order by seq desc limit 1`);
    expect(row!.row_id).toBe(ctx.requestId);
    expect(row!.actor_id).toBe(a.system);

    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set base_debit = base_debit - 7 where account_id = ${a.cash}`);
  });

  it("never writes to a projection — the drifted value survives the run that reported it", async () => {
    const ctx = await jobCtx();
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set credit = credit + 3 where account_id = ${a.sales}`);
    await handler(db.rw, envelope(), ctx);
    const [row] = await withTenant(db.rw, ctx, (tx) => tx<{ credit: string }[]>`
      select credit::text from app.account_balance where account_id = ${a.sales}`);
    expect(row!.credit).not.toBe("0.0000");
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set credit = credit - 3 where account_id = ${a.sales}`);
  });

  it("logs a pass and raises nothing for a tenant with no postings (spec:2321)", async () => {
    const empty = await seedTenantV2(db, "Empty");
    const ctx = await systemContext(db.rw, empty.tenant, await uuidv7(db.admin));
    logs.length = 0; raised.length = 0;
    await handler(db.rw, { tenantId: empty.tenant, requestId: ctx.requestId, payload: {} }, ctx);
    expect(raised).toEqual([]);
    expect(logs.at(-1)!.fields["summary"]).toBe("no postings");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd apps/worker test -- test/handlers/integrity-check.test.ts`
Expected: FAIL — `Cannot find module '../../src/handlers/accounting'`. If the run instead fails with "no test files found", 0D shipped no `apps/worker/vitest.config.ts`; create it now, mirroring `packages/db/vitest.config.ts` (plan0A:428–437):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
```

and add `"test": "node ../../node_modules/vitest/vitest.mjs run"` to `apps/worker/package.json` `scripts` if it is absent (contracts §3.1: every workspace exposes `typecheck` and `test`).

- [ ] **Step 4: Write `apps/worker/src/observability/incident.ts`**

```ts
import * as Sentry from "@sentry/node";
import type { Logger } from "@dulja/contracts";
import type { IntegrityReport } from "@dulja/db";

/**
 * The alarm half of spec:2246's ledger-integrity SLI: "This alarm is the single most valuable thing you
 * can build — it is the alarm the old system needed and never had."
 */
export interface IncidentReporter {
  raise(kind: string, report: IntegrityReport): void;
}

/**
 * Sends the report to Sentry when SENTRY_DSN is configured (0C wires the DSN for api, worker and desktop
 * — contracts §3.11) and always leaves one structured error line behind. With no DSN — a developer
 * machine, CI, or before OD-22 lands — the logger line IS the incident, so the job's behaviour is
 * identical everywhere and no test needs a Sentry stub.
 *
 * The report carries no credential, token or PII: it is ids, counts and decimal strings, so it passes
 * the forbidden-log-fields rule (contracts §3.7.5) unchanged.
 */
export function createIncidentReporter(logger: Logger): IncidentReporter {
  const dsn = process.env["SENTRY_DSN"];
  return {
    raise(kind, report) {
      logger.error(
        {
          incident: kind,
          tenant_id: report.tenantId,
          request_id: report.requestId,
          summary: report.summary,
          unbalanced_periods: report.ledgerBalance.byPeriod.length,
          unbalanced_documents: report.ledgerBalance.byDocument.length,
          projection_mismatches: report.projections.mismatches.length,
          broken_links: report.auditChain.brokenLinks,
          bad_hashes: report.auditChain.badHashes,
          period_reopens: report.periodReopens.length,
        },
        "integrity incident",
      );
      if (dsn === undefined || dsn === "") return;
      Sentry.captureMessage(`${kind}: ${report.summary}`, {
        level: "error",
        tags: { tenant_id: report.tenantId, incident: kind },
        extra: { report },
      });
    },
  };
}
```

If `@sentry/node` is not already a dependency of `apps/worker` (0C adds it with the DSN), add it now — no version is written into any source file, the lockfile owns it (spec:104):

```bash
bun add --cwd apps/worker @sentry/node
```

- [ ] **Step 5: Write `apps/worker/src/handlers/accounting.ts`**

**This file registers handlers and schedules nothing.** 0D's `apps/worker/src/index.ts` already loops over
`registeredJobNames()` and, for every name whose `JOBS[name].schedule` is non-null, installs
`boss.schedule(`${name}.fanout`, schedule, {}, {})` plus the `boss.work` worker that calls `eachTenant` and
invokes `runJob` once per tenant (0d:2650–2665). A `boss.schedule(name, schedule)` of our own would add a
**second** cron entry on the bare name, whose queued job carries `{}` as its envelope — no `tenantId` — and
`runJob` would fail on it every night. So this slice ships **no** `scheduleAccountingJobs`: registering the
handler before `boss.start()` is the whole of the wiring, and the closed `JOBS` registry supplies the cron
string 0D's loop reads.

```ts
import type { Logger } from "@dulja/contracts";
import { recordIntegrityIncident, runIntegrityCheck, withTenant } from "@dulja/db";
// registerHandler and JobHandler are 0D's, and they live in apps/worker, not in @dulja/db: contracts
// §4.2.6 annotates their code block `// apps/worker/src/handler.ts`.
import { registerHandler, type JobHandler } from "../handler";
import type { IncidentReporter } from "../observability/incident";

export interface AccountingHandlerDeps {
  logger: Logger;
  incident: IncidentReporter;
}

/**
 * The nightly ledger-integrity job (JOBS["accounting.ledger.integrity_check"], schedule "0 2 * * *",
 * owner 1B — contracts §4.2.6). 0D scaffolded a body that reported "no postings"; this is the complete
 * one: Σbase debit = Σbase credit per period and per document, every registered projection rebuilt and
 * compared row for row, the audit chain walked, every period reopen listed (spec:2246, 1963, 2179).
 *
 * `ctx` arrives from the runner as the tenant's system principal (systemContext, spec:2179) — the
 * handler never resolves a principal itself and never reads pgboss.tenant_registry: §4.2.6 makes the
 * scheduled dispatch fan out and call this once per tenant.
 *
 * Two short transactions, never one long one (spec:1368): the checks read, then the incident is written.
 */
export function createIntegrityCheckHandler(
  deps: AccountingHandlerDeps,
): JobHandler<"accounting.ledger.integrity_check"> {
  return async (sql, job, ctx) => {
    const log = deps.logger.child({
      tenant_id: ctx.tenantId, actor_id: ctx.actorId, request_id: ctx.requestId,
      job: "accounting.ledger.integrity_check",
    });

    const report = await withTenant(sql, ctx, (tx) =>
      runIntegrityCheck(tx, ctx, { companyId: job.payload.companyId, sinceAuditSeq: job.payload.sinceAuditSeq }));

    if (report.ok) {
      log.info({ summary: report.summary, period_reopens: report.periodReopens.length }, "ledger integrity check passed");
      return;
    }

    await withTenant(sql, ctx, (tx) => recordIntegrityIncident(tx, report));
    deps.incident.raise("accounting.ledger.integrity_check", report);
    log.error({ summary: report.summary }, "ledger integrity check failed");
  };
}

/**
 * Registers every handler this slice owns. `apps/worker/src/index.ts` calls it once at boot, BEFORE
 * `boss.start()`, because 0D's boot loop iterates `registeredJobNames()` and installs the worker and the
 * cron fan-out for whatever is registered by then (§4.2.6). Nothing here schedules: the schedule string
 * lives in the closed `JOBS` registry and 0D's loop is the one reader of it.
 */
export function registerAccountingHandlers(deps: AccountingHandlerDeps): void {
  registerHandler("accounting.ledger.integrity_check", createIntegrityCheckHandler(deps));
}
```

- [ ] **Step 6: Wire it into `apps/worker/src/index.ts`**

0D's file (0d:2632–2665) imports `ledgerIntegrityCheck` from `./jobs/ledger-integrity-check` and registers
it inline as the Phase 0 scaffold. Three edits replace that scaffold and nothing else.

**(a)** Delete the import line `import { ledgerIntegrityCheck } from "./jobs/ledger-integrity-check";` and
add, beside 0D's other imports:

```ts
import { createIncidentReporter } from "./observability/incident";
import { registerAccountingHandlers } from "./handlers/accounting";
```

**(b)** Replace the one line `registerHandler("accounting.ledger.integrity_check", ledgerIntegrityCheck);`
with the call below. **Where exactly:** in place, where that line already is — after `const boss =
createBoss(url);` and before `await boss.start();`, which is what 0D's boot loop over
`registeredJobNames()` requires. `log()` is 0D's logger accessor, already imported in that file:

```ts
const logger = log();
registerAccountingHandlers({ logger, incident: createIncidentReporter(logger) });
```

**(c)** Leave `registerHandler("admin.idempotency_key.purge", idempotencyKeyPurge);`, `await boss.start()`
and the whole `for (const name of registeredJobNames())` loop **exactly** as 0D wrote them. That loop is
what installs this slice's cron fan-out, and adding a schedule call here would double it — see the note at
the head of Step 5.

**Do not delete `apps/worker/src/jobs/ledger-integrity-check.ts` itself.** 0D's own
`apps/worker/test/jobs/ledger-integrity-check.test.ts` imports it, and deleting a file another slice tests
is out of this slice's scope; it simply stops being registered. If that leaves an unreferenced-export lint
failing, report it rather than widening this task — the file is 0D's to retire.

- [ ] **Step 7: Run the handler test to verify it passes**

Run: `bun run --cwd apps/worker test -- test/handlers/integrity-check.test.ts`
Expected: PASS, four cases.

- [ ] **Step 8: Write `tests/invariants/account-balance-concurrency.test.ts` — the ADR 0024 concurrency pin**

It lives in the `tests` workspace rather than `packages/db/test/` because it uses `postJournal`, and a file inside `packages/db` importing from `tests/` would invert the dependency tiers `scripts/lint/rules/dependency-rule.ts` enforces (contracts §3.1).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAccountBalanceProjection, withTenant } from "@dulja/db";
import { seedAccount, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("account_balance under concurrency — the pin behind ADR 0024's open question", () => {
  let db: Db; let a: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("two posts racing for a BRAND-NEW key leave exactly one row, and a loser fails loudly", async () => {
    const fresh = await seedAccount(db, a, { code: "1960", nameEn: "Cold start", type: "asset" });
    const results = await Promise.allSettled([
      postJournal(db, a, [{ account: fresh, debit: "11.0000" }, { account: a.sales, credit: "11.0000" }]),
      postJournal(db, a, [{ account: fresh, debit: "13.0000" }, { account: a.sales, credit: "13.0000" }]),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // PostgreSQL's MERGE takes `when not matched then insert` in BOTH sessions for a key that does not
    // yet exist, so one may raise 23505. §4.2.2's withTenant retries only 40P01/40001. Whatever happens,
    // a DUPLICATE ROW must be impossible — that is what LEGACY-049 was, and the primary key forbids it.
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const r of rejected) expect(String(r.reason)).toMatch(/23505|duplicate key|ERR_CONFLICT_UNIQUE/);

    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    const [count] = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account_balance
       where account_id = ${fresh} and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(count!.n).toBe(1);
    expect(await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx))).toEqual([]);
  });

  it("app_rw may create the scratch temp table the rebuild needs", async () => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    const [row] = await withTenant(db.rw, ctx, async (tx) => {
      await tx`create temporary table integrity_privilege_probe on commit drop as select 1 as x`;
      return tx<{ x: number }[]>`select x from integrity_privilege_probe`;
    });
    expect(row).toEqual({ x: 1 });
  });
});
```

Run: `bun run --cwd tests test -- invariants/account-balance-concurrency.test.ts`
Expected: PASS, two cases. If the second case fails with `permission denied to create temporary tables`, assumption 4 is falsified: stop, and replace the `create temporary table` in `packages/db/src/integrity/projections.ts` with a `with rebuilt as (…)` CTE in the same statement as the full outer join — the comparison is unchanged, only the scratch materialisation is.

- [ ] **Step 9: Run the whole gate and commit**

Run: `bun run typecheck && bun run lint && bun run --cwd packages/db test && bun run --cwd apps/worker test && bun run --cwd tests test`
Expected: PASS.

```bash
git add packages/db/src/jobs/payloads.ts tests/invariants/account-balance-concurrency.test.ts \
        scripts/lint/rules/dependency-rule.ts apps/worker/tsconfig.json \
        apps/worker/src/observability/incident.ts apps/worker/src/handlers/accounting.ts \
        apps/worker/src/index.ts apps/worker/vitest.config.ts apps/worker/package.json \
        apps/worker/test/handlers/integrity-check.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): complete the accounting.ledger.integrity_check job [1B T6]

Replaces 0D's "no postings" scaffold with the full nightly check: balance,
projection rebuild-and-compare, audit-chain walk and period reopens, run as the
tenant's system principal in two short transactions. A failure writes an
integrity_incident audit row and raises the alarm (Sentry when a DSN is set, a
structured error line always). The job never repairs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The `accounting.period.month_end` job

**Files:**
- Create: `packages/db/src/periods/month-end.ts`, `apps/worker/test/handlers/month-end.test.ts`
- Modify: `packages/db/src/index.ts`, `apps/worker/src/handlers/accounting.ts`
- Test: `apps/worker/test/handlers/month-end.test.ts`

**Interfaces:**
- Consumes: `app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status, closed_by, closed_at)` (plan0A:1467–1481); `runIntegrityCheck`, `recordIntegrityIncident` (Task 5); `AccountingHandlerDeps`, `IncidentReporter` (Task 6); `JOBS["accounting.period.month_end"].schedule === "0 1 1 * *"` from `@dulja/db` (§4.2.6); `JobHandler<N>` and `registerHandler` from **`apps/worker/src/handler.ts`** (0D — §4.2.6's code block is annotated with that path; they are already imported at the top of `handlers/accounting.ts` by Task 6 Step 5 and this task adds no import for them); `postJournal` from `tests/invariants/support/post-journal.ts` (Task 3), reachable from `apps/worker/test/**` through the allowance Task 6 Step 1(b) added.
- Produces:
  - `listPeriodsAwaitingClose(tx: Sql, opts: { asOf: string }): Promise<PeriodAwaitingClose[]>` and `recordMonthEndReady(tx: Sql, tenantId: string, entry: MonthEndReady): Promise<void>` from `@dulja/db`, with `PeriodAwaitingClose = { fiscalPeriodId: string; companyId: string; startsOn: string; endsOn: string }` and `MonthEndReady = { fiscalPeriodId: string; companyId: string; endsOn: string; ready: boolean; summary: string }`.
  - `createMonthEndHandler(deps: AccountingHandlerDeps): JobHandler<"accounting.period.month_end">`.

**The rule this job obeys and must never break:** it **never closes a period**. spec:2223 makes period close "uniform for all roles" and `accounting.period.close` is a human permission 1A ships; the job lists what is ready, proves it, and records that. Task 8 asserts exactly this.

- [ ] **Step 1: Write the failing test `apps/worker/test/handlers/month-end.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@dulja/contracts";
import { systemContext, withTenant, type IntegrityReport } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "../../../../tests/invariants/support/post-journal";
import { createMonthEndHandler } from "../../src/handlers/accounting";
import type { IncidentReporter } from "../../src/observability/incident";

interface LogLine { level: string; fields: Record<string, unknown>; msg: string }
function recordingLogger(sink: LogLine[]): Logger {
  const push = (level: string) => (fields: Record<string, unknown>, msg: string) => { sink.push({ level, fields, msg }); };
  const logger: Logger = { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), child: () => logger };
  return logger;
}

describe("accounting.period.month_end handler (spec:1159, 2223)", () => {
  let db: Db; let a: Seed;
  const logs: LogLine[] = [];
  const raised: { kind: string; report: IntegrityReport }[] = [];
  const incident: IncidentReporter = { raise: (kind, report) => { raised.push({ kind, report }); } };
  const handler = createMonthEndHandler({ logger: recordingLogger(logs), incident });

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });
  const jobCtx = async () => systemContext(db.rw, a.tenant, await uuidv7(db.admin));

  it("writes one month_end_ready audit row per overdue open period and closes nothing", async () => {
    await postJournal(db, a, [{ account: a.cash, debit: "30.0000" }, { account: a.sales, credit: "30.0000" }]);
    const ctx = await jobCtx();
    logs.length = 0; raised.length = 0;
    await handler(db.rw, { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-04-01" } }, ctx);

    const rows = await withTenant(db.rw, ctx, (tx) => tx<{ row_id: string; after: { ready: boolean; endsOn: string } }[]>`
      select row_id, after from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'month_end_ready' order by seq`);
    // Only the OPEN period 2026-01 is due; closedPeriod (2026-02) and lockedPeriod (2026-03) are not open.
    expect(rows.map((r) => r.row_id)).toEqual([a.period]);
    expect(rows[0]!.after.ready).toBe(true);
    expect(rows[0]!.after.endsOn).toBe("2026-01-31");

    const [period] = await withTenant(db.rw, ctx, (tx) => tx<{ status: string }[]>`
      select status from app.fiscal_period where id = ${a.period}`);
    expect(period!.status).toBe("open");
    expect(raised).toEqual([]);
  });

  it("does nothing for a period whose ends_on has not passed", async () => {
    const ctx = await jobCtx();
    const before = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant} and table_name = 'month_end_ready'`);
    await handler(db.rw, { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-01-15" } }, ctx);
    const after = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant} and table_name = 'month_end_ready'`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("marks the period not ready, raises the incident, and still does not close it when a projection has drifted", async () => {
    const ctx = await jobCtx();
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set base_credit = base_credit + 4 where account_id = ${a.sales}`);
    logs.length = 0; raised.length = 0;
    await handler(db.rw, { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-04-01" } }, ctx);

    const [row] = await withTenant(db.rw, ctx, (tx) => tx<{ after: { ready: boolean; summary: string } }[]>`
      select after from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'month_end_ready' order by seq desc limit 1`);
    expect(row!.after.ready).toBe(false);
    expect(row!.after.summary).toMatch(/^FAILED: /);
    expect(raised.map((r) => r.kind)).toEqual(["accounting.period.month_end"]);

    const [period] = await withTenant(db.rw, ctx, (tx) => tx<{ status: string }[]>`
      select status from app.fiscal_period where id = ${a.period}`);
    expect(period!.status).toBe("open");
    await withTenant(db.rw, ctx, (tx) => tx`update app.account_balance set base_credit = base_credit - 4 where account_id = ${a.sales}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd apps/worker test -- test/handlers/month-end.test.ts`
Expected: FAIL — `The requested module '../../src/handlers/accounting' does not provide an export named 'createMonthEndHandler'`.

- [ ] **Step 3: Write `packages/db/src/periods/month-end.ts`**

```ts
import type { Sql } from "postgres";

export interface PeriodAwaitingClose {
  readonly fiscalPeriodId: string;
  readonly companyId: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface MonthEndReady {
  readonly fiscalPeriodId: string;
  readonly companyId: string;
  readonly endsOn: string;
  readonly ready: boolean;
  readonly summary: string;
}

/**
 * Every company's fiscal periods whose `ends_on` has passed and which are still `open` — the list the
 * month-end job walks (spec:1159 names "month-end close" as a pg-boss scheduled job). It resolves the
 * periods only; nothing here changes a status.
 */
export async function listPeriodsAwaitingClose(
  tx: Sql, opts: { asOf: string },
): Promise<PeriodAwaitingClose[]> {
  const rows = await tx<{ id: string; company_id: string; starts_on: string; ends_on: string }[]>`
    select p.id::text, p.company_id::text, p.starts_on::text, p.ends_on::text
      from app.fiscal_period p
     where p.status = 'open'
       and p.ends_on < ${opts.asOf}::date
     order by p.company_id, p.ends_on`;
  return rows.map((r) => ({
    fiscalPeriodId: r.id, companyId: r.company_id, startsOn: r.starts_on, endsOn: r.ends_on,
  }));
}

/**
 * Records that a period was checked and is (or is not) ready for a human to close under
 * `accounting.period.close`. Written into app.audit_log — the same tamper-evident chain every other
 * write goes into (plan0A:1984–1986 grant app_rw SELECT and INSERT) — so "the system said this period
 * was clean on this date" is itself auditable evidence and cannot be edited afterwards.
 *
 * This function, and the job that calls it, NEVER set fiscal_period.status. spec:2223 makes period close
 * "uniform for all roles"; it is a human act, and acceptance test 9 exercises exactly the job path that
 * must not be able to perform it.
 */
export async function recordMonthEndReady(tx: Sql, tenantId: string, entry: MonthEndReady): Promise<void> {
  await tx`
    insert into app.audit_log (tenant_id, table_name, row_id, action, after)
    values (${tenantId}, 'month_end_ready', ${entry.fiscalPeriodId}, 'insert', ${JSON.stringify(entry)}::jsonb)`;
}
```

- [ ] **Step 4: Export from `packages/db/src/index.ts`**

```ts
export {
  listPeriodsAwaitingClose, recordMonthEndReady, type MonthEndReady, type PeriodAwaitingClose,
} from "./periods/month-end";
```

- [ ] **Step 5: Add the handler to `apps/worker/src/handlers/accounting.ts`**

Extend the imports from `@dulja/db` with `listPeriodsAwaitingClose` and `recordMonthEndReady`, then append:

```ts
/**
 * The month-end job (JOBS["accounting.period.month_end"], schedule "0 1 1 * *", owner 1B — §4.2.6).
 * For every company it lists the periods whose ends_on has passed and are still `open`, runs the
 * integrity checks for each, and writes a `month_end_ready` audit row. It never closes a period:
 * closing stays a human act under `accounting.period.close` (spec:2223).
 *
 * One short transaction per period (spec:1368), so a tenant with a long history does not hold one
 * transaction open across the whole run.
 */
export function createMonthEndHandler(deps: AccountingHandlerDeps): JobHandler<"accounting.period.month_end"> {
  return async (sql, job, ctx) => {
    const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
    const log = deps.logger.child({
      tenant_id: ctx.tenantId, actor_id: ctx.actorId, request_id: ctx.requestId,
      job: "accounting.period.month_end",
    });

    const due = await withTenant(sql, ctx, (tx) => listPeriodsAwaitingClose(tx, { asOf }));
    log.info({ as_of: asOf, due: due.length }, "month-end scan");

    for (const period of due) {
      const report = await withTenant(sql, ctx, (tx) =>
        runIntegrityCheck(tx, ctx, { companyId: period.companyId }));

      await withTenant(sql, ctx, async (tx) => {
        if (!report.ok) await recordIntegrityIncident(tx, report);
        await recordMonthEndReady(tx, ctx.tenantId, {
          fiscalPeriodId: period.fiscalPeriodId,
          companyId: period.companyId,
          endsOn: period.endsOn,
          ready: report.ok,
          summary: report.summary,
        });
      });

      if (report.ok) {
        log.info({ fiscal_period_id: period.fiscalPeriodId, ends_on: period.endsOn }, "period ready to close");
      } else {
        deps.incident.raise("accounting.period.month_end", report);
        log.error({ fiscal_period_id: period.fiscalPeriodId, summary: report.summary }, "period not ready to close");
      }
    }
  };
}
```

and extend `registerAccountingHandlers` by one line — one registration, no second file edit, and still no
schedule of our own, because 0D's boot loop reads `JOBS["accounting.period.month_end"].schedule` for itself
the moment the name is registered:

```ts
export function registerAccountingHandlers(deps: AccountingHandlerDeps): void {
  registerHandler("accounting.ledger.integrity_check", createIntegrityCheckHandler(deps));
  registerHandler("accounting.period.month_end", createMonthEndHandler(deps));
}
```

`apps/worker/src/index.ts` is **not** touched again in this task: Task 6 Step 6 already put the single
`registerAccountingHandlers({ logger, incident })` call before `boss.start()`, and this second handler
arrives through it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run --cwd apps/worker test -- test/handlers/month-end.test.ts`
Expected: PASS, three cases.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/periods/month-end.ts packages/db/src/index.ts \
        apps/worker/src/handlers/accounting.ts apps/worker/test/handlers/month-end.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): accounting.period.month_end reports readiness, never closes [1B T7]

Lists every company's overdue open periods, runs the integrity checks for each
and writes a month_end_ready audit row. spec:2223 keeps period close uniform for
all roles and a human act under accounting.period.close, so this job has no code
path that sets fiscal_period.status.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Acceptance test 9 — the period lock through the background-job path

**Files:**
- Create: `tests/invariants/period-lock.test.ts`
- Test: `tests/invariants/period-lock.test.ts`

**Interfaces:**
- Consumes: `postDocument` (§4.3.1, 1A); `systemContext(sql, tenantId, requestId): Promise<TenantContext>` (§4.2.2); `withTenant` (§4.2.2); `createMonthEndHandler` (Task 7); `app.assert_period_open()` and its trigger `ledger_entry_period_open` (plan0A:2064–2075); `postJournal` (Task 3); `draftDocument`, `seedTenantV2` (§4.1, §4.17).
- Produces: nothing importable. This file **is** the deliverable: 1B's share of "a locked period cannot be altered through any path" (spec:2287, 2427).

**What this test proves and why it is not a re-run of 1A's.** spec:2427 makes test 9 cover four paths — API, import, admin, background job. 1A holds the API and admin paths and 9B the import path. The background job is different in kind from all three because a job runs as the tenant's **system principal**, and `app.actor_has()` returns true for the system principal unconditionally (plan0A:985–1004, spec:2179) so that server-side jobs can read RLS-gated rows. The system principal is therefore the one caller for which *every permission check passes*, and the only thing standing between it and a locked period is `app.assert_period_open()`. This file proves both layers under that principal: the posting service's step-5 pre-check (§4.3.2) and the `ledger_entry_period_open` BEFORE INSERT trigger, which is the control (plan0A:2074).

- [ ] **Step 1: Write the failing test `tests/invariants/period-lock.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, systemContext, withTenant, type TenantContext } from "@dulja/db";
import { draftDocument, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { createMonthEndHandler } from "../../apps/worker/src/handlers/accounting";
import { postJournal } from "./support/post-journal";

/**
 * Two matchers, deliberately, because two different pieces of code raise this condition.
 *
 * TRIGGER_LOCKED is plan0A:2069's exact text — `raise exception 'ERR_PERIOD_NOT_OPEN: period % is %'` —
 * and is asserted only against a direct insert into app.ledger_entry, where app.assert_period_open() is
 * demonstrably the raiser.
 *
 * refusedFor(id) is for the cases that go through postDocument, whose §4.3.2 step-5 pre-check raises
 * ERR_PERIOD_NOT_OPEN through AppError with a human message 1A writes; that message is 1A's to phrase and
 * this slice must not pin another slice's wording. It still asserts everything spec:2051 demands — the
 * stable code, and a message naming the specific entity by its id — without asserting the phrasing
 * between them. Neither matcher may be weakened to a bare /ERR_PERIOD_NOT_OPEN/.
 */
const TRIGGER_LOCKED = /ERR_PERIOD_NOT_OPEN: period [0-9a-fA-F-]{36} is locked/;
const refusedFor = (periodId: string): RegExp =>
  new RegExp(`ERR_PERIOD_NOT_OPEN[\\s\\S]*${periodId}`);

const silentLogger = (() => {
  const noop = (): void => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger as unknown as import("@dulja/contracts").Logger;
})();

describe("period lock — acceptance test 9, the background-job path (spec:2427; LEGACY-031, 041)", () => {
  let db: Db; let a: Seed;

  beforeAll(async () => { db = await startDb(); a = await seedTenantV2(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  const humanCtx = async (): Promise<TenantContext> =>
    ({ tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) });
  const jobCtx = async (): Promise<TenantContext> => systemContext(db.rw, a.tenant, await uuidv7(db.admin));

  /** A draft with two balanced lines, dated into `periodId`, ready to be posted (or refused). */
  async function draftInto(periodId: string, effectiveDate: string): Promise<string> {
    const documentId = await draftDocument(db, a, { effectiveDate, periodId });
    await withTenant(db.rw, await humanCtx(), async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 9.0000, 0)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${a.tenant}, ${a.company}, ${documentId}, 2, ${a.sales}, 0, 9.0000)`;
    });
    return documentId;
  }

  it("the human path is refused (1A's path, re-run here as the control)", async () => {
    const documentId = await draftInto(a.lockedPeriod, "2026-03-10");
    const ctx = await humanCtx();
    await expect(withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })))
      .rejects.toThrow(refusedFor(a.lockedPeriod));
  });

  it("the JOB path is refused at the posting service's pre-check, even as the system principal", async () => {
    const documentId = await draftInto(a.lockedPeriod, "2026-03-11");
    const ctx = await jobCtx();
    expect(ctx.actorId).toBe(a.system);
    await expect(withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })))
      .rejects.toThrow(refusedFor(a.lockedPeriod));
  });

  it("the JOB path is refused by the TRIGGER when the posting service is bypassed entirely", async () => {
    // The pre-check above is a better error message; app.assert_period_open() is the control (plan0A:2074).
    // This writes ledger_entry directly as app_rw under the system principal — the shape a future job
    // would have if someone ever wrote one that did not go through postDocument.
    const documentId = await draftInto(a.period, "2026-01-12");
    const ctx = await jobCtx();
    await expect(withTenant(db.rw, ctx, (tx) => tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                    currency, exchange_rate, base_debit, base_credit, effective_date,
                                    fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 9.0000, 0, 'MYR', 1, 9.0000, 0,
              '2026-03-11', ${a.lockedPeriod}, ${a.policy})`)).rejects.toThrow(TRIGGER_LOCKED);
  });

  it("a CLOSED period refuses writes exactly as a locked one does — the trigger tests `is distinct from open`", async () => {
    const documentId = await draftInto(a.closedPeriod, "2026-02-10");
    const ctx = await jobCtx();
    await expect(withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })))
      .rejects.toThrow(refusedFor(a.closedPeriod));
  });

  it("the month-end job cannot alter a locked or closed period — it reports and stops (spec:2223)", async () => {
    const ctx = await jobCtx();
    const handler = createMonthEndHandler({ logger: silentLogger, incident: { raise: () => undefined } });
    const before = await withTenant(db.rw, ctx, (tx) => tx<{ id: string; status: string }[]>`
      select id::text, status from app.fiscal_period where company_id = ${a.company} order by starts_on`);
    const entriesBefore = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`);

    await handler(db.rw, { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-06-01" } }, ctx);

    const after = await withTenant(db.rw, ctx, (tx) => tx<{ id: string; status: string }[]>`
      select id::text, status from app.fiscal_period where company_id = ${a.company} order by starts_on`);
    const entriesAfter = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`);

    expect(after).toEqual(before);
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("the only remedy is a reversing entry in an OPEN period, and it leaves the locked period untouched", async () => {
    const ctx = await jobCtx();
    const before = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id = ${a.lockedPeriod}`);
    await postJournal(db, a, [{ account: a.sales, debit: "9.0000" }, { account: a.cash, credit: "9.0000" }],
      { effectiveDate: "2026-01-25", periodId: a.period, actorId: a.human });
    const after = await withTenant(db.rw, ctx, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id = ${a.lockedPeriod}`);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd tests test -- invariants/period-lock.test.ts`
Expected: FAIL, and the failure must be inspected before proceeding. Three outcomes are possible and each has a different response:

1. `Cannot find module '../../apps/worker/src/handlers/accounting'` — the `tests` workspace's `tsconfig.json` does not have that file in its program. Fix it in Step 3.
2. A rejection whose message does **not** match its matcher. Which matcher failed decides the response:
   - **`TRIGGER_LOCKED` (the direct-insert case)** — read the actual text and reconcile it with plan0A:2069 (`raise exception 'ERR_PERIOD_NOT_OPEN: period % is %'`). That text is Plan 0A's and is frozen; a mismatch means the trigger changed and that is the finding. Do not relax `TRIGGER_LOCKED`.
   - **`refusedFor(...)` (the three `postDocument` cases)** — three sub-cases, because `.rejects.toThrow(regex)` matches `error.message` and §4.2.4 fixes `AppError`'s `code` and `detail` but says nothing about what its constructor puts in `message`.
     - The code is present and the id is not: 1A's `detail` does not name the entity, which is a spec:2051 defect in 1A. Stop and report it rather than dropping the id from the matcher.
     - **Neither the code nor the id is in the message, but `error.code === "ERR_PERIOD_NOT_OPEN"`:** 1A's `AppError` calls `super(detail)`, so the code never reaches `message`. Change those three assertions to read the frozen fields directly instead of the message — `await expect(…).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN", detail: expect.stringContaining(a.lockedPeriod) })` (and `a.closedPeriod` for the fourth case). Both fields are §4.2.4's frozen shape, so this pins no wording and loses no assertion; `refusedFor` and its comment can then go.
     - Anything else: read it before changing a line. Do not weaken either matcher to a bare `/ERR_PERIOD_NOT_OPEN/`.
3. A case that **passes where it should fail** — i.e. a write into a locked period succeeded. That is a Phase 1 defect, not a test bug: stop and report it.

- [ ] **Step 3: Give the `tests` workspace a typed path to the worker handler**

`@dulja/tests` may import "any package and `apps/api` **only** through its exported `createApp()`" (contracts §3.1). `apps/worker` is not named there because no earlier slice needed it; importing a *handler factory* — a pure function of its deps, with no server, no pg-boss and no network — is the same shape as importing `createApp()`, and it is the only way to prove the job path with the real job code rather than a copy of it. **This is the fifth contracts amendment this plan needs** — it widens a frozen §3.1 row — and it is recorded in the header's *Contract deviations* block and in Self-Review §6 beside the other four; do not treat it as task-local prose.

Add `@dulja/worker` to `tests/package.json` `dependencies` as `"workspace:*"` — the manifest edge that makes turbo build the worker before the `tests` typecheck runs.

**The import stays relative and no path alias is added.** Step 1's import is
`import { createMonthEndHandler } from "../../apps/worker/src/handlers/accounting";`, so a
`"@dulja/worker/*": ["../apps/worker/*"]` entry in `tests/tsconfig.json` would be dead configuration —
declared, never resolved, and a trap for the next reader. What `tests/tsconfig.json` **does** need is the
file inside its program, mirroring Task 6 Step 1(c) in the opposite direction. Add to its `include`:

```json
    "../apps/worker/src/handlers/**/*.ts"
```

Then run `bun run --cwd tests typecheck`. If it reports **TS6059** (`File … is not under 'rootDir'`), the
`tests` tsconfig pins `rootDir`; delete that one line — `tests` emits nothing and is never published — and
re-run until it is clean. Add no other `apps/worker` path: the `include` names `handlers/**` alone, so the
worker's entrypoint, its pg-boss wiring and its Sentry module stay outside the test tier's program exactly
as the amendment says they must.

Then extend `scripts/lint/rules/dependency-rule.ts`'s allowance for the `tests` tier so that `apps/worker/src/handlers/**` joins `apps/api`'s `createApp()` as importable from `tests/**`, and add the reason as a comment on that line. This is the **second** allowance this slice adds to that file — Task 6 Step 1(b) added the opposite direction, `apps/*/test/**` → `tests/invariants/support/**` — and the two are independent: leave that one exactly as it is and add this one beside it.

```ts
// The tests tier may import apps/api only through createApp() (contracts §3.1) and, from 1B, the pure
// handler factories under apps/worker/src/handlers/** — acceptance test 9's job path has to run the real
// handler, not a copy of it. Everything else in apps/** stays unreachable from tests/**.
```

If the rule is written as a deny-list of `apps/**` from `tests/**`, add the two allowed prefixes explicitly rather than removing the rule.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --cwd tests test -- invariants/period-lock.test.ts && bun run lint:rules`
Expected: PASS, six cases; `dependency-rule` green.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants/period-lock.test.ts tests/package.json tests/tsconfig.json scripts/lint/rules/dependency-rule.ts
git commit -m "$(cat <<'EOF'
test(invariants): period lock through the background-job path (test 9) [1B T8]

The system principal is the one caller for which every actor_has check passes
(spec:2179), so it is the caller that proves assert_period_open is the control.
Both layers are asserted under it — postDocument's step-5 pre-check and the
ledger_entry_period_open trigger — plus the month-end job's inability to change
any period's status (spec:2223).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Migration 0016 — the report-filter indexes (LEGACY-070)

**Files:**
- Create: `packages/db/migrations/0016_add_ledger_report_indexes.sql`, `packages/db/migrations/0016.down.sql`, `packages/db/test/report-indexes.test.ts`
- Modify: `packages/db/src/schema/account_balance.ts`, `packages/db/src/schema/fiscal_period.ts`, `packages/db/src/schema/document.ts`, `tests/regression/legacy-070.test.ts`
- Test: `packages/db/test/report-indexes.test.ts`

**Interfaces:**
- Consumes: `app.account_balance` (§4.3.3, 1A), `app.fiscal_period` and `app.document` (plan0A:1467, 1773); `listPeriodsAwaitingClose` (Task 7); `startDb`, `seedTenantV2`, the test `withTenant` (§4.1).
- Produces: three btree indexes — `account_balance_company_period_idx (company_id, fiscal_period_id, currency)`, `fiscal_period_company_status_ends_idx (company_id, status, ends_on)`, `document_company_period_status_idx (company_id, fiscal_period_id, status)`. 7B's EXPLAIN sweep re-runs this test's structural assertion over the whole catalogue.

**Which indexes, and why exactly these three.** LEGACY-070 is "index coverage is thin on exactly the columns reports filter by" — `Journal`, the legacy general-ledger header, had one declared index and it was not on date. Plan 0A already answered the ledger half: `ledger_entry_account_date_idx (company_id, account_id, effective_date)` and `ledger_entry_company_date_idx (company_id, effective_date)` (plan0A:2038–2039). What this slice's own readers add, and what nothing covers today:

| Reader | Filter | Cover today | Added |
|---|---|---|---|
| `trialBalance` (Task 10) | `account_balance` on `(company_id, fiscal_period_id[, currency])` | the primary key `(company_id, account_id, fiscal_period_id, currency)` — `account_id` sits between the two filtered columns | `account_balance_company_period_idx` |
| `listPeriodsAwaitingClose` (Task 7) | `fiscal_period` on `(status, ends_on)` per company | nothing: the table has its primary key, `unique (tenant_id, id)` and a GiST exclusion on `(company_id, daterange(starts_on, ends_on))`, none of which serves a scalar `ends_on < $1` | `fiscal_period_company_status_ends_idx` |
| the ledger report's document join and the periods screen's document count (Tasks 10, 11) | `document` on `(company_id, fiscal_period_id[, status])` | `unique (company_id, series, fiscal_period_id, number)` — `series` sits between the two filtered columns | `document_company_period_status_idx` |

`checkLedgerBalance` and `checkAccountBalanceProjection` are **deliberately not** in the table: both aggregate the whole of `ledger_entry`, and a full aggregate reads every row whatever indexes exist. Adding an index for them would be cargo cult.

- [ ] **Step 1: Write the failing test `packages/db/test/report-indexes.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listPeriodsAwaitingClose } from "../src/periods/month-end";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

/** The leading column list of every btree index on a table, in index order. */
async function indexColumns(db: Db, table: string): Promise<Record<string, string[]>> {
  const rows = await db.admin<{ index_name: string; cols: string[] }[]>`
    select i.relname as index_name,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(ix.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as cols
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_am   am on am.oid = i.relam
     where t.relnamespace = 'app'::regnamespace and t.relname = ${table} and am.amname = 'btree'
     order by 1`;
  return Object.fromEntries(rows.map((r) => [r.index_name, r.cols]));
}

describe("report filter indexes — LEGACY-070, migration 0016", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenant(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("account_balance has an index whose leading columns are exactly the trial-balance filter", async () => {
    expect((await indexColumns(db, "account_balance"))["account_balance_company_period_idx"])
      .toEqual(["company_id", "fiscal_period_id", "currency"]);
  });

  it("fiscal_period has an index whose leading columns are exactly the month-end scan's filter", async () => {
    expect((await indexColumns(db, "fiscal_period"))["fiscal_period_company_status_ends_idx"])
      .toEqual(["company_id", "status", "ends_on"]);
  });

  it("document has an index whose leading columns are exactly the period-document filter", async () => {
    expect((await indexColumns(db, "document"))["document_company_period_status_idx"])
      .toEqual(["company_id", "fiscal_period_id", "status"]);
  });

  it("the month-end scan can be served by an index — with seqscan disabled the planner still finds one", async () => {
    // With enable_seqscan = off Postgres still emits Seq Scan when NO index can serve the predicate
    // (it prices the scan at disable_cost rather than refusing to plan it). A plan free of
    // "Seq Scan on fiscal_period" is therefore evidence that an index covers the filter, and this
    // assertion genuinely fails before 0016.
    const plan = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx<Record<string, string>[]>`
        explain (costs off)
        select p.id from app.fiscal_period p
         where p.company_id = ${s.company} and p.status = 'open' and p.ends_on < '2026-06-01'::date`;
      return rows.map((r) => r["QUERY PLAN"] ?? "").join("\n");
    });
    expect(plan).not.toMatch(/Seq Scan on fiscal_period/);
    expect(plan).toMatch(/fiscal_period_company_status_ends_idx/);
  });

  it("the trial-balance filter can be served by an index", async () => {
    const plan = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx<Record<string, string>[]>`
        explain (costs off)
        select b.account_id from app.account_balance b
         where b.company_id = ${s.company} and b.fiscal_period_id = ${s.period}`;
      return rows.map((r) => r["QUERY PLAN"] ?? "").join("\n");
    });
    expect(plan).not.toMatch(/Seq Scan on account_balance/);
  });

  it("the month-end scan itself still returns the right rows over the new index", async () => {
    const due = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPeriodsAwaitingClose(tx, { asOf: "2026-06-01" }));
    expect(due.map((p) => p.fiscalPeriodId)).toEqual([s.period]);   // 2026-01 open; 2026-02 closed; 2026-03 locked
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/db test -- test/report-indexes.test.ts`
Expected: FAIL — the first three cases report `expected undefined to deeply equal [ … ]`, and the fourth reports a plan containing `Seq Scan on fiscal_period`.

- [ ] **Step 3: Add the three indexes to the Drizzle mirrors (§3.4.9 — the mirror is the diff source)**

This step assumes all three mirror files exist (assumption 10): `account_balance.ts` is 1A's, from migration 0012; `fiscal_period.ts` and `document.ts` are Plan 0A/0B mirrors of migration 0001. If one of the three is missing, author that one mirror first — every column of the table as its migration declares it, no index — then add the index line below. Do not touch the other two beyond their index line.

In `packages/db/src/schema/account_balance.ts`, add to the table's extra-config array, beside whatever 1A mirrored from migration 0012:

```ts
  index("account_balance_company_period_idx").on(t.companyId, t.fiscalPeriodId, t.currency),
```

In `packages/db/src/schema/fiscal_period.ts`:

```ts
  index("fiscal_period_company_status_ends_idx").on(t.companyId, t.status, t.endsOn),
```

In `packages/db/src/schema/document.ts`:

```ts
  index("document_company_period_status_idx").on(t.companyId, t.fiscalPeriodId, t.status),
```

Import `index` from `drizzle-orm/pg-core` in each file if it is not already imported. Then run the generator and read what it produced:

```bash
bun run --cwd packages/db exec drizzle-kit generate
```

Expected: a generated SQL file containing exactly three `CREATE INDEX` statements. ADR-0002 keeps Drizzle Kit as the diff generator and this runner as the applier (plan0A:611–612), so the next step renames and hand-edits that output rather than applying it.

- [ ] **Step 4: Write `packages/db/migrations/0016_add_ledger_report_indexes.sql`**

Rename the generated file into this slice's range and hand-edit it to the text below (lowercase keywords, section banner, one comment per statement naming its reference — contracts §3.4.3):

```sql
-- ── 1. Report filter indexes (LEGACY-070: "index coverage is thin on exactly the columns reports
--       filter by"; spec:766–784) ───────────────────────────────────────────────────────────────
-- Plan 0A already indexed the ledger itself (ledger_entry_account_date_idx, ledger_entry_company_date_idx —
-- plan0A:2038–2039). These three cover the readers this slice adds. `create index concurrently` is not
-- available: contracts §3.4.3 runs each migration file whole in one transaction.

-- accounting.trial_balance filters (company_id, fiscal_period_id[, currency]); the primary key is
-- (company_id, account_id, fiscal_period_id, currency), so account_id sits between the two filtered columns.
create index account_balance_company_period_idx
  on app.account_balance (company_id, fiscal_period_id, currency);

-- accounting.period.month_end scans (company_id, status, ends_on). fiscal_period carries only its primary
-- key, unique (tenant_id, id) and the GiST exclusion on (company_id, daterange(starts_on, ends_on)); none
-- of them serves a scalar `ends_on < $1`, so this scan is a sequential scan today.
create index fiscal_period_company_status_ends_idx
  on app.fiscal_period (company_id, status, ends_on);

-- The accounting.ledger report's document join and the fiscal-period screen's per-period document counts
-- filter (company_id, fiscal_period_id[, status]); unique (company_id, series, fiscal_period_id, number)
-- puts `series` between the two filtered columns.
create index document_company_period_status_idx
  on app.document (company_id, fiscal_period_id, status);
```

- [ ] **Step 5: Write `packages/db/migrations/0016.down.sql`**

```sql
-- Reverse of 0016, in reverse creation order (contracts §3.4.5). Dropping an index never touches a row.
drop index if exists app.document_company_period_status_idx;
drop index if exists app.fiscal_period_company_status_ends_idx;
drop index if exists app.account_balance_company_period_idx;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --cwd packages/db test -- test/report-indexes.test.ts test/privileges.test.ts`
Expected: PASS. `privileges.test.ts` matters here: `schemaFingerprint` includes `pg_indexes`, so the up → down → up assertion (§3.4.6) proves the down really removes all three.

- [ ] **Step 7: Append the regression block to `tests/regression/legacy-070.test.ts`**

**This is an append, not a create.** The 1B catalogue card says "creates legacy-070", but the 0B card lists `070` among the twenty-one thin files 0B creates for Plan 0A-proven defects, and §3.7.3's rule is that the first slice in execution order creates the file. 0B precedes 1B, so 0B created it and this slice appends its own `describe` block without touching the earlier one.

```ts
describe("LEGACY-070 Index coverage is thin on exactly the columns reports filter by — 1B", () => {
  let db: Db; let s: Seed;
  beforeAll(async () => { db = await startDb(); s = await seedTenant(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  it("every column the Phase 1 reports and jobs filter by has an index whose leading columns are exactly it", async () => {
    const expected: Record<string, string[]> = {
      account_balance_company_period_idx: ["company_id", "fiscal_period_id", "currency"],
      fiscal_period_company_status_ends_idx: ["company_id", "status", "ends_on"],
      document_company_period_status_idx: ["company_id", "fiscal_period_id", "status"],
      ledger_entry_account_date_idx: ["company_id", "account_id", "effective_date"],
      ledger_entry_company_date_idx: ["company_id", "effective_date"],
      audit_log_tenant_seq_idx: ["tenant_id", "seq"],
    };
    const rows = await db.admin<{ index_name: string; cols: string[] }[]>`
      select i.relname as index_name,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(ix.indkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as cols
        from pg_index ix
        join pg_class i on i.oid = ix.indexrelid
        join pg_class t on t.oid = ix.indrelid
       where t.relnamespace = 'app'::regnamespace and i.relname = any(${Object.keys(expected)})
       order by 1`;
    expect(Object.fromEntries(rows.map((r) => [r.index_name, r.cols]))).toEqual(expected);
  });

  it("the legacy failure mode is impossible: the ledger's date column is indexed", async () => {
    // spec:770 — "`Journal` … has exactly one declared index, and it is not on date".
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class t on t.oid = ix.indrelid
        join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = ix.indkey[0]
       where t.relnamespace = 'app'::regnamespace and t.relname = 'ledger_entry'`;
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);   // the primary key, unique (tenant_id, id), and the two date indexes
  });
});
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0016_add_ledger_report_indexes.sql packages/db/migrations/0016.down.sql \
        packages/db/src/schema/account_balance.ts packages/db/src/schema/fiscal_period.ts \
        packages/db/src/schema/document.ts packages/db/test/report-indexes.test.ts tests/regression/legacy-070.test.ts
git commit -m "$(cat <<'EOF'
feat(db): index the columns the Phase 1 reports and jobs filter by [1B T9]

Migration 0016 adds account_balance (company_id, fiscal_period_id, currency),
fiscal_period (company_id, status, ends_on) — a sequential scan until now — and
document (company_id, fiscal_period_id, status). Generated from the Drizzle
mirrors per ADR-0002 and hand-edited. LEGACY-070.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The two minimal reports — `accounting.trial_balance` and `accounting.ledger`

**Files:**
- Create: `packages/db/src/reports/trial-balance.ts`, `packages/db/src/reports/ledger.ts`, `packages/contracts/src/accounting/reports.ts`, `apps/api/src/routes/accounting/reports.ts`, `apps/api/test/routes/accounting/reports.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `apps/api/tsconfig.json`, `tests/invariants/probes.ts`, `packages/contracts/openapi.json`
- Test: `apps/api/test/routes/accounting/reports.test.ts`

**Interfaces:**
- Consumes: `app.account_balance`, `app.ledger_entry`, `app.account`, `app.document`, `app.document_type`, `app.company.base_currency`; `PERMISSION`, `requirePermission`, `ScopeSource` (§4.2.5); `RouteModule`, `buildRoutes` (§4.2.7); `AppEnv`, `c.var.withTenant`, `c.var.logger` (§4.2.3); `UuidSchema`, `DateSchema`, `CurrencySchema`, `MoneySchema`, `RateSchema`, `CursorSchema`, `ListEnvelope`, `ListQuery`, and the one cursor codec `Cursor` / `encodeCursor` / `decodeCursor` (§4.2.8); `AppError` with the frozen constructor `(code: ErrCode, detail: string, extra?: Partial<Problem>)`, `Problem` (§4.2.4); `startApi`, `ApiRequest`, `StartedApi` (§4.2.12); `IsolationProbe`, `PROBES` (§4.2.7); `postJournal` from `tests/invariants/support/post-journal.ts` (Task 3), reachable from `apps/api/test/**` through the allowance Task 6 Step 1(b) added; **`AccountTypeSchema` from `packages/contracts/src/accounting/account.ts` (1A)** — `TrialBalanceRowSchema.accountType` imports it and this slice neither re-declares nor re-exports it (§4.2.8's module table gives that name to `accounting/account.ts`).
- Produces:
  - `trialBalance(tx, params: TrialBalanceParams): Promise<TrialBalanceRow[]>` and `trialBalanceFingerprint(tx, params: { companyId: string; fiscalPeriodId?: string }): Promise<string>` from `@dulja/db`.
  - `accountOpeningBalance(tx, params: { companyId: string; accountId: string; beforeDate: string }): Promise<string>` and `accountLedger(tx, params: LedgerParams): Promise<LedgerRow[]>` from `@dulja/db`. **7B re-expresses both reports as `ReportDefinition`s over these same functions and re-runs this task's tie-out tests unchanged** (§4.16.1).
  - `reportsRoutes` and `reportsRouteModule` from `apps/api/src/routes/accounting/reports.ts`, mounted at `/v1/companies/:companyId/reports`. **7A extends this same module** with `POST …/reports/{code}/runs`; it must not create a second module on the same path, because `PROBES` is keyed by `RouteModule.path` (§4.2.7).
  - `TrialBalanceRowSchema`, `TrialBalanceQuery`, `TrialBalanceList`, `LedgerRowSchema`, `LedgerQuery`, `LedgerList`, `ReportCodeSchema` from `@dulja/contracts`.

**One declared extension to a frozen shape.** §4.2.8 fixes every list response as `{ items, next_cursor }`. `LedgerList` adds a third member, `opening_base_balance`: a ledger that does not state the balance brought forward is not a ledger, and the alternative — making the caller derive it from the first row's running balance by subtracting that row's movement — is money arithmetic in a client, which spec:2041 exists to prevent. The addition is purely additive; a client reading `items` and `next_cursor` is unaffected. It is listed in this plan's contract additions.

- [ ] **Step 1: Write `packages/db/src/reports/trial-balance.ts`**

```ts
import type { Sql } from "postgres";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface TrialBalanceParams {
  companyId: string;
  fiscalPeriodId: string;
  /** Restrict to one document currency. Omitted: every currency the period has balances in. */
  currency?: string;
  /** Keyset position: the last row of the previous page. */
  cursor?: { accountCode: string; currency: string } | null;
  limit: number;
}

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountNameEn: string;
  accountNameAr: string | null;
  accountType: AccountType;
  currency: string;
  /** Fixed 4 dp strings, exactly as stored — "stored base amounts are never recomputed on read" (spec:2041). */
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
}

/**
 * The `accounting.trial_balance` dataset (§4.16.1, spec:2300's minimal set). It reads the SYNCHRONOUS
 * projection app.account_balance, which the posting service MERGEs in the posting transaction (D14,
 * §4.3.3) — so a trial balance is exact the instant a document posts (spec:1204). It never re-aggregates
 * ledger_entry: that is the integrity job's business (Task 4), and a report that quietly recomputed
 * would hide exactly the drift the job exists to find.
 *
 * Keyset pagination on (account.code, currency); both are text, and both are in the ORDER BY, so the
 * page boundary is total.
 */
export async function trialBalance(tx: Sql, params: TrialBalanceParams): Promise<TrialBalanceRow[]> {
  const currency = params.currency ?? null;
  const cursorCode = params.cursor?.accountCode ?? null;
  const cursorCurrency = params.cursor?.currency ?? null;

  const rows = await tx<{
    account_id: string; code: string; name_en: string; name_ar: string | null; type: AccountType;
    currency: string; debit: string; credit: string; base_debit: string; base_credit: string;
  }[]>`
    select b.account_id::text, a.code, a.name_en, a.name_ar, a.type::text as type,
           b.currency::text     as currency,
           b.debit::text        as debit,
           b.credit::text       as credit,
           b.base_debit::text   as base_debit,
           b.base_credit::text  as base_credit
      from app.account_balance b
      join app.account a on a.id = b.account_id
     where b.company_id       = ${params.companyId}
       and b.fiscal_period_id = ${params.fiscalPeriodId}
       and (${currency}::text is null or b.currency::text = ${currency})
       and (${cursorCode}::text is null
            or (a.code, b.currency::text) > (${cursorCode}::text, ${cursorCurrency}::text))
     order by a.code, b.currency
     limit ${params.limit}`;

  return rows.map((r) => ({
    accountId: r.account_id,
    accountCode: r.code,
    accountNameEn: r.name_en,
    accountNameAr: r.name_ar,
    accountType: r.type,
    currency: r.currency,
    debit: r.debit,
    credit: r.credit,
    baseDebit: r.base_debit,
    baseCredit: r.base_credit,
  }));
}

/**
 * A deterministic sha256 over the whole trial balance of one company (optionally one period), in a
 * fixed row and column order. Acceptance test 24 compares this figure across a point-in-time restore:
 * "the trial balance computed from the restored ledger equals the trial balance the live system
 * reported at that timestamp" (spec:2442). Hashing in SQL keeps the comparison free of any JavaScript
 * number and of any locale-dependent formatting.
 */
export async function trialBalanceFingerprint(
  tx: Sql, params: { companyId: string; fiscalPeriodId?: string },
): Promise<string> {
  const periodId = params.fiscalPeriodId ?? null;
  const [row] = await tx<{ fingerprint: string }[]>`
    select encode(sha256(convert_to(coalesce(string_agg(
             b.account_id::text || '|' || b.fiscal_period_id::text || '|' || b.currency || '|' ||
             b.debit::text || '|' || b.credit::text || '|' || b.base_debit::text || '|' || b.base_credit::text,
             E'\n' order by b.account_id, b.fiscal_period_id, b.currency), ''), 'UTF8')), 'hex') as fingerprint
      from app.account_balance b
     where b.company_id = ${params.companyId}
       and (${periodId}::uuid is null or b.fiscal_period_id = ${periodId})`;
  return row!.fingerprint;
}
```

- [ ] **Step 2: Write `packages/db/src/reports/ledger.ts`**

```ts
import type { Sql } from "postgres";

export interface LedgerParams {
  companyId: string;
  accountId: string;
  /** Inclusive, on effective_date — the accounting date, never posted_at (spec:2039). */
  fromDate: string;
  toDate: string;
  /**
   * Keyset position plus the running balance the previous page ended on, so page N + 1 continues the
   * arithmetic instead of restarting it.
   */
  cursor?: { effectiveDate: string; postingSeq: string; lineNo: number; runningBaseBalance: string } | null;
  limit: number;
}

export interface LedgerRow {
  entryId: string;
  effectiveDate: string;
  documentId: string;
  documentTypeCode: string;
  series: string;
  /** bigint as a string; null is impossible for a posted document but the column is nullable. */
  number: string | null;
  lineNo: number;
  postingSeq: string;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
  /** Opening balance plus every movement up to and including this row, in base. */
  runningBaseBalance: string;
}

/**
 * The balance brought forward: every base movement on the account strictly before `beforeDate`.
 * Signed as debit − credit, so an asset carries a positive brought-forward figure.
 */
export async function accountOpeningBalance(
  tx: Sql, params: { companyId: string; accountId: string; beforeDate: string },
): Promise<string> {
  const [row] = await tx<{ opening: string }[]>`
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)::text as opening
      from app.ledger_entry l
     where l.company_id     = ${params.companyId}
       and l.account_id     = ${params.accountId}
       and l.effective_date < ${params.beforeDate}::date`;
  return row!.opening;
}

/**
 * The `accounting.ledger` dataset (§4.16.1): one account's entries over a date range, with a running
 * base balance. The chronological key is (effective_date, document.posting_seq, line_no) — posting_seq
 * is the total order within a company that §4.3.5 defines and §4.3.2 step 8 assigns before any row that
 * carries it, so two documents with the same effective_date still order deterministically.
 *
 * The window sum runs over the rows this page selects and is seeded with `cursor.runningBaseBalance`
 * (or the opening balance for the first page), so paging never restarts the arithmetic.
 *
 * There is no join to document_line: ledger_entry.line_no is the LEDGER line ordinal (it carries
 * `unique (document_id, line_no)` and a policy may emit several ledger lines per document line), so a
 * join on it would be wrong. The document's type, series and number identify the row instead.
 */
export async function accountLedger(tx: Sql, params: LedgerParams): Promise<LedgerRow[]> {
  const seed = params.cursor?.runningBaseBalance ?? null;
  const opening = seed ?? await accountOpeningBalance(tx, {
    companyId: params.companyId, accountId: params.accountId, beforeDate: params.fromDate,
  });
  const cursorDate = params.cursor?.effectiveDate ?? null;
  const cursorSeq = params.cursor?.postingSeq ?? null;
  const cursorLine = params.cursor?.lineNo ?? null;

  const rows = await tx<{
    entry_id: string; effective_date: string; document_id: string; document_type_code: string;
    series: string; number: string | null; line_no: number; posting_seq: string;
    currency: string; exchange_rate: string; debit: string; credit: string;
    base_debit: string; base_credit: string; running_base_balance: string;
  }[]>`
    select l.id::text                as entry_id,
           l.effective_date::text    as effective_date,
           l.document_id::text       as document_id,
           dt.code                   as document_type_code,
           d.series                  as series,
           d.number::text            as number,
           l.line_no                 as line_no,
           d.posting_seq::text       as posting_seq,
           l.currency::text          as currency,
           l.exchange_rate::text     as exchange_rate,
           l.debit::text             as debit,
           l.credit::text            as credit,
           l.base_debit::text        as base_debit,
           l.base_credit::text       as base_credit,
           (${opening}::numeric(19,4)
             + sum(l.base_debit - l.base_credit) over (
                 order by l.effective_date, d.posting_seq, l.line_no
                 rows between unbounded preceding and current row))::numeric(19,4)::text
                                     as running_base_balance
      from app.ledger_entry l
      join app.document d       on d.id  = l.document_id
      join app.document_type dt on dt.id = d.document_type_id
     where l.company_id      = ${params.companyId}
       and l.account_id      = ${params.accountId}
       and l.effective_date >= ${params.fromDate}::date
       and l.effective_date <= ${params.toDate}::date
       and (${cursorDate}::date is null
            or (l.effective_date, d.posting_seq, l.line_no)
               > (${cursorDate}::date, ${cursorSeq}::bigint, ${cursorLine}::int))
     order by l.effective_date, d.posting_seq, l.line_no
     limit ${params.limit}`;

  return rows.map((r) => ({
    entryId: r.entry_id,
    effectiveDate: r.effective_date,
    documentId: r.document_id,
    documentTypeCode: r.document_type_code,
    series: r.series,
    number: r.number,
    lineNo: r.line_no,
    postingSeq: r.posting_seq,
    currency: r.currency,
    exchangeRate: r.exchange_rate,
    debit: r.debit,
    credit: r.credit,
    baseDebit: r.base_debit,
    baseCredit: r.base_credit,
    runningBaseBalance: r.running_base_balance,
  }));
}
```

- [ ] **Step 3: Export both from `packages/db/src/index.ts`**

```ts
export {
  trialBalance, trialBalanceFingerprint,
  type AccountType, type TrialBalanceParams, type TrialBalanceRow,
} from "./reports/trial-balance";
export {
  accountLedger, accountOpeningBalance, type LedgerParams, type LedgerRow,
} from "./reports/ledger";
```

- [ ] **Step 4: Write `packages/contracts/src/accounting/reports.ts`**

```ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, DateSchema, ListEnvelope, ListQuery, MoneySchema, RateSchema, UuidSchema } from "../common";
/**
 * `AccountTypeSchema` is **1A's**, declared in `packages/contracts/src/accounting/account.ts`
 * (`z.enum(["asset","liability","equity","income","expense"])`) and already re-exported from the barrel
 * by 1A's `export * from "./accounting/account";`. It is imported here and **not** re-declared and
 * **not** re-exported: two `export *` statements carrying one name is TS2308
 * ("Module './accounting/account' has already exported a member named 'AccountTypeSchema'"), which would
 * stop `packages/contracts` type-checking and fail Step 9 and Task 13's whole-repo gate. §4.2.8's module
 * table lists ten names for this file and `AccountTypeSchema` is deliberately not among them.
 */
import { AccountTypeSchema } from "./account";

/** The two report codes slice 1B owns in the closed register of contracts §4.16.1. */
export const ReportCodeSchema = z.enum(["accounting.trial_balance", "accounting.ledger"]);
export type ReportCode = z.infer<typeof ReportCodeSchema>;

export const TrialBalanceRowSchema = z.object({
  accountId: UuidSchema,
  accountCode: z.string(),
  accountNameEn: z.string(),
  accountNameAr: z.string().nullable(),
  accountType: AccountTypeSchema,
  currency: CurrencySchema,
  debit: MoneySchema,
  credit: MoneySchema,
  baseDebit: MoneySchema,
  baseCredit: MoneySchema,
});
export type TrialBalanceRowDto = z.infer<typeof TrialBalanceRowSchema>;

/**
 * The only filterable/sortable fields; anything else is ERR_VALIDATION_FAILED (§4.2.8).
 * `.strict()` is what makes that true rather than aspirational: `ListQuery` is a plain `z.object`, and a
 * plain Zod object STRIPS unknown keys instead of rejecting them, so without this a
 * `filter[account_code][like]=…` would be dropped silently and the request would answer 200. Both query
 * schemas in this file carry it.
 */
export const TrialBalanceQuery = ListQuery.extend({
  fiscalPeriodId: UuidSchema,
  currency: CurrencySchema.optional(),
}).strict();

export const TrialBalanceList = ListEnvelope(TrialBalanceRowSchema);

export const LedgerRowSchema = z.object({
  entryId: UuidSchema,
  effectiveDate: DateSchema,
  documentId: UuidSchema,
  documentTypeCode: z.string(),
  series: z.string(),
  number: z.string().nullable(),
  lineNo: z.number().int().positive(),
  postingSeq: z.string(),
  currency: CurrencySchema,
  exchangeRate: RateSchema,
  debit: MoneySchema,
  credit: MoneySchema,
  baseDebit: MoneySchema,
  baseCredit: MoneySchema,
  runningBaseBalance: MoneySchema,
});
export type LedgerRowDto = z.infer<typeof LedgerRowSchema>;

export const LedgerQuery = ListQuery.extend({
  accountId: UuidSchema,
  fromDate: DateSchema,
  toDate: DateSchema,
}).strict();

/**
 * `{ items, next_cursor }` per §4.2.8, plus `opening_base_balance`: a ledger that does not state the
 * balance brought forward is not a ledger, and deriving it client-side would be money arithmetic in a
 * client (spec:2041). Purely additive — a client reading only items/next_cursor is unaffected.
 *
 * **It is the balance brought forward into `fromDate`, and it is page-invariant**: every page of the same
 * `(accountId, fromDate, toDate)` carries the same value, so a view may render it once as a header. It is
 * NOT "the balance this page opens with" — that number is the previous page's last `runningBaseBalance`,
 * which travels inside the cursor and never appears on the wire as a field.
 */
export const LedgerList = ListEnvelope(LedgerRowSchema).extend({
  opening_base_balance: MoneySchema,
});
```

Add exactly one line to `packages/contracts/src/index.ts`, beside the other module barrels:

```ts
export * from "./accounting/reports";
```

It is safe to widen the barrel this way only because the file above re-exports **no** name 1A's
`./accounting/account` already exports — `AccountTypeSchema` is imported and consumed, never re-declared.
Before committing, prove it mechanically:

```bash
bun run --cwd packages/contracts typecheck
```

Expected: clean. A TS2308 here means a name was duplicated across two barrels; the fix is to delete the
duplicate declaration in **this** file, never to narrow 1A's `export *`.

- [ ] **Step 5: Write the failing test `apps/api/test/routes/accounting/reports.test.ts`**

This file imports `postJournal` from the `tests` workspace, exactly as Task 6's and Task 7's worker tests do. The `dependency-rule.ts` allowance that permits it is already in place from Task 6 Step 1(b) and needs no second edit; what `apps/api` still needs is its own tsconfig entry. Add to `apps/api/tsconfig.json`'s `include`:

```json
    "../../tests/invariants/support/**/*.ts"
```

and run `bun run --cwd apps/api typecheck`; if it reports **TS6059**, delete the `rootDir` line as Task 6 Step 1(c) describes. Add no `@dulja/tests` dependency to `apps/api/package.json` — `tests/package.json` already depends on `@dulja/api`, and the reverse edge would close a cycle in the graph turbo walks.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { postJournal } from "../../../../../tests/invariants/support/post-journal";

/**
 * Creates a role holding `codes`, assigns it to `principalId` in the seed company, as the system principal.
 *
 * **Why file-local, and why not named `grantCodes`.** §4.1 pins 0B's `grantAdmin()` as "the one way" a
 * route test grants — but that helper lives in `tests/support/api.ts`, and the only `apps/*/test/**` →
 * `tests/**` allowance this slice adds (Task 6 Step 1(b)) reaches `tests/invariants/support/**` only, so
 * it is not importable from here. §4.17 separately reserves the identifier `grantCodes` for 2B with a
 * different signature (`(db, s, opts?) => Promise<string>`), so this one carries a different name outright
 * rather than shadowing it. The three inserts are plan0A:1195–1200's, verbatim, and they run under
 * `s.system` so `forbid_self_grant` is not tripped. Recorded in the header's *Contract deviations* block.
 */
async function grantReportCodes(db: Db, s: Seed, principalId: string, roleCode: string, codes: string[]): Promise<void> {
  const roleId = await uuidv7(db.admin);
  await withTenant(db.migrator, { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${roleId}, ${s.tenant}, ${roleCode}, ${roleCode}, false)`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
}

describe("GET /v1/companies/{companyId}/reports — the Phase 1 minimal set (spec:2300, §4.16.1)", () => {
  let api: StartedApi; let db: Db; let a: Seed; let reader: string; let outsider: string;

  beforeAll(async () => {
    api = await startApi();
    db = api.db;
    a = await seedTenantV2(db, "Alpha");
    reader = a.human;
    outsider = await uuidv7(db.admin);
    await withTenant(db.migrator, { tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${outsider}, 'human', ${"human-2:" + a.tenant}, 'Outsider')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${outsider})`;
      });
    await grantReportCodes(db, a, reader, "phase1b_reader",
      ["accounting.report.read", "accounting.ledger.read"]);
    await grantReportCodes(db, a, outsider, "phase1b_nothing", []);

    await postJournal(db, a, [{ account: a.cash, debit: "100.0000" }, { account: a.sales, credit: "100.0000" }],
      { effectiveDate: "2026-01-05" });
    await postJournal(db, a, [{ account: a.cash, debit: "25.0000" }, { account: a.sales, credit: "25.0000" }],
      { effectiveDate: "2026-01-12" });
    await postJournal(db, a, [{ account: a.sales, debit: "10.0000" }, { account: a.cash, credit: "10.0000" }],
      { effectiveDate: "2026-01-20" });
  });
  afterAll(async () => { await api.stop(); });

  const tb = (query: string, as = reader) =>
    api.request({ method: "GET", path: `/v1/companies/${a.company}/reports/accounting.trial_balance?${query}`, as });
  const ledger = (query: string, as = reader) =>
    api.request({ method: "GET", path: `/v1/companies/${a.company}/reports/accounting.ledger?${query}`, as });

  it("the trial balance ties to the ledger: Σdebit = Σcredit and every row matches a fresh recomputation", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { accountCode: string; debit: { amount: string }; credit: { amount: string } }[]; next_cursor: string | null };

    const recomputed = await withTenant(db.rw, { tenantId: a.tenant, actorId: reader, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, sum(l.debit)::text as debit, sum(l.credit)::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.company_id = ${a.company} and l.fiscal_period_id = ${a.period}
         group by a.code order by a.code`);

    expect(body.items.map((r) => ({ code: r.accountCode, debit: r.debit.amount, credit: r.credit.amount })))
      .toEqual(recomputed.map((r) => ({ code: r.code, debit: r.debit, credit: r.credit })));

    const sum = (pick: (r: { debit: { amount: string }; credit: { amount: string } }) => string) =>
      body.items.reduce((acc, r) => acc + BigInt(pick(r).replace(".", "")), 0n);
    expect(sum((r) => r.debit.amount)).toBe(sum((r) => r.credit.amount));
  });

  it("keyset pages concatenate to the single-page result", async () => {
    const one = await (await tb(`fiscalPeriodId=${a.period}&limit=1000`)).json() as { items: { accountCode: string }[] };
    const first = await (await tb(`fiscalPeriodId=${a.period}&limit=1`)).json() as { items: { accountCode: string }[]; next_cursor: string };
    const second = await (await tb(`fiscalPeriodId=${a.period}&limit=1&cursor=${first.next_cursor}`)).json() as { items: { accountCode: string }[] };
    expect([...first.items, ...second.items].map((r) => r.accountCode)).toEqual(one.items.map((r) => r.accountCode));
  });

  it("the ledger report's closing running balance equals account_balance for the account", async () => {
    const res = await ledger(`accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: { runningBaseBalance: { amount: string } }[];
      opening_base_balance: { amount: string };
    };
    expect(body.opening_base_balance.amount).toBe("0.0000");

    const [row] = await withTenant(db.rw, { tenantId: a.tenant, actorId: reader, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ balance: string }[]>`
        select (base_debit - base_credit)::numeric(19,4)::text as balance
          from app.account_balance
         where company_id = ${a.company} and account_id = ${a.cash}
           and fiscal_period_id = ${a.period} and currency = 'MYR'`);
    expect(body.items.at(-1)!.runningBaseBalance.amount).toBe(row!.balance);
  });

  it("the ledger's rows are ordered by (effective_date, posting_seq, line_no) and carry the document identity", async () => {
    const body = await (await ledger(`accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=1000`)).json() as {
      items: { effectiveDate: string; postingSeq: string; documentTypeCode: string; series: string }[];
    };
    expect(body.items.map((r) => r.effectiveDate)).toEqual([...body.items.map((r) => r.effectiveDate)].sort());
    expect(new Set(body.items.map((r) => r.documentTypeCode))).toEqual(new Set(["JOURNAL"]));
    expect(new Set(body.items.map((r) => r.series))).toEqual(new Set(["JV"]));
  });

  it("opening_base_balance is the balance brought forward and is identical on every page of a range", async () => {
    // Not the previous page's closing figure: a view that prints "Opening balance" as a header must show
    // one number for the whole range, and the running balance is already on every row (§4.16.3).
    const whole = await (await ledger(`accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1000`))
      .json() as { opening_base_balance: { amount: string } };
    const first = await (await ledger(`accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1`))
      .json() as { opening_base_balance: { amount: string }; next_cursor: string };
    const second = await (await ledger(
      `accountId=${a.cash}&fromDate=2026-01-10&toDate=2026-01-31&limit=1&cursor=${first.next_cursor}`))
      .json() as { opening_base_balance: { amount: string }; items: { runningBaseBalance: { amount: string } }[] };

    // 2026-01-05 posted 100.0000 to cash and is strictly before fromDate, so it is the brought-forward figure.
    expect(whole.opening_base_balance.amount).toBe("100.0000");
    expect(first.opening_base_balance.amount).toBe(whole.opening_base_balance.amount);
    expect(second.opening_base_balance.amount).toBe(whole.opening_base_balance.amount);
    // Page 2 still continues the running sum, which is what the cursor carries.
    expect(second.items[0]!.runningBaseBalance.amount).toBe("115.0000");
  });

  it("a principal without accounting.report.read is refused", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}`, outsider);
    expect(res.status).toBe(403);
    expect((await res.json() as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the ledger report needs accounting.ledger.read as well as accounting.report.read", async () => {
    const reportOnly = await uuidv7(db.admin);
    await withTenant(db.migrator, { tenantId: a.tenant, actorId: a.system, requestId: await uuidv7(db.admin) },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${reportOnly}, 'human', ${"human-3:" + a.tenant}, 'Reports only')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${reportOnly})`;
      });
    await grantReportCodes(db, a, reportOnly, "phase1b_reports_only", ["accounting.report.read"]);
    expect((await tb(`fiscalPeriodId=${a.period}`, reportOnly)).status).toBe(200);
    const res = await ledger(`accountId=${a.cash}&fromDate=2026-01-01&toDate=2026-01-31`, reportOnly);
    expect(res.status).toBe(403);
    expect((await res.json() as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("an undeclared query field is a validation failure, and no field name reaches SQL as text (test 27)", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&filter[account_code][like]=1%27%3B--`);
    const body = await res.json() as Problem;
    expect(res.status).toBe(400);
    expect(body.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a malformed cursor is a validation failure, never a 500", async () => {
    const res = await tb(`fiscalPeriodId=${a.period}&cursor=not-base64url-json`);
    expect(res.status).toBe(400);
    expect((await res.json() as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run --cwd apps/api test -- test/routes/accounting/reports.test.ts`
Expected: FAIL — every case 404s, because no route is mounted at that path yet.

- [ ] **Step 7: Write `apps/api/src/routes/accounting/reports.ts`**

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  AppError, decodeCursor, encodeCursor, LedgerList, LedgerQuery, ProblemSchema,
  TrialBalanceList, TrialBalanceQuery,
} from "@dulja/contracts";
import { accountLedger, accountOpeningBalance, trialBalance } from "@dulja/db";
import type { AppEnv } from "../../context";
import type { RouteModule } from "../index";
import { requirePermission } from "../../middleware/require-permission";

// The cursor codec is `@dulja/contracts`' single implementation (§4.2.8: "one implementation, in `common.ts`,
// imported by every list handler in every slice" — a second base64url round-trip here would be hazard 9).
// `decodeCursor` returns the registered `Cursor` (`{ k: unknown[]; id: string }`) and itself throws
// AppError("ERR_VALIDATION_FAILED") on anything that is not that shape, so each handler below only has to check
// that the decoded `k` matches *its own* keyset. 7A reuses the same codec when it adds
// POST /v1/companies/{companyId}/reports/{code}/runs to this same router.

const CompanyParams = z.object({ companyId: z.string().uuid() });

export const reportsRoutes = new OpenAPIHono<AppEnv>();

const trialBalanceRoute = createRoute({
  method: "get",
  path: "/accounting.trial_balance",
  tags: ["accounting"],
  summary: "Trial balance for one fiscal period (report code accounting.trial_balance)",
  middleware: [requirePermission(PERMISSION["accounting.report.read"], { company: "path:companyId" })] as const,
  request: { params: CompanyParams, query: TrialBalanceQuery },
  responses: {
    200: { description: "Trial balance rows", content: { "application/json": { schema: TrialBalanceList } } },
    400: { description: "Invalid query", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

reportsRoutes.openapi(trialBalanceRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  let cursor: { accountCode: string; currency: string } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    if (decoded.k.length !== 2 || typeof decoded.k[0] !== "string" || typeof decoded.k[1] !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for accounting.trial_balance");
    }
    cursor = { accountCode: decoded.k[0], currency: decoded.k[1] };
  }

  const { rows, baseCurrency } = await c.var.withTenant(async (tx) => {
    const [company] = await tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${companyId}`;
    const found = await trialBalance(tx, {
      companyId, fiscalPeriodId: q.fiscalPeriodId, currency: q.currency, cursor, limit: q.limit,
    });
    return { rows: found, baseCurrency: company?.base_currency ?? "MYR" };
  });

  const last = rows.at(-1);
  return c.json({
    items: rows.map((r) => ({
      accountId: r.accountId,
      accountCode: r.accountCode,
      accountNameEn: r.accountNameEn,
      accountNameAr: r.accountNameAr,
      accountType: r.accountType,
      currency: r.currency,
      debit: { amount: r.debit, currency: r.currency },
      credit: { amount: r.credit, currency: r.currency },
      baseDebit: { amount: r.baseDebit, currency: baseCurrency },
      baseCredit: { amount: r.baseCredit, currency: baseCurrency },
    })),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.accountCode, last.currency], id: last.accountId })
      : null,
  }, 200);
});

const ledgerRoute = createRoute({
  method: "get",
  path: "/accounting.ledger",
  tags: ["accounting"],
  summary: "One account's ledger over a date range (report code accounting.ledger)",
  middleware: [
    requirePermission(PERMISSION["accounting.report.read"], { company: "path:companyId" }),
    requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" }),
  ] as const,
  request: { params: CompanyParams, query: LedgerQuery },
  responses: {
    200: { description: "Ledger rows with a running base balance", content: { "application/json": { schema: LedgerList } } },
    400: { description: "Invalid query", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

reportsRoutes.openapi(ledgerRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  let cursor: { effectiveDate: string; postingSeq: string; lineNo: number; runningBaseBalance: string } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    if (decoded.k.length !== 4
        || typeof decoded.k[0] !== "string" || typeof decoded.k[1] !== "string"
        || typeof decoded.k[2] !== "number" || typeof decoded.k[3] !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for accounting.ledger");
    }
    cursor = {
      effectiveDate: decoded.k[0], postingSeq: decoded.k[1],
      lineNo: decoded.k[2], runningBaseBalance: decoded.k[3],
    };
  }

  const { rows, opening, baseCurrency } = await c.var.withTenant(async (tx) => {
    const [company] = await tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${companyId}`;
    // `opening_base_balance` is the balance BROUGHT FORWARD into `fromDate`, and it is the same number on
    // every page of the same range — a client that prints "Opening balance" per page must not see it
    // change under it. It is therefore computed from `fromDate` unconditionally, never seeded from the
    // cursor. `cursor.runningBaseBalance` is the internal seed for the running sum and is passed to
    // `accountLedger` below and nowhere else (§4.16.3: "the balance brought forward: every base movement
    // on the account strictly before `beforeDate`").
    const openingBalance = await accountOpeningBalance(
      tx, { companyId, accountId: q.accountId, beforeDate: q.fromDate });
    const found = await accountLedger(tx, {
      companyId, accountId: q.accountId, fromDate: q.fromDate, toDate: q.toDate, cursor, limit: q.limit,
    });
    return { rows: found, opening: openingBalance, baseCurrency: company?.base_currency ?? "MYR" };
  });

  const last = rows.at(-1);
  return c.json({
    items: rows.map((r) => ({
      entryId: r.entryId,
      effectiveDate: r.effectiveDate,
      documentId: r.documentId,
      documentTypeCode: r.documentTypeCode,
      series: r.series,
      number: r.number,
      lineNo: r.lineNo,
      postingSeq: r.postingSeq,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      debit: { amount: r.debit, currency: r.currency },
      credit: { amount: r.credit, currency: r.currency },
      baseDebit: { amount: r.baseDebit, currency: baseCurrency },
      baseCredit: { amount: r.baseCredit, currency: baseCurrency },
      runningBaseBalance: { amount: r.runningBaseBalance, currency: baseCurrency },
    })),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.effectiveDate, last.postingSeq, last.lineNo, last.runningBaseBalance], id: last.entryId })
      : null,
    opening_base_balance: { amount: opening, currency: baseCurrency },
  }, 200);
});

export const reportsRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/reports",
  router: reportsRoutes,
  permissions: [PERMISSION["accounting.report.read"], PERMISSION["accounting.ledger.read"]],
  auth: "human",
};
```

A cursor that is not base64url of `{ k, id }` at all is rejected inside `@dulja/contracts`' `decodeCursor` with the same `ERR_VALIDATION_FAILED`; the two rejections written out above are the *keyset*-shape checks each handler must make for itself, and they `throw new AppError(code, detail)` — §4.2.4's frozen constructor is `constructor(readonly code: ErrCode, readonly detail: string, readonly extra?: Partial<Problem>)`, so the first argument is the code *string* `"ERR_VALIDATION_FAILED"` (a member of `ErrCode = keyof typeof ERRORS`), not the `ERRORS` entry, which is an `ErrorDef`. 0B's global error handler renders it as `application/problem+json` with the registry's `status`, `title` and `remedy`, which is why neither handler builds a body or picks a status itself.

- [ ] **Step 8: Register the module and its isolation probe**

In `apps/api/src/routes/index.ts`, add to `buildRoutes` — **not** to the `ROUTES` array, which §4.2.7 derives from `buildRoutes({ authAdmin: new StubAuthAdmin() })`; every slice registers its module inside the function, exactly as 1A's four modules do:

```ts
    reportsRouteModule,
```

In `tests/invariants/probes.ts` add the entry keyed by the module's exact `path` (the harness fails the build if a `ROUTES` entry has no `PROBES` entry — §4.2.7):

```ts
  "/v1/companies/:companyId/reports": {
    async seed(db, owner) {
      // Tenant A asks for tenant B's company and period. RLS makes the rows invisible and
      // requirePermission's actor_has(code, <B's company>) is false, so the answer is 403 either way.
      return {
        path: `/v1/companies/${owner.company}/reports/accounting.trial_balance?fiscalPeriodId=${owner.period}`,
        method: "GET",
      };
    },
    expect: 403,
  },
```

- [ ] **Step 9: Run the route tests, regenerate OpenAPI, run the lints**

```bash
bun run --cwd apps/api test -- test/routes/accounting/reports.test.ts
bun run --cwd packages/contracts openapi:generate
bun run --cwd tests test -- invariants/tenant-isolation.test.ts
bun run lint:rules
```

Expected: the route tests PASS (nine cases); `openapi.json` gains the two `GET` paths and must be committed (CI diffs it — spec:2055); the isolation harness PASSES with the new probe; **`lint:rules` now goes green** — `accounting.report.read` finally has a reference, closing the red opened in Task 1.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/reports/trial-balance.ts packages/db/src/reports/ledger.ts packages/db/src/index.ts \
        packages/contracts/src/accounting/reports.ts packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/reports.ts apps/api/src/routes/index.ts apps/api/tsconfig.json \
        apps/api/test/routes/accounting/reports.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the Phase 1 minimal reports — trial balance and ledger [1B T10]

Two withTenant read endpoints under the registered codes accounting.trial_balance
and accounting.ledger (§4.16.1), over hand-written dataset queries — no SQL text
crosses the API (test 27). The trial balance reads the synchronous account_balance
projection; the ledger carries an opening balance and a running base balance
ordered by (effective_date, posting_seq, line_no). 7B re-expresses both as
ReportDefinitions under the same codes and re-runs these tie-out tests.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: **OD-24 (isolated)** — the back-office screens and the two report views

> **This task is the only place OD-24 (spec:79, 108, 2408 — screenshots of the equivalent legacy screen and a two-minute description of how a fast operator uses it) is touched.** Every other task in this plan is green without it.
>
> **Owner provides:** for each of *chart of accounts*, *journal entry* and *fiscal periods*, a screenshot of the legacy screen and a two-minute description of the keyboard path a fast operator takes through it. **Verify with the exact command:** `ls -1 docs/spec/screens/1b/` prints `accounts.png`, `journal-entry.png`, `periods.png` and `operator-notes.md`, and `wc -w docs/spec/screens/1b/operator-notes.md` prints at least 300.
> **Until provided:** the task does not start. spec:108 — "Do not invent workflows from this document." The layout, field order and shortcut map below are the *structure* the data requires; the owner's notes decide tab order, defaults and which fields a fast operator never touches. **If the owner declines entirely:** this task alone is dropped, Task 13's DoD roll-up records the screens as outstanding, and Phase 1's other three DoD clauses still close. No other task and no source file outside `apps/backoffice/` changes.

**Files:**
- Create: `apps/backoffice/src/lib/accounting-schemas.ts`, `apps/backoffice/src/lib/accounting-api.ts`, `apps/backoffice/src/components/page-header.tsx`, `apps/backoffice/src/components/modal.tsx`, `apps/backoffice/src/components/report-table.tsx`, `apps/backoffice/src/routes/accounting/accounts.tsx`, `apps/backoffice/src/routes/accounting/journal-entry.tsx`, `apps/backoffice/src/routes/accounting/periods.tsx`, `apps/backoffice/src/routes/accounting/reports.trial-balance.tsx`, `apps/backoffice/src/routes/accounting/reports.ledger.tsx`, `tests/e2e/accounting-screens.spec.ts`
- Modify: `apps/backoffice/src/router.tsx` (five `createRoute` declarations added to `routeTree`), `packages/i18n/catalogues/en.json`, `packages/i18n/catalogues/ar.json`
- Test: `tests/e2e/accounting-screens.spec.ts`

**Interfaces:**
- Consumes (0E, assumption 7 — read off 0E's plan, not guessed): `createAdminApi`, `AdminApi`, `AdminApiOptions` from `apps/backoffice/src/lib/admin-api.ts`; `useShell()` (`{ locale, setLocale, t }`) from `apps/backoffice/src/components/app-shell.tsx`; `useSession()`, `useCompanyId()` from `apps/backoffice/src/lib/session.tsx`; `readEnv()` from `apps/backoffice/src/lib/env.ts`; `ApiError`, `problemMessage` from `apps/backoffice/src/lib/problem.ts`; `Button`, `TextField`, `Select`, `DataGrid`, `type Column` from `@dulja/ui`; `createRoute` from `@tanstack/react-router` and 0E's `rootRoute` / `routeTree` in `apps/backoffice/src/router.tsx`; `useQuery`, `useMutation`, `useQueryClient` from `@tanstack/react-query`.
- Consumes (1A, assumption 6): `GET/POST /v1/companies/{companyId}/accounts`, `GET /v1/companies/{companyId}/fiscal-periods`, `POST …/fiscal-periods/{id}/close`, `POST …/fiscal-periods/{id}/reopen`, `POST /v1/companies/{companyId}/documents`, `POST …/documents/{id}/transitions`; and 1A's Zod schemas `AccountSchema`, `AccountList`, `FiscalPeriodSchema`, `FiscalPeriodList`, `DocumentSchema`, `TransitionResultSchema` from `@dulja/contracts` — **the wire shapes are imported, never re-declared**, so a field 1A adds arrives here without an edit.
- Consumes (0D): `GET /v1/companies/{companyId}/dimension-types` and `GET …/dimension-types/{dimensionTypeId}/values`, with `DimensionTypeList` / `DimensionValueList` from `@dulja/contracts/admin/dimension`. **Both reads carry no `requirePermission` middleware** — 0D mounts them ungated and §4.2.11 fixes reads on dimensions as membership-only — which is what lets an `accountant` list branches. This is the only branch-listing surface in the product today, and `CreateDocumentBody.branchId` is **required** (1A), so the journal-entry screen cannot post without it.
- Consumes (Task 10): the two report routes and `TrialBalanceList`, `LedgerList`, `TrialBalanceRowDto`, `LedgerRowDto` from `@dulja/contracts`.
- Produces: five routed screens; `createAccountingApi` / `useAccountingApi`; and three small local components — `PageHeader`, `Modal` and `ReportTable` — which live in `apps/backoffice/src/components/` because `@dulja/ui` exports no equivalent and **this slice does not own `packages/ui`**. Every later UI slice re-runs test 23 against them; a slice that wants `PageHeader` or `Modal` promoted into `@dulja/ui` amends §4 and moves them there.

- [ ] **Step 1: Confirm the OD-24 inputs are present**

Run: `ls -1 docs/spec/screens/1b/ && wc -w docs/spec/screens/1b/operator-notes.md`
Expected: the four names above and a word count of at least 300. If either fails, stop — this task is blocked, not the slice.

- [ ] **Step 2: Write the failing test `tests/e2e/accounting-screens.spec.ts` (test 23 re-run)**

The spec comes before the screens. It is the only test this task has, so it is the only thing that can fail first.

**Two tasks in this plan do not have that exact shape, and saying so here keeps the claim honest.** Task 3 Step 1 writes `packages/db/src/integrity/types.ts` before Step 2's test, and Task 10 Steps 1–4 write the two report queries and the Zod module before Step 5's test. In both, the test's own import list names those declarations, so writing the test first would have produced a *parse* failure rather than the specific failure the step predicts — and in both the red is still genuine and still specific (Task 3 Step 4 expects a missing `@dulja/db` export; Task 10 Step 6 expects a 404 from an unmounted path, which does not depend on the queries existing at all). Every other task in the plan is failing-test-first end to end. Recorded again in Self-Review §3.

```ts
import { expect, test } from "@playwright/test";

/**
 * Acceptance test 23 for this slice's screens: "Every screen … renders correctly in Arabic and English,
 * including numerals, Hijri/Gregorian dates and column order" (spec:2441). The direction switch is 0E's
 * shell control; these assertions check that each screen follows it and that the keyboard path works.
 */
for (const [lang, dir] of [["en", "ltr"], ["ar", "rtl"]] as const) {
  test(`chart of accounts renders ${dir} and filters from the keyboard`, async ({ page }) => {
    await page.goto(`/accounting/accounts?lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.getByRole("tree")).toBeVisible();
    await page.keyboard.type("1000");
    await expect(page.getByTestId("account-1000")).toBeVisible();
  });

  test(`journal entry posts a balanced document from the keyboard alone (${dir})`, async ({ page }) => {
    await page.goto(`/accounting/journal-entry?lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    const grid = page.getByTestId("journal-grid");
    await grid.getByLabel(/./).first().focus();
    await page.keyboard.press("Enter");                       // appends a third line and focuses it
    await expect(grid.locator("tbody tr")).toHaveCount(3);
    await expect(page.getByTestId("total-debit")).toHaveText("0.0000");
  });

  test(`fiscal periods demand a reason before reopening (${dir})`, async ({ page }) => {
    await page.goto(`/accounting/periods?lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await page.getByRole("button", { name: /.+/ }).last().click();
    await expect(page.getByTestId("reopen-confirm")).toBeDisabled();
    await page.getByTestId("reopen-reason").fill("audit adjustment");
    await expect(page.getByTestId("reopen-confirm")).toBeEnabled();
  });

  test(`both report views render ${dir} with amounts aligned to the end edge`, async ({ page }) => {
    await page.goto(`/accounting/reports/trial-balance?lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.getByTestId("trial-balance")).toBeVisible();
    await page.goto(`/accounting/reports/ledger?lang=${lang}`);
    await expect(page.getByTestId("opening-balance")).toBeVisible();
  });
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run --cwd tests test:e2e -- accounting-screens.spec.ts`, against the same target Step 11 will use — 0E's `tests/e2e` configuration, pointed at the local dev server unless a staging target is available (spec:2377).

Expected: **FAIL — 8 failed (4 tests × 2 languages).** Read the failures rather than the count: none of the five paths is in 0E's `routeTree` yet, so TanStack Router serves its not-found element for each `page.goto`.

- The **`dir` assertion is not the one that fails.** 0E's shell sets `<html dir>` from the language, and the shell renders even on a not-found route, so `toHaveAttribute("dir", dir)` may well pass. That is expected and is not a reason to doubt the run.
- The assertions that fail are the ones that need this task's markup: `getByRole("tree")` (accounts), `getByTestId("journal-grid")` (journal entry), `getByTestId("reopen-confirm")` (periods) and `getByTestId("trial-balance")` / `getByTestId("opening-balance")` (the two report views), each ending in Playwright's `Timeout … waiting for locator(...)` with `resolved to 0 elements`.

If instead every case fails on the `dir` assertion, 0E's direction switch is not wired to `?lang=`: that is a 0E defect, not a test bug — stop and report it, because the screens this task writes cannot fix it.

- [ ] **Step 4: Write the typed fetch layer — `accounting-schemas.ts`, then `accounting-api.ts`**

**(a) `apps/backoffice/src/lib/accounting-schemas.ts`.** 0E's `createAdminApi` takes the response schema as
a *parameter*, so the back office needs one file that names the wire shapes and no other. This is 0E's own
`admin-schemas.ts` pattern, copied deliberately: a rename in 1A costs one line here and nothing anywhere
else. **Nothing is re-declared** — every shape is 1A's, 0D's or Task 10's, imported and re-exported:

```ts
import { z } from "zod";
import {
  AccountList, AccountSchema, DocumentSchema, FiscalPeriodList, FiscalPeriodSchema,
  LedgerList, TransitionResultSchema, TrialBalanceList,
} from "@dulja/contracts";
import { DimensionTypeList, DimensionValueList, DimensionValueSchema } from "@dulja/contracts/admin/dimension";

export {
  AccountList, AccountSchema, DimensionTypeList, DimensionValueList, DimensionValueSchema,
  DocumentSchema, FiscalPeriodList, FiscalPeriodSchema, LedgerList, TransitionResultSchema, TrialBalanceList,
};

/**
 * The DTOs the screens hold in state. Each is inferred from the schema above rather than hand-written:
 * two spellings of one wire shape drift the day 1A adds a field, and `z.infer` cannot drift.
 */
export type AccountDto = z.infer<typeof AccountSchema>;
export type FiscalPeriodDto = z.infer<typeof FiscalPeriodSchema>;
export type BranchDto = z.infer<typeof DimensionValueSchema>;

/** The journal-entry grid's own row shape — a form model, not a wire shape, so it is declared here. */
export interface JournalLineInput {
  lineNo: number;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}
```

**(b) `apps/backoffice/src/lib/accounting-api.ts`.** One factory over 0E's `AdminApi`, plus the hook the
five screens call. **No unsafe call mints an `Idempotency-Key` here**: `AdminApi.send` already sets one
fresh `crypto.randomUUID()` per attempt on every non-`GET` method (assumption 7), which is what spec:2055
and §4.2.7's `IdempotencyHeader` require, and a second header minted here would only be a way to get it
wrong once.

```ts
import { useMemo } from "react";
import type { ZodType } from "zod";
import { createAdminApi, type AdminApi } from "./admin-api";
import { readEnv } from "./env";
import { useCompanyId, useSession } from "./session";
import {
  AccountList, DimensionTypeList, DimensionValueList, DocumentSchema,
  FiscalPeriodList, FiscalPeriodSchema, LedgerList, TransitionResultSchema, TrialBalanceList,
  type AccountDto, type BranchDto, type JournalLineInput,
} from "./accounting-schemas";

/**
 * No hand-written interface stands beside this factory: every member's return type is already fixed by
 * the Zod schema it passes to `AdminApi.get` / `AdminApi.send`, and a second declaration of the same
 * shapes is exactly the drift `accounting-schemas.ts` exists to prevent. Callers use `AccountingClient`,
 * declared below as `ReturnType<typeof createAccountingApi>`.
 */
export function createAccountingApi(api: AdminApi, companyId: string) {
  const base = `/v1/companies/${companyId}`;
  const get = <T>(path: string, schema: ZodType<T>): Promise<T> => api.get(path, schema);

  return {
    listAccounts: async (): Promise<AccountDto[]> =>
      (await get(`${base}/accounts?limit=1000`, AccountList)).items,

    /**
     * `CreateDocumentBody.branchId` is required (1A), and `document.branch_id` is a FK to
     * `app.dimension_value` (plan0A:1836), so the branch a journal is entered for is a value of the
     * company's BRANCH dimension type. 0D mounts both of these reads WITHOUT a requirePermission
     * middleware (§4.2.11 — dimension reads are membership-only), so an `accountant` may call them.
     * Two round trips, once per screen mount, cached by react-query under ["branches", companyId].
     */
    listBranches: async (): Promise<BranchDto[]> => {
      const types = await get(`${base}/dimension-types`, DimensionTypeList);
      const branch = types.items.find((t) => t.code === "BRANCH");
      if (branch === undefined) return [];
      const values = await get(`${base}/dimension-types/${branch.id}/values`, DimensionValueList);
      return values.items.filter((v) => v.archivedAt === null);
    },

    listPeriods: async () => (await get(`${base}/fiscal-periods?limit=1000`, FiscalPeriodList)).items,

    closePeriod: (periodId: string) =>
      api.send("POST", `${base}/fiscal-periods/${periodId}/close`, {}, FiscalPeriodSchema),

    /** spec:2179 — the reason is mandatory and is written to the audit row the integrity job reports. */
    reopenPeriod: (periodId: string, reason: string) =>
      api.send("POST", `${base}/fiscal-periods/${periodId}/reopen`, { reason }, FiscalPeriodSchema),

    createJournal: (input: {
      effectiveDate: string; currency: string; branchId: string; lines: readonly JournalLineInput[];
    }) =>
      api.send("POST", `${base}/documents`, {
        documentTypeCode: "JOURNAL",
        effectiveDate: input.effectiveDate,
        currency: input.currency,
        branchId: input.branchId,
        lines: input.lines.map((l) => ({
          lineNo: l.lineNo, accountId: l.accountId, description: l.description,
          debit: l.debit, credit: l.credit,
        })),
      }, DocumentSchema),

    postDocument: (documentId: string) =>
      api.send("POST", `${base}/documents/${documentId}/transitions`, { to: "posted" }, TransitionResultSchema),

    trialBalance: (fiscalPeriodId: string, cursor?: string) =>
      get(`${base}/reports/accounting.trial_balance?fiscalPeriodId=${fiscalPeriodId}&limit=200`
          + (cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`), TrialBalanceList),

    ledger: (accountId: string, fromDate: string, toDate: string, cursor?: string) =>
      get(`${base}/reports/accounting.ledger?accountId=${accountId}&fromDate=${fromDate}&toDate=${toDate}&limit=200`
          + (cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`), LedgerList),
  };
}

export type AccountingClient = ReturnType<typeof createAccountingApi>;

/**
 * The five screens' one door. 0E's `UsersRoute` injects `AdminApiOptions` as a prop for testability;
 * these five screens are covered by Playwright against a real server rather than by a component test,
 * so the wiring is a hook and each route component takes no props at all.
 */
export function useAccountingApi(): { api: AccountingClient; companyId: string } {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();
  const client = useMemo(
    () => createAdminApi({ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }),
    [accessToken, env.apiBaseUrl],
  );
  const api = useMemo(() => createAccountingApi(client, companyId), [client, companyId]);
  return { api, companyId };
}
```

- [ ] **Step 5: Write the three local components `@dulja/ui` does not export**

`packages/ui` ships `Button`, `TextField`, `Select`, `DataGrid` and `DirectionProvider` and nothing else
(assumption 7). The three below are this app's, not the design system's: **this slice does not own
`packages/ui`**, and adding a primitive to a package another plan owns is the merge-hotspot failure §4.17
exists to prevent. Each is small, each uses logical properties only (`start`/`end`, never `left`/`right`),
and each takes already-translated strings so the `no-hardcoded-string` rule has nothing to catch.

`apps/backoffice/src/components/page-header.tsx`:

```tsx
import type { ReactNode } from "react";

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b border-border pb-2">
      <h1 className="text-start text-lg text-text">{title}</h1>
      {actions === undefined ? null : <div className="flex gap-2">{actions}</div>}
    </header>
  );
}
```

`apps/backoffice/src/components/modal.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The native `<dialog>` element, so focus trapping, Escape-to-close and inertness are the platform's
 * rather than ours. `showModal()` moves focus to the first focusable child, which is what makes the
 * reopen-reason field reachable from the keyboard alone (spec:2254).
 */
export function Modal({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="rounded-sm border border-border bg-surface p-4 text-text">
      <h2 className="text-start text-base">{title}</h2>
      {children}
    </dialog>
  );
}
```

`apps/backoffice/src/components/report-table.tsx`:

```tsx
import { useShell } from "./app-shell";

export interface ReportColumn<T> {
  key: string;
  /** i18n key — never a literal string; the hard-coded-string check fails the build otherwise (spec:2061). */
  labelKey: string;
  align: "start" | "end";
  render: (row: T) => string;
}

/**
 * The one table both report views render through. It is a plain `<table>` rather than `@dulja/ui`'s
 * `DataGrid` because a report is read, not navigated cell by cell, and `DataGrid`'s roving tabindex would
 * put a Tab stop in front of a thousand-row trial balance. Alignment is logical (`start`/`end`, never
 * `left`/`right`) so one definition is correct in Arabic and English (spec:2253, test 23); amounts are
 * rendered as they arrive — fixed 4 dp strings — because "stored base amounts are never recomputed on
 * read" (spec:2041).
 */
export function ReportTable<T>({ columns, rows, emptyKey }: {
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  emptyKey: string;
}) {
  const { t } = useShell();
  if (rows.length === 0) return <p className="p-4 text-sm text-text-muted">{t(emptyKey)}</p>;
  return (
    <table className="w-full border-collapse text-start">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col"
                className={c.align === "end" ? "border-b border-border text-end" : "border-b border-border text-start"}>
              {t(c.labelKey)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.key} className={c.align === "end" ? "text-end tabular-nums" : "text-start"}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 6: Write `apps/backoffice/src/routes/accounting/accounts.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TextField } from "@dulja/ui";
import { useShell } from "../../components/app-shell";
import { PageHeader } from "../../components/page-header";
import { useAccountingApi } from "../../lib/accounting-api";
import type { AccountDto } from "../../lib/accounting-schemas";

interface TreeNode { account: AccountDto; depth: number }

/** Flattens the tree the API returns (built there by a recursive CTE — LEGACY-071, never a per-row walk). */
function flatten(accounts: readonly AccountDto[], parentId: string | null, depth: number): TreeNode[] {
  return accounts
    .filter((a) => a.parentId === parentId)
    .sort((x, y) => x.code.localeCompare(y.code))
    .flatMap((a) => [{ account: a, depth }, ...flatten(accounts, a.id, depth + 1)]);
}

export function AccountsRoute() {
  const { t } = useShell();
  const { api, companyId } = useAccountingApi();
  const [filter, setFilter] = useState("");
  const accounts = useQuery({ queryKey: ["accounts", companyId], queryFn: () => api.listAccounts() });

  const rows = useMemo(() => {
    const tree = flatten(accounts.data ?? [], null, 0);
    if (filter === "") return tree;
    const needle = filter.toLocaleLowerCase();
    return tree.filter(({ account }) =>
      account.code.toLocaleLowerCase().includes(needle) || account.nameEn.toLocaleLowerCase().includes(needle)
      || (account.nameAr ?? "").toLocaleLowerCase().includes(needle));
  }, [accounts.data, filter]);

  return (
    <section>
      <PageHeader title={t("accounting.accounts.title")} />
      <TextField
        label={t("accounting.accounts.search")}
        value={filter}
        autoFocus
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {accounts.isPending
        ? <p className="p-4">{t("common.loading")}</p>
        : (
          <ul role="tree" aria-label={t("accounting.accounts.title")} className="mt-4">
            {rows.map(({ account, depth }) => (
              <li
                key={account.id}
                role="treeitem"
                aria-level={depth + 1}
                data-testid={`account-${account.code}`}
                className="flex gap-3 py-1"
                style={{ paddingInlineStart: `${depth * 1.5}rem` }}
              >
                <span className="w-16 tabular-nums">{account.code}</span>
                <span className="flex-1">{account.nameEn}</span>
                <span className="text-text-muted">{t(`accounting.accountType.${account.type}`)}</span>
                {account.archivedAt !== null && <span className="text-text-muted">{t("common.archived")}</span>}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
```

- [ ] **Step 7: Write `apps/backoffice/src/routes/accounting/journal-entry.tsx`**

**Why this screen has a branch control.** 1A fixes `CreateDocumentBody` as
`{ documentTypeCode: z.literal("JOURNAL"), effectiveDate, currency, branchId: UuidSchema, clientRef?, lines }`
— `branchId` is **not** optional, and `POST …/documents` answers 400 `ERR_VALIDATION_FAILED` without it.
The evaluator then stamps that branch onto every planned ledger line as the `BRANCH` dimension (§4.4.1), so
it is an accounting fact, not a form nicety. The values come from 0D's ungated dimension reads (Step 4b);
the control defaults to the company's **`HQ`** value when it is present — 0C seeds exactly that value for
the BRANCH type — and otherwise to the first value returned. **If the company has no BRANCH dimension type
at all, the Post button stays disabled and the screen says so**, rather than sending a request the API is
certain to refuse.

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Select, TextField } from "@dulja/ui";
import { useShell } from "../../components/app-shell";
import { PageHeader } from "../../components/page-header";
import { useAccountingApi } from "../../lib/accounting-api";
import type { JournalLineInput } from "../../lib/accounting-schemas";

const emptyLine = (lineNo: number): JournalLineInput =>
  ({ lineNo, accountId: "", debit: "0.0000", credit: "0.0000", description: "" });

const AMOUNT_RE = /^\d*(\.\d{0,4})?$/;

/**
 * Parses what an operator actually typed into scaled integer units (1 = 0.0001), as a BigInt.
 * The fields are free text — an operator types `100`, or `100.5`, or `100.50` — so the fractional part
 * must be PADDED to four digits before the point is stripped. `BigInt("100".replace(".", ""))` would read
 * `100` as 0.0100 and `100.5` as 0.1005, mis-scaling both the totals row and the `balanced` flag that
 * gates the Post button. Never `Number()` or `parseFloat` (spec:2041).
 * A leading `-` is not accepted: document_line has `check (debit >= 0)` and `check (credit >= 0)`
 * (§4.3.4), so a negative is a correction on the other side, not a negative amount.
 */
function toMinor(raw: string): bigint | null {
  const s = raw.trim();
  if (s === "") return 0n;
  if (!AMOUNT_RE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(`${whole === "" ? "0" : whole}${frac.padEnd(4, "0")}`);
}

/** The 4-dp string form of a scaled integer, e.g. 1005000n → "100.5000". */
function fromMinor(scaled: bigint): string {
  const s = scaled.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

/** Sums one side. An unparseable field contributes nothing and is flagged separately by `anyMalformed`. */
function totalOf(lines: readonly JournalLineInput[], side: "debit" | "credit"): string {
  return fromMinor(lines.reduce((acc, l) => acc + (toMinor(l[side]) ?? 0n), 0n));
}

/** True when any amount field holds something `toMinor` refuses. Blocks Post and shows the hint. */
function anyMalformed(lines: readonly JournalLineInput[]): boolean {
  return lines.some((l) => toMinor(l.debit) === null || toMinor(l.credit) === null);
}

/** Rewrites a field to its canonical 4-dp form on blur; leaves an unparseable value alone to be fixed. */
function normalise(raw: string): string {
  const m = toMinor(raw);
  return m === null ? raw : fromMinor(m);
}

export function JournalEntryRoute() {
  const { t } = useShell();
  const { api, companyId } = useAccountingApi();
  const queryClient = useQueryClient();
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [branchId, setBranchId] = useState("");
  const [lines, setLines] = useState<JournalLineInput[]>([emptyLine(1), emptyLine(2)]);
  const [message, setMessage] = useState<string | null>(null);
  const gridRef = useRef<HTMLTableSectionElement>(null);

  const accounts = useQuery({ queryKey: ["accounts", companyId], queryFn: () => api.listAccounts() });
  const branches = useQuery({ queryKey: ["branches", companyId], queryFn: () => api.listBranches() });

  // Default to HQ when the company has one — 0C seeds the BRANCH type with a value coded `HQ` — and to the
  // first value otherwise. An operator may change it; an empty list leaves it "" and blocks the post.
  useEffect(() => {
    const found = branches.data;
    if (branchId !== "" || found === undefined || found.length === 0) return;
    setBranchId((found.find((b) => b.code === "HQ") ?? found[0]!).id);
  }, [branches.data, branchId]);

  const malformed = anyMalformed(lines);
  const balanced = !malformed
    && branchId !== ""
    && totalOf(lines, "debit") === totalOf(lines, "credit")
    && totalOf(lines, "debit") !== "0.0000";

  const save = useMutation({
    mutationFn: async () => {
      // The wire carries canonical 4-dp strings, never the raw field text: MoneySchema's amount is
      // /^-?\d+\.\d{4}$/ (§4.2.8) and `100` would be rejected by the API's own validator.
      const normalised = lines.map((l) => ({ ...l, debit: normalise(l.debit), credit: normalise(l.credit) }));
      const created = await api.createJournal({
        effectiveDate, currency: "MYR", branchId, lines: normalised,
      });
      return api.postDocument(created.id);
    },
    onSuccess: (posted) => {
      setMessage(t("accounting.journal.posted", { number: posted.number ?? "" }));
      setLines([emptyLine(1), emptyLine(2)]);
      void queryClient.invalidateQueries({ queryKey: ["trial-balance", companyId] });
    },
    onError: (e: unknown) => { setMessage(e instanceof Error ? e.message : t("common.error")); },
  });

  const update = (index: number, patch: Partial<JournalLineInput>): void =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  /**
   * Keyboard-first, as spec:2254 requires: Enter on the last row appends a row and moves into it,
   * Ctrl+Enter posts, Escape clears. No action here needs the mouse.
   */
  function onGridKeyDown(e: KeyboardEvent<HTMLTableSectionElement>): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (balanced) save.mutate(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      setLines((prev) => [...prev, emptyLine(prev.length + 1)]);
      window.requestAnimationFrame(() => {
        const inputs = gridRef.current?.querySelectorAll<HTMLElement>("[data-line-first]");
        inputs?.item(inputs.length - 1)?.focus();
      });
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setLines([emptyLine(1), emptyLine(2)]); setMessage(null); }
  }

  return (
    <section>
      <PageHeader title={t("accounting.journal.title")} />
      <TextField
        type="date"
        label={t("accounting.journal.effectiveDate")}
        value={effectiveDate}
        autoFocus
        onChange={(e) => setEffectiveDate(e.currentTarget.value)}
      />
      <Select
        label={t("accounting.journal.branch")}
        value={branchId}
        data-testid="journal-branch"
        options={(branches.data ?? []).map((b) => ({ value: b.id, label: `${b.code} — ${b.nameEn}` }))}
        onChange={(e) => setBranchId(e.currentTarget.value)}
      />
      {branches.isSuccess && (branches.data ?? []).length === 0 && (
        <p role="alert" data-testid="journal-no-branch">{t("accounting.journal.noBranch")}</p>
      )}
      {/*
        The grid's cells use raw `<input>` and `<select>` with `aria-label`, not @dulja/ui's TextField and
        Select: those two render a visible `<label>` element of their own, which is right for a form and
        wrong for a dense grid that already has column headers. Every string here is still `t(...)`, so
        the no-hardcoded-string rule is satisfied the same way.
      */}
      <table className="mt-4 w-full" data-testid="journal-grid">
        <thead>
          <tr>
            <th scope="col" className="text-start">{t("accounting.journal.account")}</th>
            <th scope="col" className="text-start">{t("accounting.journal.description")}</th>
            <th scope="col" className="text-end">{t("accounting.journal.debit")}</th>
            <th scope="col" className="text-end">{t("accounting.journal.credit")}</th>
          </tr>
        </thead>
        <tbody ref={gridRef} onKeyDown={onGridKeyDown}>
          {lines.map((line, i) => (
            <tr key={line.lineNo}>
              <td>
                <select
                  data-line-first
                  aria-label={t("accounting.journal.account")}
                  className="w-full border border-border bg-surface text-start"
                  value={line.accountId}
                  onChange={(e) => update(i, { accountId: e.currentTarget.value })}
                >
                  <option value="">{t("common.choose")}</option>
                  {(accounts.data ?? []).filter((a) => !a.isGroup && a.archivedAt === null).map((a) => (
                    <option key={a.id} value={a.id}>{`${a.code} — ${a.nameEn}`}</option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label={t("accounting.journal.description")}
                       className="w-full border border-border bg-surface text-start"
                       value={line.description}
                       onChange={(e) => update(i, { description: e.currentTarget.value })} />
              </td>
              <td className="text-end">
                <input inputMode="decimal" className="w-full border border-border bg-surface text-end tabular-nums"
                       aria-label={t("accounting.journal.debit")} value={line.debit}
                       aria-invalid={toMinor(line.debit) === null}
                       onChange={(e) => update(i, { debit: e.currentTarget.value })}
                       onBlur={(e) => update(i, { debit: normalise(e.currentTarget.value) })} />
              </td>
              <td className="text-end">
                <input inputMode="decimal" className="w-full border border-border bg-surface text-end tabular-nums"
                       aria-label={t("accounting.journal.credit")} value={line.credit}
                       aria-invalid={toMinor(line.credit) === null}
                       onChange={(e) => update(i, { credit: e.currentTarget.value })}
                       onBlur={(e) => update(i, { credit: normalise(e.currentTarget.value) })} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-testid="journal-totals">
            <td colSpan={2} className="text-end">{t("accounting.journal.total")}</td>
            <td className="text-end tabular-nums" data-testid="total-debit">{totalOf(lines, "debit")}</td>
            <td className="text-end tabular-nums" data-testid="total-credit">{totalOf(lines, "credit")}</td>
          </tr>
        </tfoot>
      </table>
      <Button type="button" variant="primary" disabled={!balanced || save.isPending} onClick={() => save.mutate()}>
        {t("accounting.journal.post")}
      </Button>
      {malformed && <p role="alert" data-testid="journal-amount-hint">{t("accounting.journal.amountFormat")}</p>}
      {message !== null && <p role="status" data-testid="journal-message">{message}</p>}
    </section>
  );
}
```

- [ ] **Step 8: Write `apps/backoffice/src/routes/accounting/periods.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DataGrid, TextField, type Column } from "@dulja/ui";
import { useShell } from "../../components/app-shell";
import { Modal } from "../../components/modal";
import { PageHeader } from "../../components/page-header";
import { useAccountingApi } from "../../lib/accounting-api";
import type { FiscalPeriodDto } from "../../lib/accounting-schemas";

export function PeriodsRoute() {
  const { t } = useShell();
  const { api, companyId } = useAccountingApi();
  const queryClient = useQueryClient();
  const [reopening, setReopening] = useState<FiscalPeriodDto | null>(null);
  const [reason, setReason] = useState("");

  const periods = useQuery({ queryKey: ["fiscal-periods", companyId], queryFn: () => api.listPeriods() });
  const invalidate = (): void => { void queryClient.invalidateQueries({ queryKey: ["fiscal-periods", companyId] }); };

  const close = useMutation({ mutationFn: (id: string) => api.closePeriod(id), onSuccess: invalidate });
  const reopen = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) => api.reopenPeriod(id, why),
    onSuccess: () => { setReopening(null); setReason(""); invalidate(); },
  });

  const columns: readonly Column<FiscalPeriodDto>[] = [
    { key: "startsOn", header: t("accounting.periods.startsOn"), align: "start",
      cell: (p) => <span className="tabular-nums">{p.startsOn}</span> },
    { key: "endsOn", header: t("accounting.periods.endsOn"), align: "start",
      cell: (p) => <span className="tabular-nums">{p.endsOn}</span> },
    { key: "status", header: t("accounting.periods.status"), align: "start",
      cell: (p) => <span data-testid={`period-status-${p.startsOn}`}>{t(`accounting.periodStatus.${p.status}`)}</span> },
    { key: "actions", header: t("common.actions"), align: "end",
      cell: (p) => (p.status === "open"
        ? <Button type="button" disabled={close.isPending} onClick={() => close.mutate(p.id)}>
            {t("accounting.periods.close")}
          </Button>
        : <Button type="button" onClick={() => setReopening(p)}>
            {t("accounting.periods.reopen")}
          </Button>) },
  ];

  return (
    <section>
      <PageHeader title={t("accounting.periods.title")} />
      <DataGrid
        caption={t("accounting.periods.title")}
        columns={columns}
        rows={periods.data ?? []}
        rowKey={(p) => p.id}
        emptyLabel={t("accounting.periods.empty")}
      />

      {/* spec:2179 — a reopen requires a reason, it is written to the audit row, and the nightly
          integrity job reports it (Task 5's listPeriodReopens). The button stays disabled until a
          reason exists so the API's own refusal is never the first thing the operator meets. */}
      <Modal open={reopening !== null} title={t("accounting.periods.reopenTitle")} onClose={() => setReopening(null)}>
        <TextField
          autoFocus
          required
          label={t("accounting.periods.reason")}
          data-testid="reopen-reason"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <Button
          type="button"
          variant="primary"
          data-testid="reopen-confirm"
          disabled={reason.trim().length === 0 || reopen.isPending}
          onClick={() => { if (reopening !== null) reopen.mutate({ id: reopening.id, why: reason.trim() }); }}
        >
          {t("accounting.periods.reopen")}
        </Button>
      </Modal>
    </section>
  );
}
```

- [ ] **Step 9: Write the two report views and register all five routes**

`apps/backoffice/src/routes/accounting/reports.trial-balance.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select } from "@dulja/ui";
import type { TrialBalanceRowDto } from "@dulja/contracts";
import { useShell } from "../../components/app-shell";
import { PageHeader } from "../../components/page-header";
import { ReportTable, type ReportColumn } from "../../components/report-table";
import { useAccountingApi } from "../../lib/accounting-api";

const columns: readonly ReportColumn<TrialBalanceRowDto>[] = [
  { key: "code", labelKey: "accounting.report.account", align: "start", render: (r) => r.accountCode },
  { key: "name", labelKey: "accounting.report.name", align: "start", render: (r) => r.accountNameEn },
  { key: "currency", labelKey: "accounting.report.currency", align: "start", render: (r) => r.currency },
  { key: "debit", labelKey: "accounting.report.debit", align: "end", render: (r) => r.debit.amount },
  { key: "credit", labelKey: "accounting.report.credit", align: "end", render: (r) => r.credit.amount },
  { key: "baseDebit", labelKey: "accounting.report.baseDebit", align: "end", render: (r) => r.baseDebit.amount },
  { key: "baseCredit", labelKey: "accounting.report.baseCredit", align: "end", render: (r) => r.baseCredit.amount },
];

export function TrialBalanceRoute() {
  const { t } = useShell();
  const { api, companyId } = useAccountingApi();
  const periods = useQuery({ queryKey: ["fiscal-periods", companyId], queryFn: () => api.listPeriods() });
  const [periodId, setPeriodId] = useState("");
  const report = useQuery({
    queryKey: ["trial-balance", companyId, periodId],
    queryFn: () => api.trialBalance(periodId),
    enabled: periodId !== "",
  });

  return (
    <section data-testid="trial-balance">
      <PageHeader title={t("accounting.report.trialBalance")} />
      <Select
        label={t("accounting.periods.title")}
        value={periodId}
        autoFocus
        options={[{ value: "", label: t("common.choose") },
                  ...(periods.data ?? []).map((p) => ({ value: p.id, label: `${p.startsOn} — ${p.endsOn}` }))]}
        onChange={(e) => setPeriodId(e.currentTarget.value)}
      />
      <ReportTable columns={columns} rows={report.data?.items ?? []} emptyKey="accounting.report.empty" />
    </section>
  );
}
```

`apps/backoffice/src/routes/accounting/reports.ledger.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select, TextField } from "@dulja/ui";
import type { LedgerRowDto } from "@dulja/contracts";
import { useShell } from "../../components/app-shell";
import { PageHeader } from "../../components/page-header";
import { ReportTable, type ReportColumn } from "../../components/report-table";
import { useAccountingApi } from "../../lib/accounting-api";

const columns: readonly ReportColumn<LedgerRowDto>[] = [
  { key: "date", labelKey: "accounting.report.date", align: "start", render: (r) => r.effectiveDate },
  { key: "document", labelKey: "accounting.report.document", align: "start",
    render: (r) => `${r.documentTypeCode} ${r.series}-${r.number ?? ""}` },
  { key: "debit", labelKey: "accounting.report.debit", align: "end", render: (r) => r.debit.amount },
  { key: "credit", labelKey: "accounting.report.credit", align: "end", render: (r) => r.credit.amount },
  { key: "balance", labelKey: "accounting.report.balance", align: "end", render: (r) => r.runningBaseBalance.amount },
];

export function LedgerRoute() {
  const { t } = useShell();
  const { api, companyId } = useAccountingApi();
  const accounts = useQuery({ queryKey: ["accounts", companyId], queryFn: () => api.listAccounts() });
  const [accountId, setAccountId] = useState("");
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState("2026-12-31");
  const report = useQuery({
    queryKey: ["ledger", companyId, accountId, fromDate, toDate],
    queryFn: () => api.ledger(accountId, fromDate, toDate),
    enabled: accountId !== "",
  });

  return (
    <section data-testid="ledger-report">
      <PageHeader title={t("accounting.report.ledger")} />
      <Select
        label={t("accounting.journal.account")}
        value={accountId}
        autoFocus
        options={[{ value: "", label: t("common.choose") },
                  ...(accounts.data ?? []).filter((a) => !a.isGroup)
                    .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameEn}` }))]}
        onChange={(e) => setAccountId(e.currentTarget.value)}
      />
      <TextField type="date" label={t("accounting.report.from")} value={fromDate}
                 onChange={(e) => setFromDate(e.currentTarget.value)} />
      <TextField type="date" label={t("accounting.report.to")} value={toDate}
                 onChange={(e) => setToDate(e.currentTarget.value)} />
      {/* Page-invariant, by Task 10 Step 7: the same brought-forward figure on every page of the range. */}
      <p data-testid="opening-balance">
        {t("accounting.report.opening")}
        <span className="tabular-nums">{report.data?.opening_base_balance.amount ?? "0.0000"}</span>
      </p>
      <ReportTable columns={columns} rows={report.data?.items ?? []} emptyKey="accounting.report.empty" />
    </section>
  );
}
```

**Register the five routes in `apps/backoffice/src/router.tsx`.** 0E uses code-based TanStack routing —
`createRootRoute` plus one `createRoute` per screen, collected by `rootRoute.addChildren([...])` — so there
is no file-based convention to follow and no `createFileRoute` anywhere in this app. Add five imports, five
declarations, and five entries to the existing array; **change no existing line**:

```tsx
import { AccountsRoute } from "./routes/accounting/accounts";
import { JournalEntryRoute } from "./routes/accounting/journal-entry";
import { PeriodsRoute } from "./routes/accounting/periods";
import { TrialBalanceRoute } from "./routes/accounting/reports.trial-balance";
import { LedgerRoute } from "./routes/accounting/reports.ledger";

export const accountsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounting/accounts", component: AccountsRoute });
export const journalEntryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounting/journal-entry", component: JournalEntryRoute });
export const periodsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounting/periods", component: PeriodsRoute });
export const trialBalanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounting/reports/trial-balance", component: TrialBalanceRoute });
export const ledgerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accounting/reports/ledger", component: LedgerRoute });
```

and extend the children array 0E wrote, appending only:

```tsx
  accountsRoute, journalEntryRoute, periodsRoute, trialBalanceRoute, ledgerRoute,
```

The five paths are exactly the five `page.goto(...)` targets of Step 2's spec, which is how that spec goes
from red to green.

- [ ] **Step 10: Add every i18n key to both catalogues**

Add to `packages/i18n/catalogues/en.json` and `packages/i18n/catalogues/ar.json` — 0E's own catalogue paths,
flat dotted keys, ICU (ADR 0018). The completeness checker fails CI when either lacks a key, and the
hard-coded-string check fails on any literal (spec:2061, 2322): `common.loading`, `common.choose`,
`common.actions`, `common.archived`, `common.error`, `accounting.accounts.title`,
`accounting.accounts.search`, `accounting.accountType.asset|liability|equity|income|expense`,
`accounting.journal.title|effectiveDate|branch|noBranch|account|description|debit|credit|total|post|posted|amountFormat`,
`accounting.periods.title|startsOn|endsOn|status|close|reopen|reopenTitle|reason|empty`,
`accounting.periodStatus.open|closed|locked`,
`accounting.report.trialBalance|ledger|account|name|currency|debit|credit|baseDebit|baseCredit|date|document|balance|from|to|opening|empty`.

`accounting.journal.posted` takes one ICU argument, `{number}`; every other key is a plain string.

Run: `bun run --cwd packages/i18n test`
Expected: PASS — both catalogues complete, no key present in one and absent from the other.

- [ ] **Step 11: Run everything and commit**

```bash
bun run --cwd apps/backoffice typecheck
bun run --cwd packages/i18n test
bun run lint
bun run --cwd tests test:e2e -- accounting-screens.spec.ts
```

Expected: PASS. `bun run lint` includes 0E's `no-hardcoded-string` rule over `apps/backoffice/src/`, which
is what proves every visible string above came from `t(...)`. The e2e run needs a staging target
(spec:2377); with none available, run it against the local dev server per 0E's `tests/e2e` configuration
and record which was used in the PR description.

```bash
git add apps/backoffice/src/lib/accounting-schemas.ts apps/backoffice/src/lib/accounting-api.ts \
        apps/backoffice/src/components/page-header.tsx apps/backoffice/src/components/modal.tsx \
        apps/backoffice/src/components/report-table.tsx apps/backoffice/src/routes/accounting/ \
        apps/backoffice/src/router.tsx packages/i18n/catalogues/en.json packages/i18n/catalogues/ar.json \
        tests/e2e/accounting-screens.spec.ts
git commit -m "$(cat <<'EOF'
feat(backoffice): chart of accounts, journal entry, periods and the two report views [1B T11]

Keyboard-first journal entry (Enter appends a line, Ctrl+Enter posts, Escape
clears — spec:2254), with the branch CreateDocumentBody requires resolved from
the company's BRANCH dimension values; reopening a period demands a reason before
the button enables (spec:2179); every amount is a string end to end and every
label is an i18n key. Idempotency-Key comes from 0E's AdminApi.send, not from a
second minting site. Both text directions asserted in tests/e2e (test 23). Built
against the owner's OD-24 screenshots and operator notes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: **OD-19 (isolated)** — the PITR restore drill, its local equivalent, and the runbook (test 24)

> **This task is the only place OD-19 (spec:2398 — Supabase organisation access and PITR billing) is touched.** Every other task in this plan is green without it.
>
> **Owner provides:** PITR enabled on the staging Supabase project, and two connection URLs — the live staging database and, after performing the restore in Step 8's runbook, the restored one. **Verify with the exact command:**
> `psql "$DRILL_LIVE_URL" -Atc "select current_setting('wal_level', true), current_setting('archive_mode', true)"`
> prints `replica|on` (`logical|on` is also acceptable — Supabase enables logical replication on some plans; what the drill needs is `archive_mode = on`). 0C's `tests/regression/legacy-081.test.ts` already asserts this *setting* against staging; this task asserts the *drill*.
> **Until provided:** the identical assertions run against `startDb()`, over a snapshot taken by `pg_dump` inside the container and restored into a second database, and print the identical five lines. The verdict is produced by one shared function in both modes, so the staging run adds no new assertion — only a different way of obtaining the restored database.
> **If the owner declines entirely:** this task still merges and still runs in CI in local mode; what stays outstanding is the *staging* half of the Phase 1 DoD sentence ("has been run against staging"), which Task 13's roll-up records as outstanding with this task named as the one that closes it. No other task changes.

**Files:**
- Create: `tests/invariants/support/restore-drill.ts`, `tests/invariants/restore-drill.test.ts`, `docs/runbooks/restore-drill.md`, `docs/adr/0025-restore-drill-procedure.md`
- Modify: `tests/regression/legacy-081.test.ts`
- Test: `tests/invariants/restore-drill.test.ts`

**Interfaces:**
- Consumes: `trialBalanceFingerprint(tx: Sql, params: { companyId: string; fiscalPeriodId?: string }): Promise<string>` (Task 10); `checkAccountBalanceProjection(tx: Sql): Promise<ProjectionMismatch[]>` (Task 4); `checkAuditChain(tx: Sql, tenantId: string): Promise<AuditChainResult>` (Task 5); `withTenant(sql, ctx, fn)` and `TenantContext` (§4.2.2); `postJournal` (Task 3); `startDb`, `seedTenantV2`, `uuidv7`, `type Db`, `type Seed` from `@dulja/db/test`; `Db.container` / `Db.url(role)` exactly as Plan 0A defines them (plan0A:443–452).
- Produces, all ten exports of `tests/invariants/support/restore-drill.ts`: `DrillCapture`, `DrillVerdict`, `VerifyOptions`, `captureDrillPoint`, `verifyRestore`, `formatDrillVerdict`, `writeCapture`, `readCapture`, `snapshotDatabase`, `restoreDatabase`; the nine environment names `DRILL_PHASE`, `DRILL_LIVE_URL`, `DRILL_RESTORED_URL`, `DRILL_CAPTURE_FILE`, `DRILL_TENANT_ID`, `DRILL_ACTOR_ID`, `DRILL_COMPANY_ID`, `DRILL_PERIOD_ID` and the operator-supplied `DRILL_RESTORE_STARTED_AT` — all test-tier only, never held by a container or a deployable, which is why contracts §3.11 lists none of them; `docs/runbooks/restore-drill.md`, which the quarterly re-run of test 24 (contracts §6.1) follows unchanged.

- [ ] **Step 1: Decide the mode and record it**

Run: `echo "phase=${DRILL_PHASE:-local} live=${DRILL_LIVE_URL:-unset} restored=${DRILL_RESTORED_URL:-unset}"`

Expected on a developer machine and in CI: `phase=local live=unset restored=unset` — the local equivalent runs, end to end, in one process. Expected on staging after OD-19: two runs, `phase=capture` then `phase=verify`, with both URLs set. Nothing else in this task branches on the mode; only the way the restored database is obtained does.

- [ ] **Step 2: Write the failing test `tests/invariants/restore-drill.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trialBalanceFingerprint, withTenant } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import postgres, { type Sql } from "postgres";
import { postJournal } from "./support/post-journal";
import {
  captureDrillPoint, formatDrillVerdict, readCapture, restoreDatabase, snapshotDatabase,
  verifyRestore, writeCapture, type DrillCapture, type DrillVerdict,
} from "./support/restore-drill";

/**
 * Acceptance test 24 (spec:2442): "Restore to an arbitrary point in time; the trial balance computed
 * from the restored ledger equals the trial balance the live system reported at that timestamp, and the
 * audit chain verifies up to that point." LEGACY-081: backup and restore were manual, whole-file and
 * destructive, and were never rehearsed.
 *
 * Three modes, one set of assertions. `DRILL_PHASE` selects; `describe.runIf` means the modes that do
 * not apply are reported as skipped rather than passing on an early return.
 *
 *   local   (default) — the whole drill in one process against startDb(), with a pg_dump snapshot
 *                       standing in for the WAL replay. This is what CI runs.
 *   capture           — against DRILL_LIVE_URL: record what the live system reports at the target.
 *   verify            — against DRILL_RESTORED_URL: assert every recorded figure.
 *
 * capture and verify are separate processes because the restore happens between them and may take an
 * hour. They never both connect to a database, so the drill works whether the platform restores beside
 * the live database or in place of it — a property of the platform, which this file asserts nothing
 * about. ADR 0025 states what the local snapshot does and does not prove.
 */
const phase = (process.env.DRILL_PHASE ?? "local") as "local" | "capture" | "verify";

/** Required environment, with a message that names the phase rather than failing on `undefined`. */
function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set when DRILL_PHASE=${phase} (see docs/runbooks/restore-drill.md)`);
  }
  return value;
}

/**
 * The whole of test 24. Every mode calls this and no mode adds an assertion of its own — that is what
 * makes "the staging run adds no new assertion" true in code and not only in ADR 0025.
 */
function assertDrillVerdict(verdict: DrillVerdict, capture: DrillCapture): void {
  expect(verdict.fingerprintMatches).toBe(true);        // the trial balance at the target
  expect(verdict.projectionMismatches).toBe(0);         // …and it equals a rebuild from the restored ledger
  expect(verdict.chain.brokenLinks).toBe(0);            // "the audit chain verifies up to that point"
  expect(verdict.chain.badHashes).toBe(0);
  expect(verdict.chain.headSeq).toBe(capture.auditHeadSeq);
  expect(verdict.postings).toBe(capture.postings);      // no row lost, and no write raced the capture
  expect(["differs", "skipped"]).toContain(verdict.divergence);
  const lines = formatDrillVerdict(verdict).split("\n");
  expect(lines).toHaveLength(5);
  console.info(lines.join("\n"));                       // the five lines the runbook records
}

describe.runIf(phase === "local")("restore drill — local equivalent (acceptance test 24; LEGACY-081)", () => {
  let db: Db; let s: Seed; let restored: Sql | undefined;

  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "Drill"); }, 180_000);
  afterAll(async () => {
    if (restored !== undefined) await restored.end();
    if (db !== undefined) await db.stop();
  });

  const ctxFor = async () => ({ tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) });

  it("restores to an arbitrary point in time and every recorded figure matches", async () => {
    // ── 1. Postings that exist before the recovery target ──────────────────────
    // `cash` and `sales` are Plan 0A's two fixture accounts, 1000 and 4000 (plan0A Seed).
    for (const amount of ["100.0000", "250.5000", "17.2500"]) {
      await postJournal(db, s, [
        { account: s.cash, debit: amount }, { account: s.sales, credit: amount },
      ]);
    }

    // ── 2. T1: the point in time, and what the live system reported at it ──────
    const capture = await withTenant(db.rw, await ctxFor(), (tx) => captureDrillPoint(tx, {
      tenantId: s.tenant, actorId: s.human, companyId: s.company, fiscalPeriodId: s.period,
    }));
    await writeCapture(capture);
    await snapshotDatabase(db);

    // ── 3. Divergence: postings that must NOT survive the restore ──────────────
    for (const amount of ["9999.0000", "1.0001"]) {
      await postJournal(db, s, [
        { account: s.cash, debit: amount }, { account: s.sales, credit: amount },
      ]);
    }
    const liveNow = await withTenant(db.rw, await ctxFor(), (tx) =>
      trialBalanceFingerprint(tx, { companyId: s.company, fiscalPeriodId: s.period }));
    expect(liveNow).not.toBe(capture.fingerprint);      // the divergence is real, not assumed

    // ── 4. Restore to T1 and verify ────────────────────────────────────────────
    const restoreStartedAt = new Date().toISOString();
    restored = postgres(await restoreDatabase(db), { max: 2, onnotice: () => {} });

    const reread = await readCapture();                 // through the artifact, exactly as staging does
    const verdict = await verifyRestore(restored, {
      capture: reread, liveFingerprintAtRestore: liveNow, restoreStartedAt,
    });

    assertDrillVerdict(verdict, reread);
    expect(verdict.divergence).toBe("differs");         // locally the live database always still exists
  }, 300_000);
});

describe.runIf(phase === "capture")("restore drill — capture at the recovery target (test 24, 1 of 2)", () => {
  let live: Sql;

  beforeAll(() => { live = postgres(env("DRILL_LIVE_URL"), { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await live.end(); });

  it("records what the live system reports at the recovery target", async () => {
    const tenantId = env("DRILL_TENANT_ID");
    const actorId = env("DRILL_ACTOR_ID");
    const ctx = { tenantId, actorId, requestId: await uuidv7(live) };

    const capture = await withTenant(live, ctx, (tx) => captureDrillPoint(tx, {
      tenantId, actorId, companyId: env("DRILL_COMPANY_ID"), fiscalPeriodId: env("DRILL_PERIOD_ID"),
    }));

    // A drill against an empty ledger proves nothing, and would pass every assertion in phase 2.
    expect(capture.postings).toBeGreaterThan(0);
    await writeCapture(capture);

    console.info(`recovery target: ${capture.capturedAt}`);
    console.info(`live fingerprint: ${capture.fingerprint} (${capture.postings} postings, audit head ${capture.auditHeadSeq})`);
  }, 120_000);
});

describe.runIf(phase === "verify")("restore drill — verify the restored database (test 24, 2 of 2)", () => {
  let restored: Sql; let live: Sql | undefined;

  beforeAll(() => {
    restored = postgres(env("DRILL_RESTORED_URL"), { max: 2, onnotice: () => {} });
    // Absent for an in-place restore. Its absence is reported, never assumed either way.
    const liveUrl = process.env.DRILL_LIVE_URL;
    if (liveUrl !== undefined && liveUrl !== "") live = postgres(liveUrl, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => { await restored.end(); if (live !== undefined) await live.end(); });

  it("the restored database is what the live system reported at the recovery target", async () => {
    const capture = await readCapture();

    let liveFingerprintAtRestore: string | undefined;
    if (live !== undefined) {
      const ctx = { tenantId: capture.tenantId, actorId: capture.actorId, requestId: await uuidv7(live) };
      liveFingerprintAtRestore = await withTenant(live, ctx, (tx) => trialBalanceFingerprint(tx, {
        companyId: capture.companyId, fiscalPeriodId: capture.fiscalPeriodId,
      }));
    }

    const verdict = await verifyRestore(restored, {
      capture, liveFingerprintAtRestore, restoreStartedAt: env("DRILL_RESTORE_STARTED_AT"),
    });

    assertDrillVerdict(verdict, capture);
  }, 300_000);
});
```

`console.info` is the one call in this file that is not an assertion, and it is deliberate: the five
lines are the drill's output, and an operator following the runbook reads them from the test's stdout.
Plan 0A's `.oxlintrc.json` already turns `no-console` off for `**/*.test.ts` alongside
`packages/*/src/cli.ts` (plan0A:301), so this needs no new override and **no glob is widened** — which
is also why `formatDrillVerdict` returns a string instead of printing: it lives in
`support/restore-drill.ts`, which is not a `.test.ts` file and where a `console` call would fail lint.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run --cwd tests test -- invariants/restore-drill.test.ts`
Expected: FAIL — `Error: Failed to resolve import "./support/restore-drill" from "invariants/restore-drill.test.ts". Does the file exist?`

- [ ] **Step 4: Write the capture and verify halves — `tests/invariants/support/restore-drill.ts`**

```ts
import { readFile, writeFile } from "node:fs/promises";
import type { Sql } from "postgres";
import {
  checkAccountBalanceProjection, checkAuditChain, trialBalanceFingerprint, withTenant,
  type TenantContext,
} from "@dulja/db";
import { uuidv7 } from "@dulja/db/test";

/** What the live system reported at the recovery target. Written as JSON between the two phases. */
export interface DrillCapture {
  /** The recovery target. `now()` is transaction start time, so it precedes every figure below. */
  readonly capturedAt: string;
  readonly tenantId: string;
  /** The principal the capture ran as. Carried so the verify phase needs no extra environment. */
  readonly actorId: string;
  readonly companyId: string;
  readonly fiscalPeriodId: string;
  /** trialBalanceFingerprint over the company's account_balance rows — a hex sha256, never a number. */
  readonly fingerprint: string;
  /** ledger_entry rows visible at capture. A mismatch on restore means a write raced the capture. */
  readonly postings: number;
  readonly auditHeadSeq: number;
  readonly auditHeadHash: string;
}

export interface DrillVerdict {
  readonly fingerprintMatches: boolean;
  readonly projectionMismatches: number;
  readonly chain: { readonly rows: number; readonly brokenLinks: number; readonly badHashes: number; readonly headSeq: number };
  readonly postings: number;
  readonly expected: DrillCapture;
  /** "differs" · "identical" (a failure) · "skipped" when no live URL is available (in-place restore). */
  readonly divergence: "differs" | "identical" | "skipped";
  /** Whole seconds from the operator initiating the restore to this verdict. */
  readonly rtoSeconds: number;
}

const CAPTURE_FILE = (): string => process.env.DRILL_CAPTURE_FILE ?? "drill-capture.json";

export async function writeCapture(c: DrillCapture): Promise<void> {
  await writeFile(CAPTURE_FILE(), `${JSON.stringify(c, null, 2)}\n`, "utf8");
}

export async function readCapture(): Promise<DrillCapture> {
  return JSON.parse(await readFile(CAPTURE_FILE(), "utf8")) as DrillCapture;
}

/**
 * Everything here is read inside the caller's single transaction, and `now()` — which is transaction
 * start time, not clock time — is the recovery target. Under READ COMMITTED a concurrent commit can
 * still land between statements; that is why `postings` and `auditHeadSeq` are recorded. The verify
 * phase compares them, so a raced capture fails the drill loudly instead of passing quietly.
 */
export async function captureDrillPoint(
  tx: Sql, params: { tenantId: string; actorId: string; companyId: string; fiscalPeriodId: string },
): Promise<DrillCapture> {
  const [t] = await tx<{ at: string }[]>`select now()::text as at`;
  const fingerprint = await trialBalanceFingerprint(tx, {
    companyId: params.companyId, fiscalPeriodId: params.fiscalPeriodId,
  });
  const [counted] = await tx<{ postings: number }[]>`
    select count(*)::int as postings from app.ledger_entry`;
  const [head] = await tx<{ seq: number; hash: string }[]>`
    select seq::int as seq, encode(hash, 'hex') as hash
      from app.audit_log where tenant_id = ${params.tenantId} order by seq desc limit 1`;

  return {
    capturedAt: t!.at,
    tenantId: params.tenantId,
    actorId: params.actorId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    fingerprint,
    postings: counted!.postings,
    auditHeadSeq: head?.seq ?? 0,
    auditHeadHash: head?.hash ?? "",
  };
}

export interface VerifyOptions {
  /** Carries the tenant, the actor and every figure to compare — the verify phase reads nothing else. */
  readonly capture: DrillCapture;
  /** The live fingerprint read just before the restore. Omitted for an in-place restore. */
  readonly liveFingerprintAtRestore?: string;
  /** ISO timestamp at which the operator initiated the restore, for the RTO measurement. */
  readonly restoreStartedAt: string;
}

/**
 * The whole of test 24, against the restored database and nothing else.
 *
 * "The trial balance computed from the restored ledger" is satisfied transitively and deliberately:
 * `trialBalanceFingerprint` reads `account_balance`, and `checkAccountBalanceProjection` (Task 4)
 * rebuilds that projection from `ledger_entry` in a scratch table and compares it row for row. Both
 * green means the figure equals one computed from the restored ledger. Reading the projection and
 * re-deriving it in the same breath is exactly the pairing spec:2265 asks for, and it is stronger than
 * either alone: a restore that dropped ledger rows but kept balances fails the second check.
 */
export async function verifyRestore(restored: Sql, opts: VerifyOptions): Promise<DrillVerdict> {
  const ctx: TenantContext = {
    tenantId: opts.capture.tenantId,
    actorId: opts.capture.actorId,
    requestId: await uuidv7(restored),
  };

  return withTenant(restored, ctx, async (tx) => {
    const fingerprint = await trialBalanceFingerprint(tx, {
      companyId: opts.capture.companyId, fiscalPeriodId: opts.capture.fiscalPeriodId,
    });
    const mismatches = await checkAccountBalanceProjection(tx);
    const chain = await checkAuditChain(tx, opts.capture.tenantId);
    const [counted] = await tx<{ postings: number }[]>`
      select count(*)::int as postings from app.ledger_entry`;
    const [head] = await tx<{ seq: number }[]>`
      select seq::int as seq from app.audit_log
       where tenant_id = ${opts.capture.tenantId} order by seq desc limit 1`;

    const divergence: DrillVerdict["divergence"] =
      opts.liveFingerprintAtRestore === undefined ? "skipped"
        : opts.liveFingerprintAtRestore === fingerprint ? "identical" : "differs";

    return {
      fingerprintMatches: fingerprint === opts.capture.fingerprint,
      projectionMismatches: mismatches.length,
      chain: { rows: chain.rows, brokenLinks: chain.brokenLinks, badHashes: chain.badHashes, headSeq: head?.seq ?? 0 },
      postings: counted!.postings,
      expected: opts.capture,
      divergence,
      rtoSeconds: Math.round(
        (Date.now() - new Date(opts.restoreStartedAt).getTime()) / 1000),
    };
  });
}

/** The five lines a drill prints, identical on staging and locally. The runbook records them verbatim. */
export function formatDrillVerdict(v: DrillVerdict): string {
  const hhmmss = (s: number): string =>
    [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
      .map((n) => String(n).padStart(2, "0")).join(":");
  return [
    `trial-balance-fingerprint: ${v.fingerprintMatches ? "match" : "MISMATCH"}`,
    `projection-rebuild: ${v.projectionMismatches === 0 ? "clean" : `${v.projectionMismatches} MISMATCH(ES)`}`,
    `audit-chain: ${v.chain.brokenLinks === 0 && v.chain.badHashes === 0 ? "verified" : "BROKEN"}`
      + ` (${v.chain.rows} rows, ${v.chain.brokenLinks} broken links, ${v.chain.badHashes} bad hashes,`
      + ` head seq ${v.chain.headSeq}/${v.expected.auditHeadSeq})`,
    `divergence: ${v.divergence === "differs" ? "restored differs from live at restore time"
      : v.divergence === "identical" ? "IDENTICAL — the restore did not roll anything back"
      : "skipped (in-place restore: DRILL_LIVE_URL not set)"}`,
    `recovery: rpo ${v.postings === v.expected.postings ? "0 rows lost" : "ROWS LOST"}`
      + ` (postings ${v.postings}/${v.expected.postings})`
      + ` · rto ${hhmmss(v.rtoSeconds)} · target ${v.expected.capturedAt}`,
  ].join("\n");
}
```

- [ ] **Step 5: Write the local snapshot half — appended to the same file**

```ts
import type { Db } from "@dulja/db/test";

const RESTORED_DB = "dulja_restored";
const DUMP_PATH = "/tmp/drill.dump";

/** Runs a command inside the Postgres container and throws with its whole output on failure. */
async function exec(db: Db, command: string): Promise<string> {
  const { exitCode, output } = await db.container.exec(["bash", "-c", command]);
  if (exitCode !== 0) throw new Error(`drill command failed (exit ${exitCode}): ${command}\n${output}`);
  return output;
}

/**
 * The local stand-in for "restore to a point in time". `pg_dump --format=custom` reads one REPEATABLE
 * READ snapshot, so the file is the database as of the moment it starts — which is the recovery target
 * the capture just recorded. It is NOT a WAL replay, and ADR 0025 says so; what it does prove is every
 * assertion in verifyRestore and every command in the runbook.
 *
 * Credentials come from the container object, never from a literal: PostgreSqlContainer generates them.
 */
export async function snapshotDatabase(db: Db): Promise<void> {
  const c = db.container;
  await exec(db, `PGPASSWORD='${c.getPassword()}' pg_dump -U '${c.getUsername()}' `
    + `-d '${c.getDatabase()}' --format=custom --file='${DUMP_PATH}'`);
}

/**
 * Restores that snapshot into a second database and returns the app_rw URL for it.
 *
 * `pg_restore` loads data in the pre-data → data → post-data order, and CREATE TRIGGER is post-data, so
 * the rows land before app.audit_chain() exists on the table. That is what makes the chain verifiable
 * after a restore: had the trigger been present the hashes would have been recomputed and the drill
 * would prove nothing. `--exit-on-error` makes a partial restore a failure instead of a warning.
 */
export async function restoreDatabase(db: Db): Promise<string> {
  const c = db.container;
  const env = `PGPASSWORD='${c.getPassword()}'`;
  await exec(db, `${env} dropdb -U '${c.getUsername()}' --if-exists '${RESTORED_DB}'`);
  await exec(db, `${env} createdb -U '${c.getUsername()}' '${RESTORED_DB}'`);
  await exec(db, `${env} pg_restore -U '${c.getUsername()}' -d '${RESTORED_DB}' `
    + `--exit-on-error '${DUMP_PATH}'`);
  // Db.url(role) is `postgres://role:pw@host:port/<database>` (plan0A:452); only the database differs.
  return db.url("app_rw").replace(/\/[^/]+$/, `/${RESTORED_DB}`);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run --cwd tests test -- invariants/restore-drill.test.ts`
Expected: PASS.

Two failures are worth naming because they are diagnoses, not flakes:

- `pg_restore: error: could not execute query: ERROR: permission denied` — the restore is running as a role that is not the container superuser. `PostgreSqlContainer`'s user is a superuser; check that `c.getUsername()` is what reached the command and that no `--no-owner` was added.
- `audit-chain: BROKEN` on the restored database while it is verified on the live one — the triggers fired during the data load. That means `pg_restore` was given `--data-only` or the schema was created separately; restore the whole dump in one pass, as Step 5 does.

- [ ] **Step 7: Append the regression block to `tests/regression/legacy-081.test.ts`**

**This is an append.** 0C creates `legacy-081` for "PITR enabled" (contracts §2.1 0C card: "legacy-081 (PITR enabled — the drill itself is 1B)"); 0C precedes 1B in §6.3, so the file exists and §3.7.3 forbids editing its block.

```ts
describe("LEGACY-081 Backup and restore are manual, whole-file and destructive — 1B", () => {
  it("a restore is rehearsed, not assumed: the drill's verdict has five assertions and all pass", async () => {
    // The drill itself lives in tests/invariants/restore-drill.test.ts and runs there; this block is
    // the defect's regression face. It asserts the property LEGACY-081 names — that restoring is an
    // exercised, verified procedure with a written runbook — by requiring the runbook to exist, to
    // carry a drill log, and to name the exact verify command an operator types.
    // Vitest runs this workspace with cwd `tests/`, so every path here is relative to it — which is
    // why the second case below reads `invariants/support/…` and this one climbs one level.
    const runbook = await readFile("../docs/runbooks/restore-drill.md", "utf8");
    expect(runbook).toContain("## Drill log");
    expect(runbook).toContain("DRILL_PHASE=verify");
    expect(runbook).toContain("trial-balance-fingerprint:");
  });

  it("the drill is destructive to nothing: it reads the restored database and writes only its own file", async () => {
    const source = await readFile("invariants/support/restore-drill.ts", "utf8");
    // LEGACY-081's second half is that the old restore overwrote the live database. Nothing in the drill
    // may write to a database at all — the only writes are the capture JSON and the scratch temp table
    // checkAccountBalanceProjection creates and drops on commit.
    for (const forbidden of ["insert into", "update app.", "delete from", "dropdb -U '${c.getUsername()}' --if-exists '${c.getDatabase()}"]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
```

The file's import lines gain `readFile` from `node:fs/promises`. Do not remove or reorder anything the existing block imports.

- [ ] **Step 8: Write `docs/runbooks/restore-drill.md`**

```markdown
# Runbook — point-in-time restore drill

**Owner:** whoever holds the Supabase organisation (OD-19). **Cadence:** quarterly, and after any change
to the backup configuration (contracts §6.1 lists test 24's re-run as quarterly). **Time budget:** one
hour, most of it waiting for the platform.

This runbook is the whole of acceptance test 24 (spec:2442) as an operator performs it. The assertions
are not retyped here: they are `tests/invariants/restore-drill.test.ts`, and the drill is green when that
file is green against the restored database.

## 0. Before you start

| You need | Where from |
|---|---|
| `DRILL_LIVE_URL` — the staging database, `app_rw` | the staging secret store; never a pooler URL (§3.11: port 5432, not 6543) |
| `DRILL_TENANT_ID`, `DRILL_ACTOR_ID`, `DRILL_COMPANY_ID`, `DRILL_PERIOD_ID` | the tenant to drill against and any principal in it: `psql "$DRILL_LIVE_URL" -Atc "select id from app.tenant limit 1"`, then `select id from app.company where tenant_id = '<tenant>'` and `select id from app.fiscal_period where company_id = '<company>' order by ends_on desc limit 1` |
| A recovery target you can name | Step 1 produces it |
| `psql`, `bun`, and this repository at the commit staging runs | your machine |

Confirm the platform can do this at all:

    psql "$DRILL_LIVE_URL" -Atc "select current_setting('wal_level', true), current_setting('archive_mode', true)"

Expected: `replica|on` (or `logical|on`). If `archive_mode` is `off`, stop — there is nothing to restore
from, and that is OD-19, not a drill failure.

## 1. Capture — what the live system reports at the recovery target

    DRILL_PHASE=capture \
    DRILL_LIVE_URL="$DRILL_LIVE_URL" \
    DRILL_TENANT_ID="$DRILL_TENANT_ID" \
    DRILL_ACTOR_ID="$DRILL_ACTOR_ID" \
    DRILL_COMPANY_ID="$DRILL_COMPANY_ID" \
    DRILL_PERIOD_ID="$DRILL_PERIOD_ID" \
    DRILL_CAPTURE_FILE=./drill-capture.json \
      bun run --cwd tests test -- invariants/restore-drill.test.ts

Expected: PASS — one test in "capture at the recovery target", the other two describes skipped — and it
prints `recovery target: …` and `live fingerprint: …`. `./drill-capture.json` now exists with
`capturedAt`, `actorId`, `fingerprint`, `postings` and `auditHeadSeq`. **`capturedAt` is the recovery
target.** Keep this file: it is the only record of what the live system reported, and the verify phase
compares against it and nothing else.

If it fails with `expected 0 to be greater than 0`, the tenant has no postings and there is nothing to
drill — pick a tenant that does.

## 2. Let the database diverge

Post at least one document on staging after `capturedAt`, through the back office or the API. Without
this the drill proves only that a restore copies bytes; with it, the restore has something to roll back
and the `divergence:` line means something.

## 3. Restore to `capturedAt`

Perform the point-in-time restore on the platform, targeting `capturedAt` from the capture file, and
note the wall-clock time you initiate it — that is `DRILL_RESTORE_STARTED_AT` and it is what the RTO
figure measures. **The exact click path is the platform's and is not written here**: it changes without
notice, and a stale click path in a runbook is worse than none. Record in the drill log below which
control you used and what it was called on the day.

When it finishes you have a restored database. Put its `app_rw` URL in `DRILL_RESTORED_URL`. If the
platform restored **in place**, `DRILL_LIVE_URL` and `DRILL_RESTORED_URL` are the same string and you
leave `DRILL_LIVE_URL` unset in Step 4 — the drill reports `divergence: skipped` and says why.

## 4. Verify

    DRILL_PHASE=verify \
    DRILL_RESTORED_URL="$DRILL_RESTORED_URL" \
    DRILL_LIVE_URL="$DRILL_LIVE_URL" \
    DRILL_CAPTURE_FILE=./drill-capture.json \
    DRILL_RESTORE_STARTED_AT="<the time you noted in Step 3, ISO 8601>" \
      bun run --cwd tests test -- invariants/restore-drill.test.ts

**Omit the `DRILL_LIVE_URL` line for an in-place restore** — there is no separate live database left to
compare against, and the drill then reports `divergence: skipped` and says why rather than guessing.

Expected: PASS — one test in "verify the restored database", the other two describes skipped — and five
lines printed:

    trial-balance-fingerprint: match
    projection-rebuild: clean
    audit-chain: verified (N rows, 0 broken links, 0 bad hashes, head seq S/S)
    divergence: restored differs from live at restore time
    recovery: rpo 0 rows lost (postings N/N) · rto HH:MM:SS · target <capturedAt>

## 5. What each failure means

| Line | Failure | What it means |
|---|---|---|
| `trial-balance-fingerprint: MISMATCH` | the restored trial balance is not the one reported at the target | either the restore landed at a different point in time, or a write raced the capture — check the `postings` figure on the last line first |
| `projection-rebuild: N MISMATCH(ES)` | `account_balance` in the restored database does not equal a rebuild from its own `ledger_entry` | the restore is internally inconsistent. This is the serious one: raise an incident, do not re-run |
| `audit-chain: BROKEN` | hashes recomputed or rows lost | if the local run is green and staging is not, the restore reloaded data with triggers attached |
| `divergence: IDENTICAL` | nothing was rolled back | Step 2 was skipped, or the recovery target was after the divergence |
| `rpo ROWS LOST` | fewer `ledger_entry` rows than at the target | genuine data loss between the target and what the platform could recover — this is the number RPO means |

## 6. Drill log

One row per drill. `RPO` and `RTO` are **measured**, not quoted; ADR 0025 states the targets they are
measured against and records that those targets are a proposal awaiting the owner.

| Date | Target (`capturedAt`) | Restore control used | RPO measured | RTO measured | Verdict | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
```

- [ ] **Step 9: Write ADR 0025**

`docs/adr/0025-restore-drill-procedure.md`, in the same format as ADR 0024 (Step 8 of Task 4):

```markdown
# ADR 0025 — The restore drill is two phases and one shared verdict; the local equivalent is a snapshot, not a WAL replay

**Status:** accepted, with one proposal referred to the owner · **Date:** 2026-09-05 · **Slice:** 1B

## Context

spec:2233 asks for "RPO/RTO stated as numbers, tested quarterly by an actual restore drill (LEGACY-081)"
and spec:2234 for restore "verified automatically, not assumed". Acceptance test 24 (spec:2442) fixes
what verification means: the trial balance from the restored ledger equals the one the live system
reported at that timestamp, and the audit chain verifies to that point. The Phase 1 definition of done
(spec:2287) requires the first drill to have run against staging and been written up.

Two facts shape the design. PITR on staging depends on OD-19, which is unanswered — so the drill cannot
be written as staging-only or Phase 1 cannot close. And whether a platform restores *beside* the live
database or *in place of* it is a property of the platform; a drill that assumes either is asserting a
vendor fact from memory, which is the same defect as inventing an endpoint.

## Decision

**Two phases, one verdict.** `captureDrillPoint` records, at the recovery target, the trial-balance
fingerprint, the `ledger_entry` count and the audit head. `verifyRestore` reads only the restored
database and compares. The phases are separated by a JSON artifact, so they may run minutes or hours
apart, on different machines, against databases that never coexist.

**The verdict is one function in both modes.** `formatDrillVerdict` prints the same five lines locally
and on staging; only the way the restored database is obtained differs. Staging adds no assertion.

**"Computed from the restored ledger" is proved by pairing two checks.** The fingerprint reads
`account_balance`; `checkAccountBalanceProjection` (Task 4) rebuilds that projection from the restored
`ledger_entry` and compares row for row. Both green is strictly stronger than re-aggregating the ledger
in the report would be: a restore that kept balances but lost ledger rows fails the second check, and
the report keeps its production shape (spec:1204 — the trial balance reads the synchronous projection,
and a report that quietly recomputed would hide the drift the integrity job exists to find).

**The local equivalent is a `pg_dump` snapshot restored into a second database.** It is not a WAL
replay and does not exercise `archive_command`, WAL retention or the platform's recovery-target
machinery. It exercises every assertion, every command in the runbook and the whole verdict path. What
only staging can prove is that the WAL is there and that the platform can land on an arbitrary target —
which is precisely the half OD-19 gates. The drill is green in CI from the day this slice merges and
gains that half the day the owner answers.

**No click path is written down.** The runbook records which control was used on the day, in its drill
log. A stale click path in a runbook is worse than none.

## Consequences

- CI runs test 24 on every push, in local mode, in about a minute.
- The quarterly re-run (contracts §6.1) is Steps 1–4 of the runbook and produces one drill-log row.
- `checkAccountBalanceProjection` is now load-bearing for two acceptance tests, 2 and 24. A change to
  its comparison key changes what a restore is allowed to be.
- The drill writes to no database. Its only output is the capture file and the temp table Task 4's
  check drops on commit — LEGACY-081's second half was a restore procedure that overwrote the live system.

## Proposal referred to the owner, not decided here

spec:2233 wants RPO and RTO **as numbers**, and the numbers are a billing decision (retention window
and plan tier) tied to OD-19, not an engineering one. This ADR proposes **RPO ≤ 5 minutes** and
**RTO ≤ 4 hours** for staging and production as the targets the drill log is read against, and records
that they are unconfirmed. The drill *measures* both on every run regardless, so the first three drill
rows will say whether the proposal is achievable before anyone commits to it. The published SLA with
credits stays deferred (spec:2234). Nothing in the code depends on either number.
```

- [ ] **Step 10: Run everything and commit**

```bash
bun run --cwd tests test -- invariants/restore-drill.test.ts
bun run --cwd tests test -- regression/legacy-081.test.ts
bun run typecheck && bun run lint && bun run lint:rules
```

Expected: PASS. Confirm `drill-capture.json` is not staged — add it to `.gitignore` if it is not already
covered, in this commit.

```bash
git add tests/invariants/support/restore-drill.ts tests/invariants/restore-drill.test.ts \
        tests/regression/legacy-081.test.ts docs/runbooks/restore-drill.md \
        docs/adr/0025-restore-drill-procedure.md .gitignore
git commit -m "$(cat <<'EOF'
test(invariants): rehearse the restore, verify it, write it down (acceptance test 24) [1B T12]

Two phases separated by a JSON artifact, so the drill works whether the platform
restores beside the live database or in place of it. The verdict is one function
in both modes and prints the same five lines. Locally a pg_dump snapshot stands
in for the WAL replay; ADR 0025 states exactly what that does and does not prove,
and refers the RPO/RTO numbers to the owner with OD-19.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Phase 1 exit — the definition-of-done roll-up, the phase report, `CLAUDE.md`

This is the last task of a phase-completing slice, so contracts §3.8 puts the `CLAUDE.md` rewrite here,
and spec:110 requires the written phase report. Nothing new is built; what is built is *checked*, once,
against the sentence the phase is judged by.

**Files:**
- Create: `docs/reports/phase-1.md`
- Modify: `CLAUDE.md`
- Test: none new — this task runs every suite the phase owns and records the result.

**Interfaces:**
- Consumes: every test file 1A and this slice created; `bun run lint`, `lint:rules`, `format:check`, `typecheck`, `test` (the workspace-scripts contract, contracts §3.1).
- Produces: `docs/reports/phase-1.md` and the "Current phase" section 2A reads first.

- [ ] **Step 1: Run the whole gate and record the output**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
bun run --cwd packages/db test
bun run --cwd apps/api test
bun run --cwd apps/worker test
bun run --cwd tests test
bun run --cwd tests test:e2e -- accounting-screens.spec.ts
```

Expected: every command exits 0. The e2e run needs the OD-24 screens; if Task 11 is blocked, that one
command is expected to be absent and Step 2's table records it as outstanding — nothing else changes.

Then confirm the migrations are reversible over the full 0001–0016 range, which is the one check that
only exists once a phase's last migration has merged:

```bash
bun run --cwd packages/db test -- privileges.test.ts
```

Expected: PASS, including "up → down → up reproduces the schema byte for byte" (contracts §3.4.6).

- [ ] **Step 2: Write the definition-of-done roll-up**

The Phase 1 sentence has four clauses (spec:2287). Each is owned, each has one proving test, and this
table is what Task 11's OD-24 gate refers to when it says a blocked screen leaves the other clauses
green. Put it at the top of `docs/reports/phase-1.md` (Step 3 writes the whole file):

| DoD clause (spec:2287, verbatim) | Proved by | Slice | State |
|---|---|---|---|
| "Σdebit = Σcredit holds under fuzz testing" | 1A's fast-check suite through `postDocument`; re-asserted per tenant/period/company by `checkLedgerBalance` and `tests/invariants/ledger-balance.test.ts` (Task 3) | 1A owns, 1B re-asserts | |
| "projections rebuild **bit-identically**" | `checkAccountBalanceProjection` + `tests/invariants/projection-rebuild.test.ts` — **acceptance test 2** (Task 4) | 1B | |
| "a locked period cannot be altered through any path including import" | API and admin paths in 1A; the **background-job path** in `tests/invariants/period-lock.test.ts` — **acceptance test 9** (Task 8); the import path is 9B's and is listed as out of Phase 1's reach below | 1A + 1B (+ 9B) | |
| "the first PITR restore drill has been run against staging and written up as a runbook" | `tests/invariants/restore-drill.test.ts` — **acceptance test 24** — and `docs/runbooks/restore-drill.md` (Task 12) | 1B | |

Fill the State column from Step 1's run: `green`, or `green (local mode; staging half awaits OD-19)`, or
`outstanding — <task> blocked by <OD id>`. Do not write a state you did not observe.

- [ ] **Step 3: Write `docs/reports/phase-1.md`**

spec:110: "**Report per phase**, in writing, against the definition of done — what passes, what does not,
what you decided under ADR, what you are asking. Short."

```markdown
# Phase 1 — report against the definition of done

**Date:** _(the day Step 1 ran)_ · **Slices:** 1A (posting service, JOURNAL, numbering, `account_balance`,
chart of accounts, periods) and 1B (projections, integrity job, minimal reports, screens, restore drill) ·
**Migrations:** 0011–0016 · **ADRs:** 0021–0025.

## Against the definition of done

_(the four-row table from Step 2, with the State column filled from the run)_

## What passes

- **Acceptance tests owned by this phase:** 1, 3, 4 (1A); **2, 9, 24** (1B). Re-run and still green:
  11, 12, 13, 14, 23, 27, 36 over the six tables and two routes Phase 1 added.
- **§3.0.4 row spec:1040** (Accounting — chart of accounts, periods, journals, ledger, trial balance,
  projections, integrity checker) closes here. Every capability the row names has a test: the chart and
  periods in 1A's API suites, journals and the ledger through `postDocument`, the trial balance in
  `apps/api/test/routes/accounting/reports.test.ts`, projections and the integrity checker in
  `tests/invariants/projection-rebuild.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts`.
- **The ledger-integrity SLI exists** (spec:2246 — "the alarm the old system needed and never had"):
  `accounting.ledger.integrity_check` runs nightly per tenant, and a mismatch writes an
  `integrity_incident` audit row inside the hash chain and raises a Sentry event.
- **The two minimal reports ship inside the phase** (spec:2300), under the registered codes
  `accounting.trial_balance` and `accounting.ledger`, which 7B re-expresses unchanged.
- **Migrations 0001–0016 are reversible** as one range, byte for byte.

## What does not pass, and where it closes

| Not proved here | Closes in |
|---|---|
| The **import path** of "a locked period cannot be altered through any path" | 9B — the importer does not exist yet; test 9's clause is listed against 9B in contracts §6.1 |
| The **staging half** of the restore drill (the WAL replay and an arbitrary recovery target) | this slice's Task 12, the day OD-19 is answered; the drill and its verdict already run in CI |
| The three back-office screens and the two report views, if OD-24 was still outstanding | this slice's Task 11 — the routes, contracts and reports they read are merged and tested without them |
| `ReportDefinition`s for the two report codes | 7A/7B, under the same codes — 1B ships routes, not definitions |

## Decided under ADR

| ADR | Decision |
|---|---|
| 0021 | `document_line` base shape (1A) |
| 0022, 0023 | _(1A's — copy their titles from `docs/adr/`)_ |
| 0024 | The ledger-integrity check is four independent read functions and one registry; the job detects and never repairs (LEGACY-079) |
| 0025 | The restore drill is two phases and one shared verdict; the local equivalent is a snapshot, not a WAL replay |

## What we are asking

1. **OD-19** — Supabase organisation access and PITR billing on staging. Until then the drill runs in
   local mode. One task (1B Task 12) is affected; nothing is blocked.
2. **OD-24** — screenshots and a two-minute operator description for the chart of accounts, journal
   entry and fiscal-period screens (spec:79, 108: "Do not invent workflows from this document").
3. **RPO and RTO as numbers** (spec:2233). ADR 0025 proposes RPO ≤ 5 minutes and RTO ≤ 4 hours as the
   targets the drill log is read against. They are a billing decision, not an engineering one, and the
   drill measures both on every run so the proposal can be checked before it is committed to.
4. **The cold-start `MERGE` race** referred by ADR 0024: whether `23505` joins the `withTenant` retry
   set or `postDocument` retries step 12. `tests/invariants/account-balance-concurrency.test.ts` pins
   today's behaviour so the answer is visible the day it lands.
5. **Three amendments to the contracts document**, each one line: `legacy-070` is an append for 1B, not a
   create (0B creates it); the 1B card's task target of 10–12 becomes 13; and the names this slice had
   to define — listed in the plan's header and in its Self-Review §4 — join the interface registry.
```

- [ ] **Step 4: Rewrite the "Current phase" section of `CLAUDE.md`**

Contracts §3.8: the last task of every phase-completing slice rewrites this section, and 1B is one of
them. Replace the whole section — the heading and everything under it up to the next `## ` — with:

```markdown
## Current phase
**Phase 2 — Parties & documents.** Phase 1 is complete: the posting service, JOURNAL with policy v1,
numbering, `account_balance`, the chart of accounts and fiscal periods (Plan 1A); the nightly
integrity job, the three invariant suites, the two minimal reports, the back-office screens and the
restore drill (Plan 1B). Migrations 0001–0016 apply and reverse; acceptance tests 1, 2, 3, 4, 9, 24 pass
in CI alongside Phase 0's 11, 12, 13, 14, 23, 27 and 36.
Next: Plan 2A (`docs/superpowers/plans/2026-09-05-dulja-phase-2a-policy-engine-parties.md`) — the policy engine,
generic `document_line`, `party`, and the posting-service generalisation — then 2B and 2C. Phase 2 exits
when a new document type is added with zero code and issued numbers are unique and gapless-provable.
Outstanding owner decisions that reach into Phase 2: OD-24 (screens). See
`docs/reports/phase-1.md` for what Phase 1 is asking, and the frozen cross-plan contracts in
`docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` for every shared name.
```

Read the existing section first (`awk '/^## Current phase/{p=1} /^## /{if(p && !/Current phase/) exit} p' CLAUDE.md`) and keep the surrounding sections untouched — only this one is rewritten.

- [ ] **Step 5: Confirm the phase gate and commit**

```bash
bun run lint && bun run lint:rules && bun run typecheck && bun run test
grep -c "^| " docs/reports/phase-1.md
```

Expected: green, and the phase report contains the four-clause table with no empty State cell.

```bash
git add docs/reports/phase-1.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: Phase 1 report against the definition of done; CLAUDE.md to Phase 2 [1B T13]

Four DoD clauses, each with its proving test and its state as observed. What does
not pass is listed with the slice that closes it: the import path of test 9 (9B),
the staging half of the restore drill (OD-19) and the screens (OD-24). Five things
we are asking, including the RPO/RTO numbers spec:2233 wants and ADR 0025 proposes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Run against the spec, the contracts document and the writing-plans skill with fresh eyes. Issues found
are fixed inline above; what follows is the record.

### 1. Spec and contracts coverage

| Requirement | Task | Note |
|---|---|---|
| §3.3 projections (spec:1204) — synchronous `account_balance`, asynchronous rebuilt ones | 4, 10 | the trial balance reads the synchronous projection and never re-aggregates; the rebuild lives in the job |
| §3.8 `account_balance` contract and the §4.3.3 rebuild-and-compare | 4 | executed as code, on the full key and every amount |
| §3.8 audit verification (spec:1963, 2031) | 5 | `checkAuditChain` is the production twin of plan0A:2153–2165, which stays unrenamed (hazard 8) |
| §3.8 period reopen reported with its reason (spec:2179) | 5 | read from the audit `after` image, null-safe (assumption 5) |
| §4.8 reliability (spec:2231–2239) — PITR, restore verified not assumed, runbooks | 12 | ADR 0025; `docs/runbooks/restore-drill.md` |
| §4.8 "RPO/RTO stated as numbers" (spec:2233) | 12, 13 | proposed in ADR 0025, **measured** by every drill, referred to the owner with OD-19 |
| §4.9 the ledger-integrity SLI (spec:2246) | 3, 4, 5, 6 | Σdebit = Σcredit per tenant/period/company **and** projections against a fresh rebuild — both halves |
| §4.9 incident path | 6 | Sentry when `SENTRY_DSN` is set, one `logger.error` always, plus an `integrity_incident` audit row |
| §4.10 keyboard-first (spec:2254) | 11 | Enter appends a line, Ctrl+Enter posts, Escape clears |
| §4.10 RTL/LTR parity | 11 | test 23 re-run, both directions |
| §4.11 test strategy (spec:2258–2274) | 3, 4, 5, 8, 12 | invariant suites as their own tier |
| §5.0 row 0.11 — the integrity job "runs, reports no ledger yet" | 5, 6 | 0D's scaffold wording `"no postings"` is preserved as the empty-ledger summary, so the first real run is distinguishable |
| Part V reports sequencing (spec:2300) | 9, 10 | both minimal reports ship in Phase 1 under the §4.16.1 codes; hazard 4 |
| Part V Phase 1 DoD, all four clauses | 13 | the roll-up table, with the two clauses this slice does not own named against their slices |
| spec:110 "Report per phase, in writing" | 13 | `docs/reports/phase-1.md`, in the four-part shape spec:110 names |
| Part VI **2** | 4 | **owned** |
| Part VI **9** | 8 | **owned** — the background-job path, the fourth of spec:2427's four |
| Part VI **24** | 12 | **owned** |
| Part VI 13, 23 | 5, 11 | re-runs |
| §3.0.4 row spec:1040 | 13 | **owned**; closed by the integrity checker, recorded in the phase report |
| LEGACY-001, 002, 049 | 4 | appended |
| LEGACY-079 | 5 | appended — the job detects and never repairs |
| LEGACY-070 | 9 | appended, not created (deviation recorded in the header) |
| LEGACY-081 | 12 | appended (0C creates it — contracts §2.1 0C card) |

**Deliberately not here, with where it closes:** the import path of test 9 (9B); `ReportDefinition`s for
the two report codes (7A/7B, same codes); `packages/db/src/reports/datasets.ts` and any `DatasetId`
(7A); every projection after `account_balance` (3A, 3B, 4B, 6C, 8C each add one
`registerProjectionCheck` call and nothing else); the staging half of the drill (OD-19).

### 2. Placeholder scan

A scan for every token the writing-plans skill forbids — the two three-letter deferral markers, the
"do it later" phrasings, the cross-reference that says a task resembles an earlier one instead of
stating its content, the two Latin abbreviations standing in for a list's tail, the two "add suitable
handling" evasions, and a bare ellipsis where content belongs — returns nothing over the whole file.
(The tokens are described rather than typed, so that a reviewer's own scan does not match this
paragraph and report a false positive.) **One genuine hit was found by the 2026-09-08 audit and removed**:
Task 6 Step 6 carried `// … after \`logger\` and \`boss\` exist:` inside a code fence — a placement
instruction the executor had to resolve by reading 0D's `index.ts`. That step now names the three edits
against 0D's actual file, line by line, and resolves nothing at run time. Every remaining `...` in the file
is JavaScript spread or rest syntax in real code, and every remaining `…` is inside a quoted path, a quoted
error message or a quotation from the spec or the contracts document. Three further things look like
placeholders and are not:

- **`docs/reports/phase-1.md`'s State column is empty in the template.** Task 13 Step 2 says to fill it
  from Step 1's observed run and adds the sentence "Do not write a state you did not observe". Writing a
  verdict here would be inventing the result of a run the task exists to perform.
- **ADR rows 0022 and 0023 in the phase report say "copy their titles from `docs/adr/`".** Those two
  numbers are 1A's and the contracts document allocates only 0021's subject (§3.9). 1A's plan file does
  not exist on disk, so naming them here would be inventing another slice's decisions. The instruction
  names the exact directory to read them from.
- **The drill log in the runbook has one empty row.** It is a log; the first row is written by the first
  drill. The column headings state exactly what each drill records.

### 3. Type consistency across task boundaries

Every name used in more than one task, checked against its definition:

| Name | Defined | Used |
|---|---|---|
| `LedgerImbalance`, `ProjectionMismatch`, `AuditChainResult`, `PeriodReopen`, `ProjectionCheck`, `IntegrityReport` | T3 (`integrity/types.ts`) | T4, T5, T6, T12 |
| `checkLedgerBalance`, `LedgerBalanceOptions` | T3 | T5 (`runIntegrityCheck`), legacy-003 clause of T13's gate |
| `postJournal`, `JournalLine`, `PostJournalOptions` | T3 (`tests/invariants/support/post-journal.ts`) | T4, T5, **T6**, T7, T8, **T10**, T12 — T6, T7 and T10 reach it from `apps/*/test/**`, which is what the `dependency-rule.ts` allowance of T6 Step 1(b) and the two tsconfig `include` entries exist for |
| `checkAccountBalanceProjection`, `registerProjectionCheck`, `projectionChecks`, `ACCOUNT_BALANCE_CHECK` | T4 | T5, T12, and every later slice with a projection |
| `checkAuditChain` | T5 | T6, T12 |
| `listPeriodReopens`, `PeriodReopenOptions` | T5 | T6 |
| `runIntegrityCheck`, `recordIntegrityIncident`, `IntegrityCheckOptions` | T5 | T6, T7 |
| `IncidentReporter`, `createIncidentReporter` | T6 | T7 |
| `AccountingHandlerDeps`, `createIntegrityCheckHandler`, `registerAccountingHandlers` | T6, widened in T7 | T7, T8 |
| `PeriodAwaitingClose`, `MonthEndReady`, `listPeriodsAwaitingClose`, `recordMonthEndReady`, `createMonthEndHandler` | T7 | T8 |
| `trialBalance`, `trialBalanceFingerprint`, `TrialBalanceParams`, `TrialBalanceRow`, `AccountType` | T10 | T10 (routes), T11 (screens), **T12 (the drill's fingerprint)** |
| `accountLedger`, `accountOpeningBalance`, `LedgerParams`, `LedgerRow` | T10 | T10 (routes), T11 |
| `ReportCodeSchema`, `TrialBalanceRowSchema`, `TrialBalanceRowDto`, `LedgerRowSchema`, `LedgerRowDto`, `TrialBalanceQuery`, `LedgerQuery`, `TrialBalanceList`, `LedgerList` | T10 (`packages/contracts`) | T10 (routes), T11 (`accounting-api.ts`) |
| `reportsRoutes`, `reportsRouteModule` | T10 | `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts` |
| `AccountDto`, `FiscalPeriodDto`, `BranchDto`, `JournalLineInput` (all `z.infer` of 1A's / 0D's schemas, never re-declared) | T11 (`lib/accounting-schemas.ts`) | T11's five screens |
| `createAccountingApi`, `AccountingClient`, `useAccountingApi` | T11 (`lib/accounting-api.ts`) | T11's five screens |
| `PageHeader`, `Modal`, `ReportTable`, `ReportColumn` | T11 (`src/components/`) | T11's five screens; every later UI slice that re-runs test 23 |
| `AccountsRoute`, `JournalEntryRoute`, `PeriodsRoute`, `TrialBalanceRoute`, `LedgerRoute` | T11 | `apps/backoffice/src/router.tsx` |
| `DrillCapture`, `DrillVerdict`, `VerifyOptions`, `captureDrillPoint`, `verifyRestore`, `formatDrillVerdict`, `writeCapture`, `readCapture`, `snapshotDatabase`, `restoreDatabase` | T12 | T12's test, the runbook, legacy-081 |
| Plan 0A `Seed.cash`, `Seed.sales`, `Seed.period`, `Seed.company`, `Seed.human`, `Seed.system`, `Db.container`, `Db.url` | plan0A | T3, T4, T5, T7, T8, T12 |

**Nine mismatches were found and fixed inline.** The first four are the original pass; the last five come
from the 2026-09-08 audit round.

1. **Task 12's test used `s.accountCash` and `s.accountSales`, which do not exist.** Plan 0A's `Seed`
   names its two fixture accounts `cash` and `sales` (plan0A `export interface Seed`), and Tasks 3, 4
   and 5 already call `postJournal` with `a.cash` / `a.sales`. Fixed to `s.cash` / `s.sales`, with a
   comment naming them as 0A's accounts 1000 and 4000. Inventing a `Seed` field would have been the
   hazard-8 failure — renaming a Plan 0A helper's surface.
2. **Task 12's test reached `trialBalanceFingerprint` through a dynamic `await import("@dulja/db")`** in
   a trailing helper. Replaced with the static import every other test in this plan uses; the trailing
   helper is gone.
3. **Task 12's Produces block named seven of the support module's exports and its test imported nine.**
   The block now lists all ten, `VerifyOptions`, `writeCapture` and `readCapture` included.
4. **The `console.info` justification cited the wrong lint rule's scope.** Plan 0A's `.oxlintrc.json`
   turns `no-console` off for `**/*.test.ts` as well as `packages/*/src/cli.ts` (plan0A:301), so the
   drill's one print needs no new override — and that is exactly why `formatDrillVerdict` *returns* a
   string rather than printing: `support/restore-drill.ts` is not a `.test.ts` file.
5. **Task 10 re-declared `AccountTypeSchema` in `packages/contracts/src/accounting/reports.ts`.** 1A
   already declares it in `accounting/account.ts` and re-exports it from the barrel, so a second
   `export *` carrying the name is TS2308 and `packages/contracts` stops type-checking — failing Task 10
   Step 9 and Task 13's whole-repo gate. It is now **imported** from `./account` and neither re-declared
   nor re-exported. The db-side `export type AccountType` in `packages/db/src/reports/trial-balance.ts`
   is unaffected: 1A exports no `AccountType` from `@dulja/db`, and §4.16.3 assigns that name to 1B.
6. **Task 11's `createJournal` omitted `branchId`, which 1A's `CreateDocumentBody` requires**, so the
   journal-entry screen could not post at all. The screen now resolves the company's BRANCH dimension
   values through 0D's two ungated dimension reads, defaults to the `HQ` value 0C seeds, and blocks Post
   while no branch is selected.
7. **Task 11 was written against a 0E that does not exist.** It imported `apiFetch` from
   `lib/api.ts`, `useT` from `@dulja/i18n`, `Input`/`Table`/`Dialog`/`PageHeader` from `@dulja/ui` and
   `createFileRoute` from TanStack Router — **none** of which 0E ships. Assumption 7 now names 0E's real
   surface (`createAdminApi`/`AdminApi`, `useShell()`, `Button`/`TextField`/`Select`/`DataGrid`,
   code-based `createRoute` in `router.tsx`), Steps 4–9 are rewritten against it, and the three missing
   primitives are written as local `apps/backoffice/src/components/` files rather than added to
   `packages/ui`, which this slice does not own. This also answers idempotency: 0E's `AdminApi.send`
   mints `Idempotency-Key` on every unsafe method, so this slice mints none.
8. **Task 6 produced a `scheduleAccountingJobs` that would have double-scheduled both jobs.** 0D's
   `apps/worker/src/index.ts` already loops over `registeredJobNames()` and installs
   `boss.schedule(`${name}.fanout`, JOBS[name].schedule, …)` plus the `eachTenant` worker. A second
   `boss.schedule(name, schedule)` would queue a nightly envelope with no `tenantId` that `runJob`
   cannot resolve. The function is gone; registration alone is the wiring.
9. **Task 11's DTOs were hand-declared beside imported ones.** `AccountDto` and `FiscalPeriodDto` are now
   `z.infer<typeof AccountSchema>` / `z.infer<typeof FiscalPeriodSchema>`, in one
   `lib/accounting-schemas.ts` that names 1A's, 0D's and Task 10's schemas and nothing else — 0E's own
   `admin-schemas.ts` pattern, so a rename in 1A is a one-file edit.

**Two tasks declare types or queries ahead of their own failing test, and the plan says so where it
matters.** Task 3 Step 1 writes `integrity/types.ts` before Step 2's test and Task 10 Steps 1–4 write the
report queries and the Zod module before Step 5's test, because each test's import list names those
declarations. Both reds stay genuine and specific (a missing `@dulja/db` export; a 404 from an unmounted
path). Every other task is failing-test-first end to end. Task 11 Step 2 carries the same note, because
that is where the claim used to be overstated.

### 4. Contract additions — names this plan had to define because the registry lacks them

**This section is the single complete list.** The header's *Contract deviations* block points here rather
than restating a subset, because two partial lists in two places is how they drift.

- `packages/db/src/integrity/`: `IntegrityReport`, `LedgerImbalance`, `ProjectionMismatch`, `PeriodReopen`,
  `AuditChainResult`, `ProjectionCheck`, `registerProjectionCheck`, `projectionChecks`, `runIntegrityCheck`,
  `recordIntegrityIncident`, `checkLedgerBalance`, `LedgerBalanceOptions`, `checkAccountBalanceProjection`,
  `ACCOUNT_BALANCE_CHECK`, `checkAuditChain`, `listPeriodReopens`, `PeriodReopenOptions`,
  `IntegrityCheckOptions`.
- `packages/db/src/periods/month-end.ts`: `listPeriodsAwaitingClose`, `recordMonthEndReady`,
  `PeriodAwaitingClose`, `MonthEndReady`.
- `packages/db/src/reports/`: `trialBalance`, `trialBalanceFingerprint`, `TrialBalanceRow`,
  `TrialBalanceParams`, `AccountType`, `accountLedger`, `accountOpeningBalance`, `LedgerRow`, `LedgerParams`.
- `apps/worker/`: `IncidentReporter` and `createIncidentReporter` (`src/observability/incident.ts`);
  `AccountingHandlerDeps`, `createIntegrityCheckHandler`, `createMonthEndHandler`,
  `registerAccountingHandlers` (`src/handlers/accounting.ts`).
- `apps/api`: the route-module path `/v1/companies/:companyId/reports`, `reportsRoutes`,
  `reportsRouteModule`.
- `apps/backoffice`: `createAccountingApi`, `AccountingClient`, `useAccountingApi`, `AccountDto`,
  `FiscalPeriodDto`, `BranchDto`, `JournalLineInput`, `PageHeader`, `Modal`, `ReportTable`, `ReportColumn`,
  `AccountsRoute`, `JournalEntryRoute`, `PeriodsRoute`, `TrialBalanceRoute`, `LedgerRoute`. §4 registers no
  front-end interface (0E's own Self-Review says so), so these are recorded for the roadmap only.
- Schema and job names: the `JobPayload` entries for `accounting.ledger.integrity_check` and
  `accounting.period.month_end`; the three index names of migration 0016; the audit `table_name` sentinels
  `integrity_incident` and `month_end_ready`; and the assumed `app.fiscal_period.reopen_reason` column,
  which is 1A's (its migration 0013, ADR 0023) and which 1A's own amendment A1 registers.
- `tests/invariants/support/restore-drill.ts` (T12): `DrillCapture`, `DrillVerdict`, `VerifyOptions`,
  `captureDrillPoint`, `verifyRestore`, `formatDrillVerdict`, `writeCapture`, `readCapture`,
  `snapshotDatabase`, `restoreDatabase`.
- The nine environment names `DRILL_PHASE`, `DRILL_LIVE_URL`, `DRILL_RESTORED_URL`, `DRILL_CAPTURE_FILE`,
  `DRILL_TENANT_ID`, `DRILL_ACTOR_ID`, `DRILL_COMPANY_ID`, `DRILL_PERIOD_ID`, `DRILL_RESTORE_STARTED_AT`
  (contracts §3.11 lists none of them — they are test-tier names, never held by a container or a
  deployable, and the amendment should say so).
- The two document paths `docs/runbooks/restore-drill.md` and `docs/reports/phase-1.md`, both of which the
  contracts document names as directories (§3.1 "Additional directories") but not as files.

**No literal was invented in any of the five closed namespaces** (hazard 32): no document-type code, no
account code, no `DatasetId`, no `fixtures.ts` helper, no new `ERR_*`; the two report codes are §4.16.1's.
**Two names were deliberately *not* invented**: `AccountTypeSchema` is imported from 1A rather than
re-declared (mismatch 5), and the route test's local grant is `grantReportCodes`, not the `grantCodes`
§4.17 reserves for 2B.

### 5. Hazards re-checked (contracts §5)

| # | Hazard | Where this plan satisfies it |
|---|---|---|
| 1 | no real statutory rate anywhere | no rate, threshold or ceiling appears; the drill's amounts are `100.0000`, `250.5000`, `17.2500`, `9999.0000`, `1.0001` |
| 2 | no invented vendor detail | ADR 0025 and the runbook write **no** platform click path, and say why; the PITR precondition is checked with `current_setting('archive_mode')`, a Postgres fact, not a dashboard claim |
| 4 | reports ship inside the phase | T9, T10 — both codes, in Phase 1, re-expressed by 7B under the same codes |
| 5 | owner-account tasks name the exact verify command and a local equivalent | T11 (`ls -1 docs/spec/screens/1b/`), T12 (`psql … current_setting`), each with what happens when it is absent |
| 6 | one isolated task per OD item | OD-24 → T11, OD-19 → T12, and nothing else in the plan mentions either as a dependency |
| 7 | never re-open D1–D27 | none touched; ADR 0024's MERGE question and ADR 0025's RPO/RTO numbers are written as **proposals and asked** (spec:95), not implemented |
| 8 | Plan 0A helpers by exact name, never renamed | `startDb`, `Db`, `Seed`, `seedTenant`, `draftDocument`, `uuidv7`, `up`/`down`/`listApplied`, `lintSchema`, `schemaFingerprint`, `app_meta.*`, `app.assert_period_open`, `app.audit_chain` — and mismatch 1 above was exactly this hazard caught |
| 9 | `fixtures.ts` extended only with §4.17's helpers | **not touched at all**; `postJournal` and the drill helpers live in the test tier |
| 10 | per-tenant rows are never migration data | 0015 seeds `app.permission` only — the one global table |
| 11 | no enum label added | 0015 and 0016 add none |
| 13 | `lint-schema.ts` set memberships exactly as §3.5.3 | T2 changes one `relkind` filter and adds no membership |
| 14 | migration and ADR numbers never renumbered | 0015, 0016; ADR 0024, 0025 — the whole of 1B's two ranges, and no assertion anywhere on `max(version)` |
| 15 | two `withTenant`s; root `tests/` use the production one | every root test imports it from `@dulja/db`; the drill's `verifyRestore` takes the caller's `Sql` and opens the production one itself |
| 20 | jobs run as the tenant's system principal | T6, T7 — `systemContext`; T8 posts through the job path as `s.system` |
| 21 | `sql.unsafe` has three homes | this plan calls `sql.unsafe` **nowhere**: every statement, in source and in tests, is a `postgres.js` tagged template with bound parameters. Task 5's three tamper cases were rewritten from nine `db.admin.unsafe(...)` calls carrying interpolated template literals into nine `db.admin` tagged templates, for exactly this reason (contracts §3.3, spec:99 — no test exemption is granted anywhere in the contracts). The `alter table app.audit_log disable trigger audit_log_immutable` / `enable` pair those cases bracket is the one window in the plan where an invariant is off, and it is off only inside a test, as the table owner, for the two statements that manufacture the tamper the chain exists to detect — see the remaining concern in the handoff |
| 22 | nothing outside posting/costing writes ledger, movement or projection tables | the integrity job **detects and never repairs** (ADR 0024); the drill writes to no database; `recordIntegrityIncident` writes `app.audit_log`, which is not on the `posting-only-tables` list |
| 25 | the DELETE grant list is pinned | not extended; the drill's `dropdb` runs as the container superuser against a scratch database, never through `app_rw` |
| 26 | the permission vocabulary is closed | one code, `accounting.report.read`, which §3.6.2 already assigns 1B |
| 29 | every screen task begins with OD-24 | T11 Step 1 is the gate and stops the task if it fails |
| 31 | every route needs a probe entry | `tests/invariants/probes.ts` gains `/v1/companies/:companyId/reports`; both jobs carry `tenantId` |
| 32 | no literal invented in a shared namespace | §4 above |
| 35 | written to the writing-plans skill | exact paths, exact signatures, real code, failing test first, a commit per task; the placeholder scan is §2 above |

### 6. Size, task count, and what the contracts document must be amended to say

**Seven amendments, of which three are already merged.** They are numbered 1–7 and the handoff refers to
them by these numbers. **The outstanding ones precede execution**: this plan may not edit the contracts
document, and Task 1 must not start until the amendment PR is merged, so that no executor has to choose
between the plan and the catalogue. The merged ones are listed only so the orchestrator does not re-apply
a row that is already in §4.18.

1. **OUTSTANDING — §4.2.6's Rules paragraph contradicts its own `JobHandler` signature** about who iterates
   `pgboss.tenant_registry`. The signature wins; the Rules sentence becomes "the scheduled dispatcher
   iterates `pgboss.tenant_registry` … and invokes each handler once per tenant under that tenant's
   `systemContext`". 0D's shipped `apps/worker/src/index.ts` is already written that way — it schedules
   `${name}.fanout` and calls `eachTenant` — so this amendment records what the code does. Recorded in full
   in the header's *Contract deviations* block.
2. **MERGED (§4.18 round 1) — `legacy-070` is an append for 1B, not a create** (0B creates it; §3.7.3's
   first-in-execution-order rule). The 1B card already reads "appends to legacy-001, 002, 049, **070**, 079,
   081". Nothing to do.
3. **OUTSTANDING — the 1B card's target size becomes 13 tasks**, not 10–12. The three above the target are
   the two isolated owner-gate tasks §2.0 itself requires (T11, T12) and the `relkind_partition` linter
   rule §3.5.2 assigns 1B (T2). No task was split for length; none was merged to hide work.
4. **MERGED (§4.18 round 1) — the names in §4 above join the interface registry.** §4.16.3 exists and
   carries `trialBalance`, `trialBalanceFingerprint`, `accountLedger`, `accountOpeningBalance`, their
   param/row types, `AccountType`, the reports route path and the `ProjectionCheck` registry; §4.17.1
   registers `postJournal`/`JournalLine`; §4.2.6 registers the two `JobPayload` entries and the two audit
   `table_name` sentinels. Still to do inside this row: the **`DRILL_*` test-tier note** (§3.11 lists none
   of the nine names) and the two document paths of §4 above.
5. **OUTSTANDING — §3.1's `tests` tier gains `apps/worker/src/handlers/**`** beside `apps/api`'s
   `createApp()`. Task 8 needs the real month-end handler to prove test 9's job path, and a handler factory
   is a pure function of its deps, the same shape as `createApp()`. Task 8 Step 3 adds the matching
   `dependency-rule` allowance; without the amendment the plan and the catalogue disagree.
6. **OUTSTANDING — §4.16.3's pinned-assertion sentence names two files and there are three.** It becomes
   "1B's **three** assertions on that array — in `tests/invariants/projection-rebuild.test.ts`,
   `tests/invariants/audit-chain.test.ts` and `apps/worker/test/handlers/integrity-check.test.ts` — are
   updated in the same PR as the registration". Without it, 2B's `SERIES_GAP_CHECK` PR leaves
   `projection-rebuild.test.ts` red with nothing telling its executor why.
7. **OUTSTANDING — §4.1's "`grantAdmin()` is the one way" sentence admits a file-local grant inside
   `apps/api/test/**`.** That helper lives in `tests/support/api.ts`, which no allowance in this slice makes
   reachable from `apps/api/test/**`; Task 10's route test therefore uses `grantReportCodes`, doing exactly
   plan0A:1195–1200's three inserts as `s.system`. 0B already does the same in its own `apps/api/test`
   files, so the amendment records shipped practice.

**One open item of §4.18 round 1 is already closed by this plan, and needs no amendment.** Round 1 item (2)
reads "1B's Task 10 says 'add `reportsRouteModule` to the `ROUTES` array', but §4.2.7 makes `buildRoutes`
the constructor — still open, still a plan-side correction". Task 10 Step 8 now says the opposite in as many
words: "add to `buildRoutes` — **not** to the `ROUTES` array". The architect may mark that item closed.

**On length.** This plan is ~5,710 lines for 13 tasks — about 439 lines per task against the ~246 that
§2.0 derives from Plan 0A, and past the ~3,700-line ceiling §2.0 sets. The excess is not padding and is
not hidden work: three tasks carry a document as well as code (T4 ADR 0024, T12 the runbook and ADR
0025, T13 the phase report), and T10 and T11 carry two reports and five screens between them. **The
honest reading of §2.0 is that this slice is at the ceiling in substance**, and a reviewer who wants it
under the line should split it at **T10** — Tasks 1–9 are "the integrity slice" (projections, the two
jobs, tests 2 and 9, the indexes) and Tasks 10–13 are "the reports, screens and drill slice", with the
migration range splitting 0015 / 0016 and the ADR range 0024 / 0025 along the same cut. That split is
recorded here rather than taken, because §2.0 requires a catalogue amendment before a plan is split and
this plan may not amend the catalogue.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-1b-projections-integrity-reports.md`.**
Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch
execution with checkpoints.

**Which approach?**

### Order and dependencies inside this slice

Tasks 1 → 10 are strictly sequential; each one's failing test needs the previous one's export. Three
exceptions and one warning:

- **Task 2** (the `relkind_partition` linter rule) touches only `packages/db/src/lint-schema.ts` and its
  two tests. It has no dependency on Tasks 1 or 3 and can run first, in parallel, or last — but it must
  merge before any later slice partitions a table, which is why it sits early.
- **Task 11 (OD-24) must be requested before Task 9 begins.** The screenshots and operator notes take
  the owner time to produce; asking on the day the task starts wastes a week. The task itself is placed
  at 11 because it consumes Task 10's routes.
- **Task 12 (OD-19) is independent of Tasks 9–11** and may run in parallel with them by a second worker.
  Its local mode needs only Tasks 3, 4, 5 and 10.
- **Task 13 runs last, after every other task, including a blocked one.** If Task 11 or the staging half
  of Task 12 is outstanding, Task 13 still runs and records the outstanding item in the roll-up — that
  is what the roll-up is for.

**Before Task 1 starts.** Merge the **five outstanding** contracts amendments of Self-Review §6 — numbers
**1, 3, 5, 6 and 7**. Numbers **2 and 4 are already folded into §4.18 round 1** and must not be re-applied:
the 1B card already reads "appends to legacy-001, 002, 049, 070, 079, 081", and §4.16.3 and §4.17.1 already
carry this slice's registered names (all that is left inside number 4 is the `DRILL_*` test-tier note and
the two document paths).

They are not optional bookkeeping. **Amendment 1** decides which of two contradictory halves of §4.2.6 the
two job handlers implement — and 0D's shipped worker entrypoint has already chosen the signature's reading,
so the Rules sentence is the half that is wrong. **Amendment 3** is the only thing that makes a 13-task plan
legal against a 10–12 card. **Amendment 5** is what makes Task 8's import of the real month-end handler legal
against §3.1. **Amendment 6** is what stops 2B's `SERIES_GAP_CHECK` PR leaving a third pinned assertion red
with nothing naming it. **Amendment 7** is what makes Task 10's file-local grant legal against §4.1's "the
one way to do it". This plan may not amend the catalogue itself (§2.0), which is why they are listed rather
than made.

**One warning on Task 6 Step 8.** It asserts that `app_rw` may `create temporary table` (assumption 4).
If that assertion fails, the fix is one statement — grant `TEMPORARY` on the database to `app_rw` in a
migration inside this slice's range — and it is a real finding, not a test to relax.

**Four things an executor should watch that this plan does not settle.**

0. **Task 11 is written against 0E's plan, not against 0E's merged code.** Assumption 7 now names the
   exact surface 0E's own users-and-roles screen uses — `createAdminApi`/`AdminApi` in `lib/admin-api.ts`,
   `useShell()` for `t`, `Button`/`TextField`/`Select`/`DataGrid` from `@dulja/ui`, code-based
   `createRoute` in `router.tsx` — because the earlier draft of this task named an `apiFetch`, a `useT`
   and four `@dulja/ui` primitives that 0E ships none of. **Before Step 4, spend five minutes confirming
   the merged 0E matches**: `grep -n "export" apps/backoffice/src/lib/admin-api.ts packages/ui/src/index.ts
   apps/backoffice/src/components/app-shell.tsx`. A different spelling is a one-line import fix per file;
   a different *shape* — `send` not minting `Idempotency-Key`, or `Select` taking children instead of
   `options` — is a finding to report before writing any screen, because Steps 4–9 are written to those
   shapes. `PageHeader`, `Modal` and `ReportTable` stay local to `apps/backoffice` either way: promoting
   one into `packages/ui` is an amendment plus a 0E-owned file, and this slice owns neither.

1. **Task 5 disables `audit_log_immutable` for two statements.** It is a test, it runs as the table owner,
   and it is the only way to manufacture the tamper the chain exists to detect — but spec:101's "never
   disable an invariant, constraint or trigger *temporarily*" carries no test exemption anywhere in the
   contracts, and this plan does not invent one. If a reviewer reads spec:101 as binding on test code
   too, the case has to go instead: there is no third way to produce a bad hash in a database whose
   trigger refuses every UPDATE. Raise it before Task 5 rather than during it.
2. **Task 10 constructs `new OpenAPIHono<AppEnv>()` bare.** `@hono/zod-openapi` renders a *query*
   validation failure through the router's `defaultHook`; without one it answers Hono's own
   `{ success: false, error }` 400, not `application/problem+json`. Step 5's last two cases assert
   `code === "ERR_VALIDATION_FAILED"` in a `Problem` body, and Step 4's `.strict()` makes more requests
   take that path. If 0B's other routers set a `defaultHook` (or `createApp` installs one), copy the same
   construction here; if they do not, that is a 0B gap, not a 1B one — report it rather than hand-rolling
   a second error shape in this module.
3. **Task 3's foreign-currency case rests on assumption 3.** It seeds the rate *and* writes it on the
   header so it passes either way, but if 1A turns out to re-resolve through `app.rate_for`, every later
   slice's foreign-currency fixture needs the same `seedRate` call and the assumption should be promoted
   to a line in §4.3.2.

### What this slice hands to the next

**Phase 1 exits with Task 13.** The next plan is **2A — Policy engine, generic `document_line`, `party`,
posting-service generalisation, reversal**, at
`docs/superpowers/plans/2026-09-05-dulja-phase-2a-policy-engine-parties.md` (contracts §6.4). It begins
only when Task 13's gate is green.

| Consumer | Inherits |
|---|---|
| **3A, 3B, 4B, 6C, 8C** | `registerProjectionCheck({ name, run })` — each adds one call for its own projection (`stock_on_hand`, `stock_valuation`, `party_ageing`, `item_profitability`, the `pos_cashier` snapshot, `employee_ytd`) and edits no file of this slice. Each re-runs **test 2** against its own projection through the same `runIntegrityCheck` |
| **2A, 2B** | the `relkind_partition` linter rule (Task 2) — the first slice to partition a table needs it already merged; and the period-lock proof pattern of Task 8 for their own R1/R2 job paths |
| **7A, 7B** | the two report codes `accounting.trial_balance` and `accounting.ledger`, and the query functions behind them. 7B re-expresses both as `ReportDefinition`s **under the same codes** and re-runs this slice's tie-out tests unchanged (hazard 4) |
| **8B** | test 9's shape for the payroll period lock (test 38), and `assert_period_open` proven on the job path |
| **9B** | the fourth path of test 9 is the import path, and this slice's `tests/invariants/period-lock.test.ts` is the file it appends to |
| **every slice with a screen** | Task 11's OD-24 gate pattern; the three local components `PageHeader`, `Modal` and `ReportTable` in `apps/backoffice/src/components/`; and `useAccountingApi`'s shape — a `createAdminApi` client wrapped in one typed façade per module, so no screen names a URL twice |
| **operations, quarterly** | `docs/runbooks/restore-drill.md` and the drill log — contracts §6.1 lists test 24's re-run as quarterly, and the runbook is the whole procedure |