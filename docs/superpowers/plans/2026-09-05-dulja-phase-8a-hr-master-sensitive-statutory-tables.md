# Dulja Phase 8A — HR master, sensitive data, compensation, pay components, statutory schemes and rate tables

**For agentic workers:** execute the tasks in order. Each task is self-contained: it names every file it creates or modifies, gives the exact signatures it consumes and produces, carries the real code, and ends with a commit. Do not skip the failing-test step — the expected failure text is written out so you can compare it against what you actually see. If what you see differs, stop and read the task's "Where to stop and raise" entry in the Execution handoff rather than adjusting the test.

## Goal

Open Phase 8 by building the **data** payroll runs on, and by closing two defects the legacy system never closed: confidentiality as a display filter with a caller-supplied off switch (LEGACY-033, LEGACY-045) and behaviour-governing configuration living in opaque blobs (LEGACY-078).

Seven things ship. (1) The minimal `app.employee` grows the columns §3.10.1 names — position, employment type, a statutory-profile note and `archived_at` — and gains the **R4 no-self-pay** guard on `terminated_on`. (2) `app.employee_sensitive` holds national ID, passport, date of birth, residency category, bank account, EPF/SOCSO/tax reference numbers and work-permit expiry as **AES-256-GCM ciphertext under a dedicated key**, behind the `sensitive_gate` RESTRICTIVE RLS policy of spec:2076 — a principal without `hr.employee.read_sensitive` gets **zero rows through every path**, and a new schema-linter rule makes a missing gate a build failure. (3) `app.employee_statutory_profile` is effective-dated and carries the fields the spec names plus an `extra jsonb` for the verified additions ⚠️ OD-28. (4) `app.pay_component` (`earning | deduction` — two values, never three), the `app.pay_component_scheme` join that replaces "subject to X" booleans, and effective-dated `app.compensation_line` whose history *is* its closed rows. (5) `app.statutory_scheme` as **rows, never an enum**, and `app.statutory_rate_table` with the `verified_by <> loaded_by` trigger — the segregation of duties that makes a rate table trustworthy. (6) The rate-table **JSON Schema** in `packages/domain/payroll/`, the `statutory` seed sub-pack loader, and the `hr.rate_table.lapse_warning` job that warns sixty days before a table lapses. (7) Six permission codes and their role grants.

The slice's owned acceptance test is **32**: sensitive fields have no side channel — not through an endpoint, a filter, a sort, a search, the OpenAPI document, or a direct `app_rw` query under `withTenant`.

**No real Malaysian statutory rate, threshold, ceiling or formula appears anywhere in this plan** (spec:2080, hazard 1). Every table this slice can load is either the clearly synthetic `SYNTH` fixture or a file the owner's accountant signs off under OD-23. The `packages/db/seed/my/statutory/<scheme>/` directories ship **empty**.

## Architecture

- **Data.** Six migrations create or extend seven tables in `schema app`, each with `tenant_id`, forced RLS, a `tenant_isolation` policy, composite `(tenant_id, x)` FKs, the audit trigger and a two-tenant test. Two of them join `NO_ID_TABLES` (`employee_sensitive`, keyed on `employee_id`; `pay_component_scheme`, a pure join).
- **Confidentiality is a predicate, not a parameter.** Three RESTRICTIVE policies — `sensitive_gate` on `employee_sensitive` (spec:2076, verbatim) and `compensation_gate` on `compensation_line` and `employee_statutory_profile` — evaluate `app.actor_has(<code>, <the employee's company>)`. Postgres ANDs restrictive policies with the permissive set, so the gate composes instead of being OR-ed away, and because a policy with no `with check` uses its `using` expression for `with check` too, the same predicate gates writes. The API additionally omits the fields; the RLS gate is the control.
- **Encryption is application-side and one file wide.** `packages/db/src/hr/sensitive.ts` is the only module that calls `crypto`: `version(1) || nonce(12) || ciphertext || tag(16)`, AES-256-GCM, AAD = `employee_id || column name`, key chosen by `key_version` from a **key ring** built from `HR_FIELD_ENCRYPTION_KEY` (and `…_PREVIOUS` during 8D's rotation). No route ever sees a key; `AppDeps` carries the ring, exactly as 2C's `objectStore` is carried.
- **Segregation of duties in the data layer.** `app.forbid_self_pay()` is one generic trigger function taking the name of the column that holds the employee id, attached to four tables (R4, spec:2175). `app.assert_rate_table_verifier()` refuses a verification by the principal that loaded the table (`ERR_HR_SELF_VERIFY`, spec:2080) and freezes the definition once verified.
- **Rules as reviewable data.** `packages/domain/payroll/rate-table.schema.json` is §4.12.3 verbatim; `RateTable` is **generated** from it and committed, exactly as 1A generates `PostingPolicy`; the `statutory` sub-pack loader reads `schemes.json`, `pay-components.json` and `<SCHEME>/vN.json` and validates every rate table against the schema before it touches the database. `packages/domain/src/**` never imports `packages/domain/payroll/**` — spec:2366, enforced by 0B's `dependency-rule` lint.
- **Nothing here posts.** This slice writes no ledger, movement or projection row and seeds no account code: `pay_component.expense_account_id` and `statutory_scheme.payable_account_id` are **nullable**, filled by 8B's chart seed (§4.12.2, hazard 33).

## Tech Stack

TypeScript 5 on Bun; PostgreSQL 18 via `postgres.js` tagged templates (Drizzle mirrors for typed reads only); Hono + `@hono/zod-openapi`; Zod contracts; Vitest on Node 24 with Testcontainers; `decimal.js` behind `Money`; `Ajv2020` + `addFormats` + `json-schema-to-typescript` in `packages/domain` (already dependencies from 1A's ADR 0022 — the lockfile owns the versions, spec:104); Node's built-in `node:crypto` for AES-256-GCM; pg-boss for the one job this slice registers. **No new package dependency is added by this slice** and no version literal appears in a source file (§3.3).

## Spec

`C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` v1.2 — **§3.10 in full** (spec:2067–2110), especially **§3.10.1** (spec:2075–2080, 2086–2088, 2090, 2093) and **§3.10.2** (spec:2097); §3.3's Employee subtree (spec:1170–1174, 1200); §3.8's linter rules and the `stamp_actor` list (spec:1370, 1648–1652); §3.9 Deletion (spec:2049); §4.2.1 (spec:2149, 2162–2163 — the `hr` module rows and the `hr_payroll`, `accountant` and `auditor` role rows); §4.2.2 **R4, R6, R7** (spec:2175–2178); §4.6 HR data (spec:2211); §4.11 secrets (spec:2273); §5.2 (spec:2366, 2368); Part V Phase 8 (spec:2294, 2301); Part VI tests **31**, **32**, **35** (spec:2449–2451, 2453); Part VII **#14** (spec:2478); Part I **LEGACY-029, 030, 033, 044, 045, 078**.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 8A — HR master, sensitive data, compensation, pay components, statutory schemes and rate tables. **Phase:** 8. **Phase gate:** this plan starts only when **Phase 4's definition of done is green in CI** (spec:87, 2301 — "may start as soon as Phase 4 is green and run alongside Phases 5–7"), i.e. 0B, 0D, 0C, 0E, 1A, 1B, 2A, 2B, 2C, 3A, 3B, 3C, 3D, 4A and 4B are merged. **8A does not need 5A, 6A–6D or 7A** (hazard 28 — only 8D needs 7A and 2C); it does need migration **0064** (§4.6.2), which 6C commits if 6C ran first and this plan commits if it did not.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.stamp_actor`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `readConfig`, `ApiConfig`, `ConfigError`, `PERMISSION`, `PERMISSIONS`, `PermissionDef`, `PermissionCode`, `SliceId`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `seedBranch`, `JOBS`, `JobName`, `JobPayload`, `JobClient`, `JobEnvelope`, `eachTenant`, `registerHandler`, `runJob`, `JOB_PROBES`, `JobIsolationProbe`, `startWorker`, `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS`. **0C** — the seed CLI, `SubPack`, `SUB_PACKS`, `SeedConfig`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `containerSecrets`. **0E** — `packages/ui`, `packages/i18n`. **1A** — `seedTenantV2`, `seedAccount`, `documentTypesLoader`, `resolvePolicy`; the Ajv setup and `scripts/generate-policy-type.ts` this slice's generator mirrors. **2A** — `seedParty`, `seedDocumentType`, `parsePolicy`. **2B** — `grantCodes`, `app.principal_has`. **6C, if merged** — `app.employee`, `seedEmployee`, `packages/db/src/schema/employee.ts`, `employeeRoutes` / `employeeRouteModule`, `packages/contracts/src/hr/employee.ts`, `app.actor_in_branch`, the `branch_isolation` Form A′ policy on `employee`, and the `branch_isolation_policy` linter rule. **If 6C is not merged**, Task 1 commits `0064_create_employee_minimal.sql`, `seedEmployee` **and `packages/contracts/src/hr/employee.ts`** itself (amendments **A17**, **A18**) and every later task that would have used `employeeRoutes` mounts its own sub-resource module instead — Task 1 Step 1 decides the branch and Task 0 Step 3 records which branch was taken. **The branch is a repository fact every later task reads at run time, never a manual edit:** `hrFixture` derives `sixC` from `"hr.employee.read" in PERMISSION` (Task 3 Step 8), grants 6C's two employee codes only when it is true, and Task 4's two employee-*directory* cases are `it.skipIf(!f.sixC)` — there is no directory endpoint to leak through until 6C mounts one, and the cases start running by themselves the moment it does. §6.3 places 8A **in parallel with** the `6A → 6C → 6B → 6D` chain after 4B ("8A (needs 0064 via 6C or itself)"), so neither order may be assumed.
- **Migration numbers:** **0080–0086**, seven files, seven PRs (§3.4.3 "one migration per PR"), each with a hand-written `NNNN.down.sql`: `0080_alter_employee_extend.sql` (**T1**), `0081_create_employee_sensitive.sql` (**T3**), `0082_create_employee_statutory_profile.sql` (**T5**), `0083_create_pay_component_compensation.sql` (**T6**), `0084_create_statutory_scheme_rate_table.sql` (**T8**), `0085_create_company_hr_settings.sql` (**T11**), `0086_seed_permission_phase8a.sql` (**T2**). Migration 0086 is written in Task 2, out of numeric order, because `PERMISSION["hr.compensation.read"]` is a *compile* error before its catalogue row exists — the runner applies every **unapplied** file in version order and never assumes `max(version)` is its own last number (§3.4.1), so an 0086 applied before 0081 is normal and is what 6D's 0072 already did. **ADR numbers:** **0071–0073** — `0071-hr-field-encryption-envelope` (**a proposal**, spec:95 — it touches security and the data model), `0072-effective-dated-hr-rows-are-closed-not-edited`, `0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door`.
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, `readConfig`, `ApiConfig`, `ConfigError`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError` — and this slice's **two** allocated rows `ERR_HR_SELF_PAY` and `ERR_HR_SELF_VERIFY`), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `requirePermission`, `ScopeSource`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, `JobPayload`, `JobClient`, `eachTenant`, `registerHandler`, `runJob`, `JOB_PROBES`, **and the audit `table_name` sentinel paragraph — this slice registers the third sentinel**), §4.2.7 (`RouteModule`, `buildRoutes`, `IdempotencyHeader`, `createApp`, `AppDeps`, `PROBES`, `TENANT_FREE`), §4.2.8 (the common schemas, the list envelope, the cursor codec, **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`, `IdempotencyHeader`), §4.2.12 (`startApi`, `ApiRequest`, `StartedApi`), §4.2.13 (`SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES` — **this slice adds the `statutory` member and loader**), §3.4.8 (the sub-pack rule that assigns 8A `statutory`), §3.5.1 (the new-table recipe), §3.5.2 (**this slice adds the `sensitive_gate` rule**), §3.5.3 (the six pre-declared set memberships for this slice's tables), §3.6.1–§3.6.4 (the six codes and their grants), §4.5.6 (`app.actor_in_branch` and Form A′ — consumed, never re-attached), §4.5.7 (`app.party` — an employee extends a party of kind `employee`), §4.6.1 (the register rows for `employee`, `employee_sensitive`, `employee_statutory_profile`, `pay_component`, `pay_component_scheme`, `compensation_line`, `statutory_scheme`, `statutory_rate_table`, `company_hr_setting`), **§4.6.2 in full**, §4.12.1 (read only — 8B implements it; this slice ships the `RateTable` type it names), **§4.12.3 in full**, §4.12.4 (the synthetic table's shape), **§4.12.5 in full**, §4.14 (document-type codes — **none added, none seeded**), §4.15 (account codes — **none seeded, none consumed by literal**), §4.16 (report codes and `DatasetId` — **none**; the five HR reports are 8D's), §4.17 (`seedPayComponent`, `seedStatutoryScheme`, `seedRateTable` — this slice's three rows — plus `seedEmployee` under the §4.17 first-to-run rule), §4.17.1, §5 (all thirty-five hazards, **1 and 32 above all**), §6.1 rows **31, 32, 35**, §6.2 row **1056**.
- **Interfaces produced:** §4.6.1's rows for `employee_sensitive`, `employee_statutory_profile`, `pay_component`, `pay_component_scheme`, `compensation_line`, `statutory_scheme`, `statutory_rate_table` and `company_hr_setting`, implemented as written with the corrections Task 0 records; **§4.12.3 verbatim** as `packages/domain/payroll/rate-table.schema.json` and its generated `RateTable`; **§4.12.5 verbatim** as migration 0081 and `packages/db/src/hr/sensitive.ts`; §3.5.2's `sensitive_gate` linter rule; §3.6.2's six `hr` codes and §3.6.4's six role grants; §4.2.4's `ERR_HR_SELF_PAY` and `ERR_HR_SELF_VERIFY`; §4.2.6's `hr.rate_table.lapse_warning` handler, payload and probe, and the third audit sentinel; §4.2.13's `statutory` `SubPack` member and `statutoryLoader`; §4.17's `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`. Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-28** (⚠️ the statutory-profile field list, verified against LHDN's current publication — spec:2077) → **Task 5** (isolated; default **the fields the spec names plus `extra jsonb`**). **OD-23** (employer registration numbers; the accountant-signed rate tables) → **Task 11** (isolated; default **the settings row ships with no registration value and `packages/db/seed/my/statutory/<scheme>/` is empty**; every test runs on `SYNTH`). **OD-14** (⚠️ HR facts — levy, foreign workers, hourly/part-time staff, staff purchases on salary deduction — spec:2093, Part VII #14) → **Task 12** (isolated; default **none of the four is built**; the task states exactly what each adds). **OD-24** (screenshots and an operator description before any screen) → **Task 13** (isolated; default **the screen task is blocked, not the slice**). **OD-13 (the leave register) is not this slice's gate** — §2.12 assigns it to **8D**, and nothing leave-shaped is built here; the orchestrator's slice JSON lists OD-13 where the §2 card lists OD-28, and the contracts card and §2.12 govern (Task 0, amendment **A1**).
- **Part VI tests owned / re-run:** owns **32** (Task 4 for the endpoint, filter, sort, search, OpenAPI and direct-SQL channels; **Task 14 Steps 3–4 for the export channel**, behind amendment A20's `7C-FIRST` / `8A-FIRST` branch — §6.3 runs 8A and 7C in parallel, so `packages/db/src/export/` may not exist yet). Re-runs **31**'s R4 clause (Tasks 1, 5, 6, 7 — "a principal cannot alter their own compensation, sensitive data or leave approval"), **35**'s verify-not-load clause (Task 8 — "a rate table can be verified only by a principal other than the one who loaded it"; 8C owns the rest of 35), **12** and **13** and **36** for every new table, and **27**'s lint clause in CI. **§3.0.4 rows owned:** spec:1056 — Employee master (6C contributes the minimal master). **Regression files created / appended:** **creates none**; appends `— 8A` blocks to `tests/regression/legacy-029.test.ts`, `legacy-030.test.ts`, `legacy-033.test.ts`, `legacy-044.test.ts`, `legacy-045.test.ts` and `legacy-078.test.ts` — **all six created by 0B** (§3.7.3's Plan 0A-proven list names 029, 030, 033, 044; 0B's sixteen full files name 078; 045 is one of 0B's six structural files).
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14) — none, and no test-only code either.** This slice posts nothing; `PAYROLL` is 8B's. **Account codes (§4.15) — none seeded and none consumed by literal.** `pay_component.expense_account_id`, `pay_component.payable_account_id`, `statutory_scheme.payable_account_id` and `statutory_scheme.employer_expense_account_id` are **nullable** and are filled by **8B**'s `chart-of-accounts/8b-payroll.json` seed task (§4.12.2, hazard 33). Task 0 amendment **A2** records the `not null` correction on `statutory_scheme.payable_account_id`; tests that need an account call **1A's `seedAccount`** with a code of their own choosing from the already-seeded `0c-base.json` set and never invent a `24nn`. **Report codes (§4.16.1) and `DatasetId` members (§4.16.2) — none.** All five HR reports and all six HR datasets are **8D's** rows (§2.9). This slice does not widen `ReportCodeSchema`. **`fixtures.ts` helpers (§4.17) — exactly the three rows §4.17 assigns 8A** — `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable` — **plus `seedEmployee` under §4.17's first-to-run rule** (committed here only if 6C has not merged; otherwise verified and left alone — **with the fourth option `hiredOn?: string` that 6C's own amendment A12 already registers against §4.17's row**, re-recorded here as **A17** because under `8A-FIRST` this slice is the one that ships it), **plus one exported const, `SYNTH_RATE_TABLE_V1`**, registered by amendment **A5** because §4.17's `seedRateTable` row says its `definition` "defaults to `SYNTHETIC-TEST-v1`" and names no home for that value. **Shared test helpers (§4.17.1) — one new file, registered by amendment A6:** `tests/invariants/support/hr.ts` with `HrFixture`, `hrFixture` and `hrActor`, the one HR corpus 8B, 8C and 8D re-use.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

1. **No real statutory rate, threshold, ceiling or formula appears anywhere** — not in this plan, a migration, a test, a fixture, a seed file or a comment (spec:2080, hazard 1). The only table any test loads is `SYNTH` (§4.12.4), whose `source.authority` is the literal `"Dulja test fixture"`. `packages/db/seed/my/statutory/EPF/`, `/SOCSO/`, `/EIS/` and `/PCB/` ship **empty**, with a `.gitkeep` and a one-line README naming OD-23. A number in this plan that could be mistaken for a contribution rate is a defect.
2. **No invented LHDN or MyInvois detail** (hazard 2). The statutory-profile field list is ⚠️ OD-28 and Task 5 is written against the three fields **spec:2077 itself names** plus `extra jsonb`; no form name, box number, endpoint or threshold appears.
3. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). This slice writes **none** — no `postDocument` call appears in it. `posting-only-tables` (§3.7.5) is not extended and not touched.
4. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, `string` on the wire; quantities `numeric(19,6)` and `Quantity`. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. `compensation_line.amount`, every `RateTable` figure and every wire field carry `Money` or `string`. **`RateTable`'s own numbers are decimal strings** (§4.12.3, "All numbers are decimal **strings**") — a JSON Schema `"type": "number"` anywhere in `rate-table.schema.json` is a defect.
5. **Never SQL by string concatenation** (hazard 21). Every statement is a `tx`-tagged `postgres.js` template or a Drizzle read; `sql.unsafe` has exactly three homes and none is in this slice. The one `format()` in this slice's PL/pgSQL uses `%I` on a value that comes from `TG_ARGV`, a literal written in a migration file, never from a request.
6. **Never DDL from application code.** DDL lives only in `packages/db/migrations/NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql` (§3.4.2, §3.4.5). The break-glass rate-table load in Task 10 writes a **row**, never a table.
7. **Never hard-code a package version into a source file** — the lockfile owns versions (spec:104).
8. **Every new table** carries `tenant_id`, RLS via `app_meta.enable_tenant_rls`, FORCE RLS, `created_at`, the audit trigger via `app_meta.attach_audit` unless the table is in `AUDIT_EXEMPT`, `stamp_<col>` for every `*_by` column, composite `(tenant_id, x)` FKs, `unique (tenant_id, id)` (or `unique (tenant_id, <pk>)` for the two `NO_ID_TABLES` members), `snake_case` singular names, and a test that a second tenant cannot see it (§3.3, §3.5.1). **None of this slice's tables is in `AUDIT_EXEMPT` or `IMMUTABLE`** (§3.5.3): `employee_sensitive` is audited deliberately, because its before/after images are ciphertext.
9. **Every permission or branch gate is `AS RESTRICTIVE`** (spec:1370). `ALLOWED_PERMISSIVE` never grows; `sensitive_gate` and both `compensation_gate` policies are restrictive, and `extra_permissive_policy` is what proves it.
10. **A `*_by` column means "the acting principal, stamped by the server"** and nothing else (§3.3). `entered_by`, `loaded_by` and `verified_by` carry `app_meta.attach_stamp` — the write-once stamp, which raises `ERR_ACTOR_IMMUTABLE` on any later change. **`employee_sensitive.updated_by` is the one exception and carries a dedicated always-stamp trigger instead** (amendment **A19**, Task 3): the row is mutable by design — a bank account changes — so a write-once stamp would freeze the column at the *creator* forever while `updated_at` moved, which is precisely LEGACY-044's "attributable to the wrong user" shape. Either way the value comes from `app.current_actor()` and never from the caller; a column recording *whom* something is about is not named `*_by`.
11. **Per-tenant rows cannot be written by a migration** (hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so 0080–0085 create objects only and 0086 seeds `app.permission` (global). Pay components, statutory schemes, rate tables and the HR settings row are **seed-pack data** applied by `bun run seed --tenant <id> --only statutory`.
12. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly two `ERRORS` rows**, each landing in the same commit as the migration whose SQL text raises it (the 2B precedent, because `error-codes` scans `packages/db/migrations/**`): `ERR_HR_SELF_PAY` (409) with **0080**, `ERR_HR_SELF_VERIFY` (409) with **0084**. Everything else it raises is already shipped: `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_ACTOR_IMMUTABLE`, `ERR_IDEMPOTENCY_KEY_MISSING`, `ERR_INTERNAL`, and **`ERR_MONEY_CURRENCY_MISMATCH`** (0D's row, 422, §4.2.4 — 8A raises it from Task 7's compensation *handler* rather than from `Money`, which is why §4.2.4's "Raised by" column does not name a handler; the row already exists and no registry change is made). **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
13. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the six codes §3.6.2 assigns it and invents none. `hr.employee.read`, `hr.employee.manage` and `hr.attendance.record` are **6C's** and are consumed, never re-seeded; `hr.payroll.*` are 8B's and are not referenced here.
14. **No plan invents a literal in a shared namespace** (hazard 32). Every account code, document-type code, report code, `DatasetId` member, `fixtures.ts` helper name and `ERR_*` code this slice writes is in the Assumptions block's namespace list above; a literal not there is a review-blocking finding.
15. **Jobs run as the tenant's system principal** (hazard 20, spec:2179). `hr.rate_table.lapse_warning` builds its context with `systemContext()`, fans out with `eachTenant`, does its work in short `withTenant` transactions, and writes its warning as an `app.audit_log` row under the system principal.
16. **Every route needs a probe entry in `tests/invariants/probes.ts`**, keyed by its `RouteModule.path` (hazard 31), and every job payload carries `tenantId` and is probed the same way. This slice mounts **three** new modules and therefore adds **three** `PROBES` entries — **four under `8A-FIRST`**, because that branch makes 8A itself the creator of the `/v1/companies/:companyId/employees` module (T4 Step 4) and `tests/invariants/tenant-isolation.test.ts` fails the build on a `ROUTES` entry with no `PROBES` key. Its sub-paths on 6C's `employees` module inherit that module's existing key and add none. Its one job adds one `JOB_PROBES` entry.
17. **`fixtures.ts` is extended additively** (hazard 9) and only with the helpers §4.17 assigns this slice. No existing helper's parameters or return type changes.
18. **Owner-account tasks are written as "owner provides X; verify with `<exact command>`" with a local equivalent** (hazard 5). Tasks 11, 12 and 13 follow the pattern and none of them blocks the slice.
19. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [8A T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task — **with exactly one declared exception, open from Task 2 and closed at Task 10, and wholly contained inside one review batch (batch 2, which runs T2 through T10).** Task 2 seeds six catalogue codes, and §3.6.3's `permission-catalogue` rule fails on a catalogue code with no `PERMISSION.<code>` reference anywhere in the source. The first references are written by Tasks 4, 7 and 10, so `bun run lint:rules` reports **exactly those six codes** — and nothing else — as unreferenced at the end of Tasks 2 and 3, **three** at the end of Tasks 4, 5 and 6 (Task 4 closes `hr.employee.read_sensitive`, `hr.compensation.read` and `hr.compensation.manage` at once: two gate its routes and all three appear in the composed module's `permissions` array, which §3.6.3's rule counts), two at the end of Task 7, and **none from the end of Task 10 onward**. Each of those tasks' "run everything" step states the exact count it expects; the exception ends at Task 10. **The mitigation is batching, never a suppression, and never a red mainline** (6C's rule, 6c:5437, applied here to six codes and four modules): every count above is observed *inside* one branch, and the batch that carries T2 also carries T4, T7 and T10, so nothing merges while any of its own codes is unreferenced. The six catalogue rows are **not** moved into a later commit either, because `packages/db/test/permission-catalogue.test.ts` compares `app.permission` (seeded by migration 0086) against what `permissions.ts` exports in both directions — and migration 0081's `sensitive_gate` policy names `'hr.employee.read_sensitive'` as a literal `app.actor_has` resolves against `app.permission`, so a 0086 deferred past 0081 makes that gate false for everyone and kills every Task 3–7 test. The rows, the migration and the four consuming modules land in one batch or the plan does not work.
20. **This slice does not rewrite `AGENTS.md`'s "Current phase" section** — §3.8 names **8D** as Phase 8's closing slice.
21. **One migration per PR** (spec:2057). Seven migrations, seven PRs.

## This slice's share of the Phase 8 definition of done

Phase 8's DoD is one long sentence (spec:2294). Six of its clauses belong to 8B, 8C and 8D. **This slice owns two halves of one clause** — *"preparer ≠ approver is enforced by the data layer"* — and the §3.0.4 row for the employee master.

| Clause | Where it becomes true |
|---|---|
| **"preparer ≠ approver … data layer"**, the **sensitive-data** half | **Tasks 1, 3, 5, 6**: `app.forbid_self_pay()` is a trigger, not a handler check. A principal cannot write their own `compensation_line`, `employee_sensitive`, `employee_statutory_profile` row or their own `employee.terminated_on` — through the API, a job, or direct `app_rw` SQL. Proven in `tests/regression/legacy-045.test.ts` and in Task 7 Step 5's API case, both of which are test 31's R4 clause. |
| **"preparer ≠ approver … data layer"**, the **verify-not-load** half | **Task 8**: `app.assert_rate_table_verifier()` refuses `verified_at` set by the principal named in `loaded_by`, with `ERR_HR_SELF_VERIFY`, and freezes `definition` once verified. Proven by direct `app_rw` SQL, which is what "in the data layer" means. This is test **35**'s third clause; 8C owns the other two. |
| **§3.0.4 row spec:1056 — Employee master** | **Tasks 1, 3, 5**: the master carries position, employment type, hire and termination dates, home branch, the optional principal, the encrypted identity set and the effective-dated statutory profile. 6C contributes the minimal master (§6.2). |
| **Acceptance test 32** | **Task 4**, in `apps/api/test/routes/hr/sensitive.test.ts` and `tests/invariants/hr-sensitive-side-channels.test.ts`: no endpoint, filter, sort, search, OpenAPI schema or direct `app_rw` query under `withTenant` yields a sensitive or compensation field to a principal without the code. **The export channel is Task 14 Steps 3–4** — three gated `EXPORT_TABLES` rows and one appended invariant case, skipped when 7C has not merged (A20). |

**What is deliberately *not* in this slice's DoD share:** the calculator, the `PAYROLL` document, pinning and the golden payroll (**8B**); money out, `employee_ytd`, the statutory schedules and termination (**8C**); payslips, annual statements, the five HR reports, the ⚠️ leave register and the key **rotation** job (**8D**); and the one-month parallel run (**8D**).

## File Structure

```
packages/db/
  migrations/
    0080_alter_employee_extend.sql                          NEW  employee columns + forbid_self_pay      T1
    0080.down.sql                                           NEW                                          T1
    0081_create_employee_sensitive.sql                      NEW  §4.12.5 + sensitive_gate                T3
    0081.down.sql                                           NEW                                          T3
    0082_create_employee_statutory_profile.sql              NEW  ⚠️ OD-28                                 T5
    0082.down.sql                                           NEW                                          T5
    0083_create_pay_component_compensation.sql              NEW  three tables + two R4 triggers (A13)     T6
    0083.down.sql                                           NEW                                          T6
    0084_create_statutory_scheme_rate_table.sql             NEW  two tables + self-verify trigger
                                                                 + the deferred scheme FK (A13)           T8
    0084.down.sql                                           NEW                                          T8
    0085_create_company_hr_settings.sql                     NEW  ⚠️ OD-23                                 T11
    0085.down.sql                                           NEW                                          T11
    0086_seed_permission_phase8a.sql                        NEW  six hr codes                            T2
    0086.down.sql                                           NEW                                          T2
    0064_create_employee_minimal.sql                        NEW *only if 6C has not merged*              T1
    0064.down.sql                                           NEW *only if 6C has not merged*              T1
  src/
    lint-schema.ts                                          EDIT sensitive_gate rule + set memberships   T3
    hr/sensitive.ts                                         NEW  the AES-256-GCM envelope                T3
    hr/keys.ts                                              NEW  HrKey, HrKeyRing, createHrKeyRing       T3
    hr/config-error.ts                                      NEW  packages/db's own ConfigError           T3
    hr/employee-sensitive.ts                                NEW  read/write the row                      T3
    hr/statutory-profile.ts                                 NEW  effective-dated reads and writes         T5
    hr/compensation.ts                                      NEW  close-then-open, pay components          T6
    hr/statutory.ts                                         NEW  schemes, rate tables, verify, lapse      T8, T10
    hr/settings.ts                                          NEW  proration, pay day, registrations        T11
    hr/index.ts                                             NEW  the barrel                               T3
    schema/employee.ts                                      EDIT four columns                             T1
    schema/employee-sensitive.ts                            NEW  mirror                                   T3
    schema/employee-statutory-profile.ts                    NEW  mirror                                   T5
    schema/pay-component.ts                                 NEW  mirror (+ pay_component_scheme)          T6
    schema/compensation-line.ts                             NEW  mirror                                   T6
    schema/statutory-scheme.ts                              NEW  mirror                                   T8
    schema/statutory-rate-table.ts                          NEW  mirror                                   T8
    schema/company-hr-setting.ts                            NEW  mirror                                   T11
    seed/statutory.ts                                       NEW  the `statutory` PackLoader               T9
    seed/index.ts                                           EDIT export statutoryLoader                   T9
    seed/packs.ts                                           EDIT SubPack, SUB_PACKS, directories          T9
    jobs/payloads.ts                                        EDIT one key                                  T10
  seed/my/statutory/
    schemes.json                                            NEW  EPF, SOCSO, EIS, PCB — names only        T9
    pay-components.json                                     NEW  the six Malaysia components              T9
    EPF/.gitkeep, SOCSO/.gitkeep, EIS/.gitkeep, PCB/.gitkeep NEW  empty until OD-23                       T9
    README.md                                               NEW  the OD-23 rule, in the pack              T9
  test/
    fixtures.ts                                             EDIT seedPayComponent, seedStatutoryScheme,
                                                                 seedRateTable, SYNTH_RATE_TABLE_V1,
                                                                 (seedEmployee if 6C has not merged)      T1,T6,T8
    hr/employee-extend.test.ts                              NEW                                           T1
    hr/sensitive.test.ts                                    NEW                                           T3
    hr/statutory-profile.test.ts                            NEW                                           T5
    hr/compensation.test.ts                                 NEW                                           T6
    hr/statutory.test.ts                                    NEW                                           T8
    hr/statutory-loader.test.ts                             NEW                                           T9
    hr/company-hr-setting.test.ts                           NEW                                           T11
packages/domain/
  payroll/rate-table.schema.json                            NEW  §4.12.3 verbatim                         T9
  payroll/rate-table.ts                                     NEW  GENERATED — committed                    T9
  payroll/validate.ts                                       NEW  validateRateTable, parseRateTable         T9
  payroll/index.ts                                          NEW  the `./payroll` subpath barrel            T9
  scripts/generate-rate-table-type.ts                       NEW  the generator (dev only)                  T9
  package.json                                              EDIT "./payroll" export + rate-table:types     T9
  test/payroll/rate-table.test.ts                           NEW                                            T9
  test/payroll/dependency.test.ts                           NEW  core never imports payroll                T9
packages/contracts/
  permissions.ts                                            EDIT six PermissionDef rows                    T2
  src/errors.ts                                             EDIT two ERRORS rows                           T1,T8
  src/hr/employee.ts                                        EDIT position, employmentType, archivedAt      T1
  src/hr/sensitive.ts                                       NEW                                            T3
  src/hr/statutory-profile.ts                               NEW                                            T5
  src/hr/pay-component.ts                                   NEW                                            T6
  src/hr/compensation.ts                                    NEW                                            T6
  src/hr/statutory-scheme.ts                                NEW                                            T8
  src/hr/hr-setting.ts                                      NEW                                            T11
packages/db/seed/roles.ts                                   EDIT six grants                                T2
apps/api/src/
  config.ts                                                 EDIT two HR key names on ApiConfig             T3
  app.ts                                                    EDIT AppDeps gains hrKeys                      T3
  routes/hr/sensitive.ts                                    NEW  sub-paths on 6C's employees module        T4
  routes/hr/statutory-profiles.ts                           NEW  sub-paths on 6C's employees module        T5
  routes/hr/compensation.ts                                 NEW  sub-paths on 6C's employees module        T7
  routes/hr/pay-components.ts                               NEW  payComponentRoutes                        T7
  routes/hr/statutory-schemes.ts                            NEW  statutorySchemeRoutes                     T10
  routes/hr/hr-settings.ts                                  NEW  hrSettingRoutes                           T11
  routes/index.ts                                           EDIT buildRoutes deps + the ROUTES stub        T3
                                                            EDIT the composed employees module             T4
                                                            EDIT three modules in buildRoutes              T7,T10,T11
apps/api/test/
  support/app.ts                                            EDIT startApi builds hrKeys                    T3
  routes/hr/sensitive.test.ts                               NEW  test 32, the API half                     T4
  routes/hr/statutory-profiles.test.ts                      NEW                                            T5
  routes/hr/compensation.test.ts                            NEW  test 31's R4 clause through the API       T7
  routes/hr/pay-components.test.ts                          NEW                                            T7
  routes/hr/statutory-schemes.test.ts                       NEW                                            T10
  routes/hr/hr-settings.test.ts                             NEW                                            T11
apps/worker/src/jobs/rate-table-lapse.ts                    NEW  the handler                               T10
apps/worker/test/jobs/rate-table-lapse.test.ts              NEW                                            T10
apps/backoffice/src/screens/hr/                             NEW  ⚠️ OD-24 only                             T13
infra/src/secrets.ts                                        EDIT containerSecrets gains two names          T3
tests/
  invariants/probes.ts                                      EDIT three PROBES (four under 8A-FIRST:
                                                                 T4 adds the employees key it creates)
                                                                 + one JOB_PROBES                       T4,T7,T10,T11
  invariants/support/hr.ts                                  NEW  HrFixture, hrFixture, hrActor             T3
  invariants/hr-sensitive-side-channels.test.ts             NEW  test 32, the OpenAPI + SQL half           T4
                                                            EDIT the export case (7C-FIRST skips)         T14
  regression/legacy-029.test.ts                                EDIT append "— 8A"                             T14
  regression/legacy-030.test.ts                                EDIT append "— 8A"                             T14
  regression/legacy-033.test.ts                                EDIT append "— 8A"                             T14
  regression/legacy-044.test.ts                                EDIT append "— 8A"                             T14
  regression/legacy-045.test.ts                                EDIT append "— 8A"                             T14
  regression/legacy-078.test.ts                                EDIT append "— 8A"                             T14
packages/db/src/export/tables.ts                            EDIT *only under `7C-FIRST`* — three
                                                                 EXPORT_TABLES rows + the pin (A20)        T14
docs/adr/0071-hr-field-encryption-envelope.md               NEW  a PROPOSAL                                T3
docs/adr/0072-effective-dated-hr-rows-are-closed-not-edited.md NEW                                         T6
docs/adr/0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door.md NEW                            T9
```

---

### Task 0: Contracts amendments and the Phase 4 / 6C repository gate

**No code.** This task records the twenty names and corrections this plan needs that the contracts document either lacks or states inconsistently, and asserts the repository is in the state every later task assumes. §4.18's rule is that a plan writes down what it had to invent; hazard 32's rule is that an unregistered literal is a review-blocking finding. Doing both here means no later task pauses to decide.

**Files:**
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (§4.18 gains a Round 3 row block for 8A) — **or**, if the architect has not opened round 3, the table below is attached to the pull request of Task 1 as the amendment request. Nothing in this task changes source.

**Interfaces**

- Consumes: the whole contracts document.
- Produces: the amendment table below. Every later task cites its amendment by id.

- [ ] **Step 1: Record the twenty amendments**

| Id | § | Name or correction | Tasks |
|---|---|---|---|
| **A1** | 2.9 (8A card), 2.12 | **The 8A owner gates are OD-28, OD-14, OD-23 and OD-24 — not OD-13.** §2.12 gates OD-13 (the leave register) to **8D** and the 8A card names OD-28 in its place; the orchestrator's slice JSON lists OD-13. The card and the ledger govern, and this plan builds nothing leave-shaped: no `leave_type`, no `leave_entitlement`, no `leave_record`, no `public_holiday`, no `hr.leave.*` code. | header, T5, T11, T12, T13 |
| **A2** | 4.6.1 | **`statutory_scheme.payable_account_id` ships NULLABLE, not `not null`.** §4.6.1's row says `not null`; §4.12.2 and §4.15 give `2411`…`2414` and `5311`…`5314` to **8B**'s seed, and hazard 33 forbids 8A writing an account literal. A `not null` column with no legal value is unshippable. The column, `employer_expense_account_id`, `authority_party_id`, `pay_component.expense_account_id` and `pay_component.payable_account_id` are all nullable at 0083/0084; **8B's seed task fills them and 8B's `PAYROLL` policy fails closed with `ERR_POLICY_REQUIRES_MISSING` until it has.** Task 8 Step 3 carries a comment saying so on the column. | T6, T8 |
| **A3** | 4.6.1 | **`statutory_scheme` gains `employer_registration text`.** §4.6.1's `company_hr_setting` row calls it "the primary store" for the per-scheme employer registration number, but `statutory_scheme`'s own column list omits it. It is added in 0084. | T8, T11 |
| **A4** | 4.6.1 | **`company_hr_setting.employer_registrations jsonb` is dropped.** §4.6.1 describes it as "the display copy" of A3's column. spec:2088 says employer registration identifiers are "relational company settings … **never a blob**", and a second store with no rebuild path is exactly LEGACY-078's shape. `company_hr_setting` ships `proration_rule` and `pay_day` only; the registrations are read by joining `statutory_scheme`. | T11 |
| **A5** | 4.17, 4.12.4 | **`SYNTH_RATE_TABLE_V1` is an exported const of `packages/db/test/fixtures.ts`, owned by 8A**, and is what `seedRateTable`'s `definition` defaults to. §4.17 says the default is "`SYNTHETIC-TEST-v1`" and §4.12.4 puts the *file* (`packages/db/seed/test/statutory/SYNTH/v1.json`) in 8B; a fixture default cannot depend on a file a later slice writes. The const carries §4.12.4's three bands unchanged, and its `scheme` is **`SYNTH`** — the schema pattern `^[A-Z][A-Z0-9_]{1,15}$` admits no hyphen and no lower case, so `SYNTHETIC-TEST-v1` is the *label* §4.12.4 uses in prose, never a `scheme` value. 8B's file and this const carry identical numbers, and Task 9 Step 7's test asserts the const validates against the schema. | T8, T9 |
| **A6** | 4.17.1 | **`tests/invariants/support/hr.ts` is registered, owner 8A**, exporting `HrFixture`, **`hrFixture(api: StartedApi, name?: string)`** and `hrActor(f, role)` — and **nothing else**. `HrFixture` carries `sixC: boolean` (`"hr.employee.read" in PERMISSION` — the 6C branch as a repository fact, T3) and `schemeId: string` (one `SYNTH` `statutory_scheme`, appended in T8 with `seedStatutoryScheme` itself). **It takes the running API as a parameter and imports only its type** — `import type { StartedApi } from "../../../apps/api/test/support/app";` — because that is the settled shape for a §4.17.1 fixture that needs an API: 6A's `posFixture(api, name)`, 6C's `staffFixture(api, name)` and 7C's `reports-7c.ts` all do exactly this, and 7C states the rule outright (7c:1744 — *"The **type-only** `import type { StartedApi }` … is erased at compile time, exactly as 6A's `pos.ts` and 6C's `staff.ts` already do it"*), while §3.1's tier table lets the `tests` workspace reach `apps/api` only through `createApp()` and `./routes`. It needs a `StartedApi` and 2B's `grantCodes`, so it cannot live in `fixtures.ts` (§3.1). **It re-exports no other helper:** `problemOf` is 0B's and every consuming test file imports it from `tests/support/api` directly, which is what 4A (`4a:1118`), 6C (`6c:1763`, `6c:3670`) and 7C (`7c:4464`, `7c:5035`) already do from `apps/api/test/**` — 4A is merged before this slice by the Phase 4 gate, so the allowance those three rely on is a repository fact here, and a second spelling of one helper would be hazard 9. `hrFixture`'s **checker** holds `hr.statutory_table.verify` and `hr.statutory_table.manage`, plus `hr.employee.read` when `sixC` is true — the manage code is there so T10 can prove that a principal holding *both* codes still cannot verify what it loaded. 8B, 8C and 8D re-use the whole fixture; nothing else in the repository builds an HR corpus. | T3, T10, and every later task |
| **A7** | 4.2.7, 4.2.8 | **Three route modules are registered to 8A**, with their paths, router exports and gate codes: `/v1/companies/:companyId/pay-components` → `payComponentRoutes` (`hr.pay_component.manage`, `hr.compensation.read`); `/v1/companies/:companyId/statutory-schemes` → `statutorySchemeRoutes` (`hr.statutory_table.manage`, `hr.statutory_table.verify` — **and no third code**: §4.2.7 defines `RouteModule.permissions` as "every code this module evaluates", and Task 10's three routes evaluate exactly these two; `admin.company.manage` is the `hr-settings` module's gate and belongs on that row only); `/v1/companies/:companyId/hr-settings` → `hrSettingRoutes` (`admin.company.manage`). **Three `PROBES` keys, no sub-path key** (hazard 31). The six sub-paths on **6C's** `employees` module — `GET|PUT …/employees/{employeeId}/sensitive`, `GET|POST …/employees/{employeeId}/statutory-profiles`, `GET|POST …/employees/{employeeId}/compensation-lines` — inherit 6C's key. New §4.2.8 contracts modules: `hr/sensitive.ts`, `hr/statutory-profile.ts`, `hr/pay-component.ts`, `hr/compensation.ts`, `hr/statutory-scheme.ts`, `hr/hr-setting.ts`. | T4, T5, T7, T10, T11 |
| **A8** | 4.2.7, 4.2.12, 4.2.3, 3.11 | **`AppDeps` becomes SEVEN members — `hrKeys: HrKeyRing`** — on 2C's `objectStore` precedent and for the same reason: a route must not read a key out of `process.env`, and the ring must be swappable so `startApi()` can mint a deterministic test key. `ApiConfig` gains `hrFieldEncryptionKey: string` and `hrFieldEncryptionKeyPrevious: string | null`; §3.11's `HR_FIELD_ENCRYPTION_KEY` / `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` gain their **encoding**, fixed here: **base64 of exactly 32 bytes**, `ConfigError` naming the variable on any other length, and — like 2C's four R2 names — **optional when `APP_ENV=dev`** (a deterministic all-zero dev key, never in staging or production) and required otherwise. Both names join `containerSecrets(env, entrypoint)` in the same PR. | T3 |
| **A9** | 3.5.2 | **The `sensitive_gate` linter rule covers three tables, not one.** §3.5.2's registered condition is "`app.employee_sensitive` has no RESTRICTIVE policy named `sensitive_gate`". Test 32 (spec:2450) requires the *same* proof for `compensation_line` and `employee_statutory_profile` — "through any endpoint, filter, sort, search or export, checked over the OpenAPI document **and by direct `app_rw` query under `withTenant`**" — and a route check cannot satisfy a direct-SQL clause. The rule therefore holds a map `{ employee_sensitive: "sensitive_gate", compensation_line: "compensation_gate", employee_statutory_profile: "compensation_gate" }`, keeps its registered `rule` string `sensitive_gate`, and fires when a listed table has no RESTRICTIVE policy of its mapped name. | T3, T6 |
| **A10** | 4.2.6 | **`rate_table_lapse_warning` is the third audit `table_name` sentinel** (after 1B's `integrity_incident` and `month_end_ready`). `JobPayload["hr.rate_table.lapse_warning"]` is `{ companyId?: string; asOf?: string; horizonDays?: number }` — omit all three for the nightly whole-tenant run at the spec's sixty-day horizon (spec:2109). One `JOB_PROBES` entry. | T10 |
| **A11** | 3.1, 5.2 | **`packages/domain` gains a `"./payroll"` export subpath** pointing at `packages/domain/payroll/index.ts`. §5.2 (spec:2366) places `payroll/` beside `src/` inside `packages/domain` and says "core never imports HR"; without a second subpath either `packages/domain/src/index.ts` re-exports it (breaking that rule) or `packages/db` reaches in by relative path (breaking the package boundary). 0B's `dependency-rule` lint already checks the `src/**` → `payroll/**` prohibition; this is its packaging half. | T9 |
| **A12** | 4.2.13, 3.4.8, 4.12.4 | **`SubPack` gains `"statutory"`, last in `SUB_PACKS`**, with `statutoryLoader` exported from `packages/db/src/seed/index.ts`, `"statutory"` added to `PHASE_0_SUB_PACK_DIRECTORIES`, and `"statutory"` removed from `assertPackShape`'s `OWNED_ELSEWHERE` — the five edits 1A and 2C already made for `document-types` and `templates`. **The sub-pack directory holds three kinds of file**: `schemes.json` (scheme rows), `pay-components.json` (the component catalogue) and `<SCHEME>/vN.json` (rate tables). §4.12.4's sentence *"No file under `packages/db/seed/my/statutory/` exists until OD-23 supplies verified tables"* binds the **rate-table files** — the ones that carry figures — and Task 9 ships the four `<SCHEME>/` directories **empty**. Scheme names and component names carry no rate and ship now, because a rate table cannot be loaded without the scheme row it points at. **No second sub-pack named `pay-components` is created**: one loader, one directory, one `--only` flag. | T9 |
| **A13** | 4.6.1, 3.4.1 | **`app.pay_component_scheme.scheme_id` is an unconstrained FK *slot* in 0083 and gains its constraint in 0084**, on §4.3.4's already-registered precedent (`document_line.item_id` and `tax_code_id` are slots that 3A and 5A constrain later). §4.6.1's row states the join table with both FKs and the card puts it in 0083, but `app.statutory_scheme` does not exist until 0084 — as written the file cannot apply. The alternative, moving the table into 0084, would rename that file under §3.4.2 and split a two-table migration across a phase boundary for no gain. **0083 therefore creates three tables and 0084 adds one `alter table … add constraint pay_component_scheme_scheme_fk`**, and 0084's down drops that constraint before dropping `statutory_scheme`. | T6, T8 |
| **A14** | 4.6.1, 3.5.4 | **A `pay_component_scheme` row is never DELETEd.** §3.5.4 pins the `app_rw` DELETE list at five tables and hazard 25 makes a silent extension a review-blocking finding, so the slice that first needs to *withdraw* a mapping — 8B, when a scheme stops applying to a component mid-year — adds `archived_at timestamptz` by expand/contract and filters on it, rather than granting DELETE. **8A adds no removal path at all:** its rows arrive from the `statutory` sub-pack under OD-23 and the loader is `on conflict do nothing` (§3.4.8). Recorded here so 8B's writer does not reach for a grant. | T6, T8 |
| **A15** | 4.2.4 | **No `ERRORS` row and no wire token is added for an envelope failure.** The class the code ships is **`HrKeyError`** (`packages/db/src/hr/keys.ts`), a `packages/db`-local `Error` subclass in the same position `PostingError` occupies (§4.2.4's one declared exception) — but unlike `PostingError` it **carries no code property at all**, so there is nothing to map and **`apps/api/src/problem.ts` is not edited by this slice**: its default branch already answers `ERR_INTERNAL` for an unrecognised throw, which is the behaviour wanted. A failed decrypt means a wrong key, a tampered ciphertext or a moved row — an operator-visible incident, not a caller-actionable 4xx, and a wire code for it would tell an attacker which of the three happened. `packages/db` may not import `AppError` (§3.1) either way. **`ERR_HR_ENVELOPE` and `HrEncryptionError` are names an earlier draft of this table used and neither exists anywhere in the plan or the repository** — a grep for either must return nothing. | T3 |
| **A16** | 4.2.7 | **A sub-router is composed into another slice's module inside `buildRoutes`, never mounted onto its exported const.** 6C exports `employeeRoutes` and `employeeRouteModule` as **consts**, not factories, so `employeeRoutes.route(…)` at another module's import time is an import-order hazard and has no `deps` in scope. `apps/api/src/routes/hr/employees-composed.ts` therefore exports **`composeEmployeeRouter(hrKeys: HrKeyRing): OpenAPIHono<AppEnv>`**, which builds a fresh router, `.route("/", employeeRoutes)` and then the three 8A sub-routers, and `buildRoutes` spreads 6C's module with the composed router and the widened `permissions` array. 6C's two exports are untouched, which is what §4.1's "never rename what an earlier slice produced" requires. | T4, T5, T7 |
| **A17** | 4.17 | **`seedEmployee` carries a fourth option, `hiredOn?: string`** (default `'2026-01-05'`). §4.17's register row lists three; **6C's own amendment A12 already adds this one** under §4.17's closing rule, and it is re-recorded here because under the `8A-FIRST` branch **8A** is the slice that ships the helper and would otherwise ship a fourth option no 8A amendment names. Same option, same default, same position — the two slices must not diverge, which is the whole point of §4.6.2's and §4.17's first-to-run rules. No existing parameter and no return type changes. | T1 |
| **A18** | 4.2.8, 4.6.2, 4.17 | **`packages/contracts/src/hr/employee.ts` follows the same first-to-run rule as migration 0064 and `seedEmployee`.** §4.6.2 assigns the *table* to "whichever of 6C and 8A executes first" and §4.17 the *fixture*, but §4.2.8's contracts-module register names `hr/employee.ts` as 6C's outright — and 8A Task 1 Step 5 appends three wire fields to `EmployeeSchema`, which cannot append to a file that does not exist. Under `8A-FIRST`, Task 1 Step 1 therefore commits **6C's file verbatim** (`EmployeeSchema`, `CreateEmployeeBody`, `EmployeeQuery`, `EmployeeList`, `EmployeeDto`) before Step 5 extends it, and 6C's Task 3 Step 4 then takes its verification branch exactly as its Task 1 already does for 0064. Under `6C-FIRST` nothing is created. | T1 |
| **A19** | 4.12.5, 3.3 | **`employee_sensitive.updated_by` is stamped by a dedicated ALWAYS-stamp trigger, not by `app_meta.attach_stamp`.** §4.12.5 writes the column as `updated_by (stamped)` and says nothing about *which* stamp; Plan 0A's `app.stamp_actor` is a **write-once** stamp — on UPDATE it fills a NULL and raises `ERR_ACTOR_IMMUTABLE` on any change to a non-null value (plan0A:2369–2386). `employee_sensitive` is the one table in this slice whose rows are *edited* (a bank account changes; `writeSensitive` is an upsert), so `attach_stamp` would freeze the column at the **creator** for the life of the row while `updated_at` moved — a column that names the wrong principal, which is LEGACY-044's own shape. 0081 therefore creates `app.stamp_actor_always()` — the same `tg_argv[0]` + `jsonb_populate_record` shape as 0A's `app.stamp_actor()`, so it generalises to any column a later slice needs it for — and attaches it as the trigger **`stamp_updated_by`**, which sets the named column to `app.current_actor()` on **every** INSERT and UPDATE. **The trigger keeps the name `attach_stamp` would have given it**, so 0A's `stamp_actor` linter rule (which fires on a `*_by` column with no trigger *named* `stamp_<col>`, plan0A:2755-2758) is satisfied unchanged and this task's trigger-inventory assertion needs no edit. The value still never comes from the caller, which is all §3.3 requires; immutability was never the requirement. `entered_by`, `loaded_by` and `verified_by` — all write-once by design — keep `app_meta.attach_stamp`. `0081.down.sql` drops the trigger and the function. | T3 |
| **A20** | 4.6.1 (7C `export_job`), 6.3 | **8A's three `EXPORT_TABLES` rows follow a first-to-run branch, exactly as migration 0064 does.** 7C's handoff assigns 8A one row (7c:5858: *"**8A** adds one `EXPORT_TABLES` row … `NEVER_EXPORTED` already pins that table's `["*"]` so the row must narrow it deliberately"*), but §6.3 (contracts:4025) puts **8A on its own branch from 4B, parallel to `7A ─ 7B ─ 7C (needs 6D)`**, and contracts:4029 lists `8A → 8B ∥ … ∥ (7A → 7B)` — so `packages/db/src/export/` may not exist when this slice runs and 7C is more likely *later* than 8A, not earlier. **Under `7C-FIRST`** (`packages/db/src/export/tables.ts` present) Task 14 Step 3 adds three rows — `employee_sensitive` gated on `hr.employee.read_sensitive` with **metadata columns only**, `compensation_line` and `employee_statutory_profile` gated on `hr.compensation.read` — and narrows `NEVER_EXPORTED["employee_sensitive"]` from `["*"]` to the nine `*_enc` column names, which is what "narrow it deliberately" means and what 7C's own `expect(forbidden).not.toContain("*")` case (7c:3251) requires of a registered table. **Under `8A-FIRST`** nothing is added, the three tables are simply absent from the registry — which is 7C's safe default, since a table the registry does not name is never exported — and the rows are written into `docs/handoff/8a-to-8b.md` for whichever of 7C and 8D runs after both. The invariant case is `it.skipIf(!SEVEN_C)` and starts running by itself the moment the module lands, exactly as T4's two `sixC` cases do. | T14 |

- [ ] **Step 2: Assert the repository is at the Phase 4 gate**

```bash
cd "$REPO"
test -f packages/db/src/posting/post.ts            && echo "1A ok"
test -f packages/db/src/reports/trial-balance.ts   && echo "1B ok"
test -f packages/db/migrations/0017_create_party.sql && echo "2A ok"
test -f packages/db/src/attachment/object-store.ts && echo "2C ok"
test -f packages/db/migrations/0046_create_allocation.sql && echo "4A ok"
test -f packages/db/src/bank/reconcile.ts          && echo "4B ok"
bun run --cwd packages/db db:migrate && bun run --cwd packages/db db:lint
bun run lint && bun run lint:rules && bun run typecheck && bun run test
```

Expected: six `ok` lines, `0 violations`, and a wholly green suite. If any line is missing, **stop** — this plan's phase gate is not met and no later task's failing-test step will produce the failure it names.

- [ ] **Step 3: Decide and record the 6C branch**

```bash
ls packages/db/migrations/0064_create_employee_minimal.sql 2>/dev/null \
  && echo "6C-FIRST: 0064 exists; Task 1 verifies and does not create" \
  || echo "8A-FIRST: 0064 absent; Task 1 commits it and seedEmployee"
grep -c "export async function seedEmployee" packages/db/test/fixtures.ts || true
grep -c "employeeRouteModule" apps/api/src/routes/index.ts || true
```

Write the answer into the pull-request description of Task 1 as `6C branch: 6C-FIRST` or `6C branch: 8A-FIRST`. **Every later task reads it**: under `8A-FIRST` there is no `employeeRoutes` module to hang sub-paths on, so Tasks 4, 5 and 7 mount their sub-resources as a module of their own at `/v1/companies/:companyId/employees` — this plan's Task 4 Step 4 gives the exact conditional, and the module then becomes 6C's to extend rather than the reverse. Under `6C-FIRST` (the expected order — Phase 6 precedes Phase 8 in §6.3's default sequence) nothing conditional happens after Task 1.

- [ ] **Step 4: No commit**

This task produces no source change. If the amendment table above is filed as a contracts pull request, that PR's message is:

```
docs(contracts): record 8A's twenty amendments (A1-A20) [8A T0]

A1 OD-28 not OD-13; A2 statutory_scheme.payable_account_id is nullable; A3 employer_registration
on statutory_scheme; A4 drop the employer_registrations blob; A5 SYNTH_RATE_TABLE_V1 in fixtures.ts;
A6 tests/invariants/support/hr.ts, hrFixture(api, name?), no re-exports; A7 three route modules and
seven sub-paths; A8 AppDeps is seven members and the HR key encoding; A9 the sensitive_gate rule
covers three tables; A10 the third audit sentinel and the lapse payload; A11 the ./payroll subpath;
A12 the statutory sub-pack; A13 the deferred pay_component_scheme FK; A14 no DELETE path for a join
row; A15 no envelope error row and no problem.ts edit (the class is HrKeyError and carries no token);
A16 sub-routers are composed inside buildRoutes; A17 seedEmployee's hiredOn option (6C's A12);
A18 packages/contracts/src/hr/employee.ts follows the §4.6.2 first-to-run rule; A19 employee_sensitive
.updated_by is an ALWAYS stamp, not attach_stamp's write-once one; A20 the three EXPORT_TABLES rows
follow a 7C-FIRST / 8A-FIRST branch because §6.3 runs 8A and 7C in parallel.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 1: Migration 0080 — extend `app.employee`, `app.forbid_self_pay()`, and `ERR_HR_SELF_PAY`

**The R4 trigger function lands here, before any table needs it.** spec:2175 names four write targets — `compensation_line`, `employee_sensitive`, `employee_statutory_profile` and `employee.terminated_on` — and three of the four tables do not exist yet. One generic function created in 0080 and attached four times is one implementation of one rule; four copies would be four places to get it wrong. The fourth attachment, on `employee.terminated_on`, is made in this same file because the column already exists.

**The employee columns are §4.6.1's four**: `position`, `employment_type` (`full_time | part_time | contract | hourly`), `statutory_profile_note` and `archived_at` (spec:2049 — HR master data is archived, never deleted).

**Files:**
- Create: `packages/db/migrations/0080_alter_employee_extend.sql`, `packages/db/migrations/0080.down.sql`, `packages/db/test/hr/employee-extend.test.ts`
- Create **only under the `8A-FIRST` branch of Task 0 Step 3**: `packages/db/migrations/0064_create_employee_minimal.sql`, `packages/db/migrations/0064.down.sql`, `packages/db/src/schema/employee.ts`, `packages/contracts/src/hr/employee.ts` (amendment **A18**)
- Modify: `packages/db/src/schema/employee.ts` (four columns), `packages/contracts/src/errors.ts` (one `ERRORS` row), `packages/contracts/src/hr/employee.ts` (three wire fields), `packages/db/test/fixtures.ts` (**only under `8A-FIRST`**: `seedEmployee`)

**Interfaces**

- Consumes: `startDb`, `Db`, `Seed`, `seedTenant`, `withTenant` (test), `uuidv7`, `lintSchema`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `schemaFingerprint` (§4.1); `app_meta.attach_stamp`, `app.current_actor` (§4.1); `seedEmployee`, `seedBranch`, `seedParty` (§4.17); `ERRORS`, `ErrorDef` (§4.2.4); `EmployeeSchema` (6C, `packages/contracts/src/hr/employee.ts`).
- Produces:

```sql
create function app.forbid_self_pay() returns trigger;   -- trigger, PL/pgSQL; TG_ARGV[0] = the column holding the employee id
create trigger employee_no_self_pay before update of terminated_on on app.employee
  for each row execute function app.forbid_self_pay('id');
alter table app.employee add column position text, employment_type text, statutory_profile_note text, archived_at timestamptz;
```

```ts
// packages/contracts/src/errors.ts — ONE row, landing in this commit because 0080's SQL text raises the token
ERR_HR_SELF_PAY: { status: 409, title: "Self-pay refused", remedy: "Ask another principal with the HR permission to make this change." },
// packages/contracts/src/hr/employee.ts — three fields added to the EXISTING EmployeeSchema, additively
position: z.string().max(120).nullable(),
employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).nullable(),
archivedAt: TimestampSchema.nullable(),
```

- [ ] **Step 1: Take the 6C branch**

```bash
ls packages/db/migrations/0064_create_employee_minimal.sql 2>/dev/null \
  && echo "6C-FIRST" || echo "8A-FIRST"
```

Under **`8A-FIRST`**, first commit §4.6.2's file **verbatim** — the text is fixed by hazard 16 and by §4.6.2, and 6C's own Task 1 asserts it byte for byte:

`packages/db/migrations/0064_create_employee_minimal.sql`:

```sql
-- 0064_create_employee_minimal.sql — §3.10.1 "Employee master", the minimal master (spec:2075); cashiers are employees (spec:2097).
create table app.employee (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  party_id         uuid not null,                                  -- 1:1 with a party of kind 'employee'
  employee_number  text not null,
  home_branch_id   uuid not null,                                  -- BRANCH dimension value (spec:2075)
  principal_id     uuid unique references app.principal(id),       -- nullable 1:1: only staff who log in or sell (spec:2097)
  hired_on         date not null,
  terminated_on    date,                                           -- AFTER UPDATE OF terminated_on trigger arrives with 8C (migration 0093)
  created_at       timestamptz not null default now(),
  unique (company_id, employee_number),
  unique (party_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)     references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)       references app.party(tenant_id, id),
  foreign key (tenant_id, home_branch_id) references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.employee');
call app_meta.attach_audit('app.employee');
-- branch_isolation is attached by 0068 (6C) if this file ran before it, or here if 0068 already exists:
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'actor_in_branch') then
    execute 'create policy branch_isolation on app.employee as restrictive using (app.actor_in_branch(company_id, home_branch_id))';
  end if;
end $$;
```

`packages/db/migrations/0064.down.sql`: `drop table if exists app.employee;`

and add `seedEmployee` to `packages/db/test/fixtures.ts` **with 6C's four options** — the three §4.17's register lists plus `hiredOn?: string`, which **6C's amendment A12 registers against that row and this plan re-records as A17**, so the helper 8A ships and the helper 6C ships are the same helper:

```ts
/**
 * A minimal employee and the `party` of kind 'employee' it extends (§4.6.2; spec:2075, 2097).
 * Owned by 6C / 8A — whichever executes first commits it; the other extends its options additively.
 * `principalId` is left null unless given: only staff who log in or sell have one.
 */
export async function seedEmployee(
  db: Db,
  s: Seed,
  opts: { employeeNumber?: string; homeBranchId?: string; principalId?: string; hiredOn?: string } = {},
): Promise<string> {
  const employeeNumber = opts.employeeNumber ?? `E-${(await uuidv7(db.admin)).slice(-8)}`;
  const partyId = await seedParty(db, s, { kind: "employee", code: `EMP-${employeeNumber}` });
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.employee (id, tenant_id, company_id, party_id, employee_number, home_branch_id, principal_id, hired_on)
    values (${id}, ${s.tenant}, ${s.company}, ${partyId}, ${employeeNumber},
            ${opts.homeBranchId ?? s.hq}, ${opts.principalId ?? null}, ${opts.hiredOn ?? "2026-01-05"})`);
  return id;
}
```

together with the Drizzle mirror `packages/db/src/schema/employee.ts` exactly as 6C's Task 1 Step 7 writes it.

Still under **`8A-FIRST`**, commit **6C's contracts module verbatim** (amendment **A18**), because Step 5 appends three fields to `EmployeeSchema` and cannot append to a file that does not exist. This is 6C Task 3 Step 4's text unchanged, including its comment, which is what makes 6C's verification branch find what it asserts:

`packages/contracts/src/hr/employee.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

export const EmployeeSchema = z.object({
  id: UuidSchema,
  partyId: UuidSchema,
  employeeNumber: z.string().min(1).max(40),
  homeBranchId: UuidSchema,
  principalId: UuidSchema.nullable(),
  hiredOn: DateSchema,
  terminatedOn: DateSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("Employee");
// No `position`, `employmentType` or sensitive field: 8A adds the columns in 0080 and the wire fields with
// them (§4.6.1). A wire field for a column that does not exist is how a value gets silently dropped.

export const CreateEmployeeBody = z.object({
  employeeNumber: z.string().min(1).max(40),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  homeBranchId: UuidSchema,
  hiredOn: DateSchema,
}).openapi("CreateEmployeeBody");

export const EmployeeQuery = ListQuery.extend({
  "filter[homeBranchId][eq]": UuidSchema.optional(),
  "filter[active][eq]": z.enum(["true", "false"]).optional(),     // terminated_on is null
});
export const EmployeeList = ListEnvelope(EmployeeSchema);
export type EmployeeDto = z.infer<typeof EmployeeSchema>;
```

**No route is mounted for it here.** `employeeRoutes` and `employeeRouteModule` stay 6C's; under `8A-FIRST` the schemas exist so 8A's three fields have somewhere to land and 6C's Task 3 has a file to verify, and the `employees` module 8A mounts in Task 4 Step 4 carries only 8A's sub-paths until 6C adds the list and create routes.

Under **`6C-FIRST`**, create none of the five and go straight to Step 2.

- [ ] **Step 2: Write the failing test**

`packages/db/test/hr/employee-extend.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedBranch, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("migration 0080 — the employee master grows the §3.10.1 columns and the R4 guard", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "8a-emp-a"); b = await seedTenant(db, "8a-emp-b"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("carries position, employment_type, statutory_profile_note and archived_at", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'employee'
         and column_name in ('position', 'employment_type', 'statutory_profile_note', 'archived_at') order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(["archived_at", "employment_type", "position", "statutory_profile_note"]);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);   // expand, never contract (§3.4.7)
  });

  it("refuses an employment_type outside the four §4.6.1 values", async () => {
    const id = await seedEmployee(db, a, { employeeNumber: "E-KIND" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.employee set employment_type = 'intern' where id = ${id}`))
      .rejects.toThrow(/employee_employment_type_check/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.employee set employment_type = 'contract' where id = ${id}`)).resolves.toBeTruthy();
  });

  it("R4: a principal cannot terminate their own employee row (ERR_HR_SELF_PAY, spec:2175)", async () => {
    const self = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${self}, ${`sub-self-${self}`}, 'human', 'Self')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${self})`;
    });
    const mine = await seedEmployee(db, a, { employeeNumber: "E-SELF", principalId: self });
    await expect(withTenant(db.rw, a.tenant, self, (tx) => tx`
      update app.employee set terminated_on = '2026-06-30' where id = ${mine}`))
      .rejects.toThrow(/ERR_HR_SELF_PAY/);
    // another principal may
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.employee set terminated_on = '2026-06-30' where id = ${mine}`)).resolves.toBeTruthy();
  });

  it("R4 does not fire for an employee with no principal", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-NOPRIN" });
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.employee set terminated_on = '2026-07-31' where id = ${other}`)).resolves.toBeTruthy();
  });

  it("tenant B cannot see or archive tenant A's employee (test 12)", async () => {
    const branch = await seedBranch(db, b, { code: "BR-2" });
    expect(branch).toBeTruthy();
    const id = await seedEmployee(db, a, { employeeNumber: "E-ISO-80" });
    const rows = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.employee where id = ${id}`);
    expect(rows).toHaveLength(0);
    const res = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx`update app.employee set archived_at = now() where id = ${id}`);
    expect(res.count).toBe(0);
  });

  it("the schema linter reports zero violations after 0080", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/employee-extend.test.ts
```

Expected: **FAIL** — the first case reports `expect(received).toEqual(expected)` with `received: []`, because none of the four columns exists. Cases 2 and 3 fail with `column "employment_type" of relation "employee" does not exist`.

- [ ] **Step 4: Write `0080_alter_employee_extend.sql`**

```sql
-- ── 0080_alter_employee_extend.sql ──────────────────────────────────────────────────────────────
-- §3.10.1 "Employee master" (spec:2075): position, employment type, a statutory-profile note and
-- archived_at. Expand only — every column is nullable, so the deployment is one PR and not two
-- (§3.4.7). HR master data is archived, never deleted (spec:2049).
-- The same file creates app.forbid_self_pay(), the ONE implementation of §4.2.2 R4 (spec:2175),
-- and attaches it to employee.terminated_on. Migrations 0081, 0082 and 0083 attach the same
-- function to the other three write targets the rule names.

-- ── 1. The four columns ─────────────────────────────────────────────────────────────────────────
alter table app.employee add column position               text;
alter table app.employee add column employment_type        text;
alter table app.employee add column statutory_profile_note text;
alter table app.employee add column archived_at            timestamptz;

alter table app.employee add constraint employee_employment_type_check
  check (employment_type is null or employment_type in ('full_time', 'part_time', 'contract', 'hourly'));

comment on column app.employee.employment_type is
  '§4.6.1. Hourly and part-time staff are a payroll SCOPE question (OD-14, spec:2093): the label exists so the master can record what the owner already knows, and no calculator branches on it until 8B is told to.';
comment on column app.employee.statutory_profile_note is
  'Free text for the payroll officer. The statutory INPUTS live in app.employee_statutory_profile (migration 0082); this column never carries one.';

-- ── 2. R4 — no self-pay (spec:2175, LEGACY-045) ────────────────────────────────────────────────────
-- TG_ARGV[0] names the column of NEW that holds the employee id: 'id' on app.employee itself,
-- 'employee_id' on the three child tables. format(%I) is applied to a literal written in a
-- migration file and never to request input (§3.3, hazard 5 of the never list).
-- SECURITY INVOKER on purpose: the lookup must stay under RLS, and the row R4 is about — the
-- actor's OWN employee row — is always visible to that actor (their home branch is a branch they
-- are assigned to, and an unrestricted principal sees every branch). A SECURITY DEFINER here
-- would bypass tenant_isolation as well, which is a tenancy hole rather than a branch one.
create function app.forbid_self_pay() returns trigger language plpgsql as $$
declare
  v_employee_id uuid;
  v_principal   uuid;
begin
  execute format('select ($1).%I', tg_argv[0]) into v_employee_id using new;
  select e.principal_id into v_principal from app.employee e where e.id = v_employee_id;
  if v_principal is not null and v_principal = app.current_actor() then
    -- PL/pgSQL's RAISE placeholder is `%` and nothing else: a `%s` would emit the table name with a
    -- stray literal `s` after it ("their own compensation_lines row"). Two placeholders, two arguments.
    raise exception 'ERR_HR_SELF_PAY: principal % may not write their own % row (R4, spec:2175)',
      app.current_actor(), tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger employee_no_self_pay
  before update of terminated_on on app.employee
  for each row execute function app.forbid_self_pay('id');
```

`packages/db/migrations/0080.down.sql`:

```sql
-- A down that drops app.employee would violate §3.4.5's "down to 0 leaves zero tables in app" for
-- migration 0064, which owns the table. Only what 0080 added is removed.
drop trigger if exists employee_no_self_pay on app.employee;
drop function if exists app.forbid_self_pay();
alter table app.employee drop constraint if exists employee_employment_type_check;
alter table app.employee drop column if exists statutory_profile_note;
alter table app.employee drop column if exists archived_at;
alter table app.employee drop column if exists employment_type;
alter table app.employee drop column if exists position;
```

- [ ] **Step 5: Extend the Drizzle mirror and the wire schema**

`packages/db/src/schema/employee.ts` — four properties appended to the existing table object (never reordered):

```ts
  position: text("position"),
  employmentType: text("employment_type"),
  statutoryProfileNote: text("statutory_profile_note"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
```

`packages/contracts/src/hr/employee.ts` — three fields appended to `EmployeeSchema`, replacing 6C's comment that said 8A would do exactly this:

```ts
  position: z.string().max(120).nullable(),
  employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).nullable(),
  archivedAt: TimestampSchema.nullable(),
// `statutoryProfileNote` is deliberately NOT on the wire in 8A, and no 8A route reads or writes it:
// it is free text a payroll officer keeps about statutory handling, whereas the statutory INPUTS are
// the rows of app.employee_statutory_profile (migration 0082) that Task 5's sub-resource returns
// under hr.compensation.read. A later slice that needs the note on a payload appends it here.
```

and to `CreateEmployeeBody`, both optional:

```ts
  position: z.string().max(120).optional(),
  employmentType: z.enum(["full_time", "part_time", "contract", "hourly"]).optional(),
```

- [ ] **Step 6: Add the `ERR_HR_SELF_PAY` row**

`packages/contracts/src/errors.ts`, inside `ERRORS`, in the registry's own order (§4.2.4):

```ts
  ERR_HR_SELF_PAY: {
    status: 409,
    title: "Self-pay refused",
    remedy: "Ask another principal holding the HR permission to make this change; R4 forbids acting on your own HR record.",
  },
```

The `error-codes` lint (§3.7.5) is satisfied by the token in `0080_alter_employee_extend.sql`, which the rule scans — that is why the row and the migration are one commit.

- [ ] **Step 7: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run test -- test/hr/employee-extend.test.ts
cd ../.. && bun run lint && bun run lint:rules && bun run typecheck
bun run --cwd packages/contracts openapi:generate
```

Expected: 6 passing and `0 violations`. Under **`6C-FIRST`**, also a non-empty `openapi.json` diff carrying the three new `Employee` properties (spec:2055 requires the committed document to move with the API). Under **`8A-FIRST`** the diff is **empty and that is correct**: `EmployeeSchema` exists but no route references it yet, and the generator writes `components.schemas` from the mounted routes, and **no 8A route returns an `Employee`** — the sub-resources return their own schemas. Under `8A-FIRST` the three properties therefore reach the committed document only when **6C** mounts the first route that references `EmployeeSchema`, and 6C's own OpenAPI step is where the diff appears. Do not "fix" an empty diff by mounting a route here; 6C owns `employeeRoutes`.

```bash
git add packages/db/migrations/0080_alter_employee_extend.sql packages/db/migrations/0080.down.sql \
        packages/db/src/schema/employee.ts packages/db/test/hr/employee-extend.test.ts \
        packages/contracts/src/errors.ts packages/contracts/src/hr/employee.ts packages/contracts/openapi.json
git commit -m "$(cat <<'EOF'
feat(db): extend app.employee and create the one R4 no-self-pay trigger [8A T1]

Migration 0080 adds position, employment_type (four values), statutory_profile_note and
archived_at -- all nullable, so the change is expand-only (§3.4.7) and HR master data is archived
rather than deleted (spec:2049). The same file creates app.forbid_self_pay(), the single
implementation of §4.2.2 R4, and attaches it to employee.terminated_on; migrations 0081, 0082 and
0083 attach it to the other three write targets spec:2175 names. ERR_HR_SELF_PAY joins ERRORS in
this commit because 0080's SQL text is what raises the token and the error-codes lint scans it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

Under the `8A-FIRST` branch, Step 1's five files are a **separate, earlier commit** in the same PR (0064 is its own migration and §3.4.3's one-migration-per-PR rule makes it its own PR in fact):

```
feat(db): add the minimal app.employee, seedEmployee and the employee contracts module [8A T1]

Migration 0064, §4.6.2 verbatim, seedEmployee with the four options §4.17 plus 6C's amendment A12
name (re-recorded here as A17), and packages/contracts/src/hr/employee.ts verbatim from 6C's Task 3
Step 4 (amendment A18) so Step 5 has an EmployeeSchema to append to. Whichever of 6C and 8A executes
first commits all three; 8A ran first, so 6C's Task 1 and Task 3 will take their verification
branches and assert the fingerprint and the exports instead. No route is mounted: employeeRoutes
and employeeRouteModule stay 6C's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 2: Migration 0086 — the six permission codes, the catalogue rows and the role grants

**Six codes and no more** (§3.6.2, hazard 26): `hr.employee.read_sensitive`, `hr.compensation.read`, `hr.compensation.manage`, `hr.pay_component.manage`, `hr.statutory_table.manage`, `hr.statutory_table.verify` — the two `read*` non-mutating, the other four mutating. The catalogue is **global** migration data (§3.4.8, the one table a migration may write); the role grants are seed-pack data in `packages/db/seed/roles.ts`.

**This task is written out of numeric order deliberately.** `PERMISSION["hr.employee.read_sensitive"]` is a compile error until the row exists, and migration 0081's `sensitive_gate` policy names the code as a **string literal inside SQL** that `app.actor_has` resolves against `app.permission` at run time — a policy naming an unseeded code is the F-21 failure §3.4.8 warns about. Seeding first makes every later task compile and every later policy resolve.

**Files:**
- Create: `packages/db/migrations/0086_seed_permission_phase8a.sql`, `packages/db/migrations/0086.down.sql`
- Modify: `packages/contracts/permissions.ts` (six `PermissionDef` rows), `packages/db/seed/roles.ts` (six grants)

**Interfaces**

- Consumes: `app.permission` (§4.1), `PERMISSIONS`, `PermissionDef`, `PermissionModule`, `SliceId` (§4.2.5), `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (§4.2.5), `packages/db/test/permission-catalogue.test.ts` (0B's bidirectional check).
- Produces: six catalogue rows and six seeded grants. **`PERMISSION["hr.employee.read_sensitive"]`, `PERMISSION["hr.compensation.read"]`, `PERMISSION["hr.compensation.manage"]`, `PERMISSION["hr.pay_component.manage"]`, `PERMISSION["hr.statutory_table.manage"]` and `PERMISSION["hr.statutory_table.verify"]` become referenceable**, which is what lets Tasks 3–11 typecheck.

- [ ] **Step 1: Add the six rows to `permissions.ts` and run 0B's catalogue check to see it fail**

```ts
// packages/contracts/permissions.ts — six rows appended to PERMISSIONS, in §3.6.2's order
  { code: "hr.employee.read_sensitive", module: "hr", mutating: false, phase: "8A",
    description: "Read an employee's identity, bank and statutory reference numbers. Gated in the data layer by the sensitive_gate RLS policy, not only by this pre-flight — which is why it also gates the WRITE without being a mutating code: sensitive_gate has no `with check`, so its `using` predicate applies to writes too." },
  { code: "hr.compensation.read",       module: "hr", mutating: false, phase: "8A",
    description: "Read compensation lines and effective-dated statutory profiles. Posted payroll amounts are a different code (hr.payroll.read)." },
  { code: "hr.compensation.manage",     module: "hr", mutating: true,  phase: "8A",
    description: "Open and close compensation lines and statutory profiles, and write an employee's sensitive record. The sensitive write additionally passes sensitive_gate, which requires hr.employee.read_sensitive. R4 forbids acting on your own record." },
  { code: "hr.pay_component.manage",    module: "hr", mutating: true,  phase: "8A",
    description: "Maintain the pay-component catalogue and its statutory-scheme joins." },
  { code: "hr.statutory_table.manage",  module: "hr", mutating: true,  phase: "8A",
    description: "Break-glass load of a statutory rate table outside the seed pull request. The loader is recorded in loaded_by and cannot verify its own table." },
  { code: "hr.statutory_table.verify",  module: "hr", mutating: true,  phase: "8A",
    description: "Verify a loaded statutory rate table. Refused when the verifying principal is the one recorded in loaded_by (ERR_HR_SELF_VERIFY)." },
```

```bash
cd packages/db && bun run test -- test/permission-catalogue.test.ts
```

Expected: **FAIL** — six codes present in `PERMISSIONS` and absent from `app.permission`. That failure is this task's test; no new test file is written.

- [ ] **Step 2: Write `0086_seed_permission_phase8a.sql`**

```sql
-- 0086_seed_permission_phase8a.sql — §3.6.2's six 8A codes. app.permission is GLOBAL and has no RLS,
-- so it is the one table a migration may write (§3.4.8, hazard 10); every per-tenant row in this
-- slice is seed-pack data instead. This file is written before 0081-0085 on purpose: migration
-- 0081's sensitive_gate policy names 'hr.employee.read_sensitive' as a literal that app.actor_has
-- resolves against this table, and a policy naming an unseeded code resolves to false for everyone.
insert into app.permission (code, module, mutating, description) values
  ('hr.employee.read_sensitive', 'hr', false, 'Read an employee''s identity, bank and statutory reference numbers. Gated in the data layer by the sensitive_gate RLS policy, not only by this pre-flight — which is why it also gates the WRITE without being a mutating code: sensitive_gate has no `with check`, so its `using` predicate applies to writes too.'),
  ('hr.compensation.read',       'hr', false, 'Read compensation lines and effective-dated statutory profiles. Posted payroll amounts are a different code (hr.payroll.read).'),
  ('hr.compensation.manage',     'hr', true,  'Open and close compensation lines and statutory profiles, and write an employee''s sensitive record. The sensitive write additionally passes sensitive_gate, which requires hr.employee.read_sensitive. R4 forbids acting on your own record.'),
  ('hr.pay_component.manage',    'hr', true,  'Maintain the pay-component catalogue and its statutory-scheme joins.'),
  ('hr.statutory_table.manage',  'hr', true,  'Break-glass load of a statutory rate table outside the seed pull request. The loader is recorded in loaded_by and cannot verify its own table.'),
  ('hr.statutory_table.verify',  'hr', true,  'Verify a loaded statutory rate table. Refused when the verifying principal is the one recorded in loaded_by (ERR_HR_SELF_VERIFY).')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

`packages/db/migrations/0086.down.sql`:

```sql
delete from app.permission where code in
  ('hr.employee.read_sensitive', 'hr.compensation.read', 'hr.compensation.manage',
   'hr.pay_component.manage', 'hr.statutory_table.manage', 'hr.statutory_table.verify');
```

- [ ] **Step 3: Add the six role grants to `packages/db/seed/roles.ts`**

The spec's role table (spec:2162–2163) is the source; §3.6.4 requires each introducing slice to record its grants in the same PR:

| Code | Roles | The sentence it comes from |
|---|---|---|
| `hr.employee.read_sensitive` | `hr_payroll` | spec:2162 — *"Employee master **including sensitive data** (RLS-gated)"*. **`auditor` does not receive it**: spec:2163 says outright *"identity numbers and bank details (`hr.employee.read_sensitive` is not in the seed; a tenant may add it)"*. |
| `hr.compensation.read` | `hr_payroll` | spec:2162 — *"compensation and pay components"*. `user` is excluded by spec:2159's *"May not … see costs or compensation"*; `auditor` by spec:2163's *"no compensation or sensitive rows"*. |
| `hr.compensation.manage` | `hr_payroll` | spec:2162, same clause. R4 is what stops the officer touching their own row. |
| `hr.pay_component.manage` | `hr_payroll` | spec:2162 — *"compensation and **pay components**"*. |
| `hr.statutory_table.manage` | `hr_payroll` | spec:2162 — *"**load statutory tables** (a *different* principal verifies)"*. |
| `hr.statutory_table.verify` | `accountant` | spec:2160 — the accountant *"approve[s] and post[s] payroll as HR's checker; **verify[ies] statutory tables**"*. spec:2162's *"May not … verify a table they loaded"* is the same rule from the other side, and R6 makes the split structural. |

```ts
// packages/db/seed/roles.ts — additions only; no existing array is reordered.
//   hr_payroll: + "hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage",
//               "hr.pay_component.manage", "hr.statutory_table.manage"
//   accountant: + "hr.statutory_table.verify"
// `admin` is COMPUTED from PERMISSIONS and is never edited (§3.6.4).
```

- [ ] **Step 4: Prove R6 and R7 hold**

```bash
bun run --cwd packages/db db:migrate
bun run lint:rules
cd packages/db && bun run test -- test/permission-catalogue.test.ts
```

`role-seed` (§3.6.3) checks three things over the six new grants:

- **R6.** `INCOMPATIBLE_PAIRS` (§4.2.5) contains two pairs touching this slice: `["hr.statutory_table.manage", "hr.statutory_table.verify"]` and `["hr.employee.read_sensitive", "pos.ticket.sell"]`. The first is why `verify` goes to `accountant` and `manage` to `hr_payroll` and **not both to one role** — that split is the whole content of spec:2080's "`verified_by` must differ from `loaded_by`" at the seeded-role level, with the trigger of Task 8 as the run-time half. The second holds because `hr_payroll` holds no `pos.*` code at all.
- **R7, the role half.** `auditor` receives **none** of the six. Two of them are non-mutating and R7 would admit them, so this is a deliberate reading of spec:2163's own exclusion sentence, not an oversight.
- **R7, the route half.** §3.6.3 and §4.2.5 give R7 a second enforcement point: `assertRouteGates(app)` runs once inside `createApp`, after `ROUTES` are mounted, and **throws `ERR_ROUTE_GATE_READONLY` at boot when an unsafe method is gated by a `mutating: false` code**. Both of this slice's `read*` codes are `mutating: false` and §3.6.2 pins them there — `permission-catalogue.test.ts` compares `(code, module, mutating)` in both directions, so flipping one to `true` to make a `PUT` legal fails that suite instead. **The consequence is a design constraint on Task 4:** the sensitive sub-resource's `PUT` is gated by `hr.compensation.manage` (mutating) and its confidentiality is supplied by the `sensitive_gate` RLS policy, which requires `hr.employee.read_sensitive` on writes as well as reads because it carries no `with check`. Both codes go to `hr_payroll` in Step 3, so the payroll officer holds the pair; a principal holding only one of them is refused, by the middleware or by RLS respectively, and Task 4 has a case for each.
- No role holds a code absent from the catalogue — satisfied, because Step 1 and Step 2 land together.

**`permission-catalogue` will fail on exactly these six codes until Tasks 4, 7 and 10 land their route modules**, because a catalogue code with no `PERMISSION[…]` reference in `apps/**` is a build failure by design (spec:2135). The Execution handoff sequences this task and Tasks 4, 7 and 10 **inside one review batch**; the message to expect, and to ignore only until then, is:

```
permission-catalogue  hr.employee.read_sensitive is in the catalogue and is referenced nowhere
permission-catalogue  hr.compensation.read is in the catalogue and is referenced nowhere
permission-catalogue  hr.compensation.manage is in the catalogue and is referenced nowhere
permission-catalogue  hr.pay_component.manage is in the catalogue and is referenced nowhere
permission-catalogue  hr.statutory_table.manage is in the catalogue and is referenced nowhere
permission-catalogue  hr.statutory_table.verify is in the catalogue and is referenced nowhere
```

Six lines, no seventh. A seventh means a code was invented, which hazard 26 forbids.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0086_seed_permission_phase8a.sql packages/db/migrations/0086.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts
git commit -m "$(cat <<'EOF'
feat(db): seed the six 8A permission codes and their role grants [8A T2]

Migration 0086: hr.employee.read_sensitive and hr.compensation.read (non-mutating),
hr.compensation.manage, hr.pay_component.manage, hr.statutory_table.manage and
hr.statutory_table.verify. Grants per spec:2160-2163 -- hr_payroll owns the master, the
compensation catalogue and the break-glass load; the ACCOUNTANT verifies, because R6 forbids one
seeded role holding both halves of manage/verify and spec:2160 gives the accountant that duty.
auditor receives none: spec:2163 excludes identity numbers, bank details and compensation rows by
name. Seeded before 0081-0085 so migration 0081's sensitive_gate policy resolves the code it names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Migration 0081 — `app.employee_sensitive`, the `sensitive_gate` policy, the encryption envelope and ADR 0071

**The spec writes this policy for us, and it is copied character for character** (spec:2076). Everything about it is load-bearing: `AS RESTRICTIVE` because permissive policies OR together and a permissive gate would be voided by `tenant_isolation` (LEGACY-033); `app.actor_has(...)` because the system principal passes it, so 8D's rotation job and 8C's schedules still run; the sub-select joining `employee` because the table carries **no `company_id` of its own**; and no `with check` clause, because a policy without one uses its `using` expression for `with check` too, so the same predicate gates writes.

**The ciphertext never leaves one module.** `packages/db/src/hr/sensitive.ts` is the only file in the repository that calls `node:crypto`, and `packages/db/src/hr/keys.ts` is the only file that holds key bytes. Both are `packages/db`, not `apps/api`, because 8D's rotation job runs in `apps/worker` and §3.1 forbids an app importing an app.

**Files:**
- Create: `packages/db/migrations/0081_create_employee_sensitive.sql`, `packages/db/migrations/0081.down.sql`, `packages/db/src/hr/keys.ts`, `packages/db/src/hr/sensitive.ts`, `packages/db/src/hr/employee-sensitive.ts`, `packages/db/src/hr/index.ts`, `packages/db/src/schema/employee-sensitive.ts`, `packages/db/test/hr/sensitive.test.ts`, `tests/invariants/support/hr.ts`, `docs/adr/0071-hr-field-encryption-envelope.md`
- Modify: `packages/db/src/lint-schema.ts` (the `sensitive_gate` rule and the two set memberships), `packages/db/src/index.ts` (export the `hr` barrel), `apps/api/src/config.ts` (two `ApiConfig` members), `apps/api/src/app.ts` (`AppDeps` gains `hrKeys`; the `buildRoutes` call gains the key), `apps/api/src/routes/index.ts` (`buildRoutes`' parameter object and the derived `ROUTES` call gain `hrKeys`), **`apps/api/src/index.ts` (the production composition root builds the ring — one import and one member; without it `AppDeps`' new required member is missing from the only object literal that is served from, and `bun run typecheck` is red for the rest of the slice)**, `apps/api/test/support/app.ts` (`startApi` builds a test ring), `infra/src/secrets.ts` (`containerSecrets` gains two names)

**Interfaces**

- Consumes: `startDb`, `Db`, `Seed`, `seedTenant`, `withTenant` (test), `uuidv7`, `lintSchema`, `Violation`, `AUDIT_EXEMPT`, `IMMUTABLE` (§4.1); `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.forbid_self_pay` (Task 1); `seedEmployee`, `grantCodes` (§4.17); `PERMISSION` (Task 2); `ConfigError`, `readConfig`, `ApiConfig` (§4.2.3); `AppDeps`, `createApp` (§4.2.7); `startApi`, `StartedApi` (§4.2.12); `containerSecrets` (0C, §3.11).
- Produces:

```ts
// packages/db/src/hr/keys.ts
export interface HrKey { readonly version: number; readonly bytes: Buffer }              // bytes.length === 32
export interface HrKeyRing { current(): HrKey; forVersion(version: number): HrKey }
export class HrKeyError extends Error {}      // an operator fault: apps/api maps it to ERR_INTERNAL, never to a caller code
/** `current` and `previous` are base64 of EXACTLY 32 bytes (A8). Throws ConfigError naming the variable otherwise. */
export function createHrKeyRing(opts: { current: string; currentVersion: number; previous?: string | null; previousVersion?: number }): HrKeyRing;
export const HR_KEY_BYTES = 32;
export const DEV_HR_KEY: string;              // base64 of 32 zero bytes — usable ONLY when APP_ENV === "dev"

// packages/db/src/hr/sensitive.ts — the ONE module that calls node:crypto
export const SENSITIVE_FIELDS = [
  "national_id", "passport", "date_of_birth", "residency_category", "bank_account",
  "epf_number", "socso_number", "tax_number", "work_permit_expiry",
] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];
/** version(1) || nonce(12) || ciphertext || tag(16); AES-256-GCM; AAD = `${employeeId}:${field}` (§4.12.5). */
export function sealField(ring: HrKeyRing, employeeId: string, field: SensitiveField, plaintext: string): Buffer;
export function openField(ring: HrKeyRing, employeeId: string, field: SensitiveField, sealed: Buffer): string;

// packages/db/src/hr/employee-sensitive.ts
export type SensitiveValues = Partial<Record<SensitiveField, string | null>>;
export interface SensitiveRow { employeeId: string; keyVersion: number; updatedBy: string; updatedAt: string; values: SensitiveValues }
/** Returns null when the row is absent OR when RLS hid it — the caller cannot tell the two apart, which is the point (spec:2450). */
export function readSensitive(tx: Sql, ring: HrKeyRing, employeeId: string): Promise<SensitiveRow | null>;
/** Upserts only the fields present in `values`; a field set to null is cleared. Seals every touched field
 *  under `ring.current()`. `key_version` records the OLDEST version any column of the row still carries:
 *  a write that touches every field stamps the current version, a partial one never advances it (ADR 0071). */
export function writeSensitive(tx: Sql, ring: HrKeyRing, employeeId: string, values: SensitiveValues): Promise<void>;
```

```ts
// tests/invariants/support/hr.ts — amendment A6; the ONE HR corpus 8B, 8C and 8D re-use
export interface HrFixture {
  api: StartedApi; db: Db; seed: Seed;
  companyId: string;
  officer: string;      // principal holding every hr.* code 8A seeds, plus 6C's two when 6C has merged
  checker: string;      // principal holding hr.statutory_table.verify and .manage                (the accountant shape)
  outsider: string;     // principal holding hr.employee.read only, or nothing under 8A-FIRST     (the clerk shape)
  sixC: boolean;        // `"hr.employee.read" in PERMISSION` — 6C's routes and codes are present
  employees: { id: string; number: string; principalId: string | null }[];   // three: E-1001, E-1002, E-1003 (E-1003 IS `officer`)
  // schemeId: string   — appended by Task 8 Step 6, with `seedStatutoryScheme` itself
}
export function hrFixture(api: StartedApi, name?: string): Promise<HrFixture>;   // the caller owns the API (A6)
export function hrActor(f: HrFixture, who: "officer" | "checker" | "outsider"): string;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/hr/sensitive.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHrKeyRing, DEV_HR_KEY } from "../../src/hr/keys";
import { openField, sealField, SENSITIVE_FIELDS } from "../../src/hr/sensitive";
import { readSensitive, writeSensitive, type SensitiveValues } from "../../src/hr/employee-sensitive";
import { lintSchema } from "../../src/lint-schema";
import { grantCodes, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ring = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
/** A second, clearly synthetic key so the rotation case has two versions to move between. 8D's
 *  rotation job supplies the real pair through HR_FIELD_ENCRYPTION_KEY / …_PREVIOUS. */
const KEY_V2 = Buffer.alloc(32, 1).toString("base64");
const ringV2 = createHrKeyRing({ current: KEY_V2, currentVersion: 2, previous: DEV_HR_KEY, previousVersion: 1 });

describe("migration 0081 — employee_sensitive is ciphertext behind a RESTRICTIVE gate", () => {
  let db: Db; let a: Seed; let b: Seed; let holder: string; let holder2: string; let bystander: string; let employeeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-sens-a");
    b = await seedTenant(db, "8a-sens-b");
    holder = await uuidv7(db.admin); holder2 = await uuidv7(db.admin); bystander = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [id, name] of [[holder, "Holder"], [holder2, "Second holder"], [bystander, "Bystander"]] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${id}, ${`sub-${id}`}, 'human', ${name})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, { codes: ["hr.employee.read_sensitive"], principalId: holder, roleCode: "t-sens-holder" });
    // A SECOND holder of the same code, for the updated_by case below: A19's always-stamp is only
    // observable when a row is rewritten by somebody other than the principal that created it.
    await grantCodes(db, a, { codes: ["hr.employee.read_sensitive"], principalId: holder2, roleCode: "t-sens-holder-2" });
    // `bystander` is granted NOTHING. An earlier draft gave it `hr.employee.read`, which is 6C's
    // catalogue row (§3.6.2) and may not exist at all under the `8A-FIRST` branch — `grantCodes`
    // inserts `role_permission` rows that reference `app.permission`, so the grant would be a
    // foreign-key error in `beforeAll` and every case in this file would die in set-up. Nothing here
    // needs it: the cases below assert ZERO ROWS and a refused write, which is what a member holding
    // no HR code produces, and the gate under test is `hr.employee.read_sensitive` either way.
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-SENS" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("the envelope round-trips and is bound to the employee and the column (§4.12.5)", () => {
    const sealed = sealField(ring, employeeId, "national_id", "SYNTHETIC-ID-0001");
    expect(sealed[0]).toBe(1);                                  // version byte
    expect(sealed.length).toBe(1 + 12 + "SYNTHETIC-ID-0001".length + 16);
    expect(openField(ring, employeeId, "national_id", sealed)).toBe("SYNTHETIC-ID-0001");
    expect(() => openField(ring, employeeId, "passport", sealed)).toThrow();          // wrong AAD column
    expect(() => openField(ring, "00000000-0000-7000-8000-000000000000", "national_id", sealed)).toThrow();
  });

  it("a holder of hr.employee.read_sensitive can write and read every field back", async () => {
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ring, employeeId, { national_id: "SYNTHETIC-ID-0001", bank_account: "SYNTHETIC-ACC-9", work_permit_expiry: "2027-01-31" }));
    const row = await withTenant(db.rw, a.tenant, holder, (tx) => readSensitive(tx, ring, employeeId));
    expect(row?.values.national_id).toBe("SYNTHETIC-ID-0001");
    expect(row?.values.bank_account).toBe("SYNTHETIC-ACC-9");
    expect(row?.keyVersion).toBe(1);
    expect(row?.updatedBy).toBe(holder);                        // stamped, never supplied
  });

  it("updated_by names the LAST writer, not the first — the A19 always-stamp", async () => {
    // The case the write-once app_meta.attach_stamp would fail. Under attach_stamp this row's
    // updated_by would still read `holder` after the second write (a NULL -> value transition is the
    // only UPDATE it stamps, and any other change raises ERR_ACTOR_IMMUTABLE), so the column would
    // name the creator forever while updated_at moved — LEGACY-044's shape. app.stamp_actor_always()
    // is what makes the assertion below true, and this case is the only place it is observable.
    const before = await withTenant(db.rw, a.tenant, holder, (tx) => readSensitive(tx, ring, employeeId));
    expect(before?.updatedBy).toBe(holder);
    await withTenant(db.rw, a.tenant, holder2, (tx) =>
      writeSensitive(tx, ring, employeeId, { bank_account: "SYNTHETIC-ACC-CHANGED" }));
    const after = await withTenant(db.rw, a.tenant, holder2, (tx) => readSensitive(tx, ring, employeeId));
    expect(after?.updatedBy).toBe(holder2);                     // the SECOND writer, not the first
    expect(after?.updatedBy).not.toBe(holder);
    expect(after?.values.bank_account).toBe("SYNTHETIC-ACC-CHANGED");
    expect(after?.values.national_id).toBe("SYNTHETIC-ID-0001"); // an untouched field is untouched
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before!.updatedAt));
    // and a caller cannot supply it either: the trigger overwrites whatever arrives.
    await withTenant(db.rw, a.tenant, holder, (tx) => tx`
      update app.employee_sensitive set updated_by = ${holder2} where employee_id = ${employeeId}`);
    const [claimed] = await db.admin<{ updated_by: string }[]>`
      select updated_by from app.employee_sensitive where employee_id = ${employeeId}`;
    expect(claimed!.updated_by).toBe(holder);                   // the SESSION's actor, not the claim
  });

  it("a PARTIAL write under a newer key does not advance key_version; a FULL one does (ADR 0071)", async () => {
    const rot = await seedEmployee(db, a, { employeeNumber: "E-SENS-ROT" });
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ring, rot, { national_id: "SYNTHETIC-ID-ROT", passport: "SYNTHETIC-PP-ROT" }));
    // one field re-sealed under version 2; eight columns are still sealed under version 1
    await withTenant(db.rw, a.tenant, holder, (tx) => writeSensitive(tx, ringV2, rot, { national_id: "SYNTHETIC-ID-ROT2" }));
    const partial = await withTenant(db.rw, a.tenant, holder, (tx) => readSensitive(tx, ringV2, rot));
    expect(partial?.keyVersion).toBe(1);                        // the OLDEST version still in the row
    expect(partial?.values.national_id).toBe("SYNTHETIC-ID-ROT2");   // opened with the v2 key
    expect(partial?.values.passport).toBe("SYNTHETIC-PP-ROT");       // opened with the v1 key, from the same ring
    // a rotation batch re-seals every field, and only then does the row's stamp move
    await withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ringV2, rot, Object.fromEntries(
        SENSITIVE_FIELDS.map((f) => [f, partial!.values[f] ?? null])) as SensitiveValues));
    expect((await withTenant(db.rw, a.tenant, holder, (tx) => readSensitive(tx, ringV2, rot)))?.keyVersion).toBe(2);
  });

  it("what is stored is ciphertext — the plaintext is nowhere in the row (spec:2211)", async () => {
    const [raw] = await db.admin<{ hex: string }[]>`
      select encode(national_id_enc, 'hex') as hex from app.employee_sensitive where employee_id = ${employeeId}`;
    expect(raw!.hex).not.toContain(Buffer.from("SYNTHETIC-ID-0001", "utf8").toString("hex"));
  });

  it("sensitive_gate: a principal WITHOUT the code gets zero rows by direct app_rw SQL (test 32, LEGACY-033)", async () => {
    const rows = await withTenant(db.rw, a.tenant, bystander, (tx) =>
      tx<{ employee_id: string }[]>`select employee_id from app.employee_sensitive`);
    expect(rows).toHaveLength(0);
    expect(await withTenant(db.rw, a.tenant, bystander, (tx) => readSensitive(tx, ring, employeeId))).toBeNull();
  });

  it("sensitive_gate has no with check, so the same predicate refuses a WRITE", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-SENS-2" });
    await expect(withTenant(db.rw, a.tenant, bystander, (tx) =>
      writeSensitive(tx, ring, other, { national_id: "X" }))).rejects.toThrow(/row-level security|42501/);
  });

  it("the system principal passes the gate, so jobs still run (spec:2076)", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ employee_id: string }[]>`select employee_id from app.employee_sensitive`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("R4: a principal cannot write their own sensitive row (spec:2175)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-SENS-SELF", principalId: holder });
    await expect(withTenant(db.rw, a.tenant, holder, (tx) =>
      writeSensitive(tx, ring, mine, { national_id: "SYNTHETIC-ID-SELF" }))).rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("tenant B sees nothing of tenant A, code or no code (test 12)", async () => {
    const rows = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ employee_id: string }[]>`select employee_id from app.employee_sensitive where employee_id = ${employeeId}`);
    expect(rows).toHaveLength(0);
  });

  it("the table is audited, is not immutable, and has no id column (§3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'employee_sensitive'`;
    expect(cols.map((c) => c.column_name)).not.toContain("id");
    expect(cols.map((c) => c.column_name)).toContain("created_at");
    const trg = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relname = 'employee_sensitive'`;
    expect(trg.map((t) => t.tgname).sort()).toEqual(
      ["audit_row", "employee_sensitive_no_self_pay", "stamp_updated_by"].sort());
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'employee_sensitive'`;
    expect(n!.n).toBeGreaterThan(0);      // ciphertext before/after images are wanted (§3.5.3)
    const [audited] = await db.admin<{ after: Record<string, unknown> }[]>`
      select after from app.audit_log where table_name = 'employee_sensitive' order by seq desc limit 1`;
    expect(JSON.stringify(audited!.after)).not.toContain("SYNTHETIC-ID-0001");   // the image is ciphertext
  });

  it("the schema linter reports zero violations, and reports one when the gate is dropped", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    await db.admin`drop policy sensitive_gate on app.employee_sensitive`;
    const v = await lintSchema(db.admin);
    expect(v).toContainEqual({
      table: "employee_sensitive", rule: "sensitive_gate",
      detail: "no RESTRICTIVE policy named sensitive_gate (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)",
    });
    await db.admin`create policy sensitive_gate on app.employee_sensitive as restrictive
      using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)))`;
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/sensitive.test.ts
```

Expected: **FAIL** at import — `Cannot find module '../../src/hr/keys'`. Nothing in this file can run until Steps 3–6 land.

- [ ] **Step 3: Write `0081_create_employee_sensitive.sql`**

```sql
-- ── 0081_create_employee_sensitive.sql ─────────────────────────────────────────────────────────
-- §3.10.1 "Sensitive data" (spec:2076) and §4.12.5. Nine ciphertext columns under one key version,
-- keyed on employee_id (NO_ID_TABLES, §3.5.3) because there is exactly one row per employee.
-- The table deliberately carries NO company_id: the gate joins app.employee for it (spec:2076).

create table app.employee_sensitive (
  employee_id            uuid primary key,
  tenant_id              uuid not null references app.tenant(id),
  national_id_enc        bytea,
  passport_enc           bytea,
  date_of_birth_enc      bytea,
  residency_category_enc bytea,
  bank_account_enc       bytea,
  epf_number_enc         bytea,
  socso_number_enc       bytea,
  tax_number_enc         bytea,
  work_permit_expiry_enc bytea,
  key_version            smallint not null check (key_version > 0),
  updated_by             uuid not null default app.current_actor() references app.principal(id),   -- stamped
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  unique (tenant_id, employee_id),                            -- the NO_ID_TABLES form of unique (tenant_id, id)
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);

call app_meta.enable_tenant_rls('app.employee_sensitive');
call app_meta.attach_audit('app.employee_sensitive', 'tenant_column', 'employee_id');
-- ── updated_by: an ALWAYS stamp, deliberately NOT app_meta.attach_stamp (amendment A19) ─────────
-- Plan 0A's app.stamp_actor() is a WRITE-ONCE stamp: on UPDATE it fills a NULL and raises
-- ERR_ACTOR_IMMUTABLE on any change to a non-null value (plan0A:2369-2386). That is right for
-- entered_by / loaded_by / verified_by, which record one event each. It is WRONG here: this row is
-- edited -- a bank account changes, and writeSensitive() is an upsert -- so a write-once stamp would
-- pin updated_by to the CREATOR for the life of the row while updated_at moved, which is a column
-- naming the wrong principal (LEGACY-044). The trigger below stamps the session's actor on every INSERT
-- and every UPDATE. The value still never comes from the caller, which is all §3.3 requires; the
-- audit_log row images (and their own actor_id) remain the tamper-evident history.
-- Same signature shape as 0A's app.stamp_actor(): the column name arrives in TG_ARGV, a literal
-- written in this file, and the row is rebuilt with jsonb_populate_record rather than format() — so
-- no identifier is ever assembled from text (§3.3, hazard 21).
create function app.stamp_actor_always() returns trigger language plpgsql as $$
declare col text := tg_argv[0];
begin
  return jsonb_populate_record(new, jsonb_build_object(col, app.current_actor()));
end $$;
-- The trigger keeps the name attach_stamp would have given it, so the trigger inventory this task's
-- test asserts is unchanged. Both BEFORE triggers on this table fire in NAME order, so
-- `employee_sensitive_no_self_pay` runs first and R4 refuses a self-write before anything is stamped
-- ('e' < 's'). Do not rename either trigger without checking that order again.
create trigger stamp_updated_by
  before insert or update on app.employee_sensitive
  for each row execute function app.stamp_actor_always('updated_by');

-- ── The gate, spec:2076 VERBATIM ────────────────────────────────────────────────────────────────
-- AS RESTRICTIVE because permissive policies OR together and a permissive gate would be voided by
-- tenant_isolation (LEGACY-033). No `with check`: PostgreSQL then uses `using` for the write check too,
-- so one predicate gates read AND write. app.actor_has returns true for the system principal, so
-- 8C's schedules and 8D's key rotation still run (spec:2076).
create policy sensitive_gate on app.employee_sensitive as restrictive
  using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)));

-- ── R4 (spec:2175) ──────────────────────────────────────────────────────────────────────────────
create trigger employee_sensitive_no_self_pay
  before insert or update on app.employee_sensitive
  for each row execute function app.forbid_self_pay('employee_id');

-- updated_at is maintained by the writer, not a trigger: writeSensitive() sets it in the same
-- statement as the ciphertext, and app_rw holds UPDATE here (the row is mutable by design --
-- a bank account changes). No DELETE grant: spec:2049 admits none, and 8D's erasure workflow is
-- a separate, audited path.
comment on table app.employee_sensitive is
  '§3.10.1 spec:2076. Every *_enc column is version(1)||nonce(12)||ciphertext||tag(16), AES-256-GCM, AAD = employee_id:column. Sealed and opened ONLY by packages/db/src/hr/sensitive.ts (ADR 0071).';
```

`packages/db/migrations/0081.down.sql`:

```sql
drop trigger  if exists stamp_updated_by on app.employee_sensitive;
drop trigger  if exists employee_sensitive_no_self_pay on app.employee_sensitive;
drop policy   if exists sensitive_gate on app.employee_sensitive;
drop table    if exists app.employee_sensitive;
drop function if exists app.stamp_actor_always();   -- created by 0081; dropped after the table (A19)
```

- [ ] **Step 4: Extend `lint-schema.ts` — the `sensitive_gate` rule and the set memberships (§3.5.2, §3.5.3; amendment A9)**

```ts
/** Tables whose permission gate is a named RESTRICTIVE policy. Adding a row here makes a missing
 *  gate a build failure — §3.5.2's rule, widened to three tables by 8A amendment A9 because test 32
 *  (spec:2450) demands the same direct-SQL proof for compensation rows as for identity ones. */
const GATED_TABLES: ReadonlyMap<string, string> = new Map([
  ["employee_sensitive", "sensitive_gate"],
  ["compensation_line", "compensation_gate"],
  ["employee_statutory_profile", "compensation_gate"],
]);
```

and, inside the `for (const t of tables)` loop, immediately after the `extra_permissive_policy` block:

```ts
    const gate = GATED_TABLES.get(name);
    if (gate !== undefined) {
      const p = policies.find((x) => x.tablename === name && x.policyname === gate);
      if (p === undefined || p.permissive === "PERMISSIVE") {
        v.push({ table: name, rule: "sensitive_gate",
                 detail: `no RESTRICTIVE policy named ${gate} (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)` });
      }
    }
```

`NO_ID_TABLES` gains `"employee_sensitive"` and `"pay_component_scheme"` (§3.5.3 — the second lands with Task 6 but both memberships are written here, in one edit of the hotspot file, exactly as §3.5.3 requires a plan to "edit the sets to exactly this state"):

```ts
const NO_ID_TABLES = new Set([
  "membership", "role_permission", "role_assignment", "role_assignment_branch", "ledger_entry_dimension",
  "document_series", "document_number_void", "idempotency_key", "audit_log", "permission",
  // Append the two names below to the END of the existing set literal, leaving every entry earlier
  // slices added exactly where it is: this file is §3.5.3's merge hotspot and a reordered set is a
  // conflict every parallel plan has to resolve by hand. Do not retype the lines above from this plan
  // — they are the 0A members, quoted so the insertion point is unambiguous, and later slices have
  // added more between them and here.
  "employee_sensitive", "pay_component_scheme",
]);
```

`NO_CREATED_AT_TABLES` is **derived** (`new Set([...NO_ID_TABLES, "ledger_entry"])`, §3.5.3) and is not edited — both tables therefore stop *requiring* `created_at`, and `employee_sensitive` carries one anyway because spec:106 asks every new table for one and the rule only requires, never forbids. `AUDIT_EXEMPT` and `IMMUTABLE` are **not** touched: §3.5.3 puts none of this slice's tables in either.

- [ ] **Step 5: Write the key ring and the envelope**

`packages/db/src/hr/keys.ts`:

```ts
import { ConfigError } from "./config-error";

export const HR_KEY_BYTES = 32;
/** base64 of 32 zero bytes. Legal ONLY when APP_ENV === "dev" — readConfig() refuses it elsewhere. */
export const DEV_HR_KEY = Buffer.alloc(HR_KEY_BYTES).toString("base64");

export interface HrKey { readonly version: number; readonly bytes: Buffer }
export interface HrKeyRing { current(): HrKey; forVersion(version: number): HrKey }
/** An operator fault (a row sealed under a key the process was not given), never a caller fault:
 *  apps/api's problem.ts leaves it unmapped and it surfaces as ERR_INTERNAL with the version logged. */
export class HrKeyError extends Error {}

function decode(name: string, b64: string): Buffer {
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, "base64"); }
  catch { throw new ConfigError(`${name} is not valid base64 (§3.11, 8A amendment A8)`); }
  if (bytes.length !== HR_KEY_BYTES) {
    throw new ConfigError(`${name} decodes to ${bytes.length} bytes; exactly ${HR_KEY_BYTES} are required (§3.11, 8A amendment A8)`);
  }
  return bytes;
}

export function createHrKeyRing(opts: {
  current: string; currentVersion: number; previous?: string | null; previousVersion?: number;
}): HrKeyRing {
  if (!Number.isInteger(opts.currentVersion) || opts.currentVersion < 1) {
    throw new ConfigError("HR key currentVersion must be a positive integer");
  }
  const keys = new Map<number, HrKey>();
  keys.set(opts.currentVersion, { version: opts.currentVersion, bytes: decode("HR_FIELD_ENCRYPTION_KEY", opts.current) });
  if (opts.previous != null && opts.previous !== "") {
    const pv = opts.previousVersion ?? opts.currentVersion - 1;
    if (pv < 1) throw new ConfigError("HR_FIELD_ENCRYPTION_KEY_PREVIOUS was supplied with no usable version");
    keys.set(pv, { version: pv, bytes: decode("HR_FIELD_ENCRYPTION_KEY_PREVIOUS", opts.previous) });
  }
  const cur = keys.get(opts.currentVersion)!;
  return {
    current: () => cur,
    forVersion(version) {
      const k = keys.get(version);
      if (k === undefined) throw new HrKeyError(`no HR key for version ${version}; supply HR_FIELD_ENCRYPTION_KEY_PREVIOUS or run hr.encryption_key.rotate`);
      return k;
    },
  };
}
```

**`ConfigError` lives in `apps/api/src/config.ts` and `packages/db` may not import an app** (§3.1). `packages/db/src/hr/config-error.ts` therefore declares the class this package throws:

```ts
/** packages/db's own configuration error. apps/api's problem.ts already has an asAppError branch for
 *  a class named ConfigError; this one satisfies it structurally and closes no dependency cycle. */
export class ConfigError extends Error {}
```

`packages/db/src/hr/sensitive.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HrKeyError, type HrKeyRing } from "./keys";

export const SENSITIVE_FIELDS = [
  "national_id", "passport", "date_of_birth", "residency_category", "bank_account",
  "epf_number", "socso_number", "tax_number", "work_permit_expiry",
] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const aad = (employeeId: string, field: SensitiveField): Buffer => Buffer.from(`${employeeId}:${field}`, "utf8");

/** version(1) || nonce(12) || ciphertext || tag(16) — §4.12.5, AES-256-GCM. */
export function sealField(ring: HrKeyRing, employeeId: string, field: SensitiveField, plaintext: string): Buffer {
  const key = ring.current();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(employeeId, field));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([key.version]), nonce, body, cipher.getAuthTag()]);
}

export function openField(ring: HrKeyRing, employeeId: string, field: SensitiveField, sealed: Buffer): string {
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new HrKeyError(`sealed ${field} is ${sealed.length} bytes — too short to be an envelope`);
  const key = ring.forVersion(sealed[0]!);
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const body = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(employeeId, field));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  // decipher.final() throws on a tag mismatch, which is what makes the AAD binding real: a row moved
  // to another employee, or a column value copied into another column, cannot be opened.
}
```

`packages/db/src/hr/employee-sensitive.ts`:

```ts
import type { Sql } from "postgres";
import { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";
import type { HrKeyRing } from "./keys";

export type SensitiveValues = Partial<Record<SensitiveField, string | null>>;
export interface SensitiveRow {
  employeeId: string; keyVersion: number; updatedBy: string; updatedAt: string; values: SensitiveValues;
}
interface Raw { employee_id: string; key_version: number; updated_by: string; updated_at: string;
  national_id_enc: Buffer | null; passport_enc: Buffer | null; date_of_birth_enc: Buffer | null;
  residency_category_enc: Buffer | null; bank_account_enc: Buffer | null; epf_number_enc: Buffer | null;
  socso_number_enc: Buffer | null; tax_number_enc: Buffer | null; work_permit_expiry_enc: Buffer | null }

/** null means "absent OR hidden by sensitive_gate" — indistinguishable on purpose (spec:2450). */
export async function readSensitive(tx: Sql, ring: HrKeyRing, employeeId: string): Promise<SensitiveRow | null> {
  const [row] = await tx<Raw[]>`
    select employee_id, key_version, updated_by, updated_at,
           national_id_enc, passport_enc, date_of_birth_enc, residency_category_enc, bank_account_enc,
           epf_number_enc, socso_number_enc, tax_number_enc, work_permit_expiry_enc
      from app.employee_sensitive where employee_id = ${employeeId}`;
  if (row === undefined) return null;
  const values: SensitiveValues = {};
  for (const f of SENSITIVE_FIELDS) {
    const sealed = row[`${f}_enc` as keyof Raw] as Buffer | null;
    values[f] = sealed === null ? null : openField(ring, employeeId, f, sealed);
  }
  return { employeeId: row.employee_id, keyVersion: row.key_version, updatedBy: row.updated_by, updatedAt: row.updated_at, values };
}

/** Upserts the fields present in `values` and leaves the rest alone; an explicit null clears one.
 *  Every touched field is sealed under the ring's CURRENT key and `key_version` is never accepted
 *  from a caller.
 *
 *  **`key_version` is the OLDEST version any column of the row still carries, not the newest.** A
 *  partial write during or after a rotation re-seals only what it touched, so a row whose eight
 *  untouched columns are still version 1 must not claim version 2: 8D's `hr.encryption_key.rotate`
 *  scans by this column, and a row that over-claimed would be skipped and then become unreadable the
 *  day `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` is retired (`HrKeyError` from `forVersion`). `least()`
 *  therefore holds it down — except on a FULL write, which is exactly what a rotation batch performs:
 *  every column is re-sealed, so the row genuinely is at the current version and `least()` would
 *  otherwise pin it at the old one forever and make the rotation a no-op. Decryption never depends on
 *  this column either way — `openField` reads the version from each envelope's own leading byte
 *  (ADR 0071). */
export async function writeSensitive(tx: Sql, ring: HrKeyRing, employeeId: string, values: SensitiveValues): Promise<void> {
  const version = ring.current().version;
  const sealedOf = (f: SensitiveField): Buffer | null => {
    const v = values[f];
    return v === undefined || v === null ? null : sealField(ring, employeeId, f, v);
  };
  const touched = SENSITIVE_FIELDS.filter((f) => values[f] !== undefined);
  const full = touched.length === SENSITIVE_FIELDS.length;
  await tx`
    insert into app.employee_sensitive (
      employee_id, tenant_id, key_version,
      national_id_enc, passport_enc, date_of_birth_enc, residency_category_enc, bank_account_enc,
      epf_number_enc, socso_number_enc, tax_number_enc, work_permit_expiry_enc)
    select ${employeeId}, e.tenant_id, ${version},
      ${sealedOf("national_id")}, ${sealedOf("passport")}, ${sealedOf("date_of_birth")},
      ${sealedOf("residency_category")}, ${sealedOf("bank_account")}, ${sealedOf("epf_number")},
      ${sealedOf("socso_number")}, ${sealedOf("tax_number")}, ${sealedOf("work_permit_expiry")}
      from app.employee e where e.id = ${employeeId}
    on conflict (employee_id) do update set
      key_version            = case when ${full} then excluded.key_version
                                    else least(app.employee_sensitive.key_version, excluded.key_version) end,
      updated_at             = now(),
      -- `updated_by` is deliberately NOT in this list: migration 0081's `stamp_updated_by` trigger
      -- sets it to app.current_actor() on every INSERT and every UPDATE (amendment A19), so naming it
      -- here would be a second place for the same value and the first place for it to drift. A caller
      -- cannot supply it through this statement or any other.
      national_id_enc        = case when ${touched.includes("national_id")}        then excluded.national_id_enc        else app.employee_sensitive.national_id_enc end,
      passport_enc           = case when ${touched.includes("passport")}           then excluded.passport_enc           else app.employee_sensitive.passport_enc end,
      date_of_birth_enc      = case when ${touched.includes("date_of_birth")}      then excluded.date_of_birth_enc      else app.employee_sensitive.date_of_birth_enc end,
      residency_category_enc = case when ${touched.includes("residency_category")} then excluded.residency_category_enc else app.employee_sensitive.residency_category_enc end,
      bank_account_enc       = case when ${touched.includes("bank_account")}       then excluded.bank_account_enc       else app.employee_sensitive.bank_account_enc end,
      epf_number_enc         = case when ${touched.includes("epf_number")}         then excluded.epf_number_enc         else app.employee_sensitive.epf_number_enc end,
      socso_number_enc       = case when ${touched.includes("socso_number")}       then excluded.socso_number_enc       else app.employee_sensitive.socso_number_enc end,
      tax_number_enc         = case when ${touched.includes("tax_number")}         then excluded.tax_number_enc         else app.employee_sensitive.tax_number_enc end,
      work_permit_expiry_enc = case when ${touched.includes("work_permit_expiry")} then excluded.work_permit_expiry_enc else app.employee_sensitive.work_permit_expiry_enc end`;
}
```

**Why the insert is `insert … select … from app.employee`** rather than a values list: `tenant_id` must come from the employee row rather than from the caller, so a caller cannot write a row into another tenant even before RLS refuses it, and the `select` returns no row for an employee the reader cannot see — which turns "write to an invisible employee" into a silent no-op rather than a foreign-key error that leaks existence.

`packages/db/src/hr/index.ts`:

```ts
export { createHrKeyRing, DEV_HR_KEY, HR_KEY_BYTES, HrKeyError, type HrKey, type HrKeyRing } from "./keys";
export { ConfigError } from "./config-error";
export { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";
export { readSensitive, writeSensitive, type SensitiveRow, type SensitiveValues } from "./employee-sensitive";
```

and `packages/db/src/index.ts` gains one line: `export * from "./hr";` — this is the **main** barrel, not the seed barrel, so §3.1's `legacy-039` rule is untouched (no `./seed` path appears).

- [ ] **Step 6: Write the Drizzle mirror**

`packages/db/src/schema/employee-sensitive.ts`:

```ts
import { customType, pgSchema, smallint, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const employeeSensitive = app.table("employee_sensitive", {
  employeeId: uuid("employee_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  nationalIdEnc: bytea("national_id_enc"),
  passportEnc: bytea("passport_enc"),
  dateOfBirthEnc: bytea("date_of_birth_enc"),
  residencyCategoryEnc: bytea("residency_category_enc"),
  bankAccountEnc: bytea("bank_account_enc"),
  epfNumberEnc: bytea("epf_number_enc"),
  socsoNumberEnc: bytea("socso_number_enc"),
  taxNumberEnc: bytea("tax_number_enc"),
  workPermitExpiryEnc: bytea("work_permit_expiry_enc"),
  keyVersion: smallint("key_version").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 7: Wire the key into `ApiConfig`, `AppDeps`, the composition root, `startApi` and `containerSecrets` (amendment A8)**

`apps/api/src/config.ts` — two members on `ApiConfig` and their reader:

```ts
  readonly hrFieldEncryptionKey: string;             // base64 of exactly 32 bytes (§3.11, A8)
  readonly hrFieldEncryptionKeyPrevious: string | null;
```

```ts
// inside readConfig(), following the shape 2C's four R2 names already use. `appEnv` is NOT re-derived:
// read the local the existing APP_ENV branch immediately above already computed and insert these lines
// after it, so there is one parse of APP_ENV in the file and not two that can disagree.
const hrKey = env.HR_FIELD_ENCRYPTION_KEY ?? (appEnv === "dev" ? DEV_HR_KEY : undefined);
if (hrKey === undefined) {
  throw new ConfigError("HR_FIELD_ENCRYPTION_KEY is required when APP_ENV is not 'dev' (§3.11; employee_sensitive has nowhere to go without it)");
}
// …_PREVIOUS is never required and is never defaulted: it exists only while 8D's rotation is running,
// and an absent one is the normal state. It is passed through verbatim; `createHrKeyRing` is what
// validates its length, so a bad value is reported by the same message as a bad current key.
```

and both members are placed on the object `readConfig()` returns, beside the ones already there — a
declared member that is never assigned is a `strict` typecheck failure, not a nicety:

```ts
  // inside the returned config literal
  hrFieldEncryptionKey: hrKey,
  hrFieldEncryptionKeyPrevious: env.HR_FIELD_ENCRYPTION_KEY_PREVIOUS ?? null,
```

`apps/api/src/app.ts`:

```ts
export interface AppDeps {
  db: Sql; jobs: JobClient; logger: Logger; authAdmin: AuthAdmin; verifier: JwtVerifier;
  objectStore: ObjectStore;
  hrKeys: HrKeyRing;      // 8A, amendment A8 — SEVEN members. A route must never read a key from process.env,
}                         // and the ring must be swappable so startApi() can mint a deterministic test key.

// inside createApp, the ONE existing buildRoutes call gains the third key — 2C's line for objectStore,
// repeated for hrKeys; the mount loop around it and the middleware chain before it are untouched:
for (const module of buildRoutes({ authAdmin: deps.authAdmin, objectStore: deps.objectStore, hrKeys: deps.hrKeys })) {
  app.route(module.path, module.router);
}
```

**`apps/api/src/routes/index.ts` — the same two edits 2C made, and no change to the array's existing contents** (§4.2.7: `buildRoutes` is the authoritative form and `ROUTES` is derived from it, so a `deps` member Task 4 reads must be on the parameter object *and* on the stub call, or `ROUTES` does not construct and the catalogue lint, the OpenAPI generator and `tests/invariants/tenant-isolation.test.ts` all fail before a single route test runs). Add `hrKeys: HrKeyRing` to the one parameter object, and a dev ring to the `ROUTES` call beside the `StubAuthAdmin` and `MemoryObjectStore` already there:

```ts
import { createHrKeyRing, DEV_HR_KEY, type HrKeyRing } from "@dulja/db";

// signature only — the body's module array is untouched by this step; Task 4, Task 7, Task 10 and
// Task 11 append to it.
export function buildRoutes(deps: { authAdmin: AuthAdmin; objectStore: ObjectStore; hrKeys: HrKeyRing }): readonly RouteModule[];

export const ROUTES: readonly RouteModule[] = buildRoutes({
  authAdmin: new StubAuthAdmin(),
  objectStore: new MemoryObjectStore(),
  hrKeys: createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
});
```

The stub ring never decrypts anything: `ROUTES` is enumerated, never served from, so the key it holds only has to exist and be the right length. **`DEV_HR_KEY` is legal here for the same reason `MemoryObjectStore` is** — this is the derived list, not the mounted app, and `createApp` receives the real ring through `AppDeps`.

`apps/api/test/support/app.ts` — one line inside `startApi()`'s deps object:

```ts
    hrKeys: createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
```

`infra/src/secrets.ts` — both names join `containerSecrets(env, entrypoint)` for the `api` and `worker` entrypoints (8D's rotation job runs in the worker):

```ts
  HR_FIELD_ENCRYPTION_KEY: require(env, "HR_FIELD_ENCRYPTION_KEY"),
  HR_FIELD_ENCRYPTION_KEY_PREVIOUS: env.HR_FIELD_ENCRYPTION_KEY_PREVIOUS ?? undefined,
```

**`apps/api/src/index.ts` — the PRODUCTION composition root, and the last of the four places that build a ring.** 0B Task 4 Step 11 / Task 5 Step 9 wrote this file, and it holds the only `AppDeps` object literal the container actually serves from; 2C composes `objectStore` there and 6A composes `terminalJwtSigningKey` there (6a:2970–2982). `AppDeps` is a **required-member** interface, so the member added above must appear in *every* literal in the same commit or `bun run typecheck` is red for the rest of this slice — which is why this edit is not optional and not a later slice's. One import and one member, placed beside the object store:

```ts
// apps/api/src/index.ts — one import, added to the existing `@dulja/db` import line
import { createHrKeyRing } from "@dulja/db";

// …and one member inside the deps literal that `createApp(...)` already receives, on the line after
// `objectStore: new R2ObjectStore(config),`:
  hrKeys: createHrKeyRing({ current: config.hrFieldEncryptionKey, currentVersion: 1, previous: config.hrFieldEncryptionKeyPrevious }),
```

**`currentVersion: 1` is a deliberate literal, not a shortcut.** §3.11 registers `HR_FIELD_ENCRYPTION_KEY` and `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` and **no version name**, `createHrKeyRing` requires `currentVersion`, and the deployment is single-version until 8D's rotation job exists — so `1` is the only value any environment has ever used and **this plan does not invent a third §3.11 name**. 8D's Task registers `HR_FIELD_ENCRYPTION_KEY_VERSION` and replaces this literal with `config.hrFieldEncryptionKeyVersion` in the same pull request as the rotation job (8d:3685 quotes this line verbatim for that replacement, so **do not reformat it** — keep the four properties on one line and in this order). `previous` is passed straight through: `createHrKeyRing`'s parameter is `previous?: string | null` and `ApiConfig.hrFieldEncryptionKeyPrevious` is `string | null`, so an absent variable reaches the ring as `null` and needs no `?? undefined`.

**`apps/worker/src/index.ts` is NOT edited here.** 0D's worker entrypoint builds no `AppDeps` and 8A's one job (`hr.rate_table.lapse_warning`, Task 10) reads no ciphertext, so the worker needs no ring in this slice; amendment **A12** of plan 8D puts `apps/worker/src/hr-keys.ts` in 8D, on 7A's `objectStore()` / `setObjectStore()` terms, alongside the rotation job that is the first worker code to decrypt anything.

- [ ] **Step 8: Write `tests/invariants/support/hr.ts` (amendment A6)**

```ts
import { PERMISSION } from "@dulja/contracts/permissions";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app";   // TYPE only, exactly as pos.ts does
import { uuidv7, withTenant, type Db } from "@dulja/db/test";

export interface HrFixture {
  api: StartedApi; db: Db; seed: Seed; companyId: string;
  officer: string; checker: string; outsider: string;
  sixC: boolean;        // whether 6C has merged; see SIX_C below
  employees: { id: string; number: string; principalId: string | null }[];
  // `schemeId: string` is APPENDED by Task 8 Step 6, in the same commit as `seedStatutoryScheme` —
  // the helper does not exist yet and this file must typecheck at the end of every task (GC 19).
}

/** **The 6C branch, decided by the catalogue rather than by a person.** §6.3 runs 8A in parallel with
 *  the 6A→6C→6B→6D chain, so `hr.employee.read` and `hr.employee.manage` — 6C's rows in §3.6.2 — may
 *  or may not exist when this fixture runs. `PERMISSION` is built from `PERMISSIONS`, so a missing key
 *  IS the absence of the catalogue row, with no database round trip and nothing to keep in step by
 *  hand. `grantCodes` inserts `role_permission` rows that reference `app.permission`, so granting an
 *  unseeded code is a foreign-key error and every test using this fixture would die in set-up. */
const SIX_C = "hr.employee.read" in PERMISSION;

/** The 8A codes the officer always holds. `admin.company.manage` is 0B's and is here for T11. */
const OFFICER_CODES_8A = [
  "hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage",
  "hr.pay_component.manage", "hr.statutory_table.manage", "admin.company.manage",
] as const;
/** 6C's two, added only when 6C has merged. */
const OFFICER_CODES_6C = ["hr.employee.read", "hr.employee.manage"] as const;

/**
 * The ONE HR corpus. 8B, 8C and 8D re-use it; nothing else builds a second one (hazard 9).
 *
 * **The caller supplies the running API; this file never calls `startApi()`.** That is the settled
 * shape for a §4.17.1 fixture — 6A's `posFixture(api, name)`, 6C's `staffFixture(api, name)` and 7C's
 * `reports-7c.ts` all take it as a parameter and import only its type, because §3.1's tier table lets
 * the `tests` workspace reach `apps/api` through `createApp()` and `./routes` and nothing else (7C
 * writes the rule out at 7c:1744). Every consumer already owns a legal way to obtain one: a file under
 * `apps/api/test/**` calls `startApi()` from its own `../support/app`, and a `tests/invariants/*.test.ts`
 * file calls it the way 0B's own `tenant-isolation.test.ts` and `auth-bypass.test.ts` do. `name` is the
 * tenant name handed to `seedTenantV2`, so two fixtures built on ONE api do not collide.
 */
export async function hrFixture(api: StartedApi, name = "hr"): Promise<HrFixture> {
  const db = api.db;
  const seed = await seedTenantV2(db, name);
  const mint = async (name: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${id}, ${`sub-${id}`}, 'human', ${name})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${id})`;
    });
    return id;
  };
  const officer = await mint("HR Officer");
  const checker = await mint("Accountant");
  const outsider = await mint("Clerk");
  const officerCodes = [...OFFICER_CODES_8A, ...(SIX_C ? OFFICER_CODES_6C : [])];
  await grantCodes(db, seed, { codes: officerCodes, principalId: officer, roleCode: "hr-officer" });
  // The checker holds MANAGE as well as VERIFY on purpose: T10's "holding BOTH codes" case proves that a principal
  // holding both codes still cannot verify what it loaded. R6 forbids one seeded ROLE holding both
  // (§4.2.5), and a test role is not a seeded role — the trigger is what makes the rule hold anyway.
  await grantCodes(db, seed, { codes: ["hr.statutory_table.verify", "hr.statutory_table.manage", ...(SIX_C ? ["hr.employee.read"] : [])], principalId: checker, roleCode: "hr-checker" });
  // The outsider is a MEMBER holding no HR code. Under 6C it also holds hr.employee.read, so the
  // directory cases can prove that reading the roster still yields no sensitive field; under
  // 8A-FIRST there is no roster route and the empty grant is the same principal, less one code.
  if (SIX_C) await grantCodes(db, seed, { codes: ["hr.employee.read"], principalId: outsider, roleCode: "hr-outsider" });
  // …and under 8A-FIRST the call is SKIPPED rather than made with an empty array: `grantCodes`'
  // `codes` is optional (§4.17) and an omitted or empty one is not specified to mean "no codes".
  // The outsider is already a member of the tenant through `mint()`, which is the whole of what the
  // negative cases need — every one of them asserts a refusal or zero rows.
  await api.loadPrincipals();

  const employees = [] as HrFixture["employees"];
  for (const [n, p] of [["E-1001", null], ["E-1002", null], ["E-1003", officer]] as const) {
    employees.push({ id: await seedEmployee(db, seed, { employeeNumber: n, principalId: p ?? undefined }), number: n, principalId: p });
  }
  // E-1003 IS the officer: every R4 case in this slice and in 8B/8C uses it, so no test has to
  // build a self-referencing employee of its own and get the direction of the check wrong.
  return { api, db, seed, companyId: seed.company, officer, checker, outsider, sixC: SIX_C, employees };
}

export const hrActor = (f: HrFixture, who: "officer" | "checker" | "outsider"): string => f[who];

// This file exports THREE names and re-exports nothing. `problemOf` is 0B's, and every consumer
// imports it from `tests/support/api` directly — the spelling 4A (4a:1118), 6C (6c:1763, 6c:3670) and
// 7C (7c:4464, 7c:5035) already use from `apps/api/test/**`, all three merged before this slice. A
// re-export here would be a second path to one helper, which is hazard 9, and would put
// `tests/support/api.ts`'s memoised `sharedApi()` — a DIFFERENT database from this fixture's — on the
// import graph of every route test that touches HR.
```

- [ ] **Step 9: Write ADR 0071 as a PROPOSAL**

`docs/adr/0071-hr-field-encryption-envelope.md` — spec:95 requires anything touching security or the data model to be written as a proposal and **asked** before implementing. The migration and the module above are the proposal's reference implementation; the ADR's status stays `Proposed` until the owner answers.

```markdown
# ADR 0071 — The HR field-encryption envelope

Status: **Proposed** (spec:95 — this touches security and the data model, so it is asked, not decided)
Date: 2026-09-08
Slice: 8A

## Context

spec:2076 and spec:2211 require the nine identity, bank and statutory-reference fields of
`employee_sensitive` to be field-level encrypted in the application with a dedicated key from the
§4.11 inventory, gated by `hr.employee.read_sensitive`, with documented rotation (spec:2273 makes
rotation a pg-boss job, which 8D owns). The spec fixes the requirement and not the format.

Three properties have to hold together. A row must not be openable after being moved to another
employee or another column — otherwise "swap two rows" is a data-integrity attack the audit log
cannot see. Rotation must be able to run over a live table one batch at a time, so two key versions
must be readable at once. And the ciphertext must be self-describing enough that a restored backup
taken mid-rotation is still readable.

## Decision

`version(1 byte) || nonce(12) || ciphertext || tag(16)`, AES-256-GCM, with
`AAD = "<employee_id>:<column name>"` and the key selected by the leading version byte
(§4.12.5). **The envelope's own leading byte is the authority on which key opens a column**;
`app.employee_sensitive.key_version` is a row-level *index* for the rotation scan and records the
**oldest** version any column of that row still carries. A rotation batch is a read-decrypt-reseal-write
of the whole row, and only such a full write moves the stamp forward: a partial write —
`writeSensitive` with one field, which is what a bank-account change is — re-seals what it touched
under the current key and leaves `key_version` where it was, because a row claiming a version eight of
its columns have not reached would be skipped by a scan of `key_version < current` and would become
unreadable the day `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` is retired.

The key ring is `HR_FIELD_ENCRYPTION_KEY` (current) plus the optional
`HR_FIELD_ENCRYPTION_KEY_PREVIOUS`, both **base64 of exactly 32 bytes**; `readConfig()` refuses any
other length by name. `APP_ENV = dev` falls back to an all-zero key so `bun run dev` and CI need no
secret; staging and production do not.

`packages/db/src/hr/sensitive.ts` is the only module in the repository that calls `node:crypto`, and
`keys.ts` the only one that holds key bytes. Neither lives in `apps/api`, because 8D's rotation job
runs in `apps/worker` and §3.1 forbids an app importing an app.

## Consequences

- A moved row or a copied column value fails `decipher.final()`. That is a hard failure, surfaced as
  `ERR_INTERNAL` with the employee id and the column logged, never as a silent empty string.
- Two key versions are readable at once and no more, **including within a single row**: a partially
  rotated row opens field by field from the same two-key ring, which is what makes an interrupted
  rotation a resumable state rather than a corrupt one. A rotation interrupted twice, leaving three
  live versions, is refused by `forVersion` with a message naming the version — deliberately, so the
  operator re-runs the rotation rather than accumulating keys.
- 8D's rotation job scans `where key_version < <current>` and re-seals every column of each row it
  finds. Because a partial write can lower a row's stamp but never raise it, that scan cannot miss a
  row; the cost is that a row already fully current can be re-sealed once more if a later write
  lowers its stamp, which is idempotent work and not a correctness problem.
- The gate, not the cipher, is the access control. Encryption protects a stolen backup; `sensitive_gate`
  protects a live query. Both are required, and the acceptance test (32) tests the gate.
- **Not decided here:** where the key is *stored* in production. Supabase Vault, a Cloudflare secret
  binding and an external KMS all satisfy this ADR. spec:2273 says "Supabase vault or a KMS"; the
  owner's answer is 0C's deployment decision applied to a new name, and 8D's rotation job consumes
  whichever it is through the same two environment variables.

## Rejected

- **`pgcrypto` in the database.** The key would have to reach the SQL text or a session setting, which
  puts it in `pg_stat_activity` and in any query log. spec:2076 says "encrypted in the application".
- **One key for the whole tenant table with no version byte.** Rotation then has to be atomic across
  every row, which is a lock on a live HR table.
- **Deterministic encryption so the columns stay searchable.** A searchable national-ID column is a
  side channel, and test 32 forbids exactly that. Searching sensitive fields is not a v1 requirement.
```

- [ ] **Step 10: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run db:lint && bun run test -- test/hr/sensitive.test.ts
cd ../.. && bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 12 passing, `0 violations`, and `lint:rules` reporting **exactly the six `permission-catalogue` lines of Task 2 Step 4** — `hr.employee.read_sensitive` among them, because the code is still only a SQL literal and not yet a `PERMISSION[…]` reference. Task 4 closes it.

```bash
git add packages/db/migrations/0081_create_employee_sensitive.sql packages/db/migrations/0081.down.sql \
        packages/db/src/hr/ packages/db/src/schema/employee-sensitive.ts packages/db/src/lint-schema.ts \
        packages/db/src/index.ts packages/db/test/hr/sensitive.test.ts tests/invariants/support/hr.ts \
        apps/api/src/config.ts apps/api/src/app.ts apps/api/src/routes/index.ts \
        apps/api/src/index.ts apps/api/test/support/app.ts infra/src/secrets.ts \
        docs/adr/0071-hr-field-encryption-envelope.md
git commit -m "$(cat <<'EOF'
feat(db): employee_sensitive behind the spec:2076 restrictive gate, sealed with AES-256-GCM [8A T3]

Migration 0081 creates nine ciphertext columns keyed on employee_id (NO_ID_TABLES) with no
company_id of its own -- the sensitive_gate policy joins app.employee for it, exactly as spec:2076
writes the policy. AS RESTRICTIVE and with no `with check`, so one predicate gates read and write
and tenant_isolation cannot OR it away (LEGACY-033). The envelope is
version||nonce||ciphertext||tag with AAD = employee_id:column, so a row moved to another employee
cannot be opened (ADR 0071, a proposal). key_version records the OLDEST version any column of a row
still carries, so a partial write cannot hide a row from 8D's rotation scan. AppDeps becomes seven
members and buildRoutes' deps and the derived ROUTES stub gain the ring with it: the key is injected,
never read from process.env in a route. All four literals move in this commit -- the production
composition root apps/api/src/index.ts included, because a required member missing from the one
object the container serves from is a red typecheck, not a later slice's tidy-up. currentVersion is
the literal 1 until 8D registers a version variable. The sensitive_gate linter rule makes a missing
gate a build failure and already covers the two compensation tables migrations 0082 and 0083 add.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The sensitive sub-resource and **acceptance test 32**

**This is the slice's owned acceptance test** (spec:2450): *"A principal without `hr.employee.read_sensitive` receives no identity, bank or statutory-number fields; one without `hr.compensation.read` receives no `compensation_line` or `employee_statutory_profile` rows (posted `payroll_line` amounts are gated by `hr.payroll.read`) — through any endpoint, filter, sort, search or export, checked over the OpenAPI document and by direct `app_rw` query under `withTenant`."*

Five channels, five proofs. The endpoint proof is a 403 and an omitted field; the filter and sort proofs are `ERR_VALIDATION_FAILED` on an undeclared field (§4.2.8 — "an undeclared field is `ERR_VALIDATION_FAILED`; **no field name ever reaches SQL as text**"); the OpenAPI proof is a scan of the committed document; the direct-SQL proof is Task 3's `sensitive_gate` case, re-asserted here through the production `withTenant`. **The export channel is 7C's**, which builds `admin.data.export`; this task writes the assertion that no export path exists *yet* that could carry the fields, and §6.1 records 7C as test 32's re-runner.

The compensation half of the sentence is asserted in **Task 7** once `compensation_line` exists; this task's OpenAPI scan already covers it, because a schema that does not exist cannot leak.

**Files:**
- Create: `apps/api/src/routes/hr/sensitive.ts`, `packages/contracts/src/hr/sensitive.ts`, `apps/api/test/routes/hr/sensitive.test.ts`, `tests/invariants/hr-sensitive-side-channels.test.ts`
- Create: `apps/api/src/routes/hr/employees-composed.ts` (`composeEmployeeRouter`, amendment A16)
- Modify: `apps/api/src/routes/index.ts` (the composed `employees` module — both branches), `tests/invariants/probes.ts` (**one entry, `8A-FIRST` only**), `packages/contracts/openapi.json`

**Interfaces**

- Consumes: `AppEnv`, `RequestContext` (§4.2.3); `requirePermission`, `PERMISSION`, `ScopeSource` (§4.2.5); `IdempotencyHeader`, `RouteModule` (§4.2.7); `UuidSchema`, `DateSchema`, `TimestampSchema`, `ProblemSchema` (§4.2.8); `readSensitive`, `writeSensitive`, `SENSITIVE_FIELDS`, `SensitiveValues` (Task 3); `hrFixture`, `hrActor` (A6); `startApi`, `problemOf` (§4.2.12, §4.17.1); `employeeRoutes` (6C, under `6C-FIRST`).
- Produces:

```ts
// packages/contracts/src/hr/sensitive.ts
export const EmployeeSensitiveSchema: z.ZodObject<{
  employeeId; nationalId; passport; dateOfBirth; residencyCategory; bankAccount;
  epfNumber; socsoNumber; taxNumber; workPermitExpiry; keyVersion; updatedBy; updatedAt;
}>;
export const UpdateEmployeeSensitiveBody: z.ZodObject<{ /* the nine, each optional and nullable */ }>;
export type EmployeeSensitiveDto = z.infer<typeof EmployeeSensitiveSchema>;
/** The nine wire names, exported so the side-channel test scans for the SAME strings the schema uses. */
export const SENSITIVE_WIRE_FIELDS: readonly string[];
```

- [ ] **Step 1: Write the failing route test**

`apps/api/test/routes/hr/sensitive.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSION } from "@dulja/contracts/permissions";
import { grantCodes, uuidv7, withTenant } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

/** The same expression `hrFixture` uses for `sixC`, repeated at module level because `it.skipIf` is
 *  evaluated at COLLECTION time, before `beforeAll` has assigned `f`. `f.sixC` carries the identical
 *  value for use inside a case body. */
const SIX_C = "hr.employee.read" in PERMISSION;

describe("GET|PUT /v1/companies/{companyId}/employees/{employeeId}/sensitive — test 32, the endpoint half", () => {
  let f: HrFixture; let target: string; let writerOnly: string;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-sensitive");
    target = f.employees[0]!.id;
    // A principal holding the WRITE gate and not the confidentiality gate. The fixture has no such
    // principal by design — its three are the shapes the seeded roles have — and this suite needs one
    // to prove the two-code arrangement of Task 2 Step 4 is enforced at both layers.
    writerOnly = await uuidv7(f.db.admin);
    await withTenant(f.db.rw, f.seed.tenant, f.seed.human, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${writerOnly}, ${`sub-${writerOnly}`}, 'human', 'Writer only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${writerOnly})`;
    });
    await grantCodes(f.db, f.seed, { codes: ["hr.compensation.manage"], principalId: writerOnly, roleCode: "hr-writer-only" });
    await f.api.loadPrincipals();
  }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  it("the holder writes and reads back", async () => {
    const put = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.officer,
      body: { nationalId: "SYNTHETIC-ID-0001", bankAccount: "SYNTHETIC-ACC-9", epfNumber: "SYNTHETIC-EPF-7" },
    });
    expect(put.status).toBe(200);
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.officer });
    expect(get.status).toBe(200);
    const dto = await get.json() as { nationalId: string | null; bankAccount: string | null; keyVersion: number };
    expect(dto.nationalId).toBe("SYNTHETIC-ID-0001");
    expect(dto.bankAccount).toBe("SYNTHETIC-ACC-9");
    expect(dto.keyVersion).toBe(1);
  });

  it("a principal with hr.employee.read but not read_sensitive is refused, not given nulls", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.outsider });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the same principal writing is refused", async () => {
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.outsider,
      body: { nationalId: "SHOULD-NOT-LAND" },
    });
    expect(res.status).toBe(403);
    // The outsider holds neither code, so the MIDDLEWARE refuses first, on hr.compensation.manage.
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the WRITE needs BOTH codes: hr.compensation.manage passes the gate, sensitive_gate stops the row", async () => {
    // Task 2 Step 4's two-code arrangement, proved from the side the middleware cannot see. R7 forbids
    // gating a PUT with the mutating:false hr.employee.read_sensitive (ERR_ROUTE_GATE_READONLY at
    // boot), so the route's pre-flight is hr.compensation.manage and the confidentiality half is the
    // RESTRICTIVE sensitive_gate — which, carrying no `with check`, applies its `using` predicate to
    // the write. This principal clears the pre-flight and is refused by RLS: 42501, which
    // fromDatabaseError maps to ERR_RLS_DENIED (403, §4.2.4). A 200 here means the gate was dropped.
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: writerOnly,
      body: { nationalId: "SHOULD-NOT-LAND-EITHER" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RLS_DENIED");
    // and nothing landed: the holder still reads what the first case wrote
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.officer });
    expect(((await get.json()) as { nationalId: string }).nationalId).toBe("SYNTHETIC-ID-0001");
  });

  it("the same principal READING is refused by the middleware, on the read code", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: writerOnly });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  // The two DIRECTORY cases below exercise 6C's `GET …/employees` list route. Under the `8A-FIRST`
  // branch of Task 0 Step 3 that route does not exist — the module 8A mounts carries only 8A's
  // sub-paths — and there is no roster to leak a sensitive field through, so the assertions are
  // vacuous rather than failing. `f.sixC` is `"hr.employee.read" in PERMISSION`, so both cases start
  // running by themselves on the first CI run after 6C merges; nothing has to be edited back in.
  it.skipIf(!SIX_C)("the employee DIRECTORY carries no sensitive field for anyone, holder included", async () => {
    for (const who of [f.officer, f.outsider]) {
      const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees?limit=50`, as: who });
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const needle of ["nationalId", "passport", "bankAccount", "epfNumber", "socsoNumber", "taxNumber", "dateOfBirth", "residencyCategory", "workPermitExpiry"]) {
        expect(text).not.toContain(needle);
      }
      expect(text).not.toContain("SYNTHETIC-ID-0001");
    }
  });

  // ⚠️ **This case asserts a requirement on 6C's schema, not on 8A's.** The route is 6C's
  // `GET …/employees` and its query schema is 6C's `EmployeeQuery` (`packages/contracts/src/hr/
  // employee.ts`). For the five rows below to be 400 rather than a silently-stripped 200, that schema
  // needs the same two mechanisms 8A applies to its own three query schemas: `.strict()` for the two
  // `filter[…]` keys, and a `sort`/`fields` bound (0B's `z.string().max(0, …)` form, 0b:4321) for the
  // three that name declared `ListQuery` members. 8A does not own that file and does not edit it —
  // under `8A-FIRST` there is no employee list at all and the case is skipped; under `6C-FIRST` it
  // runs, and if it fails see the "Where to stop and raise" bullet in the Execution handoff. Keeping
  // the assertion here is deliberate: test 32's directory channel is 8A's to prove, wherever the
  // schema that closes it happens to live.
  it.skipIf(!SIX_C)("a sensitive field cannot be used as a filter or a sort — it is not a declared field (§4.2.8)", async () => {
    for (const q of ["filter[nationalId][eq]=SYNTHETIC-ID-0001", "filter[bankAccount][like]=SYNTH", "sort=nationalId", "sort=-bankAccount", "fields=nationalId"]) {
      const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees?${q}`, as: f.officer });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("R4: the officer cannot write their OWN sensitive row (spec:2175, test 31's R4 clause)", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/employees/${self.id}/sensitive`, as: f.officer,
      body: { nationalId: "SYNTHETIC-ID-SELF" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_PAY");
  });

  it("an unsafe call with no Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/employees/${target}/sensitive`, as: f.officer,
      body: { passport: "SYNTHETIC-PP-1" }, idempotencyKey: null,
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("an employee of another tenant is 404, never 403 (no cross-tenant existence leak)", async () => {
    const res = await f.api.request({
      method: "GET", path: `/v1/companies/${f.companyId}/employees/00000000-0000-7000-8000-0000000000ff/sensitive`, as: f.officer });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && bun run test -- test/routes/hr/sensitive.test.ts
```

Expected: **FAIL** — the first case reports `expect(200).toBe(200)` against `404`, because the route is not mounted. `problemOf(res).code` is `ERR_NOT_FOUND`.

- [ ] **Step 3: Write the contracts module**

`packages/contracts/src/hr/sensitive.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, TimestampSchema, UuidSchema } from "../common";

/** The nine wire names, exported so the side-channel test scans for exactly what the schema declares
 *  rather than for a hand-typed list that can drift away from it (test 32). */
export const SENSITIVE_WIRE_FIELDS = [
  "nationalId", "passport", "dateOfBirth", "residencyCategory", "bankAccount",
  "epfNumber", "socsoNumber", "taxNumber", "workPermitExpiry",
] as const;

const Field = z.string().max(120).nullable();

export const EmployeeSensitiveSchema = z.object({
  employeeId: UuidSchema,
  nationalId: Field, passport: Field, dateOfBirth: DateSchema.nullable(), residencyCategory: Field,
  bankAccount: Field, epfNumber: Field, socsoNumber: Field, taxNumber: Field,
  workPermitExpiry: DateSchema.nullable(),
  keyVersion: z.number().int().min(1),
  updatedBy: UuidSchema,
  updatedAt: TimestampSchema,
}).openapi("EmployeeSensitive");

/** Every field optional (send only what changes) and nullable (an explicit null clears it).
 *  `keyVersion` is deliberately ABSENT: the server always seals under the ring's current version,
 *  so a caller can neither pin an old key nor claim a version it does not hold. */
export const UpdateEmployeeSensitiveBody = z.object({
  nationalId: Field.optional(), passport: Field.optional(), dateOfBirth: DateSchema.nullable().optional(),
  residencyCategory: Field.optional(), bankAccount: Field.optional(), epfNumber: Field.optional(),
  socsoNumber: Field.optional(), taxNumber: Field.optional(), workPermitExpiry: DateSchema.nullable().optional(),
}).openapi("UpdateEmployeeSensitiveBody");

export type EmployeeSensitiveDto = z.infer<typeof EmployeeSensitiveSchema>;
```

- [ ] **Step 4: Write the routes and mount them**

`apps/api/src/routes/hr/sensitive.ts`:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "@dulja/contracts";
import { EmployeeSensitiveSchema, UpdateEmployeeSensitiveBody } from "@dulja/contracts/hr/sensitive";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  readSensitive, writeSensitive,
  type HrKeyRing, type SensitiveField, type SensitiveRow, type SensitiveValues,
} from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;

/** wire (camelCase) → column (snake_case). One map; the route never builds a column name by hand. */
const TO_COLUMN = {
  nationalId: "national_id", passport: "passport", dateOfBirth: "date_of_birth",
  residencyCategory: "residency_category", bankAccount: "bank_account", epfNumber: "epf_number",
  socsoNumber: "socso_number", taxNumber: "tax_number", workPermitExpiry: "work_permit_expiry",
} as const;

const toDto = (row: SensitiveRow) => ({
  employeeId: row.employeeId, keyVersion: row.keyVersion, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
  nationalId: row.values.national_id ?? null, passport: row.values.passport ?? null,
  dateOfBirth: row.values.date_of_birth ?? null, residencyCategory: row.values.residency_category ?? null,
  bankAccount: row.values.bank_account ?? null, epfNumber: row.values.epf_number ?? null,
  socsoNumber: row.values.socso_number ?? null, taxNumber: row.values.tax_number ?? null,
  workPermitExpiry: row.values.work_permit_expiry ?? null,
});

/**
 * A FACTORY, exactly as 0B's `createUserRoutes(authAdmin)` and 2C's `createAttachmentRoutes(objectStore)`
 * are — which is the reason `buildRoutes` takes deps at all (§4.2.7). The key ring is closed over, so no
 * handler reads a key from `process.env` and `AppEnv["Variables"]` stays at its registered EIGHT members
 * (§4.2.3 — 0B/0C's five, 2C's `attachment` and `documentModule`, 3B's `jobs`): this slice adds no
 * ninth variable and no `c.get("hrKeys")` exists anywhere.
 */
export function createSensitiveRoutes(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(
    createRoute({
      method: "get", path: "/{employeeId}/sensitive", tags: ["hr"],
      request: { params: Params },
      middleware: [requirePermission(PERMISSION["hr.employee.read_sensitive"], gate)],
      responses: { 200: { description: "The decrypted row", content: { "application/json": { schema: EmployeeSensitiveSchema } } } },
    }),
    async (c) => {
      const { employeeId } = c.req.valid("param");
      const row = await c.var.withTenant((tx) => readSensitive(tx, hrKeys, employeeId));
      if (row === null) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} has no sensitive record, or you cannot see it`);
      return c.json(toDto(row), 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "put", path: "/{employeeId}/sensitive", tags: ["hr"],
      request: { params: Params, headers: IdempotencyHeader, body: { content: { "application/json": { schema: UpdateEmployeeSensitiveBody } } } },
      // TWO codes, one on each layer, and the split is forced rather than chosen. R7 (spec:2178) is
      // enforced at boot by `assertRouteGates`, which throws ERR_ROUTE_GATE_READONLY when an unsafe
      // method is gated by a `mutating: false` code — and §3.6.2 pins `hr.employee.read_sensitive`
      // false in both directions (`permission-catalogue.test.ts` compares them), so it cannot gate a
      // PUT. The pre-flight is therefore `hr.compensation.manage`; the confidentiality half is
      // `sensitive_gate`, which has no `with check` and so applies its `using` predicate — the
      // `hr.employee.read_sensitive` test — to the write as well as the read. A principal holding
      // only the manage code clears the middleware and is refused by RLS with 42501, which
      // `fromDatabaseError` maps to ERR_RLS_DENIED (§4.2.4); Step 1 has a case for it.
      middleware: [requirePermission(PERMISSION["hr.compensation.manage"], gate)],
      responses: { 200: { description: "Stored", content: { "application/json": { schema: EmployeeSensitiveSchema } } } },
    }),
    async (c) => {
      const { employeeId } = c.req.valid("param");
      const body = c.req.valid("json");
      const values: SensitiveValues = {};
      for (const [wire, column] of Object.entries(TO_COLUMN)) {
        const v = (body as Record<string, string | null | undefined>)[wire];
        if (v !== undefined) values[column as SensitiveField] = v;
      }
      const row = await c.var.withTenant(async (tx) => {
        await writeSensitive(tx, hrKeys, employeeId, values);
        return readSensitive(tx, hrKeys, employeeId);
      });
      if (row === null) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} is not visible to you`);
      return c.json(toDto(row), 200);
    },
  );

  return routes;
}
```

**Mounting: composition inside `buildRoutes`, never a mutation of 6C's const** (amendment A16). 6C exports `employeeRoutes` and `employeeRouteModule` as **consts**, so `employeeRoutes.route(…)` written in another module would run at import time, in whatever order the bundler chose, with no `deps` in scope. The composer builds a fresh router instead and 6C's two exports are untouched:

`apps/api/src/routes/hr/employees-composed.ts` (**8A**, both branches of Task 0 Step 3):

```ts
import { OpenAPIHono } from "@hono/zod-openapi";
import type { HrKeyRing } from "@dulja/db";
import { employeeRoutes } from "./employees";                 // 6C — this LINE and the .route() below
                                                              // are BOTH omitted under 8A-FIRST; an
                                                              // import of a file 6C has not written
                                                              // fails to resolve before any route runs
import { createSensitiveRoutes } from "./sensitive";           // 8A T4
import { statutoryProfileRoutes } from "./statutory-profiles"; // 8A T5
import { compensationRoutes } from "./compensation";           // 8A T7
import type { AppEnv } from "../../context";

/** 6C's employee router plus 8A's three sub-resources, composed once, at buildRoutes time. */
export function composeEmployeeRouter(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  routes.route("/", employeeRoutes);                 // omitted entirely under 8A-FIRST
  routes.route("/", createSensitiveRoutes(hrKeys));
  routes.route("/", statutoryProfileRoutes);         // added by T5
  routes.route("/", compensationRoutes);             // added by T7
  return routes;
}
```

**Under `8A-FIRST` the file is the same minus two lines** — the `employeeRoutes` import and its `.route("/", …)` call — and 6C's Task 8, which mounts its own module, adds both back when it takes its "8A ran first" branch. Deleting only the call and keeping the import is the failure mode to avoid: the module would resolve to nothing and `bun run typecheck` would name a file that does not exist.

`apps/api/src/routes/index.ts`, inside `buildRoutes` — one entry, both branches:

```ts
// 6C-FIRST: spread 6C's module and widen it. Its `path` is unchanged, so PROBES gains NOTHING
// (PROBES is keyed by RouteModule.path — hazard 31, §4.2.7).
{
  ...employeeRouteModule,
  router: composeEmployeeRouter(deps.hrKeys),
  permissions: [
    ...employeeRouteModule.permissions,
    PERMISSION["hr.employee.read_sensitive"],
    PERMISSION["hr.compensation.read"],
    PERMISSION["hr.compensation.manage"],
  ],
},

// 8A-FIRST: there is no 6C module to spread, so 8A creates it — and ONE PROBES entry with it.
// `composeEmployeeRouter` omits its first `.route("/", employeeRoutes)` line under this branch,
// and 6C then extends this module rather than creating it.
{
  path: "/v1/companies/:companyId/employees",
  router: composeEmployeeRouter(deps.hrKeys),
  permissions: [PERMISSION["hr.employee.read_sensitive"], PERMISSION["hr.compensation.read"], PERMISSION["hr.compensation.manage"]],
  auth: "human",
},
```

**T4 ships the composer with only the sensitive sub-router**; T5 and T7 each add their line to it, and each of those tasks' `git add` lists the file.

- [ ] **Step 5: Write the side-channel invariant test (the OpenAPI and direct-SQL halves)**

`tests/invariants/hr-sensitive-side-channels.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENSITIVE_WIRE_FIELDS } from "@dulja/contracts/hr/sensitive";
import { withTenant } from "@dulja/db";
import { repoFile } from "../support/regression";
import { startApi } from "../../apps/api/test/support/app";   // as 0B's own tenant-isolation.test.ts does
import { hrFixture, type HrFixture } from "./support/hr";

/** Acceptance test 32 (spec:2450). Five channels: endpoint, filter, sort, search, export — plus the
 *  OpenAPI document and a direct app_rw query, both named in the test's own sentence. The endpoint,
 *  filter and sort channels are asserted in apps/api/test/routes/hr/sensitive.test.ts; this file
 *  holds the two the route suite structurally cannot see. */
describe("test 32 — sensitive fields have no side channel", () => {
  let f: HrFixture;
  beforeAll(async () => { f = await hrFixture(await startApi(), "hr-side-channels"); }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  /**
   * The schemas each wire name is allowed to appear in. Eight of the nine live in the sensitive pair
   * and nowhere else. **`residencyCategory` is the documented exception:** migration 0082 keeps a
   * PLAINTEXT copy on `app.employee_statutory_profile` because it is a payroll *calculation input*
   * rather than an identifier (Task 5 Step 3 says so on the column), so it is also a property of
   * `StatutoryProfile` and `OpenStatutoryProfileBody` — both of which are gated by
   * `hr.compensation.read` / `.manage` and by the `compensation_gate` RLS policy, which is the same
   * strength of control as `sensitive_gate`. Test 32 asks that no field reach a principal WITHOUT the
   * right code, not that a field appear exactly once; the assertion is therefore a subset check
   * against a named allow-list, and a tenth carrier of any name still fails it. **Task 5 adds no
   * assertion of its own — the exception is written here, in the task that owns test 32, so a reader
   * finds the whole rule in one place.**
   */
  const SENSITIVE_PAIR = ["EmployeeSensitive", "UpdateEmployeeSensitiveBody"];
  const ALLOWED_CARRIERS: Record<string, string[]> = Object.fromEntries(
    SENSITIVE_WIRE_FIELDS.map((f) => [f, f === "residencyCategory"
      ? [...SENSITIVE_PAIR, "StatutoryProfile", "OpenStatutoryProfileBody"]
      : SENSITIVE_PAIR]),
  );

  it("the committed OpenAPI document declares each of the nine names only in its allowed schemas", () => {
    const doc = JSON.parse(repoFile("packages/contracts/openapi.json")) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
    for (const field of SENSITIVE_WIRE_FIELDS) {
      const carriers = Object.entries(doc.components.schemas)
        .filter(([, s]) => s.properties !== undefined && field in s.properties)
        .map(([name]) => name).sort();
      for (const carrier of carriers) {
        expect(ALLOWED_CARRIERS[field], `${field} leaked into ${carrier}`).toContain(carrier);
      }
      // and the pair is always present, so a field cannot disappear from the API and pass silently
      expect(carriers).toEqual(expect.arrayContaining(SENSITIVE_PAIR));
    }
  });

  it("no query parameter anywhere in the document names a sensitive field", () => {
    const raw = repoFile("packages/contracts/openapi.json");
    const doc = JSON.parse(raw) as { paths: Record<string, Record<string, { parameters?: { name: string }[] }>> };
    const names = Object.values(doc.paths).flatMap((ops) => Object.values(ops)).flatMap((op) => op.parameters ?? []).map((p) => p.name);
    for (const field of SENSITIVE_WIRE_FIELDS) {
      expect(names.filter((n) => n.includes(field))).toEqual([]);
    }
  });

  it("a direct app_rw query under the PRODUCTION withTenant returns zero rows without the code", async () => {
    const ctx = { tenantId: f.seed.tenant, actorId: f.outsider, requestId: "00000000-0000-7000-8000-00000000ab01" };
    const rows = await withTenant(f.db.rw, ctx, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`);
    expect(rows[0]!.n).toBe("0");
  });

  it("and every row for the holder — the gate is a predicate, not an empty table", async () => {
    const ctx = { tenantId: f.seed.tenant, actorId: f.officer, requestId: "00000000-0000-7000-8000-00000000ab02" };
    await f.api.request({ method: "PUT", path: `/v1/companies/${f.companyId}/employees/${f.employees[1]!.id}/sensitive`,
      as: f.officer, body: { taxNumber: "SYNTHETIC-TAX-3" } });
    const rows = await withTenant(f.db.rw, ctx, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

});
```

**The export channel is asserted in Task 14, not here, because it may not exist yet.** `admin.data.export` and `packages/db/src/export/` are **7C's**, and §6.3 (contracts:4025) runs 8A on its own branch from 4B *in parallel with* `7A ─ 7B ─ 7C (needs 6D)` — so the module this channel needs is present in some orderings and absent in others, and an unconditional assertion here would be wrong in both directions: red when 7C is absent, and stale when it lands. T14 Step 3 therefore carries the whole channel behind the `7C-FIRST` / `8A-FIRST` branch amendment **A20** records — three `EXPORT_TABLES` rows and one `it.skipIf(!SEVEN_C)` case in *this* file, appended in the task that runs after every 8A table exists. **What this file proves at T4 is the four channels that exist while 8A ships**; §6.1 records 7C as test 32's re-runner for the fifth.

- [ ] **Step 6: Regenerate OpenAPI, run to green, commit**

```bash
bun run --cwd packages/contracts openapi:generate
cd apps/api && bun run test -- test/routes/hr/sensitive.test.ts
cd ../.. && bun run --cwd tests test -- invariants/hr-sensitive-side-channels.test.ts
bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 10 + 4 passing under `6C-FIRST`; under `8A-FIRST`, 8 passing and **2 skipped** in the route suite (the invariant suite is 4 either way) — the two employee-directory cases, which have no route to exercise until 6C mounts one and which un-skip by themselves when it does. `lint:rules` now reports **three** `permission-catalogue` lines, not six — `hr.pay_component.manage`, `hr.statutory_table.manage` and `hr.statutory_table.verify`. Three codes close here, not one: `hr.employee.read_sensitive` gates the GET, `hr.compensation.manage` gates the PUT, and **all three of them plus `hr.compensation.read` appear in the composed module's `permissions` array** in Step 4 — §3.6.3's rule counts every `PERMISSION[…]` reference anywhere under `apps/api`, and a `RouteModule.permissions` entry is one.

```bash
git add apps/api/src/routes/hr/sensitive.ts apps/api/src/routes/hr/employees-composed.ts apps/api/src/routes/index.ts \
        packages/contracts/src/hr/sensitive.ts packages/contracts/openapi.json \
        apps/api/test/routes/hr/sensitive.test.ts tests/invariants/hr-sensitive-side-channels.test.ts \
        tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): the sensitive sub-resource and acceptance test 32 [8A T4]

GET|PUT .../employees/{employeeId}/sensitive, built by a factory so the key ring comes from AppDeps
and never from process.env. TWO codes, one per layer, because R7 forbids gating an unsafe method with
a mutating:false code (assertRouteGates throws ERR_ROUTE_GATE_READONLY at boot): the GET's pre-flight
is hr.employee.read_sensitive, the PUT's is hr.compensation.manage, and sensitive_gate -- which has
no `with check` -- applies the read_sensitive test to the write as well, so a principal holding only
the manage code gets ERR_RLS_DENIED from the database rather than a row. Test 32 is proved on five
channels:
403 on the endpoint, ERR_VALIDATION_FAILED on an undeclared filter/sort/fields name (no field name
ever reaches SQL as text), the nine wire names present in exactly two OpenAPI schemas and in no
query parameter anywhere, and zero rows from a direct app_rw query under the PRODUCTION withTenant.
The export channel is 7C's and is asserted absent rather than assumed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: ⚠️ OD-28 — migration 0082, `app.employee_statutory_profile`, effective-dated

**Owner decision OD-28** (§2.12; spec:2077). The spec's own sentence is *"the inputs the PCB/MTD method needs (marital status, spouse-working flag, child relief count, …). ⚠️ The field list is verified against LHDN's current publication, never invented here."* The ellipsis is the decision.

> **Owner provides:** the verified statutory-profile field list, taken from LHDN's current publication, with each field's name, type and whether it is required (OD-28, spec:2077).
> **Verify:** `bun run --cwd packages/db test -- test/hr/statutory-profile.test.ts` prints `9 passed` **and** `docs/owner/od-28-statutory-profile-fields.md` exists and is referenced from this task's pull request.
> **Until provided:** the table ships **exactly the three fields spec:2077 itself names** — `marital_status`, `spouse_working`, `child_relief_count` — plus `residency_category` (which spec:2076 names in the sensitive set and which the profile needs *unencrypted* for a calculation input) and **`extra jsonb not null default '{}'`** for the verified additions, exactly as §2.9's 8A card specifies. The same test file runs unchanged against the default.

**What changes if the owner answers.** One migration in **8B's** range (`0090`, which §2.9 lists as spare) promotes the confirmed members of `extra` to typed columns and backfills them; `EmployeeStatutoryProfileSchema` gains the wire fields; `packages/domain/payroll/rate-table.schema.json`'s `required_profile_fields` array starts naming them, and 8B's `ERR_PAYROLL_INPUT_MISSING` starts firing on them. **Nothing in 8A moves** — the `extra jsonb` is the seam, and that is why it is in the card. If the owner answers *before* this task runs, the additional columns are added to 0082 directly and `extra` stays for the next revision.

**Effective dating is the whole design** (spec:2077, "Effective-dated statutory profile per employee"). A profile is never edited: a change is a new row, and the old row is closed. ADR 0072 (Task 6) records the rule for this table and for `compensation_line` together.

**Files:**
- Create: `packages/db/migrations/0082_create_employee_statutory_profile.sql`, `packages/db/migrations/0082.down.sql`, `packages/db/src/hr/statutory-profile.ts`, `packages/db/src/schema/employee-statutory-profile.ts`, `packages/db/test/hr/statutory-profile.test.ts`, `packages/contracts/src/hr/statutory-profile.ts`, `apps/api/src/routes/hr/statutory-profiles.ts`, `apps/api/test/routes/hr/statutory-profiles.test.ts`, `docs/owner/od-28-statutory-profile-fields.md`
- Modify: `packages/db/src/hr/index.ts`, `apps/api/src/routes/hr/employees-composed.ts` (one `route()` line), `packages/contracts/openapi.json`

**Interfaces**

- Consumes: everything Task 1 and Task 3 produced; `app.forbid_self_pay` (Task 1); `PERMISSION["hr.compensation.read"]`, `PERMISSION["hr.compensation.manage"]` (Task 2); `hrFixture` (A6); `DateSchema` (§4.2.8).
- Produces:

```ts
// packages/db/src/hr/statutory-profile.ts
export interface StatutoryProfile {
  id: string; employeeId: string; effectiveFrom: string; effectiveTo: string | null;
  maritalStatus: string | null; spouseWorking: boolean | null; childReliefCount: number | null;
  residencyCategory: string | null; extra: Record<string, string | number | boolean | null>;
  enteredBy: string; createdAt: string;
}
export type StatutoryProfileInput = Omit<StatutoryProfile, "id" | "employeeId" | "effectiveTo" | "enteredBy" | "createdAt">;
/** Every row for one employee, newest first. Empty when the caller lacks hr.compensation.read — RLS, not a branch. */
export function listStatutoryProfiles(tx: Sql, employeeId: string): Promise<StatutoryProfile[]>;
/** The row covering `on`, or null. This is the shape 8B's `EmployeePeriodInput.statutoryProfile` is built from. */
export function profileOn(tx: Sql, employeeId: string, on: string): Promise<StatutoryProfile | null>;
/** Closes the open row at `effectiveFrom - 1 day` and inserts the new one, in ONE statement pair. */
export function openStatutoryProfile(tx: Sql, employeeId: string, input: StatutoryProfileInput): Promise<string>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/hr/statutory-profile.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { listStatutoryProfiles, openStatutoryProfile, profileOn } from "../../src/hr/statutory-profile";
import { grantCodes, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("migration 0082 — the effective-dated statutory profile (⚠️ OD-28)", () => {
  let db: Db; let a: Seed; let b: Seed; let officer: string; let clerk: string; let employeeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-prof-a"); b = await seedTenant(db, "8a-prof-b");
    officer = await uuidv7(db.admin); clerk = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [id, n] of [[officer, "Officer"], [clerk, "Clerk"]] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${id}, ${`sub-${id}`}, 'human', ${n})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, { codes: ["hr.compensation.read", "hr.compensation.manage"], principalId: officer, roleCode: "t-prof-officer" });
    // `clerk` is granted NOTHING — see the same note in `packages/db/test/hr/sensitive.test.ts`:
    // `hr.employee.read` is 6C's catalogue row and may not exist under `8A-FIRST`, and this file's
    // only use of `clerk` asserts zero rows through `compensation_gate`, which membership alone gives.
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-PROF" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("carries the three fields spec:2077 names, residency_category, and extra jsonb", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'employee_statutory_profile' order by 1`;
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    expect(byName.get("marital_status")).toBe("text");
    expect(byName.get("spouse_working")).toBe("boolean");
    expect(byName.get("child_relief_count")).toBe("integer");
    expect(byName.get("residency_category")).toBe("text");
    expect(byName.get("extra")).toBe("jsonb");
    expect(byName.get("effective_from")).toBe("date");
    expect(byName.get("effective_to")).toBe("date");
  });

  it("opening a second profile closes the first the day before (spec:2077, ADR 0072)", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, employeeId, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null, extra: {} }));
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, employeeId, { effectiveFrom: "2026-07-01", maritalStatus: "married", spouseWorking: true, childReliefCount: 2, residencyCategory: null, extra: {} }));
    const rows = await withTenant(db.rw, a.tenant, officer, (tx) => listStatutoryProfiles(tx, employeeId));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.effectiveFrom).toBe("2026-07-01");
    expect(rows[0]!.effectiveTo).toBeNull();
    expect(rows[1]!.effectiveTo).toBe("2026-06-30");
    expect(rows[1]!.enteredBy).toBe(officer);
  });

  it("profileOn resolves the row covering a date, and null before the first", async () => {
    expect((await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2026-03-31")))!.maritalStatus).toBe("single");
    expect((await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2026-08-15")))!.childReliefCount).toBe(2);
    expect(await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2025-12-31"))).toBeNull();
  });

  it("two rows cannot share an effective_from", async () => {
    await expect(withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, employeeId, { effectiveFrom: "2026-07-01", maritalStatus: "married", spouseWorking: true, childReliefCount: 2, residencyCategory: null, extra: {} })))
      .rejects.toThrow(/employee_statutory_profile_employee_id_effective_from_key|duplicate key/);
  });

  it("compensation_gate: a principal without hr.compensation.read gets zero rows by direct SQL (test 32)", async () => {
    const rows = await withTenant(db.rw, a.tenant, clerk, (tx) =>
      tx<{ id: string }[]>`select id from app.employee_statutory_profile`);
    expect(rows).toHaveLength(0);
  });

  it("R4: a principal cannot open their own profile (spec:2175)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-PROF-SELF", principalId: officer });
    await expect(withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, mine, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null, extra: {} })))
      .rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("extra jsonb is stored and read back unchanged — the OD-28 seam", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-PROF-X" });
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, other, { effectiveFrom: "2026-01-01", maritalStatus: null, spouseWorking: null, childReliefCount: null, residencyCategory: null, extra: { verified_field_a: "value", verified_flag_b: true, verified_count_c: 3 } }));
    const [row] = await withTenant(db.rw, a.tenant, officer, (tx) => listStatutoryProfiles(tx, other));
    expect(row!.extra).toEqual({ verified_field_a: "value", verified_flag_b: true, verified_count_c: 3 });
  });

  it("tenant B sees nothing of tenant A (test 12)", async () => {
    const rows = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.employee_statutory_profile where employee_id = ${employeeId}`);
    expect(rows).toHaveLength(0);
  });

  it("the schema linter reports zero violations, and one when compensation_gate is dropped", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    await db.admin`drop policy compensation_gate on app.employee_statutory_profile`;
    expect(await lintSchema(db.admin)).toContainEqual({
      table: "employee_statutory_profile", rule: "sensitive_gate",
      detail: "no RESTRICTIVE policy named compensation_gate (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)",
    });
    await db.admin`create policy compensation_gate on app.employee_statutory_profile as restrictive
      using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)))`;
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/statutory-profile.test.ts
```

Expected: **FAIL** at import — `Cannot find module '../../src/hr/statutory-profile'`.

- [ ] **Step 3: Write `0082_create_employee_statutory_profile.sql`**

```sql
-- ── 0082_create_employee_statutory_profile.sql ─────────────────────────────────────────────────
-- §3.10.1 "Effective-dated statutory profile" (spec:2077). ⚠️ OD-28: the field list is verified
-- against LHDN's current publication and is NEVER invented here. This file ships exactly the three
-- fields spec:2077 itself names, plus residency_category (spec:2076 names it in the sensitive set;
-- the profile needs it UNENCRYPTED because it is a calculation input, not an identifier) and an
-- `extra jsonb` for the verified additions. When OD-28 lands, 8B's spare migration 0090 promotes
-- the confirmed members of `extra` to typed columns and backfills them. Nothing in 8A moves.

create table app.employee_statutory_profile (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  employee_id        uuid not null,
  effective_from     date not null,
  effective_to       date,
  marital_status     text,
  spouse_working     boolean,
  child_relief_count int check (child_relief_count is null or child_relief_count >= 0),
  residency_category text,
  extra              jsonb not null default '{}'::jsonb,      -- ⚠️ OD-28 seam. NEVER a rate, a threshold or a formula.
  entered_by         uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at         timestamptz not null default now(),
  unique (employee_id, effective_from),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);

-- At most one OPEN row per employee: the history is the closed rows (spec:2077, ADR 0072).
create unique index employee_statutory_profile_open_idx
  on app.employee_statutory_profile (employee_id) where effective_to is null;

call app_meta.enable_tenant_rls('app.employee_statutory_profile');
call app_meta.attach_audit('app.employee_statutory_profile');
call app_meta.attach_stamp('app.employee_statutory_profile', 'entered_by');

-- The compensation gate, the same shape as spec:2076's sensitive_gate and for the same reason:
-- test 32 (spec:2450) requires "no employee_statutory_profile rows … by direct app_rw query under
-- withTenant" for a principal without hr.compensation.read, and a route check cannot satisfy that.
create policy compensation_gate on app.employee_statutory_profile as restrictive
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

create trigger employee_statutory_profile_no_self_pay
  before insert or update on app.employee_statutory_profile
  for each row execute function app.forbid_self_pay('employee_id');

comment on column app.employee_statutory_profile.extra is
  '⚠️ OD-28. Verified additions to the LHDN input list, as {field: scalar}. A rate, threshold, ceiling or formula never appears here — those live in app.statutory_rate_table.definition (spec:2080).';
```

`packages/db/migrations/0082.down.sql`:

```sql
drop trigger if exists employee_statutory_profile_no_self_pay on app.employee_statutory_profile;
drop policy  if exists compensation_gate on app.employee_statutory_profile;
drop index   if exists app.employee_statutory_profile_open_idx;
drop table   if exists app.employee_statutory_profile;
```

- [ ] **Step 4: Write `packages/db/src/hr/statutory-profile.ts`**

```ts
import type { Sql } from "postgres";

export interface StatutoryProfile {
  id: string; employeeId: string; effectiveFrom: string; effectiveTo: string | null;
  maritalStatus: string | null; spouseWorking: boolean | null; childReliefCount: number | null;
  residencyCategory: string | null; extra: Record<string, string | number | boolean | null>;
  enteredBy: string; createdAt: string;
}
export type StatutoryProfileInput = Omit<StatutoryProfile, "id" | "employeeId" | "effectiveTo" | "enteredBy" | "createdAt">;

interface Raw { id: string; employee_id: string; effective_from: string; effective_to: string | null;
  marital_status: string | null; spouse_working: boolean | null; child_relief_count: number | null;
  residency_category: string | null; extra: Record<string, string | number | boolean | null>;
  entered_by: string; created_at: string }

const toProfile = (r: Raw): StatutoryProfile => ({
  id: r.id, employeeId: r.employee_id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  maritalStatus: r.marital_status, spouseWorking: r.spouse_working, childReliefCount: r.child_relief_count,
  residencyCategory: r.residency_category, extra: r.extra, enteredBy: r.entered_by, createdAt: r.created_at,
});

// The column list is written out in every query rather than hoisted into a shared string and
// interpolated: `sql.unsafe` has exactly three homes in this repository and none of them is here
// (§3.3, hazard 21), and `no-sql-concat` fails the build on a non-literal `.unsafe(` argument.
// Three repetitions of eleven column names is the price of one rule with no exceptions.

export async function listStatutoryProfiles(tx: Sql, employeeId: string): Promise<StatutoryProfile[]> {
  const rows = await tx<Raw[]>`
    select id, employee_id, effective_from::text as effective_from, effective_to::text as effective_to,
           marital_status, spouse_working, child_relief_count, residency_category, extra,
           entered_by, created_at::text as created_at
      from app.employee_statutory_profile
     where employee_id = ${employeeId}
     order by effective_from desc`;
  return rows.map(toProfile);
}

/** The row covering `on`. 8B builds `EmployeePeriodInput.statutoryProfile` (§4.12.1) from this. */
export async function profileOn(tx: Sql, employeeId: string, on: string): Promise<StatutoryProfile | null> {
  const [row] = await tx<Raw[]>`
    select id, employee_id, effective_from::text as effective_from, effective_to::text as effective_to,
           marital_status, spouse_working, child_relief_count, residency_category, extra,
           entered_by, created_at::text as created_at
      from app.employee_statutory_profile
     where employee_id = ${employeeId} and effective_from <= ${on}::date
       and (effective_to is null or effective_to >= ${on}::date)
     order by effective_from desc limit 1`;
  return row === undefined ? null : toProfile(row);
}

/** Close-then-open, one transaction, never an edit (ADR 0072). Returns the new row's id. */
export async function openStatutoryProfile(tx: Sql, employeeId: string, input: StatutoryProfileInput): Promise<string> {
  await tx`
    update app.employee_statutory_profile
       set effective_to = (${input.effectiveFrom}::date - interval '1 day')::date
     where employee_id = ${employeeId} and effective_to is null and effective_from < ${input.effectiveFrom}::date`;
  const [row] = await tx<{ id: string }[]>`
    insert into app.employee_statutory_profile
      (tenant_id, employee_id, effective_from, marital_status, spouse_working, child_relief_count, residency_category, extra)
    select e.tenant_id, e.id, ${input.effectiveFrom}::date, ${input.maritalStatus}, ${input.spouseWorking},
           ${input.childReliefCount}, ${input.residencyCategory}, ${tx.json(input.extra)}
      from app.employee e where e.id = ${employeeId}
    returning id`;
  if (row === undefined) throw new Error(`employee ${employeeId} is not visible to this transaction`);
  return row.id;
}
```

- [ ] **Step 5: Mirror, contracts and routes**

`packages/db/src/schema/employee-statutory-profile.ts` — the diff source and the typed read surface (§3.4.9):

```ts
import { boolean, date, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const employeeStatutoryProfile = app.table("employee_statutory_profile", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  maritalStatus: text("marital_status"),
  spouseWorking: boolean("spouse_working"),
  childReliefCount: integer("child_relief_count"),
  residencyCategory: text("residency_category"),
  extra: jsonb("extra").notNull(),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/contracts/src/hr/statutory-profile.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** ⚠️ OD-28. `extra` is the seam: when the owner's verified list arrives, its members become typed
 *  properties here and typed columns in 8B's migration 0090, and this object shrinks. */
export const StatutoryProfileSchema = z.object({
  id: UuidSchema,
  employeeId: UuidSchema,
  effectiveFrom: DateSchema,
  effectiveTo: DateSchema.nullable(),
  maritalStatus: z.string().max(40).nullable(),
  spouseWorking: z.boolean().nullable(),
  childReliefCount: z.number().int().min(0).nullable(),
  residencyCategory: z.string().max(40).nullable(),
  extra: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  enteredBy: UuidSchema,
  createdAt: TimestampSchema,
}).openapi("StatutoryProfile");

export const OpenStatutoryProfileBody = StatutoryProfileSchema
  .pick({ effectiveFrom: true, maritalStatus: true, spouseWorking: true, childReliefCount: true, residencyCategory: true })
  .extend({ extra: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) })
  .openapi("OpenStatutoryProfileBody");

export const StatutoryProfileList = ListEnvelope(StatutoryProfileSchema);
export type StatutoryProfileDto = z.infer<typeof StatutoryProfileSchema>;

/**
 * The list route's query schema. It exists for ONE reason: a route with no `query` schema validates
 * no query parameter at all, so `?sort=maritalStatus` and `?filter[maritalStatus][eq]=married` would
 * reach a 200 untouched — and Task 5's test-32 case asserts 400/ERR_VALIDATION_FAILED on exactly
 * those. §4.2.8's "an undeclared field is ERR_VALIDATION_FAILED; **no field name ever reaches SQL as
 * text**" is the requirement; `.strict()` is what implements it, because a bare `z.object` strips an
 * unknown key instead of rejecting it (1b:3007).
 *
 * **It deliberately does NOT extend `ListQuery`.** An employee's statutory history is a handful of
 * rows, the handler returns all of them and `next_cursor` is a constant `null`; §4.2.8 settles this
 * exact shape for 2B's `…/documents/{id}/events` — *"advertising `ListQuery` while ignoring it would
 * let a caller mistake a truncated page for a complete list"* — so `cursor` and `limit` are absent
 * and `.strict()` refuses them by name rather than accepting and discarding them. `sort` and `fields`
 * ARE declared, bounded to the empty string in 0B's `AuditLogQuery` form (0b:4321), so the generated
 * OpenAPI document says out loud that this resource sorts and projects nothing; a `.refine` would
 * wrap the object in `ZodEffects` and query-parameter generation would stop (0b:7384).
 */
export const StatutoryProfileQuery = z.object({
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
  fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
}).strict();
```

`apps/api/src/routes/hr/statutory-profiles.ts` mounts two sub-paths on the `employees` module. **It is a plain const, not a factory** — unlike Task 4's `createSensitiveRoutes`, it closes over no key ring and needs no `deps`:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "@dulja/contracts";
import {
  OpenStatutoryProfileBody, StatutoryProfileList, StatutoryProfileQuery, StatutoryProfileSchema,
} from "@dulja/contracts/hr/statutory-profile";
import { PERMISSION } from "@dulja/contracts/permissions";
import { listStatutoryProfiles, openStatutoryProfile, type StatutoryProfile } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });

/** The DB shape is already camelCase (`packages/db/src/hr/statutory-profile.ts` maps it), so the
 *  mapper only drops nothing and renames nothing — it exists so the wire object is written out once
 *  and a column added to `StatutoryProfile` cannot reach the API by accident. */
const toDto = (p: StatutoryProfile) => ({
  id: p.id, employeeId: p.employeeId, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo,
  maritalStatus: p.maritalStatus, spouseWorking: p.spouseWorking, childReliefCount: p.childReliefCount,
  residencyCategory: p.residencyCategory, extra: p.extra, enteredBy: p.enteredBy, createdAt: p.createdAt,
});

export const statutoryProfileRoutes = new OpenAPIHono<AppEnv>();

statutoryProfileRoutes.openapi(
  createRoute({
    method: "get", path: "/{employeeId}/statutory-profiles", tags: ["hr"],
    // `query` is declared even though the handler reads nothing out of it: an undeclared query
    // schema validates NOTHING, and the test-32 case below needs `?sort=maritalStatus`,
    // `?filter[maritalStatus][eq]=married` and `?fields=extra` to be 400 rather than a silent 200.
    request: { params: Params, query: StatutoryProfileQuery },
    middleware: [requirePermission(PERMISSION["hr.compensation.read"], { company: "path:companyId" })],
    responses: { 200: { description: "Newest first", content: { "application/json": { schema: StatutoryProfileList } } } },
  }),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const items = await c.var.withTenant(async (tx) => {
      // An employee this transaction cannot see must be 404 and not an empty list: an empty list is
      // indistinguishable from "exists, no profiles yet", and 404-for-both is what keeps a caller from
      // discovering another tenant's employee ids by the shape of the answer. `app.employee` is
      // already tenant- and branch-filtered by RLS, so the existence check is the check.
      const [exists] = await tx<{ id: string }[]>`select id from app.employee where id = ${employeeId}`;
      if (exists === undefined) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} was not found`);
      return listStatutoryProfiles(tx, employeeId);
    });
    return c.json({ items: items.map(toDto), next_cursor: null }, 200);
  },
);

statutoryProfileRoutes.openapi(
  createRoute({
    method: "post", path: "/{employeeId}/statutory-profiles", tags: ["hr"],
    request: { params: Params, headers: IdempotencyHeader, body: { content: { "application/json": { schema: OpenStatutoryProfileBody } } } },
    middleware: [requirePermission(PERMISSION["hr.compensation.manage"], { company: "path:companyId" })],
    responses: { 201: { description: "Opened; the previous row is closed", content: { "application/json": { schema: StatutoryProfileSchema } } } },
  }),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      const [exists] = await tx<{ id: string }[]>`select id from app.employee where id = ${employeeId}`;
      if (exists === undefined) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} was not found`);
      const id = await openStatutoryProfile(tx, employeeId, {
        effectiveFrom: body.effectiveFrom, maritalStatus: body.maritalStatus, spouseWorking: body.spouseWorking,
        childReliefCount: body.childReliefCount, residencyCategory: body.residencyCategory, extra: body.extra,
      });
      const rows = await listStatutoryProfiles(tx, employeeId);
      return toDto(rows.find((r) => r.id === id)!);
    });
    return c.json(dto, 201);
  },
);
```

**The list route is gated by `hr.compensation.read` and not by membership alone**, unlike 1A's account reads: spec:2450 names the code in the acceptance test, so the pre-flight and the RLS gate agree.

Both routes are added to `composeEmployeeRouter` (T4 Step 4) by appending `routes.route("/", statutoryProfileRoutes);` — the composer, never a mutation of 6C's const (amendment A16).

`apps/api/test/routes/hr/statutory-profiles.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("GET|POST /v1/companies/{companyId}/employees/{employeeId}/statutory-profiles", () => {
  let f: HrFixture; let target: string;
  beforeAll(async () => { f = await hrFixture(await startApi(), "hr-profiles"); target = f.employees[0]!.id; }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  const open = (as: string, employeeId: string, body: Record<string, unknown>) =>
    f.api.request({ method: "POST", path: `/v1/companies/${f.companyId}/employees/${employeeId}/statutory-profiles`, as, body });

  it("the officer opens two profiles and the first comes back closed", async () => {
    expect((await open(f.officer, target, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null })).status).toBe(201);
    expect((await open(f.officer, target, { effectiveFrom: "2026-07-01", maritalStatus: "married", spouseWorking: true, childReliefCount: 2, residencyCategory: null })).status).toBe(201);
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/statutory-profiles`, as: f.officer });
    const body = await res.json() as { items: { effectiveFrom: string; effectiveTo: string | null; childReliefCount: number | null }[] };
    expect(body.items.map((i) => [i.effectiveFrom, i.effectiveTo])).toEqual([["2026-07-01", null], ["2026-01-01", "2026-06-30"]]);
    expect(body.items[0]!.childReliefCount).toBe(2);
  });

  it("a principal without hr.compensation.read is refused on BOTH verbs (test 32)", async () => {
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/statutory-profiles`, as: f.outsider });
    expect(get.status).toBe(403);
    expect((await problemOf(get)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await open(f.outsider, target, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null })).status).toBe(403);
  });

  it("R4: the officer cannot open a profile on their OWN employee row (test 31)", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await open(f.officer, self.id, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_PAY");
  });

  it("the ⚠️ OD-28 seam round-trips: extra is stored and returned unchanged", async () => {
    const other = f.employees[1]!.id;
    await open(f.officer, other, { effectiveFrom: "2026-01-01", maritalStatus: null, spouseWorking: null, childReliefCount: null, residencyCategory: null, extra: { verified_field_a: "value", verified_flag_b: true } });
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${other}/statutory-profiles`, as: f.officer });
    const body = await res.json() as { items: { extra: Record<string, unknown> }[] };
    expect(body.items[0]!.extra).toEqual({ verified_field_a: "value", verified_flag_b: true });
  });

  // `filter[maritalStatus][eq]` is refused by `StatutoryProfileQuery`'s `.strict()`; `sort` and
  // `fields` are refused by their `.max(0, …)` bounds, because both are declared members of
  // `ListQuery` and `.strict()` would let them through whatever value they carried.
  it("a sensitive-looking sort or filter is ERR_VALIDATION_FAILED — no undeclared field reaches SQL", async () => {
    for (const q of ["sort=maritalStatus", "filter[maritalStatus][eq]=married", "fields=extra"]) {
      const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/statutory-profiles?${q}`, as: f.officer });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("POST without Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${target}/statutory-profiles`, as: f.officer,
      body: { effectiveFrom: "2028-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null },
      idempotencyKey: null });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("an employee of another tenant is 404", async () => {
    const res = await f.api.request({
      method: "GET", path: `/v1/companies/${f.companyId}/employees/00000000-0000-7000-8000-0000000000ff/statutory-profiles`, as: f.officer });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6: Write the owner note**

`docs/owner/od-28-statutory-profile-fields.md`:

```markdown
# OD-28 — the statutory-profile field list

**Decision needed from the owner's accountant, not from the build team.**

spec:2077 says the profile carries "the inputs the PCB/MTD method needs (marital status,
spouse-working flag, child relief count, …)" and that "the field list is verified against LHDN's
current publication, never invented here". The ellipsis is what is open.

**What we shipped without an answer** — `app.employee_statutory_profile` with `marital_status`,
`spouse_working`, `child_relief_count`, `residency_category` and `extra jsonb`.

**What we need** — for each additional input the current LHDN publication requires: its name, its
type (text, whole number, yes/no, date), whether it is required, and the publication and date it
was read from. That last part is not paperwork: `statutory_rate_table.source` records the same
three facts for every rate table (§4.12.3), and a profile field with no source is the shape
LEGACY-078 describes.

**What changes when it arrives** — one migration in 8B's range promotes the confirmed fields from
`extra` to typed columns and backfills them; the payroll run starts refusing a NULL in a required
field, naming the employee (`ERR_PAYROLL_INPUT_MISSING`, spec:2105 LEGACY-011). Until then a required
field simply is not declared anywhere, and no calculation depends on one.

**No rate, threshold, ceiling or formula belongs in this answer.** Those arrive separately as
`packages/db/seed/my/statutory/<scheme>/vN.json` under OD-23.
```

- [ ] **Step 7: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run db:lint && bun run test -- test/hr/statutory-profile.test.ts
cd ../apps/api && bun run test -- test/routes/hr/statutory-profiles.test.ts
cd ../.. && bun run --cwd packages/contracts openapi:generate
bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 9 + 7 passing, `0 violations`. `lint:rules` now reports **three** `permission-catalogue` lines (`hr.pay_component.manage`, `hr.statutory_table.manage`, `hr.statutory_table.verify`).

```bash
git add packages/db/migrations/0082_create_employee_statutory_profile.sql packages/db/migrations/0082.down.sql \
        packages/db/src/hr/statutory-profile.ts packages/db/src/hr/index.ts \
        packages/db/src/schema/employee-statutory-profile.ts packages/db/test/hr/statutory-profile.test.ts \
        packages/contracts/src/hr/statutory-profile.ts packages/contracts/openapi.json \
        apps/api/src/routes/hr/statutory-profiles.ts apps/api/src/routes/hr/employees-composed.ts \
        apps/api/test/routes/hr/statutory-profiles.test.ts docs/owner/od-28-statutory-profile-fields.md
git commit -m "$(cat <<'EOF'
feat(db): the effective-dated statutory profile, with extra jsonb as the OD-28 seam [8A T5]

Migration 0082 ships EXACTLY the three fields spec:2077 names, plus residency_category and an
extra jsonb for the verified additions -- the field list is LHDN's, not ours (OD-28), and 8B's
spare migration 0090 promotes the confirmed members to typed columns when the owner answers. A
profile is never edited: opening a new row closes the open one the day before, and a partial unique
index makes "at most one open row" a database fact. compensation_gate is the same restrictive shape
as sensitive_gate, because test 32 demands the direct-app_rw proof for these rows too.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration 0083 — `pay_component`, `pay_component_scheme`, `compensation_line`, and ADR 0072

**Three tables and one rule.** spec:2078 is explicit that pay components are *"a typed catalogue (`earning | deduction`), each mapped to a GL account and to statutory schemes **through a join table (no "subject to X" booleans — RC-3)**"*, and §4.6.1 repeats that `kind` is two-valued: *"an employer contribution is the employer share of a `statutory_scheme`, reached through `pay_component_scheme` … **never a third component kind**"*. A `boolean subject_to_epf` column here would be the defect RC-3 names.

**`pay_component_scheme` ships EMPTY of rows.** Which components a scheme applies to is a *statutory applicability claim* — "basic salary is subject to EPF" is exactly the kind of statement hazard 1 forbids this plan from making. The join table exists; the rows arrive with OD-23, alongside the rate tables, in the same reviewed pull request. Task 9's seed file therefore lists components and schemes and **no join row**, and Task 9 Step 6's test asserts the join table is empty after a fresh seed.

**Files:**
- Create: `packages/db/migrations/0083_create_pay_component_compensation.sql`, `packages/db/migrations/0083.down.sql`, `packages/db/src/hr/compensation.ts`, `packages/db/src/schema/pay-component.ts`, `packages/db/src/schema/compensation-line.ts`, `packages/db/test/hr/compensation.test.ts`, `docs/adr/0072-effective-dated-hr-rows-are-closed-not-edited.md`
- Modify: `packages/db/test/fixtures.ts` (`seedPayComponent`), `packages/db/src/hr/index.ts`

**Interfaces**

- Consumes: `app.forbid_self_pay` (Task 1); `app.account` (0001); `Money`, `Quantity`, `MONEY_SCALE` (§4.2.1); `seedEmployee`, `seedAccount`, `grantCodes` (§4.17).
- Produces:

```ts
// packages/db/test/fixtures.ts — §4.17's row for 8A
export async function seedPayComponent(
  db: Db, s: Seed,
  opts: { code?: string; kind?: "earning" | "deduction"; expenseAccountId?: string; quantityBased?: boolean } = {},
): Promise<string>;

// packages/db/src/hr/compensation.ts
export interface PayComponent {
  id: string; code: string; nameEn: string; nameAr: string | null;
  kind: "earning" | "deduction"; expenseAccountId: string | null; payableAccountId: string | null;
  quantityBased: boolean; schemeIds: string[]; archivedAt: string | null;
}
export interface CompensationLine {
  id: string; employeeId: string; componentId: string; effectiveFrom: string; effectiveTo: string | null;
  amount: Money | null; quantity: Quantity | null; enteredBy: string;
}
export function listPayComponents(tx: Sql, companyId: string, opts?: { includeArchived?: boolean }): Promise<PayComponent[]>;
export function setComponentSchemes(tx: Sql, componentId: string, schemeIds: readonly string[]): Promise<void>;
export function listCompensation(tx: Sql, employeeId: string): Promise<CompensationLine[]>;
/** The lines in force on `on`. This is the shape 8B's `EmployeePeriodInput.compensation` is built from. */
export function compensationOn(tx: Sql, employeeId: string, on: string): Promise<CompensationLine[]>;
/** Close-then-open per (employee, component): the previous open line of the SAME component is closed. */
export function openCompensation(tx: Sql, input: {
  employeeId: string; componentId: string; effectiveFrom: string; amount: Money | null; quantity: Quantity | null;
}): Promise<string>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/hr/compensation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { lintSchema } from "../../src/lint-schema";
import { compensationOn, listCompensation, listPayComponents, openCompensation } from "../../src/hr/compensation";
import { grantCodes, seedEmployee, seedPayComponent, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const MYR = currency("MYR");

describe("migration 0083 — pay components, the scheme join, and effective-dated compensation", () => {
  let db: Db; let a: Seed; let b: Seed; let officer: string; let clerk: string;
  let employeeId: string; let basicId: string; let unpaidId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-comp-a"); b = await seedTenant(db, "8a-comp-b");
    officer = await uuidv7(db.admin); clerk = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [id, n] of [[officer, "Officer"], [clerk, "Clerk"]] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${id}, ${`sub-${id}`}, 'human', ${n})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, { codes: ["hr.compensation.read", "hr.compensation.manage", "hr.pay_component.manage"], principalId: officer, roleCode: "t-comp-officer" });
    // `clerk` is granted NOTHING — the same reason as the two files before it: `hr.employee.read` is
    // 6C's row and may be absent under `8A-FIRST`, and the one case that uses `clerk` asserts zero
    // `compensation_line` rows, which a member holding no HR code already produces.
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-COMP" });
    basicId = await seedPayComponent(db, a, { code: "BASIC", kind: "earning" });
    unpaidId = await seedPayComponent(db, a, { code: "UNPAID_LEAVE", kind: "deduction", quantityBased: true });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("pay_component.kind admits exactly two values — never a third for employer contributions (spec:2079)", async () => {
    await expect(withTenant(db.rw, a.tenant, officer, (tx) => tx`
      insert into app.pay_component (tenant_id, company_id, code, name_en, kind)
      values (${a.tenant}, ${a.company}, 'EMPLOYER_EPF', 'Employer EPF', 'employer_contribution')`))
      .rejects.toThrow(/pay_component_kind_check/);
  });

  it("pay_component_scheme is a join table with no id and no created_at (§3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'pay_component_scheme'`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(["component_id", "scheme_id", "tenant_id"]);
  });

  it("no component carries a `subject to` boolean — the join table is the only applicability store (RC-3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'pay_component'`;
    expect(cols.map((c) => c.column_name).filter((n) => /^subject_|_epf$|_socso$|_eis$|_pcb$/.test(n))).toEqual([]);
  });

  it("expense_account_id and payable_account_id are NULLABLE — 8B seeds the accounts (§4.12.2, A2)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'pay_component' and column_name like '%account_id'`;
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
  });

  it("an amount is numeric(19,4) and survives a round trip through Money", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, { employeeId, componentId: basicId, effectiveFrom: "2026-01-01", amount: Money.of("3500.0000", MYR), quantity: null }));
    const [line] = await withTenant(db.rw, a.tenant, officer, (tx) => listCompensation(tx, employeeId));
    expect(line!.amount!.toString()).toBe("3500.0000");
    expect(line!.enteredBy).toBe(officer);
  });

  it("a raise closes the old line and opens a new one — history IS the closed rows (spec:2077)", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, { employeeId, componentId: basicId, effectiveFrom: "2026-07-01", amount: Money.of("4000.0000", MYR), quantity: null }));
    const lines = await withTenant(db.rw, a.tenant, officer, (tx) => listCompensation(tx, employeeId));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.effectiveFrom).toBe("2026-07-01");
    expect(lines[0]!.effectiveTo).toBeNull();
    expect(lines[1]!.effectiveTo).toBe("2026-06-30");
    expect((await withTenant(db.rw, a.tenant, officer, (tx) => compensationOn(tx, employeeId, "2026-03-15")))[0]!.amount!.toString()).toBe("3500.0000");
    expect((await withTenant(db.rw, a.tenant, officer, (tx) => compensationOn(tx, employeeId, "2026-09-15")))[0]!.amount!.toString()).toBe("4000.0000");
  });

  it("two OPEN lines of the same component cannot coexist, but two components can", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, { employeeId, componentId: unpaidId, effectiveFrom: "2026-07-01", amount: null, quantity: null }));
    const open = await withTenant(db.rw, a.tenant, officer, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.compensation_line where employee_id = ${employeeId} and effective_to is null`);
    expect(open[0]!.n).toBe("2");
    await expect(withTenant(db.rw, a.tenant, officer, (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
      values (${a.tenant}, ${employeeId}, ${basicId}, '2026-08-01', 4200.0000)`))
      .rejects.toThrow(/compensation_line_open_idx|duplicate key/);
  });

  it("compensation_gate: a principal without hr.compensation.read gets zero rows by direct SQL (test 32)", async () => {
    const rows = await withTenant(db.rw, a.tenant, clerk, (tx) =>
      tx<{ id: string }[]>`select id from app.compensation_line`);
    expect(rows).toHaveLength(0);
  });

  it("R4: a principal cannot open their own compensation line (spec:2175, test 31)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-COMP-SELF", principalId: officer });
    await expect(withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, { employeeId: mine, componentId: basicId, effectiveFrom: "2026-01-01", amount: Money.of("9999.0000", MYR), quantity: null })))
      .rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("tenant B sees no component and no line of tenant A (test 12)", async () => {
    const comps = await withTenant(db.rw, b.tenant, b.human, (tx) => listPayComponents(tx, a.company));
    expect(comps).toHaveLength(0);
    const lines = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ id: string }[]>`select id from app.compensation_line where employee_id = ${employeeId}`);
    expect(lines).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0083", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("no payroll account exists after 0083 — 8A seeds none (hazard 33, A2)", async () => {
    // No account is seeded here. `seedTenant` has already created `1000 Cash` and `4000 Sales` in
    // this very company (§4.1, §4.15), `app.account` carries unique (company_id, code), and §4.17's
    // `seedAccount` is a plain insert with no upsert — so a `seedAccount(db, a, { code: "1000" })`
    // would raise a duplicate key and fail this case for a reason that has nothing to do with it.
    // `a.cash` is the id of that row if a non-payroll account is ever wanted here.
    const [n] = await db.admin<{ n: string }[]>`
      select count(*)::text as n from app.account where code in ('2400','1400','5300','2411','2412','2413','2414','5311','5312','5313','5314')`;
    expect(n!.n).toBe("0");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/compensation.test.ts
```

Expected: **FAIL** at import — `Cannot find module '../../src/hr/compensation'` and `seedPayComponent is not exported from '../fixtures'`.

- [ ] **Step 3: Write `0083_create_pay_component_compensation.sql`**

```sql
-- ── 0083_create_pay_component_compensation.sql ─────────────────────────────────────────────────
-- §3.10.1 "Pay components" and "Compensation lines" (spec:2078-2079). Three tables:
--   pay_component        — a typed catalogue, kind is TWO-valued and never three (§4.6.1)
--   pay_component_scheme — the join that replaces "subject to X" booleans (RC-3, spec:2078)
--   compensation_line    — effective-dated; the history IS the closed rows (ADR 0072)
-- The account columns are NULLABLE: 8B seeds 5300/2400/1400 and 2411..2414 and sets them
-- (§4.12.2, §4.15, 8A amendment A2). This slice writes no account code (hazard 33).

create table app.pay_component (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  code               text not null,
  name_en            text not null,
  name_ar            text,
  kind               text not null,
  expense_account_id uuid,                       -- 8B: 5300 for every earning component (§4.15)
  payable_account_id uuid,                       -- 8B: 2400 net, 1400 for the advance-recovery component
  quantity_based     boolean not null default false,   -- days x daily rate (spec:2078 "unpaid-leave deduction")
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  constraint pay_component_kind_check check (kind in ('earning', 'deduction')),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  foreign key (tenant_id, expense_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, payable_account_id) references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pay_component');
call app_meta.attach_audit('app.pay_component');

comment on constraint pay_component_kind_check on app.pay_component is
  'spec:2079 and §4.6.1: exactly earning | deduction. An EMPLOYER contribution is the employer share of a statutory_scheme, selected in the PAYROLL policy by when: { "line.share": "employer" } and posted from statutory_scheme.employer_expense_account_id -- never a third kind here.';

-- The join table: no id, no created_at (§3.5.3 NO_ID_TABLES). Applicability is DATA, not a boolean.
create table app.pay_component_scheme (
  tenant_id    uuid not null references app.tenant(id),
  component_id uuid not null,
  scheme_id    uuid not null,                    -- app.statutory_scheme arrives in migration 0084
  primary key (component_id, scheme_id),
  -- Global Constraint 8's `unique (tenant_id, <pk>)` form for a NO_ID_TABLES member (§3.5.3), the
  -- same shape employee_sensitive's `unique (tenant_id, employee_id)` takes. Nothing in this slice
  -- makes a composite FK to this table, so the key is not load-bearing today; it is here because a
  -- table with no tenant-scoped unique key is one that no later slice CAN point a composite FK at,
  -- and because the recipe of §3.5.1 has no exceptions worth arguing over one line.
  unique (tenant_id, component_id, scheme_id),
  foreign key (tenant_id, component_id) references app.pay_component(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pay_component_scheme');
-- NO SPACE after the comma. Plan 0A's app.audit_row() splits this argument with
-- `unnest(string_to_array(v_keys, ','))` and then reads `rec ->> k` per element (plan0A:2320-2325),
-- so 'component_id, scheme_id' would make the second key the literal ' scheme_id', `rec ->> ' scheme_id'`
-- NULL, and `string_agg` would silently drop it — every audit row for this table would carry only the
-- component id and the two rows of one component would be indistinguishable in the trail. All eight of
-- 0A's own composite calls are written without a space ('tenant_id,principal_id',
-- 'company_id,series,fiscal_period_id', plan0A:2348-2355); this one matches them.
call app_meta.attach_audit('app.pay_component_scheme', 'tenant_column', 'component_id,scheme_id');
comment on table app.pay_component_scheme is
  'spec:2078 RC-3: "no subject to X booleans". The scheme FK is added by migration 0084, which creates app.statutory_scheme; ordering, not an omission. Rows arrive with OD-23: which components a scheme applies to is a STATUTORY claim and this repository states none (spec:2080).';

create table app.compensation_line (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  employee_id    uuid not null,
  component_id   uuid not null,
  effective_from date not null,
  effective_to   date,
  amount         numeric(19,4),
  quantity       numeric(19,6),
  entered_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check (amount is not null or quantity is not null),
  foreign key (tenant_id, employee_id)  references app.employee(tenant_id, id),
  foreign key (tenant_id, component_id) references app.pay_component(tenant_id, id)
);

-- At most one OPEN line per (employee, component). A raise is a new row; the old one is closed.
create unique index compensation_line_open_idx
  on app.compensation_line (employee_id, component_id) where effective_to is null;
create index compensation_line_period_idx
  on app.compensation_line (employee_id, effective_from, effective_to);

call app_meta.enable_tenant_rls('app.compensation_line');
call app_meta.attach_audit('app.compensation_line');
call app_meta.attach_stamp('app.compensation_line', 'entered_by');

create policy compensation_gate on app.compensation_line as restrictive
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

create trigger compensation_line_no_self_pay
  before insert or update on app.compensation_line
  for each row execute function app.forbid_self_pay('employee_id');
```

`packages/db/migrations/0083.down.sql`:

```sql
drop trigger if exists compensation_line_no_self_pay on app.compensation_line;
drop policy  if exists compensation_gate on app.compensation_line;
drop index   if exists app.compensation_line_period_idx;
drop index   if exists app.compensation_line_open_idx;
drop table   if exists app.compensation_line;
drop table   if exists app.pay_component_scheme;
drop table   if exists app.pay_component;
```

- [ ] **Step 4: Write `packages/db/src/hr/compensation.ts`**

```ts
import { Money, Quantity, currency } from "@dulja/domain";
import type { Sql } from "postgres";

export interface PayComponent {
  id: string; code: string; nameEn: string; nameAr: string | null;
  kind: "earning" | "deduction"; expenseAccountId: string | null; payableAccountId: string | null;
  quantityBased: boolean; schemeIds: string[]; archivedAt: string | null;
}
export interface CompensationLine {
  id: string; employeeId: string; componentId: string; effectiveFrom: string; effectiveTo: string | null;
  amount: Money | null; quantity: Quantity | null; enteredBy: string;
}

export async function listPayComponents(tx: Sql, companyId: string, opts: { includeArchived?: boolean } = {}): Promise<PayComponent[]> {
  const rows = await tx<{ id: string; code: string; name_en: string; name_ar: string | null; kind: "earning" | "deduction";
    expense_account_id: string | null; payable_account_id: string | null; quantity_based: boolean;
    archived_at: string | null; scheme_ids: string[] }[]>`
    select c.id, c.code, c.name_en, c.name_ar, c.kind, c.expense_account_id, c.payable_account_id,
           c.quantity_based, c.archived_at::text as archived_at,
           coalesce(array_agg(s.scheme_id) filter (where s.scheme_id is not null), '{}') as scheme_ids
      from app.pay_component c
      left join app.pay_component_scheme s on s.component_id = c.id
     where c.company_id = ${companyId}
       and (${opts.includeArchived ?? false} or c.archived_at is null)
     group by c.id
     order by c.kind, c.code`;
  return rows.map((r) => ({
    id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, kind: r.kind,
    expenseAccountId: r.expense_account_id, payableAccountId: r.payable_account_id,
    quantityBased: r.quantity_based, schemeIds: r.scheme_ids, archivedAt: r.archived_at,
  }));
}

/**
 * Adds the missing joins, idempotently. **Removing one is not possible and must not be**: `app_rw`
 * holds DELETE on exactly five tables (§3.5.4's pinned list, which only 2B ever extended) and
 * spec:2049 admits deletion for drafts and the erasure workflow alone. A component whose statutory
 * applicability changes is ARCHIVED and replaced by a new component, exactly as an account is —
 * which is also what keeps a posted payroll line's applicability legible years later.
 * Applicability is data, never a "subject to X" boolean (spec:2078, RC-3).
 */
export async function setComponentSchemes(tx: Sql, componentId: string, schemeIds: readonly string[]): Promise<void> {
  if (schemeIds.length === 0) return;
  await tx`
    insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
    select c.tenant_id, c.id, s.scheme_id
      from app.pay_component c
      join unnest(${tx.array([...schemeIds])}::uuid[]) as s(scheme_id) on true
     where c.id = ${componentId}
    on conflict (component_id, scheme_id) do nothing`;
}
```

```ts
interface RawLine {
  id: string; employee_id: string; component_id: string; effective_from: string;
  effective_to: string | null; amount: string | null; quantity: string | null;
  entered_by: string; base_currency: string;
}

/** `base_currency` is read from `app.company` rather than hard-coded: v1 payroll is single-currency
 *  (spec:2093 puts multi-currency payroll out of v1) and reading it keeps the one currency literal
 *  out of this file. `Money` still refuses a cross-currency add at compile time wherever the
 *  currency is a known literal (§4.2.1). */
const toLine = (r: RawLine): CompensationLine => ({
  id: r.id, employeeId: r.employee_id, componentId: r.component_id,
  effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  amount: r.amount === null ? null : Money.of(r.amount, currency(r.base_currency)),
  quantity: r.quantity === null ? null : Quantity.of(r.quantity),
  enteredBy: r.entered_by,
});

export async function listCompensation(tx: Sql, employeeId: string): Promise<CompensationLine[]> {
  const rows = await tx<RawLine[]>`
    select l.id, l.employee_id, l.component_id, l.effective_from::text as effective_from,
           l.effective_to::text as effective_to, l.amount::text as amount, l.quantity::text as quantity,
           l.entered_by, co.base_currency
      from app.compensation_line l
      join app.employee e on e.id = l.employee_id
      join app.company  co on co.id = e.company_id
     where l.employee_id = ${employeeId}
     order by l.effective_from desc, l.component_id`;
  return rows.map(toLine);
}

export async function compensationOn(tx: Sql, employeeId: string, on: string): Promise<CompensationLine[]> {
  const rows = await tx<RawLine[]>`
    select l.id, l.employee_id, l.component_id, l.effective_from::text as effective_from,
           l.effective_to::text as effective_to, l.amount::text as amount, l.quantity::text as quantity,
           l.entered_by, co.base_currency
      from app.compensation_line l
      join app.employee e on e.id = l.employee_id
      join app.company  co on co.id = e.company_id
     where l.employee_id = ${employeeId} and l.effective_from <= ${on}::date
       and (l.effective_to is null or l.effective_to >= ${on}::date)
     order by l.component_id`;
  return rows.map(toLine);
}

/** Close-then-open, one transaction (ADR 0072). Returns the new line's id. */
export async function openCompensation(tx: Sql, input: {
  employeeId: string; componentId: string; effectiveFrom: string; amount: Money | null; quantity: Quantity | null;
}): Promise<string> {
  await tx`
    update app.compensation_line
       set effective_to = (${input.effectiveFrom}::date - interval '1 day')::date
     where employee_id = ${input.employeeId} and component_id = ${input.componentId}
       and effective_to is null and effective_from < ${input.effectiveFrom}::date`;
  const [row] = await tx<{ id: string }[]>`
    insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
    select e.tenant_id, e.id, ${input.componentId}, ${input.effectiveFrom}::date,
           ${input.amount === null ? null : input.amount.toString()}::numeric,
           ${input.quantity === null ? null : input.quantity.toString()}::numeric
      from app.employee e where e.id = ${input.employeeId}
    returning id`;
  if (row === undefined) throw new Error(`employee ${input.employeeId} is not visible to this transaction`);
  return row.id;
}
```

- [ ] **Step 5: Write the two Drizzle mirrors (§3.4.9)**

`packages/db/src/schema/pay-component.ts` — both tables, because they ship in one migration:

```ts
import { boolean, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const payComponent = app.table("pay_component", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  kind: text("kind").notNull().$type<"earning" | "deduction">(),
  expenseAccountId: uuid("expense_account_id"),
  payableAccountId: uuid("payable_account_id"),
  quantityBased: boolean("quantity_based").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** No `id`, no `created_at` — a pure join table (§3.5.3 NO_ID_TABLES). */
export const payComponentScheme = app.table("pay_component_scheme", {
  tenantId: uuid("tenant_id").notNull(),
  componentId: uuid("component_id").notNull(),
  schemeId: uuid("scheme_id").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.componentId, t.schemeId] }) }));
```

`packages/db/src/schema/compensation-line.ts`:

```ts
import { date, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const compensationLine = app.table("compensation_line", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  componentId: uuid("component_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  // numeric(19,4) and numeric(19,6) reach TypeScript as STRINGS and are wrapped in Money/Quantity
  // by `toLine`. A `number` here would be caught by `no-number-money` (§3.7.5) — and would be wrong
  // before the lint ever ran (spec:2041).
  amount: numeric("amount", { precision: 19, scale: 4 }),
  quantity: numeric("quantity", { precision: 19, scale: 6 }),
  enteredBy: uuid("entered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 6: Add `seedPayComponent` to `packages/db/test/fixtures.ts`**

Append (never edit an existing helper — §4.1, hazard 9):

```ts
/**
 * One row of the pay-component catalogue (§4.6.1; spec:2078-2079). §4.17's 8A row.
 * `kind` is TWO-valued; an employer contribution is a scheme's employer share, never a component.
 * The account columns are left null: 8B seeds 5300/2400/1400 and sets them (§4.12.2, amendment A2).
 */
export async function seedPayComponent(
  db: Db,
  s: Seed,
  opts: { code?: string; kind?: "earning" | "deduction"; expenseAccountId?: string; quantityBased?: boolean } = {},
): Promise<string> {
  const code = opts.code ?? `PC-${(await uuidv7(db.admin)).slice(-8)}`;
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.pay_component (id, tenant_id, company_id, code, name_en, kind, expense_account_id, quantity_based)
    values (${id}, ${s.tenant}, ${s.company}, ${code}, ${code}, ${opts.kind ?? "earning"},
            ${opts.expenseAccountId ?? null}, ${opts.quantityBased ?? false})`);
  return id;
}
```

- [ ] **Step 7: Write ADR 0072**

`docs/adr/0072-effective-dated-hr-rows-are-closed-not-edited.md`:

```markdown
# ADR 0072 — Effective-dated HR rows are closed, never edited

Status: Accepted
Date: 2026-09-08
Slice: 8A

## Context

spec:2077 says of compensation: "Salary history is the closed rows; a promotion is a new row", and
of the statutory profile that it is "effective-dated per employee". §4.6.1 gives both tables
`effective_from` and a nullable `effective_to` and nothing else. What it does not say is what stops
two open rows, what closes the previous one, and where.

R3 (spec:2174) makes the answer load-bearing beyond tidiness: "a compensation change effective in
the period of a run in `submitted` or `approved` status returns that run to `draft`". 8B's trigger
detects such a change by looking for a row whose effective window overlaps the run's period. If a
raise were an UPDATE of the existing row, there would be nothing to detect — the row's identity
would not change and the audit before-image would be the only evidence, which is not a queryable
trigger condition.

## Decision

**Close-then-open, in one transaction, in one function per table.**
`openCompensation` and `openStatutoryProfile` set the previous open row's `effective_to` to
`effective_from - 1 day` and insert the new row. Neither function updates a business column of an
existing row, and no route exposes a `PATCH` that would.

**"At most one open row" is a database fact, not a convention.** A partial unique index —
`compensation_line (employee_id, component_id) where effective_to is null` and
`employee_statutory_profile (employee_id) where effective_to is null` — refuses the second one, so
a direct `app_rw` insert cannot produce the state the read path assumes.

**Backdating before the current open row is refused** by the same index: the close statement is
guarded by `effective_from < <new>`, so an attempt to open a row *earlier* than the open one leaves
the old row open and the insert collides. Correcting history is therefore an explicit two-step by a
human, not an accident.

## Consequences

- `compensationOn(employeeId, date)` and `profileOn(employeeId, date)` are simple range reads with
  no "latest wins" tie-break, because ties cannot exist.
- 8B's R3 trigger has a queryable condition: a row whose `[effective_from, effective_to]` overlaps
  the run's period and whose `created_at` is after the run's `calculated_at`.
- The audit log carries the whole history twice — once as the closed rows, once as before/after
  images. That is redundancy on purpose: the rows answer "what was in force", the audit answers
  "who changed it and when" (spec:2105, LEGACY-029/030).
- Genuine correction of a mistyped row is a *new* row plus an archived old one, never an UPDATE.
  spec:2049 admits no deletion here.

## Rejected

- **A `valid_range daterange` column with an exclusion constraint.** More expressive, and it makes
  every read a range-operator query that 8B, 8C and 8D would each have to spell correctly. Two date
  columns and a partial index give the same guarantee with the query shape everyone already writes.
- **A separate `*_history` table.** Two tables to keep consistent, and the "current" one becomes a
  projection nobody rebuilds. The spec's own sentence — "history is the closed rows" — rejects it.
```

- [ ] **Step 8: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run db:lint && bun run test -- test/hr/compensation.test.ts
cd ../.. && bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 12 passing, `0 violations`, and the same three `permission-catalogue` lines as Task 5.

```bash
git add packages/db/migrations/0083_create_pay_component_compensation.sql packages/db/migrations/0083.down.sql \
        packages/db/src/hr/compensation.ts packages/db/src/hr/index.ts \
        packages/db/src/schema/pay-component.ts packages/db/src/schema/compensation-line.ts \
        packages/db/test/fixtures.ts packages/db/test/hr/compensation.test.ts \
        docs/adr/0072-effective-dated-hr-rows-are-closed-not-edited.md
git commit -m "$(cat <<'EOF'
feat(db): pay components, the scheme join, and effective-dated compensation [8A T6]

Migration 0083. pay_component.kind is TWO-valued and a CHECK says so: an employer contribution is
the employer share of a statutory_scheme, reached through pay_component_scheme, never a third kind
(spec:2079, §4.6.1). pay_component_scheme replaces every "subject to X" boolean (RC-3) and ships
with NO rows -- which components a scheme applies to is a statutory claim, and it arrives with
OD-23. compensation_line is effective-dated with a partial unique index making "at most one open
line per employee per component" a database fact, so 8B's R3 trigger has something to detect
(ADR 0072). The account columns are nullable: 8B seeds 5300/2400/1400 (amendment A2, hazard 33).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The compensation and pay-component routes, and test 31's R4 clause through the API

**One new route module and two sub-paths.** `payComponentRoutes` at `/v1/companies/:companyId/pay-components` is the catalogue (amendment A7, one `PROBES` key); `GET|POST …/employees/{employeeId}/compensation-lines` join 6C's `employees` module and add no key (hazard 31).

**Acceptance test 31's R4 clause is proved here through the API**, not only by direct SQL: spec:2449 says *"a principal cannot alter their own compensation, sensitive data or leave approval"* **"through any path — API, job, or direct SQL as `app_rw`"**. Tasks 1, 3, 5 and 6 proved the SQL path; this task proves the API path for compensation and files the whole R4 set in `tests/regression/legacy-045.test.ts` at Task 14.

**Files:**
- Create: `apps/api/src/routes/hr/pay-components.ts`, `apps/api/src/routes/hr/compensation.ts`, `packages/contracts/src/hr/pay-component.ts`, `packages/contracts/src/hr/compensation.ts`, `apps/api/test/routes/hr/pay-components.test.ts`, `apps/api/test/routes/hr/compensation.test.ts`
- Modify: `apps/api/src/routes/index.ts` (one module inside `buildRoutes`), `apps/api/src/routes/hr/employees-composed.ts` (one `route()` line), `packages/db/src/hr/compensation.ts` (`createPayComponent`, `renamePayComponent`, `archivePayComponent` — appended, changing no existing export), `packages/db/src/hr/index.ts` (re-export the three), `tests/invariants/probes.ts` (one `PROBES` entry), `packages/contracts/openapi.json`

**Interfaces**

- Consumes: `listPayComponents`, `setComponentSchemes`, `listCompensation`, `compensationOn`, `openCompensation` (Task 6); `PERMISSION["hr.pay_component.manage"]`, `PERMISSION["hr.compensation.read"]`, `PERMISSION["hr.compensation.manage"]` (Task 2); `requirePermission`, `ScopeSource` (§4.2.5); `ListEnvelope`, `ListQuery`, `MoneySchema`, `QuantitySchema` (§4.2.8); `IsolationProbe`, `PROBES` (§4.2.7); `hrFixture`, `hrActor` (A6); `Money`, `Quantity`, `currency` (§4.2.1).
- Produces:

```ts
// apps/api/src/routes/hr/pay-components.ts
export const payComponentRoutes: OpenAPIHono<AppEnv>;
export const payComponentRouteModule: RouteModule;   // path "/v1/companies/:companyId/pay-components"
// apps/api/src/routes/hr/compensation.ts
export const compensationRoutes: OpenAPIHono<AppEnv>;  // mounted INTO the employees module — no module of its own
// packages/db/src/hr/compensation.ts — three writes appended to Task 6's file
export function createPayComponent(tx: Sql, companyId: string, input: { code: string; nameEn: string; nameAr: string | null; kind: "earning" | "deduction"; quantityBased: boolean }): Promise<string>;
export function renamePayComponent(tx: Sql, componentId: string, input: { nameEn?: string; nameAr?: string | null }): Promise<void>;
export function archivePayComponent(tx: Sql, componentId: string): Promise<void>;
// packages/contracts/src/hr/pay-component.ts
export const PayComponentSchema, PayComponentKindSchema, CreatePayComponentBody, UpdatePayComponentBody, SetComponentSchemesBody, PayComponentQuery, PayComponentList;
export type PayComponentDto;
// packages/contracts/src/hr/compensation.ts
export const CompensationLineSchema, OpenCompensationBody, CompensationQuery, CompensationList;
export type CompensationLineDto;
```

- [ ] **Step 1: Write the failing route tests**

`apps/api/test/routes/hr/compensation.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("compensation lines over HTTP — and test 31's R4 clause through the API", () => {
  let f: HrFixture; let target: string; let basic: string;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-compensation");
    target = f.employees[0]!.id;
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false },
    });
    basic = ((await res.json()) as { id: string }).id;
  }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  it("opens a line and reads it back with a Money-shaped amount", async () => {
    const post = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer,
      body: { componentId: basic, effectiveFrom: "2026-01-01", amount: { amount: "3500.0000", currency: "MYR" } },
    });
    expect(post.status).toBe(201);
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer });
    const body = await get.json() as { items: { amount: { amount: string; currency: string } | null; effectiveTo: string | null }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.amount).toEqual({ amount: "3500.0000", currency: "MYR" });
    expect(body.items[0]!.effectiveTo).toBeNull();
  });

  it("a raise closes the previous line in the same request", async () => {
    await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer,
      body: { componentId: basic, effectiveFrom: "2026-07-01", amount: { amount: "4000.0000", currency: "MYR" } },
    });
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer });
    const body = await get.json() as { items: { effectiveFrom: string; effectiveTo: string | null }[] };
    expect(body.items.map((i) => [i.effectiveFrom, i.effectiveTo])).toEqual([["2026-07-01", null], ["2026-01-01", "2026-06-30"]]);
  });

  it("test 31 R4: the officer cannot open a line on their OWN employee row through the API", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${self.id}/compensation-lines`, as: f.officer,
      body: { componentId: basic, effectiveFrom: "2026-01-01", amount: { amount: "99999.0000", currency: "MYR" } },
    });
    expect(res.status).toBe(409);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_HR_SELF_PAY");
    expect(p.detail).toContain(f.officer);
  });

  it("test 32: a principal without hr.compensation.read gets 403, and the list carries no amount", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.outsider });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  // Two different mechanisms, one assertion: `filter[amount][gt]` is an undeclared key and dies on
  // `CompensationQuery`'s `.strict()`; `sort` is a DECLARED `ListQuery` member and dies on its
  // `.max(0, …)` bound. Removing either one turns the matching row of this loop into a silent 200.
  it("test 32: amount is not a declared filter or sort field", async () => {
    for (const q of ["filter[amount][gt]=1000", "sort=-amount"]) {
      const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines?${q}`, as: f.officer });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("an amount with the wrong scale is refused by MoneySchema before it reaches SQL", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer,
      body: { componentId: basic, effectiveFrom: "2027-01-01", amount: { amount: "4000.00", currency: "MYR" } },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a line with neither amount nor quantity is refused", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/employees/${target}/compensation-lines`, as: f.officer,
      body: { componentId: basic, effectiveFrom: "2027-06-01" },
    });
    expect([400, 422]).toContain(res.status);
  });

  it("an employee of another tenant is 404", async () => {
    const res = await f.api.request({
      method: "GET", path: `/v1/companies/${f.companyId}/employees/00000000-0000-7000-8000-0000000000ff/compensation-lines`, as: f.officer });
    expect(res.status).toBe(404);
  });
});
```

`apps/api/test/routes/hr/pay-components.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("the pay-component catalogue over HTTP", () => {
  let f: HrFixture; let basic: string;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-pay-components");
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false } });
    basic = ((await res.json()) as { id: string }).id;
  }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  it("creates and lists, with the account columns null until 8B seeds them (amendment A2)", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer });
    const body = await res.json() as { items: { code: string; kind: string; expenseAccountId: string | null; schemeIds: string[] }[] };
    const row = body.items.find((i) => i.code === "BASIC")!;
    expect(row.kind).toBe("earning");
    expect(row.expenseAccountId).toBeNull();
    expect(row.schemeIds).toEqual([]);          // applicability arrives with OD-23 (T6)
  });

  it("a third kind is ERR_VALIDATION_FAILED at the Zod layer, before the CHECK ever runs (spec:2079)", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "EMPLOYER_EPF", nameEn: "Employer EPF", kind: "employer_contribution" } });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the create body accepts no account id — 8B's seed owns that wiring", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "STRAY", nameEn: "Stray", kind: "earning", expenseAccountId: "00000000-0000-7000-8000-000000000001" } });
    expect(res.status).toBe(400);   // an unknown property: CreatePayComponentBody is closed
  });

  it("a duplicate code in one company is ERR_CONFLICT_UNIQUE; another company may reuse it", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary again", kind: "earning" } });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a principal without hr.pay_component.manage cannot create, and one without hr.compensation.read cannot list", async () => {
    const post = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.outsider,
      body: { code: "NOPE", nameEn: "Nope", kind: "earning" } });
    expect(post.status).toBe(403);
    const get = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/pay-components`, as: f.outsider });
    expect(get.status).toBe(403);
  });

  // **The `PUT …/schemes` unknown-scheme case is NOT here.** Amendment A13 makes
  // `pay_component_scheme.scheme_id` an unconstrained FK *slot* in 0083; the constraint arrives in
  // 0084 (Task 8). At the end of Task 7 an unknown id therefore INSERTS and the route answers 201,
  // so an ERR_CONFLICT_REFERENCE assertion written here would be red for two tasks and Global
  // Constraint 19's "green after every task" would be broken by the plan itself. The case lives in
  // Task 10 Step 1, the first suite that runs with the constraint in place.

  it("archiving sets archivedAt and drops the row from the default list (spec:2049 — never DELETE)", async () => {
    const created = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "OLD_BONUS", nameEn: "Old bonus", kind: "earning" } });
    const id = ((await created.json()) as { id: string }).id;
    expect((await f.api.request({ method: "POST", path: `/v1/companies/${f.companyId}/pay-components/${id}/archive`, as: f.officer })).status).toBe(200);
    const listed = await (await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer })).json() as { items: { code: string }[] };
    expect(listed.items.map((i) => i.code)).not.toContain("OLD_BONUS");
    const all = await (await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/pay-components?filter[archived][eq]=true`, as: f.officer })).json() as { items: { code: string; archivedAt: string | null }[] };
    expect(all.items.find((i) => i.code === "OLD_BONUS")!.archivedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/api && bun run test -- test/routes/hr/compensation.test.ts test/routes/hr/pay-components.test.ts
```

Expected: **FAIL** in `beforeAll` — `POST /v1/companies/{id}/pay-components` answers 404, so `basic` is `undefined` and every case reports `Cannot read properties of undefined (reading 'id')`.

- [ ] **Step 3: Write the contracts modules**

`packages/contracts/src/hr/pay-component.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** Two values. spec:2079 and §4.6.1: an employer contribution is a scheme's employer share. */
export const PayComponentKindSchema = z.enum(["earning", "deduction"]).openapi("PayComponentKind");

export const PayComponentSchema = z.object({
  id: UuidSchema,
  code: z.string().min(1).max(40),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  kind: PayComponentKindSchema,
  expenseAccountId: UuidSchema.nullable(),
  payableAccountId: UuidSchema.nullable(),
  quantityBased: z.boolean(),
  schemeIds: z.array(UuidSchema),
  archivedAt: TimestampSchema.nullable(),
}).openapi("PayComponent");

export const CreatePayComponentBody = z.object({
  code: z.string().min(1).max(40),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  kind: PayComponentKindSchema,
  quantityBased: z.boolean().default(false),
}).strict().openapi("CreatePayComponentBody");
// `expenseAccountId` and `payableAccountId` are deliberately absent from the create body: 8B's
// chart seed sets them from the §4.15 codes, and a caller pointing a component at an arbitrary
// account would make the PAYROLL policy's `line.component.expense_account` unpredictable.
// **`.strict()` is what makes "absent" mean "refused".** A bare `z.object` STRIPS an unknown key and
// answers 201, so a caller sending `expenseAccountId` would get a component with a null account and
// no indication that its field was discarded — the silent-drop failure §4.2.8 keeps out of the API.
// With `.strict()` the same body is ERR_VALIDATION_FAILED, which is what Task 7 Step 1's third case
// asserts. This is the only closed body in the slice; every other one takes 0B's default because it
// has no field a caller could plausibly expect to be honoured.

/** Rename only. `code` and `kind` are absent on purpose and `.strict()` refuses them: a posted
 *  payroll line is read back by component code years later (8D's payslip reprint), and changing
 *  `kind` would reverse the sign of every historical line. A component that is wrong is archived. */
export const UpdatePayComponentBody = z.object({
  nameEn: z.string().min(1).max(200).optional(),
  nameAr: z.string().max(200).nullable().optional(),
}).strict().openapi("UpdatePayComponentBody");

/** The WHOLE join set for a component, replaced in one call — `PUT`, not `POST`, because a partial
 *  set is not a meaningful statutory claim. It is additive in the database (`setComponentSchemes` is
 *  `on conflict do nothing` and there is no removal path — amendment A14), so this body grows a set
 *  and never shrinks one; 8B adds `archived_at` to the join when a mapping must be withdrawn. */
export const SetComponentSchemesBody = z.object({ schemeIds: z.array(UuidSchema) }).strict().openapi("SetComponentSchemesBody");

/** Closed for the same two reasons `CompensationQuery` below is, and closed even though no test of
 *  this slice asserts it: the list handler reads `filter[kind][eq]` and `filter[archived][eq]` and
 *  nothing else, so a caller sending a third key or a `sort=` would have it silently dropped and be
 *  told 200 — the silent-drop failure §4.2.8 exists to keep out of the API. `sort` and `fields` are
 *  `ListQuery` members and survive `.strict()`, so they are bounded on their own keys (0b:4321). */
export const PayComponentQuery = ListQuery.extend({
  "filter[kind][eq]": PayComponentKindSchema.optional(),
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
  fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
}).strict();
export const PayComponentList = ListEnvelope(PayComponentSchema);
export type PayComponentDto = z.infer<typeof PayComponentSchema>;
```

`packages/contracts/src/hr/compensation.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, ListQuery, MoneySchema, QuantitySchema, UuidSchema } from "../common";

export const CompensationLineSchema = z.object({
  id: UuidSchema,
  employeeId: UuidSchema,
  componentId: UuidSchema,
  effectiveFrom: DateSchema,
  effectiveTo: DateSchema.nullable(),
  amount: MoneySchema.nullable(),
  quantity: QuantitySchema.nullable(),
  enteredBy: UuidSchema,
}).openapi("CompensationLine");

export const OpenCompensationBody = z.object({
  componentId: UuidSchema,
  effectiveFrom: DateSchema,
  amount: MoneySchema.optional(),
  quantity: QuantitySchema.optional(),
}).refine((b) => b.amount !== undefined || b.quantity !== undefined,
  { message: "a compensation line needs an amount or a quantity" })
  .openapi("OpenCompensationBody");

/** The ONLY filters: a component and an as-of date. `amount` is deliberately not filterable or
 *  sortable — test 32 forbids a compensation side channel.
 *
 *  **Omitting `amount` is NOT by itself the enforcement, and an earlier draft of this comment said it
 *  was.** §4.2.8's "an undeclared field is ERR_VALIDATION_FAILED" is a statement of the required
 *  behaviour, not of what a bare `z.object` does: a plain Zod object **strips** an unknown key and
 *  answers 200 (1b:3007 says it in as many words), so `?filter[amount][gt]=1000` would be silently
 *  discarded and the test-32 case below would fail on a 200. Two mechanisms close it, and both are
 *  needed because they close different halves:
 *
 *  1. `.strict()` — turns an UNDECLARED key (`filter[amount][gt]`, `filter[nationalId][eq]`) into
 *     ERR_VALIDATION_FAILED. 1B, 5A and 5B do the same on their literal-key query schemas.
 *  2. The two `z.string().max(0, …)` overrides — `sort` and `fields` are DECLARED members of
 *     `ListQuery`, so `.strict()` admits them however sensitive the name they carry, and no handler
 *     in this slice reads either one. Bounding them to the empty string on the same key is 0B's
 *     `AuditLogQuery` remedy (0b:4321, 0b:4617): a `.refine` would wrap the object in `ZodEffects`
 *     and `@hono/zod-openapi` would stop generating query parameters from it.
 *
 *  **0B's `AuditLogQuery` deliberately is NOT `.strict()` and this is not an inconsistency to
 *  "harmonise" later** (0b:7384): the audit log is §4.2.8 Layer 1's open `parseFilters` surface, whose
 *  whole point is accepting keys the schema does not enumerate, and `.strict()` there would break
 *  `legacy-036`'s undeclared-key case. This schema is a Layer 2 literal-key schema, where the enumeration
 *  IS the contract, so closing it is the correct half of the same rule. */
export const CompensationQuery = ListQuery.extend({
  "filter[componentId][eq]": UuidSchema.optional(),
  "filter[effectiveOn][eq]": DateSchema.optional(),
  sort: z.string().max(0, "sort is not supported on this resource").optional(),
  fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
}).strict();
export const CompensationList = ListEnvelope(CompensationLineSchema);
export type CompensationLineDto = z.infer<typeof CompensationLineSchema>;
```

- [ ] **Step 4: Write the routes**

`apps/api/src/routes/hr/compensation.ts` — two sub-paths, mounted into 6C's `employees` module:

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "@dulja/contracts";
import { CompensationList, CompensationQuery, CompensationLineSchema, OpenCompensationBody } from "@dulja/contracts/hr/compensation";
import { PERMISSION } from "@dulja/contracts/permissions";
import { Money, Quantity, currency } from "@dulja/domain";
import { compensationOn, listCompensation, openCompensation, type CompensationLine } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../index";
import type { AppEnv } from "../../context";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;

const toDto = (l: CompensationLine) => ({
  id: l.id, employeeId: l.employeeId, componentId: l.componentId,
  effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo,
  amount: l.amount === null ? null : l.amount.toJSON(),
  quantity: l.quantity === null ? null : l.quantity.toJSON(),
  enteredBy: l.enteredBy,
});

export const compensationRoutes = new OpenAPIHono<AppEnv>();

compensationRoutes.openapi(
  createRoute({
    method: "get", path: "/{employeeId}/compensation-lines", tags: ["hr"],
    request: { params: Params, query: CompensationQuery },
    middleware: [requirePermission(PERMISSION["hr.compensation.read"], gate)],
    responses: { 200: { description: "Newest first", content: { "application/json": { schema: CompensationList } } } },
  }),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const q = c.req.valid("query");
    const on = q["filter[effectiveOn][eq]"];
    const componentId = q["filter[componentId][eq]"];
    const rows = await c.var.withTenant(async (tx) => {
      const exists = await tx<{ id: string }[]>`select id from app.employee where id = ${employeeId}`;
      if (exists.length === 0) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} was not found`);
      return on === undefined ? listCompensation(tx, employeeId) : compensationOn(tx, employeeId, on);
    });
    const items = rows.filter((r) => componentId === undefined || r.componentId === componentId).map(toDto);
    return c.json({ items, next_cursor: null }, 200);
  },
);

compensationRoutes.openapi(
  createRoute({
    method: "post", path: "/{employeeId}/compensation-lines", tags: ["hr"],
    request: { params: Params, headers: IdempotencyHeader, body: { content: { "application/json": { schema: OpenCompensationBody } } } },
    middleware: [requirePermission(PERMISSION["hr.compensation.manage"], gate)],
    responses: { 201: { description: "Opened; the previous line of the same component is closed",
                        content: { "application/json": { schema: CompensationLineSchema } } } },
  }),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      const [company] = await tx<{ base_currency: string }[]>`
        select co.base_currency from app.employee e join app.company co on co.id = e.company_id where e.id = ${employeeId}`;
      if (company === undefined) throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} was not found`);
      const amount = body.amount === undefined ? null
        : Money.of(body.amount.amount, currency(body.amount.currency));
      if (amount !== null && amount.currency !== company.base_currency) {
        throw new AppError("ERR_MONEY_CURRENCY_MISMATCH",
          `compensation is entered in the company's base currency ${company.base_currency}; ${body.amount!.currency} was supplied (v1 payroll is single-currency, spec:2093)`);
      }
      const id = await openCompensation(tx, {
        employeeId, componentId: body.componentId, effectiveFrom: body.effectiveFrom,
        amount, quantity: body.quantity === undefined ? null : Quantity.of(body.quantity),
      });
      const rows = await listCompensation(tx, employeeId);
      return toDto(rows.find((r) => r.id === id)!);
    });
    return c.json(dto, 201);
  },
);
```

**`ERR_MONEY_CURRENCY_MISMATCH` is 0D's row and is already in `ERRORS`** — this slice raises it, it does not register it (Global Constraint 12).

**Three write helpers first.** The catalogue's create, rename and archive are the only 8A writes with no `packages/db/src/hr/` function behind them, and a route that builds its own `insert` is the one place in this slice where the SQL and the shape it returns could drift apart. Append them to `packages/db/src/hr/compensation.ts` (Task 6's file — additively, below `setComponentSchemes`, changing no existing export) and re-export them from `packages/db/src/hr/index.ts`:

```ts
/** Creates one catalogue row. `tenant_id` comes from `app.company`, never from the caller, for the
 *  same reason `writeSensitive`'s does (§3.3). A duplicate `(company_id, code)` raises SQLSTATE
 *  23505, which `fromDatabaseError` maps to ERR_CONFLICT_UNIQUE — the route adds no pre-check, because
 *  a second place deciding uniqueness is a second place to get it wrong. The two account columns are
 *  not parameters: 8B's chart seed sets them (amendment A2, hazard 33). */
export async function createPayComponent(tx: Sql, companyId: string, input: {
  code: string; nameEn: string; nameAr: string | null; kind: "earning" | "deduction"; quantityBased: boolean;
}): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.pay_component (tenant_id, company_id, code, name_en, name_ar, kind, quantity_based)
    select c.tenant_id, c.id, ${input.code}, ${input.nameEn}, ${input.nameAr}, ${input.kind}, ${input.quantityBased}
      from app.company c where c.id = ${companyId}
    returning id`;
  if (row === undefined) throw new Error(`company ${companyId} is not visible to this transaction`);
  return row.id;
}

/** Renames a component. `code` and `kind` are NOT renameable: a posted payroll line's component is
 *  read back by code years later (8D's payslip reprint), and changing `kind` would silently reverse
 *  the sign of every historical line. A component that is wrong is archived and replaced. */
export async function renamePayComponent(tx: Sql, componentId: string, input: { nameEn?: string; nameAr?: string | null }): Promise<void> {
  const res = await tx`
    update app.pay_component
       set name_en = coalesce(${input.nameEn ?? null}, name_en),
           name_ar = case when ${input.nameAr !== undefined} then ${input.nameAr ?? null} else name_ar end
     where id = ${componentId}`;
  if (res.count === 0) throw new Error(`pay component ${componentId} is not visible to this transaction`);
}

/** spec:2049 — HR master data is archived, never deleted, and `app_rw` holds no DELETE on this table
 *  (§3.5.4). Archiving twice is idempotent and is not an error. */
export async function archivePayComponent(tx: Sql, componentId: string): Promise<void> {
  const res = await tx`
    update app.pay_component set archived_at = coalesce(archived_at, now()) where id = ${componentId}`;
  if (res.count === 0) throw new Error(`pay component ${componentId} is not visible to this transaction`);
}
```

`apps/api/src/routes/hr/pay-components.ts` mounts five routes on its own module: `GET /` (list, `hr.compensation.read`), `POST /` (create, `hr.pay_component.manage`), `PATCH /{componentId}` (rename, `hr.pay_component.manage`), `PUT /{componentId}/schemes` (`hr.pay_component.manage`) and `POST /{componentId}/archive` (`hr.pay_component.manage`). The list is gated by `hr.compensation.read` rather than membership because the catalogue names what a company pays for, which spec:2159 keeps from `user` along with compensation itself.

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "@dulja/contracts";
import {
  CreatePayComponentBody, PayComponentList, PayComponentQuery, PayComponentSchema,
  SetComponentSchemesBody, UpdatePayComponentBody,
} from "@dulja/contracts/hr/pay-component";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  archivePayComponent, createPayComponent, listPayComponents, renamePayComponent, setComponentSchemes,
  type PayComponent,
} from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader, type RouteModule } from "../index";
import type { AppEnv } from "../../context";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const ComponentParams = CompanyParams.extend({ componentId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;

const toDto = (c: PayComponent) => ({
  id: c.id, code: c.code, nameEn: c.nameEn, nameAr: c.nameAr, kind: c.kind,
  expenseAccountId: c.expenseAccountId, payableAccountId: c.payableAccountId,
  quantityBased: c.quantityBased, schemeIds: c.schemeIds, archivedAt: c.archivedAt,
});

/** One read, used by every route that has to answer with a component after changing it. Reading the
 *  row back through `listPayComponents` rather than from a `returning` clause is deliberate:
 *  `schemeIds` is an aggregate over `pay_component_scheme`, so a `returning *` would answer with a
 *  field the row does not carry and `PUT …/schemes` would return the joins it just replaced as `[]`. */
const reread = async (tx: Parameters<typeof listPayComponents>[0], companyId: string, componentId: string) => {
  const row = (await listPayComponents(tx, companyId, { includeArchived: true })).find((c) => c.id === componentId);
  if (row === undefined) throw new AppError("ERR_NOT_FOUND", `pay component ${componentId} was not found`);
  return toDto(row);
};

export const payComponentRoutes = new OpenAPIHono<AppEnv>();

payComponentRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["hr"],
    request: { params: CompanyParams, query: PayComponentQuery },
    middleware: [requirePermission(PERMISSION["hr.compensation.read"], gate)],
    responses: { 200: { description: "The catalogue, by kind then code", content: { "application/json": { schema: PayComponentList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // `filter[archived][eq]=true` widens the read to archived rows; absent or `false` is the default
    // list, which carries none. The two are one flag on one query, not two endpoints (§4.2.8's one
    // filter grammar), and `kind` is filtered in memory over a catalogue that is tens of rows.
    const includeArchived = q["filter[archived][eq]"] === "true";
    const kind = q["filter[kind][eq]"];
    const rows = await c.var.withTenant((tx) => listPayComponents(tx, companyId, { includeArchived }));
    const items = rows.filter((r) => kind === undefined || r.kind === kind).map(toDto);
    return c.json({ items, next_cursor: null }, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "post", path: "/", tags: ["hr"],
    request: { params: CompanyParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: CreatePayComponentBody } } } },
    middleware: [requirePermission(PERMISSION["hr.pay_component.manage"], gate)],
    responses: { 201: { description: "Created", content: { "application/json": { schema: PayComponentSchema } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      const id = await createPayComponent(tx, companyId, {
        code: body.code, nameEn: body.nameEn, nameAr: body.nameAr ?? null,
        kind: body.kind, quantityBased: body.quantityBased,
      });
      return reread(tx, companyId, id);
    });
    return c.json(dto, 201);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "patch", path: "/{componentId}", tags: ["hr"],
    request: { params: ComponentParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: UpdatePayComponentBody } } } },
    middleware: [requirePermission(PERMISSION["hr.pay_component.manage"], gate)],
    responses: { 200: { description: "Renamed", content: { "application/json": { schema: PayComponentSchema } } } },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId);          // 404 before the update, never after it
      await renamePayComponent(tx, componentId, { nameEn: body.nameEn, nameAr: body.nameAr });
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "put", path: "/{componentId}/schemes", tags: ["hr"],
    request: { params: ComponentParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: SetComponentSchemesBody } } } },
    middleware: [requirePermission(PERMISSION["hr.pay_component.manage"], gate)],
    responses: { 200: { description: "The joins after the change", content: { "application/json": { schema: PayComponentSchema } } } },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId);
      // An unknown scheme id violates `pay_component_scheme_scheme_fk` (added by migration 0084,
      // amendment A13): SQLSTATE 23503, which fromDatabaseError maps to ERR_CONFLICT_REFERENCE. The
      // handler adds no existence pre-check — the FK is the check, and it is also the one that holds
      // against a concurrent delete. Before 0084 lands there is no constraint and the insert
      // succeeds, which is why the route test for it is Task 10's and not Task 7's.
      await setComponentSchemes(tx, componentId, body.schemeIds);
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

payComponentRoutes.openapi(
  createRoute({
    method: "post", path: "/{componentId}/archive", tags: ["hr"],
    request: { params: ComponentParams, headers: IdempotencyHeader },
    middleware: [requirePermission(PERMISSION["hr.pay_component.manage"], gate)],
    responses: { 200: { description: "Archived; the row leaves the default list", content: { "application/json": { schema: PayComponentSchema } } } },
  }),
  async (c) => {
    const { companyId, componentId } = c.req.valid("param");
    const dto = await c.var.withTenant(async (tx) => {
      await reread(tx, companyId, componentId);
      await archivePayComponent(tx, componentId);
      return reread(tx, companyId, componentId);
    });
    return c.json(dto, 200);
  },
);

export const payComponentRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/pay-components",
  router: payComponentRoutes,
  permissions: [PERMISSION["hr.compensation.read"], PERMISSION["hr.pay_component.manage"]],
  auth: "human",
};
```

and inside `buildRoutes` (never by pushing onto `ROUTES` — §4.2.7):

```ts
    payComponentRouteModule,
```

- [ ] **Step 5: Add the `PROBES` entry (hazard 31)**

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/pay-components": {
    async seed(db, owner) {
      const id = await seedPayComponent(db, owner, { code: "PROBE-BASIC", kind: "earning" });
      return { path: `/v1/companies/${owner.company}/pay-components/${id}`, method: "PATCH", body: { nameEn: "renamed by the attacker" } };
    },
    expect: 404,
  },
```

The two `compensation-lines` sub-paths and the two `sensitive` sub-paths need **no** entry: `PROBES` is keyed by `RouteModule.path` and they live on 6C's `employees` module, whose entry 6C already wrote (hazard 31, and §4.2.7's "a sub-path needs no `PROBES` entry of its own").

- [ ] **Step 6: Run to green and commit**

```bash
bun run --cwd packages/contracts openapi:generate
cd apps/api && bun run test -- test/routes/hr/compensation.test.ts test/routes/hr/pay-components.test.ts
cd ../.. && bun run --cwd tests test -- invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 8 + 6 passing — the pay-component suite is six cases, not the seven an earlier draft listed, because the `PUT …/schemes` unknown-scheme case belongs to Task 10, where migration 0084's FK exists to raise it — the isolation harness green with the new probe, and `lint:rules` reporting **two** `permission-catalogue` lines (`hr.statutory_table.manage`, `hr.statutory_table.verify`) — Task 10 closes the last two.

```bash
git add apps/api/src/routes/hr/pay-components.ts apps/api/src/routes/hr/compensation.ts \
        apps/api/src/routes/hr/employees-composed.ts apps/api/src/routes/index.ts \
        packages/db/src/hr/compensation.ts packages/db/src/hr/index.ts \
        packages/contracts/src/hr/pay-component.ts packages/contracts/src/hr/compensation.ts \
        packages/contracts/openapi.json tests/invariants/probes.ts \
        apps/api/test/routes/hr/pay-components.test.ts apps/api/test/routes/hr/compensation.test.ts
git commit -m "$(cat <<'EOF'
feat(api): the pay-component catalogue and compensation lines over HTTP [8A T7]

One new route module (pay-components, one PROBES key) and two sub-paths on 6C's employees module,
which inherit its key. Test 31's R4 clause is now proved through the API as well as by direct SQL:
the officer opening a line on their own employee row gets 409 ERR_HR_SELF_PAY with their principal
id in the detail. Test 32's compensation half: 403 without hr.compensation.read, and `amount` is
not a declared filter or sort field, so a side channel is ERR_VALIDATION_FAILED rather than a
silent leak. Compensation is entered in the company's base currency only -- v1 payroll is
single-currency (spec:2093) and Money refuses the mismatch by name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Migration 0084 — `statutory_scheme`, `statutory_rate_table`, and the verify-not-load trigger

**A scheme is a row, never an enum** (spec:2080) — that is the whole reason a confirmed levy under OD-14 is *data* and not a migration. And **`verified_by` must differ from `loaded_by`**, by trigger, which is this slice's half of Phase 8's "preparer ≠ approver is enforced by the data layer" and the third clause of acceptance test 35.

**Two subtleties the trigger must get right.**

*Compare `app.current_actor()` against `OLD.loaded_by`, never against `NEW.verified_by`.* BEFORE ROW triggers on one table fire in **trigger-name order**, so whether `stamp_verified_by` has already overwritten `NEW.verified_by` by the time this trigger runs depends on nothing more principled than how two names sort — and a rule whose correctness turns on a trigger name breaks the next time one is renamed. Reading the session and the immutable `OLD.loaded_by` is **order-independent**. `loaded_by` cannot move under it: `stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any change to a non-null `*_by` value (plan0A:2373–2376).

*Freeze the definition once verified.* A table that could be edited after verification would carry a signature for numbers nobody signed — LEGACY-041's shape applied to statutory data. The same trigger refuses a change to `scheme_id`, `version`, `effective_from`, `source` or `definition` on a row whose `verified_at` is already set.

**Files:**
- Create: `packages/db/migrations/0084_create_statutory_scheme_rate_table.sql`, `packages/db/migrations/0084.down.sql`, `packages/db/src/hr/statutory.ts`, `packages/db/src/schema/statutory-scheme.ts`, `packages/db/src/schema/statutory-rate-table.ts`, `packages/db/test/hr/statutory.test.ts`
- Modify: `packages/db/test/fixtures.ts` (`seedStatutoryScheme`, `seedRateTable`, `SYNTH_RATE_TABLE_V1`), `tests/invariants/support/hr.ts` (`HrFixture.schemeId`, seeded in the same commit as the helper it calls — amendment A6), `packages/contracts/src/errors.ts` (one `ERRORS` row), `packages/db/src/hr/index.ts`

**Interfaces**

- Consumes: `app.current_actor`, `app_meta.attach_stamp` (§4.1); `app.pay_component_scheme` (Task 6 — the FK it could not carry); `ERRORS` (§4.2.4); `grantCodes` (§4.17).
- Produces:

```ts
// packages/db/test/fixtures.ts — §4.17's two remaining 8A rows plus amendment A5's const
/** §4.12.4's synthetic table, verbatim, as the ONE place a fixture's rate figures live.
 *  `scheme` is "SYNTH": the §4.12.3 pattern ^[A-Z][A-Z0-9_]{1,15}$ admits no hyphen and no lower
 *  case, so "SYNTHETIC-TEST-v1" is the label §4.12.4 uses in prose and never a `scheme` value.
 *  NO REAL STATUTORY FIGURE EVER APPEARS HERE (hazard 1).
 *  **Neither signature names `RateTable`.** That type is generated in Task 9 from
 *  `packages/domain/payroll/rate-table.schema.json` and reached through the `"./payroll"` subpath
 *  amendment A11 adds — neither exists when this task commits, and `packages/db/test/fixtures.ts`
 *  could not import it if it did. The const is the `as const` object literal of Step 6 and its type
 *  is inferred from it; `definition` is `unknown` and every reader parses it with `parseRateTable`.
 *  Task 9 Step 7 closes the loop by asserting the const validates against the schema. */
export const SYNTH_RATE_TABLE_V1: {
  readonly schema_version: 1; readonly scheme: "SYNTH"; readonly version: 1;
  readonly kind: "banded_contribution"; readonly effective_from: string; readonly effective_to: null;
  readonly source: { readonly authority: string; readonly publication: string; readonly url: string;
                     readonly retrieved_on: string; readonly notes: string };
  readonly verification: { readonly verified_by: string; readonly verified_on: string; readonly method: "synthetic_test" };
  readonly rounding_mode: "HALF_AWAY_FROM_ZERO"; readonly required_profile_fields: readonly string[];
  readonly table: { readonly bands: readonly { readonly from: string; readonly to: string | null;
                                               readonly employee: string; readonly employer: string }[] };
};
export async function seedStatutoryScheme(db: Db, s: Seed, opts?: { code?: string; payableAccountId?: string; employerExpenseAccountId?: string }): Promise<string>;
export async function seedRateTable(db: Db, s: Seed, opts: { schemeId: string; version?: number; definition?: unknown; verified?: boolean }): Promise<string>;

// packages/db/src/hr/statutory.ts
export interface StatutoryScheme { id: string; code: string; nameEn: string; nameAr: string | null;
  payableAccountId: string | null; employerExpenseAccountId: string | null; authorityPartyId: string | null;
  employerRegistration: string | null; roundingMode: RoundingMode }
export interface RateTableRow { id: string; schemeId: string; schemeCode: string; version: number;
  effectiveFrom: string; effectiveTo: string | null; definition: unknown; source: string;
  loadedBy: string; verifiedBy: string | null; verifiedAt: string | null }
export function listSchemes(tx: Sql, companyId: string): Promise<StatutoryScheme[]>;
export function listRateTables(tx: Sql, schemeId: string): Promise<RateTableRow[]>;
/** The verified table covering `on` for a scheme, or null. 8B's `RateTableRef` is built from it. */
export function rateTableOn(tx: Sql, schemeId: string, on: string): Promise<RateTableRow | null>;
export function loadRateTable(tx: Sql, input: { schemeId: string; version: number; effectiveFrom: string;
  effectiveTo: string | null; definition: unknown; source: string }): Promise<string>;
/** Sets verified_at = now() and lets stamp_verified_by write the actor. Raises ERR_HR_SELF_VERIFY. */
export function verifyRateTable(tx: Sql, rateTableId: string): Promise<void>;
/** Tables whose effective_to falls inside [asOf, asOf + horizonDays] with no successor (spec:2109). */
export function lapsingTables(tx: Sql, asOf: string, horizonDays: number): Promise<RateTableRow[]>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/hr/statutory.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { lapsingTables, listRateTables, listSchemes, loadRateTable, rateTableOn, verifyRateTable } from "../../src/hr/statutory";
import { grantCodes, seedRateTable, seedStatutoryScheme, seedTenant, SYNTH_RATE_TABLE_V1, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("migration 0084 — schemes as rows, rate tables as verified data", () => {
  let db: Db; let a: Seed; let b: Seed; let loader: string; let verifier: string; let schemeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-stat-a"); b = await seedTenant(db, "8a-stat-b");
    loader = await uuidv7(db.admin); verifier = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [id, n] of [[loader, "Loader"], [verifier, "Verifier"]] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${id}, ${`sub-${id}`}, 'human', ${n})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, { codes: ["hr.statutory_table.manage"], principalId: loader, roleCode: "t-stat-loader" });
    await grantCodes(db, a, { codes: ["hr.statutory_table.verify"], principalId: verifier, roleCode: "t-stat-verifier" });
    schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH" });
  }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("a scheme is a ROW with a free-text code — a new levy is data, not a migration (spec:2080)", async () => {
    const levy = await seedStatutoryScheme(db, a, { code: "SYNTH_LEVY" });
    const schemes = await withTenant(db.rw, a.tenant, a.human, (tx) => listSchemes(tx, a.company));
    expect(schemes.map((s) => s.code).sort()).toEqual(["SYNTH", "SYNTH_LEVY"]);
    expect(levy).toBeTruthy();
    const enums = await db.admin<{ typname: string }[]>`
      select t.typname from pg_type t where t.typnamespace = 'app'::regnamespace and t.typtype = 'e' and t.typname like '%scheme%'`;
    expect(enums).toEqual([]);
  });

  it("payable_account_id and employer_expense_account_id are NULLABLE — 8B seeds them (A2)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_scheme' and column_name like '%account_id'`;
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
  });

  it("statutory_scheme carries employer_registration (amendment A3)", async () => {
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_scheme' and column_name = 'employer_registration'`;
    expect(col!.data_type).toBe("text");
  });

  it("loaded_by is stamped from the session, never from the caller (LEGACY-044)", async () => {
    const id = await withTenant(db.rw, a.tenant, loader, (tx) => loadRateTable(tx, {
      schemeId, version: 1, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31",
      definition: SYNTH_RATE_TABLE_V1, source: "Dulja test fixture / synthetic",
    }));
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    expect(row!.id).toBe(id);
    expect(row!.loadedBy).toBe(loader);
    expect(row!.verifiedBy).toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });

  it("test 35: the LOADER cannot verify their own table (ERR_HR_SELF_VERIFY, spec:2080)", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    await expect(withTenant(db.rw, a.tenant, loader, (tx) => verifyRateTable(tx, row!.id)))
      .rejects.toThrow(/ERR_HR_SELF_VERIFY/);
  });

  it("a DIFFERENT principal can, and verified_by is stamped to them", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    await withTenant(db.rw, a.tenant, verifier, (tx) => verifyRateTable(tx, row!.id));
    const [after] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    expect(after!.verifiedBy).toBe(verifier);
    expect(after!.verifiedAt).not.toBeNull();
  });

  it("the same refusal holds against DIRECT app_rw SQL — the trigger is the control, not a handler", async () => {
    const id = await withTenant(db.rw, a.tenant, loader, (tx) => loadRateTable(tx, {
      schemeId, version: 2, effectiveFrom: "2027-01-01", effectiveTo: null,
      definition: SYNTH_RATE_TABLE_V1, source: "Dulja test fixture / synthetic",
    }));
    await expect(withTenant(db.rw, a.tenant, loader, (tx) => tx`
      update app.statutory_rate_table set verified_at = now(), verified_by = ${verifier} where id = ${id}`))
      .rejects.toThrow(/ERR_HR_SELF_VERIFY/);
  });

  it("a verified table is frozen — definition, version, effective_from and source cannot change (LEGACY-041)", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    const verified = row!.verifiedAt === null ? (await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId)))[1]! : row!;
    await expect(withTenant(db.rw, a.tenant, verifier, (tx) => tx`
      update app.statutory_rate_table set definition = '{"tampered":true}'::jsonb where id = ${verified.id}`))
      .rejects.toThrow(/ERR_HR_SELF_VERIFY.*frozen/);
  });

  it("rateTableOn returns only a VERIFIED table covering the date (spec:2080, LEGACY-020)", async () => {
    expect((await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2026-06-30")))!.version).toBe(1);
    expect(await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2027-06-30"))).toBeNull();   // v2 unverified
    expect(await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2025-01-01"))).toBeNull();
  });

  it("two versions of one scheme cannot share a version number", async () => {
    await expect(withTenant(db.rw, a.tenant, loader, (tx) => loadRateTable(tx, {
      schemeId, version: 1, effectiveFrom: "2028-01-01", effectiveTo: null,
      definition: SYNTH_RATE_TABLE_V1, source: "Dulja test fixture / synthetic" })))
      .rejects.toThrow(/statutory_rate_table_scheme_id_version_key|duplicate key/);
  });

  it("lapsingTables finds a table expiring inside the horizon and not one outside it (spec:2109)", async () => {
    const soon = await withTenant(db.rw, a.tenant, loader, (tx) => lapsingTables(tx, "2026-11-15", 60));
    expect(soon.map((t) => t.version)).toEqual([1]);        // effective_to 2026-12-31 is 46 days away
    const notYet = await withTenant(db.rw, a.tenant, loader, (tx) => lapsingTables(tx, "2026-06-01", 60));
    expect(notYet).toEqual([]);
  });

  it("no real statutory figure is anywhere in the fixture (hazard 1)", () => {
    expect(SYNTH_RATE_TABLE_V1.scheme).toBe("SYNTH");
    expect(SYNTH_RATE_TABLE_V1.source.authority).toBe("Dulja test fixture");
    expect(SYNTH_RATE_TABLE_V1.verification?.method).toBe("synthetic_test");
  });

  it("tenant B sees no scheme and no table of tenant A (test 12)", async () => {
    expect(await withTenant(db.rw, b.tenant, b.human, (tx) => listSchemes(tx, a.company))).toHaveLength(0);
    expect(await withTenant(db.rw, b.tenant, b.human, (tx) => listRateTables(tx, schemeId))).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0084", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("seedRateTable's default definition is the synthetic table", async () => {
    const other = await seedStatutoryScheme(db, a, { code: "SYNTH_TWO" });
    const id = await seedRateTable(db, a, { schemeId: other, verified: true });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => listRateTables(tx, other));
    expect(row!.id).toBe(id);
    expect((row!.definition as { scheme: string }).scheme).toBe("SYNTH");
    expect(row!.verifiedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/statutory.test.ts
```

Expected: **FAIL** at import — `Cannot find module '../../src/hr/statutory'`, and `SYNTH_RATE_TABLE_V1 is not exported from '../fixtures'`.

- [ ] **Step 3: Write `0084_create_statutory_scheme_rate_table.sql`**

```sql
-- ── 0084_create_statutory_scheme_rate_table.sql ────────────────────────────────────────────────
-- §3.10.1 "Statutory schemes as data" (spec:2080). A scheme is a ROW, never an enum, so a levy the
-- owner confirms under OD-14 is data and not a migration. A rate table is version-controlled data
-- with a source and two DIFFERENT principals behind it (LEGACY-078, LEGACY-020).
-- THIS FILE STATES NO RATE, THRESHOLD, CEILING OR FORMULA (spec:2080, hazard 1). It states where
-- one may be stored and who has to sign it.

create table app.statutory_scheme (
  id                           uuid primary key default uuidv7(),
  tenant_id                    uuid not null references app.tenant(id),
  company_id                   uuid not null,
  code                         text not null,          -- 'EPF', 'SOCSO', 'EIS', 'PCB', plus confirmed levies. DATA.
  name_en                      text not null,
  name_ar                      text,
  payable_account_id           uuid,                   -- 8B seeds 2411..2414 and sets this (§4.15, amendment A2)
  employer_expense_account_id  uuid,                   -- 8B seeds 5311..5314 and sets this
  authority_party_id           uuid,                   -- the vendor party 8C's remittance PAYMENT is made to
  employer_registration        text,                   -- ⚠️ OD-23; the PRIMARY store (amendment A3, spec:2088 "never a blob")
  rounding_mode                text not null default 'HALF_AWAY_FROM_ZERO',
  created_at                   timestamptz not null default now(),
  constraint statutory_scheme_rounding_mode_check
    check (rounding_mode in ('HALF_AWAY_FROM_ZERO', 'HALF_EVEN', 'TOWARD_ZERO', 'AWAY_FROM_ZERO')),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)                  references app.company(tenant_id, id),
  foreign key (tenant_id, payable_account_id)          references app.account(tenant_id, id),
  foreign key (tenant_id, employer_expense_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, authority_party_id)          references app.party(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.statutory_scheme');
call app_meta.attach_audit('app.statutory_scheme');

comment on column app.statutory_scheme.rounding_mode is
  'The FALLBACK rounding for this scheme, applied through the one round() of §4.2.1 when a rate table declares none. It is a SYSTEM default (the same value every other Dulja money path uses), not an authority claim; a table that declares rounding_mode overrides it, which is what LEGACY-019 asks for ("each scheme''s rounding rule is declared in its table").';
comment on column app.statutory_scheme.employer_registration is
  '⚠️ OD-23. The employer''s registration number with this authority. Relational, per scheme -- spec:2088 forbids a blob.';

-- The join table's second FK could not be written in 0083, which ran before this table existed.
alter table app.pay_component_scheme
  add constraint pay_component_scheme_scheme_fk
  foreign key (tenant_id, scheme_id) references app.statutory_scheme(tenant_id, id);

create table app.statutory_rate_table (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  scheme_id      uuid not null,
  version        int  not null check (version > 0),
  effective_from date not null,
  effective_to   date,
  definition     jsonb not null,        -- validated against packages/domain/payroll/rate-table.schema.json (§4.12.3)
  source         text not null,         -- authority, publication, url, retrieved_on -- flattened for display; the structured copy is in `definition.source`
  loaded_by      uuid not null default app.current_actor() references app.principal(id),   -- stamped
  verified_by    uuid references app.principal(id),                                        -- stamped on UPDATE OF verified_at
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (scheme_id, version),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check ((verified_at is null) = (verified_by is null)),
  foreign key (tenant_id, scheme_id) references app.statutory_scheme(tenant_id, id)
);
create index statutory_rate_table_effective_idx
  on app.statutory_rate_table (scheme_id, effective_from desc) where verified_at is not null;
create index statutory_rate_table_lapse_idx
  on app.statutory_rate_table (effective_to) where effective_to is not null and verified_at is not null;

call app_meta.enable_tenant_rls('app.statutory_rate_table');
call app_meta.attach_audit('app.statutory_rate_table');
call app_meta.attach_stamp('app.statutory_rate_table', 'loaded_by');
call app_meta.attach_stamp('app.statutory_rate_table', 'verified_by');

-- ── verified_by <> loaded_by, and a verified table is frozen (spec:2080, 1651-1652; LEGACY-020, 041) ──
-- The comparison is app.current_actor() against OLD.loaded_by, NOT against NEW.verified_by. BEFORE
-- ROW triggers on one table fire in TRIGGER-NAME order, so whether stamp_verified_by has already
-- replaced NEW.verified_by by now turns on how two names happen to sort, and NEW.verified_by may
-- still hold whatever the caller sent -- the value LEGACY-044 says never to trust. Reading the session
-- and the immutable loaded_by is order-independent: stamp_actor raises ERR_ACTOR_IMMUTABLE on any
-- change to a non-null *_by value, so loaded_by cannot move under us.
create function app.assert_rate_table_verifier() returns trigger language plpgsql as $$
begin
  if old.verified_at is null and new.verified_at is not null then
    if app.current_actor() = old.loaded_by then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % was loaded by this principal; verification requires a different principal (spec:2080)',
        old.version, old.scheme_id using errcode = 'check_violation';
    end if;
  end if;
  if old.verified_at is not null and (
       new.definition     is distinct from old.definition
    or new.version        is distinct from old.version
    or new.scheme_id      is distinct from old.scheme_id
    or new.effective_from is distinct from old.effective_from
    or new.source         is distinct from old.source) then
    -- effective_to is deliberately NOT in the list above and the message must not claim it is: a
    -- successor version has to be able to close its predecessor's open window, which is an UPDATE of
    -- effective_to on a verified row. Every other field is frozen.
    raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is already verified; its definition, version, effective_from and source are frozen (effective_to may still be closed by a successor). Load a NEW version rather than editing a signed one (LEGACY-041, spec:2080)',
      old.version, old.scheme_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger statutory_rate_table_verifier
  before update on app.statutory_rate_table
  for each row execute function app.assert_rate_table_verifier();

comment on table app.statutory_rate_table is
  'spec:2080. The PRIMARY load path is the seed pull request (packages/db/seed/my/statutory/<scheme>/vN.json), so every change is a reviewed diff (LEGACY-078); the runtime hr.statutory_table.manage load is BREAK-GLASS (ADR 0073). No file under seed/my/statutory/<scheme>/ exists until OD-23 supplies verified tables.';
```

`packages/db/migrations/0084.down.sql`:

```sql
drop trigger if exists statutory_rate_table_verifier on app.statutory_rate_table;
drop function if exists app.assert_rate_table_verifier();
drop index if exists app.statutory_rate_table_lapse_idx;
drop index if exists app.statutory_rate_table_effective_idx;
drop table if exists app.statutory_rate_table;
alter table app.pay_component_scheme drop constraint if exists pay_component_scheme_scheme_fk;
drop table if exists app.statutory_scheme;
```

**Why the freeze `raise` re-uses `ERR_HR_SELF_VERIFY` rather than naming a token of its own.** A first draft raised `ERR_HR_TABLE_VERIFIED`, which reads better and is wrong twice over: §4.2.4's table allocates the whole `ERR_*` space and does not contain it (hazard 32 makes an unregistered literal a review-blocking finding), and `fromDatabaseError` maps a SQLSTATE 23514 whose message starts `/^ERR_[A-Z_]+:/` to *that* code — so an unregistered token would reach the wire as a `Problem.code` no client can look up. `error-codes` fails CI before anyone reads it either way, because the rule scans `packages/db/migrations/**`. **One allocated code, two messages**: both refusals are one rule seen from two sides — this table's numbers are worth only as much as the second principal who signed them, so neither the loader's own signature nor an edit after signing is admitted. The test tells them apart with `/ERR_HR_SELF_VERIFY.*frozen/`.

- [ ] **Step 4: Write `packages/db/src/hr/statutory.ts`**

```ts
import type { RoundingMode } from "@dulja/domain";
import type { Sql } from "postgres";

export interface StatutoryScheme {
  id: string; code: string; nameEn: string; nameAr: string | null;
  payableAccountId: string | null; employerExpenseAccountId: string | null;
  authorityPartyId: string | null; employerRegistration: string | null; roundingMode: RoundingMode;
}
export interface RateTableRow {
  id: string; schemeId: string; schemeCode: string; version: number;
  effectiveFrom: string; effectiveTo: string | null; definition: unknown; source: string;
  loadedBy: string; verifiedBy: string | null; verifiedAt: string | null;
}

export async function listSchemes(tx: Sql, companyId: string): Promise<StatutoryScheme[]> {
  const rows = await tx<{ id: string; code: string; name_en: string; name_ar: string | null;
    payable_account_id: string | null; employer_expense_account_id: string | null;
    authority_party_id: string | null; employer_registration: string | null; rounding_mode: RoundingMode }[]>`
    select id, code, name_en, name_ar, payable_account_id, employer_expense_account_id,
           authority_party_id, employer_registration, rounding_mode
      from app.statutory_scheme where company_id = ${companyId} order by code`;
  return rows.map((r) => ({
    id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar,
    payableAccountId: r.payable_account_id, employerExpenseAccountId: r.employer_expense_account_id,
    authorityPartyId: r.authority_party_id, employerRegistration: r.employer_registration,
    roundingMode: r.rounding_mode,
  }));
}

interface RawTable { id: string; scheme_id: string; scheme_code: string; version: number;
  effective_from: string; effective_to: string | null; definition: unknown; source: string;
  loaded_by: string; verified_by: string | null; verified_at: string | null }

const toTable = (r: RawTable): RateTableRow => ({
  id: r.id, schemeId: r.scheme_id, schemeCode: r.scheme_code, version: r.version,
  effectiveFrom: r.effective_from, effectiveTo: r.effective_to, definition: r.definition,
  source: r.source, loadedBy: r.loaded_by, verifiedBy: r.verified_by, verifiedAt: r.verified_at,
});

export async function listRateTables(tx: Sql, schemeId: string): Promise<RateTableRow[]> {
  const rows = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by, t.verified_at::text as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.scheme_id = ${schemeId} order by t.version desc`;
  return rows.map(toTable);
}

/** Only a VERIFIED table covering `on` (spec:2080, LEGACY-020). 8B's RateTableRef is built from this,
 *  and 8B's ERR_PAYROLL_RATE_TABLE_UNVERIFIED is what it raises when this returns null. */
export async function rateTableOn(tx: Sql, schemeId: string, on: string): Promise<RateTableRow | null> {
  const [row] = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by, t.verified_at::text as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.scheme_id = ${schemeId} and t.verified_at is not null
       and t.effective_from <= ${on}::date and (t.effective_to is null or t.effective_to >= ${on}::date)
     order by t.effective_from desc limit 1`;
  return row === undefined ? null : toTable(row);
}

export async function loadRateTable(tx: Sql, input: {
  schemeId: string; version: number; effectiveFrom: string; effectiveTo: string | null;
  definition: unknown; source: string;
}): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
    select s.tenant_id, s.id, ${input.version}, ${input.effectiveFrom}::date,
           ${input.effectiveTo}::date, ${tx.json(input.definition)}, ${input.source}
      from app.statutory_scheme s where s.id = ${input.schemeId}
    returning id`;
  if (row === undefined) throw new Error(`statutory scheme ${input.schemeId} is not visible to this transaction`);
  return row.id;
}

/** `verified_by` is written as `app.current_actor()` and would be overwritten with the same value by
 *  `stamp_verified_by` even if a caller had supplied another (plan0A:2373-2376) — the column is
 *  never trusted from a caller (LEGACY-044). The trigger compares the session's actor to `OLD.loaded_by`
 *  and raises ERR_HR_SELF_VERIFY when they match, and the `where verified_at is null` clause is what
 *  makes a second verification a no-op the caller is told about rather than a silent success. */
export async function verifyRateTable(tx: Sql, rateTableId: string): Promise<void> {
  const res = await tx`
    update app.statutory_rate_table
       set verified_at = now(), verified_by = app.current_actor()
     where id = ${rateTableId} and verified_at is null`;
  if (res.count === 0) throw new Error(`rate table ${rateTableId} is not visible, or is already verified`);
}

/** spec:2109's sixty-day warning. A table is lapsing when it is verified, has an effective_to inside
 *  the horizon, and NO later verified version of the same scheme starts on or before that date. */
export async function lapsingTables(tx: Sql, asOf: string, horizonDays: number): Promise<RateTableRow[]> {
  const rows = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by, t.verified_at::text as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.verified_at is not null
       and t.effective_to is not null
       and t.effective_to >= ${asOf}::date
       and t.effective_to <= (${asOf}::date + make_interval(days => ${horizonDays}))::date
       and not exists (
         select 1 from app.statutory_rate_table n
          where n.scheme_id = t.scheme_id and n.verified_at is not null
            and n.effective_from <= (t.effective_to + interval '1 day')::date
            and n.version > t.version)
     order by t.effective_to, s.code`;
  return rows.map(toTable);
}
```

- [ ] **Step 5: Add the `ERR_HR_SELF_VERIFY` row and the two Drizzle mirrors**

`packages/contracts/src/errors.ts`, inside `ERRORS`, in the registry's own order (§4.2.4) — landing in **this** commit because migration 0084's SQL text is what raises the token and `error-codes` scans `packages/db/migrations/**` (the 2B precedent):

```ts
  ERR_HR_SELF_VERIFY: {
    status: 409,
    title: "Verification refused",
    remedy: "A statutory rate table is verified by a principal other than the one who loaded it; ask the accountant. A table that is already verified is frozen — load a new version instead of editing it.",
  },
```

`packages/db/src/schema/statutory-scheme.ts`:

```ts
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const statutoryScheme = app.table("statutory_scheme", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  payableAccountId: uuid("payable_account_id"),
  employerExpenseAccountId: uuid("employer_expense_account_id"),
  authorityPartyId: uuid("authority_party_id"),
  employerRegistration: text("employer_registration"),
  roundingMode: text("rounding_mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

`packages/db/src/schema/statutory-rate-table.ts`:

```ts
import { date, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const statutoryRateTable = app.table("statutory_rate_table", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  schemeId: uuid("scheme_id").notNull(),
  version: integer("version").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  // `unknown`, not the generated RateTable: `packages/db` may not narrow a shape that lives in
  // `packages/domain/payroll`, and every reader parses it with `parseRateTable` (Task 9) anyway.
  definition: jsonb("definition").notNull().$type<unknown>(),
  source: text("source").notNull(),
  loadedBy: uuid("loaded_by").notNull(),
  verifiedBy: uuid("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 6: Add the two fixtures and the synthetic const**

`packages/db/test/fixtures.ts` — appended:

```ts
/**
 * §4.12.4's synthetic table, verbatim. Amendment A5 makes this the ONE home of a fixture's rate
 * figures: §4.17's `seedRateTable` row says its `definition` defaults to "SYNTHETIC-TEST-v1", and
 * §4.12.4 puts the FILE (packages/db/seed/test/statutory/SYNTH/v1.json) in 8B — a fixture default
 * cannot depend on a file a later slice writes. `scheme` is "SYNTH": §4.12.3's pattern
 * ^[A-Z][A-Z0-9_]{1,15}$ admits no hyphen and no lower case.
 * NO REAL STATUTORY FIGURE EVER APPEARS HERE OR ANYWHERE ELSE IN THIS REPOSITORY (spec:2080).
 */
export const SYNTH_RATE_TABLE_V1 = {
  schema_version: 1,
  scheme: "SYNTH",
  version: 1,
  kind: "banded_contribution",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md §4.12.4",
    url: "https://dulja.invalid/test-fixture/synth/v1",
    retrieved_on: "2026-01-01",
    notes: "Invented numbers for tests. Not a rate of any authority anywhere.",
  },
  verification: { verified_by: "Dulja test fixture", verified_on: "2026-01-01", method: "synthetic_test" },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  required_profile_fields: [],
  table: {
    bands: [
      { from: "0.0000",    to: "1000.0000", employee: "10.0000",  employer: "20.0000" },
      { from: "1000.0000", to: "5000.0000", employee: "50.0000",  employer: "100.0000" },
      { from: "5000.0000", to: null,        employee: "250.0000", employer: "500.0000" },
    ],
  },
} as const;

/** §4.17's 8A row. Accounts stay null: 8B seeds 2411..2414 and 5311..5314 (amendment A2). */
export async function seedStatutoryScheme(
  db: Db, s: Seed,
  opts: { code?: string; payableAccountId?: string; employerExpenseAccountId?: string } = {},
): Promise<string> {
  const code = opts.code ?? "SYNTH";
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.statutory_scheme (id, tenant_id, company_id, code, name_en, payable_account_id, employer_expense_account_id)
    values (${id}, ${s.tenant}, ${s.company}, ${code}, ${`${code} (synthetic)`},
            ${opts.payableAccountId ?? null}, ${opts.employerExpenseAccountId ?? null})`);
  return id;
}

/** §4.17's 8A row. `verified` uses `s.system` as the verifier so the trigger's verified_by <>
 *  loaded_by check passes: the fixture loads as `s.human` and verifies as the system principal,
 *  which is two different principals by construction. */
export async function seedRateTable(
  db: Db, s: Seed,
  opts: { schemeId: string; version?: number; definition?: unknown; verified?: boolean },
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.statutory_rate_table (id, tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
    select ${id}, ${s.tenant}, ${opts.schemeId}, ${opts.version ?? 1}, '2026-01-01'::date, null,
           ${tx.json(opts.definition ?? SYNTH_RATE_TABLE_V1)}, 'Dulja test fixture / synthetic'
      from app.statutory_scheme sc where sc.id = ${opts.schemeId}`);
  if (opts.verified === true) {
    await withTenant(db.rw, s.tenant, s.system, (tx) => tx`
      update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor() where id = ${id}`);
  }
  return id;
}
```

**And the same commit appends one scheme to `hrFixture`** (`tests/invariants/support/hr.ts`, amendment A6) — additively, in the task that creates `seedStatutoryScheme`, because Task 3 could not have called a helper that did not exist yet:

Three edits, all additive: add `seedStatutoryScheme` to the existing `@dulja/db/test` import; append `schemeId: string` to `HrFixture` after its `employees` member, replacing the comment Task 3 Step 8 left there; and insert the two lines below immediately before the `return`, extending the returned object literal. Nothing already in the file is reordered or renamed.

```ts
// tests/invariants/support/hr.ts
import { grantCodes, seedEmployee, seedStatutoryScheme, seedTenantV2, type Seed } from "@dulja/db/test";

//   appended to HrFixture, after `employees`:
  schemeId: string;     // one app.statutory_scheme, code "SYNTH"

//   inside hrFixture(api, name), immediately before the `return`, after the three employees:
  // Schemes are seed-pack data (ADR 0073) and NO route creates one, so a suite that expected the
  // list endpoint to hand it a scheme would find an empty list and fail in set-up rather than on
  // its own case. T10's whole suite hangs off this id.
  const schemeId = await seedStatutoryScheme(db, seed, { code: "SYNTH" });
  return { api, db, seed, companyId: seed.company, officer, checker, outsider, schemeId, sixC: SIX_C, employees };
```

- [ ] **Step 7: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run db:lint && bun run test -- test/hr/statutory.test.ts
cd ../.. && bun run lint && bun run lint:rules && bun run typecheck
grep -rn "ERR_HR_TABLE_VERIFIED" packages apps tests || echo "no unregistered token — correct"
```

Expected: 15 passing, `0 violations`, the grep printing `no unregistered token — correct`, and the same two `permission-catalogue` lines as Task 7.

```bash
git add packages/db/migrations/0084_create_statutory_scheme_rate_table.sql packages/db/migrations/0084.down.sql \
        packages/db/src/hr/statutory.ts packages/db/src/hr/index.ts \
        packages/db/src/schema/statutory-scheme.ts packages/db/src/schema/statutory-rate-table.ts \
        packages/db/test/fixtures.ts packages/db/test/hr/statutory.test.ts packages/contracts/src/errors.ts \
        tests/invariants/support/hr.ts
git commit -m "$(cat <<'EOF'
feat(db): statutory schemes as rows and rate tables that a second principal verifies [8A T8]

Migration 0084. A scheme is a ROW with a free-text code, so a levy the owner confirms under OD-14
is data and not a migration (spec:2080). A rate table carries its definition, its source and two
DIFFERENT principals: app.assert_rate_table_verifier() compares app.current_actor() to OLD.loaded_by
-- never to NEW.verified_by, which stamp_verified_by has not written yet because BEFORE triggers
fire in name order and would leave a caller-supplied value in the comparison (LEGACY-044). A verified
table is frozen: definition, version, effective_from and source cannot change, so a signature never
covers numbers nobody signed (LEGACY-041). effective_to is the one field that may still move, because a
successor version has to be able to close its predecessor's window. This is test 35's verify-not-load clause, proved by direct app_rw
SQL because "enforced by the data layer" means the trigger and not the handler. ERR_HR_SELF_VERIFY
joins ERRORS in this commit because 0084's SQL text raises it. NO STATUTORY FIGURE IS IN THIS FILE.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `packages/domain/payroll/`, the rate-table schema and type, the `statutory` sub-pack loader, and ADR 0073

**Four things that are one thing:** the JSON Schema of §4.12.3, the `RateTable` type generated from it and committed, the `statutory` sub-pack loader §3.4.8 assigns 8A, and the seed pack it reads. They land together because a loader that does not validate is the LEGACY-078 defect with extra steps, and a schema with no generated type means every consumer re-declares the shape.

**`packages/domain/payroll/` sits beside `src/`, not inside it** (spec:2366 — "`payroll/`: the statutory calculators and the rate-table JSON schema (§3.10); **core never imports HR**"). Amendment A11 adds the `"./payroll"` export subpath so `packages/db` can reach it without either violating that rule or reaching in by relative path.

**The pack ships with the four scheme directories EMPTY.** §4.12.4: *"No file under `packages/db/seed/my/statutory/` exists until OD-23 supplies verified tables"* — read, per amendment A12, as binding the **rate-table files**, the ones that carry figures. `schemes.json` and `pay-components.json` carry names and kinds and no number, and a rate table cannot be loaded without the scheme row it points at.

**Files:**
- Create: `packages/domain/payroll/rate-table.schema.json`, `packages/domain/payroll/rate-table.ts` (**generated, committed**), `packages/domain/payroll/validate.ts`, `packages/domain/payroll/index.ts`, `packages/domain/scripts/generate-rate-table-type.ts`, `packages/domain/test/payroll/rate-table.test.ts`, `packages/domain/test/payroll/dependency.test.ts`, `packages/db/src/seed/statutory.ts`, `packages/db/seed/my/statutory/schemes.json`, `packages/db/seed/my/statutory/pay-components.json`, `packages/db/seed/my/statutory/README.md`, `packages/db/seed/my/statutory/{EPF,SOCSO,EIS,PCB}/.gitkeep`, `packages/db/test/hr/statutory-loader.test.ts`, `docs/adr/0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door.md`
- Modify: `packages/domain/package.json` (the `"./payroll"` export and the `rate-table:types` script), `packages/db/src/seed/packs.ts` (`SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, `assertPackShape`'s `OWNED_ELSEWHERE`), `packages/db/src/seed/index.ts` (export `statutoryLoader`)

**Interfaces**

- Consumes: `Ajv2020`, `addFormats`, `json-schema-to-typescript` (already `packages/domain` dependencies from 1A's ADR 0022); `POLICY_TYPE_BANNER`, `POLICY_TYPE_OPTIONS` from `packages/domain/scripts/policy-type-options.ts` (1A, §4.18 round 2 — the generator options are shared, not re-typed); `PackLoader`, `LoaderContext`, `readPackFile`, `SubPack`, `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES`, `assertPackShape` (§4.2.13); `loadRateTable`, `listSchemes` (Task 8); `listPayComponents` (Task 6).
- Produces:

```ts
// packages/domain/payroll/index.ts — reachable as `@dulja/domain/payroll` (amendment A11)
export type { RateTable, RateTableBands, RateTablePercentageWithCeiling, RateTableProgressive } from "./rate-table";
export { RATE_TABLE_SCHEMA_ID, validateRateTable, parseRateTable, RateTableValidationError } from "./validate";
export interface RateTableValidation { ok: boolean; errors: { path: string; message: string }[] }
export function validateRateTable(definition: unknown): RateTableValidation;
/** Throws RateTableValidationError carrying the same `errors` array (JSON Pointers), never `any`. */
export function parseRateTable(definition: unknown): RateTable;
export class RateTableValidationError extends Error { readonly errors: { path: string; message: string }[] }

// packages/db/src/seed/statutory.ts
export const statutoryLoader: PackLoader;                 // name: "statutory"
export interface SchemeSeed { code: string; nameEn: string; nameAr?: string; roundingMode?: RoundingMode }
export interface PayComponentSeed { code: string; nameEn: string; nameAr?: string; kind: "earning" | "deduction"; quantityBased?: boolean }
export function loadStatutoryPack(tx: Sql, ctx: LoaderContext): Promise<number>;
```

- [ ] **Step 1: Write the failing domain test**

`packages/domain/test/payroll/rate-table.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRateTable, RateTableValidationError, validateRateTable } from "../../payroll";

const BANDED = {
  schema_version: 1, scheme: "SYNTH", version: 1, kind: "banded_contribution",
  effective_from: "2026-01-01", effective_to: null,
  source: { authority: "Dulja test fixture", publication: "§4.12.4", url: "https://dulja.invalid/x", retrieved_on: "2026-01-01" },
  verification: { verified_by: "Dulja test fixture", verified_on: "2026-01-01", method: "synthetic_test" },
  rounding_mode: "HALF_AWAY_FROM_ZERO", required_profile_fields: [],
  table: { bands: [{ from: "0.0000", to: "1000.0000", employee: "10.0000", employer: "20.0000" }] },
};

describe("packages/domain/payroll — the rate-table schema (§4.12.3)", () => {
  it("accepts the three shapes the schema admits, and only those", () => {
    expect(validateRateTable(BANDED).ok).toBe(true);
    expect(validateRateTable({ ...BANDED, kind: "percentage_with_ceiling",
      table: { employee_rate: "0.0100", employer_rate: "0.0200", ceiling: "9999.0000", floor: null } }).ok).toBe(true);
    expect(validateRateTable({ ...BANDED, kind: "progressive_schedule",
      table: { brackets: [{ from: "0.0000", to: "1000.0000", rate: "0.0100", cumulative: "0.0000" }], reliefs: { self: "100.0000" } } }).ok).toBe(true);
    expect(validateRateTable({ ...BANDED, kind: "flat_amount" }).ok).toBe(false);
  });

  it("every figure is a decimal STRING — a JSON number is refused (§4.12.3, hazard 4)", () => {
    const numeric = { ...BANDED, table: { bands: [{ from: 0, to: 1000, employee: 10, employer: 20 }] } };
    const v = validateRateTable(numeric);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toContain("/table/bands/0/from");
  });

  it("the schema file itself declares no `number` type anywhere (hazard 4)", async () => {
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../payroll/rate-table.schema.json", import.meta.url), "utf8"));
    const hits = [...raw.matchAll(/"type"\s*:\s*"number"/g)];
    expect(hits).toHaveLength(0);
  });

  it("source is required with all four of its members — a table with no provenance is refused (LEGACY-078)", () => {
    const { source, ...noSource } = BANDED;
    expect(source).toBeTruthy();
    expect(validateRateTable(noSource).ok).toBe(false);
    expect(validateRateTable({ ...BANDED, source: { authority: "X" } }).ok).toBe(false);
  });

  it("an unknown property anywhere is refused — additionalProperties is false at every level", () => {
    expect(validateRateTable({ ...BANDED, surprise: 1 }).ok).toBe(false);
    expect(validateRateTable({ ...BANDED, table: { bands: [{ from: "0.0000", to: null, employee: "1.0000", employer: "1.0000", extra: "x" }] } }).ok).toBe(false);
  });

  it("parseRateTable throws with JSON-Pointer paths, never `any`", () => {
    try { parseRateTable({ schema_version: 2 }); expect.unreachable("should have thrown"); }
    catch (e) {
      expect(e).toBeInstanceOf(RateTableValidationError);
      expect((e as RateTableValidationError).errors[0]!.path).toMatch(/^\//);
    }
  });

  it("the committed type is in sync with the schema (the 1A drift-guard pattern)", async () => {
    const { generateRateTableType } = await import("../../scripts/generate-rate-table-type");
    const fs = await import("node:fs/promises");
    const onDisk = await fs.readFile(new URL("../../payroll/rate-table.ts", import.meta.url), "utf8");
    expect((await generateRateTableType()).replace(/\r\n/g, "\n")).toBe(onDisk.replace(/\r\n/g, "\n"));
  });
});
```

`packages/domain/test/payroll/dependency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** spec:2366: "core never imports HR". 0B's dependency-rule lint enforces it across the repository;
 *  this test states it inside the package, so a `packages/domain` change fails here first. */
describe("packages/domain/src never imports packages/domain/payroll (spec:2366)", () => {
  it("no file under src/ mentions payroll/", async () => {
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(p));
        else if (e.name.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const root = new URL("../../src", import.meta.url).pathname;
    for (const file of await walk(root)) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} imports the payroll subtree`).not.toMatch(/from\s+["'][^"']*payroll/);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd packages/domain && bun run test -- test/payroll/
```

Expected: **FAIL** at import — `Cannot find module '../../payroll'`.

- [ ] **Step 3: Write `packages/domain/payroll/rate-table.schema.json` — §4.12.3 verbatim**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:dulja:rate-table:1", "type": "object", "additionalProperties": false,
  "required": ["schema_version", "scheme", "version", "kind", "effective_from", "source", "table"],
  "properties": {
    "schema_version": { "const": 1 },
    "scheme": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,15}$" },
    "version": { "type": "integer", "minimum": 1 },
    "kind": { "enum": ["banded_contribution", "percentage_with_ceiling", "progressive_schedule"] },
    "effective_from": { "type": "string", "format": "date" }, "effective_to": { "type": ["string", "null"], "format": "date" },
    "source": { "type": "object", "additionalProperties": false, "required": ["authority", "publication", "url", "retrieved_on"],
                "properties": { "authority": { "type": "string" }, "publication": { "type": "string" }, "url": { "type": "string", "format": "uri" }, "retrieved_on": { "type": "string", "format": "date" }, "notes": { "type": "string" } } },
    "verification": { "type": "object", "additionalProperties": false, "required": ["verified_by", "verified_on", "method"],
                      "properties": { "verified_by": { "type": "string" }, "verified_on": { "type": "string", "format": "date" }, "method": { "enum": ["accountant_sign_off", "worked_examples", "synthetic_test"] } } },
    "rounding_mode": { "enum": ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"] },
    "required_profile_fields": { "type": "array", "items": { "type": "string" } },
    "table": { "oneOf": [
      { "type": "object", "additionalProperties": false, "required": ["bands"], "properties": { "bands": { "type": "array", "minItems": 1, "items": { "type": "object", "additionalProperties": false, "required": ["from", "to", "employee", "employer"], "properties": { "from": { "type": "string" }, "to": { "type": ["string", "null"] }, "employee": { "type": "string" }, "employer": { "type": "string" } } } } } },
      { "type": "object", "additionalProperties": false, "required": ["employee_rate", "employer_rate", "ceiling"], "properties": { "employee_rate": { "type": "string" }, "employer_rate": { "type": "string" }, "ceiling": { "type": ["string", "null"] }, "floor": { "type": ["string", "null"] } } },
      { "type": "object", "additionalProperties": false, "required": ["brackets", "reliefs"], "properties": { "brackets": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["from", "to", "rate", "cumulative"], "properties": { "from": { "type": "string" }, "to": { "type": ["string", "null"] }, "rate": { "type": "string" }, "cumulative": { "type": "string" } } } }, "reliefs": { "type": "object", "additionalProperties": { "type": "string" } } } }
    ] }
  }
}
```

**Not one figure appears in this file.** It says a band has a `from`, a `to`, an `employee` share and an `employer` share, each a string. What those strings *are* arrives under OD-23, in a file with a `source` and two signatures.

- [ ] **Step 4: Write the generator and the validator**

`packages/domain/scripts/generate-rate-table-type.ts` — the 1A pattern (§4.18 round 2: `POLICY_TYPE_BANNER` and `POLICY_TYPE_OPTIONS` are **shared**, not re-typed):

```ts
import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import { POLICY_TYPE_BANNER, POLICY_TYPE_OPTIONS } from "./policy-type-options";

const SCHEMA = new URL("../payroll/rate-table.schema.json", import.meta.url);
const TARGET = new URL("../payroll/rate-table.ts", import.meta.url);

/** Exported so the drift guard in test/payroll/rate-table.test.ts compares the WHOLE normalised text
 *  (1A's rule: a partial comparison lets a banner drift and nobody notices). */
export async function generateRateTableType(): Promise<string> {
  const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as Record<string, unknown>;
  const body = await compile(schema, "RateTable", { ...POLICY_TYPE_OPTIONS, bannerComment: "" });
  return `${POLICY_TYPE_BANNER}\n${body}`;
}

if (import.meta.main) await writeFile(TARGET, await generateRateTableType(), "utf8");
```

`packages/domain/package.json` gains the subpath (amendment A11) and the script:

```json
  "exports": { ".": "./src/index.ts", "./payroll": "./payroll/index.ts" },
  "scripts": { "rate-table:types": "bun run scripts/generate-rate-table-type.ts" }
```

`packages/domain/payroll/validate.ts`:

```ts
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./rate-table.schema.json" with { type: "json" };
import type { RateTable } from "./rate-table";

export const RATE_TABLE_SCHEMA_ID = "urn:dulja:rate-table:1";

export interface RateTableValidation { ok: boolean; errors: { path: string; message: string }[] }
export class RateTableValidationError extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super(`rate table is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  }
}

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
const validator = ajv.compile(schema);

/** `errors[i].path` is a JSON Pointer into the rejected definition, the same shape §4.2.4's
 *  `Problem.errors[]` carries for ERR_POLICY_INVALID (2A amendment A10). */
export function validateRateTable(definition: unknown): RateTableValidation {
  const ok = validator(definition);
  return ok
    ? { ok: true, errors: [] }
    : { ok: false, errors: (validator.errors ?? []).map((e) => ({ path: e.instancePath === "" ? "/" : e.instancePath, message: e.message ?? "is invalid" })) };
}

export function parseRateTable(definition: unknown): RateTable {
  const v = validateRateTable(definition);
  if (!v.ok) throw new RateTableValidationError(v.errors);
  return definition as RateTable;
}
```

- [ ] **Step 5: Write the seed pack**

`packages/db/seed/my/statutory/schemes.json` — **names only**:

```json
[
  { "code": "EPF",   "nameEn": "Employees Provident Fund",   "nameAr": "صندوق ادخار الموظفين" },
  { "code": "SOCSO", "nameEn": "Social Security Organisation", "nameAr": "منظمة الضمان الاجتماعي" },
  { "code": "EIS",   "nameEn": "Employment Insurance System",  "nameAr": "نظام تأمين التوظيف" },
  { "code": "PCB",   "nameEn": "Monthly Tax Deduction (PCB/MTD)", "nameAr": "الخصم الشهري للضريبة" }
]
```

`packages/db/seed/my/statutory/pay-components.json` — spec:2078's six, with no scheme joins:

```json
[
  { "code": "BASIC",            "nameEn": "Basic salary",            "nameAr": "الراتب الأساسي",   "kind": "earning",   "quantityBased": false },
  { "code": "ALLOWANCE",        "nameEn": "Fixed allowance",         "nameAr": "بدل ثابت",         "kind": "earning",   "quantityBased": false },
  { "code": "OVERTIME",         "nameEn": "Overtime",                "nameAr": "العمل الإضافي",     "kind": "earning",   "quantityBased": false },
  { "code": "BONUS",            "nameEn": "Bonus or commission",     "nameAr": "مكافأة أو عمولة",   "kind": "earning",   "quantityBased": false },
  { "code": "UNPAID_LEAVE",     "nameEn": "Unpaid-leave deduction",  "nameAr": "خصم إجازة بدون أجر", "kind": "deduction", "quantityBased": true },
  { "code": "ADVANCE_RECOVERY", "nameEn": "Advance recovery",        "nameAr": "استرداد سلفة",      "kind": "deduction", "quantityBased": false }
]
```

`OVERTIME` is `quantityBased: false` because spec:2078 says overtime is *"entered as an amount"* in v1 and spec:2093 puts overtime calculators out of scope. `UNPAID_LEAVE` is the one quantity-based component — *"days × daily rate"*.

`packages/db/seed/my/statutory/README.md`:

```markdown
# `seed/my/statutory` — statutory schemes, pay components and rate tables

**`schemes.json`** and **`pay-components.json`** ship now. They carry names, kinds and codes and
**no number of any kind**.

**`<SCHEME>/vN.json`** — the rate tables — **do not exist yet**, and the four directories beside this
file are empty on purpose. spec:2080: *"This document states no rate, threshold, ceiling or formula."*
A rate table enters this repository only when OD-23 delivers it: the current published tables with,
per `packages/domain/payroll/rate-table.schema.json`, a `source` naming the authority, the
publication, its URL and the date it was retrieved, and a `verification` block naming the accountant
who signed it off. The seed pull request is the reviewed diff LEGACY-078 asks for.

**`pay_component_scheme` has no rows here either.** "Basic salary is subject to EPF" is a statutory
applicability claim, and this repository makes none. Those rows arrive in the same pull request as
the tables.

Every test in the repository runs on the clearly synthetic `SYNTH` table
(`SYNTH_RATE_TABLE_V1` in `packages/db/test/fixtures.ts`, and 8B's
`packages/db/seed/test/statutory/SYNTH/v1.json`), whose `source.authority` is the literal
`"Dulja test fixture"`. The loader refuses a file with that authority outside `APP_ENV = dev`.
```

- [ ] **Step 6: Write the loader and its five `packs.ts` edits**

`packages/db/src/seed/statutory.ts`:

```ts
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { parseRateTable } from "@dulja/domain/payroll";
import type { LoaderContext, PackLoader } from "./packs";
import { readPackFile } from "./packs";

export interface SchemeSeed { code: string; nameEn: string; nameAr?: string; roundingMode?: string }
export interface PayComponentSeed { code: string; nameEn: string; nameAr?: string; kind: "earning" | "deduction"; quantityBased?: boolean }

const TEST_AUTHORITY = "Dulja test fixture";

/** Applies schemes, then components, then every `<SCHEME>/vN.json` present. Idempotent on the
 *  natural keys (§3.4.8): `on conflict do nothing` for schemes and components,
 *  `on conflict (scheme_id, version) do nothing` for tables — a loaded table is NEVER overwritten,
 *  because overwriting one silently replaces numbers a second principal already verified. */
export async function loadStatutoryPack(tx: Sql, ctx: LoaderContext): Promise<number> {
  let applied = 0;

  const schemes = readPackFile<SchemeSeed[]>(ctx.packRoot, "statutory", "schemes.json");
  for (const s of schemes) {
    const res = await tx`
      insert into app.statutory_scheme (tenant_id, company_id, code, name_en, name_ar, rounding_mode)
      values (${ctx.tenantId}, ${ctx.companyId}, ${s.code}, ${s.nameEn}, ${s.nameAr ?? null},
              ${s.roundingMode ?? "HALF_AWAY_FROM_ZERO"})
      on conflict (company_id, code) do nothing`;
    applied += res.count;
  }

  const components = readPackFile<PayComponentSeed[]>(ctx.packRoot, "statutory", "pay-components.json");
  for (const c of components) {
    const res = await tx`
      insert into app.pay_component (tenant_id, company_id, code, name_en, name_ar, kind, quantity_based)
      values (${ctx.tenantId}, ${ctx.companyId}, ${c.code}, ${c.nameEn}, ${c.nameAr ?? null}, ${c.kind}, ${c.quantityBased ?? false})
      on conflict (company_id, code) do nothing`;
    applied += res.count;
  }
  // pay_component_scheme is deliberately NOT seeded here: applicability is a statutory claim and
  // arrives with OD-23, in the same reviewed pull request as the tables (spec:2078, hazard 1).

  const devOnly = (process.env.APP_ENV ?? "dev") === "dev";
  for (const scheme of schemes) {
    const dir = join(ctx.packRoot, "statutory", scheme.code);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f)).sort()) {
      const definition = parseRateTable(readPackFile<unknown>(ctx.packRoot, "statutory", `${scheme.code}/${file}`));
      if (definition.source.authority === TEST_AUTHORITY && !devOnly) {
        throw new Error(`${scheme.code}/${file} carries source.authority "${TEST_AUTHORITY}"; a test fixture may not be seeded outside APP_ENV=dev (§4.12.4)`);
      }
      if (definition.scheme !== scheme.code) {
        throw new Error(`${scheme.code}/${file} declares scheme "${definition.scheme}"; the directory says "${scheme.code}"`);
      }
      const res = await tx`
        insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
        select ${ctx.tenantId}, s.id, ${definition.version}, ${definition.effective_from}::date,
               ${definition.effective_to}::date, ${tx.json(definition)},
               ${`${definition.source.authority} / ${definition.source.publication} / retrieved ${definition.source.retrieved_on}`}
          from app.statutory_scheme s where s.company_id = ${ctx.companyId} and s.code = ${scheme.code}
        on conflict (scheme_id, version) do nothing`;
      applied += res.count;
      // verified_by is NEVER set here. The seed runs as the system principal; verification is a
      // human act by a DIFFERENT principal through hr.statutory_table.verify (spec:2080, ADR 0073).
    }
  }
  return applied;
}

export const statutoryLoader: PackLoader = { name: "statutory", load: loadStatutoryPack };
```

`packages/db/src/seed/packs.ts` — the five edits 1A and 2C already made twice (amendment A12):

```ts
export type SubPack = "roles" | "dimensions" | "fiscal-periods" | "chart-of-accounts" | "document-types" | "templates" | "tax" | "reports" | "statutory";
export const SUB_PACKS: readonly SubPack[] = [
  "roles", "dimensions", "fiscal-periods", "chart-of-accounts", "document-types", "templates", "tax", "reports", "statutory",
];   // APPLICATION order: statutory is last — a rate table points at a scheme, a scheme at a company.
export const PHASE_0_SUB_PACK_DIRECTORIES: readonly string[] = [
  "chart-of-accounts", "dimensions", "fiscal-periods", "document-types", "templates", "tax", "reports", "statutory",
];
// OWNED_ELSEWHERE loses its "statutory" entry: the loader has shipped, so assertPackShape must stop
// treating the directory as a later slice's and start requiring it (§4.2.13, 2C's precedent).
```

`packages/db/src/seed/index.ts`:

```ts
export { statutoryLoader, loadStatutoryPack, type SchemeSeed, type PayComponentSeed } from "./statutory";
```

and `LOADERS` gains `statutoryLoader`. **Nothing is exported from `packages/db/src/index.ts`** — §3.1's `legacy-039` rule.

- [ ] **Step 7: Write the loader test**

`packages/db/test/hr/statutory-loader.test.ts` — **nine cases**. Cases 1–3 and 8–9 run against the **shipped** pack root (`packages/db/seed/my`); cases 4–7 run against a **temporary** pack root the test builds. The suite calls `loadStatutoryPack` directly rather than shelling out to `bun run seed`: `runLoaders` already opens the `withTenant` the loader is handed (§4.2.13, and 1A's note that a `load` opening a second one raises `ERR_TENANT_CONTEXT_NESTED`), so the transaction has to come from the test. **Step 9's `bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only statutory` is what exercises the CLI end of the same path**, and it is the reason case 1's row count and the seed's printed `statutory: 10 rows` have to agree.

```ts
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateTableValidationError } from "@dulja/domain/payroll";
import { loadStatutoryPack } from "../../src/seed/statutory";
import type { LoaderContext } from "../../src/seed/packs";
import type { SeedConfig } from "../../src/seed/config";
import { seedTenant, SYNTH_RATE_TABLE_V1, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

// `packages/db/test/hr/` → four levels up is the repository root. 0B's `REPO_ROOT` lives in the ROOT
// `tests/` workspace (`tests/support/source.ts`) and `packages/db` does not import that workspace, so
// the constant is derived here rather than reached for across a package boundary (§3.1).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SHIPPED_PACK = join(REPO_ROOT, "packages", "db", "seed", "my");

const tempRoots: string[] = [];

/** A temporary pack root. `definition` defaults to the fixture table so cases 4 and 5 share one
 *  builder; cases 6 and 7 pass a deliberately broken one. */
const tempPack = (definition: unknown = SYNTH_RATE_TABLE_V1): string => {
  const root = mkdtempSync(join(tmpdir(), "dulja-statutory-"));
  tempRoots.push(root);
  mkdirSync(join(root, "statutory", "SYNTH"), { recursive: true });
  // The loader walks `schemes.json` and looks for a directory named by each scheme's CODE, so a
  // temporary pack carrying only `SYNTH/v1.json` and no scheme row would never be entered at all —
  // the test would pass for the wrong reason. Both files are written.
  writeFileSync(join(root, "statutory", "schemes.json"),
    JSON.stringify([{ code: "SYNTH", nameEn: "Synthetic test scheme" }]), "utf8");
  writeFileSync(join(root, "statutory", "pay-components.json"),
    JSON.stringify([{ code: "BASIC", nameEn: "Basic salary", kind: "earning" }]), "utf8");
  writeFileSync(join(root, "statutory", "SYNTH", "v1.json"), JSON.stringify(definition), "utf8");
  return root;
};

/** The loader reads only `packRoot`, `tenantId` and `companyId`, but `LoaderContext` requires the
 *  whole `SeedConfig`, so the literal is written out once. The values are inert: no loader in this
 *  slice reads them, and a test that invented a second shape for them would be the hazard-9 defect. */
const ctxFor = (s: Seed, packRoot: string): LoaderContext => {
  const config: SeedConfig = {
    tenantId: s.tenant, only: ["statutory"], packRoot,
    tenantName: "8A loader test", ownerEmail: "loader@dulja.invalid",
    companyCode: "HQ", companyName: "8A loader test company", baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur", fiscalYearStartMonth: 1, fiscalYear: 2026,
  };
  return { config, tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot };
};

/** The loader reads `process.env.APP_ENV` at CALL time (`(process.env.APP_ENV ?? "dev") === "dev"`),
 *  so every case that depends on the branch sets it explicitly and restores it. Nothing in the repo
 *  sets APP_ENV under vitest today, which means the default is `dev` — but a case whose meaning is
 *  "in dev" must not be silently re-decided the day someone adds `APP_ENV` to a vitest config. */
const withAppEnv = async <T>(value: string, fn: () => Promise<T>): Promise<T> => {
  const before = process.env.APP_ENV;
  process.env.APP_ENV = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = before;
  }
};

describe("the statutory sub-pack loader (§3.4.8, ADR 0073)", () => {
  let db: Db; let a: Seed; let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-pack-shipped");     // cases 1-3, 8-9
    b = await seedTenant(db, "8a-pack-temp");        // cases 4-7
  }, 180_000);
  afterAll(async () => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    await db.stop();
  });

  const run = (s: Seed, packRoot: string): Promise<number> =>
    withTenant(db.rw, s.tenant, s.system, (tx) => loadStatutoryPack(tx, ctxFor(s, packRoot)));

  it("applies the shipped pack: four schemes and six components, and returns 10", async () => {
    const applied = await withAppEnv("dev", () => run(a, SHIPPED_PACK));
    expect(applied).toBe(10);
    const [schemes] = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.statutory_scheme where company_id = ${a.company}`);
    const [components] = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.pay_component where company_id = ${a.company}`);
    expect(schemes!.n).toBe("4");
    expect(components!.n).toBe("6");
    // No rate table came with them: the four scheme directories ship empty (case 8 proves it on disk).
    const [tables] = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.statutory_rate_table`);
    expect(tables!.n).toBe("0");
  });

  it("is idempotent on the natural keys — the second run applies zero (§3.4.8)", async () => {
    const applied = await withAppEnv("dev", () => run(a, SHIPPED_PACK));
    expect(applied).toBe(0);
    const [schemes] = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.statutory_scheme where company_id = ${a.company}`);
    expect(schemes!.n).toBe("4");
  });

  it("makes NO applicability claim — pay_component_scheme is empty after a fresh seed (spec:2078)", async () => {
    const [joins] = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.pay_component_scheme`);
    expect(joins!.n).toBe("0");
  });

  it("loads a rate table from a pack, unverified, stamped with the loading principal", async () => {
    const applied = await withAppEnv("dev", () => run(b, tempPack()));
    expect(applied).toBe(3);                        // one scheme, one component, one rate table
    const [row] = await withTenant(db.rw, b.tenant, b.system, (tx) =>
      tx<{ version: number; verified_at: string | null; verified_by: string | null; loaded_by: string; source: string }[]>`
        select t.version, t.verified_at, t.verified_by, t.loaded_by, t.source
          from app.statutory_rate_table t
          join app.statutory_scheme s on s.id = t.scheme_id
         where s.company_id = ${b.company} and s.code = 'SYNTH'`);
    expect(row!.version).toBe(1);
    // The seed NEVER verifies: verification is a human act by a DIFFERENT principal (spec:2080, ADR 0073).
    expect(row!.verified_at).toBeNull();
    expect(row!.verified_by).toBeNull();
    expect(row!.loaded_by).toBe(b.system);
    expect(row!.source).toContain("Dulja test fixture");
  });

  it("refuses a test-fixture authority outside APP_ENV=dev, naming the file (§4.12.4)", async () => {
    // The authority check runs BEFORE the insert and before the scheme-mismatch check, so this case
    // is unaffected by whatever the previous case left in tenant b.
    await expect(withAppEnv("staging", () => run(b, tempPack()))).rejects.toThrow(
      /SYNTH\/v1\.json carries source\.authority "Dulja test fixture"; a test fixture may not be seeded outside APP_ENV=dev/);
  });

  it("refuses a file whose declared scheme disagrees with its directory", async () => {
    const wrong = { ...SYNTH_RATE_TABLE_V1, scheme: "OTHER" };
    await expect(withAppEnv("dev", () => run(b, tempPack(wrong))))
      .rejects.toThrow('SYNTH/v1.json declares scheme "OTHER"; the directory says "SYNTH"');
  });

  it("refuses a definition with no source, with a JSON Pointer at the root (LEGACY-078)", async () => {
    const noSource: Record<string, unknown> = { ...SYNTH_RATE_TABLE_V1 };
    delete noSource.source;                         // a destructured `_unused` would trip oxlint
    let caught: unknown;
    try { await withAppEnv("dev", () => run(b, tempPack(noSource))); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RateTableValidationError);
    // Deleting a required root property yields exactly one Ajv error at instancePath "", which
    // `validateRateTable` maps to "/" — the same pointer shape §4.2.4's `Problem.errors[]` carries.
    expect((caught as RateTableValidationError).errors[0]!.path).toBe("/");
  });

  it("the shipped pack contains NO rate table — OD-23 has not landed (spec:2080, hazard 1)", () => {
    for (const scheme of ["EPF", "SOCSO", "EIS", "PCB"]) {
      const files = readdirSync(join(SHIPPED_PACK, "statutory", scheme));
      expect(files.filter((f) => /^v\d+\.json$/.test(f))).toEqual([]);
    }
  });

  it("and no file anywhere under seed/my/ carries a rate-table shape", () => {
    const raw = readFileSync(join(SHIPPED_PACK, "statutory", "pay-components.json"), "utf8");
    expect(raw).not.toMatch(/employee_rate|employer_rate|bands|brackets|ceiling/);
  });
});
```

- [ ] **Step 8: Write ADR 0073**

`docs/adr/0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door.md`:

```markdown
# ADR 0073 — Statutory rate tables are seed-pack data, with one break-glass door

Status: Accepted
Date: 2026-09-08
Slice: 8A

## Context

spec:2080 gives two load paths and ranks them: rate tables are "seeded from version-controlled files
under `packages/db/seed/my/statutory/<scheme>/vN.json` **so every change is a reviewed diff**
(LEGACY-078)", and "the seed pull request is the primary load path; the runtime
`hr.statutory_table.manage` load is **break-glass**". What "break-glass" means operationally was not
written down, and a permission with no stated intent becomes an ordinary one.

## Decision

**The pack is the source of truth and the API is the exception.** `bun run seed --tenant <id>
--only statutory` inserts every `<SCHEME>/vN.json` present with `on conflict (scheme_id, version) do
nothing`, so a re-run never overwrites a table a second principal has already verified. The runtime
`POST …/statutory-schemes/{schemeId}/rate-tables` exists for one situation: an authority publishes a
change that must be in payroll before the next deployment. It writes the same row, through the same
validation, with the same `loaded_by` stamp.

**Neither path can verify.** The seed runs as the system principal and leaves `verified_at` null;
the API's load route leaves it null too. Verification is a separate route under a **different**
permission held by a **different** seeded role (`hr.statutory_table.verify` → `accountant`, R6), and
the trigger of migration 0084 refuses it when the actor is the loader. A break-glass load therefore
cannot become a break-glass *use*: 8B's run refuses an unverified table
(`ERR_PAYROLL_RATE_TABLE_UNVERIFIED`, test 29).

**A break-glass load is visible afterwards.** The row is audited like every other, and its `source`
column carries the authority, publication and retrieval date the schema requires — so the follow-up
pull request that adds the file to the pack has something to be checked against. The runbook step is
"after any break-glass load, commit the same JSON under `seed/my/statutory/<scheme>/` in the next
pull request"; the seed's `do nothing` makes that commit a no-op against the database and a
permanent record in the repository.

## Consequences

- The repository ships **no rate table at all** until OD-23. The four scheme directories exist and
  are empty; `.gitkeep` and a README say why.
- A test fixture cannot be seeded into a real environment: the loader refuses a file whose
  `source.authority` is `"Dulja test fixture"` unless `APP_ENV = dev` (§4.12.4).
- `pay_component_scheme` rows are pack data on the same terms and are equally absent, because
  "component X is subject to scheme Y" is a statutory claim.
- 8D's parallel run has a written provenance for every figure it compares against the legacy system.

## Rejected

- **API-only loading.** No reviewed diff, which is the LEGACY-078 defect verbatim.
- **Seed-only loading.** A statutory change between deployments would mean a deployment, and payroll
  deadlines do not move for a release train.
- **Letting the seed set `verified_at` when the file carries a `verification` block.** The block
  records who signed the *paper*; `verified_by` records which Dulja principal accepted it into this
  tenant. Collapsing them would let one person write both, which is what spec:2080 forbids.
```

- [ ] **Step 9: Run to green and commit**

```bash
cd packages/domain && bun run rate-table:types && bun run test -- test/payroll/
cd ../db && bun run test -- test/hr/statutory-loader.test.ts
cd ../.. && bun run --cwd packages/db seed --tenant "$TEST_TENANT" --only statutory
bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 7 + 1 + 9 passing, the seed printing `statutory: 10 rows` and exit 0 — and the same two `permission-catalogue` lines as Tasks 7 and 8 (`hr.statutory_table.manage`, `hr.statutory_table.verify`), which Task 10 closes. This task seeds no permission and writes no `PERMISSION[…]` reference, so the pair is unchanged rather than absent; two unexplained lint lines at the end of a task are what Global Constraint 19 asks each "run everything" step to account for.

```bash
git add packages/domain/payroll/ packages/domain/scripts/generate-rate-table-type.ts packages/domain/package.json \
        packages/domain/test/payroll/ packages/db/src/seed/statutory.ts packages/db/src/seed/index.ts \
        packages/db/src/seed/packs.ts packages/db/seed/my/statutory/ packages/db/test/hr/statutory-loader.test.ts \
        docs/adr/0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door.md
git commit -m "$(cat <<'EOF'
feat(domain): the rate-table schema and the statutory seed sub-pack [8A T9]

packages/domain/payroll/ ships §4.12.3's schema verbatim, the RateTable type GENERATED from it and
committed with a drift guard (1A's pattern), and validateRateTable/parseRateTable returning JSON
Pointers. The subtree sits beside src/ behind a new "./payroll" export subpath, and a test in the
package states spec:2366's "core never imports HR" so a domain change fails there first.
packages/db gains the `statutory` sub-pack loader §3.4.8 assigns 8A, with the five packs.ts edits
1A and 2C already made for document-types and templates. The pack ships scheme NAMES and component
NAMES and no number: the four <SCHEME>/ directories are empty, the loader refuses a "Dulja test
fixture" authority outside APP_ENV=dev, and neither load path can set verified_at (ADR 0073).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The statutory-scheme routes, the break-glass load, verification, and the lapse-warning job

**Three routes and one job.** `statutorySchemeRoutes` at `/v1/companies/:companyId/statutory-schemes` (amendment A7, one `PROBES` key) carries the scheme list, the break-glass `POST …/{schemeId}/rate-tables` under `hr.statutory_table.manage`, and `POST …/{schemeId}/rate-tables/{version}/verify` under `hr.statutory_table.verify`. The job is `hr.rate_table.lapse_warning`, already in the closed sixteen-name `JOBS` registry with `schedule: "0 7 * * *"` and `owner: "8A"` — this task writes its payload, its handler and its probe, and registers the third audit sentinel (amendment A10).

**The two codes close the `permission-catalogue` lint.** After this task `bun run lint:rules` is silent (Global Constraint 19).

**Files:**
- Create: `apps/api/src/routes/hr/statutory-schemes.ts`, `packages/contracts/src/hr/statutory-scheme.ts`, `apps/api/test/routes/hr/statutory-schemes.test.ts`, `apps/worker/src/jobs/rate-table-lapse.ts`, `apps/worker/test/jobs/rate-table-lapse.test.ts`
- Modify: `apps/api/src/routes/index.ts`, `packages/db/src/jobs/payloads.ts` (one key), `tests/invariants/probes.ts` (one `PROBES`, one `JOB_PROBES`), `apps/worker/src/index.ts` (register the handler), `packages/contracts/openapi.json`

**Interfaces**

- Consumes: `listSchemes`, `listRateTables`, `loadRateTable`, `verifyRateTable`, `lapsingTables` (Task 8); `parseRateTable`, `RateTableValidationError` (Task 9); `PERMISSION["hr.statutory_table.manage"]`, `PERMISSION["hr.statutory_table.verify"]` (Task 2); `JOBS`, `JobPayload`, `JobEnvelope`, `JobHandler`, `registerHandler`, `runJob`, `eachTenant`, `systemContext` (§4.2.6); `startWorker` (§4.17.1); `hrFixture` (A6).
- Produces:

```ts
// packages/db/src/jobs/payloads.ts — ONE key added; no other line is touched (§4.2.6)
  /** Slice 8A. Omit all three for the nightly whole-tenant run at spec:2109's sixty-day horizon. */
  "hr.rate_table.lapse_warning": { companyId?: string; asOf?: string; horizonDays?: number };

// apps/worker/src/jobs/rate-table-lapse.ts
export const LAPSE_HORIZON_DAYS = 60;                       // spec:2109 — the literal lives here once
export const LAPSE_AUDIT_TABLE = "rate_table_lapse_warning"; // the THIRD audit sentinel (§4.2.6, amendment A10)
export interface LapseWarning { schemeCode: string; version: number; effectiveTo: string; daysRemaining: number }
export const rateTableLapseHandler: JobHandler<"hr.rate_table.lapse_warning">;
export function registerRateTableLapse(): void;
```

- [ ] **Step 1: Write the failing route test**

`apps/api/test/routes/hr/statutory-schemes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYNTH_RATE_TABLE_V1 } from "@dulja/db/test";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("statutory schemes and rate tables over HTTP", () => {
  let f: HrFixture; let schemeId: string; let componentId: string;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-schemes");
    // The scheme comes from the FIXTURE, not from the list endpoint. Schemes are seed-pack data
    // (ADR 0073) and no route creates one, so reading the list here would return an empty array on a
    // fresh database and every case below would fail in set-up rather than on its own assertion —
    // and the list route is itself one of the things this suite is meant to test. `hrFixture` seeds
    // exactly one, code "SYNTH" (Task 8 Step 6).
    schemeId = f.schemeId;
    // One pay component too, for the FK case at the end of this file.
    const created = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/pay-components`, as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false } });
    componentId = ((await created.json()) as { id: string }).id;
  }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  it("the list route returns the fixture's scheme, by code", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/statutory-schemes`, as: f.officer });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { id: string; code: string; employerRegistration: string | null }[] };
    const synth = body.items.find((s) => s.code === "SYNTH");
    expect(synth?.id).toBe(schemeId);
    expect(synth?.employerRegistration).toBeNull();     // ⚠️ OD-23 has not landed (T11)
  });

  it("the break-glass load stores the table UNVERIFIED and stamps loaded_by (ADR 0073)", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables`, as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 },
    });
    expect(res.status).toBe(201);
    const dto = await res.json() as { version: number; verifiedAt: string | null; loadedBy: string };
    expect(dto.version).toBe(1);
    expect(dto.verifiedAt).toBeNull();
    expect(dto.loadedBy).toBe(f.officer);
  });

  it("an invalid definition is ERR_VALIDATION_FAILED with JSON-Pointer paths (§4.2.4)", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables`, as: f.officer,
      body: { definition: { schema_version: 1, scheme: "SYNTH", version: 9 } },
    });
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_VALIDATION_FAILED");
    expect(p.errors!.length).toBeGreaterThan(0);
    expect(p.errors![0]!.path).toMatch(/^\//);
  });

  it("the LOADER cannot verify (test 35, spec:2080)", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables/1/verify`, as: f.officer });
    // the officer holds manage, not verify, so the pre-flight refuses FIRST — and that is the point:
    // the two codes are held by two seeded roles (R6), so the trigger is the second line, not the first.
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the CHECKER can, and the row comes back verified", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables/1/verify`, as: f.checker });
    expect(res.status).toBe(200);
    const dto = await res.json() as { verifiedAt: string | null; verifiedBy: string | null };
    expect(dto.verifiedAt).not.toBeNull();
    expect(dto.verifiedBy).toBe(f.checker);
  });

  it("and a principal holding BOTH codes still cannot verify what they loaded — the trigger is the control", async () => {
    // grantCodes gives the checker the manage code too, so one principal now holds both.
    await f.api.request({ method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables`, as: f.checker,
      body: { definition: { ...SYNTH_RATE_TABLE_V1, version: 2, effective_from: "2027-01-01" } } });
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables/2/verify`, as: f.checker });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_VERIFY");
  });

  it("a second verification of the same version is 409, not a silent success", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables/1/verify`, as: f.checker });
    expect([404, 409]).toContain(res.status);
  });

  it("the outsider sees no scheme at all", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/statutory-schemes`, as: f.outsider });
    expect(res.status).toBe(403);
  });

  it("neither unsafe route accepts a call without Idempotency-Key", async () => {
    const res = await f.api.request({
      method: "POST", path: `/v1/companies/${f.companyId}/statutory-schemes/${schemeId}/rate-tables`, as: f.officer,
      body: { definition: SYNTH_RATE_TABLE_V1 }, idempotencyKey: null });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  // **Task 7's route, asserted here.** `PUT /pay-components/{id}/schemes` is Task 7's, but amendment
  // A13 leaves `pay_component_scheme.scheme_id` an unconstrained FK *slot* until migration 0084 adds
  // `pay_component_scheme_scheme_fk` — which is Task 8. At the end of Task 7 an unknown id would
  // simply insert and the route would answer 200, so the case lives in the first suite that runs with
  // the constraint in place. The real scheme id proves the same route succeeds, so a 409 below cannot
  // be a route that is broken for every input.
  it("PUT /pay-components/{id}/schemes maps a scheme, and an unknown one is ERR_CONFLICT_REFERENCE", async () => {
    const ok = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/pay-components/${componentId}/schemes`, as: f.officer,
      body: { schemeIds: [schemeId] } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { schemeIds: string[] }).schemeIds).toEqual([schemeId]);

    const bad = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/pay-components/${componentId}/schemes`, as: f.officer,
      body: { schemeIds: ["00000000-0000-7000-8000-0000000000ee"] } });
    expect(bad.status).toBe(409);
    expect((await problemOf(bad)).code).toBe("ERR_CONFLICT_REFERENCE");
  });
});
```

The "holding BOTH codes" case depends on the checker holding **both** codes, which is why `hrFixture`'s checker grant is `["hr.statutory_table.verify", "hr.statutory_table.manage"]` — plus `"hr.employee.read"` when 6C has merged — from Task 3 Step 8 onward — recorded on amendment A6's row, because the fixture is the shared corpus and 8B reads the same list. R6 forbids one *seeded role* holding both (§4.2.5, and Task 2 splits them across `hr_payroll` and `accountant` for exactly that reason); a test role is not a seeded role, and this case is where the trigger has to hold the rule on its own.

- [ ] **Step 2: Write the failing job test**

`apps/worker/test/jobs/rate-table-lapse.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJob } from "../../src/handler";
import { registerRateTableLapse, LAPSE_AUDIT_TABLE } from "../../src/jobs/rate-table-lapse";
import { seedRateTable, seedStatutoryScheme, seedTenant, SYNTH_RATE_TABLE_V1, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "../support/worker";

describe("hr.rate_table.lapse_warning (spec:2109)", () => {
  let w: StartedWorker; let a: Seed; let schemeId: string;
  beforeAll(async () => {
    w = await startWorker();
    registerRateTableLapse();
    a = await seedTenant(w.db, "8a-lapse");
    schemeId = await seedStatutoryScheme(w.db, a, { code: "SYNTH" });
    await seedRateTable(w.db, a, { schemeId, version: 1, verified: true,
      definition: { ...SYNTH_RATE_TABLE_V1, effective_from: "2026-01-01", effective_to: "2026-12-31" } });
  }, 240_000);
  afterAll(async () => { await w.stop(); });

  it("warns for a table lapsing inside the horizon and writes the sentinel audit row", async () => {
    await runJob(w.db.rw, "hr.rate_table.lapse_warning", {
      tenantId: a.tenant, requestId: "00000000-0000-7000-8000-00000000cc01", payload: { asOf: "2026-11-15" } });
    const [row] = await w.db.admin<{ after: { warnings: { schemeCode: string; daysRemaining: number }[] } }[]>`
      select after from app.audit_log where tenant_id = ${a.tenant} and table_name = ${LAPSE_AUDIT_TABLE} order by seq desc limit 1`;
    expect(row!.after.warnings).toHaveLength(1);
    expect(row!.after.warnings[0]!.schemeCode).toBe("SYNTH");
    expect(row!.after.warnings[0]!.daysRemaining).toBe(46);
    expect(w.logs.some((l) => l.includes("rate table lapsing"))).toBe(true);
  });

  it("is silent outside the horizon — no audit row, no log line", async () => {
    const before = await w.db.admin<{ n: string }[]>`
      select count(*)::text as n from app.audit_log where tenant_id = ${a.tenant} and table_name = ${LAPSE_AUDIT_TABLE}`;
    await runJob(w.db.rw, "hr.rate_table.lapse_warning", {
      tenantId: a.tenant, requestId: "00000000-0000-7000-8000-00000000cc02", payload: { asOf: "2026-06-01" } });
    const after = await w.db.admin<{ n: string }[]>`
      select count(*)::text as n from app.audit_log where tenant_id = ${a.tenant} and table_name = ${LAPSE_AUDIT_TABLE}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("a successor version silences the warning", async () => {
    await seedRateTable(w.db, a, { schemeId, version: 2, verified: true,
      definition: { ...SYNTH_RATE_TABLE_V1, version: 2, effective_from: "2027-01-01", effective_to: null } });
    await runJob(w.db.rw, "hr.rate_table.lapse_warning", {
      tenantId: a.tenant, requestId: "00000000-0000-7000-8000-00000000cc03", payload: { asOf: "2026-11-15" } });
    const [row] = await w.db.admin<{ after: { warnings: unknown[] } }[]>`
      select after from app.audit_log where tenant_id = ${a.tenant} and table_name = ${LAPSE_AUDIT_TABLE} order by seq desc limit 1`;
    expect(row!.after.warnings).toHaveLength(1);   // still the FIRST run's row: the second and third wrote none
  });

  it("the job's default horizon is sixty days (spec:2109)", async () => {
    const { LAPSE_HORIZON_DAYS } = await import("../../src/jobs/rate-table-lapse");
    expect(LAPSE_HORIZON_DAYS).toBe(60);
  });

  it("runs as the tenant's SYSTEM principal (hazard 20)", async () => {
    const [row] = await w.db.admin<{ actor_id: string }[]>`
      select actor_id from app.audit_log where tenant_id = ${a.tenant} and table_name = ${LAPSE_AUDIT_TABLE} order by seq desc limit 1`;
    const [sys] = await w.db.admin<{ id: string }[]>`
      select p.id from app.principal p where p.auth_subject = ${`system:${a.tenant}`}`;
    expect(row!.actor_id).toBe(sys!.id);
  });
});
```

- [ ] **Step 3: Write the routes**

`packages/contracts/src/hr/statutory-scheme.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const RoundingModeSchema = z.enum(["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"]).openapi("RoundingMode");

export const StatutorySchemeSchema = z.object({
  id: UuidSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/),      // the §4.12.3 pattern, so a scheme code and a rate table's `scheme` cannot disagree
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  payableAccountId: UuidSchema.nullable(),               // 8B fills it (amendment A2)
  employerExpenseAccountId: UuidSchema.nullable(),
  authorityPartyId: UuidSchema.nullable(),
  employerRegistration: z.string().max(80).nullable(),   // ⚠️ OD-23 (amendment A3)
  roundingMode: RoundingModeSchema,
}).openapi("StatutoryScheme");

export const StatutorySchemeList = ListEnvelope(StatutorySchemeSchema);

/** `definition` is `z.unknown()` deliberately: the generated `RateTable` lives in
 *  `packages/domain/payroll` and `packages/contracts` is core-tier, so it may not import it
 *  (spec:2366). The route parses with `parseRateTable` and answers ERR_VALIDATION_FAILED with the
 *  validator's JSON Pointers, which is a better error than any Zod restatement would give. */
export const RateTableSchema = z.object({
  id: UuidSchema,
  schemeId: UuidSchema,
  schemeCode: z.string(),
  version: z.number().int().min(1),
  effectiveFrom: DateSchema,
  effectiveTo: DateSchema.nullable(),
  definition: z.unknown(),
  source: z.string(),
  loadedBy: UuidSchema,
  verifiedBy: UuidSchema.nullable(),
  verifiedAt: TimestampSchema.nullable(),
}).openapi("StatutoryRateTable");

export const RateTableList = ListEnvelope(RateTableSchema);
export const LoadRateTableBody = z.object({ definition: z.unknown() }).openapi("LoadRateTableBody");
export type StatutorySchemeDto = z.infer<typeof StatutorySchemeSchema>;
export type RateTableDto = z.infer<typeof RateTableSchema>;
```

`apps/api/src/routes/hr/statutory-schemes.ts` — the file's head, then its three routes and its module const. **There is no create-a-scheme route**: schemes are seed-pack data (ADR 0073) and this module reads them, loads tables against them and verifies those tables, which is the whole of its surface.

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "@dulja/contracts";
import {
  LoadRateTableBody, RateTableSchema, StatutorySchemeList,
} from "@dulja/contracts/hr/statutory-scheme";
import { PERMISSION } from "@dulja/contracts/permissions";
import { parseRateTable, RateTableValidationError, type RateTable } from "@dulja/domain/payroll";
import { listRateTables, listSchemes, loadRateTable, verifyRateTable, type RateTableRow } from "@dulja/db";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader, type RouteModule } from "../index";
import type { AppEnv } from "../../context";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const SchemeParams = CompanyParams.extend({ schemeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;

/** `definition` reaches the wire as the `unknown` the schema declares: `packages/contracts` is
 *  core-tier and may not import the generated `RateTable` from `packages/domain/payroll` (spec:2366),
 *  and the row's own `definition` column is `unknown` for the same reason (Task 8's mirror says so). */
const toDto = (t: RateTableRow) => ({
  id: t.id, schemeId: t.schemeId, schemeCode: t.schemeCode, version: t.version,
  effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo, definition: t.definition,
  source: t.source, loadedBy: t.loadedBy, verifiedBy: t.verifiedBy, verifiedAt: t.verifiedAt,
});

export const statutorySchemeRoutes = new OpenAPIHono<AppEnv>();

statutorySchemeRoutes.openapi(
  createRoute({
    method: "post", path: "/{schemeId}/rate-tables", tags: ["hr"],
    request: { params: SchemeParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: LoadRateTableBody } } } },
    middleware: [requirePermission(PERMISSION["hr.statutory_table.manage"], { company: "path:companyId" })],
    responses: { 201: { description: "Loaded, UNVERIFIED", content: { "application/json": { schema: RateTableSchema } } } },
  }),
  async (c) => {
    const { schemeId } = c.req.valid("param");
    let definition: RateTable;
    try { definition = parseRateTable(c.req.valid("json").definition); }
    catch (e) {
      if (e instanceof RateTableValidationError) {
        throw new AppError("ERR_VALIDATION_FAILED", "the rate-table definition does not satisfy urn:dulja:rate-table:1", { errors: e.errors });
      }
      throw e;
    }
    const dto = await c.var.withTenant(async (tx) => {
      const id = await loadRateTable(tx, {
        schemeId, version: definition.version, effectiveFrom: definition.effective_from,
        effectiveTo: definition.effective_to ?? null, definition,
        source: `${definition.source.authority} / ${definition.source.publication} / retrieved ${definition.source.retrieved_on}`,
      });
      return (await listRateTables(tx, schemeId)).find((t) => t.id === id)!;
    });
    return c.json(toDto(dto), 201);
  },
);
```

**`AppError`'s `extra` carries `errors`** — §4.2.4's round-2 amendment A10 admits `errors[]` on `ERR_VALIDATION_FAILED` and `ERR_POLICY_INVALID` only, and this is the former. A *third* code is not registered (hazard 32).

The list route and the verify route:

```ts
statutorySchemeRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["hr"],
    request: { params: CompanyParams },
    middleware: [requirePermission(PERMISSION["hr.statutory_table.manage"], { company: "path:companyId" })],
    responses: { 200: { description: "Every scheme of the company, by code", content: { "application/json": { schema: StatutorySchemeList } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const items = await c.var.withTenant((tx) => listSchemes(tx, companyId));
    return c.json({ items, next_cursor: null }, 200);
  },
);

statutorySchemeRoutes.openapi(
  createRoute({
    method: "post", path: "/{schemeId}/rate-tables/{version}/verify", tags: ["hr"],
    request: { params: SchemeParams.extend({ version: z.coerce.number().int().min(1) }), headers: IdempotencyHeader },
    middleware: [requirePermission(PERMISSION["hr.statutory_table.verify"], { company: "path:companyId" })],
    responses: { 200: { description: "Verified", content: { "application/json": { schema: RateTableSchema } } } },
  }),
  async (c) => {
    const { schemeId, version } = c.req.valid("param");
    const dto = await c.var.withTenant(async (tx) => {
      const table = (await listRateTables(tx, schemeId)).find((t) => t.version === version);
      if (table === undefined) throw new AppError("ERR_NOT_FOUND", `scheme ${schemeId} has no rate table version ${version}`);
      // The trigger is the control (spec:2080). This call raises SQLSTATE 23514 with the token
      // ERR_HR_SELF_VERIFY when the actor is the loader, and fromDatabaseError turns it into the
      // 409 the route test asserts. The handler adds no pre-flight of its own: a second check here
      // would be a second place to get the rule wrong (LEGACY-032's shape).
      await verifyRateTable(tx, table.id);
      return (await listRateTables(tx, schemeId)).find((t) => t.id === table.id)!;
    });
    return c.json(toDto(dto), 200);
  },
);

export const statutorySchemeRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/statutory-schemes",
  router: statutorySchemeRoutes,
  // Exactly the two codes the module EVALUATES (§4.2.7). `admin.company.manage` is the hr-settings
  // module's gate (Task 11) and is not listed here: a registered code no route evaluates is a stale
  // entry the catalogue check reads and a reviewer cannot verify.
  permissions: [PERMISSION["hr.statutory_table.manage"], PERMISSION["hr.statutory_table.verify"]],
  auth: "human",
};
```

and, inside `buildRoutes` in `apps/api/src/routes/index.ts` — one line, never a push onto `ROUTES` (§4.2.7):

```ts
    statutorySchemeRouteModule,
```

- [ ] **Step 4: Write the job handler**

`apps/worker/src/jobs/rate-table-lapse.ts`:

```ts
import { lapsingTables, withTenant } from "@dulja/db";   // systemContext and eachTenant belong to index.ts, below
import { registerHandler, registeredJobNames, type JobHandler } from "../handler";
import { log } from "../log";

/** spec:2109: "a scheduled job that warns sixty days before a table lapses". The literal lives here
 *  once; the payload may override it for an operator running the job by hand. */
export const LAPSE_HORIZON_DAYS = 60;
/** The THIRD audit `table_name` sentinel (§4.2.6; 1B owns `integrity_incident` and `month_end_ready`). */
export const LAPSE_AUDIT_TABLE = "rate_table_lapse_warning";

export interface LapseWarning { schemeCode: string; version: number; effectiveTo: string; daysRemaining: number }

export const rateTableLapseHandler: JobHandler<"hr.rate_table.lapse_warning"> = async (sql, job, ctx) => {
  const asOf = job.payload.asOf ?? new Date().toISOString().slice(0, 10);
  const horizon = job.payload.horizonDays ?? LAPSE_HORIZON_DAYS;
  const rows = await withTenant(sql, ctx, (tx) => lapsingTables(tx, asOf, horizon));
  if (rows.length === 0) return;
  const warnings: LapseWarning[] = rows.map((t) => ({
    schemeCode: t.schemeCode, version: t.version, effectiveTo: t.effectiveTo!,
    daysRemaining: Math.round((Date.parse(t.effectiveTo!) - Date.parse(asOf)) / 86_400_000),
  }));
  for (const w of warnings) {
    log().warn({ scheme: w.schemeCode, version: w.version, effective_to: w.effectiveTo, days_remaining: w.daysRemaining },
      "rate table lapsing");
  }
  await withTenant(sql, ctx, (tx) => tx`
    insert into app.audit_log (tenant_id, table_name, row_id, action, after)
    values (${ctx.tenantId}, ${LAPSE_AUDIT_TABLE}, ${ctx.requestId}, 'insert',
            ${tx.json({ asOf, horizonDays: horizon, warnings })})`);
};

/** `registerHandler` throws when a name is already registered (§4.2.6), and `apps/worker/src/index.ts`
 *  calls this at boot — so a test that starts a worker and then registers again would throw before
 *  its first case. The guard makes the call idempotent, which is what a test needs and what a second
 *  boot must never silently become. */
export function registerRateTableLapse(): void {
  if (registeredJobNames().includes("hr.rate_table.lapse_warning")) return;
  registerHandler("hr.rate_table.lapse_warning", rateTableLapseHandler);
}
```

**The nightly scheduled run fans out with `eachTenant`** in `apps/worker/src/index.ts`, exactly as 1B's integrity job does; `runJob` resolves each tenant's system principal through `systemContext` (hazard 20). **Both names live in `apps/worker/src/index.ts` and not in the handler file** — `rateTableLapseHandler` is a `JobHandler`, so it is *given* its `TenantContext` by `runJob` (§4.2.6) and calls neither `systemContext` nor `eachTenant` itself. Importing them beside `lapsingTables` would be two unused bindings and `bun run lint`'s no-unused-imports rule would fail the file this task commits, which is why the import line above is exactly `{ lapsingTables, withTenant }` and nothing more. What this task adds to `apps/worker/src/index.ts` is **one line** — `registerRateTableLapse();` beside the `register*` calls 1B and 0D already make; the fan-out itself is the entrypoint's existing scheduled-job loop, which already imports `eachTenant`, already builds each tenant's context through `systemContext` inside `runJob`, and picks this job up from its `"0 7 * * *"` row in `JOBS` (§4.2.6) without a new code path.

- [ ] **Step 5: Add the probes**

`tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/statutory-schemes": {
    async seed(db, owner) {
      const schemeId = await seedStatutoryScheme(db, owner, { code: "PROBE" });
      return { path: `/v1/companies/${owner.company}/statutory-schemes/${schemeId}/rate-tables`,
               method: "POST", body: { definition: SYNTH_RATE_TABLE_V1 } };
    },
    expect: 404,
  },
```

```ts
// JOB_PROBES — the attacker enqueues for their own tenant with the victim's company id in the payload
  "hr.rate_table.lapse_warning": {
    async seed(db, attacker, victim) {
      const s = await seedStatutoryScheme(db, victim, { code: "VICTIM" });
      await seedRateTable(db, victim, { schemeId: s, verified: true,
        definition: { ...SYNTH_RATE_TABLE_V1, effective_from: "2026-01-01", effective_to: "2026-12-31" } });
      await seedStatutoryScheme(db, attacker, { code: "ATTACKER" });
    },
    async survivors(db, victim) {
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.statutory_rate_table where tenant_id = ${victim.tenant}`;
      return row!.n;
    },
  },
```

- [ ] **Step 6: Run to green and commit**

```bash
bun run --cwd packages/contracts openapi:generate
cd apps/api && bun run test -- test/routes/hr/statutory-schemes.test.ts
cd ../worker && bun run test -- test/jobs/rate-table-lapse.test.ts
cd ../.. && bun run --cwd tests test -- invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck && bun run test
```

Expected: 10 + 5 passing — the route suite is the ten cases of Step 1, two of which are here for reasons worth restating: the scheme-list case, because the fixture is where a scheme comes from and the list route has to be shown returning it; and the `PUT …/schemes` FK case, moved from Task 7 because the constraint that raises `ERR_CONFLICT_REFERENCE` arrives with migration 0084 — the isolation harness green with the new route and job probes, and **`lint:rules` silent** — the two remaining `permission-catalogue` lines are closed by this task's `PERMISSION[…]` references. That silence is Global Constraint 19's declared exception ending.

```bash
git add apps/api/src/routes/hr/statutory-schemes.ts apps/api/src/routes/index.ts \
        packages/contracts/src/hr/statutory-scheme.ts packages/contracts/openapi.json \
        apps/worker/src/jobs/rate-table-lapse.ts apps/worker/src/index.ts packages/db/src/jobs/payloads.ts \
        tests/invariants/probes.ts tests/invariants/support/hr.ts \
        apps/api/test/routes/hr/statutory-schemes.test.ts apps/worker/test/jobs/rate-table-lapse.test.ts
git commit -m "$(cat <<'EOF'
feat(api): the break-glass rate-table load, verification, and the lapse-warning job [8A T10]

One route module (three PROBES-covered routes) and one job. The load stores a table UNVERIFIED and
stamps loaded_by; verification is a different route under a different code held by a different
seeded role, and a principal holding BOTH codes still cannot verify what they loaded -- the 409 is
the trigger's, not the middleware's, which is what "enforced by the data layer" means (test 35).
An invalid definition is ERR_VALIDATION_FAILED carrying JSON Pointers, the errors[] member §4.2.4
already admits for that code. hr.rate_table.lapse_warning warns sixty days out (spec:2109), runs as
the system principal, and records the third audit sentinel. lint:rules is silent again: all six
8A codes now have handler references.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---
### Task 11: ⚠️ OD-23 — migration 0085, `app.company_hr_setting`, and the employer registration identifiers

**Owner decision OD-23** (§2.12; spec:2407, 2088). Four things are open at once and only two of them are 8A's: the **employer registration numbers** (this task) and the **accountant-signed rate tables** (Task 9's empty directories). The staff list and the pay-period conventions are 8B's and 8D's.

> **Owner provides:** the company's EPF, SOCSO, EIS and LHDN employer registration numbers; the proration rule the accountant confirms (`calendar_days` or `working_days`); and the pay day of the month (OD-23, spec:2086, 2088, 2407).
> **Verify:** after the seed, `bun run --cwd packages/db seed --tenant "$TENANT" --only statutory` exits 0 and
> `psql "$DATABASE_URL_MIGRATOR" -c "select code, employer_registration is not null as registered from app.statutory_scheme order by code"` prints `registered = t` for all four schemes.
> **Until provided:** the table ships with **no row seeded at all** and every `employer_registration` is null. Nothing in 8A, 8B or 8C reads a registration number — the first consumer is **8C's statutory schedule** and **8D's annual employer return**, both of which state a missing registration by name rather than printing an empty box. The local equivalent for every test is the same: a `company_hr_setting` row inserted by the test, and null registrations.

**What changes if the owner answers.** `packages/db/seed/my/statutory/schemes.json` gains an `employerRegistration` member per scheme and Task 9's loader writes it; a `company_hr_setting` row is seeded with the confirmed `proration_rule` and `pay_day`. **No migration and no code changes** — that is the point of A3's relational column and A4's dropped blob.

**Amendment A4 in one sentence:** `employer_registrations jsonb` is **not** built. §4.6.1 called it "the display copy" of `statutory_scheme.employer_registration`; spec:2088 says these identifiers are "relational company settings … **never a blob**", and a copy with no rebuild path is LEGACY-078's shape in miniature. A caller that wants them all reads them with one join.

**Files:**
- Create: `packages/db/migrations/0085_create_company_hr_settings.sql`, `packages/db/migrations/0085.down.sql`, `packages/db/src/hr/settings.ts`, `packages/db/src/schema/company-hr-setting.ts`, `packages/db/test/hr/company-hr-setting.test.ts`, `packages/contracts/src/hr/hr-setting.ts`, `apps/api/src/routes/hr/hr-settings.ts`, `apps/api/test/routes/hr/hr-settings.test.ts`, `docs/owner/od-23-employer-registrations.md`
- Modify: `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`, `packages/db/src/hr/index.ts`, `packages/contracts/openapi.json`

**Interfaces**

- Consumes: `PERMISSION["admin.company.manage"]` (0B — §3.6.2 fixes that company HR settings are maintained under it, so **this slice seeds no seventh code**); `listSchemes` (Task 8); `requirePermission`, `IdempotencyHeader`, `RouteModule` (§4.2.5, §4.2.7); `hrFixture` (A6).
- Produces:

```ts
// packages/db/src/hr/settings.ts
export interface CompanyHrSetting { companyId: string; prorationRule: "calendar_days" | "working_days"; payDay: number | null }
export function readHrSetting(tx: Sql, companyId: string): Promise<CompanyHrSetting | null>;
export function upsertHrSetting(tx: Sql, input: CompanyHrSetting): Promise<void>;
/** The relational read A4 replaces the blob with: one row per scheme, registration included. */
export function employerRegistrations(tx: Sql, companyId: string): Promise<{ schemeCode: string; registration: string | null }[]>;
export function setEmployerRegistration(tx: Sql, schemeId: string, registration: string | null): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/hr/company-hr-setting.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { employerRegistrations, readHrSetting, setEmployerRegistration, upsertHrSetting } from "../../src/hr/settings";
import { seedStatutoryScheme, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("migration 0085 — company HR settings (⚠️ OD-23)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "8a-set-a"); b = await seedTenant(db, "8a-set-b"); }, 180_000);
  afterAll(async () => { await db.stop(); });

  it("carries proration_rule and pay_day and NO registrations blob (amendment A4, spec:2088)", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'company_hr_setting' order by 1`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("proration_rule");
    expect(names).toContain("pay_day");
    expect(names).not.toContain("employer_registrations");
    expect(cols.filter((c) => c.data_type === "jsonb")).toEqual([]);
  });

  it("proration_rule admits exactly the two values spec:2086 names", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => upsertHrSetting(tx, { companyId: a.company, prorationRule: "calendar_days", payDay: 25 }));
    expect((await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)))!.prorationRule).toBe("calendar_days");
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.company_hr_setting set proration_rule = 'thirty_days' where company_id = ${a.company}`))
      .rejects.toThrow(/company_hr_setting_proration_rule_check/);
  });

  it("there is at most one row per company", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) => upsertHrSetting(tx, { companyId: a.company, prorationRule: "working_days", payDay: 28 }));
    const [n] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ n: string }[]>`select count(*)::text as n from app.company_hr_setting where company_id = ${a.company}`);
    expect(n!.n).toBe("1");
    expect((await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)))!.payDay).toBe(28);
  });

  it("pay_day is a day of the month or null", async () => {
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.company_hr_setting set pay_day = 32 where company_id = ${a.company}`))
      .rejects.toThrow(/company_hr_setting_pay_day_check/);
  });

  it("employer registrations are RELATIONAL, one per scheme (amendment A3)", async () => {
    const epf = await seedStatutoryScheme(db, a, { code: "SYNTH_A" });
    await seedStatutoryScheme(db, a, { code: "SYNTH_B" });
    await withTenant(db.rw, a.tenant, a.human, (tx) => setEmployerRegistration(tx, epf, "SYNTHETIC-REG-0001"));
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => employerRegistrations(tx, a.company));
    expect(rows).toEqual([
      { schemeCode: "SYNTH_A", registration: "SYNTHETIC-REG-0001" },
      { schemeCode: "SYNTH_B", registration: null },
    ]);
  });

  it("⚠️ OD-23: nothing in 8A refuses to work while every registration is null", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => employerRegistrations(tx, a.company));
    expect(rows.some((r) => r.registration === null)).toBe(true);
    expect(await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company))).not.toBeNull();
  });

  it("tenant B sees no setting of tenant A (test 12)", async () => {
    const rows = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ company_id: string }[]>`select company_id from app.company_hr_setting where company_id = ${a.company}`);
    expect(rows).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0085", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/db && bun run test -- test/hr/company-hr-setting.test.ts
```

Expected: **FAIL** at import — `Cannot find module '../../src/hr/settings'`.

- [ ] **Step 3: Write `0085_create_company_hr_settings.sql`**

```sql
-- ── 0085_create_company_hr_settings.sql ────────────────────────────────────────────────────────
-- §3.10.1 "Proration" (spec:2086) and "Employer registration identifiers" (spec:2088).
-- ⚠️ OD-23. Two settings and no blob: the employer registration numbers live RELATIONALLY, one per
-- scheme, on app.statutory_scheme.employer_registration (migration 0084, amendment A3). spec:2088:
-- "relational company settings supplied by the owner -- never a blob (§4.1)". §4.6.1's
-- `employer_registrations jsonb` "display copy" is deliberately NOT built (amendment A4): a second
-- store with no rebuild path is LEGACY-078 in miniature, and one join reads them all.

create table app.company_hr_setting (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  proration_rule text not null default 'calendar_days',
  pay_day        smallint,
  created_at     timestamptz not null default now(),
  constraint company_hr_setting_proration_rule_check check (proration_rule in ('calendar_days', 'working_days')),
  constraint company_hr_setting_pay_day_check        check (pay_day is null or (pay_day between 1 and 31)),
  unique (company_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.company_hr_setting');
call app_meta.attach_audit('app.company_hr_setting');

comment on column app.company_hr_setting.proration_rule is
  '⚠️ OD-23/OD-28. spec:2086: proration for mid-month joiners, leavers and unpaid days follows "a company-level configured rule (calendar days or working days) that the accountant confirms -- CONFIGURATION, never a statutory claim". 8B reads it; this slice only stores it.';
comment on column app.company_hr_setting.pay_day is
  '⚠️ OD-23. The day of the month wages are paid. Null until the owner confirms; 8B''s PayPeriod.payDate is entered per run and never derived from a null.';
```

`packages/db/migrations/0085.down.sql`: `drop table if exists app.company_hr_setting;`

- [ ] **Step 4: Write `packages/db/src/hr/settings.ts`, the contracts module and the route**

```ts
import type { Sql } from "postgres";

export interface CompanyHrSetting { companyId: string; prorationRule: "calendar_days" | "working_days"; payDay: number | null }

export async function readHrSetting(tx: Sql, companyId: string): Promise<CompanyHrSetting | null> {
  const [row] = await tx<{ company_id: string; proration_rule: CompanyHrSetting["prorationRule"]; pay_day: number | null }[]>`
    select company_id, proration_rule, pay_day from app.company_hr_setting where company_id = ${companyId}`;
  return row === undefined ? null : { companyId: row.company_id, prorationRule: row.proration_rule, payDay: row.pay_day };
}

export async function upsertHrSetting(tx: Sql, input: CompanyHrSetting): Promise<void> {
  await tx`
    insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
    select c.tenant_id, c.id, ${input.prorationRule}, ${input.payDay}
      from app.company c where c.id = ${input.companyId}
    on conflict (company_id) do update set proration_rule = excluded.proration_rule, pay_day = excluded.pay_day`;
}

/** Amendment A4's relational read: what the dropped jsonb "display copy" would have held. */
export async function employerRegistrations(tx: Sql, companyId: string): Promise<{ schemeCode: string; registration: string | null }[]> {
  const rows = await tx<{ code: string; employer_registration: string | null }[]>`
    select code, employer_registration from app.statutory_scheme where company_id = ${companyId} order by code`;
  return rows.map((r) => ({ schemeCode: r.code, registration: r.employer_registration }));
}

export async function setEmployerRegistration(tx: Sql, schemeId: string, registration: string | null): Promise<void> {
  const res = await tx`update app.statutory_scheme set employer_registration = ${registration} where id = ${schemeId}`;
  if (res.count === 0) throw new Error(`statutory scheme ${schemeId} is not visible to this transaction`);
}
```

`packages/db/src/schema/company-hr-setting.ts`:

```ts
import { pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const companyHrSetting = app.table("company_hr_setting", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  prorationRule: text("proration_rule").notNull().$type<"calendar_days" | "working_days">(),
  payDay: smallint("pay_day"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
// No `employerRegistrations` column and no jsonb anywhere: amendment A4, spec:2088.
```

`packages/contracts/src/hr/hr-setting.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { UuidSchema } from "../common";

export const ProrationRuleSchema = z.enum(["calendar_days", "working_days"]).openapi("ProrationRule");

/** The registrations are RETURNED here and STORED on statutory_scheme (amendments A3, A4). One
 *  read, one place to write, no copy to keep in step. */
export const HrSettingSchema = z.object({
  companyId: UuidSchema,
  prorationRule: ProrationRuleSchema,
  payDay: z.number().int().min(1).max(31).nullable(),
  employerRegistrations: z.array(z.object({
    schemeId: UuidSchema,
    schemeCode: z.string(),
    registration: z.string().max(80).nullable(),
  })),
}).openapi("HrSetting");

export const UpdateHrSettingBody = z.object({
  prorationRule: ProrationRuleSchema,
  payDay: z.number().int().min(1).max(31).nullable(),
  employerRegistrations: z.array(z.object({
    schemeId: UuidSchema,
    registration: z.string().max(80).nullable(),
  })).default([]),
}).openapi("UpdateHrSettingBody");

export type HrSettingDto = z.infer<typeof HrSettingSchema>;
```

`apps/api/src/routes/hr/hr-settings.ts` — one module, two routes, gated by `admin.company.manage`; §3.6.2 fixes that company HR settings are maintained under it, so **no seventh permission code is seeded** (hazard 26):

```ts
const CompanyParams = z.object({ companyId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;

export const hrSettingRoutes = new OpenAPIHono<AppEnv>();

const read = async (tx: Sql, companyId: string) => {
  const setting = await readHrSetting(tx, companyId);
  const schemes = await listSchemes(tx, companyId);
  return {
    companyId,
    prorationRule: setting?.prorationRule ?? "calendar_days",   // the §2.12 default until OD-23
    payDay: setting?.payDay ?? null,
    employerRegistrations: schemes.map((s) => ({ schemeId: s.id, schemeCode: s.code, registration: s.employerRegistration })),
  };
};

hrSettingRoutes.openapi(
  createRoute({
    method: "get", path: "/", tags: ["hr"],
    request: { params: CompanyParams },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], gate)],
    responses: { 200: { description: "The settings and every scheme's registration", content: { "application/json": { schema: HrSettingSchema } } } },
  }),
  async (c) => c.json(await c.var.withTenant((tx) => read(tx, c.req.valid("param").companyId)), 200),
);

hrSettingRoutes.openapi(
  createRoute({
    method: "put", path: "/", tags: ["hr"],
    request: { params: CompanyParams, headers: IdempotencyHeader, body: { content: { "application/json": { schema: UpdateHrSettingBody } } } },
    middleware: [requirePermission(PERMISSION["admin.company.manage"], gate)],
    responses: { 200: { description: "Stored", content: { "application/json": { schema: HrSettingSchema } } } },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const dto = await c.var.withTenant(async (tx) => {
      await upsertHrSetting(tx, { companyId, prorationRule: body.prorationRule, payDay: body.payDay });
      for (const r of body.employerRegistrations) await setEmployerRegistration(tx, r.schemeId, r.registration);
      return read(tx, companyId);
    });
    return c.json(dto, 200);
  },
);

export const hrSettingRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/hr-settings",
  router: hrSettingRoutes,
  permissions: [PERMISSION["admin.company.manage"]],
  auth: "human",
};
```

`apps/api/test/routes/hr/hr-settings.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";                      // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("GET|PUT /v1/companies/{companyId}/hr-settings (⚠️ OD-23)", () => {
  let f: HrFixture;
  beforeAll(async () => { f = await hrFixture(await startApi(), "hr-settings"); }, 240_000);
  afterAll(async () => { await f.api.stop(); });

  it("reads the §2.12 default before anything is stored, and lists every scheme unregistered", async () => {
    const res = await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer });
    expect(res.status).toBe(200);
    const dto = await res.json() as { prorationRule: string; payDay: number | null; employerRegistrations: { registration: string | null }[] };
    expect(dto.prorationRule).toBe("calendar_days");
    expect(dto.payDay).toBeNull();
    expect(dto.employerRegistrations.every((r) => r.registration === null)).toBe(true);
  });

  it("stores the rule, the pay day and one registration in a single PUT", async () => {
    const before = await (await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer })).json() as { employerRegistrations: { schemeId: string }[] };
    const schemeId = before.employerRegistrations[0]!.schemeId;
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer,
      body: { prorationRule: "working_days", payDay: 25, employerRegistrations: [{ schemeId, registration: "SYNTHETIC-REG-0001" }] } });
    expect(res.status).toBe(200);
    const dto = await res.json() as { prorationRule: string; payDay: number | null; employerRegistrations: { schemeId: string; registration: string | null }[] };
    expect(dto.prorationRule).toBe("working_days");
    expect(dto.payDay).toBe(25);
    expect(dto.employerRegistrations.find((r) => r.schemeId === schemeId)!.registration).toBe("SYNTHETIC-REG-0001");
  });

  it("a third proration rule is ERR_VALIDATION_FAILED at the Zod layer (spec:2086)", async () => {
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer,
      body: { prorationRule: "thirty_days", payDay: 25 } });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a pay day outside 1..31 is refused before it reaches the CHECK", async () => {
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer,
      body: { prorationRule: "calendar_days", payDay: 32 } });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a principal without admin.company.manage is refused on both verbs (§3.6.2)", async () => {
    expect((await f.api.request({ method: "GET", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.outsider })).status).toBe(403);
    const put = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.outsider,
      body: { prorationRule: "calendar_days", payDay: 1 } });
    expect(put.status).toBe(403);
  });

  it("PUT without Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "PUT", path: `/v1/companies/${f.companyId}/hr-settings`, as: f.officer,
      body: { prorationRule: "calendar_days", payDay: 1 }, idempotencyKey: null });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });
});
```

The `PROBES` entry seeds a setting for the owner tenant and has the attacker `PUT` it, expecting 404.

- [ ] **Step 5: Write the owner note**

`docs/owner/od-23-employer-registrations.md`:

```markdown
# OD-23 — employer registrations, the accountant's tables, and the pay conventions

**Decision needed from the owner and the owner's accountant.** Four separate things travel under
one id in the contracts document's ledger (§2.12); two of them block nothing in 8A and are listed
here so nobody hunts for them later.

## 1. Employer registration numbers — 8A (this task)

The company's registration number with each authority (EPF, SOCSO, EIS, LHDN). They are stored
**one per scheme**, on `app.statutory_scheme.employer_registration` — relational, because spec:2088
says these are "relational company settings supplied by the owner — never a blob".

Nothing refuses to run without them. The first place a missing one is visible is 8C's statutory
schedule and 8D's annual employer return, and both name the missing registration rather than
printing an empty box.

## 2. The current EPF / SOCSO / EIS / PCB tables, with worked examples — 8A (Task 9) and 8B

The tables themselves, signed off by the accountant, as
`packages/db/seed/my/statutory/<SCHEME>/vN.json` in the shape
`packages/domain/payroll/rate-table.schema.json` fixes: a `source` naming the authority, the
publication, its URL and the date read, and a `verification` block naming the signer.

**This repository contains no rate, threshold, ceiling or formula and will not until this arrives**
(spec:2080). Every test runs on a clearly synthetic table whose authority is literally
`"Dulja test fixture"`. The worked examples matter as much as the tables: 8B's golden fixtures are
built from the authorities' own published examples, and a table with no example to check it against
is a table nobody can prove.

## 3. The proration rule — 8A (this task) and 8B

`calendar_days` or `working_days`, for mid-month joiners and leavers and for unpaid days. spec:2086
calls this "configuration, never a statutory claim", so the accountant confirms the company's
practice rather than us reading a rule out of a statute. Default written into the plan:
`calendar_days`.

## 4. The staff list and the pay-period conventions — 8B and 8D

Who is on the payroll, and the pay period and pay date conventions. 8D's one-month parallel run
needs the real list; 8A needs none of it.
```

- [ ] **Step 6: Run to green and commit**

```bash
cd packages/db && bun run db:migrate && bun run db:lint && bun run test -- test/hr/company-hr-setting.test.ts
cd ../apps/api && bun run test -- test/routes/hr/hr-settings.test.ts
cd ../.. && bun run --cwd packages/contracts openapi:generate
bun run --cwd tests test -- invariants/tenant-isolation.test.ts
bun run lint && bun run lint:rules && bun run typecheck
```

Expected: 8 + 6 passing, `0 violations`, `lint:rules` silent.

```bash
git add packages/db/migrations/0085_create_company_hr_settings.sql packages/db/migrations/0085.down.sql \
        packages/db/src/hr/settings.ts packages/db/src/hr/index.ts packages/db/src/schema/company-hr-setting.ts \
        packages/db/test/hr/company-hr-setting.test.ts packages/contracts/src/hr/hr-setting.ts \
        packages/contracts/openapi.json apps/api/src/routes/hr/hr-settings.ts apps/api/src/routes/index.ts \
        apps/api/test/routes/hr/hr-settings.test.ts tests/invariants/probes.ts docs/owner/od-23-employer-registrations.md
git commit -m "$(cat <<'EOF'
feat(db): company HR settings, with registrations relational and no blob [8A T11]

Migration 0085 stores the proration rule (calendar_days | working_days -- CONFIGURATION, never a
statutory claim, spec:2086) and the pay day. §4.6.1's employer_registrations jsonb "display copy" is
deliberately NOT built (amendment A4): spec:2088 says these identifiers are relational company
settings and never a blob, they live one per scheme on statutory_scheme.employer_registration
(amendment A3), and a second store with no rebuild path is LEGACY-078 in miniature. ⚠️ OD-23: the
numbers are null until the owner supplies them and nothing in 8A refuses to run meanwhile; the
first consumers are 8C's schedule and 8D's employer return, which name a missing one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: ⚠️ OD-14 — the four HR facts, recorded, and exactly what each one adds

**Owner decision OD-14** (§2.12; spec:2093, Part VII #14). Four facts only the owner knows, each of which changes §3.10.1's scope by roughly one task. §2.12's default is **none of the four is built**, and this task's whole content is to *record* them and to write down precisely what changes — so the answer, whenever it arrives, does not restart a design conversation.

> **Owner provides:** answers to the four questions in `docs/owner/od-14-hr-facts.md` (OD-14, spec:2093, Part VII #14).
> **Verify:** `test -f docs/owner/od-14-hr-facts.md && grep -c "^> **Answer:**" docs/owner/od-14-hr-facts.md` prints `4`.
> **Until provided:** nothing is built. The four capabilities below are absent, and each is absent in a way that leaves a named seam rather than an assumption.

**Files:**
- Create: `docs/owner/od-14-hr-facts.md`
- Modify: nothing. **This task ships no code.**

- [ ] **Step 1: Write the four questions and their consequences**

`docs/owner/od-14-hr-facts.md`:

```markdown
# OD-14 — four HR facts only the owner knows

spec:2093 and Part VII #14. Each answer changes §3.10.1's scope by about one task. **The default
written into every Phase 8 plan is "no"**, and each "no" leaves a named seam rather than an
assumption.

---

## 1. Does HRD Corp — or any other employer levy — apply to this business?

> **Answer:** _(owner)_

**If yes.** One task in **8A**: a fifth row in `packages/db/seed/my/statutory/schemes.json` with its
code, and a `24nn` payable plus a `53nn` employer-expense account allocated **in contracts §4.15 by
8B** in the order the scheme is added — §4.15's own sentence, *"the next free `24nn` in the order the
scheme is added, allocated in this table by the slice that adds it"*. No migration: a scheme is a
row (spec:2080). The levy's rate table arrives under OD-23 like every other.

**If no.** Nothing. The four schemes `schemes.json` already carries are the whole set.

---

## 2. Are foreign workers employed?

> **Answer:** _(owner)_

**If yes.** Two things, both already seamed. `employee_sensitive.work_permit_expiry_enc` **exists
already** (migration 0081) — it is one of the nine fields spec:2076 names — so the *data* is there
whatever the answer; what a "yes" adds is **8D's `hr.contract_expiry` report** reading it, which is
already one of the five reports spec:2091 assigns 8D. Scheme applicability may differ for a foreign
worker, and that is a **rate-table** fact expressed in `required_profile_fields` and the
`employee_statutory_profile.extra` seam of Task 5 — not a code change.

**If no.** `work_permit_expiry` stays null for everyone and the expiry report has an empty section.

---

## 3. Is anyone hourly-paid or part-time?

> **Answer:** _(owner)_

**If yes.** One task in **8B**: an hours-based earning component and the calculator branch that
multiplies `compensation_line.quantity` by a rate. The **column and the flag already exist**:
`pay_component.quantity_based` (migration 0083, the unpaid-leave shape) and
`employee.employment_type` with `part_time` and `hourly` among its four values (migration 0080). What
is missing is only the calculation, and it is missing on purpose — spec:2093 puts "piecework and
production pay" and "overtime and public-holiday pay calculators" out of v1, and overtime is
"entered as an amount".

**If no.** `employment_type` records what the owner already knows and no calculator branches on it.

---

## 4. Do staff buy stock at the shops on salary deduction?

> **Answer:** _(owner)_

**If yes.** One task in **8C**, not 8A: the purchase is an `EMPLOYEE_ADVANCE`-shaped document and the
recovery is the existing `ADVANCE_RECOVERY` pay component, which
`packages/db/seed/my/statutory/pay-components.json` already ships. What a "yes" adds is the *link*
from a POS ticket paid by staff deduction to that advance — a `document_link` of kind `settles`
(§4.6.1, 3C's table) and one clause in 8C's money-out task.

**If no.** `ADVANCE_RECOVERY` stays what spec:2078 describes: the recovery of an advance the payroll
officer created, with no till path into it.

---

**None of the four is a rate, a threshold or a formula.** Those are OD-23's, and this repository
states none (spec:2080).
```

- [ ] **Step 2: Commit**

```bash
git add docs/owner/od-14-hr-facts.md
git commit -m "$(cat <<'EOF'
docs(owner): record OD-14's four HR facts and what each one adds [8A T12]

spec:2093 and Part VII #14: levy applicability, foreign workers, hourly/part-time staff, staff
purchases on salary deduction. The default is "no" for all four (§2.12), and each "no" leaves a
named seam rather than an assumption: work_permit_expiry_enc already exists, quantity_based and
employment_type already exist, ADVANCE_RECOVERY already ships. What a "yes" adds is written down
here so the answer does not restart a design conversation. No code in this commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ⚠️ OD-24 — the HR screens

**Owner decision OD-24** (§2.12; spec:79, 108, 2408, hazard 29). *"The UI is not specified. Every screen task begins with OD-24 — owner provides screenshots and a two-minute operator description — and targets keyboard parity; no plan invents a workflow."*

> **Owner provides:** screenshots of the legacy Salaries screens the payroll officer uses daily, and a two-minute description of how that officer actually works: what they open first, what they type, what they check before saving (OD-24, spec:79, 108).
> **Verify:** `test -d docs/owner/screens/hr && ls docs/owner/screens/hr | wc -l` prints a number greater than 0, and the operator description is attached to this task's pull request.
> **Until provided:** **this task is blocked; the slice is not.** Every other task in this plan ships, the API is complete and exercised by tests, and the back office simply has no HR screen. That is hazard 5's pattern applied to a screen: the slice never blocks on an owner input.

**When the screenshots arrive**, this task ships four screens in `apps/backoffice/src/screens/hr/`, each a thin client over routes that already exist and are already tested:

| Screen | Routes it drives | Notes fixed in advance |
|---|---|---|
| **Employee record** | `GET|POST /employees`, `GET|PUT …/{id}/sensitive`, `GET|POST …/{id}/statutory-profiles` | The sensitive panel is **a separate panel behind a separate fetch**, not a section of the record: a principal without `hr.employee.read_sensitive` gets a 403 the screen renders as "you do not have access to identity and bank details", never blank fields that look like missing data. |
| **Compensation** | `GET|POST …/{id}/compensation-lines` | Closed rows are shown greyed with their `effectiveTo`; the "new line" form pre-fills `effectiveFrom` with the first of next month, and the screen states that saving **closes** the current line rather than editing it (ADR 0072). |
| **Pay components** | `GET|POST|PATCH /pay-components`, `PUT …/{id}/schemes` | `kind` is a two-value radio, never a free select — spec:2079's two values, and a third is not addable in the UI because it is not addable at all. |
| **Statutory tables** | `GET /statutory-schemes`, `POST …/{id}/rate-tables`, `POST …/{id}/rate-tables/{v}/verify` | The verify button is **disabled with a reason** for the principal who loaded the table — the trigger refuses it anyway, and a UI that lets the click through and shows a 409 teaches the operator that the rule is arbitrary. The reason text names the rule: "verification requires a different principal". |

**Fixed regardless of the screenshots** (hazard 29, spec:2254): keyboard parity — every action reachable without a mouse; both text directions checked before merge (spec:106's Always list, test 23); `packages/i18n` catalogues for every string in `en` and `ar`; no HR string is hard-coded in a component.

**Files (when unblocked):**
- Create: `apps/backoffice/src/screens/hr/employee-record.tsx`, `compensation.tsx`, `pay-components.tsx`, `statutory-tables.tsx`, their four test files, `packages/i18n/src/en/hr.json`, `packages/i18n/src/ar/hr.json`
- Modify: `apps/backoffice/src/routes.tsx`, `tests/e2e/hr.spec.ts` (0E's `bootLocalStack` fixture, re-running test 23 for these four screens)

- [ ] **Step 1: Record the block**

Open the pull request with the title `⚠️ blocked on OD-24 — HR screens` and the body:

```
Blocked on OD-24 (spec:79, 108, 2408): screenshots of the legacy Salaries screens and a two-minute
operator description. Contracts hazard 29: "no plan invents a workflow."

Nothing else in 8A is blocked. The API is complete and covered:
  apps/api/test/routes/hr/{sensitive,statutory-profiles,compensation,pay-components,statutory-schemes,hr-settings}.test.ts
When the screenshots arrive, this task ships the four screens in the table of 8A Task 13 against
routes that already exist, and re-runs test 23 in both text directions for each.
```

- [ ] **Step 2: No commit until unblocked**

This task produces no source change while OD-24 is open. Task 14 records it as the one incomplete task of the slice, and 8D's screen task inherits the same block.

---

### Task 14: Slice exit — the six regression appends, the re-run matrix, and the 8B handoff

**Six `describe` blocks appended, none created.** §3.7.3's ownership rule: the first slice in execution order creates the file, every later slice appends a `describe("… — <slice id>", …)` block and never edits an earlier one. **All six of this slice's files were created by 0B** — 029, 030, 033 and 044 as thin files from the Plan 0A-proven list, 078 as one of 0B's sixteen full files, 045 as one of its six structural files.

**Files:**
- Modify: `tests/regression/legacy-029.test.ts`, `legacy-030.test.ts`, `legacy-033.test.ts`, `legacy-044.test.ts`, `legacy-045.test.ts`, `legacy-078.test.ts`, `tests/invariants/hr-sensitive-side-channels.test.ts` (Step 4's one appended case)
- Modify **only under the `7C-FIRST` branch of Step 3**: `packages/db/src/export/tables.ts` (three `EXPORT_TABLES` rows and the `NEVER_EXPORTED` narrowing — amendment **A20**)
- Create: `docs/handoff/8a-to-8b.md`

**Interfaces**

- Consumes: `sharedDb`, `thinRegression`, `sharedApi`, `fullRegression`, `problemOf`, `repoFile` (§4.17.1); `startApi`, `StartedApi` (§4.2.12); `hrFixture(api, name?)` (A6); `SENSITIVE_FIELDS` (Task 3); **under `7C-FIRST` only**, 7C's `EXPORT_TABLES`, `NEVER_EXPORTED` and `resolveExportGates` from `@dulja/db`; every produced interface of Tasks 1–11.
- Produces: six appended blocks and the handoff note. **No new source module.**

- [ ] **Step 1: What each block asserts**

| File | Part I heading | What 8A adds that no earlier block covers |
|---|---|---|
| `legacy-029` | *The audit trail records no actor and is a freely writable table* | Every one of this slice's seven tables writes an `audit_log` row with a **server-supplied** actor: insert one row into each under `withTenant(…, actorId)` and assert seven `audit_log` rows whose `actor_id` is that principal and none other. `employee_sensitive`'s before/after images are **ciphertext**, and the block asserts the plaintext is not in `after` — auditing a sensitive table is only safe because of that. |
| `legacy-030` | *A login parameter switches the audit trail off* | No flag, parameter, header or session setting suppresses an HR audit row: repeat one `PUT …/sensitive` with `?audit=false`, with an `X-Audit: off` header and with `set_config('app.audit', 'off', true)` set inside the transaction, and assert the row count rises by one each time. |
| `legacy-033` | *Confidentiality levels are a read-time display filter with a caller-supplied off switch* | The gate is an **RLS predicate on the actor's permission**, and there is no parameter that changes it: `sensitive_gate` and both `compensation_gate` policies are `RESTRICTIVE` in `pg_policies`; a direct `app_rw` select returns zero rows for a non-holder; and no route accepts a query parameter, header or body field whose name matches `/level|confidential|show.?all|include.?sensitive/i` (scanned over the committed `openapi.json`). |
| `legacy-044` | *Session records are caller-controlled and attributable to the wrong user* | Every `*_by` column this slice adds is stamped **from the session** and none of them is caller-supplied: supply a **different** principal id in each of `updated_by`, `entered_by`, `loaded_by` and `verified_by` on insert and assert the session's actor is stored instead; then attempt to change a non-null **write-once** one — `compensation_line.entered_by` — and assert `ERR_ACTOR_IMMUTABLE`. **`employee_sensitive.updated_by` is deliberately not in that second case**: it is the one always-stamp column (A19), and its own proof — that a second writer's id replaces the first's, and that a supplied one is overwritten — is Task 3's `updated_by names the LAST writer` case. And the one that matters most: the rate-table verifier is read from the **session**, so a caller cannot claim someone else verified their table. |
| `legacy-045` | *Department scoping is a report parameter, not an access control* | R4 in all four places, by **direct `app_rw` SQL** — the API cases live in the route suites and this block is the data-layer twin: a principal cannot write their own `employee.terminated_on`, `employee_sensitive`, `employee_statutory_profile` or `compensation_line` row, each raising `ERR_HR_SELF_PAY`. This is test 31's R4 clause in its filed form. |
| `legacy-078` | *Behaviour-governing configuration lives in opaque blobs* | Statutory rules are **version-controlled data with provenance**: a rate table's `definition` round-trips byte-equal through `jsonb`; an invalid one is refused with a **JSON Pointer** naming the path; `source` with all four members is required by the schema; the pack file is plain reviewable JSON on disk; and `pay_component_scheme` — not a boolean column — is where applicability lives (`information_schema` shows no `subject_to_*` column on `pay_component`). |

- [ ] **Step 2: Write the six blocks**

Each is `thinRegression` (or `fullRegression`, where a running API is needed) exactly as §4.17.1 shapes them, appended to the end of the existing file and touching no earlier block.

**The two `fullRegression` blocks build their own API and stop it.** `hrFixture(api, name?)` takes the
running API rather than starting one (A6), and these blocks must not hand it `ctx.api` — `fullRegression`'s
`api` is `sharedApi()`, memoised across every full regression file, and `f.api.stop()` in a `finally`
would stop it for every file that runs after. Each of `legacy-030.test.ts` and `legacy-033.test.ts` therefore
adds `import { startApi } from "../../apps/api/test/support/app";` beside its existing imports — the same
value import 0B's own `tests/invariants/tenant-isolation.test.ts` makes — and passes a distinct `name`,
so the two `legacy-033` cases do not seed one tenant name twice.

```ts
// tests/regression/legacy-029.test.ts — append
thinRegression("LEGACY-029", "The audit trail records no actor and is a freely writable table", ["8A T1", "8A T3", "8A T6", "8A T8"], (ctx) => {
  it("every 8A table writes an audit row whose actor is the SESSION's, not the caller's claim", async () => {
    const { db, a } = ctx;
    // `seedTenant` grants `s.human` NO permission at all (§4.1, pinned), and the three gated tables
    // below carry RESTRICTIVE policies with no `with check`, so their `using` predicate refuses the
    // WRITE as well as the read: without this grant every call in this block is refused with
    // SQLSTATE 42501 and the block fails for a reason that has nothing to do with auditing.
    // `sharedDb()` is ONE database shared by every thin regression file (§4.17.1), so the role code
    // is unique per block — `role` carries `unique (company_id, code)` and a shared code collides
    // with whichever other block happens to run first.
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"],
      principalId: a.human, roleCode: "legacy029-writer",
    });
    const before = await db.admin<{ n: string }[]>`select count(*)::text as n from app.audit_log where tenant_id = ${a.tenant}`;
    const employeeId = await seedEmployee(db, a, { employeeNumber: "E-LEGACY029" });
    const componentId = await seedPayComponent(db, a, { code: "LEGACY029", kind: "earning" });
    const schemeId = await seedStatutoryScheme(db, a, { code: "LEGACY029" });
    await seedRateTable(db, a, { schemeId });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await writeSensitive(tx, RING, employeeId, { national_id: "SYNTHETIC-ID-029" });
      await openStatutoryProfile(tx, employeeId, { effectiveFrom: "2026-01-01", maritalStatus: "single", spouseWorking: null, childReliefCount: 0, residencyCategory: null, extra: {} });
      await openCompensation(tx, { employeeId, componentId, effectiveFrom: "2026-01-01", amount: Money.of("1000.0000", currency("MYR")), quantity: null });
      await upsertHrSetting(tx, { companyId: a.company, prorationRule: "calendar_days", payDay: 25 });
    });
    const rows = await db.admin<{ table_name: string; actor_id: string }[]>`
      select distinct table_name, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name in
             ('employee', 'employee_sensitive', 'employee_statutory_profile', 'pay_component',
              'compensation_line', 'statutory_scheme', 'statutory_rate_table', 'company_hr_setting')`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      "company_hr_setting", "compensation_line", "employee", "employee_sensitive",
      "employee_statutory_profile", "pay_component", "statutory_rate_table", "statutory_scheme"]);
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set([a.human]));
    expect(Number((await db.admin<{ n: string }[]>`select count(*)::text as n from app.audit_log where tenant_id = ${a.tenant}`)[0]!.n))
      .toBeGreaterThan(Number(before[0]!.n));
  });

  it("the sensitive table's before/after images are CIPHERTEXT — auditing it is safe because of that", async () => {
    const { db, a } = ctx;
    const rows = await db.admin<{ after: Record<string, unknown> }[]>`
      select after from app.audit_log where tenant_id = ${a.tenant} and table_name = 'employee_sensitive'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.stringify(r.after)).not.toContain("SYNTHETIC-ID-029");
  });
});
```

```ts
// tests/regression/legacy-030.test.ts — append
fullRegression("LEGACY-030", "A login parameter switches the audit trail off", ["8A T3", "8A T4"], (ctx) => {
  const count = async (api: StartedApi, tenant: string): Promise<number> =>
    Number((await api.db.admin<{ n: string }[]>`
      select count(*)::text as n from app.audit_log where tenant_id = ${tenant} and table_name = 'employee_sensitive'`)[0]!.n);

  it("no query parameter, header or session setting suppresses an HR audit row", async () => {
    const f = await hrFixture(await startApi(), "legacy-030");
    try {
      const target = f.employees[0]!.id;
      const path = `/v1/companies/${f.companyId}/employees/${target}/sensitive`;
      const attempts: { label: string; run: () => Promise<unknown> }[] = [
        { label: "plain", run: () => f.api.request({ method: "PUT", path, as: f.officer, body: { passport: "SYNTHETIC-PP-1" } }) },
        { label: "query parameter", run: () => f.api.request({ method: "PUT", path: `${path}?audit=false`, as: f.officer, body: { passport: "SYNTHETIC-PP-2" } }) },
        { label: "header", run: () => f.api.request({ method: "PUT", path, as: f.officer, body: { passport: "SYNTHETIC-PP-3" }, headers: { "X-Audit": "off" } }) },
        { label: "set_config inside the transaction", run: () => withTenant(f.db.rw, { tenantId: f.seed.tenant, actorId: f.officer, requestId: "00000000-0000-7000-8000-0000000dd001" }, async (tx) => {
            await tx`select set_config('app.audit', 'off', true)`;
            await writeSensitive(tx, RING, target, { passport: "SYNTHETIC-PP-4" });
          }) },
      ];
      for (const attempt of attempts) {
        const before = await count(f.api, f.seed.tenant);
        await attempt.run();
        expect(await count(f.api, f.seed.tenant), `${attempt.label} suppressed an audit row`).toBe(before + 1);
      }
    } finally { await f.api.stop(); }
  });
});
```

```ts
// tests/regression/legacy-033.test.ts — append
fullRegression("LEGACY-033", "Confidentiality levels are a read-time display filter with a caller-supplied off switch", ["8A T3", "8A T4", "8A T5", "8A T6"], () => {
  it("all three gates are RESTRICTIVE policies, not display filters", async () => {
    const f = await hrFixture(await startApi(), "legacy-033-a");
    try {
      const rows = await f.db.admin<{ tablename: string; policyname: string; permissive: string }[]>`
        select tablename, policyname, permissive from pg_policies
         where schemaname = 'app' and policyname in ('sensitive_gate', 'compensation_gate') order by 1`;
      expect(rows.map((r) => [r.tablename, r.policyname, r.permissive])).toEqual([
        ["compensation_line", "compensation_gate", "RESTRICTIVE"],
        ["employee_sensitive", "sensitive_gate", "RESTRICTIVE"],
        ["employee_statutory_profile", "compensation_gate", "RESTRICTIVE"],
      ]);
    } finally { await f.api.stop(); }
  });

  it("there is NO off switch: no route declares a parameter that could widen a gate", () => {
    const doc = JSON.parse(repoFile("packages/contracts/openapi.json")) as {
      paths: Record<string, Record<string, { parameters?: { name: string }[]; requestBody?: unknown }>> };
    const OFF_SWITCH = /level|confidential|show_?all|showAll|include_?sensitive|includeSensitive|unmask/i;
    const names = Object.values(doc.paths).flatMap((ops) => Object.values(ops)).flatMap((op) => op.parameters ?? []).map((p) => p.name);
    expect(names.filter((n) => OFF_SWITCH.test(n))).toEqual([]);
    expect(JSON.stringify(doc).match(OFF_SWITCH)).toBeNull();
  });

  it("a non-holder gets zero rows from all three tables by direct app_rw SQL", async () => {
    const f = await hrFixture(await startApi(), "legacy-033-b");
    try {
      const ctx = { tenantId: f.seed.tenant, actorId: f.outsider, requestId: "00000000-0000-7000-8000-0000000dd033" };
      // Three literal queries, never a table name interpolated into SQL text. postgres.js would accept
      // tx("employee_sensitive") as an identifier, but `no-sql-concat` (§3.7.2) and a human reviewer both
      // read app.${...} as built SQL, and hazard 21 makes that a review-blocking finding on sight.
      const counts = await withTenant(f.db.rw, ctx, async (tx) => ({
        employee_sensitive: (await tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`)[0]!.n,
        employee_statutory_profile: (await tx<{ n: string }[]>`select count(*)::text as n from app.employee_statutory_profile`)[0]!.n,
        compensation_line: (await tx<{ n: string }[]>`select count(*)::text as n from app.compensation_line`)[0]!.n,
      }));
      expect(counts).toEqual({ employee_sensitive: "0", employee_statutory_profile: "0", compensation_line: "0" });
    } finally { await f.api.stop(); }
  });
});
```

```ts
// tests/regression/legacy-044.test.ts — append
thinRegression("LEGACY-044", "Session records are caller-controlled and attributable to the wrong user", ["8A T3", "8A T5", "8A T6", "8A T8"], (ctx) => {
  it("every *_by column 8A adds is stamped from the session, whatever the caller sends", async () => {
    const { db, a } = ctx;
    // The same reason as legacy-029's: three of the four inserts below are into gate-protected tables
    // and `seedTenant` grants `a.human` nothing (§4.1). Distinct role code — one shared database.
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"],
      principalId: a.human, roleCode: "legacy044-writer",
    });
    const impostor = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${impostor}, ${`sub-${impostor}`}, 'human', 'Impostor')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${impostor})`;
    });
    const employeeId = await seedEmployee(db, a, { employeeNumber: "E-LEGACY044" });
    const componentId = await seedPayComponent(db, a, { code: "LEGACY044", kind: "earning" });
    const schemeId = await seedStatutoryScheme(db, a, { code: "LEGACY044" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.employee_sensitive (employee_id, tenant_id, key_version, updated_by)
               values (${employeeId}, ${a.tenant}, 1, ${impostor})`;
      await tx`insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, entered_by)
               values (${a.tenant}, ${employeeId}, '2026-01-01', ${impostor})`;
      await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, entered_by)
               values (${a.tenant}, ${employeeId}, ${componentId}, '2026-01-01', 1000.0000, ${impostor})`;
      await tx`insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, definition, source, loaded_by)
               values (${a.tenant}, ${schemeId}, 1, '2026-01-01', '{}'::jsonb, 'synthetic', ${impostor})`;
    });
    const [s] = await db.admin<{ updated_by: string }[]>`select updated_by from app.employee_sensitive where employee_id = ${employeeId}`;
    const [p] = await db.admin<{ entered_by: string }[]>`select entered_by from app.employee_statutory_profile where employee_id = ${employeeId}`;
    const [c] = await db.admin<{ entered_by: string }[]>`select entered_by from app.compensation_line where employee_id = ${employeeId}`;
    const [t] = await db.admin<{ loaded_by: string }[]>`select loaded_by from app.statutory_rate_table where scheme_id = ${schemeId}`;
    for (const got of [s!.updated_by, p!.entered_by, c!.entered_by, t!.loaded_by]) {
      expect(got).toBe(a.human);
      expect(got).not.toBe(impostor);
    }
  });

  it("a stamped column cannot be changed afterwards (ERR_ACTOR_IMMUTABLE)", async () => {
    const { db, a } = ctx;
    const [row] = await db.admin<{ id: string }[]>`select id from app.compensation_line order by created_at desc limit 1`;
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      update app.compensation_line set entered_by = ${a.system} where id = ${row!.id}`))
      .rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
  });

  it("the rate-table VERIFIER is read from the session, so nobody can claim another principal signed", async () => {
    const { db, a } = ctx;
    const schemeId = await seedStatutoryScheme(db, a, { code: "LEGACY044B" });
    const id = await seedRateTable(db, a, { schemeId });
    await withTenant(db.rw, a.tenant, a.system, (tx) => tx`
      update app.statutory_rate_table set verified_at = now(), verified_by = ${a.human} where id = ${id}`);
    const [row] = await db.admin<{ verified_by: string }[]>`select verified_by from app.statutory_rate_table where id = ${id}`;
    expect(row!.verified_by).toBe(a.system);      // the SESSION's actor, not the claimed one
  });
});
```

```ts
// tests/regression/legacy-045.test.ts — append
thinRegression("LEGACY-045", "Department scoping is a report parameter, not an access control", ["8A T1", "8A T3", "8A T5", "8A T6"], (ctx) => {
  it("R4: a principal cannot write their own HR rows by direct app_rw SQL (spec:2175, test 31)", async () => {
    const { db, a } = ctx;
    const self = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${self}, ${`sub-${self}`}, 'human', 'Self')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${self})`;
    });
    // The three 8A gate codes and no more. `hr.employee.manage` was in an earlier draft and is
    // dropped: it is 6C's catalogue row and may be absent under `8A-FIRST` (grantCodes would raise a
    // foreign-key error), and the `employee.terminated_on` attempt below needs no permission at all —
    // `app.employee` carries `tenant_isolation` and, under 6C, `branch_isolation`, but no permission
    // gate, which is why Task 1's own R4 case makes the same update with a membership-only principal.
    await grantCodes(db, a, { codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"], principalId: self, roleCode: "legacy045-self" });
    const mine = await seedEmployee(db, a, { employeeNumber: "E-LEGACY045", principalId: self });
    const componentId = await seedPayComponent(db, a, { code: "LEGACY045", kind: "earning" });

    const attempts: [string, () => Promise<unknown>][] = [
      ["employee.terminated_on", () => withTenant(db.rw, a.tenant, self, (tx) => tx`
        update app.employee set terminated_on = '2026-12-31' where id = ${mine}`)],
      ["employee_sensitive", () => withTenant(db.rw, a.tenant, self, (tx) =>
        writeSensitive(tx, RING, mine, { bank_account: "SYNTHETIC-ACC-SELF" }))],
      ["employee_statutory_profile", () => withTenant(db.rw, a.tenant, self, (tx) =>
        openStatutoryProfile(tx, mine, { effectiveFrom: "2026-01-01", maritalStatus: "married", spouseWorking: false, childReliefCount: 9, residencyCategory: null, extra: {} }))],
      ["compensation_line", () => withTenant(db.rw, a.tenant, self, (tx) =>
        openCompensation(tx, { employeeId: mine, componentId, effectiveFrom: "2026-01-01", amount: Money.of("99999.0000", currency("MYR")), quantity: null }))],
    ];
    for (const [label, run] of attempts) {
      await expect(run(), `${label} admitted a self-write`).rejects.toThrow(/ERR_HR_SELF_PAY/);
    }
  });

  it("and another principal may write all four — the rule is about SELF, not about the table", async () => {
    const { db, a } = ctx;
    // `a.human` needs the gate codes too. The case above granted them to `self`; this one asserts a
    // SUCCESS, so a missing grant here would look exactly like R4 firing on the wrong principal.
    await grantCodes(db, a, {
      codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"],
      principalId: a.human, roleCode: "legacy045-other",
    });
    const [row] = await db.admin<{ id: string }[]>`select id from app.employee where employee_number = 'E-LEGACY045'`;
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) =>
      writeSensitive(tx, RING, row!.id, { bank_account: "SYNTHETIC-ACC-OTHER" }))).resolves.toBeUndefined();
  });
});
```

```ts
// tests/regression/legacy-078.test.ts — append
thinRegression("LEGACY-078", "Behaviour-governing configuration lives in opaque blobs", ["8A T6", "8A T8", "8A T9"], (ctx) => {
  it("a rate table's definition round-trips through jsonb byte-equal", async () => {
    const { db, a } = ctx;
    const schemeId = await seedStatutoryScheme(db, a, { code: "LEGACY078" });
    const id = await seedRateTable(db, a, { schemeId });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ definition: unknown }[]>`select definition from app.statutory_rate_table where id = ${id}`);
    expect(row!.definition).toEqual(JSON.parse(JSON.stringify(SYNTH_RATE_TABLE_V1)));
  });

  it("an invalid definition is refused NAMING THE JSON PATH, not swallowed", () => {
    const bad = { ...SYNTH_RATE_TABLE_V1, table: { bands: [{ from: 0, to: 1000, employee: 10, employer: 20 }] } };
    const v = validateRateTable(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toContain("/table/bands/0/from");
  });

  it("a table with no provenance cannot be stored — `source` is required with all four members", () => {
    const { source, ...noSource } = SYNTH_RATE_TABLE_V1 as Record<string, unknown> & { source: unknown };
    expect(source).toBeTruthy();
    expect(validateRateTable(noSource).ok).toBe(false);
  });

  it("the pack is reviewable text on disk, not a blob in a column", () => {
    const schemes = JSON.parse(repoFile("packages/db/seed/my/statutory/schemes.json")) as { code: string }[];
    expect(schemes.map((s) => s.code).sort()).toEqual(["EIS", "EPF", "PCB", "SOCSO"]);
    const components = JSON.parse(repoFile("packages/db/seed/my/statutory/pay-components.json")) as { code: string; kind: string }[];
    expect(components).toHaveLength(6);
    expect(new Set(components.map((c) => c.kind))).toEqual(new Set(["earning", "deduction"]));
  });

  it("applicability is a JOIN TABLE, not a boolean column (RC-3, spec:2078)", async () => {
    const { db } = ctx;
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'pay_component'`;
    expect(cols.map((c) => c.column_name).filter((n) => /^subject_|_epf$|_socso$|_eis$|_pcb$/.test(n))).toEqual([]);
    const join = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'app' and table_name = 'pay_component_scheme'`;
    expect(join).toHaveLength(1);
  });
});
```

**`RING`** in the four data-layer blocks is one module-level const per file, `createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 })` — the same ring `packages/db/test/hr/sensitive.test.ts` uses, because a regression file that minted its own key would be testing a different envelope from the one that ships.

**Each block appends its own imports to the head of the file it joins** and adds no import an earlier block already has: `grantCodes`, `seedEmployee`, `seedPayComponent`, `seedStatutoryScheme`, `seedRateTable`, `SYNTH_RATE_TABLE_V1` and `uuidv7` from `@dulja/db/test`; `writeSensitive`, `openStatutoryProfile`, `openCompensation`, `upsertHrSetting`, `createHrKeyRing`, `DEV_HR_KEY` and the production `withTenant` from `@dulja/db`; `Money` and `currency` from `@dulja/domain`; `validateRateTable` from `@dulja/domain/payroll`; `repoFile` from `../support/regression`; `hrFixture` from `../invariants/support/hr` in the two `fullRegression` blocks.

**Every block that writes a gated table grants first, with a role code of its own.** `sharedDb()` hands all six thin files ONE database and two `Seed`s (§4.17.1), and §4.1 pins that `seedTenant` grants `s.human` no permission at all — no `role`, no `role_permission`, no `role_assignment`. `sensitive_gate` and both `compensation_gate` policies are `AS RESTRICTIVE` with no `with check`, so their predicate gates writes as well as reads and an ungranted `a.human` is refused with SQLSTATE 42501 on every one of these inserts. File execution order is not fixed, so a block may not rely on another's grant; and because `app.role` carries `unique (company_id, code)`, two blocks reaching for one role code collide. Hence `legacy029-writer`, `legacy044-writer`, `legacy045-self` and `legacy045-other` — four codes, one per grant, none shared.

- [ ] **Step 3: Close test 32's export channel — three `EXPORT_TABLES` rows behind the 7C branch (amendment A20)**

**Decide the branch first, from the repository and not from memory.** 7C owns `packages/db/src/export/`;
§6.3 (contracts:4025) runs 8A on its own branch from 4B, parallel to `7A - 7B - 7C (needs 6D)`, so the
module is present in some orderings and absent in others. This is the same shape Task 0 Step 3 uses for
migration 0064:

```bash
cd "$REPO"
ls packages/db/src/export/tables.ts 2>/dev/null \
  && echo "7C-FIRST: add the three EXPORT_TABLES rows below" \
  || echo "8A-FIRST: add nothing; the three tables are absent from the registry, which is the safe default"
```

Write the answer into this task's pull-request description as `7C branch: 7C-FIRST` or `7C branch: 8A-FIRST`.

**Under `8A-FIRST` this step writes no source.** A table the registry does not name is never exported —
7C's `runExport` iterates `EXPORT_TABLES` and nothing else — so test 32's export clause is already true,
and the case in Step 4 skips itself. The three rows go into Step 5's handoff note instead, so whichever
of 7C and 8D runs after both has them written out rather than re-derived.

**Under `7C-FIRST`, `packages/db/src/export/tables.ts` gains exactly this and nothing else.** 7C's design
promises that a slice adding a sensitive table "adds one `EXPORT_TABLES` row with its gate and changes
nothing in the exporter" (7c:3789); this step keeps that promise for three tables.

```ts
// packages/db/src/export/tables.ts — inside NEVER_EXPORTED: employee_sensitive is NARROWED, not unpinned.
// 7C pinned the whole table with ["*"] before it existed ("8A's table; pinned now so the row exists
// before it does", 7c:3356). A REGISTERED table may not carry "*" — 7c:3251 asserts exactly that — so
// the pin becomes the nine ciphertext columns by name. Nothing is unpinned: the columns that carry the
// secrets are precisely the columns still refused, and the row below exports none of them. Replace the
// one line `employee_sensitive: ["*"],` with:
  employee_sensitive: [
    "national_id_enc", "passport_enc", "date_of_birth_enc", "residency_category_enc",
    "bank_account_enc", "epf_number_enc", "socso_number_enc", "tax_number_enc",
    "work_permit_expiry_enc",
  ],
```

```ts
// packages/db/src/export/tables.ts — three rows appended to EXPORT_TABLES, in the `t(name, gate,
// columns, rows)` shape every existing row uses, placed after the `attachment` row and before the
// gated `audit_log` row. None of the three tables carries a company_id of its own — that is the whole
// reason sensitive_gate joins app.employee (spec:2076) — so each query joins app.employee for the
// scope, exactly as 7C's own dimension_value row joins dimension_type.

  // ── HR (8A) — every row gated, and the ciphertext never leaves ───────────────────────────────────
  t("employee_sensitive", "hr.employee.read_sensitive",
    ["employee_id", "key_version", "updated_by", "updated_at", "created_at"],
    (tx, c) => tx`select es.employee_id, es.key_version, es.updated_by,
      to_char(es.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
      to_char(es.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.employee_sensitive es join app.employee e on e.id = es.employee_id
      where e.company_id = ${c} order by es.employee_id`),
  t("compensation_line", "hr.compensation.read",
    ["id", "employee_id", "component_id", "effective_from", "effective_to", "amount", "quantity",
     "entered_by", "created_at"],
    (tx, c) => tx`select cl.id, cl.employee_id, cl.component_id,
      to_char(cl.effective_from,'YYYY-MM-DD') as effective_from,
      to_char(cl.effective_to,'YYYY-MM-DD') as effective_to,
      cl.amount::text as amount, cl.quantity::text as quantity, cl.entered_by,
      to_char(cl.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.compensation_line cl join app.employee e on e.id = cl.employee_id
      where e.company_id = ${c} order by cl.employee_id, cl.component_id, cl.effective_from`),
  t("employee_statutory_profile", "hr.compensation.read",
    ["id", "employee_id", "effective_from", "effective_to", "marital_status", "spouse_working",
     "child_relief_count", "residency_category", "extra", "entered_by", "created_at"],
    (tx, c) => tx`select p.id, p.employee_id,
      to_char(p.effective_from,'YYYY-MM-DD') as effective_from,
      to_char(p.effective_to,'YYYY-MM-DD') as effective_to,
      p.marital_status, p.spouse_working, p.child_relief_count, p.residency_category,
      p.extra::text as extra, p.entered_by,
      to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from app.employee_statutory_profile p join app.employee e on e.id = p.employee_id
      where e.company_id = ${c} order by p.employee_id, p.effective_from`),
```

**`employee_sensitive`'s columns are metadata only, and that is a decision rather than an omission.** The
nine `*_enc` columns are ciphertext under a key the archive does not contain, so exporting them would hand
a recipient bytes nobody can read while widening the blast radius of a leaked key — and `NEVER_EXPORTED`
above refuses them by name in the same file, which is what makes it a rule and not an intention. What does
leave, for a holder of `hr.employee.read_sensitive`, is that a row exists, which key version it is at and
who last touched it — what a tenant needs to reconcile its own data, and nothing more. The plaintext leaves
through `GET …/sensitive`, gated by the same code.

- [ ] **Step 4: Append the export case to `tests/invariants/hr-sensitive-side-channels.test.ts`**

The fifth channel of test 32, in the file that owns test 32's non-route half. It is appended here rather
than written in Task 4 because `employee_statutory_profile` and `compensation_line` do not exist until
migrations 0082 and 0083, and because the branch above cannot be decided before every 8A table is in place.

```ts
// tests/invariants/hr-sensitive-side-channels.test.ts — TWO module-level lines, added beside the
// existing imports (never inside the describe: `it.skipIf` is evaluated at COLLECTION time, and a
// describe callback is synchronous).
import * as db from "@dulja/db";                       // the namespace form; see SEVEN_C below
// and `SENSITIVE_FIELDS` — the nine COLUMN stems, 0081's own list — joins the file's existing
// `import { withTenant } from "@dulja/db";` line, so the nine names still have one definition.

/** The 7C branch as a repository fact, exactly as `SIX_C` is the 6C branch in the route suite. A static
 *  named import of `EXPORT_TABLES` would fail to typecheck under 8A-FIRST and take the whole file with
 *  it; a namespace import always resolves, because `@dulja/db` exists either way, and the missing key IS
 *  the absence of 7C. `runExport` and the registry are re-exported from the main barrel by 7C's own
 *  Task 5 (7c:2471), which is the import every 7C test already uses. */
const SEVEN_C = "EXPORT_TABLES" in db;
```

```ts
// tests/invariants/hr-sensitive-side-channels.test.ts — appended as the last case inside the existing
// describe("test 32 — sensitive fields have no side channel").

it.skipIf(!SEVEN_C)("the export archive carries none of the three gated tables for a non-holder, and NAMES all three", async () => {
  const { EXPORT_TABLES, NEVER_EXPORTED, resolveExportGates } = db as unknown as typeof import("@dulja/db") & {
    EXPORT_TABLES: readonly { name: string; gate: string | null; columns: readonly string[] }[];
    NEVER_EXPORTED: Readonly<Record<string, readonly string[]>>;
    resolveExportGates: (tx: never, i: { principalId: string; companyId: string }) =>
      Promise<{ included: readonly { name: string }[]; excluded: readonly { table: string; gate: string }[] }>;
  };
  // (a) the registry says what Step 3 wrote: three rows, three gates, and no "*" pin left on a
  //     REGISTERED table — the invariant 7C asserts of its own rows, re-asserted over 8A's three.
  const byName = new Map(EXPORT_TABLES.map((t) => [t.name, t]));
  expect(byName.get("employee_sensitive")?.gate).toBe("hr.employee.read_sensitive");
  expect(byName.get("compensation_line")?.gate).toBe("hr.compensation.read");
  expect(byName.get("employee_statutory_profile")?.gate).toBe("hr.compensation.read");
  for (const name of ["employee_sensitive", "compensation_line", "employee_statutory_profile"]) {
    const forbidden = NEVER_EXPORTED[name] ?? [];
    expect(forbidden, name).not.toContain("*");
    for (const col of byName.get(name)!.columns) expect(forbidden, `${name}.${col}`).not.toContain(col);
  }
  // no ciphertext column is exportable, whatever the row says — the nine names come from the ONE list
  // the contracts module already exports, so a tenth sensitive field cannot be forgotten here.
  for (const enc of SENSITIVE_FIELDS.map((c) => `${c}_enc`)) {
    expect(NEVER_EXPORTED["employee_sensitive"], enc).toContain(enc);
    expect(byName.get("employee_sensitive")!.columns, enc).not.toContain(enc);
  }
  // (b) a principal holding NEITHER code: all three ABSENT and all three NAMED — never silently missing
  //     from both lists. This is the case 7C's Task 10 calls "the shape 8A plugs into" (7c:5194).
  const ctx = { tenantId: f.seed.tenant, actorId: f.outsider, requestId: "00000000-0000-7000-8000-00000000ab03" };
  const { included, excluded } = await withTenant(f.db.rw, ctx, (tx) =>
    resolveExportGates(tx as never, { principalId: f.outsider, companyId: f.companyId }));
  for (const [name, gate] of [
    ["employee_sensitive", "hr.employee.read_sensitive"],
    ["compensation_line", "hr.compensation.read"],
    ["employee_statutory_profile", "hr.compensation.read"],
  ] as const) {
    expect(included.map((t) => t.name), name).not.toContain(name);
    expect(excluded, name).toContainEqual({ table: name, gate });
  }
  // (c) and the officer, who holds both codes, DOES get all three: the gate is a predicate, not a
  //     permanent exclusion — the same thing the direct-SQL case above proves for one table.
  const officerCtx = { tenantId: f.seed.tenant, actorId: f.officer, requestId: "00000000-0000-7000-8000-00000000ab04" };
  const forOfficer = await withTenant(f.db.rw, officerCtx, (tx) =>
    resolveExportGates(tx as never, { principalId: f.officer, companyId: f.companyId }));
  expect(forOfficer.included.map((t) => t.name)).toEqual(expect.arrayContaining(
    ["employee_sensitive", "compensation_line", "employee_statutory_profile"]));
});
```

`SENSITIVE_FIELDS` is Task 3's own list of the nine column stems (`packages/db/src/hr/sensitive.ts`,
re-exported on the `@dulja/db` barrel) — the same list `writeSensitive` iterates. Using it rather than
retyping nine names is what makes a tenth sensitive field impossible to forget here: it would appear in
the loop the day migration adds it.

**Run it both ways before moving on.**

```bash
bun run --cwd tests test -- invariants/hr-sensitive-side-channels.test.ts
# 7C-FIRST only — 7C's own two export suites must stay green, unedited:
bun run --cwd packages/db test -- export/tables
bun run --cwd apps/api test -- test/routes/admin/exports-gates.test.ts
bun run lint && bun run lint:rules && bun run typecheck
```

**Why 7C's `exports-gates` suite is re-run and not merely assumed.** Its case *"no `NEVER_EXPORTED`
column appears in any archive the exporter can produce"* asserts that `terminal_enrolment`,
`idempotency_key` **and `employee_sensitive`** have no `tables/<name>.csv` in the archive at all
(7c:5107). After this step `employee_sensitive` is no longer pinned whole — it is a *gated* registry
row — so that assertion now holds for a different reason: 7C's `exporter` principal is granted exactly
`admin.data.export` and `accounting.ledger.read` (7c:5234) and does **not** hold
`hr.employee.read_sensitive`, so the table is gated out of its archive and the file is still absent.
The assertion stays true and 7C's file is not edited. **If a later slice ever widens that principal's
grant, that case is where it will be caught** — which is the right place for it to be caught.

Expected under **`7C-FIRST`**: 5 passing in the invariant file — the four Task 4 cases plus this one —
and 7C's `export/tables` suite still green, its "no registered column is in `NEVER_EXPORTED`" case now
covering three more tables. That case staying green is the whole point of *narrowing* the pin rather than
deleting it. Expected under **`8A-FIRST`**: 4 passing and **1 skipped**, nothing under
`packages/db/src/export/` touched, and the three rows recorded in Step 5's handoff note. A
`"*" is not allowed` failure from 7C's suite means the `NEVER_EXPORTED` narrowing was skipped; a
`resolveExportGates` failure naming a gate means a code is spelled differently here and in Task 2 Step 2.

- [ ] **Step 5: Write the re-run matrix and check it**

| Test | Clause 8A re-runs | Where | Command |
|---|---|---|---|
| **12** Tenant isolation | seven new tables; three new route modules; one new job | `packages/db/test/hr/*.test.ts` (a two-tenant case each), `tests/invariants/tenant-isolation.test.ts` | `bun run --cwd tests test -- invariants/tenant-isolation.test.ts` |
| **13** Audit completeness | every HR write audited, chain verifies | `tests/regression/legacy-029.test.ts`, `tests/invariants/audit-chain.test.ts` | `bun run --cwd tests test -- invariants/audit-chain.test.ts` |
| **31** Segregation of duties | the **R4 clause** — "a principal cannot alter their own compensation, sensitive data or leave approval" (the leave half is 8D's ⚠️) | `tests/regression/legacy-045.test.ts` (SQL), `apps/api/test/routes/hr/{sensitive,compensation}.test.ts` (API) | `bun run --cwd tests test -- regression/legacy-045.test.ts` |
| **32** Sensitive fields have no side channel | **owned** — all five channels | `apps/api/test/routes/hr/sensitive.test.ts`, `tests/invariants/hr-sensitive-side-channels.test.ts` | `bun run --cwd tests test -- invariants/hr-sensitive-side-channels.test.ts` |
| **35** YTD rebuild and recalculation | the **verify-not-load clause** — "a rate table can be verified only by a principal other than the one who loaded it"; 8C owns the other two clauses | `packages/db/test/hr/statutory.test.ts`, `apps/api/test/routes/hr/statutory-schemes.test.ts` | `bun run --cwd packages/db test -- test/hr/statutory.test.ts` |
| **36** Role catalogue integrity | the six new codes are each evaluated by a handler and each held by the right seeded role | `packages/db/test/permission-catalogue.test.ts`, `bun run lint:rules` | `bun run lint:rules` |
| **27** No SQL text across the API | every new query is a tagged template; the one `format(%I)` is in a migration on a `TG_ARGV` literal | `scripts/lint/rules/no-sql-concat.ts` in CI | `bun run lint:rules` |

```bash
bun run --cwd packages/db test
bun run --cwd packages/domain test
bun run --cwd apps/api test
bun run --cwd apps/worker test
bun run --cwd tests test
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck
bun run --cwd packages/db db:lint
```

Expected: everything green, `0 violations`, `lint:rules` silent, and the migration reversibility test (§3.4.6) green — which is what proves the seven down files are complete.

- [ ] **Step 6: Write the handoff note**

`docs/handoff/8a-to-8b.md`:

```markdown
# 8A → 8B — what the payroll engine can rely on

**Tables.** `employee` (extended), `employee_sensitive`, `employee_statutory_profile`,
`pay_component`, `pay_component_scheme`, `compensation_line`, `statutory_scheme`,
`statutory_rate_table`, `company_hr_setting`. Migrations 0080–0086 applied; the linter reports zero
violations.

**The four reads 8B's `EmployeePeriodInput` (§4.12.1) is built from**, all in `@dulja/db`:

- `profileOn(tx, employeeId, date)` → `StatutoryProfile | null` — the effective-dated inputs.
- `compensationOn(tx, employeeId, date)` → `CompensationLine[]` — `Money` and `Quantity`, never a number.
- `listPayComponents(tx, companyId)` → `PayComponent[]` with `schemeIds` already joined.
- `rateTableOn(tx, schemeId, date)` → `RateTableRow | null` — **verified tables only**. A null is
  what `ERR_PAYROLL_RATE_TABLE_UNVERIFIED` (test 29) is raised on; 8B does not re-check
  `verified_at` itself, and must not, or two places would decide one rule.

**The type.** `import type { RateTable } from "@dulja/domain/payroll"` — generated from
`rate-table.schema.json` and committed, with a drift guard. `parseRateTable` throws with JSON
Pointers. `packages/domain/src/**` may not import it (spec:2366) and the `dependency-rule` lint says so.

**Four things 8B must do that 8A deliberately did not.**

1. **Seed the accounts and wire them.** `pay_component.expense_account_id`,
   `pay_component.payable_account_id`, `statutory_scheme.payable_account_id` and
   `employer_expense_account_id` are **null**. 8B's `chart-of-accounts/8b-payroll.json` seeds
   `5300`, `2400`, `1400`, `2411`–`2414` and `5311`–`5314` (§4.15) and the same task sets these four
   columns from those codes. Until it does, the `PAYROLL` policy fails closed with
   `ERR_POLICY_REQUIRES_MISSING`, which is the correct failure and not a bug.
2. **Decide applicability.** `pay_component_scheme` is **empty**. Which components a scheme applies
   to is a statutory claim and arrives with OD-23 in the same pull request as the rate tables.
3. **Detect an R3 recalculation.** `compensation_line` and `employee_statutory_profile` are
   close-then-open with at most one open row (ADR 0072), so the trigger condition is "a row whose
   `[effective_from, effective_to]` overlaps the run's period and whose `created_at` is after the
   run's `calculated_at`".
4. **Add the `hr` row to `MODULE_READ_CODE`** (§4.5.8) when `hr.payroll.read` is seeded — 2C's map
   waits on it, and until then an `hr` attachment is a default deny.

**The export registry, if 7C has not merged yet.** Under the `8A-FIRST` branch of Task 14 Step 3,
`packages/db/src/export/` does not exist and 8A added nothing to it. The three rows it would have added
are written out in Task 14 Step 3 of this slice's plan and belong to **whichever of 7C and 8D runs after
both**: `employee_sensitive` gated on `hr.employee.read_sensitive` with **metadata columns only**
(`employee_id`, `key_version`, `updated_by`, `updated_at`, `created_at`), `compensation_line` and
`employee_statutory_profile` gated on `hr.compensation.read`, and `NEVER_EXPORTED["employee_sensitive"]`
narrowed from `["*"]` to the nine `*_enc` column names. Until then the three tables are absent from
`EXPORT_TABLES`, which already means they never leave the system — the safe default, not a gap.

**Two `fixtures.ts` facts.** `SYNTH_RATE_TABLE_V1` is the const 8B's
`packages/db/seed/test/statutory/SYNTH/v1.json` must match number for number.
`hrFixture(api, name?)` in `tests/invariants/support/hr.ts` is the shared corpus: three employees, one
of whom **is** the officer, so an R4 case needs no set-up of its own. **It takes the running API as a
parameter** (A6) — 8B, 8C and 8D pass their own `startApi()` result, exactly as 6A's `posFixture` and
6C's `staffFixture` are called, and pass a distinct `name` when two corpora share one API.

**What is still open.** OD-28 (the profile field list — the `extra jsonb` seam), OD-23 (the tables,
the registrations, the pay conventions), OD-14 (the four HR facts), OD-24 (the screens — 8A Task 13
is the slice's one incomplete task).
```

- [ ] **Step 7: Commit**

```bash
git add tests/regression/legacy-029.test.ts tests/regression/legacy-030.test.ts tests/regression/legacy-033.test.ts \
        tests/regression/legacy-044.test.ts tests/regression/legacy-045.test.ts tests/regression/legacy-078.test.ts \
        tests/invariants/hr-sensitive-side-channels.test.ts docs/handoff/8a-to-8b.md
# and, ONLY under the 7C-FIRST branch of Step 3, the file that branch touches:
#   git add packages/db/src/export/tables.ts
git commit -m "$(cat <<'EOF'
test(regression): append the six 8A blocks and hand off to 8B [8A T14]

legacy-029/030 (every HR write audited under a server-supplied actor, no flag suppresses it, and the
sensitive table's before/after images are ciphertext), legacy-033 (the gate is an RLS predicate on the
actor's permission and no parameter changes it -- checked over the committed OpenAPI document too),
legacy-044 (every *_by column stamped from the session and immutable after; the rate-table verifier
above all), legacy-045 (R4 in all four places by direct app_rw SQL -- test 31's R4 clause in its filed
form), legacy-078 (statutory rules as version-controlled data with provenance, refused with a JSON
Pointer, and applicability in a join table rather than a boolean column). All six files were
created by 0B; this slice appends and edits no earlier block.

Test 32's fifth channel closes here too. Under 7C-FIRST, employee_sensitive, compensation_line and
employee_statutory_profile each get an EXPORT_TABLES row with its gate, NEVER_EXPORTED's whole-table
pin on employee_sensitive is narrowed to the nine ciphertext columns by name, and one invariant case
proves all three are absent from a non-holder's archive AND named in manifest.excluded. Under
8A-FIRST none of that module exists yet, the three tables are simply not in the registry -- which is
already safe, since the exporter iterates the registry and nothing else -- and the rows are written
into the handoff note for whichever slice runs after both (amendment A20).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Against the contracts card (§2.9, 8A).** Every "Delivers" bullet has a task. `employee` extended → T1. `employee_sensitive` with the `sensitive_gate` policy *"exactly as spec:2076"*, the linter rule, the API omission and the gate covering filter, sort and search (test 32) → T3, T4; **the export channel → T14 Steps 3 and 4**, behind amendment A20's `7C-FIRST` / `8A-FIRST` branch, because §6.3 runs 8A and 7C in parallel and `packages/db/src/export/` may not exist when this slice runs. `employee_statutory_profile` (effective-dated, ⚠️ field list) → T5. `pay_component` (`earning | deduction`, GL account, `pay_component_scheme` join, no booleans) with the Malaysia seed components → T6, T9. `compensation_line` (effective-dated, history = closed rows) → T6. R4 triggers on all four targets with `ERR_HR_SELF_PAY` → T1 (the function and the fourth target), T3, T5, T6. `statutory_scheme` (a row per scheme, never an enum) and `statutory_rate_table` with the `verified_by ≠ loaded_by` trigger and `ERR_HR_SELF_VERIFY` → T8. The seed loader from `seed/my/statutory/<scheme>/vN.json`, the break-glass `hr.statutory_table.manage`, `hr.statutory_table.verify`, the `hr.rate_table.lapse_warning` job and `rate-table.schema.json` → T9, T10. Company HR settings with the proration rule → T11. The six codes → T2. HR screens → T13 (⚠️ OD-24). **Card size 14–15 tasks: 15 written (T0–T14).**

**Owner gates are four isolated tasks, one per OD id** (hazard 6, §2.0): OD-28 → T5, OD-23 → T11, OD-14 → T12, OD-24 → T13. None is spread across tasks; each states its default and exactly what changes. **OD-13 is not this slice's** — §2.12 assigns it to 8D and the orchestrator's JSON disagreed with the card; amendment A1 records the resolution and nothing leave-shaped is built.

**Hazard 1 — no statutory figure.** Searched the whole plan: the only numeric literals in a statutory context are `SYNTH_RATE_TABLE_V1`'s three bands (§4.12.4 verbatim, `source.authority = "Dulja test fixture"`), the horizon `60` (spec:2109's own number, a schedule and not a rate), `HR_KEY_BYTES = 32` and the envelope's `1/12/16` byte lengths. The four scheme directories ship empty with a README saying why; the loader refuses a test-fixture authority outside `APP_ENV=dev`; T9's test asserts no `v*.json` exists in the repository and no rate-table shape appears in `pay-components.json`. **Hazard 2** — no LHDN endpoint, field, form name or threshold appears; T5 ships only the three fields spec:2077 itself names.

**Hazard 32 — no invented literal in a shared namespace.** Account codes: **none seeded, none consumed by literal**; T6's last case asserts the eleven payroll codes do **not** exist after 8A, and amendment A2 records why `statutory_scheme.payable_account_id` had to become nullable. Document-type codes: none, not even a test-only one. Report codes and `DatasetId`: none. `ERR_*`: exactly the two §4.2.4 allocates — and T8 catches its own draft inventing `ERR_HR_TABLE_VERIFIED`, resolves it to a second message on the allocated code, and leaves the paragraph in so a reader knows why. `fixtures.ts`: exactly §4.17's three, plus `SYNTH_RATE_TABLE_V1` registered by A5 and `seedEmployee` under the first-to-run rule.

**Hazard 16 and the 6C interlock.** T0 Step 3 decides the branch and records it in the PR; T1 Step 1 carries both branches with 6C's exact `seedEmployee` body and `0064` text, so whichever runs second takes its verification branch and finds what it asserts. T4 Step 4 carries the conditional mounting for both branches.

**Hazard 9 — additive fixtures.** No existing helper's parameters or return changes. `hrFixture`'s checker grant is widened additively in T10 and recorded on A6's row.

**Hazard 20, 31.** The one job runs as the system principal, fans out with `eachTenant`, works in short transactions and is probed. Three new route modules, three `PROBES` entries — **four under `8A-FIRST`**, where T4 mounts the `employees` module itself and adds the key `tenant-isolation.test.ts` demands of every `ROUTES` entry (T4's Files list says so; GC 16 and the File Structure row now agree with it). Seven sub-paths on 6C's `employees` module, no entry of their own (§4.2.7's rule, stated in T7 Step 5).

**Two things a reviewer asked about, both now settled in the text.**

1. **`app_meta.attach_audit`'s third argument — settled, not open.** T3 passes `'tenant_column', 'employee_id'` and T6 passes `'tenant_column', 'component_id,scheme_id'` for the two `NO_ID_TABLES` members, because the generator's default key column is `id` and neither table has one. §4.1 gives the signature but not the `key_cols` grammar, so it was read off Plan 0A's implementation: `app.audit_row()` splits with `unnest(string_to_array(v_keys, ','))` and reads `rec ->> k` per element (plan0A:2320–2325), and all eight of 0A's own composite calls are written **without a space** (plan0A:2348–2355). **A space would not fail loudly** — `rec ->> ' scheme_id'` is NULL and `string_agg` drops it, so every `pay_component_scheme` audit row would silently carry only the component id. The comma-with-no-space in T6 Step 3 is therefore load-bearing and the migration says so on the line.
2. **`ERR_MONEY_CURRENCY_MISMATCH` from a route.** T7 raises 0D's code for a compensation amount in a non-base currency. §4.2.4 lists its raiser as `Money`, not as a handler; the code and status (422) are right and the row already exists, so no registry change is needed — but a reviewer who reads the "Raised by" column strictly should see this sentence rather than wonder. **It is named in Global Constraint 12's closed list** for the same reason: a token that a test of this slice asserts and the list omits reads as a typo to anyone applying GC12 literally.

3. **Where the PRODUCTION key ring is composed, and where its version number comes from — settled, and T3 Step 7 does it.** An earlier draft of this paragraph said the composition root was "0B's and 0D's file and not this slice's to rewrite" and assigned the line to nobody. **That was wrong and is corrected**, because `AppDeps` is a required-member interface: leaving the member out of `apps/api/src/index.ts` — the only `AppDeps` literal the container is actually served from — makes `bun run typecheck` red from T3 Step 10 onward, against Global Constraint 19, and would leave the two new `ApiConfig` members as dead code no deployed container ever reads. 6A did the same edit for `terminalJwtSigningKey` (6a:2970–2982) and 2C for `objectStore`; the rule is that **the slice that adds the member moves every literal in the same commit**. T3 Step 7 therefore carries all four: `apps/api/src/index.ts` (production), `apps/api/test/support/app.ts` (`startApi`'s deterministic dev ring), `apps/api/src/routes/index.ts` (the derived `ROUTES` stub) and `apps/api/src/app.ts` (the interface and the one `buildRoutes` call). The production line is `createHrKeyRing({ current: config.hrFieldEncryptionKey, currentVersion: 1, previous: config.hrFieldEncryptionKeyPrevious })`, placed exactly where 2C's `new R2ObjectStore(config)` already is. **The `1` is the only thing still open, and it is open by design:** §3.11 names two variables and no version number, `createHrKeyRing` requires `currentVersion`, and the deployment is single-version until rotation exists, so this plan **does not invent a third §3.11 name**. 8D closes it — its amendment **A12** registers `HR_FIELD_ENCRYPTION_KEY_VERSION` and replaces this literal with `config.hrFieldEncryptionKeyVersion` in the same pull request as the rotation job (8d:3685 quotes the line above verbatim to do it), which is also why T3 Step 7 tells the executor not to reformat it. **`apps/worker/src/index.ts` stays untouched:** it builds no `AppDeps`, and 8A's one job decrypts nothing — A12 puts `apps/worker/src/hr-keys.ts` in 8D beside the first worker code that does.

**What is different from this plan's first draft**, so a reviewer of the second does not re-derive it: the sensitive `PUT` is gated by `hr.compensation.manage` and not by the non-mutating `hr.employee.read_sensitive` (R7's boot check would have refused the app); `buildRoutes` and the derived `ROUTES` gain `hrKeys` in T3, without which nothing that enumerates `ROUTES` constructs; `pay-components.ts` and `statutory-schemes.ts` are written out in full rather than described; `key_version` records the oldest version in a row rather than the newest; the `PUT …/schemes` FK case moved from T7 to T10, where its constraint exists; the four Task 14 blocks that write gated tables grant first; the `8A-FIRST` branch is carried through the contracts module, the fixture's grants and Task 4's two directory cases; and `residencyCategory` has a documented second home in `StatutoryProfile`, asserted as an allow-list in T4 rather than as a count.

**What is different from the second draft**, after an independent audit read this plan against the contracts document, plan 0A and the spec. Four things were *wrong*, not merely absent, and each is corrected in place rather than papered over.

1. **The three query schemas did not enforce what three tests asserted.** `CompensationQuery` and `PayComponentQuery` were plain `ListQuery.extend({…})` objects and the statutory-profiles `GET` declared no `query` at all, so `filter[amount][gt]=1000`, `filter[maritalStatus][eq]=married` and friends were *stripped* and answered 200 while the tests expected 400 — and `sort=`/`fields=` would have survived even `.strict()`, because both are declared `ListQuery` members. All three schemas now carry `.strict()` **and** 0B's `z.string().max(0, …)` bound on `sort` and `fields` (0b:4321; a `.refine` would wrap the object in `ZodEffects` and break query-parameter generation), `StatutoryProfileQuery` is wired into `request.query`, and the comment claiming "the omission is the enforcement" is replaced by one that says which mechanism closes which half and why 0B's `AuditLogQuery` is correctly *not* `.strict()`. **The expected pass counts did not move** — T5 Step 7's `9 + 7` and T7 Step 6's `8 + 6` were already right; the cases were unattainable, not miscounted.
2. **`apps/api/src/index.ts` is now edited by T3 Step 7.** The second draft added a required `hrKeys` member to `AppDeps` and left the production composition root out of every Files list, which is a red `bun run typecheck` from T3 Step 10 onward and two `ApiConfig` members no deployed container would ever read. See Self-Review item 3.
3. **T9 Step 7's loader test is code.** Seven of its nine cases were a numbered prose list — the one place in the plan that described a test instead of carrying it — and the case count disagreed with Step 9's `Expected`. All nine are `it(…)` blocks now, with a `REPO_ROOT` the file derives itself, a `LoaderContext`/`SeedConfig` builder, an `APP_ENV` helper that sets and restores the variable the loader branches on, and the loader's exact throw strings; `Expected` reads `7 + 1 + 9`.
4. **Three stale counts.** `AppEnv["Variables"]` is eight registered members, not seven (§4.2.3, after 3B's `jobs`); the `PROBES` total is three, or four under `8A-FIRST` where T4 creates the `employees` module itself; and T9 Step 9's `Expected` now states the two `permission-catalogue` lines its `lint:rules` run prints, as GC 19 requires of every "run everything" step.

**One finding is deliberately NOT fixed here, because the fix is not in a file this slice owns.** T4's `it.skipIf(!SIX_C)` directory-sort case asserts 400 on 6C's `GET …/employees`, whose `EmployeeQuery` (6c:3903) is neither `.strict()` nor sort-bounded — so under `6C-FIRST` it would answer 200. The assertion stays (it is test 32's directory channel), the test carries a comment naming the exact two-line change 6C needs, and the Execution handoff has a "Where to stop and raise" bullet forbidding an edit to 6C's file.

**Two deliberate omissions.** `packages/db/src/hr/employee-sensitive.ts` exposes no bulk read: 8D's rotation job needs one and will add `forRotation(tx, ring, limit)` in its own slice, where the batching policy belongs. And no HR `DatasetId` or report code is registered here even though `employee` is 6C's table and 8A extends it — §4.16.2's rule is *first report that reads it*, and that is 8D's `hr.employee_list`.

**No placeholder survives — and after the audit pass this is true of T9 too.** Every migration, module, mirror, contract, route, fixture, seed file, job handler, regression block and ADR this plan names is written out as code an engineer types unchanged; T9 Step 7's loader cases, which the second draft left as a numbered prose list, are now nine `it(…)` blocks like every other test in the plan, and that was the last described-but-unwritten step. Drafts that were *wrong* rather than merely absent are corrected in place, each keeping a one-paragraph note saying why — the three query schemas and the composition-root wiring above, plus T5's hoisted column list (`sql.unsafe` has three homes and none is there), T6's `delete from app.pay_component_scheme` (§3.5.4's DELETE list is closed and only 2B ever extended it), and T8's `ERR_HR_TABLE_VERIFIED` (unregistered in §4.2.4, and `error-codes` scans migrations). Keeping the reason without keeping the wrong code is the difference between a note and a placeholder.

**Where the plan is deliberately short.** T13 ships no code (OD-24) and T12 ships none (OD-14); both are hazard 6's isolated-task shape and are the two tasks a reviewer should expect to be brief. Everything else carries its own test bodies.

## Execution handoff

**Batches and pull requests.** Seven migrations, seven PRs (§3.4.3), grouped into **three** review batches. Batch 2 is deliberately large: it is one long batch of many small pull requests, not one pull request.

| Batch | Tasks | Migrations | Why these together |
|---|---|---|---|
| **1** | T0, T1 | 0080 (+ 0064 under `8A-FIRST`) | The gate, the employee columns and the R4 function every later migration attaches. |
| **2** | T2, T3, T4, T5, T6, T7, T8, T9, T10 | 0086, 0081, 0082, 0083, 0084 | **The catalogue batch, and it is one batch for exactly 6C's reason** (6c:5437: *"the mitigation is batching, never a suppression"*). T2 seeds six codes whose first `PERMISSION[…]` references are written by T4 (three), T7 (one) and T10 (two), and `permission-catalogue` fails on a seeded code with no reference — so `bun run lint:rules` reports six, then three, then two lines *inside the branch* and is silent from the end of T10. Splitting this into three batches would merge a red `lint:rules` onto mainline twice, and moving 0086 later is impossible: migration 0081's `sensitive_gate` names `'hr.employee.read_sensitive'` as a literal `app.actor_has` resolves against `app.permission`, so without 0086 the gate is false for everyone and every T3–T7 test dies. Do not "fix" the lint by deleting a catalogue row either — `permission-catalogue.test.ts` compares both directions and would go red instead. Order inside the batch is T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10, one pull request per task and one migration per pull request. |
| **3** | T11, T12, T14 | 0085 | Settings, the OD-14 note, the regression appends (including T14 Step 3's export rows) and the handoff. **T13 stays open** as the slice's one blocked task. |

**Where to stop and raise.**

- **T0 Step 2 prints fewer than six `ok` lines.** The Phase 4 gate is not met. Stop: every failing-test step in this plan assumes 4B is merged, and a missing predecessor produces a *different* failure from the one written down, which is exactly the situation where adjusting a test is the wrong move.
- **T1 Step 3's R4 case passes before Step 4.** Something already attached a trigger to `employee.terminated_on` — 8C's migration 0093 is the only other candidate and it must not exist yet. Stop and check `listApplied()`.
- **T3 Step 10 reports a `sensitive_gate` violation on a table you did not create.** The rule's `GATED_TABLES` map is written in full in T3 Step 4 and includes two tables that arrive in 0082 and 0083. A violation on either **before** those migrations run means the rule is firing on a table that does not exist, which cannot happen — check that the loop is `for (const t of tables)` over the tables that *do* exist rather than over the map.
- **T4's case `a sensitive field cannot be used as a filter or a sort` returns 200 instead of 400 under `6C-FIRST`.** That is the one assertion in this slice whose enforcement lives in a file 8A does not own: the route is 6C's `GET …/employees` and the schema is 6C's `EmployeeQuery`, which as written (`ListQuery.extend({ "filter[homeBranchId][eq]", "filter[active][eq]" })`, 6c:3903) is neither `.strict()` nor bounded on `sort`/`fields`, so all five query strings are silently stripped and answered 200. **Do not edit `packages/contracts/src/hr/employee.ts` and do not weaken the assertion** — it is test 32's directory channel. Stop and raise it against 6C: the fix there is the same pair 8A applies to its own three query schemas (`.strict()`, plus `sort: z.string().max(0, …).optional()` and the same for `fields`, 0b:4321), and it is a two-line change to one schema. Under `8A-FIRST` the case is skipped and this cannot fire.
- **T8's freeze case (`a verified table is frozen — definition, version, effective_from and source cannot change`) fails with `ERR_HR_TABLE_VERIFIED` not found.** Read T8 Step 3's closing paragraph: that token is deliberately removed and *both* refusals raise `ERR_HR_SELF_VERIFY`, the freeze one with a message containing `frozen`, which is what the test matches. If the migration on disk still carries the draft token, `error-codes` will have failed the build before any test ran.
- **T8's fifth case (`the LOADER cannot verify their own table`) passes when it should fail.** The most likely cause is a trigger comparing `new.verified_by` instead of `old.loaded_by` — see the two-subtleties paragraph at the head of T8. A `stamp_verified_by` that happened to sort first would make the wrong comparison pass.
- **T9's drift-guard case fails after `bun run rate-table:types`.** The generator and the guard must use the *same* options object; 1A's `POLICY_TYPE_OPTIONS` is shared for exactly this reason (§4.18 round 2). Do not relax the comparison to a substring — the whole normalised text is the contract.
- **T10's "holding BOTH codes" case returns 403 rather than 409.** `hrFixture`'s checker grant was not widened. T10 Step 1's closing note says to add `hr.statutory_table.manage` to it and record the change on amendment A6's row.
- **Any task's `bun run lint:rules` reports a **seventh** `permission-catalogue` line.** A code was invented. Hazard 26 closes the vocabulary at the six §3.6.2 assigns 8A; stop rather than adding a catalogue row.
- **T3's trigger-inventory case reports `stamp_updated_by` missing on `employee_sensitive`.** Migration 0081 was written with `call app_meta.attach_stamp('app.employee_sensitive', 'updated_by');` — the form amendment **A19** replaces. Attach `app.stamp_actor_always('updated_by')` as a trigger of that exact name instead; the linter rule checks the trigger's *name*, not its function (plan0A:2755–2758), and A19 says why the write-once stamp is wrong for this one table.
- **T14 Step 3's branch probe says `7C-FIRST` but `packages/db/src/export/` has no `NEVER_EXPORTED`.** 7C's registry is one file; a partial merge is not a branch this plan handles. Stop and check `git log packages/db/src/export/` rather than half-writing the three rows.
- **7C's `exports-gates` case "no NEVER_EXPORTED column appears in any archive" fails on `employee_sensitive` after T14 Step 3.** That means the exporter principal in 7C's suite now holds `hr.employee.read_sensitive`, so the metadata row is legitimately in its archive. **Do not edit 7C's file.** Stop: either the grant widened somewhere it should not have, or the two slices need a settlement recorded in the contracts document. As written, 7C grants that principal exactly `admin.data.export` and `accounting.ledger.read` (7c:5234) and the case stays green.
- **T13 has no screenshots.** Open the blocked pull request of T13 Step 1 and move on. The slice is complete without it, and 8D inherits the same block.

**What 8B starts from.** `docs/handoff/8a-to-8b.md` (T14 Step 4) is the whole surface, including the four things 8A deliberately left for 8B: seeding the payroll accounts and wiring the four nullable columns, the empty `pay_component_scheme`, the R3 detection condition ADR 0072 makes possible, and the `hr` row of `MODULE_READ_CODE`.

