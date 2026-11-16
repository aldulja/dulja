# OD-11 — cashier alias email domain

## What was asked

An owner-controlled email domain and written acceptance of cashier alias addresses
for people without mailboxes. No domain or mail-administrator acceptance has been
provided. The whole-phase implementation instruction retains the documented
required-email default; it does not supply a production domain.

## What was assumed instead, and where the assumption lives

`CreateCashierBody.email` is required. The cashier creation route and back-office
form require a supplied full address and derive no alias. Local tests use reserved
`example.invalid` addresses. No alias environment variable or production alias
domain is configured.

## What changes when the answer arrives

Register `CASHIER_ALIAS_DOMAIN` in the shared configuration and secret contracts
before implementation. Only then may the create-body email become optional and
the single onboarding route derive a missing address from its minted principal ID.
Update the onboarding runbook and add a real no-email API test in that change.

## What does NOT change, ever

Provider identity is created through the existing AuthAdmin port. A person with a
mailbox supplies their address. An alias does not grant permission, become a PIN,
or replace role assignment and branch scope. No password or PIN is committed or
returned in credential metadata.

## Verify

When a domain is provided, verify its MX records with `dig +short MX <domain>` and
obtain written mail-administrator acceptance of `cashier-<uuid>@<domain>`. Until
then, the focused cashier API tests must require email and prove invalid input
makes no provider call. Run them with:

```sh
cd apps/api
node ../../node_modules/vitest/vitest.mjs run test/routes/pos/cashiers.test.ts
```
