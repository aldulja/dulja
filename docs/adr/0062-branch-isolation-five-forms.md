# ADR 0062 — Branch isolation is a RESTRICTIVE row policy in five fixed forms, and `role_assignment_branch` is the one exemption

- Status: **proposed** (spec:95 — this touches security and the data model)
- Date: 2026-09-05
- Slice: 6C

## Context

spec:2166 requires a RESTRICTIVE `branch_isolation` policy on "every table with a `branch_id` column",
attached from Phase 6 when branch-scoped roles first exist. Tables reach their branch four different
ways, and one table must not carry the policy at all.

## Decision

Two `stable` SQL functions and **five** policy forms, all named `branch_isolation`, all `AS RESTRICTIVE`,
differing only in the `using` expression (§4.5.6). Form A: a NOT NULL `branch_id`. Form A″: `app.warehouse`
— Form A plus `kind = 'in_transit' or …`. Form A′: `app.employee`, whose key is `home_branch_id`. Form B:
a NULLABLE `branch_id`, where `branch_id is null or …` because NULL means *every branch*. Form C: the five
stock tables, reached through `app.actor_in_warehouse`.

**`app.role_assignment_branch` is exempt, and the exemption is closed at one name.** `app.actor_in_branch`
selects **from** `role_assignment_branch`; a restrictive policy on that table whose predicate calls
`actor_in_branch` is self-referential, and PostgreSQL aborts every read of it with *"infinite recursion
detected in policy for relation role_assignment_branch"* — not only the policy's own read, but the
authorisation predicate of the entire system, including `app.actor_has`. The table is the branch **grant**,
not branch-scoped **data**: it is already tenant-isolated, its rows are already unreadable across tenants,
and a principal reading their own grants is the mechanism by which scope is *narrowed*, never widened.

## Consequences

- `document_line` never gains a `branch_id` (§4.3.4). Its composite FK ensures integrity; the separate
  restrictive `document_parent_visibility` policy registered below enforces parent visibility for reads and writes.
- The in-transit exception lives on `app.warehouse`'s own policy and inside `actor_in_warehouse`.
  Both must admit a legitimate transfer receipt, and the function also binds the supplied company.
- `SECURITY DEFINER` is not used by any policy or by either predicate (`app.actor_in_branch`,
  `app.actor_in_warehouse`). In a predicate it would bypass `tenant_isolation` on `warehouse` as well,
  turning a branch hole into a tenancy hole. Migration 0068 does ship one `SECURITY DEFINER` function, and it
  is not a predicate: the bounded, app_auth-owned `app.resolve_cashier_employee` described under *Linked
  cashier identity* below, which returns only a live cashier's linked employee id and number, binds the
  current tenant itself and still requires `app.actor_in_branch` for the credential's branch, and is no
  policy's `using` expression. (Corrected by the PR 12 review, 2026-10-22; this bullet earlier said
  `SECURITY DEFINER` was used nowhere here.)
