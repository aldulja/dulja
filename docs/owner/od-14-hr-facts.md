# OD-14 — four HR facts only the owner knows

spec:2093 and Part VII #14. Each answer changes §3.10.1's scope by about one task. **The default
written into every Phase 8 plan is "no"**, and each "no" leaves a named seam rather than an
assumption. On 2026-11-07 the owner directed "implement phase 8 entirely"; that default is what was
built (`docs/review/2026-11-07-phase-8-decisions.md`, the OD-14 row) — implementation
authorization, not an answer to any of the four questions below.

**Owner provides:** an answer to each of the four questions.
**Verify:** `test -f docs/owner/od-14-hr-facts.md && grep -c "^> \*\*Answer:\*\*" docs/owner/od-14-hr-facts.md`
prints `4`, and each answer line carries the owner's words in place of _(owner)_.
**Until provided:** nothing below is built. The four capabilities are absent, and each is absent in
a way that leaves a named seam rather than an assumption.

---

## 1. Does HRD Corp — or any other employer levy — apply to this business?

> **Answer:** _(owner)_

**If yes.** One task in **8A**'s seed data: a fifth row in
`packages/db/seed/my/statutory/schemes.json` with its code, and a `24nn` payable plus a `53nn`
employer-expense account allocated **in contracts §4.15 by 8B** in the order the scheme is added —
§4.15's own sentence, _"the next free `24nn` in the order the scheme is added, allocated in this
table by the slice that adds it"_. No migration: a scheme is a row (spec:2080, migration 0084's
free-text `code`). The levy's rate table arrives under OD-23 like every other.

**If no.** Nothing. The four schemes `schemes.json` already carries are the whole set.

---

## 2. Are foreign workers employed?

> **Answer:** _(owner)_

**If yes.** Two things, both already seamed. `employee_sensitive.work_permit_expiry_enc` **exists
already** (migration 0081) — it is one of the nine fields spec:2076 names — so the _data_ is there
whatever the answer; what a "yes" adds is **8D's `hr.contract_expiry` report** reading it, which is
already one of the five reports spec:2091 assigns 8D. Scheme applicability may differ for a foreign
worker, and that is a **rate-table** fact expressed in `required_profile_fields` and the
`employee_statutory_profile.extra` seam of 8A Task 5 (⚠️ OD-28) — not a code change.

**If no.** `work_permit_expiry` stays null for everyone and the expiry report has an empty section.

---

## 3. Is anyone hourly-paid or part-time?

> **Answer:** _(owner)_

**If yes.** One task in **8B**: an hours-based earning component and the calculator branch that
multiplies `compensation_line.quantity` by a rate. The **column and the flag already exist**:
`pay_component.quantity_based` (migration 0083, the unpaid-leave shape) and
`employee.employment_type` with `part_time` and `hourly` among its four values (migration 0080,
`employee_employment_type_check`). What is missing is only the calculation, and it is missing on
purpose — spec:2093 puts "piecework and production pay" and "overtime and public-holiday pay
calculators" out of v1, and overtime is "entered as an amount".

**If no.** `employment_type` records what the owner already knows and no calculator branches on it.

---

## 4. Do staff buy stock at the shops on salary deduction?

> **Answer:** _(owner)_

