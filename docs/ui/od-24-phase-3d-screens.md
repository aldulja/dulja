# OD-24 — the Phase 3D transfer, stock-count and stock-on-hand screens (Plan 3D Task 13)

**Status:** 🚫 **NOT STARTED — blocked on owner material.** Plan 3D Task 13 is the only task in Plan 3D that
touches OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only 3D task that did not ship. Tasks 0–12
and 14 are all written. 1B recorded the same posture for the accounting screens in
`docs/ui/od-24-phase-1-screens.md`, 2C for the document screens in `docs/ui/od-24-phase-2-screens.md`, 3A for
the item/warehouse/stock screens in `docs/ui/od-24-phase-3a-screens.md` and 3C for the purchasing screens in
`docs/ui/od-24-phase-3c-screens.md`; this file is 3D's record, and it is the **fifth** task OD-24 now blocks.

## The gate, and what it checks

Plan 3D Task 13 Step 1 states the gate as an exact command:

```
ls -1 docs/owner/od-24/3d/
```

It must list **six** files — `transfers.png`, `stock-count.png`, `stock-on-hand.png` and one `.md` transcript
each, every `.md` being a transcribed **two-minute** description of what the operator does on that screen, in
order, **including which keys they press**. Run on 2026-09-20 against this tree it fails outright, and not
narrowly:

```
$ ls -1 docs/owner/od-24/3d/
ls: cannot access 'docs/owner/od-24/3d/': No such file or directory
$ ls -1 docs/owner/
ls: cannot access 'docs/owner/': No such file or directory
$ ls -1 docs/ux/
ls: cannot access 'docs/ux/': No such file or directory
```

Neither spelling of the delivery directory exists — `docs/owner/od-24/` (the register's, and 3A's) nor
`docs/ux/` (3C's plan's). The material has never been supplied for any phase, so this is not a gate missing
one of six files; the whole tree the owner would deliver into is absent.

Step 1 then reads, verbatim: *"**If the directory is missing or incomplete: stop here.** Record 'OD-24
unanswered for 3D; screens deferred' in the task, leave Steps 2–6 unchecked, and ship the slice — nothing in
Tasks 0–12 or 14 depends on this task. Do not substitute a guess."*

**That is what was done. OD-24 is unanswered for 3D; screens deferred.** Steps 2–6 are unchecked, no `.tsx`
file was written, and `apps/backoffice/src/routes/inventory/` still does not exist in this tree.

## What the slice ships instead

The API is the deliverable, and it is complete. Every endpoint the three screens would consume is already
shipped and mounted — that is the point of the API-first split, not a consolation. An operator's own tooling
can drive all three jobs today.

| Screen | Endpoints already shipped |
|---|---|
| **Transfers** (dispatch + receipt) | `POST /v1/companies/{companyId}/documents/transfers` (3D T7 — drafts the dispatch into the corridor); `POST …/documents/{documentId}/receipt` (3D T8 — drafts the receive leg against the posted `TRANSFER` the path names); `POST …/documents/{documentId}/transitions` (2B — issue/post); `GET …/documents/{documentId}` (1A); `GET …/reports/inventory.stock_on_hand?includeInTransit=true` (3D T10 — **this is the in-transit worklist**) |
| **Stock count** | `POST …/documents/count-sheet` (3D T8 — snapshots a sheet); `PATCH …/documents/{documentId}/counts` (3D T8 — enters figures on a draft sheet); `GET …/documents/{documentId}/count-sheet` (3D T8 — reads it back); `POST …/documents/{documentId}/transitions` (2B — submit/approve, the second principal) |
| **Stock on hand** | `GET …/reports/inventory.stock_on_hand` (3D T10, with `includeInTransit`); `GET …/reports/inventory.valuation` and `GET …/reports/inventory.sales_by_item` (3D T10, the other two of §4.16.1's three inventory report codes); `GET …/stock-on-hand` and `GET …/stock-on-hand/fefo` (3A's ordinary list module, a separate path and deliberately not a `ReportCode`) |
| **All three** | `POST …/documents/{documentId}/print` (2C); `GET …/documents/{documentId}/events` (2B); `POST …/documents/{documentId}/reverse` (1A — refused on a `TRANSFER_RECEIPT` by policy, which the screen must not offer); `PUT …/documents/{documentId}/lines`, `DELETE …/documents/{documentId}` (1A/2B) |

