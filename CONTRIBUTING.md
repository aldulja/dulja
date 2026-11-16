# Contributing to Dulja

The sections below are copied verbatim from `docs/spec/rebuild-spec.md` (v1.2). If they drift, the specification wins.

## 0.2 Operating brief for the implementing agent

You are **implementing**, not re-deciding. The rules below are the contract.

**Work in the phase order of Part V.** A phase begins only when the previous phase's _definition of done_ passes in CI. Do not start Phase 3 with Phase 1's integrity checker still red.

**Part I is your regression suite.** Before closing any phase, write a test for every `SAH-###` that phase touches (the Appendix A index maps each defect to a root cause; §3.9 says where the test files live). If you can reproduce a Part I failure scenario against Dulja, the phase is not done.

**On `⚠️` markers, two kinds.**

- **Owner decides — stop and ask:** LHDN MyInvois specifics (§4.7); whether serials are needed and every row of §3.0.3; whether historical POS data must migrate (Part VII #10); the v1 costing method (§3.4 recommends weighted average — confirm); the code-signing certificate (§5.0 task 0.13); the v1.1 and v1.2 changelog rows marked _Confirm_ or _Decide_ (header of this document); the nine role names (§4.2.1); the ⚠️ rows in §3.0.4 and §3.10.1.
- **Agent verifies and records an ADR — do not stop:** the PDF engine (§3.2.2 — decide in week one with a real Arabic tax invoice); oxfmt stability; pg-boss on Bun; pgroll adoption (§3.2.2).

**On everything else that is unspecified:** if it is low-stakes (a component name, a folder, a library version), decide, record it in an ADR under `docs/adr/`, and proceed. If it touches **money semantics, security, the data model, or the sync protocol**, write the ADR _as a proposal_ and ask before implementing.

**Never**, at any phase, for any reason:

- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (SAH-036/037/069);
- issue DDL from application code (SAH-053);
- disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053);
- gate an audit write on any flag (SAH-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

**The UI is not specified here.** Before beginning any screen, request from the owner: screenshots of the equivalent Sahlisoft screen, and a two-minute description of how a fast operator uses it. Design the new screen to be _at least as fast by keyboard_. Do not invent workflows from this document.

**Report per phase**, in writing, against the definition of done — what passes, what does not, what you decided under ADR, what you are asking. Short.

## 3.9 Engineering conventions

Settled so the agent does not have to decide them, and so every module looks the same.

**Identifiers.** `uuidv7()` server-side for everything (time-ordered, index-friendly). The POS generates a `uuidv7` at the till for each ticket (the `uuid` npm package or Bun's built-in), carried as `document.client_ref`. Never a sequential integer as a public identifier; never reuse; never rewind (SAH-021).

**Time and dates.** All timestamps `timestamptz`, stored in UTC. Every company has a `timezone` (`Asia/Kuala_Lumpur` for the first customer). **`effective_date` is a `date`, entered by the user, and is the accounting date** — it is never derived from `posted_at`. Fiscal period is resolved from `effective_date` at posting and stored on the row. Hijri display is a presentation concern via `Intl`; storage is always Gregorian.

**Money.** `numeric(19,4)` in Postgres. In TypeScript, `Money` is an opaque type wrapping `decimal.js`, carrying its currency; the compiler rejects adding MYR to USD. Display rounding applies the currency's policy at render time; **stored base amounts are never recomputed on read.** No `number` type ever holds a monetary value — a lint rule enforces it.

**Quantities.** `numeric(19,6)`. Unit conversions are exact rationals `(numerator bigint, denominator bigint)`, never floats (SAH-066). Quantity is stored once, in the item's base unit; the entered unit and quantity are kept for display.

**Naming.** `snake_case` everywhere in SQL; **singular** table names (`ledger_entry`, not `ledger_entries`), matching §3.8; enum types singular. TypeScript: `camelCase`, types `PascalCase`. Bilingual names on master data as `name_en` / `name_ar` columns — not a JSON blob.

**Enumerations.** Postgres `enum` for closed sets the code branches on (`document_status`, `period_status`, `account_type`). A lookup table for open sets the user extends (`document_type`, `dimension_type`, `tax_code`).

**Deletion.** Financial rows: never — reversal only. Master data: `archived_at`, never `DELETE`. HR master data: archived, never deleted; a terminated employee keeps every payroll line and payslip for the statutory retention period. Genuine deletion exists only for drafts and for the GDPR/PDPA erasure workflow, and both write an audit row first.

**Error codes.** Every error the API can return has a stable string code `ERR_<DOMAIN>_<REASON>` (`ERR_LEDGER_UNBALANCED`, `ERR_PERIOD_NOT_OPEN`, `ERR_STOCK_INSUFFICIENT`), a human message naming the specific entity, and a remedy. Codes are enumerated in one file; a code no code raises fails the build (the inverse of SAH-084).

**Database access.** Every query — reads included — runs inside `withTenant(tx => …)`, which opens the transaction and issues the two `set_config(…, true)` calls before anything else. A lint rule forbids bare `db.` calls. Without this RLS silently returns zero rows (§3.8).

**API.** `/v1/…`. Cursor pagination. `Idempotency-Key` header required on POST/PUT/PATCH/DELETE. `application/problem+json` errors. OpenAPI generated from Zod, committed, diffed in CI.

**Migrations.** One migration per PR, named `NNNN_<verb>_<noun>.sql`. **Production is forward-only.** Every migration ships a hand-written `NNNN.down.sql` that CI applies and then re-applies up on a Testcontainers database — "reversible" means that file exists and passes, not that production is ever rolled back. Expand/contract for any change touching a live table. Drizzle Kit generates the up; a human reads the SQL before merge. A CI check fails any new table lacking `tenant_id`, RLS, or an audit trigger.

**Tests.** `tests/regression/sah-NNN.test.ts` — one file per Part I defect the current phase touches, named for it, so coverage of the defect register is greppable. `tests/invariants/` — the ledger and tenant-isolation suites, run on every PR. `tests/golden/` — costing and tax fixtures with expected output committed.

**Localisation.** Every user-facing string goes through i18next with an ICU message; a CI check fails any hard-coded string in a component. Both catalogues must be complete before merge — no empty `msgstr`, no source-language fallbacks in the other language (SAH-085).

**Logging.** Structured JSON; `tenant_id`, `actor_id`, `request_id`, `trace_id` on every line; never a token, password, or full card number. A lint rule forbids `console.log` outside scripts.
