# ADR-0002 — Apply SQL migrations with a small runner; keep Drizzle Kit as the diff generator

**Status:** accepted · **Date:** 2026-09-10 · **Spec:** §3.2.2 “Migrations”, §3.9 “Migrations”

## Context

Migration 0001 is handwritten PL/pgSQL containing triggers, policies, and a SECURITY DEFINER function. Drizzle Kit requires its own journal and statement markers, which add friction to SQL that must be reviewed line by line.

## Decision

`packages/db/src/migrate.ts` applies `migrations/NNNN_<name>.sql` in version order, each in its own transaction, and records `(version, name, applied_at)` in `app_meta.schema_migration`. Matching `NNNN.down.sql` files support rollback for CI and local development. Drizzle Kit remains available from Phase 1 to generate reviewed SQL diffs, which this runner applies.

## Consequences

- One monotonic schema version addresses SAH-080.
- CI proves up → down → up in Task 10.
- Production deployments remain forward-only.
