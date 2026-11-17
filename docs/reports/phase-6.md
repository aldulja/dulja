# Phase 6 implementation record

> Recovery note — 2026-10-22: this file was reconstructed from retained implementation history. Its earlier test totals describe the original workspace. The recovered tree is undergoing fresh verification; see `docs/review/2026-10-22-phase-6-recovery.md`.

## State — 2026-10-09

The authorized Phase 6 implementation is present across **6A → 6C → 6B → 6D**. Local exit verification is being finalized. Phase 5 was already merged at `fbb86be`; it was not reimplemented. The [decision bundle](../review/2026-10-07-phase-6-decisions.md) records authorized implementation defaults; ADRs 0054–0063 retain Proposed status for formal review.

Sync/enrolment/catalogue delivery, employee/PIN/branch authority, the offline POS application, shift closing, financial voids and ledger-derived reports are implemented. Conditional serials (OD-07), loyalty (OD-03), paid-outs/safe-drops/banking (OD-10), supplied production staff inputs and Windows signing remain outside the authorized default scope. Local verification does not prove Windows packaged execution, shop printing, staging or deployment. Earlier continuation sections below are historical snapshots; the final exit record supersedes their task state.

## Task status

| Slice/tasks | State | Evidence or remaining dependency |
|---|---|---|
| 6A T0 | Implemented and verified | All 24 contract amendments; executable consumed-name gate, with current Phase 5 interfaces and the 0118 review tail reconciled |
| 6A T1 | Implemented and verified | `@dulja/sync` message contract, bigint cursor codec, six focused tests and CI filter |
| 6A T2–T3 | Implemented and verified | 26 PostgreSQL 18 cases: revisions, tombstones, enrolment, commit ordering and migration round trips |
| 6A T9 | Implemented and verified | Catalogue resume acceptance 20 and outbox acknowledgement/retry regressions; sync package 32 cases |
| 6A T4 | Implemented and verified | 33 database cases including numbering, document/ledger posting, mirrors and privileges |
| 6A T5 | Implemented and verified | 41 PostgreSQL cases: permission catalogue, tender accounts, idempotent seed and role grants |
| 6A T6 | Implemented; focused checks pass | 36 enrolment/idempotency cases, 101 existing auth/session/e-invoice cases and 39 tenant-isolation cases; includes safe one-time-code replay correction |
| 6A T7–T8 | Implemented and verified | 30 production auth/catalogue/bypass cases, nine exact-decimal catalogue cases and 40 tenant-isolation cases; all thirteen workspace type checks passed |
| 6A T10 | Implemented and verified | POS seed policy, tender-method lift and shared stocked fixture; six policy cases and repository type/lint/format checks passed |
| 6A account-credit integration | Implemented and verified | Seven new exposure regressions, existing credit-control/column checks (28 total) and exact function restoration on down/up (one case) |
| 6A T11 | Implemented and verified | 35 ticket-apply cases cover posting, refusal isolation, credit exposure, historical/cumulative refunds, identities and quarantine ownership; final review adds correction-mirror source protection |
| 6A T12 | Implemented and verified | Signed push routes, quarantine listing/resolution, queued application and isolation pass; full worker matrix 64 plus two health cases; clean API matrix 693/73 files |
| 6A T13 | Implemented and verified | Acceptance 22: six real terminal/human API checks compare ledger, dimensions, stock costing and a genuine referenced refund |
| 6A T15 | Implemented and verified | Seven regression blocks, exact privilege/role/permission pins, full API/acceptance matrices and quality gates pass |
| 6A T14 | Conditional; pending | OD-07 serial-number scope remains unanswered; plan default excludes serials |
| 6C T0–T8 | Implemented and verified locally | Employee/PIN/policy/attendance schema, restrictive RLS, four permissions, snapshots, scoped APIs and provider-call proofs; broader matrices and focused corrections recorded below |
| 6C T9 | Implemented and verified | Strict current cashier/supervisor authority; branch limits; verifiable cash-rounding evidence and actual queued replay |
| 6C T10 | Implemented and verified locally | Branch-scoped endpoints, six regression appends, exact route/job/schema pins, settled acceptance matrix and focused broader-run corrections |
| 6C T11–T12 | Decision records complete; conditional runtime pending | Required supplied email and no production cashier seeds; OD-11/OD-12 records preserve the owner-input gates |
| 6C T13 | Implemented and verified locally | Staff/cashier/limits unit checks and actual local-API EN/AR Chromium keyboard workflows pass; screenshots inspected |
| 6B T0 | Implemented and verified locally | One shared portable signer and exact-body serializer; sync 57, API 15 and LEGACY-046 3 pass |
| 6B T1–T3 | Implemented and verified locally | Durable SQLite/version upgrade/embedded CJS, atomic mirrors and kind-qualified ACKs, device identity, exact-body transport and serial/rebind loops; 39 local cases pass |
| 6B T4 | Implemented and verified locally | PIN authority, malformed/wrong-branch refusal, 0063 item tax and three permissions; local POS 49, DB 43, API 37, contracts 61, 14 types and both lint checks pass |
| 6B T5 | Implemented and verified locally | Customer/branch/company prices, exact adjacent quantity breaks, unit prices, promotions, tax null/effectivity and shared arithmetic; local POS 71 and domain 301 pass |
| 6B T6 | Implemented and verified locally | UUIDv7 sales, strict base authority and supervisor cache checks, exact allocation, owned shift writes and actual outbox-write rollback; local POS 90, type/lint/rules pass |
| 6B T7 | Implemented and verified locally | Atomic tender completion, net cash settlement, original payload retention, verified rounding evidence and truthful receipts; 105 local cases pass |
| 6B T8 | Implemented and verified locally | Exact historical cumulative refunds without repricing/limit widening, pending customer lookup/ACK continuity, atomic account sales and actual outbox-write rollback; 123 local cases pass |
| 6B T9 | Implemented and verified locally | Fourteen strict main-process handlers, real PIN authority, isolated preload and built composition root; latest POS 145 and desktop 47 cases pass |
| 6B T10 | Implemented; Windows execution external | Separate unsigned Windows POS package, native dependency resolution, CI packaged-runtime and release checks; Linux build/composition proof passes |
| 6B T12 | Implemented and verified locally | Seven real offline acceptance cases: 500 sales plus shift-open accepted once, exact server totals and two harmless replays; eight hours simulated |
| 6B T11 | Implemented and verified locally | English/Arabic selling, return, receipt, recovery, cancellation and till controls use the actual main-process bridge. Step 6's acceptance test 23 POS half (`tests/e2e/pos-rtl-parity.spec.ts`, 2026-10-23) checks thirteen views in Chromium under the till's CSP in both directions (overflow, one numbering system, no untranslated string, the same things and figures in either language) and completes a sale by keyboard; it found, and now guards, a renderer that opened blank under that CSP and an Arabic shortcut hint that named the function keys "key 2" … "key 10" in Arabic-Indic digits |
| 6B T13–T14 | Conditional; pending | Windows certificate (OD-18) and loyalty scope (OD-03) remain external decisions |
| 6D T0–T8, T13 | Implemented; final verification | Migrations 0070/0072, scoped immutable events, atomic ledger-derived close/variance posting, financial voids, reports, signed reconciliation acceptance and regression/permission pins |
| 6D T9–T11 | Conditional; pending | OD-10 remains unanswered; no ADR 0064, migration 0071 or cash-lifecycle types created |
| 6D T12 | Implemented and verified locally | Real API English/Arabic shift register, Z-report detail and print media, filters/pagination and sales-by-cashier view; two Chromium cases pass |

