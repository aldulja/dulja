# Phase 6C local implementation exit — 2026-10-09

Phase 6C is implemented and locally verified. The whole Phase 6 remains in
progress, proceeding 6A → 6C → 6B → 6D. No merge, deployment or Windows-runtime
verification is claimed.

Migrations 0064–0069, handwritten downs and schema mirrors implement minimal
employees, Argon2id PIN credentials, positive branch rounding/limits, attendance,
exact cashier snapshots and restrictive branch isolation. Company/branch-scoped
staff APIs preserve one provider-backed onboarding writer, private PIN handling,
current authority, bound pagination and indistinguishable invisible resources.
The narrow linked-employee projection supports terminal login without exposing
the ordinary employee directory. Shared POS apply rechecks live cashier and
supervisor credentials, base grants, current limits and cash-rounding evidence.

The branch test uses real posted receipts/issues and rebuilt valuation; direct
child-table reads/writes/reparenting are guarded by parent visibility. Staff,
cashier and branch-limit screens pass actual API-backed English/Arabic browser
workflows and keyboard checks; all captured screenshots were inspected.

Verification:

- Settled acceptance/regression: 667 passed, five existing skips, 121 files.
- Database: broader run 1,608 passed, one stale pre-T9 authority failure, no skips,
  166 files; its complete current permission-catalogue file passes 29 cases in a
  fresh process. Migration/alternate-order/fingerprint checks pass.
- API: broader run 714 passed, eleven failed, thirty-five fixture setup skips,
  82 files. All seven affected files pass 78 focused cases after explicit fixture
  scope and exact OpenAPI route-pin corrections. Current branch/queue/validation
  passes 21 cases; no permission, tenant or financial assertion was removed.
- Worker: 65 broader cases plus the four-case corrected collection suite pass,
  covering all 69 current Vitest cases; both Bun health cases pass.
- Back office 149, domain 301, contracts 61, sync 32, i18n 40 and UI 22 pass.
- Thirteen type checks, lint, eleven repository rules, format, staff UI build,
  persistent contract gates, exact repeated OpenAPI generation and diff checks
  pass. CI includes the 6C contract gate.

The broader-process failures above are retained as evidence; combined passing
current-code corrections do not turn those original processes into wholly green
runs. The whole-phase final matrix will run after the remaining runtime slices.

T11/T12 retain their authorized defaults and decision records: required supplied
email, no alias domain and no fabricated production cashier list. Proposed ADRs
0060–0062 retain formal review status. The later POS application, offline
500-ticket proof, shifts and Z-report reconciliation remain 6B/6D work.
