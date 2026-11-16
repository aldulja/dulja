# OD-24 — the Phase 1 accounting screens (Plan 1B Task 11)

**Status:** 🚫 **NOT STARTED — blocked on owner material.** Plan 1B Task 11 is the only task in Plan 1A
or Plan 1B that touches OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only task in either
plan that did not ship with Phase 1. Every other task is green without it.

## The gate, and what it checks

Plan 1B Task 11 Step 1 states the gate as an exact command:

```
ls -1 docs/spec/screens/1b/ && wc -w docs/spec/screens/1b/operator-notes.md
```

It must print `accounts.png`, `journal-entry.png`, `periods.png` and `operator-notes.md`, and a word
count of at least 300. Run on 2026-09-19 against this tree it printed

```
ls: cannot access 'docs/spec/screens/1b/': No such file or directory
```

The directory does not exist and neither does its parent, so the gate fails on its first clause. Task 11
Step 1 then reads, verbatim: *"If either fails, stop — this task is blocked, not the slice."*

## Why a default was not written down instead

0E's `docs/ui/od-24-users-and-roles.md` shipped a screen under this same gate by recording the default it
chose. That was the right call there and is the wrong one here, for one reason: the three screens Task 11
covers are **data-entry** screens, and the gate's subject is the keyboard path a fast operator takes
through them. spec:108 — "Do not invent workflows from this document." A users-and-roles list has one
obvious shape; a journal-entry grid's tab order, its defaults, which fields a fast operator never touches
and what `Enter` does on the last line are the whole substance of the screen, and inventing them produces
work the owner has to throw away. Plan 1B Task 11 says so itself and makes the gate blocking rather than
advisory, which is a change from 0E's posture and is deliberate.

## What the owner provides

For each of **chart of accounts**, **journal entry** and **fiscal periods**:

1. A screenshot of the equivalent Sahlisoft screen — `docs/spec/screens/1b/accounts.png`,
   `journal-entry.png`, `periods.png`.
2. A two-minute description of the keyboard path a fast operator takes through it, all three together in
   `docs/spec/screens/1b/operator-notes.md` (at least 300 words): tab order, defaults, which fields are
   skipped, what `Enter` does at the end of a line, and how the screen is left.

## What is already built, so the screens are a thin layer when they start

Nothing in Task 11 is blocked on code. Everything it consumes exists on this branch:

| Task 11 needs | Where it is |
|---|---|
| chart-of-accounts read/write | `GET`/`POST /v1/companies/{companyId}/accounts` (1A) |
| fiscal-period list, close, reopen | `…/fiscal-periods`, `…/{id}/close`, `…/{id}/reopen` (1A) |
| journal draft and post | `POST …/documents`, `POST …/documents/{id}/transitions` (1A) |
| branch picker | `GET …/dimension-types` and `…/{id}/values`, membership-only (0D) |
| trial balance and ledger views | `GET …/reports/accounting.trial_balance` and `…/accounting.ledger` (1B Task 10) |
| wire shapes | `AccountSchema`, `FiscalPeriodSchema`, `DocumentSchema`, `TrialBalanceList`, `LedgerList` — all exported from `@dulja/contracts`; the screens import them and re-declare nothing |
| shell, grid, i18n, RTL | `@dulja/ui`, `packages/i18n`, `apps/backoffice` (0E) |

## What changes when the material arrives

Task 11's own file list, and nothing outside it: five routes under
`apps/backoffice/src/routes/accounting/`, three local components (`PageHeader`, `Modal`, `ReportTable`),
`apps/backoffice/src/lib/accounting-schemas.ts` and `accounting-api.ts`, five `createRoute` declarations
in `apps/backoffice/src/router.tsx`, the two i18n catalogues, and `tests/e2e/accounting-screens.spec.ts`
(acceptance test 23 for these screens). No API call, no contract, no migration, no other task.
