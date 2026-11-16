# Cashier onboarding

1. Create the employee with `POST /v1/companies/{companyId}/employees` (`hr.employee.manage`). Choose the employee's home branch and a unique employee number.
2. Create the credential with `POST /v1/companies/{companyId}/cashiers` (`admin.user.manage`). Choose its selling branch, the person's email and an initial PIN. This creates an email-confirmed provider identity without an invitation; it never exposes a password or returns the PIN. The home branch and selling branch may differ.
3. Assign the `cashier` role and its selling-branch scope using the existing role-assignment endpoint (`admin.role.assign`). Onboarding itself assigns no role.
4. Check `GET /v1/companies/{companyId}/cashiers/{principalId}` (`pos.cashier.manage_pin` in that selling branch). Confirm `snapshot.codes` contains the intended permissions. The employee number identifies a live credential even when its home directory is outside the manager's branch.
5. Have the till pull the catalogue before the cashier signs in. A changed role, policy, PIN or revocation advances the credential's revision.
6. Reset a lost PIN with `POST /v1/companies/{companyId}/cashiers/{principalId}/pin` (`pos.cashier.manage_pin` in the same selling branch). Communicate the replacement privately to its holder; do not share existing PINs through messages or logs.

Never delete a cashier. For a lost badge, use `POST /v1/companies/{companyId}/cashiers/{principalId}/revoke` (`admin.user.manage`). Employee termination will supply the ordinary revocation path in Phase 8C. Revocation removes offline permissions and publishes a catalogue tombstone.

If provider creation fails, the local principal, membership and employee link roll back. Correct the provider error before retrying with a fresh idempotency key. Reusing a successful key returns the original credential metadata without another provider call.
