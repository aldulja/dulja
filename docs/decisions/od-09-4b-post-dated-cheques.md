# OD-09 (and OD-05's spec:1044 row) — post-dated cheques, not built (Plan 4B Tasks 9 and 10)

- Owner decision: **OD-09** (contracts §2.12), spec:1044, spec:2479, Part VII #15.
- Also discharges: **OD-05** for slice 4B. OD-05 is "confirmation of every ⚠️ row in §3.0.3 and §3.0.4". 4B's
  scope contains exactly one ⚠️ row, spec:1044, and that row is OD-09's subject. One decision gets one record,
  with both ids on it.
- Covers: **Task 9** (migration 0051 `app.pdc`, the `1150` chart row) **and Task 10** (`PDC_RECEIPT`,
  `PDC_DEPOSIT`, the deposit, the bounce reversal, the register read). Both are OD-09's tasks, so Task 10 has
  no record of its own.
- Asked: not yet sent. The request at the end of this file is ready to send. There is no issue tracker in this
  workspace, and no date can honestly be recorded for a request that has not gone out.
- Answered: pending
- Decision: pending. The default (**not built**) stands until the owner answers.
- Recorded by: the 4B Task 9 agent, 2026-09-28, as a pending record. Whoever receives the owner's answer
  records it on the `Decision:` line above, with its date.

**Status:** ⚠️ **UNCONFIRMED. Nothing is built.** This is a *decision record*, not an ADR, and it decides
nothing. It records what the plan assumes if the answer is yes, what exists in the tree today (nothing), and
what each answer then costs. It follows the shape of `docs/decisions/od-05-3d-multi-branch-stock.md` and
`docs/decisions/od-05-4a-credit-control.md`.

**Nothing is blocked by this record.** Plan 4B Tasks 1–8 are built without it and do not import anything from
Tasks 9–10. Task 12's slice exit does not wait on it either. Phase 4's definition of done (spec:2290) does not
mention cheques, and spec:1044's "Proven by" column is "—", so no Part VI test is lost.

## The gate, and what it checks

Plan 4B Task 9 gives the verification as: *"`ls -1 docs/owner/od-09/` shows one file and
`docs/decisions/od-09-4b-post-dated-cheques.md` records the answer and its date."* Run on 2026-09-28 against
this tree:

```
$ ls -1 docs/owner/od-09/
ls: cannot access 'docs/owner/od-09/': No such file or directory
$ ls -1 docs/owner/
ls: cannot access 'docs/owner/': No such file or directory
```

**It does not pass, and that is the correct result.** No answer has been received, and this file records the
answer as `pending`. `docs/owner/` does not exist and never has, in any phase. The Task 9 Files line says to
create `docs/owner/od-09/` as the gate directory. It was not created: git does not track an empty directory,
no earlier gate created `docs/owner/`, and an empty directory would only look like material had arrived.

## The row, verbatim

> **Post-dated cheques** — cheque-in-hand asset with maturity date, deposit and bounce reversal ⚠️
> *(confirm the business collects PDCs)* — spec:1044, §3.0.4, Phase 4, proven by "—"

> 15\. ⚠️ **Till cash and cheques:** do branches pay small expenses from the till and bank cash daily; does
> the business collect post-dated cheques. Decides the §3.0.4 rows marked ⚠️ in Phases 4 and 6. — spec:2479

This record answers only the second half of Part VII #15. The till half is OD-10 and belongs to 6D.

**OD-05's default and OD-09's default agree on this row.** OD-05's default is "spec text as written", and
OD-09's is "not built". On most rows those two would conflict. Here they do not, because the row as written
carries its own condition, *"(confirm the business collects PDCs)"*, and §3.0.4's preamble (spec:1036) says
⚠️ rows "need the owner's confirmation before their phase starts". Building the row as written therefore
means building nothing until the owner confirms.

## What is in the tree: nothing

None of the following exists on this branch. The list comes from Plan 4B Tasks 9 and 10, and each item was
checked with `ls` and `git grep` on 2026-09-28:

| Plan artefact | Task | In the tree |
|---|---|---|
| `packages/db/migrations/0051_create_pdc.sql`, `0051.down.sql` (`app.pdc`) | T9 | absent. **0051 is 4B's reserved number and stays reserved and unused** (below) |
| `packages/db/src/schema/pdc.ts` (the Drizzle mirror) | T9 | absent |
| `packages/db/seed/my/chart-of-accounts/4b-pdc.json` (`1150` Cheques in hand) | T9 | absent. The directory holds `0c-base.json`, `3c-purchasing.json` and `3d-adjustments.json` only |
| `packages/db/test/ar-ap/pdc.test.ts` | T9, T10 | absent |
| `packages/db/seed/my/document-types/PDC_RECEIPT.json`, `PDC_DEPOSIT.json` | T10 | absent |
| `packages/db/src/ar-ap/pdc.ts` and its block in `packages/db/src/ar-ap/index.ts` | T10 | absent |
| `packages/contracts/src/accounting/pdc.ts` | T10 | absent |
| `apps/api/src/routes/accounting/pdc.ts`, its `buildRoutes` line in `apps/api/src/routes/index.ts` | T10 | absent. `buildRoutes` mounts one 4B module, `bankStatementRouteModule` |
| the `/v1/companies/:companyId/pdc` key in `tests/invariants/probes.ts` | T10 | absent |
| `apps/api/test/routes/accounting/pdc.test.ts` | T10 | absent |
| `pdc` in `packages/db/src/lint-schema.ts` | — | correctly absent under either answer: §3.5.3's `pdc` row is dashes in every column |

`packages/contracts/openapi.json` has no `pdc` path, and `ERRORS` gained nothing for cheques. The permission
catalogue is unchanged: the plan's routes would use 4A's `accounting.receipt.create` and
`accounting.receipt.post`, which already exist.

### Where the tree names post-dated cheques, all passing under either answer

Four places mention the feature. None of them imports anything, and none of them claims it is built:

- `packages/db/test/seed/permission-phase4b.test.ts:150-151, 174-176`. This test asserts that 0C's
  `0c-base.json` has no `1150` row, and that the only 4B chart file allowed to exist is `4b-pdc.json`. It
  passes now, and it still passes after a "yes".
- `tests/invariants/support/ar-ap.ts:148-149`. A comment: `1150` is absent unless OD-09 lands.
- `tests/regression/legacy-041.test.ts:167-168`. This test names `pdc` among the tables on which `app_rw` must
  hold no DELETE. With no table the check passes trivially. After a "yes" it becomes a real check.
- `scripts/check/contracts-4b-amendments.sh:35`. This checks that amendment 8's `1150` row is in the
  contracts document. That row stays under either answer (below).

### The contracts rows stay conditional, and this task edits none of them

