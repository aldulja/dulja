# Phase 3 — report against the definition of done

**Date:** 2026-09-20 · **Slices:** 3A (item master, units, warehouses, lots, movements, stock on hand),
3B (costing engine, cost layers, recost, valuation), 3C (purchasing, GRNI, landed cost, purchase returns),
3D (sales orders, delivery orders, two-step transfers, stock counts, expiry write-off, three reports) ·
**Migrations:** 0028–0042 (0043 allocated and unused) · **ADRs:** 0034–0043 ·
**Branch:** `claude/charming-mendel-c363n5`, 25 commits on top of the Phase 2 merge `93d7bf2`.

**Read "How this was verified" before the tables.** Every State below is qualified by one environment fact:
the machine this phase was built on has a `docker` client and **no daemon** (`dial unix
/var/run/docker.sock: connect: no such file or directory`), so no Testcontainers suite could be executed
here. What is claimed is claimed at the strength it was actually proved. This is the same gap
`docs/reports/phase-2.md` recorded for Phase 2, `docs/reports/phase-1.md` for Phase 1 and `CLAUDE.md` for
Phase 0 — **Phase 3 is a phase built on three unexited phases**, at the owner's direction to proceed, and
that is recorded rather than smoothed over.

## The review pass (2026-09-20), and what it changed

Phase 2's exit ran an adversarial review over its own diff and found thirty-one defects. Phase 3 ran the
same shape: five reviewers over the whole diff from `93d7bf2`, then every finding handed to a separate
agent whose only job was to **refute** it. Twenty-eight findings were raised; seventeen were verified
before the session's agent budget ran out, and sixteen verifications did not run. **That is a real gap in
this review, not a clean bill of health** — eleven findings are unadjudicated and are listed in the
transcript rather than here.

One finding survived verification, and it is fixed in `377e9a4` with **migration 0109**.

**`app.document_link` bound its two DOCUMENT ids and neither of its LINE ids.** 0037 checks both document
statuses, and the API binds both documents to the path company — then the trigger reads the source line by
`id` alone. Every FK on the table is composite on `(tenant_id, x)`, and RLS is tenant-scoped, so a line id
belonging to a different **company** of the same tenant satisfied everything. A caller authorised only in
company A could consume company B's open quantity (denying B's own receipts with
`ERR_DOC_LINK_OVER_FULFILLED`), and the `priceFromSource` UPDATE — keyed on the two line ids alone — could
copy B's `unit_price` onto A's line, or onto a line of an already-**posted** document, because
`app.document_line` has no draft-only UPDATE guard. 0109 puts the ownership check in the trigger (spec:2173
wants the data layer to be the control) and the UPDATE carries the predicates itself, since it never
reaches that trigger. The number is taken from the register's tail under §3.4.1's rule for a branch that is
not a slice, as 0105–0108 were.

### The second round — the owner's `/code-review`, and what it fixed

After the first pass the owner ran two reviews of their own over the branch: one over the review-fix
commits, one over the whole phase. Together they raised eighteen findings. **Ten were real defects and are
fixed here** (migrations 0110–0112 and the TypeScript beside them); three are design limitations recorded
below rather than half-fixed; the rest were process and hygiene, also fixed. Each real defect is one that no
test in this tree could have caught, because the suites that would exercise it need a container.

