# OD-24 — the Phase 8A HR screens (Plan 8A Task 13)

**Status:** built on the **owner-authorized default baseline** (2026-11-07), with **legacy keyboard parity
unproven**. No owner material was supplied: `docs/owner/screens/hr/` does not exist, so there are no screenshots of
the legacy Salaries screens and no two-minute operator description. On 2026-11-07 the owner directed "implement
phase 8 entirely" and answered OD-24 for Phase 8: **build the screens** on the plans' default baseline, as Phase 7
did (`docs/ui/od-24-phase-7a.md`, `od-24-phase-7c.md`). That authorizes 8A Task 13's table of four screens — plus a
fifth for 8A Task 11's HR settings — verified in English LTR and Arabic RTL, with legacy parity explicitly not
claimed. It is implementation authorization, not acceptance (`docs/review/2026-11-07-phase-8-decisions.md`).

## What was built

| Screen | Address | File | Routes it drives |
|---|---|---|---|
| **Employee record** (identity, statutory profile, compensation) | `/hr/employees/$employeeId?company=` — opened from the 6C directory's **Open HR record** link | `apps/backoffice/src/routes/hr/employee-record.tsx` | `GET …/employees/{id}`, `GET\|PUT …/{id}/sensitive`, `GET\|POST …/{id}/statutory-profiles` |
| **Compensation** (a panel of the record) | as above | `apps/backoffice/src/routes/hr/compensation.tsx` | `GET\|POST …/{id}/compensation-lines`, `GET …/pay-components` |
| **Pay components** | `/hr/pay-components` | `apps/backoffice/src/routes/hr/pay-components.tsx` | `GET\|POST\|PATCH …/pay-components`, `PUT …/{id}/schemes`, `POST …/{id}/archive`, `GET …/statutory-schemes` |
| **Statutory tables** | `/hr/statutory-tables` | `apps/backoffice/src/routes/hr/statutory-tables.tsx` | `GET …/statutory-schemes`, `GET\|POST …/{id}/rate-tables`, `POST …/{id}/rate-tables/{v}/verify`, `GET /v1/session` |
| **HR settings** (⚠️ OD-23) | `/hr/settings` | `apps/backoffice/src/routes/hr/hr-settings.tsx` | `GET\|PUT …/hr-settings` |

Supporting files: the fetch layer `apps/backoffice/src/lib/hr-api.ts` (every body parsed by the route's own strict
contract before it leaves — there is no generated client, `AGENTS.md`); `apps/backoffice/src/features/hr/shared.tsx`
(`isForbidden`, `firstOfNextMonth`, `quantityToWire`, `useSubmit` — one gesture at a time with §4.2.9's key per
gesture, the export screen's rule); `StaffCompanyGate` in `src/components/staff-context.tsx`; the routes in
`src/router.tsx` and three nav links in `src/components/app-shell.tsx`; the `hr.*` and three `app.nav.*` keys in
`packages/i18n/catalogues/{en,ar}.json` (the tree's two flat catalogues — the plan's `src/en/hr.json` files do not
exist in this layout); the unit tests `apps/backoffice/test/hr.test.tsx` (16 cases); and test 23 in a browser,
`tests/e2e/hr.spec.ts`.

## Task 13's fixed notes, row by row

- **The sensitive panel is a separate panel behind a separate fetch.** A principal without
  `hr.employee.read_sensitive` gets the server's 403, which the panel renders as "You do not have access to identity
  and bank details." — no inputs at all, never blank fields that look like missing data. The statutory-profile and
  compensation panels have their own fetches and their own sentences, so one refusal never blanks another. A 404
  (nothing recorded yet) is an empty form that says so. Saving sends only the fields that changed; a cleared field is
  an explicit `null`. The R4 refusal (`ERR_HR_SELF_PAY`, a principal's own record) is shown as the server's problem.
- **Compensation:** closed lines are shown greyed with their `effectiveTo`; the "new line" form pre-fills
  `effectiveFrom` with the first of next month and states, before saving, that saving **closes** the component's
  current line rather than editing it (ADR 0072). Only live components are offered; amounts are entered in the
  company's base currency (from `/v1/staff-context`) and sent as exact decimal strings (`amountToWire`), a
  quantity-based component's value as a six-place quantity.
- **Statutory profile:** the same close-then-open rule and sentence. The three spec:2077 fields and the residency
  category are entered; `extra` (⚠️ OD-28's seam) is shown read-only — no screen invents the verified field list.
- **Pay components:** `kind` is a **two-value radio**, never a free select; `code` and `kind` are fixed at creation
  (the form says so) and the detail offers rename, additive scheme joins (a joined scheme is checked and disabled —
  amendment A14 has no removal path, and the hint says to archive and replace) and archive.
- **Statutory tables:** the **verify** button is **disabled with the reason beside it** for the principal who loaded
  the table — "Verification requires a different principal: you loaded this table." (`aria-describedby`); the
  caller is read from `GET /v1/session`. The definition is shown, in an LTR block, before it is verified. A table is
  loaded by pasting its JSON definition; malformed JSON is refused on the client, and the server's schema errors are
  listed with their JSON Pointers. Schemes are seed-pack data, so there is no "new scheme".
- **HR settings:** exactly the two proration rules, a pay day of 1–31 or blank, and one registration field per
  scheme (blank = `null`); the hint says nothing is refused while one is missing (⚠️ OD-23).
- **Both directions:** every screen's unit cases run in `en` and `ar` and assert no physical-property class; the
  e2e spec runs the whole flow in English LTR and Arabic RTL and checks mirrored column order.

## The key map (the defaults, not the shop's)

| Key | Action |
|---|---|
| Enter on a list row | Open it (directory employee, pay component, scheme, rate-table version) |
| Enter on a focused button or link | Its action — every step of `hr.spec.ts` is taken this way |
| Enter in a form field | Submit the form |
| Ctrl+Enter in the rate-table definition | Load the table (a bare Enter is a new line there) |
| Esc | Close the open "new" form or pay-component detail and return focus to what opened it |
| `/` on the directory | Search employee numbers (6C's) |

## Gating and company

The back office has no client-side permission projection, so the three nav links are always present and every
refusal is the API's. The company is chosen with 6C's staff-context picker (`/v1/staff-context`), which lists the
companies where the operator holds one of its six codes; the employee record takes the company its directory opened
it from. **Recorded limit:** an accountant who holds only `hr.statutory_table.verify` (the seeded `accountant` role)
is in no staff-context company, so the statutory-tables screen tells them they have no accessible company rather
than showing the tables; the API serves them (`requireAnyPermission`). Widening the staff-context projection is a 6C
contract change and was not made here; until it is, an accountant verifies through a role that also carries a
staff-context code.

## Not proven

- **Legacy keyboard parity** and the legacy Salaries workflow (what the payroll officer opens first, what they check
  before saving): no owner material exists; the keys above are this build's defaults.
- The packaged `backoffice.exe` run (Windows, CI's `desktop` job).
- WCAG 2.2 AA beyond what the tests assert.
