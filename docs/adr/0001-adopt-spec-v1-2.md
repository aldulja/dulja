# ADR-0001 — Adopt rebuild-spec v1.2 as the implementation baseline

**Status:** accepted · **Date:** 2026-09-09

## Context

Two documents describe the product: `docs/spec/legacy-system-analysis.md` (kept out of the public repository) explains the legacy system, while `docs/spec/rebuild-spec.md` defines Dulja and its implementation. The 2026-09-04 review corrected blocking RLS defects and inconsistencies; the 2026-09-05 v1.2 pass brought HR & Payroll into v1, added the nine-role catalogue, and completed adversarial verification.

## Decision

Spec v1.2 is the implementation baseline. Its §0.3 decision log (D1–D27) is binding. A deviation requires a new ADR; proposals affecting money semantics, security, the data model, or the sync protocol require owner approval before implementation.

## Consequences

- Plan 0A Task 5 implements the v1.1 principal-policy split and `app_auth` role design; both require owner sign-off before merge.
- Loyalty points in POS v1 must be decided before Phase 6.
- The role names, alias e-mail domain, and the ⚠️ scope rows require owner sign-off before the tasks and phases named in the specification.
