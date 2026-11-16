# OD-15 material

The owner selected the Phase 5 plan's defaults on 2026-10-02 and authorized best-practice choices for missing inputs. The synthetic tax pack/transmitter and local deployment equivalent complete that implementation scope. The material below is required for the deferred statutory/live integration, rather than for the default local phase exit. This instruction does not establish company applicability or supply credentials.

## Tax-return format — 5A Task 10

Provide the authority's current return publication or a stable citation with its title, issuing body,
publication date and version. Include the accountant's written confirmation of the company's tax
regime, filing periods and publication version in force for those periods. This material supports
ADR 0049 and the verified regime pack; the existing synthetic pack is not a statutory return format.

The requirement is recorded in [5A Task 10](../../superpowers/plans/2026-09-05-dulja-phase-5a-tax-engine-malaysia-pack.md).

## E-invoicing requirements — 5B Task 9

**Put here:** the owner's written confirmation of in-scope status and start date, and a note of
*which* MyInvois environment (sandbox / production) each client identifier belongs to.

**Never put here:** a client secret, a token, a private key or a signed certificate. The secret is
delivered out of band and set as the Cloudflare secret binding `EINVOICE_CLIENT_SECRET` (§3.11);
`company.einvoice_credential_ref` stores the *name* `EINVOICE_CLIENT_SECRET` and never the value.
A secret committed here is a secret in git history for ever.

**Also here:** the retrieval date and the URLs of the authority documentation ADR 0051 was written
from, if the owner supplied them rather than the engineer retrieving them.

The requirement is recorded in [5B Task 9](../../superpowers/plans/2026-09-05-dulja-phase-5b-einvoicing-hooks.md).

The owner released the separate tax-return screen gate for 5A T12 on 2026-10-02 by approving the
plan’s default workflow. Legacy screenshots and a walkthrough are no longer prerequisites for this
task. Earlier OD-24 tasks retain their own gates. See [the screen gate record](../../ui/od-24-phase-5a-screens.md).

The engineer retrieved current official MyInvois SDK documentation on 2026-10-02. [ADR 0051](../../adr/0051-verified-lhdn-myinvois-requirement-set.md) now records the sources, transport facts and required contract reconciliation. This research does not establish company applicability or substitute for credentials.

The public transport is implemented and tested with loopback fixtures. [The sandbox profile draft](myinvois-sandbox-profile.draft.json) is review data, outside the deployed profile directory. The transport requires an explicit legal-field mapper and document encoder; it does not select a version, infer taxpayer identities or provide a certificate signer. Before enabling it, confirm direct-taxpayer versus intermediary registration, covered document types, consolidated/self-billed requirements, document version and signing custody. Stable signed-byte retries, ambiguous/duplicate submission recovery, throttling and cancellation-window behavior then need sandbox verification. ADR 0051 and the production profile guard remain pending.