Every one of the five 3D sub-paths carries a permission gate `assertRouteGates` checks at boot —
`requireDocumentPermission("create")` on `POST …/transfers`, `POST …/count-sheet` and `PATCH …/counts`,
`requireDocumentPermission("submit")` on `POST …/{documentId}/receipt`, and
`requireDocumentModuleRead({ writeFree: false })` on `GET …/{documentId}/count-sheet` — an `Idempotency-Key`
on every unsafe method, and company-binding on every entity id in a path. They add no `PROBES` key because
they are sub-paths of 1A's existing `documents` module (§4.2.7).

The wire shapes the screens would bind to are shipped too: `TransferDraftBody`, `TransferDraftSchema`,
`TransferReceiptBody` (`packages/contracts/src/inventory/transfer.ts`); `CountSheetBody`, `RecordCountsBody`,
`CountSheetLineSchema`, `CountSheetResultSchema` (`packages/contracts/src/inventory/count.ts`);
`StockOnHandReportQuery`, `StockOnHandReportRowSchema`, `StockOnHandReportList`
(`packages/contracts/src/inventory/reports.ts`).

**One thing the screens cannot get from the API, and it is worth stating before the material arrives:
there is no document *list* endpoint.** The `documents` module registers `POST /`, `GET|DELETE /{documentId}`
and sub-paths, but no `GET /`. The transfers screen's worklist is therefore the **stock-on-hand report with
`includeInTransit=true`**, which is exactly what the plan's `listInTransit` does — a list of *goods in the
corridor*, not a list of transfer documents. If the owner's material shows an operator who works from a list
of recent transfer documents instead, that is a **new endpoint**, not a component, and it belongs in a plan
amendment rather than in this task.

## What the three screens will be, so the request is answerable

The plan's stated default layout, carried here unchanged and **not built** — the shape being asked about, with
no workflow invented for it:

| Screen | What it shows | The one thing that is not obvious from the API |
|---|---|---|
| **Transfers** | Two panes: the in-transit worklist (every `warehouse.kind = 'in_transit'` row, grouped by receiving branch, oldest dispatch first) inline-start; inline-end a form that is either a new dispatch or the receipt of the selected row | The receipt form's counted-quantity field **defaults to the dispatched quantity**, so the common case is `Ctrl+S` with no typing and a shortfall is a deliberate edit. A `TRANSFER_RECEIPT` cannot be reversed (its policy says so), so the screen must offer no reverse action at all — the correction route is a `STOCK_COUNT` (`docs/runbooks/stock-count.md`) |
| **Stock count** | A **grid**, one row per sheet line: item code, lot code, expiry and **one editable column** — the counted quantity | `Enter` commits the cell and moves **down the column**, not into a detail pane: a counter walks a shelf and types figures, and a screen that made them reach for a mouse between rows would be unusable. `Tab` still moves across. Submit is a separate, confirmed command because a submitted sheet cannot be edited (`recordCounts` refuses a non-draft) |
| **Stock on hand** | The report view, with an explicit "include goods in transit" toggle **defaulting to off**, mirroring `StockOnHandReportQuery.includeInTransit` | The `warehouseKind` column is always shown when the toggle is on, so a reader can never mistake a corridor row for shelf stock |

