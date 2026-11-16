# Remaining costing failures — approved remediation

The two failures were reproduced on `main` at `66ec03c` using the repository's Node-hosted Vitest suite
and PostgreSQL 18 Testcontainers. Eleven cases ran: nine passed and the two known costing cases failed.

| Failure | Observed result | Proposed decision |
| --- | --- | --- |
| Acceptance test 7, back-dated purchase | Valuation `167.0589`; inventory ledger `167.0570` | Store each receipt layer's exact value and price covered issues from the decrease in that exact layer valuation. Rounded unit costs remain display figures. |
| SAH-004, reverse the second purchase | Remaining quantity `100.000000`; unit cost `15.0000` rather than `10.0000` | A full reversal of an untouched purchase cancels that purchase's own quantity and original value. Refuse a full reversal if its source layer has already been consumed or is awaiting recost. Ordinary returns retain their policy. |

The concrete proposals are appended to
[ADR 0039](../adr/0039-stock-valuation-is-an-as-of-snapshot-and-cost-layer-joins-the-projection-registry.md#accepted-amendment--conserve-exact-layer-value-2026-10-01)
and
[ADR 0038](../adr/0038-a-recost-is-bounded-restartable-and-visible.md#accepted-amendment--reverse-an-untouched-purchase-at-its-original-cost-2026-10-01).
They include the formulas, refusal behavior, historical reads, replay requirements, migration/contract
discipline, and verification scope. The owner approved these two concrete proposals on 2026-10-01 with “fix them please”; both rules are implemented on `fix/costing-value-and-reversals`. They do not ratify the
earlier ADRs' unrelated open decisions or declare any phase complete.

## Approval record

`AGENTS.md` requires: “Decisions affecting money semantics, security, the data model, or the sync protocol
require an ADR proposal and owner approval before implementation.” Plan 3B's execution handoff explicitly
says to stop and raise the exact-value discrepancy, and identifies ADR 0039 as the home of its proposal.

The exact-value rule changes fourth-decimal issue amounts. The reversal rule adds a refusal for a purchase
that has already contributed to an issue; choosing automatic cancellation and repricing instead would be
a different accounting rule. A general instruction to fix the failures does not specify these choices.

## Implementation and verification

The frozen contracts and migration register are amended, both rules have regression coverage, and the acceptance `tests` workspace joins CI’s Linux database matrix. Verification checks stock and ledger conservation through posting, replay and reversals. Golden figures remain unchanged.


The implementation adds migration 0118, exact original values to the domain and database layers, one-rounding remaining valuation, and a source-specific cancellation descriptor resolved from immutable receipt movements. Replay uses the same descriptor, including reversal/reinstatement chains. Consumed, mismatched and pending sources are refused atomically. Chronological guards refuse cancellation before its receipt and newly back-dated issues crossing an existing cancellation. Ordinary issue reversals, counts and transfers keep their rules.

The migration discovers tenant/actor contexts using the existing `app_auth` membership resolver privilege, restores the migration role and transaction context, and backfills only under forced tenant RLS. A global NOT NULL validation fails closed for any undiscoverable rows. It preserves immutable movements/ledger entries and already-booked issue values, invalidates derived consumptions and marks existing issues for the bounded replay. On an installation containing movements, enqueue the existing `inventory.cost.replay` job for each affected company and finish replay before allowing purchase reversals; this task performs no external migration or deployment. Migration rollback retains pending replay state rather than forgetting a correction.

Verification added pure regression cases and PostgreSQL cases covering AVCO/FIFO, non-divisible values, depletion, as-of history, reversal chains, replay idempotence, pending/consumed/mismatching source refusals, atomic rollback, concurrent reversal/issue, and populated multi-tenant down/up backfill. Both original regressions now pass. The complete acceptance workspace is added to CI’s Linux database matrix with no quarantine.

Eight existing test expectations deliberately change under the approved exact-value rule:

| Fixture | Before | Exact-value answer | Reason |
| --- | --- | --- | --- |
| Partially covered shortfall replay | `631.1500`; corrections `6.1500`, `2.8500` | `631.1476`; corrections `6.1476`, `2.8524` | Covered receipts total exactly `616.0000`; only the uncovered three units use rounded average `5.0492`, giving `15.1476`. |
| Concurrent replay issue of five | `26.6665` | `26.6667` | Exact remaining layer total decreases from `138.6667` to `112.0000`. |
| Six-receipt queue replay | `120.0000` | `119.9999` | The micro-unit largest-remainder split leaves `1680.0001` of the original `1800.0000` on the layers. |
| Transfer shortfall after accumulated fractional consumptions | `10.0000` | `10.0001` | Arrived value stays `40.0000`; the exact corridor issue is `50.0001`, so the variance receives the residue. |
| Full transfer arrival after fractional consumptions | `25.0000` | `24.9999` | Both equal-quantity legs preserve the complete exact corridor issue value. |
| Dispatch reversal after fractional corridor consumptions | `5.0000` on each leg | `5.0001` on each leg | The marginal corridor issue costs `5.0001`; its equal-quantity receipt and both ledger legs retain that value. |
| Later transfer shortfall | `10.0000` | `10.0002` | Arrived value stays `40.0000`; the exact corridor issue is `50.0002`. |
| April’s second replay adjustment | `166.6700` | `166.6666` | The covered issue reduces exact layer value by `1666.6666`, compared with the previously booked `1500.0000`. |

No golden fixture was regenerated. Acceptance test 7’s formerly unreachable final assertion also required a scope correction: one delivery’s cost cannot equal its `1250` balance plus every issue’s combined `5000` adjustment. It now attributes the delivery’s booked correction separately and additionally asserts that all issue corrections reconcile exactly to the COST_ADJUSTMENT ledger. This leaves the outstanding ADR question about choosing adjustment accounts for write-offs and transfers unchanged.

The source-status and full-return-chain fixtures now consume an older receipt under FIFO. Their target receipt stays wholly untouched, satisfying the approved full-cancellation rule while preserving the original assertions that a reinstated return cannot claim a reversed source. They retain the same quantity and rollback assertions; consumed-source refusal is covered separately.


## Completed verification before publishing

- Acceptance workspace: 503 passed, five existing planned skips; both original failing cases pass.
- New PostgreSQL safety/history/replay/migration cases: 11 passed. The three-file follow-up for transfers, return chains and those cases passes all 41 checks; SAH-017 passes all 10 cases separately.
- New exact-value schema constraints: all 13 layer/schema cases pass, including required and nonnegative value checks.
- Domain suite: 227 passed. Golden/lint suites: 75 passed, with no golden fixture changes; the tightened migration DML allowance also passes the lint suite separately.
- Typecheck: all 12 workspaces. Lint, all 11 custom rules, formatting, all four contract gates, and unchanged regenerated OpenAPI pass.
- Backoffice and desktop builds pass. Browser acceptance: 10 passed using the existing cloud Chromium configuration.

The PR’s CI and final validation summary record the completed full database/API runs; the targeted checks above establish both fixes before publishing. This work does not close the unrelated phase/owner gates recorded in `AGENTS.md`.

The document-header rollback test derives the migration tail from `listApplied()` while still checking that 0117’s trigger and function disappear and return. Its previous single-number assumption stopped being valid when 0118 was added.

The dispatch-reversal control exposed a receipt-pricing defect: copied `line.cost` took priority over the same-line issue and lost its fourth-decimal residue. Copied cost is now limited to one-leg receipts; a transfer receipt, including a reversal, retains the computed issue value. The control asserts both movement values and ledger legs, and valuation/ledger tie-out covers the retained residue.
