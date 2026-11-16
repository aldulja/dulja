# OD-24 — the Phase 4B ageing and bank-reconciliation screens (Plan 4B Task 11)

**Status:** 🚫 **NOT STARTED: blocked on owner material.** Plan 4B Task 11 is the only 4B task that touches
OD-24 (contracts §2.12; spec:79, 108, 2408). It is the only 4B task that is blocked by a missing screen brief.
Tasks 9 and 10 are not built either, but that is OD-09's default and is recorded in
`docs/decisions/od-09-4b-post-dated-cheques.md`. Earlier slices recorded the same posture in their own files:

- 1B, the accounting screens: `docs/ui/od-24-phase-1-screens.md`
- 2C, the document screens: `docs/ui/od-24-phase-2-screens.md`
- 3A, the inventory screens: `docs/ui/od-24-phase-3a-screens.md`
- 3C, the purchasing screens: `docs/ui/od-24-phase-3c-screens.md`
- 3D, the inventory-operations screens: `docs/ui/od-24-phase-3d-screens.md`
- 4A, the AR/AP screens: `docs/ui/od-24-phase-4a-screens.md`

This file is 4B's record. It is the **seventh** task OD-24 now blocks.

## The gate, and what it checks

Plan 4B Task 11 Step 1 gives the gate as:

```
mkdir -p docs/owner/od-24/4b
ls -1 docs/owner/od-24/4b/
```

Four files must be listed: `ageing.png`, `bank-reconciliation.png` and one `.md` transcript for each screen.
Run on 2026-09-28 against this tree, without the `mkdir`:

```
$ ls -1 docs/owner/od-24/4b/
ls: cannot access 'docs/owner/od-24/4b/': No such file or directory
$ ls -1 docs/owner/
ls: cannot access 'docs/owner/': No such file or directory
```

The `mkdir` was not run. The gate checks what the directory contains, not whether it exists. Git does not
track an empty directory, and an empty one would only look like material had arrived.

**The path, for once, agrees with the register.** 4A's plan put its material under `docs/ui/screenshots/`,
and 3C's under `docs/ux/`. This plan uses `docs/owner/od-24/4b/`, which is the spelling in `AGENTS.md` and in
3A's and 3D's records. `docs/owner/` has never existed in any phase, so no material has been supplied for any
slice.

Step 1's own rule is: *"Until then, stop here … The slice ships without them."* The step asks for a one-line
note in the phase report (Task 12). This file is the full record, and the note should cite it.

**That is what was done.** Steps 2–6 are unchecked. None of the following was written:

- `apps/backoffice/src/lib/ar-ap-api.ts`
- anything under `apps/backoffice/src/routes/accounting/`
- any new route in `router.tsx`, and no nav entry in `app-shell.tsx`
- any `accounting.ageing.*` or `accounting.bank.*` catalogue key
- `tests/e2e/ar-ap-screens.spec.ts`

## What is blocked

Two screens, and acceptance test 23's 4B re-run with them:

| Screen | The legacy screen the owner's material must show | What the material must answer |
|---|---|---|
| **Ageing worklist** | the debtor/creditor ageing enquiry | Which date it is run as at, and whether that is always today. Customers and suppliers together or apart. Whether a clerk reads it per currency or in base. Above all, **what the operator does next from a row**: call the customer, open the invoice, or print a statement |
| **Bank reconciliation** | the bank reconciliation sheet | How the statement arrives (a bank file, a printout keyed in, or a downloaded CSV, and in which column layout). Whether lines are ticked one by one or several at a time. What happens when one deposit covers three receipts, or one receipt is banked in two parts. How a wrong tick is undone. Who signs the month off, and on what figure |

Acceptance test 23's 4B re-run (`tests/e2e/ar-ap-screens.spec.ts`: both screens in `en` and `ar`, through
0E's `bootLocalStack()` in `tests/e2e/support/boot.ts`) is blocked with them. That file cannot exist before
the screens it renders.

## What the owner must provide

