# ADR 0012: Seed-pack format — JSON files under `packages/db/seed/<pack>/<sub-pack>/`, one loader per sub-pack

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C

## Context

`FORCE ROW LEVEL SECURITY` binds `app_migrator` as well as `app_rw` (spec:1366), and a migration file issues no
`set_config`, so a migration sees no tenants and cannot write a single per-tenant row. Roles, role grants, the
chart of accounts, dimension values, fiscal periods, document types, templates, report definitions, tax codes and
statutory rate tables are therefore **not** migration data. Only `app.permission` — global, no RLS — is.

Twelve slices contribute rows across nine phases. Two failure modes have to be designed out: a slice seeding a row
into a table a later slice creates, and eight parallel writers editing one file.

## Decision

1. **Per-tenant rows are seed-pack data**, applied by `bun run seed --tenant <uuid> [--only <sub-pack>]`, run as
   `app_migrator` from `packages/db/src/cli.ts`. Never an endpoint (spec:2188, SAH-039).
2. **A pack is a directory of sub-pack directories**; a sub-pack is a directory of JSON files. Phase 0's pack is
   `packages/db/seed/my/` with exactly `chart-of-accounts/`, `dimensions/` and `fiscal-periods/`; `assertPackShape`
   fails the run, exit code 3, if a later slice's directory appears early, naming the owning slice.
3. **One loader module per sub-pack**, `packages/db/src/seed/<sub-pack>.ts`, shipped by the slice that introduces
   the sub-pack. A slice that adds *rows* to an existing sub-pack adds a **file**, never a loader — which is why
   the chart of accounts is `chart-of-accounts/<slice>.json` (§4.15) and not one shared file.
4. **Idempotent by construction.** Every insert is `on conflict do nothing` on the row's natural key, except a
   `posting_policy` version, which is `on conflict … do update` (§3.4.8) so a placeholder cannot outlive the real
   definition. Running the seed twice changes nothing — including `app.audit_log`, which means an `update` must
   carry `where <col> is distinct from <new>` or it will fire the AFTER ROW audit trigger on every deploy.
5. **The loader order is application order, not alphabetical:** `roles`, `dimensions`, `fiscal-periods`,
   `chart-of-accounts`. `--only` preserves the order the flags were given, so an operator can re-apply one.
6. **Exit codes:** 0 success · 1 seed failure · 2 configuration error · 3 pack-shape violation.

## Consequences

- The seed is a release-runbook step after every deploy (§3.4.8), which is why idempotency is load-bearing rather
  than convenient.
- A slice adding a sub-pack edits `SUB_PACKS`, `PHASE_0_SUB_PACK_DIRECTORIES` (renaming it as the pack grows) and
  `OWNED_ELSEWHERE` in `packages/db/src/seed/packs.ts` — three small, reviewable lists.
- JSON rather than TypeScript for the data: a pack is reviewed as a diff by an accountant, and `roles.ts` is the
  one exception because §5.2 places the role list in `packages/db/seed/roles.ts` and its `admin` set is computed.
