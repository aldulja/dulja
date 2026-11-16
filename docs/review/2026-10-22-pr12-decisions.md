# PR 12 — owner decisions resolved by best practice (2026-10-22)

The PR 12 code review left questions only the owner could settle. On 2026-10-22 the owner directed: "for these
decisions do the best practice" and asked for the whole of Phase 6 to be implemented as planned and the PR made
ready to merge. Each question was resolved as below. The ADR records stay **proposed** for formal review, as
Phase 5's did under the same kind of direction; this file is the authority for implementing them now.

| Question | Resolution | Where |
|---|---|---|
| Till PIN lockout policy and its trade-offs | Kept: 5 consecutive wrong PINs lock a number for 5 minutes, doubling to a 60-minute cap; 10 wrong PINs per 10 minutes per till; no enumeration; persisted; clock-safe. Added the supervised unlock best practice asks for: a new credential (a manager's PIN reset) clears that number's lockout at the till. | ADR 0060 amendment; `apps/pos/src/main/authority.ts`, `mirror.ts` |
| Replay guard on signed requests | Kept (each signed message is spent once). The same-millisecond residual is removed at the source: the till signs with strictly increasing timestamps. The wire format is unchanged. | ADR 0055 amendment; `apps/pos/src/main/transport.ts` |
| Refusal finality at the till | Kept. A cured refusal now closes its needs-attention row when the ticket posts, and a void refused for good stops reserving its original against a return. | ADR 0056 amendment; `packages/db/src/sync/apply.ts`, `apps/pos/src/main/returns.ts` |
| Error codes across the Electron bridge | Kept: `ERR_…: detail` at the head of the message, the renderer shows only `t("pos.error.<code>")`. | ADR 0058 amendment |
| Does `discountBase` count cash rounding? | No: rounding is not a discount. The ledger treatment (ADR 0059, rounding on the line) is unchanged; `pos.sales_by_cashier` reports manual discounts in `discountBase` and the rounding separately. | ADR 0059; `packages/db/src/reports/pos.ts` |
| Does `discountBase` count a verified promotion? (2026-10-23) | No: a promotion is the shop's decision, not the cashier's. The ledger is unchanged; the posted line records the share the server verified (`custom_fields.posPromotion`), a referenced refund its share of it, and `discountBase` leaves it out. An unproved claim stays the cashier's discount. No promotion column is added; that needs a report-contract change and a screen. | ADR 0059 PR 12 review amendment; `packages/db/src/sync/promotion.ts`, `packages/db/src/reports/pos.ts` |
| A role edit left other companies' or branches' cashier snapshots stale | `app.refresh_pos_cashier` reads and writes as the tenant's system principal and restores the caller's actor; it grants nothing, because the snapshot's codes come only from `app.principal_has`. Listed in AGENTS.md beside the other changes to security controls the owner reviews as such. | ADR 0061 PR 12 review amendment; migration 0067 section 3; `packages/db/test/staff/cashier-snapshot.test.ts` |
| How a return of an account sale is settled (2026-10-22, plan audit) | A referenced return settles the way its sale did: a return of an account sale is credited to the customer's account with no tender, and a return of a paid sale is tendered as before. The till says so on screen and on the receipt; the server refuses a return whose settlement does not match its posted sale (a recoverable needs-attention refusal). | ADR 0056 ("A referenced return settles the way its sale did"); `apps/pos/src/main/returns.ts`, `packages/db/src/sync/apply.ts` (`prepareReturns`); `apps/api/test/routes/sync/account-returns.test.ts` |
| A re-send of an over-size batch answered 500 for the rest of the day | The re-send gets the job that holds the batch's slot: `202 queued` while pg-boss may still run it, a refusal naming the job and the remedy once it has finished, and a refusal for any other batch reusing the `batchId`. **Owner question:** approve the refusal of a reused `batchId` and of a re-send whose job has finished? | ADR 0056 ("Over-size batch re-send"); `packages/db/src/sync/batch-queue.ts` (`enqueueSyncBatch`) |
| Shift and branch-limit screens refused to report-only or policy-only roles | The staff-screen selector admits `pos.report.read` and `admin.company.manage` beside the four 6C codes; it still grants nothing. | Plan Contracts 6C reconciliation amendment; ADR 0062 |
| Both desktop windows painted nothing under their own CSP (found verifying, 2026-10-23) | Fixed at the cause, not by loosening the policy: `script-src 'self'` stays without `'unsafe-eval'`, and `@dulja/domain`'s four Ajv validators (posting policy, document-type seed, tax pack, e-invoice profile) compile on first use, once per process, instead of at import. Both renderers import that barrel through `@dulja/contracts`, and Ajv compiles with `new Function`, so the compile threw before React mounted. The back-office half is older than PR 12 (`main` paints nothing too); it is fixed here because the till shares the cause, with the two faults it hid: `backoffice.exe` opens `dulja://app/` rather than `/index.html` (which the router answered with "Not Found"), and the back office sets zod's `jitless` before any schema is built, so zod's caught eval probe reports no violation; the server keeps zod's JIT. | `packages/domain/test/lazy-schemas.test.ts`; `tests/e2e/pos-rtl-parity.spec.ts`, `tests/e2e/backoffice-csp.spec.ts` (at `BACKOFFICE_START_PATH`, which `apps/desktop/test/window-options.test.ts` pins `main.ts` to); the e2e back office is served under the desktop policy |
| Where the fixes land | PR 12's own branch (`codex/phase-6-recovery`) is fast-forwarded to the reviewed tree, so the review history stays on one PR; no history is rewritten. | — |

Owner gates the direction did not name stay at their recorded defaults: OD-03 loyalty, OD-07 serials and OD-10
till cash documents are not built, OD-11 keeps the required-e-mail default, OD-12 has no seed, and OD-18
(signing) and the staging/deployment gates remain external.

## Deviations the plan audit found and accepts (2026-10-22)

A task-by-task audit compared the tree with the four Phase 6 plans after the review fixes. Gaps it confirmed
were fixed with tests. These differences are accepted as best practice and recorded here, because no earlier
record named them:

- **The back-office staff directory has a "Create employee" form** (`apps/backoffice/src/routes/hr/employees.tsx`).
  6C Task 13 lists the directory as list, filter and open, and says an uncovered operator need goes back to the
  owner. It is kept because it is the only screen path for onboarding a cashier (a credential needs an
  employee) until Phase 8A's HR screens; it calls the already-gated `POST …/employees`. The owner may remove it.
- **`6a-pos-tenders.json` gives `1110`, `1120` and `2200` their group parents** (`1`, `1`, `2`), as the 6D till
  accounts do (reconciliation, chart parent links). 6A Step 6 said "no parentCode"; the group parent keeps the
  chart tree whole and changes no posting.
- **The `pos.sync.apply` handler's cases live in `tests/invariants/pos-sync-job.test.ts`**, not
  `apps/worker/test/handlers/pos-sync-apply.test.ts`, beside the other cross-workspace POS acceptance suites.
- **6A's `MemorySyncStore` fixture is unused**: the equal-cursor property it was meant to compare is asserted
  directly against the till's `SqliteSyncStore` (`apps/pos/test/store.test.ts`, `loops.test.ts`).
- **The shift API client keeps its shipped names** (`shiftApi(options, companyId)`), not the plan's
  `createShiftApi`/`useShiftApi`; they are internal to `apps/backoffice` and not a registered contract.
- **The till's contract schemas are imported from the `@dulja/contracts/pos/till` subpath**, not re-exported
  from the package barrel as 6B Task 9 Step 4 wrote, and carry no `.openapi('Till…')` names: they validate the
  till's IPC, which is not an HTTP surface, and the subpath is how every other pos/sync/hr contract is imported.
- **The sync apply checks the attendance principal's live cashier row before its `pos.attendance.clock`
  grant** (6B Task 4 Step 5 put the grant first) and refuses with a fixed detail. Both refusals roll the whole
  ticket back, and the handover case (each event gated on its own principal) is tested.
- **6D Task 12's over/short tone leaves an exact count untoned** (`overShortTone`,
  `apps/backoffice/src/lib/shift-api.ts`). Step 3 tested only for a leading minus, which colours a drawer that
  balanced to the cent as "over". Short is `text-danger`; over is a new `--dulja-color-success` token (6.57:1
  light, 10.18:1 dark, `packages/ui/src/tokens.css`). The sales-by-cashier view, which the plan's register does
  not have, tones its over/short through the same component, so the over/short stays the only coloured figure.
