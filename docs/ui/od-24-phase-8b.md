# OD-24 — the Phase 8B payroll screens (Plan 8B Task 15)

**Status:** built on the **owner-authorized default baseline** (2026-11-07), with **legacy keyboard parity
unproven**. No owner material was supplied: there are no screenshots of the legacy payroll approval or register
screens and no two-minute operator description of the month-end sequence. On 2026-11-07 the owner answered OD-24 for
Phase 8: **build the screens** on the plans' default baseline, as Phase 7 and 8A did (`docs/ui/od-24-phase-7a.md`,
`od-24-phase-8a.md`). The plan's Task 15 default was "blocked, not the slice"; this record is the authorization to
build it anyway, verified in English LTR and Arabic RTL, with legacy parity explicitly not claimed. It is
implementation authorization, not acceptance (`docs/review/2026-11-07-phase-8-decisions.md`).

## What was built

| Screen | Address | File | Routes it drives |
|---|---|---|---|
| **Payroll run register** and **new run** | `/hr/payroll-runs` | `apps/backoffice/src/routes/hr/payroll-runs.tsx` | `GET …/payroll-runs` (`filter[status][eq]`), `POST …/payroll-runs`, `GET …/employees` (to name a supplementary or final run's employees) |
| **Payroll run** — the approval screen | `/hr/payroll-runs/$documentId?company=` — opened from a register row | `apps/backoffice/src/routes/hr/payroll-run.tsx` | `GET …/payroll-runs/{id}`, `POST …/{id}/recalculate`, `POST …/{id}/overrides`, `POST …/documents/{id}/transitions` (2B's shared route: submit, approve, post, return to draft) |

Supporting files: the fetch layer `apps/backoffice/src/lib/payroll-api.ts` (every body parsed by the route's own
strict contract — `CreatePayrollRunBody`, `SetPayrollOverrideBody`, 2B's `TransitionBody`); the two routes in
`src/router.tsx` and one nav link (**Payroll runs**) in `src/components/app-shell.tsx`; the `payroll.*` keys and
`app.nav.payrollRuns` in `packages/i18n/catalogues/{en,ar}.json`; the unit tests `apps/backoffice/test/payroll.test.tsx`
(15 cases); and test 23 in a browser, `tests/e2e/payroll.spec.ts` (both directions), whose stack `tests/e2e/support/boot.ts`
seeds with 8B's `payrollFixture` and two SUBMITTED supplementary runs prepared by a principal who is not the
browser's operator.

## The plan's four requirements, and where each is on the screen

Task 15 Step 2 fixed what the screen must show "from the spec and nowhere else"; the layout is this build's default.

| Requirement | Source | On the screen |
|---|---|---|
| The run's period, kind, status and pinned rate-table versions | spec:2081 | The heading names the period; a definition list gives kind, status, number (once issued), pay date and every pinned scheme and version |
| Every line, per employee, with its component or scheme and its pinned version | spec:2081 | "Lines per employee": employee number, component code (or scheme code with *employee share* / *employer share*, or *Net pay*), quantity, amount, the pinned version, and the override flag. The lines are the run service's own, in its fixed order; **the screen computes no figure** — no total, no gross — because a figure computed in the browser would be a second payroll arithmetic (LEGACY-009) |
| **Every manual statutory override, flagged, with its reason and who entered it** | spec:2087 | "Manual statutory overrides": each one boxed in the danger colour, naming the employee, scheme, share and amount, then the reason, the principal who entered it (by name) and when; the line itself carries **Manual override** in the lines grid. Read from the run detail's `overrides` (8B T11) |
| **Everyone who changed compensation in the period** | spec:2174 R3 | "Compensation changed in this period", with the instruction to check them before approving. Read from `compensationChangedBy`, which 8B T11's bounded lookup now fills for an approver who holds `hr.payroll.read` without `hr.compensation.read` — who, for whom and from when, never an amount |

## Actions, by status

| Status | Actions offered (buttons, in DOM order) | Notes |
|---|---|---|
| draft | **Submit for approval**, **Recalculate**, **Manual statutory override** | The override form names an employee and one of the (scheme, share) pairs the calculation produced for them — an override replaces a computed share and never invents one — an amount in the run's currency and a reason; the run is recalculated at once |
| submitted | **Approve**, **Recalculate**, **Return to draft** | Recalculating a submitted run returns it to draft (spec:2081; the screen says so). Approval needs a different person (the screen says so); when the approver is the submitter, the server's `ERR_SOD_MAKER_IS_CHECKER` is shown as the server words it — R1 is the database's answer, never this screen's |
| approved | **Post**, **Return to draft** | Return to draft asks for the reason 2B's backward edge requires |
| posted (and later) | none | "This run is posted. A correction is a supplementary run; a posted run is never edited." (ADR 0076) |

The screen never hides a button by permission: the back office has no client-side permission projection, so every
refusal (R2's `ERR_RBAC_FORBIDDEN`, R1, a closed period's `ERR_PERIOD_NOT_OPEN`) is the API's problem, shown in place.

## The key map (the defaults, not the shop's)

| Key | Action |
|---|---|
| Enter on a register row | Open the run (the register reads every page, newest period first, as 6C's directory does) |
| Enter on a focused button or link | Its action — every step of `payroll.spec.ts` is taken this way |
| Space on an employee checkbox | Name that employee on a supplementary or final run |
| Enter in a form field | Submit the form (new run, override, return-to-draft reason) |
| Esc | Close the open "new run", override or return-to-draft form and return focus to what opened it |

A new run's form opens with focus on **Kind**, the override form on **Employee**, the return-to-draft form on its
reason. A new run defaults to the current calendar month (UTC) with the pay and posting dates at its end.

## Gating and company

The company is chosen with 6C's staff-context picker. **Its projection gains `hr.payroll.read`** (8B T15): the
seeded `accountant` (read, approve, post) and `auditor` (read) hold none of the six earlier codes, so without it the
approver — the screen's main reader — would be told they have no accessible company. It still grants nothing; every
payroll route authorizes on its own. The run screen takes the company its register opened it from.

## Not proven

- **Legacy keyboard parity** and the legacy month-end workflow (who calculates, what they check, what the approver
  looks at before approving): no owner material exists; the keys above are this build's defaults. When the
  screenshots and the operator description arrive, Task 15 Step 2's four requirements stay and the layout, order and
  wording follow the material.
- The packaged `backoffice.exe` run (Windows, CI's `desktop` job).
- WCAG 2.2 AA beyond what the tests assert.
