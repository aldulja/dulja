# OD-10 — Till cash lifecycle (paid-outs, safe drops, daily banking)

- Item: **OD-10** (Plan Contracts §2.12; spec:1063, 1354, 2406, 2479), which also discharges **OD-05** for slice 6D's one ⚠️ row (spec:1063)
- Gates: 6D Tasks 9, 10 and 11 (`docs/superpowers/plans/2026-09-05-dulja-phase-6d-shifts-till-cash.md`)
- Decision: **yes — build all three** (paid-outs, safe drops, daily banking) in POS v1
- Recorded: 2026-11-04, from the owner's answers in a Claude Code session on branch `claude/laughing-gauss-0k185d`. The owner chose each answer from a short list; every answer below is the option the session recommended.

## The four facts 6D Task 9 asks for

1. **Who may pay cash out of the drawer.** A cashier may, up to the branch's `branch_pos_policy.max_paid_out_amount`; above it, a **different** principal holding `pos.ticket.override` must authorise it. A branch whose `paid_out_allowed` is false (or which has no policy row) permits no paid-out at all. Both settings are the branch's, set in the back office.
2. **Safe drops are routine.** A cashier drops cash into the safe on their own authority (`pos.shift.own`), with no supervisor and no limit. A drop lowers the cash at risk in the drawer.
3. **Daily banking comes from either place, and the cashier picks.** The till offers both: from the safe (clears `1130` Cash in transit, where the drops sit) or straight from the drawer (`1110`). The message's `fromSafe` carries the choice.
4. **A paid-out needs a supporting reference.** The till refuses a paid-out without a reference (a supplier receipt or voucher number), and the server refuses one whose `reference` is empty. Safe drops and bankings may carry a reference (a bag number, a deposit slip) but do not require one.

## Not decided here

The amounts. `max_paid_out_amount` and `paid_out_allowed` are each branch's settings; this record fixes who may act, not how much.

## The till screen (OD-24 for this one form)

No plan specified a till screen for these three movements, and AGENTS.md forbids inventing a UI workflow. The
owner approved, in the same session on 2026-11-04, a **Cash movement** form on the till's existing Shift view
(F10), beside the void and close-shift forms and built the same way: a movement selector (paid-out, safe drop,
banking from the safe, banking from the drawer), the amount, the reference (required for a paid-out), and a
supervisor's employee number and PIN shown only for a paid-out. Legacy parity is not claimed; the
form can change when OD-24 screenshots arrive.