**A correction to the plan's own sentence about the expected quantity, recorded rather than followed
blindly.** Plan Task 13 says the expected quantity is "not shown on the count screen **and not in its API
response**". The second half is not what shipped: `CountSheetLineSchema.expectedQuantity` **is** in the
response, typed `QuantitySchema.nullable()`, and the route **nulls it for a principal who does not hold
`inventory.adjustment.approve`** (`packages/contracts/src/inventory/count.ts:20`). The control is the same —
the counter cannot see the expected figure and so cannot confirm it instead of counting — but it is a
per-principal projection, not an absent field, because the accountant reviewing the sheet *does* need to see
it. The screen's rule follows from that and is stricter than "hide the column": **render the expected column
only when the field is non-null**, and never compute a variance client-side from a figure the server withheld.

## The acceptance criteria, fixed now

Fixed independently of what the screenshots show, so the answer cannot be read as licence to skip them
(spec:2254; Global Constraint 2):

- **Keyboard parity.** Every action reachable without a pointer; 0E Task 4's model unchanged (`/` filters,
  `↑`/`↓` move the selection, `Enter` opens, `Ctrl+S` saves, `Esc` reverts, `Ctrl+N` starts a new row), plus
  this slice's one addition: on the count grid `Enter` moves **down the editable column**. No `onClick`
  without a corresponding key handler.
- **Both text directions verified before merge.** Each screen rendered `dir="ltr"` and `dir="rtl"`, no
  horizontal overflow, the count grid's column order mirrored, quantity columns right-aligned in **both** —
  a quantity column that flips to the left in Arabic is the defect this check exists to catch — and
  Arabic-Indic numerals per the locale. This is 3D's re-run of **acceptance test 23** (spec:2441); 3A's
  `inventory-screens.spec.ts` is a separate file and is not edited.
- **Every user-facing string through `useT`** with an ICU message, and the complete `inventory.transfer.*` and
  `inventory.count.*` key sets in **both** catalogues before merge (spec:2061), with
  `packages/i18n/src/completeness.ts` as the both-locales check.
- **No invented workflow.** Every field on each screen maps to a `document`/`document_line` column or to one
  of the five 3D sub-paths. A field that maps to neither is a change to this plan, not to a component.

## The exact file list that changes when the material arrives

Nothing above this line moves. Task 13 Steps 2–6 create:

- `apps/backoffice/src/lib/transfer-api.ts` — the typed fetch layer, **independent of the workflow**: it wraps
  the endpoints above and would not change even if the owner's material showed a completely different screen.
  It produces `export interface TransferApi { draftTransfer; receiveTransfer; listInTransit; countSheet;
  recordCounts; readCountSheet; stockOnHand }` and
  `export function createTransferApi(api: AdminApi, companyId: string): TransferApi`, with every Zod schema
  passed to 0E's `AdminApi` as a **parameter** (`get(path, schema)` / `send(method, path, body, schema)`,
  `apps/backoffice/src/lib/admin-api.ts:26`) and every path built in this one file so a typo is a compile
  error rather than a runtime 404. `Idempotency-Key` is set by `AdminApi.send` for every unsafe method
  (0E Task 5), so no screen can forget it.
- `apps/backoffice/src/routes/inventory/transfers.tsx`, `stock-count.tsx`, `reports.stock-on-hand.tsx`
- `apps/backoffice/test/inventory-transfers.test.tsx`, `inventory-stock-count.test.tsx` — against a mocked
  `TransferApi`: the receipt form pre-filling the dispatched quantity; a shortfall producing the right
  `counted_quantity` in the request body; the grid's `Enter`-moves-down behaviour; the grid rendering **no**
  expected-quantity column for a principal whose `expectedQuantity` is null; every interactive element
  reachable by keyboard alone; each rendered `dir="ltr"` and `dir="rtl"`
- `tests/e2e/inventory-transfers.spec.ts` — acceptance test 23's 3D re-run against `bootLocalStack`
  (`tests/e2e/support/boot.ts`), both text directions
- Modify: `apps/backoffice/src/router.tsx` (three `createRoute` entries at `/inventory/transfers`,
  `/inventory/stock-count`, `/inventory/reports/stock-on-hand`),
  `apps/backoffice/src/components/app-shell.tsx` (three nav entries),
  `packages/i18n/catalogues/en.json` and `ar.json` (every `inventory.transfer.*` and `inventory.count.*` key,
  in **both**)