**If yes.** One task in **8C**, not 8A: the purchase is an `EMPLOYEE_ADVANCE`-shaped document and the
recovery is the existing `ADVANCE_RECOVERY` pay component, which
`packages/db/seed/my/statutory/pay-components.json` already ships. What a "yes" adds is the _link_
from a POS ticket paid by staff deduction to that advance — a `document_link` of kind `settles`
(§4.6.1, 3C's table) and one clause in 8C's money-out task.

**If no.** `ADVANCE_RECOVERY` stays what spec:2078 describes: the recovery of an advance the payroll
officer created, with no till path into it.

---

**None of the four is a rate, a threshold or a formula.** Those are OD-23's
(`docs/owner/od-23-employer-registrations.md`), and this repository states none (spec:2080).

---

## What 8B adds to each answer (8B Task 8, 2026-11-07)

8B's plan restates the four costs against the payroll engine. Under the default none of the four is built, and
8B ships **no code** for any of them; what a "yes" now costs, given what 8B Tasks 5–6 built:

| Item | If yes — the change, and its only change |
| --- | --- |
| 1. A levy | One `schemes.json` row and one §4.15 allocation, **no code**: the next free pair, `2415` / `5315`, joins `chart-of-accounts/8b-payroll.json` and `PAYROLL_ACCOUNT_CODES` (`packages/db/src/hr/accounts.ts`). The levy's table arrives under OD-23. If its shape is none of the three `kind`s §4.12.3 admits, that is a fourth `kind` and a fourth `SchemeCalculator` — a §4.12.3 amendment first (ADR 0074). |
| 2. Foreign workers | **No 8B code.** A scheme whose contribution depends on residency declares `required_profile_fields: ["residency_category"]` in its rate table; every calculator already refuses a null or absent declared input naming the employee (`ERR_PAYROLL_INPUT_MISSING`), and a string profile value already counts as a present category in a progressive relief. |
| 3. Hourly / part-time | **One seed component and one un-skipped test, no code.** The calculator branch item 3 above anticipated now exists: a compensation line with a quantity is `amount × quantity` and is **not** prorated (`packages/domain/payroll/calculator.ts`), which is right for hours worked. The seed adds an hourly earning component with `quantity_based = true`; `compensation_line.amount` is the hourly rate and `.quantity` the hours. The acceptance is the skipped case in `packages/domain/test/payroll/hourly.test.ts`, un-skipped. |
| 4. Staff purchases | **No 8B code.** The recovery is a deduction component (`ADVANCE_RECOVERY` already ships) whose account is chosen by the slice the answer lands in (8C, with 6D's till link); 8B's only obligation is that `linkPayrollAccounts` never overwrites an account already set, and it does not (it fills only null columns). |

**Verify (8B):** `bun run --cwd packages/domain test -- payroll/hourly` reports `1 skipped` until item 3 is
answered "yes", and `1 passed` after.

---

## What 8C adds to item 4 — staff purchases on salary deduction (8C Task 14, 2026-11-07)

Item 4 is the money-out clause of OD-14, and 8C is the slice whose machinery it would use. Under the default it is
**not built**, and 8C ships **no code** for it: no table, no column, no tender method, no permission code, no account and
no document type. Items 1–3 stay 8A's and 8B's and are not re-opened here.

**The question, in four parts** (answer under item 4 above):

1. May staff buy at the till and have it deducted from pay at all?
2. What approval is required at the till — a supervisor override, a manager PIN, or nothing?
3. Does a limit apply, and is it per employee or per month? The figure and the unit.
4. Is the deduction recovered in one pay period or spread over several, and who authorises it?

**The default that ships, and it works with nothing added.** An officer raises an ordinary **`EMPLOYEE_ADVANCE`** (8C
Task 6, `POST /v1/companies/{companyId}/employee-advances`) for the amount. It debits `1400` staff advances tagged with
the employee's `EMPLOYEE` dimension value and credits `1100`, released under `hr.advance.create` and approved and posted
by a second person under `accounting.payment.approve` / `.post`. 8B's `ADVANCE_RECOVERY` deduction (whose account the
operator sets to `1400` — `linkPayrollAccounts` never chooses it, `packages/db/src/hr/accounts.ts`) clears it on the next
payroll run, and `advanceBalance` (`GET …/employee-advances/balances/{employeeId}`)
answers "what does this employee owe" at any date. The one thing the default does **not** give is capture _at the
till_: the purchase is recorded by the officer afterwards rather than by the cashier at the point of sale.

**Exactly what a "yes" costs** — and why it is more than item 4's first estimate (a `settles` link) suggests:

| # | Change | Why it is not a one-liner |
| --- | --- | --- |
| 1 | **A fifth tender method on `POS_TICKET`.** | `LineSnapshot.tenderMethod` is the frozen union `cash \| card \| transfer \| store_credit` (`packages/domain/src/posting/evaluate.ts`, §4.4.2) and `posting-policy.schema.json`'s `when["line.tender_method"]` enum matches it; the till's `Tender.method` (`packages/sync/src/messages.ts`) is the same four. A fifth value is a **schema change — a new `version` const and a new `$id`** (§4.4.1's own rule), a sync-protocol change, and therefore a contracts amendment and an **ADR proposal before any code** (spec:95). |
| 2 | **A per-employee limit.** | A column on `app.branch_pos_policy` (6C) or `app.company_hr_setting` (8A) — a migration in a **later slice's** range; 8C's 0091–0095 is spent and 8C allocates none. |
| 3 | **One permission code**, e.g. `pos.ticket.staff_purchase`. | §3.6.1's vocabulary is closed (hazard 26): an amendment to §3.6.2 **first**, before the code is written anywhere. |
| 4 | **No new account.** | `1400` staff advances is the debit, exactly as an `EMPLOYEE_ADVANCE` uses it — a staff purchase is an advance in kind. |
| 5 | **No new document type.** | The ticket is a `POS_TICKET` (6A's) with a different tender leg; a `STAFF_PURCHASE` type would be a §4.14 row for what is a tender method. |

Items 1 and 3 are **prerequisites, not consequences**: both amendments land before the first line of implementation.

**How it would be verified.** A new `packages/db/test/hr/staff-purchase.test.ts`, written first: a `POS_TICKET` tendered
to the new method posts a debit on `1400` tagged `EMPLOYEE`, `advanceBalance` reports it, and the next payroll run's
`ADVANCE_RECOVERY` line clears it to zero. Until then the shipped path is covered by
`packages/db/test/hr/money-out.test.ts` (`createEmployeeAdvance`, `advanceBalance`).
