# Repository bug review — 2026-09-30

Review of the current implementation on `5212eb6`, covering request validation, domain date/custom-field
logic, database custom-field and promotion services, API middleware, worker dispatch, desktop storage and
navigation, printing, and build/test configuration. This is a code review and remediation record, not a
phase exit or a guarantee that the repository has no other defects.

## Fixed defects

| Defect | Trigger and result before the fix | Remediation and regression evidence |
| --- | --- | --- |
| Zero-scale decimal custom fields throw | A supported definition with `options.scale: 0` constructs the invalid regex `{1,0}`; even a value of `"12"` throws instead of validating. | Validate zero-scale values as signed integer strings. The new domain case reproduced the exception and now passes. |
| Item custom fields remain unavailable after inventory landed | `setValues(..., "item", ...)` always returns `no item ... in this company`, because the entity guard still treats the item table as a future feature. | Query the existing item table with both entity ID and company ID under RLS. The real PostgreSQL regression reproduced the refusal and tests successful storage/readback and company/tenant refusals. Employees remain gated on their future table. |
| Leading zeroes bypass positive-magnitude validation | `"00.000000"` is accepted as a positive requested quantity and `"00.0000"` as a positive settlement amount. | Refuse every all-zero spelling, retaining legitimate positive values with leading zeroes. Contract regressions failed before the change and pass afterwards. |
| Leading zeroes make valid document lines fail validation | A debit of `"1.0000"` and credit of `"00.0000"` is refused as two nonzero sides. | Compare both sides to numeric zero using decimal-string checks. Regressions cover debit-only, credit-only, both zero, and refusal of two positive sides. |
| Promotion windows compare clock text instead of instants | A start at `12:00+08:00` and end at `05:00Z` is a valid one-hour window but is refused; other offset combinations admit a reversed window. | Compare parsed instants with a fractional-second tie-breaker that preserves precision beyond milliseconds. Contract and real API cases cover create/update, unequal offsets, equal instants, microseconds, and open-ended windows. |
| Promotion timestamps lose microseconds in PostgreSQL parameters | A start at `.000001Z` and end at `.000003Z` collapses to equal timestamps during driver serialization, causing a valid create to return HTTP 500. | Bind create/update/filter timestamps through `text` before casting to `timestamptz`. The real API regression first returned 500, then passed creation, update, timestamp readback and an inside-window filter. |
| Year zero passes storage date validation | `DateSchema` accepts `0000-01-01`, although PostgreSQL has no year zero. | Refuse year zero in the shared calendar helper. The contract regression also ensures `0001-01-01` remains valid. |
| Date formatting silently changes an invalid accounting day | `formatDate("2026-02-30", ...)` renders a day in March instead of refusing the input. | Validate the UTC date round-trip before rendering. Regressions cover impossible days, century leap rules, year zero, and valid leap/early-year dates. The i18n package keeps its required independence from the domain package. |
| Turbo strips the configured Chromium executable | Direct print-engine tests pass with `CHROMIUM_EXECUTABLE_PATH`; the root Turbo test command drops that variable and API/acceptance print cases return 500. | Forward that optional variable to `test` tasks using `passThroughEnv`. Verify through the root Turbo suite, preserving its strict environment mode. |

These changes restore already-declared behavior and validation; they introduce no new money formula,
permission, schema, migration, UI workflow, or phase decision. Existing golden costing fixtures are unchanged.

## Verification

Focused regression tests pass, including real PostgreSQL 18 tests for item fields and promotion windows.
The first attempted Docker pull hit Docker Hub's unauthenticated rate limit; Testcontainers subsequently
obtained the images and database verification became available.

Root type checking passes in all twelve workspaces. `lint`, the eleven custom lint rules, `format:check`,
the four contracts-amendment scripts, and regeneration of OpenAPI with no committed-document diff pass.
The English/Arabic Playwright parity suite passes all ten cases using the workspace's host Chromium
configuration. The backoffice and desktop builds pass with the same placeholder Vite configuration used
by CI. Thirty-three regression cases were added across domain, contracts, i18n, database, and API tests.

The root test run uses `bun run turbo run test --continue=always` so the pre-existing acceptance failures
do not cancel verification of the remaining workspaces. Completed results:

| Workspace | Result |
| --- | --- |
| `packages/domain` | 220 passed |
| `packages/contracts` | 55 passed |
| `packages/i18n` | 40 passed |
| `packages/ui` | 22 passed |
| `apps/backoffice` | 117 passed |
| `apps/edge` | 37 passed |
| `apps/desktop` | 37 passed (unit tests) |
| `infra` | 17 passed |
| `apps/worker` | 34 Vitest cases and two Bun health cases passed |
| `tests` | 500 passed, two pre-existing costing failures, five skipped |
| `apps/api` | 552 passed across 62 files |
| `packages/db` | 1,179 passed across 130 files, including up → down → up schema reversibility |

The full root run completed all twelve workspaces: eleven succeeded and `tests` exited 1 solely for
the two known costing failures. All thirty-three added cases pass. Windows installer and native
Electron specs, and staging/deployed-system checks, were not run in this Linux workspace.

## Existing owner decisions

The two costing failures already recorded in `AGENTS.md` remain owner decisions:

- `tests/invariants/test-07-one-costing-answer.test.ts`: the back-dated AVCO tie-out disagrees because
  issues use a rounded running average while valuation sums rounded per-layer amounts. Resolving the
  valuation/value rule changes accounting semantics and involves ADR 0039.
- `tests/regression/sah-004.test.ts`: reversing the second AVCO purchase retains unit cost `15.0000`
  where the regression expects `10.0000`. Selecting the reversal cost rule also changes accounting semantics.

`AGENTS.md` explicitly says: “Do not decide items marked ⚠️, Confirm, Decide, or OD-## on the owner's behalf”
and “Decisions affecting money semantics, security, the data model, or the sync protocol require an ADR
proposal and owner approval before implementation.” The review preserves these unresolved choices and
does not quarantine their tests. Other known limits and owner gates in that file remain open; this work
does not declare any phase complete.

## Follow-up review of the working-tree fixes

The requested `code-review@claude-plugins-official` plugin was not exposed by the environment's
tools, skill catalogs, local plugin files, or plugin search. The follow-up was a direct code review
of all current implementation and regression-test changes.

Two additional promotion validation defects were reproduced against PostgreSQL 18 and fixed:

- **Sub-microsecond windows returned 500.** A start at `.0000001Z` and end at `.0000002Z`
  pass the RFC 3339 schema and chronological comparison but both round to the same stored instant.
- **Partial window edits returned 500.** Changing only `endsAt` to precede the retained `startsAt`,
  or only `startsAt` to follow the retained `endsAt`, bypasses the body-only window refinement.

The POST and PATCH handlers translate SQLSTATE `23514` specifically for `promotion_window_check`
into `ERR_VALIDATION_FAILED` (HTTP 400) with an `endsAt` field error. The database still validates
the final window atomically; unrelated failures retain their existing mapping. The OpenAPI responses
and committed generated document now describe this validation response.

Both new regression tests first failed with HTTP 500 and now pass. The complete promotion API file
passes all twelve cases, including rounded-window PATCH refusals and verification that refused
edits leave both timestamps unchanged. Root type checking passes all twelve workspaces; `lint`,
the eleven custom lint rules, `format:check`, and `git diff --check` pass. The full suite and builds
recorded above were not repeated for this focused handler change. There are now thirty-five added
regression cases across the combined fixes. The two existing costing decisions remain unresolved.