Every mention of the feature in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` is already marked
⚠️ / OD-09 / "only if OD-09". None says the feature is built:

- §2.5's 4B card (lines 443, 446, 453, 458)
- §2.12's OD-09 row, default **not built** (line 870)
- §3.5.3's `pdc ⚠️` membership row (line 1093)
- §4.6.1's `pdc ⚠️` row, "4B / 0051 (OD-09)" (line 3014)
- §4.14's `PDC_RECEIPT ⚠️`, `PDC_DEPOSIT ⚠️` row (line 3813)
- §4.15's `⚠️ 4b-pdc.json (OD-09 only)` in the seed-layout list and its `1150 ⚠️` row (lines 3843, 3852)
- §4.16.1's `accounting.pdc_register ⚠️`, a 7C row (line 3918)
- §4.16.2's `pdc ⚠️` `DatasetId` member (lines 3957, 3967)
- round 8's amendment 8, "plan (conditional, OD-09)" (line 4416)

These rows record an allocation. They do not claim anything was built, so a pending answer leaves them exactly
as they are.

## What the plan assumes if the answer is yes

Taken from Plan 4B Task 9. These are assumptions, not decisions:

| Question the ⚠️ row leaves open | Assumption if the answer is yes | Where it would live |
|---|---|---|
| Is a cheque in hand an asset of its own, or just an unbanked receipt? | **An asset of its own**, `1150` Cheques in hand. spec:1044 says "cheque-in-hand asset with maturity date". A receipt that is not yet money must not sit in `1100` Bank, or Task 7's reconciliation can never balance | the §4.15 amendment and `PDC_RECEIPT`'s debit (Task 10) |
| Does a bounce reverse the deposit, or the original receipt? | **The deposit.** §4.14's row says "bounce = reversal of the deposit (D13)". The cheque returns to `in_hand`, and the receivable it settled stays settled until the operator unallocates | `bouncePdc` (Task 10) |
| Is there a maturity alarm? | **No job.** `JOBS` is a closed registry (§4.2.6), and adding a name is an amendment this slice does not make. Maturity is a query, `listPdc({ maturingBefore })`, and the register is 7C's ⚠️ `accounting.pdc_register` | `listPdc` (Task 10) |

## If the owner says yes

Tasks 9 and 10 are carried out as the plan writes them, in that order, as their own PRs:

- **Migration 0051** `0051_create_pdc.sql` and its hand-written `0051.down.sql`, creating `app.pdc` with
  `pdc_status_check`, `pdc_deposit_pair_check`, `unique (company_id, party_id, cheque_number)`,
  `unique (tenant_id, id)`, `pdc_maturity_idx`, forced RLS and the audit trigger.
  - **0051 is the number.** It is 4B's reserved number (§2.5's card, §4.6.1), and it stays reserved and unused
    until then.
  - No other slice may take it. §3.4.1 says "a slice writes only inside its range and never renumbers".
  - A late 0051 applies cleanly to a database that already holds 0052 and later. The runner "applies every
    unapplied file in version order" (§3.4.1, `packages/db/src/migrate.ts` `up`), and `app.pdc` references
    only tables from before 0048.
- `packages/db/src/schema/pdc.ts`, `packages/db/seed/my/chart-of-accounts/4b-pdc.json` (`1150`, parent `"1"`),
  `PDC_RECEIPT.json` (series `PDC`) and `PDC_DEPOSIT.json` (series `PDD`), `packages/db/src/ar-ap/pdc.ts`,
  `packages/contracts/src/accounting/pdc.ts`, `apps/api/src/routes/accounting/pdc.ts` with its `buildRoutes`
  line and its one `PROBES` key, a regenerated `openapi.json`, and the two test files.
- The ADR question: 4B's ADR range (0046–0048) is spent, and neither task allocates an ADR. A "yes" that
  confirms the three assumptions above as written needs no new ADR. A "yes" that changes one of them is a
  money-semantics change (spec:95). That wants an ADR, and the ADR needs a number allocated first.

**Three things in this tree that the plan's Task 9–10 code will meet.** Each one needs fixing before the code
runs, and none of them is decided here:

1. **A deposited cheque cannot be reconciled.**
   - `PDC_DEPOSIT` debits `1100`, which moves the bank account's ledger balance.
   - The reconciliation registry (`packages/db/src/ar-ap/reconciliation.ts`) has only two sources:
     `ledgerLegSource("receipt", "RECEIPT")` and `ledgerLegSource("payment", "PAYMENT")`. They are keyed one
     kind to one type code, and registering a second `receipt` source replaces the first.
   - `bank_match.reconcilable_kind`'s CHECK (migration 0050) admits only `receipt`, `payment`, `till_banking`
     and `payroll_batch`.
   - Task 10 registers nothing. So the bank-statement line for a banked cheque would stay in `unmatchedLines`,
     with nothing it could be matched to, in every month that has a deposit. That month could never be fully
     matched, which is what Phase 4's second DoD sentence asks for.
   - There are two ways to fix it: a fifth kind, which is a CHECK change and so DDL, or a `receipt` source
     spanning more than one type code. Either is a change to ADR 0048's registry, and it must be decided with
     the answer.
2. **The request context has no branch.**
   - The plan's create handler passes `branchId: c.var.ctx.branchId`.
   - `RequestContext` (`apps/api/src/context.ts:5`) is `TenantContext` (`tenantId`, `actorId`, `requestId`)
     plus `principalKind` and `aal`. It has no `branchId`.
   - The plan names the fallback itself: the body gains a required `branchId`.
3. **`PDC_DEPOSIT`'s direction.**
   - §4.14's row gives both types `inbound`.
   - The plan's `PDC_DEPOSIT.json` is `direction: "internal"`, and so is its `requires: []` rationale.
   - One of the two changes before the file is written. That change is a contracts amendment if §4.14 moves.

## If the owner says no

**Nothing is deleted, because nothing was built.** The plan's own "If the answer is NO" list (Task 9 Step 1)
names eleven files to delete and three lines to remove from existing files. None of them exists. What a "no"
does change:

- **Contracts.**
  - Strike the §4.14 `PDC_RECEIPT`/`PDC_DEPOSIT` row, the §4.6.1 `pdc` row, the §3.5.3 `pdc` membership and
    the §2.5 card's PDC lines.
  - Strike the §4.16.2 `pdc` `DatasetId` member and §4.16.1's `accounting.pdc_register`. §4.16.2 already says
    these two are dropped together. The register row is 7C's, and striking it is recorded against 7C.
  - **`1150` is not struck.** The Task 9 template says to strike the §4.15 row. §4.15's own row says otherwise:
    "if OD-09 = no, neither the file nor the row exists and **this code stays allocated-but-unseeded**, exactly
    as §4.16.2 treats the `pdc` `DatasetId`". The frozen contract governs here, so the row stays with that
    wording, and the seed-layout list drops `⚠️ 4b-pdc.json`.
- **Migration 0051 stays unused, permanently.** §3.4.1 says "unused numbers stay unused", and Task 9 Step 1
  says "no slice borrows it".
  - `docs/decisions/od-05-4a-credit-control.md` reads a declined OD-09 as the one way a number in 4B's range
    becomes free for 4A's credit-control contract migration.
  - Against the two rules above, taking 0051 for that migration would be a register question for the owner
    under §3.4.1's ⚠️ proposal for branches that are not slices. It is not a number either record can take.
- **Tree.** Of the four mentions above, the `legacy-041` IN list and the two comments can be tidied in the same
  PR. `permission-phase4b.test.ts`'s allowance for `4b-pdc.json` becomes "no 4B chart file at all".

## What does not change under either answer

- Tasks 1–8 and 11–12 of Plan 4B are unchanged under either answer: receipts and payments, allocation, ageing,
  FX and bank reconciliation.
- The Phase 4 definition of done is unchanged. Its two sentences are about ageing and bank reconciliation.
- Cheques that are banked the day they are received are unaffected. They are ordinary `RECEIPT`s to a bank
  account today, and they reconcile through the `receipt` source.

## The owner request, ready to send

> **OD-09, post-dated cheques (spec:1044; Part VII #15, second half).** Does the business accept **post-dated
> cheques** from customers, meaning cheques dated in the future that you hold until their date and then bank?
> Today we have **not** built anything for them. A cheque is recorded when it is banked, as an ordinary
> receipt. If you do take them, three things need a yes or no:
>
> 1. **Held cheques as their own balance.** While a cheque is in the drawer, should the books show it as
>    "cheques in hand", separate from the bank balance, so that the bank reconciliation only ever sees money
>    that has actually been banked?
> 2. **Bounced cheques.** When a banked cheque bounces, we would undo the *deposit*. The cheque goes back to
>    "in hand", and the customer's invoice stays paid until someone deliberately re-opens it. Is that right, or
>    should a bounce re-open the invoice automatically?
> 3. **Maturity.** Is a list of cheques that fall due before a chosen date enough, or does someone need an
>    alert?
>
> **Verify:** the answer in `docs/owner/od-09/`, and the `Decision:` line of
> `docs/decisions/od-09-4b-post-dated-cheques.md` recording it and its date. **Until provided:** nothing is
> blocked. Slice 4B ships without post-dated cheques, and migration 0051 stays reserved for them.
