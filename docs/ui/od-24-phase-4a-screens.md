# OD-24 — the Phase 4A AR/AP screens (Plan 4A Task 13)

**Status:** 🚫 **NOT STARTED: blocked on owner material.** Plan 4A Task 13 is the only 4A task that touches
OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only 4A task that did not ship. Tasks 0–12 and 14
are written. Earlier slices recorded the same posture in their own files:

- 1B, the accounting screens: `docs/ui/od-24-phase-1-screens.md`
- 2C, the document screens: `docs/ui/od-24-phase-2-screens.md`
- 3A, the inventory screens: `docs/ui/od-24-phase-3a-screens.md`
- 3C, the purchasing screens: `docs/ui/od-24-phase-3c-screens.md`
- 3D, the inventory-operations screens: `docs/ui/od-24-phase-3d-screens.md`

This file is 4A's record. It is the **sixth** task OD-24 now blocks.

## The gate, and what it checks

Plan 4A Task 13 Step 1 gives the gate as two commands. The first must print **4 or more**, and the second
must print `OD-24 attached`:

```
ls docs/ui/screenshots/ar-ap/ | wc -l
test -s docs/ui/ar-ap-operator-notes.md && echo "OD-24 attached"
```

Run on 2026-09-28 against this tree, both fail outright. So does the register's location for owner
material:

```
$ ls docs/ui/screenshots/ar-ap/
ls: cannot access 'docs/ui/screenshots/ar-ap/': No such file or directory
$ test -s docs/ui/ar-ap-operator-notes.md && echo "OD-24 attached"
$ ls docs/owner/
ls: cannot access 'docs/owner/': No such file or directory
```

This plan puts the material under `docs/ui/screenshots/`. 3A, 3D and `AGENTS.md` put it under
`docs/owner/od-24/`, and 3C under `docs/ux/`. **None of the three directories exists.** The material has
never been supplied for any phase. The owner should deliver into one place. `docs/owner/od-24/4a/` is the
register's spelling, and the plan's two commands then change to that path. That is a one-line correction, not
a design decision.

Step 1's own rule, verbatim: *"**Until provided:** this task does not start. There is no local equivalent
and none is invented — a screen built from a guess is the failure hazard 29 names, and the four routes are
fully exercised by the route suites of Tasks 1, 6, 9 and 10 in the meantime."*

**That is what was done.** Steps 2–4 are unchecked. No file was written under
`apps/backoffice/src/features/ar-ap/`, no `ar-ap` catalogue keys exist, and `tests/e2e/ar-ap.spec.ts` does
not exist.

## What is blocked

The plan's four screens. None is built:

| Screen | What the owner's material must show |
|---|---|
| **Invoice list** | How a clerk finds an invoice today: by number, by customer, by date, or by what is still unpaid. What columns they read without opening the invoice |
| **Invoice editor** | The sales and purchase invoice, and the credit note raised from one: what is typed first, whether an invoice usually starts from a delivery (`convert-to-invoice`) or is keyed from nothing, and which field is tabbed to most |
| **Receipt / payment editor** | A customer receipt and a supplier payment: the bank account, the reference, and whether the clerk allocates against invoices on the same screen or later. A payment needs a **second person** to approve it (spec:2147), so the screen must show who does that step and when |
| **Allocation panel** | How money received is matched to invoices: oldest first, by choosing each invoice, or by typing amounts. What happens to an overpayment. How a mistaken allocation is undone. The API compels a reason for that |

Acceptance test 23's 4A re-run is also blocked (`tests/e2e/ar-ap.spec.ts`, both text directions, through 0E's
`bootLocalStack` in `tests/e2e/support/boot.ts`). The file cannot exist before the screens it renders.

## What the owner must provide

For **each** of the four screens:

1. **A screenshot** of the Sahlisoft screen the staff use for that job today.
2. **A two-minute description**, from the person who actually does the job, of their real sequence: what they
   type first, what they never touch, which field they tab to most, which keys they press. Not a
   specification; the real sequence, including the parts that are annoying.

Eight files in all: four screenshots and four transcripts.

## The routes the screens would consume, all shipped

