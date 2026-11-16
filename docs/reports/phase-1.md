# Phase 1 — report against the definition of done

**Date:** 2026-09-19 · **Slices:** 1A (posting service, JOURNAL, numbering, `account_balance`, chart of
accounts, periods) and 1B (projections, integrity job, minimal reports, screens, restore drill) ·
**Migrations:** 0011–0016 · **ADRs:** 0021–0025.

**Read the "How this was verified" section before the table.** Every row's State is qualified by one
environment fact: the machine this phase was built on has **no Docker daemon**, so no Testcontainers
suite could be executed here. What is claimed below is claimed at the strength it was actually proved.

## Against the definition of done

| DoD clause (spec:2287, verbatim) | Proved by | Slice | State |
|---|---|---|---|
| "Σdebit = Σcredit holds under fuzz testing" | 1A's fast-check suite through `postDocument` (`apps/api/test/routes/accounting/documents.fuzz.test.ts`) and `packages/domain/test/posting/balance.property.test.ts`; re-asserted per tenant/period/company by `checkLedgerBalance` and `tests/invariants/ledger-balance.test.ts` | 1A owns, 1B re-asserts | **written, unrun** — the pure half (`packages/domain`, 79 cases) is green; the two DB-backed halves need a container |
| "projections rebuild **bit-identically**" | `checkAccountBalanceProjection` + `tests/invariants/projection-rebuild.test.ts` — **acceptance test 2** | 1B | **written, unrun** — needs a container |
| "a locked period cannot be altered through any path including import" | API and admin paths in 1A; the **background-job path** in `tests/invariants/period-lock.test.ts` — **acceptance test 9**; the import path is 9B's and is listed as out of Phase 1's reach below | 1A + 1B (+ 9B) | **written, unrun** — needs a container |
| "the first PITR restore drill has been run against staging and written up as a runbook" | `tests/invariants/restore-drill.test.ts` — **acceptance test 24** — and `docs/runbooks/restore-drill.md` | 1B | **runbook written; drill unrun.** The staging half additionally awaits **OD-19**; the local half additionally awaits a container |

**No clause of the Phase 1 definition of done has been observed to pass.** The gate that closes Phase 1
is a green run of these four, and this phase produced the code and the tests for all four but executed
none of them. That is the honest state, and it is the same gap `CLAUDE.md` records for Phase 0: the
suites that prove this work are `packages/db`, `apps/api`, `apps/worker` and `tests`, and those are
exactly the four workspaces the Windows-only CI cannot run either.

## How this was verified

**What ran, and passed, on 2026-09-19:**

| Check | Result |
|---|---|
| `bun run lint` (oxlint) | clean |
| `bun run lint:rules` | 11 rules, 379 files, 0 violations |
| `bun run format:check` (oxfmt) | 494 files, all correctly formatted |
| `bun run typecheck` | 12 of 12 workspaces clean |
| `packages/contracts` | 14 tests, 1 file |
| `packages/domain` | 81 tests, 12 files |
| `packages/i18n` | 31 tests, 3 files |
| `packages/ui` | 22 tests, 3 files |
| `apps/backoffice` | 117 tests, 3 files |
| `apps/edge` | 35 tests, 5 files |
| `apps/desktop` (vitest) | 37 tests, 5 files |
| `apps/worker` (`test:bun`) | 2 tests, 1 file |
| **Total executed** | **339 tests across 33 files in 8 workspaces** |

**What did not run, and why.** `docker` reports `Cannot connect to the Docker daemon at
unix:///var/run/docker.sock`; there is no daemon in this sandbox, and an attempt to pull `postgres:18`
earlier returned `403 Forbidden` from the agent egress proxy. `packages/db/test/harness.ts` starts a
`PostgreSqlContainer("postgres:18")`, so **every suite in `packages/db`, `apps/api`, `apps/worker`
(vitest) and `tests` is unrunnable here** — which is the whole of this phase's own proof.

This phase **created 29 DB-backed test files carrying 158 cases** and **appended blocks to 19 more**; the
review pass below added nine more cases to five of them.
None has been executed. They are written against the same harness the 537 Phase 0 DB-backed tests use,
and they typecheck against the real exports, but a file that typechecks is not a file that passes.

