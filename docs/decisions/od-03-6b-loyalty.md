# OD-03 — Loyalty points in POS v1

- Item: **OD-03** (contracts §2.12; spec:22, 1032, 1348, 2397)
- Gates: **6B Task 14** and nothing else
- Status: **no, deferred** — 2026-11-04
- Recorded: 2026-11-04, from the owner's answer in a Claude Code session (branch `claude/laughing-gauss-0k185d`)

## The question

Does POS v1 accrue loyalty points? §3.7.6's Pricing row asks; §3.0.3 expects not.

## The answer

**No.** Loyalty stays out of v1, which is §2.12's default and the plan's recommendation for a scheme that is
not commercially required: points owed are a ledger liability, and a liability that nobody reconciles is
worse than no scheme.

## What this means in the tree

Nothing changes. No loyalty concept exists anywhere in slice 6B or 6A: no local table, no `Ticket` field, no
permission code, no account code, no catalogue stream, no screen, no i18n key. 6B Task 14 is closed as
dropped.

## If the answer changes later

It is a slice, not a task (6B Task 14, "If the answer is yes"): a liability account (§4.15), a
`POS_TICKET` policy rule and a `Ticket.loyalty` wire field (both 6A's, §4.10.1), and a ninth catalogue
stream so the till knows a balance offline. Schedule it as its own slice after Phase 6 closes.
