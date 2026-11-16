# ADR 0056 — Up-sync applies each ticket in a savepoint and records refusals

- Status: **Proposed** (security, data-model or sync-protocol decisions require owner approval before implementation)
- Date: 2026-10-07
- Slice: 6A
- Source: [2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md](../superpowers/plans/2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md)
- Formal ADR acceptance: pending. Implementation of the presented Phase 6 defaults is authorized by the renewed whole-phase instruction; see the decision bundle.

## Context

spec:1303–1305 requires safe batch retries, good tickets surviving a bad neighbour, and a retained payload for every refused ticket. SAH-051's shared numbering race is avoided by till-created UUIDv7 `client_ref` values. The authenticated terminal supplies the actor; the server must independently verify the cashier's current authority rather than accept a stale offline snapshot.

## Decision

One outer transaction covers the batch and its catalogue-revision read, with a savepoint per ticket. A transaction per ticket loses the batch boundary; a single transaction without savepoints loses all good tickets when one fails. Tickets apply in array order. Concurrent applies for one terminal serialize on `sync-batch:<terminal id>`.

Deduplication on `(company_id, client_ref)` reads the existing ticket first and relies on the named unique constraint second to cover the race. A duplicate reports the existing document without posting again or adding a needs-attention row.

Required cashier permission codes derive from the ticket's content (`requiredCodes`): creating a ticket, non-zero discount, void event or blind return each requires its corresponding code. Under 6C's strict authority reconciliation, overrides lift limits only and cannot supply a missing base code. The supervisor must hold `pos.ticket.override` with a live cashier credential at the terminal's company/branch; 2B's `assert_override_authorised` still controls the recorded override.

Stock insufficiency, an unauthorized override, every posting error and a tax disagreement are refusals, never silent corrections. Tax compares domain `Money` values, so scale formatting alone cannot cause a disagreement. The full refused payload and reason are upserted into needs-attention outside the rolled-back savepoint, keyed by company and client ref. Updating an attempt never clears its previous resolution stamp.

The proposed `classify()` table is ordered as follows:

| Failure | Outcome/code | Handling |
|---|---|---|
| `SyncError` | Its own code and detail | Refusal |
| `PostingError` | Its own code and message | Refusal |
| SQLSTATE `23505` on `document_company_id_client_ref_key` | `DUPLICATE` | Read existing document; no rejection row |
| Other SQLSTATE `23505` | `ERR_CONFLICT_UNIQUE` | Refusal, with constraint name when available |
| SQLSTATE `23503` | `ERR_CONFLICT_REFERENCE` | Refusal |
| SQLSTATE `42501` | `ERR_RLS_DENIED` | Refusal |
| SQLSTATE `23514` whose message matches `ERR_<CODE>: detail` | Parsed guard code and detail | Refusal |
| Any other failure, including an unrecognized CHECK message | `ERR_SYNC_TICKET_REJECTED` | Named default refusal with retained payload |

Before its owning slice implements a message kind, that message is refused with `ERR_SYNC_MESSAGE_UNSUPPORTED`; it is never dropped. Per-ticket and per-message codes are outcomes inside `200 BatchResult`, not HTTP rejection statuses in 6A.

## Consequences

- A bad ticket cannot erase its good neighbours, and retries do not post a sale twice.
- Array order matters: stock consumed by an earlier accepted ticket can cause a later ticket to be refused. An earlier duplicate is not posted again and does not consume additional stock; its original sale remains part of stock history.
- A stale tax catalogue causes refusal until the till re-pulls and re-prices; the server never substitutes a price the shop did not choose.
- A previously resolved ticket that fails again retains its resolution and receives the fresh payload/reason in the resolved list. An attempt-history table would require a separate data-model proposal.
- Unknown failures remain recoverable refusals rather than silently lost tickets.

## What we are asking

Approve this batch/savepoint boundary, read-first/constraint-second deduplication, refusal/classification table and content-derived authority checks, including stale-tax refusal and retaining prior needs-attention resolution stamps on repeated failures?

## Phase 5 integration correction — account sales and returns (2026-10-07)

