# OD-24 — the Phase 8D payslip, HR-report, permit and leave screens (Plan 8D Task 10)

**Status:** built on the **owner-authorized default baseline** (2026-11-07), with **legacy keyboard parity
unproven**. No owner material was supplied: there are no screenshots of the legacy Salaries module's payslip-printing
screen, its HR reports or its leave screens, and no two-minute operator description. On 2026-11-07 the owner answered
OD-24 for Phase 8 — **build the screens** on the plans' default baseline, as Phase 7, 8A and 8B did
(`docs/ui/od-24-phase-7a.md`, `od-24-phase-8a.md`, `od-24-phase-8b.md`) — and OD-13 — **build the leave register**
(8D Task 8). The plan's Task 10 default was "blocked, creates no file"; this record is the authorization to build it
anyway, verified in English LTR and Arabic RTL, with legacy parity explicitly not claimed. It is implementation
authorization, not acceptance (`docs/review/2026-11-07-phase-8-decisions.md`).

## What was built

| Screen | Address | File | Routes it drives |
|---|---|---|---|
| **Payslips** — a panel of the payroll run screen, for a posted (or reversed) run | `/hr/payroll-runs/$documentId?company=` | `apps/backoffice/src/routes/hr/payroll-run.tsx` (`Payslips`) | `POST …/payroll-runs/{id}/payslips` (8D T5; `hr.filing.generate`, then the definition's `hr.payroll.read`), `GET …/attachments/{attachmentId}/content` (2C's download, under the run's module code) |
| **HR reports** — 7A's report list and run screen, **reused** | `/reports?module=hr`, `/reports/$code?parameters=…` | `apps/backoffice/src/routes/reports/index.tsx`, `$code.tsx` | 7A's routes, unchanged: the eight `hr.*` definitions are seeded rows like any other |
| **Work permit expiry** | `/hr/permit-expiry` | `apps/backoffice/src/routes/hr/permit-expiry.tsx` | `GET …/employees/permit-expiry?withinDays=&includeTerminated=` (8D T3, `hr.employee.read_sensitive`) |
| **Leave register** — records, entitlements, leave types, public holidays | `/hr/leave` | `apps/backoffice/src/routes/hr/leave.tsx` | the seven routes under `…/leave-records` (8D T8), and `GET …/employees` for the employees a request or an entitlement may name |

Supporting files: `apps/backoffice/src/lib/leave-api.ts` (every body parsed by the route's own strict contract —
`CreateLeaveRecordBody`, `LeaveDecisionBody`, `CreateLeaveTypeBody`, `SetLeaveEntitlementBody`,
`CreatePublicHolidayBody`), `payrollApi.payslips` / `payslipContent` and `hrApi.permitExpiry`; the two routes and the
search validation in `src/router.tsx`; three nav links (**Leave register**, **Permit expiry**, **HR reports**) in
`src/components/app-shell.tsx`; the `payslip.*`, `permit.*`, `leave.*` keys and the HR parameter labels in
`packages/i18n/catalogues/{en,ar}.json`; the unit tests `apps/backoffice/test/hr-8d.test.tsx` (25 cases); and test 23 in
a browser, `tests/e2e/payslips.spec.ts` and `tests/e2e/leave.spec.ts` (both directions each), whose stack
`tests/e2e/support/boot.ts` seeds a POSTED June run, a permit sealed a month out and two requested leaves by the system
principal, and grants the operator `hr.filing.generate`, `hr.leave.record` and `hr.leave.approve`.

## The plan's three screens, and what this build added

Task 10 Step 2 named three screens "and no others": a run review listing `hr.payroll_register` for one run with the
overrides flagged; a payslip screen that generates and downloads for one run, showing each file name and hash; and
an HR reports entry adding the eight codes to 7A's report list.

- **Run review.** 8B's approval screen already lists every line and flags every override, and keeps doing so after
  posting; the register itself opens from the payslip panel's **Open this run's payroll register (report)** link in
  7A's run screen with `payrollDocumentId` filled in. No second grid was written.
- **Payslips.** One form — language (defaults to the screen's), employees (everyone, or one) — and **Generate
  payslips**. The answer lists each employee's file name, size and SHA-256 as the server computed them; each row
  downloads its PDF. Every generation stores new attachments and never replaces one (spec:2049; the screen says so).
- **HR reports.** The eight `hr.*` definitions are seeded rows, so 7A's list already lists them; the nav's **HR
  reports** opens the list narrowed to the `hr` module (a module filter now sits beside the text filter). The run
  screen labels the HR parameters (`taxYear`, `payrollDocumentId`, `employeeId`, `schemeCode`, `employmentType`,
  `activeOnly`, `formName`, `formYear`) and names `hr.attendance`'s `kind` as an event kind.
- **Added beyond the three** (owner direction for this task): the **permit-expiry list** (spec:2091's permit half,
  8D A3 — the contract half is the `hr.contract_expiry` report) and the **leave register** (spec:2085, OD-13).

## The leave register's rules, on the screen

| Rule | Source | On the screen |
|---|---|---|
| A request is approved or rejected by a **different** person | spec:2175 R4, test 31 | The screen offers Approve on every requested row; when it is the operator's own leave, the server's `ERR_HR_SELF_PAY` is shown as the server words it — R4 is the database's answer, never this screen's. Withdrawing one's own request (a rejection) is allowed, as 0096 allows it |
| A decided record is final | 0096's `app.guard_leave_record()` | Only requested rows carry actions; a second decision would be the server's `ERR_TABLE_IMMUTABLE` |
| Entitlements are entered by HR; nothing accrues | spec:2085 | "Set entitlement" is an upsert of one (employee, year, type) figure; the section says saving again replaces it |
| Leave is never a pay input | spec:2085 | The intro says so; nothing here reaches a payroll run |
| A holiday for every branch or one branch | 8D A8 (Form B) | Branch defaults to **Every branch** (null); the list shows the company-wide holidays and those of the operator's branches |
| Day counts are `numeric(6,2)` | 0096 | Typed as whole or half days ("2", "1.5") and written exactly ("2.00", "1.50"), never through a float; the span rules are the contract's own `superRefine`, so a bad span is refused before anything is sent |

The register carries employee **numbers**, not names (8D T8's `LeaveRecord`); the screen names no one it cannot read.

## The key map (the defaults, not the shop's)

| Key | Action |
|---|---|
| Arrow keys in a grid | Move between cells (7A's `DataGrid`) |
| Enter on a requested leave row | Open its decision panel, with **Approve** focused; Enter approves, **Reject** opens the optional reason, Esc closes |
| Enter on a payslip row | Download that payslip |
| Enter on a focused button or link | Its action — every step of both specs is taken this way |
| Enter in a form field | Submit the form |
| Esc | Close the open form and return focus to the button that opened it |

A grid keeps focus on its cells, so a button drawn inside a row is the mouse's path; the keyboard's path is the row's
own Enter (the decision panel, the download), as 7A's report list does for "Design". The request and entitlement
forms open on **Employee**, the type form on **Kind**, the holiday form on **Date**, the permit list on its window.

## Gating and company

The company is chosen with 6C's staff-context picker; its projection already holds `hr.employee.read`, the code the
leave register and the permit list need, so it is **not** widened. The screen never hides a control by permission:
a section whose list route refuses (the types, entitlements and holidays need `hr.leave.record`; the permit list
`hr.employee.read_sensitive`) says which code it needs, in a sentence — never an empty list that would read as fact.

## Not proven

- **Legacy keyboard parity** and the legacy workflows (how payslips are printed and handed out, which HR reports the
  office runs, how leave is requested and approved): no owner material exists; the keys above are this build's
  defaults. When the material arrives, the layout, order and wording follow it.
- ~~Earlier generations of a run's payslips are not listed~~ — **closed by the Phase 8 review (2026-11-08):** 2C's
  list now asks the named run's module read code (`hr.payroll.read`), and the panel lists every payslip already on the
  run under "Payslips already on this run", newest first, Enter on a row downloads it (EN/LTR and AR/RTL in
  `apps/backoffice/test/hr-8d.test.tsx` and `tests/e2e/payslips.spec.ts`).
- The packaged `backoffice.exe` run (Windows, CI's `desktop` job), and PDF rendering in a deployed image (OD-20).
- WCAG 2.2 AA beyond what the tests assert.
