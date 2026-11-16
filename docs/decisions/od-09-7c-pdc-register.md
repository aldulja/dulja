# OD-09 — `accounting.pdc_register`, not built (Plan 7C Task 11)

- Owner decision: **OD-09** (contracts §2.12), spec:1044, spec:2479, Part VII #15 — _does the business collect
  post-dated cheques?_ The 4B record is `docs/decisions/od-09-4b-post-dated-cheques.md`; this note adds only
  7C's report.
- Covers: **Plan 7C Task 11** only — `packages/db/seed/my/reports/7c/accounting.pdc_register.json`, its
  `ReportCodeSchema` member and its group-test `describe`.
- Asked: not by this slice. The question is 4B's and is still unsent (its record holds the request).
- Answered: pending.
- Decision: pending. The default (**not built**) stands, so Plan 7C Task 11 is **dropped whole**.
- Recorded by: the 7C Task 11 agent, 2026-11-05.

**Status:** ⚠️ **DROPPED on the plan's default.** This is a gate note, not an ADR, and it decides nothing. Plan
7C Task 11 says that with OD-09 not answered yes "the task is not started and the file is not created"; this
note is written anyway, as 7B did for OD-27 (`docs/decisions/od-27-7b-template-mapping.md`), so the next reader
finds the closed gate in a file. It adds no code, no definition and no test.

## The gate, and what it checked

Task 11's Verify line is `select to_regclass('app.pdc')` printing `app.pdc`. Its precondition is 4B's migration
`0051`, which would create the table. Run on 2026-11-05 against this tree:

```
$ ls packages/db/migrations | grep -E '^0051'
$ ls docs/owner/
od-10
od-15
```

There is no `0051` file — the number is reserved to OD-09 and unused (`AGENTS.md`, contracts §3.4.1) — so
`app.pdc` does not exist, 7A shipped no `pdc` `DatasetId` (twenty-five members, not twenty-six) and §4.16.2 drops
the dataset and the report that reads it **together**, so the union never names a table that is not there.
`docs/owner/od-09/` does not exist. **The task was not started.**

## What this costs — nothing else in 7C

Contracts round 15, amendment A16 item 1, already wrote 7C on this default:

- `CATALOGUE_7C` (`tests/invariants/support/reports-7c.ts`) lists **ten** codes, not eleven;
- `ReportCodeSchema` gained **seven** members in 7C (thirty-two in all), not eight (A15);
- the `DatasetId` registry closes at **twenty-eight**, not twenty-nine;
- `assertTieOut` gained three `projection` branches (`shift`, `allocation`, `bank_statement_line`) and no `pdc`
  branch;
- §4.16.1's `accounting.pdc_register` row is struck through as dropped.

Phase 7's definition of done (spec:2293) does not name the cheque register, and §3.0.4's spec:1044 row is proven
by "—", so no Part VI test is lost.

## If the owner answers yes

The work is 4B's first and 7C's second, in that order: 4B Tasks 9–10 ship migration `0051` (`app.pdc`, the `1150`
chart row) and the `PDC_RECEIPT` / `PDC_DEPOSIT` types; 7A's `pdc` dataset joins the registry (a §4.16.2 row that
is already written); then Plan 7C Task 11 runs as printed — one definition file with
`tieOut: { kind: "projection", projection: "pdc" }`, one `ReportCodeSchema` member, one `pdc` branch in
`assertTieOut` and one `describe` in `packages/db/test/reports/7c-ar-ap.test.ts`. The 7C roll-up
(`tests/invariants/report-tie-out-7c.test.ts`) and the regression appends skip a missing
`accounting.pdc_register.json` by name and need no edit beyond the roll-up's parameter entry.
