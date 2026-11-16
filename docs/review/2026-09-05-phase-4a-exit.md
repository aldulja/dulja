# Slice 4A exit report: invoices, credit notes, receipts and payments, allocation, credit control

**Date:** 2026-09-28 · **Slice:** 4A (Phase 4) · **Branch:** `wip/4a` (not pushed) · **Tree measured:** the
working tree of the Task 14 commit, whose parent is `caf5503`. The branch also carries 4B's T0, T1, T2 and T6
commits, and every suite below ran over them too.

## The verdict, before the detail

- **Implemented:** 4A Tasks 0–11 are implemented. Task 12 is recorded as pending: the owner has not answered
  OD-05, and nothing is decided on the owner's behalf. Task 13 is blocked on OD-24, with no screen written.
- **Run for real:** every suite the slice owns ran against a real PostgreSQL 18 container in this sandbox. The
  results are the run table below: `packages/db` 917/917, `apps/api` 463/463, `apps/worker` 23/23 (+2 bun), `packages/domain` 198/198 and `packages/contracts` 17/17 are green. `tests` is 462 passed and **3 failed**, the three reds known before this task (below); **none is a 4A defect**.
- **Not in CI:** 4A's own acceptance clauses have **not** been observed green in CI. `.github/workflows/ci.yml`
  is Windows-only by the owner's decision, and cannot start the Linux `postgres` image. The four DB-backed
  workspaces (`packages/db`, `apps/api`, `apps/worker`, `tests`) are absent from it, as `AGENTS.md` records for
  Phases 0–3. CI does run the three gates `contracts-3d/4a/4b-amendments.sh`, lint, `lint:rules` and
  typecheck. The plan's "every row above green in CI" is therefore met in this sandbox and **unmet in CI**.
  Restoring the four workspaces to CI is the owner's call.
- **Not Phase 4's definition of done.** Both sentences of spec:2290 are verified in 4B.

## The exit table (Plan 4A Task 14 Step 5)

| Clause | Where it is proved | Status here |
|---|---|---|
| Allocation refuses an over-allocation both ways; `openBalance` returns after `unallocate` | Task 9, `packages/db/test/ar-ap/allocation.test.ts` (+ `apps/api/test/routes/accounting/allocations.test.ts`) | green |
| Credit limits: refusal, second-principal override, non-overridable hold | Task 3, `packages/db/test/ar-ap/credit-control.test.ts` (16 cases, over `CREDIT_TEST`); Task 5, the credit-control case of `ar-ap/sales-invoice.test.ts` (on the real `SALES_INVOICE`); `tests/regression/sah-042.test.ts` 4A block | green, at the **OD-05 default** (pending, `docs/decisions/od-05-4a-credit-control.md`) |
| Payment terms: pinned on the document, due date derived | Task 1, `ar-ap/payment-term.test.ts`; Task 5, the pinned-term case of `ar-ap/sales-invoice.test.ts` | green |
| `1250` nets to zero across a delivery and its invoice | Task 6, `ar-ap/invoice-conversion.test.ts` (residue case included) | green |
| `2150` nets to zero across a receipt and its invoice | Task 7, `ar-ap/purchase-invoice.test.ts` (residue and USD cases included) | green |
| A credit note is the invoice's reversal target and posts the opposite | Task 8, `ar-ap/credit-note.test.ts`, `ar-ap/stock-return.test.ts` | green |
| Money in needs one principal, money out needs two | Task 10, `ar-ap/settlement.test.ts`, `apps/api/test/routes/accounting/settlements.test.ts` (tests 10 and 31) | green |
| `inventory.sales_by_item` carries revenue and margin under the same code | Task 11, `packages/db/test/reports/sales-by-item-revenue.test.ts`; 3D's report suites re-run unchanged | green |
| Tests 10, 14, 31 re-run; tests 1, 12, 13, 27, 36 re-run over this slice's rows (**not 2 or 15**: §6.1 assigns neither to 4A) | see "The re-run matrix" below | green |
| `lintSchema` zero; DELETE list unchanged; `app.series_gaps` empty for `INV`, `CN`, `PINV`, `PCN`, `RCT`, `PAY-OUT` | Task 14: `packages/db/test/schema-lint.test.ts` and `bun run --cwd packages/db db:lint`; `packages/db/test/privileges.test.ts` (4A case); `tests/invariants/ledger-balance.test.ts` (4A describe, second case) | green |
| The trial balance equals the sum of `ledger_entry` for every company the suite touched | `tests/invariants/ledger-balance.test.ts` 4A describe, after every one of 200 generated documents: Σ `base_debit` = Σ `base_credit` for the company, and `checkLedgerBalance` (1B) empty per (company, fiscal period) and per document | green |

