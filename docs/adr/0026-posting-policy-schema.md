# ADR 0026 — The posting-policy schema, in full

**Status:** PROPOSED — this ADR touches the data model, so spec:95 requires it to be written as a proposal and asked before implementing. spec:2006 requires it by name: "Phase 2 opens with an ADR proposing this schema in full."
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2A

## Context

The legacy system encoded document behaviour as ~35 boolean flags on `Muniments` plus XML options (LEGACY-013, LEGACY-072, LEGACY-078). Nothing declared which combinations were legal, the rules lived in client code and trigger branches, and a reversal read the *current* flags rather than the ones originally applied. spec:1075 states the replacement: "Document types are data; posting rules are versioned policy objects — declarative, validated, tested, and *pinned to each posted document* so history is never re-interpreted."

1A shipped `packages/domain/posting-policy.schema.json` at the subset the JOURNAL type needs, so `postDocument` had a type to compile against and the seed had a schema to validate. That subset cannot express a sales invoice, a payroll run or a POS ticket.

## Decision

`packages/domain/posting-policy.schema.json` is widened to the full text in contracts §4.4.1, keeping `$id: urn:dulja:posting-policy:1` and `"version": { "const": 1 }`.

A policy declares:

- **`direction`** (`inbound | outbound | internal | none`) and **`requires`** — header fields the document must carry before it may post (`party`, `warehouse`, `to_warehouse`, `attributed_to`, `client_ref`, `reverses_document`).
- **`lines`** — the ledger lines the document produces. Each rule names a **scope** (`for`: `each_line`, `each_tax`, `document`), a **side**, an **account reference** (one of thirteen resolution paths, or a literal `{ "code": "…" }` resolved against `app.account.code` of the document's company and registered in contracts §4.15), an **amount reference** (one of thirteen), an optional **`when`** conjunction of equalities, and an optional **`dimensions.from`** list naming where the line's analysis dimensions come from.
- **`inventory`**, **`tax`**, **`numbering`**, **`reversal`**, **`approval`** (with the optional `create` code this document adds to the spec's block), **`fxRoundingAccount`** and **`dimensions.required`**.

The schema is `additionalProperties: false` at every level. A document-type seed file is therefore an **envelope** whose `policy` member is the policy (contracts §4.3.7): `nameEn`, `nameAr`, `module`, `policyVersion` and `effectiveFrom` live outside it.

**Two numbers, one word.** `policy.version` is the *schema* version and is `const 1`; the envelope's `policyVersion` is the `app.posting_policy.version` row number under `unique (document_type_id, version)`.

**A schema change is a new `version` const and a new `$id`**, proposed through the contracts document. This widening is not such a change: it adds enum labels and optional properties only, so every file valid under 1A's subset is still valid. It completes version 1.

## Alternatives considered

- **A DSL or a small expression language for `amount`.** Rejected: an expression language is a parser, an evaluator and an injection surface, and spec:2053/LEGACY-036 exists because the legacy system built behaviour out of strings. A closed `amountRef` enum is checkable by CI, diffable in review, and exhaustively switchable in TypeScript.
- **Per-document-type schemas.** Rejected: `validatePolicy` would have to pick a schema by document type, which is the flag-dispatch LEGACY-013 describes, one level up.
- **A `version: 2` schema now.** Rejected: 1A's committed policies and the `PostingPolicy` type would need a migration for a change that removes nothing.

## Consequences

- `evaluatePolicy` must handle every member the schema admits or the schema promises what the engine cannot do; 2A Task 6 does that, and its test file has one case per enum label.
- A reference whose backing table does not exist yet (`item.*` is 3A's, `tax_code.*` is 5A's, `line.component.*`/`line.scheme.*` are 8A/8B's) resolves through the structural `ItemRef`/`TaxCodeRef`/`PayComponentRef`/`SchemeRef` shapes declared in core (contracts §4.4.2, spec:2366 — "core never imports HR"), and yields `ERR_POLICY_REQUIRES_MISSING` naming the reference until its slice populates `snapshot.refs`.
- Every seeded policy is a reviewed diff of a version-controlled file (LEGACY-078), and every posted document pins the `posting_policy_id` that produced it (LEGACY-013).