The API is the deliverable, and it is complete. Every endpoint below is mounted, carries a permission gate that
`assertRouteGates` checks at boot and an `Idempotency-Key` on every unsafe method, and passes the path company
into every service call it makes. An operator's own tooling can drive all four jobs today.

| Route | Slice / task | Screen |
|---|---|---|
| `GET` / `POST /v1/companies/{companyId}/payment-terms` | 4A T1 | invoice editor (the term), party screen |
| `PATCH …/payment-terms/{paymentTermId}`, `POST …/payment-terms/{paymentTermId}/archive` | 4A T1 | (payment-term maintenance) |
| `POST …/documents/{documentId}/convert-to-invoice` | 4A T6/T7 | invoice editor: from a posted `DELIVERY_ORDER` or `GOODS_RECEIPT` |
| `POST …/documents/{documentId}/credit-note` | 4A T8 | invoice editor: a partial credit note, issued with its reason |
| `POST …/documents/settlements` | 4A T10 | receipt / payment editor. The body names `documentTypeCode` (`RECEIPT` or `PAYMENT`) |
| `POST` / `GET …/documents/{documentId}/allocations` | 4A T9 | allocation panel |
| `POST …/documents/{documentId}/allocations/{allocationId}/unallocate` | 4A T9 | allocation panel: undo, with the compelled reason |
| `GET …/documents/{documentId}/open-balance` | 4A T9 | allocation panel, invoice list (what is still owed) |
| `GET …/parties/{partyId}/balance` | 4A T9 | receipt / payment editor, the party's balance per currency and in base |
| `POST …/documents`, `GET` / `DELETE …/documents/{documentId}`, `PUT …/documents/{documentId}/lines` | 1A/2B | invoice editor: an invoice keyed from nothing (`documentTypeCode: "SALES_INVOICE"` or `"PURCHASE_INVOICE"`). The response carries `paymentTermId` and `dueDate` (4A T3) |
| `POST …/documents/{documentId}/transitions` | 2B | all: submit, approve (the `PAYMENT` second principal), issue |
| `POST …/documents/{documentId}/overrides` | 2B | invoice editor: the credit-limit override, by a second principal (`docs/runbooks/credit-control-override.md`) |
| `POST …/documents/{documentId}/reverse` | 2B | invoice editor: a full reversal, which produces the credit note |
| `POST …/documents/{documentId}/print`, `GET …/documents/{documentId}/events` | 2C / 2B | all |
| `GET …/reports/inventory.sales_by_item` | 3D, 4A T11 | (report) revenue and margin per item |

The plan's Interfaces line says the screens reach these routes "through the generated client (§4.2.7)". That
client does not exist. `AGENTS.md` records that `apps/backoffice` calls the API through the handwritten
`apps/backoffice/src/lib/admin-api.ts`, so a 4A fetch layer would wrap `AdminApi` the way 3D's planned
`transfer-api.ts` does.

**Three things the screens cannot get from the API, stated before the material arrives.** Each is a **new
endpoint**, and so a plan amendment, not a component:

1. **There is no document list endpoint.** The `documents` module registers `POST /`, `GET|DELETE
   /{documentId}` and sub-paths, but no `GET /`. 3D's record found the same gap. The invoice list screen has
   nothing to list from until one exists.
2. **There is no credit-status read.** `creditStatus()` (`packages/db/src/ar-ap/credit.ts`) returns the
   limit, the hold, the open base balance and the headroom, but no route exposes it. A screen can learn the
   figure only by being refused with `ERR_CREDIT_LIMIT_EXCEEDED`, whose message carries it.
3. **There is no list of open documents per party.** `open-balance` answers for one document at a time. The
   allocation panel's natural list, a customer's unpaid invoices, is 4B's ageing (§4.8.2) and is not in this
   slice.

## The exact file list that changes when the material arrives

Nothing above this line moves. Task 13 Steps 2–4 create:

- `apps/backoffice/src/features/ar-ap/InvoiceList.tsx`, `InvoiceEditor.tsx`, `SettlementEditor.tsx`,
  `AllocationPanel.tsx`
