# Phase 6D local implementation exit

The authorized default scope implements T0–T8, T12 and T13. T9–T11 remain excluded under OD-10: no paid-out/safe-drop/banking documents, migration 0071, fourth cash stream or ADR 0064. This closes the serial implementation sequence 6A → 6C → 6B → 6D; it does not claim Windows packaged execution or deployment.

## Resulting behavior

Migrations 0070 and 0072 introduce tenant/branch-scoped shifts, immutable till events and the two registered permissions. Opening and closing require live cashier authority; company, branch, terminal and shift ownership are enforced. Accepted messages replay without changing the first close or posting twice. Ticket application requires a known open owned shift. Local closing waits for outstanding ticket/event acknowledgements and refuses an unfinished sale.

Expected cash comes from opening float and posted/reversed cash ledger movements. Exact closes post nothing. Variances create one balanced TILL_OVER_SHORT through the existing posting service, using accounts 1130 and 5120, with atomic close/link rollback and no inventory effects. A manager can close another cashier's shift on the same physical till with the registered authority.

Draft cancellation retains the local ticket and cancellation record while removing only its unsent outbox intent. No-sale/drawer events persist through the signed batch. A completed-sale void requires an acknowledged owned ticket, reason, live base authority and a different PIN-authenticated supervisor above the branch cap. The server invokes the existing financial reversal before inserting the event. Tickets, events and closes run in that order after opens, so a same-batch void is included in expected cash. Return and void intents reserve their source against each other. The local ticket becomes voided only on the real event acknowledgement.

The scoped shift directory and ledger-derived Z-report use validated keyset pagination. Sales-by-cashier groups by cashier and branch, separates discount/revenue aggregates, and includes closers with no sales. Cross-company requests are refused before lookup; hidden branch resources return 404. English/Arabic shift, report and print screens use actual API data; POS controls use the existing strict main-process bridge. No extra IPC method or renderer-held authority was introduced.

## Executed verification

- Final combined report/reconciliation/regression rerun: 38 cases in five files pass, covering report readers, signed reconciliation, immutability/RLS and authority-consumer pins.
- Actual signed reconciliation acceptance: four cases. The busy day uses eight sales, four tender methods, a cash refund, no-sale/drawer events, financial void and close in the same batch. Opening 200, expected 342, counted 340.5 and shortfall −1.5 tie exactly to independent ledger sums and the balanced variance document. Fresh signed replay changes no documents, events or ledger rows.
- Actual offline acceptance: seven cases; 500 locally completed sales plus shift-open are accepted once (501 accepted, zero rejected), with two harmless replays and exact gross/net/tax/tender/stock totals. Timestamps simulate eight hours; this is not an eight-hour elapsed soak.
- POS: 145 cases in 14 files; desktop: 47 in eight. Actual main-process cancellation, events, ACK void, manager close and source reservations have focused passing checks.
- Scoped report API: seven shift-directory cases including hidden branches, pagination, ISO timestamps and malformed cursors. Existing report/OpenAPI checks pass after catalogue pins were extended. Hardened batch API: all 27 cases pass with real owned second-terminal shifts.
- DB schema/close/event coverage includes atomic-close checks, append-only privileges, live authority, rollback, zero/positive/negative variance, financial void/refusal/replay and correct batch ordering. Seed type, idempotence, branch-isolation and final phase-pin corrections pass (7, 5, 15 and 5 respectively). After correcting chart parent links, chart and till-pack suites pass all 13 cases.
- Actual API/browser workflow: two English/Arabic Chromium cases exercise keyboard activation, Z-report, print media, sales view and empty date filters. Four screenshots are retained under `tests/test-results/pos-z-report-*`; the Arabic print screenshot was visually inspected. This fixture is a zero-sales shift; financial reconciliation is proved by the busy-day integration above.
- Leaf suites: domain 301, contracts 61, sync 57, i18n 40, UI 22, backoffice 149, POS 145, desktop 47, edge 38, worker 69 plus two Bun health cases, infrastructure 25.
- Fourteen workspace type checks, lint, eleven custom rules over 1,051 files, formatting and all four persistent Phase 6 contract gates pass. OpenAPI is generated from the actual route registry. POS renderer, embedded CJS and preload build; an isolated built bundle opens all 18 SQLite tables and registers 14 handlers without source imports.

## Broad-suite corrections

The first root suite returned 721 passed, six failed and five existing skips (732 cases). Each failing file now has a passing rerun: role catalogue 8, SAH-051 5, report reader 10, branch scoping 20, SAH-033 and SAH-047. Corrections retain positive real fixtures and permission gates: known owned shifts, new branch-table pins, canonical zero Money and actual main/sync permission consumers. The seed sweep also exposed missing chart parent links for the new till accounts; 1130 and 5120 now attach to existing groups 1 and 5.

The broad API suite returned 769 passed and four failed (773 cases, no skips). Two report catalogue assertions and two second-terminal fixtures were corrected; the report/OpenAPI rerun passed 24, the extended shift API passed seven, and all 27 hardened-batch cases passed. The original broad process is not described as wholly green.

The second root sweep completed with 731 passed, one failed and five existing skips (737 cases / 128 files). Its sole failure loaded the old SAH-047 classification before correction; the final combined 38-case rerun passes all three current SAH-047 cases. Settled coverage is 732 passing cases plus five existing skips. Database final totals are recorded in the whole-phase report after completion. Failures loaded before a correction are distinguished from passing reruns; no skipped or failed case is silently counted as a pass.

Evidence: `/tmp/dulja-phase6d-t13-{api,db,invariants,invariants-final}.log`, `/tmp/dulja-phase6d-t13-{targeted-third,api-reports-final,api-pagination,apply-hardening-second,authority-third}.log`, `/tmp/dulja-phase6-final-{types,lint,rules,format,infra-third,db-branch-corrected,seed-chart-corrected,reconciliation,openapi}.log`, `/tmp/dulja-phase6d-t12-browser-final.log`, `/tmp/dulja-phase6d-t13-{pos-build-final,cjs-proof-final}.log`. Temporary logs are local evidence, not a committed CI artifact.

## External boundaries

OD-07 serials, OD-03 loyalty, OD-10 cash-control documents and unsupplied production staff/email inputs retain their recorded defaults. ADRs 0054–0063 remain Proposed; implementation authorization is in the decision bundle. The Windows installer/native-runtime CI check is configured but has not run in this Linux environment. Signing, real shop printing, production feed, staging, deployment, legacy screen parity and merge are not claimed.
