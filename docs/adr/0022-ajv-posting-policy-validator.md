# ADR 0022 — Ajv validates posting policies; the `PostingPolicy` type is generated and committed

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 1A

## Context

spec:2008 makes the posting policy a JSON document validated against
`packages/domain/posting-policy.schema.json`, and spec:1711 requires it to be diffable and version-controlled
rather than an opaque blob (SAH-078). Two things follow: something must validate a policy against that schema,
and TypeScript must have a type for it that cannot drift from the schema.

## Decision

- **Ajv** with the draft-2020-12 dialect (`ajv/dist/2020`), one instance compiled once at module load in
  `packages/domain/src/posting/evaluate.ts`, `strict: true`, `allErrors: true`, `useDefaults: false`.
  `useDefaults: false` matters: a policy read back from the database must look exactly as it was seeded, so a
  schema `default` never silently rewrites a stored definition.
- **`json-schema-to-typescript`** generates `packages/domain/src/posting/policy.ts` from the schema. The
  output is **committed**, and `packages/domain/test/posting/policy-type.test.ts` regenerates it and fails on
  a diff — the same discipline spec:2055 applies to `openapi.json`.
- D11's "`decimal.js` only" is a decision about how money is represented, not a ban on every dependency of
  `packages/domain`; the money module keeps exactly one runtime dependency, and the policy module adds one.

## Consequences

- A policy that fails the schema is refused with the JSON Pointer of the offending member, which is what
  `ERR_POLICY_INVALID`'s `detail` reports.
- 2A widens the schema (ADR 0026) and regenerates the type; because the widening adds enum labels and optional
  properties only, the generated type widens and every 1A caller still compiles.
- Ajv is a runtime dependency of `@dulja/domain`, therefore of `@dulja/db`, `@dulja/contracts`, `apps/api`,
  `apps/worker` and `apps/pos`. It is ~120 kB minified, which is acceptable at the till.
- `json-schema-to-typescript` takes the generated type's name from the schema's `title`, not from the `name`
  argument. The generator therefore substitutes `title: "PostingPolicy"` for the compile call only, so the
  schema file keeps a title a human can read while the type keeps the name contracts §4.4.2 fixes.
