# ADR 0049 — The verified return format

Status: proposed
Date: 2026-10-02
Deciders: the project owner, the accountant, the architect
Supersedes: none
Related: ADR 0050 (one tax computation at persist time), ADR 0051 (5B, the verified MyInvois requirement
set), contracts §2.12 OD-15, contracts hazards 1 and 2, spec:2226, spec:2405, spec:2467

## Context

Slice 5A ships a pluggable jurisdiction pack (contracts §4.9.1) whose regime definitions carry their own
box layouts as data. It ships exactly one definition, `SYNTH-MY-v1`, every literal of which is invented
and marked as such in `app.tax_regime.source`. That is deliberate: contracts hazard 1 forbids a published
statutory figure anywhere in this repository, and hazard 2 forbids any detail of the authority's own
publication until that publication has been read.

Part VII #3 and spec:2467 are explicit that the current requirement set is fetched from the authority and
never reconstructed from this specification or from a model's training data. SAH-020 is the defect this
guards against in its concrete form: the legacy system's GST return multiplied by a rate literal inside a
stored procedure, with no regime discriminator, no effective date and no provenance — so nobody could say
which rate had been applied to which period, or revert one.

## Decision

**Proposed, pending OD-15.** When the owner provides the authority's currently published return
specification:

1. Its citation — title, issuing body, publication date, version — is recorded in the "Publication" section
   below, and **only there**. No figure from it is repeated in this ADR's prose.
2. Its box layout becomes a second `RegimeDefinition` in `packages/domain/src/tax/malaysia.ts`, appended to
   `MALAYSIA_REGIMES`. `SYNTH_MY_V1` is not removed.
3. Its codes and rates become `packages/db/seed/my/tax/<REGIME>.regime.json` and `<REGIME>.codes.json`,
   named by `taxFileNames`, each carrying the citation string in `source`.
4. This ADR moves to `accepted` in the same PR as those files, and the provenance guard
   (`packages/db/test/seed/tax-pack.test.ts`) is what makes that ordering mechanical rather than a habit.

**Until then this ADR carries no rate, no box code, no box label, no form name, no threshold and no
deadline.** An implementer who needs one has hit the gate, not a gap.

## Publication

(empty until OD-15 lands: title, issuing body, publication date, version, and the accountant's written
confirmation that it is in force for the periods Dulja will file)

## Consequences

- **Slice 5A is not blocked.** Every task except this one runs on `SYNTH-MY-v1`, and acceptance test 26 is
  green on it — determinism, validation and the tie-out are properties of the engine and the pack, not of
  any particular rate.
- **Adding the verified regime changes no interface.** `JurisdictionPack.regimes` holds definitions keyed
  `(code, version)` (contracts amendment A3), so a second entry is additive by construction.
- **A tenant already filing under `SYNTH-MY-v1` keeps its filed returns readable**, because nothing is
  replaced and a filed return is never regenerated.
- **The cost of being wrong is bounded to a seed PR.** A misread rate is one reviewed JSON diff with a
  `source` line naming where it came from — not a release, and not a stored procedure.
