# 0085 — Cut-over documents use the dedicated `OB` and `OS` series, and open items never re-recognise revenue

- Status: **Proposed** — the plan wrote _Accepted_; decisions 2, 5 and 6 decide the shape in which a customer's
  unpaid invoices and bills enter the ledger, which accounts they touch and what the ageing reads on day one (spec:95's
  money-semantics class), so it waits on the owner like every other Phase 9 ADR of that kind. Implemented in 9B
  Task 7 as the plan's default, ahead of approval, under the owner's direction to implement Phase 9 entirely
  (2026-11-13; `docs/review/2026-11-13-phase-9-decisions.md`).
- Date: 2026-11-13 (the plan's text is dated 2026-09-08)
- Slice: 9B · Task 7
- Contracts: amends §4.13.3 (round 20, amendment C1); reads §4.14 (`OPENING_BALANCE` → `OB`, `OPENING_STOCK` →
  `OS`), §4.15 (`1200`, `2100`, `3900`), §4.8.1 (allocation) and §4.8.2 (ageing and its tie-out). Supersedes: none.

## Context

Contracts §4.13.3 says every imported open document is "issued through the posting service in a dedicated series
`LEGACY` in the cut-over period so uniqueness holds and the new gapless series starts after cut-over". Three facts make
`LEGACY` unbuildable as written:

1. §4.3.6 takes the series from `policy.numbering.series`, and `issueDocument` writes it onto the header. A series
   that is no policy's cannot be issued without changing a frozen function (hazard 8).
2. §4.14 registers exactly two 9B document types, with series `OB` and `OS`. `LEGACY` is a literal in a shared
   namespace with no register row, which hazard 32 makes a review-blocking finding.
3. The sentence's stated purpose — uniqueness, and a clean new series — is met by any dedicated series.

Separately, the _shape_ of an imported open item is a money decision. An unpaid 2025 invoice could be re-created as a
`SALES_INVOICE`, which would post revenue and tax under 4A's and 5A's policies and move stock under 3D's. The legacy
trial balance already carries that revenue, that tax and that stock movement.

The legacy numbering is LEGACY-051's: it has duplicates and gaps, and some numbers are not numbers at all
(`INV/2025/0417`). And 4B's ageing (`app.party_ageing_rows`, 0048) reads, per party, the ledger rows a document posted to
the account `app.party_control_account` (0045) names for that party — so an open item on any other account is in no
party's ageing, and §4.8.2's tie-out to `1200`/`2100` "to the cent" fails.

## Decision

1. **The dedicated cut-over series are `OB` and `OS`** — the two §4.14 rows — used by no other document type and
   never re-used after cut-over. Contracts §4.13.3's `LEGACY` reads as those two (round 20, C1). Both types are
   service-only on the generic document routes (9B Tasks 5 and 6), so no person can draft one after cut-over.
2. **An open AR/AP item is an `OPENING_BALANCE` document with a `party_id` and a `legacy_ref`**, one per open legacy
   document (`BILLS` → target `open_item`), posting Dr the receivable control / Cr `3900`, or Dr `3900` / Cr the
   payable control. It is never a `SALES_INVOICE` or a `PURCHASE_INVOICE`, and it touches no revenue, expense, stock or
   tax account: the type's policy has `tax.applies: false` and no line carries a tax code, so no tax fact is invented.
3. **The amount is a magnitude and the side carries the direction** (A9's sign normalisation, at the boundary). A
   receivable opens on the debit side and a payable on the credit side; a legacy credit — a negative open amount, a
   credit note or advance not yet set off — opens on the other side. A zero open amount is reported, not loaded: a
   settled document is history.
4. **`document.legacy_ref` carries the printed legacy number verbatim; `document.number` is the posting service's own
   gapless `bigint` in the `OB` series.** Two legacy documents that share a number both load, each with its own `OB`
   number; the index on `legacy_ref` is non-unique (0101), and a legacy number never reaches `number`.
5. **The control leg is the account the party ages on.** The open item posts to the account map's `ar_control` (or
   `ap_control`), and the load **refuses the run** when that is not `app.party_control_account` of the item's party — a
   receivable of a vendor, a payable of a customer, or a party a person created on another control — naming the item,
   the party and both accounts. Posting it would put a figure in the ledger that no party's ageing holds; skipping it
   would record the key against nothing and never retry it (ADR 0084 decision 7) after the party is corrected.
6. **The effective date is the cut-over date** (spec:2039; 9B global constraint 3), never the legacy document's date,
   which is kept in the control line's description (`Open receivable at cut-over — legacy <number> dated <date>`). So
   each open item ages from the cut-over date: on that date every one is `current`. A legacy document dated after the
   cut-over date refuses the run — the source was not frozen, or the date is wrong.
7. **The live series start clean.** The import creates `document_series` rows for `OB` and `OS` only. The first real
   `SALES_INVOICE` after cut-over is the first number of its own series in its period, which is §5.1 #8's "start the
   new gapless series after cut-over".
8. **The trial-balance opening excludes the AR, AP and inventory controls** (9B Task 5), because the open-item load
   and `OPENING_STOCK` supply them. That exclusion is what makes decision 2 safe: without it the control balance would
   be counted twice.

## Consequences

- **The ageing ties out on day one.** Each open item is a document with a party and an effective date on its party's
  control account, so Σ buckets per party equals that party's balance and the 4B tie-out (`ageingTieOut`) reads
  `0.0000` against `1200` and `2100` — the same function, unchanged (`packages/importer/test/load/open-items.test.ts`).
- **Allocation works on day one.** A receipt after cut-over settles the opening document as it would an invoice
  (`allocateSettlement` asks the settled side only that it be posted, of the same party and on the opposite side of
  the control account); the test posts a `RECEIPT` through `draftSettlement` and allocates it.
- **The ageing BUCKETS start at the cut-over date** (decision 6). The total is right to the cent; the age of a
  legacy item is not — a 2025 invoice reads `current` on the cut-over date and grows older from there. The legacy
  system's own ageing at the freeze is the reference report for the first collection cycle, and the runbook says to
  print it.
- **A legacy credit open item cannot be allocated against an invoice.** It is a settled-side document, and
  `allocateSettlement` takes only a receipt, a payment or a credit note as the settlement (4A's S2); how a refund or an
  advance is set off is ADR 0047's open question 5. It stays open on the party's ageing until that is decided.
- **Open items load in the base currency at rate 1.** The plan names no currency column on `BILLS` and hazard 3 forbids
  inventing one; a foreign-currency open item is loaded at its base figure, and its later settlement in the foreign
  currency realises the whole difference. OD-17's scoping is where a currency column would be found.
- The imported document does **not** carry its original lines, tax or items. A user who needs the original looks it up
  by `legacy_ref` in the archived legacy system; the runbook says to keep a read-only copy. This is a deliberate limit
  of a cut-over, not an omission.
- `3900`'s balance after the whole load is the sum of every explained difference — the legacy trial balance's
  imbalance, less the legacy inventory-control net against the recomputed valuation (Task 6), less the legacy AR/AP
  controls against Σ open items (this task), less the excluded accounts — the figure OD-25 is about and Task 10's
  reconciliation explains.

## Questions for the owner

1. Decision 6 ages every open item from the cut-over date. Should the legacy due date be carried — which needs a
   column (`document.due_date`, or a pinned payment term per item), a data-model change — so the first month's ageing
   reads as the legacy one did?
2. Decision 5 refuses the whole run on one item whose kind disagrees with its party's control account. Is that the
   remedy the owner wants for a legacy receivable held against a supplier (or the reverse), or should such an item be
   reported and left on `3900` for the reconciliation to explain?
3. A legacy credit open item (decision 3) stays open until a refund rule exists (ADR 0047 question 5). Should the
   cut-over instead net a party's credits against its debits, so no stranded credit opens?