For **each** of the two screens, placed in `docs/owner/od-24/4b/`:

1. **A screenshot** of the Sahlisoft screen the staff use for that job today: `ageing.png` and
   `bank-reconciliation.png`.
2. **A two-minute description**, from the person who actually does the job, of their real sequence: what they
   type first, what they never touch, which keys they press, and what they do when the figures do not agree.
   This is not a specification. It is the real sequence, including the parts that are annoying. One `.md`
   transcript per screen.

That makes four files in all.

## The routes the screens would consume, all shipped

The API is the deliverable, and for these two jobs it is written. Every route below is mounted and has a
permission gate that `assertRouteGates` checks at boot. Every unsafe method takes an `Idempotency-Key`. Every
handler passes the path company into every service call it makes and resolves each id it is given inside that
company. An operator's own tooling can drive both jobs today.

### Ageing worklist

A `GET` on 1B's `reports` module (`reportsRouteModule`, `/v1/companies/:companyId/reports`). It is not a
module of its own.

| Route | Gate | Slice / task | What the screen reads from it |
|---|---|---|---|
| `GET /v1/companies/{companyId}/reports/accounting.ageing` (`apps/api/src/routes/accounting/reports.ts:522`) | `accounting.report.read` in the path company | 4B T3 | The whole grid. See the notes after this table |
| `GET …/parties/{partyId}`, `GET …/parties/{partyId}/balance` (`apps/api/src/routes/accounting/parties.ts:337`, `:463`) | `accounting.party.manage` | 2A, 4A T9 | A selected party's header, and its open balance per currency and in base, as of a date |
| `GET …/documents/{documentId}/open-balance` (`apps/api/src/routes/accounting/documents.ts:1603`) | the document module's read code (`requireDocumentModuleRead`) | 4A T9 | One document's remaining figure |

Notes on `accounting.ageing`:

- **Filters.** `filter[as_of][eq]=YYYY-MM-DD` is **required** and must be a real calendar date. The optional
  filters are `filter[party_id][eq]`, `filter[party_kind][eq]`, `filter[currency][eq]` and
  `filter[bucket][eq|in]` (`current`, `1_30`, `31_60`, `61_90`, `over_90`; `in` takes a comma-separated list).
  They are parsed through `parseFilters`, and anything else is `ERR_VALIDATION_FAILED`.
- **Paging.** `cursor` and `limit` page on `(partyCode, currency)`.
- **Rows.** The response is `AgeingList`. Each row is one party in one currency: `partyId`, `partyCode`,
  `partyNameEn`, `partyNameAr`, `partyKind`, `currency`, then `current`, `d1_30`, `d31_60`, `d61_90`,
  `over_90` and `total` as bare signed 4-dp strings in that currency, and `totalBase`.
- **Freshness.** It reads `agedBalance`, which is fresh through `app.party_ageing_rows`, never the stored
  snapshot (ADR 0046).
- **Buckets** are cut on the document's effective date plus the payment term pinned on the document.

The two `parties` reads are gated by `accounting.party.manage`, not by `accounting.report.read`. A reader who
holds only the report code gets the grid but not the drill-down. The owner's description of who uses this
screen settles whether that matters.

### Bank reconciliation

All six sub-paths of `bankStatementRouteModule` (`apps/api/src/routes/accounting/bank-statements.ts:500`,
`/v1/companies/:companyId/bank-statements`). This is the one route module 4B mounts, and its one `PROBES` key.
Every sub-path is gated `accounting.bank.reconcile` in the path company, the GETs included.

