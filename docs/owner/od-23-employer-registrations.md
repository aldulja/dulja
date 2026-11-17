# OD-23 — employer registrations, the accountant's tables, and the pay conventions

**Decision needed from the owner and the owner's accountant.** Four separate things travel under
one id in the contracts document's ledger (§2.12); two of them block nothing in 8A and are listed
here so nobody hunts for them later.

**Owner provides:** the company's EPF, SOCSO, EIS and LHDN employer registration numbers; the
proration rule the accountant confirms (`calendar_days` or `working_days`); and the pay day of the
month (spec:2086, 2088, 2407).

**Verify:** after the seed, `bun run --cwd packages/db seed --tenant "$TENANT" --only statutory`
exits 0 and
`psql "$DATABASE_URL_MIGRATOR" -c "select code, employer_registration is not null as registered from app.statutory_scheme order by code"`
prints `registered = t` for all four schemes.

**Until provided:** `app.company_hr_setting` (migration 0085) ships with **no row seeded at all**
and every `statutory_scheme.employer_registration` is null. A company with no row reads the
§2.12 default — `calendar_days`, no pay day — from `GET /v1/companies/{companyId}/hr-settings`.
Nothing in 8A, 8B or 8C refuses to run meanwhile. Every test uses a row it inserts itself and
synthetic `SYNTHETIC-REG-…` values.

## 1. Employer registration numbers — 8A (Task 11)

The company's registration number with each authority (EPF, SOCSO, EIS, LHDN). They are stored
**one per scheme**, on `app.statutory_scheme.employer_registration` — relational, because spec:2088
says these are "relational company settings supplied by the owner — never a blob". The
`employer_registrations jsonb` "display copy" §4.6.1 once named is deliberately not built
(contracts round 16, amendment A4): a second store with no rebuild path is LEGACY-078 in miniature.