`bun run e2e` (acceptance test 23) was likewise not run: it needs the back-office dev server and, for
this phase's own screens, Task 11 — which did not start (below).

## The review pass of 2026-09-19

A comprehensive review of the diff ran before merge and found fifteen defects, every one verified against the
code and fixed in the same PR. Three would have let money land where it should not; they are listed first.

| # | Defect | Fix |
|---|---|---|
| 1 | `issueDocument` read and updated the document with no row lock, so two concurrent `to: "issued"` transitions both passed the status check and each consumed a series number — a burned number with no void row (LEGACY-051 reborn) | `select … for update` on the document before the status check; `postDocument` already held it, and re-locking in the same transaction is a no-op |
| 2 | `balanceInBase` never checked Σdebit = Σcredit in the **document** currency, and its `0.01 × lines` tolerance applied at rate 1 — so `100.0000 / 99.9900` posted with a fabricated `fx_rounding` line | exact document-currency balance first; base tolerance `0.0001 × lines` (per-line 4-dp rounding contributes at most 0.00005) |
| 3 | Document lines accepted any account, branch or dimension value **in the tenant** — the FKs are tenant-scoped — so company A could post to company B's accounts | every referenced account (live, non-group), the header branch (this company's `BRANCH` type) and every line dimension value are checked against `companyId` before any row is written |
| 4 | `PATCH …/accounts/{id}` never verified the new `parentId` was in the company (POST did) | the same existence check, before the cycle CTE |
| 5 | The fiscal-period check in `postDocument` was a plain SELECT, so a close could commit between the check and the poster's commit | `for share` on the period row in both `postDocument` and `issueDocument`; a close now waits for in-flight posts |
| 6 | `GET …/documents/{id}` — every line's account and amount — was `membershipOnly()` | `requireAnyPermission([journal.create, journal.post, ledger.read], { company: "path:companyId" })`, a new middleware whose every code `assertRouteGates` judges |
| 7 | `z.coerce.boolean()` on `includeArchived` read `"false"` as `true` — here and in two 0D schemas | `z.stringbool()` in all three |
| 8 | The worker test harness registered 0D's scaffold, not the shipping handlers, so the job-isolation invariant ran against dead code and `month_end` was never probed | the harness calls `registerAccountingHandlers`; the scaffold is deleted; its corruption scenarios are re-pointed at the real handler; a `month_end` probe is added |
| 9 | `POST …/fiscal-periods/{id}/close` was unconditional: it downgraded a **locked** period to closed under `period.close` alone, and rewrote `closed_at` on a repeat | `where status = 'open'` (and `in ('closed','locked')` on reopen); a wrong status is 409 `ERR_PERIOD_STATUS_ILLEGAL`, a new code |
| 10 | The ledger report's cursor carried the running balance as `k[3]` — a money figure read back from an unsigned client value, and a 500 at `::numeric` when malformed | the cursor is the three-column key only; the seed is recomputed from the ledger up to that key; both reports validate their keyset shape strictly |
| 11 | The projection rebuild issued DDL (`create temporary table … on commit drop`) from application code, which AGENTS.md forbids | one statement with a CTE; the privilege probe that existed only to prove the temp-table grant is gone |
| 12 | `listPeriodReopens` declared `seq: number` but `audit_log.seq` is bigint, which postgres.js returns as a string | `seq::int`, as the other two readers already did; two tests that compared against a raw `seq` fixed the same way |
| 13 | The month-end job ran the whole tenant-wide integrity check once **per overdue period** | once per company; each period's readiness row is written from the one report |
| 14 | The document-create route re-implemented `resolvePolicy`'s selection rule inline and skipped `parsePolicy` | it calls `resolvePolicy` |
| 15 | Both report handlers fell back to a hard-coded `"MYR"` when the company row was not visible | `ERR_NOT_FOUND`; the base currency is OD-21's to name and no literal belongs in the API |

Two of the fifteen (7 and, in part, 8) are Phase 0 defects this pass fixed because the identical bug was being
copied forward. Findings 1–6 and 9–10 are the kind the unrun DB-backed suites exist to catch; none of those
suites has yet run.

## What passes

- **Every static gate**, over the whole tree including everything this phase added: lint, the ten custom
  repository rules plus the new eleventh, format, and typecheck across all twelve workspaces.