## Commands run (Step 4) and their output

Every workspace was run in full, with no filter. The DB-backed suites ran against `postgres:18` through
Testcontainers.

| Command | Result |
|---|---|
| `packages/db` vitest, `--fileParallelism --maxWorkers=3` | **106 files passed (106) · 917 tests passed (917)** |
| `apps/api` vitest, `--maxWorkers=2` | **54 files passed (54) · 463 tests passed (463)** |
| `apps/worker` `test` (vitest, then `bun test test/health.test.ts`) | **vitest 6 files passed · 23 tests passed; `bun test` 2 pass, 0 fail** |
| `tests` vitest (serial, its own config) | **98 files passed, 3 failed, 1 skipped (102) · 462 tests passed, 3 failed, 5 skipped (470)**. The three reds are the three known ones below. The skips are pre-existing: `sah-024` is `it.skip` pending OD-27, and the rest are `restore-drill`'s capture/verify modes and `sah-087`'s build-gated cases |
| `packages/domain` vitest | **23 files passed · 198 tests passed** |
| `packages/contracts` vitest | **1 file passed · 17 tests passed** |
| `bun run lint` (oxlint) | exit 0 |
| `bun run lint:rules` | `11 rules, 700 files, 0 violations` |
| `bun run format:check` | exit 0 |
| `bun run typecheck` | `12 successful, 12 total` |
| `bun run --cwd packages/contracts openapi:generate` then `git diff --exit-code packages/contracts/openapi.json` | regenerated, **no diff** (exit 0) |
| `bash scripts/check/contracts-2c-amendments.sh` / `-3d-` / `-4a-` / `-4b-` | all four exit 0 (`contracts-3d-amendments: ok`, `contracts-4a-amendments: ok`, `contracts-4b: OK`) |
| `bun run --cwd packages/db db:lint` (the CLI, over a fresh container migrated `up` by the CLI) | `schema lint: 0 violations` (applied: 1, 2, 4–42, 44–49, 52, 105–112) |

**Not run:** `bun run e2e` (no 4A spec exists; Task 13 is blocked), `test:staging` (it skips without its three
URLs, so a green run would prove nothing), and `bun run --cwd apps/desktop test:electron`.

## The re-run matrix

| Test | 4A's share | Where |
|---|---|---|
| **1** Ledger invariant | 200 fast-check documents over the six types. Each is posted through the real `postDocument`, with `PAYMENT` through two principals and the credit notes through `creditNoteFrom`. Currency MYR or EUR at a rate in [0.5, 9.5] to 8 dp, a date anywhere in 2026, 1–5 product / service / charge lines, and a copied cost in [0, amount] on a sales product line. After each document: Σ base = 0 for the company, `checkLedgerBalance` is empty per period and per document, and no line breaks base = round(value × rate, 4). The last assertion is test 8's share, which is 4A's | `tests/invariants/ledger-balance.test.ts`, 4A describe (about 38 s for 200 runs) |
| **10** Approval authority | `PAYMENT`'s approve/post pair, through the service, `app_rw` SQL and HTTP | Task 10: `ar-ap/settlement.test.ts`, `settlements.test.ts` |
| **12** Tenant isolation | one new module (`payment-terms`) and one `PROBES` key; the eight sub-paths inherit their modules' keys | `tests/invariants/tenant-isolation.test.ts`; plus a two-tenant case in each DB suite for `payment_term` and `allocation` |
| **13** Audit completeness | the two new tables are audited, and an un-allocation's reason is in the audit image | `ar-ap/payment-term.test.ts` ("every write is audited"); `ar-ap/allocation.test.ts` (reason from `audit_log.after`); `sah-041` 4A block (`audit_row` enabled); `lintSchema` |
| **14** Permission query | one query against the complete accounting catalogue, `PURCHASE_RETURN` included, over two principals holding the SEEDED accountant and user grants | Task 11, `packages/db/test/seed/permission-phase4a.test.ts` |
| **27** No SQL text across the API | the lint rules over 4A's files | `bun run lint:rules`, 0 violations |
| **31** Segregation of duties | R1/R2 on `PAYMENT` | Task 10 (as test 10) |
| **36** Role catalogue integrity | seven codes on three roles; R6's `payment.create`/`payment.approve` pair is live for the first time (the pair is split across `user` and `accountant`); R7 auditor holds none | Task 2, `permission-phase4a.test.ts`, `permission-catalogue.test.ts`, `roles-seed.test.ts`, `seed-roles.test.ts`, `tests/invariants/role-catalogue.test.ts`, `tests/lint/role-seed.test.ts` |

