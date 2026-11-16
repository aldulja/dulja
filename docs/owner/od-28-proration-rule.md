# OD-28 — the proration rule the accountant confirms

spec:2086: _"Proration for mid-month joiners and leavers and for unpaid days follows a company-level configured
rule (calendar days or working days) that the accountant confirms — configuration, never a statutory claim."_

**Decision needed from the owner's accountant, not from the build team.** On 2026-11-07 the owner directed
"implement phase 8 entirely"; the plan's default below is what was built
(`docs/review/2026-11-07-phase-8-decisions.md`, the OD-28 proration row) — implementation authorization, not an
answer to any of the three questions.

**Owner provides:** a one-line written confirmation from the accountant answering (a), (b) and (c), with the date
and the accountant's name.
**Verify:** `grep -c "^> \*\*Answer:\*\*" docs/owner/od-28-proration-rule.md` prints `3` and each answer line
carries the accountant's words in place of _(owner)_; the confirmation is recorded as a dated addendum to
`docs/adr/0074-payroll-calculator-seam-and-rate-table-pinning.md`; and
`bun run --cwd packages/domain test -- payroll/proration` shows the case named for the confirmed rule as the one
that is **not** skipped.

---

## What is built without an answer (8B Tasks 6 and 7, 2026-11-07)

- **Both rules, live.** `packages/domain/payroll/period.ts` counts `calendar_days` (every day of the period) and
  `working_days` (Monday to Friday). `prorationFactor(period, employee)` returns the exact pair _eligible days /
  period days_ under the period's rule — never a float — and a prorated amount is rounded once,
  `HALF_AWAY_FROM_ZERO` at four decimals.
- **The company picks.** The rule is 8A's `app.company_hr_setting.proration_rule` (migration `0085`), which admits
  exactly the two values and seeds **no row**; a company without one reads the default **`calendar_days`**. The
  run service (8B Task 10) reads it into `PayPeriod.prorationRule` for each run.
- **Public holidays are not subtracted.** `working_days` counts weekdays only.
- **One rule for both sides.** A joiner (`hired_on` inside the period) and a leaver (`terminated_on` inside it) are
  prorated by the same rule, inclusive of both ends.
- **Quantity lines are never prorated.** Unpaid days and hours are a `compensation_line.quantity` times a per-unit
  amount; the quantity already says how much of the period it covers.
- The gate is in the test output: `packages/domain/test/payroll/proration.test.ts` carries two skipped cases,
  `OD-28 CONFIRMED calendar_days` and `OD-28 CONFIRMED working_days`.

---

## (a) Which rule applies — `calendar_days` or `working_days`?

> **Answer:** _(owner)_

**If `calendar_days`** (the default): no code change. Un-skip the first case and delete the second.

**If `working_days`**: no code change. One `company_hr_setting` row per company is written with
`proration_rule = 'working_days'` (`PUT /v1/companies/{companyId}/hr-settings`, or the seed when OD-23's other
answers arrive). Un-skip the second case and delete the first.

## (b) Does `working_days` exclude public holidays as well as weekends?

> **Answer:** _(owner)_

**If no** (the default): nothing changes.

**If yes**: `countDays` in `packages/domain/payroll/period.ts` gains a `holidays: readonly string[]` parameter
and skips a day whose ISO date is in it; `PayPeriod` gains `holidays` (default `[]`), which amends contracts
§4.12.1; and the run service reads `app.public_holiday` for the company and the employee's branch — **8D's
table**, so this answer makes 8B's run depend on 8D and the two must land together (recorded in contracts §6.3
first). Only relevant if (a) is `working_days`.

## (c) Are a mid-month joiner and a mid-month leaver prorated by the same rule?

> **Answer:** _(owner)_

**If yes** (the default): nothing changes.

**If no**: `prorationFactor` splits into a joiner factor and a leaver factor and `calculate` picks by whether
`hiredOn` is after the period start or `terminatedOn` before its end. **This is the only answer that changes an
exported signature** (contracts §4.12.1), and 8B's golden `synth-proration` case gains a third employee.

---

**No rate, threshold, ceiling or formula belongs in this answer.** Those are OD-23's
(`docs/owner/od-23-employer-registrations.md`, whose §3 names the same setting), and this repository states none
(spec:2080). The statutory-profile field list, the other half of OD-28, is `docs/owner/od-28-statutory-profile-fields.md`.
