# 0064 — The till cash lifecycle rides the sync protocol, and a banking is cash in transit

- Status: **Proposed** — money semantics and the sync protocol both (spec:95). Implemented on the owner's
  OD-10 answer of 2026-11-04 (`docs/owner/od-10/decision.md`), ahead of approval of this record, as ADRs
  0054–0063 were.
- Date: 2026-11-04 (the plan's text is dated 2026-09-08)
- Slice: 6D · Tasks 9–11 · Gated on OD-10
- Amends: contracts §4.10.1 (a fourth message array, amendment A13), §4.10.6 (`outbox.kind`), §4.15 (`5130`,
  and what `1130` carries — amendment A14), §4.6.1 and §3.5.3 (`till_banking_link` — amendment A16)

## Context

A shop pays a supplier out of the drawer, drops surplus notes into the safe, and banks the day's takings.
Each is a movement of physical cash that must reach the ledger, and each happens at a till that may be
offline for hours. The owner answered OD-10 **yes** with four facts:

1. a cashier may pay out up to the branch's `max_paid_out_amount`; above it a **different** principal holding
   `pos.ticket.override` must authorise it, and a branch with `paid_out_allowed = false` permits none;
2. a safe drop is routine — the cashier's own act, no supervisor, no limit;
3. a banking may come from the safe or straight from the drawer, and the cashier picks;
4. a paid-out needs a reference (the supplier receipt or voucher number).

Two routes were available.

**(a) Back-office API routes** — `POST …/documents/till-paid-outs` and friends, gated on a permission.
**(b) A fourth array on the sync batch** — the till records the event in its outbox and it drains with the
tickets.

## Decision

**(b).** `TicketBatch` gains `cashEvents?: TillCashMsg[]` and `BatchResult` gains `cashEventResults`, acked by
the message's `clientRef`. The till's `outbox.kind` admits `'cash_event'`. `TILL_PAID_OUT`, `TILL_SAFE_DROP`
and `TILL_BANKING` post through `buildTillDocument` inside `applyBatch`, in the batch order **opens →
tickets → till events → cash events → closes**, each message in its own savepoint.

| Kind | Document | Debit | Credit |
|---|---|---|---|
| `paid_out` | `TILL_PAID_OUT` (series `TPO-<terminal>`) | `5130` Till paid out (BRANCH) | `1110` Cash in till |
| `safe_drop` | `TILL_SAFE_DROP` (`TSD-<terminal>`) | `1130` Cash in transit | `1110` |
| `banking`, `fromSafe` | `TILL_BANKING` (`TBK-<terminal>`) | `1100` Bank | `1130` |
| `banking`, from the drawer | `TILL_BANKING` | `1100` Bank | `1110` |

Every kind needs a live cashier of the terminal's branch holding `pos.shift.own`. Only a paid-out is limited
and needs a reference (facts 1 and 4); a paid-out authorised above the limit records the supervisor's
`pos.ticket.override` as a `document_event` override on the paid-out, so 2B's `assert_override_authorised`
re-checks the code at the document's branch and refuses the cashier or the terminal as their own approver
— the guard a void already meets. A safe drop or banking carrying a supervisor, a `fromSafe` on anything but
a banking, and a paid-out approval sent within the limit are refused as malformed.

`app.till_banking_link` (migration 0071) records, per banking document, its shift, bank account (`1100`),
value date (the document's `effective_date`), amount, currency, reference and `from_safe`. 6D registers one
`till_banking` `Reconcilable` source over it (`packages/db/src/ar-ap/reconciliation-till.ts`) and edits no
file of 4B's.

## Consequences

- **(a) was not merely worse, it was impossible.** §4.14 fixes all three types' `approval.post` at
  `pos.sync.push`, and R8 (spec:2179) keeps a human out of the `pos_terminal` role — so a back-office route
  could create the document and could not post it.
- **Every cash event is inside the shift's expectation with no formula change.** ADR 0063 reads the `1110`
  leg, so a paid-out, a drop or a drawer banking reduces `expected_cash` the moment its document posts; a
  banking from the safe never touches `1110`. The Z-report's `cashControl` section lists each type's net
  effect on the drawer, and the cash tender line stays the sales alone.
- **`TILL_BANKING` always debits `1100`**, so the banking's bank leg is on the statement's bank account and
  test 39's "the reconciled balance equals the bank account's ledger balance" can hold.
- **`1130` sits between the drawer and the bank** and is cleared by the banking from the safe, not by a job.
  A safe drop that is never banked leaves a balance on `1130` — the correct statement of a physical fact.
- **The batch is not atomic across kinds and must not be.** A paid-out refused for exceeding the branch limit
  does not roll back the sales beside it. A refused cash event writes no `needs_attention` row (amendment
  A10): it answers `rejected` and stays pending in the till's outbox.
- **The protocol edits are additive and versionless.** `cashEvents` is optional on the request and the till
  sends it only when it has a cash event, so a till with none emits the three-array batch an older server
  accepts; `cashEventResults` is always in the response and optional to the till's reader.
- **`TILL_PAID_OUT` is `outbound`, as §4.14 registers it**, so `app.policy_extends_credit` — a property of the
  policy alone — answers true for it. That never acts: a paid-out carries no party, and both
  `app.assert_credit_available()` and a party's exposure key on `document.party_id`.
- **A cash event is not reversible from the till.** Its `reversal.allowed` is `true` for a back-office
  correction, but the mirror posts under `pos.sync.push` like the original, so today a mistaken paid-out is
  corrected by a JOURNAL. This is the same gap ADR 0063's over/short has.

## Rejected

- **A single `TILL_CASH` type with a `kind` field.** Three types buy three numbering series, three policy
  rules and three §4.14 rows a report can name; one type would put the account choice in a policy `when` on
  a custom field.
- **Netting the day's cash events into the close.** It would lose the individual events, and spec:1354's
  point is that a drawer's history is auditable.
- **Listing bankings from the ledger leg alone.** The leg has no shift, and an unreconciled banking that
  cannot say which drawer it came from is unactionable at a shop (amendment A16).

## Amendment — 2026-11-07: a cash event names the shift's own cashier

- Status: **Proposed**, like the record it amends. A security fix implemented ahead of approval.
- Found by: the Phase 7 code review (2026-11-06), recorded in AGENTS.md's known defects and not fixed on
  that branch.

**The defect.** "Every kind needs a live cashier of the terminal's branch holding `pos.shift.own`" was all
`verifyCashEvent` checked. A till could send a paid-out, safe drop or banking on shift S, opened by cashier A,
naming cashier B of the same branch: it posted against A's drawer, attributed to B. A's over/short absorbed
it, and B's paid-out limit applied to a drawer B never held. The till let it happen too — B could sign in on
the till where A's shift was open and record a cash movement, which selling already refused.

**The decision.** A cash event's `cashierPrincipalId` must equal the shift's `opened_principal_id`, on every
kind. Otherwise the server refuses it `ERR_RBAC_FORBIDDEN`, checked after the live-cashier check and before
any kind-specific rule. The refusal is the ordinary recoverable one: the event answers `rejected`, writes no
`needs_attention` row (as above), stays pending in the till's outbox with the server's error, and becomes
final only once the shift's close is acknowledged. The till refuses the same movement before writing
anything (`recordCashMovement`, the same `ERR_RBAC_FORBIDDEN` a sale on another cashier's shift meets).

**What does not change.** OD-10 fact 1's approver is a different principal by design: `supervisorPrincipalId`
is checked on its own (a live cashier holding `pos.ticket.override`, never the cashier), and nothing here
asks the supervisor to own the shift. Closing another cashier's shift stays `pos.shift.close_any`'s (6D);
there is no cash-event equivalent, so a manager who must move cash out of an absent cashier's drawer closes
the shift first.

**Proof.** `tests/invariants/pos-till-cash.test.ts` ("a cash event names the shift's own cashier") sends each
kind naming a second live branch cashier who holds `pos.shift.own` and asserts `ERR_RBAC_FORBIDDEN` with no
document, then closes the shift at the owner's own figure with no over/short; on the code before the fix
all four cases fail (the three events posted, and the close was 30.0000 over). `apps/pos/test/register.test.ts`
("another cashier signed in on this till cannot move cash…") fails before the till guard and passes after.
