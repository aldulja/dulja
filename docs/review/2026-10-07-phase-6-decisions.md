# Phase 6 decision proposals — 2026-10-07

The owner authorized starting Phase 6 after Phase 5 merged. These concrete proposals are prepared for review under AGENTS.md's Owner Gates and Decisions and spec §0.3 (spec:95): money semantics, security, the data model and sync-protocol decisions require an ADR proposal and owner approval before implementation. The subsequent renewed instruction, “please implement the whole phase 6”, followed presentation of these proposals and the explicit approval request. It authorizes implementing the presented recommendations and Phase 6 default-screen baseline. This records implementation authorization, not statutory acceptance or phase completion.

The proposals use the exact filenames assigned by the four Phase 6 plans and the ranges in Plan Contracts §3.9. ADRs 0057–0063 retain the supplied plan text and its original date; preparation notes distinguish that source date from this review date. ADRs 0054–0056 turn the plans' explicit ADR instructions into reviewable Context/Decision/Consequences proposals.

| ADR | Decision to approve | Status |
|---|---|---|
| [0054](../adr/0054-commit-ordered-catalogue-revisions.md) | Shared tenant lock; revisions and tombstones | Implementation authorized; ADR retained for review |
| [0055](../adr/0055-terminal-identity-and-the-terminal-jwt.md) | Device enrolment, identity and JWT | Implementation authorized; ADR retained for review |
| [0056](../adr/0056-up-sync-apply-savepoints-and-refusal.md) | Savepoints, deduplication and refusal semantics | Implementation authorized; ADR retained for review |
| [0057](../adr/0057-till-sqlite-is-a-cache.md) | SQLite cache, outbox and device-loss recovery | Implementation authorized; ADR retained for review |
| [0058](../adr/0058-pos-main-process-is-a-build-output.md) | POS build output loaded by Electron | Implementation authorized; ADR retained for review |
| [0059](../adr/0059-pos-cash-rounding-has-no-ledger-account.md) | Cash rounding as a signed line discount | Implementation authorized; ADR retained for review |
| [0060](../adr/0060-argon2id-in-webassembly.md) | Shared WASM Argon2id PIN implementation | Implementation authorized; ADR retained for review |
| [0061](../adr/0061-cashier-snapshot-is-a-projection.md) | Offline cashier projection; report-only drift job | Implementation authorized; ADR retained for review |
| [0062](../adr/0062-branch-isolation-five-forms.md) | Five restrictive branch policy forms | Implementation authorized; ADR retained for review |
| [0063](../adr/0063-shift-close-derives-expected-cash.md) | Ledger-derived shift expected cash | Implementation authorized; ADR retained for review |

## Implementation authorization

The user renewed the whole-phase implementation instruction after this bundle and its recommended alternatives were presented. Implementation proceeds with ADRs 0054–0063 and the recommendations below:

- The currency rounding column remains display-only; the branch policy is the sole cash-rounding source. Branch increments must be positive, with the plan’s configurable `0.05` default. Zero does not disable rounding. No currency seed value changes and no jurisdictional rule is inferred.
- Phase 6 uses the plans’ screen workflows and keyboard maps as its UI baseline: 6B T11, 6C T13 and 6D T12. EN/LTR, AR/RTL and keyboard behavior require verification. Unavailable legacy reference material means legacy parity remains unproven. Other phases’ OD-24 gates retain their records.

These choices resolve the two rounding discrepancies raised in the proposals. ADR 0059 records the positive-only treatment; the shared contract will carry the same resolution before the relevant runtime tasks.

## Conditional work remains gated

No `docs/owner/od-10/` owner input is present. 6D Tasks 9–11 explicitly require that input before execution. ADR 0064 is not created, migration 0071 stays unused, and no paid-out, safe-drop or banking implementation is authorized by this review index. The owner may provide OD-10 separately; the ungated proposals above do not depend on it. Other owner dependencies retain their existing gates. The renewed instruction authorizes the Phase 6 UI baseline described above.

## Verification scope

The proposals were checked against the repository plans. Runtime verification is recorded separately in `docs/reports/phase-6.md`; this index does not claim completion.

## Authorization applied

The implementation uses the branch increment alone, with positive-only validation and the configurable `0.05` default from 6C; the currency increment stays display-only. Zero does not disable rounding. The signed-discount adjustment and tax recomputation are ADR 0059’s proposed treatment. Phase 6’s planned screen workflows and keyboard maps are the authorized baseline, verified in EN/LTR and AR/RTL; no unavailable legacy keyboard parity is claimed. These choices do not enable optional OD-03/07/10 features, generate real cashier identities, supply a Windows certificate or authorize deployment. ADR statuses remain Proposed for review, with implementation authorization recorded separately.
