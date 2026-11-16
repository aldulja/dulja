# OD-12 — cashiers per branch

## What was asked

The actual employee numbers, names, branches and contact addresses of the people
who will operate each till. No real cashier list has been provided.

## What was assumed instead, and where the assumption lives

There are no production cashier seed rows. Tests create synthetic people only in
their isolated databases. The implemented employee and cashier screens and
[onboarding runbook](../runbooks/cashier-onboarding.md) provide the operator path.

## What changes when the answer arrives

An authorized operator follows the runbook once per person: create the employee,
create their provider-backed credential, assign the existing cashier role with its
actual selling-branch scope, and verify the next catalogue pull. Perform real
onboarding only when the owner supplies the people and authorizes that action.

## What does NOT change, ever

Cashiers are people with provider identities, not tenant configuration seed-pack
data. There is no cashier SubPack, loader or version-controlled list of PINs.
The existing route remains the single onboarding writer; supplying a list does
not create a second identity path, widen a branch grant or authorize deletion.

## Verify

For each authorized person, verify their employee number and live credential using
`GET /v1/companies/{companyId}/cashiers/{principalId}` under a human authorized for
that selling branch. Verify the assigned role's snapshot, then pull the catalogue
and test the privately communicated PIN at the till once Phase 6B is available.
Cross-branch/company/tenant requests must remain refused. No real-person or live
provider verification is claimed by the local synthetic tests.