## Verification of completed work

- Phase 5 exit plus tax and tax/e-invoice golden suites: **35 passed** in three files against PostgreSQL 18.
- Phase 6A contract/consumed-name gate: **passes**, all 24 amendments.
- `packages/sync`: **32 passed** (cursor six, catalogue resume ten, outbox sixteen). Tests first failed on the missing implementation; the extra bigint-boundary regression first failed on an out-of-range revision being accepted, then passed with symmetric encoding/decoding validation.
- Root type checking: **13/13 workspace tasks passed**; the focused sync type check also passes after the boundary fix.
- Root lint, all **11 repository lint rules** and root formatting check pass.
- Root build: both available build tasks, back office and desktop, pass. POS does not exist yet and no `pos.exe` build is claimed.
- Container manifest integration: **13 passed**, including all workspace manifests.
- `git diff --check` passes. Migrations 0059–0062 implement catalogue revisions/tombstones, terminal enrolment, POS document columns and permissions. Their focused PostgreSQL tests pass; no deployment is claimed.

The original plan's precision test compared a bigint converted to `number` with an already-rounded numeric literal, which would fail for the correct implementation. The test now compares `BigInt(Number(revision))` with the original bigint, proving the precision loss without using an inaccurate numeric expectation. The codec additionally rejects revisions above PostgreSQL's signed bigint maximum so an invalid cursor cannot reach SQL as an overflowing sequence value. The existing dependency lint already declares the exact sync tier; it was retained. CI now names the new workspace explicitly rather than leaving its tests unrun.

Catalogue resume acceptance 20, offline acceptance and ledger-derived Z-report reconciliation now have executed proofs. The offline interval is simulated, not eight hours of elapsed operation. See the final exit record for current evidence and limitations.

## Continuation — 2026-10-08

The saved edits survived the earlier workspace spend-cap interruption. The user requested continuation; Bun 1.4.2 and Docker 28.4.0 are available, and database checks resumed against PostgreSQL 18. No completion or deployment is implied by resuming.

The account-sale integration correction is implemented in migration 0061: tender-policy exposure subtracts line-rounded tenders from non-tender gross; the zero-valued account settlement leg cannot double gross. Fully paid customer sales add no credit and can issue on a credit hold, while positive account exposure retains hold, limit, pending claims and concurrent-party serialization. Seven new regressions plus existing credit-control/column tests pass (28 total). A separate rollback test proves both credit function bodies exactly match their pre-6A definitions after down and regain the amended definitions after up. The contract gate passes all 24 amendments.

Ticket-apply integration review also registers the existing posting JobClient as an optional server-only apply-context member and the trusted return-cost conversion path. Historical referenced-return tax uses verified source facts, without weakening new-sale code checks or claiming partial refunds are full reversals. The 6C branch-policy contract/ADR proposal is corrected before runtime implementation: role-scoped enrolment policy, company-bound transit lookup, and a separate restrictive document-line parent-visibility policy. Runtime proofs for these pending paths remain required.

The existing database tax and credit-note suites were checked after the historical-refund helper changes: 125 of 126 cases passed on the first run. The remaining assertion incorrectly required `tax_code` to carry only the audit trigger, although 6A intentionally adds its catalogue-revision trigger. Its query now selects the audit trigger explicitly and still asserts both tables carry it; all ten cases in that file pass on re-run. The nine-file tax/credit-note matrix is therefore green. The container integration suite also passes all thirteen cases, and CI now runs the persistent 6A contract gate.

The resumed domain suite passes all **297 cases in 28 files**. The persistent 6A contract gate remains green after registering POS full-reversal provenance, cumulative historical refund budgets, customer-ID collision refusal and owner-scoped needs-attention retries. These corrections are undergoing integration verification; later slices have not started.

The container-free contracts suite initially found its pinned shipped-error list missing the six registered 6A codes. The list and terminal/sync status assertions are now updated; **56 cases in four files pass**. Future 6C amendments are registered as documentation preparation, with A1/A15 preserving earlier provenance; this does not mark a 6C runtime task complete. Pricing prerequisite review confirms customer-specific price lists already exist in merged 0045, while the missing item-tax assignment is registered to 6B's allocated 0063 rather than modifying merged 0055.

## Continuation — 2026-10-09

Ticket apply passes 35 integration cases; focused route/worker/isolation checks also pass. The whole database run completed **1,530 passing / 10 failing cases in 158 files**. Eight files exposed expected Phase 6 completeness changes plus missing tender-account parent links. The existing profitability membership now includes POS_TICKET as its frozen contract requires; sale-policy exposure expectations include POS. Both affected suites pass **48 cases**. Six seed/enum/role suites passed **57 of 59** after updating exact shipped sets and restoring tender parents; the two remaining failures were a line-number collision introduced in the expanded enum fixture, corrected to a separate range and undergoing re-run. No invariant or constraint was removed.