**Two path deviations from the plan's own Files line, recorded rather than silently followed.**

1. The plan names `packages/i18n/src/locales/en.json` and `ar.json`. **That directory does not exist**; the
   catalogues are `packages/i18n/catalogues/en.json` and `ar.json`. 3C's record found the same thing and made
   the same correction; this file follows the tree.
2. The plan's `createTransferApi` sketch spells the in-transit worklist as
   `…/reports/inventory.stock_on_hand?includeInTransit=true&${query}`. That is correct against the shipped
   route, but note that `includeInTransit` is parsed by `z.stringbool().default(false)`, so the screen must
   send the literal string and must not rely on the bare flag form.

Both are one-line corrections when the gate opens, not design decisions.

## Why a default layout was not written down and built anyway

The plan does state a default, and it is reproduced above in full — that is deliberate, so a reviewer can hold
it against the owner's material the day it arrives. But everything the gate actually asks about is what the
default cannot supply: the order the fields are filled, what is typed versus chosen, whether the count grid is
walked by shelf position or by item code, what a counter does when the shelf holds a lot the sheet does not
list, and which keys a fast operator's hands already know. spec:79 and spec:108 are explicit that the UI is
not specified and that workflows are not to be invented from the specification, and hazard 29 forbids it.

A screen built against a guess is worse than no screen: it looks finished, so nobody re-opens the question,
and the operator it was built for is slower on it than on the system it replaced. The count sheet is the
sharpest case in the whole project — it is used standing up, one-handed, away from a desk — and it is exactly
the screen a plausible guess would get wrong.

## The owner request, ready to send

> **OD-24 (spec:2408), inventory operations.** Before we build the transfer, stock-count and stock-enquiry
> screens, please provide: **(a)** screenshots of the three Sahlisoft screens your staff use today for sending
> stock to another branch, for writing down a stock count, and for looking up what is in a warehouse;
> **(b)** a **two-minute description**, from whoever actually does each job, of the order in which they type
> and what they tab between — including what the person counting the shelves physically holds and does. Not a
> specification: the real sequence, including the parts that are annoying.
>
> **Verify:** six files in `docs/owner/od-24/3d/` — `transfers.png`, `stock-count.png`, `stock-on-hand.png`
> and one `.md` transcript each. **Until provided:** this task stays open and no component is written.
> Nothing else in slice 3D waits, and Task 14's slice exit does not wait for it.

## What this blocks, cumulatively

OD-24 now blocks **five whole tasks, in five slices, across three phases**:

| Task | Screens | Record |
|---|---|---|
| 1B Task 11 | chart of accounts, journal entry, periods | `docs/ui/od-24-phase-1-screens.md` |
| 2C Task 12 | document list and entry | `docs/ui/od-24-phase-2-screens.md` |
| 3A Task 15 | item master, warehouses, stock enquiry | `docs/ui/od-24-phase-3a-screens.md` |
| 3C Task 13 | purchase order, goods receipt, import shipment | `docs/ui/od-24-phase-3c-screens.md` |
| 3D Task 13 | transfers, stock count, stock on hand | this file |

**A note on how that is counted.** The 3D task brief describes this as "five whole tasks across four phases".
The slices are five — 1B, 2C, 3A, 3C, 3D — but they sit in **three** phases (1, 2 and 3), because three of the
five are Phase 3 slices. The table above is the count; "four phases" is a miscount and is recorded here rather
than repeated.

None of those phases' definitions of done contains a screen clause, so none of them is blocked *by* this.
But the back-office application ships with **no screen for any of accounting, documents, inventory,
purchasing or inventory operations** until the material arrives, and the gap is now five slices wide and
growing by one per slice. The cheapest moment to answer OD-24 was 1B; the cheapest remaining moment is now.