| # | Defect | Fix |
|---|---|---|
| 1 | **0109 bound only line-to-line links to the company**, and via `document_line.company_id`, a column nothing binds to its document. A header-only link (4A's `settles` shape) with a source document from another company still passed. | **0110**: both document reads assert `d.company_id = new.company_id`; the line checks need only `document_id`. Four regression cases added. |
| 2 | **The near-expiry job failed every night it had anything to report.** `recordExpiryWarning` writes the `lot_expiry_warning` sentinel through `app.record_system_event`, and 0105 admits exactly two names. | **0111** admits the third. The list stays closed. |
| 3 | **FEFO picked expired lots first.** `pick_lots_fefo` ordered `expires_on asc` with no lower bound, so a sales order converted from an expired batch. | **0112**: `expires_on is null or expires_on >= current_date`. An expired lot is the write-off's to consume, never a pick's. |
| 4 | **A total-loss transfer receipt could not be drafted.** `least(arrived, expected)` was `0.000000` and `document_link` refuses `quantity = 0`, so the case `apply-movements.ts` documents was unreachable. | The link carries `quantity NULL` — the relationship with no fulfilled quantity, which the table admits. `FulfilmentLineInput.quantity` is `string \| null`. |
| 5 | **The generic line writer accepted `countedQuantity` and `expectedQuantity` from the client**, so a STOCK_COUNT could be built with an expected figure that never came from the projection — equal to the count (hiding shrinkage) or far above on-hand (creating stock at cost). | Both removed from `DocumentLineInput`; `.strict()` makes a body carrying either a 400. Their sole writers are `snapshotCountSheet`, `recordCounts` and `draftTransferReceipt`. |
| 6 | **Stock locks were per lot; cost layers are per (item, warehouse).** Two concurrent issues of one item from different lots took disjoint locks, both read the same open layers, and the last absolute `qty_remaining` write overwrote the other's consumption. | `lockStockKeys` takes a second key, `layers:<company>/<item>/<warehouse>`, sorted with the first. |
| 7 | **The replay took no stock locks**, so a document posted concurrently had its consumption overwritten by the batch flush. | Each replay batch calls `lockStockKeys` on the rows it touches before its first layer read. Transaction-scoped: a poster waits one batch, not the whole replay. |
| 8 | **`QuantitySchema` admits a leading minus**, and five body fields used it for a *requested* quantity. A dispatch of `-5` flipped the movement's direction — a branch clerk could pull another branch's in-transit goods into their own stock. | `PositiveQuantitySchema` for pick / link / dispatch / convert quantities; `NonNegativeQuantitySchema` for a counted figure, where zero is a real answer. |
| 9 | **`inventory.sales_by_item` counted a reversed delivery as delivered.** The reversal is itself a `DELIVERY_ORDER` with a positive movement, so `m.quantity < 0` kept the original and dropped the reversal. | Both sides of a reversal pair excluded (`status <> 'reversed'`, `reverses_document_id is null`). 4A's revenue extension inherits the corrected denominator. |
| 10 | **0109 was taken without amending the register**, which AGENTS.md and §3.4.1 make a precondition. | The register row for 0109–0112 is landed, and says the first number was taken late. |

Hygiene, also fixed: the `no-sql-concat` rule now exports `isCommentLine` and `legacy-036` imports it, so the
two cannot drift; `legacy-010`'s `document_line` exemption no longer applies to a line that also names a costing
table; the link route declares the 400 it can answer; the config test's R2 fixture is declared once, and
**the rule that made that suite red — the object store is required outside development — now has its own
case**, so loosening it is red rather than silently green.

**Recorded, not fixed — design limitations for the owner and for 4A/7B:**

- **A stock count's variance is against `stock_on_hand` frozen at sheet time, and nothing re-reads it at
  posting.** Every movement posted into the location between drawing the sheet and posting the count is
  double-counted into the variance. A system-enforced count freeze is a feature, not a fix; the runbook now
  carries the control ("freeze the location for the whole count") until one is built.
- **`COST_ADJUSTMENT` posts every recost delta between `5000` COGS and `1300` inventory**, whichever
  account the recosted issue originally hit. §4.7.3 names those two as "the company-wide fallback the replay
  job posts to when it is aggregating across items", so this is the contract as written — but a replayed
  expiry write-off's delta lands on COGS rather than `5100`, and a replayed transfer leaves `1310` stale.
  Posting the delta per original account is an ADR, not a patch.
- **`asAppError` is copy-pasted into five handler files**, and `snapshotCountSheet` issues one INSERT per
  stock key. Both are clean-up, neither is a defect.

### Five red cases in suites that need no container

Running what could run found five genuinely failing cases. Four were false positives and one was a real
break; each was fixed at the layer that was wrong.

| Case | Cause | Fixed by |
|---|---|---|
| `legacy-067` | **The check was right and Phase 3's code was wrong.** Its scan refuses `/PLAN\s*\(/i` in shipped source — how the legacy procedures pinned a query plan. `planMovements`' docstring read "the movement half of the plan (ADR 0035)". | Rewording the docstring. The check is untouched. |
| `legacy-010` | Demanded all four columns of §4.3.5's key on any ordering naming one, and caught two plain `app.document_line` reads ordered by `line_no` — that table's own natural order, not a costing dimension. | Excluding `document_line`; a movement, layer or consumption read still needs all four. |
| `legacy-036` | Grepped raw text for `.unsafe(` and matched a **comment** in `parties.ts` saying `.unsafe` is deliberately not used there. | Stripping comment lines, which is what `no-sql-concat` itself does. |
| `legacy-082` | Flagged `203.0.113.9` — RFC 5737 TEST-NET-3, the documentation range — in a **test**. The case's own title is "no shipped source". | Excluding the test tree. Shipped source still has nothing exempted. Introduced by the Phase 2 review pass. |
| `apps/api/test/config-and-auth.test.ts` | **A real break, red since 2C Task 2.** Making the R2 object store required outside development meant `readConfig` threw `R2_ACCOUNT_ID is required…` before reaching `createAuthAdmin`, so three cases' assertions about `SUPABASE_URL` tested nothing for two phases. | Supplying the four R2 names, restoring each case's actual subject. |

After these, **zero assertion failures remain anywhere in the `tests` workspace**. All 148 remaining
failures there are the container-runtime cascade from 26 suites that need Postgres.

**Executed and passing: 576** — contracts 17, domain 186, i18n 31, ui 22, backoffice 117, edge 37,
desktop 37, and 129 of the `tests` workspace's cases that start without a container.

## Against the definition of done

spec:2289, verbatim: *"Back-dated purchase recosts only forward, in bounded time, with a visible adjustment
entry; FEFO picking returns the earliest-expiring lot; a landed-cost allocation changes unit cost and every
downstream margin; a stock count posts only the variance; goods in transit are in neither warehouse's on-hand
and in the company's total."*

| Clause | Slice | Proved by | State |
|---|---|---|---|
| "Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry" | 3B | `packages/db/test/costing/replay.test.ts` (8), `cost-adjustment.test.ts` (5), `invalidate.ts`'s bounded restart; the last case of `tests/invariants/test-07-one-costing-answer.test.ts` — *"a BACK-DATED purchase recosts forward only, and all three tie-outs hold again afterwards"*; `tests/regression/legacy-004`, `legacy-054`, `legacy-060`, `legacy-062`; ADR 0038 | **written, unrun** |
| "FEFO picking returns the earliest-expiring lot" | 3A | `packages/db/test/inventory/fefo.test.ts` (11), `fulfilment.test.ts` (6), `delivery-order.test.ts` (6); ADR 0036 | **written, unrun** |
| "a landed-cost allocation changes unit cost and every downstream margin" | 3C | `packages/db/test/purchasing/landed-cost.test.ts` (16), `packages/db/test/landed-cost-allocation.test.ts` (11); test 7's case *"the landed cost is IN the tie-out — layer B's unit cost is 7.0000, not 5.0000"*; ADR 0041 | **written, unrun** |
| "a stock count posts only the variance" | 3D | `packages/db/test/inventory/stock-count.test.ts` (10), migration 0040's `counted_quantity`/`expected_quantity`, `packages/db/src/inventory/count.ts`; test 7's case *"the stock count posted ONE movement and did not disturb either tie-out"*; ADR 0042 | **written, unrun** |
| "goods in transit are in neither warehouse's on-hand and in the company's total" | 3D | `packages/db/test/inventory/transfer.test.ts` case *"THE DoD CLAUSE — in transit is in neither warehouse's on-hand and in the company's total"* (10 cases in the file), `transfer-receipt.test.ts` (11), and `packages/db/test/reports/inventory-reports.test.ts` case *"THE DoD CLAUSE, from the report's own output: shelves 10, transit 4, total 14"* (12 cases); ADR 0043 | **written, unrun** |

**No clause of the Phase 3 definition of done has been observed to pass.** All five are container-backed —
every one of them asserts against rows in Postgres — and there is no container here. The phase produced the
code and the tests for all five and executed none of them.

The weaker things that *were* proved, and are not the clauses:

- Both 3D document-type seed envelopes pass `validateDocumentTypeSeed` **and** `validatePolicy` against the
  frozen `posting-policy.schema.json`, and `assertRouteGates` accepts the application with every new
  sub-path mounted. That proves the configuration parses and the routes boot. It proves no ledger figure.
- `packages/domain`'s 186 cases include the whole costing engine (AVCO and FIFO layer consumption, the
  guards, the rounding) and `planMovements`/`applyConversion` as **pure functions**. The engine's arithmetic
  is therefore genuinely exercised; what is unexercised is every path that reaches it through SQL.