A new signed-route integration test proves the existing profitability projection contains a sale of two units and a partial refund of one: remaining revenue **45.0450**, carrying cost **30.0000**, margin **15.0450**, with one net unit sold. The historical refund preserves the original inclusive-tax residue. Its first run passes; the repeated-rebuild stored-row assertion is strengthened for the final matrix. These are local PostgreSQL proofs, not deployment evidence.

The enum fixture now uses distinct line numbers and its eight cases pass. All eight failing files from the full database run are covered by green focused re-runs (**107 cases across those files**, including the final eight-case enum re-run); the other **150 files** were green in the original full run. This is combined verification of the **1,540-case database matrix**, not a claim that a second full run was executed. The strengthened POS profitability/repeated stored-row rebuild case passes. Root lint passes, and the eleven repository rules report **907 files / zero violations**. Type checking identified only unknown JSON response types in the newly written needs-attention tests; the owning task is fixing them before slice exit.

Acceptance 22 now passes all six cases through the production terminal and ordinary human document APIs. They compare nonempty ledger entries, branch dimensions and cost-consumption multisets, then prove a genuine referenced refund returns one unit at its original carrying cost. All thirteen workspace type checks and formatting pass after the final test additions. The worker matrix passes **64 cases in eleven files**, plus its two additive Bun health cases.

The needs-attention API passes five cases, including malformed-cursor rejection and paging two refusals from the same transaction exactly once. That paging test exposed postgres.js timestamp parameter serialization losing PostgreSQL microseconds; binding the timestamp as text before casting preserves the exact cursor. Both the output and comparison now keep six fractional digits.

Final lightweight matrix: sync **32/3 files**, edge **38/5 files**, desktop **37/5 files**; available back-office and desktop builds **2/2**. Referenced-return authority now restores verified original discounts without demanding new manual-discount permission; fresh sales/blind returns retain their checks, and forged source shares remain refused. The API and full acceptance/regression runs remain underway.

All seven existing contract gates (2C, 3D, 4A, 4B, 5A, 5B and 6A) pass after the registered integration corrections. Final lint, all eleven repository rules, formatting and thirteen workspace type checks pass.

The initial full API matrix completed **686 passed / six failed in 73 files (692 cases)**. All six are covered by green focused reruns: the document permission-stage pin, three OpenAPI assertions and two queue cursor cases loaded against earlier in-memory runtime modules. Node/Bun OpenAPI generation is now byte-identical after replacing circular header imports with their leaf module. A clean full API rerun is underway.

The initial full acceptance/regression matrix completed **609 passed / four failed / five skipped in 117 files (618 cases)**. The four failures are repaired with positive checks: exact human-admin/terminal role membership; the app_auth-only enrolment resolver’s role, operation and hash/expiry/redemption-bound function; apply-time ticket permission gates; and universal failure statuses through the actual Problem mapper. The two registered batch-wrapper codes keep status 200 inside batch results and surface as 422 if thrown as standalone errors. Focused checks pass **eleven role/permission cases** and **four resolver/error cases**; a clean full rerun is underway.

## Phase 6A local implementation exit

The clean final matrices pass: **API 693/73 files**, **acceptance/regression 613 passed plus five existing skips in 117 files**, **worker 64/11 files plus two health cases**, **sync 32/3**, **domain 297/28**, **contracts 61**, **edge 38/5**, **desktop 37/5**, and **back office 134/4**. The **1,540-case database matrix** is verified through its full run and green focused corrections as recorded above. Acceptance 20 and the six-case acceptance 22 proof pass; migration round trips and all 24 6A contract amendments pass. All thirteen workspace type checks, lint, eleven repository rules, formatting, both available build tasks and diff checks pass. No second full database run, Windows packaging, staging deployment or whole-phase completion is implied.

Implementation proceeds directly to 6C under the whole-phase instruction. Its registered linked-cashier identity projection supports catalogue login and attendance across different employee-home/credential branches while preserving ordinary employee-directory RLS. Actual 6C runtime proofs remain required.

6C progress: minimal employee and WASM Argon2id cashier credentials have focused
database proofs, including migration round trips and exact bigint revision strings.
The four-code permission/role change passes **72 cases in four files**, including
the full privilege/migration fingerprint round trip. The registered staff context
projection admits only actual company/BRANCH pairs under the four existing staff
authorities, leaving admin company/dimension endpoints gated. Its initial API
matrix passes four cases, including same-tenant company/type exclusion.
The branch-limit screen uses schema-checked requests and exact decimal percentage
conversion. Its EN/AR keyboard and decimal-entry matrix passes **five cases in two
files**. Staff/cashier screens, branch-isolation integration and later slices remain
in progress; these focused results do not establish a 6C or whole-phase exit.
The complete back-office matrix at the branch-limit milestone passes **139 cases
in six files**; staff-context isolation/auth bypass pass **56 cases in two files**.
Shared domain `roundToIncrement` now owns the registered server/till increment
arithmetic. Its signed-half, explicit-mode, near-half quotient precision and large
amount checks pass together with existing money/rounding cases (**23 cases in three
files**). Later cash-rounding evidence integration is not yet verified.

6C integration progress: the explicit legacy-fixture scope grants pass **34 cases
in five files** and **224 cases in 22 files** through the initial matrix plus its
eight-case R8 bystander correction. That correction grants branch visibility and
no financial permission. Frozen seed helpers remain unchanged. The independent
alternate-order employee migration test passes, including the exact restrictive
role clause and restoration of the complete schema fingerprint. The clean serial
back-office matrix passes **148 cases in seven files**; the shared domain matrix
passes **301 cases in 29 files**. The broader database run, actual API-backed staff
browser tests and later authority checks remain pending.

Additional 6C legacy-fixture corrections pass **38 cases in four files** (stock
count, warehouse, price-list and catalogue read), **19 party-ageing cases** and
**17 document-link cases**, retaining their original financial and cross-company
validator assertions. The two pre-6C policy-absence checks now require the actual
restrictive warehouse and optional-branch policies. Expiry write-off passes all
six cases after its fixture receives scope before seeding warehouses. The linked
cashier UI proof passes ten staff cases: a manager can identify and reset a live
credential using the bounded employee-number projection even when ordinary
employee-directory access is refused. Creation remains disabled without visible
employee choices. Actual browser tests and the broader matrices remain underway.