Spec §3.7.6 requires account sales within credit limits. The supplied plan rejected zero-tender tickets and lacked a receivable settlement rule. Implement a customer-required zero-tender path without changing the wire shape: the server creates an existing `account` line with zero amount/tax/gross and a nonnegative debit or credit equal to the signed item-gross magnitude. Existing `line.debit`/`line.credit` policy selectors resolve the customer’s receivable account through the single posting service. Its zero amount prevents persist-time tax from doubling document totals. Referenced account returns preserve source customer and remaining refundable facts.

For effective policy shapes containing tender rules, migration 0061 changes `document_base_total` to sum line-rounded non-tender gross less line-rounded tenders. Paid customer tickets extend no credit. Positive account exposure retains the existing locked-party hold, limit, amount-bound override and pending-plus-posted exposure controls; nonpositive tender-policy exposure does not extend credit. Policies without tender rules retain their behavior; rollback restores the prior functions. Prove cash customer/hold behavior, missing-customer refusal, account hold/limit/concurrency and AR/ledger tie-outs.

POS item rules explicitly select quantity signs. Return cost credits COGS and debits inventory at the cost magnitude; signed revenue/tax use the existing evaluator. This applies ADR 0045’s explicit-sign exception and preserves the posting service’s negative-stock-line control. These are concrete corrections needed for the authorized Phase 6 implementation; formal ADR status remains Proposed.