- `tests/golden/costing/` holds three committed fixtures with committed expected output. They run without a
  container — and **three of them are currently red**; see "Defects found by running what could run".

### The acceptance tests this phase owns or extends

| Test | File(s) | Slice | State |
|---|---|---|---|
| 5 back-dated costing | `packages/db/test/costing/replay.test.ts`, `cost-adjustment.test.ts`, `tests/golden/costing/avco-back-dated` | 3B | DB half written, unrun; the golden half **runs and is red** (below) |
| 6 costing edge cases | `packages/db/test/costing/layers.test.ts`, `method.test.ts`, `tests/golden/costing/avco-edge-cases`, `fifo-oldest-first` | 3B | same |
| **7 one costing answer** | `tests/invariants/test-07-one-costing-answer.test.ts` (10 cases: three tie-outs plus seven consequences) | **3D T11** | **written, unrun** |
| 18 stock availability | `tests/invariants/stock-availability.test.ts` (11 cases, four write paths plus the override door), `packages/db/test/inventory/delivery-order.test.ts` | 3A, re-run by 3D | written, unrun |
| 31 segregation of duties | `tests/invariants/segregation-of-duties.test.ts`, re-run over `STOCK_COUNT` in `packages/db/test/inventory/stock-count.test.ts` | 2B, 3D | written, unrun |
| 2 deterministic projections | `tests/invariants/projection-rebuild.test.ts` — extended for `stock_on_hand` and `cost_layer` | 1B, 3A, 3B | written, unrun |
| 12 tenant isolation | `tests/invariants/tenant-isolation.test.ts` and `probes.ts` — 3A adds the `inventory` route module, 3C and 3D add sub-paths on `documents` and `reports` and **no new module** | 0B, 3A, 3C, 3D | written, unrun |
| 13 attachment authorisation | `apps/api/test/routes/accounting/attachments-lot.test.ts`; the `inventory` row of §4.5.8's download map that 2C left a default deny; the lot rule in `require-attachment-read.ts` | 2C, 3A | route suite unrun; **the lot-gate unit is green** (3 cases) |
| 15 new document type, zero code | `tests/invariants/zero-code-document-type.test.ts` (extended), `apps/api/test/routes/accounting/document-count.test.ts` with `COUNT_TEST` | 2C, 3D | written, unrun |
| 23 RTL/LTR parity | `tests/e2e/inventory-transfers.spec.ts` — **does not exist**; 3D Task 13 shipped no screen (OD-24) and recorded the gate in `docs/ui/od-24-phase-3d-screens.md` instead | 0E, 3D | **not written** |
| 27 no SQL text across the API | `scripts/lint/rules/no-sql-concat.ts`, `no-bare-db` | 0B | **green** — 11 rules, 637 files, 0 violations |
| 36 role catalogue integrity | `packages/db/test/permission-catalogue.test.ts`, `roles-seed.test.ts`, `seed/permission-phase3d.test.ts` | 0D, 3A–3D | written, unrun |

## How this was verified

**What ran on 2026-09-20 against this branch's head, and its result.** Every figure here is a real run, not
a static count.