They can be entered by an administrator holding `admin.company.manage` through
`PUT /v1/companies/{companyId}/hr-settings` (the back office's HR settings screen), or delivered in
the seed pack: `packages/db/seed/my/statutory/schemes.json` gains an `employerRegistration` member
per scheme and the `statutory` loader writes it.

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

## 3. The proration rule — 8A (Task 11) and 8B

`calendar_days` or `working_days`, for mid-month joiners and leavers and for unpaid days. spec:2086
calls this "configuration, never a statutory claim", so the accountant confirms the company's
practice rather than us reading a rule out of a statute. Default written into the plan:
`calendar_days`. Stored on `app.company_hr_setting.proration_rule` (CHECK admits exactly the two
values), beside `pay_day` (1–31 or null).

## 4. The staff list and the pay-period conventions — 8B and 8D

Who is on the payroll, and the pay period and pay date conventions. 8D's one-month parallel run
needs the real list; 8A needs none of it.

**What changes when the owner answers:** seed data only — `schemes.json` gains the registrations
and one `company_hr_setting` row is written with the confirmed rule and pay day. No migration and
no code change; that is the point of A3's relational column and A4's dropped blob.

## What 8B adds (8B Task 12, 2026-11-07)

**Until the owner answers — the default in force:** `SYNTH`, the clearly synthetic scheme of contracts
§4.12.4, now on disk at `packages/db/seed/test/statutory/SYNTH/v1.json` (display name
`SYNTHETIC-TEST-v1` in its `source.publication`; authority `"Dulja test fixture"`; a `.invalid` URL;
verification method `synthetic_test`). It is the same table as the fixture constant every payroll
test seeds (`SYNTH_RATE_TABLE_V1`), and `packages/db/test/payroll/synth-guard.test.ts` asserts the two
agree, that the file validates against the §4.12.3 schema, and that **no `v<n>.json` exists under
`packages/db/seed/my/statutory/EPF|SOCSO|EIS|PCB/`** — each holds only its `.gitkeep`. No `seed/test`
file is ever applied by `bun run seed`.

**The acceptance when the tables arrive** is three commands: `bun run seed --tenant "$DULJA_TENANT"
--only statutory` (8A's loader; `loaded_by` is the seed principal); then, as a **different** principal
holding `hr.statutory_table.verify`, `POST /v1/companies/{companyId}/statutory-schemes/{schemeId}/rate-tables/{version}/verify`
(8A's route; the loader is refused with `ERR_HR_SELF_VERIFY`); then `bun run --cwd tests test --
golden/payroll`, with each worked example added as a golden case.

| Arrives | Exact change | Owner |
|---|---|---|
| A verified rate table per scheme | `packages/db/seed/my/statutory/<SCHEME>/v1.json`, applied by 8A's `statutory` loader and verified through 8A's verify route by a different principal. **No 8B code changes** — `loadPayrollInputs` reads whatever `statutory_rate_table` holds. The guard's first two cases are then updated in the same PR to name the files that arrived. | 8A applies; 8B consumes |
| A scheme whose shape is none of the three `kind`s | A fourth `kind` in `packages/domain/payroll/rate-table.schema.json` plus a fourth `SchemeCalculator` in `packages/domain/payroll/schemes/`; §4.12.3 is amended first (ADR 0074's consequence clause). | contracts, then 8B |
| The worked examples (at least two per scheme, signed) | One golden case per example under `tests/golden/payroll/<scheme>-worked-<n>/`, byte-compared by `tests/golden/payroll.test.ts`. The examples are the acceptance (spec:2109's PCB mitigation). | 8D's parallel run consumes them too |
| Employer registration numbers | `statutory_scheme.employer_registration` (8A, through `PUT …/hr-settings`). No 8B change. | 8A |
| The pay-period and pay-date convention | `company_hr_setting.pay_day` (8A) and the `periodStart` / `periodEnd` / `payDate` a run is created with. No code change — they are inputs. | operator |

## What 8C adds (8C Task 15, 2026-11-07)

8C is the **first consumer** of two OD-23 clauses — the employer registration numbers and the pay-period / pay-date
convention — and closes both on the plan's default. The rate-table half stays 8B's (above); the upload **layout** of a
schedule is OD-28's (`docs/owner/statutory-layouts/README.md`).

**Owner provides:** (a) the registration number with each scheme, as a plain string per scheme (§1 above);
(b) the pay-period and pay-date convention in writing, confirmed by the accountant — is a pay period a calendar month,
and is the pay date inside it or in the following month? The one thing 8C needs from (b) is which **calendar year** a
period's figures accumulate into.
**Verify:** the `psql` command at the top of this file prints `registered = t` for every scheme, and
`bun run --cwd packages/db test test/hr/tax-year-convention.test.ts` is green with the `⚠️ OD-23` case un-skipped.
**Until provided — the default in force:**

- `statutory_scheme.employer_registration` stays null. A schedule is still generated, its totals are still correct and
  test 30's tie-out is unaffected — a registration is a _filing_ fact, never a _ledger_ fact. What 8C adds is that the
  null is **visible**: every `StatutoryScheduleResult` (generator, `readSchedule`, `listSchedules`) carries
  `employerRegistration`, the API's `StatutorySchedule` body carries it as a **required, nullable** field (never an
  absent key), and `missingEmployerRegistrations(tx, companyId)` returns the codes of the company's schemes that lack
  one, sorted — so 8D's employer return prints the scheme's name beside the gap instead of an empty box.
- **`employee_ytd.tax_year` is the calendar year of `payroll_run.pay_date`** (contracts round 18 B7, ADR 0077). A
  convention 8C fixes, **not a statutory claim**: no rate, threshold, relief or deadline follows from it anywhere in
  this repository. `packages/db/test/hr/tax-year-convention.test.ts` makes it visible — a December 2026 period paid on
  2027-01-05 lands in 2027 alone.

**Exactly what changes if the owner answers otherwise:**

| If the accountant says | Change |
| --- | --- |
| The year is `period_end`'s, not `pay_date`'s | **One expression** in `app.employee_ytd_delta` (`extract(year from r.pay_date)` → `extract(year from r.period_end)`), in a **new migration in a later slice's range** that `create or replace`s the function (an applied migration is never edited, §3.4.7). **Moving the existing rows is a separate piece of work** and a migration cannot do it (FORCE RLS binds `app_migrator` and a migration sees no tenants, hazard 10); nor can the nightly `hr.employee_ytd.rebuild`, which reads and compares and has no write path (ADR 0077 decision 1). A re-key needs a new function under `packages/db/src/posting/**` — the only directory that may write `app.employee_ytd` — run per tenant under `systemContext`, registered by a contracts amendment before it is written. Until then the correction applies to runs posted after the new migration. Amendment B7 and ADR 0077 are amended in the same change. |
| A pay period is not a calendar month | **Nothing in 8C.** `payroll_run.period_start` / `period_end` are free dates (8B) and every figure here is keyed off the run, never off a month. |
| The registration numbers arrive | One statement per scheme, by the seed CLI as the system principal or by an administrator through `PUT /v1/companies/{companyId}/hr-settings` (8A) — **never a migration** (hazard 10). Then the `⚠️ OD-23` case in `tax-year-convention.test.ts` loses its `.skip`. |

## What 8D adds (8D Task 9, 2026-11-07)

8D's share of OD-23 is **the parallel run itself and the owner's written acceptance** — the Phase 8 definition of done's
first clause. The tool is built; the run against real figures is not, because it needs the owner's material.

**Owner provides:** (a) the staff list for the parallel month; (b) the legacy system's payslip figures for that month, as
a CSV `employee_number,gross,total_deductions,net,<scheme code>_employee…` (`docs/runbooks/payroll-parallel-run.md`,
"After the run"); (c) the accountant's sign-off on the statutory tables that month uses (the rate-table half above);
(d) a written acceptance of the difference report.
**Verify:** `DATABASE_URL=<app_rw url> bun run payroll:reconcile --tenant "$TENANT_ID" --company "$COMPANY_ID" --run
"$PAYROLL_DOCUMENT_ID" --legacy ./legacy-<yyyy-mm>.csv --out ./docs/reports/parallel-run-<yyyy-mm>.md` prints
`differences: 0 — clean to the cent` or `differences: N — see <out>` (exit 0 either way; exit 2 on a configuration
error), and the owner's signature with a reason per difference is recorded under the report's "Accepted differences".
**Until provided — the default in force:** `bun run payroll:reconcile --self-test` runs the same comparison against the
`SYNTH` fixture corpus (`packages/db/test/hr/reconcile.test.ts`, "clean to the cent": the legacy side is derived from
the posted SYNTH run) and prints `differences: 0 — clean to the cent`. The same test file proves each difference kind,
the CLI end to end against a Testcontainers database, and the report's determinism. **The definition of done's first
clause stays open** until (a)–(d) arrive: a SYNTH self-test proves the tool, not the business's payroll.
