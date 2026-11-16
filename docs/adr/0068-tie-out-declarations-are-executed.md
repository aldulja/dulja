# 0068 — A report's `tieOut` declaration is executed, not documentation

- Status: **Proposed** — a test-tier decision, implemented ahead of approval as ADRs 0065–0067 were.
- Date: 2026-11-05 (the plan's text is dated 2026-09-05)
- Slice: 7B · Task 1
- Amends: contracts §4.11.1 (`tieOut` made executable — 7B amendment A5, round 14) and §4.17.1 (the harness
  row — 7B amendment A9)

## Context

Phase 7's definition of done is _"A user clones and edits a report without a release; every report's numbers
tie to the ledger"_ (spec:2293). The second clause is the one that fails silently. `ReportDefinition` already
carries `tieOut: { kind; account?; projection? }` (contracts §4.11.1), described as "the tie-to-ledger test each
core report declares" — but a declaration nothing executes is a comment, and the legacy system's own reporting
failure (LEGACY-069, LEGACY-070, LEGACY-076) was a catalogue of queries nobody could reconcile against the ledger.
Twenty-two definitions land in 7B and more in 7C and 8D. Written per report, bespoke tie-out tests would drift:
some would tie against a hand-written aggregate, one would compare a report with itself, and some would be
forgotten.

## Decision

**One harness executes the declaration.** `tests/invariants/support/reports.ts` reads a definition off disk,
runs it through 7A's `rowsForDefinition` — the same row provider the `reporting.render` handler uses, so the
tie-out is a claim about the query that renders and not about a parallel one — and turns `tieOut` into an
assertion against an independent path: a direct `ledger_entry` sum for `ledger_sum`, the projection's own
stored rows (or `valuationAsOf`, the one valuation implementation) for `projection`, and a caller-supplied row
witness for `none`. 7B's roll-up, `tests/invariants/report-tie-out.test.ts`, enumerates the catalogue and fails
naming the code when a definition has no case, so a report cannot be added to the pack without one.

Four rules make the assertion mean something rather than pass vacuously:

1. **The two sides are different code paths.** The report's figure is the dataset's rows aggregated with
   `Money`/`Quantity`; the other side is one SQL sum, one projection read or one witness query.
2. **The measure map is closed.** `base_debit` → `debit`, `base_credit` → `credit`, `base_balance` → `net`,
   `base_total` → `debit` (7A's column aliases), and a fourth arm, `credit_net`, for a signed measure on a
   credit-natured account. A signed field is never mapped to `credit`. A definition cannot compare debits
   against a net and pass.
3. **`none` requires a row witness.** A master-data list has no monetary total; it still has a row set, and an
   independent query must produce the same one.
4. **Nothing is computed over a partial or empty result.** `runDefinition` refuses a full page and
   `assertFieldCoverage` refuses zero rows, and checks every referenced field against the keys the query
   actually returned — the gap 7A's declared-column check (`assertDefinitionFields`) cannot see.

A `cost_layer` row's money is not a column: its `value` is the layer's stored receipt value (migration 0118).
The harness values the residue as `round(value × qty_remaining / qty_in, 4)` — the term `valuationAsOf` sums —
once, in one place, so no report definition performs arithmetic on a stored cost (LEGACY-009).

## Consequences

- Adding a core report is: write the definition, add the tie-out case, and the roll-up goes green. Forgetting
  the second step is a red build with the report's code in the message.
- `assertTieOut`'s `projection` switch is extended additively by 7C (`party_ageing`, the POS sources) and 8D
  (`employee_ytd`, `statutory_schedule`); neither edits an existing case.
- The harness pays a fixture cost: a tie-out is only as good as the rows behind it, so the shared fixture posts
  every row through the real posting service (journals, a receipt, a delivery, a transfer, an invoice, a credit
  note and a stock count) and never writes a ledger or movement row itself.
- A report whose numbers cannot tie — a list of master data — is visible as such in one place instead of being
  indistinguishable from an untested one.

## Rejected

- **A tie-out per report, hand-written.** Twenty-two files, twenty-two chances to compare a figure with itself.
- **Tie-outs as a property of the render job** (verify at run time, warn in the PDF footer). It moves a build
  failure into a production warning nobody reads, and spec:2245's SLO makes a per-render reconciliation query
  a latency problem as well.
- **Making `tieOut.kind: "none"` illegal.** Some catalogue definitions are master-data lists; forcing a monetary
  total onto a price list would invent a figure to satisfy a schema.
- **A local code→statement map in the harness.** It would prove parity against a second copy of 7A's dispatch
  and go silently wrong the day 7C adds `accounting.branch_profit_and_loss` to `STATEMENT_CODES`.