| Check | Result |
|---|---|
| `bun run lint` (oxlint) | clean, exit 0 |
| `bun run lint:rules` | **11 rules, 637 files, 0 violations** |
| `bun run format:check` (oxfmt) | **754 files, all formatted** |
| `bun run typecheck` | **12 of 12 workspaces clean** |
| `scripts/check/contracts-3d-amendments.sh` | `contracts-3d-amendments: ok`, exit 0 (this one **is** in CI, unlike 2C's) |
| `packages/contracts` | **17 passed** (1 file) |
| `packages/domain` | **186 passed** (22 files) — Phase 2 left 128 |
| `packages/i18n` | **31 passed** (3 files) |
| `packages/ui` | **22 passed** (3 files) |
| `apps/backoffice` | **117 passed** (3 files) |
| `apps/edge` | **37 passed** (5 files) |
| `apps/desktop` (vitest) | **37 passed** (5 files) |
| `apps/worker` (`test:bun`) | **2 passed** (1 file) |
| `apps/api`, the five container-free files | 26 executed: **24 passed, 2 failed** (`config-and-auth.test.ts` — a real defect, below) |
| `apps/api/test/print/engines.test.ts` | 8 executed: **4 passed, 4 failed** — the four failures are `browserType.launch: Executable doesn't exist`; this sandbox has no downloaded Playwright browser. Environmental, not a defect |
| `tests/invariants` ×3 + `tests/lint` ×4 (the container-free files) | **58 passed** |
| `tests/golden/costing.test.ts` | 7 executed: **4 passed, 3 failed** (stale fixtures — a real defect, below) |
| `tests/regression`, the 40 files that do not import the harness directly | 94 executed: **29 passed, 62 failed, 3 skipped** — 60 of the failures are `Could not find a working container runtime strategy` reached through `regression/support/*`; **2 are real** |
| **Executed and passing, all sources** | **568** |
| **Executed and failing** | **71** — 60 the container gap, 4 the missing browser binary, **7 real** |

Phase 2 recorded 399 passing on the same kind of run. The increase is mostly `packages/domain` (128 → 186,
the costing engine) and the discovery below.

**A correction to what earlier phases assumed is runnable.** Phase 2's report and `CLAUDE.md` both say the
whole `tests` workspace is unrunnable here. That is **not true** and was not checked: `tests/invariants`
(three files), `tests/lint` (four files) and `tests/golden` need no container at all, and 40 of the 78
`tests/regression` files do not import `harness.ts` directly — though most of those reach it anyway through
`regression/support/costing.ts` and `regression/support/api.ts`, which is why 60 of them still fail. **159
cases in `tests` were attempted here and 91 of them passed.** Three of the four real defects below were
found only because that assumption was tested instead of repeated.

**What did not run, and why.** `packages/db/test/harness.ts:34` starts a
`PostgreSqlContainer("postgres:18")`. There is no daemon, so **every suite in `packages/db`, most of
`apps/api`, `apps/worker`'s vitest suite and every `tests` file that reaches the harness is unrunnable
here.** `bun run e2e` was not run: it needs the back-office dev server, and this phase shipped no screen.
`bun run test:staging` skips itself without `STAGING_BASE_URL`. The exact `bun run test` figure `AGENTS.md`
asks for cannot be produced on this machine.

**Plan 3D Task 14 Step 4 — the staging re-seed — could not be attempted at all.** Both commands
(`seed --only chart-of-accounts`, `seed --only document-types`) need a database; the fallback the plan gives
("the same two commands against `startDb()`") needs the same container. Neither half ran. The seed files
themselves are present and parse: `chart-of-accounts/3d-adjustments.json` and the six 3D document-type
envelopes, which `validateDocumentTypeSeed` and `validatePolicy` accept without a database.

### What this phase wrote, and how much of it has executed

**Created 82 test files and appended cases to 35 more.** By static count of `it(`/`test(` at line start:
**518 cases in the new files and 119 appended to the modified ones — 637 in all.** The static count
under-reads any file that generates cases in a loop (`tests/golden/costing.test.ts` declares 3 and runs 7),
so treat 637 as a floor.

| Area | New test files | New cases |
|---|---|---|
| `packages/db/test` | 36 | 278 |
| `apps/api/test` | 14 | 112 |
| `packages/domain/test` | 6 | 54 |
| `tests/regression` | 21 | 45 |
| `tests/invariants` | 2 | 21 |
| `apps/worker/test` | 2 | 5 |
| `tests/golden` | 1 | 3 (7 at run time) |

**Of the 637, the ones that have executed are the `packages/domain` 54 and a handful of source-scanning
regression cases.** Everything in `packages/db/test` — 278 new cases, and 713 in that workspace altogether —
has never run. The four workspaces CI does not build hold **249 test files and about 1,438 cases**; roughly
**1,245 of them have never executed anywhere, in any phase.**

**A file that typechecks is not a file that passes.** Every assertion about a ledger figure, a cost layer,
an in-transit quantity, an RLS boundary, a trigger refusal or a migration's reversibility in this phase is
in that 1,245.

## Defects found by running what could run

Seven cases are genuinely red on this tree. Four were introduced by Phase 3; three are older and this
phase's exit run is simply the first time anyone looked. Per Task 14's own rule — *"if a re-run fails, the
fix belongs in the task that owns the code"* — **none of them is fixed here**; each is recorded against its
owning task.

1. **The three golden costing fixtures are stale, and have been since 3D Task 3.**
   `tests/golden/costing.test.ts` compares the evaluator's output against committed expected JSON.
   3D Task 3 added `fill: "cost"` to a planned ledger line (`packages/domain/src/posting/evaluate.ts:575`,
   ADR 0042) and the three fixtures written in 3B T10–T13 were never regenerated. The diff is **exactly six
   added `"fill": "cost"` keys across the three files and nothing else** — no amount, layer, consumption or
   ordering changed — so this is a fixture-maintenance miss, not a costing error. It is nonetheless the
   textbook failure mode a golden fixture exists to catch, and it sat red through three commits.
   **Owner: 3D Task 3.** The fix is `GOLDEN_WRITE=1` over the three cases and a reviewed diff, which is the
   procedure the file's own header describes.
2. **`tests/regression/legacy-010.test.ts` is red on 3C's landed-cost reader.** The scanner takes every
   `order by` line in `packages/db/src/costing` that names any part of §4.3.5's chronological key and
   demands all four columns. `packages/db/src/costing/landed-cost.ts:173` and `:288` read
   `from app.document_line where document_id = … order by line_no` — a line read, not a chronological
   costing ordering — and are caught by the `line_no` in the filter. Red since 3C Task 8.
   **Owner: 3B (which owns LEGACY-010) or 3C**; the honest fix is to narrow the scanner's filter so it matches
   only orderings over the movement/layer tables, not to loosen the four-column assertion.
3. **`tests/regression/legacy-082.test.ts` is red on a Phase 2 edit.**
   `apps/edge/test/rate-limit.test.ts:46` carries the literal `203.0.113.9` twice, added by the Phase 2
   review-pass commit `2e4691a` (the IPv6 /64 rate-limit finding). LEGACY-082's scanner walks
   `apps/`, `packages/` and `scripts/` including test files and allows only `0.0.0.0` and `127.0.0.1`.
   **Red since Phase 2 and unnoticed through the whole of Phase 3.** The address is TEST-NET-3 documentation
   space and is harmless in substance; the scanner is right that it is a hard-coded literal.
   **Owner: Phase 2's review branch.** Either the fixture moves behind a named constant the scanner's
   `ALLOWED` set knows, or `sourceFiles()`'s default roots stop including `**/test/**`.
4. **`apps/api/test/config-and-auth.test.ts` has been red since 2C Task 2.** Two cases build a config from a
   local `required` env bag that names no R2 variables, and 2C's `readConfig`
   (`apps/api/src/config.ts:52`) refuses to boot with `R2_ACCOUNT_ID is required when APP_ENV=staging —
   attachments have nowhere to go`. The `ConfigError` the cases expect (`SUPABASE_URL and
   SUPABASE_SERVICE_ROLE_KEY not set`) is never reached, because the R2 check fires first. Phase 2's exit
   run listed "13 database-free `apps/api` cases" — a hand-picked subset that did not include this file, so
   the regression was invisible. **Owner: Phase 2 (2C T2).** The fix is two names in the test's `required`
   bag; the production code is correct.

**The pattern is Phase 2's, one phase later:** a pinned or committed expectation goes red, the per-task loop
runs only the workspace the task touched directly, and nobody notices until an exit gate runs everything.
Items 3 and 4 are worse than Phase 2's equivalent, because they survived a whole further phase.

**One more thing worth naming, which is not a defect.** The four `print/engines.test.ts` failures are the
absence of a downloaded Playwright browser in *this* sandbox. Phase 2 ran those same four cases green
against a host Chromium and set `CHROMIUM_EXECUTABLE_PATH` for exactly this reason. The deployment
consequence Phase 2 recorded stands unchanged: **the API image needs a Chromium and an Arabic-capable font**,
and no plan has yet named the font package.

## Step 3 — the pinned lists this phase did not change, re-asserted

Three lists exist precisely so a slice cannot widen them quietly. Each is an **equality**, not a
containment.

| List | Check | Result |
|---|---|---|
| `app_rw`'s DELETE grants (§3.5.4) | new case in `packages/db/test/privileges.test.ts`: the list is still `["document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission"]` | **written, unrun** — needs the container. Phase 3 created fifteen tables and granted DELETE on none: every inventory row is append-only or a merged projection |
| `packages/db/src/lint-schema.ts`'s §3.5.3 membership sets | `git log --oneline -- packages/db/src/lint-schema.ts \| grep -c "3D T"` | **0** — 3D created no table, so it added no set membership |
| `3c-purchasing.json` not re-seeded by 3D | `git log --oneline -- …/3c-purchasing.json \| grep -c "3D T"` | **0** — `1310` and `5100` are asserted to resolve, never re-seeded |
| Migration `0043` unused | `ls packages/db/migrations/0043*` | **nothing** — allocated to 3D and left unused under §3.4.1's "unused numbers stay unused" |
| `DatasetId` union unchanged | grep over `packages/contracts/src` | **the name does not exist in the tree** — 7A creates that file, so "unchanged" holds trivially |
| `counted_quantity`'s sole writers | `grep -rn counted_quantity packages/db/src` less schema and `posting/load.ts` | **`inventory/count.ts` and `inventory/transfer.ts` write it** (the plan's expectation), plus one **prose-only** mention in a doc comment at `costing/apply-movements.ts:167`. No third writer |
| `bun run --cwd packages/db test lint-schema` | — | **could not run** (container) |

