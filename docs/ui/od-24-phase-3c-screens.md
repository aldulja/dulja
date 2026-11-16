# OD-24 — the Phase 3C purchasing screens (Plan 3C Task 13)

**Status:** 🚫 **NOT STARTED — blocked on owner material.** Plan 3C Task 13 is the only task in Plan 3C that
touches OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only 3C task that did not ship. Tasks
0–12 and 14 are all written. 1B recorded the same posture for the accounting screens in
`docs/ui/od-24-phase-1-screens.md`, 2C for the document screens in `docs/ui/od-24-phase-2-screens.md`, and
3A for the inventory screens in `docs/ui/od-24-phase-3a-screens.md`; this file is 3C's record, and it is the
fourth task OD-24 now blocks.

## The gate, and what it checks

Plan 3C Task 13 Step 1 states the gate as a location rather than a command: the two-minute operator
description is attached to the task and **the three screenshots are in `docs/ux/purchasing/`**. Run on
2026-09-20 against this tree, every reading of that gate fails outright:

```
$ ls -1 docs/ux/purchasing/
ls: cannot access 'docs/ux/purchasing/': No such file or directory
$ ls -1 docs/ux/
ls: cannot access 'docs/ux/': No such file or directory
$ ls -1 docs/owner/od-24/3c/
ls: cannot access 'docs/owner/od-24/3c/': No such file or directory
```

Neither `docs/ux/` (this plan's spelling) nor `docs/owner/od-24/` (the spelling 3A's Task 15 used, and the
one `AGENTS.md` records for the register) exists. The material has never been supplied for
any phase, so the gate is not narrowly missing one of six files — the whole directory tree the owner would
deliver into is absent.

Step 4 of the task then reads, verbatim: *"There is nothing to commit. The task stays open with the request
and the table above recorded on it. **Task 14's slice exit does not wait for it** — §2.12's default is
explicit that the screen task, not the slice, is blocked."*

That is what was done. Nothing was written against a guess: spec:79 and spec:108 say the UI is not
specified and that workflows are not to be invented from the specification, and hazard 29 forbids it.

**The owner request, verbatim from Step 1**, so it can be sent as-is:

> **OD-24 (spec:2408).** Before we build the purchasing screens, please provide: **(a)** screenshots of the
> three Sahlisoft screens your staff use today for raising a purchase order, receiving goods against one,
> and entering an import shipment's freight and duty; **(b)** a two-minute description, from whoever does
> the job, of the order in which they type and what they tab between. Not a specification — the actual
> sequence, including the parts that are annoying.
>
> **Verify:** the description is attached to this task and the three screenshots are in
> `docs/ux/purchasing/`. **Until provided:** this task stays open and no component is written. Nothing else
> in slice 3C waits.

## What the slice ships instead

The API is the deliverable, and it is complete. An operator's own tooling can already drive every screen
this task would have built — which is the point of the API-first split, not a consolation.

