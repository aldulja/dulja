# Phase 8 implementation progress log

## 8A T0–T3 (2026-11-07)

**Branches taken.** `6C-FIRST` (0064, `seedEmployee`, `packages/contracts/src/hr/employee.ts`, `employeeRoutes` /
`employeeRouteModule` are 6C's; nothing recreated) and `7C-FIRST` (`packages/db/src/export/tables.ts` present).
Both are recorded in contracts **round 16** (end of `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`).

### Built

- **T0** — contracts round 16: A1–A20 transcribed from the plan, plus **A21** (nine places the plan text was
  stale against the tree). New gate `scripts/check/contracts-8a-amendments.sh`, wired into CI's `checks` job
  after the 7C step (`.github/workflows/ci.yml`). Later 8A tasks should re-run it first.
- **T1** — migration `0080_alter_employee_extend.sql` (+ down): `position`, `employment_type` (check
  `employee_employment_type_check`), `statutory_profile_note`, `archived_at`; `app.forbid_self_pay()` (TG_ARGV[0] =
  employee-id column) attached as `employee_no_self_pay` (BEFORE UPDATE OF terminated_on). `ERR_HR_SELF_PAY` (409)
  in `ERRORS` and pinned in `packages/contracts/test/contracts.test.ts`. `EmployeeSchema` gains `position`,
  `employmentType`, `archivedAt`; `CreateEmployeeBody` gains optional `position`, `employmentType`. Because the
  wire schema parses 6C's rows, 6C's service `packages/db/src/staff/employee.ts` (`EmployeeRow`,
  `CreateEmployeeInput`, `SELECT`, `createEmployee`) and route now carry them; `apps/backoffice/test/staff.test.tsx`'s
  fixture gained the three nulls; 6C's frozen-column case (`packages/db/test/staff/employee.test.ts`) sets 0080's
  four aside by name. `openapi.json` regenerated (Employee gains 3 props, CreateEmployeeBody 2).
- **T2** — six `PermissionDef` rows (phase `"8A"`) and migration `0086_seed_permission_phase8a.sql` (+ down).
  Grants: `hr_payroll` += read_sensitive, compensation.read, compensation.manage, pay_component.manage,
  statutory_table.manage; `accountant` += statutory_table.verify; auditor none.
  `packages/db/test/roles-seed.test.ts` updated (accountant list + an 8A case).
- **T3** — migration `0081_create_employee_sensitive.sql` (+ down): table, `sensitive_gate` (RESTRICTIVE,
  spec:2076 verbatim, no `with check`), `app.stamp_actor_always()` + trigger `stamp_updated_by` (A19),
  `employee_sensitive_no_self_pay`, audit keyed `'employee_id'`.
  `packages/db/src/hr/`: `keys.ts` (`HR_KEY_BYTES`, `DEV_HR_KEY`, `HrKey`, `HrKeyRing`, `HrKeyError`,
  `createHrKeyRing`, **`decodeHrKey(name, b64)`** — extra export, used by `apps/api/src/config.ts`),
  `config-error.ts` (`ConfigError`), `sensitive.ts` (`SENSITIVE_FIELDS`, `SensitiveField`, `sealField`,
  `openField`), `employee-sensitive.ts` (`readSensitive`, `writeSensitive`, `SensitiveRow`, `SensitiveValues`),
  `index.ts`; `packages/db/src/index.ts` does `export * from "./hr"`. Drizzle mirror
  `schema/employee-sensitive.ts` exported as `employeeSensitiveTable` (mirror count 74). `lint-schema.ts`:
  `GATED_TABLES` map (A9; only fires for tables that exist) and `noId` += `employee_sensitive`,
  `pay_component_scheme` (the plan's `NO_ID_TABLES` is spelled `noId` in the tree).
  API wiring: `ApiConfig.hrFieldEncryptionKey` / `hrFieldEncryptionKeyPrevious`; `AppDeps.hrKeys`;
  `buildRoutes({ authAdmin, objectStore, hrKeys })` and the `ROUTES` stub (dev ring); `apps/api/src/index.ts`,
  `apps/api/src/openapi.ts` and `apps/api/test/support/app.ts` build a ring. `tests/invariants/support/hr.ts`
  (`HrFixture`, `hrFixture(api, name = "hr")`, `hrActor`) — smoke-tested (built twice on one API, outsider lists
  6C's directory 200) and then the scratch test was removed. ADR `0071-hr-field-encryption-envelope.md` (Proposed,
  three owner questions).

### Deviations from the plan (and why)

1. `AppDeps` already had **seven** members (6A's `terminalJwtSigningKey`); `hrKeys` is the **eighth** (A21 item 2).
   `apps/api/test/routes/health.test.ts`'s `deps()` is cast `as never` and was left alone; it never touches
   `hrKeys` (Task 4's `composeEmployeeRouter(hrKeys)` must not dereference the ring at build time, or that test
   breaks).
2. `containerSecrets` is `apps/edge/src/container-env.ts` (no `infra/src/secrets.ts`); both HR names are in its
   **optional** list (forwarded to api AND worker when bound), `EnvSecrets` gained both, on the R2 precedent.
   `docs/runbooks/deploy.md`'s secrets block now binds `HR_FIELD_ENCRYPTION_KEY` (`openssl rand -base64 32`) and
   warns that the key is never replaced without `…_PREVIOUS`; `apps/api/test/config-and-auth.test.ts` binds a
   real 32-byte key for that name; `apps/edge/test/containers.test.ts` gained a forwarding case.
3. **`readConfig()` validates the HR key** (alphabet + exactly 32 bytes, both names) with apps/api's own
   `ConfigError`, so a bad deployment exits 2 at boot naming the variable (A8's "ConfigError naming the variable");
   the plan only checked presence. `createHrKeyRing` re-validates with packages/db's `ConfigError`.
4. The production `hrKeys: createHrKeyRing({ current, currentVersion: 1, previous })` line is **wrapped by oxfmt
   over five lines**; the plan asked to keep it on one line for 8D's verbatim quote — 8D should match the
   properties, not the line.
5. `packages/db/test/export/tables.test.ts`: `FORWARD_PINS` is now `[]` (it fails once the table exists).
   `NEVER_EXPORTED.employee_sensitive` **stays `["*"]`** (a whole-table pin is legal for a live table) — Task 14
   narrows it to the nine `*_enc` columns and adds the metadata row. The four 0080 columns are not in the
   `employee` EXPORT_TABLES row yet (explicit-column registry → `omitted`); Task 14 should decide whether
   `position`, `employment_type`, `archived_at` (and the note) leave.
6. `writeSensitive` casts every parameter (`::uuid`, `::smallint`, `::bytea`, `::boolean`) — a null bytea in an
   `insert … select` target list would otherwise resolve to `text`. `readSensitive` returns `updatedAt` as an
   RFC 3339 UTC string. `openField` wraps a GCM auth failure in `HrKeyError` (plan let the raw crypto error escape).
   `createHrKeyRing` bounds `currentVersion` to 1…255 (one envelope byte).

### Decisions

- **Test actors need a live role in the company.** 6C's Form A′ `branch_isolation` on `app.employee` hides every
  employee from a principal with no role assignment, so the plan's tests (written for `8A-FIRST`) would see
  silent no-ops. Every human actor in `employee-extend.test.ts` / `sensitive.test.ts` gets a company-wide
  `grantCodes` role; the `sensitive.test.ts` **bystander holds an empty role**, so its refusal is
  `sensitive_gate`'s (42501 on INSERT and on the upsert), not branch isolation's. Later HR tests must do the same.
- Principals are minted through `db.migrator` as `s.system` (the tree's fixture pattern), not `db.rw` as `s.human`.
- Comments in `packages/db/src/**` and `apps/**` must not spell a catalogue code literally until its route lands —
  `permission-catalogue` counts any text inclusion as a reference (a comment in `export/tables.ts` briefly
  masked `hr.employee.read_sensitive`; reworded). Likewise no apostrophes in `roles.ts` permission arrays.

### Tests run (2026-11-07)

- `packages/db` whole suite on T3's head: **2,000 passed in 204 files** (incl. `hr/employee-extend` 6,
  `hr/sensitive` 14).
- `apps/api` whole suite on T3's tree: **897 passed in 93 files**.
- `tests`: `tenant-isolation`, `auth-bypass`, `tax-permissions-5a`, `export-audit` 80 passed; a scratch
  `hrFixture` smoke test passed and was removed. The rest of the `tests` workspace and `bun run e2e` were not run.
- `packages/contracts` 69, `apps/edge` 46, `infra` 25, `apps/backoffice` staff 20, `tests` lint + sah-082 +
  lint-rules invariant 71 — green.
- Static: `bun run typecheck` 14/14, `bun run lint` 0, `bun run format:check` clean, `openapi.json` regenerated
  with no further diff after T1, `contracts-8a-amendments.sh` OK. **`bun run lint:rules` reports exactly GC 19's
  declared exception**: one `permission-catalogue` line naming the six 8A codes (closes at T4/T7/T10).

### For the next agent (T4+)

- `hrFixture` is in place; T8 appends `schemeId` with `seedStatutoryScheme`.
- `AppDeps.hrKeys` / `buildRoutes` deps carry the ring; compose the employees router in `buildRoutes` (A16).
- `EmployeeQuery` is already `.strict()` with `sort`/`fields` bounded, so T4's directory case should get 400.
- `GATED_TABLES` already names `compensation_line` and `employee_statutory_profile` with `compensation_gate`; their
  migrations (0082/0083) must create RESTRICTIVE policies of exactly that name or `lintSchema` fails.
- `pay_component_scheme` is already in `noId`.

## 8A T4–T7 (2026-11-07)

### Built

- **T4** (`96ef47e`) — `GET|PUT /v1/companies/{companyId}/employees/{employeeId}/sensitive`:
  `apps/api/src/routes/hr/sensitive.ts` (`createSensitiveRoutes(hrKeys)`, a factory; the ring is dereferenced only
  inside a handler, so `health.test.ts`'s `as never` deps still build), `apps/api/src/routes/hr/employees-composed.ts`
  (**`composeEmployeeRouter(hrKeys)`** — 6C's `employeeRoutes` + 8A's three sub-routers), and in `buildRoutes` 6C's
  `employeeRouteModule` spread with `router: composeEmployeeRouter(deps.hrKeys)` and `permissions` widened by
  read_sensitive / compensation.read / compensation.manage (6C-FIRST branch; **no new PROBES key**).
  `packages/contracts/src/hr/sensitive.ts` (`SENSITIVE_WIRE_FIELDS`, `EmployeeSensitiveSchema`,
  `UpdateEmployeeSensitiveBody` (**`.strict()`**), `EmployeeSensitiveDto`; zod v4 `.meta({ id })`, not `.openapi()`).
  Tests: `apps/api/test/routes/hr/sensitive.test.ts` (12), `tests/invariants/hr-sensitive-side-channels.test.ts` (4).
- **T5** (`9be83b7`) — migration `0082_create_employee_statutory_profile.sql` (+ down): the plan's table plus a
  `jsonb_typeof(extra) = 'object'` CHECK; `compensation_gate` (RESTRICTIVE), `stamp_entered_by`,
  `employee_statutory_profile_no_self_pay`, `employee_statutory_profile_open_idx`. `packages/db/src/hr/statutory-profile.ts`
  (`listStatutoryProfiles`, `profileOn`, `openStatutoryProfile`, `StatutoryProfile`, `StatutoryProfileInput`, extra
  `StatutoryExtraValue`); mirror `employeeStatutoryProfileTable`. Contracts `packages/contracts/src/hr/statutory-profile.ts`
  (`StatutoryProfileSchema`, `OpenStatutoryProfileBody` (strict), `StatutoryProfileList`, `StatutoryProfileQuery`).
  Route `apps/api/src/routes/hr/statutory-profiles.ts` (`statutoryProfileRoutes`). Owner note
  `docs/owner/od-28-statutory-profile-fields.md`; **created** `docs/review/2026-11-07-phase-8-decisions.md` (OD-28 row
  and the company-binding row — later agents append OD-13/OD-24/OD-23/OD-14 rows). Tests: db 9, api 8.
- **T6** (`2071bc1`) — migration `0083_create_pay_component_compensation.sql` (+ down): `pay_component`
  (`pay_component_kind_check`, plus a `length(code) between 1 and 40` CHECK), `pay_component_scheme` (no scheme FK —
  0084 adds it, A13; audit keys `'component_id,scheme_id'`), `compensation_line` (`compensation_gate`,
  `compensation_line_open_idx`, `compensation_line_period_idx`, `stamp_entered_by`, `compensation_line_no_self_pay`).
  `packages/db/src/hr/compensation.ts` (`listPayComponents`, `setComponentSchemes`, `listCompensation`,
  `compensationOn`, `openCompensation`, `PayComponent`, `CompensationLine`, extra `PayComponentKind`); mirrors
  `payComponentTable`, `payComponentSchemeTable`, `compensationLineTable` (mirror count **78**); fixture
  `seedPayComponent` (§4.17). ADR `0072-effective-dated-hr-rows-are-closed-not-edited.md` (**Proposed**, one owner
  question). Tests: db 14.
- **T7** (`8141a4d`) — `createPayComponent`, `renamePayComponent`, `archivePayComponent` appended to
  `compensation.ts`; contracts `packages/contracts/src/hr/pay-component.ts` (`PayComponentKindSchema`,
  `PayComponentSchema`, `CreatePayComponentBody`, `UpdatePayComponentBody`, `SetComponentSchemesBody`,
  `PayComponentQuery`, `PayComponentList`, `PayComponentDto`) and `compensation.ts` (`CompensationLineSchema`,
  `OpenCompensationBody`, `CompensationQuery`, `CompensationList`, `CompensationLineDto`); routes
  `apps/api/src/routes/hr/pay-components.ts` (`payComponentRoutes`, **`payComponentRouteModule`** mounted in
  `buildRoutes`) and `apps/api/src/routes/hr/compensation.ts` (`compensationRoutes`, composed). One PROBES entry
  `"/v1/companies/:companyId/pay-components"`. Tests: api compensation 10, pay-components 9.

### Deviations from the plan (and why)

1. **Every employee sub-resource binds the employee to the PATH company** (`apps/api/src/routes/hr/employee-scope.ts`,
   `requireEmployeeInCompany(tx, companyId, employeeId)`, one 404). The plan's handlers checked only existence (or
   nothing, for the sensitive GET). RLS bounds the tenant only and `sensitive_gate`/`compensation_gate` ask the code at
   the *employee's* company, so a holder in a sibling company could read this company's records through a path naming
   their own company. Proven failing-first by the sibling-company case in `sensitive.test.ts`. Recorded in the
   decisions record.
2. `openCompensation` **joins the component on the employee's company** (a cross-company component inserts nothing
   and throws), and the compensation POST refuses an unknown component (404) or an **archived** one (400) before the
   insert. The plan's insert took any component id of the tenant.
3. Query schemas: `StatutoryProfileQuery`, `CompensationQuery` **and `PayComponentQuery`** are plain strict objects
   (`sort`/`fields` bounded) and do **not** extend `ListQuery` — each handler returns the whole set with a constant
   `null` cursor, so `limit`/`cursor` are refused (the plan's own §4.2.8 argument for the statutory list, applied to
   all three). All write bodies are `.strict()` (the plan closed only `CreatePayComponentBody`).
4. Probe `expect` for pay-components is **403**, not the plan's 404: `requirePermission` refuses a path company in
   another tenant before any row is read (as every company-path probe in the file does).
5. The plan's T6 test opened an unpaid-leave line with `amount: null, quantity: null`, which the table's own
   `amount is not null or quantity is not null` CHECK refuses; the test uses a quantity, and a separate case asserts
   the CHECK. The list order is `kind, code` as the plan's SQL says (deductions before earnings).
6. `apps/api/test/openapi.test.ts` pins the path list; every new path was added in its task's commit.
7. `NEVER_EXPORTED` pins `employee_statutory_profile`, `compensation_line`, `pay_component`, `pay_component_scheme`
   as `["*"]` (comments say Task 14 replaces the gated pins with `EXPORT_TABLES` rows, A20). **Task 14 must decide**
   whether `pay_component`/`pay_component_scheme` get rows (gate: compensation read) or stay pinned.
8. ADR 0072 is **Proposed**, not the plan's "Accepted": it fixes the shape of two tables (data model, spec:95).

### Decisions

- Test principals for T5/T6 db suites follow T3's rule: minted through `db.migrator` as `s.system`; the "clerk" holds
  an **empty live role** so its zero rows are the gate's, not 6C's branch isolation's.
- The officer in `hrFixture` holds a company-wide role named `hr-officer`; a test that needs the officer in a second
  company inserts a `role_assignment` for that role (see the sibling-company case).

### Tests run (2026-11-07)

- Focused: db `hr/statutory-profile` 9, `hr/compensation` 14, plus `migrations`, `migrate`, `schema-lint`,
  `permission-catalogue`, `export/tables`, `schema-mirror`, `privileges`, `expand-contract`, `review-guards`,
  `staff/*`, `report-indexes`, `document-delete`, `inventory/reserved-names` — green. api `routes/hr/*` (5 files),
  `openapi`, `middleware/*` 129 — green. tests `tenant-isolation`, `auth-bypass`, `hr-sensitive-side-channels` 69 —
  green.
- Whole suites on T7's head (`8141a4d`): **`packages/db` 2,024 passed in 206 files**, **`apps/api` 936 passed in 97
  files**. `tests` (subset): `job-isolation`, `phase-5a/6c/6d` pins, `report-catalogue-pins`, `lint-rules`,
  `export-audit`, `sah-039`, `sah-046` green. There are two failures. The first is test 15's PDF in `zero-code-document-type`,
  the known one. The second is **`regression/sah-047.test.ts` "every catalogue code has a registered route"**, which fails on
  `hr.statutory_table.manage`. This is GC 19's same declared exception, seen from the runtime side: the case already
  failed at T3's head on all six 8A codes, and it closes at Task 10 when the statutory-scheme routes land. It is not a
  T4–T7 regression.
- Static on T7's head: `bun run typecheck` 14/14, `lint` 0, `format:check` clean, `openapi.json` regenerated with no
  further diff, `contracts-8a-amendments.sh` OK. **`bun run lint:rules`**: after T4, T5 and T6 exactly **three**
  `permission-catalogue` codes unreferenced (`hr.pay_component.manage`, `hr.statutory_table.manage`,
  `hr.statutory_table.verify`); after T7 exactly **two** (`hr.statutory_table.manage`, `hr.statutory_table.verify`) —
  GC 19's declared counts.

### For the next agent (T8+)

- 0084 must add the `pay_component_scheme.scheme_id` FK (A13); then Task 10's `PUT …/pay-components/{id}/schemes`
  unknown-scheme case (`ERR_CONFLICT_REFERENCE`) can run — the route already relies on the FK and adds no pre-check.
- New employee sub-paths go into `composeEmployeeRouter` and must call `requireEmployeeInCompany`; new paths must be
  added to `apps/api/test/openapi.test.ts`'s sorted list (alphabetical: `pay-components` sorts before `payment-terms`).
- `hrFixture`'s schemeId field is still Task 8's to append.

## 8A T8–T10 (2026-11-07)

### Built

- **T8** (`bf37ff8`) — migration `0084_create_statutory_scheme_rate_table.sql` (+ down): `app.statutory_scheme` (account
  and authority columns nullable, `employer_registration text` (A3), `statutory_scheme_rounding_mode_check`, plus a
  `statutory_scheme_code_check` on the rate-table schema's `^[A-Z][A-Z0-9_]{1,15}$`), `app.statutory_rate_table`
  (stamps `loaded_by`/`verified_by`, `statutory_rate_table_effective_idx`, `statutory_rate_table_lapse_idx`), trigger
  `statutory_rate_table_verifier` → `app.assert_rate_table_verifier()`, `pay_component_scheme_scheme_fk` (A13) and
  `pay_component_scheme_same_company` → `app.assert_pay_component_scheme_company()`. `ERR_HR_SELF_VERIFY` (409) in
  `ERRORS` and pinned in `packages/contracts/test/contracts.test.ts`. `packages/db/src/hr/statutory.ts`: `listSchemes`,
  `listRateTables`, `rateTableOn`, `loadRateTable`, `verifyRateTable`, `lapsingTables`, `StatutoryScheme`,
  `RateTableRow`, and an extra **`RateTableNotVerifiableError`** (all on the `@dulja/db` barrel). Mirrors
  `statutorySchemeTable`, `statutoryRateTableTable` (mirror count **80**). Fixtures `SYNTH_RATE_TABLE_V1`,
  `seedStatutoryScheme`, `seedRateTable`; `HrFixture.schemeId` (code `SYNTH`). Both tables pinned `["*"]` in
  `NEVER_EXPORTED`. Test `packages/db/test/hr/statutory.test.ts` (21).
- **T9** (`86c3408`) — `packages/domain/payroll/`: `rate-table.schema.json`, generated `rate-table.ts` (`RateTable`),
  `validate.ts` (`RATE_TABLE_SCHEMA_ID`, `validateRateTable`, `parseRateTable`, `RateTableValidationError` — carries
  `code = "ERR_VALIDATION_FAILED"`), `index.ts` (also `RateTableBands`, `RateTablePercentageWithCeiling`,
  `RateTableProgressive`, derived with `Extract<>`); `"./payroll"` export and `rate-table:types` script;
  `scripts/generate-rate-table-type.ts` (`generateRateTableType`); `RATE_TABLE_TYPE_BANNER`/`RATE_TABLE_TYPE_OPTIONS` in
  `scripts/policy-type-options.ts`; `rate-table.ts` added to `.prettierignore`; `tsconfig.json` includes `payroll/**`.
  Seed: `packages/db/seed/my/statutory/{schemes.json, pay-components.json, README.md, EPF|SOCSO|EIS|PCB/.gitkeep}`;
  `packages/db/src/seed/statutory.ts` (`statutoryLoader`, `loadStatutoryPack`, `SchemeSeed`, `PayComponentSeed`,
  exported from `src/seed/index.ts`, in `LOADERS`); `SubPack`/`SUB_PACKS` (last), `PHASE_0_SUB_PACK_DIRECTORIES`,
  `OWNED_ELSEWHERE` now `{}`. ADR `0073-statutory-tables-are-seed-pack-data-with-a-break-glass-door.md` (**Proposed**, two
  owner questions). Tests: domain `test/payroll/` 9, db `hr/statutory-loader` 10.
- **T10** — `packages/contracts/src/hr/statutory-scheme.ts` (`RoundingModeSchema`, `StatutorySchemeSchema`,
  `StatutorySchemeList`, `RateTableSchema`, `RateTableList`, `LoadRateTableBody` (strict), `StatutoryListQuery`
  (empty strict), DTO types); `apps/api/src/routes/hr/statutory-schemes.ts` (`statutorySchemeRoutes`,
  `statutorySchemeRouteModule`, mounted in `buildRoutes`); one `PROBES` key (403) and one `JOB_PROBES` entry;
  `JobPayload["hr.rate_table.lapse_warning"]`; `apps/worker/src/jobs/rate-table-lapse.ts` (`LAPSE_HORIZON_DAYS`,
  `LAPSE_AUDIT_TABLE`, `LapseWarning`, `rateTableLapseHandler`, `registerRateTableLapse`), registered in
  `apps/worker/src/index.ts` and in `apps/worker/test/support/worker.ts`; **tail migration
  `0120_admit_rate_table_lapse_warning_system_event.sql`** (+ down). `openapi.json` regenerated (3 paths, 4 operations);
  `apps/api/test/openapi.test.ts` path list updated. Tests: api `routes/hr/statutory-schemes` 16, worker
  `jobs/rate-table-lapse` 6. Contracts round 16 gains **A22** and the §3.4.1 register row "8A overrun" (0120).

### Deviations from the plan (and why)

1. **Migration 0120 (tail) — not in 8A's range.** The plan's handler inserts into `app.audit_log` directly, which 0001
   §8 refuses to `app_rw`; the only door is `app.record_system_event` with a closed list. 0080–0086 all sort before
   0105/0111 (which create/re-create that function), so the admission needs a number after 0111. Registered in §3.4.1
   and A22 in the same commit, as 0111 did for 3A. **8D's AGENTS.md rewrite must add `0120` to "In the tree".**
2. **Verifier trigger is `before insert or update`** and freezes `verified_at` too: a direct insert arriving verified
   would stamp the session actor into both columns (a self-verification the plan's UPDATE-only trigger admitted).
3. **`pay_component_scheme_same_company` trigger** in 0084 (SQLSTATE 23503 → `ERR_CONFLICT_REFERENCE`): the composite
   FKs bound only the tenant. **`statutory_scheme_code_check`** pins the schema's code pattern on the row.
4. **`seedRateTable` reads `effective_from`/`effective_to` from its `definition`** (the plan pinned 2026-01-01/null,
   which made the plan's own lapse tests impossible). `lapsingTables` takes an optional `{ companyId }`.
5. The schema carries a **`"title": "RateTable"`** annotation (the posting-policy/report precedent) so the generated
   interface is `RateTable`, not `UrnDuljaRateTable1`. Formats `date`/`uri` are registered with `ajv.addFormat` (no
   `ajv-formats` dependency exists); `allowUnionTypes: true` for `["string","null"]`. Lazy compile like every validator.
6. The loader reads **`ctx.config.appEnv`** (the tax loader's source), not `process.env.APP_ENV`, throws `SeedError`
   for the authority/scheme refusals, and treats an absent `schemes.json`/`pay-components.json` as `[]` (so
   `test/seed/phase4-pack.test.ts`'s Phase 3 reconstruction keeps an empty `statutory/`).
7. **Four routes, not three**: `GET …/{schemeId}/rate-tables` added so the verifier can read what it signs; both GETs
   use `requireAnyPermission([manage, verify])`. Every route 404s a scheme of another company; the load refuses a
   definition whose `scheme` ≠ the path scheme's code (400 at `/scheme`); a second verify is 409 `ERR_HR_SELF_VERIFY`.
8. Probe `expect` 403 (the T7 reason). The job probe's survivor counts the victim's rate tables **plus** its
   `rate_table_lapse_warning` audit rows, with the victim's company in the payload.
9. Tests updated for the shipped sub-pack: `seed-packs`, `seed/tax-pack`, `seed/templates`, `seed/reports`,
   `seed-idempotent` (applied gains `statutory: 10` / `0`), `seed/phase4-pack`; `hr/compensation`'s join case now
   seeds a real scheme (the 0084 FK refuses the fake id).

### Decisions

- Rows appended to `docs/review/2026-11-07-phase-8-decisions.md`: 0120, the fourth route, the insert hole, the
  same-company join, ADR 0073's status.
- ADR 0073 is **Proposed** (security/SoD), on the 0072 precedent. Its question 1: the API load does not refuse the
  test-fixture authority outside `dev` (the route layer has no `APP_ENV`); the second-principal verify is the control.

### Tests run (2026-11-07)

- Focused: db `hr/` (all 7 files), `seed/`, `seed-packs`, `seed-idempotent`, `migrations`, `migrate`, `schema-lint`,
  `export/tables`, `schema-mirror`, `privileges`, `permission-catalogue`, `review-guards` — green. domain whole suite
  **391 in 39 files**. contracts **69**.
- Whole suites on T10's tree: **`packages/db` 2,055 passed in 208 files**, **`apps/api` 952 passed in 98 files**,
  **`apps/worker` 125 in 19** plus its two Bun cases. The rest of the `tests` workspace and `bun run e2e` were not run. `tests`: `tenant-isolation`, `job-isolation`, `auth-bypass`, `lint-rules`,
  `hr-sensitive-side-channels` and **`regression/sah-047` — green (GC 19's exception closed)**.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  fourteen `scripts/check/*.sh` gates OK, `openapi.json` regenerated with no further diff.

### For the next agent (T11+)

- `statutory_scheme.employer_registration` is the OD-23 registration store (A3); T11's `company_hr_setting` has no blob.
- `hrFixture.schemeId` exists; the officer and checker both hold `hr.statutory_table.manage`, only the checker verify.
- `NEVER_EXPORTED` now also pins `statutory_scheme`, `statutory_rate_table` — T14 decides their rows.
- `record_system_event`'s closed list now has four names (0120); a further sentinel needs another tail number.

## 8A T11–T14 (2026-11-07)

### Built

- **T11** (`f4f37fd`, ⚠️ OD-23) — migration `0085_create_company_hr_settings.sql` (+ down): `app.company_hr_setting`
  (`proration_rule` ∈ {calendar_days, working_days} via `company_hr_setting_proration_rule_check`, `pay_day` 1–31 or
  null via `company_hr_setting_pay_day_check`, `unique (company_id)`), audited, **no row seeded**, no jsonb (A4).
  `packages/db/src/hr/settings.ts`: `readHrSetting`, `upsertHrSetting`, `employerRegistrations`,
  `setEmployerRegistration`, `CompanyHrSetting`, extra `ProrationRule` (barrel). Mirror `companyHrSettingTable`
  (mirror count **81**). Contracts `packages/contracts/src/hr/hr-setting.ts` (`ProrationRuleSchema`, `HrSettingSchema`,
  `UpdateHrSettingBody` (strict, registrations `.strict()`, `.max(50)`, registration `min(1)` or null), DTO types).
  Route `apps/api/src/routes/hr/hr-settings.ts` (`hrSettingRoutes`, `hrSettingRouteModule`,
  `GET|PUT /v1/companies/:companyId/hr-settings` under `admin.company.manage`), mounted in `buildRoutes`; one PROBES key
  (403); `openapi.json` regenerated; path added to `apps/api/test/openapi.test.ts`. Owner note
  `docs/owner/od-23-employer-registrations.md`; decisions row OD-23. Tests: db `hr/company-hr-setting` 11, api
  `routes/hr/hr-settings` 9.
- **T12** (`eb55a70`, ⚠️ OD-14) — `docs/owner/od-14-hr-facts.md` (four `> **Answer:** _(owner)_` lines; each fact's
  seam verified against the tree); decisions row OD-14. No code.
- **T13** (`efca5f3`, ⚠️ OD-24 — owner answered BUILD) — five screens in `apps/backoffice/src/routes/hr/`:
  `employee-record.tsx` (`EmployeeRecordRoute`; `/hr/employees/$employeeId?company=`, opened by a new **Open HR
  record** link in 6C's directory details; identity/bank panel behind its own fetch — 403 rendered as a sentence, 404 as
  an empty form; statutory profile panel), `compensation.tsx` (`CompensationPanel`, closed rows greyed,
  first-of-next-month default, close-then-open stated), `pay-components.tsx` (`PayComponentsRoute`, kind a two-value
  radio, rename / additive scheme joins / archive), `statutory-tables.tsx` (`StatutoryTablesRoute`, verify disabled
  with the rule named for the loader, read from `GET /v1/session`; JSON load with Ctrl+Enter), `hr-settings.tsx`
  (`HrSettingsRoute`). Support: `src/lib/hr-api.ts` (`hrApi`, `HrApi` — note `verifyTable`, not `verifyRateTable`:
  `no-number-money` flags a property named `*rate*` with a `number` parameter), `src/features/hr/shared.tsx`
  (`isForbidden`, `isNotFound`, `firstOfNextMonth`, `quantityToWire`, `useSubmit`), `StaffCompanyGate` in
  `src/components/staff-context.tsx`, four routes in `src/router.tsx`, three nav links. **124** catalogue keys
  (`hr.*`, `app.nav.payComponents|statutoryTables|hrSettings`) in `packages/i18n/catalogues/{en,ar}.json` — the tree
  has two flat catalogues, not the plan's `src/{en,ar}/hr.json`. Unit tests `apps/backoffice/test/hr.test.tsx` (16);
  e2e `tests/e2e/hr.spec.ts` (2 — en, ar); `tests/e2e/support/boot.ts` grants the operator the six 8A codes and
  seeds `E2E-HR` (an employee who is not the operator — R4), scheme `SYNTH` and two system-loaded unverified tables
  (v1 for the en run, v2 for ar); `E2E_HR_EMPLOYEE` in `support/people.ts`. Record `docs/ui/od-24-phase-8a.md`;
  decisions row OD-24.
- **T14** (`f57d224`) — six `— 8A` blocks appended with `sliceRegression` (the tree's helper; the plan's
  `thinRegression(…, ["8A T1"…], (ctx) => { it(…) })` shape does not exist) to sah-029/030/033/044/045/078.
  `packages/db/src/export/tables.ts`: rows for `employee_sensitive` (metadata only, `hr.employee.read_sensitive`),
  `employee_statutory_profile`, `pay_component`, `pay_component_scheme`, `compensation_line`
  (`hr.compensation.read`), `statutory_scheme`, `statutory_rate_table` (`hr.statutory_table.manage`), plus T11's
  `company_hr_setting` (ungated); the `employee` row gains `position`, `employment_type`, `archived_at`;
  `NEVER_EXPORTED.employee_sensitive` narrowed to the nine `*_enc` columns and the other six whole-table 8A pins
  removed. Test 32's export case appended to `tests/invariants/hr-sensitive-side-channels.test.ts` (runs
  unconditionally — 7C-FIRST). Handoff `docs/handoff/8a-to-8b.md`; decisions row for the export gates.

### Deviations from the plan (and why)

1. T11's PUT **binds every scheme id to the path company** before writing (404 `ERR_NOT_FOUND` otherwise; the
   employee-scope rule). The plan wrote whatever scheme id arrived. `UpdateHrSettingBody` and its items are
   `.strict()`. The PROBES `expect` is **403** (the T7 reason), not the plan's 404.
2. `company_hr_setting` is exported **ungated** (configuration, like `company`): `export/tables.test.ts` fails on an
   unclassified table, so T11 had to classify it; the registrations leave with `statutory_scheme`.
3. T13 built **five** screens (the plan's four plus T11's settings), and the company comes from 6C's staff-context
   picker (it carries `baseCurrency`, which a compensation amount needs). **Recorded limit:** a verify-only
   accountant is in no staff-context company, so the statutory-tables screen shows "no accessible company" to them —
   widening `/v1/staff-context` is a 6C contract change, not made.
4. T14's regression blocks were adapted to the tree: sah-029's `employee` audit row comes from an `update … set
   position` by `a.human` (6C's `seedEmployee` writes as the system principal, so the plan's "every actor is
   a.human" could not hold); sah-030 and sah-033 build no `fullRegression` (its label is hard-wired `— 0B`) —
   sah-030 starts its own API inside a `sliceRegression` body and stops it; sah-033 checks parameter **names** and
   schema **member** names against an anchored off-switch pattern (the plan's `JSON.stringify(doc).match(/level…/)`
   would match prose), and its non-holder is a company member with an empty role (so the zeros are the gates', not
   branch isolation's); sah-044's impostor is `b.human` (another tenant's principal, as 0B's block does).
5. Statutory schemes and rate tables are gated on `hr.statutory_table.manage` in the export (one code per row; the
   read route admits either code).

### Tests run (2026-11-07)

Whole suites on T14's tree (2026-11-07, Linux, Node 22, PostgreSQL 18 Testcontainers):
- **`packages/db` 2,066 passed in 209 files**; **`apps/api` 961 in 99**; **`apps/worker` 125 in 19** plus its two Bun
  cases; **`apps/backoffice` 242 in 13** (hr.test.tsx 16); `packages/domain` 391, `packages/contracts` 69,
  `packages/i18n` 41.
- **`tests`: 887 passed, 5 skipped, 1 failed in 138 files** after the fix below — the one failure is test 15's PDF
  hyphens (`zero-code-document-type`), the known pre-existing one. The first run also failed
  `invariants/role-catalogue.test.ts` (accountant pinned at **22**, now **23**): T2's `hr.statutory_table.verify`
  grant, never caught because no earlier 8A agent ran the whole `tests` workspace. Pin and comment updated in the T14
  progress commit. The six regression files 21/21; `hr-sensitive-side-channels` 5/5; `tenant-isolation` 55/55.
- **`bun run e2e` 27/27** (25 + `hr.spec.ts`'s two).
- Static: `bun run typecheck` 14/14, `lint` 0, `lint:rules` 11 rules 0 violations, `format:check` clean, all
  fourteen `scripts/check/*.sh` gates OK, `openapi.json` regenerated (T11) with no further diff.
- Not run: ui, edge, desktop, pos, sync, infra suites (untouched by T11–T14); the back-office build ran inside e2e.

### For the next agent (8B)

- Start from `docs/handoff/8a-to-8b.md`. Any new `app` table needs an `EXPORT_TABLES` row or pin in the same commit.
- `readHrSetting` returns null for every company until OD-23 is answered; default `calendar_days`.
- The e2e operator now holds every 8A code; an 8B screen spec can reuse `E2E-HR`, `SYNTH` and the boot grants.
- AGENTS.md's Current phase is untouched (8D rewrites it); 8D's rewrite must list 0080–0086 and the tail `0120` in
  "In the tree", and `docs/handoff/8a-to-8b.md`.

## 8B T1–T4 (2026-11-07)

### Built

- **T1 Step 1** (`84e0bd4`) — contracts **round 17** (end of `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`):
  the plan's A1–A16 (A15 and A16 were already folded into round 3 and are re-recorded) plus **A17** (eleven places
  the plan is stale against the tree). A3's in-place corrections applied to §4.3.4's `dimensions` comment and §4.4.1's
  semantics paragraph; A1/A2 to the §2.9 8B card. New gate `scripts/check/contracts-8b-amendments.sh`, wired into
  CI's `checks` job after the 8A step. **Later 8B tasks should re-run it first.**
- **T1** (`107d70e`) — migration `0087_create_payroll_run_line.sql` (+ down): `app.payroll_run` (PK `document_id`),
  `app.payroll_line` (PK `document_line_id`) with `payroll_line_amount_check`, `payroll_line_shape_check`,
  `payroll_line_override_check`, `payroll_line_change_draft_only` → `app.forbid_payroll_line_change_unless_draft()`;
  indexes `payroll_run_period_idx`, `payroll_line_employee_idx`, `payroll_line_scheme_idx`; stamps `calculated_by`,
  `entered_by`; audit keyed on the PKs. Both join lint-schema's `noId`. Mirrors `schema/payroll-run.ts` /
  `payroll-line.ts`, exported as **`payrollRunTable` / `payrollLineTable`** from `schema/index.ts` and as
  **`payrollRun` / `payrollLine`** from the main barrel (mirror count 83). Fixture **`seedPayrollRun`** (A6 options).
  Test `packages/db/test/payroll/tables.test.ts` (10).
- **T2** (`5d8814d`) — migration `0088_create_employee_dimension.sql` (+ down): `app.ensure_employee_dimension_type`,
  `app.ensure_employee_dimension_value`, `app.employee_dimension()` + trigger `employee_dimension_value`.
  `packages/db/src/hr/employee-dimension.ts`: `EMPLOYEE_DIMENSION_CODE`, `ensureEmployeeDimensionType`,
  `ensureEmployeeDimensionValue` (on the main barrel via `hr/index.ts`). ADR `0075` (**Proposed**). Test
  `payroll/employee-dimension.test.ts` (10).
- **T3** (`37d67ea`) — migration `0089_seed_permission_phase8b.sql` (+ down); four `PermissionDef` rows (phase `"8B"`);
  grants `hr_payroll` += read, prepare; `accountant` += read, approve, post; `auditor` += read.
  `MODULE_READ_CODE.hr = hr.payroll.read`; `POLICY_RESOLVED_CODES` += prepare/approve/post; the attachments route
  module (`apps/api/src/routes/index.ts`) declares `hr.payroll.read`. Export registry: `payroll_run`, `payroll_line`
  rows gated on `hr.payroll.read` (T1 had pinned them `["*"]`).
- **T4** (`039f7af`) — `packages/db/seed/my/chart-of-accounts/8b-payroll.json` (11 leaves + `2410` group),
  `packages/db/seed/my/document-types/PAYROLL.json` (seven rules, every one `dimensions.from: ["line.dimensions",
  "line.employee"]`, `approval.create = hr.payroll.prepare`, reversal refused, series `PAY`).
  `packages/db/src/hr/accounts.ts`: **`PAYROLL_ACCOUNT_CODES`**, **`linkPayrollAccounts(tx, companyId)`**,
  `PayrollAccountLinkage` (main barrel). `packages/db/src/seed/payroll-accounts.ts`: **`linkPayrollAccountsForTenant(sql,
  tenantId, companyId)`** (seed barrel only), `main(argv, env?)`; script `seed:payroll-accounts`; runbook
  `docs/runbooks/deploy.md` "Phase 8 deployment checks". ADR `0076` (**Proposed**). Test `payroll/accounts.test.ts` (11);
  `permission-catalogue.test.ts` gained an 8B block (4 cases).

### Deviations from the plan (and why)

1. **`0087.down.sql` restores the six-label kind union, not 2A's four** — 6A's 0061 always runs first here (A17.1).
2. **`payroll_line.entered_by` is filled by the write-once stamp only when the writer supplies a value.** T10/T11's
   override writer must insert `override_reason` together with a non-null `entered_by` (e.g. `app.current_actor()`); a
   reason alone fails `payroll_line_override_check`. T1's test proves both directions.
3. `seedPayrollRun` resolves the fiscal period from the effective date (plan always used `s.period`).
4. T1's test uses the seed's own `1000`/`4000` (`a.cash`, `a.sales`) — the plan's `seedAccount` calls collide with them.
   Its actor holds a company-wide role (Form A / branch isolation).
5. **Chart rows hang off 0C's type groups** (`1`, `2`, `5`; `2410` under `2`); the plan's were parentless (A17.8).
6. `linkPayrollAccounts` reads leaf accounts only; an EIS-style partial skip leaves both scheme columns null; a scheme §4.15
   has no row for (e.g. `SYNTH`) is named `scheme:SYNTH` — **so `linkPayrollAccountsForTenant` THROWS for any company
   that has the `SYNTH` test scheme.** T10's `payrollFixture` must either call `linkPayrollAccounts` (no throw) and accept
   the `scheme:SYNTH` entry, or set the SYNTH scheme's two accounts by hand first (the plan already says the fixtures set
   `1400` by hand).
7. `accounts.test.ts` reads the permission catalogue from `app.permission` (dependency-rule forbids `@dulja/contracts` in
   `packages/db` tests except `permission-catalogue.test.ts`, where the PAYROLL-policy case lives).
8. 2C's attachment-map test is property-shaped already: one positive `hr` case added, nothing rewritten (A17.7).
9. ADRs 0075 and 0076 are **Proposed** (plan: 0075 Accepted).

### Decisions

- Rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (0087's down, the export rows, ADR 0075, the `hr`
  attachment row, ADR 0076, the chart placement).
- Gate script added although the plan has no Task 0 (rounds 14–16 precedent).
- **Recorded, not changed:** `document_line` and `ledger_entry` export ungated, so a PAYROLL's line amounts leave with
  them regardless of `hr.payroll.read` — 8D's export/test-32 question.

### Tests run (2026-11-07)

- **`packages/db` whole suite on T4's tree: 2,102 passed in 212 files** (T2's tree: 2,086 in 211).
- **`apps/api` whole suite: 961 passed, 1 failed in 99 files** on T4's tree — the failure was
  `routes/accounting/documents.test.ts`'s `DOCUMENT_STAGE_CODES` pin (T3's three codes), fixed in the progress commit;
  the file re-run 26/26.
- **`tests` workspace: 887 passed, 5 skipped, 1 failed in 138 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. role-catalogue (accountant 26, auditor 10) and sah-047 green.
- `packages/contracts` 69. Focused: api `middleware/*`, `routes/admin/*`, `routes/hr/*`, `openapi` green; `openapi.json`
  regenerated with no diff (T3 adds no route).
- Static on T4's head: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations** (no declared
  exception needed: T3's map rows reference all four codes), `format:check` clean, `contracts-8b-amendments.sh` OK.
- **`apps/worker` 125 passed in 19** (Vitest) and **`bun run e2e` 27/27** on T4's tree.

### For the next agent (T5+)

- `@dulja/domain`'s `"./payroll"` subpath and `payroll/index.ts` exist (8A) — T5 **appends** to the barrel (A8).
- `PAYROLL` seeds into every tenant through `--only document-types`; `seedPayrollRun` needs it seeded in the test tenant.
- `ensureEmployeeDimensionValue(tx, companyId, employeeId)` binds the employee to the company.
- `MODULE_READ_CODE.hr` is done (8A handoff item 4).

## 8B T5–T8 (2026-11-07)

### Built

- **T5** (`14e8e3a`) — `packages/domain/payroll/`: `errors.ts` (`PayrollCalculationError` with `code`/`detail`,
  `PayrollErrorCode`), `types.ts` (§4.12.1 verbatim: `EmployeePeriodInput`, `PayPeriod`, `RateTableRef`,
  `SchemeResult`, `EmployeeResult`, `PayrollCalculator`, `SchemeCalculator`, plus `RateTableKind`, `BandedTable`,
  `PercentageTable`, `ProgressiveTable`), `schemes/{banded-contribution,percentage-with-ceiling,progressive-schedule,
  index}.ts` (`calculators`) and an extra **`schemes/shape.ts`** (`DEFAULT_ROUNDING_MODE`, `modeOf`, `nameOf`,
  `shapeMismatch`, `missingInput`, `assertRequiredInputs`, `within`; not on the barrel). The barrel is **appended**
  (8A's exports intact); `"./payroll"` was already present (asserted). `no-number-money` `ALLOWED` += `rateTableVersion`
  (A14). ADR `0074` (**Proposed**). Tests: domain `payroll/schemes` 9; sah-019 8B block 2.
- **T6** (`8b0b4df`) — `payroll/period.ts` (`periodDays`, `eligibleDays`; constants exactly `MS_PER_DAY`, `SUNDAY`,
  `SATURDAY` — sah-020 pins them), `payroll/calculator.ts` (`payrollCalculator`, `prorationFactor`, `ytdKey`,
  `schemeYtdKey`, re-exports `periodDays`/`eligibleDays`; all on the barrel). `ERRORS` += `ERR_PAYROLL_RATE_TABLE_UNVERIFIED`,
  `ERR_PAYROLL_INPUT_MISSING` (both 422, pinned in `packages/contracts/test/contracts.test.ts`); `apps/api/src/problem.ts`
  maps `PayrollCalculationError` in the `ReportError` branch (+ a `problem.test.ts` case). sah-011 and sah-020 8B blocks.
  Tests: domain `payroll/calculator` 18.
- **T7** (`84f9e8e`, ⚠️ OD-28) — `packages/domain/test/payroll/proration.test.ts` (6 passed, 2 skipped — the two
  `OD-28 CONFIRMED …` gate cases); owner record **`docs/owner/od-28-proration-rule.md`** (three `> **Answer:**` lines:
  (a) rule, (b) holidays, (c) joiner vs leaver, each with its exact cost); decisions row. No production change.
- **T8** (`51d029a`, ⚠️ OD-14) — `packages/domain/test/payroll/hourly.test.ts` (1 skipped; passes when un-skipped);
  an "8B" section appended to `docs/owner/od-14-hr-facts.md` (its four Answer lines unchanged); decisions row.

### Deviations from the plan (and why)

1. **ADR 0074 is Proposed** (plan: Accepted) — it fixes how every payroll figure is derived (money, spec:95). It was
   written in T5 as the plan places it.
2. **Intermediate arithmetic uses `@dulja/domain`'s `D`** (decimal.js cloned at precision 40), not the global
   `Decimal` (precision 20) the plan imported — the package's own rule (`src/money/decimal.ts`).
3. **Shape check:** the schema's `table` `oneOf` does not depend on `kind`, so a mismatched definition validates;
   each calculator refuses it with **`RateTableValidationError`** (`ERR_VALIDATION_FAILED`) rather than reading
   `undefined`.
4. **`required_profile_fields` is enforced in all three kinds** (`assertRequiredInputs`), not only where a
   progressive relief happens to read the field. Message: `rate table <CODE> v<n> requires statutory input '<f>' and
   the value is null|absent`.
5. **`calculate` re-raises a scheme calculator's refusal naming the employee**: `employee <id>: <scheme message>`
   (test 33: "naming the employee"). The component and table-gate messages are the plan's, verbatim, **except**
   the no-compensation one ends "…a run cannot compute a currency **out of** nothing" — `no-sql-concat` reads
   "from" inside a substituted template literal as SQL.
6. **A manual override on a scheme the employee does not feed refuses** (`ERR_PAYROLL_INPUT_MISSING`, "employee <id>
   has a manual <share> override on scheme <schemeId> and no earning feeding that scheme; remove the override or
   join a component to the scheme"). The plan skipped it silently. **T10/T11 must not hand `calculate` an override
   for a scheme that produced no line**, and R3 recalculation after a compensation change that drops a scheme's
   base stops here until the officer clears the override.
7. **Dates:** `period.ts` validates through `isCalendarDate` (an impossible date is a `RangeError`, never rolled
   over); an inverted period and a period in which the rule counts no day (a weekend under `working_days`) are
   `RangeError`s. Calendar day counts use exact division, no `Math.round`.
8. **A16 is moot:** `error-codes` has no root list (it reads all of `apps`, `packages`, `scripts` via
   `scripts/lint/source.ts`), so `packages/domain/payroll/**` was already read. A comment in the rule and a
   `scripts/lint/lint.test.ts` case pin it.
9. sah-020's literal scan covers **`schemes/shape.ts`** too and additionally fails if a new file appears under
   `packages/domain/payroll/` that is not in its list (period/rate-table/validate excepted).
10. Test messages in T6 avoid authority names ("authority letter on file", not the plan's LHDN wording).

### Decisions

- Rows appended to `docs/review/2026-11-07-phase-8-decisions.md`: ADR 0074 and its four hardenings; the override
  refusal; A16; OD-28 proration (default `calendar_days`, `working_days` selectable, holidays not subtracted); OD-14
  at 8B (record only).
- The two OD-28 gate cases and the OD-14 hourly case are the plan's `it.skip` owner gates (not quarantined tests);
  the domain suite now reports **3 skipped**.

### For the next agent (T9+)

- Import everything from `@dulja/domain/payroll`: `payrollCalculator`, `prorationFactor`, `periodDays`,
  `eligibleDays`, `ytdKey`, `schemeYtdKey`, `calculators`, `PayrollCalculationError`, and the §4.12.1 types.
- `RateTableRef.definition` should carry the scheme row's `rounding_mode` when the stored definition omits it
  (ADR 0074); the calculator otherwise defaults to `HALF_AWAY_FROM_ZERO`.
- `PayPeriod.prorationRule` comes from `readHrSetting(tx, companyId)?.prorationRule ?? "calendar_days"`.
- The calculator throws `RangeError` (→ 500) for a malformed period; T10's route should validate dates with
  `DateSchema` so that never reaches it.
- `SchemeResult.roundingMode` is `modeOf(definition)` (the declared or default mode).

### Tests run (2026-11-07, on T8's tree `51d029a`)

- **`packages/domain` whole suite: 424 passed, 3 skipped in 43 files** (42 passed, 1 skipped — `hourly.test.ts`);
  `payroll/` alone: schemes 9, calculator 18, proration 6 + 2 skipped, hourly 1 skipped, plus 8A's rate-table and
  dependency files.
- **`apps/api` whole suite: 963 passed in 99 files** (incl. the new `problem.test.ts` case).
- **`tests` whole workspace: 894 passed, 5 skipped, 1 failed in 138 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. sah-011/019/020 and `scripts/lint/lint.test.ts` green.
- `packages/contracts` 69.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  fifteen `scripts/check/*.sh` gates OK. No route changed, so `openapi.json` was not regenerated.
- Not run: `packages/db`, `apps/worker`, `bun run e2e` (nothing they load changed beyond the `@dulja/domain/payroll`
  barrel's additive exports, which `packages/db` typechecks against).

## 8B T9–T10 (2026-11-07)

### Built

- **T9** (`4ff048a`) — `packages/db/src/posting/load.ts`: `loadSnapshot` fills `refs.components` (the company's live
  `pay_component` rows → core's `PayComponentRef`), `refs.schemes` (`statutory_scheme` rows whose payable account is
  set → `SchemeRef`, `expenseAccountId` = `employer_expense_account_id`) and `LineSnapshot.payroll` (one query per
  document over `payroll_line`, EMPLOYEE `dimension_value` resolved by `employee_number`). No signature change, no
  evaluator branch (A11's first outcome — 8A filled none). A payroll line with no visible EMPLOYEE value raises
  `PostingError("ERR_POLICY_REQUIRES_MISSING", …)` naming the line. Test `payroll/snapshot.test.ts` (6).
- **T10** (`e2c0824`) — the run service and the route module:
  - `packages/db/src/hr/inputs.ts`: **`loadPayrollInputs(tx, LoadInputsOptions)`** → `PayrollInputs` (the plan's
    shape **plus `rateTableIds: Record<schemeId, statutory_rate_table.id>`**).
  - `packages/db/src/hr/run.ts`: **`calculatePayrollRun(tx, ctx, CalculateRunInput)`**,
    **`recalculatePayrollRun(tx, ctx, documentId, scope?)`**, **`readPayrollRun(tx, documentId, scope?)`** — the
    optional `scope: RunScope = { companyId? }` binds a read/recalculation to a company (404 otherwise); types
    `PayrollRunResult`, `PayrollRunDetail`, `PayrollRunLine`, `PayrollRunStatus`, `PayrollRunKind`, `RunScope`.
  - `packages/db/src/hr/run-error.ts`: **`PayrollRunError`** (`code` ∈ `ERR_NOT_FOUND`, `ERR_DOC_NOT_DRAFT`,
    `ERR_PERIOD_NOT_FOUND`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_RBAC_FORBIDDEN`, `ERR_VALIDATION_FAILED`; all existing
    `ERRORS` rows; `problem.ts` maps it through `fromDomainError`, no edit there).
  - `packages/db/src/hr/ytd.ts`: **`ytdFromPostedLines(tx, companyId, year, employeeIds)`** (parameter renamed from
    `taxYear`: `no-number-money` reads `tax`; calendar year, posted documents only).
  - All on the main barrel via `hr/index.ts`.
  - `packages/contracts/src/hr/payroll-run.ts`: `PayrollRunKindSchema`, `PayrollRunStatusSchema`, `PayrollLineSchema`,
    `PayrollRunSchema`, `CreatePayrollRunBody` (strict; refuses `employeeIds` on `regular`, inverted dates),
    `SetPayrollOverrideBody` (defined for T11, not yet mounted), `PayrollRunQuery` (strict), `PayrollRunListItem`,
    `PayrollRunList`.
  - `apps/api/src/routes/hr/payroll-runs.ts`: **`payrollRunRoutes`, `payrollRunRouteModule`** at
    `/v1/companies/:companyId/payroll-runs` — `POST /` (prepare, 201 detail), `POST /{documentId}/recalculate`
    (prepare), `GET /{documentId}` (read), `GET /` (read; keyset on `(period_start, id)` desc). Mounted in
    `buildRoutes` after `hrSettingRouteModule`. No transition route. `openapi.json` regenerated (+4 operations).
  - `tests/invariants/support/payroll.ts` (A7): `PAYROLL_PACK_ROOT`, `SYNTH_TABLE` (= 8A's `SYNTH_RATE_TABLE_V1`; T12's
    file does not exist yet), `PayrollFixture`, `payrollFixture`, `postPayrollRun`, `secondApprover`.
  - `tests/invariants/probes.ts`: one `PROBES` entry (expects **403**).
  - Tests: `packages/db/test/payroll/run.test.ts` (13), `apps/api/test/routes/hr/payroll-runs.test.ts` (11).

### Deviations from the plan (and why)

1. **Errors are `PayrollRunError`, not `new Error("ERR_…: …")`** — a bare Error has no `code` and answers 500.
2. **The preparer must hold `hr.compensation.read`** (refused up front, `ERR_RBAC_FORBIDDEN`): 8A's RESTRICTIVE
   `compensation_gate` would otherwise hide every compensation line. `payrollFixture` therefore grants `s.human`
   `hr.compensation.read` (a company-wide role — also what 6C's `branch_isolation` on `employee` needs). **Every later
   test that calculates as some principal must grant it `hr.compensation.read` too** (T11's recalculation test grants
   only prepare + compensation.manage: add compensation.read, or rely on `payrollFixture`'s grant to `s.human`).
3. **Compensation per component = the line in force at period end** (`distinct on (component_id) … effective_from
   desc`); the plan's `group by … amount` paid a mid-period raise twice.
4. **Refused before any insert:** malformed/inverted period, pay date before the period, a no-day period under the
   proration rule (`RangeError` → 422 `ERR_VALIDATION_FAILED`), an empty run, a named employee not employed in the
   period, a negative net pay. An override line is written even when its share is zero (reason survives).
5. **`payrollFixture`**: principals minted like 8A's `hrFixture` (`app.principal` has no `tenant_id`); role codes use
   the uuid TAIL; `SYNTH_TABLE` is 8A's constant; `pay_component_scheme` inserted once (not per employee).
6. **Route:** detail and recalculate pass `{ companyId }`; the list query is `.strict()` (a flat parameter → 400; the
   plan's test said 200 — 8A's query precedent wins); the PROBES entry seeds via `seedDocumentType` + `seedEmployee` +
   `seedPayrollRun` (not `payrollFixture`, whose `BR2` branch and `E-0001` would collide with other probes on the
   shared victim tenant) and expects **403** (plan: 404) — the 8A probes' reason.
7. **No overrides route yet** — it calls T11's `setStatutoryOverride`. **T11 adds `POST /{documentId}/overrides`**
   to `apps/api/src/routes/hr/payroll-runs.ts` with `SetPayrollOverrideBody` (already in the contracts module),
   bound to the path company, and regenerates `openapi.json`.
8. Dates are validated in the service (`isCalendarDate`) and at the wire (`DateSchema`), per the T5–T8 note.

### Decisions

- Rows appended to `docs/review/2026-11-07-phase-8-decisions.md`: T9's nullable-account handling; the mid-period
  compensation rule; the compensation-read requirement; the refusals; the wire shape; and
  **`compensationChangedBy` is empty for a reader without `hr.compensation.read`** (the seeded `accountant`/approver) —
  proposed fix: a bounded `SECURITY DEFINER` lookup (who/employee/date, never amounts) in **T11's migration 0090**.

### For the next agent (T11+)

- `recalculatePayrollRun(tx, ctx, documentId)` reads the run's OWN overrides (`override_reason is not null` on its
  draft lines) BEFORE deleting the lines; the override line insert sets `entered_by = app.current_actor()` whenever
  `override_reason` is set. `setStatutoryOverride` should UPDATE the target line's `amount`/`override_reason`/
  `entered_by` on the draft and then call `recalculatePayrollRun` (the calculator applies the override).
- `postPayrollRun` needs `s.human` to hold `hr.payroll.prepare` (grant it in the suite); `f.approver` holds
  approve/post/read.
- `seedRateTable(…, { version: 2, verified: false })` opens 2026-01-01; move it away by updating `effective_from` as
  the tenant's system principal (`withTenant(db.migrator, s.tenant, s.system, …)`) — `db.admin` writes fail the
  audit trigger's RLS.

### Tests run (2026-11-07, on T10's tree + the openapi pin)

- **`packages/db` whole suite: 2,121 passed in 214 files** (payroll: snapshot 6, run 13).
- **`apps/api` whole suite: 973 passed, 1 failed in 100 files** — the failure was `test/openapi.test.ts`'s pinned path
  list (the three new payroll-runs paths), fixed in the progress commit; the file re-run 3/3. Route file 11/11.
- **`tests` whole workspace: 895 passed, 5 skipped, 1 failed in 138 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. `tenant-isolation` 56/56 (the new probe included).
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations** (no `ALLOWED` entry added —
  `taxYear` was renamed `year`), `format:check` clean, all fifteen `scripts/check/*.sh` gates OK; `openapi.json`
  regenerated and committed (re-generation gives no diff).
- Not run: `apps/worker`, `bun run e2e`, `packages/domain` (none of them load anything T9/T10 changed).

## 8B T11–T15 (2026-11-07)

### Built

- **T11** (`62005f6`) — migration **`0090_create_compensation_change_returns_run.sql`** (+ down):
  `app.return_runs_for_compensation(employee, from, to)` and `app.compensation_change_returns_run()` + trigger
  **`compensation_line_returns_run`** (AFTER INSERT/UPDATE/DELETE; evaluates the NEW and the OLD window; returns every
  `submitted`/`approved` run the employee is on to draft with reason `compensation_changed`; posted runs untouched).
  Also the bounded lookup **`app.compensation_changes_in_period(company, from, to)`** → `(principal_id, employee_id,
  effective_from)`, `app_auth`-owned `SECURITY DEFINER`, answered to `hr.payroll.read` or `hr.compensation.read`;
  `compensation_gate` re-created `to app_rw, app_migrator`; `app_auth` gains SELECT on four `compensation_line`
  columns and `role_permission(tenant_id, role_id, permission_code)`. `packages/db/src/hr/override.ts`:
  **`setStatutoryOverride(tx, ctx, SetOverrideInput, scope?)`**, **`listOverrides(tx, documentId, scope?)`**,
  `OverrideRow` (plan's shape + `schemeId`, `enteredByName`), `SetOverrideInput` (main barrel). `run.ts`:
  **`recalculateWith(tx, ctx, documentId, scope, pending?)`** (internal, not on the barrel) and `PendingOverride`;
  `recalculatePayrollRun` now returns a **submitted** run to draft (reason `recalculated`) before recalculating and
  refuses approved+. `readPayrollRun` adds **`overrides`** and each line's **`componentCode`/`schemeCode`**, and
  reads `compensationChangedBy` through the lookup. Contracts: `PayrollOverrideSchema`; `PayrollLineSchema` +
  `componentCode`, `schemeCode`; `PayrollRunSchema` + `overrides` (omitted from the list item);
  `SetPayrollOverrideBodyDto`. Route **`POST /{documentId}/overrides`** (prepare, 200 detail). `openapi.json`
  regenerated; `openapi.test.ts` pins the path. Tests: `packages/db/test/payroll/recalculation.test.ts` (16);
  `run.test.ts`'s submitted-recalc case updated; API route file +3 cases (14).
- **T12** (`8de8332`) — `packages/db/seed/test/statutory/SYNTH/v1.json` (= `SYNTH_RATE_TABLE_V1` but for the
  `source` prose, asserted); `packages/db/test/payroll/synth-guard.test.ts` (5); `docs/owner/od-23-employer-
  registrations.md` gains "What 8B adds".
- **T13** (`98ffe4f`) — `tests/golden/payroll.test.ts` (+ `golden:payroll` script, `GOLDEN_WRITE=1`) and three cases
  `tests/golden/payroll/{synth-regular,synth-proration,synth-missing-input}/{input,expected}.json`, reviewed figure by
  figure; `tests/invariants/payroll-one-posting-path.test.ts` (test 28, 2); `JournalLine.dimensions` in
  `tests/invariants/support/post-journal.ts` (A13); 8B blocks in sah-003 (1) and sah-009 (2).
- **T14** (`aa0c44f`) — `tests/invariants/payroll-pinning.test.ts` (9: test 29 ×4, test 38, test 9, test 31 ×2,
  test 10); 8B blocks in sah-013, sah-031, sah-032, sah-042.
- **T15** (`9198117`, ⚠️ OD-24 — owner: BUILD) — `apps/backoffice/src/lib/payroll-api.ts` (`payrollApi`),
  `src/routes/hr/payroll-runs.tsx` (`PayrollRunsRoute`, register + new run; exports `monthOf`, `statusKey`,
  `kindKey`, `RUN_STATUSES`), `src/routes/hr/payroll-run.tsx` (`PayrollRunRoute`, the approval screen), routes
  `/hr/payroll-runs` and `/hr/payroll-runs/$documentId?company=` in `router.tsx`, nav link `app.nav.payrollRuns`,
  `payroll.*` keys (en/ar); `apps/backoffice/test/payroll.test.tsx` (15); `tests/e2e/payroll.spec.ts` (2, en/ar);
  `tests/e2e/support/boot.ts` seeds `payrollFixture` + two submitted supplementary runs by a second principal and
  grants the operator the four `hr.payroll.*` codes; `hr.spec.ts`'s settings assertion uses `arrayContaining`.
  `/v1/staff-context` gains **`hr.payroll.read`** (route + `listStaffContext` SQL + test; AGENTS.md's sentence now says
  seven codes). `docs/ui/od-24-phase-8b.md`. Slice handoff **`docs/handoff/8b-to-8c.md`**.

### Deviations from the plan (and why)

1. **The override is an input to an immediate recalculation, not an UPDATE** of the line: `entered_by` is a
   write-once stamp, so the plan's UPDATE raises `ERR_ACTOR_IMMUTABLE` when a second principal corrects an
   override. Errors are `PayrollRunError` (the plan threw bare `Error("ERR_…")` → 500). The plan's `ERR_INTERNAL` for
   ">1 line" is `ERR_VALIDATION_FAILED`. Extra refusals: foreign currency, negative amount, blank reason.
2. **R3 evaluates OLD and NEW** (the plan's `coalesce(new, old)` missed a line moved out of a period).
3. **The plan's R3 test inserted a second OPEN line** for one (employee, component), which 0083's one-open-line
   index refuses; the test closes the old line first. The "posted" case posts through `postDocument` (the plan's
   `db.admin` status shortcut would hit 2B's trigger).
4. **T12's guard is adapted to 8A's tree** (`packages/db/seed/my/statutory/` is not empty: 8A's catalogue files and
   four `.gitkeep`s); it asserts no rate table there. Validation uses `validateRateTable`, not a direct Ajv import.
   The JSON keeps `effective_from 2026-01-01` and padded bands to equal the fixture constant.
5. **T13:** `GOLDEN_WRITE=1` (repo mechanism), not `UPDATE_GOLDEN`; refusal is detected as an outcome; input gains
   optional `components[].quantityBased`; test 28 uses a `supplementary` run; the dimension multiset is keyed per row.
6. **T14:** no `startWorker().run(fn)` exists — the job legs run under `systemContext` + production `withTenant`
   (exactly `runJob`'s context). **The plan's leg "a system principal that did not submit is refused approval with
   ERR_RBAC_FORBIDDEN" is not written**: spec:2179 makes `actor_has` true for it. Test 10's raw-SQL leg is omitted
   (`approved → posted` is not a matrix edge). SAH-042's stranger has an empty company-wide role → R2's
   `ERR_RBAC_FORBIDDEN`, pinned exactly.
7. **T15 was built** (owner answer) where the plan defaulted to blocked; the plan's `src/screens/PayrollApproval.tsx`
   path follows the tree's layout instead (`src/routes/hr/payroll-run{,s}.tsx`, tests under `apps/backoffice/test/`).

### Decisions

Rows appended to `docs/review/2026-11-07-phase-8-decisions.md`: the 0090 lookup (**a security widening, the eighth**,
for the owner's review — 8D should add it to AGENTS.md's list when it rewrites Current State), R3's old/new windows
and its writer-visibility limit, the submitted-recalc rule, the override mechanics (and the limit that a later
recalculation re-stamps `entered_by` to the recalculator — the audit trail keeps the original), OD-23 at 8B, the
golden harness, the T14 job legs, OD-24 for the payroll screens, the staff-context widening, the e2e stack.

### For the next agent (8C/8D)

- Read `docs/handoff/8b-to-8c.md`. `ytdFromPostedLines` is the single call site to swap for `employee_ytd`.
- `payrollFixture` is not idempotent; the e2e tenant now carries it (EPF, E-0001, E-0002, BR2, `Payroll principal …`
  members), so an 8C/8D e2e spec reuses it rather than calling it again.
- A test that edits `compensation_line` while a run of that employee is submitted/approved now bounces the run (R3).
- AGENTS.md "Current State" still lacks: the 0090 widening, 8B's ADRs 0074–0076 in the awaiting list, 8B's known
  limits (R3 writer visibility; override `entered_by` re-stamp). 8D's rewrite should fold them in.

### Tests run (2026-11-07, on T15's tree `9198117`)

- **`packages/db` whole suite: 2,142 passed in 216 files** (payroll: recalculation 16, synth-guard 5, run 13).
- **`apps/api` whole suite: 977 passed in 100 files** (payroll-runs 14, staff-context 5, openapi 3).
- **`apps/backoffice` whole suite: 257 passed in 14 files** (payroll 15).
- **`tests` whole workspace: 917 passed, 5 skipped, 1 failed in 141 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. Golden payroll 4 (3 cases + layout), test 28 2,
  payroll-pinning 9, sah-003/009/013/031/032/042 green.
- **`bun run e2e`: 29/29** (payroll 2 new; hr 2 with the `arrayContaining` change).
- `packages/contracts` 69, `packages/i18n` 41.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  fifteen `scripts/check/*.sh` gates OK; `openapi.json` regenerated with no diff.
- Not run: `apps/worker` and `packages/domain` (nothing they load changed).

## 8C T1–T4 (2026-11-07)

### Built

- **T1 Step 1** (`df2da8d`, `730c679`) — contracts **round 18** (end of the contracts document): the plan's B1–B15
  plus **B16** (seven places the plan is stale against the tree). In-place corrections: §2.9's 0091 name (B1), §4.2.6's
  sentinel paragraph (B2, `employee_ytd_drift`) and `JobPayload` block (B4), §4.16.3 (B5), §4.12.8 (B6/B7/B14), §4.6.1's
  `statutory_schedule` row (B11), §4.2.4's code table (B13, `ERR_HR_CASHIER_NOT_EMPLOYEE`). Gate
  **`scripts/check/contracts-8c-amendments.sh`**, wired into CI after the 8B step. B15: `dependency-rule`'s
  `ESCAPE_ALLOW` gains `packages/db/test/` → `tests/support/` (the `tests/invariants/support/` half was 3B's) and
  `packages/db/tsconfig.json` includes `../../tests/support/**/*.ts`.
- **T1** (`d935297`) — migration `0091_create_statutory_schedule_and_remittance_guard.sql` (+ down):
  `app.statutory_schedule` (B11's `currency`, stamped `generated_by`, constraint
  `statutory_schedule_scheme_period_run_key`), audited; `app.assert_remittance_matches_schedule()` + trigger
  `statutory_schedule_remittance_guard` (BEFORE INSERT OR UPDATE OF remittance_document_id, total_employee,
  total_employer). `ERR_PAYROLL_REMITTANCE_MISMATCH` (422) in `ERRORS` + contracts pin. Mirror
  `statutorySchedule` (main barrel) / `statutoryScheduleTable` (schema index); mirror count **84**. Export row
  gated `hr.payroll.read`. Test `packages/db/test/hr/statutory-schedule-table.test.ts` (10).
- **T2** (`ae43b13`) — migration `0092_create_employee_ytd.sql` (+ down): `app.employee_ytd` (PK `(company_id,
  employee_id, tax_year)`, no audit), `app.employee_ytd_opening` (audited, stamped `loaded_by`, unique
  `employee_ytd_opening_natural_key`), `app.employee_ytd_delta(uuid)`, `app.jsonb_add_money`, `app.jsonb_add_scheme`,
  `app.jsonb_add_money_agg`, `app.jsonb_add_scheme_agg` — all of 0092 in one file. `lint-schema.ts`: `employee_ytd`
  joins **`noId`, now exported** (`export const noId`). Mirrors `employeeYtd`, `employeeYtdOpening` (and
  `…Table` aliases); count **86**. Export rows for both tables, gated `hr.payroll.read`. ADR **0077** (**Proposed**, one
  owner question — the tax-year convention). Test `hr/employee-ytd-table.test.ts` (12).
- **T3** (`8a14a35`) — `packages/db/src/posting/ytd.ts`: **`mergeEmployeeYtd(tx, documentId)`** →
  `EmployeeYtdMergeResult` (on the main barrel via `posting/index.ts`), called unconditionally in `postDocument` step 12
  after the stock MERGE. `packages/db/src/hr/ytd.ts`: **`ytdFromEmployeeYtd(tx, companyId, year, employeeIds)`** →
  `{ [employeeId]: { gross: Money, net: Money } }` = projection + opening (B14). Test `hr/ytd-merge.test.ts` (11).
- **T4** (`11d8bd4`) — migration `0095_seed_permission_phase8c.sql` (+ down); `hr.payroll.pay`, `hr.advance.create`
  (phase `"8C"`, mutating) in `permissions.ts`; `hr_payroll` += both; `POLICY_RESOLVED_CODES` += both (so
  `DOCUMENT_STAGE_CODES` and its pin in `apps/api/test/routes/accounting/documents.test.ts` gain them). Tests:
  `hr/permissions-8c.test.ts` (3), an 8C block in `permission-catalogue.test.ts` (3), `roles-seed.test.ts` 8B case
  extended.

### Deviations from the plan (and why)

1. **Round 18, not "Round 3"** (rounds 16/17 precedent), with a B16 staleness item list and a gate script.
2. **T1's test posts its remittance through the real `postJournal`** (credit `1100`, debit `1000`) instead of
   hand-writing two `ledger_entry` rows, and uses `draftDocument` for the run shell. Two extra cases: an INSERT that
   arrives settled for the wrong amount, and moving a settled row's totals (both refused).
3. **The guard also refuses a payment of another company** of the tenant (the composite FK bounds only the tenant;
   a zero-total schedule could otherwise be "settled" by any posted document of a sibling company). Variable
   `status` renamed `doc_status` (it shadowed nothing, but reads better beside `doc_company`).
4. **`jsonb_add_scheme` sums in a subquery** — the plan's body nested `sum()` inside `jsonb_object_agg` (42803) — and
   fills a missing share with `0.0000`.
5. **T2's delta test uses a real posted run** (`payrollFixture` + `postPayrollRun`; SYNTH figures 2000/50/100 →
   net 1950) instead of hand-inserted `posted` rows, plus a draft-run case and direct cases for the four jsonb
   helpers/aggregates. `noId` is the tree's name (B16.1); `AUDIT_EXEMPT` and `posting-only-tables` already listed
   `employee_ytd` (B16.2 — only the rule's comment changed).
6. **`mergeEmployeeYtd` takes sorted `ytd:<company>/<employee>/<year>` advisory locks** before the MERGE (B16.7, the
   A4 reasoning); tenant comes from `app.current_tenant()`.
7. **`ytdFromEmployeeYtd`'s parameter is `year`, not `taxYear`** (`no-number-money` reads `tax`).
8. **`ytdFromPostedLines` is NOT swapped** for the projection (the 8B handoff suggested it): the calculator's
   `ytdBefore` is keyed per component/scheme share, which the headline read does not carry — ADR 0077's own
   consequence. Its doc comment now says so.
9. **T4's catalogue case is in `permission-catalogue.test.ts`**: a `packages/db` test other than that file may not
   import `@dulja/contracts` (B16.3). The F-21 case in `apps/api/test/routes/admin/document-types.test.ts` now names
   **8D's `hr.filing.generate`** — 8D must move it again when it seeds that code.

### Decisions

Rows appended to `docs/review/2026-11-07-phase-8-decisions.md`: round 18, the guard's company check, ADR 0077, the
MERGE lock, the unswapped calculator read, the F-21 move.

### Tests run (2026-11-07, on T4's tree `11d8bd4`)

- **`packages/db` whole suite: 2,181 passed in 220 files.**
- **`apps/api` whole suite: 977 passed in 100 files.**
- **`tests` whole workspace: 917 passed, 5 skipped, 1 failed in 141 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. role-catalogue, sah-032, sah-047 green.
- `apps/worker` 125 in 19 (Vitest), `packages/contracts` 69.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **sixteen** `scripts/check/*.sh` gates OK; `openapi.json` regenerated with no diff (no route changed).
- Not run: `bun run e2e`, `packages/domain`, the UI workspaces (nothing they load changed).

### For the next agent (T5+)

- `tests/invariants/support/payroll-money.ts` (B3) does not exist yet — T6 creates it.
- `postDocument` now MERGEs `employee_ytd` on every PAYROLL post; any test that posts a run sees rows there.
- The guard compares the payment's `1100` leg to `total_employee + total_employer`; one PAYMENT settles one schedule.
- T9's rebuild must admit `employee_ytd_drift` through `app.record_system_event`'s closed list — that needs a tail
  migration number after 0111 (the 8A `0120` precedent), since 0091–0095 sort before 0105/0111; register it in
  §3.4.1 in the same change.
- AGENTS.md (8D's rewrite) must list `0091`, `0092`, `0095` in "In the tree" and ADR 0077 in the awaiting list.

## 8C T5–T6 (2026-11-07)

### Built

- **T5** (`94a2978`) — `packages/db/seed/my/document-types/PAYROLL_PAYMENT.json` (series `PAYB`, create
  `hr.payroll.pay`) and `EMPLOYEE_ADVANCE.json` (series `ADV`, create `hr.advance.create`): module `hr`, direction
  `outbound`, one `each_line` debit rule (`{ "code": "2400" }` / `{ "code": "1400" }`, `line.amount`, `when line.kind =
  payroll`, `dimensions.from: ["line.dimensions"]`) and one `for: "document"` credit to `{ "code": "1100" }` at
  `document.total_excl_tax`; `dimensions.required: ["BRANCH"]`; approval `required` with `accounting.payment.approve` /
  `.post`; `reversal.allowed: true` (B8). Test `packages/db/test/hr/money-out-types.test.ts` (9). Document-type pins
  moved: `seed/document-types.test.ts` (two rows) and `seed-idempotent.test.ts` (**25 → 27**).
- **T6** (`d06b361`) —
  - `packages/db/src/hr/money-out.ts` (main barrel via `hr/index.ts`): **`createPayrollPayment(tx, ctx,
    PayrollPaymentInput)`**, **`createEmployeeAdvance(tx, ctx, EmployeeAdvanceInput)`**, **`readMoneyOut(tx,
    documentId, scope?: MoneyOutScope)`** (`{ companyId?, typeCode? }` — the plan had no scope), **`listMoneyOut(tx,
    MoneyOutListFilter)`** (newest first), **`advanceBalance(tx, { companyId, employeeId, asOf })`**,
    **`MoneyOutError`** (codes `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_DOC_STATUS_ILLEGAL`,
    `ERR_POLICY_REQUIRES_MISSING`, `ERR_RBAC_FORBIDDEN`; mapped by `problem.ts`'s `fromDomainError` branch, so routes
    need no `asAppError`), types `MoneyOutResult` (the plan's nine members **plus `typeCode` and `branchId`**),
    `MoneyOutLine`, `MoneyOutStatus`, `MoneyOutTypeCode`, `MoneyOutScope`, `MoneyOutListFilter`, `PayrollPaymentInput`,
    `EmployeeAdvanceInput`. A batch's `document.notes` is `payroll:<run id>`, an advance's `advance:<reason>`.
  - `packages/db/src/hr/batch-csv.ts`: **`BATCH_CSV_HEADER`**, **`payrollBatchCsv`**, `BatchCsvRow`.
  - `packages/contracts/src/hr/payroll-payment.ts` (`MoneyOutStatusSchema`, `PayrollPaymentLineSchema`,
    `PayrollPaymentSchema`, `CreatePayrollPaymentBody`, `PayrollPaymentQuery`, `PayrollPaymentList`) and
    `employee-advance.ts` (`EmployeeAdvanceSchema`, `CreateEmployeeAdvanceBody`, `EmployeeAdvanceBalanceSchema`,
    `EmployeeAdvanceBalanceQuery`, `EmployeeAdvanceQuery`, `EmployeeAdvanceList`).
  - `apps/api/src/routes/hr/payroll-payments.ts` — **`payrollPaymentRoutes`, `payrollPaymentRouteModule`** at
    `/v1/companies/:companyId/payroll-payments`: `POST /` (`hr.payroll.pay`, 201 draft), `GET /`, `GET /{documentId}`,
    `GET /{documentId}/csv` (`hr.payroll.read`); also exports `moneyOutCursor` (the cursor guard both modules use).
    `apps/api/src/routes/hr/employee-advances.ts` — **`employeeAdvanceRoutes`, `employeeAdvanceRouteModule`** at
    `/v1/companies/:companyId/employee-advances`: `POST /` (`hr.advance.create`), `GET /`, `GET /{documentId}`,
    `GET /balances/{employeeId}?asOf=` (`hr.payroll.read`). Mounted in `buildRoutes` after `payrollRunRouteModule`.
    `openapi.json` regenerated (+6 paths, 7 schemas, purely additive) and the paths pinned in `apps/api/test/openapi.test.ts`.
  - `tests/invariants/support/payroll-money.ts` (B3): **`MoneyOutFixture`** (8B's fixture + `payrollDocumentId`,
    `payer`, `authorityPartyId`, **`bankAccountId`**), **`moneyOutFixture`**, **`postPayrollPayment(db, s, f,
    { effectiveDate?, employeeIds?, payrollDocumentId? })`**, **`postEmployeeAdvance`**. `postRemittance` is T8's.
  - `tests/invariants/probes.ts`: two `PROBES` keys (expect **403**) over a helper `seedMoneyOutDraft`.
  - Tests: `packages/db/test/hr/money-out.test.ts` (16), `apps/api/test/routes/hr/payroll-payments.test.ts` (11),
    `apps/api/test/routes/hr/employee-advances.test.ts` (11).

### Deviations from the plan (and why)

1. **Hazard 33's `1100`:** `seedTenantV2` never applies 0C's chart, so the T5 test and `moneyOutFixture` apply the
   `1100` row from the shipped `0c-base.json`; the test also asserts each code is a leaf of its owner's shipped file.
2. **T5 test reads the catalogue from `app.permission`** (B16 item 3) and calls `loadDocumentTypes` on the
   `document-types/` directory with the production `(sql, ctx, dir, catalogue)` signature.
3. **`moneyOutFixture` seeds the two types with `seedDocumentType` from the shipped envelopes** (8B's PAYROLL
   precedent), not `loadDocumentTypes` over the whole pack; it grants `s.human` read, prepare, pay and advance.create
   (`postPayrollRun` needs prepare — the plan granted only pay and advance.create).
4. **Net per employee = `credit − debit` of the run's net-pay `account` lines** (the plan summed `payroll_line.amount`
   magnitudes). The exclusion also skips `reversed` batches and reversal mirrors; a per-run advisory lock
   (`payroll_payment:<run>`) serialises concurrent drafts; an invisible run employee refuses (`ERR_RBAC_FORBIDDEN`);
   a named employee not on the run refuses.
5. **The advance's currency check is in the service**, not the route. Every service refusal is
   `ERR_VALIDATION_FAILED` = **400** (the plan's tests said 422); declared responses follow.
6. **CSV text cells are neutralised against formula injection** (the 7A report rule); `amount` untouched.
7. **Lists newest first** with `limit + 1` (no cursor on a full last page), `.strict()` queries, a hand-made cursor
   400; schemas gain `branchId`. **PROBES expect 403** (8B's reason) and seed a draft of the type, not
   `moneyOutFixture` (not idempotent on the shared victim tenant). Route tests mint principals with `secondApprover`
   (`grantAdmin` does not grant `hr.payroll.pay`).
8. The reversal case is pinned as the plan predicted: **`ERR_DOC_STATUS_ILLEGAL`** from `issueDocument` on the mirror,
   no mirror left.

### Decisions

Seven rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (hazard 33's `1100`, `reversal.allowed`, what a
batch pays and excludes, company/type-bound reads, the currency check, the CSV, the wire shapes and probes).

### Tests run (2026-11-07, on T6's tree `d06b361`)

- **`packages/db` whole suite: 2,206 in 222 files** — first run 1 failed: `ar-ap/code-review-a.test.ts`'s
  `app.policy_extends_credit` pin (the two new outbound types name no payable account, so the predicate is true for
  them, as for `TILL_PAID_OUT`; they carry no party, so `assert_credit_available` never acts). Pin moved with its
  reason in the progress commit; the file re-ran 25/25.
- **`apps/api` whole suite: 999 passed in 102 files** (payroll-payments 11, employee-advances 11, openapi 3).
- **`tests` whole workspace: 919 passed, 5 skipped, 1 failed in 141 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. `tenant-isolation` (both new probes), sah-047 green.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **sixteen** `scripts/check/*.sh` gates OK; `openapi.json` regenerated with no diff.
- Not run: `apps/worker`, `bun run e2e`, `packages/domain` and the UI workspaces (nothing they load changed).

### For the next agent (T7+)

- `moneyOutFixture` is not idempotent (it calls `payrollFixture`); it posts January's run (pay date 2026-02-05) and
  seeds `1100`. The authority party's payable account is the scheme's `2411`; T8's remittance `PAYMENT` should check
  0047's `app.party_control_account` step-6c refusal against that party early.
- A posted batch cannot be reversed (approval-required type) — AGENTS.md's known-limit sentence should name
  `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` in 8D's rewrite; AGENTS.md's "twenty-four document types" is stale (27 now).
- `payrollBatchCsv` is in `@dulja/db`; T12's `PAYROLL_BATCH_SOURCE` reads the batch's `1100` leg (BRANCH = the
  batch's branch, no EMPLOYEE tag).

## 8C T7–T8 (2026-11-07)

### Built

- **T7** (`d3425cc`) —
  - `packages/db/src/hr/schedule.ts` (main barrel via `hr/index.ts`): **`generateStatutorySchedule(tx, ctx, store,
    GenerateScheduleInput)`** → `StatutoryScheduleResult[]`, **`readSchedule(tx, scheduleId, scope?: ScheduleScope)`**
    (`{ companyId? }` — the plan had no scope), **`listSchedules(tx, ListScheduleFilter)`** (oldest period first; the
    filter gains `payrollDocumentId`), **`SCHEDULE_CSV_HEADER`**, **`scheduleCsv`**, **`scheduleFileName`**
    (`<schemeCode>-<periodStart>.csv`), **`SCHEME_REFERENCE_KEY_PREFIX`** (`"scheme_reference:"`), **`ScheduleError`**
    (codes `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_DOC_STATUS_ILLEGAL`, **`ERR_RBAC_FORBIDDEN`**; mapped by
    `fromDomainError`, no route `asAppError`). `StatutoryScheduleResult` gains **`companyId`**; `ScheduleRow` gains
    **`employeeId`**. Internal: `scheduleRowsFor` (the one per-employee aggregation the generator and both readers use),
    `HEADER_COLUMNS` (aliases `ss2` = schedule, `sc` = scheme, as T15 expects), `hydrate`, `attachCsv`.
  - `packages/db/src/hr/csv-cell.ts`: **`csvField`**, **`csvText`** — T6's quoting and formula-injection rule, now shared
    by `batch-csv.ts` (refactored onto it, output unchanged) and `scheduleCsv`.
  - `packages/contracts/src/hr/statutory-schedule.ts`: `StatutoryScheduleRowSchema`, `StatutoryScheduleSchema`,
    `GenerateStatutoryScheduleBody` (`.strict()`, `schemeIds` 1–100), `StatutoryScheduleQuery` (`.strict()`; filters
    `schemeId`, `payrollDocumentId`, `periodStart` gte/lte, `settled`), `StatutoryScheduleList`; T8 adds
    `SettleStatutoryScheduleBody`.
  - `apps/api/src/routes/hr/statutory-schedules.ts`: **`createStatutoryScheduleRoutes(store)`**,
    **`statutoryScheduleRouteModule(store)`**, `STATUTORY_SCHEDULES_PATH` — `POST /` (`hr.payroll.pay`, 201 list
    envelope), `GET /`, `GET /{scheduleId}`, `GET /{scheduleId}/csv` (`hr.payroll.read`); T8 adds `POST
    /{scheduleId}/settle` (`hr.payroll.pay`). Mounted in `buildRoutes` after the two T6 modules with
    `deps.objectStore`. `openapi.json` regenerated (purely additive) and the four paths pinned in `openapi.test.ts`.
  - `tests/invariants/probes.ts`: the third money-out `PROBES` key (seeds scheme `PROBE_SCHEDULE` + a bare schedule
    row; expects **403**).
  - Tests: `packages/db/test/hr/schedule.test.ts` (13), `apps/api/test/routes/hr/statutory-schedules.test.ts` (12 + 4 in
    T8).
- **T8** (`06f8023`) —
  - `packages/db/src/hr/remittance.ts`: **`settleStatutorySchedule(tx, ctx, SettleScheduleInput)`**,
    **`unsettleStatutorySchedule(tx, ctx, UnsettleScheduleInput)`** (both inputs carry an optional `companyId`),
    **`RemittanceError`** (`ERR_NOT_FOUND`, `ERR_PAYROLL_REMITTANCE_MISMATCH`, `ERR_VALIDATION_FAILED`). Both return
    T7's `StatutoryScheduleResult`. No unsettle route (B10's five).
  - Migration **0091 amended in place**: `statutory_schedule_remittance_key` (unique on `remittance_document_id` where
    not null). Contracts round 18 **B17** and §4.6.1's row record it.
  - `tests/invariants/support/payroll-money.ts`: **`postRemittance(db, s, f, { amount, effectiveDate? })`** (default
    2026-02-15) over 4B's `postFromPack("PAYMENT")` to `f.authorityPartyId`, line on `f.bankAccountId`. Note: its first
    call grants `postArDocument`'s `MAKER_CODES` (incl. `accounting.payment.create`/`.post`) to `s.human`, and the
    checker is a fresh principal holding PAYMENT's approve/post (not `f.payer`).
  - `tests/invariants/payslip-ties-to-ledger.test.ts` — **acceptance test 30** (four clauses) + the DoD clause (Σ net =
    2400's movement on the run and in January's `account_balance`; a posted batch clears 2400 to zero) — 6 cases.
  - `packages/db/test/hr/remittance.test.ts` (14, order-dependent); `— 8C` blocks appended to
    `tests/regression/sah-011.test.ts` (2) and `sah-019.test.ts` (3).

### Deviations from the plan (and why)

1. **The generator needs `hr.compensation.read`** (else `ERR_RBAC_FORBIDDEN` naming the code): the scheme reference is on
   `employee_statutory_profile` behind 8A's RESTRICTIVE `compensation_gate`, and the archived file would otherwise be
   silently blank. **An employee on the run the caller cannot see is refused**, never dropped (generator and readers).
2. **Scheme reference key is `extra["scheme_reference:<scheme code>"]`**, not one `scheme_reference` key for every
   scheme.
3. **Regeneration never rewrites an archived file**: same bytes keep the attachment; different bytes write a new one via
   2C's `createAttachment` and archive the old. The plan's `on conflict (id) do update` overwrote the object before the
   row (a rollback would leave bytes that fail their hash). The schedule row is `on conflict do nothing` + a locked read,
   updating totals only if they differ (no audit row per regeneration).
4. **`GET …/csv` serves the archived attachment** (verified by 2C's `readAttachmentContent`; `ERR_INTERNAL` +
   `attachment_integrity` log on mismatch), rendering from the record only when none is linked;
   `Content-Disposition` uses `filename*=UTF-8''…`. The route test asserts it is byte-identical to 2C's attachment
   download.
5. **CSV text cells neutralised** against formula injection (shared `csv-cell.ts`); shares untouched.
6. **Settlement also refuses** a non-`PAYMENT` document, a PAYMENT to a party other than the scheme's
   `authority_party_id`, and a payment that already settles another schedule (service sentence + 0091's new unique
   index). Payment of another company → `ERR_NOT_FOUND`.
7. The plan's sah-019 regex `/\d,\d{3}\./` matches the legitimate `0.0000,100.0000`; replaced by "exactly five cells and
   each figure `^-?\d+\.\d{4}$`". Test 30 clause 4 uses a one-cent-over remittance and also asserts the payable clears
   to zero after the right one; clause 2 asserts by string equality, not `toBeCloseTo`.
8. Route statuses: a named scheme the run lacks → 400; a not-posted run → 409; a non-run id → 404; probe → 403.

### Decisions

Nine rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (generator visibility, the reference key,
regeneration, what the CSV route serves, the module's wire shapes/probe, what a remittance may be, one payment one
schedule, the unsettle reason, `postRemittance`).

### Tests run (2026-11-07, on T8's tree `06f8023`)

- **`packages/db` whole suite: 2,233 passed in 224 files.**
- **`apps/api` whole suite: 1,015 passed in 103 files** (statutory-schedules 16, openapi 3).
- **`tests` whole workspace: 931 passed, 5 skipped, 1 failed in 142 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. Test 30 (6), `tenant-isolation` (the new probe), sah-011,
  sah-019 green.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **sixteen** `scripts/check/*.sh` gates OK (incl. `contracts-8c-amendments.sh` after B17); `openapi.json` regenerated
  with no diff.
- Not run: `apps/worker`, `bun run e2e`, `packages/domain` and the UI workspaces (nothing they load changed).

### For the next agent (T9+)

- 4A's PAYMENT posts as expected for a remittance: exactly `credit 1100 = X`, `debit <scheme payable> = X`
  (`remittance.test.ts` pins it).
- `unsettleStatutorySchedule`'s reason is validated but stored nowhere (recorded limit).
- T15 edits `schedule.ts`: the readers' aliases are `ss2`/`sc` in `HEADER_COLUMNS`; the generator's scheme query
  aliases `ss`; `present` in the route is the one place a result becomes the wire body.
- T12's `PAYROLL_BATCH_SOURCE` is untouched by T7/T8.

## 8C T9–T10 (2026-11-07)

### Built

- **T9** (`15396ea`) —
  - Tail migration **`0121_admit_employee_ytd_drift_system_event.sql`** (+ down): `app.record_system_event`'s closed list
    gains `employee_ytd_drift` (fifth name). Registered in contracts §3.4.1 ("8C overrun, Task 9") in the same change.
  - `packages/db/src/integrity/employee-ytd.ts`: **`checkEmployeeYtdProjection(tx, opts?: EmployeeYtdCheckOptions)`**
    (`{ companyId?, year? }`, narrowed in SQL) and **`EMPLOYEE_YTD_CHECK`** (`name: "employee_ytd"`), registered in
    `integrity/index.ts` and on the main barrel (with `EmployeeYtdCheckOptions`). One CTE statement over
    `app.employee_ytd_delta` + `jsonb_add_money_agg`/`jsonb_add_scheme_agg`; every measure compared as text; key values
    are strings (`tax_year: "2026"`); `detail` is `"<column> <projected> <> <rebuilt>"`.
  - `packages/db/src/hr/opening.ts` (main barrel via `hr/index.ts`): **`upsertEmployeeYtdOpening(tx, ctx,
    EmployeeYtdOpeningInput)`** → id, **`listEmployeeYtdOpening(tx, { companyId, year })`** →
    `EmployeeYtdOpeningRow[]`, **`OpeningError`** (`ERR_VALIDATION_FAILED` | `ERR_NOT_FOUND`), `OpeningErrorCode`.
    **The input/row field is `year`, not `taxYear`** (see B18). No route (B10).
  - `packages/db/src/jobs/payloads.ts`: **`"hr.employee_ytd.rebuild": { companyId?: string; year?: number }`**.
  - `apps/worker/src/jobs/employee-ytd-rebuild.ts` (beside 8A's lapse job, not the plan's `handlers/`):
    **`employeeYtdRebuildHandler`**, **`registerEmployeeYtdRebuild()`** (idempotent), **`EMPLOYEE_YTD_DRIFT_SENTINEL`**;
    registered in `apps/worker/src/index.ts` and `apps/worker/test/support/worker.ts`. One sentinel row per drifted
    run (`after = { companyId, year, mismatches }`), none when clean; repairs nothing.
  - `tests/invariants/probes.ts`: `JOB_PROBES["hr.employee_ytd.rebuild"]` (both tenants hold a stray projection row;
    the attacker's own run writes its sentinel into its own chain; the victim's row count and sentinels unchanged).
  - Pinned `projections.checked` / `projectionChecks()` arrays moved in **seven** files (B5's three plus
    `packages/db/test/privileges.test.ts`, `costing/layers.test.ts`, `inventory/stock-on-hand.test.ts`,
    `ar-ap/item-profitability.test.ts`).
  - Tests: `packages/db/test/hr/employee-ytd-opening.test.ts` (9), `tests/invariants/employee-ytd-rebuild.test.ts`
    (**acceptance test 35** + test 2 re-run, 7), `apps/worker/test/jobs/employee-ytd-rebuild.test.ts` (7), `— 8C`
    blocks in `tests/regression/sah-004.test.ts` (2) and `sah-016.test.ts` (2).
  - Contracts round 18 **B18**; the gate's B4 literal moved to `year`; ADR 0077 decision 1's wording (CTE, 0121).
- **T10** (`9b32735`) —
  - Migration **`0093_create_termination_trigger.sql`** (+ down): **`app.terminate_employee()`** and trigger
    **`employee_terminated`** (AFTER UPDATE OF `terminated_on`, `when old is null and new is not null`).
  - ADR **0078** (**Proposed**, two owner questions).
  - Tests: `packages/db/test/hr/termination.test.ts` (11), a `— 8C` block in `tests/regression/sah-044.test.ts` (2).
  - Contracts round 18 **B19**.

### Deviations from the plan (and why)

1. **The sentinel goes through `app.record_system_event`** (tail 0121), not a direct `insert into app.audit_log`
   (refused to `app_rw` by 0001 §8) — the 0111/0120 precedent; 0091–0095 sort before 0105/0111/0120.
2. **`taxYear` → `year`** in the payload, the opening input and row (`no-number-money` reads `tax`; Global Constraint
   2 forbids an `ALLOWED` entry). B18 records it; the gate's literal moved.
3. **The rebuild is a CTE**, not `create temp table` (AGENTS.md: no DDL from application code; 1B's precedent), and
   compares as text, so a scale-only drift is caught (test 35 has a case for it).
4. Handler file at `apps/worker/src/jobs/` (8A's lapse precedent) with a `register…()` function; test at
   `apps/worker/test/jobs/`. The worker test uses `payrollFixture` + `postPayrollRun`, not `moneyOutFixture`.
5. Test 35's clause 2 re-runs the clause itself (submitted → recalculated → draft, reason `recalculated`, approval
   refused) plus the plan's posted-run refusal; test 35 posts a second run so the fold covers two deltas.
6. The opening loader also refuses a non-base currency and an out-of-range year.
7. SAH-016's recovery run is a real `supplementary` draft whose lines are replaced by the recovery shape (the calculator
   refuses a negative net), not hand-inserted `document`/`payroll_run` headers.
8. **0093 order and actor** (B19, ADR 0078): assignments expire **first** as the terminating actor (6C's trigger
   refreshes the snapshot), the credential is revoked **last** as the **tenant's system principal** (actor restored
   after; ADR 0061's precedent) — the plan's actor-RLS revoke left a credential at a branch a branch-restricted
   terminator cannot see live. No explicit `refresh_pos_cashier` call; the tombstone carries the row's final revision
   (the plan's order bumped the row past its tombstone). The expiry also covers each live credential's own principal.
9. The plan's `principal()` helper inserted `app.principal.tenant_id` (no such column); tests mint principals through
   `db.migrator` as `seedCashier` does, and pass `principalId` to `seedCashier` so the credential is the employee's.

### Decisions

Nine rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (six T9, three T10).

### Tests run (2026-11-07, on T10's tree `9b32735`)

- **`packages/db` whole suite: 2,253 passed in 226 files.**
- **`apps/api` whole suite: 1,015 passed in 103 files.**
- **`apps/worker`: 132 passed in 20 files (Vitest) plus its two Bun cases.**
- **`tests` whole workspace: 944 passed, 5 skipped, 1 failed in 143 files** — the failure is test 15's PDF hyphens
  (`zero-code-document-type`), the known pre-existing one. Test 35 (7), `job-isolation` (the new JOB_PROBES entry),
  `phase-5-exit`, `projection-rebuild`, `audit-chain`, sah-004, sah-016, sah-044 green.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **sixteen** `scripts/check/*.sh` gates OK (incl. `contracts-8c-amendments.sh` after B18/B19). No route changed, so
  `openapi.json` is untouched.
- Not run: `bun run e2e`, `packages/domain` and the UI workspaces (nothing they load changed).

### For the next agent (T11+)

- T11's 0094 constraint trigger must admit 0093's in-transaction order: `terminated_on` is written first, the
  assignments expire, then `revoked_at` — so the "cashiers are employees" check must be DEFERRABLE INITIALLY DEFERRED
  (ADR 0078 decision 5). 0093 finds/revokes credentials as the system principal; 0094's check, if it reads
  `pos_cashier` under the actor, would miss credentials at branches the actor cannot see — consider the same swap or
  a definer lookup.
- 0094 sorts before 0105–0121; it must not depend on anything from the tail.
- `seedCashier` mints its own principal unless `principalId` is passed, so many fixtures create a credential whose
  principal is not the employee's login; 0093 expires that principal's assignments too on termination.
- AGENTS.md (8D's rewrite): list `0093`, `0121` in "In the tree"; ADR 0078 in the awaiting list; the 0093 system-actor
  swap beside the reviewed widenings (it mirrors the fifth, 0067's `refresh_pos_cashier`).

## 8C T11–T15 (2026-11-07)

### Built

- **T11** (`8efaf16`) — migration **`0094_create_cashier_is_employee_constraint.sql`** (+ down):
  `app.assert_cashier_is_employee()` and two `DEFERRABLE INITIALLY DEFERRED` constraint triggers,
  **`pos_cashier_is_employee`** (`after insert or update of employee_id, revoked_at`) and
  **`employee_cashier_still_employed`** (`after update of terminated_on`), raising **`ERR_HR_CASHIER_NOT_EMPLOYEE`**
  (409; `ERRORS` + contracts pin, same commit). Tests: `packages/db/test/hr/cashier-is-employee.test.ts` (9),
  **acceptance test 34** `tests/invariants/termination-closes-everything.test.ts` (7, incl. test 20's resume re-run as
  clause 2b), a `— 8C` block in `tests/regression/sah-021.test.ts` (5). 6C's pinned `pos_cashier` trigger list
  (`packages/db/test/staff/pos-cashier.test.ts`) gains the new name. ADR 0078 decision 5 as built + owner question 3;
  its question 2 corrected (0094 does not make a principal mismatch impossible). Contracts round 18 **B20**; the 8C gate
  checks it and 0094.
- **T12** (`ede11ff`, `ef1d167`) — `packages/db/src/hr/reconcilable.ts`: **`PAYROLL_BATCH_SOURCE`** (kind
  `payroll_batch`), registered at module level and exported from the `hr` barrel. Tests:
  `packages/db/test/hr/reconcilable.test.ts` (6), `tests/invariants/money-out-sod.test.ts` (test 31 × 4 paths × 2
  types + test 10, and test 39's payroll-batch clause — 10). Pinned registry lists moved in
  `packages/db/test/ar-ap/bank-match.test.ts` (two lists, a length 3 → 4, and the "no source" case now asserts the batch
  source's own refusal) and `tests/invariants/pos-till-banking.test.ts`.
- **T13** (`d3d3e8a`, ⚠️ OD-28) — `docs/owner/statutory-layouts/README.md` (the owner record),
  `packages/db/src/hr/schedule-layouts/index.ts` (`ScheduleLayout`, `EmployerIdentifiers`, `layoutFor`; empty
  `LAYOUTS`; not on the barrel, not wired), `packages/db/test/hr/schedule-layouts.test.ts` (5 pass, 4 skipped).
- **T14** (`106e6d0`, ⚠️ OD-14 item 4) — a "What 8C adds to item 4" section in `docs/owner/od-14-hr-facts.md`. No code.
- **T15** (`47d8015`, ⚠️ OD-23) — `StatutoryScheduleResult.employerRegistration?: string | null` (set by the generator,
  `readSchedule`, `listSchedules`), **`missingEmployerRegistrations(tx, companyId)`** (on the barrel; built on 8A's
  `employerRegistrations`), `StatutoryScheduleSchema.employerRegistration: z.string().nullable()` (required), the
  route's `present`; `openapi.json` regenerated (+1 field). Test `packages/db/test/hr/tax-year-convention.test.ts`
  (4 + 1 skipped); one assertion in `apps/api/test/routes/hr/statutory-schedules.test.ts`. A "What 8C adds" section in
  `docs/owner/od-23-employer-registrations.md`.
- Slice handoff **`docs/handoff/8c-to-8d.md`**.

### Deviations from the plan (and why)

1. **0094 reads as the tenant's system principal** (0093's swap), restoring the caller's actor: `pos_cashier` Form A
   (credential branch) and `employee` Form A′ (home branch) are each RESTRICTIVE, so the plan's check under the actor's
   RLS passed a violation whose other side the actor could not see (the C-6 case fails on the plan's body — verified
   by running it against the plan's form). The function writes nothing. The plan's `principal()` helper inserted a
   non-existent `principal.tenant_id`; tests mint principals through `db.migrator` (T10's form).
2. **The `pos_cashier` trigger fires on `employee_id, revoked_at` only**, not every update (snapshot refreshes and PIN
   changes queue nothing).
3. **Test 34**: employee B's principal and credential are added in the file (8B's fixture untouched); clause 1 also
   asserts the two rows share one `xmin` ("same transaction"); `currentCatalogueRevision(tx, companyId)` and
   `readCatalogue(…, limit)` / `op: "delete"` are the tree's shapes (the plan used `{ companyId }` and `deleted`).
   Extra clause 3b: the credential cannot be un-revoked.
4. **T12's source uses 4B's `ledgerLegSource` arithmetic** (account-currency leg, `d.company_id` bound, matches counted on
   this bank account's statements), not the plan's `credit − debit` with all matches.
5. **T12's "edits no 4B file" case is a tree scan** (exactly four `registerReconcilableSource(` calls: 4B ×2, 6D, 8C),
   not `git diff origin/main`.
6. **Test 31's re-run**: adds the job path; `ERR_SOD_NO_SUBMISSION` on a row INSERTED at `submitted` (the plan's draft
   would meet the matrix's `ERR_DOC_STATUS_ILLEGAL` first); test 10's post refusal by a third principal (the plan's
   submitter meets R1 before R2), on the service and raw-SQL paths. The file uses `startApi` (root tests already import
   it) instead of `sharedApi`. Test 39's "matching altered no ledger entry" is a ledger fingerprint (`ledger_entry` is
   AUDIT_EXEMPT, so the plan's audit count was vacuous).
7. **T13's "unverified" case** asserts no layout is registered without both files (the plan asserted the directory
   is absent, which fails as soon as one file arrives).
8. **T14's record is a section of the existing OD-14 file** (8B's precedent), not the plan's new
   `od-14-staff-purchases.md`; it corrects 8A's first estimate (a `settles` link) — a fifth tender method is a
   posting-policy schema version and a sync-protocol change.
9. **T15**: the tax-year comment regex is `/B7/` (0092's comment says "round 18 B7", not "amendment B7"); the plan's
   `it.skip` is kept.

### Decisions

Ten rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (four T11, three T12, and OD-28, OD-14 item 4,
OD-23's 8C clauses).

### Tests run (2026-11-07, on T15's tree `47d8015`)

- **`packages/db` whole suite: 2,277 passed, 5 skipped in 230 files** (first T11 run: 1 failure, 6C's pinned
  `pos_cashier` trigger list — moved in the T11 commit; the registry pins in `bank-match.test.ts` moved in `ef1d167`).
- **`apps/api` whole suite: 1,015 passed in 103 files.**
- **`apps/worker`: 132 passed in 20 files (Vitest) plus its two Bun cases.**
- **`tests` whole workspace: 966 passed, 5 skipped, 1 failed in 145 files** (run twice, the second after the worker and
  Docker restart) — the failure is test 15's PDF hyphens (`zero-code-document-type`), the known pre-existing one. The
  first run on the T12 tree also failed `pos-till-banking`'s registry pin, moved in `ef1d167`. Test 34 (7), money-out
  SoD (10), sah-021, sah-041, tenant-isolation, job-isolation green.
- **`bun run e2e`: 29/29** — the first run after the restart failed once in `exports.spec.ts` (ar: `boundingBox()`
  null on the format select, a layout race in a 7C screen 8C does not touch); the spec passed 6/6 with
  `--repeat-each 3` and the full re-run was 29/29.
- `apps/pos` 251 in 16 (0094 is server-side only).
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **sixteen** `scripts/check/*.sh` gates OK (`contracts-8c-amendments.sh` checks B20 and 0094); `openapi.json`
  regenerated in T15 (+1 field).

### For 8D

- Read `docs/handoff/8c-to-8d.md`; its "For 8D's `AGENTS.md` rewrite" list carries every 8C item AGENTS.md lacks
  (0091–0095, 0121, ADRs 0077/0078, the 0093/0094 system-principal swaps beside the reviewed widenings, 27 document
  types, the money-out known limits).
- `reconcilableSources()` now has four kinds; any new pin of the list moves with the next registration.
- `missingEmployerRegistrations` is what the annual employer return names gaps from.
- 0094 is deferred: a test that un-revokes a credential of a terminated employee fails at COMMIT (the `withTenant`
  call rejects), not at the statement.

## 8D T0–T2 (2026-11-07)

### Built

- **T0** (`d161e55`) — contracts **round 19** (end of the contracts document): the plan's A1–A12, cited **8D A1–A12**
  (8A/8B used A-numbers too), plus **A13** (eleven places the plan was stale against the tree) and **A14** (OD-13
  answered build). The plan's in-place edits are applied (§3.11 row + A12 sentence, §3.6.3, §4.2.9, §4.5.9, §4.6.1
  employee and leave rows, §4.11.2, §4.16.1 `hr.contract_expiry`, §4.16.2, §4.17.1 7B row + a new `hr-reports.ts`
  row). Gate **`scripts/check/contracts-8d-amendments.sh`**, wired into CI's `checks` job after the 8C step.
  `packages/db/test/hr/predecessors.test.ts` (7).
- **T1** (`246e06c`) — `hr.filing.generate` (phase `"8D"`, mutating) in `packages/contracts/permissions.ts`; migration
  **`0097_seed_permission_phase8d.sql`** (+ down, deletes only `app.permission`); `hr_payroll` += the code.
  **`apps/api/src/hr/authorise.ts`: `requireFilingGenerate()`** = `requirePermission(PERMISSION["hr.filing.generate"],
  { company: "path:companyId" })`. Tests: `apps/api/test/hr/authorise.test.ts` (3, probe route on the started app,
  real chain), an 8D block in `permission-catalogue.test.ts` (3), one line in `roles-seed.test.ts`. 2C's F-21 case
  (`apps/api/test/routes/admin/document-types.test.ts`) now names **`hr.leave.approve`**.
- **T2** (`303e042`) — migration **`0098_add_employee_contract_end.sql`** (+ down); mirror `employee.contractEndsOn`;
  the export's `employee` row gains `contract_ends_on`. **`packages/db/src/reports/datasets/hr.ts`**:
  `employeeDataset`, `attendanceEventDataset`, `payrollLineDataset`, `employeeYtdDataset`, `statutoryScheduleDataset`
  (not re-exported from the reports barrel — 7C's `datasets/pos.ts` isn't either; reach them through `DATASETS`).
  `datasets.ts`: union, `DATASETS` and **`DATASET_READ_CODES`** (`employee`, `attendance_event` → `hr.employee.read`;
  `payroll_line`, `employee_ytd`, `statutory_schedule` → `hr.payroll.read`). **`tests/invariants/support/hr-reports.ts`**
  (8D A7): `HR_CATALOGUE`, `HrReportCode`, `HR_CATALOGUE_DIR`, `readHrEnvelope`, `readHrDefinition` (7B's typed
  envelope), `HrReportFixture` (plan shape **+ `contractorId`**), `hrReportFixture(db, s)`, and the extra exports
  `CONTRACT_ENDS_ON` (`2026-03-31`) and `ATTENDANCE_EVENTS`. Test `packages/db/test/reports/hr-datasets.test.ts` (14).

### Dataset field names (what T3–T6 definitions reference)

- `employee`: employee_id, employee_number, employee_name_en, employee_name_ar, branch_id, branch_code, branch_name_en,
  position, employment_type, hired_on, terminated_on, contract_ends_on, active, has_login.
- `attendance_event`: attendance_event_id, employee_id, employee_number, employee_name_en, branch_id, branch_code, kind,
  occurred_at (RFC 3339 UTC), **occurred_on (company-timezone date, `localDateOf`)**, terminal_id, corrects_event_id, note.
- `payroll_line`: payroll_line_id, payroll_document_id, **document_series** (extra), **document_number (integer, 7A's
  kind, not the plan's text)**, document_status, run_kind, period_start, period_end, pay_date, **tax_year (pay-date
  year)**, employee_id, employee_number, employee_name_en, branch_id, branch_code, component_id, component_code,
  component_kind, scheme_id, scheme_code, share, quantity, amount, rate_table_version, override_reason,
  net_contribution, payable_contribution.
- `employee_ytd`: employee_id, employee_number, employee_name_en, branch_id, branch_code, tax_year, gross, net,
  scheme_code, scheme_employee, scheme_employer (projection only — the opening is NOT added).
- `statutory_schedule`: statutory_schedule_id, scheme_id, scheme_code, scheme_name_en, **scheme_name_ar**, period_start,
  period_end, payroll_document_id, **payroll_number (integer)**, **currency**, total_employee, total_employer, total,
  payable_account_code, attachment_id, remittance_document_id, **remittance_number (integer)**, remitted.

### Deviations from the plan (and why)

1. **Registry base 28, not 29** (`pdc` not built, OD-09): T2's pins are **33**, Task 8's will be **34**. **Three** pins
   moved, not two: 7A's literal array, 7C's `toHaveLength`, and 7C's `tests/invariants/report-catalogue-pins.test.ts`
   ("closed Phase 7 at twenty-eight" — now `length 33`, `slice(25, 28)` = 7C's three, `slice(28)` = 8D's five).
   `datasets.test.ts`'s `DATASET_FILES` gains `hr.ts` (test-27 scan: only `${companyId}` may be interpolated — so each
   measure's CASE is written twice, as `ref` and in `select`; the test filters on both measures to prove they agree).
2. **The predecessor gate is durable** — it pins the predecessors and admits only 8D's own names, instead of the plan's
   "0096–0099 unapplied / none of 8D's six / no 8D code" (which would go red at T1/T2). It reads `app.permission`
   (a `packages/db` test may not import `@dulja/contracts`).
3. **`0097.down.sql`** deletes `app.permission` only (0089/0095 precedent), not `role_permission` rows.
4. **`payroll_line.tax_year`** = year of `pay_date` (round 18 B7), not `period_end`'s. **`attendance_event.occurred_on`**
   = company-timezone date (7C precedent), not UTC; the corpus' 16:30Z clock-out is 00:30 local on 6 Jan to prove it.
5. **`hrReportFixture`** grants `s.human` `hr.payroll.prepare` + `hr.payroll.read` (postPayrollRun needs prepare), uses
   the production `withTenant`, and lets `seedPayrollRun` resolve the February period itself (8B changed it to
   resolve from the effective date, so the plan's January pin is unnecessary).
6. `requireFilingGenerate`'s test mounts the probe with `api.app.post(...)` (the require-permission test's pattern) and
   adds a cross-tenant refusal case.

### Decisions

Nine rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (round 19; the durable gate; **OD-13 answered
build**; 0097's down; sah-047 red until T5; the F-21 move; the dataset gates; tax year and local date; contract end
on the export and not yet on the wire).

### Open — for the next agents

- **sah-047 is red** (`hr.filing.generate` has no mounted route): **Task 5** must compose the payslip route onto 8B's
  `payroll-runs` module with `requireFilingGenerate()` AND add `PERMISSION["hr.filing.generate"]` to that module's
  `permissions` in `apps/api/src/routes/index.ts` (and `payrollRunRouteModule`). That closes it.
- **Task 8** (leave register, OD-13 = build): append `leave_record` to `datasets/hr.ts`, the union, `DATASETS` and
  **`DATASET_READ_CODES`** (`definition-gates.test.ts` requires a key per member); move the three pins 33 → 34
  (`datasets.test.ts` array, `7c-datasets.test.ts` length, `report-catalogue-pins.test.ts` length + `slice(28)`);
  `hr-datasets.test.ts`'s first case pins `slice(-5)`/33 and `isDatasetId("leave_record") === false` — update it.
  **Move the F-21 case again** (0096 ships `hr.leave.approve`): pick a syntactically valid code no slice ships, or
  assert on an uncatalogued code. `predecessors.test.ts` already admits 0096 and the two `hr.leave.*` codes.
- **Task 4**: `LEDGER_MEASURE` gains `net_contribution`/`payable_contribution` (both `"credit"`); on the corpus
  Σnet_contribution = 3900.0000 = the run's `2400` credit, Σpayable_contribution = 300.0000 = `2411` credit (asserted
  in `hr-datasets.test.ts`). `employee_ytd`'s `gross` repeats per scheme row — compare distinct pairs.
- **Task 7**: `containerSecrets` is `apps/edge/src/container-env.ts` (A13 item 3); `apps/api/src/index.ts` still has
  `currentVersion: 1`.
- **No route writes `employee.contract_ends_on`** (6C's employee bodies unchanged); Task 3's report works on fixture
  data only until a later task adds a wire field (or the HR record screen) for it.
- AGENTS.md (Task 12): in the tree add `0097`, `0098`, ADRs per 8D; `scripts/check/contracts-8d-amendments.sh`.

### Tests run (2026-11-07, on T2's tree `303e042`)

- **`packages/db` whole suite: 2,301 passed, 5 skipped in 232 files.**
- **`apps/api` whole suite: 1,018 passed in 104 files.**
- **`tests` whole workspace: 965 passed, 5 skipped, 2 failed in 145 files** — test 15's PDF hyphens
  (`zero-code-document-type`, known, pre-existing) and **`regression/sah-047`** on `hr.filing.generate` (declared above;
  closes at Task 5). role-catalogue, report-catalogue-pins, sah-077, tenant-isolation green.
- Static: `bun run typecheck` 14/14, `lint` 0, **`lint:rules` 11 rules, 0 violations**, `format:check` clean, all
  **seventeen** `scripts/check/*.sh` gates OK (incl. the new 8D gate). No route changed, so `openapi.json` is untouched.
- Not run: `apps/worker`, `bun run e2e`, `packages/domain` and the UI workspaces (nothing they load changed).

## 8D T3–T5 (2026-11-07)

### Built

- **T3** (`f3dfa7d`) — `packages/db/seed/my/reports/8d/` with **`hr.employee_list`**, **`hr.contract_expiry`**,
  **`hr.attendance`** (all `hr.employee.read`, `tieOut: none`, each proved by a row witness in
  `packages/db/test/reports/hr-definitions.test.ts`). The permit half of spec:2091 (A3):
  **`permitExpiry(tx, ring, { companyId, withinDays, includeTerminated? })`** → `PermitExpiryRow[]`
  (`packages/db/src/hr/permit-expiry.ts`, barrel-exported); `@dulja/contracts/hr/permit-expiry`
  (`PermitExpirySchema` id `PermitExpiry`, `PermitExpiryQuery` strict, `PermitExpiryList`);
  **`createPermitExpiryRoutes(hrKeys)`** (`apps/api/src/routes/hr/permit-expiry.ts`) = `GET
  /v1/companies/{companyId}/employees/permit-expiry` under `hr.employee.read_sensitive`, composed FIRST in
  `composeEmployeeRouter` (ahead of 6C's `/{employeeId}`). No `PROBES` key. Tests: `packages/db/test/hr/permit-expiry.test.ts`
  (5), `apps/api/test/routes/hr/permit-expiry.test.ts` (5).
- **T4** (`a079399`) — **`hr.payroll_register`** (`ledger_sum` on `2400` over `net_contribution`),
  **`hr.statutory_summary`** (`projection: statutory_schedule`), **`hr.payable_reconciliation`** (`ledger_sum`, no
  account — the caller's window names each `241n`; first total `payable_contribution`, second `net_contribution`).
  `tests/invariants/support/reports.ts`: `LEDGER_MEASURE` += `net_contribution`, `payable_contribution` (**both
  `"credit_net"`**, see Decisions), and two new `assertTieOut` projection arms, **`statutory_schedule`** and
  **`employee_ytd`**, after 7C's and before `default:`; no existing arm edited.
- **T5** (`7146345`) — **`hr.payslip`** (A5 paper, total `net_contribution`, `tieOut: none`).
  `packages/db/src/hr/payslip.ts`: **`payslipRows(tx, { companyId, payrollDocumentId, employeeIds? })`** →
  `PayslipBundle[]` (`header: PayslipHeader` with 4 dp `gross`/`totalDeductions`/`net`, `rows` = the employee's
  `payroll_line` dataset rows **without the net-pay leg**) and **`payslipRunState(tx, { companyId, payrollDocumentId })`**
  → `{ status } | null`. `apps/api/src/print/payslip.ts`: **`PAYSLIP_ENGINE = "chromium"`**, **`renderPayslip(definition,
  bundle, { lang, engine, formatters, currency, generatedAt })`** → `RenderedPayslip` (no sha256).
  `@dulja/contracts/hr/payslip`: `GeneratePayslipsBody` (strict; `lang`, `employeeIds?`), `PayslipSchema` (id `Payslip`),
  `GeneratePayslipsResult`. **`createPayslipRoutes(objectStore)`** (`apps/api/src/routes/hr/payslips.ts`) = `POST
  …/payroll-runs/{documentId}/payslips`, composed onto 8B's module by `composePayrollRunRouter` in
  `apps/api/src/routes/index.ts`, whose `permissions` gain **`hr.filing.generate`** → **SAH-047 passes**. ADR
  **0079** (Proposed, two owner questions). `apps/api/test/openapi.test.ts`'s path pin gains the two new paths.
  Tests: `packages/db/test/hr/payslip.test.ts` (7), `apps/api/test/routes/hr/payslips.test.ts` (13),
  `hr-definitions.test.ts` 9 → 17 → 19.

### Deviations from the plan (and why)

1. **No `companyId` parameter** on any 8D definition (round 19 A13 item 13): `assertParameters` enforces `required`, so
   the plan's would have made every run demand a company id the run ignores; no Phase 7 definition declares one.
2. **`LEDGER_MEASURE` maps both 8D keys to `credit_net`**, not A10's `credit` (A13 item 12) — 7B's map reserves that arm
   for signed fields and names 8D as its first user; it answers the Self-Review's question (e).
3. **The `statutory_schedule` arm compares per schedule row** through `compareStored`, restricted by the run's own
   `fromDate`/`toDate`/`schemeCode` (not the plan's `window` and per-scheme sum); the `employee_ytd` arm also compares
   each scheme's shares (A13 item 14). The register's tie-out window adds the run's period dates (question (f)).
4. **Payslip totals `net_contribution`**, has no groups, and leaves out the net-pay leg (the plan summed `amount`,
   which equals nothing). Footer prints gross/deductions/net formatted; header names the employee in the run's
   language.
5. **The payslip route** checks the run first (404 not in company / 409 not posted, `payslipRunState`), resolves
   `hr.payslip` with 7A's `resolveDefinitionForRun` (404 unseeded) and then the definition's own read code
   (`requireReportRead`) — the plan read the definition with its own SQL and had no second gate. Render + object
   writes run outside the row transaction (2C's `stageAttachment` / `insertAttachment`), staged objects removed on
   failure. `reportToTypstSource` does not exist (ADR 0016's set is `chromium` alone).
6. **Contracts modules are reached by subpath** (`@dulja/contracts/hr/…`), as 8A–8C's are; `src/index.ts` untouched
   (A13 item 15).
7. **Widths are pixels** (×6 the plan's) — `reportToHtmlSource` writes `width: Npx`, Phase 7's widths are 50–130.
8. `PermitExpiry` joins `tests/invariants/hr-sensitive-side-channels.test.ts`'s allow-list for `workPermitExpiry`
   (an 8A test edited additively: same code, same RESTRICTIVE gate as the sensitive pair).
9. The permit list's "today" is the company's calendar day from the DB clock, not the API's UTC day.

### Decisions

Ten rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (8D T3–T5). Contracts round 19 **A13 items 12–15**
added (the gate still passes).

### Known — the PDF hyphens

Under this container's Chromium (`/opt/pw-browsers`) the hyphen-minus and em dash reach `pdfText` as Private Use
code points (U+E088, U+E08B) — test 15's known failure. `payslips.test.ts` compares the employee number with dashes and
PUA marks removed on both sides, and the EN/AR money figures as a set (the one signed cell's minus is that glyph, and
in an RTL row it splits the digits in extraction). A correct build passes the same assertions.

### Open — for the next agents

- **ReportCodeSchema is NOT widened** (Task 11's job). The 8D definitions are seeded by the reports loader already
  (`bun run seed --only reports` and e2e boot walk every `<slice>/` directory; nothing in the loader consults
  `ReportCodeSchema`), so runs over them work today; `report-catalogue-pins`' "ReportCodeSchema is exactly the
  thirty-two shipped" compares against `CATALOGUE_7B + 7C` and is unaffected — **Task 11 must move it** when it widens
  the enum. Task 11's "loads the eight 8d/ definitions" case: seven are on disk until Task 6 ships `hr.annual_statement`.
- `hr-definitions.test.ts`'s `shippedCodes()` validates every 8D file on disk (schema, sets, `assertDefinitionFields`)
  — Task 6 needs no validation case of its own. Task 6's `hr.annual_statement` can tie through the new
  **`employee_ytd`** arm (it restricts by a `taxYear` parameter, else `opts.asOf`'s year).
- The employee_ytd arm's probe in `hr-definitions.test.ts` borrows the registered code `hr.payroll_register`.
- `hr.payslip` through `POST …/reports/hr.payslip/runs` (7A's queued path) WOULD print the net-pay leg row (a blank
  item, amount = net, contribution 0) — the dataset has no column to exclude it by; only the synchronous payslip route
  drops it. Its total is still the net.

### Tests run (2026-11-07, on T5's tree `7146345`)

- **`packages/db` whole suite: 2,332 passed, 5 skipped in 235 files.**
- **`apps/api` whole suite: 1,036 passed in 106 files.**
- **`apps/worker`: 132 passed in 20 files, plus its two Bun cases.**
- **`tests` whole workspace: 966 passed, 5 skipped, 1 failed in 145 files** — only test 15's PDF hyphens
  (`zero-code-document-type`, known, pre-existing). **`regression/sah-047` now passes** (closed by T5);
  `hr-sensitive-side-channels`, `report-catalogue-pins`, `report-tie-out` / `-7c`, `tenant-isolation` green.
- Static: `bun run typecheck` 14/14, `lint` 0, `lint:rules` 11 rules 0 violations, `format:check` clean, all
  seventeen `scripts/check/*.sh` gates OK. `openapi.json` regenerated (the two new paths and `PermitExpiry`,
  `PermitExpiryList`, `GeneratePayslipsBody`, `Payslip`, `GeneratePayslipsResult`).
- Not run: `bun run e2e` (its boot now seeds seven 8d definitions through the unchanged loader), `packages/domain`
  and the UI workspaces (nothing they load changed).

## 8D T6–T7 (2026-11-07)

### Built

- **T6** (`e17dac9`, ⚠️ OD-28) — **`hr.annual_statement`** (`packages/db/seed/my/reports/8d/hr.annual_statement.json`):
  over `employee_ytd`, `hr.payroll.read`, `tieOut: projection employee_ytd` (T4's arm), parameters `taxYear` (required),
  `employeeId`, `branchId`, `formName`, `formYear` (optional); groups by `employee_number`, totals the two scheme shares
  only (gross/net repeat per scheme row). With `employeeId` = one employee's statement; without = the employer return.
  Tests: `hr-definitions.test.ts` +5 (24), `apps/api/test/routes/accounting/report-runs.test.ts` +1 (202 queued, and
  403 without `hr.payroll.read`), `apps/worker/test/reports/render.test.ts` +1 (queued → done through the unchanged
  `reporting.render`). Owner record **`docs/owner/od-28-form-names.md`**; runbook
  **`docs/runbooks/payroll-parallel-run.md`** created with only the "Annual statements and the employer return" section
  (**Task 9 appends the rest**). All eight 8D definitions are now on disk.
- **T7** (`a58ac86`) — `packages/db/src/hr/rotate.ts`: **`rotateSensitiveBatch(tx, ring, { batchSize, afterEmployeeId,
  companyId? })`** → `RotationBatch`; `RotationResult`, `RotationBatchOptions` (barrel). `JobPayload["hr.encryption_key.rotate"]
  = { batchSize?: number; companyId?: string }`. **`apps/worker/src/hr-keys.ts`**: `hrKeyRing()`, `setHrKeyRing(ring)`,
  **`hrKeyRingFromEnv(env, appEnv = parseAppEnv(env))`**, `parseHrKeyVersion(raw)`; exported as **`@dulja/worker/hr-keys`**.
  **`apps/worker/src/jobs/hr-key-rotate.ts`**: `hrKeyRotateHandler`, `registerHrKeyRotate()`,
  `HR_KEY_ROTATE_DEFAULT_BATCH` (200), `HR_KEY_ROTATE_MAX_BATCH` (5 000); registered in `index.ts` (ring composed at boot,
  exit 2 on a config error) and `test/support/worker.ts` (dev ring v1). **`ApiConfig.hrFieldEncryptionKeyVersion`**;
  `apps/api/src/index.ts` passes it (8A's literal `1` gone). `HR_FIELD_ENCRYPTION_KEY_VERSION` in `apps/edge/src/env.ts`
  and `containerSecrets`' optional list (api + worker). One **`JOB_PROBES`** entry. ADR **0080** (Proposed, two owner
  questions), **`docs/runbooks/hr-key-rotation.md`**, `docs/runbooks/deploy.md`'s rotation note. Tests:
  `packages/db/test/hr/rotate.test.ts` (10), `apps/worker/test/hr/key-rotate.test.ts` (9), `apps/worker/test/hr-keys.test.ts`
  (5), `apps/api/test/config-and-auth.test.ts` +4, `apps/edge/test/containers.test.ts` +1.
- **Fix** (`093cd34`) — `infra/Dockerfile` copies **`packages/domain/payroll`**: 8B's calculator is imported by
  `apps/api/src/problem.ts` and the payroll services, so the runtime image could load neither entrypoint;
  `infra/test/dockerfile.test.ts` had been red (3 cases) since 8B — no Phase 8 agent had run `infra`.

### Deviations from the plan (and why)

1. **`formName` is `text`, not `enum` with `options: []`** — 7A's schema (`minItems: 1`) and validator rule 3 refuse an
   enum without options. The owner's identifiers make it an enum (A13 item 16).
2. **The annual statement carries no cut-over opening**: the dataset reads the projection; `employee_ytd_opening` is a
   read-time addend (round 18 B14). No opening exists until 9B; the runbook forbids issuing a mid-year switch's statement
   from Dulja alone until the dataset adds it. The footer says "from posted payroll lines" (the plan's "and opening
   rows" would have been false).
3. **No `companyId` parameter** on the statement (A13 item 13), and widths are pixels (×6).
4. **The rotation batch reads `for update`** (else a concurrent `writeSensitive` is lost), **honours `companyId`** (the
   plan's comment said "reserved, not read"), opens every value (a value at the current version is kept byte for
   byte), and the handler caps `batchSize` at 5 000 and logs `hr_key_rotation_incomplete` (warn) at its batch bound.
5. **Both readers refuse a previous key beside version 1** and any version but strict digits 1–255; 8A's config case
   that bound a previous key at the default version gained `HR_FIELD_ENCRYPTION_KEY_VERSION: "2"`. The worker now
   refuses to boot outside dev without `HR_FIELD_ENCRYPTION_KEY`.
6. **No `infra/secrets.ts`** — A1's edit is `apps/edge/src/{env,container-env}.ts` (A13 item 3). The deploy runbook's
   secrets block does NOT bind the version (it is optional; `config-and-auth.test.ts` binds every name of that block
   as a key, which a version is not); the rotation runbook binds it.
7. **The JOB_PROBES entry injects a v2 ring** through the new `./hr-keys` export (the harness's v1 ring would rotate
   nothing and prove nothing); seeds and reads as each tenant's system principal (the harness grants humans nothing).
8. Worker logs are `{ level, fields, msg }` (`CapturedLog`), so the plan's `line.rotated` is `line.fields.rotated`.
9. Error texts say "between 1 and 255": `no-sql-concat` reads "from" in an untagged template as SQL.

### Decisions

Seven rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (three T6 incl. OD-28 form names, four T7).
Contracts round 19 **A13 items 16–18**; the 8D gate passes. **No migration**: the rotation writes no system event —
its record is the per-row audit under the system principal and one log line — so no tail number was taken.

### Open — for the next agents

- **Task 9** appends to `docs/runbooks/payroll-parallel-run.md` (the annual-statement section is first; keep it).
- **Task 11**: `ReportCodeSchema` + 8 — all eight 8D files are on disk now.
- **Task 12 / AGENTS.md**: ADR 0080; `apps/worker/src/hr-keys.ts`; `HR_FIELD_ENCRYPTION_KEY_VERSION`; the worker now
  validates the HR key at boot; the rotation has no operator route (ADR 0080 owner question 2) — the runbook enqueues
  it with pg-boss directly; the annual statement's missing opening (9B) and missing registration box (OD-23/28).

### Tests run (2026-11-07, on T7's tree + the Dockerfile fix)

- **`packages/db` whole suite: 2,346 passed, 5 skipped, 1 failed in 236 files** — the failure was
  `seed/tax-pack.test.ts`'s "every seed command any runbook gives names its APP_ENV" on the new
  `payroll-parallel-run.md`'s bare `bun run seed`; fixed in the log commit (`APP_ENV=<staging|production> bun run seed
  …`) and the file re-run green (19/19).
- **`apps/api` whole suite: 1,041 passed in 106 files** (openapi unchanged — no route was added).
- **`apps/worker`: 147 passed in 22 files, plus its two Bun cases.** **`apps/edge`: 47 in 5.** **`infra`: 25 in 3**
  (3 red before the Dockerfile fix).
- **`tests` whole workspace: 966 passed, 5 skipped, 1 failed in 145 files** — only test 15's PDF hyphens
  (`zero-code-document-type`, known, pre-existing). `job-isolation` (the new probe), `phase-5-exit`, tenant isolation,
  report pins green.
- Static: `bun run typecheck` 14/14, `lint` 0, `lint:rules` 11 rules 0 violations, `format:check` clean, all
  seventeen `scripts/check/*.sh` gates OK.
- Not run: `bun run e2e`, `packages/domain`, `packages/contracts` and the UI workspaces (nothing they load changed).

## 8D T8 (2026-11-07) — ⚠️ OD-13, the leave register (answered BUILD)

### Built

- **Migration `0096_create_leave_register.sql`** (+ down): `app.leave_type` (code ∈ annual/sick/unpaid/other, unique per
  company, `paid`, `archived_at`; `unique (tenant_id, company_id, id)` as the children's company-bound FK target),
  `app.leave_entitlement` (yearly `days numeric(6,2)`, `entered_by` stamped, unique (employee, year, type)),
  `app.leave_record` (requested → approved | rejected; `approved_by` stamped = the DECIDER of either), `app.public_holiday`
  (NULL branch = company-wide, `unique nulls not distinct`, Form B `branch_isolation`). R4: 8A's
  `app.forbid_self_pay('employee_id')` attached as **`leave_record_no_self_approve`**. Plus (beyond the plan, see
  Deviations): RESTRICTIVE **`employee_parent_visibility`** on entitlement and record; **`app.guard_leave_record()`**
  (trigger `leave_record_decision_final`); CHECKs `(status = 'requested') = (approved_by is null)` and
  `days <= ends_on - starts_on + 1`. The two `hr.leave.*` permission rows are inserted here (8D A9).
- **`packages/contracts/permissions.ts`**: `hr.leave.record`, `hr.leave.approve` (phase `"8D"`, mutating).
  **`packages/db/seed/roles.ts`**: both → `hr_payroll` (contracts §3.6.4's sentence extended).
- **Mirrors** `packages/db/src/schema/{leave-type,leave-entitlement,leave-record,public-holiday}.ts`, exported from
  `schema/index.ts` as `leaveTypeTable`, `leaveEntitlementTable`, `leaveRecordTable`, `publicHolidayTable`
  (`schema-mirror.test.ts` 86 → 90).
- **Service `packages/db/src/hr/leave.ts`** (barrel-exported): `requestLeave(tx, RequestLeaveInput) → id`,
  **`approveLeave(tx, { companyId, leaveRecordId }) → boolean`**, **`rejectLeave(tx, { companyId, leaveRecordId,
  reason? }) → boolean`**, `listLeaveRecords(tx, LeaveRecordFilter)` (filters `id`, `employeeId`, `leaveTypeId`,
  `status`, `fromDate`/`toDate` on `starts_on`), `setEntitlement`, `listEntitlements`, `createLeaveType`,
  `listLeaveTypes` (row carries `archivedAt`), `createPublicHoliday`, `listPublicHolidays`; **`LeaveError`**
  (`ERR_NOT_FOUND` | `ERR_VALIDATION_FAILED`) and the plan's types plus `LeaveDecisionInput`, `RejectLeaveInput`,
  `LeaveTypeCode`, `LeaveStatus`, `LeaveErrorCode`.
- **Dataset `leave_record`** (`leaveRecordDataset` in `datasets/hr.ts`) — the 34th `DatasetId`;
  `DATASET_READ_CODES.leave_record = ["hr.employee.read"]`. Fields: leave_record_id, employee_id, employee_number,
  employee_name_en, employee_name_ar, branch_id, branch_code, leave_type_id, leave_type_code, leave_type_name_en,
  leave_type_name_ar, paid, starts_on, ends_on, days, status, approved_by, reason. **No report definition** reads it
  (§4.16.1 has no leave code) — **Task 11's `ReportCodeSchema` widening stays at the eight `hr.*` codes.** The three
  registry pins moved 33 → 34 (`datasets.test.ts` literal array, `7c-datasets.test.ts` length,
  `report-catalogue-pins.test.ts` length + `slice(28)`); `hr-datasets.test.ts`' first case now pins `slice(-6)`/34 and
  gained a nested `leave_record` describe (3 cases).
- **Export** (`packages/db/src/export/tables.ts`): `leave_type`, `public_holiday` ungated; `leave_entitlement`,
  `leave_record` under `hr.employee.read`.
- **Contracts `@dulja/contracts/hr/leave`** (subpath; `src/index.ts` untouched, round 19 A13 item 15).
- **Routes `apps/api/src/routes/hr/leave.ts`**: `leaveRoutes` / **`leaveRouteModule`** at
  `/v1/companies/:companyId/leave-records`, registered in `buildRoutes` after the statutory-schedules module; one
  **`PROBES`** key (expects **403**). `openapi.json` regenerated; `apps/api/test/openapi.test.ts`'s path pin +5.
- **F-21 case** (`apps/api/test/routes/admin/document-types.test.ts`) now names **`hr.leave.accrue`** — outside the
  catalogue by design (spec:2085: no accrual engine), so it never needs moving again.
- Docs: contracts round 19 **A13 item 19** (a)–(j), §2.12's OD-13 row ("answered 2026-11-07: build"), §3.6.4's
  sentence; six rows in `docs/review/2026-11-07-phase-8-decisions.md`. The plan names no OD-13 owner record file; the
  decisions row + round 19 A14/A13 item 19 + §2.12's row are the record.

### API surface for Task 10's leave screen (all under `/v1/companies/{companyId}/leave-records`)

| Method + path | Gate | Body / query | Answers |
|---|---|---|---|
| `GET /` | `hr.employee.read` | `filter[status][eq]`, `filter[employee_id][eq]`, `filter[leave_type_id][eq]`, `filter[starts_on][gte\|lte]`, `limit` ≤ 200 (default 50); strict | `LeaveRecordList` (`next_cursor` always null), newest `startsOn` first |
| `POST /` | `hr.leave.record` | `CreateLeaveRecordBody` {employeeId, leaveTypeId, startsOn, endsOn, days `"d.dd"`, reason?} strict | 201 `LeaveRecord` (`status: requested`, `approvedBy: null`); 400 span/days; 404 employee/type not in company |
| `POST /{leaveRecordId}/decision` | `hr.leave.approve` | `LeaveDecisionBody` {decision: approved\|rejected, reason?} strict | 200 `LeaveRecord` (`approvedBy` = caller); 404; **409 `ERR_HR_SELF_PAY`** (own leave); **409 `ERR_TABLE_IMMUTABLE`** (already decided) |
| `GET /types` / `POST /types` | `hr.leave.record` | `includeArchived=true\|false`, `limit` / `CreateLeaveTypeBody` {code, nameEn, nameAr?, paid?} | `LeaveTypeList` / 201 `LeaveType`; 409 `ERR_CONFLICT_UNIQUE` (code exists) |
| `GET /entitlements` / `PUT /entitlements` | `hr.leave.record` | `filter[employee_id][eq]`, `filter[year][eq]`, `filter[leave_type_id][eq]`, `limit` / `SetLeaveEntitlementBody` {employeeId, year, leaveTypeId, days} | `LeaveEntitlementList` / 200 `LeaveEntitlement` (upsert); 404 |
| `GET /holidays` / `POST /holidays` | `hr.leave.record` | `filter[holiday_on][gte\|lte]`, `limit` / `CreatePublicHolidayBody` {branchId \| null, holidayOn, nameEn, nameAr?} | `PublicHolidayList` (RLS shows company-wide + the caller's branches) / 201; 404 foreign branch; 409 duplicate |

`LeaveRecord` = {id, employeeId, employeeNumber, leaveTypeId, leaveTypeCode, startsOn, endsOn, days, status,
approvedBy, reason} — no employee name: the screen joins the staff directory (`GET …/employees`) for names. All
unsafe methods need `Idempotency-Key`. The seeded `hr_payroll` holds all three codes; R4 refuses the officer's own leave.

### Deviations from the plan (and why)

1. **`employee_parent_visibility`** on `leave_record` / `leave_entitlement` (A8's "isolated through employee" made
   concrete): without it, `forbid_self_pay`'s RLS-bound employee lookup returns nothing for an approver outside the
   employee's branch, so a branch-restricted principal whose own employee row sits in another branch could approve
   their own leave — reproduced against PostgreSQL 18 with the policy dropped (scratch run, not committed); pinned by
   "R4 holds for a branch-restricted approver…" in `leave.test.ts`.
2. **`(status = 'requested') = (approved_by is null)`** replaces the one-way check, and **a decided record is final**
   (`app.guard_leave_record`, `ERR_TABLE_IMMUTABLE`; insert only at `requested`): otherwise a rejected record could be
   flipped to approved by a third principal under the first decider's stamp. Consequence: a second decision is **409**,
   not the plan's idempotent 200; `approveLeave`/`rejectLeave` have no `status = 'requested'` predicate on purpose.
3. **Company bind in the service**: decisions take `{ companyId, leaveRecordId }`; request/entitlement insert through a
   join on employee + type of the path company → `LeaveError` `ERR_NOT_FOUND` → **404** (8A precedent), not 409.
   Composite FK `(tenant_id, company_id, leave_type_id)` is the data-layer backstop. A holiday's branch must be a
   BRANCH value of the company (404).
4. Plan test code adapted: `app.principal` has no `tenant_id`; the API test's R4 subject is hrFixture's E-1003 (the
   officer) — `employee.principal_id` is unique, so the plan's second self-employee could not be seeded.
5. **PROBES expects 403**, not 404 (gate refuses a foreign path company first, as every 8A–8C probe).
6. Wire: every write body `.strict()`; `days` regex `^\d{1,4}\.\d{2}$` (numeric(6,2)); the request body refuses a span
   that ends before it starts, zero days or more days than the span (400 naming the field) so the CHECKs never surface
   as a 500. `rejectLeave` replaces the reason only when one is given.
7. `0096.down.sql` deletes `app.permission` only (0089/0095/0097 precedent; unseeded-database precondition).
8. Three more branch-policy pins moved 20 → 21 for `public_holiday`'s Form B: `packages/db/test/staff/branch-isolation.test.ts`
   (the policy list), `tests/invariants/branch-scoping.test.ts` (count + the Form B tables the A/B fixture does not
   cover) and `tests/regression/sah-033.test.ts` (count).

### Decisions

Six rows appended to `docs/review/2026-11-07-phase-8-decisions.md` (OD-13 as built — implementation authorization, not
acceptance; test 31's leave clause and the three hardenings; 404/409/403 answers; export gates; the F-21 move; no leave
report definition). Contracts round 19 **A13 item 19**; the 8D gate passes.

### Open — for the next agents

- **Task 10** (screens): the leave screen consumes the API table above; the register has no employee names (join the
  directory). Holidays are RLS-filtered to the caller's branches plus company-wide rows.
- **Task 11**: `ReportCodeSchema` + the eight `hr.*` codes only; no leave definition exists (`leave_record` is a designer
  source, like `till_event`).
- **Task 12 / AGENTS.md**: in the tree add `0096`; 8D's migrations are now `0096`–`0098` (0099 unused); the
  `leave_record` dataset (34 `DatasetId` members); the RESTRICTIVE `employee_parent_visibility` policy on
  `leave_entitlement`/`leave_record` and `app.guard_leave_record()` beside the reviewed controls; OD-13 answered build.

### Tests run (2026-11-07, on T8's tree)

- **`packages/db` whole suite: 2,367 passed, 5 skipped, 1 failed in 237 files** — the failure was 6C's
  `staff/branch-isolation.test.ts` policy list (the `public_holiday` pin), moved and re-run green (16/16).
- **`apps/api` whole suite: 1,052 passed in 107 files.**
- **`apps/worker`: 147 passed in 22 files, plus its two Bun cases.**
- **`tests` whole workspace: 965 passed, 5 skipped, 3 failed in 145 files** — test 15's PDF hyphens
  (`zero-code-document-type`, known, pre-existing) and the two 20 → 21 branch-policy pins (`branch-scoping`,
  `sah-033`), moved and re-run green with `tenant-isolation`, `sah-047` and `report-catalogue-pins` (5 files, 102).
- `packages/contracts` 69, `apps/backoffice` 257. Static: `bun run typecheck` 14/14, `lint` 0, `lint:rules` 11 rules
  0 violations, `format:check` clean, all seventeen `scripts/check/*.sh` gates OK. `openapi.json` regenerated (the five
  leave paths and their schemas; the large diff is component re-ordering by registration).
- Not run: `bun run e2e` (no screen changed), `packages/domain`, the POS/UI workspaces (nothing they load changed).

## 8D T9–T10 (2026-11-07/08)

### Built

- **T9** (`f21e2ed`, ⚠️ OD-23 — the run half) — `packages/db/src/hr/reconcile.ts` (barrel-exported):
  **`reconcileParallelRun(tx, { companyId, payrollDocumentId, baseCurrency }, legacy)`** → `ReconciliationReport`,
  **`renderReconciliation(report)`** (deterministic Markdown), plus **`parseLegacyCsv(text)`** → `LegacyPayslip[]` and
  **`ReconcileError`** (`ERR_VALIDATION_FAILED` | `ERR_NOT_FOUND`); types `LegacyPayslip`, `Difference`,
  `DifferenceKind`, `ReconciliationReport`, `ReconcileErrorCode`. The Dulja side is `payslipRows` (the paper's
  figures). **`scripts/payroll-reconcile.ts`** + root script **`payroll:reconcile`** (`--tenant --company --run --legacy
  --out [--currency]`, exit 0 with or without differences, 2 on configuration/input error; `--self-test` spawns the
  vitest case "clean to the cent" and prints `differences: 0 — clean to the cent`). Relative imports (the
  `reseed-verify.ts` precedent), `DATABASE_URL` (`app_rw`), the tenant's system principal. Tests
  `packages/db/test/hr/reconcile.test.ts` (13, incl. the real CLI spawned against the Testcontainers DB). Runbook
  `docs/runbooks/payroll-parallel-run.md`: intro + Before the month / During the month / After the run / The acceptance /
  What is not allowed, above T6's section. `docs/owner/od-23-employer-registrations.md` gains "What 8D adds".
- **T10** (⚠️ OD-24 — owner: BUILD) — back office:
  - **Payslips** panel on `src/routes/hr/payroll-run.tsx` for a posted/reversed run (language, everyone or one
    employee; file name, size, SHA-256; download via 2C's content route; Enter on a row downloads) and a link to the
    run's `hr.payroll_register` in 7A's run screen with `payrollDocumentId` filled. `payrollApi.payslips`,
    `payrollApi.payslipContent`.
  - **HR reports = 7A's screens reused**: `ReportsRoute` prop **`module`** (`/reports?module=hr`, module filter),
    `ReportRunRoute` prop **`preset`** (`/reports/$code?parameters=…`), `ParameterForm` prop **`code`** with
    `report.param.for.<code>.<name>` labels; HR parameter labels and options in the catalogues.
  - **`/hr/permit-expiry`** (`src/routes/hr/permit-expiry.tsx`, `hrApi.permitExpiry`).
  - **`/hr/leave`** (`src/routes/hr/leave.tsx`, `src/lib/leave-api.ts` = `leaveApi`): records (status filter, request
    form, approve/reject; Enter on a requested row opens a decision panel with Approve focused), entitlements (by year,
    upsert form), leave types, public holidays. Exports `daysToWire`, `yearOf`, `leaveStatusKey`.
  - Nav: **Leave register**, **Permit expiry**, **HR reports** (`app.nav.leave`, `.permitExpiry`, `.hrReports`).
  - Tests: `apps/backoffice/test/hr-8d.test.tsx` (25); e2e `tests/e2e/payslips.spec.ts` and `tests/e2e/leave.spec.ts`
    (2 each, en/ar). Boot (`tests/e2e/support/boot.ts`): operator += `hr.filing.generate`, `hr.leave.record`,
    `hr.leave.approve`; a POSTED June supplementary run (`postPayrollRun`), a permit sealed +30 days on E-0002, leave
    type `annual` and one requested leave each for E-0001/E-0002 (system principal).
  - Docs: `docs/ui/od-24-phase-8d.md`; contracts round 19 **A13 items 20 (T9) and 21 (T10)**; five T10 rows and two T9
    rows in `docs/review/2026-11-07-phase-8-decisions.md`.

### Deviations from the plan (and why)

1. T9: the CSV parser is in `packages/db` and exported/tested (the plan kept it in the script); it refuses >4 dp, short
   rows, repeated or blank employee numbers. A run with no posted bundles is **refused** (`ReconcileError` → exit 2)
   instead of reporting every legacy employee missing. Sorting is by code unit, not `localeCompare` (byte-identical
   Markdown on every machine). The hazard-1 self-scan uses a word-boundary regex for "rate" (the plan's
   `not.toContain("rate")` would match its own line).
2. T10 was built (owner answer) where the plan created no file; the screens follow the tree's layout
   (`src/routes/hr/*`, tests under `apps/backoffice/test/`). The run review is 8B's approval screen + the register
   report (no second grid); beyond the plan's three screens, the permit list and the leave register were built per the
   owner's direction for this task.
3. `ReportCodeSchema` is **not** widened (still Task 11's): no back-office path consults it.
4. Two Phase 7 tests moved: `tests/e2e/reports.spec.ts` names its **Reports** nav link `exact` (HR reports also
   matches); `apps/backoffice/test/shell.test.tsx` compares each nav link's path (not its search string) and pins the
   two new paths. The catalogue's `payslip.lang.*` avoid the endonyms ("English"/"العربية"), which
   `pos-rtl-parity.spec.ts` would otherwise flag as untranslated on the till.

### Decisions

Seven rows in `docs/review/2026-11-07-phase-8-decisions.md` (T9: OD-23's run half, the reconciliation's refusals; T10:
OD-24 as built, reuse of 7A's report screens, the grid's keyboard path, earlier payslip generations not listed, the
e2e operator and seed).

### Open — for the next agents

- **Task 11**: `ReportCodeSchema` + the eight `hr.*` codes (and `report-catalogue-pins`). The screens do not need it.
- **Task 12 / AGENTS.md**: the DoD's first clause stays open on OD-23 (the owner's staff list, legacy month, accountant
  sign-off and written acceptance); `bun run payroll:reconcile` is the tool. 7A's `DataGrid` steals focus from a
  button inside a cell (in-row buttons are mouse-only; every 8D screen gives a row-Enter path). Earlier payslip
  generations are listed only under `accounting.ledger.read` (2C's attachment list gate). OD-24 for 8D is built with
  legacy parity unproven (`docs/ui/od-24-phase-8d.md`).

### Tests run (2026-11-08, on T10's tree)

- **`packages/db` whole suite: 2,381 passed, 5 skipped in 238 files** (reconcile 13).
- **`apps/api` whole suite: 1,052 passed in 107 files** (no route changed; `openapi.json` untouched).
- **`apps/backoffice` whole suite: 282 passed in 15 files** (hr-8d 25; shell 29).
- **`tests` whole workspace: 967 passed, 5 skipped, 1 failed in 145 files** — only test 15's PDF hyphens
  (`zero-code-document-type`, known, pre-existing).
- **`bun run e2e`: 33/33** (payslips 2, leave 2 new; reports 2 with the `exact` nav link; pos-rtl-parity 4 after the
  `payslip.lang.*` wording kept clear of the endonyms).
- `packages/i18n` 41. `bun run payroll:reconcile --self-test` prints `differences: 0 — clean to the cent`.
- Static: `bun run typecheck` 14/14, `lint` 0, `lint:rules` 11 rules 0 violations, `format:check` clean, all seventeen
  `scripts/check/*.sh` gates OK (8D gate with A13 items 20–21). The script was also typechecked ad hoc against
  `packages/db`'s config (no workspace covers `scripts/`).
- Not run: `apps/worker`, `packages/domain`, `packages/contracts` and the POS/desktop workspaces (nothing they load changed).

## 8D T11–T12 (2026-11-08)

### Built

- **T11** (`4f129e7`) — `ReportCodeSchema` (`packages/contracts/src/accounting/reports.ts`) gains §4.16.1's eight `hr.*`
  codes after 7C's last member, in register order. `tests/invariants/report-catalogue-pins.test.ts`: the Phase 7
  "exactly the shipped definitions" pin moves 32 → **40** (`CATALOGUE_7B + CATALOGUE_7C + HR_CATALOGUE`), and a new
  "8D pins" block holds the wire enum and `HR_CATALOGUE` together in both directions (and every 8D gate is a registered
  read code, five on `hr.payroll.read`, three on `hr.employee.read`). `packages/db/test/seed/reports.test.ts`: the real
  `8d/` directory loads idempotently on a tenant of its own (eight `hr.*` rows at version 1; the second run inserts
  nothing). Regression blocks appended: **sah-011** (payslip header figures are 4 dp, never null; an employee missing
  from Dulja is reported), **sah-020** (no rate shape in the seven 8D sources, no number in an 8D definition but
  `version`/`width`, no scheme name as a value), **sah-033** (no 8D definition names a sensitive field, no HR dataset
  joins a gated table, the permit list is empty for a company member without the code), **sah-085** (the payslip's
  labels per language and the same figures as a set; one definition per code, every Arabic label its own). Contracts
  round 19 **A13 item 22**.
- **T12** — `docs/reports/phase-8.md` (the clause-by-clause record), `docs/review/2026-11-08-phase-8-exit.md` (the exit
  review), and `AGENTS.md`: a Phase 8 bullet at the top of **Current phase** (earlier bullets kept), and **Current State**
  updated — OD-13 answered build, OD-14/OD-23/OD-28 open, OD-24's Phase 8 screens built on the default baseline; ADRs
  0071–0080 awaiting; the eighth (0090), ninth (0093) and tenth (0094) reviewed widenings and Phase 8's tightenings;
  `PAYROLL_PAYMENT`/`EMPLOYEE_ADVANCE` in the irreversible list; Phase 8's known limits; the HR key in the deployment
  note; and "In the tree" (0080–0098, 0099 unused, tails 0120/0121, ADRs to 0080, twenty-seven document types, the 8A–8D
  gates, the four payroll test helpers).

### Deviations from the plan (and why)

1. **The plan's `ReportCodeSchema` case is not in `packages/db/test/reports/hr-definitions.test.ts`**: a `packages/db`
   test may not import `@dulja/contracts` (round 18 B16 item 3). It is in the catalogue-pins file, which already pinned
   the Phase 7 total and said the next widening slice must move it.
2. **The regression blocks share the workspace's single database and API** (`sharedDb()` / `sharedApi()`) with a fresh
   `seedTenantV2` tenant per block — the 8C precedent — rather than the plan's `startDb()` / `startApi()` per block.
   SAH-085's figures are compared as a set (test 15's PDF hyphen artefact, as `payslips.test.ts`); SAH-020's scan covers
   seven 8D sources (the plan's four plus `permit-expiry.ts`, `leave.ts` and `apps/api/src/print/payslip.ts`) and
   matches scheme names on word boundaries across sources and definitions.
3. **T12's deliverables follow the orchestrator's names** — `docs/reports/phase-8.md` and
   `docs/review/2026-11-08-phase-8-exit.md` in the form Phase 7 set — not the plan's
   `docs/reports/phase-8-definition-of-done.md`; the content is the plan's four sections and more.
4. `openapi.json` is unchanged by T11: no route validates `{code}` against the enum.

### Tests run

See the verification table in `docs/reports/phase-8.md`.

## Phase 8 review pass (2026-11-08)

Final review-and-fix pass over `6bbf287..`. Four fixes, one commit each, each with a regression test run red first
(`docs/reports/phase-8.md`, "Review pass (2026-11-08)"):

1. `268bf66` — the tenant export bounds an `hr` document's rows by `hr.payroll.read` (`MODULE_ROW_GATES`,
   `MODULE_BOUNDED_TABLES`, `ExportRowScope`/`EVERY_ROW`, `ExportTable.moduleRows`, `rows(tx, companyId, scope)`;
   manifest `excludedRows`; export screen lists them). `seedExportJob` gained `requestedBy`. ADR 0069 amendment.
2. `b16835f` — 2C's attachment list, naming a document, asks that document's `MODULE_READ_CODE` row; the payroll run
   screen lists the payslips already on the run (`payrollApi.runAttachments`). Contracts "Phase 8 review" R2.
3. `7154890` — `GET …/documents/{id}` of an `hr` document also asks `hr.payroll.read`.
4. `2400263` — `refuseServiceOnlyType` refuses PAYROLL, PAYROLL_PAYMENT and EMPLOYEE_ADVANCE on the generic routes.

Recorded, not fixed: 7A's `document`/`document_line`/`ledger_entry` datasets serve `hr` rows under the accounting codes
(a render-time module bound, ADR 0065); the archived statutory-schedule file is read under `hr.payroll.read` though its
scheme references are compensation-gated.
