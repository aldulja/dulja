# ADR 0010 — Typed custom-field storage

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Custom fields must be typed, attachable, indexed, validated, and creatable without a schema migration. A column per field cannot meet that contract.

## Decision

Definitions carry one of eight checked kinds, required state, and kind-specific JSON options. Values are JSONB, unique per definition and entity, and normalized by the single pure `@dulja/domain` validator before storage. Money uses `{ amount, currency }`, and decimals use strings, never JSON numbers. The polymorphic entity identifier has no foreign key; the tenant-bound definition foreign key and forced RLS enforce isolation. Both entity and kind use text checks so later expand migrations remain transactional.

The lookup index is `(definition_id, value)`, supporting equality searches for indexed scalar fields.

## Consequences

Party, item, and employee phases can use the predefined entity names without migrations. Definitions are archived rather than deleted, preserving their values for audit.