`SAH-###` files touched by 4A:

- created: `sah-014`
- appended with a 4A block: `sah-011`, `sah-012` (both at Task 14), `sah-017`, `sah-018`, `sah-019`, `sah-031`,
  `sah-041`, `sah-042`

## Deviations from the plan, by task

Each commit body has the full list. These are the ones a reader of the plan needs.

- **Every 4A service takes `companyId`**, and `unallocate` also takes the path's `settlementDocumentId`
  (T1, T6, T8, T9, T10). The reason is `AGENTS.md`'s company-binding rule: RLS bounds the tenant only. The
  contract amendment lands in this commit (below).
- **Service errors are coded objects the API lifts** (T1's `ItemAccountUnresolvedError` shape).
  `ERR_VALIDATION_FAILED` is 400 in `ERRORS`, so an over-allocation is 400, not the plan's 422 (T9, T10).
- **Contracts modules are plain zod, with no `.openapi("Name")`**, so there are no OpenAPI components (T1, T6,
  T8, T9, T10). Route suites use `startApi` + `grantCodes`, because `grantAdmin` grants no accounting code, and
  `ROUTES` rather than `PROBES`, because of the dependency rule.
- **T4:** `postDocument` now calls `applyMovements` on every plan, as §4.3.2 step 9's frozen text says, so the
  unfilled-cost refusal reaches an `effect: "none"` policy. ADR 0045 records one open question: a policy that
  already picks its side with `line.quantity_sign` would be flipped twice. Nothing reaches that combination.
- **T6 conversion:**
  - The route has **two gates**: the source's `"submit"`, and the target type's `create` in the handler.
  - The residue is taken when Σ converted + this = the source quantity.
  - A delivery line with amount 0 is priced round(price × qty, 4) − discount. 3D writes amount 0 on delivery
    lines, and copying that would invoice no revenue.
  - Source lines are locked before the read.
- **T7:** the freight case's expected sign was wrong (−40.0000, not +40.0000). The residue and USD-shipment
  cases were added.
- **T8 credit notes:**
  - The completing credit takes the residue.
  - Empty `lines` credits each line's **open** quantity.
  - A charge line is refused.
  - A stock document, and a target that is not the pinned `producesType`, are refused.
  - A partial stock return has no service, by decision: reverse the delivery and re-deliver the retained part.
- **T9 allocation:**
  - Settlement and settled documents are locked, sorted.
  - The completing allocation takes the base residue.
  - A same-side pair and a self-settlement are refused.
  - `filter[unallocated][eq]=true` returns the reversed rows only.
  - Review follow-ups (8348d59): the `allocation_guard` trigger; a full reversal can neither settle nor be
    settled; `reverseDocument` refuses while live allocations exist.
  - 72881da (found by 4B T1): capacity counts both roles.
- **T10 settlements:**
  - The wire body names `documentTypeCode`, not `documentTypeId`.
  - Refused beyond the plan: a non-settlement policy shape, a foreign series, allocations on an
    approval-required type, a base-currency rate other than 1, and a group or archived bank account.
  - Test 31's second case now proves R2 rather than repeating R1.
- **T11 report:**
  - Revenue counts `status in (posted, reversed)`, so a full-reversal pair nets inside a range. It uses a FULL
    join to 3D's delivery aggregate, and item lines only.
  - The wire members are `MoneySchema`, not bare strings.
  - Test 14 asserts the nineteen shipped codes and admits only §3.6.2's four later ones, because 4B's
    `bank.reconcile` is already in the tree.
- **T12:** the record is at `docs/decisions/od-05-4a-credit-control.md`, beside Phase 3's OD-05 record, not at
  the plan's `docs/review/2026-09-05-od-05-credit-control.md`. `Decision:` reads **pending**, so the plan's
  verify grep `^- Decision: (confirmed|declined)$` **does not pass**. It cannot pass without writing a decision
  nobody made.
  - Finding: the plan's "next free number in 4B's range, 0048–0052" for a "no" has no free number once 4B lands
    0050 and 0051. A "no" therefore also needs a Plan Contracts §3.4.1 allocation.
- **T13:** `docs/ui/od-24-phase-4a-screens.md` is the gate record. No `.tsx` and no `ar-ap.spec.ts` exist. The
  plan's i18n path (`packages/i18n/src/locales/…`) and `features/` directory do not exist in the tree.
- **T14:**
  - **`sah-012`:** the source case pins six writers of an AR/AP header, not four: `reverseDocument` and 1A's
    `POST …/documents` also write it. Each writer is pinned by its header column list, not by the bare word,
    which a comment would satisfy. The plan's guard case ran over an empty set on the thin regression
    database, so it now first posts a USD invoice, a partial credit note and a MYR receipt through the
    production services. It then asserts the note copied the invoice's rate and source, and that the receipt
    reads `unit`.
  - **`sah-011`:** the plan's source check counted `coalesce(sum(` against `sum(`, and would have **failed on
    correct code**. The tree coalesces at the boundary in two other spellings: `coalesce((select sum(…)), 0)` in
    `allocation.ts`, and the full join's missing side coalesced column by column in `sales-by-item.ts`. The
    check now names each spelling and counts over comment-stripped source. A behavioural case was added: a
    service item invoiced and never delivered reads cost `0.0000`, and an idle party's balance reads `0.0000`.
    Removing one `coalesce` turned both cases red (checked by mutation, then restored).
  - **Test 1:** the plan's fuzz used `arArbitrary`/`postGenerated` as sketches. They are implemented with
    fast-check, which `tests` already depends on, at the plan's `numRuns: 200`. The series-gap assertion is a
    second case over the same counters, and it first asserts that each of the six series issued a number, so
    the empty set is not vacuous.
  - **`privileges.test.ts`:** the 4A case re-states the five-row list verbatim. It also asserts `payment_term`
    and `allocation` exist with SELECT and without DELETE, so it cannot pass on a database without 0044/0046.

## Fixes to Phases 0–3 this branch needed

These fixes were **found by 4A's tasks** and are defects in earlier slices:

- **999c1e3 (2A/3B):** `balanceInBase` balances a plan per currency. A foreign-currency document with a
  base-currency cost leg crashed `ERR_MONEY_CURRENCY_MISMATCH`.
- **325be17 (2A/3B, with 4A T4):** `postDocument` skipped `applyMovements` on an `effect: "none"` plan.
- **d63ff51 (1A/2B/3C):** a full reversal after a partial credit note or a purchase return double-credited. It
  is now refused until the partial document is voided.
- **6d8e840 (2B/3A):** the documents module did not declare the override codes its overrides route gates
  (sah-047).
- **29a2e07 (0D):** the `role-seed` lint was defeated by a comment inside `roles.ts`, which hid an injected
  `payment.create` on `accountant`.
- **104f963, in part (1A/3C):** `reverseDocument` did not copy `warehouse_id`/`to_warehouse_id`, so no
  `requires: ["warehouse"]` document could be reversed. Task 8's `DELIVERY_ORDER` stock return needs it.

The branch's **first DB-backed run** also fixed Phase 0–3 defects that every suite, 4A's included, needed:

| Commit | Fix |
|---|---|
| b985eb0 | `JSON.stringify(x)::jsonb` double-encoding in 19 files; the `grantCodes` role-code clock collision; the `ensureOpenPeriods` reopen reason |
| 96ae69e | the seed loader re-upserted policies on every run, writing audit rows |
| 5e5f70a | a test disabled a trigger |
| 104f963 | the rest of that commit: `lots.ts` returned Dates; `LandedCostError` lacked its code prefix; an uncounted sheet line was refused; 3D A8's surplus valuation was never implemented |
| 5611a0a | the worker fixture |
| 6218cc5 | the API line writer double-encoded `jsonb`, the root of every API post 422; the attachment list's branch gate, **an authorisation change that wants review** |
| 2787245 | the tests workspace |

These are listed for the Phase 4 report, and are not claimed as 4A work.

**`AGENTS.md`'s known defect** reads "reversing a `DELIVERY_ORDER`, `TRANSFER` or `EXPIRY_WRITE_OFF` puts its
ledger legs on the same side as the original". ADR 0045 (4A T4) now covers `DELIVERY_ORDER` and `TRANSFER`:
`stock-return.test.ts` asserts that the `DELIVERY_ORDER` reversal credits `1250`. ADR 0045 is still a
proposal, and `EXPIRY_WRITE_OFF`'s reversal is refused for the approval-required reason below. **`AGENTS.md` is
not edited by this task**; its Current State line wants updating when Phase 4's report is written.

## Contract amendments landed with this commit

Seven rows were appended to Plan Contracts §4.18 **Round 7**, with the named sections edited to match. Each
was recorded as owed by the task that found it.

1. **§4.8.1:** `companyId` on `allocateSettlement`, `unallocate`, `openBalance`, `partyBalance` and
   `listAllocations`, and `settlementDocumentId` on `unallocate`. The same member is on `convertToInvoice`,
   `creditNoteFrom` and `draftSettlement`.
2. **§4.2.7, §4.5.4:** `POST …/documents/settlements` is gated `"create"` and takes `documentTypeCode`.
3. **§4.5.4, §4.2.7:** `…/convert-to-invoice` and `…/credit-note` carry two gates. This is a settlement of the
   plan's first self-review item, on 3D's precedent.
4. **§4.3.1:** `reverseDocument` refuses while a partial credit note, a return or a live allocation touches the
   document.
5. **§4.8.1:** `allocation_guard`.
6. **§4.8.1:** a full reversal nets its original, and is never a settlement or a settled document.
7. **§4.8.1:** capacity counts both roles.

The `contracts-4a` gate's literals, `listAllocations(tx, input:` included, still match.

**Not landed here, because it is 4B's to land:** 4B T1's owed §4.6.1 correction. Amendment 7's `abs(amount)`
for `item_profitability` revenue contradicts its own consequence (1); the SQL keeps each line's sign.

## Open items that touch 4A (owner, ADR or later slice)

1. **OD-05, pending.** The default (spec:1026 as written) is built. `docs/decisions/od-05-4a-credit-control.md`
   asks three questions: the hold; whether the block should also stop the `DELIVERY_ORDER`, as it does now;
   and whether a customer refund `PAYMENT` should be exempt, where today it fails closed on a hold or limit.
2. **OD-24.** Task 13 is blocked. It is the sixth screen task OD-24 blocks. `docs/ui/od-24-phase-4a-screens.md`
   has the record. Three reads the screens would need have no route yet: a document list, a credit-status
   read, and a per-party open-documents list.
3. **ADR 0044** (the invoice is financial only) and **ADR 0045** (negative quantity negates `line.cost`) are
   **proposals** implemented ahead of approval, as every Phase 2–3 ADR was.
4. **A posted `PAYMENT` cannot be reversed.** `reverseDocument` posts its mirror straight through `issued`,
   which 0022 refuses for an approval-required type. The same holds for `STOCK_COUNT`, `EXPIRY_WRITE_OFF`,
   `PAYROLL` and any approval-required type. This is a money-semantics question (spec:95).
5. **0022's posted → reversed guard** admits the transition whenever **any** posted document names the original
   in `reverses_document_id`, and a posted **partial** credit note does. So a bare `app_rw` UPDATE can mark a
   partly-credited invoice `reversed`. It changes status only, with no ledger effect, and the fix needs a
   migration. 4A's range is spent.
6. **ADR 0041 point 7:** a `PURCHASE_RETURN` before the invoice leaves the returned part's accrual in `2150`
   (−20.0000 in the test), and `PURCHASE_CREDIT_NOTE` cannot clear it or book the freight difference.
7. **Over-allocation and company binding are enforced in `allocateSettlement` only**, not in the database. The
   service is the only writer, and `allocation_guard` fixes each row once it is written.
8. **Test 22's reading** (round 7 open item 7) is 6A's to choose: a 6A-configured stock-issuing invoice type,
   or a pair compare that nets the two `1250` legs.
9. **`item_profitability`** (4B T1): `doc_sign` reads the item's **current** `revenue_account_id`, so
   `updateItem` re-pointing it makes a later rebuild drop past revenue.
10. **Inherited, not 4A's:** the fully matching `STOCK_COUNT` (§4.3.2 step 6 refuses zero lines), the
    attachment-gate change in 6218cc5 (wants review), job approval by the system principal (spec:2172), ADR
    0042's widened counted-line exemption, and AVCO issue rounding (golden-pinned).

## What is red, and why

Exactly three cases are red, all in the `tests` workspace. Each was red before this task, and each fails with
the figure its record predicts.

| Case | Failure | Why, and whose |
|---|---|---|
| `invariants/test-07-one-costing-answer.test.ts`, "a BACK-DATED purchase recosts forward only, and all three tie-outs hold again afterwards" | `expected '167.0589' to be '167.0570'`: off by 0.0019 | **Phase 3 (3B), owner/ADR.** An AVCO issue is costed at the running average rounded to 4 dp × qty, while the valuation sums per-layer rounded values. 3B's plan calls this its "fourth blocker"; the `cost_layer.value` proposal (ADR 0039) was never written. 4A adds nothing to either figure |
| `regression/sah-004.test.ts`, "cost is a function of the movements, so reversing the second purchase restores the first's cost" | `expected '15.0000' to be '10.0000'` | **Phase 3 (3B), owner/ADR.** Reversing a receipt under AVCO issues at the running average, while the ledger credits `1300` at the receipt's amount. spec:231's failure scenario argues that the reversal should consume the reversed receipt's own layer; contract §4.7.1's proportional slice gives 15, which is the legacy failure. It wants an ADR |
| `regression/sah-047.test.ts`, "every catalogue code is the gate of at least one registered route" | `accounting.bank.reconcile` is catalogued and gates no mounted route | **4B, transient.** 4B Task 2 (7d3faf9) catalogues the code, and 4B Task 8 mounts `bankStatementRouteModule`, per 4B's plan. Red from 4B T2 until 4B T8. The assertion stops at the first missing code, so the full set was listed separately against `ROUTES`: the ungated set is exactly `{accounting.bank.reconcile}`, and each of 4A's seven codes gates a route |

**No 4A test is red, and no 4A test was weakened, skipped or deleted to reach this.** The new Task 14 cases
(the privileges case; `sah-011` ×3; `sah-012` ×3; the fuzz and the series-gap case) are all green in the full
runs above.

The **CI clause** ("every row above green in CI") is unmet, as the verdict says. It is not red; it is not run.

## What the next slice needs

- **`document.payment_term_id`**, not `party.payment_term_id`, is the term 4B's ageing buckets are cut on.
- **`allocation.fx_difference`** is computed and stored in base. 4B posts the gain or loss through
  `4900`/`5910` on an `FX_REVALUATION`, and needs no second calculation.
- **A full reversal pair is never an open item** (§4.8.1, round 7). A partial credit note is one, negative,
  until allocated.
- **sah-047 turns green** only when 4B Task 8 mounts `bankStatementRouteModule`.