**A referenced return settles the way its sale did (2026-10-22, plan audit; owner direction: best practice; proposed).** The correction above lets a referenced account return keep its source customer but did not say how a return of an account sale is paid, and the till paid it out of the drawer: a return copied the original's customer, then `tender()` demanded tenders, so the customer kept both the refund and the debt. Each sale is settled one way — an account sale has no tender, and a paid sale's tenders cover its payable — so the rule is "refund to the original settlement", as POS practice refunds to the original tender. **At the till**, `returnTicket` completes a referenced return of an account sale (a completed sale with a customer and no `ticket_tender` row) in its own transaction with `tenders: []`, as `accountSale` completes a sale; the register answers `account: true` and the renderer skips the payment step for the receipt; `tender()` refuses to pay one out. Because the till chose that settlement, it says so in English and Arabic: the receipt, on screen and printed, lists "Refunded to customer account" with the amount where a tender would be (an account sale's reads "Charged to customer account"; `ReceiptPayload.onAccount`), and the screen tells the cashier, once the original is loaded and again beside the receipt, that nothing is paid out of the drawer (not printed). A return of a paid sale, the customer's included, is tendered exactly as before, and a blind return is unchanged. **At the server**, `prepareReturns` refuses with `ERR_VALIDATION_FAILED` (a recoverable needs-attention refusal) a zero-tender return whose posted source has `tender` lines and a tendered return whose posted source has an `account` line; an accepted zero-tender return credits `party.receivable_account` through the existing `account` settlement line and the AR tie-out holds (`apps/api/test/routes/sync/account-returns.test.ts`, `apps/pos/test/returns.test.ts`). The wire and the posting policy are unchanged. A customer who has since paid the account receives an account credit rather than cash; the back office settles it (with the recorded limit that a refund cannot yet post, ADR 0047 open question 5).

## Posting jobs integration — 2026-10-08

The merged posting service requires a `JobClient` for backdated stock replay and projection work. `TerminalApplyContext` carries optional server-only `jobs?: JobClient`, supplied by the API or apply worker and forwarded to `postDocument`. The four-argument apply signature and all wire messages stay fixed. Tests use the registered recording job client. This preserves the existing transactional enqueue path and makes delayed offline tickets use the same posting behavior as ordinary documents.

POS return conversion supplies a nonnegative base-currency line cost to the existing receipt-value branch. A referenced return uses the verified source sale's carrying cost, source-line identity and remaining quantities; returning the full quantity conserves the source cost. Partial returns carry bounded `returns` links and do not claim a full reversal. A blind return derives carrying cost from valid server cost-layer facts under the existing stock locks, refusing when those facts cannot establish a cost. The wire supplies no trusted cost. This extends the registered conversion-writer list and preserves the single inventory and ledger posting path.

Referenced returns must still work after their source tax code is archived or expires. The persist-time tax helper gains an optional server-only verified `historicalSourceId`, using the existing historical-code lookup constrained by immutable tax transactions on a same-company posted source. Posting snapshot resolution also reads the single posted source of bounded `returns` links when no reversal header exists. Multiple ambiguous sources are refused. New sales and blind returns retain active/effective-code checks. The existing regime check and sole tax-fact writer stay in place; regressions prove historical refund conservation and reject unrelated historical codes.

Partial historical refunds derive proportional net/gross/tax shares and the completing residue from immutable source facts and trusted quantity-bounded return history, following the existing credit-note treatment. Independently rounding each inclusive quotient can exceed the original tax by a fourth decimal. The historical branch validates source identity, selected code, links/history and quantities, compares the wire amounts with the server-derived facts, and conserves the original gross, net, tax and cost after a full return. New sales and blind returns keep the unchanged tax-engine path.

## Full reversal, quantity residues and collisions — 2026-10-08

A full POS reversal needs the policy-required client ref and terminal/shift provenance. When the original and pinned reversal target are both POS_TICKET, the existing reversal service mints a fresh UUIDv7 mirror client ref and copies terminal/shift IDs. The original ref still deduplicates to the original, even after reversal. Ordinary-document reversal behavior, line mirroring and partial-return guards are unchanged.

Referenced refund shares use immutable source gross/net/tax facts rather than a freshly rounded price identity. Gross, discount, net/tax and carrying-cost shares use differences between rounded cumulative source budgets and amounts already returned, with the completing return taking the exact residue. Gross and cost magnitudes stay nonnegative and bounded. Discount shares preserve the original signed cumulative budget, including a cash-rounding surcharge represented by a negative discount. Net/tax are derived consistently with gross = net + tax; a fourth-decimal historical component residue may have the opposite sign. This avoids exhausting tiny source values through repeated independent rounding. Both entered and converted base quantities are bounded, using server-pinned conversion facts. Ambiguous nonintegral conversion residues are refused without changing the existing quantity trigger; a full return remains possible where its converted quantity exactly matches the source. Sales and blind returns keep the fresh gross identity.

Quick-create code collisions with a different UUID are refused because BatchResult provides no customer-ID remapping. Same-UUID retries remain scoped to the verified company and active customer. A needs-attention row is updated only by its authenticated terminal owner; a foreign-terminal collision preserves the original payload and produces a recoverable refusal. A queue-write failure is isolated so good neighboring tickets remain committed. These corrections implement the authorized identity, conservation and recoverability guarantees without a new ledger writer or a new history table.

A referenced historical source must also have no `reverses_document_id`: a positive mirror of a reversed return is a correction rather than an independent original sale. Refunding that mirror as well as the released original-sale budget would return the same units twice. Apply and historical lookup share this restriction.


## Referenced discount restoration — 2026-10-09

Referenced returns restore server-verified cumulative source discounts, including original cash-rounding treatment. They require return authority without requiring new manual-discount authority or applying fresh discount limits. Fresh sales and blind returns keep those checks. Source identity, quantities and exact refundable amounts remain mandatory; forged discounts are refused. The original treatment is preserved even after a branch increment changes; new rounding evidence on a referenced refund is refused so immutable source shares cannot be adjusted again.


The registry’s status 200 for `ERR_SYNC_TICKET_REJECTED` and `ERR_SYNC_MESSAGE_UNSUPPORTED` describes refusal wrappers inside a batch response. If either is accidentally thrown as a standalone error, the production Problem mapper returns 422. A failed operation cannot surface as a successful Problem response; a regression routes every registry code through that mapper.

## Phase 6C strict override authority reconciliation

Overrides lift configured limits only. They cannot replace missing cashier
base discount, void or blind-return permission. The supervisor must be a different
current human principal holding `pos.ticket.override` at the actual company and
credential branch with a live, unrevoked cashier credential there. Existing 2B
recording and trigger checks remain in force. Stale or revoked offline credentials
cannot authorize overrides; source-verified historical discount restoration keeps
its existing exception. Formal ADR status remains Proposed.

## Till-side refusal finality — PR 12 review (2026-10-22, proposed)

The till (6B's `SqliteSyncStore`) previously held a shift `close` until every ticket and till event of that
shift was acknowledged. A refused one never is, so a deterministic refusal (a stale tax figure, an exceeded
limit) kept the close on the till for ever, and the server's shift stayed open with no expected cash,
over/short or Z-report. Making every refusal final at once, the first repair, broke the recoverable refusals
this ADR keeps: the server can cure a refusal with no change to the payload — a shift open refused for a lapsed
grant, which refuses every ticket of that shift through `assertShiftKnown`; a fiscal period not yet open; a
colliding quick-create customer code — and such a sale was then never re-sent and never posted. The rule is:

1. A `rejected` ticket or till event stays unacknowledged with its attempt count and reason (spec:1305;
   §4.10.5's "never acked on silence" is unchanged) and is sent again on later drains while its shift is open.
2. It does not hold its shift's close. The close waits only for the shift's tickets and till events that have
   **no answer yet** — never sent, in flight or offline — because the server refuses anything naming a closed
   shift and a close that overtook one would strand it.
3. The refused rows travel beside the close. `applyBatch` applies tickets and till events before closes, so a
   refusal cured in the meantime posts before ADR 0063 derives the drawer, and a deterministic one is refused
   once more without blocking anything.
4. Once the server acknowledges the close, every refused ticket and till event of that shift is **final**: the
   till never sends it again (the local `outbox_refused` view). The server would refuse it for naming a closed
   shift and, for a ticket, overwrite the reason its needs-attention row holds. The ticket was never posted, so
   ADR 0063's expectation leaves it out and its cash shows in the shift's over/short. A refused shift message is
   never final (6D amendment A10).
5. Rows with no answer travel before refused tickets and till events, so a batch-sized run of refusals cannot
   stop `drainOutbox` (which ends on a pass with no progress) before the close leaves.
6. A final refusal is not pending work: the re-enrolment gate and the till's local credit exposure leave it
   out, as they leave out a quick-created customer only such a ticket carried. The till's status line shows a
   translated sync-attention notice while any refusal stands (the count and newest reason travel in the status
   object's `lastError`, from `refusalNotice`); a refused till event has no server queue (A10), so that is its
   only record.

The wire, `applyBatch` and the server's shift close are unchanged. A ticket refused earlier and accepted on a later re-send closes its open needs-attention row in the same
savepoint, with a note naming the posted number, so the queue holds only what still needs a person. A void
refused for good reversed nothing, so it stops reserving its original against a return. Two residuals are
accepted rather than solved here: no server path re-applies a quarantined ticket (`resolveNeedsAttention`
records a resolution only), so a final refusal is corrected in the back office; and when the answer to the close's own batch is lost, the
re-send carries the refused rows after the server has closed the shift, and their needs-attention reason is
replaced by the closed-shift refusal (the payload is not). A till whose backlog exceeds one batch may also send
the close before a refused row of its shift fits beside it. That row was re-sent on each earlier drain the till
made, but a cure the server made while the till was offline is never tried: the row becomes final with its
last refusal and is corrected in the back office.

## Over-size batch re-send — PR 12 review (2026-10-22, proposed)

A batch over `SYNC_BATCH_SYNC_LIMIT` is queued as `pos.sync.apply` keyed by its `batchId` and answered `202`
(Plan Contracts §4.10.4). That queue is `standard`, so the keyed send holds a 24-hour pg-boss slot that a job
keeps in every state but `cancelled`, and a re-send of the same batch under a fresh `Idempotency-Key` was
answered 500 for the rest of the UTC day. The route now answers such a re-send with the job that holds the
slot and queues nothing (`enqueueSyncBatch`, `packages/db/src/sync/batch-queue.ts`). Only the same batch gets
that answer: the holder's tenant, terminal and batch must equal the request's, compared in SQL, and the
holder's id and state are returned only when they do, so a job id never reaches another tenant's request;
any other batch under the `batchId` is refused `ERR_VALIDATION_FAILED`, so a 202 never reports tickets that
no job carries. The answer is `202` `queued` with `Retry-After: 5` only while pg-boss may still run the job
(`created`, `retry`, `active`). Once it has `completed`, or `failed` with its retries spent, the re-send is
refused `ERR_VALIDATION_FAILED`, naming the job, how it ended and the remedy: re-send the tickets in batches
of at most `SYNC_BATCH_SYNC_LIMIT`, which answer per ticket — `duplicate` for what the job applied, applied
now for what a failed job did not. A `202` there would keep the client polling until the slot lapses at UTC
midnight with no answer ever coming, and would hide a failed job whose tickets were never applied (the second
review of this fix; owner direction 2026-10-22: best practice). The till sends no batch over the limit.
Approve the refusal of a reused `batchId` and of a re-send whose job has finished?