The actual local-API Chromium staff workflow passes in **both English and Arabic**:
employee creation/search/Enter/Escape, real AuthAdmin-seam onboarding, PIN blur
clearing and reset, and saving 10% as the exact wire fraction `0.100000`. Captured
branch-limit screenshots were visually inspected in both directions. The first
browser attempt exposed only test navigation (login's existing application-shell
entry must precede Employees); the corrected clean run passes both cases.

The initial broader matrices completed: database **1,533 passed / 25 failed / 40
skipped across 164 files**; acceptance/regression **602 passed / 17 failed / five
existing skips across 118 files**. Observed failures were older fixture scope or
pre-6C catalogue/policy assertions. All eleven failing database files now have
green focused corrections; the final two files pass **18 cases**, including
negative R2 checks that reach the guard through empty-code scope. All thirteen
failing acceptance/regression files pass **71 focused cases**, including unchanged
financial, tenant, override and actor-stamping assertions. A clean full rerun of
each matrix is underway. These counts are initial-run evidence, not final exits.

Final staff-screen verification passes **149 back-office cases in seven files**
and both actual-API Chromium locale workflows. Employee-directory, cashier PIN
panel and branch-limit screenshots were inspected in EN/LTR and AR/RTL, including
an empty focused PIN field. Contracts pass **61 cases in five files** after adding
the registered 6C limit-refusal code to the exact registry pin. Domain passes
**301 cases in 29 files**. The whole acceptance rerun picked up the newly added
T9 pg-boss rounding-evidence test while that runtime was still under development;
it is being completed and will be rerun against settled modules before slice exit.

6C T9 passes **48 API cases in three files** (12 rounding evidence cases plus
baseline/hardening apply checks) and **21 authority/real queued-apply cases in two
files**. Proofs include strict base grants, current branch limits, live supervisor
credentials, tight/zero manual-discount limits, forged evidence rejection and
queued replay with one posting. Thirteen type checks, lint and eleven repository
rules pass at this milestone. The whole regression rerun completed **618 passed,
two failed and five existing skips in 118 files**: the newly added queue case
loaded pre-change modules, and LEGACY-047 still inspected the former apply-local
permission loop. Queue replay is green against settled modules; LEGACY-047 now
verifies apply's delegation to the actual current-principal/company/branch loop
and retains the original override-trigger assertions (**three focused cases
pass**). A final settled run follows the remaining T10 appends.


6C T10's six appended regressions pass **23 cases in six files**. Actual branch
isolation passes **18 PostgreSQL cases**, including legitimately posted branch-B
receipts/issues and valuation rebuild. Standard Problem validation passes five
cases through the five existing 6A routers. Thirteen type checks, lint and eleven
repository rules pass; the staff UI build passes. CI now runs the persistent 6C
contract gate beside 6A. The running database matrix loaded a pre-T9 authority
module for its permission-registry assertion; a fresh current-code run passes
**all 29 permission-catalogue cases**. Full-run totals remain pending. Documentation
preparation registers the ten corrected 6B owning amendments; no 6B runtime task
has started before 6C integration finishes.


The broad 6C database rerun finished **1,608 passed / one failed / no skipped,
1,609 cases in 166 files**. The lone failure displays the pre-T9 non-null
`OVERRIDE_SUBJECT_FOR` entries for discount/blind-return/void; the current module
has all-null entries, and its complete 29-case permission-catalogue file passes
in a fresh process. This is the recorded broad run plus current-code correction,
not a claim that the broad process was wholly green. I18n passes **40 cases** and
shared UI **22 cases**. API accounting branch-guard fixtures retain exact 403
financial-code assertions by receiving only a separate empty-code visibility
assignment; focused accounting/stock-count checks pass **18 cases**.


The settled acceptance/regression matrix is clean: **667 passed plus five existing
skips (672 cases) in 121 files**. Current queue/branch/validation checks pass **21
cases in three files**, including invalid UUIDs before scoped gate SQL and real
sibling-company branch setup. Worker coverage passes all **69 Vitest cases** through
its 65-case broader run and four-case repaired collection suite, plus **two Bun
health cases**; this is combined current-code coverage, not a wholly green second
broad process. Final type/lint/rules/format/OpenAPI consistency checks pass. The API
matrix is completing; its observed accounting visibility fixtures are corrected
with focused proofs. The prepared persistent 6B gate passes its document/consumed-
name checks, using the actual Quantity path and the corrected 0063 long name.


All observed broader API accounting failures are corrected with current-code
coverage: **48 cases in three files** (review-4A six, document-count twelve,
invoices thirty). The original five-code invoice fixture grant now precedes its
warehouse seed; no permission or policy changed. The full API footer remains the
last 6C integration result pending before its local exit is recorded.


The broader API run finished **714 passed / eleven failed / thirty-five fixture
setup skips (760 cases) across 82 files**. Its six financial/tenant fixture files
now pass **75 focused cases** with unchanged assertions. The seventh failing file
is the exact OpenAPI route-list pin, which must include the nine newly mounted 6C
paths; that correction and its focused rerun are the last local-exit check. These
are transparent initial broader totals, not final wholly-green API totals.


6C local implementation exit is recorded in
[the slice review](../review/2026-10-09-phase-6c-exit.md). The final OpenAPI exact-path,
unsafe-header and committed-document checks pass **three cases**, bringing all
seven failing broader API files to **78 passing focused cases**. The whole-phase
instruction now proceeds serially to 6B T0; no merge, deployment or whole-phase
completion is claimed.


6B T0–T3 are verified locally. The shared signer passes 57 sync tests, 15 API
checks and LEGACY-046's three single-owner checks. The native SQLite workspace passes
39 recovery/sync/device tests; its embedded CJS opens from a temporary directory
outside the source tree with all 18 tables. Version-1 upgrades retain unsent
outbox/ticket rows and exact revisions; WAL uses FULL durability. Older catalogue
pages cannot regress rows or cursors. ACKs match kind and reference; completed
local tickets alone travel, while open/voided rows stay local. Manual/timer loops
share one serial tail and device replacement invalidates queued operations.
The encrypted identity is one value so partial storage cannot pair a new key
with an old terminal. CI includes this workspace and the persistent 6B gate.

