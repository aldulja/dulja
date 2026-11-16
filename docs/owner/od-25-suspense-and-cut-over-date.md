# OD-25 — the suspense-account treatment and the cut-over date

**Status: open.** Contracts §2.12, OD-25; spec:2334 ("Suspense-account treatment for unbalanced vouchers; cut-over
date") and §5.1 #2 ("Expect unbalanced vouchers … agree a treatment (suspense account) with the customer _before_
migrating"). §2.12's _Default written into plans_ is **none**: there is no default treatment and no default date.
Recorded by plan 9B Task 11 (2026-11-13); this record decides nothing.

**Owner provides:**

1. **The cut-over date**, as a calendar date. It is entered, never derived from a legacy timestamp or from today
   (spec:2039), and the fiscal period that contains it must be open in Dulja.
2. **The agreed treatment of the balance standing on `3900`** after the load, one of _leave standing pending
   investigation_, _write off to a named account by a JOURNAL after cut-over_, or _reclassify per cause to named
   accounts by JOURNALs after cut-over_. What each costs and how each is executed is
   `docs/runbooks/cut-over-suspense.md`.

**Verify:** `bun run legacy reconcile-cut-over --tenant-id <id> --company-id <id> --cut-over-date <the owner's date>
--account-map <path>` exits 0, and the `3900 = …` figure on its summary line — decomposed in its `suspense` section
(ADR 0086 decision 4) — is the figure the customer initialled on the sign-off sheet, with the chosen treatment written
beside it.

**Until provided:**

- Every rehearsal uses the last day of an open period — the committed corpus is written for `2026-01-31` — and the
  cut-over runbook says so (step 0).
- The residue **stands** on `3900`. The import writes no clearing JOURNAL, and
  `packages/importer/test/load/opening-balance.test.ts` pins it ("OD-25 default …"): after the whole corpus load the
  company holds only `OPENING_BALANCE` and `OPENING_STOCK` documents and `3900` is −6080.0000.
- Nothing refuses to run meanwhile.

**What does not depend on the answer:** `3900`'s code, type (equity) and seeding slice (`9b-cut-over.json`, §4.15),
fixed in 9B Task 4 so that the loaders and the §5.1 #2 reconciliation name one account whatever the owner decides; the
loaders that credit it; and ADR 0086's rule for what may stand on it. A different suspense **account** would be a
contracts §4.15 amendment, not an answer to this gate.

Implementation authorization for the default: `docs/review/2026-11-13-phase-9-decisions.md`, row "9B T11".
