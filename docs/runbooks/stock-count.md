# Runbook — stock count (physical inventory)

The procedure for counting stock and posting the variance. It covers a **full count** of a warehouse and a
**cycle count** of a subset of items; both use the same document type, `STOCK_COUNT` (spec:1052), and the
same four steps.

The type is configuration, not code: its policy lives in
`packages/db/seed/my/document-types/STOCK_COUNT.json`. The rule it encodes is that **only the variance
posts** — a line whose counted figure matches the expected one produces no movement and no ledger entry.

Two people are always involved. `inventory.count.create` (the **counter** — the `warehouse` and
`branch_manager` roles) draws up the sheet and enters the figures; `inventory.adjustment.approve` (the
**approver** — the `accountant` role) approves and posts it. The system refuses a sheet approved by the
principal who submitted it (`ERR_SOD_MAKER_IS_CHECKER`, spec:2026), so the split is not a convention.

---

## 1. Before the count

1. Choose the warehouse. It must be a `kind = 'stock'` warehouse; an in-transit corridor is not counted,
   and the system refuses one.
2. Decide **full** or **cycle**. A full count omits `itemIds`; a cycle count passes the subset being
   counted this week.
3. Draw the sheet:

   ```http
   POST /v1/companies/{companyId}/documents/count-sheet
   Idempotency-Key: <a fresh uuid>

   { "documentTypeCode": "STOCK_COUNT", "series": "SC",
     "effectiveDate": "2026-02-01", "warehouseId": "<the warehouse>" }
   ```

   The response is a draft `STOCK_COUNT` and one line per (item, warehouse, lot) key that carries stock.
   Each line records `expectedQuantity` — the `stock_on_hand` figure **at the moment the sheet was drawn**
   — and leaves `countedQuantity` and the variance empty.

   Keys whose projected quantity is zero are left off by default. Pass `"includeZero": true` when the point
   of the count is to prove that a line really is empty.

4. Print the sheet with blank count boxes. **The printed sheet deliberately omits the expected quantity.**
   A counter who can see the expected figure confirms it instead of counting, which is the one control the
   legacy process lacked. The server enforces this rather than trusting the print template:
   `GET …/documents/{documentId}/count-sheet` returns `expectedQuantity: null` to any principal who does not
   hold `inventory.adjustment.approve`.

Freeze movement in the warehouse for the duration, or accept that a receipt posted mid-count will show up
as a variance. The sheet is a snapshot; it is not re-read.

## 2. During the count

> **Freeze the location for the whole count.** The expected figure on the sheet is `stock_on_hand` **at
> the moment the sheet is drawn**, and the variance posted at step 4 is `counted − expected` against that
> frozen figure. Nothing in the system re-reads the location at posting time, so **every movement posted
> into or out of the warehouse between drawing the sheet and posting the count is double-counted into the
> variance**: a delivery of 30 posted after the snapshot makes an accurate count of 70 look like 30 units
> of shrinkage. Do not receive, deliver or transfer against a warehouse while its sheet is open; if a
> movement is unavoidable, void the sheet and draw a new one after it posts. A system-enforced count freeze
> is not built in Phase 3; this runbook is the control until it is (recorded in `docs/reports/phase-3.md`).

- Count **by lot**, not by item: a lot-tracked item has one line per lot and the variance is per lot.
- Write the figure on the sheet in ink. The paper sheet is the evidence; the screen is the transcription.
- A key that is not on the sheet but has stock on the shelf is a finding in its own right: note it, and draw
  a second sheet with `includeZero: true` afterwards rather than writing on this one.

## 3. After the count — entering the figures

```http
PATCH /v1/companies/{companyId}/documents/{documentId}/counts
Idempotency-Key: <a fresh uuid>

{ "counts": [ { "documentLineId": "…", "countedQuantity": "8.000000" } ] }
```

`PATCH`, not `PUT`: a counter enters part of a sheet at a time, and a line not named keeps its empty
counted quantity and posts nothing. The variance (`counted − expected`) is computed by the server in the
same statement as the counted figure, so the two can never disagree.

When every line has been entered, submit:

```http
POST /v1/companies/{companyId}/documents/{documentId}/transitions   { "to": "submitted" }
```

**A submitted sheet can no longer be edited.** `PATCH …/counts` answers `409 ERR_DOC_STATUS_ILLEGAL` — the
sheet is evidence from this point on. A sheet entered wrongly is rejected back to draft by the approver, or
corrected by a second count; it is never quietly overwritten.

## 4. Approval and posting

The approver reviews each variance **against the expected figure**, which they — and only they — can see.
Then:

```http
POST …/transitions   { "to": "approved" }
POST …/transitions   { "to": "issued" }     # the sheet takes its SC number here
POST …/transitions   { "to": "posted" }
```

What posting does:

- a **shortfall** credits the item's inventory account and debits `5110` stock-count variance;
- a **surplus** debits inventory and credits `5110`, valued at the average of the open cost layers (there is
  no purchase price for stock that simply appeared);
- a **matching** line does nothing at all.

The resulting `5110` balance for the period **is** the month's shrinkage. That is the number the count
exists to produce.

### A matching sheet is a success, not a failure — and it is voided, not posted

A sheet on which every line matches plans **no movement and no ledger entry**, and the posting service
refuses a document whose plan has zero ledger lines (`ERR_DOC_NO_LINES`, contracts §4.3.2 step 6). So a
fully matching sheet is **issued and then voided** with the reason `count matched`: it keeps its number,
the void records why the number never posted (SAH-051), and the document and its event log remain the
evidence that on this date this warehouse was counted and found correct. Do not re-run the count looking
for a variance.

> **Open item for the owner.** The 3D plan intended a matching sheet to *post* with an empty ledger, which
> contradicts the frozen §4.3.2 step 6. Until the contract is amended, the void above is the procedure.

### Correcting a posted count

**Count again.** A new sheet snapshots the current on-hand as its expected figure, so its variance is exactly
the correction the mis-count needs, and it posts against the same `5110`. Nothing is ever deleted
(spec:2049).

A posted `STOCK_COUNT` cannot be reversed today, although its policy says `reversal.allowed: true`:
`reverseDocument` drafts the mirror and posts it at once, and a type that requires approval may not go
draft → issued (contracts §4.5.1), so the reversal is refused with `ERR_DOC_STATUS_ILLEGAL`. Whether an
approval-required type may be reversed at all is an open item for the owner.

This is also the route for correcting a mis-counted **transfer receipt**: `TRANSFER_RECEIPT` forbids
reversal, because its lines carry a variance rather than a quantity moved, so stock that is not where the
books say it is gets a `STOCK_COUNT` at the receiving branch. Both documents post against the same `5110`,
so the net balance is right after the pair even though neither references the other.