| Route | Line | Task | What it does for the screen |
|---|---|---|---|
| `POST /v1/companies/{companyId}/bank-statements` | `:221` | 4B T8 | **Import.** The body is `ImportStatementBody`: `bankAccountId`, the raw `csv` and a `CsvMapping` with statement date, opening and closing balances, columns by index or header name, `dateFormat` and `hasHeader`. It returns `201 { statementId, lines }`, or `400` when opening + Σ lines ≠ closing, or `409` when a statement already exists for that account and date |
| `GET …/bank-statements` | `:266` | 4B T8 | **Statement list**, newest first, with optional `filter[bank_account_id][eq]`. Keyset paging on `(statement_date desc, id)` |
| `GET …/bank-statements/{statementId}/lines` | `:312` | 4B T8 | **Statement column.** `filter[matched][eq]=false` gives the lines whose magnitude still exceeds their live matches, including partly matched lines. `=true` gives the fully matched lines. Omitting it gives all lines. Each line carries a signed `amount` (positive is money in) and a `matchedAmount` |
| `POST …/bank-statements/{statementId}/lines/{lineId}/matches` | `:363` | 4B T8 | **Match.** The body is `{ kind, documentId, amount }`. The amount is a magnitude in the statement's currency, and a partial amount is allowed. It returns `201 { matchId }`, or `422 ERR_BANK_MATCH_AMOUNT` when the direction, currency, document or remaining amount disagrees. It writes `app.bank_match` only (ADR 0048) |
| `POST …/bank-statements/matches/{matchId}/unmatch` | `:405` | 4B T8 | **Undo.** The body is `{ reason }`, and the reason is compelled. It returns **`200` with the `BankMatchSchema` row**, not the plan's `204`: the idempotency layer cannot replay a body-less 204. The row survives, with `unmatchedAt` set |
| `GET …/bank-statements/reconciliation` | `:446` | 4B T8 | **The sheet's header and the item column.** `filter[bank_account_id][eq]` and `filter[as_of][eq]` are both required. It returns `statement` (the closing balance of the latest statement on or before `as_of`), `ledger` (the account's balance at `as_of`), `unreconciled` (every registered source's unmatched `receipt` / `payment` documents, as `ReconcilableDto`) and `unmatchedLines` |

One supporting read is also needed. The bank-account picker would list accounts through
`GET …/accounts` (`apps/api/src/routes/accounting/accounts.ts:115`, `membershipOnly()`). No route narrows that
list to bank accounts. The picker filters by code or type client-side, or the operator types the code.

The DTO aliases the plan's fetch layer imports all exist in `@dulja/contracts`: `AgeingRowDto`
(`packages/contracts/src/accounting/reports.ts:132`), and `BankStatementDto`, `BankStatementLineDto`,
`BankMatchDto`, `ReconcilableDto` and `ReconciledBalanceDto` (`packages/contracts/src/accounting/bank.ts:112-192`).

## Four things the screens cannot get from the API, stated before the material arrives

Each of these is a **new endpoint or field**, and so a plan amendment, not a component:

1. **No list of a party's open items.**
   - The plan's ageing grid opens "that party's open items" on `Enter`, at
     `/accounting/parties/$partyId/open-items`, which it calls 4A's route. 4A shipped no screen
     (`docs/ui/od-24-phase-4a-screens.md`), so that route does not exist.
   - There is also no API behind it. `app.party_ageing_rows` returns
     `(party_id, currency, bucket, amount, base_amount)` with no document id. `open-balance` answers for one
     document at a time. The `documents` module still has no `GET /`.
   - 4A's record handed this list to "4B's ageing". 4B's ageing is per party and currency, so the gap is still
     open.
   - The plan's own fallback is that `Enter` does nothing. That is a one-line change. The owner's material
     settles whether the operator needs the drill-down at all.
2. **No list of live matches.**
   - Unmatch takes a `matchId`, and a `matchId` is returned only by the `POST` that created the match.
   - A statement line carries `matchedAmount`, but not the matches behind it. Nothing lists a line's or a
     statement's matches.
   - So an operator who reopens the sheet tomorrow cannot find the match to undo. The plan's reconciliation
     screen has no unmatch action at all, even though its fetch layer has `postUnmatch`.
3. **No difference on the wire.**
   - `ReconciledBalanceSchema` carries `statement` and `ledger`, and deliberately no difference.
   - The plan's screen subtracts the two in the browser through `Money`. That would make it the one screen in
     the project that does money arithmetic client-side.
   - The alternatives are to accept that, or to add the field to the schema. Either is a decision made when
     the gate opens, not here.
4. **No statement import on the plan's screen.**
   - The route takes a raw CSV and a column mapping.
   - The plan's reconciliation screen assumes the statement is already imported, and takes the newest one for
     the account. Where the file comes from, and whether the mapping is chosen once per bank or per file, is
     exactly what the operator's description must say.

## What the two screens will be, so the request is answerable

This is the plan's stated default layout, carried here unchanged and **not built**. It is the shape being asked
about, with no workflow invented for it. 0E's keyboard model applies unchanged: `/` filters, `↑`/`↓` move,
`Enter` opens, `Ctrl+S` saves, `Esc` reverts, `Ctrl+N` starts a new row.

| Screen | What it shows | The keyboard decision the plan adds |
|---|---|---|
| **Ageing worklist** | A read-only grid with a mandatory as-of date in the toolbar, and a customer/vendor switch. One row per party and currency, the five bucket columns, total and base total, with per-currency footers | `Enter` on a row opens that party's open items rather than a detail form, because "the operator's next action is always 'which invoice is this'". That route and its API do not exist (item 1 above) |
| **Bank reconciliation** | A bank-account picker and an as-of date. The header shows statement balance, ledger balance and their difference. Below, **two columns side by side**: statement lines on one side, unmatched `Reconcilable`s on the other. The columns swap sides under `dir="rtl"` | `Space` toggles a selection in the focused column. `Enter` matches the two selections, but only when the two remaining figures are equal. `Ctrl+Enter` is the explicit partial match. The amount is never typed, and there is no mouse drag |

## The exact file list that changes when the material arrives

Nothing above this line moves. Task 11 Steps 2–6 create the files below. **The plan's file list meets this
tree with the deviations shown**, each a one-line correction when the gate opens and none a design decision:

| Plan names | This tree |
|---|---|
| `apps/backoffice/src/lib/ar-ap-api.ts` over `apiFetch` from `./api-client` (0E Task 3) | There is no `api-client.ts` and no `apiFetch`. The backoffice calls the API through the handwritten `apps/backoffice/src/lib/admin-api.ts` (`createAdminApi`, `AGENTS.md`), so the fetch layer wraps that. The plan's closing `export type { …, BankMatch, BankStatement, BankStatementLine, Reconcilable }` names types it never imports, and must read the `…Dto` aliases |
| eight `@dulja/ui` components: `DataGrid`, `DateField`, `MoneyText`, `SegmentedControl`, `Toolbar`, `AccountPicker`, `ProblemAlert`, `SelectList` | `packages/ui/src/index.ts` ships `Button`, `DataGrid`, `DirectionProvider`, `Select` and `TextField`. **Seven of the eight do not exist.** The plan's rule is that a missing one is "a 0E reconciliation, not a component invented here" |
| `Money`, `currency` from `@dulja/domain` in both screens | `apps/backoffice/package.json` depends on `@dulja/contracts`, `@dulja/i18n` and `@dulja/ui`, not on `@dulja/domain`. `MoneyJson` does exist (`packages/i18n/src/format.ts:17`), as the plan says |
| `createFileRoute("/accounting/ageing")` | `apps/backoffice/src/router.tsx` builds a code-based tree with `createRoute`. The two routes join it as `createRoute` entries under `shellRoute` |
| `packages/i18n/src/locales/en.json`, `ar.json` | The catalogues are `packages/i18n/catalogues/en.json` and `ar.json`, as 3C's, 3D's and 4A's records also found |
| `useCompanyId` from `../../lib/session` | Present (`apps/backoffice/src/lib/session.tsx:111`) |
| two nav entries in `src/components/app-shell.tsx` | Present. That file holds one nav link today (`/admin/users`) |
| `tests/e2e/ar-ap-screens.spec.ts` through `bootLocalStack()` | `bootLocalStack` is present (`tests/e2e/support/boot.ts:192`) |

## The acceptance criteria, fixed now

These hold whatever the screenshots show (spec:2254; the plan's Global Constraints 16 and 17):

- **Keyboard parity.** Every action is reachable without a pointer, in the order the operator's description
  gives. That includes matching a hundred-line statement.
- **Both text directions are verified before merge.** This is acceptance test 23's 4B re-run. The numeric
  columns keep reading order, and the matcher's two columns swap sides under `dir="rtl"`.
- **Every user-facing string goes through i18next** with an ICU message, and the `en` and `ar` catalogues are
  complete.
- **No invented workflow.** Every field maps to a column or to one of the routes above. A field that maps to
  neither changes the plan, not a component.
- **Money is never a JavaScript `number` on a screen** (spec:2041). Amounts are the API's 4-dp strings. Any
  figure the screen derives, such as the plan's reconciliation difference, is item 3 above and is decided
  explicitly.

## Why the default layout was not built anyway

The plan does state a default and carries real code for it: *"hazard 29 blocks the screen, not the ability to
write one."* The default is reproduced above in full, so a reviewer can hold it against the owner's material
the day it arrives.

But what the gate asks about is exactly what the default cannot supply:

- whether a clerk works the ageing from the oldest bucket or from the biggest balance
- what they do from a row
- whether the bank statement is a file or a printout
- whether a clerk ticks one line at a time or many
- how a deposit of three cheques is matched
- how a mistaken tick is found again the next morning

spec:79 and spec:108 say the UI is not specified and workflows are not to be invented, and hazard 29 forbids
it. `AGENTS.md` requires the screenshots and the walkthrough before any UI task.

A screen built against a guess looks finished, so nobody re-opens the question, and the operator it was built
for is slower on it than on the system it replaced. The reconciliation sheet is used once a month under a
deadline, against a paper statement, and it is exactly the screen whose rhythm a plausible guess gets wrong.

## The owner request, ready to send

> **OD-24 (spec:2408), ageing and bank reconciliation.** Before we build these two screens, please provide:
> **(a)** screenshots of the two Sahlisoft screens your staff use today: the **debtor/creditor ageing** and
> the **bank reconciliation** sheet. **(b)** A **two-minute description** of each, from whoever does the job,
> of what they do in order and which keys they press. For the ageing, say what they do next from a customer's
> line. For the reconciliation, say how the bank statement gets into the system, how a line is ticked off
> against a receipt or payment, and how a wrong tick is undone.
>
> **Verify:** `ls -1 docs/owner/od-24/4b/` lists `ageing.png`, `bank-reconciliation.png` and one `.md`
> transcript for each. **Until provided:** this task stays open and no component is written. Nothing else in
> slice 4B waits, and Task 12's slice exit does not wait for it.

## What this blocks, cumulatively

OD-24 now blocks **seven whole tasks in seven slices, across four phases**:

| Task | Screens | Record |
|---|---|---|
| 1B Task 11 | chart of accounts, journal entry, periods | `docs/ui/od-24-phase-1-screens.md` |
| 2C Task 12 | document list and entry | `docs/ui/od-24-phase-2-screens.md` |
| 3A Task 15 | item master, warehouses, stock enquiry | `docs/ui/od-24-phase-3a-screens.md` |
| 3C Task 13 | purchase order, goods receipt, import shipment | `docs/ui/od-24-phase-3c-screens.md` |
| 3D Task 13 | transfers, stock count, stock on hand | `docs/ui/od-24-phase-3d-screens.md` |
| 4A Task 13 | invoice list, invoice editor, receipt/payment, allocation | `docs/ui/od-24-phase-4a-screens.md` |
| 4B Task 11 | ageing worklist, bank reconciliation | this file |

None of those phases' definitions of done has a screen clause, so none of them is blocked *by* this. Phase 4's
two DoD sentences are proved at the service and route level (4B Tasks 3, 7 and 8). But until the material
arrives, the back-office ships with **no screen** for any of accounting, documents, inventory, purchasing,
inventory operations, AR/AP, ageing or bank reconciliation.