## What Phase 3 delivered, against spec:2289's scope sentence

Item by item. Every row is present in the tree; every row's *behaviour* is in the unrun 1,245.

| Scope item | Where it landed | Slice |
|---|---|---|
| Items | migration 0028, `packages/db/src/inventory/items.ts`, `apps/api/src/routes/inventory/items.ts` | 3A |
| Exact-rational UoM | 0028, `packages/domain/src/quantity/convert.ts`, conversion applied by trigger at line write; ADR 0036 | 3A |
| Warehouses | 0029 (tree with a one-CTE cycle check), `inventory/warehouses.ts` | 3A |
| Lots with expiry | 0029 and the per-item **sentinel lot** so `lot_id` is NOT NULL on every stock row; ADR 0034 | 3A |
| Variants | 0029 | 3A |
| Movements | 0031 `inventory_movement` + `stock_on_hand`, negative-stock refusal in the trigger, FEFO over the projection | 3A |
| Cost layers | 0034 `cost_layer`, `cost_consumption`, `stock_valuation`; the one engine in `packages/domain/src/costing/engine.ts`; ADRs 0037, 0039 | 3B |
| Landed cost through an import-shipment document | 0038 `landed_cost_allocation` (draft-only), `SHIPMENT.json`, `costing/landed-cost.ts` as the one place a receipt movement's value is decided; ADR 0041 | 3C |
| Sales and purchase orders, non-posting, open-quantity tracked | 0037 `document_link` + the `document_open_quantity` **view** (`security_invoker = true`), `PURCHASE_ORDER.json`, `SALES_ORDER.json`; ADR 0040 | 3C, 3D |
| Goods receipt with GRNI accrual | `GOODS_RECEIPT.json`, account `2150`, all legs `line.amount` under §4.3.4's pairing rule | 3C |
| Delivery orders | `DELIVERY_ORDER.json`, FEFO picking, back-orders left open, cost to `1250` | 3D |
| Certificates and permits attached per lot | the `inventory` row of §4.5.8's download map (2C's default deny), the lot rule in `require-attachment-read.ts`, `attachments-lot.test.ts` | 3A |
| Stock counts with variance posting | `STOCK_COUNT.json`, 0040's `counted_quantity`/`expected_quantity`, `inventory/count.ts`, variance to `5110` under `inventory.adjustment.approve`; ADR 0042; `docs/runbooks/stock-count.md` | 3D |
| Two-step inter-branch transfers with an in-transit state | `TRANSFER.json` + `TRANSFER_RECEIPT.json`, the in-transit warehouse and `1310`; ADR 0043 | 3D |
| Expiry write-off | `EXPIRY_WRITE_OFF.json`, drafted by a branch and approved by an accountant, `5100` tagged BRANCH | 3D |
| Free-of-charge lines | `costing: "zero"` through the engine; the step-9b zero guard widened to admit it (spec:1055) | 3B, 3C |
| Price lists | 0030 `price_list`, `price_list_line`, `promotion` | 3A |
| Valuation | `valuationAsOf`/`openLayersOf`, `stock_valuation` as an as-of snapshot with a nightly rebuild-and-compare, `COST_LAYER_CHECK` in the projection registry; ADR 0039 | 3B |
| Three minimal reports | `inventory.stock_on_hand`, `inventory.valuation`, `inventory.sales_by_item` — the third, fourth and fifth members of `ReportCodeSchema`, beside 1B's two; migration 0042's index | 3D |

### The two items deliberately **not** built

