# Dulja Phase 6D — Shifts, Z-report, till cash lifecycle, POS reports

**For agentic workers:** execute the tasks in order. Each task is self-contained: it names every file it creates or modifies, gives the exact signatures it consumes and produces, carries the real code, and ends with a commit. Do not skip the failing-test step — the expected failure text is written out so you can compare it against what you actually see. If what you see differs, stop and read the task's "Where to stop and raise" entry in the Execution handoff rather than adjusting the test.

## Goal

Close Phase 6. A till's **shift** becomes a server-side row synced up with its tickets; the server — never the till — derives what the drawer should hold, posts the difference as a `TILL_OVER_SHORT` document, and serves a **Z-report that ties to the ledger to the cent** (acceptance test 21). The **till-event stream** (`no_sale`, `drawer_open`, `void`) becomes append-only server rows. Behind owner decision **OD-10**, the **till cash lifecycle** (paid-outs, safe drops, daily banking as cash in transit, cleared by 4B's bank reconciliation) lands as three document types and one new sync message. Two minimal POS reports — `pos.z_report` and `pos.sales_by_cashier` — ship under the registered codes 7C will later re-express.

This slice replaces the `ERR_SYNC_MESSAGE_UNSUPPORTED` refusal 6A left in `applyBatch` for `shifts` and `tillEvents` with real inserts, and re-runs 6A's whole batch suite as the proof that nothing else moved. **One case in that suite is edited and exactly one** — 6A's `it("a shift or till-event message is REFUSED per message before 6D, never dropped (§4.10.1)")`, whose two `ERR_SYNC_MESSAGE_UNSUPPORTED` assertions become acceptance assertions; every other case in `packages/db/test/sync/apply.test.ts` stands byte-for-byte, and Task 3 Step 6 shows the exact edit rather than leaving "unchanged" as a slogan a reader would find false on the first run.

## Architecture

- **Data.** `app.shift` (client-minted id, opened/closed principals as **attribution**, opening float, counted/expected/over-short) and `app.till_event` (immutable, audit-exempt) in migration `0070`, both carrying the Form A `branch_isolation` policy of §4.5.6 in their own migration file. Optionally `app.till_banking_link` in `0071` (OD-10).
- **Sync.** The shift and till-event apply paths live inside **6A's** `applyBatch` — one entry point, one transaction, a savepoint per ticket. This slice reorders that function to **shift opens → tickets → shift closes → till events** so a close sees the cash its own batch banked, and re-emits `shiftResults` in the order the till sent them.
- **Money.** Nothing about cash is computed at the till except the physical count. `expected_cash` is read out of `app.ledger_entry` — the net movement on `1110` Cash in till, in the shift's own currency, over the shift's posted documents — so a tampered or clock-skewed till cannot move the difference. `over_short = counted − expected`, positive is over.
- **Posting.** Every peso of this slice goes through `postDocument`. `TILL_OVER_SHORT`, `TILL_PAID_OUT`, `TILL_SAFE_DROP` and `TILL_BANKING` are ordinary documents with ordinary two-line `account` bodies under JOURNAL-shaped policies; no ledger row is written outside `packages/db/src/posting/`.
- **Reports.** `packages/db/src/reports/pos.ts` exports `zReport` and `salesByCashier`; two `GET`s join **1B's existing** `reportsRouteModule`; a new `shifts` route module serves the list and detail reads. 7C re-expresses both codes as `ReportDefinition`s and re-runs this slice's tie-out test unchanged.

## Tech Stack

TypeScript 5 on Bun; PostgreSQL 18 via `postgres.js` tagged templates (Drizzle mirrors for reads only); Hono + `@hono/zod-openapi`; Zod contracts; Vitest on Node 24 with Testcontainers; `decimal.js` behind `Money`/`Quantity`; pg-boss for jobs (this slice registers none). No new dependency is added by this slice, and no version is hard-coded in a source file (§3.3).

## Spec

`C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` v1.2 — §3.7.5 (spec:1320–1337, the local `shift` shape and cashier identity), §3.7.6 (spec:1339–1360, the **Shift**, **Staff** and **Cash control ⚠️** rows), §3.0.4 row spec:1063 (Till cash lifecycle ⚠️), §4.2.1 (spec:2160–2161, the `branch_manager` and `cashier` rows), §4.2.2 R8 (spec:2179), §3.9 (spec:2037–2063), §0.2 (spec:97–106), Part V Phase 6 (spec:2292, 2299), Part VI tests **21** (spec:2439) and **39** (spec:2457), Part VII **#15** (spec:2479).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 6D — Shifts, Z-report, till cash lifecycle, POS reports. **Phase:** 6. **Phase gate:** this plan starts only when **6A, 6C and 6B** are merged and Phase 5's definition of done is green in CI (spec:87). Phase 6 is serial: 6A → 6C → 6B → 6D (§6.3).
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `draftDocument`, `schemaFingerprint`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `discover`, `MIGRATIONS_DIR`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.forbid_change`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.posting_seq`. **0B** — `createDb`, the production `withTenant(sql, ctx, fn)`, `TenantContext`, `systemContext`, `AppError`, `ERRORS`, `Problem`, `fromDatabaseError`, `createLogger`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `requirePermission`, `assertRouteGates`, `buildRoutes`, `ROUTES`, `RouteModule`, `IdempotencyHeader`, `createApp`, `AppDeps`, `AppEnv`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `IsolationProbe`, `encodeCursor`, `decodeCursor`, `Cursor`, `ListEnvelope`, `ListQuery`, `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CurrencySchema`, `ProblemSchema`, `sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `repoFile`. **0D** — `Money`, `currency`, `CurrencyCode`, `round`, `RoundingMode`, `MONEY_SCALE`, `Quantity`, `seedBranch`, `seedCurrency`, `JOBS`, `JobName`. **0C** — the seed CLI, `PackLoader`, `LoaderContext`, `readPackFile`, `SUB_PACKS`, and the `0c-base.json` chart rows `1000`, `1100`, `1200`, `1300`, `4000`, `5000`, `5900`, `5920`. **0E** — `packages/ui`, `packages/i18n`, `bootLocalStack`, `grantAdminRole`. **1A** — `postDocument`, `issueDocument`, `loadSnapshot`, `resolvePolicy`, `PostResult`, `PostingError`, `seedTenantV2`, `seedAccount`, `documentTypesLoader`, `loadDocumentTypes`, `app.posting_seq`, `document.posting_seq`. **1B** — `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`, `postJournal`, `registerProjectionCheck`, `projectionChecks`. **2A** — `evaluatePolicy`, `balanceInBase`, `parsePolicy`, `validatePolicy`, `PostingPolicy`, `DocumentSnapshot`, `LineSnapshot`, `PlannedLedgerLine`, `seedDocumentType`, `seedParty`, `POLICY_RESOLVED_CODES`, `DOCUMENT_STAGE_CODES`. **2B** — `recordOverride`, `setEventContext`, `grantCodes`, `app.principal_has`, `app.effective_policy`. **2C** — `MODULE_READ_CODE`, `requireAttachmentRead`, `readableModules`, `pdfText`. **3A** — `seedItem`, `seedWarehouse`, `INVENTORY_PERMISSION`, `app.inventory_movement`, `app.stock_on_hand`. **3B** — `applyMovements`, `ensureOpenPeriods`. **4B** — `Reconcilable`, `ReconcilableSource`, `RECONCILABLE_DIRECTION`, `registerReconcilableSource`, `reconcilableSources`, `match`, `unmatch`, `reconciledBalance`, `importStatement`. **6A** — `applyBatch`, `TerminalApplyContext`, `TicketInput`, `TicketLineInput`, `TicketTenderInput`, `TicketEventInput`, `TicketBatchInput`, `TicketOutcome`, `MessageOutcome`, `BatchOutcome`, `SyncError`, `SyncErrorCode`, `POS_PERMISSION`, `OVERRIDE_SUBJECT_FOR`, `PosPermissionCode`, `readCatalogue`, `currentCatalogueRevision`, `seedTerminal`, `document.terminal_id`, `document.shift_id`, `document_line.kind = 'tender'`, `POS_TICKET` and its policy, the chart rows `1110`/`1120`/`2200`, and the whole of `tests/invariants/support/pos.ts` (`POS_PACK_ROOT`, `PosFixture`, `posFixture`, `enrolTerminal`, `EnrolledTerminal`, `signSyncRequest`, `syncRequest`, `buildTicket`, `MemorySyncStore`, `SHARED_SHIFT_ID`). **6C** — `app.employee`, `app.pos_cashier`, `app.branch_pos_policy`, `app.attendance_event`, `app.actor_in_branch`, `app.actor_in_warehouse`, `branch_isolation` Forms A/A″/A′/B/C, the `branch_isolation_policy` linter rule, `BRANCH_ISOLATION_EXEMPT`, `verifyTicket`, `requiredCodesFor`, `OVERRIDE_LIFTS`, `LimitKind`, `LimitRefusal`, `TicketVerification`, `TicketContext`, `ERR_POS_LIMIT_EXCEEDED`, `seedEmployee`, `seedCashier`, `seedBranchPosPolicy`, `staffFixture`, `StaffFixture`, `computeSnapshot`, `CASHIER_SNAPSHOT_CODES`. **6B** — the `pos.price.check` / `pos.shift.own` / `pos.attendance.clock` catalogue rows and their permission-seed migration (Task 0 asserts them by literal, not by file name).
- **Migration numbers:** 0070–0073 — files `0070_create_shift_till_event.sql`, `0072_seed_permission_phase6d.sql`, and ⚠️ `0071_create_till_banking_link.sql` **only if OD-10 = yes**. **0073 is allocated and left unused; no slice borrows it** (§3.4.1). **ADR numbers:** 0063–0064 (`0063-shift-close-derives-expected-cash`, ⚠️ `0064-till-cash-lifecycle-and-cash-in-transit` — written only if OD-10 = yes).
- **Interfaces consumed:** §4.1 (the whole Plan 0A surface), §4.2.1 (`Money`, `currency`, `round`, `RoundingMode`), §4.2.2 (`withTenant`, `TenantContext`, `systemContext`), §4.2.3 (`AppEnv`, `RequestContext`, `Logger`, the fixed middleware order), §4.2.4 (`Problem`, `ERRORS`, `AppError`, `fromDatabaseError`, `PostingError`, and 6A's/6C's already-shipped rows — **this slice adds none**), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `requirePermission`, `ROLES`, `INCOMPATIBLE_PAIRS`, `assertRouteGates`), §4.2.6 (`JOBS`, consulted only — **this slice registers no job**), §4.2.7 (`RouteModule`, `buildRoutes`, `PROBES`, `IsolationProbe`, `IdempotencyHeader`, `createApp`), §4.2.8 (the common schemas, the list envelope, the cursor codec, and **the one list-filter convention — literal `filter[…]` keys, the Layer 2 default**), §4.2.9 (`idempotency`), §4.2.12 (`startApi`, `StartedApi`), §4.2.13 (`PackLoader`, `readPackFile`), §4.3.1 (`postDocument`, `loadSnapshot`, `resolvePolicy`, `setEventContext`), §4.3.2 (the fixed algorithm — steps 1–15, and specifically 6's zero-drop), §4.3.4 (`document_line`, `document.shift_id`, `document.terminal_id`), §4.3.5 (`posting_seq`), §4.3.6 (numbering at issue), §4.3.7 (the seed envelope), §4.4.1 (`posting-policy.schema.json`, consumed **unchanged**), §4.4.2 (`DocumentSnapshot`, `LineSnapshot`, **sign normalisation A9**), §4.5.1 (legal transitions), §4.5.6 (Form A, attached here for two tables), §4.5.8 (`MODULE_READ_CODE` — **this slice adds the `pos` row**), §4.6.1 (the register rows for `shift` and `till_event`), §4.6.3–§4.6.4 (`pos_cashier`, `branch_pos_policy`), **§4.6.5 in full**, §4.8.3 (`Reconcilable`, `registerReconcilableSource`, `ledgerLegSource`'s shape), §4.10 **in full**, §4.11 (consulted: **this slice ships no `ReportDefinition`** — 7A builds the engine), §4.14 (document-type codes), §4.15 (account codes), §4.16.1 and §4.16.3 (the two report codes and the Phase 1 report surface they join), §4.17 (`seedShift` — this slice's one row), §4.17.1, §5 (all thirty-five hazards), §6.1 row 21, §6.2 row 1063.
- **Interfaces produced:** §4.6.5 (`app.shift`, implemented verbatim plus the three FKs and one index Task 0 amends in), §4.6.1's `till_event` row, the shift/till-event apply paths of §4.10.1, §4.16.3's POS additions (`zReport`, `salesByCashier` and their param/row types — amendment A5), §4.5.8's `pos` map row, §4.2.7's `shiftRouteModule` at `/v1/companies/:companyId/shifts` with its one `PROBES` key (amendment A11), two new §4.2.8 module rows (`packages/contracts/src/pos/shift.ts`, `pos/reports.ts`), and ⚠️ **OD-10 only** §4.10.1's fourth message array `cashEvents`/`cashEventResults` with `TillCashMsg` (amendment A13) and `app.till_banking_link` with its `till_banking` `ReconcilableSource` (amendment A16, §4.8.3's registry seam).
- **Four amendments this plan discovered that the contracts document did not have at all, all written by Task 0:** **A15** — 6A's `resolveSeries` suffixes **every** document carrying a `terminal_id`, so §4.14's `Series` column is the *policy* series and this slice's posted documents are numbered `TOS-<terminal code>` (and ⚠️ `TPO-`/`TSD-`/`TBK-`); **A16** — ⚠️ `till_banking_link` had no §4.6.1 register row and no §3.5.3 linter-set row, and its columns are fixed there before migration 0071 is written; **A17** — `seedShift`'s §4.17 row gains `currency?`, `branchId?` and `shiftId?`; **A18** — 2C shipped `MODULE_READ_CODE` in `apps/api/src/middleware/require-attachment-read.ts`, **not** at the `routes/accounting/attachments.ts` path §4.5.8's prose names, and §4.18 makes the written plan the authority.
- **Owner decisions:** **OD-10** (till cash lifecycle) → **Tasks 9, 10, 11** (isolated; default **not built**). **OD-24** (screenshots before any screen) → **Task 12** (isolated; default **the screen task is blocked, not the slice**). **OD-05**'s 6D row is the ⚠️ §3.0.4 row spec:1063, which is the *same* decision as OD-10 — the three OD-10 tasks are its gate and this slice creates no separate OD-05 task.
- **Part VI tests owned / re-run:** owns **21**; re-runs **39** (the till-banking clause, OD-10 only), **36** (shifts in branch scoping), **23** (screens, OD-24 only), and **6A's `packages/db/test/sync/apply.test.ts` batch suite — with exactly one case edited**, the `ERR_SYNC_MESSAGE_UNSUPPORTED` refusal that becomes the acceptance case (Task 3 Step 6, finished in Task 6 Step 5); every other case in that file stands byte-for-byte and Task 13's re-run matrix is where the claim is checked. **§3.0.4 rows owned:** spec:1063 (Till cash lifecycle ⚠️). **Regression files created / appended:** creates none; **appends to `tests/regression/sah-031.test.ts` and `tests/regression/sah-041.test.ts`** (both created by 0B — §3.7.3's Plan 0A-proven list names 031 and 041).
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14)** — `TILL_OVER_SHORT` (`pos`, series `TOS`), seeded as `packages/db/seed/my/document-types/TILL_OVER_SHORT.json`; ⚠️ **OD-10 only** `TILL_PAID_OUT` (`pos`, `TPO`), `TILL_SAFE_DROP` (`pos`, `TSD`), `TILL_BANKING` (`pos`, `TBK`). Consumed and never re-seeded: `POS_TICKET` (6A). **Account codes (§4.15)** — two of this slice's own rows seeded **unconditionally**, `5120` Till over/short (expense) and `1130` Cash in transit (asset), plus ⚠️ **OD-10 only** `5130` Till paid out (expense), all in `packages/db/seed/my/chart-of-accounts/6d-till.json`. Consumed and asserted-not-re-seeded, with their seeding slice: `1110` Cash in till, `1120` Card clearing, `2200` Store-credit liability (**6A**); `1000` Cash on hand, `1100` Bank (**0C**). **Report codes (§4.16.1)** — **`pos.z_report` and `pos.sales_by_cashier`**, both this slice's own rows, seeded as routes over named read functions (§4.16.3) and **not** as `ReportDefinition`s; `ReportCodeSchema` is widened by both. **`DatasetId` members (§4.16.2) — none:** `shift` and `till_event` are **7C's** rows in the frozen union and 7A creates `datasets.ts`. **`fixtures.ts` helpers (§4.17) — exactly one, the row §4.17 assigns 6D, with three options added additively by amendment A17: `seedShift(db, s, opts: { terminalId; cashierPrincipalId; openingFloat?; currency?; branchId?; shiftId? }) → string`.** §4.17's registered row names only the first three; the other three are load-bearing (`shiftId` for amendment A6, `branchId` for A7, `currency` for Task 3's wrong-currency cases) and §4.17's own rule — "a slice needing an option a listed one lacks adds the option additively and records it here in the same PR" — is discharged by **A17**. **Shared test helpers (§4.17.1) — none new**; this slice consumes 6A's `tests/invariants/support/pos.ts` and 6C's `tests/invariants/support/staff.ts` and adds one exported member to each (Task 0 amendments A6 and A7).
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

## Global Constraints

1. **Never write to a ledger or movement table outside the posting service** (spec:97, hazard 22). Every figure this slice puts in the ledger — the over/short, the paid-out, the safe drop, the banking — is a `document` posted by `postDocument`. `packages/db/src/reports/pos.ts` and `packages/db/src/sync/shifts.ts` **read** `ledger_entry`; neither writes it, and `posting-only-tables` (§3.7.5) fails the build if either ever does.
2. **Never money as a float.** `numeric(19,4)` in Postgres, `Money` in TypeScript, `string` on the wire. `no-number-money` (§3.7.5) fires on any property, parameter or variable whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` typed `number`. `expectedCash`, `countedCash`, `overShort` and `openingFloat` all carry `Money` or `string`, never `number`.
3. **Never SQL by string concatenation.** Every statement is a `tx`-tagged `postgres.js` template or a Drizzle read; `sql.unsafe` has exactly three homes and none of them is in this slice (§3.3, hazard 21).
4. **Never DDL from application code.** DDL lives only in `packages/db/migrations/NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql` (§3.4.2, §3.4.5).
5. **Never hard-code a package version into a source file** — the lockfile owns versions (spec:104).
6. **Every new table** carries `tenant_id`, RLS via `app_meta.enable_tenant_rls`, FORCE RLS, `created_at`, the audit trigger via `app_meta.attach_audit` unless the table is in `AUDIT_EXEMPT`, `stamp_<col>` for every `*_by` column, composite `(tenant_id, x)` FKs, `unique (tenant_id, id)`, `snake_case` singular names, and a test that a second tenant cannot see it (§3.3, §3.5.1).
7. **A column that records *whom* an act is attributed to is never named `*_by`** (§3.3). `shift.opened_principal_id`, `shift.closed_principal_id`, `till_event.cashier_principal_id` and `till_event.supervisor_principal_id` follow the rule; `stamp_actor` would otherwise overwrite the cashier with the terminal, which is SAH-044 in reverse.
8. **The terminal acts, the cashier is attributed** (hazard 19, spec:1324). Every document this slice posts through the sync path has `created_by` / `posted_by` = the terminal principal and its human on `attributed_to` or on a `*_principal_id` column.
9. **`side` carries direction; a planned ledger amount is never negative** (§4.4.2 amendment A9). This slice is **named** in A9's warning list through its 6A inheritance: nothing here reads `amount.isNegative()` to decide a direction. `shift.over_short` is a **stored signed column** and is not a planned line — it is read once, its sign chooses which of two `document_line` rows carries the magnitude, and the magnitude itself is always positive.
10. **Per-tenant rows cannot be written by a migration** (hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so `0070` and `0072` create objects and seed `app.permission` (global) only. Document types, policies and chart rows are seed-pack data applied by `bun run seed --tenant <id> --only <sub-pack>`.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds no `ERRORS` row.** Everything it raises is already shipped: `ERR_NOT_FOUND`, `ERR_VALIDATION_FAILED`, `ERR_RBAC_FORBIDDEN`, `ERR_RLS_DENIED`, `ERR_CONFLICT_UNIQUE`, `ERR_CONFLICT_REFERENCE`, `ERR_POS_LIMIT_EXCEEDED` (6C), `ERR_SYNC_TICKET_REJECTED`, `ERR_SYNC_MESSAGE_UNSUPPORTED` (6A), `ERR_DOC_NO_LINES`, `ERR_DOC_STATUS_ILLEGAL`, `ERR_PERIOD_NOT_OPEN`, `ERR_PERIOD_NOT_FOUND`, `ERR_POLICY_NOT_FOUND`, `ERR_POLICY_REQUIRES_MISSING`, `ERR_LEDGER_UNBALANCED`, `ERR_OVERRIDE_NOT_AUTHORISED`, `ERR_BANK_MATCH_AMOUNT` (4B), `ERR_INTERNAL`. **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the two codes §3.6.2 assigns it — `pos.shift.close_any` and `pos.report.read` — and invents none. `pos.shift.own`, `pos.price.check` and `pos.attendance.clock` are **6B's** and are consumed, never re-seeded.
13. **No plan invents a literal in a shared namespace** (hazard 32). Every document-type code, account code, report code, `DatasetId` member, `fixtures.ts` helper name and `ERR_*` code this slice writes is in the Assumptions block's namespace list above; a literal not there is a review-blocking finding.
14. **The slice that seeds a policy seeds the accounts that policy names by code** (hazard 33). This slice's four policies address their accounts as `{ "from": "line.account" }`, so **no `account: { code }` literal appears in any of them**; the *service* resolves `1110`, `1130`, `5120`, `5130` and `1100` by code when it builds the document's lines, and Task 5 Step 2's first case asserts each resolves rather than assuming it.
15. **Jobs run as the tenant's system principal** (hazard 20). This slice registers **no** job and adds **no** `JOBS` name — the registry stays closed at sixteen.
16. **Every route needs a probe entry in `tests/invariants/probes.ts`**, keyed by its `RouteModule.path` (hazard 31). This slice mounts **one** new module (`/v1/companies/:companyId/shifts`) and therefore adds **one** `PROBES` entry; the two report `GET`s join 1B's existing `reports` module and add none.
17. **No real Malaysian statutory rate, threshold, ceiling or formula appears anywhere** (hazard 1) and **no LHDN or MyInvois detail** (hazard 2). Neither is in scope here; the constraint is restated because this slice touches tax through `POS_TICKET`'s tender totals and must read tax figures from the database, never restate one.
18. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [6D T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after **every** task. **No check is ever knowingly red in this slice, and the catalogue rule in particular is not** — a point worth stating because an earlier draft of this plan got it wrong. Task 2 Step 4 adds the catalogue rows `pos.shift.close_any` and `pos.report.read`, and **Task 2 Step 6 writes both literals into `packages/db/src/sync/authority.ts` in the same commit**. §3.6.3's `permission-catalogue` rule (0D, `scripts/lint/rules/permission-catalogue.ts`) counts a code as *evaluated* when it appears as **any string literal** in `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or **`packages/db/src`** — 0D's implementation is a `stringLiterals(file)` walk compared against the catalogue, not a `PERMISSION.<code>` / `principalHas('<code>')` pattern match, and 6A relies on exactly that to keep eight of its eleven codes green from the commit that adds `authority.ts` (6A Task 5 Step 5). Both of this slice's codes are therefore referenced from Task 2's own commit, and `bun run lint:rules` is green at the end of Tasks 2, 3, 4 and 5 alike. **The catalogue row still lands in the same commit as migration 0072** — `packages/db/test/permission-catalogue.test.ts`'s bidirectional assertion compares `app.permission` (seeded by 0072) against what `permissions.ts` exports, so splitting them makes that suite red.
19. **This slice rewrites `AGENTS.md`'s "Current phase" section** — §3.8 names 6D as Phase 6's closing slice. Task 13 does it.
20. **One migration per PR** (spec:2057). Two migrations, **PR 1 of 2 (3 with OD-10)** — that exact phrase is used in every commit step and in the handoff table, so a reader never has to reconcile two counts.

## This slice's share of the Phase 6 definition of done

Phase 6's DoD is two sentences (spec:2292): *"A till sells 8 hours offline and reconciles with zero duplicates and zero lost tickets; the shift Z-report ties to the ledger to the cent."* The first is 6B's (the till) and 6A's (the server); **this slice owns the second**, and one clause of the first.

| Clause | Where it becomes true |
|---|---|
| **"the shift Z-report ties to the ledger to the cent"** | **Task 8**, acceptance test 21, in `tests/invariants/pos-shift-reconciliation.test.ts`: for a closed shift, (1) every tender line of the Z-report equals the ledger's net movement on that tender's §4.15 account over the shift's posted tickets, in the shift's own currency, to the cent; (2) `opening_float + net(1110) over every posted document of the shift, TILL_OVER_SHORT included == counted_cash`, to the cent; (3) `over_short == counted_cash − expected_cash` and the `TILL_OVER_SHORT` lines carry the magnitude on the side the sign chooses. |
| **"zero lost tickets"** (this slice's clause) | **Task 3 Step 4** — 6A's `refuseUnsupported` is replaced by real inserts, so the opening float a till has been holding in its outbox since 6A finally lands instead of being refused; and a shift or till-event message that *is* refused still answers `rejected`, so `drainOutbox` leaves its outbox row pending (spec:1337). Nothing this slice adds can drop a message. |
| **"zero duplicates"** (this slice's clause) | **Task 3 Step 3** and **Task 6 Step 3** — a shift `open` is `on conflict (id) do nothing` on the till's own uuidv7, a `close` on an already-closed shift answers `duplicate`, and a `till_event` is keyed on the till's `client_ref`. Re-sending any of the three writes nothing and posts nothing a second time. |

**What is deliberately *not* in this slice's DoD share:** the till (`apps/pos`, the local SQLite schema, acceptance test 19 — **6B**); the catalogue down-sync and terminal identity (**6A**); the PIN, the cashier snapshot and the branch-isolation policies for 6A's and 6C's own tables (**6C**); the report *builder*, saved views and financial-statement layouts (**7A**); and Z-report *history* as a `ReportDefinition` (**7C**, under this slice's same code).

## File Structure

```
packages/db/
  migrations/
    0070_create_shift_till_event.sql              NEW  T1  — app.shift, app.till_event, Form A, indexes
    0070.down.sql                                 NEW  T1
    0072_seed_permission_phase6d.sql              NEW  T2  — pos.shift.close_any, pos.report.read
    0072.down.sql                                 NEW  T2
    0071_create_till_banking_link.sql             NEW  T11 ⚠️ OD-10 only
    0071.down.sql                                 NEW  T11 ⚠️ OD-10 only
  src/
    schema/shift.ts                               NEW  T1  — Drizzle mirror (reads only)
    schema/till-event.ts                          NEW  T1
    schema/till-banking-link.ts                   NEW  T11 ⚠️
    lint-schema.ts                                EDIT T1  — till_event joins AUDIT_EXEMPT and IMMUTABLE
    sync/shifts.ts                                NEW  T3  — classifyShifts, applyShiftOpen, assertShiftKnown
                                                  EDIT T5  — applyShiftClose, computeExpectedCash
    sync/till-events.ts                           NEW  T6  — applyTillEvent
    sync/till-cash.ts                             NEW  T9  ⚠️ — applyCashEvent, verifyCashEvent
    sync/apply.ts                                 EDIT T3, T6, T9 — 6A's seam: ordering + the three real paths
    sync/authority.ts                             EDIT T2  — POS_PERMISSION gains two members
    posting/till.ts                               NEW  T5  — buildTillDocument, the ONE till-document writer
    reports/pos.ts                                NEW  T7  — zReport, salesByCashier
    ar-ap/reconciliation-till.ts                  NEW  T11 ⚠️ — the till_banking ReconcilableSource
    index.ts                                      EDIT T1, T3, T5, T6, T7, T9, T11 — re-exports
  seed/my/
    chart-of-accounts/6d-till.json                NEW  T4 (two rows) / EDIT T9 (⚠️ the third)
    document-types/TILL_OVER_SHORT.json           NEW  T4
    document-types/TILL_PAID_OUT.json             NEW  T9  ⚠️
    document-types/TILL_SAFE_DROP.json            NEW  T10 ⚠️
    document-types/TILL_BANKING.json              NEW  T11 ⚠️
  test/
    fixtures.ts                                   EDIT T1  — seedShift (§4.17's one 6D row)
    shift.test.ts                                 NEW  T1  — DDL, RLS, branch isolation, immutability
    sync/shifts.test.ts                           NEW  T3  — the open path, the classifier, assertShiftKnown
    sync/shift-close.test.ts                      NEW  T5  — the close arithmetic (its OWN startApi, §3.7.1)
    sync/till-events.test.ts                      NEW  T6
    sync/till-cash.test.ts                        NEW  T9, T10, T11 ⚠️
    reports/pos.test.ts                           NEW  T7
    seed/6d-pack.test.ts                          NEW  T4  — the pack shape, over app.permission rows
    phase-6d-pins.test.ts                         NEW  T13 — the five pins reachable from packages/db
    schema-lint.test.ts                           (unchanged — its "zero violations" case is the gate)
    privileges.test.ts                            (unchanged — T1 re-runs it; 6D grants no DELETE, §3.5.4)

packages/contracts/
  src/pos/shift.ts                                NEW  T7  — ShiftSchema, ShiftQuery, ShiftList
  src/pos/reports.ts                              NEW  T7  — ZReportSchema, SalesByCashierRowSchema, the queries
  src/accounting/reports.ts                       EDIT T7  — ReportCodeSchema gains two members
  src/sync/messages.ts (mirror of packages/sync)  EDIT T9  ⚠️ — TillCashMsgSchema, the fourth array

packages/sync/
  src/messages.ts                                 EDIT T9  ⚠️ — TillCashMsg, TicketBatch.cashEvents, BatchResult.cashEventResults
  src/client.ts                                   EDIT T9  ⚠️ — drainOutbox acks the fourth array

apps/api/src/
  routes/pos/shifts.ts                            NEW  T7  — shiftRoutes, shiftRouteModule
  routes/accounting/reports.ts                    EDIT T7  — two GETs on 1B's module
  routes/sync/tickets.ts                          EDIT T9  ⚠️ — toBatchResult carries the fourth array
  routes/index.ts                                 EDIT T7  — buildRoutes registers shiftRouteModule
  middleware/require-attachment-read.ts           EDIT T2  — MODULE_READ_CODE gains the pos row

apps/backoffice/src/                              T12 ⚠️ OD-24 — blocked until screenshots arrive

tests/
  invariants/support/pos.ts                       EDIT T3  — posFixture opens a shift at SHARED_SHIFT_ID
  invariants/support/staff.ts                     EDIT T5  — StaffFixture gains shiftA and openShift
  invariants/pos-shift-reconciliation.test.ts     NEW  T8  — acceptance test 21
  invariants/pos-till-banking.test.ts             NEW  T11 ⚠️ — test 39's till-banking clause
  invariants/probes.ts                            EDIT T7  — one PROBES entry for the shifts module
  invariants/phase-6d-pins.test.ts                NEW  T13 — the three pins that read @dulja/contracts,
                                                            @dulja/api/routes and probes.ts (§3.1)
  regression/sah-031.test.ts                      EDIT T13 — append a "— 6D" describe block
  regression/sah-041.test.ts                      EDIT T13 — append a "— 6D" describe block

docs/adr/
  0063-shift-close-derives-expected-cash.md       NEW  T4  — a PROPOSAL (money semantics — spec:95)
  0064-till-cash-lifecycle-and-cash-in-transit.md NEW  T9  ⚠️ — a PROPOSAL (money semantics + sync protocol)

scripts/check/contracts-6d-amendments.sh          NEW  T0  — the gate Task 1 does not start without
AGENTS.md                                         EDIT T13 — the "Current phase" section (§3.8)
```

---

### Task 0: Contracts amendments and the 6A / 6C / 6B / 4B / 1B repository gate

**This task carries no product code and no commit of its own beyond the gate script and the contracts edits.** It exists because six of the eleven interfaces this slice extends were written by another plan, and a guess about any of them is a merge conflict discovered at the last task instead of the first. **Task 1 does not start until `bash scripts/check/contracts-6d-amendments.sh` exits 0.**

**Files**
- Create: `scripts/check/contracts-6d-amendments.sh`
- Modify: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` (the eighteen amendments below)

- [ ] **Step 1: Write the gate script.**

```bash
#!/usr/bin/env bash
# scripts/check/contracts-6d-amendments.sh — 6D's Task 0 gate. Exits 0 only when every name this slice
# extends exists in the repository with the spelling this plan was written against.
set -u
CONTRACTS="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_repo() {  # need_repo "<label>" <path> "<literal>"
  if [ ! -f "$2" ]; then printf 'MISSING (repo): %-42s no file %s\n' "$1" "$2"; fail=1; return; fi
  if ! grep -qF -- "$3" "$2"; then printf 'MISSING (repo): %-42s %s lacks "%s"\n' "$1" "$2" "$3"; fail=1; fi
}
need_dir() {   # need_dir "<label>" <dir> "<literal>"  — the literal anywhere under the directory
  if ! grep -rqF -- "$3" "$2" 2>/dev/null; then printf 'MISSING (repo): %-42s nothing under %s contains "%s"\n' "$1" "$2" "$3"; fail=1; fi
}
need_doc() {   # need_doc "<label>" "<literal>"
  if ! grep -qF -- "$2" "$CONTRACTS"; then printf 'MISSING (doc): %-43s "%s"\n' "$1" "$2"; fail=1; fi
}
need_repo_owned() {  # need_repo_owned "<label>" <path> "<literal>" "<remedy sentence>"
  # Same check as need_repo, but the literal belongs to ANOTHER slice's file and 6D cannot supply it by
  # renaming anything of its own — so the failure line carries the raise, not "fix your import path".
  if [ ! -f "$2" ] || ! grep -qF -- "$3" "$2"; then
    printf 'MISSING (repo, OWNED ELSEWHERE): %s\n  %s lacks "%s"\n  %s\n' "$1" "$2" "$3" "$4"; fail=1
  fi
}

# ── 6A: the sync seam this slice replaces ─────────────────────────────────────────────────────────────
need_repo "6A applyBatch"            packages/db/src/sync/apply.ts     "export async function applyBatch"
need_repo "6A refuseUnsupported"     packages/db/src/sync/apply.ts     "async function refuseUnsupported"
need_repo "6A refOf"                 packages/db/src/sync/apply.ts     "function refOf"
need_repo "6A BatchOutcome"          packages/db/src/sync/apply.ts     "export interface BatchOutcome"
need_repo "6A MessageOutcome"        packages/db/src/sync/apply.ts     "export interface MessageOutcome"
need_repo "6A TicketInput"           packages/db/src/sync/apply.ts     "export interface TicketInput"
need_repo "6A TicketBatchInput"      packages/db/src/sync/apply.ts     "export interface TicketBatchInput"
need_repo "6A TerminalApplyContext"  packages/db/src/sync/apply.ts     "export interface TerminalApplyContext"
need_repo "6A SyncError"             packages/db/src/sync/enrolment.ts "export class SyncError"
need_repo "6A POS_PERMISSION"        packages/db/src/sync/authority.ts "export const POS_PERMISSION"
need_repo "6A OVERRIDE_SUBJECT_FOR"  packages/db/src/sync/authority.ts "export const OVERRIDE_SUBJECT_FOR"
need_repo "6A ShiftOpenClose"        packages/sync/src/messages.ts     "export interface ShiftOpenClose"
need_repo "6A TillEventMsg"          packages/sync/src/messages.ts     "export interface TillEventMsg"
need_repo_owned "6A document.shift_id" packages/db/migrations/0061_alter_document_add_pos_columns.sql "shift_id" \
  "0061 must add app.document.shift_id — 6A's applyTicket step (f) writes that column on every POS_TICKET, so a 0061 without it cannot pass 6A's own suite and 6A is not green. RAISE against 6A Task 4, whose migration 0061 adds the column under 6A's own Task 0 amendment 6 — the amendment that records this move from 6A's side, as 6D's contracts amendment A2 records it from this one. Do NOT add it in 0070: A2 records why 6D adds neither the column nor a key, and 0070.down.sql cannot be written to be reversible in both worlds."
need_repo "6A tender kind"           packages/db/migrations/0061_alter_document_add_pos_columns.sql "'tender'"
# 2C's 0027 adds `app.document.notes` (contracts §4.3.4) and its FILE NAME is 2C's to choose (§3.4.2),
# so the literal is searched across the whole directory. `buildTillDocument` writes that column.
# NOTE for the reader: 6A's own header insert (its Task 11, `applyTicket` step (f)) names neither `memo`
# nor `notes` — `memo` is a column NO migration creates and 6A's comment says so outright. `notes` is 2C's
# and this slice is the first to write it (Task 5 Step 2's column-list note).
need_dir  "2C document.notes"        packages/db/migrations "add column notes"
need_repo "6A posFixture"            tests/invariants/support/pos.ts   "export async function posFixture"
need_repo "6A SHARED_SHIFT_ID"       tests/invariants/support/pos.ts   "SHARED_SHIFT_ID"
need_repo "6A buildTicket"           tests/invariants/support/pos.ts   "export function buildTicket"
need_repo "6A seedTerminal"          packages/db/test/fixtures.ts      "export async function seedTerminal"
need_repo "6A 1110 cash in till"     packages/db/seed/my/chart-of-accounts/6a-pos-tenders.json "1110"
need_repo "6A POS_TICKET policy"     packages/db/seed/my/document-types/POS_TICKET.json "POS_TICKET"

# ── 6C: the limits, the branch policies and the staff corpus ──────────────────────────────────────────
need_repo "6C verifyTicket"          packages/db/src/sync/limits.ts    "export async function verifyTicket"
need_repo "6C requiredCodesFor"      packages/db/src/sync/limits.ts    "export function requiredCodesFor"
need_repo "6C OVERRIDE_LIFTS"        packages/db/src/sync/limits.ts    "export const OVERRIDE_LIFTS"
need_repo "6C LimitRefusal"          packages/db/src/sync/limits.ts    "export interface LimitRefusal"
need_repo "6C TicketContext"         packages/db/src/sync/limits.ts    "export interface TicketContext"
need_repo "6C actor_in_branch"       packages/db/migrations/0068_create_branch_isolation_policies.sql "actor_in_branch"
need_repo "6C branch_isolation rule" packages/db/src/lint-schema.ts    "branch_isolation_policy"
need_repo "6C paid_out_allowed"      packages/db/migrations/0066_create_branch_pos_policy.sql "paid_out_allowed"
need_repo "6C seedCashier"           packages/db/test/fixtures.ts      "export async function seedCashier"
need_repo "6C seedBranchPosPolicy"   packages/db/test/fixtures.ts      "export async function seedBranchPosPolicy"
need_repo "6C staffFixture"          tests/invariants/support/staff.ts "export async function staffFixture"
need_repo "6C ERR_POS_LIMIT"         packages/contracts/src/errors.ts  "ERR_POS_LIMIT_EXCEEDED"

# ── 6B: the three till-side codes. 6B's migration number is 0063 but its FILE NAME is 6B's to choose,
#    so the literal is searched across the whole migrations directory (§3.4.2's rule, not its guess).
need_dir  "6B pos.shift.own"         packages/db/migrations "pos.shift.own"
need_dir  "6B pos.attendance.clock"  packages/db/migrations "pos.attendance.clock"
need_repo "6B catalogue row"         packages/contracts/permissions.ts "pos.shift.own"

# ── 4B, 1B, 2C: the three registries this slice joins ─────────────────────────────────────────────────
need_repo "4B registerReconcilable"  packages/db/src/ar-ap/reconciliation.ts "export function registerReconcilableSource"
need_repo "4B RECONCILABLE_DIRECTION" packages/db/src/ar-ap/reconciliation.ts "till_banking"
need_repo "1B reportsRouteModule"    apps/api/src/routes/accounting/reports.ts "reportsRouteModule"
need_repo "1B ReportCodeSchema"      packages/contracts/src/accounting/reports.ts "export const ReportCodeSchema"
need_repo "2C MODULE_READ_CODE"      apps/api/src/middleware/require-attachment-read.ts "export const MODULE_READ_CODE"
need_repo "0C seed entry point"        packages/db/src/seed/index.ts "export async function seed"
need_repo "6A effective-date rule"   packages/db/src/sync/apply.ts     "at time zone"

# ── The eighteen contracts amendments this task writes ────────────────────────────────────────────────
need_doc "A1 shift extra keys"        "6D amendment A1"
need_doc "A2 no document.shift_id FK" "6D amendment A2"
need_doc "A3 expected_cash formula"   "6D amendment A3"
need_doc "A4 POS_PERMISSION widened"  "6D amendment A4"
need_doc "A5 report surface"          "6D amendment A5"
need_doc "A6 posFixture shift"        "6D amendment A6"
need_doc "A7 staffFixture members"    "6D amendment A7"
need_doc "A8 role grants"             "6D amendment A8"
need_doc "A9 test 21 location"        "6D amendment A9"
need_doc "A10 no needs_attention"     "6D amendment A10"
need_doc "A11 shifts route module"    "6D amendment A11"
need_doc "A12 no force-close route"   "6D amendment A12"
need_doc "A13 fourth sync array"      "6D amendment A13"
need_doc "A14 till account roles"     "6D amendment A14"
need_doc "A15 series terminal suffix" "6D amendment A15"
need_doc "A16 till_banking_link row"  "6D amendment A16"
need_doc "A17 seedShift options"      "6D amendment A17"
need_doc "A18 MODULE_READ_CODE path"  "6D amendment A18"

if [ "$fail" -ne 0 ]; then
  echo; echo "6D Task 0 gate FAILED."
  echo "  'MISSING (doc)'                   — Step 2 has not been done. Write the amendment."
  echo "  'MISSING (repo)'                  — a reconciliation with the owning plan (§4.18: the written"
  echo "                                      plan is the authority for what it exports). Correct THIS"
  echo "                                      plan's import path or name, and never add a second spelling."
  echo "  'MISSING (repo, OWNED ELSEWHERE)' — a column or literal 6D cannot supply by renaming anything of"
  echo "                                      its own. The line carries its own remedy; follow it, and do"
  echo "                                      NOT rewrite this plan to work around a missing column."
  exit 1
fi
echo "6D Task 0 gate OK."
```

Run: `chmod +x scripts/check/contracts-6d-amendments.sh && bash scripts/check/contracts-6d-amendments.sh` → expect a list of eighteen `MISSING (doc)` lines and `exit 1` on the first run.

- [ ] **Step 2: Write the eighteen amendments into the contracts document.** Each is one paragraph or one row, tagged with its id so the gate can find it.

**A1 — §4.6.5 `app.shift` gains three foreign keys and one index.** *"**6D amendment A1.** §4.6.5's DDL omits three composite keys the §4.6 preamble requires of every register row, and 6D's migration 0070 adds them: `foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id)` (the same key `pos_cashier` and `branch_pos_policy` carry, §4.6.3–§4.6.4), `foreign key (tenant_id, over_short_document_id) references app.document(tenant_id, id)`, and the index `shift_branch_opened_idx on app.shift (company_id, branch_id, opened_at desc)` the Z-report-history parameter shape reads. `opened_principal_id` and `closed_principal_id` keep their plain FK to `app.principal`, which is a `GLOBAL_TABLES` member and therefore exempt from `composite_fk` (§4.1). Everything else in §4.6.5 is implemented verbatim, `id uuid primary key` **without** a `default uuidv7()` included — the id is minted at the till, and the `id_column` linter rule checks only that the column exists (plan0A:2748)."*

**A2 — §4.3.4: the `shift_id` column belongs to 6A's 0061, not to 6D's 0070, and 6D adds no foreign key on it.** *"**6D amendment A2.** §4.3.4's header-additions paragraph assigns `shift_id uuid` to **6D (0070)**. That assignment is superseded: **6A's 0061 adds the column**, because 6A's `applyTicket` step (f) writes `document.shift_id` on every `POS_TICKET` it inserts (6A's Task 11) and 6A's own **Task 0 amendment 6** moves the column into **its Task 4, migration 0061**, for exactly that reason — that amendment is 6A's half of this agreement and the two plans land the same words. A 0061 without it cannot pass 6A's batch suite, so '6A merged and green' — which is 6D's phase gate — already implies the column exists; **6D's Task 0 gate asserts it by literal and, if it is absent, raises against 6A rather than adding it in 0070.** §4.3.4's paragraph is corrected to read `6A (0061)` `terminal_id uuid` (FK `pos_terminal`) **and `shift_id uuid` (no FK)**, with the 6D entry removed. **0070 deliberately adds no foreign key to it, and no later migration in this slice's range does either.** Two facts make a validated key impossible at 0070: a migration cannot backfill the missing parents, because `FORCE ROW LEVEL SECURITY` binds `app_migrator` and a migration file has no `set_config` (hazard 10); and PostgreSQL's referential-integrity checks **bypass** row security, so the constraint's validation scan would see every pre-6D `POS_TICKET` written between 6B's release and 6D's, each naming a shift that has no row. The reference is enforced instead in the apply path — `assertShiftKnown` in `packages/db/src/sync/shifts.ts` refuses a ticket whose `shiftId` names no shift **of that terminal**, so no new orphan is created — exactly the shape §4.3.4 already uses for the `item_id` and `tax_code_id` slots. The key belongs in a **contract** migration in a later slice (§3.4.7), once every till has re-sent the shift-open messages 6A held in its outbox; this slice does not schedule it and no plan may add it without amending this paragraph."*

**A3 — §4.6.5's `expected_cash` sentence is completed.** *"**6D amendment A3.** §4.6.5 says `expected_cash` is *'derived server-side: opening_float + Σ cash tenders − Σ paid-outs/safe-drops of this shift's posted tickets'*. 6D implements that as **one read of `app.ledger_entry`**, which is both simpler and the thing test 21 actually asserts: `expected_cash = opening_float + Σ(debit − credit)` over `ledger_entry` rows whose `account_id` is the company's `1110` Cash in till, whose `currency` **equals `shift.currency`** (the count is a physical count in one currency, so a base-currency sum would tie in the wrong money), and whose `document_id` belongs to a **posted** document with this `shift_id` and a `document_type.code` other than `TILL_OVER_SHORT`. Every cash movement of the shift is then included by construction — tickets, refunds, and ⚠️ OD-10's paid-outs, safe drops and bankings — and no formula has to be extended when OD-10 lands. `TILL_OVER_SHORT` is excluded because it is posted *from* this figure. `over_short = counted_cash − expected_cash`, **positive is over**, unchanged."*

**A4 — §4.2.5 / §3.6.2: 6A's `POS_PERMISSION` gains two members.** *"**6D amendment A4.** `packages/db/src/sync/authority.ts` (6A) is the one home of the `pos.*` code literals reachable from `packages/db`, which may not import `@dulja/contracts` (§3.1). 6D widens it additively by `shiftOwn: \"pos.shift.own\"` (**6B's** catalogue row, consumed here) and `shiftCloseAny: \"pos.shift.close_any\"` (**6D's** row), and adds the two matching `null` entries to `OVERRIDE_SUBJECT_FOR`, whose type is `Readonly<Record<PosPermissionCode, …>>` and therefore does not compile without them. `null` is the right value in both: no supervisor's override lets a cashier close a shift they may not close — that is an authority gap, not a limit (6C's decision (d))."*

**A5 — §4.16.3 gains 6D's two report readers.** *"**6D amendment A5.** The Phase 1 report surface 7B/7C re-express grows by 6D's two, in `packages/db/src/reports/pos.ts`, exported from `@dulja/db`: `zReport(tx: Sql, params: ZReportParams): Promise<ZReport[]>` with `ZReportParams { companyId: string; shiftId?: string; branchId?: string; from?: string; to?: string; limit: number; cursor?: { openedAt: string; shiftId: string } | null }`, and `salesByCashier(tx: Sql, params: SalesByCashierParams): Promise<SalesByCashierRow[]>` with `SalesByCashierParams { companyId: string; from: string; to: string; branchId?: string; cashierPrincipalId?: string; limit: number; cursor?: { cashierPrincipalId: string } | null }`. The row shapes `ZReport`, `ZReportTender` and `SalesByCashierRow` are §4.16.3 members like `TrialBalanceRow`. **One code, two parameter shapes:** `pos.z_report` with `shiftId` returns exactly one Z-report; with `from`/`to` it returns the shift history §4.16.1 names, which is why the reader returns an array in both cases. 7C re-expresses both codes over these same functions and re-runs 6D's tie-out test unchanged. **6D adds no `DatasetId` member** — `shift` and `till_event` are 7C's rows in the frozen union (§4.16.2)."*

**A6 — §4.17.1: `posFixture` opens a shift.** *"**6D amendment A6.** 6A's `tests/invariants/support/pos.ts` exports a module-level `SHARED_SHIFT_ID` and writes it into every ticket's `document.shift_id`, noting that `app.shift` is 6D's and 'the constant is what keeps 6D's first task from having to re-key every 6A test'. 6D therefore has `posFixture` insert **one open `app.shift` row at that id** — terminal `f.terminal.terminalId`, cashier `f.cashierId`, `opening_float` `\"0.0000\"`, the company's base currency — and exposes it as `PosFixture.shiftId`. Every existing 6A and 6C test keeps passing unchanged, and `assertShiftKnown` (amendment A2) has a parent to find. No other member of `PosFixture` changes."*

**A7 — §4.17.1: `StaffFixture` gains two members.** *"**6D amendment A7.** 6C's `tests/invariants/support/staff.ts` builds branch A and B with three cashiers. 6D adds `shiftA: string` (an open shift at branch A on `terminalA`, opened by `cashierA`) and `openShift(opts: { cashierPrincipalId: string; openingFloat?: string }): Promise<string>`, so a test needing a second shift does not re-derive the insert. Both are additive; no existing member changes."*

**A8 — §3.6.4: the two role grants 6D records.** *"**6D amendment A8.** `pos.shift.close_any` → **`branch_manager`** (spec:2160 gives the branch manager 'closing any shift and the Z-report'). `pos.report.read` → **`branch_manager`** (the same clause) **and `auditor`** (spec:2163 'Read everything financial: ledger, documents, reports, stock and costs … export'; the code is `mutating: false`, so R7 holds and `role-seed` stays green). It is **not** granted to `accountant`, `user` or `cashier`: spec:2161 gives the cashier no report code at all, and the accountant's row names no POS report — a tenant that wants head office to read Z-reports clones a role under `admin.role.manage`, which is what §4.2.1's 'a tenant may clone one' is for. `admin`'s array is computed from `PERMISSIONS` and gains both automatically."*

**A9 — §3.7.3: acceptance test 21's file is `tests/invariants/`, not `tests/e2e/`.** *"**6D amendment A9.** §3.7.3 places tests 20 and 21 in `tests/e2e/`. Test 21 is a **data** assertion — a Z-report compared to `ledger_entry` to the cent — which needs Testcontainers, the real `applyBatch` and the real `postDocument`, and no browser; a Playwright test cannot read `app.ledger_entry` at all. It therefore lives at **`tests/invariants/pos-shift-reconciliation.test.ts`**, beside the other invariant suites, and `tests/e2e/` carries only the screen half, which is 6D's ⚠️ OD-24 task and re-runs **test 23**, not test 21. Test 20 is unaffected and stays where 6A put it."*

**A10 — §4.10.3: a refused shift, till event or cash event writes no `needs_attention` row.** *"**6D amendment A10.** 6A's `app.needs_attention` has `client_ref uuid not null` and `unique (company_id, client_ref)`, and its `payload` is documented as the whole **ticket**. A `ShiftOpenClose` is acked by `\"<shiftId>:<kind>\"`, which is not a uuid, so it cannot be keyed there at all; and for the uuid-keyed message kinds the queue would mix two different objects under one `payload` contract. 6D therefore writes **no** `needs_attention` row for any non-ticket message: a refused message answers `rejected`, `drainOutbox` acks only refs that appear in a result array, and the till's outbox row stays pending (spec:1337) — which is the recovery path, and is 'never lost' without widening 6A's queue. A later slice that wants a shop-visible queue for these adds a `ref text` column and a `kind` discriminator to `needs_attention`, which is a §4.10.3 amendment."*

**A11 — §4.2.7: one new route module.** *"**6D amendment A11.** Append to the module-path register: `/v1/companies/:companyId/shifts` · `shiftRoutes` (module const `shiftRouteModule`) · **6D** · `pos.report.read`. Sub-paths: `GET …/shifts`, `GET …/shifts/{shiftId}`, `GET …/shifts/{shiftId}/till-events`. It gets **one** `PROBES` entry keyed on its `RouteModule.path` (hazard 31). The two report `GET`s — `…/reports/pos.z_report` and `…/reports/pos.sales_by_cashier` — are **sub-paths of 1B's existing `reports` module** and add no key; `reportsRouteModule.permissions` gains `pos.report.read` in the same PR, because that module now evaluates two codes."*

**A12 — §4.6.5: there is no back-office force-close, and the gap is recorded.** *"**6D amendment A12.** A shift is closed **only** by a `ShiftOpenClose { kind: \"close\" }` arriving over `/v1/sync/tickets`, because §4.14 fixes `TILL_OVER_SHORT.approval.post = pos.sync.push` and R8 (spec:2179) keeps a human out of the `pos_terminal` role: a branch manager's request-path close could not post the difference. `pos.shift.close_any` is therefore evaluated **on the sync path** — the closer is `ShiftOpenClose.cashierPrincipalId`, and closing a shift someone else opened requires it while closing one's own requires `pos.shift.own` — which is exactly spec:2161's distinction between the cashier who 'may not close others' shifts' and the branch manager who may. **Known gap:** a till destroyed mid-shift leaves an open shift no one can close. Closing it needs a request-gated route whose posting runs under `systemContext` from a job, and `JOBS` is a closed sixteen-name registry (§4.2.6) — so the fix is a new job name and an amendment there, not a route a plan can add quietly."*

**A13 — ⚠️ §4.10.1 gains a fourth message array (OD-10 only).** *"**6D amendment A13.** If OD-10 = yes, `TicketBatch` gains `cashEvents: TillCashMsg[]` and `BatchResult` gains `cashEventResults: MessageResult[]`, with `export interface TillCashMsg { clientRef: string; shiftId: string; kind: \"paid_out\" | \"safe_drop\" | \"banking\"; amount: { amount: string; currency: string }; cashierPrincipalId: string; supervisorPrincipalId: string | null; occurredAt: string; reference: string | null; fromSafe: boolean }`, acked by `clientRef`. `outbox.kind`'s CHECK in §4.10.6 becomes `('ticket','shift','till_event','cash_event')`. Every edit is additive: a client that sends three arrays and reads three arrays is unaffected, `applyBatch`'s signature is unchanged (`TicketBatchInput.cashEvents?: unknown[]` is optional), and `SyncStore.markAcked` matches a fourth result array the same way it matches the other three. **The alternative — back-office routes for the three till-cash documents — was rejected because §4.14 fixes their `approval.post` at `pos.sync.push`, so only a terminal can post them.** If OD-10 = no, nothing in this amendment is written and §4.10.1 is untouched."*

**A14 — §4.15: what `1130` and `5130` actually carry.** *"**6D amendment A14.** `1130` Cash in transit is debited by ⚠️ `TILL_SAFE_DROP` (cash out of a drawer into the branch safe, still the company's and not yet the bank's) and credited by ⚠️ `TILL_BANKING` when the deposit is made from the safe (`TillCashMsg.fromSafe = true`); a banking straight from the drawer credits `1110` instead. **`TILL_BANKING` always debits `1100` Bank**, which is what makes it visible to 4B's `ledgerLegSource` — that source lists from the ledger leg on the **statement's own** `bank_account_id`, so a banking with no `1100` leg could never be matched and test 39's 'the reconciled balance equals the bank account's ledger balance' clause could not hold. The row for `1130` stays seeded **unconditionally**, exactly as §4.15 already says, so a manual banking journal has an account to clear when OD-10 = no. `5130` Till paid out is debited by ⚠️ `TILL_PAID_OUT`, tagged BRANCH, and is dropped with the type if OD-10 = no."*

**A15 — §4.14: 6A's `resolveSeries` suffixes *every* document that carries a `terminal_id`, so the four till series are `TOS-<terminal code>`, not `TOS`.** *"**6D amendment A15.** §4.14 gives `TILL_OVER_SHORT` the series `TOS` and only `POS_TICKET` the note 'series per terminal'. 6A's `resolveSeries` (`packages/db/src/posting/issue.ts`) is **generic** — it joins `app.pos_terminal` on `document.terminal_id` and returns `` `${policySeries}-${code}` `` whenever that join finds a row, with no test on the document type — so any document 6D posts through the sync path with `terminal_id` set is numbered in a **per-terminal** series. That is the right behaviour and 6D does not change it: two tills closing the same day would otherwise contend on one `document_series` advisory lock for their over/short documents, and a gapless series per terminal is what makes `TOS-<code>` #1…#n a readable audit trail of one drawer. The register's `Series` column is therefore the **policy** series (`policy.numbering.series`), and `document.series` for a terminal-borne document is that string plus `-<pos_terminal.code>`. This binds `TOS` and ⚠️ `TPO`/`TSD`/`TBK` alike. A slice asserting a bare `TOS` on a posted document has read the register and not `resolveSeries`."*

**A16 — ⚠️ §4.6.1 and §3.5.3 gain the `till_banking_link` row (OD-10 only).** *"**6D amendment A16.** §2.7's 6D card names `0071_create_till_banking_link.sql` but neither §4.6.1's register nor §3.5.3's linter table has a row for the table, so 6D fixes both here. **§4.6.1:** `till_banking_link` | 6D / 0071 ⚠️ | `company_id`, `branch_id uuid not null`, `banking_document_id uuid not null unique`, `shift_id uuid not null`, `bank_account_id uuid not null`, `from_safe boolean not null`, `value_date date not null`, `amount numeric(19,4) not null check (amount > 0)`, `currency char(3) not null`, `reference text`; Form A `branch_isolation`; audited; immutable **after** insert is *not* claimed — the row is never updated but carries no `forbid_change` trigger, because 4B's `bank_match` (not this row) records a match and the row has nothing left to change. **§3.5.3:** `till_banking_link` | 6D | `NO_ID_TABLES` — | `NO_CREATED_AT_TABLES` — | `AUDIT_EXEMPT` — | `IMMUTABLE` —. **Why the table exists at all rather than reading the `TILL_BANKING` document:** `Reconcilable` (§4.8.3) needs `bankAccountId` and `valueDate` per banking, and a `TILL_BANKING` document reaches its bank account only through its `1100` ledger leg — which is exactly what 4B's `ledgerLegSource` reads, and 6D's source copies that shape. The link row carries the **shift** the banking came from, which no ledger leg does, and that is the one fact the Z-report's banking line and the DoD's 'ties to the ledger' clause both need. If OD-10 = no, neither row is written and §4.6.1/§3.5.3 are untouched."*

**A17 — §4.17: `seedShift` gains three additive options.** *"**6D amendment A17.** The register's 6D row reads `seedShift(db, s, opts: { terminalId; cashierPrincipalId; openingFloat? }) → string`. 6D ships it as `seedShift(db, s, opts: { terminalId; cashierPrincipalId; openingFloat?; currency?; branchId?; shiftId? }) → string` — three optional additions, no existing parameter or return changed, recorded here in the same PR as §4.17's own rule requires. Each is load-bearing: **`shiftId`** lets amendment A6's `posFixture` open the shift at 6A's `SHARED_SHIFT_ID` rather than minting a new one every ticket would then have to be re-keyed against; **`branchId`** lets amendment A7's `StaffFixture.openShift` open a shift at branch A when the `Seed`'s default is the HQ value; **`currency`** lets Task 3's wrong-currency cases build a shift whose `currency` differs from the message's without touching the company. Defaults are `openingFloat "0.0000"`, `currency "MYR"`, `branchId s.hq`, `shiftId` a fresh `uuidv7`. **The helper inserts under `withTenant(db.migrator, s.tenant, s.system, …)` and not under `db.rw`/`s.human`**, which is the second half of this amendment and is not a style choice: `app.shift` carries Form A's restrictive `branch_isolation` policy, `app.actor_in_branch` is true only for a `kind = 'system'` principal or a principal with a live `role_assignment` in the company, and `seedTenant` grants `s.human` nothing (§4.1, pinned) — a policy declared with `using` alone is also applied as `with check` on INSERT, so an `s.human` insert fails with `new row violates row-level security policy for table \"shift\"`. §4.17's preamble sentence 'helpers insert on `db.rw` inside `withTenant(sql, s.tenant, s.human, …)` unless the row is catalog-level' gains a second exception clause: **or unless the row's table carries a `branch_isolation` policy** (6C's `seedCashier` writes its `app.principal` half the same way, 6C Task 2 Step 8)."*

**A18 — §4.5.8: `MODULE_READ_CODE` lives at the middleware path 2C actually used.** *"**6D amendment A18.** §4.5.8's prose places `MODULE_READ_CODE` in `apps/api/src/routes/accounting/attachments.ts`. **2C shipped it in `apps/api/src/middleware/require-attachment-read.ts`** (2c:133's file tree, 2c:1796's Produces block, 2c:1992's implementation, and 2c:1818 — its own test's import), and 3A added its `inventory` row there. §4.18 makes the written plan the authority for what it exports, so §4.5.8's path is corrected to the middleware file and every later slice that adds a row — **6D's `pos`, 8B's `hr`** — edits that file. A slice following the old path would declare a *second* `MODULE_READ_CODE` in a file that has none, leave the real map without its row, and ship a module whose attachment downloads keep hitting 2C's default deny while every test of the new map passes. That is hazard 32 (one literal, one home) applied to a map rather than to a code."*

- [ ] **Step 3: Re-run the gate.**

Run: `bash scripts/check/contracts-6d-amendments.sh`
Expected: `6D Task 0 gate OK.` and exit 0. **Neither a `MISSING (repo):` nor a `MISSING (repo, OWNED ELSEWHERE):` line is ever fixed by editing the gate.** The first means the owning plan shipped a different spelling; §4.18 makes that plan the authority, so correct this plan's import path or name and re-run. The second means a column or literal is genuinely absent from another slice's file: the line carries its own remedy (a raise against the owning slice), and rewriting 6D to work around a missing column is the failure that branch exists to prevent.

- [ ] **Step 4: Commit.**

```bash
git add scripts/check/contracts-6d-amendments.sh docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
git commit -m "docs(contracts): 6D amendments A1-A18 and the phase-6d gate script [6D T0]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Migration 0070 — `app.shift`, `app.till_event`, Form A branch isolation, and `seedShift`

**Files**
- Create: `packages/db/migrations/0070_create_shift_till_event.sql`, `packages/db/migrations/0070.down.sql`, `packages/db/src/schema/shift.ts`, `packages/db/src/schema/till-event.ts`, `packages/db/test/shift.test.ts`
- Modify: `packages/db/src/lint-schema.ts` (two set memberships), `packages/db/test/fixtures.ts` (`seedShift`), `packages/db/src/index.ts` (two mirror re-exports)

**Interfaces**

- Consumes: `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app.forbid_change`, `app.actor_in_branch` (6C, migration 0068), `app.company`, `app.dimension_value`, `app.pos_terminal`, `app.document`, `app.principal` (plan0A); `startDb`, `Db`, `Seed`, `withTenant` (test), `uuidv7`, `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down`, `listApplied`, `MIGRATIONS_DIR`, `schemaFingerprint` (§4.1); `seedTenantV2` (1A), `seedBranch` (0D), `seedTerminal` (6A), `seedEmployee`, `seedCashier` (6C).
- Produces:

```ts
// packages/db/test/fixtures.ts — §4.17's ONE 6D row, in the register's uniform (db, s, opts?) shape.
/** An OPEN shift on `terminalId`, opened by `cashierPrincipalId`. Returns the shift id (the uuidv7 a till
 *  would have minted). Closing goes through the sync path, never a fixture — §4.17's note on this row. */
export async function seedShift(
  db: Db, s: Seed,
  opts: { terminalId: string; cashierPrincipalId: string; openingFloat?: string; currency?: string; branchId?: string; shiftId?: string },
): Promise<string>;

// packages/db/src/schema/shift.ts and till-event.ts — Drizzle mirrors, READS only (§3.4.9)
export const shift: PgTable;
export const tillEvent: PgTable;
```

- [ ] **Step 1: Write the failing test `packages/db/test/shift.test.ts`.**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedShift, seedTenantV2, type Seed } from "./fixtures";
import { seedBranch } from "./fixtures";
import { seedTerminal } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("migration 0070 — app.shift and app.till_event (§4.6.5, §4.6.1)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let terminalA: { terminalId: string; principalId: string };
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
    terminalA = await seedTerminal(db, a, { code: "T1" });
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  it("the shipped schema still has zero linter violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("app.shift keeps the till's own id — there is no uuidv7() default (§4.6.5)", async () => {
    const [col] = await db.admin<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'shift' and column_name = 'id'`;
    expect(col!.column_default).toBeNull();
  });

  it("an open shift round-trips, and over_short is NULL until the close", async () => {
    const id = await seedShift(db, a, { terminalId: terminalA.terminalId, cashierPrincipalId: a.human, openingFloat: "200.0000" });
    const [row] = await db.admin<{
      opening_float: string; currency: string; counted_cash: string | null;
      expected_cash: string | null; over_short: string | null; closed_at: string | null; branch_id: string;
    }[]>`select opening_float::text, currency, counted_cash::text, expected_cash::text,
                over_short::text, closed_at::text, branch_id::text from app.shift where id = ${id}`;
    expect(row!.opening_float).toBe("200.0000");
    expect(row!.currency).toBe("MYR");
    expect(row!.counted_cash).toBeNull();
    expect(row!.expected_cash).toBeNull();
    expect(row!.over_short).toBeNull();
    expect(row!.closed_at).toBeNull();
    expect(row!.branch_id).toBe(a.hq);
  });

  it("tenant B cannot see tenant A's shift or till event (spec:106, test 12)", async () => {
    const shiftId = await seedShift(db, a, { terminalId: terminalA.terminalId, cashierPrincipalId: a.human });
    const eventId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, terminalA.principalId, (tx) => tx`
      insert into app.till_event (id, tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                  cashier_principal_id, occurred_at, client_ref)
      values (${eventId}, ${a.tenant}, ${a.company}, ${a.hq}, ${terminalA.terminalId}, ${shiftId},
              'no_sale', ${a.human}, now(), ${await uuidv7(db.admin)})`);

    const seenShifts = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.shift`);
    const seenEvents = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.till_event`);
    expect(seenShifts[0]!.n).toBe(0);
    expect(seenEvents[0]!.n).toBe(0);
  });

  it("till_event is immutable to app_rw: no UPDATE, no DELETE, and the trigger says so", async () => {
    const shiftId = await seedShift(db, a, { terminalId: terminalA.terminalId, cashierPrincipalId: a.human });
    const eventId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, terminalA.principalId, (tx) => tx`
      insert into app.till_event (id, tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                  cashier_principal_id, occurred_at, client_ref)
      values (${eventId}, ${a.tenant}, ${a.company}, ${a.hq}, ${terminalA.terminalId}, ${shiftId},
              'drawer_open', ${a.human}, now(), ${await uuidv7(db.admin)})`);

    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'till_event'
         and privilege_type in ('UPDATE', 'DELETE')`;
    expect(grants).toEqual([]);

    // The trigger is the control even for app_migrator, which holds the privilege.
    await expect(
      withTenant(db.migrator, a.tenant, a.system, (tx) => tx`update app.till_event set kind = 'void' where id = ${eventId}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("a branch manager restricted to branch B sees no shift or till event of branch A (§4.5.6 Form A, test 36)", async () => {
    const branchB = await seedBranch(db, a, { code: "BR-B" });
    const shiftA = await seedShift(db, a, { terminalId: terminalA.terminalId, cashierPrincipalId: a.human });
    expect(shiftA).toBeTruthy();

    // A principal assigned ONLY to branch B. grantCodes creates the role, the assignment and the branch row.
    const { grantCodes } = await import("./fixtures");
    const managerId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${managerId}, 'human', ${"human:mgr:" + a.tenant}, 'Branch B manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${managerId})`;
    });
    // **`pos.ticket.sell` and NOT `pos.report.read`.** `app.role_permission.permission_code` has a real FK
    // to `app.permission(code)` (plan0A:1325), and `pos.report.read` is seeded by migration **0072**, which
    // is Task 2 and a different PR. Granting it here would fail with a foreign-key violation on a task that
    // ships only 0070. What this case needs from the grant is a `role_assignment` restricted to branch B —
    // `app.actor_in_branch` reads assignments, not codes — so any code 6A already seeded does the job.
    await grantCodes(db, a, { codes: ["pos.ticket.sell"], principalId: managerId, roleCode: "bm_b", branchIds: [branchB] });

    const rows = await withTenant(db.rw, a.tenant, managerId, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.shift`);
    expect(rows[0]!.n).toBe(0);
  });

  it("both tables carry a RESTRICTIVE policy named branch_isolation (§4.5.6)", async () => {
    const policies = await db.admin<{ tablename: string; policyname: string; permissive: string }[]>`
      select tablename, policyname, permissive from pg_policies
       where schemaname = 'app' and tablename in ('shift', 'till_event') and policyname = 'branch_isolation'
       order by tablename`;
    expect(policies.map((p) => `${p.tablename}:${p.permissive}`)).toEqual([
      "shift:RESTRICTIVE", "till_event:RESTRICTIVE",
    ]);
  });

  it("till_event.kind admits exactly no_sale, drawer_open and void (§4.6.1)", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.till_event'::regclass and conname = 'till_event_kind_check'`;
    expect(chk!.def).toContain("'no_sale'");
    expect(chk!.def).toContain("'drawer_open'");
    expect(chk!.def).toContain("'void'");
  });
});
```

Run: `cd packages/db && bun run test -- shift`
Expected: **FAIL** — every case dies in `beforeAll` or on the first statement with `error: relation "app.shift" does not exist`, because migration 0070 has not been written.

- [ ] **Step 2: Write `packages/db/migrations/0070_create_shift_till_event.sql`.**

```sql
-- 0070_create_shift_till_event.sql
-- §4.6.5 app.shift and §4.6.1 app.till_event — the server side of the till's shift (spec:1331, 1352, 1354).
-- Both tables take Form A of the branch_isolation family (§4.5.6): a NOT NULL branch key, attached in the
-- table's own migration from 6C onward (§3.5.1 step 7), which is what makes the branch_isolation_policy
-- linter rule a build failure rather than a review note.

-- ── 1. app.shift ───────────────────────────────────────────────────────────────────────────────────────
-- `id` carries NO default: it is the uuidv7 the till minted when the drawer was counted in, so re-sending
-- the `open` message is idempotent on the primary key (§4.10.1). The `id_column` linter rule checks only
-- that the column exists (plan0A:2748), so the absent default is legal and deliberate.
create table app.shift (
  id                      uuid primary key,
  tenant_id               uuid not null references app.tenant(id),
  company_id              uuid not null,
  branch_id               uuid not null,
  terminal_id             uuid not null,
  -- ATTRIBUTION, never `*_by`: on a shift synced up by a terminal the acting principal is the TERMINAL, and
  -- a stamped `opened_by` would silently replace the cashier with it — SAH-044 in reverse (§3.3).
  opened_principal_id     uuid not null references app.principal(id),
  opened_at               timestamptz not null,
  opening_float           numeric(19,4) not null,
  currency                char(3) not null,
  closed_at               timestamptz,
  closed_principal_id     uuid references app.principal(id),
  -- The ONLY cash figure the till sends (§4.10.1 ShiftOpenClose.countedCash).
  counted_cash            numeric(19,4),
  -- Derived server-side from app.ledger_entry at close (contracts §4.6.5 + amendment A3). Never sent.
  expected_cash           numeric(19,4),
  -- counted_cash - expected_cash. POSITIVE IS OVER, negative is short.
  over_short              numeric(19,4),
  over_short_document_id  uuid,
  created_at              timestamptz not null default now(),
  constraint shift_close_is_atomic check (
    (closed_at is null) = (closed_principal_id is null)
    and (closed_at is null) = (counted_cash is null)
    and (closed_at is null) = (expected_cash is null)
    and (closed_at is null) = (over_short is null)),
  constraint shift_opening_float_non_negative check (opening_float >= 0),
  constraint shift_over_short_is_the_difference check (
    over_short is null or over_short = counted_cash - expected_cash),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)              references app.dimension_value(tenant_id, id),   -- amendment A1
  foreign key (tenant_id, terminal_id)            references app.pos_terminal(tenant_id, id),
  foreign key (tenant_id, over_short_document_id) references app.document(tenant_id, id)           -- amendment A1
);

-- The Z-report history parameter shape (§4.16.1: "the same code with a date-range parameter") reads this.
create index shift_branch_opened_idx on app.shift (company_id, branch_id, opened_at desc);
-- The close path and every report resolve a shift's tickets through document.shift_id, which 6A's 0061
-- added with no key (amendment A2 records why 0070 adds none either). The index is what keeps that read
-- from being a sequential scan of app.document on every close.
create index document_shift_idx on app.document (shift_id) where shift_id is not null;

call app_meta.enable_tenant_rls('app.shift');
call app_meta.attach_audit('app.shift');
-- Form A (§4.5.6): a NOT NULL branch key. `shift` is not in AUDIT_EXEMPT — a close is an UPDATE, and its
-- before/after images are the record of who declared what count.
create policy branch_isolation on app.shift as restrictive
  using (app.actor_in_branch(company_id, branch_id));

-- ── 2. app.till_event ──────────────────────────────────────────────────────────────────────────────────
-- Append-only events on the ticket stream (spec:1354). IMMUTABLE and AUDIT_EXEMPT (§3.5.3): an audit row
-- per event would be a byte-for-byte second copy of a row nothing may ever change.
create table app.till_event (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  branch_id              uuid not null,
  terminal_id            uuid not null,
  shift_id               uuid not null,
  kind                   text not null,
  ticket_document_id     uuid,
  cashier_principal_id   uuid not null references app.principal(id),
  supervisor_principal_id uuid references app.principal(id),
  occurred_at            timestamptz not null,
  client_ref             uuid not null,
  created_at             timestamptz not null default now(),
  constraint till_event_kind_check check (kind in ('no_sale', 'drawer_open', 'void')),
  -- A void is an event ABOUT a ticket; the other two are about the drawer and name none.
  constraint till_event_ticket_only_on_void check (kind = 'void' or ticket_document_id is null),
  -- §4.6.1 declares client_ref globally unique. It is the till's own uuidv7, so a collision is not a real
  -- event, and the global key is what makes re-sending the message idempotent with no company in hand.
  unique (client_ref),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)          references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id)        references app.pos_terminal(tenant_id, id),
  foreign key (tenant_id, shift_id)           references app.shift(tenant_id, id),
  foreign key (tenant_id, ticket_document_id) references app.document(tenant_id, id)
);

create index till_event_shift_idx on app.till_event (shift_id, occurred_at);

call app_meta.enable_tenant_rls('app.till_event');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3).
create trigger till_event_immutable before update or delete on app.till_event
  for each row execute function app.forbid_change();
revoke update, delete on app.till_event from app_rw;
create policy branch_isolation on app.till_event as restrictive
  using (app.actor_in_branch(company_id, branch_id));
```

- [ ] **Step 3: Write `packages/db/migrations/0070.down.sql`.**

```sql
-- 0070.down.sql — reverse dependency order (§3.4.5). `drop table` takes the table's own policies,
-- triggers and indexes with it; the two indexes on OTHER tables must be named explicitly.
drop table if exists app.till_event;
drop index if exists app.document_shift_idx;
drop table if exists app.shift;
```

- [ ] **Step 4: Edit the two linter sets in `packages/db/src/lint-schema.ts` to exactly the state §3.5.3 declares.**

`till_event` joins **both** `AUDIT_EXEMPT` and `IMMUTABLE`; `shift` joins **neither** and no other set changes. `NO_ID_TABLES` and `NO_CREATED_AT_TABLES` are untouched — `NO_CREATED_AT_TABLES` is derived from `NO_ID_TABLES` (plan0A:2702) and no slice rewrites that derivation.

```ts
// packages/db/src/lint-schema.ts — the two one-word additions, in the sets 6C last edited.
export const AUDIT_EXEMPT = new Set([
  // … every existing member, unchanged …
  "till_event",     // 6D — append-only ticket-stream events; an audit row would duplicate an immutable row (§3.5.3)
]);

export const IMMUTABLE = new Set([
  // … every existing member, unchanged …
  "till_event",     // 6D — append-only (spec:1354); app_rw holds neither UPDATE nor DELETE (§3.5.3)
]);
```

- [ ] **Step 5: Write the two Drizzle mirrors.**

```ts
// packages/db/src/schema/shift.ts — a READ mirror (§3.4.9). Every write in this slice is a tagged template.
import { char, index, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const shift = app.table("shift", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  terminalId: uuid("terminal_id").notNull(),
  openedPrincipalId: uuid("opened_principal_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  openingFloat: numeric("opening_float", { precision: 19, scale: 4 }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedPrincipalId: uuid("closed_principal_id"),
  countedCash: numeric("counted_cash", { precision: 19, scale: 4 }),
  expectedCash: numeric("expected_cash", { precision: 19, scale: 4 }),
  overShort: numeric("over_short", { precision: 19, scale: 4 }),
  overShortDocumentId: uuid("over_short_document_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  branchOpenedIdx: index("shift_branch_opened_idx").on(t.companyId, t.branchId, t.openedAt),
}));
```

```ts
// packages/db/src/schema/till-event.ts
import { index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const tillEvent = app.table("till_event", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  terminalId: uuid("terminal_id").notNull(),
  shiftId: uuid("shift_id").notNull(),
  kind: text("kind").notNull(),
  ticketDocumentId: uuid("ticket_document_id"),
  cashierPrincipalId: uuid("cashier_principal_id").notNull(),
  supervisorPrincipalId: uuid("supervisor_principal_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  clientRef: uuid("client_ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  shiftIdx: index("till_event_shift_idx").on(t.shiftId, t.occurredAt),
}));
```

Re-export both from `packages/db/src/index.ts` beside the existing schema mirrors.

- [ ] **Step 6: Add `seedShift` to `packages/db/test/fixtures.ts` — §4.17's one 6D row, appended, editing nothing above it (hazard 9).**

```ts
/**
 * An OPEN shift, in the uniform (db, s, opts?) shape §4.17 fixes. Returns the shift id — the uuidv7 a till
 * would have minted when the drawer was counted in, so a test may pass it as `Ticket.shiftId` directly.
 *
 * There is deliberately no `closeShift` fixture: closing derives `expected_cash` from the ledger and posts a
 * document, and a fixture that wrote those columns by hand would let a test pass against arithmetic the
 * production path never ran. Closing goes through `applyBatch` (§4.17's note on this row).
 */
export async function seedShift(
  db: Db,
  s: Seed,
  opts: {
    terminalId: string; cashierPrincipalId: string;
    openingFloat?: string; currency?: string; branchId?: string; shiftId?: string;
  },
): Promise<string> {
  const id = opts.shiftId ?? (await uuidv7(db.admin));
  // `db.migrator` + `s.system`, NOT `db.rw` + `s.human` — the one deviation from §4.17's preamble, recorded
  // as amendment A17 and forced by the table's own policy. `app.shift` carries Form A's RESTRICTIVE
  // `branch_isolation`, `app.actor_in_branch` (6C) is true only for a `kind = 'system'` principal or one
  // with a live `app.role_assignment` in the company, and `seedTenant` grants `s.human` nothing (§4.1,
  // pinned). A policy declared with `using` alone is applied as `with check` on INSERT too, so an
  // `s.human` insert here fails with `new row violates row-level security policy for table "shift"` —
  // in `beforeAll`, before any assertion of the test that called it. 6C's `seedCashier` writes its
  // `app.principal` half exactly this way (6C Task 2 Step 8) and this is the same reason.
  await withTenant(db.migrator, s.tenant, s.system, (tx) => tx`
    insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id,
                           opened_principal_id, opened_at, opening_float, currency)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.branchId ?? s.hq}, ${opts.terminalId},
            ${opts.cashierPrincipalId}, now(), ${opts.openingFloat ?? "0.0000"}, ${opts.currency ?? "MYR"})
    on conflict (id) do nothing`);
  return id;
}
```

**Why the system principal, in one sentence a reviewer can check:** `app.actor_in_branch(company, branch)` is the whole of Form A's predicate, and its first disjunct is `p.kind = 'system'`. The **production** path needs no such privilege — `applyShiftOpen` (Task 3) runs as the *terminal* principal, and `createTerminal` (6A) gives every terminal a `role_assignment` plus a `role_assignment_branch` at its own branch, so the terminal satisfies the second disjunct honestly. It is only the fixture, acting as a `Seed`'s ungranted human, that has no branch at all.

**If you see `new row violates row-level security policy for table "shift"`** anywhere in this slice, the fix is never `opts` and never the policy: it is that the insert is running as a principal with no `role_assignment` in the company. Task 13's stop-and-raise table carries the same line.

- [ ] **Step 7: Run the suite.**

Run: `cd packages/db && bun run test -- shift`
Expected: **8 passed.**

Run: `cd packages/db && bun run test -- schema-lint privileges`
Expected: green. `schema-lint`'s "the shipped schema has zero violations" case is the real gate for the two new tables — a missing `branch_isolation` policy, a missing `audit_row` trigger on `shift`, or an `UPDATE`/`DELETE` grant left on `till_event` each reports there by table name. **`privileges.test.ts`'s pinned DELETE list is unchanged** — 2B is the only slice that ever extends it (§3.5.4) and 6D grants no DELETE.

Run: `cd packages/db && bun run test -- privileges`
Expected: the up → down → up reversibility case passes, proving `0070.down.sql` drops every object `0070` created (§3.4.6) and that the schema fingerprint — which since 0B also covers enum labels and `app_rw` grants — is byte-identical.

- [ ] **Step 8: Commit (PR 1 of 2, 3 with OD-10 — one migration per PR, spec:2057).**

```bash
git add packages/db/migrations/0070_create_shift_till_event.sql packages/db/migrations/0070.down.sql \
        packages/db/src/schema/shift.ts packages/db/src/schema/till-event.ts \
        packages/db/src/lint-schema.ts packages/db/src/index.ts \
        packages/db/test/fixtures.ts packages/db/test/shift.test.ts
git commit -m "feat(db): migration 0070 — app.shift and app.till_event with Form A branch isolation [6D T1]

app.shift keeps the till's own uuidv7 as its primary key, so re-sending an open
message is idempotent; opened_principal_id and closed_principal_id are attribution
and never *_by (contracts §3.3). app.till_event is append-only: IMMUTABLE, AUDIT_EXEMPT,
and app_rw holds neither UPDATE nor DELETE.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0072 — `pos.shift.close_any` and `pos.report.read`, the role grants, `POS_PERMISSION`, and the `pos` attachment row

**This task ships the whole permission surface of the slice in one PR, and nothing else in the slice compiles without it.** `PERMISSION["pos.report.read"]` is a type error until the catalogue row exists (§4.5.8's closing paragraph), so Task 7's routes, Task 4's close gate and this task's `MODULE_READ_CODE` row all wait on it. It is the second of the slice's three migration PRs.

**Files**
- Create: `packages/db/migrations/0072_seed_permission_phase6d.sql`, `packages/db/migrations/0072.down.sql`
- Modify: `packages/contracts/permissions.ts` (two catalogue rows), `packages/db/seed/roles.ts` (three grants), `packages/db/src/sync/authority.ts` (two `POS_PERMISSION` members, two `OVERRIDE_SUBJECT_FOR` entries), **`apps/api/src/middleware/require-attachment-read.ts`** (the `pos` row of `MODULE_READ_CODE` — that path and **not** the `routes/accounting/attachments.ts` one §4.5.8's prose names; Task 0 amendment **A18** records why, and Task 0's gate asserts the export at the middleware path), `apps/api/test/middleware/require-attachment-read.test.ts` (2C's suite — its first case asserts `Object.keys(MODULE_READ_CODE)` exactly, so the key list grows by `"pos"` there in the same commit), `packages/db/test/permission-catalogue.test.ts` (two appended cases)

**Interfaces**

- Consumes: `app.permission` (plan0A, global, no RLS); `PERMISSION`, `PERMISSIONS`, `PermissionCode` (§4.2.5, 0B); `ROLES` and the `roles.ts` shape (§4.2.5, 0D); `MODULE_READ_CODE`, `DocumentTypeModule` (§4.5.8, 2C); `POS_PERMISSION`, `OVERRIDE_SUBJECT_FOR`, `PosPermissionCode` (6A, `packages/db/src/sync/authority.ts`); `up`, `down`, `listApplied` (§4.1).
- Produces:

```ts
// packages/contracts/permissions.ts — the two rows §3.6.2 assigns 6D, and no others.
// pos.shift.close_any  mutating: true   phase: "6D"
// pos.report.read      mutating: false  phase: "6D"

// packages/db/src/sync/authority.ts — 6A's const, widened additively (Task 0 amendment A4).
export const POS_PERMISSION = {
  /* … 6A's eight members, unchanged … */
  shiftOwn:      "pos.shift.own",        // 6B's catalogue row, CONSUMED here — never re-seeded
  shiftCloseAny: "pos.shift.close_any",  // 6D's own row
} as const;
```

- [ ] **Step 1: Write the failing test — two appended cases in `packages/db/test/permission-catalogue.test.ts`.**

Append inside the existing top-level `describe`; do not touch a case above (§3.7.3's rule applied to a shared test file).

```ts
  // ── 6D ───────────────────────────────────────────────────────────────────────────────────────────────
  it("6D's two codes are in app.permission with the right mutating flags (§3.6.2)", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission
       where code in ('pos.shift.close_any', 'pos.report.read')
       order by code`;
    expect(rows).toEqual([
      { code: "pos.report.read", module: "pos", mutating: false },
      { code: "pos.shift.close_any", module: "pos", mutating: true },
    ]);
  });

  it("the pos module now has sixteen codes and not one more (§3.6.2's total)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.permission where module = 'pos'`;
    expect(n!.n).toBe(16);
  });
```

Run: `cd packages/db && bun run test -- permission-catalogue`
Expected: **FAIL** — the first case reports `expected [] to deeply equal [ { code: 'pos.report.read', … }, … ]` because migration 0072 has not been written; the second reports `expected 14 to be 16` (6A's ten plus 6B's three plus 6C's one).

- [ ] **Step 2: Write `packages/db/migrations/0072_seed_permission_phase6d.sql`.**

```sql
-- 0072_seed_permission_phase6d.sql
-- The two permission codes §3.6.2 assigns slice 6D, and no others (hazard 26 — the vocabulary is closed).
-- app.permission is GLOBAL and has no RLS (plan0A:1254), so it is the one table a migration may seed
-- per-row: hazard 10's "a migration sees no tenants" does not bite, because there is no tenant column.
insert into app.permission (code, module, action, mutating, description) values
  -- spec:2160 gives the branch manager "closing any shift and the Z-report". Closing one's OWN shift is
  -- 6B's pos.shift.own; this code is the one that lets a principal close a shift SOMEONE ELSE opened,
  -- which is the exact distinction spec:2161 draws when it says a cashier "may not close others' shifts".
  ('pos.shift.close_any', 'pos', 'close_any', true,
   'Close a POS shift that another principal opened (spec:2160, 2161)'),
  -- The POS report read code. `mutating = false` is load-bearing three ways: R7 (spec:2178) lets it gate a
  -- GET, `role-seed` (§3.6.3) then permits `auditor` to hold it, and §4.5.8's attachment download map can
  -- name it for the `pos` module. A `mutating = true` code here would fail all three.
  ('pos.report.read', 'pos', 'read', false,
   'Read POS reports — the Z-report, Z-report history and sales by cashier (§4.16.1)')
on conflict (code) do update
  set module = excluded.module, action = excluded.action,
      mutating = excluded.mutating, description = excluded.description;
```

- [ ] **Step 3: Write `packages/db/migrations/0072.down.sql`.**

```sql
-- 0072.down.sql — delete exactly the two codes the up inserted (§3.4.5). app.role_permission rows
-- referencing them are per-tenant seed data and are removed by re-running the roles loader, not here:
-- a migration cannot see a tenant's rows (hazard 10), and the FK is ON DELETE RESTRICT, so a down run
-- against a database with the roles pack applied fails LOUDLY rather than silently orphaning a grant.
-- That is the intended behaviour: reversing a shipped permission is an operational act, not a rollback.
delete from app.permission where code in ('pos.shift.close_any', 'pos.report.read');
```

- [ ] **Step 4: Add the two catalogue rows to `packages/contracts/permissions.ts`.**

```ts
  // ── pos (6D) ──────────────────────────────────────────────────────────────────────────────────────
  { code: "pos.shift.close_any", module: "pos", action: "close_any", mutating: true, phase: "6D",
    description: "Close a POS shift that another principal opened (spec:2160, 2161)" },
  { code: "pos.report.read", module: "pos", action: "read", mutating: false, phase: "6D",
    description: "Read POS reports — the Z-report, Z-report history and sales by cashier (§4.16.1)" },
```

`close_any` and `read` are both in the §3.6.1 action vocabulary already (`close_any` is one of the five the C2 resolution added precisely for this row), so the DB CHECK `^[a-z_]+\.[a-z_]+\.[a-z_]+$` and the closed action list both hold with no edit.

- [ ] **Step 5: Add the three role grants to `packages/db/seed/roles.ts` (Task 0 amendment A8).**

```ts
// packages/db/seed/roles.ts — three array entries; no existing entry is edited.
  branch_manager: {
    permissions: [
      /* … every existing code, unchanged … */
      "pos.shift.close_any",   // 6D — spec:2160 "closing any shift and the Z-report"
      "pos.report.read",       // 6D — the second half of the same clause
    ],
  },
  auditor: {
    permissions: [
      /* … every existing code, unchanged … */
      "pos.report.read",       // 6D — spec:2163 "Read everything financial: ledger, documents, reports…"
    ],
  },
```

**Why `auditor` may hold it and why nothing else does.** `role-seed` (§3.6.3) fails the build if `auditor` holds any `mutating = true` code; `pos.report.read` is `false`, so the rule holds. It is **not** granted to `accountant`, `user` or `cashier`: spec:2161 gives the cashier no report code at all, and the accountant's row (spec:2157) names no POS report — a tenant that wants head office to read Z-reports clones a role under `admin.role.manage`, which is what §4.2.1's "a tenant may clone one" exists for. `admin`'s array is **computed** from `PERMISSIONS` minus `pos.ticket.sell` and the `pos.sync.*` pair (§3.6.4), so it gains both codes with no edit — and `pos_terminal` holds exactly `pos.sync.pull` and `pos.sync.push` and is never widened, which is why Task 4 checks the *cashier's* authority through `principal_has` and not the terminal's.

`INCOMPATIBLE_PAIRS` needs no new entry: neither code pairs with an existing one under R6 (spec:2177). A branch manager who may close any shift and read the Z-report is one job, not two — the segregation R6 protects is maker/checker on money out, and a shift close posts a difference the manager did not choose the figure for.

- [ ] **Step 6: Widen `POS_PERMISSION` and `OVERRIDE_SUBJECT_FOR` in `packages/db/src/sync/authority.ts` (amendment A4).**

```ts
// packages/db/src/sync/authority.ts — 6A's file, extended additively. `packages/db` may not import
// @dulja/contracts (§3.1), which is why the pos.* literals have a db-tier home at all; this is 3A's
// INVENTORY_PERMISSION precedent and not a second catalogue.
export const POS_PERMISSION = {
  ticketSell:            "pos.ticket.sell",
  ticketDiscount:        "pos.ticket.discount",
  ticketReturn:          "pos.ticket.return",
  ticketReturnBlind:     "pos.ticket.return_blind",
  ticketVoid:            "pos.ticket.void",
  ticketOverride:        "pos.ticket.override",
  customerCreate:        "pos.customer.create",
  needsAttentionResolve: "pos.needs_attention.resolve",
  // ── 6D ──
  /** 6B's catalogue row, CONSUMED here. The code the closer of their OWN shift must hold (spec:2161). */
  shiftOwn:              "pos.shift.own",
  /** 6D's own row. The code the closer of SOMEONE ELSE'S shift must hold (spec:2160). */
  shiftCloseAny:         "pos.shift.close_any",
} as const;
export type PosPermissionCode = (typeof POS_PERMISSION)[keyof typeof POS_PERMISSION];

export const OVERRIDE_SUBJECT_FOR: Readonly<
  Record<PosPermissionCode, "discount" | "void" | "blind_return" | "price_override" | null>
> = {
  "pos.ticket.sell": null,
  "pos.ticket.discount": "discount",
  "pos.ticket.return": null,
  "pos.ticket.return_blind": "blind_return",
  "pos.ticket.void": "void",
  "pos.ticket.override": null,
  "pos.customer.create": null,
  "pos.needs_attention.resolve": null,
  // ── 6D: `null` in both, and it is a decision, not an omission ──
  // A supervisor's override does not make a principal a shift closer. 6C's decision (d) draws the line:
  // an override lifts a LIMIT, and "may I close this drawer at all" is an AUTHORITY question. A cashier
  // handed a supervisor PIN to close a colleague's till would produce a TILL_OVER_SHORT attributed to
  // the wrong human, which is SAH-044 with extra steps.
  "pos.shift.own": null,
  "pos.shift.close_any": null,
};
```

`OVERRIDE_SUBJECT_FOR`'s type is `Readonly<Record<PosPermissionCode, …>>`, so the two entries are not optional: adding the members to `POS_PERMISSION` without them is a compile error, which is exactly the property amendment A4 records.

- [ ] **Step 7: Add the `pos` row to `MODULE_READ_CODE` (§4.5.8's one-line edit, owned by this slice).**

**The file is `apps/api/src/middleware/require-attachment-read.ts`.** §4.5.8's prose names `routes/accounting/attachments.ts`; 2C shipped the map in the middleware file (2c:1796's Produces, 2c:1992's implementation, 2c:1818's test import) and 3A added `inventory` there. §4.18 makes 2C's file the authority, Task 0 amendment **A18** corrects §4.5.8, and Task 0's gate line `need_repo "2C MODULE_READ_CODE" apps/api/src/middleware/require-attachment-read.ts` is the mechanical check. **Editing the routes file instead would declare a second `MODULE_READ_CODE` in a file that has none** — every test of the new map would pass while `pos` attachment downloads kept hitting 2C's default deny.

```ts
// apps/api/src/middleware/require-attachment-read.ts — 2C's map, third row. 3A added `inventory`;
// 8B adds `hr` and the map is then complete at four (§4.5.8).
export const MODULE_READ_CODE: Readonly<Partial<Record<DocumentTypeModule, PermissionCode>>> = {
  accounting: PERMISSION["accounting.ledger.read"],
  inventory: PERMISSION["inventory.stock.read"],
  // 6D. §4.14 makes POS_TICKET and the four TILL_* types `module: "pos"`, and until this row existed a
  // `pos` attachment download hit 2C's default deny. That was the safe direction and needed no
  // compensating work — POS tickets carry no attachments before 6D — but the window closes here.
  pos: PERMISSION["pos.report.read"],
};
```

`PERMISSION["pos.report.read"]` compiles only because Step 4 added the catalogue row; before it, `PermissionCode` does not contain the string and the line is a type error. That ordering is the whole reason §4.5.8 assigns this row to the slice that seeds the code.

Append the matching case to **2C's** suite in the same commit, because its first case pins the key list exactly (2c:1822):

```ts
// apps/api/test/middleware/require-attachment-read.test.ts — 2C wrote the first case as
// `expect(Object.keys(MODULE_READ_CODE)).toEqual(["accounting"])`; 3A widened it to add "inventory".
// 6D widens it again, in the order the rows are written in the file, and 8B appends "hr".
  it("the pos module maps to pos.report.read (6D, §4.5.8 amendment A18)", () => {
    expect(Object.keys(MODULE_READ_CODE)).toEqual(["accounting", "inventory", "pos"]);
    expect(MODULE_READ_CODE.pos).toBe(PERMISSION["pos.report.read"]);
    // 8B's row is not here yet, and 2C's "every other module is undefined" case must still hold for it.
    expect(MODULE_READ_CODE.hr).toBeUndefined();
  });
```

- [ ] **Step 8: Run the suites.**

Run: `cd packages/db && bun run test -- permission-catalogue`
Expected: **the two new cases pass**, and every earlier case is untouched. The suite's own bidirectional assertion — that `(code, module, mutating)` in `app.permission` equals the set `permissions.ts` exports — is the real gate: a typo in either Step 2 or Step 4 fails it naming the code.

Run: `bun run lint:rules`
Expected: **green — every rule, including `permission-catalogue`.**

**Why it is green in this very commit, and not at Task 5.** 0D's implemented rule (`scripts/lint/rules/permission-catalogue.ts`) walks **every string literal** of every file under `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` and `packages/db/src` and marks a catalogue code referenced when any literal contains it; the `requirePermission`/`principalHas`/`PERMISSION[...]` node walk is the *other* direction only (a reference naming no catalogue code). **Step 6 wrote both literals into `packages/db/src/sync/authority.ts`, and Step 9's `git add` includes that file**, so `pos.shift.close_any` and `pos.report.read` are both evaluated from this commit onward. 6A relies on the identical property for eight of its eleven codes and states it in the same words (6A Task 5 Step 5); §4.18 makes both 0D and 6A authorities and they agree.

**If you nonetheless see a `permission-catalogue` violation here**, its text will be 0D's — `N catalogue code(s) evaluated by no route or job handler: <codes> (spec §4.2 …)`. That means `authority.ts` was not staged with the migration, or Step 6's member was written as a computed value rather than a bare literal. **Fix the file, never the rule and never the catalogue row**: `permission-catalogue.test.ts` compares `app.permission` (seeded by 0072) against what `permissions.ts` exports, so moving the row to a later commit makes that suite red instead.

Run: `bun run --cwd packages/db test -- privileges`
Expected: the up → down → up reversibility case passes for 0072 as well as 0070 (§3.4.6), proving `0072.down.sql` deletes exactly the two rows.

- [ ] **Step 9: Commit (PR 2 of 2, 3 with OD-10 — the permission migration and every consumer of its two codes).**

This commit is made **here, at the end of this task**, and nothing about it is deferred: `authority.ts`'s two literals are in it, so `lint:rules` is green (Step 8), and `permission-catalogue.test.ts`'s bidirectional check is green because the migration and `permissions.ts` land together. PR 2 continues with Tasks 3–8; this is its head commit.

```bash
git add packages/db/migrations/0072_seed_permission_phase6d.sql packages/db/migrations/0072.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        packages/db/src/sync/authority.ts \
        apps/api/src/middleware/require-attachment-read.ts \
        apps/api/test/middleware/require-attachment-read.test.ts \
        packages/db/test/permission-catalogue.test.ts
git commit -m "feat(db): migration 0072 — pos.shift.close_any and pos.report.read [6D T2]

The pos module reaches its §3.6.2 total of sixteen codes. branch_manager gets
both (spec:2160); auditor gets the read code only (spec:2163, mutating: false so
R7 holds). POS_PERMISSION gains shiftOwn (6B's row, consumed) and shiftCloseAny,
with null in OVERRIDE_SUBJECT_FOR for both: an override lifts a limit, never an
authority. MODULE_READ_CODE's pos row — in 2C's middleware file, not the routes
path §4.5.8's prose names (amendment A18) — closes 2C's default-deny window.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The shift **open** apply path, the batch ordering, and `assertShiftKnown`

**This is the task that makes 6A's refusal go away.** `refuseUnsupported`'s body for `"shift"` is replaced by real inserts, `applyBatch` is reordered so a close sees its own batch's tickets, and every `POS_TICKET` now has to name a shift the server knows about. The close arithmetic is **Task 5** — this task ships `open`, the plumbing both halves share, and a **`applyShiftClose` stub whose body Task 5 replaces**, so the diff a reviewer reads is "the batch changed shape" and not "the batch changed shape and learned to do money". The stub is not decoration: `applyBatch`'s `3c` loop calls `applyShiftClose` in this task, and a task that imported a function no file exports would not typecheck and could not be committed green (Global Constraint 18).

**Files**
- Create: `packages/db/src/sync/shifts.ts`, `packages/db/test/sync/shifts.test.ts`
- Modify: `packages/db/src/sync/apply.ts` (the ordering, `refuseUnsupported`'s shift half, `applyTicket` step (c′)), `packages/db/src/sync/index.ts` and `packages/db/src/index.ts` (re-exports), `packages/db/test/sync/apply.test.ts` (**one** case edited, one `seedShift` line added), `tests/invariants/support/pos.ts` (amendment A6)

**Interfaces**

- Consumes: `applyBatch`, `TicketBatchInput`, `TicketInput`, `TerminalApplyContext`, `MessageOutcome`, `SyncError`, `SyncErrorCode`, `classify` (6A, `packages/db/src/sync/apply.ts` — `classify` stays private to that file and this task calls it from there, not from `shifts.ts`); `withTenant`, `TenantContext` (§4.2.2); `Money`, `currency` (§4.2.1); `app.shift` (Task 1); `seedShift` (Task 1), `seedTerminal` (6A), `seedTenantV2` (1A), `startDb`, `uuidv7`, `withTenant` (test) (§4.1); `posFixture`, `PosFixture`, `SHARED_SHIFT_ID` (6A, `tests/invariants/support/pos.ts`).
- Produces:

```ts
// packages/db/src/sync/shifts.ts — exported from @dulja/db.

/** The db-tier structural twin of §4.10.1's `ShiftOpenClose`. `kind` is `string`, not the union, for the
 *  reason 6A's `TicketInput` gives: `packages/db` may not import `@dulja/contracts` (§3.1), so the wire
 *  narrowing happens in `apps/api` and this layer validates rather than trusts. */
export interface ShiftMessageInput {
  shiftId: string; kind: string; terminalId: string; cashierPrincipalId: string; at: string;
  currency: string;
  openingFloat: { amount: string; currency: string } | null;
  countedCash: { amount: string; currency: string } | null;
}

/** §4.10.1's ack key for a shift message: `"<shiftId>:<kind>"`, one outbox row per transition. */
export function shiftRef(m: unknown): string;

/** The one wire-money reader this slice's apply paths share: `{ amount, currency }` → `Money`, raising
 *  `SyncError("ERR_VALIDATION_FAILED", …)` when the bag is absent, when its currency is not the shift's,
 *  or when its amount is not a decimal. `field` and `at` are message text only. It lives here rather than
 *  in `apply.ts` because the shift open is its first caller, and **Task 9's `till-cash.ts` imports it
 *  from this module** (that file's header names it). Step 6 re-exports it from the barrel. */
export function moneyFromMessage(
  bag: { amount: string; currency: string } | null, field: string, shiftCurrency: string, at: string,
): Money;

export interface ClassifiedShift { index: number; ref: string; msg: ShiftMessageInput }
export interface ShiftClassification {
  opens: ClassifiedShift[];
  closes: ClassifiedShift[];
  /** A message this layer cannot even key or route, already answered. `index` preserves send order. */
  malformed: { index: number; outcome: MessageOutcome }[];
}
/** Pure. Splits `batch.shifts` by `kind` and rejects anything that is neither, WITHOUT touching the
 *  database — so `applyBatch` can plan its order before it opens a savepoint. */
export function classifyShifts(messages: readonly unknown[]): ShiftClassification;

/** Inserts an OPEN shift at the till's own id. Idempotent on the primary key: a re-sent `open` answers
 *  `duplicate` and writes nothing. Never throws for a bad message — it returns a `rejected` outcome. */
export async function applyShiftOpen(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome>;

/** The CLOSE transition. **A stub in this task** — it answers `rejected` with a message naming Task 5 —
 *  because `applyBatch`'s `3c` loop calls it here and a missing export would not typecheck. Task 5 Step 3
 *  replaces the body and this signature does not change. */
export async function applyShiftClose(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome>;

/** Refuses a ticket whose `shiftId` names no shift OF THIS TERMINAL — the application-level enforcement
 *  of the foreign key 0070 deliberately does not create (Task 0 amendment A2). Throws `SyncError`. */
export async function assertShiftKnown(
  sp: Sql, terminal: TerminalApplyContext, shiftId: string,
): Promise<void>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/sync/shifts.test.ts`.**

The close arithmetic gets a **file of its own** in Task 5 (`packages/db/test/sync/shift-close.test.ts`), because it needs `startApi()` and 6C's `staffFixture` while this file needs only `startDb()` — and §3.7.1 fixes `packages/<pkg>/test/*.test.ts` as one file per topic with one container per file. Appending a second `describe` here would start two Postgres containers on every run of this file.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
import { classifyShifts, shiftRef } from "../../src/sync/shifts";
import { seedShift, seedTenantV2, seedTerminal, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** The 4-argument TEST helper (§4.1); the production `withTenant(sql, ctx, fn)` is a different export. */
const asTerminal = <T>(db: Db, s: Seed, principalId: string, fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, s.tenant, principalId, fn as never) as Promise<T>;

describe("6D shift apply — the open path (§4.10.1, contracts amendment A2)", () => {
  let db: Db;
  let s: Seed;
  let t1: { terminalId: string; principalId: string };
  let t2: { terminalId: string; principalId: string };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Shifty");
    t1 = await seedTerminal(db, s, { code: "T1" });
    t2 = await seedTerminal(db, s, { code: "T2" });
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  const openMsg = (shiftId: string, terminalId: string, over: Partial<Record<string, unknown>> = {}) => ({
    shiftId, kind: "open", terminalId, cashierPrincipalId: s.human,
    at: new Date().toISOString(), currency: "MYR",
    openingFloat: { amount: "150.0000", currency: "MYR" }, countedCash: null,
    ...over,
  });

  const apply = (terminal: typeof t1, shifts: unknown[]) =>
    asTerminal(db, s, terminal.principalId, (tx) =>
      applyBatch(tx, { tenantId: s.tenant, actorId: terminal.principalId, companyId: s.company },
        { terminalId: terminal.terminalId, companyId: s.company, branchId: s.hq, principalId: terminal.principalId },
        { terminalId: terminal.terminalId, batchId: crypto.randomUUID(), tickets: [], shifts, tillEvents: [] }));

  it("shiftRef is `<shiftId>:<kind>` and classifyShifts is pure (§4.10.1)", () => {
    expect(shiftRef({ shiftId: "abc", kind: "open" })).toBe("abc:open");
    const c = classifyShifts([
      { shiftId: "a", kind: "open" }, { shiftId: "b", kind: "close" }, { shiftId: "c", kind: "pause" }, 7,
    ]);
    expect(c.opens.map((x) => x.index)).toEqual([0]);
    expect(c.closes.map((x) => x.index)).toEqual([1]);
    expect(c.malformed.map((x) => x.index)).toEqual([2, 3]);
    expect(c.malformed[0]!.outcome.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(c.malformed[0]!.outcome.error!.detail).toContain("pause");
  });

  it("an open message inserts the shift at the TILL'S id and answers accepted", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t1.terminalId)]);
    expect(out.shiftResults).toEqual([{ ref: `${id}:open`, status: "accepted", error: null }]);

    const [row] = await db.admin<{
      terminal_id: string; branch_id: string; opened_principal_id: string;
      opening_float: string; currency: string; closed_at: string | null;
    }[]>`select terminal_id::text, branch_id::text, opened_principal_id::text,
                opening_float::text, currency, closed_at::text from app.shift where id = ${id}`;
    expect(row!.terminal_id).toBe(t1.terminalId);
    expect(row!.branch_id).toBe(s.hq);                       // from the CONTEXT, never the payload
    expect(row!.opened_principal_id).toBe(s.human);          // the cashier, ATTRIBUTED
    expect(row!.opening_float).toBe("150.0000");
    expect(row!.closed_at).toBeNull();
  });

  it("re-sending the same open answers duplicate and writes nothing a second time (zero duplicates)", async () => {
    const id = await uuidv7(db.admin);
    await apply(t1, [openMsg(id, t1.terminalId)]);
    const out = await apply(t1, [openMsg(id, t1.terminalId, { openingFloat: { amount: "999.0000", currency: "MYR" } })]);
    expect(out.shiftResults[0]!.status).toBe("duplicate");

    const [row] = await db.admin<{ opening_float: string; n: number }[]>`
      select opening_float::text, (select count(*)::int from app.shift where id = ${id}) as n
        from app.shift where id = ${id}`;
    expect(row!.n).toBe(1);
    expect(row!.opening_float).toBe("150.0000");             // FIRST write wins; the re-send changed nothing
  });

  it("a shift claiming another terminal is REJECTED, and the row is not created", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t2.terminalId)]);   // sent BY t1, CLAIMING t2
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.shiftResults[0]!.error!.detail).toContain("terminalId");
    const [n] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.shift where id = ${id}`;
    expect(n!.n).toBe(0);
  });

  it("an open with no openingFloat is rejected — a drawer with no counted-in figure is not a shift", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t1.terminalId, { openingFloat: null })]);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.shiftResults[0]!.error!.detail).toContain("openingFloat");
  });

  it("an openingFloat in the wrong currency is rejected — the count and the shift are one money", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t1.terminalId, { openingFloat: { amount: "10.0000", currency: "USD" } })]);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.detail).toContain("USD");
  });

  it("shiftResults come back in SEND order even though opens are applied before closes", async () => {
    const a = await uuidv7(db.admin);
    const b = await uuidv7(db.admin);
    await apply(t1, [openMsg(a, t1.terminalId)]);
    // Send [close a, open b]: the server applies open b FIRST (a close must see its batch's tickets), but
    // the till keys its outbox by ref and reads the array positionally in `markAcked` — a reordered array
    // would ack the wrong row (§4.10.5), which is a lost message with no error anywhere.
    const out = await apply(t1, [
      { ...openMsg(a, t1.terminalId), kind: "close", openingFloat: null, countedCash: { amount: "150.0000", currency: "MYR" } },
      openMsg(b, t1.terminalId),
    ]);
    expect(out.shiftResults.map((r) => r.ref)).toEqual([`${a}:close`, `${b}:open`]);
  });

  it("one bad shift message does not touch its neighbours (savepoint per message)", async () => {
    const good = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(good, t1.terminalId), openMsg("not-a-uuid", t1.terminalId)]);
    expect(out.shiftResults.map((r) => r.status)).toEqual(["accepted", "rejected"]);
    const [n] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.shift where id = ${good}`;
    expect(n!.n).toBe(1);
  });

  it("a ticket naming a shift of ANOTHER terminal is refused by assertShiftKnown (amendment A2)", async () => {
    const foreign = await seedShift(db, s, { terminalId: t2.terminalId, cashierPrincipalId: s.human });
    const { assertShiftKnown } = await import("../../src/sync/shifts");
    await expect(
      asTerminal(db, s, t1.principalId, (tx) =>
        assertShiftKnown(tx as never, { terminalId: t1.terminalId, companyId: s.company, branchId: s.hq, principalId: t1.principalId }, foreign)),
    ).rejects.toThrow(/ERR_CONFLICT_REFERENCE/);
  });

  it("assertShiftKnown accepts a shift of THIS terminal, open or closed", async () => {
    const mine = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    const { assertShiftKnown } = await import("../../src/sync/shifts");
    await expect(
      asTerminal(db, s, t1.principalId, (tx) =>
        assertShiftKnown(tx as never, { terminalId: t1.terminalId, companyId: s.company, branchId: s.hq, principalId: t1.principalId }, mine)),
    ).resolves.toBeUndefined();
  });
});
```

Run: `cd packages/db && bun run test -- sync/shifts`
Expected: **FAIL** at import time —
```
SyntaxError: The requested module '../../src/sync/shifts' does not provide an export named 'classifyShifts'
```
because `packages/db/src/sync/shifts.ts` does not exist. That is the failure to see; if instead you see `relation "app.shift" does not exist`, Task 1 has not merged and you are in the wrong order.

- [ ] **Step 2: Write `packages/db/src/sync/shifts.ts` — the classifier, the open path and `assertShiftKnown`.**

```ts
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { SyncError } from "./enrolment";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

/**
 * The db-tier structural twin of §4.10.1's `ShiftOpenClose`, exactly as 6A's `TicketInput` is the twin of
 * `Ticket`: `packages/db` may not import `@dulja/contracts` (§3.1), so `kind` and `currency` are `string`
 * here and this layer VALIDATES them instead of trusting a narrowing that happened somewhere else.
 */
export interface ShiftMessageInput {
  shiftId: string;
  kind: string;
  terminalId: string;
  cashierPrincipalId: string;
  at: string;
  currency: string;
  openingFloat: { amount: string; currency: string } | null;
  countedCash: { amount: string; currency: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §4.10.1's ack key: `"<shiftId>:<kind>"` — one outbox row per transition, not per shift. Written with the
 * same defensive `String(o.x ?? "")` shape as 6A's private `refOf`, because a message we cannot key must
 * still be acked as *itself*: an empty ref matches no outbox row and the till keeps it pending, which is
 * the safe direction (spec:1337). `refOf` stays in `apply.ts` for the till-event half and this function
 * is the shift half — two callers, one spelling each, and Task 6 makes `apply.ts` delegate to both.
 */
export function shiftRef(m: unknown): string {
  const o = (m ?? {}) as Record<string, unknown>;
  return `${String(o.shiftId ?? "")}:${String(o.kind ?? "")}`;
}

export interface ClassifiedShift { index: number; ref: string; msg: ShiftMessageInput }
export interface ShiftClassification {
  opens: ClassifiedShift[];
  closes: ClassifiedShift[];
  malformed: { index: number; outcome: MessageOutcome }[];
}

/**
 * Pure, and deliberately so: `applyBatch` must know how many opens and closes it has BEFORE it opens a
 * savepoint, because the order it applies them in depends on the split (Step 3). Nothing here touches the
 * database and nothing here validates money — a message whose `kind` is neither `open` nor `close` is the
 * only thing this function refuses, since it is the only defect that makes the message unroutable.
 */
export function classifyShifts(messages: readonly unknown[]): ShiftClassification {
  const opens: ClassifiedShift[] = [];
  const closes: ClassifiedShift[] = [];
  const malformed: { index: number; outcome: MessageOutcome }[] = [];

  messages.forEach((raw, index) => {
    const msg = (raw ?? {}) as ShiftMessageInput;
    const ref = shiftRef(raw);
    if (msg.kind === "open") { opens.push({ index, ref, msg }); return; }
    if (msg.kind === "close") { closes.push({ index, ref, msg }); return; }
    malformed.push({
      index,
      outcome: {
        ref,
        status: "rejected",
        error: {
          code: "ERR_VALIDATION_FAILED",
          detail: `shift message ${index}: kind must be "open" or "close", received ${JSON.stringify(msg.kind)}`,
        },
      },
    });
  });

  return { opens, closes, malformed };
}

/**
 * Every check both transitions share, in one place so `open` and `close` (Task 5) cannot drift.
 *
 * **`terminalId` is checked against the CONTEXT and not merely parsed.** The context comes from the signed
 * request (6A's `terminalAuth`); the payload comes from a till that may be reimaged, cloned or hostile.
 * A shift claiming another terminal would put branch A's cash under branch B's Z-report, and RLS would not
 * catch it because both terminals are in one tenant. This is the message-level twin of hazard 19.
 */
function assertShape(msg: ShiftMessageInput, terminal: TerminalApplyContext): void {
  const at = `shift ${msg.shiftId} (${msg.kind})`;
  if (!UUID_RE.test(String(msg.shiftId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: shiftId is not a uuid — the till mints it (§4.10.1)`);
  }
  if (msg.terminalId !== terminal.terminalId) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: terminalId ${msg.terminalId} is not this terminal (${terminal.terminalId}); a shift may only be`
      + ` opened or closed by the terminal that signed the call`);
  }
  if (!UUID_RE.test(String(msg.cashierPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: cashierPrincipalId is not a uuid`);
  }
  if (!/^[A-Z]{3}$/.test(String(msg.currency))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: currency ${JSON.stringify(msg.currency)} is not a 3-letter code`);
  }
  if (Number.isNaN(Date.parse(String(msg.at)))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: at is not an ISO 8601 timestamp`);
  }
}

/**
 * Reads a `{ amount, currency }` bag off a message as a `Money` in the shift's own currency, or refuses.
 * `Money.of` is 0D's parser and is the only thing in this file that touches a decimal: no `Number()`, no
 * arithmetic on a string, and `no-number-money` (§3.7.5) fires on any of it (Global Constraint 2).
 */
export function moneyFromMessage(
  bag: { amount: string; currency: string } | null, field: string, shiftCurrency: string, at: string,
): Money {
  if (bag === null || bag === undefined) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: ${field} is required on this transition`);
  }
  if (bag.currency !== shiftCurrency) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: ${field} is in ${bag.currency} but the shift is in ${shiftCurrency}; a drawer is counted in one`
      + ` currency and a base-currency figure would tie in the wrong money`);
  }
  try {
    return Money.of(bag.amount, currency(bag.currency));
  } catch {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: ${field}.amount ${JSON.stringify(bag.amount)} is not a decimal`);
  }
}

/**
 * The OPEN transition. Idempotent on the primary key: the id is the uuidv7 the till minted when the drawer
 * was counted in, so `on conflict (id) do nothing` plus a read-back is the whole of "zero duplicates" for
 * this message kind — a re-send after a timeout answers `duplicate` and the first write's `opening_float`
 * stands. Overwriting it on a re-send would let a till change a figure a Z-report has already been built
 * on, which is SAH-020's shape ("the server does not overwrite a figure the shop chose") applied to cash.
 *
 * `branch_id` and `terminal_id` come from `terminal`, never from `msg`: the context is signed and the
 * payload is not. `opened_principal_id` is the cashier from the payload — that is ATTRIBUTION data and the
 * acting principal stays the terminal (hazard 19, §4.6.5's naming note).
 */
export async function applyShiftOpen(
  sp: Sql, _ctx: TenantContext, terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome> {
  const ref = shiftRef(msg);
  assertShape(msg, terminal);
  const at = `shift ${msg.shiftId}`;
  const float = moneyFromMessage(msg.openingFloat, "openingFloat", msg.currency, at);

  // Read first, exactly as 6A's `applyTicket` step (a) does: the read is the common case and the primary
  // key is the race. Both answer `duplicate` and neither writes twice.
  const [existing] = await sp<{ id: string }[]>`
    select id from app.shift where id = ${msg.shiftId} and company_id = ${terminal.companyId}`;
  if (existing) return { ref, status: "duplicate", error: null };

  const inserted = await sp<{ id: string }[]>`
    insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id,
                           opened_principal_id, opened_at, opening_float, currency)
    values (${msg.shiftId}, app.current_tenant(), ${terminal.companyId}, ${terminal.branchId},
            ${terminal.terminalId}, ${msg.cashierPrincipalId}, ${msg.at}::timestamptz,
            ${float.toString()}, ${msg.currency})
    on conflict (id) do nothing
    returning id`;

  // Empty `returning` means a concurrent apply won the primary key — the same `duplicate`, reached the
  // other way. There is no third answer and no error to report: the shift IS open.
  return { ref, status: inserted.length === 1 ? "accepted" : "duplicate", error: null };
}

/**
 * The reference `0070` deliberately does not enforce (Task 0 amendment A2), enforced here instead.
 *
 * Two facts made a validated foreign key impossible in the migration: a migration cannot backfill the
 * missing parents, because `FORCE ROW LEVEL SECURITY` binds `app_migrator` and a migration file has no
 * `set_config` (hazard 10); and PostgreSQL's referential-integrity checks BYPASS row security, so the
 * constraint's validation scan would see every pre-6D `POS_TICKET` written between 6B's release and 6D's,
 * each naming a shift with no row. Refusing here creates no new orphan, which is what a later contract
 * migration will need before it can add the key.
 *
 * **Scoped to the terminal, not merely to the company.** A shift id is a client-minted uuid; two tills in
 * one shop cannot collide on one by accident, but a cloned till could send its neighbour's, and a ticket
 * filed under the wrong drawer is an over/short on both.
 */
export async function assertShiftKnown(
  sp: Sql, terminal: TerminalApplyContext, shiftId: string,
): Promise<void> {
  if (!UUID_RE.test(String(shiftId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `shiftId ${JSON.stringify(shiftId)} is not a uuid`);
  }
  const [row] = await sp<{ id: string }[]>`
    select id from app.shift
     where id = ${shiftId} and company_id = ${terminal.companyId} and terminal_id = ${terminal.terminalId}`;
  if (!row) {
    throw new SyncError("ERR_CONFLICT_REFERENCE",
      `shift ${shiftId} is not a shift of terminal ${terminal.terminalId}; send the ShiftOpenClose "open"`
      + ` message before the tickets of that shift (§4.10.1)`);
  }
}

/**
 * The CLOSE transition — **a stub in this task, replaced whole by Task 5 Step 3.**
 *
 * It exists here because `applyBatch`'s `3c` loop (Step 3) calls it: a task that imported a name no file
 * exported would fail `bun run typecheck` and could not be committed green, and Global Constraint 18
 * requires all five root checks green after every task. The stub answers with an outcome rather than
 * throwing, for the same reason every other message path does — the ref must come back so the till's
 * `markAcked` can match it positionally (§4.10.5) — and it answers `rejected` rather than `duplicate`
 * because the till must keep the outbox row pending and re-send after Task 5 lands (spec:1337).
 *
 * `ERR_VALIDATION_FAILED` and not a new code: Global Constraint 11's list is closed, and this outcome is
 * gone before the slice ships, so inventing an `ERR_SHIFT_*` row for a stub would leave a permanent
 * `ERRORS` entry with no raiser and fail the `error-codes` lint.
 */
export async function applyShiftClose(
  _sp: Sql, _ctx: TenantContext, _terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome> {
  return {
    ref: shiftRef(msg),
    status: "rejected",
    error: {
      code: "ERR_VALIDATION_FAILED",
      detail: "the shift close apply path is 6D Task 5; the till keeps this outbox row and re-sends",
    },
  };
}
```

**Task 3's tests never assert a close's status**, and that is deliberate rather than an oversight: the one case that sends a `close` is the send-order case, which asserts `out.shiftResults.map((r) => r.ref)` and nothing else, because the property under test is that `shiftResults` comes back in **send** order while opens are applied first. Task 5's own suite is where a close's status, columns and posting are asserted, against the real body.

**Why `SyncErrorCode` needs no widening.** `ERR_VALIDATION_FAILED` and `ERR_CONFLICT_REFERENCE` are the two codes this file raises. The first is already in 6A's `SyncErrorCode` union; the second is not, so **add `"ERR_CONFLICT_REFERENCE"` to that union in this step** — it is a one-token widening of a 6A type, it adds no `ERRORS` row (the code has shipped since 0B), and 6A's own `classify` already maps SQLSTATE 23503 to it, so the wire behaviour is identical whether the refusal comes from this function or from the database.

- [ ] **Step 3: Reorder `applyBatch` and wire the shift half — `packages/db/src/sync/apply.ts`.**

The diff is three edits to one function plus one new private helper. Nothing else in `apply.ts` moves.

```ts
// packages/db/src/sync/apply.ts — the imports this task adds.
import {
  applyShiftOpen, applyShiftClose, assertShiftKnown, classifyShifts,
  type ShiftClassification, type ShiftMessageInput,
} from "./shifts";
```

```ts
/**
 * One message, one savepoint, one outcome — the message-kind twin of the per-ticket savepoint above.
 *
 * A shift or till event that fails must not roll back the tickets committed beside it, and must not throw
 * out of `applyBatch`: 6A's `refuseUnsupported` ran OUTSIDE the per-ticket savepoint for exactly that
 * reason (its own comment says a throw there "would 500 the whole batch, losing every accepted ticket in
 * it"), and replacing it with real inserts keeps that property by giving each message a savepoint of its
 * own. **No `needs_attention` row is written** for a non-ticket message (Task 0 amendment A10): a
 * `ShiftOpenClose` is acked by `"<shiftId>:<kind>"`, which is not a uuid, and 6A's queue is keyed
 * `unique (company_id, client_ref uuid)`. The till keeps the outbox row instead, which is the recovery
 * path spec:1337 describes and is "never lost" without widening a table this slice does not own.
 */
async function runMessage(
  tx: Sql, ref: string, body: (sp: Sql) => Promise<MessageOutcome>,
): Promise<MessageOutcome> {
  try {
    return await tx.savepoint((sp) => body(sp));
  } catch (e: unknown) {
    const { code, detail } = classify(e);
    // `classify`'s "DUPLICATE" sentinel is a ticket-level answer (a colliding client_ref on app.document).
    // A message kind reaches its own duplicate answer by reading first, so the sentinel cannot appear
    // here; if it ever does, reporting it as a rejection is the honest answer and the till retries.
    return { ref, status: "rejected", error: { code: code === "DUPLICATE" ? "ERR_CONFLICT_UNIQUE" : code, detail } };
  }
}
```

```ts
export async function applyBatch(
  tx: Sql, ctx: TenantContext, terminal: TerminalApplyContext, batch: TicketBatchInput,
): Promise<BatchOutcome> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`sync-batch:${terminal.terminalId}`}, 0))`;
  const catalogueRevision = await currentCatalogueRevision(tx, terminal.companyId);

  // ── 6D: plan the order before writing anything ───────────────────────────────────────────────────
  // A close derives `expected_cash` from the LEDGER (Task 5), so it must run AFTER the tickets of its own
  // batch: a till that sells its last sale and closes in one payload would otherwise be short by that
  // sale, every time, and the Z-report would tie to nothing. An open must run BEFORE the tickets, because
  // `assertShiftKnown` now requires the parent row. The array positions are kept so `shiftResults` comes
  // back in SEND order — `SyncStore.markAcked` matches refs against the arrays and a reordered array acks
  // the wrong outbox row (§4.10.5).
  const shifts: ShiftClassification = classifyShifts(batch.shifts);
  const shiftOutcomes = new Array<MessageOutcome>(batch.shifts.length);
  for (const m of shifts.malformed) shiftOutcomes[m.index] = m.outcome;

  // 3a. Shift OPENS.
  for (const e of shifts.opens) {
    shiftOutcomes[e.index] = await runMessage(tx, e.ref, (sp) => applyShiftOpen(sp, ctx, terminal, e.msg));
  }

  // 3b. Tickets — 6A's loop, unchanged.
  const results: TicketOutcome[] = [];
  for (const ticket of batch.tickets) {
    /* … 6A's body, byte-for-byte: savepoint, classify, DUPLICATE branch, upsertNeedsAttention … */
  }

  // 3c. Shift CLOSES, after the tickets they must see. (Task 9 inserts the cash-event loop between 3b
  //     and 3c if OD-10 = yes, for the same reason: a banking is cash out of the drawer before the count.)
  for (const e of shifts.closes) {
    shiftOutcomes[e.index] = await runMessage(tx, e.ref, (sp) => applyShiftClose(sp, ctx, terminal, e.msg));
  }

  return {
    batchId: batch.batchId,
    results,
    shiftResults: [...shiftOutcomes],
    // 3d. Till events last: a `void` event names the ticket it is about, and that ticket is applied in 3b.
    tillEventResults: await refuseUnsupported(tx, batch.tillEvents, "till_event"),
    catalogueRevision,
  };
}
```

**`refuseUnsupported` loses its `"shift"` arm and keeps its `"till_event"` arm** until Task 6 replaces that too. Narrow its signature in this step so a stale caller is a compile error rather than a silent refusal:

```ts
// packages/db/src/sync/apply.ts — 6A's function, narrowed. The body is unchanged except the literal.
async function refuseUnsupported(_tx: Sql, messages: unknown[], kind: "till_event"): Promise<MessageOutcome[]> {
  if (messages.length === 0) return [];
  // 6D Task 6 REPLACES this whole body with the real inserts and deletes the function. Deliberately no
  // `to_regclass` capability probe — 6A's comment explains why, and it still holds: this runs outside any
  // savepoint, so a throw here escapes `applyBatch` and 500s the batch.
  return messages.map((m) => ({
    ref: refOf(m, kind),
    status: "rejected" as const,
    error: { code: "ERR_SYNC_MESSAGE_UNSUPPORTED", detail: "app.till_event's apply path is 6D Task 6; the till keeps this row" },
  }));
}
```

And step **(c′)** joins `applyTicket`, immediately after 6A's attendance check (c) and before the authority check (d), because a ticket whose shift is unknown must be refused before anything reads a limit row:

```ts
  // (c′) 6D: the shift must exist and must be THIS terminal's (amendment A2). Placed after (c) so the
  //      attendance refusal keeps its position in 6A's test, and before (d) so a ticket for a foreign
  //      drawer never reaches a policy or a limit.
  await assertShiftKnown(sp, terminal, ticket.shiftId);
```

- [ ] **Step 4: Have `posFixture` open a shift at `SHARED_SHIFT_ID` — `tests/invariants/support/pos.ts` (amendment A6).**

6A's fixture already writes `SHARED_SHIFT_ID` into every ticket's `document.shift_id` and says in its own comment that "the constant is what keeps 6D's first task from having to re-key every 6A test". This is that task.

```ts
// tests/invariants/support/pos.ts — inside posFixture, after the terminal is enrolled and before it
// returns. Two lines of insert and one new member; nothing above is edited (hazard 9).
  // 6D (amendment A6): app.shift is 6D's table and `assertShiftKnown` now requires the parent row for
  // every ticket. Opening one shift at the shared id keeps every existing 6A and 6C test passing with no
  // other change, and gives 6D's own tests a shift they did not have to seed.
  await seedShift(db, s, {
    shiftId: SHARED_SHIFT_ID,
    terminalId: terminal.terminalId,
    cashierPrincipalId: cashierId,
    openingFloat: "0.0000",
    currency: company.baseCurrency,
  });
```

```ts
export interface PosFixture {
  /* … every existing member, unchanged … */
  /** 6D: the OPEN shift at `SHARED_SHIFT_ID` that every ticket this fixture builds belongs to. */
  shiftId: string;
}
```

…returning `shiftId: SHARED_SHIFT_ID` from the object literal. **`opening_float` is `"0.0000"` deliberately:** a non-zero float would make every 6A and 6C assertion about a tender total look wrong to a reader comparing it against the drawer, and 6D's own tests set their own float where the figure matters.

- [ ] **Step 5: Flip 6A's one refusal case, and only that one — `packages/db/test/sync/apply.test.ts`.**

**No fixture line is needed in that file, and this is worth stating because the opposite is the obvious guess.** 6A's batch test imports `posFixture` and `buildTicket` from `tests/invariants/support/pos` by relative path (`../../../../tests/invariants/support/pos`) and `startApi` from `apps/api/test/support/app` — that is 6A's own established shape and §4.18 makes its file the authority. Amendment A6 therefore already gives that file's tickets a parent shift at `SHARED_SHIFT_ID`, because `buildTicket` writes the constant into every ticket it builds. **Read the file's `beforeAll` before editing anything**: if it seeds its own terminal instead of using `posFixture`, add one `seedShift(db, f.s, { terminalId: f.terminal.terminalId, cashierPrincipalId: f.cashierId })` line there and use its return wherever the file writes a ticket's `shiftId`; if it uses `posFixture` as 6A's plan shows, add nothing.

6A's helper is positional — `apply(tickets, shifts = [], tillEvents = [])` — and its fixture members are `f.terminal.terminalId`, `f.terminal.principalId`, `f.cashierId`, `f.s` and `api.db.admin`. The flipped case uses exactly those:

```ts
// packages/db/test/sync/apply.test.ts — 6A wrote this case; 6D rewrites its body and keeps the file's
// every other case byte-for-byte. The title changes because the old one would now be false.
  it("a shift OPEN is applied, and a till event is still refused until Task 6 (§4.10.1)", async () => {
    const id = crypto.randomUUID();
    const out = await apply([], [{
      shiftId: id, kind: "open", terminalId: f.terminal.terminalId, cashierPrincipalId: f.cashierId,
      at: new Date().toISOString(), currency: "MYR",
      openingFloat: { amount: "0.0000", currency: "MYR" }, countedCash: null,
    }], [{ clientRef: crypto.randomUUID() }]);
    expect(out.shiftResults[0]!.status).toBe("accepted");
    expect(out.shiftResults[0]!.error).toBeNull();
    const [n] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.shift where id = ${id}`;
    expect(n!.n).toBe(1);
    // The till-event half is Task 6's; until then it is still refused per message and never dropped.
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_SYNC_MESSAGE_UNSUPPORTED");
  });
```

Task 6 Step 5 edits this case once more, dropping the last two lines and asserting the till event is accepted. **No other case in `apply.test.ts` is edited by this slice**, and the Self-Review's re-run matrix records both edits so a reviewer can check the claim mechanically.

- [ ] **Step 6: Re-export and run everything.**

`packages/db/src/sync/index.ts` gains `export * from "./shifts";` and `packages/db/src/index.ts` already re-exports `./sync`, so `@dulja/db` exposes `applyShiftOpen`, `applyShiftClose` (the stub), `assertShiftKnown`, `classifyShifts`, `shiftRef`, `moneyFromMessage` and the three types with no further edit.

Run: `cd packages/db && bun run test -- sync/shifts`
Expected: **10 passed** — the nine database cases above plus the classifier's purity case.

Run: `cd packages/db && bun run test -- sync/apply`
Expected: green, with the one flipped case now asserting `accepted`. **If any other case fails, that file seeds its own terminal and needs Step 5's conditional `seedShift` line** — do not weaken `assertShiftKnown`; add the fixture line.

Run: `cd tests && bun run test -- pos`
Expected: green. Every 6A and 6C invariant suite passes unchanged because `posFixture` now opens the shared shift.

Run: `bun run typecheck && bun run lint`
Expected: green. Typecheck is green **because Step 2 shipped the `applyShiftClose` stub**; without it the `import { … applyShiftClose … } from "./shifts"` this step's `apply.ts` carries is `TS2305: Module './shifts' has no exported member 'applyShiftClose'`.

Run: `bun run lint:rules`
Expected: **green.** `permission-catalogue` was already satisfied for both of this slice's codes by Task 2 Step 6's literals in `packages/db/src/sync/authority.ts` (Task 2 Step 8 carries the reasoning), so nothing about it changes here. `posting-only-tables` (§3.7.5) is the rule to check in this task: `shifts.ts` inserts into `app.shift`, which is **not** a protected table, and contains no `insert into app.ledger_entry` — the allow-list stays untouched and Task 13 re-asserts that.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/src/sync/shifts.ts packages/db/src/sync/apply.ts packages/db/src/sync/index.ts \
        packages/db/test/sync/shifts.test.ts packages/db/test/sync/apply.test.ts \
        tests/invariants/support/pos.ts
git commit -m "feat(db): the shift open apply path and the batch ordering [6D T3]

applyBatch now applies opens -> tickets -> closes, so a close sees the tickets of
its own batch, and re-emits shiftResults in SEND order because markAcked matches
positionally. A re-sent open answers duplicate on the till's own uuidv7 and the
first opening_float stands. assertShiftKnown enforces the reference 0070 cannot
validate (amendment A2). posFixture opens the shift at SHARED_SHIFT_ID, so every
6A and 6C test passes unchanged; 6A's one refusal case becomes its acceptance case.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The seed pack — `5120`, `1130`, the `TILL_OVER_SHORT` type and its policy, and ADR 0063

**Seed-pack data, not DDL** (§3.4.8, hazard 10): a document type, a posting policy and two chart rows are per-tenant rows, so they arrive through `bun run seed --tenant <id> --only <sub-pack>` and never through a migration. This task ships them **before** Task 5's posting code so that Task 5's first test has a type to post and an account to resolve — the F-21 ordering rule (validate the policy at seed time, not at post time) applied inside one slice.

**Files**
- Create: `packages/db/seed/my/chart-of-accounts/6d-till.json`, `packages/db/seed/my/document-types/TILL_OVER_SHORT.json`, `packages/db/test/seed/6d-pack.test.ts`, `docs/adr/0063-shift-close-derives-expected-cash.md`

**Interfaces**

- Consumes: `PackLoader`, `LoaderContext`, `readPackFile`, `SUB_PACKS` (§4.2.13, 0C); `loadDocumentTypes`, `documentTypesLoader` (§4.3.7, 1A); the chart-of-accounts loader (0C); `validatePolicy`, `validateDocumentTypeSeed` (§4.4.2, 2A); **the permission catalogue as rows of `app.permission`, never as an import of `PERMISSIONS`** — `dependency-rule` forbids `packages/db` naming `@dulja/contracts` (3b:3435, 1a:5105), and Step 1's `beforeAll` reads it; `seedTenantV2` (1A); `startDb`, `Seed`, `withTenant` (§4.1). **This task adds no loader and no sub-pack** — both files land in directories 0C's `SUB_PACKS` already names.
- Produces: the two §4.15 rows `5120` and `1130`; the §4.14 row `TILL_OVER_SHORT`; ADR 0063.

- [ ] **Step 1: Write the failing test `packages/db/test/seed/6d-pack.test.ts`.**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";
import { runSeed } from "../support/seed";

// The repository root, computed locally. There is deliberately NO `packages/db/test/support/repo.ts`:
// §4.17.1 puts `REPO_ROOT` in `tests/support/source.ts` (0B) and `packages/db` may not import the `tests`
// workspace (§3.1), so a shared helper here would be either a dependency-rule violation or a new
// registered name this slice has no row for (hazard 9). 0C's own provisioning test computes it the same
// way (0c:415), and three lines in two files is cheaper than a fourth register entry.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACK = join(REPO_ROOT, "packages/db/seed/my");

/**
 * The permission catalogue `validatePolicy` checks `approval.post` against — read from **`app.permission`
 * rows**, never from an import of `PERMISSIONS`.
 *
 * §3.1's dependency rule pins `packages/db` to `@dulja/domain`, and `scripts/lint/rules/dependency-rule.ts`
 * runs over every import under `packages/**` — test files included, which is why `no-bare-db` has to
 * name `packages/db/test/**` on an allow-list at all (§3.7.5). `import { PERMISSIONS } from
 * "@dulja/contracts/permissions"` here is therefore a `dependency-rule` violation and Task 13 Step 4
 * requires `bun run lint:rules` green. **3B met this exact need and solved it this exact way** (3b:3435,
 * citing 1a:5105): *"the permission catalogue **as rows of `app.permission`, not as an import of
 * `PERMISSIONS`** — `dependency-rule` forbids `packages/db` naming `@dulja/contracts`"*. `app.permission`
 * is global and un-RLS'd (plan0A:1254), so `db.admin` reads it with no tenant context.
 */
let catalogue: string[];

describe("6D seed pack — 6d-till.json and TILL_OVER_SHORT.json (§4.14, §4.15)", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "TillPack");
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code);
  }, 240_000);
  afterAll(async () => { await db.stop(); });

  it("6d-till.json holds exactly the two rows §4.15 seeds unconditionally, in the frozen shape", () => {
    const rows = JSON.parse(readFileSync(join(PACK, "chart-of-accounts/6d-till.json"), "utf8")) as {
      code: string; nameEn: string; nameAr: string; type: string;
    }[];
    expect(rows.map((r) => r.code).sort()).toEqual(["1130", "5120"]);
    // The code format rule of §4.15: four digits, first digit === the account_type's enum position.
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.code[0]).toBe({ asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[r.type]);
      expect(r.nameAr.length).toBeGreaterThan(0);
    }
    // 6A's three tender accounts are NOT here — 6A seeds them (hazard 33) and two files must not collide.
    const text = readFileSync(join(PACK, "chart-of-accounts/6d-till.json"), "utf8");
    for (const foreign of ["1110", "1120", "2200", "1100"]) expect(text).not.toContain(foreign);
  });

  it("TILL_OVER_SHORT.json is a valid §4.3.7 envelope whose policy validates against the catalogue", () => {
    const env = JSON.parse(readFileSync(join(PACK, "document-types/TILL_OVER_SHORT.json"), "utf8"));
    expect(validateDocumentTypeSeed(env)).toEqual({ ok: true, errors: [] });
    expect(validatePolicy(env.policy, catalogue)).toEqual({ ok: true, errors: [] });
    expect(env.module).toBe("pos");                       // §4.14's Module column — the §4.5.8 gate
    expect(env.policy.numbering.series).toBe("TOS");      // the POLICY series; resolveSeries suffixes it (A15)
    expect(env.policy.approval.post).toBe("pos.sync.push");
    expect(env.policy.inventory.effect).toBe("none");
    expect(env.policy.tax.applies).toBe(false);
    expect(env.policy.dimensions.required).toEqual(["BRANCH"]);
  });

  it("the policy names NO account by code — every leg resolves from the line (hazard 33)", () => {
    const text = readFileSync(join(PACK, "document-types/TILL_OVER_SHORT.json"), "utf8");
    expect(text).not.toMatch(/"code"\s*:\s*"[1-5][0-9]{3}"/);
    const env = JSON.parse(text);
    for (const rule of env.policy.lines) {
      if (rule.account?.from === "company.fx_rounding_account_id") continue;
      expect(rule.account).toEqual({ from: "line.account" });
    }
  });

  it("applying the pack creates both accounts, and every code the till path resolves is present", async () => {
    // The whole chart sub-pack, in the order §3.4.8 fixes: 0C's base, then 6A's tenders, then 6D's.
    await runSeed(db, s, "chart-of-accounts");
    await runSeed(db, s, "document-types");

    // `a.type`, NOT `a.account_type`. `app.account_type` is the ENUM TYPE's name (plan0A:1484); the COLUMN
    // is `type app.account_type not null` (plan0A:1492), and §3.2 forbids renames, so no migration adds a
    // second spelling. Every other written plan uses `type` (1b:2779, 4b:2169, 5a:4676).
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ code: string; type: string }[]>`
      select code, type::text as type from app.account
       where company_id = ${s.company} and code in ('1100','1110','1120','1130','2200','5120')
       order by code`);
    expect(rows.map((r) => r.code)).toEqual(["1100", "1110", "1120", "1130", "2200", "5120"]);
    expect(rows.find((r) => r.code === "1130")!.type).toBe("asset");
    expect(rows.find((r) => r.code === "5120")!.type).toBe("expense");
  });

  it("re-applying the pack is idempotent on (company_id, code) and on (document_type_id, version)", async () => {
    await runSeed(db, s, "chart-of-accounts");
    await runSeed(db, s, "document-types");
    const [n] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company} and code = '5120'`);
    expect(n!.n).toBe(1);
    const [p] = await withTenant(db.rw, s.tenant, s.human, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.posting_policy pp
        join app.document_type dt on dt.id = pp.document_type_id
       where dt.code = 'TILL_OVER_SHORT' and dt.company_id = ${s.company}`);
    expect(p!.n).toBe(1);
  });
});
```

`runSeed(db, s, subPack)` is **0C's existing test helper** for driving the seed CLI's loader seam against a Testcontainers database (§4.2.13); it is imported from `packages/db/test/support/seed.ts` and this slice adds nothing to it.

Run: `cd packages/db && bun run test -- seed/6d-pack`
Expected: **FAIL** — the first two cases die with `ENOENT: no such file or directory, open '…/seed/my/chart-of-accounts/6d-till.json'`.

- [ ] **Step 2: Write `packages/db/seed/my/chart-of-accounts/6d-till.json`.**

```json
[
  {
    "code": "1130",
    "nameEn": "Cash in transit",
    "nameAr": "نقد في الطريق",
    "type": "asset"
  },
  {
    "code": "5120",
    "nameEn": "Till over/short",
    "nameAr": "زيادة/نقص الصندوق",
    "type": "expense"
  }
]
```

**No `parentCode`, and that is a decision.** The obvious guesses — `"1000"` for `1130` and `"5000"` for `5120` — are both **wrong**: §4.15 registers `1000` as the **leaf** "Cash on hand" and `5000` as the **leaf** "Cost of goods sold", both seeded by 0C, and hanging a child off a leaf gives the chart tree a leaf with children. §4.15 says a presentation parent is marked `isGroup: true` and that group codes are *unregistered by that table*, so the only correct parent for these two rows is whichever `isGroup` row `0c-base.json` happens to carry — a code this plan cannot name without reading a file 0C owns and §4.15 does not register. Omitting the field is legal (`parentCode?` is optional in the §4.15 file shape) and it is the honest state: a top-level leaf in the chart, grouped for presentation by **7A's** financial-statement layouts, which is where account grouping actually belongs. **An engineer who wants the rows nested may add `parentCode` after reading `packages/db/seed/my/chart-of-accounts/0c-base.json` and picking the `isGroup: true` row whose `type` matches** — the asset group for `1130`, the expense group for `5120` — and nothing in this slice depends on the choice: `resolveAccountByCode` (Task 5) filters `is_group = false` and reads `code`, never a parent.

**Two rows and not three.** `5130` Till paid out is ⚠️ OD-10's and lands in Task 9, which edits this file. `1130` is seeded **unconditionally even when OD-10 = no**, exactly as §4.15 already says: 4B's bank reconciliation must have an account to clear when a shop banks its takings through a manual journal, and an account that exists with a zero balance costs nothing while an account that does not exist makes the journal unpostable. `1110`, `1120` and `2200` are **6A's** rows in `6a-pos-tenders.json` and `1100`/`1000`/`5000` are **0C's** in `0c-base.json`; none is repeated here, and Step 1's third assertion is the mechanical proof (hazard 32 — two files seeding one code is the failure the per-slice file layout exists to prevent).

- [ ] **Step 3: Write `packages/db/seed/my/document-types/TILL_OVER_SHORT.json`.**

```json
{
  "code": "TILL_OVER_SHORT",
  "nameEn": "Till Over/Short",
  "nameAr": "زيادة/نقص الصندوق",
  "module": "pos",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "TILL_OVER_SHORT",
    "direction": "internal",
    "requires": ["attributed_to"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "TOS", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "TILL_OVER_SHORT" },
    "approval": { "required": false, "approve": null, "post": "pos.sync.push" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

**Six decisions in that file, each of which a reader would otherwise have to reconstruct.**

1. **The `lines` block is JOURNAL's, verbatim** (§4.3.7). Two `each_line` rules keyed on `line.kind = "account"`, addressing `{ from: "line.account" }` and taking `line.debit` / `line.credit`. That is deliberate and is the whole of hazard 33's discharge here: **no `account: { code }` literal appears**, so the *service* resolves `1110` and `5120` when it builds the lines (Task 5) and the policy has nothing to resolve for a tenant. A policy that named the two codes would have to name them in the right order for the right sign, and the sign is a per-close fact.
2. **`requires: ["attributed_to"]` and not `"client_ref"`.** A `TILL_OVER_SHORT` is minted by the server at close time and has no till-minted client ref; it *does* have a human — the cashier who declared the count — and a difference nobody is attributed to is unauditable (spec:1324). `warehouse` is not required: no stock moves.
3. **`tax.applies: false`.** A till discrepancy is not a supply. `computeDocumentTax` (5A) is never reached, which is also why this type appears nowhere in 5A's return.
4. **`inventory.effect: "none"`.** The §4.4.1 conditional that makes `warehouse` and `costing` required does not fire, so the policy needs neither and `applyMovements` (§4.7.2) plans nothing.
5. **`approval.required: false`, `post: "pos.sync.push"`.** §4.5.1 makes `draft → issued` legal only when `approval.required` is false, and a maker-checker on a drawer count would mean a supervisor approving every close. `pos.sync.push` is the code R2 evaluates **inside** the posting transaction against the terminal, which is what makes Task 0 amendment A12 true: only a terminal can post this type, so there is no back-office force-close.
6. **`reversal.producesType: "TILL_OVER_SHORT"`.** A close corrected by a supervisor reverses into another over/short with negated magnitudes (D13) — the same shape as every other internal correction and needing no second type. `reverseDocument` reads this block from the **pinned** policy on the original document (§4.3.1, 2A amendment A8), so a later policy version cannot change what a past close reverses into.

**`policyVersion: 1`, not 2.** 1A's JOURNAL file is seeded as `posting_policy.version = 2` because Plan 0A's `seedTenant` fixture already wrote a version 1 for JOURNAL. `TILL_OVER_SHORT` has no fixture history, so its first row is version 1 (§4.3.7's "two numbers, one word" note: the `"version": 1` *inside* `policy` is the schema version and is unrelated).

- [ ] **Step 4: Apply the pack in the two places the slice needs it applied.**

```bash
# The local Testcontainers path every test above uses — no owner account, no staging (hazard 5's local half).
bun run --cwd packages/db seed --tenant "$TEST_TENANT_ID" --only chart-of-accounts
bun run --cwd packages/db seed --tenant "$TEST_TENANT_ID" --only document-types
```

Expected output, from 0C's loader: `chart-of-accounts: 2 created, 0 updated (6d-till.json)` and `document-types: TILL_OVER_SHORT created, policy v1 created`. A second run prints `0 created, 2 updated` and `TILL_OVER_SHORT unchanged, policy v1 updated` — the §3.4.8 upsert shapes (`on conflict do nothing` on the type, `on conflict (document_type_id, version) do update` on the policy).

**Owner-account equivalent (hazard 5).** *Owner provides:* nothing for this task — the pack is repository data. *Verify on staging after the phase deploys:* `bun run --cwd packages/db seed --tenant "$STAGING_TENANT_ID" --only chart-of-accounts document-types` prints the same two lines against `$DATABASE_URL`. *Until a staging database exists (OD-19):* the same command against `startDb()` prints them, which is Step 1's last two cases.

- [ ] **Step 5: Write ADR 0063 — a proposal, because it fixes money semantics (spec:95, §3.8).**

```markdown
# 0063 — A shift close derives `expected_cash` from the ledger, and the till sends only the count

- Status: **Proposed** (money semantics — spec:95 requires this be asked, not implemented first)
- Date: 2026-09-08
- Slice: 6D
- Supersedes / Amends: completes the `expected_cash` sentence of contracts §4.6.5 (amendment A3)

## Context

`app.shift` carries three cash figures: `opening_float` (declared at open), `counted_cash` (declared at
close) and `expected_cash` (what the drawer should hold). `over_short = counted_cash − expected_cash`,
positive is over. §4.6.5 described `expected_cash` as "opening_float + Σ cash tenders − Σ paid-outs and
safe-drops of this shift's posted tickets" — a formula over *ticket* data.

Two ways to obtain it were available.

**(a) Sum the tender lines.** Read `document_line` where `kind = 'tender'` and
`custom_fields.method = 'cash'` for every posted document of the shift.

**(b) Read the ledger.** Sum `debit − credit` on the company's `1110` Cash in till over the shift's posted
documents, in the shift's own currency.

## Decision

**(b).** `expected_cash = opening_float + Σ(debit − credit)` over `app.ledger_entry` rows whose
`account_id` is the company's `1110`, whose `currency` equals `shift.currency`, and whose `document_id`
belongs to a document of this `shift_id` with `status in ('posted', 'reversed')` and a `document_type.code`
other than `TILL_OVER_SHORT`. The till sends `countedCash` and nothing else; the server computes
`expected_cash` and `over_short`, and both are refused if they arrive in a payload.

## Consequences

- **The Z-report ties to the ledger by construction, not by agreement.** Acceptance test 21 asserts that
  the Z-report equals the ledger to the cent. Under (a) that assertion compares two independent
  computations and can fail for a reason nobody can localise; under (b) it compares the ledger to itself
  and can only fail if the *posting* is wrong — which is the defect worth catching.
- **Every future cash movement is included with no formula change.** OD-10's paid-outs, safe drops and
  bankings each post a `1110` leg, so they enter the sum the day their document type lands. Under (a) the
  formula would have had to grow a clause per type, and a type whose clause was forgotten would be a
  silent shortfall — SAH-055's shape ("a figure recomputed by a second, staler rule").
- **A POS return is handled without a sign rule.** A refund's cash tender posts a credit to `1110`, so
  `debit − credit` subtracts it. Nothing reads the sign of an amount to decide a direction (§4.4.2 A9).
- **`status in ('posted', 'reversed')` and not `= 'posted'`.** A reversed ticket's own entries stay in the
  ledger and its reversal's entries are there too; both belong in the sum, and filtering to `posted` would
  drop the original and leave the reversal, understating the drawer by twice the sale. This is 4B's
  `ledgerLegSource` predicate, deliberately reused.
- **`TILL_OVER_SHORT` is excluded** because it is posted *from* this figure. Including it would make the
  close idempotent on the wrong thing: a second close would compute an expectation that already contained
  the first close's correction and find a difference of zero.
- **One currency, never base.** A physical count is a count of notes in one currency. Summing base
  amounts would tie a MYR drawer to a MYR-equivalent figure and be off by the day's rate.
- **The cost is one join more than (a).** `ledger_entry` is indexed on `(company_id, account_id)` and the
  shift's documents are reached through `document_shift_idx` (0070), so the read is two index scans.

## Rejected

- **Trusting a till-computed `expectedCash`.** A till's clock and its arithmetic are both outside our
  control, and the figure decides who is short. Refusing the field is cheaper than validating it.
- **A stored running total on `app.shift`.** A counter updated per ticket is a second projection of the
  ledger with no integrity job behind it (D14's reasoning applied to cash).
```

- [ ] **Step 6: Run the suite.**

Run: `cd packages/db && bun run test -- seed/6d-pack`
Expected: **5 passed.**

Run: `cd packages/db && bun run test -- document-types`
Expected: green — 1A's own loader suite validates every file in `seed/my/document-types/` against the envelope schema and the catalogue, so a malformed `TILL_OVER_SHORT.json` fails there too, naming the file.

Run: `bun run lint:rules`
Expected: **green**, exactly as at the end of Tasks 2 and 3. This task adds two JSON files and one test and touches no lint scope; it is named here only so an engineer arriving at Task 4 without having read Tasks 2 and 3 does not expect a pending red rule. There is none — Task 2 Step 6's literals in `packages/db/src/sync/authority.ts` reference both catalogue codes from Task 2's own commit.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/seed/my/chart-of-accounts/6d-till.json \
        packages/db/seed/my/document-types/TILL_OVER_SHORT.json \
        packages/db/test/seed/6d-pack.test.ts docs/adr/0063-shift-close-derives-expected-cash.md
git commit -m "feat(seed): 5120 till over/short, 1130 cash in transit, TILL_OVER_SHORT [6D T4]

1130 is seeded unconditionally even when OD-10 = no, so 4B's reconciliation has an
account to clear for a manual banking (§4.15). The policy names no account by code —
every leg is { from: line.account } and the service resolves the pair per close, so
hazard 33 has nothing to bite on. ADR 0063 proposes deriving expected_cash from the
ledger's 1110 leg rather than from tender lines.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The **close** — `computeExpectedCash`, `applyShiftClose`, and `buildTillDocument`

**The centre of the slice.** The server derives what the drawer should hold, writes the four close columns, and posts the difference as a `TILL_OVER_SHORT` document through `postDocument`. Nothing about cash is computed at the till except the physical count, and no ledger row is written outside `packages/db/src/posting/` (Global Constraint 1).

**Files**
- Create: `packages/db/src/posting/till.ts`, **`packages/db/test/sync/shift-close.test.ts`**
- Modify: `packages/db/src/sync/shifts.ts` (`computeExpectedCash`, and `applyShiftClose`'s **body replaces Task 3's stub**), `packages/db/src/index.ts` (two re-exports), `tests/invariants/support/staff.ts` (amendment A7)

**Why a new test file and not a second `describe` in `sync/shifts.test.ts`.** §3.7.1 fixes `packages/<pkg>/test/*.test.ts` as one file per topic with **one `startDb()` per file**. Task 3's file owns a container (`db = await startDb()` in `beforeAll`, `await db.stop()` in `afterAll`); this suite needs `startApi()` and 6C's `staffFixture`, which start a container **and** an API of their own. Appending here would run two Postgres containers on every invocation of that file and leak the second, since a second `beforeAll` cannot share the first's `afterAll`. The close therefore gets `packages/db/test/sync/shift-close.test.ts`, which starts what it needs and stops it.

**Interfaces**

- Consumes: `postDocument`, `PostResult`, `PostingError` (§4.3.1, 1A); `resolvePolicy` (§4.3.1 — reached *through* `postDocument`, never called here); `app.principal_has(p_principal, p_code, p_company_id, p_branch_id)` (§4.5.3, 2B — **that argument order**); `POS_PERMISSION` (Task 2); `Money`, `currency`, `MONEY_SCALE` (§4.2.1); `SyncError` (6A); `TerminalApplyContext`, `MessageOutcome` (6A); `assertShape`, `moneyFromMessage`, `shiftRef` (Task 3); `app.shift` (Task 1); `app.document`, `app.document_line`, `app.ledger_entry`, `app.document_type`, `app.account` (1A/2A); `staffFixture`, `StaffFixture` (6C); `grantCodes` (2B), `seedShift` (Task 1); **`reverseDocument` (1A, §4.3.1)** — Step 1's reversal case calls it directly to prove `computeExpectedCash` follows a reversed ticket, and Task 8's Consumes list carries it too.
- Produces:

```ts
// packages/db/src/posting/till.ts — the ONE writer of a till document, exported from @dulja/db.

/** The four §4.14 till types, so a caller cannot pass a code the register does not have. `over_short` is
 *  unconditional; the other three are ⚠️ OD-10's and their document types only exist if it lands. */
export type TillDocumentKind = "over_short" | "paid_out" | "safe_drop" | "banking";

export interface TillDocumentInput {
  kind: TillDocumentKind;
  /** The §4.14 code — `TILL_OVER_SHORT` | `TILL_PAID_OUT` | `TILL_SAFE_DROP` | `TILL_BANKING`. */
  typeCode: string;
  shiftId: string;
  /** The magnitude. NEVER negative — the two account codes carry the direction (§4.4.2 A9). */
  amount: Money;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveDate: string;       // YYYY-MM-DD, the accounting date (spec:2039)
  /** The human the act is attributed to. The ACTING principal stays the terminal (hazard 19). */
  attributedTo: string;
  description: string;
  /** Only a till-minted message has one; a server-minted close does not. */
  clientRef: string | null;
}

/** Drafts a two-line `account` document and posts it. Returns the `PostResult` so a caller can record the
 *  document id. Throws `PostingError` (§4.3.8) or `SyncError`; never writes a ledger row itself. */
export async function buildTillDocument(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, input: TillDocumentInput,
): Promise<PostResult>;

/** `app.account.code` → id for one company, or `SyncError("ERR_NOT_FOUND")` naming the code and the file
 *  that seeds it. The hazard-33 assertion in code form: a slice that consumes a code it did not seed
 *  refuses loudly instead of falling back to a null account. */
export async function resolveAccountByCode(sp: Sql, companyId: string, code: string): Promise<string>;

/** The company's LOCAL date for an instant — 6A's `date(soldAt at time zone company.timezone)`, reused so
 *  a shift's tickets and its close land in one fiscal period. Never a UTC string slice. */
export async function tillEffectiveDate(sp: Sql, companyId: string, instant: string): Promise<string>;
```

```ts
// packages/db/src/sync/shifts.ts — the two additions.

/** ADR 0063: `opening_float + Σ(debit − credit)` on the company's 1110 over the shift's posted documents,
 *  in the SHIFT'S currency, excluding TILL_OVER_SHORT. Returns a `Money` in that currency. */
export async function computeExpectedCash(
  sp: Sql, companyId: string, shiftId: string,
): Promise<{ expected: Money; openingFloat: Money; shiftCurrency: string }>;

/** The CLOSE transition: authority, the derivation, the four columns, and the TILL_OVER_SHORT posting. */
export async function applyShiftClose(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/sync/shift-close.test.ts`.**

The import header is the whole of what this file needs; nothing below reaches for a name that is not in it. **`startApi` and `staffFixture` are imported by relative path out of `apps/api/test/**` and `tests/invariants/support/**`** — that is 6A's established shape for a `packages/db` sync test (its own `apply.test.ts` does exactly this) and §4.17.1's named allowance on `dependency-rule.ts` covers the direction; do not add a `package.json` dependency for it.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
import { reverseDocument } from "../../src/posting/reverse";        // 1A, packages/db/src/posting/reverse.ts
import { resolveAccountByCode } from "../../src/posting/till";      // Step 2
import { grantCodes, type Seed } from "../fixtures";
import { uuidv7, withTenant, type Db } from "../harness";
import { startApi, type StartedApi } from "../../../../apps/api/test/support/app";
import { buildTicket } from "../../../../tests/invariants/support/pos";
import { staffFixture, type StaffFixture } from "../../../../tests/invariants/support/staff";

describe("6D shift close — the derivation, the sign and the posting (test 21's unit half, ADR 0063)", () => {
  let db: Db;
  let f: StaffFixture;                     // 6C's world: two branches, three cashiers, one terminal each
  let api: StartedApi;

  beforeAll(async () => {
    api = await startApi();          // 6A's spelling, from apps/api/test/support/app
    f = await staffFixture(api, "close");
    db = api.db;
    // The closer needs pos.shift.own for their OWN shift. `seedCashier` grants exactly `opts.permissions`
    // (6C), and staffFixture's cashierA holds sell/discount/return — NOT the shift codes. Granting here
    // rather than widening 6C's fixture keeps 6C's own limit tests asserting the authority they assert.
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"], principalId: f.cashierA,
      roleCode: "own-shift", branchIds: [f.branchA],
    });
  }, 300_000);

  // This file starts its own container and its own API, so it stops them. §3.7.1's one-per-file rule.
  afterAll(async () => { await api.stop(); });

  /**
   * Sell `amounts` as cash tickets into `shiftId` through the REAL apply path, and return the document ids.
   * Never `insert into app.ledger_entry`: the whole value of test 21 is that the ledger got there by
   * posting, and a fixture that wrote entries directly would prove nothing (hazard 22).
   *
   * **`unitPrice` + `tender`, never a `cashPrice` option.** 6A's `buildTicket` takes
   * `{ sku, quantity, unitPrice, discount, tender, kind, clientRef, shiftId, cashierPrincipalId,
   * customerId, newCustomer, returnsClientRef, events }` (6A Task 10 Step 6) and derives the single tender's
   * amount as `unitPrice × quantity − discount`, tax-inclusive. With the default `quantity` of `1.000000`
   * and no discount, `unitPrice: "40.0000"` is a ticket whose one cash tender is `40.0000` — which is what
   * these cases mean. §4.17.1 forbids widening 6A's signature, and nothing here needs it widened.
   */
  const sellCash = async (shiftId: string, amounts: string[]): Promise<string[]> => {
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), shifts: [], tillEvents: [],
          tickets: amounts.map((a) =>
            buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: a, tender: "cash" })) }));
    expect(out.results.map((r) => r.status)).toEqual(amounts.map(() => "accepted"));
    return out.results.map((r) => r.documentId!);
  };

  /** A close whose `countedCash` bag is passed through verbatim, so the two malformed cases can send null
   *  and a wrong currency without `close`'s string parameter getting in the way. */
  const closeRaw = (shiftId: string, countedCash: { amount: string; currency: string } | null) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), tickets: [], tillEvents: [],
          shifts: [{ shiftId, kind: "close", terminalId: f.terminalA.terminalId,
                     cashierPrincipalId: f.cashierA, at: new Date().toISOString(), currency: "MYR",
                     openingFloat: null, countedCash }] }));

  /**
   * A human principal with a membership and a branch, for the manager cases. 6C's `seedEmployee` +
   * `seedCashier` pair makes a CASHIER; a branch manager is not one, so this builds the principal directly
   * and lets `grantCodes` do the role. It is test-local on purpose: §4.17 assigns 6D one `fixtures.ts`
   * helper (`seedShift`) and inventing a second there is hazard 9.
   */
  const seedEmployeePrincipal = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  const close = (shiftId: string, counted: string, closer = f.cashierA) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA, principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), tickets: [], tillEvents: [],
          shifts: [{ shiftId, kind: "close", terminalId: f.terminalA.terminalId, cashierPrincipalId: closer,
                     at: new Date().toISOString(), currency: "MYR", openingFloat: null,
                     countedCash: { amount: counted, currency: "MYR" } }] }));

  it("expected_cash is opening_float plus the 1110 net of the shift's posted tickets (ADR 0063)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["25.0000", "10.5000"]);
    const out = await close(shiftId, "135.5000");
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [row] = await db.admin<{
      expected_cash: string; counted_cash: string; over_short: string;
      closed_at: string; closed_principal_id: string; over_short_document_id: string | null;
    }[]>`select expected_cash::text, counted_cash::text, over_short::text, closed_at::text,
                closed_principal_id::text, over_short_document_id::text from app.shift where id = ${shiftId}`;
    expect(row!.expected_cash).toBe("135.5000");
    expect(row!.counted_cash).toBe("135.5000");
    expect(row!.over_short).toBe("0.0000");
    expect(row!.closed_principal_id).toBe(f.cashierA);
    expect(row!.over_short_document_id).toBeNull();        // an exact count posts NOTHING (Step 4)
  });

  it("an OVER drawer debits 1110 and credits 5120, and over_short is POSITIVE", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["20.0000"]);
    const out = await close(shiftId, "123.0000");           // expected 120, counted 123 → over 3
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [sh] = await db.admin<{ over_short: string; doc: string }[]>`
      select over_short::text, over_short_document_id::text as doc from app.shift where id = ${shiftId}`;
    expect(sh!.over_short).toBe("3.0000");
    expect(sh!.doc).not.toBeNull();

    const legs = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, le.debit::text, le.credit::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${sh!.doc} order by a.code`;
    expect(legs).toEqual([
      { code: "1110", debit: "3.0000", credit: "0.0000" },
      { code: "5120", debit: "0.0000", credit: "3.0000" },
    ]);
  });

  it("a SHORT drawer debits 5120 and credits 1110, and over_short is NEGATIVE", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["20.0000"]);
    const out = await close(shiftId, "118.5000");           // expected 120, counted 118.50 → short 1.50
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [sh] = await db.admin<{ over_short: string; doc: string }[]>`
      select over_short::text, over_short_document_id::text as doc from app.shift where id = ${shiftId}`;
    expect(sh!.over_short).toBe("-1.5000");
    const legs = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, le.debit::text, le.credit::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${sh!.doc} order by a.code`;
    expect(legs).toEqual([
      { code: "1110", debit: "0.0000", credit: "1.5000" },
      { code: "5120", debit: "1.5000", credit: "0.0000" },
    ]);
    // The magnitude on the ledger is POSITIVE on both legs. Nothing wrote a negative debit (§4.4.2 A9).
    for (const l of legs) { expect(l.debit).not.toMatch(/^-/); expect(l.credit).not.toMatch(/^-/); }
  });

  it("the over/short document carries the shift, the terminal, the branch and the cashier", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "50.0000" });
    await close(shiftId, "51.0000");
    const [d] = await db.admin<{
      shift_id: string; terminal_id: string; branch_id: string; attributed_to: string;
      created_by: string; posted_by: string; series: string; status: string; code: string;
    }[]>`select d.shift_id::text, d.terminal_id::text, d.branch_id::text, d.attributed_to::text,
                d.created_by::text, d.posted_by::text, d.series, d.status::text, t.code
           from app.document d join app.document_type t on t.id = d.document_type_id
          where d.shift_id = ${shiftId} and t.code = 'TILL_OVER_SHORT'`;
    expect(d!.code).toBe("TILL_OVER_SHORT");
    expect(d!.status).toBe("posted");
    expect(d!.terminal_id).toBe(f.terminalA.terminalId);
    expect(d!.branch_id).toBe(f.branchA);
    expect(d!.attributed_to).toBe(f.cashierA);                    // the cashier is ATTRIBUTED
    expect(d!.created_by).toBe(f.terminalA.principalId);          // the terminal ACTED (hazard 19)
    expect(d!.posted_by).toBe(f.terminalA.principalId);
    // 6A's resolveSeries suffixes EVERY document carrying a terminal_id (amendment A15). The code is read
    // off the fixture and NOT written as "T1": `posFixture` enrols its terminal with `code: "KL01"`
    // (6A Task 10 Step 6) and `StaffFixture.terminalA` IS `pos.terminal` (6C Task 9 Step 2), so every assertion that reaches
    // this suite through `staffFixture` sees `TOS-KL01`. 6A writes its own equivalent the same way
    // (6A Task 11 Step 1: `expect(doc!.series).toBe(`POS-${f.terminal.code}`)`).
    expect(d!.series).toBe(`TOS-${f.terminalA.code}`);
  });

  it("the BRANCH dimension is on both ledger lines (spec:1066, dimensions.required)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "50.0000" });
    await close(shiftId, "52.0000");
    // `led.entry_id`, NOT `led.ledger_entry_id`. `app.ledger_entry_dimension` is
    // `(tenant_id, entry_id, dimension_type_id, dimension_value_id)` with `primary key (entry_id,
    // dimension_type_id)` (plan0A:2041–2046). 2A's own self-review records making and correcting this
    // exact mistake as its item 16, noting that the wrong column left its two BRANCH-dimension assertions
    // "never run" — a query that errors is a case that proves nothing. 1a:2843 and 1a:6043 are the
    // correct form.
    const dims = await db.admin<{ code: string; value_id: string }[]>`
      select dt.code, led.dimension_value_id::text as value_id
        from app.ledger_entry le
        join app.ledger_entry_dimension led on led.entry_id = le.id
        join app.dimension_type dt on dt.id = led.dimension_type_id
        join app.document d on d.id = le.document_id
       where d.shift_id = ${shiftId}`;
    expect(dims).toHaveLength(2);
    expect(new Set(dims.map((d) => d.code))).toEqual(new Set(["BRANCH"]));
    expect(new Set(dims.map((d) => d.value_id))).toEqual(new Set([f.branchA]));
  });

  it("a re-sent close answers duplicate, and a DIFFERENT countedCash does not overwrite the first", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await close(shiftId, "101.0000");
    const out = await close(shiftId, "500.0000");
    expect(out.shiftResults[0]!.status).toBe("duplicate");
    expect(out.shiftResults[0]!.error).toBeNull();

    const [sh] = await db.admin<{ counted_cash: string; over_short: string }[]>`
      select counted_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.counted_cash).toBe("101.0000");        // FIRST count stands
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
       where d.shift_id = ${shiftId} and t.code = 'TILL_OVER_SHORT'`;
    expect(n!.n).toBe(1);                             // ONE over/short document, ever
  });

  it("closing SOMEONE ELSE'S shift without pos.shift.close_any is ERR_RBAC_FORBIDDEN", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", f.supervisorA);     // holds override, not close_any
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.shiftResults[0]!.error!.detail).toContain("pos.shift.close_any");
    const [sh] = await db.admin<{ closed_at: string | null }[]>`
      select closed_at::text from app.shift where id = ${shiftId}`;
    expect(sh!.closed_at).toBeNull();                              // refused, and STILL OPEN
  });

  it("a branch manager holding pos.shift.close_any may close a cashier's shift (spec:2160)", async () => {
    const managerId = await seedEmployeePrincipal(f.seed, "mgr-close");
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.close_any"], principalId: managerId, roleCode: "bm-close", branchIds: [f.branchA],
    });
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", managerId);
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ closed_principal_id: string }[]>`
      select closed_principal_id::text from app.shift where id = ${shiftId}`;
    expect(sh!.closed_principal_id).toBe(managerId);
  });

  it("closing one's OWN shift without pos.shift.own is ERR_RBAC_FORBIDDEN and names that code", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierB, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", f.cashierB);        // cashierB holds `sell` only
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.shiftResults[0]!.error!.detail).toContain("pos.shift.own");
  });

  it("a countedCash the till omits is rejected, and a wrong-currency count too", async () => {
    const a = await f.openShift({ cashierPrincipalId: f.cashierA });
    const out1 = await closeRaw(a, null);
    expect(out1.shiftResults[0]!.error!.detail).toContain("countedCash");
    const b = await f.openShift({ cashierPrincipalId: f.cashierA });
    const out2 = await closeRaw(b, { amount: "1.0000", currency: "USD" });
    expect(out2.shiftResults[0]!.error!.detail).toContain("USD");
  });

  it("a close in the SAME batch as its tickets sees them (the whole reason for Task 3's ordering)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "0.0000" });
    // One payload: a 40.00 cash sale AND the close. Under 6A's original order the close would run first
    // and find an empty drawer, reporting a 40.00 over on every till that sells its last sale and shuts.
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA, principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), tillEvents: [], shifts: [
            { shiftId, kind: "close", terminalId: f.terminalA.terminalId, cashierPrincipalId: f.cashierA,
              at: new Date().toISOString(), currency: "MYR", openingFloat: null,
              countedCash: { amount: "40.0000", currency: "MYR" } }],
          tickets: [buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "40.0000", tender: "cash" })] }));
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("40.0000");
    expect(sh!.over_short).toBe("0.0000");
  });

  it("a REVERSED ticket's cash is still in the expectation, and so is its reversal (ADR 0063)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "0.0000" });
    const [ticketId] = await sellCash(shiftId, ["30.0000"]);
    // **The reversal runs as the TERMINAL, not as a human**, and that is not a stylistic choice: the
    // reversal document is another `POS_TICKET` (`reversal.producesType`, 6A's POS_TICKET.json decision 4)
    // whose policy has `approval.post = "pos.sync.push"`, and 2B's R2 evaluates that code INSIDE the
    // posting transaction. `s.human` does not hold it, and `admin`'s computed array excludes every
    // `pos.sync.*` code (§3.6.4) — so a human-actor reversal dies at the trigger with ERR_RBAC_FORBIDDEN.
    await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      reverseDocument(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { documentId: ticketId, effectiveDate: "2026-01-15", reason: "mis-scan" }));

    // ⚠️ **STOP AND RAISE if this case fails with `expected_cash` = "30.0000".** It means
    // `reverseDocument` does not copy `shift_id` onto the reversal document, so the reversal's 1110 credit
    // is outside `d.shift_id = $1` and only the original's debit is counted. Neither 1A's §4.3.1 entry nor
    // 6A's plan settles whether the reversal inherits the POS header columns, and this plan does not
    // invent an answer. The fix is in 1A's `reverse.ts` (carry `shift_id` and `terminal_id` forward, which
    // is also what makes a reversed ticket appear in its own Z-report) plus a §4.3.1 amendment — NOT a
    // widened predicate here, which would have to guess which reversal belongs to which drawer.
    const out = await close(shiftId, "0.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    // 30 in, 30 out: the expectation is zero, not 30 (which `status = 'posted'` alone would have given).
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("0.0000");
    expect(sh!.over_short).toBe("0.0000");
  });

  it("resolveAccountByCode refuses loudly and names the seeding file (hazard 33)", async () => {
    for (const code of ["1110", "1130", "5120", "1100"]) {
      await expect(withTenant(db.rw, f.seed.tenant, f.seed.human,
        (tx) => resolveAccountByCode(tx as never, f.seed.company, code))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    }
    await expect(withTenant(db.rw, f.seed.tenant, f.seed.human,
      (tx) => resolveAccountByCode(tx as never, f.seed.company, "5130")))
      .rejects.toThrow(/ERR_NOT_FOUND.*5130.*6d-till\.json/);
  });
});
```

Run: `cd packages/db && bun run test -- sync/shift-close`
Expected: **FAIL** at import —
```
Error: Failed to load url ../../src/posting/till (resolved id: …/packages/db/src/posting/till.ts).
Does the file exist?
```
because `packages/db/src/posting/till.ts` does not exist yet. Once Step 2 lands, every close case fails on Task 3's **stub** — `expect(out.shiftResults[0]!.status).toBe("accepted")` reporting `received: "rejected"` with `error.detail` `"the shift close apply path is 6D Task 5; the till keeps this outbox row and re-sends"` — until Step 3 replaces the body. That exact string in a failure is the confirmation that you are running against the stub and not against a broken close.

Run: `cd packages/db && bun run test -- sync/shifts`
Expected: **10 passed, unchanged.** Task 3's file is not edited by this task; if it fails here, something in Step 3 changed `shifts.ts`'s open path rather than only `applyShiftClose`'s body.

- [ ] **Step 2: Write `packages/db/src/posting/till.ts` — the one writer of a till document.**

```ts
import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import { postDocument, type PostResult } from "./post";
import { SyncError } from "../sync/enrolment";
import type { TerminalApplyContext } from "../sync/apply";
import type { TenantContext } from "../with-tenant";

export type TillDocumentKind = "over_short" | "paid_out" | "safe_drop" | "banking";

export interface TillDocumentInput {
  kind: TillDocumentKind;
  typeCode: string;
  shiftId: string;
  amount: Money;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveDate: string;
  attributedTo: string;
  description: string;
  clientRef: string | null;
}

/** The four §4.15 codes this file may be asked for, and the file that seeds each — so the refusal below
 *  tells an operator which seed pack has not been applied instead of "account not found". */
const SEEDED_BY: Readonly<Record<string, string>> = {
  "1100": "0c-base.json (0C)",
  "1110": "6a-pos-tenders.json (6A)",
  "1130": "6d-till.json (6D)",
  "5120": "6d-till.json (6D)",
  "5130": "6d-till.json (6D, ⚠️ OD-10)",
};

/**
 * The **draft** series for each till document kind — §4.14's `Series` column, which amendment A15 fixes as
 * the *policy* series (`policy.numbering.series`).
 *
 * **Why this column has to be written at all.** `app.document.series` is `text not null` **with no
 * default** (plan0A:1780). §4.3.6 only *updates* it at issue, so every insert in every plan supplies it
 * (plan0A:1608's `draftDocument` writes `'JV'`; 1a:2585 and 1a:3615 do the same) — and a header insert
 * that omits it dies on
 * `null value in column "series" of relation "document" violates not-null constraint`
 * **before `postDocument` is ever reached**, which is a confusing failure for a correct close.
 *
 * **Why a literal and not a read of the policy.** The value is overwritten within milliseconds:
 * `postDocument` step 1 issues the document, and 6A's `resolveSeries` recomputes the string as
 * `` `${policySeries}-${pos_terminal.code}` `` for any document carrying a `terminal_id` (amendment A15),
 * so the final `series` on every row this function writes is `TOS-<code>` / ⚠️ `TPO-`/`TSD-`/`TBK-<code>`
 * regardless of what the draft held. Reading `posting_policy.definition->'numbering'->>'series'` here to
 * obtain a value that is discarded would be a second policy read outside `resolvePolicy` — which is the
 * thing §4.3.1 gives `postDocument` sole custody of. These four literals are §4.14 register values, in
 * this slice's declared namespace list (Global Constraint 13), and `TillDocumentKind` makes the record
 * exhaustive: a fifth kind does not compile without its row.
 */
const SERIES_FOR: Readonly<Record<TillDocumentKind, string>> = {
  over_short: "TOS",
  paid_out: "TPO",
  safe_drop: "TSD",
  banking: "TBK",
};

/**
 * `app.account.code` → id, or a refusal naming the code and its seed file.
 *
 * This is hazard 33's "a slice consuming a code it did not seed asserts that the account resolves" in code
 * rather than only in a test: `postDocument` would otherwise fail at step 10 on a null `account_id` with a
 * message about a NOT NULL constraint, in the slice that did not write the seed file.
 */
export async function resolveAccountByCode(sp: Sql, companyId: string, code: string): Promise<string> {
  const [row] = await sp<{ id: string }[]>`
    select id from app.account
     where company_id = ${companyId} and code = ${code} and is_group = false and archived_at is null`;
  if (!row) {
    throw new SyncError("ERR_NOT_FOUND",
      `account ${code} is not in company ${companyId}; it is seeded by ${SEEDED_BY[code] ?? "an unregistered file"}`
      + ` — run \`bun run seed --tenant <id> --only chart-of-accounts\``);
  }
  return row.id;
}

/**
 * The company's LOCAL date for an instant, which is the `effective_date` every till document takes.
 *
 * **Never `String(iso).slice(0, 10)`.** That is the UTC date, and a Malaysian shop closing at 07:00 MYT on
 * 1 February is 23:00 UTC on 31 January — the document would post into January and, if January is closed,
 * die on `ERR_PERIOD_NOT_OPEN` with a message about a period the operator did not choose. 6A derives a
 * ticket's `effective_date` as `date(soldAt at time zone company.timezone)` (its `ticketEffectiveDate`
 * helper does the same thing for its own test), and every till document uses that one derivation so a
 * shift's tickets and its close land in one fiscal period.
 */
export async function tillEffectiveDate(sp: Sql, companyId: string, instant: string): Promise<string> {
  const [row] = await sp<{ d: string }[]>`
    select date(${instant}::timestamptz at time zone
                (select timezone from app.company where id = ${companyId}))::text as d`;
  return row!.d;
}

/**
 * Drafts a two-line `account` document for a till event and posts it through `postDocument`.
 *
 * **It computes nothing and posts everything** (Global Constraint 1, hazard 22). There is no
 * `insert into app.ledger_entry` in this file: the two `document_line` rows carry a magnitude on `debit`
 * or on `credit`, the `TILL_OVER_SHORT` policy's two JOURNAL-shaped rules turn them into planned ledger
 * lines, and 1A's `insertLines` writes the ledger. `posting-only-tables` (§3.7.5) allows
 * `packages/db/src/posting/**` for exactly this kind of file and would fail the build on a ledger insert
 * anywhere else — which is why this function lives here and not in `sync/`.
 *
 * **The magnitude is always positive and the two codes carry the direction** (§4.4.2 A9). The caller
 * chooses which code is the debit and which the credit; this function never reads `amount.isNegative()`,
 * and a caller that passed a negative `amount` would die on `document_line`'s `check (debit >= 0)` — which
 * is the right place for that to fail.
 *
 * **The terminal acts, the human is attributed** (hazard 19). `created_by` and `posted_by` come from the
 * column default `app.current_actor()`, which is the terminal principal resolved from the signed call;
 * `attributed_to` is `input.attributedTo` and is a data column. No line here puts a payload principal into
 * an actor column.
 */
export async function buildTillDocument(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, input: TillDocumentInput,
): Promise<PostResult> {
  if (input.amount.isNegative() || input.amount.isZero()) {
    // A zero document would reach §4.3.2 step 6, plan two zero lines, have both dropped by the zero-drop,
    // and raise ERR_DOC_NO_LINES from step 6's OUTPUT case — a confusing error for a legitimate exact
    // count. The caller decides not to post instead, and this guard makes that contract explicit.
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${input.typeCode} for shift ${input.shiftId}: amount must be a positive magnitude, received ${input.amount.toString()}`);
  }

  const [type] = await sp<{ id: string }[]>`
    select id from app.document_type
     where company_id = ${terminal.companyId} and code = ${input.typeCode} and archived_at is null`;
  if (!type) {
    throw new SyncError("ERR_NOT_FOUND",
      `document type ${input.typeCode} is not seeded in company ${terminal.companyId}`
      + ` — run \`bun run seed --tenant <id> --only document-types\``);
  }

  const debitAccountId = await resolveAccountByCode(sp, terminal.companyId, input.debitAccountCode);
  const creditAccountId = await resolveAccountByCode(sp, terminal.companyId, input.creditAccountCode);

  const [company] = await sp<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${terminal.companyId}`;
  // `Money.currency` IS the three-letter code — §4.2.1 declares `CurrencyCode = string & { __brand }` and
  // `Money<C extends CurrencyCode>`'s `readonly currency: C` (contracts:1335, 1350). There is no `.code`
  // member on it, and reaching for one is `TS2339`. This value flows into the base-currency comparison
  // below and into `document.currency`, so the slip would not have been cosmetic.
  const amountCurrency: string = input.amount.currency;
  // A till document in a non-base currency would need a rate, and 0D's rate lookup is a different task in
  // a different slice. A drawer in a foreign currency is a real shop but not a v1 one, and refusing is
  // honest: `ERR_RATE_NOT_FOUND` from deep inside `postDocument` would be a worse message than this.
  if (amountCurrency !== company!.base_currency) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${input.typeCode} for shift ${input.shiftId}: the shift is in ${amountCurrency} and the company's base`
      + ` currency is ${company!.base_currency}; a till document in a second currency needs an exchange rate`
      + ` this path does not resolve`);
  }

  const [doc] = await sp<{ id: string }[]>`
    insert into app.document (
      tenant_id, company_id, document_type_id, branch_id, status, series, effective_date,
      currency, exchange_rate, attributed_to, terminal_id, shift_id, client_ref, notes)
    values (
      app.current_tenant(), ${terminal.companyId}, ${type.id}, ${terminal.branchId}, 'draft',
      ${SERIES_FOR[input.kind]}, ${input.effectiveDate}::date, ${amountCurrency}, 1, ${input.attributedTo},
      ${terminal.terminalId}, ${input.shiftId}, ${input.clientRef}, ${input.description})
    returning id`;

  const magnitude = input.amount.toString();
  // Two `kind = 'account'` lines in the §4.3.4 base shape — `debit`/`credit` are the columns the policy's
  // two `each_line` rules address, and each carries a non-negative magnitude with the other at 0.
  await sp`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, description,
                                   account_id, debit, credit, amount)
    values (app.current_tenant(), ${terminal.companyId}, ${doc!.id}, 1, 'account', ${input.description},
            ${debitAccountId}, ${magnitude}, 0, ${magnitude}),
           (app.current_tenant(), ${terminal.companyId}, ${doc!.id}, 2, 'account', ${input.description},
            ${creditAccountId}, 0, ${magnitude}, ${magnitude})`;

  // `postDocument` issues (assigning TOS-<terminal code> through 6A's resolveSeries), resolves the policy
  // pinned by effective date, evaluates it, balances in base, writes the ledger and the BRANCH dimension,
  // MERGEs account_balance and flips the status — §4.3.2 steps 1–15. Nothing above duplicates any of it.
  return postDocument(sp, ctx, { documentId: doc!.id });
}
```

**On the `document` column list — it is written out here, not copied from 6A.** The fourteen columns above are the complete list this insert needs. **6A's header insert (its Task 11, `applyTicket` step (f)) is close but is not the list to copy**, and the two places the two inserts differ are the two a reader should check rather than take on trust:

- **`series`.** `app.document.series` is `text not null` with no default (plan0A:1780), so every draft path has to carry a literal; 6A's step (f) carries the bare `'POS'` and says in its own comment that it is a placeholder §4.3.6's issue SQL overwrites. This insert carries `SERIES_FOR[input.kind]` instead — `TOS` / ⚠️ `TPO`, `TSD`, `TBK` — because four till document kinds are four §4.14 register values, and one shared `'POS'` would sit on a banking and a ticket alike in the window between insert and issue. Both literals are then overwritten identically by `resolveSeries` (amendment A15), so the difference is confined to the draft row. Dropping the column altogether is the failure to recognise: `null value in column "series" of relation "document" violates not-null constraint` on the first close.
- **`notes`, and no `memo`.** There is no `memo` column on `app.document`, and neither insert names one — 6A's step (f) states that in its own comment, and §4.3.4 gives 2C's 0027 `notes text` with no `memo` anywhere in the register. Reaching for it yields `column "memo" of relation "document" does not exist`. 6A's insert names **no** notes column at all (a POS ticket has nothing to put in one); this insert is the first in the register to write **`notes`**, with `input.description`, and Task 0's gate asserts the column exists by literal across the whole migrations directory, since 2C chooses its own file name (§3.4.2).

**What is deliberately absent.** `warehouse_id`, `tax_inclusive`, `party_id` and `sold_at` are item-and-tax columns a till document has no use for; `created_by` and `posted_by` come from their column defaults (`app.current_actor()`), which is hazard 19's whole mechanism; `fiscal_period_id`, `number`, `posting_policy_id` and `posting_seq` are assigned by `postDocument`'s own steps and a value written here would be overwritten or would pin the wrong policy. `client_ref` is `null` for a server-minted close, and `app.document`'s `unique (company_id, client_ref)` tolerates many nulls (6A's `findExisting` relies on the same fact).

**If a later slice adds a NOT NULL column to `app.document`**, this insert needs it and the failure is `null value in column … violates not-null constraint` on the first close. §4.3.4's header-additions paragraph is the register to check, and every addition it lists after 1A is nullable or defaulted — which is §3.4.7's expand rule, not a coincidence.

- [ ] **Step 3: Add `computeExpectedCash` to `packages/db/src/sync/shifts.ts`, and replace Task 3's `applyShiftClose` stub with the body below.** The signature does not change, so `apply.ts` is not touched by this task; the stub's whole body — the four-line `return { ref, status: "rejected", … }` — is deleted and replaced.

```ts
import { Money, currency } from "@dulja/domain";
// All three are used below: `buildTillDocument` posts the over/short, `resolveAccountByCode` resolves
// `1110` for the expected-cash read, and `tillEffectiveDate` maps the till's instant to a posting date.
import { buildTillDocument, resolveAccountByCode, tillEffectiveDate } from "../posting/till";
import { POS_PERMISSION } from "./authority";

/**
 * ADR 0063's formula, as one read.
 *
 * `opening_float + Σ(debit − credit)` over `app.ledger_entry` rows on the company's **`1110` Cash in
 * till**, in the **shift's own currency**, for documents of this `shift_id` whose status is `posted` or
 * `reversed` and whose type is not `TILL_OVER_SHORT`.
 *
 * Four clauses, four reasons, each of which a reader would otherwise have to reconstruct:
 * — **`1110` and not "the cash accounts"**: the drawer holds notes. Card and transfer tenders post to
 *   `1120` and `1100` and are not in the drawer at all.
 * — **`le.currency = shift.currency` and not the base amounts**: a physical count is a count in one
 *   currency, and `base_debit` would tie a MYR drawer to a rate-converted figure.
 * — **`status in ('posted','reversed')`**: a reversed ticket's own entries stay in the ledger and its
 *   reversal's entries are there too; both belong. Filtering to `posted` would drop the original and keep
 *   the reversal, understating the drawer by twice the sale. (4B's `ledgerLegSource` predicate, reused.)
 * — **`t.code <> 'TILL_OVER_SHORT'`**: this figure is what the over/short is posted FROM. Including it
 *   would make a second close compute an expectation that already held the first close's correction.
 *
 * Every future cash movement — OD-10's paid-outs, safe drops and bankings — enters this sum the day its
 * document type lands, with no change here. That is the whole point of reading the ledger.
 */
export async function computeExpectedCash(
  sp: Sql, companyId: string, shiftId: string,
): Promise<{ expected: Money; openingFloat: Money; shiftCurrency: string }> {
  const [shift] = await sp<{ opening_float: string; currency: string }[]>`
    select opening_float::text, currency from app.shift
     where id = ${shiftId} and company_id = ${companyId}`;
  if (!shift) {
    throw new SyncError("ERR_CONFLICT_REFERENCE", `shift ${shiftId} is not a shift of company ${companyId}`);
  }
  const cur = currency(shift.currency);
  const tillAccountId = await resolveAccountByCode(sp, companyId, "1110");

  const [net] = await sp<{ movement: string }[]>`
    select coalesce(sum(le.debit) - sum(le.credit), 0)::text as movement
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
     where le.company_id = ${companyId}
       and le.account_id = ${tillAccountId}
       and le.currency   = ${shift.currency}
       and d.shift_id    = ${shiftId}
       and d.status in ('posted', 'reversed')
       and t.code <> 'TILL_OVER_SHORT'`;

  const openingFloat = Money.of(shift.opening_float, cur);
  // `Money.add` on two `Money` of one currency — no JavaScript arithmetic, no `Number()` (Constraint 2).
  const expected = openingFloat.add(Money.of(net!.movement, cur));
  return { expected, openingFloat, shiftCurrency: shift.currency };
}

/**
 * The CLOSE transition. Six steps, in this order and for these reasons:
 *
 * 1. Shape (`assertShape`) — shared with the open, so the two cannot drift.
 * 2. `select … for update` on the shift, so two concurrent closes of one drawer serialise. The batch-level
 *    advisory lock in `applyBatch` covers one terminal; a branch manager's close arriving on a second
 *    terminal's batch is a different key, and without this row lock both would derive the same expectation
 *    and post two over/short documents.
 * 3. Already closed → `duplicate` and NOTHING else. The first count stands: overwriting `counted_cash` on
 *    a re-send would change a figure a Z-report has already been built on, and posting a second
 *    `TILL_OVER_SHORT` would double the correction. This is "zero duplicates" for this message kind.
 * 4. Authority, evaluated against the SERVER's assignments through `app.principal_has` — never against
 *    anything the till sent (spec:1324). The closer's own shift needs `pos.shift.own` (6B's code); someone
 *    else's needs `pos.shift.close_any` (6D's). That is spec:2161's distinction verbatim, and no override
 *    lifts either (Task 2 Step 6: `OVERRIDE_SUBJECT_FOR` is `null` for both).
 * 5. The derivation and the four columns, written in ONE update so `shift_close_is_atomic` can never see a
 *    half-closed row.
 * 6. The posting — but only when the difference is non-zero.
 */
export async function applyShiftClose(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: ShiftMessageInput,
): Promise<MessageOutcome> {
  const ref = shiftRef(msg);
  assertShape(msg, terminal);
  const at = `shift ${msg.shiftId}`;

  // 2. One closer per drawer.
  const [shift] = await sp<{
    id: string; opened_principal_id: string; closed_at: string | null; currency: string;
  }[]>`
    select id, opened_principal_id::text, closed_at::text, currency
      from app.shift
     where id = ${msg.shiftId} and company_id = ${terminal.companyId} and terminal_id = ${terminal.terminalId}
       for update`;
  if (!shift) {
    throw new SyncError("ERR_CONFLICT_REFERENCE",
      `${at} is not an open shift of terminal ${terminal.terminalId}; send the "open" message first (§4.10.1)`);
  }

  // 3. Idempotent on the transition, not on the payload.
  if (shift.closed_at !== null) return { ref, status: "duplicate", error: null };

  const counted = moneyFromMessage(msg.countedCash, "countedCash", shift.currency, at);

  // 4. Authority. `app.principal_has(p_principal, p_code, p_company_id, p_branch_id)` — that order (§4.5.3).
  const own = msg.cashierPrincipalId === shift.opened_principal_id;
  const code = own ? POS_PERMISSION.shiftOwn : POS_PERMISSION.shiftCloseAny;
  const [auth] = await sp<{ ok: boolean }[]>`
    select app.principal_has(${msg.cashierPrincipalId}, ${code}, ${terminal.companyId}, ${terminal.branchId}) as ok`;
  if (!auth!.ok) {
    throw new SyncError("ERR_RBAC_FORBIDDEN",
      `${at}: principal ${msg.cashierPrincipalId} does not hold ${code} at branch ${terminal.branchId}`
      + (own ? " (closing one's own shift)" : " (closing a shift another principal opened — spec:2160)"));
  }

  // 5. Derive and write. `over_short = counted − expected`, POSITIVE IS OVER (§4.6.5).
  const { expected } = await computeExpectedCash(sp, terminal.companyId, msg.shiftId);
  const overShort = counted.subtract(expected);
  await sp`
    update app.shift
       set closed_at = ${msg.at}::timestamptz,
           closed_principal_id = ${msg.cashierPrincipalId},
           counted_cash  = ${counted.toString()},
           expected_cash = ${expected.toString()},
           over_short    = ${overShort.toString()}
     where id = ${msg.shiftId}`;

  // 6. An exact count posts NOTHING. `over_short_document_id` stays null and `over_short` is "0.0000",
  //    which is a *statement* that the drawer balanced and not a missing document. Posting a zero
  //    document would raise ERR_DOC_NO_LINES from §4.3.2 step 6's zero-drop and refuse a correct close.
  if (!overShort.isZero()) {
    // The SIGN chooses the pair; the MAGNITUDE is always positive. This is the one place in the slice that
    // reads a sign, and Global Constraint 9 grants it explicitly: `shift.over_short` is a stored signed
    // column, not a `PlannedLedgerLine`, and it is read once to pick two account codes.
    const over = overShort.isNegative() === false;
    const result = await buildTillDocument(sp, ctx, terminal, {
      kind: "over_short",
      typeCode: "TILL_OVER_SHORT",
      shiftId: msg.shiftId,
      amount: overShort.abs(),
      // OVER: the drawer holds more than the ledger says → debit 1110 (more cash), credit 5120 (a gain
      // sitting in an expense account, which is what "signed: a debit is short, a credit is over" means
      // in §4.15's row for 5120). SHORT: the mirror.
      debitAccountCode: over ? "1110" : "5120",
      creditAccountCode: over ? "5120" : "1110",
      effectiveDate: await tillEffectiveDate(sp, terminal.companyId, msg.at),
      attributedTo: msg.cashierPrincipalId,
      description: over
        ? `Till over on shift ${msg.shiftId}`
        : `Till short on shift ${msg.shiftId}`,
      clientRef: null,
    });
    await sp`update app.shift set over_short_document_id = ${result.documentId} where id = ${msg.shiftId}`;
  }

  return { ref, status: "accepted", error: null };
}
```

**`assertShape` becomes module-visible.** Task 3 wrote it `private`; this step drops the `function` keyword's implicit privacy by leaving it unexported but hoisted in the same file — both callers are in `shifts.ts`, so nothing else changes. `moneyFromMessage` is already exported (Task 3) and is used by Task 9.

- [ ] **Step 4: Add the two `StaffFixture` members — `tests/invariants/support/staff.ts` (amendment A7).**

```ts
export interface StaffFixture {
  /* … every existing member, unchanged … */
  /** 6D: an OPEN shift at branch A on `terminalA`, opened by `cashierA`, `opening_float` "0.0000". */
  shiftA: string;
  /** 6D: open another. Returns the shift id. A test needing a second drawer does not re-derive the insert. */
  openShift(opts: { cashierPrincipalId: string; openingFloat?: string }): Promise<string>;
}
```

```ts
// tests/invariants/support/staff.ts — inside staffFixture, after branchB and the three cashiers exist.
  const openShift = (opts: { cashierPrincipalId: string; openingFloat?: string }) =>
    seedShift(db, seed, {
      terminalId: pos.terminal.terminalId,
      cashierPrincipalId: opts.cashierPrincipalId,
      openingFloat: opts.openingFloat ?? "0.0000",
      branchId: branchA,
    });
  const shiftA = await openShift({ cashierPrincipalId: cashierA });
```

…and both on the returned object. Both are additive; **no existing member changes**, which is what keeps 6C's own limit and isolation suites green. `posFixture.shiftId` (amendment A6) is a *different* shift — the shared one every `buildTicket` names — and `shiftA` is 6D's own, so a 6D test can close one without ending the shift 6C's tests sell into.

- [ ] **Step 5: Check the three `buildTicket` facts Step 1's `sellCash` depends on, against 6A's committed file, before you run the suite.**

Step 1's three test-local helpers (`sellCash`, `closeRaw`, `seedEmployeePrincipal`) are written out in full there. What they depend on is **6A's** `buildTicket`, which this slice may not widen (§4.17.1 is additive-only and a widened signature would be a 6A edit). Read `tests/invariants/support/pos.ts` and confirm each of these three, because every arithmetic figure in this task and in Task 8 rests on them:

1. **The option set.** 6A's builder takes `{ sku, quantity, unitPrice, discount, tender, kind, clientRef, shiftId, cashierPrincipalId, customerId, newCustomer, returnsClientRef, events }` (6A Task 10 Step 5 declares the type, Step 6 the body). **There is no `cashPrice` or `cardPrice` option** — an early draft of this plan used one and it does not exist. The tender amount is derived: `gross = unitPrice.multiply(quantity) − discount`, and the single tender carries `gross` with `method = opts.tender ?? "cash"`. With the default `quantity` `"1.000000"` and no discount, `{ unitPrice: "40.0000", tender: "cash" }` is a ticket whose one cash tender is exactly `40.0000`. **If the option is spelled differently in the committed file, use its spelling** — §4.18 makes 6A the authority — and never mutate the returned tender's `amount` by hand, which would desynchronise it from the line total and make `applyBatch` refuse the ticket for an unrelated reason.
2. **`shiftId` defaults to `SHARED_SHIFT_ID`** (6A Task 10 Step 6's note 2), so every helper here passes it explicitly; a ticket that fell back to the shared shift would land in `posFixture`'s drawer and not in the one under test.
3. **`kind: "return"` negates in one place.** `quantity`, `total`, `taxAmount`, `discount` and the tender's `amount` all flip together inside the builder (6a's own comment says so); `unitPrice` does not. **Never negate again at the call site.** And a return needs `returnsClientRef` — see Task 7 Step 1's note on blind returns, which is where the constraint first bites.

Nothing is written in this step. It exists because getting any of the three wrong produces a green test asserting the wrong money, which is the one failure mode a plan cannot catch after the fact.

- [ ] **Step 6: Run everything.**

Run: `cd packages/db && bun run test -- sync/shift-close`
Expected: **13 passed** — this task's thirteen cases, in their own file with their own container.

Run: `cd packages/db && bun run test -- sync/shifts`
Expected: **10 passed** — Task 3's file, unchanged by this task.

Run: `cd packages/db && bun run test -- sync/apply`
Expected: green and unchanged.

Run: `cd tests && bun run test -- ledger-balance`
Expected: green. 1B's invariant suite asserts Σdebit = Σcredit per document across the whole database, and a `TILL_OVER_SHORT` is two lines of one magnitude — so a sign error in Step 3 fails **here** as well as in the two sign cases above, which is the cross-check worth having.

Run: `bun run lint:rules`
Expected: **green**, as at the end of every earlier task. Three rules bite here and all three pass: `posting-only-tables` allows `packages/db/src/posting/**` (and `shifts.ts` writes no protected table); `no-number-money` finds `expectedCash`, `countedCash`, `overShort` and `openingFloat` typed `Money` or `string`, never `number`; and `permission-catalogue` finds `pos.shift.close_any` referenced — by Step 3's `POS_PERMISSION.shiftCloseAny` in the `app.principal_has` call **and** already by Task 2 Step 6's literal in `authority.ts`, which is the reference that made the rule green three tasks ago.

- [ ] **Step 7: Commit — the close path, inside PR 2.**

```bash
git add packages/db/src/posting/till.ts packages/db/src/sync/shifts.ts packages/db/src/index.ts \
        packages/db/test/sync/shift-close.test.ts tests/invariants/support/staff.ts
git commit -m "feat(db): the shift close derives expected_cash and posts TILL_OVER_SHORT [6D T5]

expected_cash is one read of the 1110 leg in the shift's own currency over the
shift's posted-or-reversed documents, TILL_OVER_SHORT excluded (ADR 0063). The
till sends countedCash and nothing else. over_short = counted - expected, positive
is over; its sign picks which of two account codes is the debit and the magnitude
is always positive. An exact count posts no document. A re-sent close answers
duplicate and the first count stands. pos.shift.own for one's own drawer,
pos.shift.close_any for another's, both through app.principal_has.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The till-event apply path — `no_sale`, `drawer_open`, `void`

**The last of 6A's two refusals goes away here.** `refuseUnsupported` is deleted whole and the `tillEvents` array becomes real inserts into the append-only `app.till_event`. Nothing about this path touches money: an event is a fact about a drawer, and a `void` names the ticket it is about through that ticket's own `client_ref`.

**Files**
- Create: `packages/db/src/sync/till-events.ts`, `packages/db/test/sync/till-events.test.ts`
- Modify: `packages/db/src/sync/apply.ts` (delete `refuseUnsupported` and `refOf`, wire the real path), `packages/db/src/sync/index.ts`, `packages/db/test/sync/apply.test.ts` (the one case's last two lines), **`apps/api/src/routes/sync/tickets.ts`** (Step 5's unknown-array-key guard — the replacement raiser for `ERR_SYNC_MESSAGE_UNSUPPORTED`), **`apps/api/test/routes/sync/tickets.test.ts`** (one case for it)

**Interfaces**

- Consumes: `assertShiftKnown` (Task 3); `runMessage`, `TerminalApplyContext`, `MessageOutcome`, `SyncError` (6A/Task 3); `app.till_event` (Task 1); `app.document` (for the `void`'s ticket lookup); `seedShift` (Task 1), `seedTerminal` (6A); `Seed`, `withTenant`, `uuidv7` (§4.1); **`posFixture`, `PosFixture`, `buildTicket` (6A, `tests/invariants/support/pos.ts`) and `startApi`, `StartedApi` (§4.2.12)** — the test file needs a real posted `POS_TICKET` for a `void` to resolve against, and Global Constraint 1 forbids writing one by hand, so this file takes the same `startApi()` dependency Tasks 5 and 7 take rather than `startDb()`.
- Produces:

```ts
// packages/db/src/sync/till-events.ts — exported from @dulja/db.

/** The db-tier structural twin of §4.10.1's `TillEventMsg`. `kind` is `string` for §3.1's reason. */
export interface TillEventInput {
  clientRef: string;
  shiftId: string;
  kind: string;
  /** The ticket this event is about, BY ITS CLIENT REF — never by a document id the till cannot know. */
  ticketClientRef: string | null;
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
}

/** §4.10.1's ack key for a till event: the till's own `clientRef`. */
export function tillEventRef(m: unknown): string;

/** Inserts one append-only event. Idempotent on `client_ref` (globally unique, §4.6.1). Throws
 *  `SyncError`; the caller's savepoint turns that into a `rejected` outcome. */
export async function applyTillEvent(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: TillEventInput,
): Promise<MessageOutcome>;
```

- [ ] **Step 1: Write the failing test `packages/db/test/sync/till-events.test.ts`.**

**This file's world is `posFixture`, not a bare `seedTenantV2`.** Two of its cases need a **real posted `POS_TICKET`** for a `void` to resolve against, and posting one requires an item with stock, a warehouse, a tax pack and the seeded `POS_TICKET` document type — the whole corpus `posFixture` builds and that `seedTenantV2` does not. The alternative was a hand-written `document` + `ledger_entry` insert, which Global Constraint 1 forbids outright. So this file takes the same `startApi()` dependency the slice's other DB-tier sync tests take (Task 5's `shift-close.test.ts`, Task 7's `reports/pos.test.ts`), starts one container of its own and stops it.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
import { tillEventRef } from "../../src/sync/till-events";
import { seedShift, seedTerminal, type Seed } from "../fixtures";
import { uuidv7, withTenant, type Db } from "../harness";
import { startApi, type StartedApi } from "../../../../apps/api/test/support/app";
import { buildTicket, posFixture, type PosFixture } from "../../../../tests/invariants/support/pos";

describe("6D till events — the append-only ticket stream (spec:1354, §4.6.1)", () => {
  let api: StartedApi;
  let db: Db;
  let f: PosFixture;
  let s: Seed;
  let t1: { terminalId: string; principalId: string };
  let t2: { terminalId: string; principalId: string };
  let shiftId: string;
  let foreignShiftId: string;

  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "drawer");     // items with stock, the tax pack, POS_TICKET, one terminal
    db = api.db;
    s = f.s;                                  // `PosFixture`'s member is `s`, not `seed` (6A Task 10 Step 5)
    t1 = f.terminal;                           // enrolled at s.hq — the branch every case below asserts
    t2 = await seedTerminal(db, s, { code: "T2" });
    shiftId = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    foreignShiftId = await seedShift(db, s, { terminalId: t2.terminalId, cashierPrincipalId: s.human });
  }, 300_000);
  afterAll(async () => { await api.stop(); });

  const ev = (over: Record<string, unknown> = {}) => ({
    clientRef: crypto.randomUUID(), shiftId, kind: "no_sale", ticketClientRef: null,
    cashierPrincipalId: s.human, supervisorPrincipalId: null,
    occurredAt: new Date().toISOString(), ...over,
  });

  const apply = (tillEvents: unknown[], terminal = t1) =>
    withTenant(db.rw, s.tenant, terminal.principalId, (tx) =>
      applyBatch(tx as never, { tenantId: s.tenant, actorId: terminal.principalId, companyId: s.company },
        { terminalId: terminal.terminalId, companyId: s.company, branchId: s.hq, principalId: terminal.principalId },
        { terminalId: terminal.terminalId, batchId: crypto.randomUUID(), tickets: [], shifts: [], tillEvents }));

  /**
   * One cash `POS_TICKET` at the till's own `clientRef`, in `shift`, posted through the REAL apply path.
   * Returns nothing — the two `void` cases resolve the document by `client_ref`, which is the only handle
   * the till has and therefore the only one worth testing.
   *
   * `buildTicket`'s `clientRef` option is what makes the ref caller-chosen; everything else is 6A's
   * default (`SKU-A`, quantity 1, the seeded output tax code). Global Constraint 1: no `document` or
   * `ledger_entry` insert appears here, so what a `void` resolves against is a document the posting
   * service actually wrote.
   */
  const insertPostedTicket = async (shift: string, clientRef: string): Promise<void> => {
    const out = await withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
      applyBatch(tx as never, { tenantId: s.tenant, actorId: t1.principalId, companyId: s.company },
        { terminalId: t1.terminalId, companyId: s.company, branchId: s.hq, principalId: t1.principalId },
        { terminalId: t1.terminalId, batchId: crypto.randomUUID(), shifts: [], tillEvents: [],
          tickets: [buildTicket(f, { sku: "SKU-A", shiftId: shift, clientRef, tender: "cash" })] }));
    expect(out.results[0]!.status).toBe("accepted");
  };

  /** A ticket OBJECT for the in-batch case, not applied — the point of that case is that the ticket and
   *  the `void` event about it travel in one payload and the event still resolves, which only works
   *  because till events run last (Task 3's `3d`). */
  const buildTicketLocal = (shift: string) =>
    buildTicket(f, { sku: "SKU-A", shiftId: shift, clientRef: crypto.randomUUID(), tender: "cash" });

  it("tillEventRef is the clientRef, and an unkeyable message acks as the empty string", () => {
    expect(tillEventRef({ clientRef: "abc" })).toBe("abc");
    expect(tillEventRef({})).toBe("");
    expect(tillEventRef(null)).toBe("");
  });

  it("a no_sale is inserted with the branch and terminal from the CONTEXT", async () => {
    const m = ev();
    const out = await apply([m]);
    expect(out.tillEventResults).toEqual([{ ref: m.clientRef, status: "accepted", error: null }]);
    const [row] = await db.admin<{
      kind: string; branch_id: string; terminal_id: string; shift_id: string;
      cashier_principal_id: string; supervisor_principal_id: string | null; ticket_document_id: string | null;
    }[]>`select kind, branch_id::text, terminal_id::text, shift_id::text, cashier_principal_id::text,
                supervisor_principal_id::text, ticket_document_id::text
           from app.till_event where client_ref = ${m.clientRef}`;
    expect(row!.kind).toBe("no_sale");
    expect(row!.branch_id).toBe(s.hq);
    expect(row!.terminal_id).toBe(t1.terminalId);
    expect(row!.shift_id).toBe(shiftId);
    expect(row!.supervisor_principal_id).toBeNull();
    expect(row!.ticket_document_id).toBeNull();
  });

  // `void` is the third admitted kind and is NOT sent here: it requires a `ticketClientRef` naming a
  // ticket the server has posted, so admitting it is a three-case story of its own further down
  // ("a void resolves its ticket by CLIENT REF…", "…never seen is rejected…", "…in the SAME batch…").
  // The claim this case makes is the two unconditional kinds plus the CHECK's closed vocabulary; a title
  // saying "all three" while sending two would be a green test asserting less than it claims.
  it("no_sale and drawer_open are admitted, and a kind outside the CHECK is rejected by name", async () => {
    const out = await apply([ev({ kind: "no_sale" }), ev({ kind: "drawer_open" }),
                             ev({ kind: "cash_count" })]);
    expect(out.tillEventResults.map((r) => r.status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(out.tillEventResults[2]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.tillEventResults[2]!.error!.detail).toContain("cash_count");
    // …and the refusal names the vocabulary, so a till author reads the fix out of the message.
    expect(out.tillEventResults[2]!.error!.detail).toContain("void");
  });

  it("re-sending an event answers duplicate and inserts nothing a second time", async () => {
    const m = ev({ kind: "drawer_open" });
    await apply([m]);
    const out = await apply([m]);
    expect(out.tillEventResults[0]!.status).toBe("duplicate");
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_event where client_ref = ${m.clientRef}`;
    expect(n!.n).toBe(1);
  });

  it("an event naming a shift of ANOTHER terminal is rejected (assertShiftKnown)", async () => {
    const out = await apply([ev({ shiftId: foreignShiftId })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");
  });

  it("a no_sale carrying a ticketClientRef is rejected — the CHECK and the message agree", async () => {
    const out = await apply([ev({ kind: "no_sale", ticketClientRef: crypto.randomUUID() })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.detail).toContain("only a void");
  });

  it("a void resolves its ticket by CLIENT REF to a document id, and a supervisor is recorded", async () => {
    // A real posted ticket in this shift, so the resolution has something to find.
    const ticketRef = crypto.randomUUID();
    await insertPostedTicket(shiftId, ticketRef);
    const m = ev({ kind: "void", ticketClientRef: ticketRef, supervisorPrincipalId: s.human });
    const out = await apply([m]);
    expect(out.tillEventResults[0]!.status).toBe("accepted");
    const [row] = await db.admin<{ ticket_document_id: string; supervisor_principal_id: string }[]>`
      select ticket_document_id::text, supervisor_principal_id::text
        from app.till_event where client_ref = ${m.clientRef}`;
    const [doc] = await db.admin<{ id: string }[]>`
      select id::text from app.document where company_id = ${s.company} and client_ref = ${ticketRef}`;
    expect(row!.ticket_document_id).toBe(doc!.id);
    expect(row!.supervisor_principal_id).toBe(s.human);
  });

  it("a void naming a ticket the server has never seen is rejected, not stored with a null ticket", async () => {
    const out = await apply([ev({ kind: "void", ticketClientRef: crypto.randomUUID() })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");
    expect(out.tillEventResults[0]!.error!.detail).toContain("ticketClientRef");
  });

  it("a void in the SAME batch as its ticket resolves it (till events run last — Task 3's order)", async () => {
    const shift2 = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    const ticket = buildTicketLocal(shift2);
    const m = ev({ shiftId: shift2, kind: "void", ticketClientRef: ticket.clientRef, supervisorPrincipalId: s.human });
    const out = await withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
      applyBatch(tx as never, { tenantId: s.tenant, actorId: t1.principalId, companyId: s.company },
        { terminalId: t1.terminalId, companyId: s.company, branchId: s.hq, principalId: t1.principalId },
        { terminalId: t1.terminalId, batchId: crypto.randomUUID(), shifts: [], tickets: [ticket], tillEvents: [m] }));
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.tillEventResults[0]!.status).toBe("accepted");
  });

  it("one bad event does not roll back its neighbours (savepoint per message)", async () => {
    const good = ev();
    const out = await apply([good, ev({ kind: "nope" }), ev()]);
    expect(out.tillEventResults.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_event where client_ref = ${good.clientRef}`;
    expect(n!.n).toBe(1);
  });

  it("no needs_attention row is written for a refused event (amendment A10)", async () => {
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.needs_attention`;
    await apply([ev({ kind: "nope" })]);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.needs_attention`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
```

`insertPostedTicket(shiftId, clientRef)` and `buildTicketLocal(shiftId)` are **test-local** helpers, written out in the block above: the first posts one cash `POS_TICKET` through `applyBatch`, the second returns a ticket object for the in-batch case. They are written here rather than imported from `shift-close.test.ts` because §3.7.1 makes each test file its own topic with its own container, and a test file that imported another's helpers would inherit its fixture too.

Run: `cd packages/db && bun run test -- sync/till-events`
Expected: **FAIL** — `SyntaxError: The requested module '../../src/sync/till-events' does not provide an export named 'tillEventRef'`.

- [ ] **Step 2: Write `packages/db/src/sync/till-events.ts`.**

```ts
import type { Sql } from "postgres";
import { SyncError } from "./enrolment";
import { assertShiftKnown } from "./shifts";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

export interface TillEventInput {
  clientRef: string;
  shiftId: string;
  kind: string;
  ticketClientRef: string | null;
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
}

const KINDS = new Set(["no_sale", "drawer_open", "void"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §4.10.1's ack key. An unkeyable message acks as `""`, which matches no outbox row, so the till keeps
 *  it pending — the safe direction (spec:1337), and the same shape as `shiftRef`. */
export function tillEventRef(m: unknown): string {
  return String(((m ?? {}) as Record<string, unknown>).clientRef ?? "");
}

/**
 * One append-only event.
 *
 * **Idempotent on `client_ref`, which §4.6.1 makes globally unique** — not `(company_id, client_ref)`.
 * The ref is the till's own uuidv7, so a collision across companies is not a real event, and the global
 * key means the dedup read needs no company in hand. Read-then-insert with `on conflict do nothing`, so
 * both the common case and the concurrent race answer `duplicate` (6A's `applyTicket` step (a) shape).
 *
 * **A `void` names its ticket by CLIENT REF and this function resolves it.** The till minted that ref
 * offline and has no document id; storing the ref would leave the join to every future reader, and
 * `till_event.ticket_document_id` has a composite FK to `app.document` that a ref cannot satisfy. A void
 * whose ticket the server has never seen is **rejected** rather than stored with a null: the till will
 * re-send both, and till events run last in the batch (Task 3 step 3d) precisely so a void and its ticket
 * can arrive together.
 */
export async function applyTillEvent(
  sp: Sql, _ctx: TenantContext, terminal: TerminalApplyContext, msg: TillEventInput,
): Promise<MessageOutcome> {
  const ref = tillEventRef(msg);
  const at = `till event ${msg.clientRef}`;

  if (!UUID_RE.test(String(msg.clientRef))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: clientRef is not a uuid — the till mints it (§4.10.1)`);
  }
  if (!KINDS.has(msg.kind)) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: kind must be no_sale, drawer_open or void, received ${JSON.stringify(msg.kind)}`);
  }
  if (msg.kind !== "void" && msg.ticketClientRef !== null && msg.ticketClientRef !== undefined) {
    // The DDL says the same thing (`till_event_ticket_only_on_void`), and refusing here gives the till a
    // sentence instead of a constraint name. Both are kept: the CHECK guards every other writer.
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: only a void names a ticket; a ${msg.kind} is about the drawer and carries ticketClientRef null`);
  }
  if (!UUID_RE.test(String(msg.cashierPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: cashierPrincipalId is not a uuid`);
  }
  if (Number.isNaN(Date.parse(String(msg.occurredAt)))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: occurredAt is not an ISO 8601 timestamp`);
  }

  // The shift must exist and be THIS terminal's — the same reference `assertShiftKnown` enforces for a
  // ticket (amendment A2). `till_event.shift_id` DOES carry a real composite FK, because `app.shift`
  // exists before any `till_event` row can: the pre-6D backfill problem that stopped 0070 from keying
  // `document.shift_id` has no analogue here. Calling the function anyway gives the same sentence.
  await assertShiftKnown(sp, terminal, msg.shiftId);

  const [existing] = await sp<{ id: string }[]>`
    select id from app.till_event where client_ref = ${msg.clientRef}`;
  if (existing) return { ref, status: "duplicate", error: null };

  let ticketDocumentId: string | null = null;
  if (msg.kind === "void") {
    if (!UUID_RE.test(String(msg.ticketClientRef))) {
      throw new SyncError("ERR_VALIDATION_FAILED", `${at}: a void requires ticketClientRef as a uuid`);
    }
    const [doc] = await sp<{ id: string }[]>`
      select id from app.document
       where company_id = ${terminal.companyId} and client_ref = ${msg.ticketClientRef}`;
    if (!doc) {
      throw new SyncError("ERR_CONFLICT_REFERENCE",
        `${at}: ticketClientRef ${msg.ticketClientRef} names no ticket in company ${terminal.companyId};`
        + ` send the ticket in this batch or before it — till events are applied after tickets (§4.10.1)`);
    }
    ticketDocumentId = doc.id;
  }

  const inserted = await sp<{ id: string }[]>`
    insert into app.till_event (tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                ticket_document_id, cashier_principal_id, supervisor_principal_id,
                                occurred_at, client_ref)
    values (app.current_tenant(), ${terminal.companyId}, ${terminal.branchId}, ${terminal.terminalId},
            ${msg.shiftId}, ${msg.kind}, ${ticketDocumentId}, ${msg.cashierPrincipalId},
            ${msg.supervisorPrincipalId ?? null}, ${msg.occurredAt}::timestamptz, ${msg.clientRef})
    on conflict (client_ref) do nothing
    returning id`;

  return { ref, status: inserted.length === 1 ? "accepted" : "duplicate", error: null };
}
```

- [ ] **Step 3: Wire it and delete `refuseUnsupported` — `packages/db/src/sync/apply.ts`.**

```ts
import { applyTillEvent, tillEventRef, type TillEventInput } from "./till-events";
```

```ts
  // 3d. Till events, LAST. A `void` names the ticket it is about, and that ticket is applied at 3b — so
  //     a void and its ticket may travel in one batch, which is what a till does when a supervisor voids
  //     the sale that was just rung up. `runMessage` gives each event its own savepoint, so one bad event
  //     leaves the tickets and the shifts of the same batch committed.
  const tillEventResults: MessageOutcome[] = [];
  for (const raw of batch.tillEvents) {
    const msg = (raw ?? {}) as TillEventInput;
    tillEventResults.push(
      await runMessage(tx, tillEventRef(raw), (sp) => applyTillEvent(sp, ctx, terminal, msg)),
    );
  }

  return {
    batchId: batch.batchId,
    results,
    shiftResults: [...shiftOutcomes],
    tillEventResults,
    catalogueRevision,
  };
```

**Delete `refuseUnsupported` and `refOf` entirely.** Both were 6A's temporary scaffolding and both are now dead: `shiftRef` (Task 3) and `tillEventRef` (this task) replace `refOf`'s two arms, each in the file that owns its message kind. A dead private function is not a lint error, so **grep for both names after deleting them** — `grep -rn "refuseUnsupported\|refOf" packages/db/src apps` must print nothing.

- [ ] **Step 4: Delete the shift/till-event capability comments 6A left behind.**

6A's `refuseUnsupported` carried a long comment explaining why it had no `to_regclass` probe. That reasoning still applies to `runMessage`'s placement — a throw outside a savepoint 500s the batch — and Task 3 already restated it on `runMessage`. Remove the orphaned copy so one explanation exists in one place (hazard 9's spirit applied to comments).

- [ ] **Step 5: Finish 6A's one edited case.**

**Use 6A's own fixture spelling, which Task 3 Step 5 already told you to read first: `f.terminal.terminalId` and `f.cashierId`.** 6A's `beforeAll` binds one `PosFixture` as `f` and every case in that file reaches through it (6A Task 11 Step 1's own test file); a bare `terminal`/`cashierId` resolves to nothing. The block below is written in that spelling and Task 3 Step 5's version of the same case is written in it too, so the two steps agree character for character.

```ts
// packages/db/test/sync/apply.test.ts — Task 3 Step 6 left two lines about a refused till event. Both go.
  it("a shift OPEN and a till event are both applied (§4.10.1; 6D replaced 6A's refusal)", async () => {
    const id = crypto.randomUUID();
    const evRef = crypto.randomUUID();
    const out = await apply([], [{
      shiftId: id, kind: "open", terminalId: f.terminal.terminalId, cashierPrincipalId: f.cashierId,
      at: new Date().toISOString(), currency: "MYR",
      openingFloat: { amount: "0.0000", currency: "MYR" }, countedCash: null,
    }], [{
      clientRef: evRef, shiftId: id, kind: "no_sale", ticketClientRef: null,
      cashierPrincipalId: f.cashierId, supervisorPrincipalId: null, occurredAt: new Date().toISOString(),
    }]);
    expect(out.shiftResults[0]!.status).toBe("accepted");
    expect(out.tillEventResults[0]!.status).toBe("accepted");
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_event where client_ref = ${evRef}`;
    expect(n!.n).toBe(1);
  });
```

The event's `shiftId` is the shift the same batch just opened — which works because opens run at 3a and till events at 3d, and is a second, incidental proof of the ordering.

- [ ] **Step 6: Give `ERR_SYNC_MESSAGE_UNSUPPORTED` its replacement raiser, in `apps/api/src/routes/sync/tickets.ts`.**

**Why this step exists.** Deleting `refuseUnsupported` removes the last raiser of `ERR_SYNC_MESSAGE_UNSUPPORTED` in `packages/db` — 6A's `applyTicket` step (c) raised it for a `Ticket.attendance` array before 6C, and 6C replaced that too. **Check first**: `grep -rn "ERR_SYNC_MESSAGE_UNSUPPORTED" packages apps`. If the only hits are `packages/contracts/src/errors.ts` and a test, the `error-codes` lint (§4.2.4, spec:2051 — "a code no code raises fails the build") is red. **The fix is not to delete the row**: it is a documented wire code a client may still receive from a capability gap, and Task 9 makes this same guard the permanent raiser by growing its known-key set from three to four.

**It must read the RAW body, not `c.req.valid("json")`.** 6A validates against `TicketBatchBody = TicketBatchSchema.refine(…)` (6A Task 12 Step 2) and `TicketBatchSchema` is a plain `z.object`, which **strips** unknown keys instead of rejecting them — so by the time the handler sees `batch`, a `cashEvents` array the server does not know is already gone and there is nothing left to refuse. `.strict()` on 6A's schema would change 6A's error shape and is not this slice's to change (§4.18). `c.req.json()` is memoised by Hono, so re-reading it costs nothing.

```ts
// apps/api/src/routes/sync/tickets.ts — a module-level const and four lines at the top of the handler.

/**
 * The top-level keys a `TicketBatch` may carry on THIS deployment (§4.10.1). A key outside this set is
 * refused whole with `ERR_SYNC_MESSAGE_UNSUPPORTED`, never dropped: a till whose build is ahead of the
 * server must keep its outbox row and re-send after the server catches up (spec:1337), and a silently
 * stripped array is the "lost message with no trace" failure acceptance test 21 exists to catch.
 *
 * ⚠️ **Task 9 adds `"cashEvents"` to this set** when OD-10 = yes, and that is the only edit it needs here.
 */
const KNOWN_BATCH_KEYS = new Set(["terminalId", "batchId", "tickets", "shifts", "tillEvents"]);

// …inside the handler, BEFORE `const batch = c.req.valid("json");`:
  const raw = (await c.req.json()) as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_BATCH_KEYS.has(k)).sort();
  if (unknownKeys.length > 0) {
    throw new AppError("ERR_SYNC_MESSAGE_UNSUPPORTED",
      `this server does not understand the batch key(s) ${unknownKeys.join(", ")}`
      + " — nothing in this batch was applied; keep every outbox row pending and re-send after the"
      + " server is upgraded");
  }
```

`AppError` and `ERRORS` are already imported by this file (6A Task 12), so no import changes.

⚠️ **The response status is whatever `ERRORS` maps, and §4.2.4 gives this row `200 (per-message)`** (contracts:1576). That is deliberate on 6A's part — the code was designed to travel inside `MessageResult.error`, never as an HTTP status — so a *request-level* refusal that raises it answers **200 with a `Problem` body**. It is an odd pair, and it is still the right behaviour for the property that matters: nothing was applied and nothing was acked, so `drainOutbox` leaves every outbox row pending (spec:1337, §4.10.5). **Do not "fix" it by editing the `ERRORS` row to a 4xx** — that row is 6A's and §4.18 makes 6A the authority; if a reviewer wants a request-level status for this code, that is a §4.2.4 amendment raised against 6A/0B, not a change made here. Assert the status the registry gives and move on.

Append one case to **6A's** route suite, in the same commit:

```ts
// apps/api/test/routes/sync/tickets.test.ts — appended below 6A's own cases; `f`, `api`, `buildTicket`
// and `syncRequest` are already in that file's scope (6A Task 12 Step 1's import header).
  it("a batch carrying an array this server does not know is REFUSED, never stripped (§4.10.1)", async () => {
    const ticket = buildTicket(f, { sku: "SKU-A" });
    const res = await syncRequest(api, f.terminal, {
      method: "POST", path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId, batchId: crypto.randomUUID(),
        tickets: [ticket], shifts: [], tillEvents: [],
        // A key from a till build ahead of this server. Before this guard, `TicketBatchSchema` — a plain
        // `z.object` — STRIPPED it, `applyBatch` never saw it, and the till acked messages the server
        // had silently discarded. That is the "lost message with no trace" test 21 exists to catch.
        cashEvents: [{ clientRef: crypto.randomUUID(), kind: "paid_out" }],
      },
    });
    // 200 with a Problem body: §4.2.4 gives ERR_SYNC_MESSAGE_UNSUPPORTED the status `200 (per-message)`
    // (contracts:1576), and this plan adds no ERRORS row (Global Constraint 11).
    expect(res.status).toBe(200);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_SYNC_MESSAGE_UNSUPPORTED");
    expect(problem.detail).toContain("cashEvents");

    // Nothing of the batch was applied — the refusal happens before `applyBatch` — so the till's own
    // ticket is still pending in its outbox and will be re-sent, not lost.
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = ${ticket.clientRef}::uuid`;
    expect(n!.n).toBe(0);
  });
```

- [ ] **Step 7: Run everything.**

Run: `cd packages/db && bun run test -- sync/till-events`
Expected: **11 passed.**

Run: `cd packages/db && bun run test -- sync`
Expected: green across `apply`, `shifts` (10), `shift-close` (13), `till-events` (11), `catalogue-revision`, `enrolment` and `pos-columns`.

Run: `cd packages/db && bun run test -- schema-lint`
Expected: green — `till_event`'s `IMMUTABLE` membership means the linter checks for the `forbid_change` trigger and the absent `UPDATE`/`DELETE` grants, both of which Task 1 attached, and this task inserts rows without touching either.

Run: `cd apps/api && bun run test -- sync/tickets`
Expected: green, with 6A's own cases untouched and Step 6's one new case passing.

Run: `bun run lint:rules && bun run typecheck`
Expected: green. **`error-codes` is the one to watch, and Step 6 is why**: `refuseUnsupported` was the last raiser of `ERR_SYNC_MESSAGE_UNSUPPORTED` in `packages/db`, and Step 6's route guard is its replacement. If that rule reports the code, Step 6's guard was not written or its file was not staged — do not delete the `ERRORS` row (Global Constraint 11: this slice adds and removes none).

- [ ] **Step 8: Commit.**

```bash
git add packages/db/src/sync/till-events.ts packages/db/src/sync/apply.ts packages/db/src/sync/index.ts \
        packages/db/test/sync/till-events.test.ts packages/db/test/sync/apply.test.ts \
        apps/api/src/routes/sync/tickets.ts apps/api/test/routes/sync/tickets.test.ts
git commit -m "feat(db): the till-event apply path, and 6A's last refusal is deleted [6D T6]

app.till_event rows are append-only and idempotent on the globally-unique
client_ref. A void resolves its ticket by CLIENT REF — the till has no document
id — and is rejected rather than stored with a null when the server has not seen
that ticket; till events run last in the batch so a void and its ticket can
travel together. refuseUnsupported and refOf are deleted: shiftRef and
tillEventRef replace them, each in the file that owns its message kind.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `pos.z_report` and `pos.sales_by_cashier`, the `shifts` route module, and the probe

**The minimal report surface Phase 6 owes** (hazard 4: reports ship inside each phase; Phase 7 is the engine). Two read functions, two `GET`s on **1B's existing** `reports` module, and one new `shifts` module for the list and detail reads a back office needs. 7C re-expresses both codes as `ReportDefinition`s **over these same functions** and re-runs Task 8's tie-out unchanged (§4.16.1), which is why the function names are contract.

**Files**
- Create: `packages/db/src/reports/pos.ts`, `packages/contracts/src/pos/shift.ts`, `packages/contracts/src/pos/reports.ts`, `apps/api/src/routes/pos/shifts.ts`, `packages/db/test/reports/pos.test.ts`, `apps/api/test/routes/pos/shifts.test.ts`
- Modify: `packages/contracts/src/accounting/reports.ts` (`ReportCodeSchema` gains two members), `apps/api/src/routes/accounting/reports.ts` (two `GET`s and one `permissions` entry), `apps/api/src/routes/index.ts` (`shiftRouteModule` inside `buildRoutes`), `packages/db/src/index.ts`, `packages/contracts/src/index.ts`, `tests/invariants/probes.ts` (one entry), `packages/contracts/openapi.json` (regenerated)

**Interfaces**

- Consumes: `app.shift`, `app.till_event` (Task 1); `app.ledger_entry`, `app.document`, `app.document_type`, `app.account` (1A/2A); `PERMISSION`, `requirePermission`, `ScopeSource` (§4.2.5); `RouteModule`, `buildRoutes`, `IdempotencyHeader` (§4.2.7); `reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema` (1B); `AppEnv`, `c.var.withTenant`, `c.var.logger` (§4.2.3); `UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CurrencySchema`, `CursorSchema`, `ListEnvelope`, `ListQuery`, `encodeCursor`, `decodeCursor` (§4.2.8); `AppError`, `Problem` (§4.2.4); `startApi`, `ApiRequest`, `StartedApi`, `problemOf` (§4.2.12, 0B); `IsolationProbe`, `PROBES` (§4.2.7); `staffFixture`, `StaffFixture` (6C); `buildTicket` (6A); `applyBatch` (Tasks 3, 6); `grantCodes` (2B); `seedShift` (Task 1); `uuidv7`, `withTenant` (§4.1/§4.2.2).
- Produces (Task 0 amendment A5 — the §4.16.3 additions, exported from `@dulja/db`):

```ts
// packages/db/src/reports/pos.ts

export interface ZReportParams {
  companyId: string;
  /** One shift → exactly one Z-report. */
  shiftId?: string;
  /** A range → the shift HISTORY §4.16.1 names, under the SAME code. That is why both return an array. */
  branchId?: string; from?: string; to?: string;
  limit: number;
  cursor?: { openedAt: string; shiftId: string } | null;
}
export interface ZReportTender { method: string; accountCode: string; amount: string; currency: string }
/** No `kind` member — the section it appears in *is* the kind. Step 2 carries the full reasoning. */
export interface ZReportCashLine { documentTypeCode: string; amount: string; currency: string }
export interface ZReport {
  shiftId: string; branchId: string; terminalId: string; terminalCode: string;
  openedAt: string; closedAt: string | null;
  openedPrincipalId: string; closedPrincipalId: string | null;
  currency: string;
  openingFloat: string; countedCash: string | null; expectedCash: string | null; overShort: string | null;
  overShortDocumentId: string | null;
  ticketCount: number; returnCount: number;
  /** Σ by tender method over this shift's POS_TICKET documents, from the LEDGER (§4.6.5). */
  tenders: ZReportTender[];
  /** The cash-control movements on 1110 that are not ticket tenders: ⚠️ paid-outs, safe drops, bankings
   *  and the over/short itself, one row per document type. Empty when OD-10 = no and the count was exact. */
  cashControl: ZReportCashLine[];
  tillEvents: { kind: string; count: number }[];
}
export async function zReport(tx: Sql, params: ZReportParams): Promise<ZReport[]>;

export interface SalesByCashierParams {
  companyId: string; from: string; to: string;
  branchId?: string; cashierPrincipalId?: string;
  limit: number;
  cursor?: { cashierPrincipalId: string } | null;
}
export interface SalesByCashierRow {
  cashierPrincipalId: string; cashierName: string; branchId: string;
  ticketCount: number; returnCount: number;
  /** Σ credits − Σ debits on income-type accounts, in base — revenue, never a document_line sum. */
  netSalesBase: string; baseCurrency: string;
  discountBase: string; overShortBase: string;
}
export async function salesByCashier(tx: Sql, params: SalesByCashierParams): Promise<SalesByCashierRow[]>;
```

```ts
// apps/api/src/routes/pos/shifts.ts
export const shiftRoutes: OpenAPIHono<AppEnv>;
export const shiftRouteModule: RouteModule;   // path "/v1/companies/:companyId/shifts", gate pos.report.read
```

- [ ] **Step 1: Write the failing DB-tier test `packages/db/test/reports/pos.test.ts`.**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { salesByCashier, zReport } from "../../src/reports/pos";
import { grantCodes, type Seed } from "../fixtures";
import { uuidv7, withTenant, type Db } from "../harness";
import { startApi, type StartedApi } from "../../../../apps/api/test/support/app";
import { buildTicket } from "../../../../tests/invariants/support/pos";
import { staffFixture, type StaffFixture } from "../../../../tests/invariants/support/staff";
import { applyBatch } from "../../src/sync/apply";

describe("6D POS reports — pos.z_report and pos.sales_by_cashier (§4.16.1, §4.16.3)", () => {
  let api: StartedApi;
  let db: Db;
  let f: StaffFixture;
  let shiftId: string;
  /** The `clientRef` of the 10.0000 cash sale, so the refund can point at it — a return with a null
   *  `returnsClientRef` is a BLIND return and branch A refuses those (see the note below this block). */
  let tenRef: string;

  beforeAll(async () => {
    api = await startApi();
    db = api.db;
    f = await staffFixture(api, "zrep");
    await grantCodes(db, f.seed, { codes: ["pos.shift.own"], principalId: f.cashierA,
                                   roleCode: "own-z", branchIds: [f.branchA] });
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    // Two cash sales, one card sale, one cash return, then a short close — the smallest corpus in which
    // every line of the report is non-trivial.
    tenRef = crypto.randomUUID();
    await sellInto(shiftId, [
      { unitPrice: "40.0000", tender: "cash" },
      { unitPrice: "10.0000", tender: "cash", clientRef: tenRef },
      { unitPrice: "25.0000", tender: "card" },
    ]);
    await returnInto(shiftId, { unitPrice: "10.0000", tender: "cash", returnsClientRef: tenRef });
    await closeShiftFor(shiftId, "138.0000");           // expected 140 → short 2
  }, 300_000);

  afterAll(async () => { await api.stop(); });          // this file starts its own stack, so it stops it

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.seed.tenant, f.seed.human, fn as never) as Promise<T>;

  /** One `applyBatch` of `n` tickets into `shiftId`, through the real path. `opts` are 6A's `buildTicket`
   *  options verbatim — `unitPrice` + `tender`, never a `cashPrice`/`cardPrice` that does not exist
   *  (Task 5 Step 5's first fact). Returns the posted document ids. */
  const sellInto = async (
    shift: string, tickets: readonly Parameters<typeof buildTicket>[1][],
  ): Promise<string[]> => {
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), shifts: [], tillEvents: [],
          tickets: tickets.map((t) => buildTicket(f.pos, { sku: "SKU-A", shiftId: shift, ...t })) }));
    expect(out.results.map((r) => r.status)).toEqual(tickets.map(() => "accepted"));
    return out.results.map((r) => r.documentId!);
  };

  /** The same, for one `kind: "return"` ticket. **`returnsClientRef` is required, not optional.** 6C
   *  classifies `kind === "return"` with `returnsClientRef === null` as a BLIND return (6C Task 9 Step 1(b)), which
   *  needs `pos.ticket.return_blind` AND `blind_return_allowed = true`; `staffFixture` sets branch A's
   *  `blind_return_allowed` to false and gives `cashierA` `pos.ticket.return` and not `return_blind`
   *  (6C Task 9 Step 2's `staffFixture`). A refund with a null ref is therefore REFUSED at branch A and every figure below
   *  would be short by it — with `out.results[0].status === "rejected"` as the only clue. 6A's builder
   *  negates quantity, total, tax, discount and the tender together inside itself; nothing is negated here. */
  const returnInto = async (
    shift: string, opts: Parameters<typeof buildTicket>[1] & { returnsClientRef: string },
  ): Promise<string> => {
    const [id] = await sellInto(shift, [{ ...opts, kind: "return" }]);
    return id!;
  };

  /** Close `shift` at `counted` through the real sync path — the only way a shift closes (amendment A12),
   *  and the reason there is no `closeShift` fixture (§4.17's note on the `seedShift` row). */
  const closeShiftFor = (shift: string, counted: string) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(), tickets: [], tillEvents: [],
          shifts: [{ shiftId: shift, kind: "close", terminalId: f.terminalA.terminalId,
                     cashierPrincipalId: f.cashierA, at: new Date().toISOString(), currency: "MYR",
                     openingFloat: null, countedCash: { amount: counted, currency: "MYR" } }] }));

  /** A plain human principal with a membership, for the branch-B manager case. Task 5 Step 1 carries the
   *  same helper and the same reason it is test-local rather than a second `fixtures.ts` row (hazard 9). */
  const seedEmployeePrincipal = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  it("one shiftId returns exactly one Z-report with the shift's own figures", async () => {
    const rows = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    expect(rows).toHaveLength(1);
    const z = rows[0]!;
    expect(z.shiftId).toBe(shiftId);
    // `posFixture` enrols its terminal as `KL01` (6A Task 10 Step 6) and `StaffFixture.terminalA` IS that terminal
    // (6C Task 9 Step 2), so the code is read off the fixture and never written as "T1".
    expect(z.terminalCode).toBe(f.terminalA.code);
    expect(z.currency).toBe("MYR");
    expect(z.openingFloat).toBe("100.0000");
    expect(z.countedCash).toBe("138.0000");
    expect(z.expectedCash).toBe("140.0000");
    expect(z.overShort).toBe("-2.0000");
    expect(z.overShortDocumentId).not.toBeNull();
    expect(z.ticketCount).toBe(3);
    expect(z.returnCount).toBe(1);
  });

  it("the tender lines are the LEDGER's movement per §4.15 account, to the cent", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    const byMethod = Object.fromEntries(z!.tenders.map((t) => [t.method, t]));
    expect(byMethod.cash!.accountCode).toBe("1110");
    expect(byMethod.cash!.amount).toBe("40.0000");         // 40 + 10 − 10 refunded
    expect(byMethod.card!.accountCode).toBe("1120");
    expect(byMethod.card!.amount).toBe("25.0000");
    expect(byMethod.transfer).toBeUndefined();             // no transfer tender in this shift: no row
    expect(byMethod.store_credit).toBeUndefined();
  });

  it("the TILL_OVER_SHORT movement is in cashControl and NOT in the cash tender line", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    const cash = z!.tenders.find((t) => t.method === "cash")!;
    expect(cash.amount).toBe("40.0000");                   // NOT 38 — the correction is not a tender
    const tos = z!.cashControl.find((c) => c.documentTypeCode === "TILL_OVER_SHORT")!;
    expect(tos.amount).toBe("-2.0000");                    // the drawer LOST 2 to the correction
  });

  it("a date range returns the shift HISTORY under the same code, newest first, keyset-paged", async () => {
    const second = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });
    await closeShiftFor(second, "5.0000");
    const page1 = await read((tx) => zReport(tx, {
      companyId: f.seed.company, branchId: f.branchA, from: "2026-01-01", to: "2026-12-31", limit: 1,
    }));
    expect(page1).toHaveLength(1);
    const page2 = await read((tx) => zReport(tx, {
      companyId: f.seed.company, branchId: f.branchA, from: "2026-01-01", to: "2026-12-31", limit: 1,
      cursor: { openedAt: page1[0]!.openedAt, shiftId: page1[0]!.shiftId },
    }));
    expect(page2).toHaveLength(1);
    expect(page2[0]!.shiftId).not.toBe(page1[0]!.shiftId);
    expect(page2[0]!.openedAt <= page1[0]!.openedAt).toBe(true);
  });

  it("neither shiftId nor a from/to range is ERR_VALIDATION_FAILED, not a full-table scan", async () => {
    await expect(read((tx) => zReport(tx, { companyId: f.seed.company, limit: 50 })))
      .rejects.toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("the till-event counts are per kind and omit a kind with no events", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    expect(z!.tillEvents).toEqual([]);                     // this shift had none
  });

  it("salesByCashier reports revenue from the LEDGER, grouped by document.attributed_to", async () => {
    const rows = await read((tx) => salesByCashier(tx, {
      companyId: f.seed.company, from: "2026-01-01", to: "2026-12-31", branchId: f.branchA, limit: 50,
    }));
    const mine = rows.find((r) => r.cashierPrincipalId === f.cashierA)!;
    expect(mine.ticketCount).toBe(3);
    expect(mine.returnCount).toBe(1);
    expect(mine.baseCurrency).toBe("MYR");
    // A COMPUTED figure, not a regex: `netSalesBase` is the income-account movement, so read that movement
    // and compare. A regex would pass against a join fan-out that multiplied the figure by the line count,
    // which is exactly the defect Step 2's two-CTE split exists to avoid.
    // `a.type`, NOT `a.account_type` — `app.account_type` is the enum TYPE (plan0A:1484) and `type` is the
    // column (plan0A:1492). The wrong spelling is `column a.account_type does not exist`, which fails the
    // case rather than weakening it, but it is the same typo Step 2's `revenue` CTE must not carry either.
    const [expectedNet] = await db.admin<{ net: string }[]>`
      select (sum(le.base_credit) - sum(le.base_debit))::text as net
        from app.ledger_entry le
        join app.document d on d.id = le.document_id
        join app.account  a on a.id = le.account_id and a.type = 'income'
       where d.attributed_to = ${f.cashierA} and d.shift_id = ${shiftId}`;
    expect(mine.netSalesBase).toBe(expectedNet!.net);
    expect(mine.overShortBase).toBe("-2.0000");            // the shift's correction lands on its closer
  });

  it("a cashier with no tickets in the range does not appear", async () => {
    const rows = await read((tx) => salesByCashier(tx, {
      companyId: f.seed.company, from: "2026-01-01", to: "2026-12-31", limit: 50,
    }));
    expect(rows.map((r) => r.cashierPrincipalId)).not.toContain(f.cashierB);
  });

  it("a branch manager restricted to branch B sees no branch-A shift through either report (test 36)", async () => {
    const mgr = await seedEmployeePrincipal(f.seed, "mgr-b");
    await grantCodes(db, f.seed, { codes: ["pos.report.read"], principalId: mgr,
                                   roleCode: "bm-b-z", branchIds: [f.branchB] });
    const rows = await withTenant(db.rw, f.seed.tenant, mgr,
      (tx) => zReport(tx as never, { companyId: f.seed.company, shiftId, limit: 50 }));
    expect(rows).toEqual([]);        // Form A's restrictive policy on app.shift, not a WHERE clause here
  });
});
```

Run: `cd packages/db && bun run test -- reports/pos`
Expected: **FAIL** — `Cannot find module '../../src/reports/pos'`.

- [ ] **Step 2: Write `packages/db/src/reports/pos.ts`.**

```ts
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";   // NOT importable from packages/db (§3.1) — see the note below
```

⚠️ **`packages/db` may not import `@dulja/contracts`** (§3.1). This file therefore throws **`ReportParamError`**, a local class in 1B's `LandedCostError`/`BankMatchError` shape: `readonly code` is the literal `"ERR_VALIDATION_FAILED"` and the token is in the message, so `apps/api` writes `new AppError(e.code, e.detail)` with no cast and this file's own tests assert `rejects.toThrow(/ERR_VALIDATION_FAILED/)`.

```ts
import type { Sql } from "postgres";

/** 4B's `BankMatchError` shape: exported so `apps/api` can `instanceof` it, `code` a literal member of
 *  `ErrCode` so the handler needs no branch, the token in the message so db-tier tests match on it. */
export class ReportParamError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly detail: string) { super(`ERR_VALIDATION_FAILED: ${detail}`); }
}

export interface ZReportParams {
  companyId: string;
  /** One shift → exactly one Z-report. */
  shiftId?: string;
  /** A range → the shift HISTORY §4.16.1 names, under the SAME code. That is why both return an array. */
  branchId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: { openedAt: string; shiftId: string } | null;
}

export interface ZReportTender { method: string; accountCode: string; amount: string; currency: string }

/** One cash-control movement on `1110` that is **not** a ticket tender, per document type. There is no
 *  `kind` member: an earlier draft carried `kind: string` always filled with the literal `"cash_control"`,
 *  which the wire schema (`ZReportCashLineSchema`) then dropped — a field that conveys nothing and that a
 *  7C re-expression would have to keep in step for no reason. The section it appears in *is* the kind. */
export interface ZReportCashLine { documentTypeCode: string; amount: string; currency: string }

export interface ZReport {
  shiftId: string; branchId: string; terminalId: string; terminalCode: string;
  openedAt: string; closedAt: string | null;
  openedPrincipalId: string; closedPrincipalId: string | null;
  currency: string;
  openingFloat: string; countedCash: string | null; expectedCash: string | null; overShort: string | null;
  overShortDocumentId: string | null;
  ticketCount: number; returnCount: number;
  tenders: ZReportTender[];
  cashControl: ZReportCashLine[];
  tillEvents: { kind: string; count: number }[];
}

export interface SalesByCashierParams {
  companyId: string; from: string; to: string;
  branchId?: string; cashierPrincipalId?: string;
  limit: number;
  cursor?: { cashierPrincipalId: string } | null;
}

export interface SalesByCashierRow {
  cashierPrincipalId: string; cashierName: string; branchId: string;
  ticketCount: number; returnCount: number;
  netSalesBase: string; baseCurrency: string;
  discountBase: string; overShortBase: string;
}

/** The §4.6.5 tender-method → §4.15 account-code map, in the ONE place a report may hold it. It mirrors
 *  the four `when: { line.tender_method }` rules of 6A's POS_TICKET policy; a fifth method would be a
 *  §4.6.5 amendment and a policy rule, and this map would grow in the same PR. */
const TENDER_ACCOUNT: Readonly<Record<string, string>> = {
  cash: "1110", card: "1120", transfer: "1100", store_credit: "2200",
};

/**
 * `pos.z_report` — ONE code, TWO parameter shapes (§4.16.1, amendment A5).
 *
 * `shiftId` returns exactly one report; `from`/`to` return the shift history, newest first, keyset-paged
 * on `(opened_at desc, id desc)` over `shift_branch_opened_idx` (0070). Both return an array, which is why
 * 7C can re-express the code as one `ReportDefinition` with an optional parameter rather than two.
 *
 * **Every figure comes from `app.ledger_entry`, never from `document_line`.** The DoD sentence is "the
 * shift Z-report ties to the ledger to the cent", and a report that summed tender lines would be a second
 * computation that can disagree — which is the defect SAH-055 names ("a figure recomputed by a staler
 * rule") and the reason 1B's `trialBalance` reads `account_balance` rather than re-aggregating.
 *
 * **Branch isolation is RLS's job, not this query's.** `app.shift` carries Form A's restrictive
 * `branch_isolation` policy (0070), so a branch manager at B reads zero rows here with no `WHERE` clause
 * of ours — which is what makes the isolation hold "through any endpoint, filter or export" (spec:2454)
 * instead of holding only in the queries somebody remembered.
 */
export async function zReport(tx: Sql, params: ZReportParams): Promise<ZReport[]> {
  const oneShift = params.shiftId !== undefined && params.shiftId !== null;
  const aRange = params.from !== undefined && params.to !== undefined;
  if (!oneShift && !aRange) {
    throw new ReportParamError(
      "pos.z_report needs either shiftId (one Z-report) or from and to (the shift history)"
      + " — an unbounded read of every shift a company ever had is not a report");
  }

  const shifts = await tx<{
    id: string; branch_id: string; terminal_id: string; terminal_code: string;
    opened_at: string; closed_at: string | null;
    opened_principal_id: string; closed_principal_id: string | null; currency: string;
    opening_float: string; counted_cash: string | null; expected_cash: string | null;
    over_short: string | null; over_short_document_id: string | null;
  }[]>`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           s.opened_at::text, s.closed_at::text,
           s.opened_principal_id::text, s.closed_principal_id::text, s.currency,
           s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
     where s.company_id = ${params.companyId}
       and (${params.shiftId ?? null}::uuid is null or s.id = ${params.shiftId ?? null}::uuid)
       and (${params.branchId ?? null}::uuid is null or s.branch_id = ${params.branchId ?? null}::uuid)
       and (${params.from ?? null}::date is null or s.opened_at >= ${params.from ?? null}::date)
       and (${params.to ?? null}::date is null or s.opened_at < (${params.to ?? null}::date + 1))
       and (${params.cursor?.openedAt ?? null}::timestamptz is null
            or (s.opened_at, s.id) < (${params.cursor?.openedAt ?? null}::timestamptz,
                                      ${params.cursor?.shiftId ?? null}::uuid))
     order by s.opened_at desc, s.id desc
     limit ${params.limit}`;
  if (shifts.length === 0) return [];

  const ids = shifts.map((s) => s.id);

  // Tenders: the ledger movement on the four §4.15 tender accounts, over POS_TICKET documents ONLY.
  // **Scoped to POS_TICKET deliberately.** OD-10's TILL_BANKING debits 1100, which is the `transfer`
  // tender's account — without this predicate a day's banking would appear as a transfer sale, and the
  // "tenders by type" line would be wrong in exactly the way a shop would notice and not be able to
  // explain. Cash control gets its own section below.
  const tenders = await tx<{
    shift_id: string; code: string; movement: string; currency: string;
  }[]>`
    select d.shift_id::text, a.code, (sum(le.debit) - sum(le.credit))::text as movement, le.currency
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
      join app.account       a on a.id = le.account_id
     where d.shift_id = any(${ids}::uuid[])
       and d.status in ('posted', 'reversed')
       and t.code = 'POS_TICKET'
       and a.code = any(${Object.values(TENDER_ACCOUNT)}::text[])
     group by d.shift_id, a.code, le.currency
    having sum(le.debit) - sum(le.credit) <> 0
     order by a.code`;

  // Cash control: every OTHER movement on 1110, one row per document type. TILL_OVER_SHORT is here and
  // not in `tenders`, and ⚠️ OD-10's three types join it the day they land with no change to this query.
  const control = await tx<{
    shift_id: string; type_code: string; movement: string; currency: string;
  }[]>`
    select d.shift_id::text, t.code as type_code, (sum(le.debit) - sum(le.credit))::text as movement,
           le.currency
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
      join app.account       a on a.id = le.account_id
     where d.shift_id = any(${ids}::uuid[])
       and d.status in ('posted', 'reversed')
       and t.code <> 'POS_TICKET'
       and a.code = '1110'
     group by d.shift_id, t.code, le.currency
    having sum(le.debit) - sum(le.credit) <> 0
     order by t.code`;

  const counts = await tx<{ shift_id: string; kind: string; n: number }[]>`
    select d.shift_id::text,
           case when exists (select 1 from app.document_line l
                              where l.document_id = d.id and l.kind = 'item' and l.quantity < 0)
                then 'return' else 'ticket' end as kind,
           count(*)::int as n
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.shift_id = any(${ids}::uuid[]) and t.code = 'POS_TICKET' and d.status in ('posted', 'reversed')
     group by d.shift_id, 2`;

  const events = await tx<{ shift_id: string; kind: string; n: number }[]>`
    select shift_id::text, kind, count(*)::int as n from app.till_event
     where shift_id = any(${ids}::uuid[]) group by shift_id, kind order by kind`;

  const ACCOUNT_TENDER = Object.fromEntries(Object.entries(TENDER_ACCOUNT).map(([m, c]) => [c, m]));
  return shifts.map((s) => ({
    shiftId: s.id, branchId: s.branch_id, terminalId: s.terminal_id, terminalCode: s.terminal_code,
    openedAt: s.opened_at, closedAt: s.closed_at,
    openedPrincipalId: s.opened_principal_id, closedPrincipalId: s.closed_principal_id,
    currency: s.currency,
    openingFloat: s.opening_float, countedCash: s.counted_cash,
    expectedCash: s.expected_cash, overShort: s.over_short,
    overShortDocumentId: s.over_short_document_id,
    ticketCount: counts.find((c) => c.shift_id === s.id && c.kind === "ticket")?.n ?? 0,
    returnCount: counts.find((c) => c.shift_id === s.id && c.kind === "return")?.n ?? 0,
    tenders: tenders.filter((t) => t.shift_id === s.id).map((t) => ({
      method: ACCOUNT_TENDER[t.code]!, accountCode: t.code, amount: t.movement, currency: t.currency,
    })),
    cashControl: control.filter((c) => c.shift_id === s.id).map((c) => ({
      documentTypeCode: c.type_code, amount: c.movement, currency: c.currency,
    })),
    tillEvents: events.filter((e) => e.shift_id === s.id).map((e) => ({ kind: e.kind, count: e.n })),
  }));
}

/**
 * `pos.sales_by_cashier` — revenue per cashier, from the ledger's INCOME accounts.
 *
 * Grouped by `document.attributed_to`, which is the cashier (hazard 19): `posted_by` is the terminal and
 * would give one row per till. `netSalesBase` is `Σ(base_credit − base_debit)` on `account.type = 'income'`
 * — the sign convention that makes a sale positive and a refund's credit note negative, with no sign test
 * on an amount anywhere (§4.4.2 A9). Base amounts, not document amounts, because a cashier's day may hold
 * two currencies and "sales by cashier" is one figure.
 *
 * `overShortBase` is attached from `shift.over_short` by closer, so a manager reading the report sees the
 * discrepancy beside the takings of the person who declared it.
 */
export async function salesByCashier(tx: Sql, params: SalesByCashierParams): Promise<SalesByCashierRow[]> {
  if (!params.from || !params.to) {
    throw new ReportParamError("pos.sales_by_cashier needs both from and to");
  }
  const rows = await tx<{
    cashier: string; cashier_name: string; branch_id: string; base_currency: string;
    ticket_count: number; return_count: number; net_sales: string; discount: string; over_short: string;
  }[]>`
    with tickets as (
      select d.attributed_to, d.branch_id, d.id,
             exists (select 1 from app.document_line l
                      where l.document_id = d.id and l.kind = 'item' and l.quantity < 0) as is_return
        from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${params.companyId}
         and t.code = 'POS_TICKET'
         and d.status in ('posted', 'reversed')
         and d.effective_date between ${params.from}::date and ${params.to}::date
         and (${params.branchId ?? null}::uuid is null or d.branch_id = ${params.branchId ?? null}::uuid)
         and (${params.cashierPrincipalId ?? null}::uuid is null
              or d.attributed_to = ${params.cashierPrincipalId ?? null}::uuid)
    ),
    -- TWO CTEs and not one. Joining `ledger_entry` (N rows per ticket) to `document_line` (M rows per
    -- ticket) inside one aggregate multiplies BOTH sums by the other's cardinality: net sales would be M
    -- times too large and the discount N times too large. The defect is invisible to a test that only
    -- checks the shape of the number, which is why Step 1's seventh case compares a computed figure.
    revenue as (
      -- `a.type`, NOT `a.account_type`. `app.account` declares `type app.account_type not null`
      -- (plan0A:1492); `account_type` is the ENUM TYPE's name (plan0A:1484) and §3.2 forbids renames, so
      -- no migration ever adds the other spelling. `a.account_type` fails with
      -- `column a.account_type does not exist` and takes the whole report down. 1b:2779, 4b:2169 and
      -- 5a:4676 all use `a.type`.
      select k.attributed_to, sum(le.base_credit - le.base_debit) as net
        from tickets k
        join app.ledger_entry le on le.document_id = k.id
        join app.account       a on a.id = le.account_id and a.type = 'income'
       group by k.attributed_to
    ),
    discounts as (
      select k.attributed_to, sum(l.discount) as disc
        from tickets k
        join app.document_line l on l.document_id = k.id and l.kind = 'item'
       group by k.attributed_to
    ),
    shortfall as (
      select s.closed_principal_id as p, sum(s.over_short) as os
        from app.shift s
       where s.company_id = ${params.companyId} and s.closed_at is not null
         and s.opened_at >= ${params.from}::date and s.opened_at < (${params.to}::date + 1)
         and (${params.branchId ?? null}::uuid is null or s.branch_id = ${params.branchId ?? null}::uuid)
       group by s.closed_principal_id
    )
    select k.attributed_to::text as cashier, p.display_name as cashier_name,
           min(k.branch_id::text) as branch_id, c.base_currency,
           count(*) filter (where not k.is_return)::int as ticket_count,
           count(*) filter (where k.is_return)::int     as return_count,
           coalesce(max(r.net), 0)::text                as net_sales,
           coalesce(max(dc.disc), 0)::text              as discount,
           coalesce(max(sf.os), 0)::text                as over_short
      from tickets k
      join app.principal p on p.id = k.attributed_to
      join app.company   c on c.id = ${params.companyId}
      left join revenue   r  on r.attributed_to  = k.attributed_to
      left join discounts dc on dc.attributed_to = k.attributed_to
      left join shortfall sf on sf.p             = k.attributed_to
     where (${params.cursor?.cashierPrincipalId ?? null}::uuid is null
            or k.attributed_to > ${params.cursor?.cashierPrincipalId ?? null}::uuid)
     group by k.attributed_to, p.display_name, c.base_currency
     order by k.attributed_to
     limit ${params.limit}`;

  return rows.map((r) => ({
    cashierPrincipalId: r.cashier, cashierName: r.cashier_name, branchId: r.branch_id,
    ticketCount: r.ticket_count, returnCount: r.return_count,
    netSalesBase: r.net_sales, baseCurrency: r.base_currency,
    discountBase: r.discount, overShortBase: r.over_short,
  }));
}
```

- [ ] **Step 3: Write the two contracts files and widen `ReportCodeSchema`.**

```ts
// packages/contracts/src/pos/shift.ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, ListEnvelope, ListQuery, MoneySchema, TimestampSchema, UuidSchema } from "../common";

export const ShiftSchema = z.object({
  shiftId: UuidSchema,
  branchId: UuidSchema,
  terminalId: UuidSchema,
  terminalCode: z.string(),
  openedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  openedPrincipalId: UuidSchema,
  closedPrincipalId: UuidSchema.nullable(),
  currency: CurrencySchema,
  openingFloat: MoneySchema,
  countedCash: MoneySchema.nullable(),
  expectedCash: MoneySchema.nullable(),
  overShort: MoneySchema.nullable(),
  overShortDocumentId: UuidSchema.nullable(),
}).openapi("Shift");

/** Literal `filter[…]` keys — §4.2.8 Layer 2's default, and this surface is four pairs, under the
 *  threshold at which `parseFilters` earns its keep. */
export const ShiftQuery = ListQuery.extend({
  "filter[branchId][eq]": UuidSchema.optional(),
  "filter[terminalId][eq]": UuidSchema.optional(),
  "filter[openedAt][gte]": z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  "filter[openedAt][lte]": z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  "filter[closedAt][eq]": z.enum(["null", "not_null"]).optional(),
});
export const ShiftList = ListEnvelope(ShiftSchema);

export const TillEventSchema = z.object({
  id: UuidSchema,
  shiftId: UuidSchema,
  kind: z.enum(["no_sale", "drawer_open", "void"]),
  ticketDocumentId: UuidSchema.nullable(),
  cashierPrincipalId: UuidSchema,
  supervisorPrincipalId: UuidSchema.nullable(),
  occurredAt: TimestampSchema,
  clientRef: UuidSchema,
}).openapi("TillEvent");
export const TillEventList = ListEnvelope(TillEventSchema);
```

```ts
// packages/contracts/src/pos/reports.ts
import { z } from "@hono/zod-openapi";
import { CurrencySchema, DateSchema, ListEnvelope, ListQuery, MoneySchema, UuidSchema } from "../common";
import { ShiftSchema } from "./shift";

export const ZReportTenderSchema = z.object({
  method: z.enum(["cash", "card", "transfer", "store_credit"]),
  accountCode: z.string().regex(/^[1-5][0-9]{3}$/),
  amount: MoneySchema,
}).openapi("ZReportTender");

export const ZReportCashLineSchema = z.object({
  documentTypeCode: z.string(),
  amount: MoneySchema,
}).openapi("ZReportCashLine");

/** The Z-report is the shift PLUS its ledger sections, so it extends `ShiftSchema` rather than restating
 *  eleven fields — one schema for one row shape (§4.2.8's naming convention applied). */
export const ZReportSchema = ShiftSchema.extend({
  ticketCount: z.number().int(),
  returnCount: z.number().int(),
  tenders: z.array(ZReportTenderSchema),
  cashControl: z.array(ZReportCashLineSchema),
  tillEvents: z.array(z.object({ kind: z.string(), count: z.number().int() })),
}).openapi("ZReport");
export const ZReportList = ListEnvelope(ZReportSchema);

/**
 * One code, two shapes (§4.16.1): `shiftId` for one report, `from`/`to` for the history.
 *
 * **It stays a plain `ZodObject`, and the either/or check lives in the handler.** An earlier draft wrote
 * `.refine((q) => q.shiftId !== undefined || (q.from !== undefined && q.to !== undefined))` here, which
 * wraps the schema in a `ZodEffects`. 0B settled that exact question in the same words for
 * `AuditLogQuery` (0b:4317): *"`@hono/zod-openapi` generates query parameters from a `ZodObject`, and a
 * `.refine` would wrap the schema in `ZodEffects`"* — so a refined query schema can fail parameter
 * generation and the OpenAPI diff check of Step 8. §4.18 makes 0B the authority on its own convention.
 * `.strict()` is likewise not used: 1B applies it to a report query, but `sah-036` sends undeclared
 * `where=` / `filter=` keys and expects them stripped (0b:4318), and this route is on that path.
 */
export const ZReportQuery = ListQuery.extend({
  shiftId: UuidSchema.optional(),
  branchId: UuidSchema.optional(),
  from: DateSchema.optional(),
  to: DateSchema.optional(),
});

/** **Three deliberate renames between the db tier and the wire**, stated here and again in the handler:
 *  `salesByCashier` returns `netSalesBase` / `discountBase` / `overShortBase` — the `Base` suffix records
 *  that the figure is in the company's base currency, which matters inside `packages/db` where a caller
 *  could otherwise mistake it for a document-currency amount. On the wire every money member is already a
 *  `{ amount, currency }` pair carrying `baseCurrency`, so the suffix is redundant noise in a DTO. The
 *  mapping is `netSalesBase → netSales`, `discountBase → discount`, `overShortBase → overShort`, and it
 *  lives in exactly one place: Step 4's `pos.sales_by_cashier` handler. */
export const SalesByCashierRowSchema = z.object({
  cashierPrincipalId: UuidSchema,
  cashierName: z.string(),
  branchId: UuidSchema,
  ticketCount: z.number().int(),
  returnCount: z.number().int(),
  netSales: MoneySchema,
  discount: MoneySchema,
  overShort: MoneySchema,
}).openapi("SalesByCashierRow");
export const SalesByCashierList = ListEnvelope(SalesByCashierRowSchema);

export const SalesByCashierQuery = ListQuery.extend({
  from: DateSchema,
  to: DateSchema,
  branchId: UuidSchema.optional(),
  cashierPrincipalId: UuidSchema.optional(),
});
```

```ts
// packages/contracts/src/accounting/reports.ts — 1B's enum, widened by two. It is a wire-validation
// convenience and never a second register (§4.16.1 is the register), so the only rule is that a code
// whose route exists is a member.
export const ReportCodeSchema = z.enum([
  "accounting.trial_balance",
  "accounting.ledger",
  /* … 3D's and 4B's members, unchanged … */
  "pos.z_report",           // 6D
  "pos.sales_by_cashier",   // 6D
]);
```

- [ ] **Step 4: Add the two `GET`s to 1B's `reports` module — `apps/api/src/routes/accounting/reports.ts`.**

**On 1B's module and not a new one.** `PROBES` is keyed by `RouteModule.path` (hazard 31), and two modules on `/v1/companies/:companyId/reports` would collide — §4.2.7 says so explicitly for 7A and it binds 6D identically. The module's `permissions` array grows by one, because it now evaluates a second code.

```ts
import { salesByCashier, zReport, ReportParamError } from "@dulja/db";
import {
  SalesByCashierList, SalesByCashierQuery, ZReportList, ZReportQuery,
} from "@dulja/contracts/pos/reports";

const zReportRoute = createRoute({
  method: "get",
  path: "/pos.z_report",
  request: { params: z.object({ companyId: UuidSchema }), query: ZReportQuery },
  responses: { 200: { content: { "application/json": { schema: ZReportList } }, description: "Z-report(s)" },
               400: problem(), 403: problem(), 404: problem() },
  middleware: [requirePermission(PERMISSION["pos.report.read"], { company: "path:companyId" })],
  tags: ["pos"],
});

reportsRoutes.openapi(zReportRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  let cursor: { openedAt: string; shiftId: string } | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (d.k.length !== 1 || typeof d.k[0] !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for pos.z_report");
    }
    cursor = { openedAt: d.k[0], shiftId: d.id };
  }

  // **No `baseCurrency` here, unlike the `sales_by_cashier` handler below.** Every money member of the
  // Z-report DTO takes its currency from `z.currency` — the shift's own, per amendment A3 — so the
  // company's base currency is never read on this path. Destructuring it would be an unused local, which
  // `noUnusedLocals` and the repo lint both fail, and Step 8 expects green.
  const rows = await c.var.withTenant(async (tx) => {
    try {
      return await zReport(tx, { companyId, shiftId: q.shiftId, branchId: q.branchId,
                                 from: q.from, to: q.to, cursor, limit: q.limit });
    } catch (e) {
      // 4B's pattern: a db-tier error class whose `code` is already an `ErrCode`, so no branch and no cast.
      if (e instanceof ReportParamError) throw new AppError(e.code, e.detail);
      throw e;
    }
  });

  const last = rows.at(-1);
  return c.json({
    items: rows.map((z) => ({
      shiftId: z.shiftId, branchId: z.branchId, terminalId: z.terminalId, terminalCode: z.terminalCode,
      openedAt: z.openedAt, closedAt: z.closedAt,
      openedPrincipalId: z.openedPrincipalId, closedPrincipalId: z.closedPrincipalId,
      currency: z.currency,
      openingFloat: { amount: z.openingFloat, currency: z.currency },
      countedCash: z.countedCash === null ? null : { amount: z.countedCash, currency: z.currency },
      expectedCash: z.expectedCash === null ? null : { amount: z.expectedCash, currency: z.currency },
      overShort: z.overShort === null ? null : { amount: z.overShort, currency: z.currency },
      overShortDocumentId: z.overShortDocumentId,
      ticketCount: z.ticketCount, returnCount: z.returnCount,
      tenders: z.tenders.map((t) => ({ method: t.method, accountCode: t.accountCode,
                                       amount: { amount: t.amount, currency: t.currency } })),
      cashControl: z.cashControl.map((x) => ({ documentTypeCode: x.documentTypeCode,
                                               amount: { amount: x.amount, currency: x.currency } })),
      tillEvents: z.tillEvents,
    })),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.openedAt], id: last.shiftId })
      : null,
  }, 200);
});
```

And the second handler, in the same file, with the same gate:

```ts
import { SalesByCashierList, SalesByCashierQuery } from "@dulja/contracts/pos/reports";

const salesByCashierRoute = createRoute({
  method: "get",
  path: "/pos.sales_by_cashier",
  request: { params: z.object({ companyId: UuidSchema }), query: SalesByCashierQuery },
  responses: { 200: { content: { "application/json": { schema: SalesByCashierList } },
                      description: "Sales per cashier" },
               400: problem(), 403: problem() },
  middleware: [requirePermission(PERMISSION["pos.report.read"], { company: "path:companyId" })],
  tags: ["pos"],
});

reportsRoutes.openapi(salesByCashierRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  // The cursor is a single-key keyset on the cashier's principal id — the query's own `order by`. `k` is
  // empty because the id IS the ordering key and `decodeCursor` already carries it as `id`.
  let cursor: { cashierPrincipalId: string } | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (d.k.length !== 0) {
      throw new AppError("ERR_VALIDATION_FAILED",
        "cursor is not a valid keyset cursor for pos.sales_by_cashier");
    }
    cursor = { cashierPrincipalId: d.id };
  }

  const { rows, baseCurrency } = await c.var.withTenant(async (tx) => {
    const [co] = await tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${companyId}`;
    try {
      return {
        rows: await salesByCashier(tx, { companyId, from: q.from, to: q.to, branchId: q.branchId,
                                         cashierPrincipalId: q.cashierPrincipalId,
                                         cursor, limit: q.limit }),
        baseCurrency: co?.base_currency ?? "MYR",
      };
    } catch (e) {
      if (e instanceof ReportParamError) throw new AppError(e.code, e.detail);
      throw e;
    }
  });

  const last = rows.at(-1);
  return c.json({
    // **The three `Base`-suffix renames, in the one place they happen.** `salesByCashier` returns
    // `netSalesBase`, `discountBase` and `overShortBase`; `SalesByCashierRowSchema` names them
    // `netSales`, `discount` and `overShort`. The suffix earns its keep inside `packages/db`, where a
    // bare `netSales` could be read as a document-currency figure; on the wire the `{ amount, currency }`
    // pair already says which money it is, and `currency` is `baseCurrency` on all three because the
    // function returns base amounts (§4.16.3, amendment A5).
    items: rows.map((r) => ({
      cashierPrincipalId: r.cashierPrincipalId,
      cashierName: r.cashierName,
      branchId: r.branchId,
      ticketCount: r.ticketCount,
      returnCount: r.returnCount,
      netSales: { amount: r.netSalesBase, currency: baseCurrency },
      discount: { amount: r.discountBase, currency: baseCurrency },
      overShort: { amount: r.overShortBase, currency: baseCurrency },
    })),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [], id: last.cashierPrincipalId })
      : null,
  }, 200);
});
```

**`baseCurrency` is read even though the row type does not carry it per row**, because `SalesByCashierRow.baseCurrency` is the same string for every row of one company and the DTO needs it three times per row; reading `app.company` once in the same transaction is cheaper than threading it out of the reader. The `?? "MYR"` fallback is unreachable — `companyId` came through `requirePermission`'s company scope, so the row exists — and is there so the map has no `!`.

```ts
export const reportsRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/reports",
  router: reportsRoutes,
  permissions: [
    PERMISSION["accounting.report.read"],
    PERMISSION["accounting.ledger.read"],
    /* … 3D's and 4B's codes, unchanged … */
    PERMISSION["pos.report.read"],          // 6D (amendment A11)
  ],
  auth: "human",
};
```

- [ ] **Step 5: Write the `shifts` route module — `apps/api/src/routes/pos/shifts.ts`.**

Three `GET`s, all gated `pos.report.read`, all read-only (so R7 holds and `ERR_ROUTE_GATE_READONLY` cannot fire at boot). **No `POST`, and amendment A12 is why:** a shift is closed only over `/v1/sync/tickets`, because `TILL_OVER_SHORT.approval.post` is `pos.sync.push` and R8 keeps a human out of the `pos_terminal` role — a back-office close could not post the difference. There is therefore no `IdempotencyHeader` in this file, which is correct rather than an omission: §4.2.9 requires it on unsafe methods and this module has none.

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PERMISSION } from "@dulja/contracts/permissions";
import { ShiftList, ShiftQuery, ShiftSchema, TillEventList } from "@dulja/contracts/pos/shift";
import { encodeCursor, decodeCursor, UuidSchema } from "@dulja/contracts";
import { AppError } from "@dulja/contracts";
import { requirePermission } from "../../middleware/require-permission";
import { problem } from "../../problem";
import type { AppEnv } from "../../env";
import type { RouteModule } from "../index";

export const shiftRoutes = new OpenAPIHono<AppEnv>();

const listRoute = createRoute({
  method: "get", path: "/",
  request: { params: z.object({ companyId: UuidSchema }), query: ShiftQuery },
  responses: { 200: { content: { "application/json": { schema: ShiftList } }, description: "Shifts" },
               403: problem() },
  middleware: [requirePermission(PERMISSION["pos.report.read"], { company: "path:companyId" })],
  tags: ["pos"],
});

const detailRoute = createRoute({
  method: "get", path: "/{shiftId}",
  request: { params: z.object({ companyId: UuidSchema, shiftId: UuidSchema }) },
  responses: { 200: { content: { "application/json": { schema: ShiftSchema } }, description: "One shift" },
               403: problem(), 404: problem() },
  middleware: [requirePermission(PERMISSION["pos.report.read"], { company: "path:companyId" })],
  tags: ["pos"],
});

const eventsRoute = createRoute({
  method: "get", path: "/{shiftId}/till-events",
  request: { params: z.object({ companyId: UuidSchema, shiftId: UuidSchema }), query: ShiftQuery.pick({ cursor: true, limit: true }) },
  responses: { 200: { content: { "application/json": { schema: TillEventList } }, description: "Till events" },
               403: problem(), 404: problem() },
  middleware: [requirePermission(PERMISSION["pos.report.read"], { company: "path:companyId" })],
  tags: ["pos"],
});

/** The wire shape of one `app.shift` row, in one place because all three handlers below need it. Every
 *  money member is `{ amount, currency }` per `MoneySchema`; `currency` is the SHIFT's currency and not
 *  the company's base, because a drawer is counted in one currency (§4.6.5, amendment A3). */
const toShiftDto = (r: {
  id: string; branch_id: string; terminal_id: string; terminal_code: string;
  opened_at: string; closed_at: string | null;
  opened_principal_id: string; closed_principal_id: string | null; currency: string;
  opening_float: string; counted_cash: string | null; expected_cash: string | null;
  over_short: string | null; over_short_document_id: string | null;
}) => ({
  shiftId: r.id, branchId: r.branch_id, terminalId: r.terminal_id, terminalCode: r.terminal_code,
  openedAt: r.opened_at, closedAt: r.closed_at,
  openedPrincipalId: r.opened_principal_id, closedPrincipalId: r.closed_principal_id,
  currency: r.currency,
  openingFloat: { amount: r.opening_float, currency: r.currency },
  countedCash: r.counted_cash === null ? null : { amount: r.counted_cash, currency: r.currency },
  expectedCash: r.expected_cash === null ? null : { amount: r.expected_cash, currency: r.currency },
  overShort: r.over_short === null ? null : { amount: r.over_short, currency: r.currency },
  overShortDocumentId: r.over_short_document_id,
});

// **The two `select` lists below are written out twice on purpose.** A shared `const SHIFT_COLUMNS = "…"`
// interpolated into a `tx` template would be sent as a PARAMETER rather than as SQL and postgres.js would
// fail on it; interpolating it any other way is `sql.unsafe`, which has exactly three homes and none is
// here (§3.3, `no-sql-concat`). Two literal lists kept in step by hand is the cost of that rule.

shiftRoutes.openapi(listRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");

  // **Every filter key is mapped to a PARAMETER here, and no field name ever reaches SQL as text**
  // (test 27, `no-sql-concat`). The `filter[…][op]` literals are §4.2.8 Layer 2's default form, declared
  // in `ShiftQuery`, so an unknown key is a 400 from Zod before this handler runs.
  const branchId = q["filter[branchId][eq]"] ?? null;
  const terminalId = q["filter[terminalId][eq]"] ?? null;
  const openedFrom = q["filter[openedAt][gte]"] ?? null;
  const openedTo = q["filter[openedAt][lte]"] ?? null;
  // A tri-state on the wire ("null" | "not_null" | absent) becomes a nullable boolean here: `true` means
  // "closed_at is not null". A boolean parameter and two `is null` tests keep it one statement.
  const closedState = q["filter[closedAt][eq]"] ?? null;
  const wantClosed = closedState === null ? null : closedState === "not_null";

  let cursorOpenedAt: string | null = null;
  let cursorId: string | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (d.k.length !== 1 || typeof d.k[0] !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for shifts");
    }
    cursorOpenedAt = d.k[0];
    cursorId = d.id;
  }

  const rows = await c.var.withTenant((tx) => tx<Parameters<typeof toShiftDto>[0][]>`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           s.opened_at::text, s.closed_at::text, s.opened_principal_id::text, s.closed_principal_id::text,
           s.currency, s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
     where s.company_id = ${companyId}
       and (${branchId}::uuid is null   or s.branch_id  = ${branchId}::uuid)
       and (${terminalId}::uuid is null or s.terminal_id = ${terminalId}::uuid)
       and (${openedFrom}::date is null or s.opened_at >= ${openedFrom}::date)
       and (${openedTo}::date is null   or s.opened_at <  (${openedTo}::date + 1))
       and (${wantClosed}::boolean is null
            or (${wantClosed}::boolean and s.closed_at is not null)
            or (not ${wantClosed}::boolean and s.closed_at is null))
       and (${cursorOpenedAt}::timestamptz is null
            or (s.opened_at, s.id) < (${cursorOpenedAt}::timestamptz, ${cursorId}::uuid))
     order by s.opened_at desc, s.id desc
     limit ${q.limit}`);

  const last = rows.at(-1);
  return c.json({
    items: rows.map(toShiftDto),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.opened_at], id: last.id })
      : null,
  }, 200);
});

shiftRoutes.openapi(detailRoute, async (c) => {
  const { companyId, shiftId } = c.req.valid("param");
  const [row] = await c.var.withTenant((tx) => tx<Parameters<typeof toShiftDto>[0][]>`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           s.opened_at::text, s.closed_at::text, s.opened_principal_id::text, s.closed_principal_id::text,
           s.currency, s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
     where s.company_id = ${companyId} and s.id = ${shiftId}`);
  // **404 and not 403, and the distinction is the whole point of Form A.** A branch manager at branch B
  // asking for a branch-A shift reads zero rows, because the restrictive `branch_isolation` policy makes
  // the row INVISIBLE rather than forbidden — so "not found" is the honest answer, and it leaks nothing
  // about whether the id exists. The same answer covers another tenant's shift (`PROBES` asserts it).
  if (!row) throw new AppError("ERR_NOT_FOUND", `shift ${shiftId} is not a shift of company ${companyId}`);
  return c.json(toShiftDto(row), 200);
});

shiftRoutes.openapi(eventsRoute, async (c) => {
  const { companyId, shiftId } = c.req.valid("param");
  const q = c.req.valid("query");

  // The shift is read first, so an unknown or invisible shift is a 404 rather than an empty list — an
  // empty `items` would tell a reader "this drawer had no events", which is a different claim.
  const [shift] = await c.var.withTenant((tx) => tx<{ id: string }[]>`
    select id from app.shift where company_id = ${companyId} and id = ${shiftId}`);
  if (!shift) throw new AppError("ERR_NOT_FOUND", `shift ${shiftId} is not a shift of company ${companyId}`);

  let cursorOccurredAt: string | null = null;
  let cursorId: string | null = null;
  if (q.cursor !== undefined) {
    const d = decodeCursor(q.cursor);
    if (d.k.length !== 1 || typeof d.k[0] !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "cursor is not a valid keyset cursor for till-events");
    }
    cursorOccurredAt = d.k[0];
    cursorId = d.id;
  }

  // Ascending — a drawer's event stream reads forwards, unlike the shift list, which reads newest first.
  const rows = await c.var.withTenant((tx) => tx<{
    id: string; shift_id: string; kind: string; ticket_document_id: string | null;
    cashier_principal_id: string; supervisor_principal_id: string | null;
    occurred_at: string; client_ref: string;
  }[]>`
    select id::text, shift_id::text, kind, ticket_document_id::text, cashier_principal_id::text,
           supervisor_principal_id::text, occurred_at::text, client_ref::text
      from app.till_event
     where company_id = ${companyId} and shift_id = ${shiftId}
       and (${cursorOccurredAt}::timestamptz is null
            or (occurred_at, id) > (${cursorOccurredAt}::timestamptz, ${cursorId}::uuid))
     order by occurred_at, id
     limit ${q.limit}`);

  const last = rows.at(-1);
  return c.json({
    items: rows.map((r) => ({
      id: r.id, shiftId: r.shift_id, kind: r.kind, ticketDocumentId: r.ticket_document_id,
      cashierPrincipalId: r.cashier_principal_id, supervisorPrincipalId: r.supervisor_principal_id,
      occurredAt: r.occurred_at, clientRef: r.client_ref,
    })),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.occurred_at], id: last.id })
      : null,
  }, 200);
});

export const shiftRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/shifts",
  router: shiftRoutes,
  permissions: [PERMISSION["pos.report.read"]],
  auth: "human",
};
```

Register it **inside `buildRoutes`** in `apps/api/src/routes/index.ts` — never by pushing onto `ROUTES`, which §4.2.7 derives from `buildRoutes({ authAdmin: new StubAuthAdmin() })`:

```ts
    shiftRouteModule,          // 6D — /v1/companies/:companyId/shifts
```

- [ ] **Step 6: Add the one `PROBES` entry — `tests/invariants/probes.ts` (hazard 31).**

**One entry, not three.** `PROBES` is keyed by `RouteModule.path`, so the two sub-paths inherit this key, and the two report `GET`s add nothing because they are sub-paths of 1B's `reports` module.

```ts
  "/v1/companies/:companyId/shifts": {
    // Owner B has a shift; tenant A asks for it by id and must get a 404 — not a 403, because RLS makes
    // the row invisible and "not found" is the honest answer to a row in another tenant.
    async seed(db, owner) {
      const terminal = await seedTerminal(db, owner, { code: "PROBE" });
      const shiftId = await seedShift(db, owner, {
        terminalId: terminal.terminalId, cashierPrincipalId: owner.human,
      });
      return { path: `/v1/companies/${owner.company}/shifts/${shiftId}`, method: "GET" };
    },
    expect: 404,
  },
```

- [ ] **Step 7: Write the route test `apps/api/test/routes/pos/shifts.test.ts`.**

Six cases through the running API (§3.7.1: `apps/api/test/**` starts its own stack per file).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, uuidv7 } from "@dulja/db/test";
import { applyBatch, withTenant } from "@dulja/db";              // the PRODUCTION withTenant(sql, ctx, fn)
import { startApi, problemOf, type StartedApi } from "../../support/app";
import { buildTicket } from "../../../../../tests/invariants/support/pos";
import { staffFixture, type StaffFixture } from "../../../../../tests/invariants/support/staff";

describe("GET /v1/companies/:companyId/shifts and the two pos report GETs (6D T7)", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let reader: string;      // holds pos.report.read at branch A
  let nobody: string;      // holds nothing
  let managerB: string;    // holds pos.report.read at branch B only
  let closedShift: string;
  let openShift: string;

  const principal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, { tenantId: f.seed.tenant, actorId: f.seed.system, companyId: f.seed.company },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${f.seed.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${id})`;
      });
    return id;
  };

  const sync = (body: Record<string, unknown>) =>
    withTenant(api.db.rw,
      { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
      (tx) => applyBatch(tx,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company },
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(),
          tickets: [], shifts: [], tillEvents: [], ...body }));

  beforeAll(async () => {
    api = await startApi();
    f = await staffFixture(api, "shiftroutes");

    reader = await principal("shift-reader");
    await grantCodes(api.db, f.seed, { codes: ["pos.report.read"], principalId: reader,
                                       roleCode: "sr-a", branchIds: [f.branchA] });
    nobody = await principal("shift-nobody");
    managerB = await principal("shift-mgr-b");
    await grantCodes(api.db, f.seed, { codes: ["pos.report.read"], principalId: managerB,
                                       roleCode: "sr-b", branchIds: [f.branchB] });
    await grantCodes(api.db, f.seed, { codes: ["pos.shift.own"], principalId: f.cashierA,
                                       roleCode: "sr-own", branchIds: [f.branchA] });

    // One closed shift with a 2.00 short, and one still open, so the list has both states.
    closedShift = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sync({ tickets: [buildTicket(f.pos, { sku: "SKU-A", shiftId: closedShift,
                                                unitPrice: "40.0000", tender: "cash" })] });
    await sync({ tillEvents: [
      { clientRef: crypto.randomUUID(), shiftId: closedShift, kind: "no_sale", ticketClientRef: null,
        cashierPrincipalId: f.cashierA, supervisorPrincipalId: null,
        occurredAt: "2026-01-15T01:00:00.000Z" },
      { clientRef: crypto.randomUUID(), shiftId: closedShift, kind: "drawer_open", ticketClientRef: null,
        cashierPrincipalId: f.cashierA, supervisorPrincipalId: null,
        occurredAt: "2026-01-15T02:00:00.000Z" },
    ] });
    await sync({ shifts: [{ shiftId: closedShift, kind: "close", terminalId: f.terminalA.terminalId,
                            cashierPrincipalId: f.cashierA, at: new Date().toISOString(),
                            currency: "MYR", openingFloat: null,
                            countedCash: { amount: "138.0000", currency: "MYR" } }] });
    openShift = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });
  }, 300_000);

  afterAll(async () => { await api.stop(); });

  const base = () => `/v1/companies/${f.seed.company}`;

  it("1. the list answers 200 with the envelope, and every money member is { amount, currency }", async () => {
    const res = await api.request("GET", `${base()}/shifts?limit=50`, { as: reader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { shiftId: string; openingFloat: { amount: string; currency: string };
               overShort: { amount: string } | null }[];
      next_cursor: string | null;
    };
    expect(body.items.map((i) => i.shiftId)).toEqual(expect.arrayContaining([closedShift, openShift]));
    for (const item of body.items) {
      // MoneySchema's own form: a decimal string at scale 4, never a JSON number (Constraint 2).
      expect(item.openingFloat.amount).toMatch(/^-?\d+\.\d{4}$/);
      expect(item.openingFloat.currency).toBe("MYR");
    }
    expect(body.items.find((i) => i.shiftId === openShift)!.overShort).toBeNull();
    expect(body.next_cursor).toBeNull();     // two shifts, limit 50
  });

  it("2. a principal holding no code is 403 ERR_RBAC_FORBIDDEN", async () => {
    const res = await api.request("GET", `${base()}/shifts?limit=50`, { as: nobody });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("3. the detail read is 200 for a closed shift and 404 for an unknown id", async () => {
    const ok = await api.request("GET", `${base()}/shifts/${closedShift}`, { as: reader });
    expect(ok.status).toBe(200);
    const shift = (await ok.json()) as { overShort: { amount: string }; countedCash: { amount: string } };
    expect(shift.overShort.amount).toBe("-2.0000");
    expect(shift.countedCash.amount).toBe("138.0000");

    const missing = await api.request("GET", `${base()}/shifts/${await uuidv7(api.db.admin)}`, { as: reader });
    expect(missing.status).toBe(404);
    expect((await problemOf(missing)).code).toBe("ERR_NOT_FOUND");
  });

  it("4. the till-event read is 200, oldest first, and 404 for a shift that is not there", async () => {
    const res = await api.request("GET", `${base()}/shifts/${closedShift}/till-events?limit=50`, { as: reader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string; occurredAt: string }[] };
    expect(body.items.map((e) => e.kind)).toEqual(["no_sale", "drawer_open"]);   // ascending occurred_at
    const missing = await api.request(
      "GET", `${base()}/shifts/${await uuidv7(api.db.admin)}/till-events?limit=50`, { as: reader });
    expect(missing.status).toBe(404);
  });

  it("5. pos.z_report serves one shift, a range, and refuses neither with 400", async () => {
    const one = await api.request("GET", `${base()}/reports/pos.z_report?shiftId=${closedShift}&limit=10`,
                                  { as: reader });
    expect(one.status).toBe(200);
    const z = (await one.json()) as {
      items: { expectedCash: { amount: string }; tenders: { method: string; amount: { amount: string } }[] }[];
    };
    expect(z.items).toHaveLength(1);
    expect(z.items[0]!.expectedCash.amount).toBe("140.0000");
    expect(z.items[0]!.tenders.find((t) => t.method === "cash")!.amount.amount).toBe("40.0000");

    const history = await api.request(
      "GET", `${base()}/reports/pos.z_report?from=2026-01-01&to=2026-12-31&limit=10`, { as: reader });
    expect(history.status).toBe(200);
    expect(((await history.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);

    // NEITHER parameter. There is **one** guard and this pins where it lives: `ZReportQuery` is a plain
    // `ZodObject` (Step 2's note on 0b:4317 — a `.refine` would make it a `ZodEffects` and
    // `@hono/zod-openapi` derives query parameters from a `ZodObject`), so Zod admits the request and
    // `zReport`'s own `ReportParamError` fires inside `withTenant`. Step 4's `catch` translates it with
    // `new AppError(e.code, e.detail)`, which is the 400 below. **If this ever answers 500**, the handler
    // lost its `instanceof ReportParamError` branch — do not re-add a `.refine` to compensate.
    const neither = await api.request("GET", `${base()}/reports/pos.z_report?limit=10`, { as: reader });
    expect(neither.status).toBe(400);
    const problem = await problemOf(neither);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("shiftId");
  });

  it("6. the branch-B manager reads an empty list through both reports (test 36 at the API surface)", async () => {
    const sales = await api.request(
      "GET", `${base()}/reports/pos.sales_by_cashier?from=2026-01-01&to=2026-12-31&limit=50`,
      { as: managerB });
    expect(sales.status).toBe(200);
    expect(((await sales.json()) as { items: unknown[] }).items).toEqual([]);

    // 200-with-nothing on the collection, 404 on the row: Form A makes branch A's shift invisible, and
    // "not found" rather than "forbidden" is the honest answer to a row you cannot see.
    const detail = await api.request("GET", `${base()}/shifts/${closedShift}`, { as: managerB });
    expect(detail.status).toBe(404);
  });
});
```

**`api.request(method, path, { as })`** is 0B's `ApiRequest` shape and `problemOf(res)` is 0B's `tests/support/api.ts` helper re-exported for `apps/api`'s own suites — **read `apps/api/test/support/app.ts` and use its spelling**; if that file names the option differently (`principalId`, `actor`), use its name. §4.18 makes 0B the authority and this slice adds no test helper of its own (§4.17.1).

- [ ] **Step 8: Regenerate the OpenAPI document and run everything.**

Run: `bun run --cwd packages/contracts openapi:generate`
Expected: a diff adding `Shift`, `TillEvent`, `ZReport`, `ZReportTender`, `ZReportCashLine` and `SalesByCashierRow` components and five paths. CI fails on an un-regenerated document (spec:2055), so commit the file.

Run: `cd packages/db && bun run test -- reports/pos` → **9 passed.**
Run: `cd apps/api && bun run test -- pos/shifts` → **6 passed.**
Run: `cd tests && bun run test -- tenant-isolation`
Expected: green. The harness iterates `ROUTES` and fails the build if a module has no `PROBES` entry or a key matches no route — so a typo between Step 5's `path` and Step 6's key fails here naming the string.

Run: `bun run lint:rules`
Expected: green. Two rules matter: `no-sql-concat` (every filter field is a parameter, never text — test 27) and `no-number-money` (`netSalesBase`, `overShortBase`, `discountBase` and every `amount` are `string`, and `ticketCount`/`returnCount`/`count` are `number` but do not match the money regex).

- [ ] **Step 9: Commit.**

```bash
git add packages/db/src/reports/pos.ts packages/db/src/index.ts \
        packages/contracts/src/pos/shift.ts packages/contracts/src/pos/reports.ts \
        packages/contracts/src/accounting/reports.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json \
        apps/api/src/routes/pos/shifts.ts apps/api/src/routes/accounting/reports.ts \
        apps/api/src/routes/index.ts apps/api/test/routes/pos/shifts.test.ts \
        packages/db/test/reports/pos.test.ts tests/invariants/probes.ts
git commit -m "feat(api): pos.z_report, pos.sales_by_cashier and the shifts module [6D T7]

Both reports read app.ledger_entry, never document_line: the DoD sentence is that
the Z-report ties to the ledger, and a second computation can disagree. The tender
section is scoped to POS_TICKET so OD-10's TILL_BANKING leg on 1100 cannot appear
as a transfer sale; cash control is its own section, one row per document type.
The two GETs join 1B's reports module (PROBES is keyed by path); the shifts module
is read-only, because only a terminal can post a TILL_OVER_SHORT (amendment A12).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Acceptance test 21 — the Z-report ties to the ledger to the cent

**This slice's share of the Phase 6 definition of done** (spec:2292, 2439). One file, one shift, one full trading day driven entirely through `applyBatch` and `postDocument`, and three assertions that compare the Z-report to `app.ledger_entry` with no tolerance.

**Files**
- Create: `tests/invariants/pos-shift-reconciliation.test.ts`

**Interfaces**

- Consumes: `staffFixture`, `StaffFixture` (6C); `posFixture`, `buildTicket`, `enrolTerminal`, `syncRequest`, `signSyncRequest` (6A); `applyBatch` (6A/Tasks 3, 6); `zReport`, `salesByCashier` (Task 7); `seedShift` (Task 1); `grantCodes` (2B); `sharedApi`, `StartedApi` (0B, **`tests/support/api.ts`** — that is `../support/api` from `tests/invariants/`, not `./support/api`), `withTenant` (0B — the **production** `withTenant(sql, ctx, fn)`, because root `tests/` use that one, §4.2.2 and hazard 15); `reverseDocument` (1A); `BatchResult` (§4.10.1, `@dulja/sync`).
- Produces: nothing importable. **Test 21's home is `tests/invariants/` and not `tests/e2e/`** — Task 0 amendment A9 records why: it is a data assertion needing Testcontainers, the real apply path and the real posting service, and a Playwright test cannot read `app.ledger_entry` at all.

- [ ] **Step 1: Write the test — it is the deliverable, so it is written whole rather than as a failing stub.**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { reverseDocument, salesByCashier, withTenant, zReport } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { buildTicket, syncRequest } from "./support/pos";
import { staffFixture, type StaffFixture } from "./support/staff";
// `sharedApi` is 0B's memoised stack at **`tests/support/api.ts`** (§4.17.1), which is `../support/api`
// from `tests/invariants/` — NOT `./support/api`, which is 6A's per-suite `tests/invariants/support/`
// directory and holds no such export.
import { sharedApi, type StartedApi } from "../support/api";
import type { BatchResult } from "@dulja/sync";       // §4.10.1's wire result, for `push`'s return type

/**
 * Acceptance test 21 — "the shift Z-report ties to the ledger to the cent" (spec:2292, 2439).
 *
 * The whole shift is driven through the REAL sync path: `POST /v1/sync/tickets` with a signed terminal
 * request for the sales, and `applyBatch` for the shift transitions. Nothing here writes a `ledger_entry`,
 * a `document` or a `shift` column by hand — a fixture that did would prove that a fixture agrees with a
 * report, which is not the claim (hazard 22).
 */
describe("acceptance test 21 — shift reconciliation (spec:2439)", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let shiftId: string;
  let ctx: { tenantId: string; actorId: string; companyId: string };

  /** Every message the day actually sent, captured so the "re-sent changes nothing" case can send the
   *  SAME objects — same `clientRef`s — rather than newly minted ones. `push` appends to it. */
  const sent: { tickets: unknown[]; shifts: unknown[]; tillEvents: unknown[] } =
    { tickets: [], shifts: [], tillEvents: [] };

  /** Every figure the assertions compare, captured once so the three cases read as arithmetic. */
  const day = {
    openingFloat: "200.0000",
    cashSales: ["45.5000", "12.0000", "133.2500", "8.7500"],   // Σ 199.5000
    cardSales: ["99.9900", "50.0000"],                          // Σ 149.9900
    transferSale: "500.0000",
    storeCreditSale: "20.0000",
    // `cashSales[1]`, refunded — the SAME figure, deliberately, so the refund can name that sale's own
    // `clientRef` and be an ordinary (non-blind) return. A refund of an amount no sale had would have to
    // be blind, and branch A refuses blind returns.
    cashRefund: "12.0000",
    countedCash: "386.0000",                                    // 200 + 199.50 − 12 = 387.50 → SHORT 1.50
  };

  beforeAll(async () => {
    api = await sharedApi();      // the tests-tier accessor; packages/db/test uses startApi
    f = await staffFixture(api, "test21");
    ctx = { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company };
    await grantCodes(api.db, f.seed, {
      codes: ["pos.shift.own"], principalId: f.cashierA, roleCode: "t21-own", branchIds: [f.branchA],
    });
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"], principalId: f.seed.human, roleCode: "t21-read",
    });

    // ── The trading day ──────────────────────────────────────────────────────────────────────────────
    // 1. The drawer is counted in. The till mints the shift id offline.
    shiftId = crypto.randomUUID();
    await push({ shifts: [openMsg(shiftId, day.openingFloat)] });

    // 2. Eight sales across all four tender methods, in three batches, as an 8-hour offline day drains.
    //    Each cash sale's `clientRef` is minted here rather than inside `buildTicket`, so the refund in
    //    step 3 can name the sale it reverses — a return with a null ref is a BLIND return and branch A
    //    refuses those (the `ticket` helper's doc comment carries the full reasoning and the citations).
    const cashRefs = day.cashSales.map(() => crypto.randomUUID());
    await push({ tickets: day.cashSales.slice(0, 2)
      .map((a, i) => ticket({ cash: a, clientRef: cashRefs[i]! })) });
    await push({ tickets: [
      ...day.cashSales.slice(2).map((a, i) => ticket({ cash: a, clientRef: cashRefs[i + 2]! })),
      ...day.cardSales.map((a) => ticket({ card: a })),
    ] });
    await push({ tickets: [ticket({ transfer: day.transferSale }), ticket({ storeCredit: day.storeCreditSale })] });

    // 3. A refund of the SECOND cash sale (12.0000 — `day.cashRefund` is that figure by construction),
    //    a no-sale and a supervisor void: the three till events, all in one batch.
    const refunded = await push({ tickets: [
      ticket({ cash: day.cashRefund, kind: "return", returnsClientRef: cashRefs[1]! }),
    ] });
    expect(refunded.results[0]!.status).toBe("accepted");   // a blind-return refusal would land HERE
    await push({ tillEvents: [
      event("no_sale"), event("drawer_open"),
      event("void", { ticketClientRef: refunded.results[0]!.clientRef, supervisorPrincipalId: f.supervisorA }),
    ] });

    // 4. The drawer is counted out — 1.50 short. This is the ONE figure a human declares.
    await push({ shifts: [closeMsg(shiftId, day.countedCash, f.cashierA)] });
  }, 600_000);

  // **No `afterAll` stopping the API, and that is deliberate.** `sharedApi()` is 0B's *memoised*
  // `startApi()` in `tests/support/api.ts` — one stack for every full-regression file in the run, with
  // `fileParallelism: false` and `isolate: false` so they share a process (0b:39). Calling `api.stop()`
  // here would tear down the container every later file in that run is then handed, and the failure would
  // surface in an unrelated regression file with no hint that this one caused it. The stack is reaped by
  // Testcontainers' Ryuk at process exit locally and by the ephemeral runner in CI, exactly as 0B's own
  // files rely on. A file that wants to stop its own stack calls `startApi()` instead of `sharedApi()`.

  const read = <T>(fn: (tx: never) => Promise<T>) => withTenant(api.db.rw, ctx, fn as never) as Promise<T>;

  // ── Assertion 1: every tender line equals the ledger's own movement, to the cent ──────────────────
  it("each tender line of the Z-report equals the ledger's net movement on that §4.15 account", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: ctx.companyId, shiftId, limit: 10 }));
    expect(z).toBeDefined();

    for (const tender of z!.tenders) {
      const [ledger] = await api.db.admin<{ movement: string }[]>`
        select (sum(le.debit) - sum(le.credit))::text as movement
          from app.ledger_entry le
          join app.document      d on d.id = le.document_id
          join app.document_type t on t.id = d.document_type_id
          join app.account       a on a.id = le.account_id
         where d.shift_id = ${shiftId} and d.status in ('posted', 'reversed')
           and t.code = 'POS_TICKET' and a.code = ${tender.accountCode}
           and le.currency = ${z!.currency}`;
      expect(tender.amount).toBe(ledger!.movement);   // to the CENT: string equality on numeric(19,4)
    }

    // And the four methods are the four §4.6.5 rules, each with the figure the day's arithmetic gives.
    const byMethod = Object.fromEntries(z!.tenders.map((t) => [t.method, t.amount]));
    expect(byMethod).toEqual({
      cash: "187.5000",           // 199.50 sold − 12.00 refunded
      card: "149.9900",
      transfer: "500.0000",
      store_credit: "20.0000",
    });
  });

  // ── Assertion 2: the drawer's own arithmetic closes on the ledger ─────────────────────────────────
  it("opening_float + net(1110) over EVERY posted document of the shift == counted_cash", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: ctx.companyId, shiftId, limit: 10 }));

    // Every document of the shift, TILL_OVER_SHORT INCLUDED — which is the difference between this
    // assertion and ADR 0063's formula, and is the whole point: the expectation EXCLUDES the correction,
    // and the drawer AFTER the correction must equal what the cashier physically counted. If the two
    // agreed by construction the test would be vacuous; they agree only if the posting is right.
    const [net] = await api.db.admin<{ movement: string }[]>`
      select (sum(le.debit) - sum(le.credit))::text as movement
        from app.ledger_entry le
        join app.document d on d.id = le.document_id
        join app.account  a on a.id = le.account_id
       where d.shift_id = ${shiftId} and d.status in ('posted', 'reversed')
         and a.code = '1110' and le.currency = ${z!.currency}`;

    // Compared in SQL's numeric, not in JavaScript: no Number(), no toFixed, no float (Constraint 2).
    const [tie] = await api.db.admin<{ closes: boolean; drawer: string }[]>`
      select (${z!.openingFloat}::numeric(19,4) + ${net!.movement}::numeric(19,4))
               = ${z!.countedCash}::numeric(19,4) as closes,
             (${z!.openingFloat}::numeric(19,4) + ${net!.movement}::numeric(19,4))::text as drawer`;
    expect(tie!.drawer).toBe(day.countedCash);
    expect(tie!.closes).toBe(true);
  });

  // ── Assertion 3: the difference and the document that carries it ──────────────────────────────────
  it("over_short == counted − expected, and TILL_OVER_SHORT carries the magnitude on the right side", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: ctx.companyId, shiftId, limit: 10 }));
    expect(z!.expectedCash).toBe("387.5000");
    expect(z!.countedCash).toBe("386.0000");
    expect(z!.overShort).toBe("-1.5000");            // SHORT, and the sign says so (§4.6.5)
    expect(z!.overShortDocumentId).not.toBeNull();

    const legs = await api.db.admin<{ code: string; debit: string; credit: string; base_debit: string }[]>`
      select a.code, le.debit::text, le.credit::text, le.base_debit::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${z!.overShortDocumentId} order by a.code`;
    expect(legs).toEqual([
      { code: "1110", debit: "0.0000", credit: "1.5000", base_debit: "0.0000" },
      { code: "5120", debit: "1.5000", credit: "0.0000", base_debit: "1.5000" },
    ]);
    // A magnitude, never a negative: `side` carried the direction all the way down (§4.4.2 A9).
    for (const l of legs) { expect(l.debit).not.toMatch(/^-/); expect(l.credit).not.toMatch(/^-/); }

    // The document is a real, posted, numbered document in a per-terminal series (amendment A15).
    const [doc] = await api.db.admin<{ status: string; series: string; number: string; code: string }[]>`
      select d.status::text, d.series, d.number::text, t.code
        from app.document d join app.document_type t on t.id = d.document_type_id
       where d.id = ${z!.overShortDocumentId}`;
    expect(doc!.code).toBe("TILL_OVER_SHORT");
    expect(doc!.status).toBe("posted");
    // The code comes off the fixture: `posFixture` enrols `KL01` (6A Task 10 Step 6) and `StaffFixture.terminalA`
    // IS that terminal (6C Task 9 Step 2), so this is `TOS-KL01`. 6A writes its own the same way (6A Task 11 Step 1).
    expect(doc!.series).toBe(`TOS-${f.terminalA.code}`);
    expect(Number(doc!.number)).toBeGreaterThan(0);
  });

  // ── The three clauses of the phase DoD this slice also carries ────────────────────────────────────
  it("zero duplicates — the whole day re-sent changes nothing (spec:1304, test 19's server half)", async () => {
    // **The ORIGINAL objects, captured in `beforeAll` as `sent`, not freshly built ones.** `ticket()` mints
    // a new `clientRef` on every call, so re-building them would send eight genuinely new sales — and
    // `assertShiftKnown` accepts a CLOSED shift (see the push-back note in the Self-Review), so they would
    // post into the closed drawer and the snapshot would legitimately change. The claim under test is
    // idempotency on `client_ref`, and only the same refs can test it.
    const before = await snapshot();
    await push({ shifts: sent.shifts, tickets: sent.tickets, tillEvents: sent.tillEvents });
    expect(await snapshot()).toEqual(before);
  });

  it("zero lost tickets — every message of the day was acked, and none by silence", async () => {
    // Every ref the day sent appears in a result array with a terminal status. `drainOutbox` acks only a
    // ref present in one of the arrays (§4.10.5), so this is the property that makes the till's outbox
    // drain: a ref answered by silence would stay pending for ever and be a stuck till, not a lost sale.
    const out = await push({
      shifts: [openMsg(crypto.randomUUID(), "0.0000")],
      tickets: [ticket({ cash: "1.0000" })],
      tillEvents: [event("no_sale")],
    });
    // The three arrays are two different shapes: `TicketResult` acks by `clientRef`, `MessageResult` by
    // `ref` (contracts:3306–3310). `r.ref` on the union does not compile, so narrow with `in` rather than
    // casting — a cast here would hide the very typo (`ref` where `clientRef` belongs) this case exists
    // to catch on the wire.
    for (const r of [...out.results, ...out.shiftResults, ...out.tillEventResults]) {
      expect("ref" in r ? r.ref : r.clientRef).toBeTruthy();
      expect(["accepted", "duplicate", "rejected"]).toContain(r.status);
    }
  });

  it("the Z-report's own figures survive a reversal of one of the day's tickets", async () => {
    // A supervisor reverses a card sale the next morning. The Z-report of a CLOSED shift must not move:
    // `counted_cash`, `expected_cash` and `over_short` are stored facts about a drawer that was counted,
    // and a later correction is its own document. The TENDER lines DO move, because they read the ledger
    // — and that is right: the money did come back. This case pins which half is which.
    const [before] = await read((tx) => zReport(tx, { companyId: ctx.companyId, shiftId, limit: 10 }));
    const [card] = await api.db.admin<{ id: string }[]>`
      select d.id from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.ledger_entry le on le.document_id = d.id
        join app.account a on a.id = le.account_id
       where d.shift_id = ${shiftId} and t.code = 'POS_TICKET' and a.code = '1120' limit 1`;
    // As the TERMINAL: the reversal is another POS_TICKET and its policy's `approval.post` is
    // `pos.sync.push`, which R2 evaluates inside the posting transaction and no human holds (Task 5's
    // reversal case carries the full reasoning and the stop-and-raise note).
    await withTenant(api.db.rw, ctx, (tx) =>
      reverseDocument(tx, ctx,
        { documentId: card!.id, effectiveDate: "2026-01-20", reason: "chargeback" }));

    const [after] = await read((tx) => zReport(tx, { companyId: ctx.companyId, shiftId, limit: 10 }));
    expect(after!.countedCash).toBe(before!.countedCash);
    expect(after!.expectedCash).toBe(before!.expectedCash);
    expect(after!.overShort).toBe(before!.overShort);
    const cardAfter = after!.tenders.find((t) => t.method === "card")!;
    expect(cardAfter.amount).not.toBe("149.9900");        // the reversal is in the ledger, so it is here
  });

  it("sales_by_cashier attributes the day to the CASHIER, not to the terminal (hazard 19)", async () => {
    const rows = await read((tx) => salesByCashier(tx, {
      companyId: ctx.companyId, from: "2026-01-01", to: "2026-12-31", branchId: f.branchA, limit: 50,
    }));
    expect(rows.map((r) => r.cashierPrincipalId)).toContain(f.cashierA);
    expect(rows.map((r) => r.cashierPrincipalId)).not.toContain(f.terminalA.principalId);
    expect(rows.find((r) => r.cashierPrincipalId === f.cashierA)!.overShortBase).toBe("-1.5000");
  });
});
```

**The five helpers this file defines**, all test-local (§4.17.1 assigns 6D no new shared helper):

```ts
/**
 * One signed `POST /v1/sync/tickets`, through the REAL route — headers, Ed25519 signature, terminal JWT
 * and idempotency key all included, because 6A's `syncRequest` builds them. Returns the `BatchResult`.
 *
 * **The call is 6A's THREE-argument object form and the response is a `Response`.** `syncRequest(api, t,
 * req)` takes `{ method, path, body?, idempotencyKey?, headers? }` (6A Task 7 Step 6) and answers
 * `Promise<Response>`; a positional `(api, t, "POST", path, body)` does not typecheck, and `res.body` is a
 * stream, not the parsed result — the parsed result is `await res.json()`. Every 6A call site is the
 * object form (6A's Task 8, Task 12 and Task 13 call sites) and §4.18 makes 6A the authority.
 */
const push = async (body: { tickets?: unknown[]; shifts?: unknown[]; tillEvents?: unknown[] }) => {
  sent.tickets.push(...(body.tickets ?? []));
  sent.shifts.push(...(body.shifts ?? []));
  sent.tillEvents.push(...(body.tillEvents ?? []));
  const res = await syncRequest(api, f.terminalA, {
    method: "POST",
    path: "/v1/sync/tickets",
    body: {
      terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(),
      tickets: body.tickets ?? [], shifts: body.shifts ?? [], tillEvents: body.tillEvents ?? [],
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as BatchResult;
};

const openMsg = (shiftId: string, openingFloat: string) => ({
  shiftId, kind: "open", terminalId: f.terminalA.terminalId, cashierPrincipalId: f.cashierA,
  at: new Date().toISOString(), currency: "MYR",
  openingFloat: { amount: openingFloat, currency: "MYR" }, countedCash: null,
});

const closeMsg = (shiftId: string, countedCash: string, closer: string) => ({
  shiftId, kind: "close", terminalId: f.terminalA.terminalId, cashierPrincipalId: closer,
  at: new Date().toISOString(), currency: "MYR",
  openingFloat: null, countedCash: { amount: countedCash, currency: "MYR" },
});

/**
 * One ticket in `shiftId`, priced so its single tender of the named method equals the given amount.
 *
 * **It is `buildTicket` with two options translated, not a second ticket builder.** 6A's builder derives
 * the single tender as `unitPrice × quantity − discount` and takes `method` from `opts.tender`
 * (6A Task 10 Step 6), so "a 45.50 cash sale" is `{ unitPrice: "45.5000", tender: "cash" }` — there is no
 * `cashPrice` option and §4.17.1 forbids adding one. The named key here is sugar for the day's narrative:
 * `ticket({ cash: "45.5000" })` reads as the day reads.
 *
 * **Nothing is negated at this call site.** `kind: "return"` makes 6A's builder flip `quantity`, `total`,
 * `taxAmount`, `discount` and the tender's `amount` together, in one place, by design (its own comment
 * says a caller that flipped three of the five would build a ticket whose tenders do not sum to its lines
 * and see it refused for an unrelated reason). `unitPrice` never flips: a price is a price (§4.4.2 A9).
 *
 * **A return MUST carry `returnsClientRef`, and this signature makes it non-optional for `kind: "return"`.**
 * 6C classifies `kind === "return"` with `returnsClientRef === null` as a **blind** return (6C Task 9 Step 1(b)),
 * which needs `pos.ticket.return_blind` **and** `blind_return_allowed = true`. `staffFixture` sets branch
 * A's `blind_return_allowed` false and grants `cashierA` `pos.ticket.return` and **not** `return_blind`
 * (6C Task 9 Step 2's `staffFixture`) — so a null-ref refund is refused at branch A, `push`'s `expect(res.status).toBe(200)`
 * still passes (the batch is fine; the ticket is not), and every cash figure below would be 12.00 too high
 * with `results[0].status === "rejected"` as the only clue. `day.cashRefund` is one of `day.cashSales`,
 * and its original `clientRef` is captured in `cashRefs` for exactly this.
 */
const ticket = (t: {
  cash?: string; card?: string; transfer?: string; storeCredit?: string;
  kind?: "sale" | "return"; returnsClientRef?: string; clientRef?: string;
}) => {
  const [tender, amount] =
    t.cash !== undefined ? (["cash", t.cash] as const)
    : t.card !== undefined ? (["card", t.card] as const)
    : t.transfer !== undefined ? (["transfer", t.transfer] as const)
    : t.storeCredit !== undefined ? (["store_credit", t.storeCredit] as const)
    : (() => { throw new Error("ticket(): name exactly one of cash, card, transfer, storeCredit"); })();

  return buildTicket(f.pos, {
    sku: "SKU-A",
    shiftId,
    unitPrice: amount,          // quantity defaults to 1.000000 and discount to 0, so tender === amount
    tender,                     // one of §4.10.1's four TicketTender methods (6A Task 1)
    kind: t.kind ?? "sale",
    returnsClientRef: t.returnsClientRef ?? null,
    cashierPrincipalId: f.cashierA,
    ...(t.clientRef !== undefined ? { clientRef: t.clientRef } : {}),
  });
};

const event = (kind: string, over: Record<string, unknown> = {}) => ({
  clientRef: crypto.randomUUID(), shiftId, kind, ticketClientRef: null,
  cashierPrincipalId: f.cashierA, supervisorPrincipalId: null,
  occurredAt: new Date().toISOString(), ...over,
});

/** A comparable fingerprint of everything the day wrote, so "re-sent changes nothing" is one assertion
 *  rather than nine. It counts rows and sums the ledger, so both a duplicate row and a double posting
 *  show up. `posted_at` and the ids are deliberately excluded — a re-send that changed nothing but the
 *  clock is still a change of nothing. */
const snapshot = async () => {
  const [row] = await api.db.admin<{
    documents: number; lines: number; entries: number; debit: string; credit: string;
    shifts: number; events: number;
  }[]>`
    select (select count(*)::int from app.document where shift_id = ${shiftId})            as documents,
           (select count(*)::int from app.document_line l join app.document d on d.id = l.document_id
             where d.shift_id = ${shiftId})                                                as lines,
           (select count(*)::int from app.ledger_entry le join app.document d on d.id = le.document_id
             where d.shift_id = ${shiftId})                                                as entries,
           (select coalesce(sum(le.debit), 0)::text from app.ledger_entry le
              join app.document d on d.id = le.document_id where d.shift_id = ${shiftId})  as debit,
           (select coalesce(sum(le.credit), 0)::text from app.ledger_entry le
              join app.document d on d.id = le.document_id where d.shift_id = ${shiftId})  as credit,
           (select count(*)::int from app.shift where id = ${shiftId})                     as shifts,
           (select count(*)::int from app.till_event where shift_id = ${shiftId})           as events`;
  return row!;
};
```

- [ ] **Step 2: Run it, and read the first failure carefully.**

Run: `cd tests && bun run test -- pos-shift-reconciliation`
Expected: **7 passed** on a correct implementation of Tasks 1–7.

**The three failures worth naming, because each points at a different task rather than at this test.**

| What you see | Where the defect is |
|---|---|
| Assertion 1's `byMethod` shows `cash: "186.0000"` instead of `"187.5000"` | Task 7 Step 2's tender query is not scoped to `t.code = 'POS_TICKET'`, so the `TILL_OVER_SHORT` correction has been folded into the cash tender. Fix the report, never the expected figure. |
| Assertion 2's `closes` is `false` and `drawer` is `"389.0000"` | The `TILL_OVER_SHORT` legs are the wrong way round — Task 5 Step 3's `over` branch. A short drawer must *credit* `1110`; debiting it moves the drawer the wrong way by twice the difference. |
| Assertion 3's `expectedCash` is `"399.5000"` | `computeExpectedCash` is filtering `d.status = 'posted'` instead of `in ('posted','reversed')`, so the refunded sale's own entries were dropped and its reversal's kept. ADR 0063's fourth consequence. |
| `beforeAll` fails on `expect(refunded.results[0]!.status).toBe("accepted")`, `received: "rejected"` with `ERR_POS_LIMIT_EXCEEDED` and `blind_return` in the detail | The refund reached 6C's `verifyTicket` with `returnsClientRef === null`, which is a **blind** return (6C Task 9 Step 1(b)): branch A's `blind_return_allowed` is false and `cashierA` holds `pos.ticket.return` and not `return_blind` (6C Task 9 Step 2's `staffFixture`). The `ticket()` helper must pass `returnsClientRef: cashRefs[1]`. Do **not** widen the branch policy or the cashier's grants to make it pass — those are 6C's fixture facts and other 6C suites assert them. |
| Assertion 1's `byMethod` has no `cash` key at all, or every figure is 12.00 high | The same defect, one step earlier: the refund was refused and the day never had it. Check `beforeAll`'s new `expect` first. |

- [ ] **Step 3: Commit.**

```bash
git add tests/invariants/pos-shift-reconciliation.test.ts
git commit -m "test(invariants): acceptance test 21 — the Z-report ties to the ledger [6D T8]

A full trading day through the signed sync route: eight sales across all four
tender methods, a refund, three till events and a 1.50 short close. Three
assertions with no tolerance — every tender line equals its §4.15 account's own
ledger movement; opening_float + net(1110) over EVERY document of the shift,
TILL_OVER_SHORT included, equals counted_cash; and over_short equals
counted - expected with the magnitude on the side the sign chose. Plus the two
phase-DoD clauses this slice carries: the day re-sent changes nothing, and every
message was acked by a status rather than by silence.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: ⚠️ OD-10 — `TILL_PAID_OUT`, the fourth sync message array, and ADR 0064

**Owner decision OD-10 (§2.12): "Till cash lifecycle — paid-outs, safe drops, daily banking" — spec:1063 ⚠️, 1354, 2406, 2479; Part VII #15. Default: NOT BUILT.** This is also the discharge of **OD-05** for this slice: OD-05 is "confirmation of every ⚠️ row in §3.0.3 and §3.0.4", and 6D's scope contains exactly one such row — spec:1063, till cash lifecycle — which is OD-10's own subject. Both ids are recorded against one decision rather than creating a second gate for one sentence (hazard 6 asks for one task per decision, not one task per id pointing at one decision).

**Owner provides:** a yes/no on the till cash lifecycle, and if yes, four facts a shop's own practice decides and no plan may assume: (1) whether a cashier may pay cash out of the drawer at all, or only a supervisor; (2) whether a safe drop is a shop routine or an exception; (3) whether the daily banking is made from the drawer or from the safe; (4) whether a paid-out needs a supporting document (a supplier receipt) attached.
**Verify:** `ls -1 docs/owner/od-10/` and confirm `decision.md` naming all four, signed and dated.
**Until provided:** **Tasks 9, 10 and 11 do not run.** Migration `0071` is not written, `0071` stays unused in the 0070–0073 range, ADR 0064 is not written, the three document-type files are not created, `5130` is not added to `6d-till.json`, and `packages/sync`'s `TicketBatch` keeps its three arrays. **Nothing in Tasks 0–8 or 12–13 depends on any of it**, which is what makes this a droppable gate rather than a blocked slice: the Z-report's `cashControl` section is already written to iterate whatever document types touched `1110`, so it is simply empty; `1130` Cash in transit is seeded **unconditionally** by Task 4 so 4B's reconciliation has an account to clear for a manual banking journal; and `expected_cash`'s formula (ADR 0063) reads the ledger and therefore needs no clause per type.

**If the owner decides yes, what changes beyond these three tasks:** nothing outside them. That is the design and it is why Task 4 seeded `1130` early — a "no" answer removes three tasks and one migration number and touches no line of the other eleven.

**Files** (all conditional)
- Create: `docs/adr/0064-till-cash-lifecycle-and-cash-in-transit.md`, `packages/db/src/sync/till-cash.ts`, `packages/db/seed/my/document-types/TILL_PAID_OUT.json`, `packages/db/test/sync/till-cash.test.ts`
- Modify: `packages/db/seed/my/chart-of-accounts/6d-till.json` (the third row, `5130`), `packages/sync/src/messages.ts`, `packages/contracts/src/sync/messages.ts`, `packages/db/src/sync/apply.ts` (the fourth loop and `TicketBatchInput.cashEvents`), `apps/api/src/routes/sync/tickets.ts` (`toBatchResult`), `packages/sync/src/client.ts` (`drainOutbox` acks the fourth array), `packages/db/src/sync/index.ts`

**Interfaces**

- Consumes: `buildTillDocument`, `resolveAccountByCode` (Task 5); `assertShiftKnown`, `moneyFromMessage` (Tasks 3); `runMessage`, `TerminalApplyContext`, `MessageOutcome`, `SyncError` (6A/Task 3); `app.branch_pos_policy.paid_out_allowed`, `.max_paid_out_amount` (6C, migration 0066); `app.principal_has` (2B); `POS_PERMISSION` (Task 2); `Money`, `currency` (§4.2.1); `SyncStore`, `markAcked`, `drainOutbox`, `TicketBatch`, `BatchResult`, `MessageResult` (§4.10.5, 6A).
- Produces (Task 0 amendment A13):

```ts
// packages/sync/src/messages.ts — additive. A client that sends three arrays and reads three is unaffected.
export interface TillCashMsg {
  clientRef: string;            // uuidv7 minted at the till; the ack key and the document's client_ref
  shiftId: string;
  kind: "paid_out" | "safe_drop" | "banking";
  amount: { amount: string; currency: string };
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
  reference: string | null;     // a supplier receipt number, a safe-drop bag number, a deposit slip
  fromSafe: boolean;            // banking only: true = out of the safe (1130), false = out of the drawer (1110)
}
// 6A's two wire interfaces, each gaining exactly ONE member. The existing members are reprinted here so
// this block is the whole shape a reader implements from; §4.10.1 (contracts:3305–3311) is the authority
// and `BatchResult`'s cursor member is **`catalogueCursor`**, a string — `catalogueRevision` is the
// db-tier `BatchOutcome`'s member and does not appear on the wire.
export interface TicketBatch {
  terminalId: string; batchId: string;
  tickets: Ticket[]; shifts: ShiftOpenClose[]; tillEvents: TillEventMsg[];
  cashEvents: TillCashMsg[];              // ⚠️ OD-10 — the one added member
}
export interface BatchResult {
  batchId: string; results: TicketResult[];
  shiftResults: MessageResult[]; tillEventResults: MessageResult[];
  cashEventResults: MessageResult[];      // ⚠️ OD-10 — the one added member
  catalogueCursor: string;
}

// packages/db/src/sync/till-cash.ts — exported from @dulja/db. The db-tier twin of `TillCashMsg`:
// `kind` is `string` and not the three-member union because §3.1 forbids `packages/db` importing
// `@dulja/sync`, so this is a structural twin the wire type satisfies — 6A's `TicketInput` precedent.
export interface TillCashInput {
  clientRef: string; shiftId: string; kind: string;
  amount: { amount: string; currency: string };
  cashierPrincipalId: string; supervisorPrincipalId: string | null;
  occurredAt: string; reference: string | null; fromSafe: boolean;
}
export function cashEventRef(m: unknown): string;
/** The `branch_pos_policy` and authority checks a cash event needs, in 6C's `verifyTicket` shape. */
export async function verifyCashEvent(
  sp: Sql, terminal: TerminalApplyContext, msg: TillCashInput,
): Promise<void>;
/** Posts the event's document and inserts ⚠️ `till_banking_link` for a banking (Task 11). */
export async function applyCashEvent(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: TillCashInput,
): Promise<MessageOutcome>;
```

- [ ] **Step 1: The gate — confirm the owner's decision, or stop here.**

Run: `ls -1 docs/owner/od-10/`
Expected: `decision.md`. **If the directory is missing: stop.** Record "OD-10 unanswered; till cash lifecycle deferred" in this task, leave Steps 2–9 unchecked, drop Tasks 10 and 11 with it, and ship the slice. Do not substitute a guess: whether a cashier may take cash out of a drawer is a shop's control decision and inventing one would put a hole in the till it was not asked for.

- [ ] **Step 2: Write ADR 0064 — a proposal (money semantics *and* the sync protocol, spec:95).**

```markdown
# 0064 — The till cash lifecycle rides the sync protocol, and a banking is cash in transit

- Status: **Proposed** — money semantics and the sync protocol both (spec:95)
- Date: 2026-09-08
- Slice: 6D · Gated on OD-10
- Amends: contracts §4.10.1 (a fourth message array), §4.10.6 (`outbox.kind`), §4.15 (`1130`, `5130`)

## Context

A shop pays a supplier out of the drawer, drops surplus notes into the safe, and banks the day's takings.
Each is a movement of physical cash that must reach the ledger, and each happens at a till that may be
offline for hours.

Two routes were available.

**(a) Back-office API routes** — `POST …/documents/till-paid-outs` and friends, gated on a permission.
**(b) A fourth array on the sync batch** — the till records the event in its outbox and it drains with the
tickets.

## Decision

**(b).** `TicketBatch` gains `cashEvents: TillCashMsg[]` and `BatchResult` gains `cashEventResults`.
`outbox.kind`'s CHECK becomes `('ticket','shift','till_event','cash_event')`. `TILL_PAID_OUT`,
`TILL_SAFE_DROP` and `TILL_BANKING` post through `buildTillDocument` inside `applyBatch`, in the batch
order **opens → tickets → cash events → closes**.

`TILL_PAID_OUT` debits **`5130` Till paid out** (tagged BRANCH) and credits `1110`.
`TILL_SAFE_DROP` debits **`1130` Cash in transit** and credits `1110`.
`TILL_BANKING` debits **`1100` Bank** and credits `1130` when `fromSafe`, else `1110`.

## Consequences

- **(a) was not merely worse, it was impossible.** §4.14 fixes all three types' `approval.post` at
  `pos.sync.push`, and R8 (spec:2179) keeps a human out of the `pos_terminal` role — so a back-office
  route could create the document and could not post it. Changing the `approval.post` code would mean a
  human could post a till document from a desk, which is the control this whole slice exists to keep.
- **Every cash event is inside the shift's expectation with no formula change.** ADR 0063 reads the `1110`
  leg, so a paid-out reduces `expected_cash` the moment its document posts. A shop that pays a supplier
  200 and counts 200 less is not short.
- **`TILL_BANKING` always debits `1100`**, which is what makes it visible to 4B's `ledgerLegSource` — that
  source lists from the ledger leg on the *statement's own* `bank_account_id`, so a banking with no `1100`
  leg could never be matched and test 39's "the reconciled balance equals the bank account's ledger
  balance" clause could not hold.
- **`1130` sits between the drawer and the bank** and is cleared by 4B's matching, not by a second posting.
  A safe drop that is never banked leaves a balance on `1130` — which is the correct statement of a
  physical fact and is exactly what an auditor wants to see.
- **Cash events run BEFORE the close and AFTER the tickets.** A banking is cash out of the drawer before
  the count; a paid-out funded by the day's sales needs those sales posted first.
- **The batch is not atomic across kinds and must not be.** Each message has its own savepoint: a paid-out
  refused for exceeding the branch limit must not roll back the sales beside it.
- **`packages/sync`'s edits are additive and versionless.** A till built against three arrays sends three
  and reads three; `TicketBatchInput.cashEvents` is optional in the db tier, so 6A's own tests compile
  unchanged. There is no protocol version to negotiate, which is the property that lets 6B ship before
  this decision lands and not be rebuilt after it.

## Rejected

- **A single `TILL_CASH` type with a `kind` field.** Three types cost three seed files and buy three
  independent numbering series, three sets of policy rules and three rows in §4.14 that a report can name.
  One type with a discriminator would put the account choice inside a policy `when` on a custom field,
  which §4.4.1 admits but which makes the chart of accounts a matter of a JSON path.
- **Netting the day's cash events into the close.** It would lose the individual events, and spec:1354's
  whole point is that a drawer's history is auditable.
```

- [ ] **Step 3: Add `5130` to `6d-till.json` and write `TILL_PAID_OUT.json`.**

```json
  {
    "code": "5130",
    "nameEn": "Till paid out",
    "nameAr": "مدفوعات من الصندوق",
    "type": "expense",
    "parentCode": "5000"
  }
```

```json
{
  "code": "TILL_PAID_OUT",
  "nameEn": "Till Paid Out",
  "nameAr": "دفع من الصندوق",
  "module": "pos",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "TILL_PAID_OUT",
    "direction": "outbound",
    "requires": ["client_ref", "attributed_to"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "TPO", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "TILL_PAID_OUT" },
    "approval": { "required": false, "approve": null, "post": "pos.sync.push" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`direction: "outbound"` per §4.14's row; `requires` adds `client_ref` because a cash event **does** have a till-minted ref (unlike the server-minted over/short), and it is the dedup key. `dimensions.required: ["BRANCH"]` is §4.15's "tagged BRANCH" for `5130`. **No `account: { code }` literal**, same as `TILL_OVER_SHORT`: `applyCashEvent` picks the pair.

- [ ] **Step 4: Widen the message package — `packages/sync/src/messages.ts` and its Zod mirror.**

```ts
/** ⚠️ OD-10. A movement of physical cash at the till that is not a sale (spec:1354, ADR 0064).
 *  Acked by `clientRef`, like a `TillEventMsg` and unlike a `ShiftOpenClose`. */
export interface TillCashMsg {
  clientRef: string;
  shiftId: string;
  kind: "paid_out" | "safe_drop" | "banking";
  amount: { amount: string; currency: string };
  cashierPrincipalId: string;
  supervisorPrincipalId: string | null;
  occurredAt: string;
  reference: string | null;
  /** `banking` only. `true` credits 1130 Cash in transit (the deposit came from the safe); `false`
   *  credits 1110 (straight from the drawer). Ignored for the other two kinds. */
  fromSafe: boolean;
}

export interface TicketBatch {
  terminalId: string; batchId: string;
  tickets: Ticket[]; shifts: ShiftOpenClose[]; tillEvents: TillEventMsg[];
  cashEvents: TillCashMsg[];              // ⚠️ OD-10
}
export interface BatchResult {
  batchId: string; results: TicketResult[];
  shiftResults: MessageResult[]; tillEventResults: MessageResult[];
  cashEventResults: MessageResult[];      // ⚠️ OD-10
  catalogueCursor: string;
}
```

`packages/contracts/src/sync/messages.ts` gains `TillCashMsgSchema` in the same shape — `MoneySchema` for `amount`, `UuidSchema` for the three ids, `TimestampSchema` for `occurredAt`, `z.enum(["paid_out","safe_drop","banking"])` for `kind` — and both `TicketBatchSchema` and `BatchResultSchema` gain their array. `packages/sync/src/client.ts`'s `drainOutbox` needs **no logic change**: it passes the whole `BatchResult` to `store.markAcked(ids, result)`, and `SyncStore` implementations match a fourth result array exactly as they match the other three. `outbox.kind`'s CHECK in 6B's SQLite schema (§4.10.6) becomes `('ticket','shift','till_event','cash_event')` — a one-literal edit in 6B's file, listed here because this task owns the amendment.

- [ ] **Step 5: Write `packages/db/src/sync/till-cash.ts`.**

```ts
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { SyncError } from "./enrolment";
import { assertShiftKnown, moneyFromMessage } from "./shifts";
import { POS_PERMISSION } from "./authority";
// `tillEffectiveDate` is named here because `applyCashEvent` calls it below (Task 5 Step 2 exports it
// beside `buildTillDocument`); omitting it is `TS2304: Cannot find name 'tillEffectiveDate'`.
import { buildTillDocument, tillEffectiveDate, type TillDocumentKind } from "../posting/till";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

export interface TillCashInput {
  clientRef: string; shiftId: string; kind: string;
  amount: { amount: string; currency: string };
  cashierPrincipalId: string; supervisorPrincipalId: string | null;
  occurredAt: string; reference: string | null; fromSafe: boolean;
}

const KINDS = new Set(["paid_out", "safe_drop", "banking"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §4.10.1's ack key for a cash event: the till's own `clientRef`. */
export function cashEventRef(m: unknown): string {
  return String(((m ?? {}) as Record<string, unknown>).clientRef ?? "");
}

/** kind → the §4.14 type code, the §4.15 debit code, and how the credit code is chosen. ADR 0064's table
 *  in one place, so no caller re-derives it. `banking`'s credit depends on `fromSafe`. */
const CASH_EVENT: Readonly<Record<string, {
  typeCode: string; kind: TillDocumentKind; debit: string; credit: (fromSafe: boolean) => string;
}>> = {
  paid_out:  { typeCode: "TILL_PAID_OUT",  kind: "paid_out",  debit: "5130", credit: () => "1110" },
  safe_drop: { typeCode: "TILL_SAFE_DROP", kind: "safe_drop", debit: "1130", credit: () => "1110" },
  banking:   { typeCode: "TILL_BANKING",   kind: "banking",   debit: "1100",
               credit: (fromSafe) => (fromSafe ? "1130" : "1110") },
};

/**
 * The authority and limit checks a cash event needs — 6C's `verifyTicket` shape, applied to cash.
 *
 * **Only `paid_out` is limited, and that is a decision.** A safe drop moves the company's own cash from
 * one of its own containers to another and reduces the risk in the drawer; a shop's control interest is
 * in *making it easy*. A banking is likewise a movement between company accounts. A paid-out is the only
 * one where cash leaves the company, and 6C's `branch_pos_policy` already carries `paid_out_allowed` and
 * `max_paid_out_amount` for exactly this (migration 0066, marked ⚠️ OD-10 there).
 *
 * **Read the policy ROW, never the cashier snapshot** (spec:1324) — the snapshot is the till's copy and
 * may lag or be tampered with, and 6C's ADR 0061 forbids a server decision reading it.
 */
export async function verifyCashEvent(
  sp: Sql, terminal: TerminalApplyContext, msg: TillCashInput,
): Promise<void> {
  const at = `cash event ${msg.clientRef}`;
  const [auth] = await sp<{ ok: boolean }[]>`
    select app.principal_has(${msg.cashierPrincipalId}, ${POS_PERMISSION.shiftOwn},
                             ${terminal.companyId}, ${terminal.branchId}) as ok`;
  if (!auth!.ok) {
    throw new SyncError("ERR_RBAC_FORBIDDEN",
      `${at}: principal ${msg.cashierPrincipalId} does not hold ${POS_PERMISSION.shiftOwn} at branch`
      + ` ${terminal.branchId}; a cash event is an act on one's own drawer`);
  }
  if (msg.kind !== "paid_out") return;

  const [policy] = await sp<{ allowed: boolean; max_amount: string }[]>`
    select paid_out_allowed as allowed, max_paid_out_amount::text as max_amount
      from app.branch_pos_policy
     where company_id = ${terminal.companyId} and branch_id = ${terminal.branchId}`;
  // No row means the closed defaults, exactly as 6C decided: a branch with no policy permits nothing.
  if (!policy || policy.allowed === false) {
    throw new SyncError("ERR_POS_LIMIT_EXCEEDED",
      `${at}: branch ${terminal.branchId} does not allow paid-outs (branch_pos_policy.paid_out_allowed)`);
  }
  const cur = currency(msg.amount.currency);
  const amount = Money.of(msg.amount.amount, cur);
  const limit = Money.of(policy.max_amount, cur);
  // `compare` returns > 0 when the receiver is greater. No `Number()`, no `>` on strings (Constraint 2).
  if (amount.compare(limit) > 0) {
    const [sup] = msg.supervisorPrincipalId === null ? [{ ok: false }] : await sp<{ ok: boolean }[]>`
      select app.principal_has(${msg.supervisorPrincipalId}, ${POS_PERMISSION.ticketOverride},
                               ${terminal.companyId}, ${terminal.branchId}) as ok`;
    if (!sup!.ok || msg.supervisorPrincipalId === msg.cashierPrincipalId) {
      throw new SyncError("ERR_POS_LIMIT_EXCEEDED",
        `${at}: ${amount.toString()} exceeds branch ${terminal.branchId}'s max_paid_out_amount`
        + ` ${limit.toString()} and no DIFFERENT principal holding ${POS_PERMISSION.ticketOverride}`
        + ` authorised it (spec:2161, 2179)`);
    }
  }
}

/**
 * One cash event: verify, dedup on the document's `client_ref`, post through `buildTillDocument`.
 *
 * Dedup reads `app.document` and not a table of its own, because a cash event **is** a document and
 * `unique (company_id, client_ref)` is already the key 6A's tickets dedup on. There is no second
 * bookkeeping to keep in step (hazard 9's spirit applied to state).
 */
export async function applyCashEvent(
  sp: Sql, ctx: TenantContext, terminal: TerminalApplyContext, msg: TillCashInput,
): Promise<MessageOutcome> {
  const ref = cashEventRef(msg);
  const at = `cash event ${msg.clientRef}`;

  if (!UUID_RE.test(String(msg.clientRef))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: clientRef is not a uuid`);
  }
  const spec = CASH_EVENT[msg.kind];
  if (!spec) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: kind must be paid_out, safe_drop or banking, received ${JSON.stringify(msg.kind)}`);
  }
  await assertShiftKnown(sp, terminal, msg.shiftId);

  const [existing] = await sp<{ id: string }[]>`
    select id from app.document where company_id = ${terminal.companyId} and client_ref = ${msg.clientRef}`;
  if (existing) return { ref, status: "duplicate", error: null };

  const [shift] = await sp<{ currency: string }[]>`select currency from app.shift where id = ${msg.shiftId}`;
  const amount = moneyFromMessage(msg.amount, "amount", shift!.currency, at);
  if (amount.isZero() || amount.isNegative()) {
    throw new SyncError("ERR_VALIDATION_FAILED",
      `${at}: amount must be a positive magnitude, received ${msg.amount.amount}`);
  }

  await verifyCashEvent(sp, terminal, msg);

  const result = await buildTillDocument(sp, ctx, terminal, {
    kind: spec.kind,
    typeCode: spec.typeCode,
    shiftId: msg.shiftId,
    amount,
    debitAccountCode: spec.debit,
    creditAccountCode: spec.credit(msg.fromSafe === true),
    effectiveDate: await tillEffectiveDate(sp, terminal.companyId, msg.occurredAt),
    attributedTo: msg.cashierPrincipalId,
    description: msg.reference === null
      ? `${spec.typeCode} on shift ${msg.shiftId}`
      : `${spec.typeCode} on shift ${msg.shiftId} — ${msg.reference}`,
    clientRef: msg.clientRef,
  });

  // ⚠️ Task 11 inserts the `till_banking_link` row here, for `kind === "banking"` only.
  await afterCashEvent(sp, terminal, msg, result.documentId);
  return { ref, status: "accepted", error: null };
}

/** Task 11's hook. Task 9 ships it as a no-op with this comment rather than as an empty stub the reader
 *  has to guess at: `TILL_SAFE_DROP` and `TILL_PAID_OUT` have nothing to record beyond their document,
 *  and the banking link exists only because `Reconcilable` needs a bank account and a value date per
 *  banking and a ledger leg carries no shift (amendment A16). */
async function afterCashEvent(
  _sp: Sql, _terminal: TerminalApplyContext, _msg: TillCashInput, _documentId: string,
): Promise<void> { /* Task 11 fills this for kind === "banking" */ }
```

- [ ] **Step 6: Wire the fourth loop into `applyBatch`.**

```ts
// packages/db/src/sync/apply.ts — TicketBatchInput gains ONE optional member, so 6A's own tests and 6B's
// three-array client both still compile (amendment A13).
export interface TicketBatchInput {
  terminalId: string; batchId: string; tickets: TicketInput[];
  shifts: unknown[]; tillEvents: unknown[];
  cashEvents?: unknown[];        // ⚠️ OD-10
}
export interface BatchOutcome {
  batchId: string; results: TicketOutcome[];
  shiftResults: MessageOutcome[]; tillEventResults: MessageOutcome[];
  cashEventResults: MessageOutcome[];    // ⚠️ OD-10 — always present, empty when the array was absent
  catalogueRevision: bigint;
}
```

```ts
  // 3b′. Cash events, BETWEEN the tickets and the closes (ADR 0064). A banking is cash out of the drawer
  //      before the count; a paid-out funded by the day's sales needs those sales posted first.
  const cashEventResults: MessageOutcome[] = [];
  for (const raw of batch.cashEvents ?? []) {
    const msg = (raw ?? {}) as TillCashInput;
    cashEventResults.push(
      await runMessage(tx, cashEventRef(raw), (sp) => applyCashEvent(sp, ctx, terminal, msg)),
    );
  }
```

…placed after the ticket loop and before the close loop, and `cashEventResults` added to the returned object. `apps/api/src/routes/sync/tickets.ts` takes **two** one-line edits: `toBatchResult` maps the fourth array through unchanged, and **Task 6 Step 6's `KNOWN_BATCH_KEYS` gains `"cashEvents"`** — growing from five members to six (three arrays to four). That guard is *not* removed and is not temporary: it stays the permanent raiser of `ERR_SYNC_MESSAGE_UNSUPPORTED` (`error-codes` needs one, §4.2.4), and after this task it refuses any key beyond the four arrays and the two scalars.

```ts
// apps/api/src/routes/sync/tickets.ts — Task 6 Step 6's const, one member wider. ⚠️ OD-10 only.
const KNOWN_BATCH_KEYS = new Set(["terminalId", "batchId", "tickets", "shifts", "tillEvents", "cashEvents"]);
```

Task 6 Step 6's route case then needs its unknown key changed from `cashEvents` to something this server still does not know, in this commit:

```ts
// apps/api/test/routes/sync/tickets.test.ts — the same case, with a key that is unknown AFTER OD-10.
        // `cashEvents` is understood from this commit onward, so the case names the next gap instead.
        attendanceEvents: [{ clientRef: crypto.randomUUID(), kind: "clock_in" }],
```
…and the two `expect(problem.detail).toContain(...)` lines change from `"cashEvents"` to `"attendanceEvents"`. **If OD-10 = no, none of this happens** and Task 6 Step 6's case stands as written.

- [ ] **Step 7: Write `packages/db/test/sync/till-cash.test.ts` — the paid-out half.**

Eleven cases; Tasks 10 and 11 append their own `describe` blocks to this file. The file header and the six shared helpers are written out below this block and are in scope for all three.

```ts
describe("⚠️ OD-10 — TILL_PAID_OUT (ADR 0064, spec:1354)", () => {
  /**
   * The world: branch A permits paid-outs up to 100.0000 and branch B is at 6C's closed defaults
   * (`paidOutAllowed: false`), which is what makes the two refusal cases a *policy* difference rather
   * than a missing row. The drawer opens at 300.0000 and takes two cash sales of 50.0000 — a real
   * balance to pay out of, so a refusal cannot be mistaken for "there was no money".
   */
  beforeAll(async () => {
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"], principalId: f.cashierA, roleCode: "t9-own-a", branchIds: [f.branchA],
    });
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"], principalId: f.cashierB, roleCode: "t9-own-b", branchIds: [f.branchB],
    });
    await seedBranchPosPolicy(db, f.seed, {
      branchId: f.branchA, limits: { paidOutAllowed: true, maxPaidOutAmount: "100.0000" },
    });
    await seedBranchPosPolicy(db, f.seed, {
      branchId: f.branchB, limits: { paidOutAllowed: false, maxPaidOutAmount: "0.0000" },
    });

    shiftId = await seedShift(db, f.seed, {
      terminalId: f.terminalA.terminalId, cashierPrincipalId: f.cashierA,
      openingFloat: "300.0000", branchId: f.branchA,
    });
    branchBTerminal = await seedTerminal(db, f.seed, { code: "B1", branchId: f.branchB });
    shiftBId = await seedShift(db, f.seed, {
      terminalId: branchBTerminal.terminalId, cashierPrincipalId: f.cashierB,
      openingFloat: "100.0000", branchId: f.branchB,
    });

    // Two cash sales of 50.0000 into the shift under test, through the real apply path.
    await batchAs(f.terminalA, f.branchA, { tickets: [
      buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "50.0000", tender: "cash",
                           cashierPrincipalId: f.cashierA }),
      buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "50.0000", tender: "cash",
                           cashierPrincipalId: f.cashierA }),
    ] });
  }, 300_000);

  it("a paid-out debits 5130 and credits 1110, tagged BRANCH", async () => {
    const out = await pushCash({ kind: "paid_out", amount: "30.0000", reference: "RCPT-001" });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    const ref = out.cashEventResults[0]!.ref;
    expect(await legsOf(ref)).toEqual([
      { code: "1110", debit: "0.0000", credit: "30.0000" },
      { code: "5130", debit: "30.0000", credit: "0.0000" },
    ]);
    // Every line carries the BRANCH dimension the policy requires — two lines, two dimension rows.
    const [dims] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from app.ledger_entry_dimension led
        join app.ledger_entry le on le.id = led.entry_id
        join app.document d on d.id = le.document_id
        join app.dimension_value dv on dv.id = led.dimension_value_id
        join app.dimension_type dt on dt.id = dv.dimension_type_id
       where d.client_ref = ${ref}::uuid and dt.code = 'BRANCH'`;
    expect(dims!.n).toBe(2);
  });

  it("the document is posted, numbered TPO-<terminal code>, and carries the shift and the cashier", async () => {
    const out = await pushCash({ kind: "paid_out", amount: "10.0000" });
    const [d] = await db.admin<{
      series: string; status: string; code: string; shift_id: string;
      attributed_to: string; created_by: string; terminal_id: string;
    }[]>`select d.series, d.status::text, t.code, d.shift_id::text, d.attributed_to::text,
                d.created_by::text, d.terminal_id::text
           from app.document d join app.document_type t on t.id = d.document_type_id
          where d.client_ref = ${out.cashEventResults[0]!.ref}::uuid`;
    expect(d!.code).toBe("TILL_PAID_OUT");
    expect(d!.status).toBe("posted");
    // Amendment A15: read the suffix off the fixture. `posFixture` enrols `KL01` (6A Task 10 Step 6) and
    // `StaffFixture.terminalA` IS that terminal (6C Task 9 Step 2); a literal would fail on a correct build.
    expect(d!.series).toBe(`TPO-${f.terminalA.code}`);
    expect(d!.shift_id).toBe(shiftId);
    // Hazard 19: the TERMINAL acts, the CASHIER is attributed.
    expect(d!.created_by).toBe(f.terminalA.principalId);
    expect(d!.attributed_to).toBe(f.cashierA);
    expect(d!.terminal_id).toBe(f.terminalA.terminalId);
  });

  it("the paid-out reduces the shift's expected_cash with no change to ADR 0063's formula", async () => {
    // 300 float + 100 sold − 30 − 10 (the two paid-outs above) = 360 expected. `computeExpectedCash`
    // reads the 1110 leg and knows nothing about paid-outs by name — which is the whole value of
    // deriving from the ledger rather than from tender lines.
    const out = await closeShiftFor(shiftId, "360.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string; doc: string | null }[]>`
      select expected_cash::text, over_short::text, over_short_document_id::text as doc
        from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("360.0000");
    expect(sh!.over_short).toBe("0.0000");
    expect(sh!.doc).toBeNull();                       // an exact count posts no document (Task 5)
  });

  it("re-sending a paid-out answers duplicate and posts nothing twice", async () => {
    const clientRef = crypto.randomUUID();
    const first = await pushCash({ kind: "paid_out", amount: "5.0000", clientRef });
    expect(first.cashEventResults[0]!.status).toBe("accepted");
    const second = await pushCash({ kind: "paid_out", amount: "5.0000", clientRef });
    expect(second.cashEventResults[0]!.status).toBe("duplicate");
    expect(second.cashEventResults[0]!.error).toBeNull();
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = ${clientRef}::uuid`;
    expect(n!.n).toBe(1);
    expect(await legsOf(clientRef)).toHaveLength(2);   // one pair, not two
  });

  it("a paid-out at a branch whose policy forbids it is ERR_POS_LIMIT_EXCEEDED", async () => {
    const out = await pushCashAt(branchBTerminal, { kind: "paid_out", amount: "1.0000" });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(out.cashEventResults[0]!.error!.detail).toContain("paid_out");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("a paid-out over max_paid_out_amount with no supervisor is ERR_POS_LIMIT_EXCEEDED, naming the limit", async () => {
    const out = await pushCash({ kind: "paid_out", amount: "150.0000" });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    // The limit is in the message, so the cashier reads what to ask for rather than "denied".
    expect(out.cashEventResults[0]!.error!.detail).toContain("100.0000");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("the same paid-out with a DIFFERENT principal holding pos.ticket.override is accepted", async () => {
    // 6C's `OVERRIDE_LIFTS` is the rule: a supervisor holding `pos.ticket.override` (f.supervisorA,
    // 6C Task 9 Step 2) lifts a LIMIT. `recordOverride` is what `verifyCashEvent` calls, so the authorisation is
    // 2B's, not a second implementation.
    const out = await pushCash({
      kind: "paid_out", amount: "150.0000", supervisorPrincipalId: f.supervisorA,
    });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([
      { code: "1110", debit: "0.0000", credit: "150.0000" },
      { code: "5130", debit: "150.0000", credit: "0.0000" },
    ]);
  });

  it("a supervisor who IS the cashier does not authorise it (a second principal means a second principal)", async () => {
    const out = await pushCash({
      kind: "paid_out", amount: "150.0000",
      cashierPrincipalId: f.cashierA, supervisorPrincipalId: f.cashierA,
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    // 2B's `app.assert_override_authorised` refuses an override whose principal is the document's own
    // `created_by` or `attributed_to`; this asserts the guard reaches the cash-event path rather than
    // being bypassed by `verifyCashEvent` doing its own comparison.
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("a cash event naming an unknown shift is ERR_CONFLICT_REFERENCE and posts nothing", async () => {
    const out = await pushCash({ kind: "paid_out", amount: "1.0000", shiftId: crypto.randomUUID() });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");   // assertShiftKnown
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document
       where client_ref = ${out.cashEventResults[0]!.ref}::uuid`;
    expect(n!.n).toBe(0);
  });

  it("one refused cash event leaves the tickets of its own batch committed (savepoint per message)", async () => {
    const good = buildTicket(f.pos, { sku: "SKU-A", shiftId: shiftBId, unitPrice: "7.0000",
                                      tender: "cash", cashierPrincipalId: f.cashierB });
    const badRef = crypto.randomUUID();
    const out = await batchAs(branchBTerminal as StaffFixture["terminalA"], f.branchB, {
      tickets: [good],
      cashEvents: [{
        clientRef: badRef, shiftId: shiftBId, kind: "paid_out",
        amount: { amount: "1.0000", currency: "MYR" },
        cashierPrincipalId: f.cashierB, supervisorPrincipalId: null,
        occurredAt: new Date().toISOString(), reference: null, fromSafe: false,
      }],
    });
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    // `runMessage`'s savepoint: the ticket's document survives the neighbour's rollback.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = ${good.clientRef}::uuid`;
    expect(n!.n).toBe(1);
  });

  it("a batch with NO cashEvents array returns cashEventResults: [] and nothing else changes", async () => {
    // Amendment A13's additivity claim, asserted rather than argued: `batchAs` supplies `cashEvents: []`
    // by default and a caller that names none is a pre-OD-10 client.
    const out = await batchAs(f.terminalA, f.branchA, { tickets: [], shifts: [], tillEvents: [] });
    expect(out.cashEventResults).toEqual([]);
    expect(out.results).toEqual([]);
    expect(out.shiftResults).toEqual([]);
    expect(out.tillEventResults).toEqual([]);
  });
});
```

**The five test-local helpers all three OD-10 tasks share**, written out once here because Tasks 10 and 11 append their `describe` blocks to this same file and reference all five. `pushCash` and `closeShiftFor` are the OD-10 twins of Task 7 Step 1's `sellInto`/`closeShiftFor`; the world is `staffFixture`'s, and this file starts and stops its own stack.

```ts
// packages/db/test/sync/till-cash.test.ts — the file header and the shared helpers, above the describes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
// `zReport` is used by Task 10's Z-report case and Task 11's banking case; it is a sibling module in this
// same package, so no dependency-rule question arises.
import { zReport } from "../../src/reports/pos";
import { grantCodes, seedBranchPosPolicy, seedShift, seedTerminal } from "../fixtures";
import { withTenant, type Db } from "../harness";
import { startApi, type StartedApi } from "../../../../apps/api/test/support/app";
import { buildTicket } from "../../../../tests/invariants/support/pos";
import { staffFixture, type StaffFixture } from "../../../../tests/invariants/support/staff";

let api: StartedApi;
let db: Db;
let f: StaffFixture;
/** Branch B's own terminal, seeded by the `beforeAll` of the first `describe` that needs it and shared by
 *  the branch-policy cases of Tasks 9 and 10. `pushCashAt` takes it as its first argument. The shape is
 *  6A's `seedTerminal` return, which is `{ terminalId, principalId }` and carries no `code` (6A Task 6). */
let branchBTerminal: { terminalId: string; principalId: string };
/** The shift under test, at branch A on `f.terminalA`. Module-level `let` because all three `describe`s
 *  below open their own and `pushCash` defaults to it; each `describe`'s own `beforeAll` assigns it. */
let shiftId: string;
/** A shift at branch B on that branch's own terminal, for the branch-policy refusal cases. Assigned by
 *  whichever `describe` needs it; `pushCashAt` defaults to it. */
let shiftBId: string;

// One stack for the file, started once and stopped once — §3.7.1's one-container-per-file rule, with
// three `describe`s sharing it because they share one `staffFixture` world.
beforeAll(async () => {
  api = await startApi();
  db = api.db;
  f = await staffFixture(api, "tillcash");
}, 300_000);
afterAll(async () => { await api.stop(); });

/** One `applyBatch` as a terminal, with whatever arrays the caller names. The four-array shape is
 *  amendment A13's; a batch that omits `cashEvents` gets `[]` back, which is the additivity claim. */
const batchAs = (
  terminal: StaffFixture["terminalA"], branchId: string, body: Record<string, unknown>,
) => withTenant(db.rw, f.seed.tenant, terminal.principalId, (tx) =>
  applyBatch(tx as never,
    { tenantId: f.seed.tenant, actorId: terminal.principalId, companyId: f.seed.company },
    { terminalId: terminal.terminalId, companyId: f.seed.company, branchId,
      principalId: terminal.principalId },
    { terminalId: terminal.terminalId, batchId: crypto.randomUUID(),
      tickets: [], shifts: [], tillEvents: [], cashEvents: [], ...body }));

/** One `TillCashMsg` (amendment A13's shape) into the shift under test, at branch A on terminal A. */
const pushCash = (msg: {
  kind: "paid_out" | "safe_drop" | "banking"; amount: string; shiftId?: string;
  cashierPrincipalId?: string; supervisorPrincipalId?: string | null;
  reference?: string | null; fromSafe?: boolean; clientRef?: string;
}) => batchAs(f.terminalA, f.branchA, { cashEvents: [{
  clientRef: msg.clientRef ?? crypto.randomUUID(),
  shiftId: msg.shiftId ?? shiftId,
  kind: msg.kind,
  amount: { amount: msg.amount, currency: "MYR" },
  cashierPrincipalId: msg.cashierPrincipalId ?? f.cashierA,
  supervisorPrincipalId: msg.supervisorPrincipalId ?? null,
  occurredAt: new Date().toISOString(),
  reference: msg.reference ?? null,
  fromSafe: msg.fromSafe ?? false,
}] });

/**
 * The same at a second terminal and branch, for the branch-policy cases. `terminal` comes from
 * `seedTerminal(db, f.seed, { code: "B1", branchId: f.branchB })` and `shiftBId` from
 * `seedShift(db, f.seed, { terminalId: terminal.terminalId, cashierPrincipalId: f.cashierB,
 * branchId: f.branchB })`, both in the calling `describe`'s `beforeAll`. **`shiftId` defaults to that
 * branch-B shift and not to the module-level one**: `assertShiftKnown` scopes a shift to its own terminal,
 * so passing branch A's drawer here would be refused with `ERR_CONFLICT_REFERENCE` and the case would pass
 * for the wrong reason — the branch-policy refusal it means to assert would never be reached.
 */
const pushCashAt = (
  terminal: { terminalId: string; principalId: string }, msg: Parameters<typeof pushCash>[0],
) => batchAs(terminal as StaffFixture["terminalA"], f.branchB, { cashEvents: [{
  clientRef: msg.clientRef ?? crypto.randomUUID(),
  shiftId: msg.shiftId ?? shiftBId,
  kind: msg.kind,
  amount: { amount: msg.amount, currency: "MYR" },
  cashierPrincipalId: msg.cashierPrincipalId ?? f.cashierB,
  supervisorPrincipalId: msg.supervisorPrincipalId ?? null,
  occurredAt: new Date().toISOString(),
  reference: msg.reference ?? null,
  fromSafe: msg.fromSafe ?? false,
}] });

/** Close `shift` at `counted` through the real sync path — the only way a shift closes (amendment A12). */
const closeShiftFor = (shift: string, counted: string) =>
  batchAs(f.terminalA, f.branchA, { shifts: [{
    shiftId: shift, kind: "close", terminalId: f.terminalA.terminalId,
    cashierPrincipalId: f.cashierA, at: new Date().toISOString(), currency: "MYR",
    openingFloat: null, countedCash: { amount: counted, currency: "MYR" },
  }] });

/** The ledger legs of the document a cash event produced, resolved through the event's own `clientRef`
 *  (which is `MessageOutcome.ref` for this message kind) — `(code, debit, credit)` ordered by code. */
const legsOf = async (ref: string): Promise<{ code: string; debit: string; credit: string }[]> =>
  db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, le.debit::text, le.credit::text
      from app.ledger_entry le
      join app.document d on d.id = le.document_id
      join app.account  a on a.id = le.account_id
     where d.company_id = ${f.seed.company} and d.client_ref = ${ref}::uuid
     order by a.code`;

/** A comparable fingerprint of one document's ledger rows, so "matching altered no ledger entry"
 *  (SAH-041) is one assertion. Ids and timestamps are excluded; amounts and accounts are not. */
const ledgerFingerprint = async (documentId: string): Promise<string> => {
  const rows = await db.admin<{ code: string; debit: string; credit: string; currency: string }[]>`
    select a.code, le.debit::text, le.credit::text, le.currency
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId} order by a.code, le.debit, le.credit`;
  return JSON.stringify(rows);
};

/** A tenant-scoped READ, for the two cases that call `zReport` directly rather than through the route.
 *  It is the 4-argument **test** `withTenant` of `packages/db/test/harness`, which is the one this
 *  workspace uses (hazard 15); root `tests/**` files use the production 3-argument one instead. */
const read = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  withTenant(db.rw, f.seed.tenant, f.seed.human, fn as never) as Promise<T>;
```

`bankingDocumentId`, `statementLineId`, `matchId` and `bankAccountId` are declared and filled by the `beforeAll` of the `describe` that uses them — Task 11's, as its `beforeAll` comment states. `shiftId`, `shiftBId` and `branchBTerminal` are the three module-level `let`s the three `describe`s share, because `pushCash` and `pushCashAt` default to the first two and take the third.

- [ ] **Step 8: Run and commit (PR 3 of 3 begins here; migration 0071 lands in Task 11).**

Run: `cd packages/db && bun run test -- sync/till-cash` → **11 passed.**
Run: `cd packages/db && bun run test -- sync seed/6d-pack` → green; the pack test's first case now expects three codes, so **update its `.sort()` expectation to `["1130", "5130", "5120"].sort()`** in this commit — it is Task 4's test and this task's edit, and leaving it red would be a broken build the owner's "yes" caused.
Run: `cd tests && bun run test -- pos-shift-reconciliation` → green and **unchanged**: test 21's day sends no cash events, so the fourth array is empty and every figure is identical. That is the additivity property, checked.

```bash
git add docs/adr/0064-till-cash-lifecycle-and-cash-in-transit.md \
        packages/db/src/sync/till-cash.ts packages/db/src/sync/apply.ts packages/db/src/sync/index.ts \
        packages/db/seed/my/document-types/TILL_PAID_OUT.json \
        packages/db/seed/my/chart-of-accounts/6d-till.json \
        packages/sync/src/messages.ts packages/sync/src/client.ts \
        packages/contracts/src/sync/messages.ts apps/api/src/routes/sync/tickets.ts \
        packages/db/test/sync/till-cash.test.ts packages/db/test/seed/6d-pack.test.ts
git commit -m "feat(db): OD-10 — TILL_PAID_OUT and the fourth sync message array [6D T9]

A cash event rides the sync batch because §4.14 fixes all three till-cash types'
approval.post at pos.sync.push and R8 keeps a human out of pos_terminal — a
back-office route could create the document and could not post it (ADR 0064).
Cash events run between the tickets and the closes: a paid-out funded by the
day's sales needs those sales posted, and the close must see the cash leave.
Only paid_out is limited, through 6C's branch_pos_policy row and never the
cashier snapshot. Every edit to packages/sync is additive.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: ⚠️ OD-10 — `TILL_SAFE_DROP`

**Gated on the same OD-10 decision as Task 9 and dropped with it.** No second gate: hazard 6 asks for one task per decision, and Task 9 Step 1 is the gate for all three. This task is separate from Task 9 only because it ships its own document type and its own seed file, and one migration or seed file per PR keeps a reviewer's diff readable.

**Files**
- Create: `packages/db/seed/my/document-types/TILL_SAFE_DROP.json`
- Modify: `packages/db/test/sync/till-cash.test.ts` (a second `describe`)

**Interfaces**
- Consumes: everything Task 9 produced — `applyCashEvent`, `verifyCashEvent`, `CASH_EVENT`'s `safe_drop` row, `buildTillDocument`; the `1130` chart row (Task 4, seeded **unconditionally**). **Produces no new TypeScript**: `CASH_EVENT` already routes `safe_drop` to `TILL_SAFE_DROP` with debit `1130` and credit `1110`, so this task's only code is a seed file and its tests. That is the design ADR 0064 chose — three types, one apply path — and this task is the proof that the third type needed no branch.

- [ ] **Step 1: Write the failing test — a second `describe` in `packages/db/test/sync/till-cash.test.ts`.**

```ts
describe("⚠️ OD-10 — TILL_SAFE_DROP (spec:1354, ADR 0064)", () => {
  /* beforeAll: the same staffFixture world; an open shift with opening_float "100.0000" and three cash
     sales of "200.0000" each, so there is a genuine surplus to drop. */

  it("a safe drop debits 1130 Cash in transit and credits 1110 Cash in till", async () => {
    const out = await pushCash({ kind: "safe_drop", amount: "500.0000", reference: "BAG-0007" });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    const legs = await legsOf(out.cashEventResults[0]!.ref);
    expect(legs).toEqual([
      { code: "1110", debit: "0.0000", credit: "500.0000" },
      { code: "1130", debit: "500.0000", credit: "0.0000" },
    ]);
  });

  it("the document is numbered TSD-<terminal code> and carries the bag number as its description", async () => {
    const out = await pushCash({ kind: "safe_drop", amount: "50.0000", reference: "BAG-0008" });
    const [d] = await db.admin<{ series: string; status: string; notes: string; code: string }[]>`
      select d.series, d.status::text, d.notes, t.code
        from app.document d join app.document_type t on t.id = d.document_type_id
       where d.client_ref = ${out.cashEventResults[0]!.ref}`;
    expect(d!.code).toBe("TILL_SAFE_DROP");
    // **Read the suffix off the fixture, never hard-code it.** Amendment A15: 6A's `resolveSeries`
    // suffixes every document carrying a `terminal_id` with the terminal's own code, `posFixture`
    // enrols `KL01` (6A Task 10 Step 6) and `StaffFixture.terminalA` IS that terminal (6C Task 9 Step 2). A literal
    // `"TSD-T1"` fails on a correct implementation, which is the failure mode Tasks 5, 7 and 8 each
    // warn about in the same words.
    expect(d!.series).toBe(`TSD-${f.terminalA.code}`);
    expect(d!.status).toBe("posted");
    expect(d!.notes).toContain("BAG-0008");
  });

  it("a safe drop is NOT limited by paid_out_allowed — it moves the company's own cash", async () => {
    // Branch B's policy is the closed defaults, `paid_out_allowed: false`. A safe drop still works there,
    // and that is deliberate (Task 9 Step 5's comment on `verifyCashEvent`): the shop's control interest
    // in a safe drop is in making it EASY, because it reduces the cash at risk in the drawer.
    const out = await pushCashAt(branchBTerminal, { kind: "safe_drop", amount: "9999.0000" });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
  });

  it("a safe drop still needs pos.shift.own — an unauthorised principal is ERR_RBAC_FORBIDDEN", async () => {
    const out = await pushCash({ kind: "safe_drop", amount: "10.0000", cashierPrincipalId: f.cashierB });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the drop reduces expected_cash and the close ties, with 1130 left holding the money", async () => {
    // 100 float + 600 sold − 500 dropped = 200 expected. The cashier counts 200 and is neither over nor
    // short, and 1130 carries 500 that no shift's arithmetic touches again — which is the correct
    // statement of a physical fact: the notes are in the safe.
    const out = await closeShiftFor(shiftId, "200.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string; doc: string | null }[]>`
      select expected_cash::text, over_short::text, over_short_document_id::text as doc
        from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("200.0000");
    expect(sh!.over_short).toBe("0.0000");
    expect(sh!.doc).toBeNull();

    const [transit] = await db.admin<{ balance: string }[]>`
      select (sum(le.debit) - sum(le.credit))::text as balance
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.company_id = ${f.seed.company} and a.code = '1130'`;
    expect(transit!.balance).toBe("500.0000");
  });

  it("the Z-report shows the drop in cashControl and not in the cash tender line", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 10 }));
    expect(z!.tenders.find((t) => t.method === "cash")!.amount).toBe("600.0000");   // the SALES
    const drop = z!.cashControl.find((c) => c.documentTypeCode === "TILL_SAFE_DROP")!;
    expect(drop.amount).toBe("-500.0000");         // the drawer LOST 500 to the safe
  });

  it("an unbanked drop leaves a 1130 balance an auditor can see, and no job clears it", async () => {
    // 1130 is cleared by 4B's bank MATCHING on a TILL_BANKING (Task 11), never by a second posting and
    // never by a scheduled job. A shop that drops into the safe and does not bank has money in the safe.
    const jobs = await db.admin<{ name: string }[]>`select name from pgboss.job where name like '%till%'`;
    expect(jobs).toEqual([]);
  });
});
```

- [ ] **Step 2: Write `packages/db/seed/my/document-types/TILL_SAFE_DROP.json`.**

```json
{
  "code": "TILL_SAFE_DROP",
  "nameEn": "Till Safe Drop",
  "nameAr": "إيداع في الخزنة",
  "module": "pos",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "TILL_SAFE_DROP",
    "direction": "internal",
    "requires": ["client_ref", "attributed_to"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "TSD", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "TILL_SAFE_DROP" },
    "approval": { "required": false, "approve": null, "post": "pos.sync.push" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`direction: "internal"` per §4.14's row — the cash does not leave the company, it moves between two of its own containers. Everything else is `TILL_PAID_OUT`'s shape.

- [ ] **Step 3: Run and commit.**

Run: `cd packages/db && bun run test -- sync/till-cash` → **18 passed** (Task 9's eleven plus these seven).
Run: `cd packages/db && bun run test -- document-types seed/6d-pack` → green; 1A's loader validates the new envelope and the pack test's document-type assertions grow by one code.

```bash
git add packages/db/seed/my/document-types/TILL_SAFE_DROP.json packages/db/test/sync/till-cash.test.ts
git commit -m "feat(seed): OD-10 — TILL_SAFE_DROP debits 1130 cash in transit [6D T10]

No new TypeScript: CASH_EVENT already routes safe_drop, which is the proof that
ADR 0064's one-apply-path design held for the third type. A safe drop is not
limited by paid_out_allowed — it moves the company's own cash between its own
containers and reduces what is at risk in the drawer. An unbanked drop leaves a
1130 balance no job clears, which is the correct statement of a physical fact.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: ⚠️ OD-10 — `TILL_BANKING`, migration 0071, and the `till_banking` `Reconcilable` source

**Gated on the same OD-10 decision (Task 9 Step 1) and dropped with it.** This task closes the loop: cash that left the drawer reaches the bank statement, and 4B's matching clears it. It re-runs **acceptance test 39's till-banking clause** — the one 4B's card names 6D for.

**Files**
- Create: `packages/db/migrations/0071_create_till_banking_link.sql`, `packages/db/migrations/0071.down.sql`, `packages/db/src/schema/till-banking-link.ts`, `packages/db/src/ar-ap/reconciliation-till.ts`, `packages/db/seed/my/document-types/TILL_BANKING.json`, `tests/invariants/pos-till-banking.test.ts`
- Modify: `packages/db/src/sync/till-cash.ts` (`afterCashEvent`'s body), `packages/db/src/index.ts`, `packages/db/test/sync/till-cash.test.ts` (a third `describe`)

**Interfaces**

- Consumes: `Reconcilable`, `ReconcilableSource`, `registerReconcilableSource`, `reconcilableSources`, `RECONCILABLE_DIRECTION`, `match`, `unmatch`, `reconciledBalance`, `importStatement` (§4.8.3, **4B**); `applyCashEvent` (Task 9); `resolveAccountByCode`, `buildTillDocument` (Task 5); `app.bank_match`, `app.bank_statement_line` (4B, migrations 0049–0050); `Money`, `currency` (§4.2.1); `lintSchema`, `AUDIT_EXEMPT`, `IMMUTABLE`, `up`, `down` (§4.1).
- Produces (amendment A16):

```ts
// packages/db/src/ar-ap/reconciliation-till.ts — ONE registration and no edit to 4B's file.
export const tillBankingSource: ReconcilableSource;   // kind: "till_banking"
registerReconcilableSource(tillBankingSource);        // module-level, so importing the barrel registers it
export const tillBankingLink: PgTable;                // the Drizzle mirror, from schema/till-banking-link.ts
```

- [ ] **Step 1: Write the failing test `tests/invariants/pos-till-banking.test.ts` — test 39's clause.**

**This file is in the `tests` workspace and shares nothing with `packages/db/test/sync/till-cash.test.ts`.** It defines its own `pushCash`, `legsOf` and `ledgerFingerprint` rather than importing them: that file has a top-level `beforeAll` starting its own stack, and *"a test file that imported another's helpers would inherit its fixture too"* (Task 6's note). Three short helpers duplicated across a workspace boundary is the cheaper of the two costs, and §4.17.1 assigns 6D no shared helper to put them in (hazard 9).

```ts
// tests/invariants/pos-till-banking.test.ts
/**
 * Acceptance test 39's till-banking clause (spec:2457). 4B owns test 39; its card names 6D for this
 * clause and 8C for the payroll-batch clause, "which is why the registry and not a type list is the seam".
 * This file proves the seam: 6D adds ONE `registerReconcilableSource` call and edits no file of 4B's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyBatch, importStatement, lintSchema, match, reconcilableSources, reconciledBalance,
  RECONCILABLE_DIRECTION, unmatch, withTenant,
} from "@dulja/db";
import { grantCodes, seedBranchPosPolicy, seedShift, seedTenantV2 } from "@dulja/db/test";
import { Money, currency } from "@dulja/domain";
import { buildTicket } from "./support/pos";
import { staffFixture, type StaffFixture } from "./support/staff";
import { ensureOpenPeriods } from "./support/post-inventory";
// `sharedApi` is 0B's memoised stack at `tests/support/api.ts` (§4.17.1) — `../support/api` from here,
// NOT `./support/api`, which is 6A's per-suite directory. **This file never calls `api.stop()`** (0b:39).
import { sharedApi, type StartedApi } from "../support/api";

let api: StartedApi;
let f: StaffFixture;
/** The production `withTenant(sql, ctx, fn)` — root `tests/**` uses that one, never the 4-argument test
 *  helper (hazard 15, §4.2.2). `ctx` is the TERMINAL as actor, because a cash event is a terminal act. */
let ctx: { tenantId: string; actorId: string; companyId: string };
let shiftId: string;
let bankAccountId: string;
let bankingDocumentId: string;
let statementLineId: string;
let matchId: string;

/**
 * Every read and write in this file runs as `f.seed.human`, not as the terminal.
 *
 * **Reconciliation is a back-office act, not a till act.** `matchedBy` / `unmatchedBy` are stamped from
 * the `ctx` handed to 4B's `match`/`unmatch`, so a terminal principal there would put a till in the audit
 * column of a bank match; and reading `reconciledBalance` as the terminal would be asserting the report
 * from a principal that can never open it in production. `ctx` (the terminal) is used for exactly one
 * thing — `applyBatch`, in `batchAs` — because a cash event *is* a till act (hazard 19). Task 7's own
 * `read` uses `f.seed.human` the same way.
 */
const human = (): typeof ctx => ({ ...ctx, actorId: f.seed.human });

const read = <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  withTenant(api.db.rw, human(), fn as never) as Promise<T>;

/** The same, handing the callback the ctx `match`/`unmatch` take as their second argument. */
const write = <T>(fn: (tx: never, c: typeof ctx) => Promise<T>): Promise<T> => {
  const h = human();
  return withTenant(api.db.rw, h, ((tx: never) => fn(tx, h)) as never) as Promise<T>;
};

/** One `applyBatch` as terminal A, with whatever arrays the caller names — the four-array shape of
 *  amendment A13. A local copy; `packages/db/test/sync/till-cash.test.ts`'s is that workspace's. */
const batchAs = (body: Record<string, unknown>) =>
  withTenant(api.db.rw, ctx, (tx) =>
    applyBatch(tx as never, ctx,
      { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
        principalId: f.terminalA.principalId },
      { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(),
        tickets: [], shifts: [], tillEvents: [], cashEvents: [], ...body }));

/** One `TillCashMsg` into the shift under test. `occurredAt` is explicit because `tillEffectiveDate`
 *  derives the document's `effective_date` — and therefore the `Reconcilable`'s `valueDate` — from it. */
const pushCash = (msg: {
  kind: "paid_out" | "safe_drop" | "banking"; amount: string; occurredAt: string;
  reference?: string | null; fromSafe?: boolean; clientRef?: string;
}) => batchAs({ cashEvents: [{
  clientRef: msg.clientRef ?? crypto.randomUUID(),
  shiftId,
  kind: msg.kind,
  amount: { amount: msg.amount, currency: "MYR" },
  cashierPrincipalId: f.cashierA,
  supervisorPrincipalId: null,
  occurredAt: msg.occurredAt,
  reference: msg.reference ?? null,
  fromSafe: msg.fromSafe ?? false,
}] });

/** The ledger legs of the document a cash event produced, `(code, debit, credit)` ordered by code. */
const legsOf = async (ref: string): Promise<{ code: string; debit: string; credit: string }[]> =>
  api.db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, le.debit::text, le.credit::text
      from app.ledger_entry le
      join app.document d on d.id = le.document_id
      join app.account  a on a.id = le.account_id
     where d.company_id = ${f.seed.company} and d.client_ref = ${ref}::uuid
     order by a.code`;

/** A comparable fingerprint of one document's ledger rows, so "matching altered no ledger entry"
 *  (SAH-041) is one assertion. Ids and timestamps are excluded; amounts and accounts are not. */
const ledgerFingerprint = async (documentId: string): Promise<string> => {
  const rows = await api.db.admin<{ code: string; debit: string; credit: string; currency: string }[]>`
    select a.code, le.debit::text, le.credit::text, le.currency
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId} order by a.code, le.debit, le.credit`;
  return JSON.stringify(rows);
};

describe("test 39 — a till banking is reconcilable, and matching never alters a ledger entry", () => {
  beforeAll(async () => {
    api = await sharedApi();
    f = await staffFixture(api, "tillbank");
    ctx = { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company };
    await ensureOpenPeriods(api.db, f.seed, 2026);
    await grantCodes(api.db, f.seed, {
      codes: ["pos.shift.own"], principalId: f.cashierA, roleCode: "t39-own", branchIds: [f.branchA],
    });
    await seedBranchPosPolicy(api.db, f.seed, {
      branchId: f.branchA, limits: { paidOutAllowed: true, maxPaidOutAmount: "100.0000" },
    });

    // The drawer: 100 float, then nine cash sales of 100 — 1000 in the till to bank.
    shiftId = await seedShift(api.db, f.seed, {
      terminalId: f.terminalA.terminalId, cashierPrincipalId: f.cashierA,
      openingFloat: "100.0000", branchId: f.branchA,
    });
    await batchAs({ tickets: Array.from({ length: 9 }, () =>
      buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "100.0000", tender: "cash",
                           cashierPrincipalId: f.cashierA })) });

    // The banking: 1000 straight out of the drawer (1110) into the bank (1100), on 2026-01-15.
    // `tillEffectiveDate` takes the company's local date of this instant, so the document's
    // `effective_date` — and the `Reconcilable`'s `valueDate` — is 2026-01-15.
    const banked = await pushCash({
      kind: "banking", amount: "1000.0000", fromSafe: false,
      occurredAt: "2026-01-15T04:00:00.000Z", reference: "DEP-4471",
    });
    expect(banked.cashEventResults[0]!.status).toBe("accepted");
    const [doc] = await api.db.admin<{ id: string }[]>`
      select id from app.document where client_ref = ${banked.cashEventResults[0]!.ref}::uuid`;
    bankingDocumentId = doc!.id;

    // 0C seeds `1100 Bank` in `0c-base.json`; this slice consumes it and re-seeds nothing (hazard 33).
    const [bank] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${f.seed.company} and code = '1100'`;
    bankAccountId = bank!.id;

    // 4B's importer, in 4B's own call shape (4b:5528): one line crediting the bank 1000.00 that day.
    const { statementId } = await write((tx, c) =>
      importStatement(tx, c, {
        companyId: f.seed.company, bankAccountId,
        csv: ["Date,Narrative,Ref,Amount", "2026-01-15,TILL DEPOSIT,DEP-4471,1000.00"].join("\n"),
        mapping: {
          statement: { statementDate: "2026-01-31", openingBalance: "0.0000",
                       closingBalance: "1000.0000" },
          columns: { valueDate: "Date", description: "Narrative", reference: "Ref", amount: "Amount" },
          dateFormat: "YYYY-MM-DD", hasHeader: true,
        },
      }));
    const [line] = await api.db.admin<{ id: string }[]>`
      select id from app.bank_statement_line where statement_id = ${statementId} order by line_no limit 1`;
    statementLineId = line!.id;
  }, 600_000);

  it("till_banking is a registered Reconcilable kind, and its direction is money IN", async () => {
    expect(reconcilableSources().map((s) => s.kind)).toContain("till_banking");
    expect(RECONCILABLE_DIRECTION.till_banking).toBe("in");
  });

  it("the banking appears in the unreconciled list for the bank account it credited", async () => {
    const { unreconciled } = await read((tx) => reconciledBalance(tx, { bankAccountId, asOf: "2026-12-31" }));
    const mine = unreconciled.find((r) => r.kind === "till_banking")!;
    expect(mine.documentId).toBe(bankingDocumentId);
    expect(mine.amount.toString()).toBe("1000.0000");
    expect(mine.bankAccountId).toBe(bankAccountId);
    expect(mine.valueDate).toBe("2026-01-15");
    // `TBK-<terminal code>`, read off the fixture: `posFixture` enrols `KL01` (6A Task 10 Step 6) and
    // `StaffFixture.terminalA` IS that terminal (6C Task 9 Step 2). Amendment A15 is why the suffix is there at all.
    expect(mine.reference).toContain(`TBK-${f.terminalA.code}`);
  });

  it("matching it clears the line, and the reconciled balance equals the bank account's ledger balance", async () => {
    // `matchId` is captured here and the next case unmatches it — `match` returns `{ matchId }` (4b:5451)
    // and there is no other way to learn the id, since `bank_match` rows are never listed by this file.
    ({ matchId } = await write((tx, ctx) => match(tx, ctx, {
      statementLineId, reconcilable: { kind: "till_banking", documentId: bankingDocumentId },
      amount: Money.of("1000.0000", currency("MYR")),
    })));
    const { statement, ledger, unreconciled } = await read((tx) =>
      reconciledBalance(tx, { bankAccountId, asOf: "2026-12-31" }));
    expect(statement.toString()).toBe(ledger.toString());     // the DoD sentence of test 39
    expect(unreconciled.find((r) => r.kind === "till_banking")).toBeUndefined();
  });

  it("matching and unmatching alter NO ledger entry (SAH-041, spec:2457)", async () => {
    const before = await ledgerFingerprint(bankingDocumentId);
    await write((tx, ctx) => unmatch(tx, ctx, { matchId, reason: "wrong line" }));
    ({ matchId } = await write((tx, ctx) => match(tx, ctx, {
      statementLineId, reconcilable: { kind: "till_banking", documentId: bankingDocumentId },
      amount: Money.of("1000.0000", currency("MYR")),
    })));
    expect(await ledgerFingerprint(bankingDocumentId)).toBe(before);
    // And the unmatched row is retained with `unmatched_at`, never deleted (§4.8.3, hazard 25).
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.bank_match
       where reconcilable_document_id = ${bankingDocumentId} and unmatched_at is not null`;
    expect(n!.n).toBe(1);
  });

  it("a banking from the SAFE credits 1130, and one from the drawer credits 1110 — both debit 1100", async () => {
    // First put 300 into the safe, so there is a 1130 balance to bank out of.
    const dropped = await pushCash({ kind: "safe_drop", amount: "300.0000",
                                     occurredAt: "2026-01-16T04:00:00.000Z", reference: "BAG-0001" });
    expect(dropped.cashEventResults[0]!.status).toBe("accepted");

    const fromSafe = await pushCash({ kind: "banking", amount: "300.0000", fromSafe: true,
                                      occurredAt: "2026-01-16T09:00:00.000Z" });
    expect(fromSafe.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(fromSafe.cashEventResults[0]!.ref)).toEqual([
      { code: "1100", debit: "300.0000", credit: "0.0000" },
      { code: "1130", debit: "0.0000", credit: "300.0000" },
    ]);
    // …and the drawer banking from `beforeAll` credited 1110 instead. Both debit 1100.
    expect(await legsOf((await api.db.admin<{ client_ref: string }[]>`
      select client_ref::text as client_ref from app.document where id = ${bankingDocumentId}`)[0]!.client_ref))
      .toEqual([
        { code: "1100", debit: "1000.0000", credit: "0.0000" },
        { code: "1110", debit: "0.0000", credit: "1000.0000" },
      ]);
    // The 1100 debit is what makes it visible to 4B's ledgerLegSource at all (amendment A14): that source
    // lists from the ledger leg on the STATEMENT'S OWN bank_account_id, so a banking with no 1100 leg
    // could never be matched and this test's third case could not hold.
  });

  it("the till_banking_link row carries the shift, which no ledger leg does (amendment A16)", async () => {
    const [link] = await api.db.admin<{
      shift_id: string; bank_account_id: string; from_safe: boolean; amount: string; value_date: string;
    }[]>`select shift_id::text, bank_account_id::text, from_safe, amount::text, value_date::text
           from app.till_banking_link where banking_document_id = ${bankingDocumentId}`;
    expect(link!.shift_id).toBe(shiftId);
    expect(link!.bank_account_id).toBe(bankAccountId);
    expect(link!.from_safe).toBe(false);
    expect(link!.amount).toBe("1000.0000");
  });

  it("a second tenant cannot see the link row (spec:106, test 12)", async () => {
    const other = await seedTenantV2(api.db, "Nosy");
    const rows = await withTenant(api.db.rw, { tenantId: other.tenant, actorId: other.human, companyId: other.company },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`);
    expect(rows[0]!.n).toBe(0);
  });

  it("a branch manager at B sees no branch-A banking link (Form A, test 36)", async () => {
    // The isolation is 0071's RESTRICTIVE `branch_isolation` policy, not a `where branch_id = …` a
    // handler remembered — which is what makes it hold "through any endpoint, filter or export"
    // (spec:2454). `f.cashierB` is a principal whose only branch assignment is B; granting it
    // `pos.report.read` scoped to B gives it every reason to see the row except the one that matters.
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"], principalId: f.cashierB, roleCode: "t39-read-b",
      branchIds: [f.branchB],
    });
    const rows = await withTenant(
      api.db.rw, { tenantId: f.seed.tenant, actorId: f.cashierB, companyId: f.seed.company },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`);
    expect(rows[0]!.n).toBe(0);

    // And the row IS there for a principal assigned to branch A — otherwise this case would pass on an
    // empty table and prove nothing, which is the failure mode a count-of-zero assertion invites.
    const mine = await withTenant(
      api.db.rw, { tenantId: f.seed.tenant, actorId: f.cashierA, companyId: f.seed.company },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`);
    expect(mine[0]!.n).toBeGreaterThan(0);
  });

  it("the shipped schema still has zero linter violations", async () => {
    expect(await lintSchema(api.db.admin)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write `packages/db/migrations/0071_create_till_banking_link.sql`.**

```sql
-- 0071_create_till_banking_link.sql  ⚠️ OD-10 ONLY
-- The one fact a TILL_BANKING document cannot carry: which SHIFT the banked cash came from.
-- `Reconcilable` (§4.8.3) needs a bank account and a value date per banking, and both are reachable from
-- the document's 1100 ledger leg — which is what 4B's ledgerLegSource reads. The shift is not: a ledger
-- entry has no shift, and `document.shift_id` is unkeyed (amendment A2). This table is that one join,
-- plus the `from_safe` flag the Z-report's banking line needs to say which container the notes left.
-- Contracts amendment A16 registers the row in §4.6.1 and §3.5.3 (no linter-set membership).

create table app.till_banking_link (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  branch_id            uuid not null,
  -- One link per banking document: the document IS the banking, and a second link would be a second
  -- statement about one event.
  banking_document_id  uuid not null,
  shift_id             uuid not null,
  bank_account_id      uuid not null,
  from_safe            boolean not null,
  value_date           date not null,
  amount               numeric(19,4) not null,
  currency             char(3) not null,
  reference            text,
  created_at           timestamptz not null default now(),
  -- A magnitude, never a signed figure: RECONCILABLE_DIRECTION.till_banking = 'in' carries the direction
  -- (4B's Task 7), and comparing two signed figures across the seam is how a match picks the wrong sign.
  constraint till_banking_link_amount_positive check (amount > 0),
  unique (banking_document_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)          references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)           references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, banking_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, shift_id)            references app.shift(tenant_id, id),
  foreign key (tenant_id, bank_account_id)     references app.account(tenant_id, id)
);

-- The Reconcilable source lists by (company, bank account, value-date range) and the Z-report by shift.
create index till_banking_link_bank_date_idx on app.till_banking_link (company_id, bank_account_id, value_date);
create index till_banking_link_shift_idx     on app.till_banking_link (shift_id);

call app_meta.enable_tenant_rls('app.till_banking_link');
call app_meta.attach_audit('app.till_banking_link');
-- Form A (§4.5.6): a NOT NULL branch key, attached in the table's own migration (§3.5.1 step 7).
create policy branch_isolation on app.till_banking_link as restrictive
  using (app.actor_in_branch(company_id, branch_id));

-- No `attach_stamp`: there is no `*_by` column. The banking's actor is `document.created_by` — the
-- terminal — and its human is `document.attributed_to`; duplicating either here would be a second
-- spelling of one fact (§3.3, and the same reasoning as `shift.opened_principal_id`).
-- No `forbid_change` trigger and no revoked grants: the row is never updated in practice, but a MATCH is
-- recorded on 4B's `bank_match` and not here, so there is nothing this row would have to defend against
-- that IMMUTABLE would catch and the audit trigger would not (amendment A16).
```

- [ ] **Step 3: Write `packages/db/migrations/0071.down.sql`.**

```sql
-- 0071.down.sql — one table, whose policies, triggers and indexes drop with it (§3.4.5).
drop table if exists app.till_banking_link;
```

- [ ] **Step 4: Write `TILL_BANKING.json` and the Drizzle mirror.**

```json
{
  "code": "TILL_BANKING",
  "nameEn": "Till Banking",
  "nameAr": "إيداع بنكي من الصندوق",
  "module": "pos",
  "policyVersion": 1,
  "effectiveFrom": "2026-01-01",
  "policy": {
    "version": 1,
    "documentType": "TILL_BANKING",
    "direction": "internal",
    "requires": ["client_ref", "attributed_to"],
    "lines": [
      { "for": "each_line", "side": "debit",  "account": { "from": "line.account" }, "amount": "line.debit",  "when": { "line.kind": "account" } },
      { "for": "each_line", "side": "credit", "account": { "from": "line.account" }, "amount": "line.credit", "when": { "line.kind": "account" } }
    ],
    "inventory": { "effect": "none" },
    "tax": { "applies": false },
    "numbering": { "series": "TBK", "assignAt": "issue" },
    "reversal": { "allowed": true, "producesType": "TILL_BANKING" },
    "approval": { "required": false, "approve": null, "post": "pos.sync.push" },
    "fxRoundingAccount": { "from": "company.fx_rounding_account_id" },
    "dimensions": { "required": ["BRANCH"] }
  }
}
```

`packages/db/src/schema/till-banking-link.ts` is the read mirror in Task 1's shape — `uuid`, `boolean`, `date`, `numeric(19,4)`, `char(3)` columns plus the two `index(…)` declarations — re-exported from `packages/db/src/index.ts`.

- [ ] **Step 5: Fill `afterCashEvent` — `packages/db/src/sync/till-cash.ts`.**

```ts
/**
 * Task 11 (⚠️ OD-10): a banking gets a `till_banking_link` row; the other two kinds get nothing, because
 * their document says everything there is to say. The bank account is resolved from `1100` by code — the
 * same account the policy's debit leg used, read once so the link and the ledger cannot disagree.
 */
async function afterCashEvent(
  sp: Sql, terminal: TerminalApplyContext, msg: TillCashInput, documentId: string,
): Promise<void> {
  if (msg.kind !== "banking") return;
  const bankAccountId = await resolveAccountByCode(sp, terminal.companyId, "1100");
  const [shift] = await sp<{ branch_id: string; currency: string }[]>`
    select branch_id::text, currency from app.shift where id = ${msg.shiftId}`;
  await sp`
    insert into app.till_banking_link (tenant_id, company_id, branch_id, banking_document_id, shift_id,
                                       bank_account_id, from_safe, value_date, amount, currency, reference)
    values (app.current_tenant(), ${terminal.companyId}, ${shift!.branch_id}, ${documentId}, ${msg.shiftId},
            ${bankAccountId}, ${msg.fromSafe === true},
            date(${msg.occurredAt}::timestamptz at time zone (select timezone from app.company where id = ${terminal.companyId})),
            ${msg.amount.amount}, ${shift!.currency}, ${msg.reference})
    on conflict (banking_document_id) do nothing`;
}
```

- [ ] **Step 6: Write `packages/db/src/ar-ap/reconciliation-till.ts` — one source, one registration.**

```ts
import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { registerReconcilableSource, type Reconcilable, type ReconcilableSource } from "./reconciliation";

/**
 * The `till_banking` source. **4B's `reconciliation.ts` is not edited** — its own Task 7 note says 6D
 * "adds one `registerReconcilableSource` call and edits no file of this slice", and its
 * `reconcilable_kind` CHECK already admits `till_banking` (§4.8.3).
 *
 * It lists from `app.till_banking_link` rather than from the ledger leg, which is the one place this
 * source differs from 4B's private `ledgerLegSource`. The reason is the link row's reason: a banking's
 * bank account and value date ARE on the ledger leg, but its **shift** is not, and a till-banking row in
 * an unreconciled list that could not say which drawer it came from would be unactionable at a shop —
 * "1,000 banked, from somewhere". `unmatchedOnly` uses the same `bank_match` subquery shape as 4B's
 * source, deliberately, so the two behave identically at the margins (a partially matched banking is
 * still listed).
 */
export const tillBankingSource: ReconcilableSource = {
  kind: "till_banking",
  async list(tx: Sql, input): Promise<Reconcilable[]> {
    const rows = await tx<{
      document_id: string; value_date: string; amount: string; currency: string; reference: string | null;
    }[]>`
      select l.banking_document_id::text as document_id, l.value_date::text, l.amount::text,
             l.currency,
             nullif(concat_ws(' ', concat_ws('-', d.series, d.number::text), l.reference), '') as reference
        from app.till_banking_link l
        join app.document d on d.id = l.banking_document_id
       where l.company_id      = ${input.companyId}
         and l.bank_account_id = ${input.bankAccountId}
         and l.value_date between ${input.from}::date and ${input.to}::date
         and d.status in ('posted', 'reversed')
         and (${input.unmatchedOnly} = false
              or l.amount > coalesce((select sum(bm.amount) from app.bank_match bm
                                       where bm.reconcilable_document_id = l.banking_document_id
                                         and bm.unmatched_at is null), 0))
       order by l.value_date, l.banking_document_id`;
    return rows.map((r) => ({
      kind: "till_banking" as const,
      documentId: r.document_id,
      bankAccountId: input.bankAccountId,
      valueDate: r.value_date,
      amount: Money.of(r.amount, currency(r.currency)),
      reference: r.reference,
    }));
  },
};

// Module-level, exactly as 4B registers its two. **The barrel must import this file** or the registration
// never runs — `packages/db/src/index.ts` gains `export * from "./ar-ap/reconciliation-till";` and Step 1's
// first case (`reconcilableSources()` contains `till_banking`) is what catches a missing re-export.
registerReconcilableSource(tillBankingSource);
```

- [ ] **Step 7: Add the banking `describe` to `packages/db/test/sync/till-cash.test.ts`.**

Five cases, appended below Task 10's block and sharing the file's `beforeAll`, its six helpers and the module-level `shiftId` / `branchBTerminal`.

```ts
describe("⚠️ OD-10 — TILL_BANKING and app.till_banking_link (spec:1354, ADR 0064, amendment A16)", () => {
  /**
   * Its own drawer, because Tasks 9 and 10 spent theirs: 200 float and four cash sales of 200 — 1000 in
   * the till. `bankAccountId` is `1100`, seeded by 0C in `0c-base.json` and consumed here, never
   * re-seeded (hazard 33).
   */
  let bankShiftId: string;
  let bankAccountId: string;
  beforeAll(async () => {
    bankShiftId = await seedShift(db, f.seed, {
      terminalId: f.terminalA.terminalId, cashierPrincipalId: f.cashierA,
      openingFloat: "200.0000", branchId: f.branchA,
    });
    await batchAs(f.terminalA, f.branchA, { tickets: Array.from({ length: 4 }, () =>
      buildTicket(f.pos, { sku: "SKU-A", shiftId: bankShiftId, unitPrice: "200.0000", tender: "cash",
                           cashierPrincipalId: f.cashierA })) });
    const [bank] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${f.seed.company} and code = '1100'`;
    bankAccountId = bank!.id;
  }, 300_000);

  it("a banking from the DRAWER debits 1100 and credits 1110", async () => {
    const out = await pushCash({ kind: "banking", amount: "600.0000", fromSafe: false,
                                 shiftId: bankShiftId, reference: "DEP-1" });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([
      { code: "1100", debit: "600.0000", credit: "0.0000" },
      { code: "1110", debit: "0.0000", credit: "600.0000" },
    ]);
  });

  it("a banking from the SAFE debits 1100 and credits 1130 — the fromSafe flag picks the credit", async () => {
    await pushCash({ kind: "safe_drop", amount: "200.0000", shiftId: bankShiftId, reference: "BAG-9" });
    const out = await pushCash({ kind: "banking", amount: "200.0000", fromSafe: true,
                                 shiftId: bankShiftId, reference: "DEP-2" });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([
      { code: "1100", debit: "200.0000", credit: "0.0000" },
      { code: "1130", debit: "0.0000", credit: "200.0000" },
    ]);
  });

  it("the link row carries the shift, the bank account, from_safe and the amount (amendment A16)", async () => {
    const out = await pushCash({ kind: "banking", amount: "50.0000", fromSafe: false,
                                 shiftId: bankShiftId, reference: "DEP-3" });
    const [link] = await db.admin<{
      shift_id: string; bank_account_id: string; from_safe: boolean; amount: string; branch_id: string;
    }[]>`select l.shift_id::text, l.bank_account_id::text, l.from_safe, l.amount::text, l.branch_id::text
           from app.till_banking_link l
           join app.document d on d.id = l.banking_document_id
          where d.client_ref = ${out.cashEventResults[0]!.ref}::uuid`;
    expect(link!.shift_id).toBe(bankShiftId);
    expect(link!.bank_account_id).toBe(bankAccountId);
    expect(link!.from_safe).toBe(false);
    expect(link!.amount).toBe("50.0000");
    expect(link!.branch_id).toBe(f.branchA);
  });

  it("re-sending a banking answers duplicate, and there is still exactly ONE link row", async () => {
    const clientRef = crypto.randomUUID();
    await pushCash({ kind: "banking", amount: "25.0000", shiftId: bankShiftId, clientRef });
    const second = await pushCash({ kind: "banking", amount: "25.0000", shiftId: bankShiftId, clientRef });
    expect(second.cashEventResults[0]!.status).toBe("duplicate");
    // `afterCashEvent` runs only on the accepted branch, so a duplicate cannot write a second link —
    // and `till_banking_link` carries no unique index on `banking_document_id` to catch it for us.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_banking_link l
        join app.document d on d.id = l.banking_document_id
       where d.client_ref = ${clientRef}::uuid`;
    expect(n!.n).toBe(1);
  });

  it("the Z-report shows every banking in cashControl as the drawer's loss, never as a tender", async () => {
    // The drawer, movement by movement — every figure comes from a case above, in file order:
    //   +200 opening float
    //   +800 four cash sales of 200            (this describe's own beforeAll)
    //   −600 banked from the drawer            (case 1)
    //   −200 dropped to the safe               (case 2; the 200 banked FROM the safe never touches 1110)
    //    −50 banked from the drawer            (case 3)
    //    −25 banked from the drawer            (case 4; the duplicate re-send posts nothing)
    //   ————
    //    125 expected, and the cashier counts exactly that.
    const out = await closeShiftFor(bankShiftId, "125.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId: bankShiftId, limit: 10 }));
    // The cash TENDER line is the sales alone: 4 × 200. Bankings and drops are cash CONTROL, which is the
    // categorisation the Self-Review's second push-back item is about.
    expect(z!.tenders.find((t) => t.method === "cash")!.amount).toBe("800.0000");
    const banking = z!.cashControl.find((c) => c.documentTypeCode === "TILL_BANKING")!;
    expect(banking.amount).toBe("-675.0000");       // 600 + 50 + 25 left the DRAWER; the 200 left the SAFE
    const drop = z!.cashControl.find((c) => c.documentTypeCode === "TILL_SAFE_DROP")!;
    expect(drop.amount).toBe("-200.0000");
    expect(z!.expectedCash).toBe("125.0000");
    expect(z!.overShort).toBe("0.0000");
  });
});
```

⚠️ **The counted figure in the last case is the sum of every movement the four cases above it made**, and Vitest runs `it`s in file order inside a `describe`. If you reorder or add a case, **re-derive `125.0000` from the comment's ladder** rather than adjusting the expectation to whatever the run printed — Task 8's stop-and-raise rule ("never change an expected figure") applies here too.

- [ ] **Step 8: Run everything, then commit (PR 3 of 3 — migration 0071).**

Run: `cd packages/db && bun run test -- sync/till-cash` → **23 passed.**
Run: `cd packages/db && bun run test -- schema-lint privileges`
Expected: green, and the up → down → up reversibility case covers 0071 (§3.4.6). `schema-lint`'s zero-violations case is the gate for the new table: a missing `branch_isolation` policy or a missing `audit_row` trigger reports there by table name. **`privileges.test.ts`'s pinned DELETE list is still unchanged** — this table's rows are never deleted.
Run: `cd tests && bun run test -- pos-till-banking` → **9 passed.**
Run: `cd tests && bun run test -- bank-reconciliation`
Expected: green and **unchanged**. 4B's own test 39 suite must not move: this task registered a third source and edited nothing of 4B's, and 4B's Task 7 Step 7 already proved the seam with a synthetic source. If 4B's suite fails, the registration replaced a kind rather than adding one — `registerReconcilableSource` is a `Map.set`, so registering `receipt` again would silently replace 4B's.

```bash
git add packages/db/migrations/0071_create_till_banking_link.sql packages/db/migrations/0071.down.sql \
        packages/db/src/schema/till-banking-link.ts packages/db/src/ar-ap/reconciliation-till.ts \
        packages/db/src/sync/till-cash.ts packages/db/src/index.ts \
        packages/db/seed/my/document-types/TILL_BANKING.json \
        packages/db/test/sync/till-cash.test.ts tests/invariants/pos-till-banking.test.ts
git commit -m "feat(db): OD-10 — migration 0071, TILL_BANKING and the till_banking Reconcilable [6D T11]

TILL_BANKING always debits 1100, which is what makes it visible to 4B's matching
at all; it credits 1130 when the deposit came from the safe and 1110 when it came
straight from the drawer (amendment A14). app.till_banking_link carries the one
fact no ledger leg does — the shift — so an unreconciled banking can say which
drawer it came from. 6D adds ONE registerReconcilableSource call and edits no file
of 4B's, which is the seam its card promised. Test 39's till-banking clause holds:
the reconciled balance equals the bank account's ledger balance, and matching
alters no ledger entry (SAH-041).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: ⚠️ OD-24 — the shift register and Z-report screens

**Owner decision OD-24 (§2.12): "Screenshots + operator description before any screen" — spec:79, 108, 2408. Default: the screen task is blocked, not the slice.** spec:79 and spec:108 state that the UI is not specified, and hazard 29 forbids inventing a workflow.

**Owner provides:** screenshots of the two legacy screens a branch manager uses for these jobs — the shift/till register and the Z-report print — and a **two-minute description per screen** of what the operator does, in order, including which keys they press and what they do with the printed Z-report afterwards.
**Verify:** run `ls -1 docs/owner/od-24/6d/` and confirm four files — `shifts.png`, `z-report.png` and one `.md` transcript each.
**Until provided:** Steps 2 onward do not run; the slice ships with the API and no screens, and Tasks 1–11 plus 13 are the deliverable an operator's own tooling can already drive. **Nothing in any other task depends on this one.**

**Steps 2–5 carry real code against a stated default layout**, on 3A's and 3D's terms and for their reason: hazard 29 blocks the *screen*, not the ability to write one, and if the owner's material shows a different workflow only the two `.tsx` files and their tests change — `shift-api.ts` does not.

**The stated default layout, so a reviewer can compare it to the owner's material.** 3A's two-pane list-and-detail with 0E Task 4's keyboard model unchanged (`/` filters, `↑`/`↓` move the selection, `Enter` opens, `Esc` returns to the list; there is no `Ctrl+S` and no `Ctrl+N` because **this screen writes nothing** — amendment A12), plus one addition this slice needs: **the over/short figure is the only coloured element on either screen**, red for short and green for over, because a manager scanning twenty drawers is looking for exactly one thing. The Z-report detail is a **print-first layout** — a single column at 80 mm that reads correctly on a receipt printer and in a browser — since the operator's job with a Z-report is to sign it and file it.

**Files**
- Create: `apps/backoffice/src/lib/shift-api.ts`, `apps/backoffice/src/routes/pos/shifts.tsx`, `apps/backoffice/src/routes/pos/z-report.tsx`, `apps/backoffice/test/pos-shifts.test.tsx`, `apps/backoffice/test/pos-z-report.test.tsx`, `tests/e2e/pos-z-report.spec.ts`
- Modify: `apps/backoffice/src/router.tsx` (two routes), `apps/backoffice/src/components/app-shell.tsx` (one nav entry), `packages/i18n/src/locales/en.json` and `ar.json`

**Interfaces**
- Consumes: `createAdminApi`, `AdminApi` (0E, `apps/backoffice/src/lib/admin-api.ts` — `get(path, schema)` / `send(method, path, body, schema)`, the schema always a parameter); `AppShell` and **`useShell()`**, which returns `{ locale, setLocale, t }` (0E, `apps/backoffice/src/components/app-shell.tsx`, 0e:2614); `DirectionProvider`, `DataGrid`, `Column`, `Button` (0E, `@dulja/ui`, 0e:1360); `formatMoney`, `formatDate`, `formatTimestamp`, `MoneyJson` (0E, `@dulja/i18n`, 0e:620); `createRoute`, `rootRoute`, `routeTree` (0E, `apps/backoffice/src/router.tsx`); `ShiftList`, `ShiftSchema`, `TillEventList`, `ZReportList`, `SalesByCashierList` (Task 7); `bootLocalStack`, `grantAdminRole` (0E, `tests/e2e/support/boot.ts`).
  ⚠️ **Use 0E's spellings, not 3A's.** 3A's screen task writes `useT()`, `DataTable` and `CommandBar`; 0E ships `useShell().t`, `DataGrid` and no command bar (0e:1360, 2614). §4.18 makes 0E the authority on its own files, so this task is written against 0E and **if the committed `packages/ui/src/index.ts` spells any of them differently, use its spelling** — never add a second component.
- Produces: `export interface ShiftApi { listShifts; readShift; listTillEvents; zReport; salesByCashier }`, `export function createShiftApi(api: AdminApi, companyId: string): ShiftApi` and `export function useShiftApi(): ShiftApi` (the two-line context, in the same file — 3A puts its twin in a separate `*-api-context.ts`; one file is fewer names and this slice has two screens, not three); `ShiftsRoute`, `ZReportRoute`; two `createRoute` entries at `/pos/shifts` and `/pos/shifts/$shiftId/z-report`.

- [ ] **Step 1: The gate — confirm the owner's material is attached, or stop.**

Run: `ls -1 docs/owner/od-24/6d/`
Expected: the four files above. **If the directory is missing or incomplete: stop here.** Record "OD-24 unanswered for 6D; screens deferred" in this task, leave Steps 2–5 unchecked, and ship the slice. Do not substitute a guess.

- [ ] **Step 2: Write `apps/backoffice/src/lib/shift-api.ts`** — the typed fetch layer both screens share, in 3A's shape: one method per endpoint, every path built here so a typo is a compile error rather than a runtime 404, every Zod schema passed to 0E's `AdminApi` as a parameter.

```ts
export function createShiftApi(api: AdminApi, companyId: string): ShiftApi {
  const base = `/v1/companies/${companyId}`;
  return {
    listShifts: (q) => api.get(`${base}/shifts${query(q)}`, ShiftList),
    readShift: (shiftId) => api.get(`${base}/shifts/${shiftId}`, ShiftSchema),
    listTillEvents: (shiftId, q) => api.get(`${base}/shifts/${shiftId}/till-events${query(q)}`, TillEventList),
    zReport: (q) => api.get(`${base}/reports/pos.z_report${query(q)}`, ZReportList),
    salesByCashier: (q) => api.get(`${base}/reports/pos.sales_by_cashier${query(q)}`, SalesByCashierList),
  };
}
```

`query(q)` is 3A's own serialiser for the literal `filter[…]` keys and `ListQuery`'s four (§4.2.8 Layer 2), copied into this file — 3A calls it `qs` and it is nine lines; §4.17.1 assigns 6D no shared helper and `apps/backoffice` has no `lib/query.ts` to put one in (hazard 9 cuts against inventing one here). **Every method is a `get`** — `AdminApi.send` sets `Idempotency-Key` for unsafe methods (0E Task 5) and none is reachable from this file, which is amendment A12 expressed as an API surface rather than as a comment.

The same file carries the context both screens read it through — two lines, 3A's shape:

```ts
// apps/backoffice/src/lib/shift-api.ts — the bottom of the file.
const ShiftApiContext = createContext<ShiftApi | null>(null);
export const ShiftApiProvider = ShiftApiContext.Provider;
export function useShiftApi(): ShiftApi {
  const value = useContext(ShiftApiContext);
  if (value === null) throw new Error("useShiftApi must be used inside <ShiftApiProvider>");
  return value;
}
```

`AppShell` wraps its children once with `<ShiftApiProvider value={createShiftApi(api, session.companyId)}>`, exactly as 3A wraps `useInventoryApi` (3a:8690).

- [ ] **Step 3: Write `apps/backoffice/src/routes/pos/shifts.tsx` — the register.**

A filter row over one `DataGrid`: branch and date range at the top, one row per shift showing terminal code, opened/closed timestamps, the cashier principal, `countedCash` and `overShort`. **The over/short is the only coloured cell on either screen.** `Enter` on a row opens its Z-report (0E's `DataGrid` `onActivate`, its own roving-tabindex model unchanged); `/` focuses the filter. **Nothing on this screen writes** — amendment A12 — so there is no `Ctrl+S` and no `Ctrl+N`.

```tsx
// apps/backoffice/src/routes/pos/shifts.tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DataGrid, type Column } from "@dulja/ui";
import { formatMoney, formatTimestamp, type MoneyJson } from "@dulja/i18n";
import { useShell } from "../../components/app-shell";
import { useShiftApi } from "../../lib/shift-api";
import type { z } from "zod";
import type { ShiftSchema } from "@dulja/contracts/pos/shift";

type Shift = z.infer<typeof ShiftSchema>;

/**
 * The shift register. Read-only by construction: `ShiftApi` exposes no `send`, so there is no code path
 * from this component to an unsafe method (amendment A12 — a shift is closed over `/v1/sync/tickets`,
 * because only a terminal can post a `TILL_OVER_SHORT`).
 *
 * **No money arithmetic and no hand-rolled formatting** (spec:2041): every amount arrives as the wire
 * `{ amount, currency }` pair and goes straight to `@dulja/i18n`'s `formatMoney`, which formats the
 * decimal STRING through `Intl` and never touches `Number`.
 */
export function ShiftsRoute(): JSX.Element {
  const { t, locale } = useShell();
  const api = useShiftApi();
  const navigate = useNavigate();
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filter = useRef<HTMLInputElement>(null);

  // "/" focuses the filter — 0E Task 4's keyboard model, applied unchanged. It is deliberately NOT
  // captured while a text input already has focus, or a cashier could never type a "/" in a date.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || target?.tagName === "INPUT") return;
      e.preventDefault();
      filter.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shifts = useQuery({
    queryKey: ["shifts", branchId, from, to],
    queryFn: () => api.listShifts({
      limit: 100,
      ...(branchId === "" ? {} : { branchId }),
      ...(from === "" ? {} : { from }),
      ...(to === "" ? {} : { to }),
    }),
  });

  const money = (m: MoneyJson | null): string => (m === null ? "—" : formatMoney(m, { locale }));

  const columns: readonly Column<Shift>[] = [
    { key: "terminalCode", header: t("pos.shifts.terminal"), cell: (r) => r.terminalCode },
    { key: "openedAt", header: t("pos.shifts.openedAt"),
      cell: (r) => formatTimestamp(r.openedAt, { locale }) },
    { key: "closedAt", header: t("pos.shifts.closedAt"),
      // An OPEN shift shows an em dash, never a zero: "not counted yet" and "counted at nothing" are
      // different facts and a manager scanning the register must be able to tell them apart.
      cell: (r) => (r.closedAt === null ? "—" : formatTimestamp(r.closedAt, { locale })) },
    { key: "cashier", header: t("pos.shifts.cashier"), cell: (r) => r.openedPrincipalId },
    { key: "countedCash", header: t("pos.shifts.countedCash"), align: "end",
      cell: (r) => money(r.countedCash) },
    { key: "overShort", header: t("pos.shifts.overShort"), align: "end",
      cell: (r) => (
        // THE one coloured element on either screen. A manager scanning twenty drawers is looking for
        // exactly one thing, so nothing else competes with it. `data-tone` (not a colour class) is what
        // the component test asserts, so the palette can change without breaking the test.
        <span data-tone={r.overShort === null ? "none" : r.overShort.amount.startsWith("-") ? "short" : "over"}
              className={r.overShort === null ? "" : r.overShort.amount.startsWith("-")
                ? "text-danger" : "text-success"}>
          {money(r.overShort)}
        </span>
      ) },
  ];

  return (
    <section aria-label={t("pos.shifts.title")}>
      <div className="flex gap-4 pb-4">
        <label className="flex flex-col text-start">
          {t("pos.shifts.filterBranch")}
          <input ref={filter} value={branchId} onChange={(e) => setBranchId(e.target.value)}
                 aria-label={t("pos.shifts.filterBranch")} />
        </label>
        <label className="flex flex-col text-start">
          {t("pos.shifts.filterFrom")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 aria-label={t("pos.shifts.filterFrom")} />
        </label>
        <label className="flex flex-col text-start">
          {t("pos.shifts.filterTo")}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 aria-label={t("pos.shifts.filterTo")} />
        </label>
      </div>
      <DataGrid
        caption={t("pos.shifts.title")}
        emptyLabel={t("pos.shifts.empty")}
        columns={columns}
        rows={shifts.data?.items ?? []}
        rowKey={(r) => r.shiftId}
        onActivate={(r) => void navigate({ to: "/pos/shifts/$shiftId/z-report",
                                           params: { shiftId: r.shiftId } })}
      />
    </section>
  );
}
```

- [ ] **Step 4: Write `apps/backoffice/src/routes/pos/z-report.tsx` — the print-first detail.**

One column at 80 mm that reads correctly on a receipt printer and in a browser, because the operator's job with a Z-report is to sign it and file it. **The over/short line names its document number** when there is one, so a signed paper Z-report can be traced back to a ledger entry.

```tsx
// apps/backoffice/src/routes/pos/z-report.tsx
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Button, DataGrid, type Column } from "@dulja/ui";
import { formatMoney, formatTimestamp, type MoneyJson } from "@dulja/i18n";
import { useShell } from "../../components/app-shell";
import { useShiftApi } from "../../lib/shift-api";
import type { z } from "zod";
import type { ZReportSchema } from "@dulja/contracts/pos/reports";

type ZReportDto = z.infer<typeof ZReportSchema>;

/**
 * The Z-report, print-first. `@media print` drops the shell so the page is the report; the layout is a
 * single 80 mm column so a receipt printer and a browser render the same document.
 *
 * The `cashControl` table is EMPTY when OD-10 = no and the count was exact — and it renders as an empty
 * table with its caption rather than disappearing, because a section that vanishes reads as a bug on
 * paper while an empty one reads as "nothing moved".
 */
export function ZReportRoute(): JSX.Element {
  const { t, locale } = useShell();
  const api = useShiftApi();
  const { shiftId } = useParams({ from: "/pos/shifts/$shiftId/z-report" });
  const report = useQuery({
    queryKey: ["z-report", shiftId],
    queryFn: async () => (await api.zReport({ shiftId, limit: 1 })).items[0] ?? null,
  });

  const money = (m: MoneyJson | null): string => (m === null ? "—" : formatMoney(m, { locale }));
  const z: ZReportDto | null | undefined = report.data;
  if (z === undefined) return <p>{t("common.loading")}</p>;
  if (z === null) return <p>{t("pos.zReport.notFound")}</p>;

  const tenderColumns: readonly Column<ZReportDto["tenders"][number]>[] = [
    { key: "method", header: t("pos.zReport.method"), cell: (r) => t(`pos.tender.${r.method}`) },
    { key: "accountCode", header: t("pos.zReport.account"), cell: (r) => r.accountCode },
    { key: "amount", header: t("pos.zReport.amount"), align: "end", cell: (r) => money(r.amount) },
  ];
  const controlColumns: readonly Column<ZReportDto["cashControl"][number]>[] = [
    { key: "documentTypeCode", header: t("pos.zReport.documentType"),
      cell: (r) => t(`documentType.${r.documentTypeCode}`) },
    { key: "amount", header: t("pos.zReport.amount"), align: "end", cell: (r) => money(r.amount) },
  ];

  return (
    <article aria-label={t("pos.zReport.title")} className="mx-auto w-[80mm] print:w-full">
      {/* The one physical-property-free print rule this screen needs. 0E's Tailwind preset admits only
          logical properties, so the print block is written as a plain <style> with `display` and
          `visibility` — neither of which has a direction. */}
      <style>{`@media print { header, nav, [data-print="hide"] { display: none !important; } }`}</style>

      <header>
        <h1>{t("pos.zReport.title")}</h1>
        <dl>
          <dt>{t("pos.shifts.terminal")}</dt><dd>{z.terminalCode}</dd>
          <dt>{t("pos.shifts.openedAt")}</dt><dd>{formatTimestamp(z.openedAt, { locale })}</dd>
          <dt>{t("pos.shifts.closedAt")}</dt>
          <dd>{z.closedAt === null ? "—" : formatTimestamp(z.closedAt, { locale })}</dd>
          <dt>{t("pos.shifts.cashier")}</dt><dd>{z.openedPrincipalId}</dd>
        </dl>
      </header>

      <DataGrid caption={t("pos.zReport.tenders")} emptyLabel={t("pos.zReport.noTenders")}
                columns={tenderColumns} rows={z.tenders} rowKey={(r) => r.method} />

      <DataGrid caption={t("pos.zReport.cashControl")} emptyLabel={t("pos.zReport.noCashControl")}
                columns={controlColumns} rows={z.cashControl} rowKey={(r) => r.documentTypeCode} />

      <dl aria-label={t("pos.zReport.drawer")}>
        <dt>{t("pos.zReport.openingFloat")}</dt><dd>{money(z.openingFloat)}</dd>
        <dt>{t("pos.zReport.expectedCash")}</dt><dd>{money(z.expectedCash)}</dd>
        <dt>{t("pos.zReport.countedCash")}</dt><dd>{money(z.countedCash)}</dd>
        <dt>{t("pos.shifts.overShort")}</dt>
        <dd>
          <span data-tone={z.overShort === null ? "none" : z.overShort.amount.startsWith("-")
                  ? "short" : "over"}
                className={z.overShort === null ? "" : z.overShort.amount.startsWith("-")
                  ? "text-danger" : "text-success"}>
            {money(z.overShort)}
          </span>
          {/* The traceability line: a signed paper Z-report names the document a reader can look up. */}
          {z.overShortDocumentId !== null && (
            <span> · {t("pos.zReport.document")} {z.overShortDocumentId}</span>
          )}
        </dd>
      </dl>

      <ul aria-label={t("pos.zReport.tillEvents")}>
        {z.tillEvents.map((e) => (
          <li key={e.kind}>{t(`pos.tillEvent.${e.kind}`)}: {e.count}</li>
        ))}
      </ul>

      <Button data-print="hide" onClick={() => window.print()}>{t("pos.zReport.print")}</Button>
    </article>
  );
}
```

Register both routes in `apps/backoffice/src/router.tsx`, beside 0E's and 3A's:

```tsx
export const shiftsRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/pos/shifts", component: ShiftsRoute,
});
export const zReportRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/pos/shifts/$shiftId/z-report", component: ZReportRoute,
});
```

…add both to `routeTree.addChildren([…])`, add one `/pos/shifts` entry to `app-shell.tsx`'s nav, and add **every** `pos.shifts.*`, `pos.zReport.*`, `pos.tender.*`, `pos.tillEvent.*` and `documentType.TILL_*` key this task uses to **both** `packages/i18n/src/locales/en.json` and `ar.json`. 0E ships a catalogue-completeness checker; a key in one file and not the other fails it, which is the point.

- [ ] **Step 5: Write the three test files.**

```tsx
// apps/backoffice/test/pos-shifts.test.tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ShiftsRoute } from "../src/routes/pos/shifts";
import { ShiftApiProvider, type ShiftApi } from "../src/lib/shift-api";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const shift = (over: { amount: string; currency: string } | null, closed: string | null) => ({
  shiftId: "01930000-0000-7000-8000-000000000001",
  branchId: "b", terminalId: "t", terminalCode: "KL01",
  openedAt: "2026-01-15T01:00:00.000Z", closedAt: closed,
  openedPrincipalId: "p", closedPrincipalId: closed === null ? null : "p",
  currency: "MYR",
  openingFloat: { amount: "200.0000", currency: "MYR" },
  countedCash: closed === null ? null : { amount: "386.0000", currency: "MYR" },
  expectedCash: closed === null ? null : { amount: "387.5000", currency: "MYR" },
  overShort: over, overShortDocumentId: null,
});

const stub = (items: unknown[]): ShiftApi => ({
  listShifts: async () => ({ items, next_cursor: null }),
  readShift: async () => items[0],
  listTillEvents: async () => ({ items: [], next_cursor: null }),
  zReport: async () => ({ items: [], next_cursor: null }),
  salesByCashier: async () => ({ items: [], next_cursor: null }),
} as unknown as ShiftApi);

const renderWith = (items: unknown[]) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShiftApiProvider value={stub(items)}><ShiftsRoute /></ShiftApiProvider>
  </QueryClientProvider>,
);

describe("the shift register", () => {
  it("a SHORT drawer renders with the short tone and an OVER one with the over tone", async () => {
    renderWith([
      shift({ amount: "-1.5000", currency: "MYR" }, "2026-01-15T10:00:00.000Z"),
      shift({ amount: "2.0000", currency: "MYR" }, "2026-01-15T18:00:00.000Z"),
    ]);
    const tones = (await screen.findAllByText(/1\.5|2\.0/)).map((el) => el.getAttribute("data-tone"));
    expect(tones).toEqual(["short", "over"]);
  });

  it("an OPEN shift renders an em dash for the three close figures, never a zero", async () => {
    renderWith([shift(null, null)]);
    // Three dashes: closedAt, countedCash and overShort. A zero here would read as "counted at nothing".
    expect(await screen.findAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0.00")).toBeNull();
  });

  it("renders no physical-property class in either direction (0E's preset, test 23's half)", () => {
    const { container } = renderWith([shift({ amount: "-1.5000", currency: "MYR" }, "2026-01-15T10:00:00.000Z")]);
    const classes = [...container.querySelectorAll("[class]")].map((e) => e.getAttribute("class")).join(" ");
    for (const physical of ["ml-", "mr-", "pl-", "pr-", "left-", "right-"]) {
      expect(classes).not.toContain(physical);
    }
  });
});
```

```tsx
// apps/backoffice/test/pos-z-report.test.tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ZReportRoute } from "../src/routes/pos/z-report";
import { ShiftApiProvider, type ShiftApi } from "../src/lib/shift-api";

vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ shiftId: "s1" }) }));

const report = {
  shiftId: "s1", branchId: "b", terminalId: "t", terminalCode: "KL01",
  openedAt: "2026-01-15T01:00:00.000Z", closedAt: "2026-01-15T13:00:00.000Z",
  openedPrincipalId: "p", closedPrincipalId: "p", currency: "MYR",
  openingFloat: { amount: "200.0000", currency: "MYR" },
  countedCash: { amount: "386.0000", currency: "MYR" },
  expectedCash: { amount: "387.5000", currency: "MYR" },
  overShort: { amount: "-1.5000", currency: "MYR" },
  overShortDocumentId: "01930000-0000-7000-8000-0000000000aa",
  ticketCount: 8, returnCount: 1,
  tenders: [{ method: "cash", accountCode: "1110", amount: { amount: "187.5000", currency: "MYR" } }],
  cashControl: [],
  tillEvents: [{ kind: "no_sale", count: 1 }],
};

const stub = { zReport: async () => ({ items: [report], next_cursor: null }) } as unknown as ShiftApi;

const renderReport = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShiftApiProvider value={stub}><ZReportRoute /></ShiftApiProvider>
  </QueryClientProvider>,
);

describe("the Z-report screen", () => {
  it("names the TILL_OVER_SHORT document, so a signed paper report is traceable", async () => {
    renderReport();
    expect(await screen.findByText(/01930000-0000-7000-8000-0000000000aa/)).toBeInTheDocument();
  });

  it("renders the cash-control section EMPTY rather than absent when nothing moved", async () => {
    renderReport();
    // `cashControl: []` — the caption is present and the empty label is shown. A vanished section reads
    // as a bug on paper; an empty one reads as "nothing moved".
    expect(await screen.findByText(/cashControl|Cash control/i)).toBeInTheDocument();
  });

  it("the over/short is the only toned element on the page", async () => {
    const { container } = renderReport();
    await screen.findByText(/1\.5/);
    const toned = [...container.querySelectorAll("[data-tone]")]
      .filter((e) => e.getAttribute("data-tone") !== "none");
    expect(toned).toHaveLength(1);
    expect(toned[0]!.getAttribute("data-tone")).toBe("short");
  });
});
```

```ts
// tests/e2e/pos-z-report.spec.ts — acceptance test 23 re-run on a print-first layout (spec:2377, 2441).
import { expect, test } from "@playwright/test";
import { bootLocalStack, grantAdminRole } from "./support/boot";

for (const dir of ["ltr", "rtl"] as const) {
  test(`the shift register and Z-report are keyboard-complete in ${dir} (test 23)`, async ({ page }) => {
    const stack = await bootLocalStack();
    await grantAdminRole(stack.api, stack.seed);
    await page.goto(`${stack.baseUrl}/pos/shifts?lang=${dir === "rtl" ? "ar" : "en"}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);

    // Reach the Z-report with the keyboard alone — no click anywhere in this test (spec:2254).
    await page.keyboard.press("Tab");           // into the DataGrid's single tab stop
    await page.keyboard.press("Enter");         // onActivate → the Z-report route
    await expect(page).toHaveURL(/\/pos\/shifts\/.+\/z-report/);

    // The numeric column stays on the reader's END side in BOTH directions — that is what
    // `align: "end"` plus a logical-property preset buys, and it is test 23's "column order" clause.
    const amount = page.getByRole("cell", { name: /\d/ }).first();
    await expect(amount).toHaveCSS("text-align", dir === "rtl" ? "right" : "left");

    // And the print layout survives the flip: printing hides the shell, not the report.
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("header").first()).toBeHidden();
    await expect(page.getByRole("article")).toBeVisible();
    await stack.stop();
  });
}
```

⚠️ **`text-align: end` resolves to `right` in RTL and `left` in LTR only if `align: "end"` reaches the cell as a logical property.** If the assertion above reads the other way round, 0E's `DataGrid` is emitting a physical `text-right`; that is a 0E defect and the fix belongs there — **raise it, do not add a physical class here**, which `logical-properties.test.ts` would fail anyway.

- [ ] **Step 6: Run and commit.**

Run: `cd apps/backoffice && bun run test -- pos` → **6 passed** (three register cases, three Z-report cases).
Run: `cd tests && bun run test:e2e -- pos-z-report` → green in both directions (skipped when `STAGING_BASE_URL` is unset, per §3.7.1).
Run: `cd packages/i18n && bun run test` → green; 0E's catalogue-completeness checker fails on any key added to `en.json` and not to `ar.json`.
Run: `bun run lint && bun run typecheck` → green; 0E's `no-physical-property` rule scans `apps/backoffice/src/` (0e:1212) and the two `.tsx` files use logical utilities only.

```bash
git add apps/backoffice/src/lib/shift-api.ts apps/backoffice/src/routes/pos/shifts.tsx \
        apps/backoffice/src/routes/pos/z-report.tsx apps/backoffice/src/router.tsx \
        apps/backoffice/src/components/app-shell.tsx \
        apps/backoffice/test/pos-shifts.test.tsx apps/backoffice/test/pos-z-report.test.tsx \
        tests/e2e/pos-z-report.spec.ts packages/i18n/src/locales/en.json packages/i18n/src/locales/ar.json
git commit -m "feat(backoffice): the shift register and the Z-report print screen [6D T12]

Built against the owner's OD-24 material. Both screens are read-only: a shift is
closed only over /v1/sync/tickets, because only a terminal can post a
TILL_OVER_SHORT (amendment A12). The over/short is the only coloured element,
because a manager scanning twenty drawers is looking for one thing. Test 23
re-runs on the print-first layout in both text directions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Phase 6 exit — the regression appends, the re-run matrix, `AGENTS.md`, and the phase report

**The last task of the slice that closes Phase 6** (§3.8 names 0E, 1B, 2C, 3D, 4B, 5B, **6D**, 7C, 8D and 9B as the slices that rewrite the "Current phase" section — `AGENTS.md`'s from 4B on, `CLAUDE.md`'s before ADR 0088 retired it). It ships no new behaviour: it appends the two regression blocks the card assigns, re-runs every test the slice inherits, and re-asserts the pinned lists a later reader will otherwise take on trust.

**Files**
- Modify: `tests/regression/sah-031.test.ts`, `tests/regression/sah-041.test.ts` (one appended `describe` each), `AGENTS.md`
- Create: `packages/db/test/phase-6d-pins.test.ts`, `tests/invariants/phase-6d-pins.test.ts`

**The pins are TWO files, and the split is the dependency rule, not taste.** §3.1 pins `packages/db` to `@dulja/domain`, and `scripts/lint/rules/dependency-rule.ts` runs over every import under `packages/**` — test files included, which is why `no-bare-db` has to name `packages/db/test/**` on an allow-list at all (§3.7.5). Three of the eight pinned claims read tiers `packages/db` may not name: `JOBS` and `ReportCodeSchema` live in `@dulja/contracts`, and the route/probe bijection needs `apps/api`'s routes **and** `tests/invariants/probes.ts` — and §4.17.1's one named allowance runs the *other* way (`apps/*/test/**` → `tests/invariants/support/**`), so not even an `apps/api` test has an allowance for `probes.ts`. Those three move to **`tests/invariants/phase-6d-pins.test.ts`**, where §3.1's tier table already lets the `tests` workspace import any package and reach `@dulja/api` through its exported `./routes` entry point. The five that read the *database* and the *repository tree* stay in `packages/db`. 3B hit the same wall and answered it the same way — read `app.permission` instead of importing `PERMISSIONS` (3b:3435, citing 1a:5105) — and Step 3's permission case does exactly that.

**Interfaces**
- Consumes, in `packages/db/test/phase-6d-pins.test.ts`: `listApplied`, `startDb`, `Db` (§4.1) — and **nothing else**. The permission catalogue is read as rows of `app.permission`; every other claim is a file read through the locally computed `repoFile`. **`repoFile` and `REPO_ROOT` are computed locally** rather than imported: 0B/0C put both in `tests/support/**`, `packages/db` may not import that tier (§3.1), and §4.17.1 assigns 6D no helper of its own (hazard 9).
- Consumes, in `tests/invariants/phase-6d-pins.test.ts`: `JOBS` (§4.2.6); `ReportCodeSchema` (1B); `buildRoutes`, `StubAuthAdmin` (§4.2.7, through `@dulja/api`'s `./routes` entry point — never a route file, §3.1); `PROBES` (`./probes`, a sibling in the same workspace); `REPO_ROOT` from `../support/source` (0B).
- Consumes, in the two `tests/regression/**` appends: `sharedApi`, `repoFile` (0B — they live in that workspace); `reconcilableSources` (4B); `lintSchema` (§4.1); `staffFixture`, `buildTicket` (6C/6A); `applyBatch`, `withTenant`, `grantCodes`.
- Produces: nothing importable.

- [ ] **Step 1: Append the `sah-031` block — `tests/regression/sah-031.test.ts`.**

**SAH-031** (spec:490) is *"a direct `UPDATE "VouItems"` on a signed, locked, closed-period voucher silently rewriting `AccTotals` to match"*. 0B created the file (§3.7.3's Plan 0A-proven list); 4B appended a locked-period clause; 6D appends its own and **edits no earlier block**.

```ts
// tests/regression/sah-031.test.ts — APPENDED. 0B's file header already imports `sharedApi`, `repoFile`
// and vitest's globals for its own blocks; this block adds the three below to that header and touches
// nothing above it. `sharedApi()` is 0B's memoised stack and is NOT stopped by this file (0b:39).
import { applyBatch, withTenant } from "@dulja/db";
import { grantCodes } from "@dulja/db/test";
import { buildTicket } from "../invariants/support/pos";
import { staffFixture, type StaffFixture } from "../invariants/support/staff";

describe("SAH-031 Direct table writes bypass every control — 6D", () => {
  let f: StaffFixture;
  let ctx: { tenantId: string; actorId: string; companyId: string };
  let shiftId: string;      // closed, with a posted TILL_OVER_SHORT
  let openShiftId: string;  // still open, for the atomicity case
  let eventId: string;      // a till_event of the closed shift

  beforeAll(async () => {
    const api = await sharedApi();
    f = await staffFixture(api, "sah031-6d");
    ctx = { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, companyId: f.seed.company };
    await grantCodes(api.db, f.seed, { codes: ["pos.shift.own"], principalId: f.cashierA,
                                       roleCode: "s031-own", branchIds: [f.branchA] });

    const batch = (body: Record<string, unknown>) =>
      withTenant(api.db.rw, ctx, (tx) => applyBatch(tx, ctx,
        { terminalId: f.terminalA.terminalId, companyId: f.seed.company, branchId: f.branchA,
          principalId: f.terminalA.principalId },
        { terminalId: f.terminalA.terminalId, batchId: crypto.randomUUID(),
          tickets: [], shifts: [], tillEvents: [], ...body }));

    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await batch({ tickets: [buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "40.0000",
                                                 tender: "cash" })] });
    const ev = await batch({ tillEvents: [{
      clientRef: crypto.randomUUID(), shiftId, kind: "no_sale", ticketClientRef: null,
      cashierPrincipalId: f.cashierA, supervisorPrincipalId: null,
      occurredAt: new Date().toISOString(),
    }] });
    expect(ev.tillEventResults[0]!.status).toBe("accepted");
    const [row] = await api.db.admin<{ id: string }[]>`
      select id::text from app.till_event where client_ref = ${ev.tillEventResults[0]!.ref}::uuid`;
    eventId = row!.id;
    // 100 float + 40 sold = 140 expected; counted 137 → 3.00 short, so a TILL_OVER_SHORT is posted and
    // the "a correction is a document" claim below has a document to be about.
    await batch({ shifts: [{ shiftId, kind: "close", terminalId: f.terminalA.terminalId,
                             cashierPrincipalId: f.cashierA, at: new Date().toISOString(),
                             currency: "MYR", openingFloat: null,
                             countedCash: { amount: "137.0000", currency: "MYR" } }] });
    openShiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });

    // The two direct-write actors, and the two `withTenant`s they need. `asMigrator` holds the privilege
    // the trigger and the CHECK must override; `asRw` is the application role.
    asMigrator = (fn) => withTenant(api.db.migrator,
      { tenantId: f.seed.tenant, actorId: f.seed.system, companyId: f.seed.company }, fn);
    asRw = (fn) => withTenant(api.db.rw, ctx, fn);
    db = api.db;
    closeShiftFor = (shift, counted) => batch({ shifts: [{
      shiftId: shift, kind: "close", terminalId: f.terminalA.terminalId,
      cashierPrincipalId: f.cashierA, at: new Date().toISOString(), currency: "MYR",
      openingFloat: null, countedCash: { amount: counted, currency: "MYR" },
    }] });
  }, 600_000);

  // Assigned in `beforeAll` because they close over the fixture. Typed here so the cases read cleanly.
  let db: Awaited<ReturnType<typeof sharedApi>>["db"];
  let asMigrator: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
  let asRw: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
  let closeShiftFor: (shift: string, counted: string) => Promise<unknown>;

  /** The four close columns, the over/short document id, and that document's own ledger totals —
   *  Task 8's `snapshot` narrowed to one drawer. Anything a direct write could move is in here. */
  const drawerFingerprint = async (shift: string) => {
    const [row] = await db.admin<{
      counted: string | null; expected: string | null; over_short: string | null;
      closed_at: string | null; doc: string | null; entries: number; debit: string; credit: string;
    }[]>`
      select s.counted_cash::text as counted, s.expected_cash::text as expected,
             s.over_short::text as over_short, s.closed_at::text as closed_at,
             s.over_short_document_id::text as doc,
             (select count(*)::int from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as entries,
             (select coalesce(sum(le.debit), 0)::text from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as debit,
             (select coalesce(sum(le.credit), 0)::text from app.ledger_entry le
               where le.document_id = s.over_short_document_id)                       as credit
        from app.shift s where s.id = ${shift}`;
    return row!;
  };

  it("a re-sent close writes nothing: the counted figure and its document are both frozen", async () => {
    // The new-system sentence is "a correction is a document, never an update". A till that re-sends its
    // close — which it will, after any timeout — must not rewrite a figure a Z-report was built on.
    const before = await drawerFingerprint(shiftId);
    await closeShiftFor(shiftId, "9999.0000");
    expect(await drawerFingerprint(shiftId)).toEqual(before);
  });

  it("no code outside packages/db/src/posting writes a ledger row for a till document", () => {
    // The mechanical half. `posting-only-tables` (§3.7.5) is the build gate; this asserts the ALLOW-LIST
    // itself was not widened to get this slice's code through, which is the failure mode a lint rule
    // cannot catch about itself.
    const rule = repoFile("scripts/lint/rules/posting-only-tables.ts");
    expect(rule).not.toContain("packages/db/src/sync");
    expect(rule).not.toContain("packages/db/src/reports");
    expect(rule).not.toContain("packages/db/src/ar-ap");
  });

  it("a till_event cannot be updated or deleted, even by app_migrator", async () => {
    await expect(asMigrator((tx) => tx`update app.till_event set kind = 'void' where id = ${eventId}`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(asMigrator((tx) => tx`delete from app.till_event where id = ${eventId}`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("the shift's close columns are all-or-nothing: no half-closed row can be written", async () => {
    // `shift_close_is_atomic` (0070). A direct UPDATE setting counted_cash without closed_at is the
    // shape SAH-031 describes, and the constraint refuses it at the row.
    await expect(asRw((tx) => tx`update app.shift set counted_cash = 1 where id = ${openShiftId}`))
      .rejects.toThrow(/shift_close_is_atomic/);
  });
});
```

`drawerFingerprint(shiftId)` is written out in the block above: the four close columns, `over_short_document_id`, and the count and Σdebit/Σcredit of that document's ledger entries — the same shape as Task 8's `snapshot`, scoped to one drawer. `asMigrator`, `asRw`, `closeShiftFor` and `db` are assigned in the same `beforeAll` because each closes over the fixture.

- [ ] **Step 2: Append the `sah-041` block — `tests/regression/sah-041.test.ts`.**

**SAH-041** (spec:567) is *"the anti-tampering triggers shipped inactive"*. 6D's block asserts that **this slice's** triggers and policies are live in the shipped schema, not merely present in a migration file.

```ts
// tests/regression/sah-041.test.ts — APPENDED. `db` comes from 0B's `sharedDb()` in this file's own
// header; the two additions this block needs are below. `OD10` is computed from the gate directory Task 9
// Step 1 names, so the OD-10 case is skipped by a FILE CHECK and not by a comment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { reconcilableSources } from "@dulja/db";     // 4B's registry, for the ⚠️ OD-10 case
import { REPO_ROOT } from "../support/source";

const OD10 = existsSync(join(REPO_ROOT, "docs/owner/od-10"));

describe("SAH-041 Anti-tampering controls shipped inactive — 6D", () => {
  it("every trigger and policy 0070 and ⚠️ 0071 attach is ENABLED in the shipped schema", async () => {
    const triggers = await db.admin<{ table: string; name: string; enabled: string }[]>`
      select c.relname as table, t.tgname as name, t.tgenabled::text as enabled
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relname in ('shift', 'till_event', 'till_banking_link')
         and not t.tgisinternal order by 1, 2`;
    // 'O' is "enabled, origin" — the only acceptable value. 'D' is DISABLED, which is SAH-041 verbatim.
    for (const t of triggers) expect(t.enabled).toBe("O");
    // And the ones that must EXIST: the audit trigger on shift, forbid_change on till_event.
    expect(triggers.map((t) => `${t.table}:${t.name}`)).toContain("shift:audit_row");
    expect(triggers.map((t) => `${t.table}:${t.name}`)).toContain("till_event:till_event_immutable");
  });

  it("both RLS policies on both tables are RESTRICTIVE and FORCE RLS is on", async () => {
    const rows = await db.admin<{ table: string; policy: string; permissive: string; forced: boolean }[]>`
      select p.tablename as table, p.policyname as policy, p.permissive, c.relforcerowsecurity as forced
        from pg_policies p join pg_class c on c.relname = p.tablename
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
       where p.schemaname = 'app' and p.tablename in ('shift', 'till_event') order by 1, 2`;
    expect(rows.every((r) => r.permissive === "RESTRICTIVE")).toBe(true);
    expect(rows.every((r) => r.forced)).toBe(true);
    expect(new Set(rows.map((r) => r.policy))).toEqual(new Set(["tenant_isolation", "branch_isolation"]));
  });

  // ⚠️ OD-10 only, and gated by the FILE the owner's answer lands in rather than by a comment: with no
  // `docs/owner/od-10/` directory, Tasks 9–11 were dropped and `till_banking` is not a registered
  // `Reconcilable` kind. `it.skip` reports it as skipped, which is the honest state — a body-less `it`
  // passes unconditionally and claims coverage of a SAH-041 clause nothing tested.
  //
  // **It asserts SCHEMA, not a transaction, and that is why it belongs in this file at all.** SAH-041 is
  // "the anti-tampering triggers shipped inactive", so every case in this block reads the shipped schema
  // — and `sharedDb()` is a fresh migrated database with 0B's two thin seeds and no POS corpus, so a
  // banking document to unmatch does not exist here and could not be built without the whole 6A/6C world.
  // The BEHAVIOURAL half — unmatch sets `unmatched_at`, re-match restores it, and neither alters a ledger
  // row — is Task 11's fourth case, at the tier that has a banking (`tests/invariants/pos-till-banking`).
  // This case proves the property that makes that behaviour *structurally* unavoidable: `app_rw` cannot
  // delete a match even if a handler tried, and the retention column exists.
  (OD10 ? it : it.skip)(
    "a bank match can only be unmatched, never deleted — the grant and the column say so (§4.8.3)",
    async () => {
      // 1. `app_rw` holds no DELETE on `app.bank_match`. §3.5.4 pins the whole DELETE list and 6D adds
      //    nothing to it, so a `delete from app.bank_match` in any handler is a privilege error, not a
      //    review question. (The last case of this block asserts the pinned list itself.)
      const grants = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = 'bank_match'
           and privilege_type = 'DELETE'`;
      expect(grants).toEqual([]);

      // 2. The retention column exists and is nullable — the "unmatched, not gone" representation.
      const [col] = await db.admin<{ is_nullable: string; data_type: string }[]>`
        select is_nullable, data_type from information_schema.columns
         where table_schema = 'app' and table_name = 'bank_match' and column_name = 'unmatched_at'`;
      expect(col!.is_nullable).toBe("YES");
      expect(col!.data_type).toBe("timestamp with time zone");

      // 3. `till_banking` is a registered kind, so the clause has a subject at all. `reconcilableSources`
      //    is a Map: a source that REPLACED one of 4B's would leave the count at two, not three.
      const kinds = reconcilableSources().map((s) => s.kind);
      expect(kinds).toContain("till_banking");
      expect(new Set(kinds).size).toBe(kinds.length);      // no kind registered twice
    });

  it("app_rw holds no UPDATE or DELETE it did not hold before this slice (§3.5.4)", async () => {
    const grants = await db.admin<{ table: string; privilege: string }[]>`
      select table_name as table, privilege_type as privilege from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE' order by 1`;
    expect(grants.map((g) => g.table).sort()).toEqual(
      ["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]);
  });
});
```

- [ ] **Step 3: Write the two pins files — the pinned lists, re-asserted.**

Eight cases between them, each a claim this plan made in prose and which a later reader would otherwise take on trust. **Five in `packages/db`** (they read the database or the repository tree, both of which that workspace may reach) and **three in `tests/invariants`** (they read `@dulja/contracts`, `@dulja/api`'s routes and `probes.ts`, none of which `packages/db` may import — see the Files note above).

```ts
// packages/db/test/phase-6d-pins.test.ts — FIVE cases. Its whole import list is node, vitest and this
// package; there is no `@dulja/contracts` and no `apps/` or `tests/` path in it, and that is the point.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listApplied } from "../src/migrate";
import { startDb, type Db } from "./harness";

// The repository root and a file reader, computed locally — the same three lines as Task 4's pack test and
// for the same reason: §4.17.1 puts `REPO_ROOT`/`repoFile` in `tests/support/**` (0B/0C) and `packages/db`
// may not import the `tests` workspace (§3.1); inventing a shared `packages/db` helper would be a new
// registered name with no §4.17.1 row (hazard 9). 0C computes it the same way (0c:415).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const repoFile = (relativePath: string): string => readFileSync(join(REPO_ROOT, relativePath), "utf8");

describe("6D pins (db tier) — the claims this slice's prose makes, asserted mechanically", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); }, 240_000);
  afterAll(async () => { await db.stop(); });

  it("this slice added NO ERRORS row", () => {
    // Every code the slice raises was shipped by 0B, 4B, 6A or 6C. The `error-codes` lint enforces the
    // other direction (a code with no raiser); this asserts that no 6D-shaped token was added. It is a
    // SOURCE read, not an import — `errors.ts` is `@dulja/contracts` and this file may not name it.
    const errors = repoFile("packages/contracts/src/errors.ts");
    for (const own of ["ERR_SHIFT_", "ERR_TILL_", "ERR_ZREPORT_"]) expect(errors).not.toContain(own);
  });

  it("this slice added NO DatasetId member — shift and till_event are 7C's rows (§4.16.2)", () => {
    // `datasets.ts` is 7A's file and does not exist yet; when it does, 6D must not have edited it.
    const path = "packages/db/src/reports/datasets.ts";
    if (!existsSync(join(REPO_ROOT, path))) return;
    const text = repoFile(path);
    expect(text).not.toContain('"shift"');
    expect(text).not.toContain('"till_event"');
  });

  it("the pos module holds exactly sixteen permission codes and 6D contributed two", async () => {
    // **Read from `app.permission`, not from an import of `PERMISSIONS`.** 3B's precedent (3b:3435,
    // citing 1a:5105): `dependency-rule` forbids `packages/db` naming `@dulja/contracts`. The table is
    // global and un-RLS'd (plan0A:1254), so `db.admin` reads it with no tenant context. There is no
    // `phase` column on it, so the two 6D codes are asserted by membership rather than by a filter —
    // `permission-catalogue.test.ts` (0B) is what pins the table against `permissions.ts` both ways.
    const pos = await db.admin<{ code: string }[]>`
      select code from app.permission where module = 'pos' order by code`;
    expect(pos).toHaveLength(16);
    expect(pos.map((p) => p.code)).toContain("pos.report.read");
    expect(pos.map((p) => p.code)).toContain("pos.shift.close_any");
  });

  it("6d-till.json seeds only 6D's own account codes, and no other file seeds them", () => {
    const charts = readdirSync(join(REPO_ROOT, "packages/db/seed/my/chart-of-accounts"));
    for (const code of ["1130", "5120"]) {
      const owners = charts.filter((f) => repoFile(`packages/db/seed/my/chart-of-accounts/${f}`).includes(`"${code}"`));
      expect(owners).toEqual(["6d-till.json"]);       // hazard 32: exactly one seeding slice per code
    }
  });

  it("the migrations applied after 0069 are exactly this slice's, and 0073 is unused (§3.4.1)", async () => {
    const applied = (await listApplied(db.admin)).filter((v) => v >= 70 && v <= 73);
    // 0071 only if OD-10 = yes; 0073 is allocated and left unused, and no slice borrows it.
    expect(applied.filter((v) => v === 73)).toEqual([]);
    expect(applied).toContain(70);
    expect(applied).toContain(72);
  });
});
```

```ts
// tests/invariants/phase-6d-pins.test.ts — THREE cases, at the tier that may import all three sources.
// §3.1's table: "`tests` — imports any package and `apps/api` only through its exported entry points
// `createApp()` and `./routes` (never a route file)". `probes.ts` is a sibling of this file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS } from "@dulja/contracts/jobs";
import { ReportCodeSchema } from "@dulja/contracts/accounting/reports";
import { buildRoutes, StubAuthAdmin } from "@dulja/api/routes";
import { REPO_ROOT } from "../support/source";
import { PROBES } from "./probes";

// `ROUTES` is derived from `buildRoutes` with the stub auth adapter (§4.2.7); importing the derived const
// would be the same call, and this spelling matches 0B's own route tests. No database, so no `startDb`
// and no timeout — every case here is synchronous.
const ROUTES = buildRoutes({ authAdmin: new StubAuthAdmin() });

describe("6D pins (contracts and route tier)", () => {
  it("this slice registered NO job: JOBS is still the closed sixteen", () => {
    expect(Object.keys(JOBS)).toHaveLength(16);
    expect(Object.keys(JOBS).filter((n) => /till|shift|pos\.z/.test(n))).toEqual([]);
  });

  it("6D mounted exactly ONE new route module and it has exactly one PROBES key", () => {
    const mine = ROUTES.filter((r) => r.path.endsWith("/shifts"));
    expect(mine).toHaveLength(1);
    expect(PROBES[mine[0]!.path]).toBeDefined();
    // And the two report GETs added no key: they are sub-paths of 1B's module (hazard 31).
    expect(ROUTES.filter((r) => r.path.endsWith("/reports"))).toHaveLength(1);
  });

  it("ReportCodeSchema names both 6D codes and 6D seeded no ReportDefinition", () => {
    expect(ReportCodeSchema.options).toContain("pos.z_report");
    expect(ReportCodeSchema.options).toContain("pos.sales_by_cashier");
    expect(existsSync(join(REPO_ROOT, "packages/db/seed/my/reports/6d"))).toBe(false);
  });
});
```

- [ ] **Step 4: Run the whole re-run matrix.** Every row is a test this slice inherits and must not have broken; the "why it can break" column is what a failure means.

| Suite | Command | Why this slice could break it |
|---|---|---|
| 6A's batch apply | `cd packages/db && bun run test -- sync/apply` | Task 3's ordering and `assertShiftKnown`; **one case is edited by design** (Task 3 Step 6, Task 6 Step 5) and every other must stand |
| 6A's catalogue + enrolment | `cd packages/db && bun run test -- sync/catalogue-revision sync/enrolment sync/pos-columns` | nothing here should touch them; a failure means `apply.ts`'s imports moved something |
| 6C's limits, PIN, isolation | `cd packages/db && bun run test -- sync/limits staff` | `posFixture`'s new shift (A6) and `staffFixture`'s two members (A7) — both additive |
| 6A/6C invariants | `cd tests && bun run test -- pos-sync pos-authority` | the same two fixture edits, at the `tests` tier |
| **test 36** branch scoping | `cd tests && bun run test -- branch-isolation` | 0070's two Form A policies join the family; the suite iterates the five forms |
| **test 12** tenant isolation | `cd tests && bun run test -- tenant-isolation` | the new `shifts` module and its `PROBES` key |
| **test 1** ledger balance | `cd tests && bun run test -- ledger-balance` | every `TILL_*` document is two lines of one magnitude; a sign error fails here |
| **test 2 / 22** projections | `cd tests && bun run test -- projection-rebuild` | `account_balance` MERGEs from the till documents; `projectionChecks` is unchanged at two members |
| **test 13** audit chain | `cd tests && bun run test -- audit-chain` | `shift` is audited and `till_event` is exempt; a wrong set membership fails here |
| **test 39** bank reconciliation | `cd tests && bun run test -- bank-reconciliation` | ⚠️ OD-10's third `ReconcilableSource`; a replaced kind rather than an added one fails 4B's own cases |
| **test 21** shift reconciliation | `cd tests && bun run test -- pos-shift-reconciliation` | this slice's own DoD |
| **6D's own db-tier suites** | `cd packages/db && bun run test -- sync/shifts sync/shift-close sync/till-events reports/pos seed/6d-pack phase-6d-pins` | this slice's five new db files plus the db half of the pins: 10 + 13 + 11 + 9 + 5 + 5 = **53** cases |
| **6D's contracts-tier pins** | `cd tests && bun run test -- phase-6d-pins` | the other three pinned claims — `JOBS`, the route/probe bijection and `ReportCodeSchema` — which live here because `packages/db` may not import `@dulja/contracts`, `@dulja/api/routes` or `probes.ts` (§3.1): **3** cases |
| Schema linter + privileges | `cd packages/db && bun run test -- schema-lint privileges permission-catalogue` | 0070/0071's tables, 0072's codes, the unchanged DELETE pin |
| Whole repo | `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test` | the gate §3.8 requires green after every task |

- [ ] **Step 5: Rewrite `AGENTS.md`'s "Current phase" section (§3.8).**

```markdown
## Current phase

**Phase 6 (POS) is complete.** 6A shipped the sync protocol, terminal identity and `POS_TICKET`; 6B the
till application (`pos.exe`) and its local SQLite; 6C the minimal employee master, `pos_cashier`,
`branch_pos_policy`, `attendance_event` and the five `branch_isolation` policy forms; 6D shifts,
`till_event`, the Z-report and ⚠️ the till cash lifecycle.

Phase 6's definition of done is met: a till sells 8 hours offline and reconciles with zero duplicates and
zero lost tickets (`tests/invariants/pos-sync-*.test.ts`, acceptance tests 19 and 20), and **the shift
Z-report ties to the ledger to the cent** (`tests/invariants/pos-shift-reconciliation.test.ts`, acceptance
test 21).

**Next: Phase 7 (Reporting), slice 7A** — the report engine: the definition format, datasets,
server-side render, saved views and financial-statement layouts. 7A creates
`packages/db/src/reports/datasets.ts` with every dataset whose source tables exist at migration ≤ 0058;
**7C adds the three Phase 6 members** `shift`, `till_event` and `needs_attention` and re-expresses
`pos.z_report` and `pos.sales_by_cashier` as `ReportDefinition`s **under the same codes**, re-running
6D's tie-out test unchanged as the proof that nothing moved (contracts §4.16.1).

Migrations applied: 0001–0072 (**0073 is allocated to 6D and deliberately unused; no slice borrows it**).
⚠️ 0071 exists only if OD-10 = yes.
Open owner decisions blocking work: OD-10 (till cash lifecycle — 6D Tasks 9–11), OD-24 (screens — every
slice with a screen task), and the Phase 7+ items of §2.12.
```

- [ ] **Step 6: Write the phase report into the PR body.** The §3.8 PR template unchanged, plus a table of the thirteen tasks, the three PRs and their migrations, the acceptance tests owned and re-run, and the two owner gates and what each dropped. **Pushing to GitHub is the owner's call and is not part of this task's definition of done** (plan0A:2927).

- [ ] **Step 7: Commit.**

```bash
git add tests/regression/sah-031.test.ts tests/regression/sah-041.test.ts \
        packages/db/test/phase-6d-pins.test.ts tests/invariants/phase-6d-pins.test.ts AGENTS.md
git commit -m "test(regression): sah-031 and sah-041 — 6D blocks, and the phase-6 exit [6D T13]

sah-031: a re-sent close writes nothing, a till_event resists app_migrator, and
shift_close_is_atomic refuses a half-closed row — a correction is a document,
never an update. sah-041: every trigger 0070 attaches is tgenabled = 'O', both
policies are RESTRICTIVE with FORCE RLS, and app_rw's DELETE list is the pinned
five. phase-6d-pins re-asserts the eight claims this plan's prose makes: no job,
no ERRORS row, no DatasetId member, sixteen pos codes, one route module, one
PROBES key, one seeding file per account code, and 0073 unused. It is TWO files
because §3.1 pins packages/db to @dulja/domain: the three claims that read
@dulja/contracts, @dulja/api/routes and probes.ts live in tests/invariants.

AGENTS.md: Phase 6 complete; next is 7A.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

### Contract additions — every name this plan had to invent because the contracts document lacked it

Each is either an amendment Task 0 writes into the contracts document (A1–A18) or a name internal to this slice. **A name in neither list is a review-blocking finding** (hazard 32).

**Registered by Task 0 as amendments A1–A18** — the cross-slice half, each written into the contracts document before any code:

| Id | What it adds or settles | Section touched |
|---|---|---|
| A1 | `app.shift`'s three missing composite FKs and one index | §4.6.5 |
| A2 | `document.shift_id` is **6A's 0061 column, not 6D's**, and 6D adds no FK on it | §4.3.4 |
| A3 | `expected_cash` is one read of the `1110` leg (ADR 0063's contract half) | §4.6.5 |
| A4 | `POS_PERMISSION` gains `shiftOwn` and `shiftCloseAny`; `OVERRIDE_SUBJECT_FOR` gains two `null`s | §4.2.5, §3.6.2 |
| A5 | `zReport` / `salesByCashier` and their param and row types join the §4.16.3 surface | §4.16.3 |
| A6 | `posFixture` opens a shift at `SHARED_SHIFT_ID`; `PosFixture.shiftId` | §4.17.1 |
| A7 | `StaffFixture.shiftA` and `.openShift()` | §4.17.1 |
| A8 | The three role grants — `close_any` → `branch_manager`; `report.read` → `branch_manager`, `auditor` | §3.6.4 |
| A9 | Test 21 lives in `tests/invariants/`, not `tests/e2e/` | §3.7.3 |
| A10 | A refused shift / till event / cash event writes **no** `needs_attention` row | §4.10.3 |
| A11 | The `shifts` route module, its three sub-paths and its one `PROBES` key; `reportsRouteModule.permissions` gains `pos.report.read` | §4.2.7 |
| A12 | There is no back-office force-close, and the known gap is recorded | §4.6.5 |
| A13 | ⚠️ `TicketBatch.cashEvents`, `BatchResult.cashEventResults`, `TillCashMsg`, `outbox.kind`'s fourth label | §4.10.1, §4.10.6 |
| A14 | What `1130` and `5130` carry, and why `TILL_BANKING` always debits `1100` | §4.15 |
| A15 | **New in this pass.** 6A's `resolveSeries` is generic, so the four till series are `TOS-<terminal code>` etc., not bare | §4.14 |
| A16 | ⚠️ `till_banking_link`'s §4.6.1 register row and its §3.5.3 (empty) linter memberships | §4.6.1, §3.5.3 |
| A17 | **New in this pass.** `seedShift` gains `currency?`, `branchId?`, `shiftId?`, and inserts as the **system** principal because `app.shift` carries Form A | §4.17 |
| A18 | **New in this pass.** `MODULE_READ_CODE` lives in `apps/api/src/middleware/require-attachment-read.ts`, the path 2C actually shipped | §4.5.8 |

**Internal to this slice and deliberately not registered** (the 6A precedent: a db-local name with one home and one caller is not a contract): `ShiftMessageInput`, `ClassifiedShift`, `ShiftClassification`, `classifyShifts`, `shiftRef`, `applyShiftOpen`, `applyShiftClose`, `assertShiftKnown`, `computeExpectedCash`, `moneyFromMessage`, `assertShape`, `runMessage` (private in `apply.ts`), `TillEventInput`, `tillEventRef`, `applyTillEvent`, `TillDocumentKind`, `TillDocumentInput`, `buildTillDocument`, `resolveAccountByCode`, `SEEDED_BY`, `TENDER_ACCOUNT`, `ACCOUNT_TENDER`, `ReportParamError`, `ZReportTender`, `ZReportCashLine`, `SERIES_FOR`, `toShiftDto`, ⚠️ `TillCashInput`, ⚠️ `cashEventRef`, ⚠️ `verifyCashEvent`, ⚠️ `applyCashEvent`, ⚠️ `CASH_EVENT`, ⚠️ `afterCashEvent`, ⚠️ `tillBankingSource`, ⚠️ `useShiftApi` / `ShiftApiProvider` (Task 12, `apps/backoffice/src/lib/shift-api.ts` — 3A's `useInventoryApi` precedent, in the same file rather than a second one), and the test-local `sellCash`, `closeRaw`, `seedEmployeePrincipal`, `sellInto`, `returnInto`, `closeShiftFor`, `insertPostedTicket`, `buildTicketLocal`, `push`, `openMsg`, `closeMsg`, `ticket`, `event`, `snapshot`, `read`, `write`, `drawerFingerprint`, `ledgerFingerprint`, `asMigrator`, `asRw`, `principal`, `sync`, ⚠️ `batchAs`, ⚠️ `pushCash`, ⚠️ `pushCashAt`, ⚠️ `legsOf`, and the two locally computed `REPO_ROOT` / `repoFile` constants in `packages/db/test/seed/6d-pack.test.ts` and `packages/db/test/phase-6d-pins.test.ts` (§3.1 forbids importing 0B's, and §4.17.1 assigns 6D no helper). **`read`, `write`, `batchAs`, `pushCash`, `legsOf` and `ledgerFingerprint` exist in TWO copies — one in `packages/db/test/sync/till-cash.test.ts` and one in `tests/invariants/pos-till-banking.test.ts` — deliberately**: the two files are in different workspaces with different `withTenant`s (hazard 15) and different stacks, and *"a test file that imported another's helpers would inherit its fixture too"* (Task 6's note).

**Wire names that *are* contracts and are registered by A5/A11/A13**: `ShiftSchema`, `ShiftQuery`, `ShiftList`, `TillEventSchema`, `TillEventList`, `ZReportSchema`, `ZReportQuery`, `ZReportList`, `ZReportTenderSchema`, `ZReportCashLineSchema`, `SalesByCashierRowSchema`, `SalesByCashierQuery`, `SalesByCashierList`, `shiftRoutes`, `shiftRouteModule`, ⚠️ `TillCashMsgSchema`. The two contracts files `packages/contracts/src/pos/shift.ts` and `pos/reports.ts` are **new rows in §4.2.8's module table** and Task 0's A5 records them there.

### The skill's checklist, walked

| Requirement | Where |
|---|---|
| For-agentic-workers line, Goal, Architecture, Tech Stack, Spec | header, lines 1–25 |
| Assumptions block (§3.10) | header, "Assumptions and contracts" |
| Global Constraints | header, twenty numbered items |
| File Structure | header, the tree |
| Every task has Files / Interfaces (Consumes / Produces with exact signatures) | Tasks 1–13; Task 0 is the contracts gate and names its two files |
| Bite-sized checkbox steps | every task; 4–9 steps each |
| TDD: failing test → the exact expected failure → minimal implementation → run to pass → commit | Tasks 1, 2, 3, 4, 5, 6, 7, 9, 10, 11 each open with the failing test and the literal failure text; Task 8 **is** the test and states the three failures worth naming; Tasks 12 and 13 are a gated screen task and a re-run task and say so |
| Real code in every code step | every SQL block is a full `CREATE TABLE` with constraints, composite FKs and the three `app_meta` calls; every TypeScript block compiles as written |
| No placeholders | audited below |
| Self-Review section | this section |
| Execution handoff section | next section |
| Task headings are exactly `### Task N: <title>` | all fourteen (0–13), contiguous, none renumbered |
| 10–15 tasks | **fourteen, and the 6D card says 11–13 (contracts:601) — a declared deviation of one.** The extra is **Task 0**, which ships no product code: it is the contracts-amendment and repository gate that eighteen `need_repo` lines and eighteen amendments (A1–A18) require, and folding it into Task 1 would put a contracts edit and a migration in one commit. Counted as product tasks the slice is thirteen (1–13), which is inside the card's range. Recorded here rather than fixed by merging, because the merge is the worse plan |

### Placeholder audit

Searched for `TBD`, `TODO`, `implement later`, `add appropriate`, `similar to Task`, `etc.`, `and so on`, `per Step`, `/* … */`, `...` and a bare `…` standing in for content. **One construct appears and it is a deliberate, bounded reference rather than a placeholder**, because a plan that reprinted it would be worse:

1. **`/* … 6A's body, byte-for-byte … */`** (Task 3 Step 3, inside `applyBatch`'s ticket loop) and **`/* … every existing member, unchanged … */`** (Tasks 2, 5, 7). Each names a *specific existing block in a specific committed file* that the step must not alter. Reprinting 6A's forty-line ticket loop would invite a reviewer to diff two copies of it and would make the one thing this slice changes about that function invisible. Every such marker is preceded by the file path and the identifier.

**Fixed in the third pass — an earlier draft defended described-but-unwritten test bodies as "acceptable because they are gated", and that defence was wrong.** A gate decides whether a task *runs*; it does not license a title with a comment for a body, which passes unconditionally and is counted in a "N passed" the handoff table relies on. All of the following now carry real code:

- **Task 9 Step 7's eleven `it`s and its `beforeAll`** (were titles with a comment, four of them literally `async () => { /* … */ }`). The `beforeAll` now seeds both branches' policies, both shifts, branch B's terminal and the two cash sales; every case carries its assertions and its arithmetic. The step also said "Ten cases" over eleven blocks — it says eleven now, and Step 8's `11 passed` was already right.
- **Task 11 Step 1's whole file.** It had no import header at all and called `pushCash`, `legsOf`, `ledgerFingerprint`, `read`, `write` and six ids that lived in another file in another workspace. It now has its own header, its own `beforeAll` (the shift, the nine sales, the banking, 4B's `importStatement` in 4B's own call shape), its own local copies of the three helpers, and the "a branch manager at B sees no branch-A banking link" case has a body — including the positive control that stops it passing on an empty table.
- **Task 11 Step 7's five cases** (were one sentence).
- **Task 12 Steps 3, 4 and 5** (were three prose paragraphs immediately after a preamble claiming "Steps 2–5 carry real code"). Both `.tsx` screens, the two component suites and the Playwright spec are written out against **0E's** real names — `useShell().t`, `DataGrid`, `Column`, `formatMoney` — not 3A's `useT`/`DataTable`, which 0E does not ship.
- **Task 10's till-cash header** gained `read`, `zReport`, `seedShift` and `branchBTerminal`, all of which its cases called and none of which the file declared.

**Fixed in the second pass, and recorded because the first audit missed them:** the `ZReportParams`/`ZReport` interface bodies in Task 7 Step 2 (was `/* … as declared above … */`, now inlined together with `SalesByCashierParams` and `SalesByCashierRow`); the whole `pos.sales_by_cashier` handler (Task 7 Step 4, was one sentence); all three `shifts` handlers (Task 7 Step 5, was a block comment); the six route-test cases (Task 7 Step 7, was six English sentences); acceptance test 21's `ticket()` helper (Task 8 Step 1, was `/* … */`); `sellInto` / `returnInto` / `closeShiftFor` (Task 7 Step 1, called and never defined); `insertPostedTicket` / `buildTicketLocal` (Task 6 Step 1, same); `sellCash` (Task 5, was "per Step 6"); the sah-031 `beforeAll` and `drawerFingerprint` (Task 13 Step 1, was a comment); the sah-041 OD-10 case (Task 13 Step 2, was a title with two comment lines and no statement — it passed unconditionally and claimed a SAH-041 clause nothing tested); and **Task 6 Step 6's route guard**, which was one sentence describing the replacement raiser for `ERR_SYNC_MESSAGE_UNSUPPORTED` and is now the `KNOWN_BATCH_KEYS` check, its exact detail text, its route-suite case and its entry in the task's Modify list.

**No step says "handle errors appropriately", "add validation" or "see Task N".** Every refusal in this plan names its `ERR_*` code from Global Constraint 11's closed list and carries its exact message text. **Every test file's code block carries its own complete import header**, and **every `it` in the plan has statements** — the one `it.skip` in the plan is Task 13 Step 2's OD-10 schema case, which is gated on the `docs/owner/od-10/` directory and reports as skipped rather than passing vacuously.

### Every hazard in §5 that touches this slice, and where it is discharged

| Hazard | Discharge |
|---|---|
| 1 no statutory rate | Constraint 17. This slice states no rate; tax reaches it only through `POS_TICKET`'s already-posted tender totals, and Task 4's `TILL_OVER_SHORT` policy is `tax.applies: false` |
| 2 no MyInvois detail | Constraint 17; nothing here touches e-invoicing |
| 3 Firebird unknown | Nothing in this slice reads a legacy database |
| 5 owner-account pattern | Task 4 Step 4 and Task 9 Step 1 / Task 12 Step 1 all use "owner provides X; verify with `<exact command>`" with a local equivalent |
| 6 one task per OD item | OD-10 → Tasks 9, 10, 11 behind **one** gate (Task 9 Step 1); OD-24 → Task 12; OD-05's 6D row is OD-10's own subject and Task 9's preamble records both ids against one decision |
| 7 never re-open D1–D27 | Constraint (Assumptions "Never re-decide"); ADR 0063 and ⚠️ 0064 are **proposals** and neither implements before asking |
| 8 0A helpers by exact name | Every fixture call is `startDb`, `Db`, `Seed`, `withTenant` (4-arg test) / `withTenant(sql, ctx, fn)` (production, in root `tests/`), `uuidv7`, `lintSchema`, `listApplied`, `schemaFingerprint` |
| 9 `fixtures.ts` additive, one helper | Exactly `seedShift` (Task 1 Step 6), appended, editing nothing above it. Tasks 5 and 6 keep their extra setup **test-local** rather than adding a second fixture |
| 10 no per-tenant rows in a migration | 0070 and ⚠️ 0071 create objects; 0072 seeds `app.permission`, which is global. Document types, policies and chart rows are Task 4's seed pack |
| 11 no enum label | `till_event.kind` and every new vocabulary is `text` + a named CHECK |
| 12 0A's `[1]` generalised | Relied on by 0070/0071/0072's reversibility runs; 0B did it |
| 13 `lint-schema.ts` hotspot | Task 1 Step 4 edits the two sets to **exactly** §3.5.3's declared state and nothing else |
| 14 numbers never renumbered or borrowed | 0070, ⚠️ 0071, 0072; **0073 allocated and unused**, asserted by Task 13 Step 3 |
| 15 two `withTenant`s | `packages/db/test/**` uses the 4-argument test helper; `tests/**` uses the production one (Task 8's `read`/`write`) |
| 18 test 22's projection set | Untouched; Task 13's re-run matrix runs `projection-rebuild` |
| 19 terminal acts, cashier attributed | Constraint 8; `buildTillDocument`'s doc comment; Task 5's fourth case asserts `created_by === terminal` and `attributed_to === cashier`; Task 8's last case asserts `salesByCashier` groups by the cashier |
| 20 jobs as the system principal | Constraint 15; **this slice registers no job**, asserted by Task 13 Step 3 |
| 21 `sql.unsafe` has three homes | Constraint 3; none in this slice |
| 22 nothing outside `posting/` writes the ledger | Constraint 1; `buildTillDocument` is in `posting/`; Task 13 Step 1's second case asserts the lint allow-list was **not** widened |
| 24 `document_event` only by triggers | This slice inserts none; `postDocument`'s status update fires 2B's trigger |
| 25 the DELETE pin | Constraint (Task 1 Step 7's note); Task 13 Step 2's last case asserts the pinned five |
| 26 the permission vocabulary is closed | Constraint 12; Task 2 seeds exactly two; Task 13 Step 3 asserts the pos total is sixteen |
| 29 the UI is not specified | Task 12 opens with OD-24 and states its default layout for comparison |
| 31 every route needs a probe | Task 7 Step 6, **one** entry; Task 13 Step 3's fifth case asserts the bijection and that the report GETs added none |
| 32 no invented literal in a shared namespace | The contract-additions tables above; Task 4 Step 1's third case and Task 13 Step 3's seventh case are the mechanical proofs |
| 33 the policy-seeder seeds its accounts | Constraint 14; Task 4 seeds `5120`/`1130` (⚠️ `5130`); Task 5's last case asserts `1110`/`1100` resolve and refuses loudly by name; no policy in this slice names an account by code |
| 34 a seed file is an envelope | Task 4 Step 3 and Tasks 9–11's three files all carry `code`/`nameEn`/`nameAr`/`module`/`policyVersion`/`effectiveFrom` **outside** `policy` |
| 35 written to the skill | this section |

### Four things a reviewer should push back on

1. **`applyShiftClose` posts a document inside `applyBatch`'s message savepoint, and `postDocument` is not a small function.** A close therefore does issue-numbering (an advisory lock on the series), a policy resolve, an evaluate, a ledger insert and an `account_balance` MERGE inside a savepoint nested in a batch transaction that also holds a per-terminal advisory lock. That is a long-held lock on a busy shop's closing minute. It is accepted because the alternative — posting the over/short from a job after the batch commits — would leave a window in which a shift is closed and its difference is not in the ledger, and the DoD sentence is that the Z-report *ties*. If it proves too slow, the fix is 6A's existing `pos.sync.apply` job path for large batches, not a second posting path.
2. **The Z-report's tender section is scoped to `POS_TICKET` by a string literal in a SQL predicate.** A fifth POS-side document type that debited `1110` and was *meant* to appear as a tender would be silently excluded. The mitigation is that the `cashControl` section catches every other type by construction, so nothing is lost — it is only categorised differently — and Task 10's Z-report case pins that behaviour. A reviewer who wants the predicate driven off `document_type.module = 'pos'` should say so; it would fold ⚠️ `TILL_BANKING`'s `1100` leg back into the transfer tender, which is why it is not written that way.
3. **`assertShiftKnown` accepts a CLOSED shift, so a late ticket posts into a reconciled drawer.** A till
   that has closed its shift and then drains a ticket it had been holding — a real case after a long
   outage — will have that ticket accepted and posted with `shift_id` set. The shift's stored
   `expected_cash`, `counted_cash` and `over_short` do not move (they are facts about a count that
   happened), but the Z-report's *tender* lines do, because they read the ledger — so a closed shift's
   Z-report can stop tying to its own stored figures. **This is accepted rather than refused**, for two
   reasons: the batch order (opens → tickets → cash events → closes) means a till sending its backlog and
   its close in one payload is handled correctly, which is the common case; and refusing a ticket because
   its drawer is closed would lose a real sale to satisfy a report, which inverts spec:1305's priority. A
   reviewer who wants it refused should say so — the change is four characters in `assertShiftKnown`
   (`and closed_at is null`) plus a `needs_attention` path for the refused ticket, and it makes "zero lost
   tickets" conditional on a till's clock. Task 3's last case pins the current behaviour deliberately.

4. **`salesByCashier` attaches `overShortBase` by `shift.closed_principal_id`.** A branch manager who closes a cashier's drawer takes the discrepancy onto their own row, not the cashier's. That is defensible (the closer declared the count) and it is also arguably wrong (the cashier held the drawer all day). It is written the first way because `closed_principal_id` is the only principal the row can attribute a *count* to, and a report that guessed would be a report a manager could not defend. If the owner's practice differs, the change is one join in one query.

---

## Execution handoff

### Read these before Task 1

1. **The contracts document, in this order**: your card (§2.7's 6D row), §2.12 (OD-10 and OD-24), all of §3, §4.1, §4.2, §4.3.1–§4.3.7, §4.4.2 (**including the sign-normalisation section**), §4.5.6, §4.5.8, §4.6.1, **§4.6.5 in full**, §4.8.3, **§4.10 in full**, §4.14, §4.15, §4.16.1 and §4.16.3, §4.17, §4.18, all of §5, and your rows in §6.1 (test 21) and §6.2 (spec:1063).
2. **The four plans you extend**, at their Produces blocks: `2026-09-05-dulja-phase-6a-sync-protocol-terminal-identity.md` (Tasks 5, 10, 11 and the whole of `tests/invariants/support/pos.ts`), `…-6c-staff-cashiers-branch-isolation.md` (Tasks 8, 9 and `tests/invariants/support/staff.ts`), `…-4b-ageing-fx-bank-reconciliation.md` (Task 7's `registerReconcilableSource` and `ledgerLegSource`), `…-1b-projections-integrity-reports.md` (Task 9's `reportsRouteModule` and the report-handler shape).
3. **Plan 0A Tasks 3, 4, 7 and 11**, for `startDb` / `withTenant` / `uuidv7` / `seedTenant` / `Seed` / `draftDocument` / `lintSchema` / the migration runner exactly as they exist.

### Execution order and the PRs — **PR 1 of 2 (3 with OD-10)**

Tasks run **in order**; the numbering is the dependency order and there is no parallel branch.

| PR | Migration | Tasks | Gate to merge |
|---|---|---|---|
| — | none | **0** | `bash scripts/check/contracts-6d-amendments.sh` exits 0 |
| **1** | `0070` | **1** | `packages/db` tests green; `schema-lint` zero violations; up → down → up reversible |
| **2** | `0072` | **2, 3, 4, 5, 6, 7, 8** | acceptance test 21 green; every row of Task 13's re-run matrix green; `lint:rules` green **after every commit in the PR**, Task 2's included |
| **3** ⚠️ | `0071` | **9, 10, 11** | OD-10 = yes; test 39's till-banking clause green; 4B's own suite **unchanged** |
| — ⚠️ | none | **12** | OD-24 material attached; test 23 green in both directions |
| — | none | **13** | the whole matrix, `AGENTS.md`, the two regression appends |

**PR 2 is seven tasks, on the "one migration per PR" ground and nothing else.** Migration 0072 is its only migration; Tasks 3–8 add no DDL, so folding them in keeps spec:2057 satisfied without opening a PR that ships a permission code and no behaviour behind it. **It is not held open by a red lint** — Task 2's commit is green on its own (Task 2 Step 8), and if a reviewer prefers a two-commit PR 2a (Task 2) and a PR 2b (Tasks 3–8), nothing in this plan prevents it. Commit each task separately inside the PR so a reviewer reads seven diffs, not one.

### Where to stop and raise, per task

**The rule: if the failure text differs from what the task predicted, stop and read this table rather than adjusting the test.** A test adjusted to match a wrong implementation is the defect this column exists to prevent.

| Task | What you should see | Stop and raise if |
|---|---|---|
| **0** | eighteen `MISSING (doc)` lines, then `6D Task 0 gate OK.` | **any `MISSING (repo)` line** — the owning plan shipped a different spelling; §4.18 makes that plan the authority, so correct **this** plan's import path or name and never add a second spelling. **Or any `MISSING (repo, OWNED ELSEWHERE)` line** — a column or literal 6D cannot supply by renaming anything of its own; the line carries its own remedy (for `document.shift_id`, a raise against 6A Task 11, **never** an `alter table` in 0070). Never edit the gate to pass |
| **1** | `relation "app.shift" does not exist`, then **8 passed** | `lintSchema` returns a violation naming `shift` or `till_event` — the Form A policy or the audit/immutable attachment is missing, and §3.5.2 requires zero. If the violation names a *third* table, 6C's 0068 did not run. **Or `new row violates row-level security policy for table "shift"` in a `beforeAll`** — `seedShift` is inserting as `db.rw`/`s.human` instead of `db.migrator`/`s.system`; `app.actor_in_branch` needs a `role_assignment` and `seedTenant` grants `s.human` none (amendment A17). The fix is the fixture's `withTenant`, never `opts` and never the policy |
| **2** | `expected 14 to be 16` on the pos count | the count is not 14 before your migration. 6A/6B/6C seeded ten + three + one; a different number means one of them did not merge, and Task 0's gate should have caught it |
| **3** | `does not provide an export named 'classifyShifts'` | **any case in `sync/apply.test.ts` other than the one you edited fails.** That is a missed `shiftId` site in Step 5 — find it; do **not** weaken `assertShiftKnown` |
| **4** | `ENOENT … 6d-till.json` | the seed CLI reports a code-format violation. `1130` must be an asset (`1`) and `5120` an expense (`5`); the first digit **is** the type (§4.15) |
| **5** | `Failed to load url ../../src/posting/till` in `sync/shift-close`, then every close case failing on Task 3's stub detail `"the shift close apply path is 6D Task 5"` | `null value in column "series" of relation "document"` on the first close — the header insert dropped `series`, which is `text not null` with no default (plan0A:1780); Step 2's `SERIES_FOR` supplies it and **6A's printed insert is not the list to copy** (its `series` is the bare placeholder `'POS'` and it names no notes column at all). **Or** `column "memo" of relation "document" does not exist` — you invented a column neither plan names; the registered one is `notes` (§4.3.4, 2C's 0027). **Or** `ERR_DOC_NO_LINES` on an exact count — you posted a zero document; Step 3's `if (!overShort.isZero())` is missing |
| **5** (again) | 13 passed in `sync/shift-close`, 10 still passing in `sync/shifts` | the reversal case reports `expected_cash` = `"30.0000"`. `reverseDocument` does not carry `shift_id` onto the reversal — **raise it against 1A's `reverse.ts` and §4.3.1**, and do not widen `computeExpectedCash`'s predicate to compensate. **Or** the BRANCH-dimension case reports `column led.ledger_entry_id does not exist` — the column is `entry_id` (plan0A:2043); that typo makes the case *error*, not fail, so it proves nothing until fixed (2A's self-review item 16 is the same mistake) |
| **2, 3, 4** | `bun run lint:rules` **green**, `permission-catalogue` included | `permission-catalogue` reports `N catalogue code(s) evaluated by no route or job handler: pos.shift.close_any …`. That means Task 2 Step 6's `packages/db/src/sync/authority.ts` was not staged with migration 0072, or its two members were written as anything other than bare string literals. **Fix the file; never add a `PERMISSION["pos.shift.close_any"]` elsewhere to silence it** — a reference outside the close path is a dead one nobody removes — and never move the catalogue row to a later commit, which makes `permission-catalogue.test.ts` red instead |
| **6** | `does not provide an export named 'tillEventRef'`, then **11 passed** and green `apps/api` sync route suite | `error-codes` fails on `ERR_SYNC_MESSAGE_UNSUPPORTED` — Step 6's `KNOWN_BATCH_KEYS` guard in `apps/api/src/routes/sync/tickets.ts` is its replacement raiser and was not written or not staged; write it, do **not** delete the `ERRORS` row. **Or Step 6's new route case answers 200 with a `BatchResult` body instead of a `Problem` body** — the guard is reading `c.req.valid("json")`, whose plain `z.object` has already stripped the unknown key (6A Task 12 Step 2); it must read `await c.req.json()`, and 6A's schema is not yours to make `.strict()`. **The 200 status itself is correct** and is §4.2.4's row for this code (contracts:1576); do not edit that row |
| **7** | `Cannot find module '../../src/reports/pos'` | `tenant-isolation` fails naming a path string — Step 5's `RouteModule.path` and Step 6's `PROBES` key disagree character for character |
| **8** | 7 passed | one of the five named failures in Step 2's table. Each points at Task 5, Task 7 or the refund's `returnsClientRef`, not at this test. **Never change an expected figure**: the day's arithmetic is written out in `day` and is checkable by hand. **Also stop if a later, unrelated regression file in the same run fails with a closed connection** — something added an `api.stop()` to this file, and `sharedApi()` is 0B's memoised stack shared by every full-regression file in the process (0b:39) |
| **9** | the `docs/owner/od-10/` gate | the gate directory is absent → **stop, drop Tasks 9–11, and ship**. That is the designed outcome, not a blocked slice |
| **10** | 18 passed cumulatively | a safe drop is refused at branch B. `verifyCashEvent` is applying the paid-out limit to every kind; only `paid_out` is limited |
| **11** | 23 passed; test 39 green | **4B's own `bank-reconciliation` suite fails.** `registerReconcilableSource` is a `Map.set` — you registered `receipt` or `payment` again and replaced 4B's source. Register `till_banking` only |
| **12** | the `docs/owner/od-24/6d/` gate | the directory is absent → **stop, leave Steps 2–5 unchecked, ship the slice**. Nothing depends on this task |
| **13** | the whole matrix green — `packages/db` pins **5 passed**, `tests` pins **3 passed** | either pins file fails on the `JOBS` count, the pos code count, the route/probe bijection or the 0073 assertion. Each is a claim this plan's prose made; a failure means the prose or the code is wrong, and the prose is the one to check first. **Or `bun run lint:rules` reports `dependency-rule` on `packages/db/test/phase-6d-pins.test.ts`** — a case that belongs in the `tests` half was written in the db half; move the case, never widen the rule |

### What the next slice needs from this one

**7A** creates `packages/db/src/reports/datasets.ts` with every dataset whose source tables exist at migration ≤ 0058 and **must not add `shift`, `till_event` or `needs_attention`** — those are 7C's three rows in the frozen §4.16.2 union, and Task 13 Step 3's third case asserts 6D added none.

**7C** re-expresses **`pos.z_report`** and **`pos.sales_by_cashier`** as `ReportDefinition`s **under the same two codes**, over `zReport` and `salesByCashier` **unchanged** (§4.16.1: "re-expresses means the code and its numbers are unchanged"), seeding them at `report_definition.version = 2` under `unique (company_id, code, version)`. It adds the three Phase 6 `DatasetId` members, and **it re-runs `tests/invariants/pos-shift-reconciliation.test.ts` unchanged** as the proof that the re-expression changed nothing. Z-report *history* is the same code with the `from`/`to` parameter shape this slice already serves — 7C adds no third code. It also owns `pos.sales_by_branch` and `pos.needs_attention`, neither of which is this slice's.

**8B** adds the fourth and last row to `MODULE_READ_CODE` (`hr → hr.payroll.read`, §4.5.8), completing the map 2C started, 3A extended and Task 2 Step 7 gave its `pos` row.

**A later slice** may add the foreign key on `document.shift_id` in a **contract** migration (§3.4.7), once every till has re-sent the shift-open messages 6A held in its outbox. **This slice does not schedule it, and Task 0 amendment A2 forbids any plan adding it without amending that paragraph** — the reason is in A2 and is not obvious from the schema.

**Nothing in Phase 7 or 8 may rename or re-shape** `app.shift`, `app.till_event`, ⚠️ `app.till_banking_link`, `zReport`, `salesByCashier`, `shiftRouteModule`, `pos.shift.close_any`, `pos.report.read`, `seedShift`, `PosFixture.shiftId` or `StaffFixture.shiftA`/`.openShift`. All are registered in the contracts document by Task 0's amendments and are frozen from the moment this slice merges.