- `tests/e2e/ar-ap.spec.ts`: each screen under `dir="ltr"` and `dir="rtl"`. Numeric columns right-aligned in
  both, Hijri and Gregorian dates both rendering, tab order matching the operator's sequence. Run with
  `bun run --cwd tests test:e2e -- ar-ap`
- the `ar-ap` message keys in **both** catalogues

**Path deviation from the plan's own Files line.** The plan names `packages/i18n/src/locales/en/ar-ap.json`
and `ar/ar-ap.json`. That directory does not exist. The catalogues are `packages/i18n/catalogues/en.json` and
`ar.json`, as 3C's and 3D's records also found. The plan also names `apps/backoffice/src/features/`, which
does not exist either. The application's screens live under `apps/backoffice/src/routes/`. The owner's
material does not settle which is right, and it is one line either way when the gate opens.

## The acceptance criteria, fixed now

These hold whatever the screenshots show (spec:2254; Global Constraints 15 and 16):

- **Keyboard parity.** Every action reachable without a pointer, in the order the operator's description
  gives. 0E's model is unchanged: `/` filters, `↑`/`↓` move, `Enter` opens, `Ctrl+S` saves, `Esc` reverts,
  `Ctrl+N` starts a new row.
- **Both text directions verified before merge.** This is acceptance test 23's 4A re-run.
- **Every user-facing string through i18next** with an ICU message, and the `en` and `ar` catalogues complete.
- **No invented workflow.** Every field maps to a `document` / `document_line` / `allocation` column or to one
  of the routes above. A field that maps to neither changes the plan, not a component.
- **Money is never a JavaScript `number` on a screen either** (spec:2041). Amounts are the API's 4-dp strings,
  formatted for display and never computed client-side. The API already gives the open balance and the party
  balance, so no screen needs arithmetic.

## Why a default layout was not built anyway

The plan gives no default layout for these four screens. It is right not to. What the gate asks is exactly
what a default cannot supply:

- whether the clerk allocates while entering the receipt or afterwards
- whether an invoice starts from a delivery or is keyed from nothing
- what a clerk does with a payment that covers three invoices and part of a fourth

spec:79 and spec:108 say the UI is not specified and workflows are not to be invented. Hazard 29 forbids it.
A screen built against a guess looks finished, so nobody re-opens the question, and the operator it was built
for is slower on it than on the system it replaced.

## The owner request, ready to send

> **OD-24 (spec:2408), invoices, receipts and payments.** Before we build these screens, please provide:
> **(a)** screenshots of the four Sahlisoft screens your staff use today: the invoice list, the invoice
> itself, the receipt/payment voucher, and wherever a receipt is matched against invoices. **(b)** A
> **two-minute description** of each, from whoever does the job, of the order they type in and what they tab
> between. Include how a supplier payment gets its second signature today.
>
> **Verify:** four screenshots and four transcripts in `docs/owner/od-24/4a/`, or at the plan's
> `docs/ui/screenshots/ar-ap/` and `docs/ui/ar-ap-operator-notes.md`. **Until provided:** this task stays open
> and no component is written. Nothing else in slice 4A waits, and Task 14's slice exit does not wait for it.

## What this blocks, cumulatively

OD-24 now blocks **six whole tasks in six slices, across four phases**:

| Task | Screens | Record |
|---|---|---|
| 1B Task 11 | chart of accounts, journal entry, periods | `docs/ui/od-24-phase-1-screens.md` |
| 2C Task 12 | document list and entry | `docs/ui/od-24-phase-2-screens.md` |
| 3A Task 15 | item master, warehouses, stock enquiry | `docs/ui/od-24-phase-3a-screens.md` |
| 3C Task 13 | purchase order, goods receipt, import shipment | `docs/ui/od-24-phase-3c-screens.md` |
| 3D Task 13 | transfers, stock count, stock on hand | `docs/ui/od-24-phase-3d-screens.md` |
| 4A Task 13 | invoice list, invoice editor, receipt/payment, allocation | this file |

None of those phases' definitions of done has a screen clause, so none is blocked *by* this. But the
back-office ships with **no screen for any of** accounting, documents, inventory, purchasing, inventory
operations or AR/AP until the material arrives. The gap grows by one slice at a time.
