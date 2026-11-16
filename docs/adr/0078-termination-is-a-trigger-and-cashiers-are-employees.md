# 0078 — Termination is a trigger, and cashiers are employees

- Status: **Proposed** — asked, not decided (spec:95: this touches security). Decisions 1–4 are implemented in 8C
  Task 10 (migration 0093) as the plan's default, ahead of approval, under the owner's direction to implement Phase 8
  entirely; decision 5 is implemented in 8C Task 11 (migration 0094) on the same terms.
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8C · Tasks 10, 11
- Contracts: round 18 B13, B19; §4.6.1 (`employee`, `pos_cashier`); spec:2090, spec:1324, spec:2097

## Context

spec:2090 requires that setting `employee.terminated_on` — **including by direct `app_rw` SQL** or the Phase 9
importer — revokes the till credential, expires every role assignment and tombstones the catalogue, in one
transaction, running **under the terminating actor** so R4 and `forbid_self_grant` still hold. The same sentence adds
a second, independent requirement: an unrevoked `pos_cashier` must reference an employee with `terminated_on IS NULL`
("cashiers are employees", spec:1324).

A **service function** would be bypassed by the importer, by a support engineer's `psql` session and by any later
slice that writes the column; spec:2090 names the direct-SQL path, so a bypassable mechanism does not satisfy it. A
**trigger** cannot be bypassed by anything that writes the row.

## Decision

1. **`app.terminate_employee()` is an `AFTER UPDATE OF terminated_on` trigger on `app.employee`**
   (`employee_terminated`), fired only on the `null → value` transition. In order, it (a) finds the employee's live
   till credentials, (b) expires every live `role_assignment` of `employee.principal_id` **and of each live
   credential's own principal**, and (c) revokes the credentials (`where revoked_at is null`, so a repeat is a no-op
   and the FIRST revocation instant stands). Expiring first means 6C's `refresh_pos_cashier` trigger on
   `role_assignment` empties each snapshot's codes before the revocation, so the revocation is the credential's last
   write and the tombstone 6C writes carries the row's final revision. A credential is keyed on the staff member's
   human principal (spec:2097); one whose principal is not the employee's login is exactly what decision 5 refuses,
   and until then its pos codes must not survive the termination either.
2. **It writes no catalogue tombstone and computes no snapshot.** 6C's `pos_cashier_tombstone` fires on the
   `revoked_at` `null → value` transition this trigger causes (0065), and 6C's `refresh_pos_cashier` trigger fires on
   every assignment it expires (0067) — 6C's own text names "8C's termination trigger" as the path that reaches it. A
   second tombstone or snapshot writer would be two mechanisms for one fact (hazard 9).
3. **It is `SECURITY INVOKER` (the default) and takes no parameter**, so the assignment expiries run as the
   terminating actor: RLS, 8A's `employee_no_self_pay` (R4), Plan 0A's `forbid_self_grant` and
   `keep_last_admin_assignment` all apply, and `hr_payroll` needs no `admin.role.assign`. R4 is a BEFORE trigger on
   the same column, so it runs first and this AFTER trigger only ever sees a termination R4 admitted. The audit rows of
   the employee and of every expired assignment name the terminating principal (SAH-044).
   **One exception, for the credential only:** the two statements that find and revoke `pos_cashier` rows run as the
   tenant's **system principal**, and the caller's actor is restored straight after — ADR 0061's `refresh_pos_cashier`
   precedent. `pos_cashier` carries Form A of `branch_isolation` keyed on the credential's branch, which may differ
   from the employee's home branch; under a branch-restricted HR clerk's own RLS the revoke would match nothing and
   leave a live credential for a terminated employee — the door spec:2090 says the trigger closes. It grants nothing:
   the table has no audit trigger and no actor stamp, the only value written is `now()`, and the rows are exactly the
   terminated employee's. No `SECURITY DEFINER`, no `BYPASSRLS`.