- **Serials — OD-07, default "not built" (spec:1032, 1310).** No `app.serial_unit` table, no DDL, no
  source reference. The reservation is executable: `packages/db/test/inventory/serial-unit.test.ts` asserts
  the table does **not** exist and that none of the three conditional regression files (`legacy-052`, `056`,
  `057`) has been created. If OD-07 comes back *yes*, that file's expectations flip, the DDL is **appended
  to `0029_create_warehouse_lot_variant.sql`** (no number of its own, per §2.4's 3A row), and 6A gains its
  two-terminal serial race as acceptance test 17.
- **BOM, consignment stock, dealer commissions, project/job costing — OD-08, default "names reserved
  only" (spec:1032).** `packages/db/test/inventory/reserved-names.test.ts` asserts that `bill_of_materials`,
  `bill_of_materials_line`, `consignment_holding`, `dealer_commission` and `job` exist in **no** schema, and
  documents the shape §4.6.1 would use for each if the answer changed. A capability needing one of them
  amends §4.6.1 first.

Both are Phase 10 reservations (spec:2282, 2296) and neither blocks anything.

## Owner decisions this phase ran on defaults for

`docs/owner/` **does not exist and never has, in any phase.** Every gate below was built at the register's
stated default and recorded rather than decided.

| Gate | Question | Default built | What changes if the answer differs |
|---|---|---|---|
| **OD-05** | every ⚠️ row of §3.0.3/§3.0.4 | spec text as written. 3A cites it per task (multi-unit items, batch/lot with expiry, multi-branch stock, price lists per customer type); 3C owns Landed cost and Purchase in foreign currency; 3D owns Multi-branch stock | `docs/decisions/od-05-3d-multi-branch-stock.md` is the decision record and names the revert set per alternative answer. 3C's half is recorded in its slice exit |
| **OD-06** | v1 costing method | `company.costing_method` default `'avco'` (migration 0035), FIFO built, tested and never defaulted | Flipping to FIFO is one literal in 0035 plus one assertion in `costing/method.test.ts`. **Removing FIFO** is the only branch that deletes: `legacy-055.test.ts`, the `'fifo'` CHECK label, and `costIssue`'s FIFO branch with its four cases. ADR 0037 is the proposal |
| **OD-07** | serial numbers in scope? | **not built** | `serial-unit.test.ts` flips; DDL appends to 0029; `legacy-052/056/057` are created by 3A; 6A gains test 17 |
| **OD-08** | BOM / consignment / commissions / project costing | **not built, names reserved** | `reserved-names.test.ts` is the reservation and lists each table's intended shape; §4.6.1 amends first |
| **OD-24** | screenshots + a two-minute operator walkthrough before any screen | **no screen built, in any phase** | `docs/ui/od-24-phase-3a-screens.md`, `od-24-phase-3c-screens.md` and `od-24-phase-3d-screens.md` each record the gate, the shipped endpoints the screens would consume, and the exact file list that changes when the material arrives. The 3D one is untracked on this tree |

**OD-24 now blocks five whole tasks across four phases:** 1B T11 (three accounting screens), 2C T12
(document list and entry), 3A T15, 3C T14 and 3D T13. Phase 3's definition of done has no screen clause, so
the phase's gate does not wait on it — but acceptance test 23's Phase 3 half
(`tests/e2e/inventory-transfers.spec.ts`) does not exist and cannot until it lands.

**The Phase 0, 1 and 2 gates are unchanged and still owed:** OD-04 (nine role names) · OD-18 (Windows
code-signing certificate) · OD-19 (Supabase organisation, PITR billing, the restore drill's staging half) ·
OD-20 (Cloudflare account and domain) · OD-21 (owner login, legal name, currency, fiscal-year start, service
role key — and the `pos_rounding_increment` question 6B settles) · OD-22 (Sentry organisation). OD-01 and
OD-02 remain formally unconfirmed and block nothing. Migration 0010's forward-only audit-hash window is
still open.

## Decided under ADR

| ADR | Title | Slice | Status |
|---|---|---|---|
| 0034 | the per-item sentinel lot, and why `lot_id` is NOT NULL on every stock row | 3A | **PROPOSED** — a primary-key shape and a NOT NULL on three stock tables, spec:95 |
| 0035 | movement planning belongs to the evaluator, and the provisional value rule | 3A | accepted — structural, no money/security/data-model consequence (§3.9) |
| 0036 | exact unit conversion at line write, and FEFO over the synchronous projection | 3A | accepted |
| 0037 | AVCO is the v1 costing method, and FIFO shares the same layer model | 3B | **PROPOSED** — money semantics, spec:95; OD-06 is the gate |
| 0038 | a recost is bounded, restartable and visible | 3B | **PROPOSED** — six decisions about what a cost correction does to posted money |
| 0039 | `stock_valuation` is an as-of snapshot; `cost_layer` is the checked projection | 3B | **PROPOSED** — the plan's inline draft read *Accepted*; the ADR says why that was not honest |
| 0040 | fulfilment is a link row; open quantity is a derived view | 3C | **PROPOSED** — the view is `security_invoker = true` and without it reads every tenant's orders |
| 0041 | landed-cost allocation, and how a purchase return is valued | 3C | **PROPOSED** — allocation half implemented behind it; the return-valuation half awaits the owner |
| 0042 | variance documents in the frozen posting-policy schema | 3D | **PROPOSED** — implemented behind it, as 0020, 0026 and 0041 were |
| 0043 | in-transit warehouse resolution and the two-step transfer protocol | 3D | accepted — a low-risk implementation choice, recorded and executed |

**Seven of the ten are proposals implemented ahead of approval**, each saying so in its own text, as ADR
0020 was and as Phase 2's 0026, 0027 and 0029–0031 were. Together with **ADR 0019** (desktop context bridge,
Phase 0) and Phase 2's five, **thirteen ADRs now await the owner.** ADR 0087 (the Phase 2 review
remediations) is also a proposal.

## The migrations

**0028–0042, fifteen in all, each with a hand-written `NNNN.down.sql`.** `0043` is allocated to 3D and
**unused**; under §3.4.1 it stays unused. Migrations `0003`, `0014`–`0015` (reserved to 0C) and `0028` in
the *ADR* register remain unused for the same reason.

| # | File | Slice |
|---|---|---|
| 0028 | `create_item_unit` | 3A |
| 0029 | `create_warehouse_lot_variant` | 3A |
| 0030 | `create_price_list_promotion` | 3A |
| 0031 | `create_movement_stock_on_hand_and_warehouse_lot_links` | 3A |
| 0032 | `alter_document_line_add_inventory_columns` | 3A |
| 0033 | `seed_permission_phase3a` | 3A |
| 0034 | `create_cost_layer_consumption_valuation` | 3B |
| 0035 | `alter_company_add_costing_method` | 3B |
| 0036 | `seed_permission_phase3b` | 3B |
| 0037 | `create_document_link` | 3C |
| 0038 | `create_landed_cost_allocation` | 3C |
| 0039 | `seed_permission_phase3c` | 3C |
| 0040 | `alter_document_line_add_counted_columns` | 3D |
| 0041 | `seed_permission_phase3d` | 3D |
| 0042 | `add_inventory_report_index` | 3D |

**Not one of the fifteen has been parsed by Postgres.** `up → down → up` reproducing the schema byte for
byte is asserted in `packages/db/test/privileges.test.ts` and has never run for any migration after 0002.

**Eleven document types** join `JOURNAL` as seed-pack configuration, no bespoke code: `PURCHASE_ORDER`,
`GOODS_RECEIPT`, `SHIPMENT`, `PURCHASE_RETURN`, `COST_ADJUSTMENT`, `SALES_ORDER`, `DELIVERY_ORDER`,
`TRANSFER`, `TRANSFER_RECEIPT`, `STOCK_COUNT`, `EXPIRY_WRITE_OFF`. **Thirteen `inventory.*` permission
codes** and **two `accounting.purchase.*`** plus `accounting.sales.create` are seeded with their role
grants, and §3.6.4's running grant sentence now records every one of them. **Six chart-of-accounts leaves**
were added across `3c-purchasing.json` (`2150`, `1310`, `5100`) and `3d-adjustments.json` (`1250`, `5110`).

## Pre-existing defects this phase surfaced in earlier phases' work

