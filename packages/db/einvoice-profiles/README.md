# E-invoice transmitter profiles

A **profile** is the remote call shape of a fiscalisation authority, expressed as data (ADR 0052).
`packages/domain/einvoice-profile.schema.json` is what a profile must satisfy;
`packages/db/src/einvoice/profile.ts` loads one; `createHttpTransmitter` turns it into an
`EInvoiceTransmitter` (§4.9.3).

## Rules

1. **A file's `source` says where its values came from.** For a real authority that is the ADR that
   recorded the authority's _own current documentation_ — never this repository, never a summary,
   never a model's recollection (spec:2226, spec:2467).
2. **`synthetic.v1.json` points at loopback and nowhere else.** It exists so CI, `bun run dev` and
   every test in slices 5B onward can exercise the whole transmission path with no network.
   `scripts/check/no-authority-literals.sh` fails the build if its `baseUrl` leaves `127.0.0.1`.
3. **A new authority schema version is a new file**, `<code>.v<n+1>.json`, beside the old one. The
   old one is never edited: `einvoice_transmission.profile_version` records which file each call was
   made with, so a completed transmission stays readable against the file that produced it
   (SAH-013's pinning applied to an integration).
4. **This directory is deliberately not under `packages/db/seed/`.** 2C made `assertPackShape`
   derive its allowed directories from `SUB_PACKS` (§4.2.13), so an unregistered directory there
   makes `bun run seed` exit 3. A profile is not per-tenant data and needs no loader.
5. **Adding `myinvois.v1.json` is the OD-15 task and nothing else** (slice 5B Task 9). Until it
   exists, a company set to `myinvois` gets `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from the
   registry — by design, and visibly.

The committed synthetic origin reserves port 0 as a fixture placeholder. To verify a running stub without editing the pinned file, use `einvoice:verify --profile synthetic --base-url http://127.0.0.1:<port>`. The override is confined to that verification probe and an explicit local origin. It cannot redirect an authority profile or change application registration. The Phase 5 owner selected the documented synthetic/local equivalent on 2026-10-02; live statutory integration remains a separate OD-15 step.