T4's first verification passes 48 local POS cases, 43 DB cases and 37 API cases.
Migration 0063 adds nullable item tax selection and the three POS permissions.
The item API preserves explicit-null untaxed selection, validates active/effective
company tax ownership and round-trips the field. Server attendance now verifies
the attendance principal's own live clock grant, alongside credential/branch
checks, and refuses the entire ticket when absent. Only the narrow shared PIN
subpath is permitted from POS into DB; the PostgreSQL barrel remains forbidden.
Further T4 hardening and whole-phase work remain in progress.

## 6B T7–T9 corrections and evidence (2026-10-09)

Tender completion stores net settled cash locally and on the wire, retaining handed amounts and change for receipts. The actual SQLite outbox UPDATE failure rolls back completion and tender rows. Noncash and referenced returns skip fresh rounding; pinned null tax survives later catalogue edits. Receipt numbers remain null until real acknowledgement.

The T8 copied return path would have repriced historical tax and widened a cashier's price limit. It is replaced with source item/lot/unit matching, exact cumulative gross/net/discount shares and residual completion, original tax pins, nonvoided local reservations and a shared main-only persistence writer. Missing references cannot become blind returns. Customer ACKs retain locally created parties until the mirror arrives; account sales and quick-created customers roll back with an actual outbox write failure. The earlier T6/T7 tests' fabricated original references now exercise either a genuine completed source or an explicitly authorised blind return.

T9 uses fixed-decimal IPC amounts, strict request objects, sender checks, main-held cashier sessions and PIN-authenticated different supervisors. The copied MoneyJson-schema/string-handler mismatch and fourteen-method/thirteen-count mismatch are reconciled in the owning contract. Failed logins clear previous sessions; revoked/changed catalogue authority refuses subsequent operations. No auth-store access is exposed by POS preload. Receipt printing remains pending the actual rendered screen proof.

Logs: `/tmp/dulja-phase6b-t8-second.log` (123), `/tmp/dulja-phase6b-t9-pos-second.log` (128), `/tmp/dulja-phase6b-t9-build.log` (renderer, embedded CJS and preload built). The first desktop unit additions accidentally used Playwright's .spec suffix; they are corrected to .test so Vitest actually executes them. Their initial two failures and the Electron preference API type error are retained in `/tmp/dulja-phase6b-t9-desktop-second.log` and `...t9-types-third.log`; final reruns are pending. No Windows runtime, signing, feed deployment or Phase 6 exit is claimed.

## 6B local implementation exit (2026-10-09)

The completed implementation and precise limits are recorded in [the 6B review](../review/2026-10-09-phase-6b-exit.md). Final POS coverage is 138 tests/14 files; desktop 47/8; seven real 500-ticket offline/replay/ledger checks; nine pinned/regression checks. Every workspace type check, lint and custom rule passes. The actual signed catalogue acceptance exposed and fixed the principal-keyed cashier mirror mismatch, missed by the earlier synthetic local fixtures. Completed receipt snapshots retain both languages through item edits/tombstones. Main-process logout clears the session; unpaid recovery prevents a second draft through IPC.

T9's earlier desktop/type failures are resolved by the passing reruns; T10's separate Windows packaging and required CI runtime test are implemented, with actual Windows execution still unverified locally. No whole Phase 6 exit is claimed. 6D T0's contract gate initially found the copied nonexistent runSeed helper; the owning plan/gate now consume 0C's actual seed export. A1–A18 are registered, with OD-10 conditional amendments inactive. T1 is starting with failing schema tests.

## 6D T0–T6 continuation (2026-10-09)

T1 schema/isolation/reversal checks pass 28 cases in three files; the new shift/till-event tables have tenant composite keys, restrictive branch policies and immutable events. T2 registers only close_any/report.read with the intended branch-manager/auditor grants. The current T2 catalogue/role cases pass within T3's 65 passing DB cases; the remaining original count pin was corrected to the registered ten authority-map members. T3's additional hardening passes 13 open/identity/currency/credential/closed-shift checks; the real API batch and attachment suites pass 14 cases. Each POS fixture now owns a fresh shift id, avoiding the plan's global UUID collision across tenants.

T4's actual pack/loader checks pass five cases. Only 1130 and 5120 are seeded; only TILL_OVER_SHORT is added. T5 close integration passes fifteen cases: exact/over/short, dimensions/attribution, refunds, existing POS reversals, first-count replay, live close authority and real posting-failure rollback. The integration lives in the root tests workspace to preserve the existing DB dependency rule. POS store/shift/transport checks pass 32 cases, including actual close withholding until ticket/event acknowledgements. Root type/lint/custom-rule checks pass at the T5 correction (14 workspaces, 1,041 scanned files).

T6 replaces the unsupported event path. Its current eleven real event cases and ten original API batch cases pass. The copied void event only inserted an audit row and did not cancel the sale; the owning correction invokes the existing POS reverseDocument in the event savepoint, with live base authority, closed branch cap, different supervisor above the cap and a required reason. Order is now opens → tickets → events → closes. Additional financial replay/rollback assertions and final T6 checks remain in progress. Local draft cancellation and POS event controls still need their actual renderer/main implementation; no successful whole-phase exit is claimed.

## Whole-phase local exit — 2026-10-09

All authorized default implementation tasks are present across 6A, 6C, 6B and 6D. The final [6D exit record](../review/2026-10-09-phase-6d-exit.md) describes shift ownership, immutable till events, atomic ledger-derived closes, balanced variance posting, financial voids, manager authority, Z-report/sales-by-cashier APIs and actual EN/AR screens. It supersedes the historical pending-task statements above alongside the [6B](../review/2026-10-09-phase-6b-exit.md) and [6C](../review/2026-10-09-phase-6c-exit.md) local exits.