- The system principal passes every form (jobs must still run; `app.refresh_pos_cashier` also switches to it
  for its own two statements, per ADR 0061's PR 12 review amendment), and a principal with no
  `role_assignment_branch` rows is company-wide by construction — exactly `app.actor_has`'s NULL-branch rule.
- A new table with a branch key now fails the build until it carries a form (§3.5.1 step 7, the
  `branch_isolation_policy` rule). That is the point: the next slice cannot forget.

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6c-staff-cashiers-branch-isolation.md](../superpowers/plans/2026-09-05-dulja-phase-6c-staff-cashiers-branch-isolation.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## What we are asking

Approve the five restrictive branch-isolation policy forms and the sole role_assignment_branch exemption described above?

## Integration corrections — 2026-10-08

The supplied plan's PUBLIC restrictive Form A on `terminal_enrolment` would also constrain the app_auth-owned pre-tenant resolver, whose actor is not yet known. Scope that table's Form A to `app_rw, app_migrator`, preserving its hash-bound SECDEF resolver, app_auth-only SELECT grant and resolver policy. There is no table exemption or BYPASSRLS grant. Prove redemption still works after 0068 and ordinary cross-branch reads remain refused.

`actor_in_warehouse` binds `w.company_id = p_company_id` and admits `w.kind = 'in_transit' OR actor_in_branch(w.company_id, w.branch_id)`. Keep the warehouse policy's own transit exception as well. Prove a cross-branch transfer receipt and cross-company/tenant refusals.

A composite document-line FK bypasses RLS during integrity checks and does not isolate child reads or DML. Add restrictive `document_parent_visibility` on `document_line`, with correlated visible-parent EXISTS predicates in both USING and WITH CHECK, keyed by tenant/company/document ID. This is separate from the five branch/stock forms and adds no branch column. The linter requires it and the down migration drops it; seventeen branch/stock policies plus this child policy make eighteen. Prove cross-branch SELECT, INSERT, UPDATE and reparenting refusals, including the invisible-parent NULL-status path of the existing line-freeze trigger.

These corrections are necessary to implement the authorized branch-isolation behavior. Formal ADR status remains Proposed; no runtime completion is claimed by this record.


## Linked cashier identity — integration reconciliation

The human cashier management response also uses the bounded linked number:
`CashierSchema.employeeNumber` is the live resolver result, or null for a revoked
credential. It identifies an authorized credential across employee home branches
without opening the employee directory. API and screen tests retain directory and
foreign-branch refusal; no new permission or column grant accompanies the field.

The staff screens also require a read-only `/v1/staff-context` projection: existing
company/dimension administration routes require admin authority that staff roles
do not hold. The projection lists only actual company/BRANCH pairs admitted by
one of the four 6C authorities at that pair (six since the PR 12 review amendment: `pos.report.read` and `admin.company.manage` join them for the shift, Z-report and branch-limit screens), under human tenant context. Empty
access is refused. It changes no permission or administration gate; returned IDs
grant no authority. Branch-only grants and cross-company/tenant refusal are tested.

An employee’s home branch and their cashier credential’s branch may differ. Migration 0068 supplies the narrow `app.resolve_cashier_employee(company, branch, principal)` projection, owned by app_auth with fixed search_path and current-tenant/live-cashier/credential-branch predicates. It returns only the linked employee ID and number for catalogue login and the existing attendance writer. Exact column SELECT grants let the internal resolver read its required identity and scope facts; it cannot mutate them. Employee Form A′ remains restrictive for app_rw and app_migrator, while existing tenant isolation and explicit resolver scope bind app_auth. No permissive policy, BYPASSRLS, application flag, new role or directory endpoint is added. Tests must prove ordinary cross-home-branch directory refusal together with the legitimate cashier’s login projection and signed attendance, and reject cross-tenant/company/credential-branch or revoked identities. Down restores the prior invoker stream and removes the new resolver/grants.

## Cross-branch transfer receipt — amendment, 2026-10-23 (Phase 6 plan audit)

The 2026-10-08 correction above asked for proof of a cross-branch transfer receipt. The proof now exists, in
the "after 0068" cases of `packages/db/test/inventory/transfer-receipt.test.ts` and
`apps/api/test/routes/accounting/document-transfer.test.ts`, and it shows that this ADR and contracts §4.5.6
claim more for Form A″ than it delivers. The cases pin what follows; nothing here widens a policy.

- **The in-transit exception serves the dispatch, not the receipt.** ADR 0043 puts the corridor at the
  RECEIVING branch, so a principal restricted to B reaches it through its own branch. What the exception
  admits is the SENDING branch. A principal restricted to A issues and posts a dispatch that a wider
  principal drafted, and that post writes the movement, cost layer and `stock_on_hand` row into B's
  corridor. Both copies of the exception are needed for that post. In a one-off probe on 2026-10-23 (not a
  standing test) each copy was removed in turn, and the post was refused both times: by `postDocument`'s
  transfer-leg check (step 6f), which could no longer see the corridor, when the warehouse row was hidden;
  and by `inventory_movement`'s WITH CHECK when the function's admission was missing.
- **No principal restricted to one branch can complete an inter-branch transfer.**
  - *Receiving branch only.* `draftTransfer` stamps the dispatch with the source warehouse's branch, so the
    dispatch is branch A's document. Form A hides its header from a principal restricted to B, and
    `document_parent_visibility` hides its lines. `draftTransferReceipt` therefore answers `ERR_NOT_FOUND`,
    and the receipt route 404s, because its gate reads the same row to find the dispatch's branch.
  - *A readable dispatch would only move the refusal.* The receipt is stamped with the dispatch's branch,
    and Form A's WITH CHECK refuses that row to B (`new row violates row-level security policy
    "branch_isolation" for table "document"`); the same row stamped with B is admitted. The receipt route
    and the receipt's post are both gated at A, where B holds no authority.
  - *Sending branch only.* `draftTransfer` resolves the destination, which is a stock warehouse, and
    Form A″ hides a stock warehouse from every other branch.
  - *Through the API, any branch-restricted principal.* `POST …/documents/transfers` refuses the dispatch
    earlier still, 403, whichever branches the principal holds. `TransferDraftBody` names no branch, so 3D's
    create gate asks for `actor_has(code, company, null)`, which is false for any principal with
    `role_assignment_branch` rows.
- **What completes.** A company-wide principal does everything. A principal granted both branches receives
  (service and route) and drafts the dispatch at the service. The seeded `branch_manager`, which spec:2160
  gives "receiving transfers", is branch-restricted by construction, so in practice it can neither dispatch
  nor receive an inter-branch transfer.

So the cross-branch receipt proof is met only at the predicate level and for the dispatch's post, not for a
receipt by the receiving branch. Making one possible means choosing which branch gates and stamps a
receipt, and how the receiving branch reads the dispatch without a `SECURITY DEFINER` or a permissive
policy. That is a 3D decision with a security cost, and it is raised for the owner as ADR 0043's proposed
amendment of the same date. It is not implemented here.

**Resolved by migration 0119, 2026-11-04.** The owner accepted ADR 0043's amendment on 2026-11-04 with every
recommended default, and migration 0119 implements it. The limitation recorded above no longer holds:

- a principal restricted to the sending branch drafts, issues and posts a dispatch;
- one restricted to the receiving branch reads the posted dispatch, receives it stamped with its own branch,
  and posts it there;
- a third branch reads nothing of either document.

Four changes did it, all still `AS RESTRICTIVE`, with no permissive policy and no `SECURITY DEFINER` in any
predicate:

- Form A on `document` reads one more row shape: a posted document into an in-transit warehouse of a branch
  the actor is in. Its WITH CHECK stays the original predicate.
- `document_parent_visibility`'s WITH CHECK asks that a line's parent be writable (`actor_in_branch`), not
  merely visible.
- Form A″ keeps its USING and is scoped to `app_rw` and `app_migrator`, as Form A′ and `terminal_enrolment`'s
  Form A are.
- A second bounded `app_auth`-owned resolver, `app.transfer_destination_branch`, gives the sending branch the
  branch of a destination it cannot see, as `resolve_cashier_employee` does for a cashier's employee.

The register is unchanged: nineteen `branch_isolation` policies plus the one child guard. ADR 0043's
*Implementation* section has the detail. The "after 0068 and 0119" cases now prove the receipt by the receiving
branch that the 2026-10-08 correction asked for.