4. **A reinstatement is an explicit act, not a side effect.** The `WHEN` clause is
   `old.terminated_on is null and new.terminated_on is not null`, never `is distinct from`: a corrected date would
   otherwise write a second tombstone for a person already tombstoned, and clearing the column would run the
   revocation on the transition meant to undo it. Clearing `terminated_on` restores nothing; a returning employee gets
   a new credential and new assignments.
5. **"Cashiers are employees" is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on both tables** (migration
   0094, 8C Task 11), raising `ERR_HR_CASHIER_NOT_EMPLOYEE` (B13). Deferral is not a nicety: decision 1 writes
   `terminated_on` before `revoked_at` inside one transaction, and an immediate constraint would see that intermediate
   state and abort the very path spec:2090 mandates. As built (`app.assert_cashier_is_employee()`, triggers
   `pos_cashier_is_employee` — `after insert or update of employee_id, revoked_at` — and
   `employee_cashier_still_employed` — `after update of terminated_on`): the check reads the table **as it stands at
   COMMIT**, so a violation repaired inside the same transaction (a reinstatement) passes; and it reads **as the
   tenant's system principal**, the caller's actor restored straight after — the exception decision 3 makes for the
   revocation, applied to a read. `pos_cashier` (Form A, the credential's branch) and `employee` (Form A′, the home
   branch) are each RESTRICTIVE on a different branch, so a check under the actor's own RLS would find no row when
   either side is hidden and pass the violation it exists to refuse — a clerk restricted to the credential's branch
   could un-revoke the credential of an employee whose home branch they cannot see
   (`packages/db/test/hr/cashier-is-employee.test.ts` fails on the actor-RLS form). The function writes nothing.
   What 0094 does **not** enforce: that a credential's principal is the employee's login. spec:2090 names only the
   terminated case; 6C's `createCashier` service already refuses the mismatch (`e.principal_id = principalId`), and
   many POS fixtures mint a credential on its own principal (`seedCashier` without `principalId`).

## Consequences

- **Terminating the tenant's last administrator raises `ERR_RBAC_LAST_ADMIN` and the whole transaction rolls back**
  (`packages/db/test/hr/termination.test.ts` pins it). That is correct rather than unfortunate — a tenant cannot be
  left without one — and the answer is to appoint a successor first. It follows from decision 3.
- **The two mechanisms close the door from both sides**: the trigger revokes when the employee leaves; the constraint
  refuses a credential that would outlive one. The post-termination state — a revoked credential pointing at a
  terminated employee — is admitted by both.
- **Nothing is deleted.** `pos_cashier.revoked_at` and `role_assignment.expires_at` are set; the rows, the payroll lines
  and the payslips remain for the retention period (spec:2049).
- A termination is auditable end to end without a second table: `app.audit_log` carries the `employee` and
  `role_assignment` images with the terminating principal as `actor_id`. `pos_cashier` is AUDIT_EXEMPT (0065), so its
  revocation is evidenced by the row itself and the catalogue tombstone.

## Owner questions

1. Decision 3's exception — the credential revoked as the system principal so a branch-restricted terminator cannot
   leave a credential live at a branch they cannot see — is the implementer's resolution of spec:2090's "under the
   terminating actor" against 6C's branch isolation. Accept it, or require the terminating actor to see every branch
   the employee holds a credential at (and refuse otherwise)?
2. Decision 1 also expires the assignments of a credential's own principal when it is not the employee's login.
   The API cannot create that state (6C's `createCashier` binds the credential to `employee.principal_id`), but no
   constraint refuses it — 0094 enforces only spec:2090's terminated case — so a direct write or the importer can.
   Accept the expiry as belt-and-braces, or narrow it to `employee.principal_id` as spec:2090's text reads? (And
   should a later migration also constrain `pos_cashier.principal_id = employee.principal_id`?)
3. Decision 5's read as the system principal — accept it, or require a principal that can see both sides?