The final reconciliation/report/regression rerun passes **38 cases in five files**. The signed busy-day proof independently ties all tenders, expected cash, financial void, refund and the −1.5 variance to the ledger, and preserves every total on replay. The seven offline acceptance cases now accept **501 messages with zero rejection**: 500 real local tickets and their shift-open, applied once with two harmless replays. The eight-hour interval uses simulated timestamps; an elapsed eight-hour soak is not claimed. Two real API/Chromium EN/AR report workflows pass, with four screenshots and print-media assertions. POS 145, desktop 47 and infrastructure 25 cases pass; all fourteen type checks, lint, eleven custom rules over 1,051 files, formatting, generated OpenAPI and four Phase 6 contract gates pass. The built POS composition root opens eighteen tables and registers fourteen handlers outside the source checkout.

| Verification | Executed result and correction evidence |
|---|---|
| First root invariant/regression sweep | 721 passed, six failed, five existing skips / 732. Every failed file has a passing correction: catalogue 8, LEGACY-051 5, reports 10, branch scope 20, LEGACY-033 and LEGACY-047. The final combined reconciliation/authority/report regression run passes 38. |
| Second root sweep | 731 passed, one failed, five existing skips / 737 in 128 files. It loaded LEGACY-047 before its correction; all three corrected authority cases pass in the final 38-case combined rerun. No other failures. Settled coverage is 732 passing cases plus five existing skips, across the full process and rerun. |
| API sweep | 769 passed, four failed / 773; no skips. Corrected report/permission catalogue pins pass in the 24-case report/OpenAPI rerun; hardened batch fixtures with actual owned second-terminal shifts pass all 27; extended shift API passes seven. |
| DB correction reruns | Seed types 7, idempotence 5, branch isolation 15, phase pins 5 and combined chart/till-pack 13 pass. Chart verification found and fixed missing parent links for new 1130/5120 seed accounts; exact seed counts/table pins now include the new slice. |
| Leaf suites | Domain 301, contracts 61, sync 57, i18n 40, UI 22, backoffice 149, POS 145, desktop 47, edge 38, worker 69 plus two health cases, infrastructure 25 pass. |

The database sweep was started before its final corrections; its final totals are appended once complete. Passing corrections are recorded separately, rather than relabeling a process with failures as green. Earlier logs and original failures remain available in `/tmp`; the exit record lists the evidence paths.

Scope boundaries remain explicit: no conditional serials, loyalty or OD-10 paid-out/safe-drop/banking, no migration 0071 or 0073, no fourth cash stream, no ADR 0064, no unsupplied real staff/email bootstrap. ADRs 0054–0063 remain Proposed for formal review under the authorized implementation defaults. Windows packaged execution, certificate/signing, shop printers, production feed, staging/deployment, legacy screen parity and merge have not been performed. The required Windows packaged native-runtime CI check is configured.

## 6B T11 Step 6 — acceptance test 23's POS half (2026-10-23 plan-gap fix)

The 2026-10-23 plan audit found that Step 6's `tests/e2e/pos-rtl-parity.spec.ts` was not in the tree. The only RTL proof for the till was jsdom's `dir`, and jsdom does no layout. The spec now exists and runs in the ubuntu `e2e` job (`bun run e2e`).

