# OD-27 (Part VII #7 and #13) — what 9B consumes of 9A's answers (Plan 9B Task 15)

- Owner decision: **OD-27** (contracts §2.12; spec:2470–2473, 2477). Two of its five items change what 9B does:
  **#7** (does `MatOpens.Job` ever differ from 0?) and **#13** (is the legacy Salaries module in live use?). #6 is 9A's
  `constraints()` probe and 1A's `sah-024`; #8 and #9 are 7B/7C's template mapping (`od-27-7b-…`, `od-27-7c-…`).
- Asked: by 9A's `bun run legacy questions` (`part7-7`, `part7-13` — row counts and job values, evidence only).
- Answered: pending. §2.12's default is **none**.
- Recorded by: the 9B Task 15 agent, 2026-11-14. Implementation authorization: `docs/review/2026-11-13-phase-9-decisions.md`,
  rows "9B T15".

## #7 — `MatOpens.Job`, asked of the customer's data at load time

`packages/importer/src/load/matopens-guard.ts` (`assertNoJobPartition`, `JOB_PARTITIONED_TABLES`,
`JobPartitionFinding`) reads `MATOPENS.MOPJOB` through the run's own source at the top of the opening-stock loader's
`load`, before anything is computed. Every value 0, NULL or blank, or no `MATOPENS` table: inert, the load proceeds. Any
non-zero value: the load **refuses** (`ERR_IMPORT_SOURCE_UNREADABLE`, naming the count and up to five values) — merging
job-partitioned openings yields a valuation that ties to the ledger and is still wrong. A present `MATOPENS` whose job
column cannot be read also refuses: an unanswerable question is not an answer of zero.

`MOPJOB` is 9B's dossier spelling; 9A's probe reads `MATOPENS.JOB`. Both are hypotheses until OD-17's live catalogue
(`docs/owner/od-17-live-database.md`). Until then a source in 9A's spelling refuses opening stock — fail closed.

Limit: a **dry run** never calls `load`, so it does not ask #7; 9A's `questions` report answers it beforehand, and the
cut-over runbook (step 3) says to read it.

## #13 — the Salaries module

The plan's default runs Task 8 and reports what it finds: an **empty** `EMPLOYEES` loads zero employees and zero
`employee_ytd_opening` rows, and the reconciliation's `employeeYtd` section is empty — "not in use" reached by evidence.
An **absent** `EMPLOYEES` still fails the whole pre-flight (ADR 0084 decision 3): the loader cannot tell a module never
used from a misspelt table (hazard 3). The refusal now names the operator's remedy — re-run with `only` leaving out
`employee, employee_ytd_opening` — which is exactly what the runbook prescribes when #13 is answered **no**. Pinned by
`packages/importer/test/load/employees.test.ts` ("Part VII #13 …").
