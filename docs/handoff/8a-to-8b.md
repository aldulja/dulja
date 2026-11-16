# 8A → 8B — what the payroll engine can rely on

Written at 8A's slice exit (Task 14, 2026-11-07). The running record of what each 8A task shipped, and every
deviation from the plan, is `docs/reports/phase-8-progress.md`; the owner-question resolutions are
`docs/review/2026-11-07-phase-8-decisions.md`.

**Tables.** `employee` (extended by 0080), `employee_sensitive` (0081), `employee_statutory_profile` (0082),
`pay_component`, `pay_component_scheme`, `compensation_line` (0083), `statutory_scheme`, `statutory_rate_table`
(0084), `company_hr_setting` (0085). Migrations 0080–0086 plus the tail migration **0120** (the lapse job's
`record_system_event` admission, register row "8A overrun"); the schema linter reports zero violations.

**The four reads 8B's `EmployeePeriodInput` (§4.12.1) is built from**, all on the `@dulja/db` barrel:

- `profileOn(tx, employeeId, on)` → `StatutoryProfile | null` — the effective-dated inputs (⚠️ OD-28: the three
  spec:2077 fields, `residencyCategory`, and `extra` as the seam).
- `compensationOn(tx, employeeId, on)` → `CompensationLine[]` — `Money` and `Quantity`, never a number.
- `listPayComponents(tx, companyId, { includeArchived? })` → `PayComponent[]` with `schemeIds` already joined.
- `rateTableOn(tx, schemeId, on)` → `RateTableRow | null` — **verified tables only**. A null is what
  `ERR_PAYROLL_RATE_TABLE_UNVERIFIED` (test 29) is raised on; 8B does not re-check `verified_at` itself, and must
  not, or two places would decide one rule.

Every one of them takes the company or the employee as a parameter: RLS bounds the tenant only, and an 8B route
that clears a path company must pass that company down (the 8A employee-scope rule, `requireEmployeeInCompany`).

**The type.** `import type { RateTable } from "@dulja/domain/payroll"` — generated from `rate-table.schema.json`
and committed, with a drift guard. `parseRateTable` throws `RateTableValidationError` with JSON Pointers.
`packages/domain/src/**` may not import it (spec:2366) and the `dependency-rule` lint says so.

**The settings.** `readHrSetting(tx, companyId)` → `CompanyHrSetting | null`. **A null is normal** (⚠️ OD-23: no
row is seeded); the §2.12 default is `calendar_days` with no pay day, which is what `GET …/hr-settings` answers. 8B
reads `prorationRule` from here and enters `payDate` per run — never derived from a null `payDay`. The employer
registrations are `statutory_scheme.employer_registration` (`employerRegistrations(tx, companyId)`), null until the
owner supplies them; 8C's schedule and 8D's annual return name a missing one.

**Four things 8B must do that 8A deliberately did not.**

1. **Seed the accounts and wire them.** `pay_component.expense_account_id`, `pay_component.payable_account_id`,
   `statutory_scheme.payable_account_id` and `employer_expense_account_id` are **null**. 8B's
   `chart-of-accounts/8b-payroll.json` seeds `5300`, `2400`, `1400`, `2411`–`2414` and `5311`–`5314` (§4.15) and the
   same task sets these four columns from those codes. Until it does, the `PAYROLL` policy fails closed with
   `ERR_POLICY_REQUIRES_MISSING`, which is the correct failure and not a bug.
2. **Decide applicability.** `pay_component_scheme` is **empty**. Which components a scheme applies to is a
   statutory claim and arrives with OD-23 in the same pull request as the rate tables. The join is additive (A14):
   `PUT …/pay-components/{id}/schemes` adds, nothing removes.
3. **Detect an R3 recalculation.** `compensation_line` and `employee_statutory_profile` are close-then-open with at
   most one open row (ADR 0072), so the trigger condition is "a row whose `[effective_from, effective_to]` overlaps
   the run's period and whose `created_at` is after the run's `calculated_at`".
4. **Add the `hr` row to `MODULE_READ_CODE`** (§4.5.8, `apps/api/src/middleware/require-attachment-read.ts`) when
   `hr.payroll.read` is seeded — until then an `hr` attachment is a default deny.

**The export registry (7C-FIRST, so 8A wrote it).** `packages/db/src/export/tables.ts` now registers every 8A
table: `employee_sensitive` gated on `hr.employee.read_sensitive` with **metadata columns only** (`employee_id`,
`key_version`, `updated_by`, `updated_at`, `created_at`) and `NEVER_EXPORTED["employee_sensitive"]` narrowed to the
nine `*_enc` columns; `employee_statutory_profile`, `compensation_line`, `pay_component` and `pay_component_scheme`
gated on `hr.compensation.read`; `statutory_scheme` and `statutory_rate_table` gated on
`hr.statutory_table.manage`; `company_hr_setting` ungated (configuration); and the `employee` row gains 0080's
`position`, `employment_type` and `archived_at` (`statutory_profile_note` is left `omitted`). **A table 8B adds must
get its own row or pin, or `packages/db/test/export/tables.test.ts` fails.** Test 32's export case is in
`tests/invariants/hr-sensitive-side-channels.test.ts`.

**Two `fixtures.ts` facts.** `SYNTH_RATE_TABLE_V1` is the const 8B's `packages/db/seed/test/statutory/SYNTH/v1.json`
must match number for number. `hrFixture(api, name?)` in `tests/invariants/support/hr.ts` is the shared corpus:
three employees, one of whom **is** the officer, so an R4 case needs no set-up of its own; the officer holds every
8A code but verify, plus 6C's two and `admin.company.manage`; the checker holds verify **and** manage. **It takes
the running API as a parameter** (A6) — pass your own `startApi()` result and a distinct `name`. Test principals
need a live role in the company: 6C's `branch_isolation` hides every employee from a principal with none.

**The back office.** The HR screens are built (`apps/backoffice/src/routes/hr/`, `docs/ui/od-24-phase-8a.md`): an
8B run screen inherits `hrApi` (`apps/backoffice/src/lib/hr-api.ts`), `StaffCompanyGate`, the `hr.*` catalogue keys
and `tests/e2e/hr.spec.ts`'s seeded `E2E-HR` employee and `SYNTH` scheme.

**What is still open.** OD-28 (the profile field list — the `extra jsonb` seam), OD-23 (the tables, the
registrations, the pay conventions), OD-14 (the four HR facts, `docs/owner/od-14-hr-facts.md`), OD-24's legacy
keyboard parity (the screens are built on the default baseline, parity unproven), ADRs 0071–0073 (Proposed).