Phase 3 did not run a dedicated review pass the way Phase 2 did. What it did instead was consume Phase 0–2
code hard enough that several gaps fell out, each fixed in the slice that hit it and recorded in that
slice's commit rather than smoothed over.

1. **`loadSnapshot` hard-coded `costingMethod: "avco"`** with a comment promising 3B would fix it. 3B T4
   made it read `company.costing_method` — the last of the four fields §4.3.1 lists as 2A stubs.
2. **`tests/invariants/ledger-balance.test.ts` (1B) could never have passed once 3A landed.** It seeded
   `INV-1` on `app.item`'s default `track_lots = true` and then posted receipts carrying no lot, so
   `planMovements` would raise `ERR_POLICY_REQUIRES_MISSING` before the file's balance property ran.
   Pre-existing in form, found by 3B T7, fixed with `trackLots: false` and the reason on the line. It has
   still never executed.
3. **The tree was unpostable between 3B and 3C.** `planMovements` returns every movement with `value: null`
   and 3B's `costReceipt` raises `ERR_COST_VALUE_MISSING` on a null, so **no receipt could post at all**.
   3B T7 had improvised a private helper; 3C's `costing/landed-cost.ts` replaced it with §4.7.2's canonical
   four-branch rule, whose branch 4 returns null **explicitly** rather than defaulting to zero.
4. **`reverseDocument` did not copy `document_line.cost`.** `cost` is a magnitude, and without the copy a
   reversal of a stock issue — which emits a *receipt* of the returned goods — valued that receipt at the
   negated sale price instead of its carrying cost. 3C closed it. **The wider reversal-sign gap is still
   open**: `DELIVERY_ORDER`, `TRANSFER` and `EXPIRY_WRITE_OFF` all address `amount: "line.cost"` with a
   fixed `side`, and 3C copies `cost` unnegated, so a reversal's ledger legs land on the same side as the
   original. That is a 2A/3C reversal-mechanism gap, named in 3D's execution handoff, and **not fixed**.
5. **A cross-company link hole the 3C plan itself missed.** The plan bound only a fulfilment link's *target*
   document to the path company; the source was bound to the tenant alone, and `document_link`'s FKs are
   composite on `tenant_id` while 0037's trigger checks status and never company. A caller authorised for
   company A could link A's draft receipt against company B's purchase order, price A's line from B's, and
   consume B's open quantity. Bound to the path company; answers `ERR_NOT_FOUND`. **This is the same class
   AGENTS.md names and the Phase 2 review pass fixed three of** — which is evidence the class is not closed.
6. **3B's posting step 9 discarded what `applyMovements` returned**, re-reading `document_line.cost` and
   re-evaluating the policy. That cannot serve 3D: a two-quantity variance line took the matched value on
   all four legs, and a `TRANSFER_RECEIPT` where nothing arrived resolved every leg to zero, lost them all
   to the zero-drop, and would have **posted no ledger entry at all** while its issue leg emptied the
   in-transit corridor. 3D T4 posts the plan `applyMovements` hands back, and adds step 9a to re-balance it
   so Σdebit = Σcredit does not rest on §4.3.4's pairing rule being a convention the schema cannot enforce.
7. **Step 9b was fail-open twice.** 2A wrote the zero-value-COGS guard as `role === "policy" && isZero`,
   correct only while every pushed line was `"policy"`; 3B's `role: "cost"` tag would have made it match
   nothing. 3B widened it to the amount alone. Separately it had been deleted outright when the
   `applyMovements` call replaced it, which skipped it entirely for a policy addressing `line.cost` on a
   document planning no movements; it was restored after step 9.
8. **§3.6.4's running role-grant sentence had stopped at 2B.** 3A's and 3B's grants were in
   `packages/db/seed/roles.ts` and recorded nowhere. 3C T0 landed them — and caught, in the act of reading
   them out of the tree rather than the plan, that `inventory.cost.read` is **not** granted to `user`.
   **1B's `accounting.report.read → accountant, auditor` is still missing from that sentence.** It is 1B's
   to land and has not been.
9. **Migration 0031's filename in the 3D plan was an orphan.** 3A renamed the file and its own header
   flagged that the rename would orphan exactly the grep 3D would write. 3D T0's gate script is written
   against the real name with a comment saying why.
10. **`LEGACY-082` and `apps/api/test/config-and-auth.test.ts`** — red since Phase 2 and found only by this
    exit run. See "Defects found by running what could run" above. **Not fixed here.**

## Deviations from the four plans, recorded

Each is a place a plan's text could not be followed as written against the real tree or an accepted
decision. None re-opens a frozen contract.

- **This report is `docs/reports/phase-3.md`**, following Phases 1 and 2, where 3D T14 named
  `docs/review/2026-09-05-phase-3-exit.md`. One record, not two.
- **The plan's Step 1 and Step 2 commands name files that do not exist.**
  `tests/invariants/test-05-back-dated-costing.test.ts`, `test-06-costing-edges.test.ts` and
  `test-18-stock-availability.test.ts` were never created under those names; the work lives in
  `tests/golden/costing/` plus `packages/db/test/costing/*` (5 and 6) and
  `tests/invariants/stock-availability.test.ts` (18). The tables above name the real files.
- **`apps/api/test/routes/accounting/zero-code.test.ts` is `document-count.test.ts`** for 3D's `COUNT_TEST`
  re-run of acceptance test 15.
- **Task 14's `packages/db/test/privileges.test.ts` edit is an addition, not a re-assertion of an unchanged
  file** — 2C had already pinned the five-row list for 0027. The new case pins it against 3D by name, which
  is what §3.5.4's hazard 25 asks for; both cases now stand.
- **The `counted_quantity` grep returns three files, not two.** The third
  (`costing/apply-movements.ts:167`) is a doc comment, not a write. The plan's substance — two writers —
  holds.
- **3D Tasks 12 and 13 landed as records, uncommitted.** `docs/decisions/od-05-3d-multi-branch-stock.md`
  (T12) and `docs/ui/od-24-phase-3d-screens.md` (T13) are both complete and both untracked on this tree;
  they were written alongside this exit task and have not been committed. **Task 13 shipped no screen**, and
  `tests/e2e/inventory-transfers.spec.ts` does not exist: OD-24's material has never arrived, so what T13
  produced is the record of the gate, the way 1B, 2C, 3A and 3C each did — not the screens.