| Screen | Endpoints already shipped (3C Tasks 4 and 9, on 1A's `documents` module) |
|---|---|
| Purchase order | `POST\|GET\|DELETE …/documents[/{documentId}]`, `PUT …/documents/{documentId}/lines`, `POST …/documents/{documentId}/transitions`, `GET …/documents/{documentId}/open-quantity` |
| Goods receipt | the same document routes, plus `POST\|GET …/documents/{documentId}/links` (receiving is link creation plus a draft) |
| Import shipment | the same document routes, plus `POST\|GET …/documents/{documentId}/landed-cost` |
| All three | `POST …/documents/{documentId}/print` (2C), `GET …/documents/{documentId}/events` (2B), `POST …/documents/{documentId}/reverse` (1A) |

All five 3C sub-paths — `POST`/`GET …/links`, `GET …/open-quantity`, `POST`/`GET …/landed-cost` — carry a
permission gate `assertRouteGates` checks at boot (`requireDocumentPermission("submit")` on the two `POST`s,
`requireDocumentModuleRead()` on the three `GET`s), an `Idempotency-Key` on every unsafe method, and
company-binding on **both** sides of every link and allocation. They add no `PROBES` key because they are
sub-paths of an existing module (plan §"Why there is no new route module"), and they are in
`packages/contracts/openapi.json`.

The wire shapes the screens would bind to are shipped too: `DocumentLinkSchema`, `CreateDocumentLinksBody`,
`DocumentLinkList`, `OpenQuantitySchema`, `OpenQuantityList` (`packages/contracts/src/accounting/document-link.ts`)
and `LandedCostMethodSchema`, `AllocateLandedCostBody`, `LandedCostAllocationSchema`,
`LandedCostAllocationList`, `LandedCostSummarySchema` (`packages/contracts/src/inventory/landed-cost.ts`).

## What the three screens will be, so the request is answerable

Plan Task 13 Step 2's table, carried here unchanged — the shape being asked about, with no workflow invented
for it:

| Screen | What it shows | The one thing that is not obvious from the API |
|---|---|---|
| **Purchase order** | party, warehouse, item lines with agreed price and quantity; a running total; **`open_quantity` per line once anything has been received against it** | An order stops at `issued` and never posts (Task 5), so the screen has an *Issue* action and no *Post* action — a Post button would be a bug the operator cannot recover from |
| **Goods receipt** | the open lines of one or more issued orders, quantity received per line defaulting to the open quantity, lot and expiry per line | Receiving is *link creation plus a draft*, which the operator experiences as one action; `ERR_DOC_LINK_OVER_FULFILLED` is the only refusal they can cause and its message already names both figures (migration `0037_create_document_link.sql:145`) |
| **Import shipment** | goods lines, cost lines, and a **method selector per cost line** with the resulting per-line landed amount recomputed live from `GET …/landed-cost`'s `summary` | Allocation is draft-only (Task 7). After post the selector must be absent, not disabled-with-a-tooltip: the remedy is a reversal, and offering a control that cannot work invites the support call it looks like it prevents |

## The acceptance criteria, fixed now

Plan Step 3, fixed independently of what the screenshots show, so the answer cannot be read as licence to
skip them (spec:2254; Global Constraint 2):

- **Keyboard parity:** every action reachable without a pointer, tab order follows the typing order the
  operator described, and `Enter` on the last line of a document adds a line rather than submitting.
- **Both text directions verified before merge:** each screen rendered `dir="ltr"` and `dir="rtl"` with 0E's
  harness, and the numeric columns right-aligned in both — a quantity column that flips to the left in
  Arabic is the defect this check exists to catch.
- **No invented workflow:** every field on each screen maps to a `document`/`document_line` column or to one
  of the five sub-paths. A field that maps to neither is a change to this plan, not to a component.

## The exact file list that changes when the material arrives

Nothing above this line moves. Task 13 creates:

- `apps/backoffice/src/lib/purchasing-api.ts` — the typed fetch layer, which is **independent of the
  workflow**: it wraps the routes above and would not change even if the owner's material showed a
  completely different screen.
- `apps/backoffice/src/routes/purchasing/purchase-order.tsx`, `goods-receipt.tsx`, `shipment.tsx`
- `apps/backoffice/test/purchasing-order.test.tsx`, `purchasing-receipt.test.tsx`,
  `purchasing-shipment.test.tsx` — each rendering its screen `dir="ltr"` and `dir="rtl"`
- `tests/e2e/purchasing-screens.spec.ts` — acceptance test 23's 3C re-run, both text directions
- Modify: `apps/backoffice/src/router.tsx` (three routes), `apps/backoffice/src/components/app-shell.tsx`
  (three nav entries), `packages/i18n/catalogues/en.json` and `ar.json` (every `purchasing.*` key, in BOTH)

  A note on that last path: the three earlier OD-24 records all spell it `packages/i18n/src/locales/`, which
  no longer exists — the catalogues are `packages/i18n/catalogues/en.json` and `ar.json`, with
  `packages/i18n/src/completeness.ts` as the both-locales check. This file uses the real path.

**One deviation from the plan's own Files line, recorded rather than silently followed.** Plan Task 13 names
`apps/desktop/src/screens/purchasing/{PurchaseOrder,GoodsReceipt,Shipment}.tsx` and
`apps/desktop/test/screens/purchasing/*.test.tsx`. **That path does not exist and cannot**: `apps/desktop` in
this tree is the Electron main/preload shell alone — `main.ts`, `preload.ts`, `bridge-types.ts`,
`navigation-guard.ts`, `secure-store.ts`, `updater.ts`, `window-options.ts` and no `src/screens/` directory
— and `AGENTS.md`'s architecture section says `desktop` "imports build outputs only". React screens live in
`apps/backoffice`, which is where 1B Task 11, 2C Task 12 and 3A Task 15 all placed theirs. The list above
follows the tree and the three precedents, not the plan's literal path. This is a documentation-only note
until the gate opens; when it does, it is a one-line plan correction, not a design decision.

## What this blocks, cumulatively

OD-24 now blocks four whole tasks across four slices in three phases — 1B Task 11 (three accounting
screens), 2C Task 12 (the document list and entry screens), 3A Task 15 (item, warehouse and stock) and 3C
Task 13 (these three purchasing screens). None of those phases' definitions of done contains a screen
clause, so none of them is blocked *by* this; but the back-office application ships with no screen for any
of accounting, documents, inventory or purchasing until the material arrives.