- **What it runs.** `beforeAll` runs the two builds that `apps/desktop`'s `build:pos` begins with: `apps/pos` `build` and `build:main`. `tests/e2e/support/till.ts` serves `apps/pos/dist` on an ephemeral loopback port. Each request goes through the desktop's own `resolveRendererRequest`, and each response carries the desktop's `CONTENT_SECURITY_POLICY`. The viewport is the 1280×800 of `browserWindowOptions`. `window.dulja.pos` is answered by the built `pos-main.cjs`'s `openTill`, the module `main-pos.ts` loads, over the fourteen `POS_CHANNELS`. The page side uses the preload's `ERR_…: detail` rejection, and the binding is checked as `main-pos.ts`'s `allowEvent` checks it. The till is enrolled, in memory and offline, and has the renderer suite's catalogue and its `CASH`/`4821` cashier with a real Argon2id hash; the enrol form is measured on a second, unenrolled till.
- **What it asserts, in English and in Arabic.** `html` carries `dir` and `lang`, and an injected inline script is refused, which proves the CSP is in force. Eight views were checked in the first round (thirteen since the review repair, below): sign-in, open shift, sell after scanning `9001`, payment (F8), the receipt, price check (F2), customer (F4) and shift (F10), each closed with Escape. On each view, its labelled control is visible, no painted box lies outside the viewport on either side, and `scrollWidth ≤ clientWidth`. The box check exists because an overflow past the right edge of a right-to-left page is unreachable, so `scrollWidth` never reports it. The spec reads the receipt's column order off the screen. It completes a sale by keyboard alone: type, Enter, F8, select the amount and type 5, Tab to *Complete payment*, Enter. It then checks that the receipt shows the localized item name and the 1.65 change. A positive control proves the overflow measurement reports a 3000 px box in both directions. The spec also asserts that the page threw no error. Each view leaves a screenshot under `test-results/`.
- **What it found.** Under the till's own policy the built renderer opened blank. The barrel import of `@dulja/domain` bundled the posting and tax validators, and their Ajv schemas compile with `new Function` at load. `script-src 'self'` refuses that, so React never mounted. `pos-native-module.spec.ts` proves the CSP header arrives in the packaged till but never checks that the till renders, so nothing had seen this. The fix is at the cause, in `@dulja/domain`: its four Ajv validators (posting policy, document-type seed, tax pack, e-invoice profile) now compile on first use, once per process, not at import (`packages/domain/test/lazy-schemas.test.ts` fails on the eager code). With nothing compiled at import, the till's bundle also drops Ajv and every string evaluation by ordinary tree-shaking, and shrinks from 537.77 kB to 395.38 kB. The first round's fix, a side-effect-free hint in `apps/pos/vite.config.ts`, was removed as redundant. With the eager validators both cases fail; with the fix both pass. The deviation and the fix are recorded in the [reconciliation](../review/2026-10-07-phase-6-plan-reconciliation.md)'s 6B section.
- **Deviations from the plan's sample.** The till has state views, not `#/…` routes, so each view is reached by its key. The page runs in Playwright's Chromium against the built bundles, not `pos.exe` under `_electron`. The packaged till is Windows-only and starts unenrolled, so that launch remains CI's Windows `desktop` job. `tests/invariants/logical-properties.test.ts` also scans `apps/pos/src/renderer` now (three cases; `app.css` is in scope and has no physical property).
- **Executed (Linux, Chromium 1194).** The whole `e2e` suite passes **18/18** under the local Testcontainers stack, including both new cases. The logical-properties invariant passes 6/6, POS 228/228 in 16 files, and desktop 53/53. `tests` and `apps/pos` typecheck, `oxlint` reports nothing on the touched files, and the custom rules report 0 violations over 1,068 files.
- **Review repair (2026-10-23).** The independent review found that the header claimed `rtl-parity.spec.ts`'s checks while the spec made only the layout ones, and that four states were never measured. The spec now makes the back office's other checks too, on every view: the page's text uses one numbering system; no text node or accessible name is a string of the other catalogue that this one translates differently; and, switched to the other language on the same state by keyboard and back, the view shows the same number of each kind of element and the same figures, with each timestamp written that language's own way. It reads the order of the receipt date's year digits off the screen. It now also visits the enrol form of an unenrolled till (a second fixture, `openTill(…, { enrolled: false })`) and that form after a refused enrolment, the return mode with the sale's own ticket loaded back, the open supervisor approval, and the closed shift's summary (cash 3.35, closed by F10, the count and Enter): thirteen views in each language. Positive controls prove that a stray string of the other catalogue and an Arabic-Indic digit are reported. The header lists the states it still does not visit, and says Hijri is not exercised, as the back office's file does. The new checks found a real defect, and the Arabic catalogue is corrected. `pos.shortcuts` read "مفتاح ٢ للاستعلام · … · مفتاح ١٠ للوردية" ("key 2 for price check … key 10 for shift"). It sent an Arabic-reading cashier to the digit keys, which type into the scan field. It was also the only text on the till in Arabic-Indic digits, beside Western money, dates, revision and counts. It now reads "F2 للاستعلام عن السعر · F4 للعملاء · F8 للمراجعة · F10 للوردية · Esc للرجوع", naming the keys as they are printed, as the English does. With the old string, the Arabic case fails at its first signed-in view ("open-shift mixes numbering systems in ar"); with the new one, all four cases pass. Executed: the whole `e2e` suite passes **20/20** (Linux, Chromium 1194, Testcontainers); `packages/i18n` 40/40, POS 228/228, the logical-properties invariant 6/6; `tests` typechecks, `oxlint` reports nothing on the touched files and the custom rules report 0 violations over 1,069 files.
- **Not proven.** Windows packaged execution, a physical scanner and a printer are not proven. The back office had the same defect, and older than PR 12 (`main`'s build paints nothing under the same policy too); the domain fix covers it. Two more faults hid behind it and are fixed with it: `backoffice.exe` opened `dulja://app/index.html`, which the router answers with "Not Found", so `apps/desktop/src/main.ts` now opens the origin's root; and zod's caught `new Function` probe still reported a policy violation, so the back office sets zod's `jitless` before any schema is built (`apps/backoffice/src/lib/jitless.ts`, the server keeps the JIT). `tests/e2e/backoffice-csp.spec.ts` serves the built back office through the desktop's resolver under the desktop's policy and requires the sign-in screen in English and Arabic with no page error and no violation; it fails on the eager validators. Electron itself is not run on Linux; `posture.spec.ts` on CI's Windows job still checks only the header and the stylesheet.

## PR 12 integrated review (2026-10-23)

After the plan-gap groups were each fixed and reviewed, one review covered every change since PR 12's head `849e418`, in five areas, with an independent verifier trying to refute each finding. Fourteen findings came back; four were already fixed in the tree (verifier: stale) and ten were confirmed. Each code fix has a regression test that fails on the code before it.

- **A cancelled ticket came back (blocking, older than PR 12).** In `pos.exe` every bridge call settles on a later task, so React rendered between the cancel and the status read after it, and a status read taken before the cancel still named the ticket as open: its payment screen returned with every key and button refused until the till restarted. The renderer suite's bridge settled in microtasks and never showed that render. The screen now remembers the tickets it closed and never resumes one (`apps/pos/src/renderer/app.tsx`); the test runs the real handlers behind a bridge that answers on a later task.
- **The next shift's float and count were added to the last one's (blocking, older than PR 12).** The fields kept the previous figures and focus did not select them, so the documented key map ("type the float, Enter") turned 150 into 100150. Both reset after each open and close and select their text on focus, and the last close's summary is cleared when the next shift opens; the test runs two shifts in one session by keyboard and reads both rows back.
- **The Z-report printed the whole page in `backoffice.exe` (blocking, older than PR 12).** Its print rule was an inline `<style>`, which `style-src 'self'` refuses; it now lives in `apps/backoffice/src/app.css`. The e2e harness now serves the back office under `backoffice.exe`'s own policy (only `connect-src` widened to the loopback API and auth stub), so every back-office spec runs under the shipped script and style rules; `pos-z-report.spec.ts` fails with the inline rule.
- **Minor.** A Lock now clears the void's and the sale's approval fields (the signed-in cashier is part of the screen key); price check shows a promotion as its own figure between the list price and the total; the enrolment-code refusal says the code was not accepted and to check it first, because the server answers alike for a mistyped, expired or used code (LEGACY-025), and the runbook names which message each case gets; migration 0068's comments now say the in-transit exception admits the sending branch (comments only); AGENTS.md's owner register names every PR 12 amendment, 0061's actor switch among the security-control changes, and no longer lists a fixed behaviour as a defect; a test helper's comment names the URL each window opens.
- **A re-review of these fixes (same day).** Two lenses with verifiers confirmed ten minor findings, all fixed: the sale's supervisor approval now clears whenever the signed-in cashier changes (a sign-out main forces when the cashier's authority changes, not only a Lock); `backoffice.exe`'s start path is one constant (`BACKOFFICE_START_PATH`) that `main.ts`, a desktop test and `backoffice-csp.spec.ts` share; and the records above, AGENTS.md's register, ADR 0058 and the decisions record were corrected where they disagreed with the code.
- **Executed (2026-10-23, Linux, PostgreSQL 18 Testcontainers, Chromium 1194).** `packages/db` 1,677/1,677 in 172 files; `apps/api` 811/811 in 86; `apps/worker` 69 plus its two Bun cases; `tests` 751 passed, 6 skipped, 1 failed — test 15's PDF loses its hyphens under this container's Chromium and fails identically on `main`; `bun run e2e` 21/21 under the desktop policy; domain 310, contracts 63, sync 57, POS 241, i18n 41, UI 22, backoffice 194, edge 44, desktop 54, infra 25; typecheck in all fourteen workspaces, `lint`, the eleven custom rules over 1,070 files, `format:check`, the eleven contract gates, a regenerated `openapi.json` with no diff, and the back-office, desktop and POS builds. Windows packaged execution is CI's `desktop` job.

