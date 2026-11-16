# Phase 2 — report against the definition of done

**Date:** 2026-09-19 · **Slices:** 2A (policy engine and parties), 2B (state machine, segregation of duties,
gapless numbering), 2C (print templates, attachments, the zero-code proof) · **Migrations:** 0017–0027 ·
**ADRs:** 0026, 0027, 0029–0033 · **Branch:** `claude/fervent-wright-2t2v3b`, 36 commits, one per plan task, then the review pass below (PR #5).
**Migrations, after the review pass:** 0017–0027 and 0105–0108 · **ADRs:** 0026, 0027, 0029–0033, 0087.

**Read "How this was verified" before the table.** Every row's State is qualified by one environment fact:
the machine this phase was built on has **no Docker daemon**, so no Testcontainers suite could be executed
here. What is claimed below is claimed at the strength it was actually proved. This is the same gap
`docs/reports/phase-1.md` recorded for Phase 1 and `CLAUDE.md` for Phase 0 — **Phase 2 is a phase built on
two unexited phases**, at the owner's direction to proceed, and that is recorded rather than smoothed over.

## Against the definition of done

spec:2288, verbatim: *"A new document type is added with zero code; issued numbers are unique and
gapless-provable."*

| Clause | Proved by | Slice | State |
|---|---|---|---|
| "A new document type is added with zero code" | `tests/invariants/zero-code-document-type.test.ts` (acceptance test 15, 11 cases: define through three API calls, number, post, print both directions, report, reverse, gapless, no `src/` mention) and `apps/api/test/routes/accounting/zero-code.test.ts` (8 cases) | 2C T10, 2A T13 | **written, unrun.** The two source-tree clauses hold by grep on this tree: no file under `apps/*/src` or `packages/*/src` names `CONSIGNMENT_RETURN`, and `reports.ts` names no consignment code. The nine clauses that need the API against Postgres have not been observed. |
| "issued numbers are unique and gapless-provable" | `app.series_gaps` (migration 0023), `tests/invariants/numbering-gapless.test.ts` (acceptance test 16, 8 cases), the gapless case of test 15 | 2B T4, T9; 2C T10 | **written, unrun** |

**No clause of the Phase 2 definition of done has been observed to pass.** The phase produced the code and
the tests for both clauses and executed neither.

### The acceptance tests this phase owns or extends

| Test | File | Slice | State |
|---|---|---|---|
| 10 approval authority, 31 segregation of duties | `tests/invariants/segregation-of-duties.test.ts` (9) | 2B | written, unrun |
| 12 tenant isolation | `tests/invariants/tenant-isolation.test.ts` — two cases added for `attachment` and `print_template` and the route-to-probe pin; probes for the four new route modules in `tests/invariants/probes.ts` | 2A, 2C | written, unrun |
| 13 audit completeness | `packages/db/test/attachment.test.ts`, `document-event.test.ts`, `party.test.ts` (audit rows on insert) | 2A–2C | written, unrun |
| **15 new document type, zero code** | above | **2C** | written, unrun |
| 16 numbering | above | 2B | written, unrun |
| 23 RTL/LTR parity, for PDFs | `apps/api/test/routes/accounting/print.test.ts` (12), `tests/regression/legacy-085.test.ts` 2C block; the pipeline behind them was **run here without a database** (below) | 2C | route suite unrun; pipeline verified |
| **25 zero-downtime migration** | `packages/db/test/expand-contract.test.ts` (6), `tests/regression/legacy-080.test.ts` 2C block (2) | **2C** | written, unrun |
| 27 no SQL text across the API | `scripts/lint/rules/no-sql-concat.ts`, `no-bare-db` | 0B | **green** (11 rules, 462 files, 0 violations) |
| 36 role catalogue integrity | `tests/invariants/role-catalogue.test.ts`; this phase adds two permission codes and touches two roles | 0D, 2A, 2B | written, unrun |

## How this was verified

**What ran, and passed, on 2026-09-19, against this branch's head:**

| Check | Result |
|---|---|
| `bun run lint` (oxlint) | clean |
| `bun run lint:rules` | 11 rules, 462 files, 0 violations |
| `bun run format:check` (oxfmt) | 568 files, all formatted |
| `bun run typecheck` | 12 of 12 workspaces clean |
| `packages/contracts` | 14 tests, 1 file — **after** fixing the pinned error-code list (below) |
| `packages/domain` | 128 tests, 16 files (Phase 1 had 81; this phase added the policy schema, `evaluatePolicy` and the print renderer) |
| `packages/i18n` | 31 tests, 3 files |
| `packages/ui` | 22 tests, 3 files |
| `apps/backoffice` | 117 tests, 3 files |
| `apps/edge` | 35 tests, 5 files |
| `apps/desktop` (vitest) | 37 tests, 5 files |
| `apps/worker` (`test:bun`) | 2 tests, 1 file |
| `apps/api`, the database-free cases only | 13 tests: the six engine-adapter cases against a **real headless Chromium**, the two `REPLAY_BY_RERUN` matcher cases, the five `markWriteFreeGate` boot-check cases |
| **Total executed** | **399 tests** |

**One check ran outside any committed suite and is recorded here because it is the only execution the
print path has had:** the seed `JOURNAL.standard.v1` template was composed, rendered through the domain
renderer with a model in each language, printed by the Chromium adapter and read back with `pdfText`. Both
directions round-tripped — the Arabic labels, the Hijri date and the amounts came back as written, and
`1000 · Cash` kept its order inside the RTL page once the account cell was bidi-isolated. That scratch file
was deleted, not committed; the committed `print.test.ts` asserts the same things through the API and has
not run.

**What did not run, and why.** `packages/db/test/harness.ts` starts a `PostgreSqlContainer("postgres:18")`
and there is no Docker daemon in this sandbox, so **every suite in `packages/db`, `apps/api` (bar the 13
above), `apps/worker` (vitest) and `tests` is unrunnable here.** `bun run e2e` was not run: it needs the
back-office dev server, and this phase shipped no screen. The exact `bun run test` figure `AGENTS.md` asks
for cannot be produced on this machine; the per-workspace figures above are what was produced.

**This phase created 34 test files and appended cases to 35 more, about 331 cases in all** (counted as
`it(`/`test(`/case-object entries in the phase's diff; the count is approximate for the regression files,
whose case objects are not all one line). By workspace: `packages/db` 137 in 22 files, `apps/api` 107 in 16,
`packages/domain` 47 in 6, `tests/invariants` 30 in 7, `tests/regression` 9 in 16 (many blocks appended by
`sliceRegression`, whose cases the count under-reads), `apps/edge` 1, `apps/worker` 0 (two pinned arrays
changed). **Of those, 60 executed** — the 47 domain cases and the 13 database-free API cases. They typecheck
against the real exports. A file that typechecks is not a file that passes.

## The review pass of 2026-09-19

After the exit commit a review of the Phase 2 diff found **fifteen defects**, and a second pass over the
Phase 0 and Phase 1 code it leans on found **sixteen more**. All thirty-one are fixed on this branch, in two
commits after the exit commit, and recorded in ADR 0087 where a decision was involved. None of them was
caught by a test that ran, because none of the tests that would have caught them has ever run.

**Phase 2 (fifteen).** Three let a caller act as someone else or reach another company's rows: any tenant
member could record an override or a transition *by* any principal who held the code (`attributedTo` was
trusted from the body — now a terminal's alone, spec:1324); a document could name a sibling company's party,
and a party a sibling company's settlement account (tenant-composite keys admitted both — now bound to the
path's company); the attachment list and download asked with a NULL branch while print and events asked at
the document's branch (now one map, one predicate, at the branch). Two routes were dead on every call:
`PUT …/lines` and `DELETE …/{id}` resolved a type named `""` because the gate read the body whenever the stage
was `create` (now the path decides). A template could reach the container's network and run script (now
scripts off, every request aborted, a bounded context). Replaced lines were tombstoned and printed as empty
rows (now deleted under 0023's grant). A print held a pooled connection for the whole render (write-free
routes now run outside the idempotency transaction). The rest: the Chromium launch never recovered from a
failure; the executable-path knob could not reach the container; a malformed multipart body was a 500; an
attachment's object was written inside the row's transaction with no timeout; `MODULE_READ_CODE` had two
spellings; the mustache resolver walked the prototype chain.

**Phase 0 and 1 (sixteen).** The worst: 1B's integrity-incident and month-end rows were inserted into
`app.audit_log` as `app_rw`, which 0001 revokes INSERT on — the nightly alarm failed with 42501 before it
reached Sentry, and its own tests (never run) asserted the row. Migration 0105 adds one SECURITY DEFINER door
for the two system events and the worker raises the alarm before it writes. Migrations 0106–0108 make the
schema hold what the API alone had held: a pinned posting-policy version is immutable (the seed's `do update`
could rewrite what a posted document was posted under); a closed period's dates cannot move and a reopen
needs a reason by any path; a ledger entry must fit its period; an assignment must name a member of the
tenant. In code: custom-field values are bound to the company on both the write and the read that steers a
posting; the posting service re-validates every planned account at post time; role-assignment branch ids,
custom-field definition ids and dimension-value parents are company-bound; the role-assignment list pages;
the identity-provider call is bounded and its 422 is the caller's conflict; the edge keys an IPv6 client on
its /64 and accepts only a well-formed `traceparent`; a zero rounding increment and an unknown time zone are
refused at the contract.

**Numbers.** Migrations **0105–0108** and ADR **0087** are allocated from the register's tail under §3.4.1's
proposed rule for a branch that is not a slice — the first use of it, recorded in the register — rather than
by taking a slice's reserved number as the Phase 0 review branch did. §3.4.8's `do update` sentence is
amended in the same PR.

**Verified, after the pass:** typecheck 12/12, oxlint, 11 rules on 471 files, format; `packages/contracts`
15, `packages/domain` 129, `apps/edge` 37, and 18 database-free `apps/api` cases (the engine sandbox and
crash-recovery cases among them). **Not verified:** everything else — `packages/db/test/review-guards.test.ts`
pins all four migrations and both service checks, and the route tests gained a case per finding, none of
which has run.

## Defects found by running what could run

Four things went wrong in the part of this phase that *did* execute, and each is a reason the unrun part is
not to be trusted until it runs:

1. **The contracts suite pinned the error-code count and failed.** `packages/contracts/test/contracts.test.ts`
   asserts every `ERRORS` key by name and the total by count. 2B added four codes and 2C one, and the suite
   was red from 2B Task 1 until the exit gate, because the per-task loop ran only the workspace each task
   touched directly. Fixed in the exit commit: the five names join `CODES_AFTER_0B` with their status
   spot-checks. A pinned registry should be run on every commit that touches its source; it was not.
2. **Playwright's pinned Chromium was not the sandbox's.** `playwright@1.63.0` looks for build 1243 and the
   host carries 1194. `CHROMIUM_EXECUTABLE_PATH`, optional like `SENTRY_DSN`, names a host binary; unset,
   Playwright launches its own. The container image and CI must carry a Chromium **and an Arabic-capable
   font** — the sandbox had DejaVu Sans, which shaped the Arabic; an image without one prints boxes.
3. **pdfjs reads Arabic as glyphs in visual order.** ADR 0016 measured this and the plan's `pdfText` ignored
   it: `getTextContent()` reads no `/ActualText`, so a shaped run arrives one presentation-form glyph per
   item, left to right. The reader now regroups items by baseline and position, reads an Arabic cluster right
   to left, folds NFKC, and returns **lines in reading order** rather than raw items. Every test that reads a
   PDF asserts on the joined text.
4. **A read-gated POST refuses to boot.** Contracts §4.5.9 freezes printing as a POST gated by the type's
   module *read* code, and Phase 0's `assertRouteGates` refuses an unsafe method gated by a `mutating: false`
   code — rightly. The plan said no change was needed; that was wrong. `markWriteFreeGate` is the declared
   exception, admitted on one kind of evidence: the route must be an unsafe method, carry codes, and be listed
   in `REPLAY_BY_RERUN`, so the two "write-free" declarations are checked against each other at boot. **This
   widens a Phase 0 security control and wants owner review**, as `membershipOnly()` did in Phase 1.

## Deviations from the three plans, recorded

Each is a place the plan's text could not be followed as written against the real tree or an accepted
decision. None re-opens a frozen contract; several want a one-line amendment (listed at the end).

- **Test-only document-type codes.** 2B's plan named `STRICT`, `BARE`, `LATE` and `LATE2`; contracts §4.14
  registers none of them and hazard 32 forbids inventing a code. `POLICY_TEST` and `POLICY_TEST_2` carry those
  roles.
- **The engine set is `{chromium}`.** 2C's plan pre-dated ADR 0016's verdict and described three codes and
  two adapters (Chromium and Typst) with `react-pdf` refused. ADR 0016's accepted Decision fixes the closed
  set as `{chromium}`; migration 0026's CHECK, the seed manifest type, `PrintEngineSchema`, `PrintEngineCode`
  and `PDF_ENGINES` all hold exactly that. The Typst adapter was not written. `ERR_PRINT_ENGINE_UNSUPPORTED`
  is kept because the API fails closed on the value it reads rather than trusting the CHECK; ADR 0032 says so.
- **`app.audit_log.action`**, lowercase, where the plans wrote `operation = 'DELETE'` / `'INSERT'`.
- **`ERR_OVERRIDE_NOT_AUTHORISED` is 403**, not the plan's 409: a second principal's authority is missing.
- **`grantCodes` after every `seedTenantV2`**: 24 call sites in 14 files, not the plan's 10 in 5 — 2B's rule
  R2 runs `app.actor_has` inside the posting transaction and every existing posting test needed the grant.
- **Worker integrity-check test** also pins `projections.checked`; both pinned arrays gained `document_series`.
- **Edge secrets** live in `apps/edge/src/container-env.ts` and `env.ts`; the plan named an `infra/src/secrets.ts`
  that does not exist. The four R2 names are there and the count is thirteen.
- **`markPermissionGate` accepts `readonly string[]`** (2B), so a gate resolved from data may name a code a later
  slice seeds; `isMutating` treats an unknown code as mutating, so the unsafe-method check is as strict as before.
- **`MODULE_READ_CODE` has two spellings**, both sanctioned by the contracts text: 2B's local map inside
  `documents.ts` for the events route, 2C's shared map in `require-attachment-read.ts` for attachments and
  printing. Merging them is a §4.5.8 amendment, not a plan decision, and is recommended below.
- **`DocumentStatus`** is declared in `packages/db/src/posting/lifecycle.ts`, not imported from a module that
  did not export it.
- **The seed template isolates mixed-script cells** with `dir="auto"` so `1000 · Cash` keeps its order on an
  RTL page; the plan's body had no isolation and the Arabic render showed `Cash · 1000`.
- **Task 9's unsupported-engine case drops and restores the CHECK** for one insert, because the CHECK admits
  `chromium` alone and the route must still fail closed on a row the CHECK would never have let in.
- **This report is `docs/reports/phase-2.md`**, following Phase 1, where the 2C plan named
  `docs/review/2026-09-05-phase-2-exit.md`. One record, not two.
- **`CLAUDE.md`'s "Current phase" was not written from the plan's template**, which read "Phase 2 is
  complete … acceptance tests passing". Nothing here has been observed to pass; the section says so.
- **The 2C contracts-name gate** (`scripts/check/contracts-2c-amendments.sh`, Task 0) passes on this tree; it
  is not wired into `bun run lint`, as the plan said.

## What passes

- The eight database-free workspaces, 399 tests, with the contracts registry re-pinned.
- Lint, the eleven repository rules, formatting and typecheck across twelve workspaces.
- The Chromium adapter against a real browser in both directions and all three paper sizes; the print
  pipeline end to end at the text layer, in English and Arabic, outside a committed suite.
- The boot-time gate check with the new marker: admits the print route, refuses the marker on a safe method,
  on a POST `REPLAY_BY_RERUN` does not list, and with no codes.
- Every migration `0017`–`0027` has a hand-written down file; `lintSchema` and the `up → down → up`
  fingerprint are asserted by suites that have not run.

## What does not pass, and where it closes

- **Both clauses of the definition of done** — written, unrun. Closes when the four DB-backed workspaces run
  anywhere at all and what they find is fixed. That is the project's largest single outstanding item, one edit
  to `.github/workflows/ci.yml`, and the owner's call, as the Windows-only decision was.
- **Plan 2C Task 12, the document list and entry screens** — blocked on **OD-24**, not failing. Phase 2's
  definition of done has no screen clause; `docs/ui/od-24-phase-2-screens.md` is the record and the file list.
- **Phase 0 and Phase 1 have not exited.** Their gates are unchanged by this work and still owed.

## Decided under ADR

| ADR | Title | Slice | Status |
|---|---|---|---|
| 0026 | the posting-policy schema in full | 2A | **proposed** — spec:95 |
| 0027 | posting-policy versions are append-only | 2A | **proposed** — spec:95 |
| 0029 | the document state machine lives in triggers; the API gate is a pre-flight | 2B | **proposed** — security and data model, spec:95 |
| 0030 | gapless numbering and draft-only deletion | 2B | **proposed** — grants a DELETE, spec:95 |
| 0031 | attachment storage: opaque server-generated keys and the `ObjectStore` port | 2C | **proposed** — security and data model, spec:95 |
| 0032 | print-template source format and the engine value set | 2C | accepted — consumes ADR 0016, never re-opens it |
| 0033 | expand/contract for a live table, and what "zero downtime" is asserted to mean | 2C | accepted |

ADR 0019 (desktop context bridge, Phase 0) is still proposed. ADR 0028 was allocated to 2A and left unused
under §3.4.1's rule that an unused number stays unused; `docs/adr/` runs 0026, 0027, 0029–0033 for this phase.

## Owner review wanted

1. **`markWriteFreeGate`** — a read code may gate an unsafe method when, and only when, `REPLAY_BY_RERUN`
   also declares the route write-free. It widens `assertRouteGates`, a Phase 0 review control. Five pure cases
   pin it; the reasoning is in `apps/api/src/middleware/require-permission.ts`.
2. **`markPermissionGate(handler, readonly string[])`** — the same control, widened by 2B for data-resolved
   gates.
3. **ADRs 0026, 0027, 0029, 0030 and 0031** are proposals that were implemented ahead of approval, as ADR
   0020 was, and say so in their own text. Two of this phase's seven ADRs are accepted on their own authority
   (0032 consumes an accepted ADR; 0033 is procedure); five wait on the owner.
4. **The deployment needs a Chromium and an Arabic-capable font in the API image** (ADR 0011's container);
   `CHROMIUM_EXECUTABLE_PATH` is the knob, and no plan has yet named the font package.

## What we are asking

1. **Run the four DB-backed workspaces somewhere.** Everything in the three DoD tables above is waiting on it.
2. **OD-24** — screenshots of the legacy document list and entry screens plus a two-minute operator
   description (`docs/owner/od-24/`). It unblocks 2C Task 12, 1B Task 11 and every later screen task.
3. **The Phase 0 and Phase 1 gates**, unchanged: OD-19–OD-22 and the runner.

## Contract amendments this phase owes, each one line

- §4.17.1: `pdfText(bytes)` returns the page's **lines in reading order**, not raw text items.
- §4.2.5 / §4.2.11: `markWriteFreeGate(handler, codes)` joins the gate markers; the boot rule admits a read
  code on an unsafe method only for a route `REPLAY_BY_RERUN` lists.
- §4.2.9: `REPLAY_BY_RERUN` is read by `assertRouteGates` as well as by the idempotency middleware;
  `isReplayByRerunPath(method, path)` is exported beside `isReplayByRerun(c)`.
- §4.5.9: the engine set is ADR 0016's `{chromium}`; `PrintEngineCode` is that one literal.
- §4.14: `POLICY_TEST` and `POLICY_TEST_2` carry the strict / bare / late roles 2B's plan gave to
  unregistered codes.
- §3.11: `CHROMIUM_EXECUTABLE_PATH` is optional configuration, not a secret, and is not in the thirteen.
- §4.5.8: the two `MODULE_READ_CODE` spellings should become one import — a recommended amendment, not done.
- Interface registry, names this phase defined: `markWriteFreeGate`, `isReplayByRerunPath`, `closeChromium`,
  `PDF_ENGINES`, `PDF_MAGIC`, `engineFor`, `DEFAULT_TEMPLATE_CODE`, `resolvePrintTemplate`,
  `loadPrintContext`, `renderDocumentSource`, `templatesLoader`, `SUB_PACK_DIRECTORIES`, `readPackText`,
  `PrintLangSchema`, `PrintDocumentBody`, `PrintTemplateSchema`, `CreatePrintTemplateBody`.

## The commits, one per task

| Slice | Tasks → commits |
|---|---|
| 2A | T1 `e9d2769` · T2 `7ca73a6` · T3 `cd674e7` · T4 `bed8932` · T5–6 `8c80979` · T7 `80ce193` · T8 `b0ef0b6` · T9 `98d27c3` · T10–11 `6b39290` · T12 `8ed0738` · T13 `437a498` · T14 `52d501b` · T15 `3c69c3f` |
| 2B | T1 `2cfe28f` · T2 `53f17ad` · T3 `92605b4` · T4 `18e2f05` · T5 `cee9fdc` · T6 `46934b4` · T7–8 `86f67da` · T9 `a9d1391` · T10 `8c93b28` · T11 `825de2e` |
| 2C | T0 `a557f7a` · T1 `188e7f7` · T2 `36efd43` · T3–4 `abc117f` · T5 `70c98ba` · T6 `626256d` · T7 `aa7937c` · T8 `aa9dbc0` · T9 `b43ff7d` · T10 `3cd2093` · T11 `aa21ec2` · T12 `8f1684b` (OD-24 record) · T13 the exit commit |

**What closes Phase 2**, in order: run the four DB-backed workspaces anywhere at all and fix what they find;
then OD-24 for Task 12; then, because a phase cannot exit before the phases under it, the Phase 0 and Phase 1
gates. **Next, once that passes: Phase 3 — inventory, slice 3A** (`docs/superpowers/plans/`), which adds the
`inventory` row of the §4.5.8 download map that 2C left as a default deny.
