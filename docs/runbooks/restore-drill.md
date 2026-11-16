# Runbook — point-in-time restore drill

**Owner:** whoever holds the Supabase organisation (OD-19). **Cadence:** quarterly, and after any change
to the backup configuration (contracts §6.1 lists test 24's re-run as quarterly). **Time budget:** one
hour, most of it waiting for the platform.

This runbook is the whole of acceptance test 24 (spec:2442) as an operator performs it. The assertions
are not retyped here: they are `tests/invariants/restore-drill.test.ts`, and the drill is green when that
file is green against the restored database.

## 0. Before you start

| You need | Where from |
|---|---|
| `DRILL_LIVE_URL` — the staging database, `app_rw` | the staging secret store; never a pooler URL (§3.11: port 5432, not 6543) |
| `DRILL_TENANT_ID`, `DRILL_ACTOR_ID`, `DRILL_COMPANY_ID`, `DRILL_PERIOD_ID` | the tenant to drill against and any principal in it: `psql "$DRILL_LIVE_URL" -Atc "select id from app.tenant limit 1"`, then `select id from app.company where tenant_id = '<tenant>'` and `select id from app.fiscal_period where company_id = '<company>' order by ends_on desc limit 1` |
| A recovery target you can name | Step 1 produces it |
| `psql`, `bun`, and this repository at the commit staging runs | your machine |

Confirm the platform can do this at all:

    psql "$DRILL_LIVE_URL" -Atc "select current_setting('wal_level', true), current_setting('archive_mode', true)"

Expected: `replica|on` (or `logical|on`). If `archive_mode` is `off`, stop — there is nothing to restore
from, and that is OD-19, not a drill failure.

## 1. Capture — what the live system reports at the recovery target

    DRILL_PHASE=capture \
    DRILL_LIVE_URL="$DRILL_LIVE_URL" \
    DRILL_TENANT_ID="$DRILL_TENANT_ID" \
    DRILL_ACTOR_ID="$DRILL_ACTOR_ID" \
    DRILL_COMPANY_ID="$DRILL_COMPANY_ID" \
    DRILL_PERIOD_ID="$DRILL_PERIOD_ID" \
    DRILL_CAPTURE_FILE=./drill-capture.json \
      bun run --cwd tests test -- invariants/restore-drill.test.ts

Expected: PASS — one test in "capture at the recovery target", the other two describes skipped — and it
prints `recovery target: …` and `live fingerprint: …`. `./drill-capture.json` now exists with
`capturedAt`, `actorId`, `fingerprint`, `postings` and `auditHeadSeq`. **`capturedAt` is the recovery
target.** Keep this file: it is the only record of what the live system reported, and the verify phase
compares against it and nothing else.

If it fails with `expected 0 to be greater than 0`, the tenant has no postings and there is nothing to
drill — pick a tenant that does.

## 2. Let the database diverge

Post at least one document on staging after `capturedAt`, through the back office or the API. Without
this the drill proves only that a restore copies bytes; with it, the restore has something to roll back
and the `divergence:` line means something.

## 3. Restore to `capturedAt`

Perform the point-in-time restore on the platform, targeting `capturedAt` from the capture file, and
note the wall-clock time you initiate it — that is `DRILL_RESTORE_STARTED_AT` and it is what the RTO
figure measures. **The exact click path is the platform's and is not written here**: it changes without
notice, and a stale click path in a runbook is worse than none. Record in the drill log below which
control you used and what it was called on the day.

When it finishes you have a restored database. Put its `app_rw` URL in `DRILL_RESTORED_URL`. If the
platform restored **in place**, `DRILL_LIVE_URL` and `DRILL_RESTORED_URL` are the same string and you
leave `DRILL_LIVE_URL` unset in Step 4 — the drill reports `divergence: skipped` and says why.

## 4. Verify

    DRILL_PHASE=verify \
    DRILL_RESTORED_URL="$DRILL_RESTORED_URL" \
    DRILL_LIVE_URL="$DRILL_LIVE_URL" \
    DRILL_CAPTURE_FILE=./drill-capture.json \
    DRILL_RESTORE_STARTED_AT="<the time you noted in Step 3, ISO 8601>" \
      bun run --cwd tests test -- invariants/restore-drill.test.ts

**Omit the `DRILL_LIVE_URL` line for an in-place restore** — there is no separate live database left to
compare against, and the drill then reports `divergence: skipped` and says why rather than guessing.

Expected: PASS — one test in "verify the restored database", the other two describes skipped — and five
lines printed:

    trial-balance-fingerprint: match
    projection-rebuild: clean
    audit-chain: verified (N rows, 0 broken links, 0 bad hashes, head seq S/S)
    divergence: restored differs from live at restore time
    recovery: rpo 0 rows lost (postings N/N) · rto HH:MM:SS · target <capturedAt>

## 5. What each failure means

| Line | Failure | What it means |
|---|---|---|
| `trial-balance-fingerprint: MISMATCH` | the restored trial balance is not the one reported at the target | either the restore landed at a different point in time, or a write raced the capture — check the `postings` figure on the last line first |
| `projection-rebuild: N MISMATCH(ES)` | `account_balance` in the restored database does not equal a rebuild from its own `ledger_entry` | the restore is internally inconsistent. This is the serious one: raise an incident, do not re-run |
| `audit-chain: BROKEN` | hashes recomputed or rows lost | if the local run is green and staging is not, the restore reloaded data with triggers attached |
| `divergence: IDENTICAL` | nothing was rolled back | Step 2 was skipped, or the recovery target was after the divergence |
| `rpo ROWS LOST` | fewer `ledger_entry` rows than at the target | genuine data loss between the target and what the platform could recover — this is the number RPO means |

## 6. Drill log

One row per drill. `RPO` and `RTO` are **measured**, not quoted; ADR 0025 states the targets they are
measured against and records that those targets are a proposal awaiting the owner.

| Date | Target (`capturedAt`) | Restore control used | RPO measured | RTO measured | Verdict | Notes |
|---|---|---|---|---|---|---|
| | | | | | | _(no staging drill yet — OD-19)_ |