## OD-10 and the transfer amendment (2026-11-04)

The owner answered the open Phase 6 decisions on 2026-11-04, on branch `claude/laughing-gauss-0k185d`.

- **OD-03 loyalty — no** (`docs/decisions/od-03-6b-loyalty.md`) and **OD-07 serials — no** (`docs/decisions/od-07-serial-numbers.md`). 6B Task 14, 6A Task 14 and 3A Task 13 are closed as dropped; nothing in the tree changes.
- **OD-10 till cash — yes**, with four facts (`docs/owner/od-10/decision.md`): a cashier pays out up to the branch's `max_paid_out_amount` and a different supervisor holding `pos.ticket.override` approves above it (a branch with `paid_out_allowed = false` permits none); a safe drop is routine; a banking comes from the safe or the drawer, the cashier's pick; a paid-out needs a reference. The owner also approved the till screen: a Cash movement form on the Shift view (F10).
- **ADR 0043's 2026-10-23 amendment — accepted** with every recommended default.

**6D Tasks 9–11, built.** `TILL_PAID_OUT` (5130 / 1110), `TILL_SAFE_DROP` (1130 / 1110) and `TILL_BANKING` (1100 / 1130 from the safe, 1100 / 1110 from the drawer) post through `buildTillDocument` from a fourth sync array, `cashEvents`, applied between till events and closes with a savepoint per message (`packages/db/src/sync/till-cash.ts`, ADR 0064 proposed). The array is optional and the till sends it only when it has a cash event, so a three-array batch is unchanged; `cashEventResults` is always answered and a reader defaults it to `[]`. A paid-out approved above the limit records the supervisor's `pos.ticket.override` on the document, so 2B's override guard re-checks it as it does for a void. `5130` is seeded in `6d-till.json`. Migration `0071` adds `app.till_banking_link` (Form A, audited) and `reconciliation-till.ts` registers the `till_banking` `Reconcilable` source beside 4B's two without editing 4B's file. ADR 0063's expected cash needed no change: it reads the `1110` leg. On the till, schema version 3 adds a `cash_event` table and outbox kind (an older file's outbox is rebuilt under the new CHECK with every row kept), the close waits for unanswered cash events, and the F10 view carries the form in English and Arabic. Contracts amendments A13, A14 and A16 are now active (Plan Contracts, "Phase 6D owning amendments", 2026-11-04 note).

**ADR 0043's amendment, built (migration 0119).** A receipt is stamped and gated at its corridor's (the receiving) branch; Form A on `app.document` also admits reading a posted document whose `to_warehouse_id` is an in-transit warehouse of the actor's branch, writes unchanged; the `document_line` guard's WITH CHECK now needs a writable parent (without it the receiving branch could update a posted dispatch line's `cost`); the dispatch's create stage is gated at the source warehouse's branch; and `app.transfer_destination_branch`, an `app_auth`-owned `SECURITY DEFINER` lookup bounded to one column and to principals with a live role in the company, finds a destination's corridor that Form A″ hides from the sending branch. The "after 0068" pins in `packages/db/test/inventory/transfer-receipt.test.ts` (7 cases) and `apps/api/test/routes/accounting/document-transfer.test.ts` (3) now assert the new behaviour, each failing on the tree before it; a third branch still sees nothing, and 0119 round-trips up → down → up to an identical fingerprint.

**New and changed tests.** `tests/invariants/pos-till-cash.test.ts` (25: limits, supervisor override and self-approval, reference, branch policy, duplicates after close, savepoint isolation, expected cash, Z-report cash control, link rows, Form A) and `tests/invariants/pos-till-banking.test.ts` (6: test 39's till-banking clause — registered kind, unreconciled listing, match, reconciled balance equals ledger, unmatch alters no ledger entry, two tenants); till handler, outbox-upgrade and renderer cases in `apps/pos`; drain, contract and seed-pack cases; and the count pins that recorded OD-10 as absent (chart leaves, document types, branch policies, Reconcilable kinds, till tables), each updated to the new figure.

**Executed on the merged tree (2026-11-04, Linux, PostgreSQL 18 Testcontainers, Chromium 1243, Node 24).** Typecheck in all fourteen workspaces, `lint`, the eleven custom rules (0 violations over 1,077 files), `format:check`, the ten `contracts-*.sh` gates and `no-authority-literals.sh`, and a regenerated `openapi.json` with no diff beyond the additive `cashEvents`/`cashEventResults` members; `packages/db` 1,683/1,683 in 172 files (migrations up → down → up included); `apps/api` 812/812 in 86; `apps/worker` 69 plus its two Bun cases; `tests` 785 passed, 5 skipped, 1 failed — test 15's PDF loses its hyphens under this container's Chromium, as on `main`; `bun run e2e` 21/21, the till's F10 view with the new form measured in both directions; domain 310, contracts 65, sync 58, i18n 41, UI 22, POS 251, backoffice 194, desktop 54, edge 44, infra 25; and the back-office, desktop and POS builds. **Not verified:** Windows packaged execution (CI's `desktop` job), shop printers, staging and deployment. **Phase 6 has not exited**: OD-11 and OD-12 (6C T11–T12), OD-18 (6B T13), the Windows packaged run, staging (OD-19–OD-21) and the owner's approval of ADRs 0054–0064 remain.