- **Step 4's staging re-seed could not be attempted**, either half. See above.
- **`CLAUDE.md`'s "Current phase" was not written from the plan's one-line template**, which reads
  "Phase 3 exit". Nothing here has been observed to pass and the section says so, as Phase 2's did.
- The slice-level deviations — `JobEnvelope`'s real shape, `asAppError` passing an `AppError` through,
  `grantCodes` beside `grantAdmin`, the link capped at `least(arrived, expected)` because 0037's trigger
  refuses `linked > ordered`, `expectedQuantity` projected out of **all three** count responses rather than
  only the read-back, `draftTransferReceipt` reading `final_warehouse_id` through `finalWarehouseOf`, the
  count routes living in `apps/api/src/inventory/count-handlers.ts`, and `shell: bash` on the Windows CI
  step — are each recorded in their own commit body and are not repeated here.

## What passes

- Lint, the eleven repository rules over 637 files, formatting over 754 files, and typecheck across twelve
  workspaces.
- **568 executed, passing test cases** across ten workspaces, including the whole costing engine as a pure
  function (186 in `packages/domain`) and 91 cases in `tests` that earlier phases assumed were unrunnable.
- `scripts/check/contracts-3d-amendments.sh`, **in CI**, exits 0: 3D's thirteen contract amendments are in
  the contracts document and every 3A/3B/3C export 3D consumes exists in the tree.
- Every new document-type envelope validates against the frozen posting-policy schema, and
  `assertRouteGates` accepts the application with every new route and sub-path mounted.
- The two OD-07/OD-08 reservations are executable assertions, not prose.

## What does not pass, and where it closes

- **All five clauses of the definition of done** — written, unrun. Closes when the four DB-backed
  workspaces run anywhere at all and what they find is fixed.
- **Seven red cases** — four of them defects this exit run found, three of them older. Each is recorded
  against its owning task above and none is fixed here, per Task 14's own rule.
- **Acceptance test 23's Phase 3 half** — not written, blocked on OD-24.
- **The staging re-seed and every owner-gated half** — `docs/owner/` does not exist.
- **Phases 0, 1 and 2 have not exited.** Their gates are unchanged by this work and still owed. A phase
  cannot exit before the phases under it.

## The runner gap, restated with Phase 3's arithmetic

CI is Windows-only by the owner's decision (`.github/workflows/ci.yml`), and a GitHub-hosted
`windows-latest` runner cannot start the Linux `postgres` image the Testcontainers suites need, so
`packages/db`, `apps/api`, `apps/worker`'s vitest suite and `tests` were removed from it. Phase 0 recorded
537 tests hidden by that decision, Phase 1 added 167, Phase 2 about 270. **Phase 3 wrote about 578 cases
into those four workspaces** — 464 in new files (`packages/db` 278, `apps/api` 112, `tests` 69,
`apps/worker` 5) and 114 appended (`packages/db` 82, `tests` 32) — **and a handful of the `tests` ones are
the only ones a machine has executed.** The four excluded workspaces now hold **249 test files and about
1,438 cases; 193 of them were attempted here without a container, 119 passed, and roughly 1,245 have never
executed anywhere, in any phase.** Phase 3's own visible total is 568 against Phase 2's 399, but most of
that rise is `packages/domain` plus the discovery that parts of `tests` were runnable all along — it is not
568 new proofs.

**Fixing this is the project's largest single outstanding item** — larger than any owner gate — and it is
one edit to one file. It is the owner's call, as the Windows-only decision was.

## Contract amendments this phase owes or inherits

3D's own thirteen are in and gated. Outstanding:

- **1B's `accounting.report.read → accountant, auditor`** is still missing from §3.6.4's running sentence.
  1B's to land (found by 3C T0).
- **Phase 2's `markWriteFreeGate` amendment (§4.2.5 / §4.2.11) has not landed** — the name appears nowhere
  in the contracts document, though `pdfText`'s §4.17.1 amendment did. Phase 2's list of eight is otherwise
  unverified here.
- **`LINK_ORDER` and `LCA_ISO` share the series `LO`** (3C). Harmless as written — different files,
  different tenants, `document_series` is per company — but a note, not a fix.

## What Phase 4 inherits

Written down here so 4A's author does not re-derive it:

1. **`1250` carries every delivered-not-invoiced cost** and is cleared by `SALES_INVOICE` when it is linked
   to the delivery through `document_link` (`linkFulfilment`, `linkKind: "fulfils"`).
2. **`inventory.sales_by_item` is one report code** with a `deliveredQuantity` and a `cost` column. At
   Phase 3 there is no revenue-posting type, so no sales value exists and none was invented; **4A adds
   `revenue` and `margin` to that same code and its same two files.**
3. **Acceptance test 7 is the cost side only**, for the same reason, and is **re-run by 7B against
   `item_profitability`** once 4A and 4B exist. Its three tie-outs are written so the first two are
   unchanged by revenue and only tie-out C gains columns.

## The commits

| Slice | Tasks → commits |
|---|---|
| 3A (15 tasks) | T1 `be19f18` · T2 `a608325` · T3 `eae5448` · T4 `33318f5` · T5 `ec9d800` · T6 `db003f5`, `a349717` · T7 `779e7b3` · T8 `754e3cd` · T9 `c8dd09e` · T10 `b0f5637` · T11–14 `4eb4d5e` · T15 `4ba3b22` (OD-24 record) |
| 3B (13 tasks) | T1 `7ba15e2` · T2–3 `f7a4f50` · T4 `49a4083` · T5–6 `7d13bb3` · T7 `98f35c0` · T10–13 `18d5fe4` |
| 3C (15 tasks) | T0–3 `f8e684c` · T4–8 `7fe8a48` · T9–14 `ece93ad` |
| 3D (15 tasks) | T0–3 `83c70dd` · T4–7 `49c85c7` · T8–11 `32c388c` · T12 and T13 **written, uncommitted** (a decision record and an OD-24 record; T13 ships no screen) · T14 this report |

**What closes Phase 3**, in order: run the four DB-backed workspaces anywhere at all and fix what they
find — starting with the seven cases already known to be red; then OD-24 for 3D Task 13 and acceptance test
23; then the OD-05/06/07/08 confirmations, which change little but are owed; then, because a phase cannot
exit before the phases under it, the Phase 0, 1 and 2 gates.

**Next, once that passes: Phase 4 — AR/AP, slice 4A.** Every plan for every phase is already written; the
catalogue and the frozen cross-plan contracts are in
`docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`. **Read that document before any plan.**