- **The pure half of the posting service**: `packages/domain/src/posting` — policy validation, the
  evaluator's sign normalisation and zero-line drop, BRANCH-always-wins, and the `balanceInBase`
  property suite (fast-check, 10⁴ cases) — 79 tests, green.
- **The contracts surface**: 14 tests including the error-registry count, now 36 codes.
- **`packages/contracts/openapi.json` regenerates** and carries the two new report paths; CI's diff check
  will see a committed, current document.

## What does not pass, and where it closes

| Not proved here | Closes in |
|---|---|
| **Every DB-backed suite this phase wrote** | the first run on a host with a Docker daemon, or on a CI runner that can start a Linux `postgres:18` container. This is the same `.github/workflows/ci.yml` decision `CLAUDE.md` records for Phase 0, and it now hides 158 more cases than it did |
| The **import path** of "a locked period cannot be altered through any path" | 9B — the importer does not exist yet; test 9's clause is listed against 9B in contracts §6.1 |
| The **staging half** of the restore drill (the WAL replay and an arbitrary recovery target) | Task 12, the day **OD-19** is answered. The drill, its verdict function and its runbook are merged; only the platform half is missing |
| The three back-office screens and the two report views | **Task 11, which did not start** — blocked by **OD-24**. See `docs/ui/od-24-phase-1-screens.md`. The routes, contracts and reports they read are merged and tested without them |
| `ReportDefinition`s for the two report codes | 7A/7B, under the same codes — 1B ships routes, not definitions |

## Decided under ADR

| ADR | Decision |
|---|---|
| 0021 | `document_line`: the Phase 1 base shape — no branch key, ever |
| 0022 | Ajv validates posting policies; the `PostingPolicy` type is generated and committed |
| 0023 | The mandatory period-reopen reason is a column on `fiscal_period` |
| 0024 | The ledger-integrity check is four independent read functions and one registry; the job detects and never repairs (LEGACY-079) |
| 0025 | The restore drill is two phases and one shared verdict; the local equivalent is a snapshot, not a WAL replay |

## What we are asking

1. **A CI runner that can start a Linux Postgres container**, or Docker on the development host. This is
   now the largest single gap in the project: 537 Phase 0 tests plus this phase's 158 new cases — the
   entire evidential basis for the posting service, the integrity job, the reports and migrations
   0011–0016 — have never been executed anywhere. `.github/workflows/ci.yml:36-38` names two ways.
   Nothing else in this list matters as much.
2. **OD-24** — screenshots and a two-minute operator description for the chart of accounts, journal entry
   and fiscal-period screens (spec:79, 108: "Do not invent workflows from this document"). One task is
   blocked; nothing else is.
3. **OD-19** — Supabase organisation access and PITR billing on staging. Until then the drill runs in
   local mode only.
4. **RPO and RTO as numbers** (spec:2233). ADR 0025 proposes RPO ≤ 5 minutes and RTO ≤ 4 hours as the
   targets the drill log is read against. They are a billing decision, not an engineering one, and the
   drill measures both on every run so the proposal can be checked before it is committed to.
5. **The cold-start `MERGE` race** referred by ADR 0024: whether `23505` joins the `withTenant` retry set
   or `postDocument` retries step 12. `tests/invariants/account-balance-concurrency.test.ts` pins today's
   behaviour so the answer is visible the day it lands.
6. **A new `membershipOnly()` route marker needs sign-off.** `assertRouteGates` (the Phase 0 review's own
   fix) refuses to boot when a module declaring permissions carries an ungated route. Phase 1's read
   routes that are membership-scoped rather than permission-scoped therefore needed an explicit marker
   rather than an absence. It refuses to attach to an UNSAFE method. It is described in
   `docs/ui/phase-1-api-surface.md`; it widens a Phase 0 security control and should be reviewed as one.
7. **Three amendments to the contracts document**, each one line: `legacy-070` is an append for 1B, not a
   create (0B creates it); the 1B card's task target of 10–12 becomes 13; and the names this slice had to
   define — `membershipOnly`, `sliceRegression`, `chainHashExpression`, `seedTenantV2`, `seedAccount`,
   `seedJournalPolicy`, `grantReportCodes` — join the interface registry.