- **The Z-report's route `/pos/shifts/$shiftId/z-report` renders nothing of its own.** It is a child of
  `/pos/shifts`; the register stays mounted and shows the report beside its list (the plan's two-pane default),
  so the filters survive Esc and the browser's back. It carries `?company=<id>`, because the staff-context
  picker, not the path, chooses the company: a report opens only under the company it was opened from. Esc
  pops the history entry that opening the report pushed (a report opened over another replaces it), so back
  never reopens a report just closed and an Enter/Esc scan leaves no history; a report reached by a link has no
  register entry beneath it and closes by replacing its own.
- **The Z-report prints only itself.** Print hides everything that neither contains nor sits inside the report,
  where the plan's rule hid only `header` and `nav` and left the company picker and the register's title on the
  paper. Esc's focus return lands on the grid cell that holds the terminal button, because `DataGrid` keeps its
  single tab stop on the cell.
- **Display rounding is `formatMoney`'s default two minor units and times are `formatTimestamp`'s default
  zone** (Asia/Kuala_Lumpur), as Steps 3–4 wrote: no currency minor units or company time zone reach the client
  yet. The register's From/To start at today in that same zone (`todayIn(SHIFT_TIME_ZONE)`,
  `apps/backoffice/src/lib/shift-api.ts`), where the plan's register started unfiltered and the shipped one
  used the UTC day: the API filters on the company-local opening date, so the UTC day hid every shift opened
  between local midnight and 08:00. Catalogue keys keep the shipped `shift.*` names rather than
  `pos.shifts.*`/`pos.zReport.*`; `documentType.TILL_OVER_SHORT` is new, and a cash-control type with no label
  (OD-10's, not built) prints its code.
- **6A Task 8's `Change` and `CataloguePage` are named through Zod 4's `.meta({ id })`**, not by importing `z`
  from `@hono/zod-openapi` and calling `.openapi(…)`: `@dulja/contracts` depends on `zod` alone, every other
  named schema in it is spelled this way, and the generator emits the same `#/components/schemas/<id>`
  references. `CatalogueQuery.since` stays a bare string rather than the plan's `CursorSchema.optional()`, so a
  malformed cursor is answered `ERR_SYNC_CURSOR_INVALID` by the route instead of `ERR_VALIDATION_FAILED`.
