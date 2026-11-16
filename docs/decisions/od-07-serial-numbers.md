# OD-07 — Serial numbers

- Item: **OD-07** (contracts §2.12; spec:92, 1032, 1310, 2435)
- Gates: **3A Task 13** (`app.serial_unit`, `legacy-052/056/057`) and **6A Task 14** (acceptance test 17)
- Status: **no, not in v1** — 2026-11-04
- Recorded: 2026-11-04, from the owner's answer in a Claude Code session (branch `claude/laughing-gauss-0k185d`)

## The question

Are serial numbers in scope — one unit, one serial, sold once? §3.0.3 expects not for a food distributor.

## The answer

**No.** Serials are out of v1, which is §2.12's default. Food goods carry lots and expiry dates (3A builds
those), not unit serials.

## What this means in the tree

Nothing changes. `app.serial_unit` does not exist and `packages/db/test/inventory/serial-unit.test.ts` keeps
asserting its absence; `TicketLine` has no `serials` member; `applyBatch` has no serial branch; acceptance
test 17 is not written; `legacy-052`, `legacy-056` and `legacy-057` are not created. 3A Task 13 and 6A Task 14 are
closed as dropped. `SerialUnit` stays a reserved name (Plan Contracts, Phase 10 note).

## If the answer changes later

3A's DDL is appended to migration `0029` (contracts §2.3's 3A card) and 6A Task 14 runs in its
"online mode only" form; "reserved blocks per till" needs a design task and an ADR first (6A Task 14 Step 1).
