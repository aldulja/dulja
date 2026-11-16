# Dulja — Building the Replacement for a Legacy Accounting System
## Defect register, root-cause analysis, and a SaaS-grade target specification

**Audience:** the engineering agent/team implementing **Dulja**, the product that replaces a legacy accounting system.
**Document version:** 1.2 · 2026-09-05 · **Status: ready for implementation** (see §0.2 for how to begin). Changelog at the end of this header block.
**Evidence standard:** every defect in Part I cites the source file and line it was read from; every settled decision is logged in §0.3.
**Review status:** two independent adversarial review passes (56 findings raised, all resolved); reference schema in §3.8 reviewed for Postgres 18 correctness including concurrency of the audit chain, RLS on identity resolution, and cross-tenant FK hardening. A third pass (v1.1, this version) found that the identity-resolution path could not work as written under `FORCE ROW LEVEL SECURITY`, and that the bootstrap could not insert its first principal; both are corrected and listed in the changelog below. A fourth pass (v1.2, 2026-09-05) brought **HR & Payroll into v1** and added a **named role catalogue** on the owner's instruction; three independent design proposals (minimal, compliance-first, operator-first) were compared and judged before the synthesis in §3.10 and §4.2.1–4.2.2.
**Companion document:** `legacy-system-analysis.md` (architecture & data-model dossier — the *what it is*; kept out of the public repository). This document is the *what is wrong with it and what to build instead*.

**Changes in 1.1 (2026-09-04)** — rows marked *Confirm* or *Decide* need the owner's sign-off before task 0.2 (§5.3).

| # | Change | Where | Owner |
|---|---|---|---|
| 1 | The product is named **Dulja**. Title, audience and every reference to "the new system / the replacement" updated; decision D24 added. | throughout, §0.3 | — |
| 2 | **Bootstrap-blocking RLS defect fixed.** `principal_in_tenant` was a USING-only policy. Postgres reuses USING as the INSERT check when no WITH CHECK is given, so a principal could never be inserted before its membership existed — and membership references principal. Split into SELECT/UPDATE policies plus a separate INSERT policy. | §3.8, task 0.7b | *Confirm* |
| 3 | **Login-blocking RLS defect fixed.** `resolve_principal` was SECURITY DEFINER owned by `app_migrator`, which is itself subject to `FORCE ROW LEVEL SECURITY`. Called before `set_config`, it could only ever return nothing. It is now owned by a dedicated `app_auth` role (`NOLOGIN`, no role attributes) that owns nothing else and reads `principal` and `membership` through **role-scoped RLS policies** (`for select to app_auth using (true)`) — not through `BYPASSRLS`, which only a superuser can confer, and Supabase's `postgres` role is not one. | §3.8, tasks 0.2, 0.6 | *Confirm* |
| 4 | Generic audit trigger specified as **AFTER ROW** (the bootstrap's self-citing system principal depends on it). `tenant`, `principal`, `permission` have no `tenant_id`; the generator's variants for them are now stated. | §3.8, task 0.8 | — |
| 5 | The 0.4 linter rule conflated the *immutable* list with the *audit-exempt* list; derived tables (`account_balance`, `cost_layer`, `cost_consumption`) are audit-exempt but must stay updatable by `app_rw`. Rule restated. | §3.8 | — |
| 6 | Self-referencing and reversal FKs (`account.parent_id`, `dimension_value.parent_id`, `document.reverses_document_id`) converted to the composite `(tenant_id, …)` form the schema's own rule requires; `document.party_id` annotated as a Phase 2 FK. | §3.8 | — |
| 7 | D5 reworded: Bun runs the API, workers and build; the **test suite runs under Node 24**, as §3.2.2 already said. Decision unchanged; the wording contradicted itself. | §0.3, §3.0, §3.2.2 | — |
| 8 | "ULID" replaced by uuidv7 everywhere; the footnote that reconciled the two terms removed. | D17, §3.7.3, §3.9 | — |
| 9 | Loyalty points: §3.0.3 listed them as probably not v1 while §3.7.6 and Phase 6 included them. Now ⚠️ owner-confirm in all three places. | §3.0.3, §3.7.6, Part V | *Decide* |
| 10 | Data export (v1 in §4.3) placed in Phase 7; the first PITR restore drill (§4.8) placed in the Phase 1 definition of done. | Part V | — |
| 11 | Task 0.13 gains an explicit verify-and-ADR item: Bun workspaces + electron-builder dependency resolution, and `better-sqlite3` rebuilt against Electron's Node ABI. | §5.0 | — |
| 12 | Repository layout gains a root `CLAUDE.md` pointing the implementing agent at §0.2 and `CONTRIBUTING.md`. | §5.2 | — |
| 13 | "first fifteen tasks" → sixteen (0.1–0.15 plus 0.7b). | §0 | — |
| 14 | `ledger_entry_dimension.entry_id` was a plain FK to a tenant-scoped table, violating the schema's own composite-FK rule; `ledger_entry` gains `unique (tenant_id, id)` and the join uses `(tenant_id, entry_id)`. Found while writing the 0.4 linter, which now checks this rule mechanically. | §3.8 | — |
| 15 | Bootstrap and API convention stated: insert a `principal` **without `RETURNING`** and its `membership` in the same transaction — a `RETURNING` clause is checked against the SELECT policy, which needs the membership that does not exist yet. | §3.8 | — |

**Changes in 1.2 (2026-09-05)** — owner decision: Dulja v1 comprises **four modules — Accounting, Inventory, HR & Payroll, POS** — and a concrete user-permission model with named roles. Rows marked *Confirm* need sign-off before the phase they name.

| # | Change | Where | Owner |
|---|---|---|---|
| 16 | **HR & Payroll is in v1.** Phase 8 is redefined from "Verticals — deferred" to "HR & Payroll [v1]"; the other verticals move to a new Phase 10 (deferred). D20 reworded; D25 added. Full design in the new §3.10. | §0.3, §3.0.1, §3.3, §3.10, Part V | — |
| 17 | **Role catalogue.** Nine tenant-seeded system roles (`admin`, `accountant`, `user`, `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `auditor`, `pos_terminal`), a `<module>.<resource>.<action>` permission scheme in five modules, branch-scoped assignments, and eight segregation-of-duties rules enforced in the data layer. D26 added. | §4.2.1, §4.2.2, §3.8 | *Confirm* the role names before task 0.7 |
| 18 | §3.8 RBAC tables extended: `role_assignment` stays a join table but gains `granted_by`, `granted_at`, `expires_at` and a `(tenant_id, …)` unique key; new child `role_assignment_branch` for branch scope; `role` gains `description`, `is_system`; `permission` gains `module`, `mutating`; `app.actor_has(code, company, branch)` as the one authorisation predicate, usable inside RLS policies; a no-self-grant trigger; `principal.auth_subject` gains a per-kind CHECK; `document` gains `branch_id`. | §3.8, Plan 0A Tasks 5–7, 9–11 | — |
| 19 | `document_event` (Phase 2): append-only record of every status transition with its actor; the maker ≠ checker rule reads it. | §3.3, §3.8, §4.2.2 | — |
| 20 | **Module coverage map** (§3.0.4) added, and gaps closed for the first customer: bank reconciliation (Phase 4), goods receipt with GRNI accrual and an import-shipment document (Phase 3), delivery order (Phase 3), stock count with variance posting (Phase 3), two-step inter-branch transfer with in-transit (Phase 3), expiry write-off (Phase 3), till paid-outs / safe drops / banking (Phase 6), post-dated cheques (Phase 4), BRANCH mandatory on revenue, COGS and staff-cost lines. D27 added. | §3.0.4, Part V | *Confirm* the ⚠️ rows |
| 21 | Cashier identity restated: `pos_cashier` (Phase 6) holds the PIN hash, branch and snapshotted authority; every cashier — even one who never opens the back office — has a real Supabase auth user created through the admin API (random undisclosed password, alias address on a tenant domain the owner supplies), so §4.2's rule that a principal comes only from a Supabase-obtained `sub` still holds; termination revokes credential and assignments in one transaction; sync apply re-verifies cashier authority and supervisor overrides server-side. | §3.7.5, §3.7.6, §3.10.2 | *Confirm* the alias e-mail domain before Phase 6 |
| 22 | Glossary rows for the legacy Salaries module; §4.6 names HR PII under field-level encryption with statutory retention; §4.7 adds the payroll statutory-pack rule; §4.11 adds the HR encryption key to the secrets inventory; §5.1 adds two migration hazards; §5.2 adds `packages/domain/payroll`, `packages/db/seed/my/statutory/`, `packages/db/seed/roles.ts`; §5.3 adds owner dependencies for tasks 0.7, Phase 6 and Phase 8; Part VI adds tests 28–39; Part VII adds items 13–15. | throughout | — |
| 23 | **Verification pass on v1.2** (four independent verifiers, one of which assembled and ran the §3.8 / Plan 0A SQL on PostgreSQL 18; skeptics re-checked each finding). Fixed: `resolve_principal` ownership transfer needs `CREATE` on the schema and the REVOKE/GRANT must precede it; `forbid_self_grant` must use nested IFs (PL/pgSQL compiles `new.principal_id` against `role_permission`'s row type); `audit_log.actor_id` FK is `deferrable initially deferred` (the tenant row is audited before its system principal exists); `ledger_entry` is exempt from the `created_at` linter rule. | §3.8, Plan 0A Tasks 5, 6, 9, 11 | — |
| 24 | Segregation of duties made enforceable and self-consistent: R1/R2 move into the Phase 2 status trigger (which also writes `document_event` and enforces legal transitions, failing closed); R3 returns a run to `draft`, not a non-existent `calculated`; R6 exempts `admin` (it holds every code by construction); R7 covers `auditor` only; kind-discipline and last-admin rules gain their triggers; actor columns are stamped by trigger, never trusted from a default. | §3.8, §4.2.2 | — |
| 25 | `actor_has()` no longer fails open on a NULL branch: NULL asks for company-wide authority, and the system principal passes so server-side jobs can read RLS-gated rows; `document.branch_id` is NOT NULL; the sensitive-data gate is a RESTRICTIVE policy (permissive policies OR together); branch isolation is a restrictive policy on every table with `branch_id` from Phase 6. | §3.8, §3.10.1, §4.2.1 | — |
| 26 | Catalogue gaps closed: `accounting.receipt.create/post` (money-in needs no maker-checker, so the accountant no longer holds the payment create+approve pair), `inventory.adjustment.create`, the `approval` block in posting policies mapping approve/post codes; `RECEIPT`, `SALES_ORDER`, `PURCHASE_ORDER` document types; the attachment service placed in Phase 2/3; sales and purchase orders placed in Phase 3; wrong Part VI citations in §3.0.4 corrected; Phase 4's definition of done no longer depends on Phases 6 and 8. | §3.0.4, §3.3, §4.2.1, Part V, Part VI | — |
| 27 | POS/HR mechanics tightened: termination revokes credential and assignments by trigger, not by handler; `pos_cashier` authority is a projection with relational `branch_pos_policy` limits; `document_event.attributed_to` records the supervisor while `actor_id` stays the terminal; `role_permission` and `role_assignment_branch` rows may be deleted by the app (audited before-image). | §3.7.5, §3.8, §3.10.1 | — |
| 28 | Regression fixes to the verification-pass changes: the last-admin guard is split into `keep_last_admin_assignment` / `keep_last_admin_permission` (one function per table — the same PL/pgSQL row-type hazard as `forbid_self_grant`) and acts only when the OLD row grants an unexpired `admin.user.manage` that the change removes or expires, so a tenant without an administrator yet is untouched; `stamp_actor` semantics refined — on INSERT a supplied value is replaced (NULL stays NULL), on UPDATE the NULL → value transition is stamped and any other change raises `ERR_ACTOR_IMMUTABLE` — and attached to `document.posted_by` and `fiscal_period.closed_by`. | §3.8; Plan 0A Tasks 6, 7, 9 | — |
| 29 | **Second execution pass** (two independent executors assembled the Plan 0A SQL and ran it on PostgreSQL 18: up → down → up clean, schema fingerprint identical, all 61 plan tests pass when replayed as SQL; skeptics re-executed each finding). Fixed: `keep_last_admin_permission` now guards UPDATE as well as DELETE — an `update … set permission_code` or `set role_id` on the last administrator's grant went through unchallenged; `forbid_self_grant` honours `expires_at` on its role-permission branch, matching "a role they currently hold"; §3.8 gains the `revoke insert, update on app.permission` line and the `ledger_entry_dimension_immutable` trigger that Plan 0A already carried; the `btree_gist` extension is documented as deliberately surviving `0001.down.sql`. | §3.8; Plan 0A Tasks 5, 6, 9, 10 | — |

---

# 0. How to use this document

**If you are the implementing agent, read in this order:** §0.2 (how to work) → §0.3 (what is already decided) → §0.4 (glossary) → Part II (why the old system failed) → Part III (what to build, including the reference schema in §3.8, conventions in §3.9 and the HR & payroll design in §3.10) → §5.0 (your first sixteen tasks). Then use Part I and Part VI as the acceptance bar throughout.

Read Part I as a **regression suite for a system that does not exist yet**. Every defect (`LEGACY-###`) is written so it can be turned directly into a failing test against Dulja. If Dulja can reproduce the failure scenario, it has inherited the defect.

Read Part II before designing anything. Six structural causes generate almost all 87 defects. Fixing symptoms without fixing causes reproduces them.

Part III is the target architecture and settled stack. Part IV is the SaaS standard, tagged **[v1]** / **[deferred]**. Part V is the build plan with the Phase 0 backlog and repository layout. Part VI is the acceptance tests. Part VII is what remains genuinely open.

## 0.1 Provenance and confidence — do not skip

| What was examined | Extent | Confidence |
|---|---|---|
| Declarative schema (`.hscript`) — 17 databases, 460 tables, 5,136 columns | **100%**, machine-extracted | **Verified** |
| PSQL corpus — 372 stored procedures, 318 triggers, 47 views, 23 functions, 54 UDF declarations = **913 objects / 33,179 lines** | **100% extracted; ~120 objects read in full**, remainder pattern-analysed | **Verified** for cited findings |
| English UI catalogues (17 files, 13,778 strings) | 100% | Verified |
| Hand-written repair scripts (`fixes/*.sql`) | 100% (9 files) | Verified |
| Seed data (chart of accounts, document types) | 100% | Verified |
| Binary inventory, services, licensing config | File-level | Verified |
| **The 15 compiled plug-in DLLs** (client-side business logic) | **0%** | **Not examined** |
| **The running UI** (screens, flows, keyboard model) | **0%** | **Not observed** |
| **Live production database** (row counts, actual usage) | **0%** | **Not accessed** |

**Two consequences you must carry into design.**

1. **Everything in Part I concerns what the database permits.** Some defects may be prevented in practice by the Delphi client. That is precisely the point: none are prevented by the *data layer*, so any second client, import tool, replication path, POS terminal, or direct SQL connection reintroduces all of them. Dulja must enforce invariants where they cannot be bypassed.

2. **The UI is not specified here.** Screen-level behaviour, keyboard shortcuts and data-entry ergonomics must be sourced separately (screenshots, a recorded walkthrough, or operator interviews) before UI work begins. Existing users are fast keyboard operators; regressing that will fail adoption regardless of architecture. **Do not invent the UI from this document.**

Six of the highest-impact findings (LEGACY-001, 002, 010, 021, 032, 049) were re-verified line-by-line against source after the audit. Findings marked ⚠️ *unverified* depend on DDL constraints or client code not available; treat them as hypotheses to confirm, not facts.

## 0.2 Operating brief for the implementing agent

You are **implementing**, not re-deciding. The rules below are the contract.

**Work in the phase order of Part V.** A phase begins only when the previous phase's *definition of done* passes in CI. Do not start Phase 3 with Phase 1's integrity checker still red.

**Part I is your regression suite.** Before closing any phase, write a test for every `LEGACY-###` that phase touches (the Appendix A index maps each defect to a root cause; §3.9 says where the test files live). If you can reproduce a Part I failure scenario against Dulja, the phase is not done.

**On `⚠️` markers, two kinds.**
- **Owner decides — stop and ask:** LHDN MyInvois specifics (§4.7); whether serials are needed and every row of §3.0.3; whether historical POS data must migrate (Part VII #10); the v1 costing method (§3.4 recommends weighted average — confirm); the code-signing certificate (§5.0 task 0.13); the v1.1 and v1.2 changelog rows marked *Confirm* or *Decide* (header of this document); the nine role names (§4.2.1); the ⚠️ rows in §3.0.4 and §3.10.1.
- **Agent verifies and records an ADR — do not stop:** the PDF engine (§3.2.2 — decide in week one with a real Arabic tax invoice); oxfmt stability; pg-boss on Bun; pgroll adoption (§3.2.2).

**On everything else that is unspecified:** if it is low-stakes (a component name, a folder, a library version), decide, record it in an ADR under `docs/adr/`, and proceed. If it touches **money semantics, security, the data model, or the sync protocol**, write the ADR *as a proposal* and ask before implementing.

**Never**, at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (LEGACY-036/037/069);
- issue DDL from application code (LEGACY-053);
- disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053);
- gate an audit write on any flag (LEGACY-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

**The UI is not specified here.** Before beginning any screen, request from the owner: screenshots of the equivalent legacy screen, and a two-minute description of how a fast operator uses it. Design the new screen to be *at least as fast by keyboard*. Do not invent workflows from this document.

**Report per phase**, in writing, against the definition of done — what passes, what does not, what you decided under ADR, what you are asking. Short.

## 0.3 Decision log — settled; do not relitigate without a written ADR and the owner's approval

| # | Decision | Chosen | Considered and rejected | Where |
|---|---|---|---|---|
| D1 | Target platform for v1 | Windows only | macOS, Linux, mobile | §3.0 |
| D2 | Desktop packaging | Electron + electron-builder, both apps, from day one | PWA first; Tauri | §3.7.2 |
| D3 | Database | PostgreSQL 18 on Supabase, Singapore | Firebird continuation; MySQL; on-premise | §3.2.2 |
| D4 | Compute | Cloudflare Containers for API + workers; Workers at the edge | Plain Workers for the ledger API (Hyperdrive transaction-mode pooling — §3.2.1); Fly.io/Railway | §3.2.1 |
| D5 | Runtime | Bun 1.4 for the API, workers and build; the test suite runs under Node 24 LTS, which is also the drop-in fallback runtime | Node as primary; `bun test` for the suite | §3.2.2 |
| D6 | API framework | Hono + Zod + `@hono/zod-openapi` | NestJS | §3.2.2 |
| D7 | Data access | Drizzle ORM + `postgres.js`; raw SQL for posting/costing | Prisma; direct `supabase-js` from clients | §3.2.2 |
| D8 | Job queue | pg-boss (transactional enqueue) | Redis + BullMQ | §3.2.2 |
| D9 | Lint / format | oxlint + oxfmt | Biome; ESLint + Prettier | §3.2.2 |
| D10 | Frontend | React 19, Vite, TanStack Router/Query/Table/Virtual, RHF, Tailwind + shadcn/ui, i18next | — | §3.2.2 |
| D11 | Money | `numeric(19,4)` in Postgres; `decimal.js` behind a `Money` type | floats; integer minor units | §3.9 |
| D12 | Identifiers | `uuidv7()` server-side; client-generated at the till | serial integers; composite `Site+ID` | §3.9 |
| D13 | Ledger | Immutable, append-only; corrections by reversal only | in-place update with audit | §3.1 |
| D14 | Balances / stock / cost | Synchronous projections via `MERGE` in the posting transaction + nightly rebuild-and-compare; cost layers as rebuildable derived data | trigger-maintained aggregates with no rebuild path | §3.3, §3.4, RC-2 |
| D15 | Tenancy | `tenant_id` + RLS on every table from migration 0001, even with one tenant | add later | §3.0.2 |
| D16 | POS | Built in-house, one codebase with the back office, same posting service | third-party POS integration | §3.7.4 |
| D17 | POS sync | Disjoint ownership; cursor down-sync on a sequence; outbox + client-generated uuidv7 up-sync | timestamp-based sync; CRDTs | §3.7.3 |
| D18 | POS hardware | Out of scope for v1; Windows printer drivers via Electron in v1 | ESC/POS in v1 | §3.7.2 |
| D19 | First customer | The owner's own business — office back office + branch POS | external customers first | §3.0 |
| D20 | v1 scope | Structure for SaaS, no commerce; **four modules — Accounting, Inventory, HR & Payroll, POS** (owner decision 2026-09-05); other verticals deferred to Phase 10 | full SaaS surface; fixed assets / service contracts / hospital / academy in v1 | §3.0.1, §3.0.4 |
| D21 | First tax jurisdiction | Malaysia | GCC first; both at once | §4.7 |
| D22 | Package versions | Latest at scaffold, pinned by lockfile, Renovate | versions written into the spec | §3.2 |
| D23 | Architecture shape | Modular monolith + worker process | microservices | §3.2.3 |
| D24 | Product name | **Dulja** | — | title |
| D25 | HR & Payroll | In v1 as Phase 8: employee master as a Party extension, effective-dated compensation, statutory schemes (EPF, SOCSO, EIS, PCB/MTD) as versioned **verified** rate tables, PAYROLL as a document type through the posting service, POS clock-in as attendance events; a leave register only if the owner confirms; rosters, clock-file import, incident/penalty engines, gratuity accrual, staff self-service and e-filing connectors deferred | rebuilding the legacy 36-table Salaries module; deferring HR entirely | §3.10 |
| D26 | Roles and permissions | Nine seeded system roles; `<module>.<resource>.<action>` codes in five modules; branch scope through `role_assignment_branch`; one predicate `app.actor_has()`; segregation of duties enforced by data-layer triggers reading `document_event` | flat admin/user; permissions as a blob (LEGACY-078); UI-only enforcement | §4.2.1, §4.2.2 |
| D27 | Module coverage for the first customer | Bank reconciliation, goods receipt + GRNI, import-shipment document, delivery order, stock count, two-step transfer, expiry write-off and till cash lifecycle added to Phases 3, 4 and 6 | discover them in production | §3.0.4 |

## 0.4 Glossary — legacy term → new term

Part I quotes the old system's names. Read them through this table.

| Legacy system | Meaning there | New system | Notes |
|---|---|---|---|
| `Site` | company / branch / fiscal container; part of every PK | **Company** (under a **Tenant**) + **Branch** as a dimension | Tenant is new; Site conflated company and branch |
| `Job` | project / contract / sometimes fiscal year | **Project** dimension; fiscal year is **FiscalPeriod** | Separate the two concepts |
| `Muniment` | document *type* with ~35 behaviour flags + XML options | **DocumentType** + versioned **PostingPolicy** | The core idea kept; encoding replaced |
| `Bill` / `BillItems` | any inventory-bearing document + lines | **Document** / **DocumentLine** (with `InventoryMovement`) | One document model for everything |
| `Voucher` / `VouItems` | journal entry header / lines | **Document** of type *journal* / **DocumentLine** → **LedgerEntry** | Posting produces ledger entries; lines are not the ledger |
| `Journal` | one row per document-level account movement | **LedgerEntry** (immutable) | The only financial truth |
| `Account` (with 20 `Is*` flags) | GL account doubling as customer/vendor/employee | **Account** (GL only) + **Party** | Party is a separate entity |
| `AccTypes` (30 booleans) | financial classification | **AccountType** enum + statement mapping | Discriminator, not flags |
| `Material` | item / product / service | **Item** | |
| `Warehouse` | stock location (tree) | **Warehouse** | Kept |
| `Batch` | lot with expiry | **Lot** | |
| `MatUnits.Exchange` | unit conversion factor (float, never applied) | **UnitConversion** (exact rational) | |
| `Prices` / `PriceGroups` | price lists | **PriceList** / **PriceListLine** | |
| `Descriptor` | user-defined field | **CustomField** / **CustomFieldValue** | Kept as a core service |
| `Level` | confidentiality tier on rows | **Clearance** (RLS-enforced) — *deferred*; v1 scopes by company/branch through RBAC | Was display-only; if built, must be enforced |
| `Sign` | approval tier + period lock | **ApprovalLevel** + **FiscalPeriod.status** | Two concepts separated |
| `Audits` | per-document audit header | **AuditLog** (append-only, hash-chained) | |
| `Carrier` | session | **Session** (server-owned) | |
| `User` / `Point` | human login / POS terminal, as unrelated tables | **Principal** (`human` · `system` · `terminal`) | One FK target for every actor column; a terminal has a real audit identity |
| `Point` / `Terminal` | POS terminal registry | **PosTerminal** (owns a `terminal` principal) | |
| `Parcel` | POS sync batch | **SyncBatch** (outbox) | |
| `AccTotals`, `MatCosts`, etc. | trigger-maintained aggregates | **projections** (`account_balance`, `stock_on_hand`) and derived `cost_layer`/`cost_consumption` | Rebuilt from the ledger/movements; never hand-edited |
| `Futures` | feature gate (sic — "Features") | **Entitlement** | |
| `.lic` + `tcb_guard` | node-locked licence | **Entitlement** per tenant plan | Deferred |
| `Employees` / `Personnels` | staff records (HR) | **Employee** — a Party of kind employee, optional principal, home branch | §3.10 |
| `Payrolls` / `PayItems` | payroll run header / per-employee lines | **Document of type PAYROLL** / `payroll_line` | Posts through the one posting service |
| `TaxLayers` | payroll tax brackets | **StatutoryRateTable** — versioned, effective-dated, verified; one per scheme | No rate in code |
| `Lends` | staff advances | **EMPLOYEE_ADVANCE** document + recovery pay component | The balance is a ledger projection |
| `Vacations` / `EmpVacations` / `Holidays` | leave and holidays | `leave_type` / `leave_entitlement` / `leave_record` / `public_holiday` — ⚠️ only if the owner confirms | Minimal register; no accrual engine |
| `Enrolls` / `posEnrolls` | attendance and clock-in | `attendance_event` | From POS clock-in; never an automatic pay input in v1 |
| `Users.Permissions` (MEMO) + `Is*` role flags | authorisation blob | **role / permission / role_assignment** with nine seeded roles | §4.2.1 |

---

# PART I — DEFECT REGISTER

87 defects. Severity reflects impact on **financial correctness first**, then security, then operability.

Legend — **C** Critical (silently wrong money, or full compromise) · **H** High · **M** Medium · **L** Low.

---

## A. Silent financial corruption — the defects that produce wrong numbers with no error

These are the most dangerous class: no exception, no log, no user-visible symptom. The books are simply wrong.

### LEGACY-001 · **C** · Denormalised currency balances are updated without the tenant key
`standard/OnVouItemsAIUD.sql:40–60` updates `AccCurTotals` with:
```sql
where ("AcrtAccount"=old."ItmAccount" and "AcrtCur" = old."ItmCur");
```
No `AcrtSite`. But the INSERT at `:63–73` supplies `new."ItmSite"`, and the rebuild `procFixTotals.sql:21–30` groups by `"ItmSite","ItmAccount","ItmCur"`. The table's key is `(Site, Account, Cur)`.

**Failure:** Site 1 holds a row for `(Account A, Cur 2)`. Site 2 posts its first entry for the same account/currency. The UPDATE matches **site 1's row** and adds site 2's money to it. `ROW_COUNT = 1`, so the `inserting and ROW_COUNT=0` guard is false and **site 2 never gets a row** — its foreign-currency balance reads zero forever, while site 1 is overstated. Once both rows exist, every posting updates **both**, doubling every movement.

**New system:** aggregate read, write and rebuild paths must use an identical key, mechanically. Prefer deriving balances from the ledger; if a projection is materialised, generate all three paths from one key definition.
**Test:** two tenants, same account and currency, post concurrently; assert each tenant's balance equals its own postings and nothing else.

### LEGACY-002 · **C** · The upsert never fires on UPDATE, so re-keying a posting destroys the amount
`standard/OnVouItemsAIUD.sql:24–26`, `:61`, `OnVouItemsAIUD_Objects.sql:33–64`:
```sql
if (not deleting) then
  update "AccTotals" set ... where ("ActAccount"=new."ItmAccount");
if ((inserting) and (ROW_COUNT=0)) then
  insert into "AccTotals" (...) values (...);
```
The create-missing-row branch is gated on the DML verb, not on `ROW_COUNT` alone.

**Failure:** an operator corrects a mis-posted line from account A to account B, where B has never been posted to. The old branch decrements A correctly. The new branch's UPDATE matches zero rows. `inserting` is false, so no INSERT. **The amount is removed from A and added nowhere.** The trial balance silently understates by exactly that amount, while the underlying line still exists. Same for `AccObjects` (per site) and `AccCurTotals` (per site+currency, which also fires whenever `ItmCur` or `ItmSite` changes).

**New system:** never condition a create-missing-row branch on the DML verb. Use a real upsert on the full key, applied symmetrically to reversal and application.
**Test:** post to A, re-key the line to a never-used account B, assert `sum(all balances) == sum(all postings)`.

### LEGACY-003 · **C** · Nothing enforces that debits equal credits
There is **no trigger on `Vouchers` at all**. Grep for `sum("ItmDebit")`, `Unbalance`, `IsBalanced` across all 913 objects returns zero hits. `OnVouItemsBIU.sql:7–13` is the entire before-insert validation of a ledger line — it defaults currency and copies local amounts. No check that debit and credit are not both non-zero on one line, no sign check, no per-document balance check at any point.

**Failure:** a single-sided journal entry commits successfully. `AccTotals`/`AccObjects` move. The trial balance is permanently out, and **no repair procedure can detect it** — `procFixTotals` faithfully re-sums the same unbalanced rows and reports agreement.

**New system:** balance is a deferred constraint enforced at commit, per document and per currency, on base-currency amounts. Ledger tables are not directly writable by application roles; the only write path is a posting service.
**Test:** attempt a single-sided entry through every write path including bulk import; all must reject.

### LEGACY-004 · **C** · Weighted-average cost is advanced on INSERT but never recomputed on UPDATE or DELETE, and nothing can rebuild it
Cost is computed only inside `if (inserting)` — `standard/OnBillItemsAIUD.sql:87–89`:
```sql
CstCost = ((CstCost * CstBalance + CurTotal)) / CurBalance;
```
On delete (`:145–157`) and update (`:159–173`) only quantities move and a dirty flag is set. **No repair procedure rebuilds `MatCosts`**: `procFixTotals` rebuilds `MatTotals`/`MatQuantity`, `procFixObjects` rebuilds `AccObjects`/`MatObjects`, `MatCosts` appears in neither. `procUpdateMatCosts.sql:20–22` only re-seeds from `MatOpens`, discarding all movement history.

**Failure:** buy 100 @ 10 (cost 10), buy 100 @ 20 (cost 15). Delete the second purchase. Quantity returns to 100 but **cost stays 15**. Every subsequent sale books COGS 50% too high, permanently, with no recovery path in shipped code.

**New system:** cost is a derived function of an immutable ordered movement ledger, recomputed forward from any affected point. Never a mutable running scalar.

### LEGACY-005 · **C** · `MatCosts.Changed` is never set on INSERT, so back-dated documents are never recosted
`CstChanged = 1` is written in exactly two places — the DELETE branch (`OnBillItemsAIUD.sql:152`) and the UPDATE branch (`:168`). The INSERT branch (`:40–142`) never sets it. Meanwhile the incremental update orders by document **ID** (`:91–93`, `if (new."BtmMaster" > Master)`) while the batch replay orders by **date** (`procCalcCosts.sql:89`), and the batch replay only visits dirty materials (`:72–74`, `inner join "MatCosts" ... "CstChanged" = 1`).

**Failure:** on 30 September a clerk enters a goods receipt dated 1 September — routine in this domain. The new row has the highest ID, so the trigger folds September's price in as if it were the newest transaction, *after* all of September's sales. `CstChanged` stays 0. The nightly `procCalcCosts(vForce=0)` skips the material entirely and **never corrects it**. All of September's sales stay mis-costed until somebody happens to edit an unrelated line of that material.

**Consequence:** `vForce=0` is not an optimisation mode — it is a silent-wrong-answer mode. `vForce=1` (full recompute of everything) is the only correct setting.

**New system:** maintain a per-item *costing watermark* (earliest date needing recompute). Any insert/update/delete with an effective date earlier than the watermark moves it back automatically. Invalidation must be structural, not a boolean set from three of four code paths.

### LEGACY-006 · **C** · Editing a bill line's material, job, batch, site or warehouse permanently desynchronises cost aggregates
`OnBillItemsAIUD.sql:163–171` (and identically `OnBtmJobCosts.sql:171–180`, `OnBtmBatchCosts.sql:176–186`) uses a single combined statement keyed on the **OLD** key:
```sql
update "MatCosts" set
  "CstDebit" = "CstDebit" - old."BtmDebit" + new."BtmDebit",
  "CstCredit" = "CstCredit" - old."BtmCredit" + new."BtmCredit",
  "CstChanged" = 1
where "CstSite" = old."BtmSite" and "CstMaterial" = old."BtmMaterial";
```
**Failure:** clerk enters 100 units against material 5001, then corrects it to 5002. For 5001: `−100 + 100 = unchanged` — it still carries 100 units it does not have. For 5002: **never touched** — 100 units short. `MatObjects`/`MatQuantity` *are* corrected properly (`:227` vs `:242`), so the two aggregates now permanently disagree, and only one of them is repairable.

**New system:** an edit is a full reversal on the old key plus a fresh application on the new key, as two statements, uniformly across every derived table. Better: append-only movements, no in-place aggregate maintenance.

### LEGACY-007 · **C** · Production/repackaging writes value-less movements that NULL-poison a material's cost for all history
`standard/procProducePackage.sql:61–81` inserts both the consuming and producing lines with **no `BtmPrice`, `BtmLocalPrice`, `BtmTotal`, `BtmPureTotal`, `BtmLocalCost`, `BtmSite` or `BtmJob`**. `BtmPureTotal` is therefore NULL, and both costing engines consume it directly (`OnBillItemsAIUD.sql:38,89`; `procCalcCosts.sql:195`).

**Failure:** one packaging run on a material with cost 42.00 and 500 on hand → `CstCost = (42*500 + NULL)/500` = **NULL**. The next sale coalesces NULL to 0, so cost becomes **0.00**. A full recompute does not fix it — `procCalcCosts` hits the same NULL, `Cost` becomes NULL and propagates to every remaining row of that material. COGS goes to zero; gross margin reports 100% on every subsequent sale.

Note there is **no BOM cost roll-up anywhere in the corpus** — `procProducePackage` moves the *same* material between warehouses (`:69` and `:81` both use `:Material`); there is no component-consumption → finished-good valuation path in the database at all.

**New system:** value is a mandatory non-null attribute of every stock movement, rejected at write time if absent. Manufacturing values output from summed valued inputs via an explicit BOM roll-up.

### LEGACY-008 · **C** · Weighted-average cost can go negative, explode by 10,000×, or be wiped to zero
`procCalcCosts.sql:158–209`. Three reachable failure modes:

**(a) Negative cost.** On hand 5 @ 10 (`aCostQnt = 5`); return 6 to supplier at 5 (`aQnt = −6`, `aTotal = −30`). `aCurrentQnt = −1`. `Cost = (10·5 − 30)/(−1) = **−20.00**`. Every later sale books *negative* COGS, inflating gross profit.

**(b) 10,000× explosion.** The guard is `if ("aCurrentQnt" <> 0)` — it excludes only exact zero. The smallest non-zero `numeric(18,4)` is 0.0001, so the divisor can be 10,000× smaller than one unit. Return 5.0001 units at 20 against 5.0000 on hand: `Cost = (50 − 100.002)/(−0.0001) = **500,020.00**`, stored into `MatCosts.Cost` which is `double precision` — no overflow check, no domain constraint.

**(c) Cost wiped to zero.** A wash line (`BtmDebit = BtmCredit` — a landed-cost allocation, a reconciliation line) posted while running stock is zero or negative sets `Cost = 0`. Everything sold until the next receipt has zero COGS.

Also: the **opening balance is loaded then mathematically discarded** (`:99–103` sets `Cost` from `MatOpens.MopCost`, but `Debit`/`Credit` start at 0, so the first receipt computes `Cost = (MopCost·0 + aTotal)/qty`).

**New system:** clamp the divisor to a minimum meaningful quantity; refuse rather than absorb issues exceeding stock; make negative computed cost a hard error, not a stored value; seed the running balance from opening quantity *and* opening cost.

### LEGACY-009 · **C** · Three different weighted-average formulas exist, so cost and profit reports cannot reconcile
`procCalcCosts`, `procSumBillItems` and the `OnBillItemsAIUD` trigger are three independent implementations. Divergences:

| | trigger | `procCalcCosts` | `procSumBillItems` |
|---|---|---|---|
| Transfer (`MunIsTrans`) revaluation | — | **absent** | present (`:262`, `:273–282`) |
| Zero-divisor fallback | — | `Cost = 0` (`:196`) | **commented out** (`:292–293`) |
| Reject-out revaluation | — | present (`:203–208`) | **commented out** (`:364–370`) |
| Prior balance | raw (`:70`) | clamped to ≥0 (`:176`) | — |

Worked example, prior balance −10, cost 5, receiving 4 units for 40: trigger → `(5·−10 + 40)/(−6) = 1.667`; `procCalcCosts` → `40/4 = 10.00`. **Two answers for the same data**, plus a third from `procSumBillItems`.

**Failure:** the stock valuation report (from `MatCosts`) and the profit report (from `procSumBillItems`) will never tie for any material that has been transferred, gone negative, or had a supplier return — and no amount of recosting will make them tie, because the formulas differ.

**New system:** exactly one costing implementation, called by everything, with transfer/reject/negative-stock policy stated once and covered by golden-file tests.

### LEGACY-010 · **C** · `procCalcJobCosts` cannot compute per-job cost, and its incremental mode cannot execute at all
A copy-paste clone of `procCalcCosts`. The job dimension was added to the SELECT list and the write targets but **not to the ordering or the group-break** — `:92` orders by `"BtmMaterial","BtmDate","BtmMaster"`; `:109` breaks on `if ("Material" <> "aMaterial")`. `aJob` appears only in write targets.

Separately, the incremental mode joins `MatCosts` (`:75`) but emits a `PLAN` naming `MatJobCosts` (`:87`) — a table not in the FROM clause. Firebird rejects the plan at runtime, so `MjcChanged` is **never cleared** and every job-costed material stays permanently dirty.

**Failure:** material M used on J1 (10 @ 100) and J2 (10 @ 500), interleaved by date. With `vForce=1` the loop blends both into one running cost (≈300) and writes it to whichever job happened to be on the material's **last row**. J1's row is never written. Project profitability is fabricated.

**New system:** per-job cost requires `(item, job)` in both sort and group key. Never build a `PLAN` clause and a `FROM` clause from independent code paths.

### LEGACY-011 · **C** · NULL arithmetic irreversibly nulls balances and tax boxes
No aggregate update uses `coalesce`. `OnVouItemsAIUD.sql:22–23`: `"ActAdminDebit" = "ActAdminDebit" + new."ItmLocalDebit"`. `OnVouItemsBIU.sql:9–13` only populates `ItmLocalDebit/Credit` when `ItmCur = 1`; for foreign currency the client supplies them and nothing rejects NULL.

**Failure (ledger):** one foreign-currency line with NULL `ItmLocalDebit` makes `AccTotals.ActAdminDebit` become NULL. Every later posting computes `NULL + amount = NULL`. The balance is permanently NULL, renders as blank or zero, and only a full table rebuild recovers it.

**Failure (VAT):** `procCalculateVATReturn.sql:66–67` accumulates without coalesce. A single bill line with NULL `BtmLocalTotal` nulls `Output_Total` for **the entire period**, while `Output_Tax` (a different column) still reports a figure. **A return is filed with tax but no base.**

**New system:** `NOT NULL DEFAULT 0` on every monetary column; coalesce at every accumulation boundary; a check that a return's base and tax are both present or both absent.

### LEGACY-012 · **C** · Base-currency amounts are never derived from value × rate, and the rate is never validated
The identity is asserted only in a *repair* procedure — and incorrectly. `standard/procFixValues.sql:4–9`:
```sql
"ItmLocalDebit" = case when ("ItmEqu"=1) then "ItmLocalDebit" else "ItmDebit" * "ItmEqu" end
```
When `ItmEqu = 1` it leaves the stored value **unchanged**, so base-currency inconsistencies are never repaired. When `ItmEqu <> 1` it overwrites with an unrounded product.

`ItmEqu` itself is never checked against `Currencies.CurEqu` or `CurHistory` anywhere. `OnBillsBIU.sql:5–9` forces `Equ = 1` when `Cur <= 1` for bills; `VouItems` has no equivalent — `OnVouItemsBIU` forces the *amounts* equal when `Cur = 1` but never forces `ItmEqu = 1`.

**Failure:** a line posts with `Cur=2, Debit=100, Equ=1500, LocalDebit=140000` (stale client rate or operator override). Nothing rejects it. `AccCurTotals` accumulates 100 foreign; `AccTotals` accumulates 140,000 base. They are inconsistent by 10,000 and no report can say which is right. If `procFixValues` is later run, `LocalDebit` is silently rewritten to 150,000 — **restating a posted, possibly already-filed balance** — and this fires the aggregate triggers, moving balances inside a closed period with no audit row.

**New system:** store rate and both amounts; enforce `base = round(value × rate, scale)` as a check constraint at post time with documented rounding and tolerance; capture rate source and timestamp; reject rates a rate-source cannot justify.

### LEGACY-013 · **H** · Reversal reads *current* document-type flags instead of what was originally applied
`OnVouItemsAIUD_Objects.sql:7–16` resolves `MunIsOpen` from the live `Muniments` row at trigger time and uses it for **both** the subtract (`:27`) and the add (`:42`). Same in `OnBillItemsAIUD.sql:30–33` for `IsTrans`/`IsOpen`.

**Failure:** muniment 7 has `IsOpen=1`; a line posts 10,000 to `AcoOpenDebit`. An admin later clears `IsOpen` (nothing prevents this). The user deletes the line: the reversal evaluates `IsOpen = 0` and subtracts **0**. `AcoOpenDebit` retains 10,000 for a line that no longer exists. `procFixObjects` then rebuilds using *current* flags, producing a third figure matching neither.

**New system:** store the classification on the posted row, immutable at post time. Document-type definitions are versioned and non-editable once used.

### LEGACY-014 · **H** · `procSumVouItems` silently discards the caller's exchange rate
`procSumVouItems.sql:108–119`: when the caller supplies a non-zero `vEqu` — the only reason to pass it — the `else` branch overwrites it with `1`.

**Failure:** a report requests balances in currency 2 at contractual rate 1500. `vEqu` becomes 1, and the computation at `:220` divides by 1 — the report prints base-currency figures under a foreign-currency heading, **1500× too large**, with no error.

Related: `:188–193` relies on Firebird leaving a singleton `SELECT ... INTO` target unchanged when no row matches; inside the loop at `:200–205` there is no reset, so a row predating the first `CurHistory` entry silently reuses the previous row's rate. ⚠️ *Version-dependent — confirm behaviour on the target engine.*

### LEGACY-015 · **H** · `procSumBillItems` computes its date window with a predicate that can never be satisfied
`:90–91` coalesces `vJob` to 0; `:101–103` then tests `where (:"vJob" is null) or ("BtmJob"=:"vJob")` — always false, so always `BtmJob = 0`. The result drives the time-weighted average at `:201–205`.

**Failure:** a contracting installation posts every line against a project. `min/max` over `BtmJob = 0` returns NULL. `Average` becomes NULL for every material and all average-stock and stock-turn figures are blank, with no error. On a mixed installation the time-weighting denominator is simply wrong.

**New system:** compute the window from the same filtered set as the body; never coalesce a parameter before a path tests it for NULL.

### LEGACY-016 · **H** · `MatStatus` min/max prices ratchet permanently and are maintained only on INSERT
`OnMatStatusBU.sql:6–10` refuses to raise `MtcMin` or lower `MtcMax`. The only maintainer, `OnBillItemsStatusAI.sql:1–2`, is **after insert only** — no update or delete trigger.

**Failure:** a clerk fat-fingers 0.01 instead of 1.00, saves, notices, deletes the line. `MtcMin` is now 0.01 and cannot be raised. The "lowest price ever sold" figure used for floor-price checks is permanently wrong. `procFixMatStatus` does not rescue it (see LEGACY-060).

Also: `:6` tests `if (new."BtmSize" <> 0)` — unknown when NULL, so the whole update is silently skipped; `MtcLatest` is written unconditionally while `MtcPrice`/`MtcDate` are date-guarded, so a back-dated invoice sets "latest price" to the *older* price while "price" keeps the newer one.

### LEGACY-017 · **H** · Order-delivery tracking double-adds bonus on edit and never reverses on re-pointing
`Orders/EvnOnBillItemsAI.sql:30`:
```sql
"OdtTransferredBonus" = "OdtTransferredBonus" + old."BtmBonus" + new."BtmBonus"
```
Adds `old` instead of subtracting it (compare the correct form in `EvnOnBillItemsAD.sql:15`). Additionally, when the reference changes, the `iif` adds to the **new** reference and the `WHERE` targets only the new reference — the old order line is never decremented. And bonus is excluded inconsistently between the three branches.

**Failure:** re-pointing a delivery from order A to order B leaves A permanently over-delivered. Editing a line's quantity adds the bonus again.

This is the concrete answer to whether the `Qnt`/`Size`/`Bonus` → `Debit`/`Credit` derivation is consistent: **it is not**. Across the corpus delivered quantity is variously `Debit − Credit`, `Debit − Credit − Bonus`, `Debit − Credit` including bonus, and `Qnt`.

**New system:** define delivered-quantity once; derive every consumer from it.

### LEGACY-018 · **H** · Deleting a return line never decrements; editing one double-counts
`OnBillItemsAIUD.sql:290–322`. The enclosing `if` at `:293` dereferences `new."BtmReferenceID"` — NULL during DELETE, so `NULL <> 0` is unknown, the branch is false, and the delete path at `:313` is **unreachable**. Separately `:295` lumps `updating` with `inserting` and only adds.

**Failure:** customer returns 10 of 10 against invoice #500 (`BdtQnt` = 10). Clerk deletes the line — `BdtQnt` stays 10, so no further return is possible against that invoice. Correcting 10 → 4 gives `BdtQnt` = 14: more returned than ever shipped.

**New system:** never gate a delete path on a `NEW` value. Delta from `OLD` on delete, `NEW − OLD` on update, as explicit separate branches.

### LEGACY-019 · **H** · Rounding is configured everywhere, applied nowhere, and the one rounding function is wrong
`Currencies` carries eight rounding columns and `TaxCodes` two more. Grep for `CurRoundBase`, `CurTaxRoundBase`, `CurBillRoundBase`, `TxcRoundBase`, `TxcRoundMode` across all 913 objects: **zero references**. `system/RoundTo.sql` is never called by anything.

And it is incorrect (`:9–28`): `m` is `integer` so `vAmount / vRoundBase` is **rounded, not truncated**; there is no `vMode < 0` branch, so rounding 8 *down* to base 5 returns **10**; behaviour is asymmetric across sign (+6 → 10, −6 → −5, leaving a permanent 5-unit imbalance per rounded credit note); `vRoundBase is NULL` bypasses the `= 0` guard and returns **NULL**, silently nulling the amount; `m integer` overflows for large amounts against small bases.

**New system:** one rounding function with explicit mode (half-up / half-even / ceiling / floor / away-from-zero), symmetric across sign, applied server-side at persist time, with the rule recorded per currency and per tax code and covered by property-based tests.

### LEGACY-020 · **H** · The GST return hardcodes a rate, uses an ambiguous date literal, and shares an enum with an incompatible meaning
`procCalculateGSTReturn.sql:92–97`:
```sql
"IS_Tax_Value" = "IS_Tax_Value" + (:"aTotal" * 0.06);--:"aTaxValue";
```
Rate hardcoded at 6%; the actual per-transaction tax is commented out. At `:72` and `:77` the rate-change date is the string `'06-01-2018'` — MM-DD-YYYY or DD-MM-YYYY depends on engine literal parsing. If misparsed, five months of transactions land in the wrong box.

**Enum collision:** `procCalculateVATReturn` reads `TaxCodes.Kind` as 1=standard-rated output, 3=exempt, 4=IG. `procCalculateGSTReturn` reads the *same column* as 1=TX input, 3=IM import input, 4=IS imported services. Both procedures are installed in every database and there is no discriminator saying which regime a code belongs to.

**Failure:** a VAT-configured tenant runs the GST return; standard-rated sales are reported as *purchases*. No warning.

⚠️ `GSTAmount` at `:69` is `InputTax − OutputTax`; whether the sign matches the conventional payable figure is unverified.

**New system:** versioned tax-regime definitions with rate-effective-date tables; never hardcode a rate; unambiguous date literals; every tax code declares its regime and a mismatched return refuses to run.

### LEGACY-021 · **H** · Accounts can be deleted with posted entries; the ID generator then rewinds and reuses their IDs
`OnAccountsAD.sql:6–22` checks only for child accounts and `AccFinal` links — not for `VouItems`. There is **no foreign key from `VouItems.ItmAccount`**. Aggregates are not deleted either.

`procFixGenerators.sql:7–11` sets `GenAccID` to `max("AccID")` — **moving it backwards** if the highest-numbered accounts were deleted. Same for `GenMatID` and `GenMunID`. Notably the author defended against exactly this for `GenJournal` (`:25–35` uses `max(max(JurID), max(AdtID))`, using audit tombstones as a high-water mark) — proving the failure mode was known and simply not generalised.

**Failure:** account 4210 is deleted after being posted to; its balance rows survive. Maintenance runs `procFixGenerators`, rewinding the generator. A new account is created, receives ID 4210, and **inherits the deleted account's balances before a single entry is posted to it** — while the old account's postings silently reattach to the new account and appear in reports and tax returns under its name.

**New system:** FK from every posting line to its account; deactivate rather than delete; **never reuse identifiers; never rewind a sequence.**

### LEGACY-022 · **H** · A `SELECT ... INTO` ignores a key column and will hard-fail on any multi-job opening balance
`MatOpens` PK is `(Site, Material, Job)`. Every read omits `Job` — `procCalcCosts.sql:99–101`, `procCalcJobCosts.sql:102`, `procSumBillItems.sql:190–193` (with the intent visibly commented out: `--and "MopJob" = :"Job"`), `:243`, and seven `tcbReports` procedures.

Firebird raises `multiple rows in singleton select` (−811). The codebase uses `select first 1` elsewhere precisely to avoid this, so the hazard was known and not applied here.

**Failure:** an implementer enters opening stock split across two projects. From that moment costing and every profit report throw −811 **for the whole site**, with an error pointing at a SELECT rather than at the data.
⚠️ *Depends on production data having `MopJob <> 0`; the schema permits it and nothing prevents it.*

### LEGACY-023 · **M** · Audit sequence numbers are renumbered retroactively and collide across document classes
`procVouAuditID.sql:7–17` and `procBilAuditID.sql` both restart at 1 and both feed `Journal.JurAuditID` and `Audits.AdtAuditID`. Running either rewrites the audit sequence of every already-issued document; the two counters produce colliding values between bills and vouchers in the same tables. Inserting a back-dated voucher and re-running shifts every later document's audit number.

**New system:** an audit sequence is issued once at posting, from a single counter across all document classes, and is never rewritten.

### LEGACY-024 · **L** · Account codes are allocated with `max()` on a string, without locking
`procNewCode.sql:15–17` takes `max("AccCode")` where `Code` is a string — lexicographic, so for children `'1'…'9','10'` the max is `'9'` and the next code collides. No locking, so concurrent creates derive the same code. `OnAccounts_DUP.sql` (the likely duplicate check) is marked `inactive`.
⚠️ *`IncCodeNumber` is an external UDF not in the corpus; it may zero-pad and avoid this. Confirm before rating.*

---

## B. Security and access control

The structural finding: **the database has no notion of an authenticated caller.** `procLogin` is an application-level ceremony that writes plaintext-verified attributes into `RDB$SET_CONTEXT` — a namespace every client can write directly — and five triggers consult those attributes, each behind a client-writable off-switch.

### LEGACY-025 · **C** · `procQuickLogin` grants a full administrator session with no credentials
`system/procQuickLogin.sql:1–17` takes **no parameters**:
```sql
select first 1 "UsrName", "UsrPassword" from "Users" where "UsrIsAdmin" = 1
into :"UserName", :"Password";
select "UserID" from "procLogin"(:"UserName", :"Password", '.', 0, 0) into :"UserID";
```
It reads the first admin's cleartext password and logs in as them — `IsAdmin=1`, `IsModerator=1`, `IsAuditor=1`, max level, max sign. Anyone who can open a connection can execute it. It is **not dead code**: `Payments/FixPaymentValues.sql:63` and the shipped `fixes/round.sql` both call it.

**Failure:** complete authentication bypass to the highest privilege, from one statement, leaving only a session log row bearing the *admin's* name. The real actor is recorded nowhere.

**New system:** never derive an identity from stored credentials. Maintenance elevation is an explicitly-granted service principal with its own audited identity.

### LEGACY-026 · **C** · Session identity is unauthenticated, client-writable context
`procLogin.sql:130–152` *writes* identity into `RDB$SET_CONTEXT('USER_SESSION', …)`; `procGetSession.sql:21–39` *reads it back*. That namespace is writable by any connected user. A client can skip `procLogin` entirely:
```sql
select RDB$SET_CONTEXT('USER_SESSION','UserID',1),
       RDB$SET_CONTEXT('USER_SESSION','LevelID',99),
       RDB$SET_CONTEXT('USER_SESSION','SignID',99),
       RDB$SET_CONTEXT('USER_SESSION','SiteID',7) from RDB$DATABASE;
```
Every consumer then believes it — the sign check (`OnAuditsBIUD.sql:18–19`), the confidentiality filter (`tcbReports/procInitArrTier.sql:33–35`), the user stamp (`OnUserBIUTrigger.sql:7`), the audit-log site (`procLogElement.sql:29`). No `GRANT`/`CREATE ROLE` statements appear anywhere in the corpus, consistent with a single shared database login for all clients.

**New system:** identity derives from a server-side authenticated session the client cannot write — a validated signed token, or a real per-user database principal. Authorisation decisions read that principal, never mutable connection state.

### LEGACY-027 · **C** · One client-settable variable disables every write-time control
All four guard triggers open identically — `OnAuditsBIUD.sql:16`, `OnAuditsActvitiesBIUD.sql:13`, `IsManualTriggerBUD.sql:8`, `OnJournalAU.sql:7`:
```sql
if (coalesce(RDB$GET_CONTEXT('USER_TRANSACTION', 'Internal'), '') = '') then
```
So do the audit-log triggers. Setting `Internal` disables, for the whole transaction: period-lock enforcement, the approval-sign check, the site read-only check, the site date-range check, `IsChangeOnlyOwned`, `CanNotUpdatePaid`, the activity lock, **and** journal/audit logging.

Worse, a callable procedure sets it and **never clears it** — `hospitals/procFixAudisIsPrinted.sql:4` sets `Internal = 1` with no matching reset. It takes no arguments and requires no privilege; `USER_TRANSACTION` context persists for the life of the transaction, so calling it leaves the rest of the transaction running with all controls off.

**New system:** the channel carrying user data must never carry an enforcement-bypass flag. System operations skip user-facing checks by virtue of an authenticated service principal, checked server-side.

### LEGACY-028 · **C** · Passwords are stored and compared in cleartext
`procLogin.sql:33–40`: `"UsrPassword"=:"UserPassword"`. `procInitDatabase.sql:13–15` inserts it verbatim. Domain is `NAME` — plain varchar. Across the whole corpus `UsrPassword` appears three times; there is no hash, salt, or work factor among the 54 UDF declarations. `procQuickLogin` proves a plain `SELECT` of the column is unrestricted.

Secondary: Firebird `=` on VARCHAR ignores trailing blanks (`'secret'` and `'secret   '` both authenticate); there is no failed-attempt counter, so this is an unthrottled online oracle.

**New system:** per-user salted hash from a memory-hard KDF (Argon2id), constant-time comparison in the application tier, hash column never exposed to application queries, rate limiting and lockout on failed attempts.

### LEGACY-029 · **C** · The audit trail records no actor and is a freely writable table
`Logs` has a `User` column. **No insert anywhere in the corpus populates `LogUser` or `LogDate`** — `procLogElement.sql:17–34`, `OnJournalLogAIUD.sql:35–60` and `:62–87`, `OnAuditsLogAU.sql:18–41`, `hospitals/procLoghhElement.sql:20–43`, `archives/procRcvLogElement.sql:18–37` all omit both. There is **no trigger on `Logs` at all**, so nothing prevents `UPDATE`/`DELETE` on it. No hash chain, no sequence-gap detection, no append-only constraint.

**New system:** audit records written from a server-controlled identity into append-only storage the application role cannot modify, with a monotonic sequence and per-record chained hash so gaps and edits are detectable.

### LEGACY-030 · **C** · A login parameter switches the audit trail off
`procLogin.sql:6, 133–134` accepts a caller-supplied `Silent` argument and writes it to session context. Every logging trigger then no-ops (`OnLogNameBIUDTrigger.sql:6–18`, `OnJournalAuditAIUD.sql:7–8`, `types/RevisionTrigger.sql:7`). It can also be set mid-session via `RDB$SET_CONTEXT`.

**Failure:** an authenticated session performs real writes and leaves **no audit records** — and because the session log line is written before the gate matters, nothing distinguishes a silent session from a normal one.

**New system:** audit emission is non-optional and not addressable from the request path. Bulk operations log one summarising record — never nothing.

### LEGACY-031 · **C** · Period locks live on a sibling table, are per-privilege-tier, and do not reach the line items
`OnAuditsBIUD.sql:32–34`:
```sql
select first 1 max("SgnLockDate") from "Signs" where "SgnID" >= :"UserSign" into "LockDate";
```
The lock applied to you is the maximum over signs **at or above your own** — so holders of a high sign are exempt from every lower-tier lock *by construction*. If `UserSign` is NULL the query matches nothing and there is **no lock at all**.

The lock lives only on the `Audits` header, and the `Audits` row exists only because `OnJournalAuditAIUD` writes it — which is inside the `Silent` gate (LEGACY-030). Checking every trigger on `VouItems` (`OnVouItemsBIU`, `OnVouItemsAIUD`, `OnVouItemsBI_Admin`, `OnVouItemsAIUD_Objects`, `fkItmMaster`), **none** references `Audits`, `Signs`, `SgnLockDate` or `Journal`.

**Failure:** a direct `UPDATE "VouItems" SET "ItmDebit" = …` on a signed, locked, closed-period voucher changes the amount and silently rewrites `AccTotals` to match — no exception, and under `Silent`, no log.

**New system:** period close is a uniform property of the *period*, not a per-role threshold; reopening is separately authorised and audited; immutability is enforced on the whole document aggregate (header + lines + projections) in one transactional boundary.

### LEGACY-032 · **H** · A user can raise a document's approval level above their own
`OnAuditsBIUD.sql:37–43` checks only `old."AdtSign" > "UserSign"`. There is **no check that `new."AdtSign" <= "UserSign"`**. A user at sign 1 can set `AdtSign = 9` on any document at sign ≤ 1, and the trigger obligingly stamps `AdtSignDate = current_timestamp` to make it look like a genuine approval — which then locks the document against that same user, making the forgery look more authentic.

A side door exists that does not touch `Audits` at all: `Orders/OnOrderInfoAIU.sql:7–22` promotes a document to the muniment's activation sign when a boolean is flipped, with no check of the actor's own sign.

**New system:** approval is a state transition authorised against the **actor's** authority (`new_state <= actor.authority`), recorded as an immutable approval event with actor, timestamp and prior state — never a mutable integer on the document its own editor can raise.

### LEGACY-033 · **H** · Confidentiality levels are a read-time display filter with a caller-supplied off switch
Level is only ever *stamped*, never *checked* on write — and `system/OnLevelBIUTrigger.sql:4–7`, the model that would have applied a level check, is **entirely commented out**. The only consumers are report procedures, and they take an override: `tcbReports/procInitArrTier.sql:68` — `(((:"aIsAdmin"<>0) or (:"vFullEntries"=1)) or ("AccLevel"<=:"aLevel"))`, where `vFullEntries` is an ordinary input parameter. Passing `vFullEntries=1` disables the confidentiality filter for a non-admin.

**New system:** enforce confidentiality at the data-access layer as a mandatory predicate the query cannot opt out of (row-level security), on read *and* write, from the authenticated principal — never from a query parameter.

### LEGACY-034 · **H** · `Grants` — the document-level permission table — is never read by any code
The table is captioned "permissions at document level". Grep across all 913 objects for `"Grants"`, `GrntUser`, `GrntForID`, `GrntValue` returns exactly one hit: a foreign key definition. **`GrntUser` is never read by any procedure, trigger, view or function.**

**New system:** if per-document ACLs exist they are evaluated on every read and write. A permission table no code consults is worse than none — it creates a documented, auditable belief that access is controlled when it is not.

### LEGACY-035 · **H** · Tenant (Site) scoping is a client convention
The only site-related write logic is a *default*, not a check — `system/OnSiteBIUTrigger.sql:1–7` fills `Site` when null or zero, and accepts any non-zero value the client supplies. There is no `if (new.Site <> session_site) then exception` anywhere. Read-side, site is a parameter that merely falls back to the session: `procSumVouItems.sql:52–53, 75–79, 128` — passing `vSite = 3` reads site 3's ledger regardless of session. Same shape in `procSumBillItems`, `procCalcCosts`, `Payments/procSumAccPayments`, `Additions/procBdgCheckSite` and the `tcbReports` profit procedures.

Compounding: `procLogin.sql:59–60` accepts `UserSite = '*'`, which blanks the site, skips the `SiteID is null` exception, and establishes a session with `SiteID = NULL`. The only compensating control is `IsReadOnly = 1` — and `IsReadOnly` is written to context at `:138` and **never read by anything** (grep confirms one hit, the write). The `'.'` variant resolves the site from the `Options` table, which has no protective trigger and is writable by any user.

**New system:** tenant scope is a non-negotiable server-side predicate on every query and write; a write whose tenant column disagrees with the session is rejected; cross-tenant sessions do not exist (a genuine cross-tenant role is a distinct, separately-audited principal).

### LEGACY-036 · **H** · Six procedures accept a raw SQL predicate as a parameter
```
Payments/procSumPayments.sql:106        ' and (' || :"vMunimentsStr" || ')'
Payments/procSumAccPayments.sql:83      ' and (' || :"vMunimentsStr" || ')'
Orders/procSumOrders.sql:82             ' and (' || :"vMunimentsStr" || ')'
Payments/procCalcCustRewards.sql:34     ' and ("JurMuniment" in (' || :"vMuniments" || '))'
tcbReports/procInitMatBtmArray.sql:104  "aQry" || "vWhere"
tcbReports/procSelectAccountVouchers.sql:70  /  ...Vouchers1.sql:73   "aWhere" || "vWhere"
```
The client presumably binds these as parameters — but the procedure *unbinds* them back into statement text, so parameterisation at the call site gives zero protection. Impact is bounded by Firebird executing one statement per `EXECUTE STATEMENT` (no stacked `DROP`), but it is enough to subvert the `WHERE` and read across tenants via injected sub-selects.

**New system:** never accept SQL text across an API boundary. Filters cross as typed structured values; queries are assembled server-side from an allow-list of columns and operators, values always bound.

### LEGACY-037 · **H** · Four procedures interpolate unescaped user strings into SQL literals
`procSerCheck.sql:34,40`, `procGetSerials.sql:84,86,88`, `procSerInventory.sql:70`, `tcbReports/procSelectDescTier.sql:16`. These are genuinely user-controlled — serial numbers are keyed, barcode-scanned and bulk-imported; `Value` feeds a descriptor `LIKE` search box. One apostrophe breaks the query; a crafted value rewrites the predicate. `procSelectDescTier` returns account IDs, so an injected sub-select leaks arbitrary values through the return channel.

**Precision note for the rebuild team:** the remaining ~262 interpolation sites splice **integers only** into `INTEGER`/`SMALLINT` parameters and are **not injectable** (the engine rejects non-numeric input at the procedure boundary). A further ~54 splice `DATE`-typed parameters — also not injectable, but locale-fragile (LEGACY-069). Do not over-report the injection surface: it is 10 sites, not 320.

### LEGACY-038 · **H** · Path traversal to arbitrary file write on the database server
`archives/ProcCopyExternalFile.sql:1–27` concatenates a caller-supplied `vDstID` into a filesystem path with no canonicalisation and passes it to the native UDF `BlobToFile` with caller-supplied content:
```sql
"DstFileName" = :"FolderName" || '\' || :"vDstID";
BlobToFile(:"vSrcBlob", :"DstFileName", :"vDstVersion");
```
`..\..\..\Windows\Temp\evil.dll` traverses out of the archive folder; the write happens as the Firebird service account. The base directory is itself read from the unprotected `Options` table, so the prefix is attacker-influenceable too. Same pattern reaches file *deletion* at `archives/OnRcvDeletedAttachmentsBD.sql:12`.

**New system:** blobs in object storage or the database, addressed by opaque server-generated identifiers. Never build a filesystem path from client input; if files must live on disk, resolve the final path and assert it is inside the storage root before any I/O.

### LEGACY-039 · **H** · `procInitDatabase` creates an administrator, unauthenticated, with no already-initialised guard
`system/procInitDatabase.sql:1–28` has no authentication, no admin check, and **no test for whether the database is already initialised**. A live production database will accept a second call, minting a new admin with `UsrIsAdmin = 1` and a caller-chosen password, plus a new `Sites` row marked primary.

**New system:** bootstrap is a one-time offline operation guarded by an initialisation sentinel, never a callable procedure on a running system; passwords never arrive as plain procedure arguments.

### LEGACY-040 · **H** · Deletions are logged less reliably than inserts, and can erase the document header
`OnJournalAuditAIUD.sql:56–71` places the *soft-delete tombstone* inside the `Silent` gate. With `Silent` set, deleting a `Journal` row leaves the `Audits` header neither marked deleted nor removed — a stale header pointing at a vanished transaction.

`IsManualTriggerAD.sql:10–17` shows the soft-delete was deliberately commented out in favour of a hard `delete from "Journal"`. In the archive module, `ProcDeleteDocument.sql:8–9` and `ProcDeleteAttachment.sql:7–9` issue raw `DELETE`s with **no logging call at all** — and the first is an unqualified `delete from "RcvDeletedAttachments"` which also flushes another user's pending file-deletion queue, deleting their files from disk via `rcvDeleteFile`.

**New system:** delete is the *most* strongly audited operation — before-images logged, never gated on any flag, soft-delete with retained tombstone for financial records.

### LEGACY-041 · **H** · Documents are hard-deleted and the anti-tampering controls are shipped disabled
`IsManualTriggerAD.sql:8–18` hard-deletes; `fkVouMaster`/`fkBilMaster` cascade to all lines. Meanwhile the fiscalisation controls are shipped **inactive**:
- `OnJournalTaxAI.sql:2` — `inactive after insert`. This is what would create the `JurTaxInfo` row carrying `Guid`, `Token`, `Hash`, `QRCode` for a taxable document.
- `OnJournalTaxBUD.sql:2` — `inactive before update or delete`, containing the only guard against editing or deleting a taxable document (`exception "JournalIsTaxable"`).

**Failure:** an invoice issued to a customer and reported on a VAT return is deleted. All rows vanish, stock reverses, cost corrupts (LEGACY-004), the number becomes a permanent gap — and re-running the VAT return for that period produces a different figure from the one filed, with nothing explaining the difference.

**New system:** issued financial documents are immutable. Corrections are reversing entries. Deletion of a posted document is not available at any privilege level.

### LEGACY-042 · **M** · Ownership and paid-record checks fail open when the user row is missing
`IsManualTriggerBUD.sql:8–19`, `OnJournalAU.sql:12–17`, `OnVouItemsBIU.sql:15–21`, `OnBillItemsBIU.sql:30`, `OnMatObjectsBIU.sql:9`, `OnAccObjectsBIU.sql:11`, `OnMatQuantityBIU.sql:12`, `Orders/procCheckAccBalanceLimits.sql:15` all follow:
```sql
select first 1 "UsrIsChangeOnlyOwned" from "Users" where "UsrID" = RDB$GET_CONTEXT(...) into :X;
if (X <> 0) then exception "…";
```
If no row matches — no session, or a forged non-existent `UserID` — `X` is NULL, `NULL <> 0` is unknown, and the check is skipped. **The check is defeated by supplying an invalid user rather than a valid one.**

**New system:** default deny. An absent or unresolvable identity is a hard failure. Three-valued logic handled explicitly at every authorisation branch.

### LEGACY-043 · **M** · Failed authentication returns a row instead of raising
`procLogin.sql:100–161`: on a wrong password the user `SELECT` returns nothing, `UserID` stays NULL, the site lookup has *already* succeeded, so the `SiteID is null` exception is not raised, and the procedure `suspend`s a row carrying a populated `SiteName` and `SiteGuid` with a NULL `UserID`. A caller checking "did I get a row?" — the natural idiom for a selectable procedure — treats a failed login as success.

Also: `SessionID = CURRENT_CONNECTION` (`:109`) is a small, reused integer, not an unpredictable token. And `procLogout.sql:1–12` writes a log line but **clears no context** — session variables survive logout for the life of the connection, so a pooled or reused connection retains the previous user's identity and privileges.

**New system:** authentication fails with an unambiguous error and no partial data; session tokens are unpredictable with explicit expiry; all session state is destroyed on logout and on connection return-to-pool.

### LEGACY-044 · **M** · Session records are caller-controlled and attributable to the wrong user
`procRegisterCarrier.sql:14–51` — every discriminator (`CarrierSite`, `CarrierName`, `CarrierGuid`) and the timestamp are caller-supplied. On the match path it returns an existing carrier row **whose `CarUser` may be a different user**, and subsequent writes are stamped to that other user's session. `DeleteOld = 1` lets a caller destroy an existing session record. Same forged-actor pattern at `archives/ProcRecycleDocument.sql:29–33`, where the deleting user is a parameter.

**New system:** actor and timestamp for every provenance field come from the server; session records are server-owned and immutable to clients.

### LEGACY-045 · **M** · Department scoping is a report parameter, not an access control
The only write-side use is a stamp (`OnAuditsDepBI.sql:6–13`), which additionally only fires when `AdtUser` is not null. Read-side, `tcbReports/procFilterDeptAccounts.sql` takes the department as a plain parameter with no comparison against the session. `UseDepartmentForJobs`, `…ForWarehouses`, `…ForCostCentres`, `…ForSubAccounts` are **never referenced in SQL at all**.

**New system:** scope resolves from the authenticated principal server-side; a client-supplied scope may only *narrow* what the principal is entitled to, never widen it.

### LEGACY-046 · **M** · Site protection triggers are bypassable, and two different flags share one name
`OnSiteBI.sql:5–15` and `OnSiteBU.sql:6–10` — which prevent a replication branch inventing or editing sites, the core of the multi-site model — are both disabled by `RDB$SET_CONTEXT('USER_TRANSACTION','Silent',1)`.

Note this is a *different namespace* from the `USER_SESSION.'Silent'` used by logging: the codebase has two independent flags with the same name. `hospitals/OnVisitBookAD.sql:8,35` shows the resulting confusion — it reads `Silent` but writes `Internal`, and into `USER_SESSION` while every consumer of `Internal` reads `USER_TRANSACTION`. The suppression it intends is completely inert.

**New system:** operation mode (user action / replication apply / maintenance) is typed, server-authenticated request metadata with one canonical name per concept, checked in one place.

### LEGACY-047 · **M** · Only 7 of ~55 permission flags are ever read by the database
Column-frequency count across the whole corpus: `UsrIsAdmin` (7 uses), `UsrIsCheckJob` (2), `UsrIsAccNoOverload` (2), `UsrIsChangeOnlyOwned` (1), `UsrIsNoUpdateAfterPaid` (1), `UsrIsCheckWarehouse` (1), `UsrIsMatNoOvercost` (1). **`UsrPermissions`, `UsrIsFullAccess`, `UsrIsRestricted`, `UsrIsViewOnlyOwned`, `UsrIsGuest`, `UsrIsAllowReject`, `UsrIsViewCosts`, `UsrCanNotChangePassword`: zero uses.** The entire authorisation surface of the database is five files.

**New system:** every permission is evaluated in one authorisation service. A permission that no code reads fails the build.

### LEGACY-048 · **H** · Negative-stock and overcost controls are opt-in per user and have four bypasses
`OnMatObjectsBIU.sql:7–17` and `OnMatQuantityBIU.sql:10–31` are the only `NotEnough` sites; there is one `MatOvercost` site.
1. `RDB$SET_CONTEXT('USER_TRANSACTION','IgnoreMatExceptions','1')` — one statement disables overdraw checking for the transaction.
2. No session `UserID` (direct ODBC, import tool, replication apply, POS terminal that forgets) → NULL flag → check skipped (LEGACY-042).
3. The flag is per-user and defaults **off**.
4. The `MatOvercost` check no-ops when `BtmActualCost` is NULL — so a new material, or one poisoned by LEGACY-007, silently never triggers "don't sell below cost".

Additionally, the quantity check applies **only** to materials flagged batched/category/variety (`:24`).

**New system:** stock availability is a database invariant no session flag can disable, with a separate, audited, explicitly-granted override recording who overrode what.

---

## C. Concurrency and consistency

### LEGACY-049 · **C** · Aggregate tables have no unique key, so the upsert race creates duplicates that are then double-updated forever
`MatObjects` and `MatQuantity` have **no key columns**, while `AccObjects` and `AccTotals` do. They are maintained by the classic non-atomic upsert (`OnBillItemsAIUD.sql:231–261`, `:275–285`): `UPDATE`; `if (ROW_COUNT = 0) then INSERT`.

**Interleaving:** two users post the first-ever line for the same (material, warehouse, job, site). Both UPDATEs return 0 rows (neither sees the other's uncommitted insert). Both INSERT. Both commit. Nothing rejects either.

Now **two rows** exist for one key. Every subsequent posting updates both (the WHERE is not a singleton), so each movement is counted twice. `procFixObjects` collapses them, and the race immediately reintroduces the duplicate — which is exactly why the repair procedures exist.

Contrast `AccTotals` and `Numbers`, where the same race produces a loud primary-key violation. **The unkeyed tables fail silently, which is worse.**
⚠️ *Absence of the key is inferred from the schema dump's `*` convention; confirm against `RDB$RELATION_CONSTRAINTS`.*

### LEGACY-050 · **H** · NULL dimension values make aggregates accumulate orphans and lose all decrements
`OnBillItemsAIUD.sql:227`/`:242–245` match `MtoJob`/`MtoWarehouse` on raw equality; `MatQuantity` (`:270`,`:279`) coalesces Batch/Variety/Category but **not** Job/Warehouse. `procProducePackage` is a live producer of NULL-job rows.

**Failure:** a line saves with `BtmJob` NULL. `MtoJob = NULL` is unknown, so the increment matches nothing, `ROW_COUNT = 0`, and a fresh row is inserted. Delete the line: the decrement also matches nothing, and **there is no `ROW_COUNT = 0` fallback on the decrement** — the row stays. Each NULL-job line accumulates one orphan row. Repair does not stick either: `procFixObjects.sql:44` groups by `BtmJob`, and SQL `GROUP BY` folds all NULLs into one row with `MtoJob` NULL — which the trigger then never finds again.

**New system:** primary key on every aggregate table; dimension columns `NOT NULL` with a sentinel; `MERGE`/`UPDATE OR INSERT` against that key.

### LEGACY-051 · **H** · Document numbering races on first use, has no uniqueness constraint, and cannot be gapless
`procGetNewNumber.sql:15–39`. `for update with lock` locks nothing when no row matches, so two transactions creating the first document of a new muniment both read NULL and both insert → primary-key violation on the very first document of every new document type.

Once the row exists, `with lock` serialises all concurrent creation of that document type (a throughput ceiling, plus deadlock risk when a transaction numbers two muniments in different orders).

`Vouchers.VouNumber` and `Bills.BilNumber` have **no unique constraint anywhere in the corpus**. `NumberTrigger.sql:6–9` only assigns a number when blank *and* `IsManual <> 0` — so auto-numbering is skipped for non-manual documents, and a client supplying its own number bypasses the counter entirely with nothing detecting the duplicate.

`NumberTrigger.sql:8` always passes `NumID = 0`, so the counter is per (Site, Muniment) and monotonic forever — **no period reset**. Any year component comes from `MunCode` via `procFormatNumber`, but changing `MunCode` at year end does not reset the counter. And `procFormatNumber.sql:11–12` declares `varchar(9)` prefix/suffix buffers while `:31` assigns a `substring(... for 30)` — a format longer than 9 characters truncates or raises.

**Failure for compliance:** a tax authority requiring unbroken sequential invoice numbers cannot be satisfied. Numbers are assigned at row-insert (not at issue), clients may supply their own, deleting a committed invoice leaves an unrecoverable gap with no record of what occupied it, and nothing enforces uniqueness of the rendered string.

**New system:** assign the legal number at **issue** time in a dedicated short transaction against a per-(series, period) counter; unique constraint on `(series, period, number)`; deletion of issued documents forbidden; voided numbers recorded explicitly so the sequence is provably unbroken.

### LEGACY-052 · **C** · Serial numbers can be sold twice
`procSerCheck` — the availability check — has **no callers anywhere in the database** (grep returns only its own `CREATE`). Serial availability is checked, if at all, entirely in the Delphi client, so every other write path bypasses it. And there is no fallback: the `Serials` table has **no primary key**.

The procedure is also wrong on its own terms: it answers a *range* question with a single boolean (`break` on the first match at `:48–55`), so selling SN1000–SN1099 where 99 are already sold and one is in stock reports the whole range available.

**Interleaving:** two cashiers scan the same IMEI simultaneously. Both call `procSerCheck` (read-only, no lock, snapshot isolation), both get `Balance = 1`, both commit. Nothing detects it — no unique index, no cross-checking trigger. **The device is sold twice.**

**New system:** serial units are rows with a unique constraint on (serial, in-stock state), so double-issue is impossible at the storage layer, not the query layer.

### LEGACY-053 · **M** · Runtime DDL disables integrity machinery mid-transaction
`Payments/FixPaymentValues.sql` issues `'alter trigger "OnPaymentsAU" inactive'`, bulk-updates, then `'alter trigger "OnPaymentsAU" active'`. **If it fails between those points the trigger stays inactive** and the database silently stops maintaining payment values, with no alarm. `tcbReports/procFixStatistics.sql:12` iterates every index in `RDB$INDICES` issuing DDL, holding metadata locks across the whole database. `procRenumberTier.sql:18` resets a generator after renumbering every voucher — a concurrent insert in that window produces a duplicate audit ID. `procFixAccad.sql:6` creates an index that then becomes a silent prerequisite.

**New system:** schema changes only through the migration system, never from application code; never disable integrity machinery as part of a data fix.

### LEGACY-054 · **H** · A full recost aborts on the first historical below-cost sale
`procCalcCosts.sql:214–220` writes `BtmActualCost` back row by row. That `UPDATE` fires `OnBillItemsBIU` (BEFORE INSERT **OR UPDATE**), whose guard at `:36–40` compares the historical unit price against **the value being written** and raises `MatOvercost`.

**Failure:** a manager with `UsrIsMatNoOvercost = 1` runs a recost after a supplier price rise. The replay reaches a sale priced below the *newly computed* cost, raises, and the whole transaction rolls back — **including every material already processed**. The only way to complete a recost is to log in as a user without the flag, which silently disables the overcost control for that session's normal data entry.

This is a mutual-recursion defect: an *entry-time data-quality guard* applied to a *system-generated correction*, where the guard's operand is the field the correction writes.

**New system:** separate entry-time policy from the recompute path entirely; make a full recost restartable and idempotent, not one all-or-nothing transaction.

---

## D. Plain logic bugs

### LEGACY-055 · **M** · `procMatStorage` (FIFO stock ageing) is non-functional
`tcbReports/procMatStorage.sql:39`:
```sql
if (("Material" is not null) or ("Material"<>"aMat")) then "aRemain" = 0;
```
`OR` where `AND` is meant. From the second row onward `Material` is always non-null, so the condition is true on every iteration and `aRemain` resets each row — **the FIFO carry-forward never happens**. Additionally `aCount` (`:21`) is declared but never initialised, then used as `select skip (:"aCount")` — NULL on first use, and `"aCount" = "aCount" + 1` stays NULL forever. Also `create or alter procedure "%Name%"` — the deployment template placeholder was never substituted (see LEGACY-075).

### LEGACY-056 · **H** · Serial lookup is length-and-prefix based, non-sargable, and silently wrong
`procGetSerials.sql:84–88` and `procSerLookupSerial.sql:24–28` gate on `STRLEN(col) = STRLEN(literal)`. `StrLen` is a UDF, so this **cannot use an index** — every serial lookup is a full table scan.

**Failure:** a block recorded as `SN0001`–`SN0500` (6 chars); an operator scans a label printed `SN1` (3 chars). The length guard fails, no row returns, and the serial reports as **not in stock** — so it can be received again, creating a duplicate. Conversely a 6-char serial from a different block can satisfy the range and match the wrong material; `procSerLookupSerial` takes `first 1` of an **unordered** result.

Range semantics are lexicographic too: `"Serial" >= 'SN100' and "Serial" <= 'SN99'` matches nothing, because `'SN9'` sorts after `'SN100'`. Any non-zero-padded numbering scheme gives wrong ranges silently.

### LEGACY-057 · **H** · Serial enquiry expands blocks unit-by-unit with a full scan per unit
`procGetSerials.sql:117–132` loops `SerCount` times, calling `procSerStateCount` per unit — each a `COUNT(*)` over `SerActivateItems` with a non-sargable two-sided range predicate.

**Failure:** 10,000 handsets received as one block; a stock enquiry produces 10,000 rows each triggering a full scan. With 200,000 activation rows that is ~2×10⁹ row comparisons **for one screen**. `procSerInventory` then loops those 10,000 rows calling `procSerGetStates` again per serial.

Auxiliary: `procSerStateCount.sql:8` declares `smallint` for a `count(*)` (overflows past 32,767); `procSerGetStates.sql:7,24` builds `varchar(40)` by unbounded concatenation (raises string truncation at nine or more states); `procGetSerials.sql:117` — if `SerCount` is NULL the loop never runs and **the entire block silently disappears from the result**.

### LEGACY-058 · **M** · `procGetTaxItems` applies contradictory filters to the two halves of its union
Same parameter, different meaning per side. `vTaxCode = -1` ("uncoded"): the bill half (`:63–69`) adds `BtmTaxCode is null`; the voucher half (`:103–109`) adds `ItmTaxCode is null` — but the voucher seed at `:97` **already contains `and ("ItmTaxCode" is not null)`**, a contradiction that always returns zero voucher rows. `vTaxCode = 0` filters bills but leaves vouchers unfiltered. `vDirection` maps differently on each side. `vMaterial` and `vWithZeroPrice` apply to bills only.

**Failure:** an "all uncoded transactions" reconciliation reports uncoded bill lines but **never uncoded voucher lines** — so a manual journal posted without a tax code is invisible to the reconciliation *and* excluded from the VAT return. Untaxed manual journals disappear entirely.

### LEGACY-059 · **H** · `procGetTaxItems` overflows its declared buffer on a normal VAT return
`:37–39` declares `varchar(1000)` for `aVouQry`. The seed literal is ~891 characters, leaving ~109. The appended predicates at `:98–119` total ≈148 characters, and a VAT return **always** supplies both dates.

**Failure:** either the engine raises string truncation (the good case — the return fails visibly) or it truncates. Losing the tail at a clause boundary yields a **valid query with the period filter missing**, and the VAT return silently reports every voucher ever posted instead of the quarter. That is a filed-return-level error with no visible symptom.

### LEGACY-060 · **M** · `procFixMatStatus` uses two different sort orders and drops columns it rebuilds
`:33` primes the group key with `order by "BtmSite","BtmMuniment","BtmMaterial",…` while the main loop at `:42` uses `order by "BtmSite","BtmMaterial","BtmMuniment",…` — so **the first emitted group is attributed to the wrong key**. The procedure also `delete from "MatStatus"` at `:23` then omits `MtcCurPrice`/`MtcCur` from both INSERT lists (`:53`, `:83`) — **running the repair wipes all foreign-currency purchase prices**. And `:68` unconditionally overwrites `"Date"` before `:69` tests it, making the date guard dead code.

### LEGACY-061 · **M** · `procUpdateMatCosts` resets every material's cost to its opening value, permanently
`:20–22` does `update or insert … matching ("CstSite","CstMaterial")` with the *opening* cost. It does not set `CstChanged`, so the subsequent `vForce=0` recompute skips them all and **the reset is permanent**.

### LEGACY-062 · **L** · `procCalcCosts` writes the wrong watermark document at every group break
`:112` (`"CstMaster" = :"aMaster"`) executes *after* `aMaster` has been fetched for the first row of the **next** material. So `MatCosts.CstMaster` — which `OnBillItemsAIUD.sql:93` uses as the "already costed past this document" watermark — points at a bill belonging to a different material. Only the final group gets the right value.

### LEGACY-063 · **L** · Unguarded division by `BtmSize` in six of eight places
`procCalcCosts.sql:169,171`, `OnBillItemsAIUD.sql:78,79,83`, `OnBtmJobCosts.sql:82,83,87` divide by `BtmSize` with no zero/NULL check. `OnBillItemsStatusAI.sql:6` and `procFixMatStatus.sql:40` **do** guard it — the same hazard handled in two of eight places.

### LEGACY-064 · **L** · Copy-paste dead NULL guard
`OnBillItemsAIUD.sql:62–68` — the third test re-checks `CurBuyPrice`, which line 63 has just forced non-null, so it never fires. `BuyCur` is never defaulted and a NULL `CstBuyCur` is written back at `:102`. Identical bug at `OnBtmJobCosts.sql:66–72` and in `OnBtmBatchCosts`.

### LEGACY-065 · **L** · Unreachable dead code in the audit trigger
`OnJournalAuditAIUD.sql:59` tests `if (RDB$GET_CONTEXT('USER_SESSION','Silent') is not null)` inside a block only reachable when `Silent` **is** null (guard at `:8`). Lines 61–63 can never execute.

### LEGACY-066 · **L** · Unit conversion is defined in the schema and applied nowhere
Exhaustive grep for `MntExchange`: three hits, none of which convert anything. `tcbReports/procGetMatByUnits.sql:13–30` has the entire conversion body **commented out** and returns `ByUnits = ''` unconditionally.

Consequences provable from the SQL: the base-unit quantity (`Debit`/`Credit`) and the entry quantity (`Qnt` × `Size`) are two independently-stored values with **no constraint tying them**; `MatUnits.Exchange` is `double precision` while quantities are `numeric(18,4)`, so a three-per-box factor stored as 0.333333… does not round-trip (10 boxes → 30 units → 9.9999… boxes); nothing rejects `Exchange = 0` or NULL.

**New system:** store quantity once in a canonical unit as exact decimal; store the conversion factor as an exact rational (numerator/denominator), never a float; derive the display unit rather than storing a second unvalidatable copy.

---

## E. Performance and scalability

### LEGACY-067 · **H** · Stock-on-hand replays the entire movement history under a forced index-navigation plan
`procSumMaterials.sql:19–37` aggregates all of `BillItems` with `PLAN ("BillItems" ORDER "IdxInventory")`. The same directive appears in 10 places.

Three problems: (a) `ORDER <index>` forces one random data-page fetch per row for a query that aggregates the whole table — the optimiser's natural sequential-scan-plus-sort is *disallowed*; at 500k rows this is minutes, at 5M rows unusable; **and it ignores `MatObjects`/`MatQuantity`, which exist precisely to answer this question**. (b) The index names are baked into string literals in ten procedures — rename or drop one and all ten fail at runtime with no fallback. (c) The `PLAN` and the `ORDER BY` are assembled independently, so the correctness of the chronological replay rests on `IdxInventory` being exactly `(BtmMaterial, BtmDate, BtmMaster)` — an assumption living only in DDL that is not version-controlled with this code. **Change that index and costing silently produces wrong numbers rather than failing.**

There is also **no tie-break within a day**: same-day documents order by insert order, so back-dated same-day corrections re-order the replay.

### LEGACY-068 · **H** · 23 hardcoded query plans, two pinning implicitly-generated index names
`procSelectLogDates.sql:19` pins `"IdxLogDate"` and `"fkLogElement"`, which appear **nowhere** in any schema source as declared objects — they exist only because `Logs.Date` carries `Indexed = True` and `Logs.Element` carries a `ForeignTable`, and the generator derives the names. **Unticking one checkbox in the schema designer silently deletes an index that a hand-written plan hundreds of lines away depends on.** No tooling can catch this.

`procInitArrTier.sql:87` forces `plan ("Accounts" natural)` — a full table scan, forever. And the plan in `procSelectLogDates` orders by an index whose second segment is not filtered, so it is **worse than what the optimiser would choose**.

### LEGACY-069 · **M** · Every report query is rebuilt, re-parsed and re-planned on each call, into fixed-size buffers
61 `execute statement` sites across 48 objects. `procSerInventory` appends up to **24 fragments** into `varchar(600)`, including a 60-character user serial. Prepared-statement caching never hits. Overflow raises at runtime only under the specific filter combination that makes the query long enough — combinatorially hard to reach in testing, guaranteed to be found by a customer.

Concatenation is also written without separator spaces (`from "BillItems"inner join`, `"MunID"where`). **This currently parses** because a closing quote terminates the identifier — it is not a live bug, but it is one edit away from being one.

~54 sites interpolate `DATE` parameters as text, relying on the connection's date-literal parsing. `Appointments/procAppointment.sql:175–176` carries a `--{review for compatibilty to firebird4}` marker where a cast was replaced — the team already hit engine-version date fragility.

### LEGACY-070 · **M** · Index coverage is thin on exactly the columns reports filter by
Cross-referencing every index definition against filter predicates across the corpus:

| Table | Column | Filter sites | Status |
|---|---|---:|---|
| `Journal` | `JurDate` | 6 | **no index** — every date-ranged ledger report is a full scan |
| `Journal` | `JurJob` | 4 | no FK, **no index** |
| `BillItems` | `BtmJob` | 31 | no FK, **no index at all** |
| `VouItems` | `ItmCostCentre` | 5 | no FK, **no index** |
| `VouItems` | `ItmSite` | 45 | FK index only, ~1 distinct value |
| `VouItems` | `ItmLevel` | 35 | FK index, very low selectivity |
| `Bills` | `BilMuniment` | 12 | FK index, ~30 distinct values |

`Journal` — the general ledger header, the most reporting-critical table in the product — has exactly **one** declared index, and it is not on date.

**This is the causal link to LEGACY-067/068: the hardcoded plans exist because the indexes are wrong.** Pinning a plan was the workaround for missing coverage.

**Note on a common miscount:** the "155 indexes" figure counts only explicitly-declared index objects. There are also 589 field-level `Indexed = True` flags plus automatic indexes for every PK/unique/FK (997 FK fields) — total on the order of 750+. **The problem is placement, not count.**

### LEGACY-071 · **L** · Tree-integrity checks run a recursive procedure per row inside triggers
`standard.sub.hscript:1858–1875` and the same pattern in `hospitals` and `services`: every insert/update on a tree table walks the ancestor chain via a recursive procedure call — O(depth) queries per row. `RecursiveRecord` is the most-raised exception in the corpus (20 of 151 raise sites), confirming the pattern is replicated widely. The check is duplicated in at least three modules rather than shared.

**New system:** recursive CTE or a materialised path / closure table, so cycle detection is one indexed lookup. Implemented once.

---

## F. Integrity, maintainability, operability, quality

### LEGACY-072 · **H** · Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states
`grep -oE '\bcheck\b *\('` across all schema sources → **0**. Of 5,136 columns, 1,846 are `NOT NULL` (36%) and **544 are boolean**.

| Table | Columns | Boolean flags | Nominal state space |
|---|---:|---:|---:|
| `Users` | 75 | **40** | 2⁴⁰ ≈ 1.1 × 10¹² |
| `Muniments` | 57 | **32** | 2³² ≈ 4.3 × 10⁹ |
| `AccTypes` | 36 | **30** | 2³⁰ ≈ 1.1 × 10⁹ |
| `Accounts` | 63 | 20 | 2²⁰ |
| `Materials` | 69 | 20 | 2²⁰ |

`AccTypes` is the clearest case — a discriminated union (`IsAsset`, `IsLiability`, `IsEquity`, `IsExpense`, `IsIncome`) modelled as independent booleans with nothing preventing all five being set. `Muniments` has `IsOpen` and `IsClose` as separate flags with no constraint preventing both.

**Why this is the single largest testability obstacle:** these state spaces are not all reachable, but **nothing declares which combinations are legal**, so the rules exist only in Delphi UI code and 318 triggers. They cannot be enumerated, tested, or reasoned about. Every `if IsBill and not IsReject and IsCosting` branch across 33,179 lines is an untested path, and no exhaustive test suite is writable because there is no specification of the valid state set.

**New system:** replace mutually-exclusive flag clusters with a single enumerated discriminator; keep booleans only for genuinely independent facts; enforce every remaining rule as a `CHECK` or a state-machine table so the legal state set is finite, declared, and enumerable by a test generator.

### LEGACY-073 · **H** · Referential integrity is enforced inconsistently for the same logical relationship
The schema is *not* free of FKs — 997 fields carry a foreign table, 795 with an explicit delete action. The defect is inconsistency:

| Column | Declared FK | **No constraint** | % unconstrained |
|---|---:|---:|---:|
| `Job` | 11 | **49** | 82% |
| `CostCentre` | 8 | **35** | 81% |
| `SubAccount` | 9 | 10 | 53% |
| `Warehouse` | 9 | 9 | 50% |
| `Account` | 69 | 40 | 37% |
| `Site` | 78 | 45 | 37% |
| `Muniment` | 57 | 12 | 17% |
| `Dealer` | **0** | 3 | 100% |

Confirmed at field level: `VouItems.Job` has FK `Jobs`; `BillItems.Job` has **none**. Same logical concept, one constrained, one not.

**Direct evidence of drift being repaired in production:** `standard/FixAccOperatings.sql` adds six missing FK constraints at runtime on live databases via `execute statement` (`fkBtmCostCentre`, `fkBilCostCentre`, `fkJurCostCentre`, `fkItmCostCentre`, `fkVouCostCentre`, `fkDptcCostCentre`). That these had to be retro-fitted proves the constraint was missing while data accumulated. The script has **no orphan-cleanup step and no failure handling** — on any database with a dangling `CostCentre` the `ALTER` fails and the upgrade aborts mid-way. Any database that never ran it has no cost-centre referential integrity at all.

Corroborating: the shipped `fixes/fix-finals.sql` and `fixes/fix-Jobs.sql` do exactly this — drop the NOT NULL flag via direct `RDB$RELATION_FIELDS` manipulation, then `update … set "ItmJob" = null where "ItmJob" not in (select "JobID" from "Jobs")`. **Editing system tables directly to null out orphans is the shipped remediation.**

### LEGACY-074 · **M** · 42 of 460 tables have no primary key
9.1%, and the significant ones carry transactional data: `posEntryItems` (30 cols), `AttendItems` (23), `PayDetails` (14), `Enrolls` (14), `SerActivateItems` (14), `MatObjects` (14), `OrderInfo` (13), `JurTaxInfo` (13), `BillInfo` (12), `hspCostPaid` (12), `PayCommissions` (11), `Serials` (10), `CntSerials` (10), `Allotments` (8).

Without a key there is no unique row identity: duplicates cannot be detected or prevented, a row cannot be individually corrected or audited, replication has nothing to reconcile on, and no other table can ever reference these rows.

### LEGACY-075 · **M** · Deployment template placeholders were never substituted in shipped objects
`standard/procFixMatStatus.sql:1`, `tcbReports/procMatStorage.sql:1`, `tcbReports/procSplitBtmQnt.sql:1` begin `create or alter procedure "%Name%"`; `standard/NumberTrigger.sql:1` uses `"%Table%"`. As shipped these create objects literally named `%Name%`.

More broadly, **141 of 913 objects (15.4%) declare themselves as `"%Name%"`** — the deployed name comes from schema metadata at generation time. This is how two procedures came to be **byte-identical** (LEGACY-076). A procedure's source does not state its own identity, so grepping for a name finds call sites but not the definition.

### LEGACY-076 · **M** · 9% of the corpus is duplicate or near-duplicate code
Jaccard similarity on normalised statement sets: **68 pairs ≥ 0.60, 15 pairs ≥ 0.80, 82 distinct objects (9.0%)**.
```
1.00  procViewBillVisits ≡ procViewSerials          (byte-identical)
0.93  procAccMonthProfits ~ procAccProfits          (~11,000 chars of costing logic, twice)
0.92  Academy/procAddStudent ~ hospitals/procAddPatient
0.91  standard/procSumVouItems ~ tcbReports/procSumVouItems3
0.90  procSelectAccountVouchers ~ …Vouchers1
0.77  procCalcCosts ~ procCalcJobCosts              (source of LEGACY-010)
```
The "append a digit to clone it" pattern is systemic: `procSumVouItems`/`2`/`3`, `procAccBalances`/`1`/`11`, `procAccLastPaid`/`1`, `procInitMatArray`/`1`, `procFixMatStatus`/`2`, `ProcChamFix1`/`2`.

**Why it matters:** every costing or profit rule change must be applied in 2–3 places nothing links together. The 0.93-similar profit pair and the 0.77-similar costing pair are exactly where a missed edit produces **figures that disagree between two reports over the same data** — the hardest class of accounting defect to diagnose. LEGACY-009 is this defect realised.

### LEGACY-077 · **M** · The call graph is unresolvable, so dead code cannot be identified
92 of 372 procedures (24.7%) appear ≤2 times across the entire corpus — essentially only their own definition. **They cannot be concluded dead**, because report definitions are stored as `MEMO` blobs in the `Reports` table inside customer databases, not as files.

**That is itself the finding:** because report definitions live as blobs in customer databases, **no static analysis can ever determine whether a procedure is live.** A maintainer facing `procAccProfits` and `procAccMonthProfits` (93% identical) cannot establish whether either is still called without inspecting every blob in every customer database. This is a permanent structural obstacle to deleting anything — and precisely why near-duplicates accumulate instead of being consolidated.

Explicitly-marked dead code ships too: 9 objects carry abandonment suffixes (`OnTeachersAI_Canceled`, `OnStudentEnrollsTaxBUD_Disabled`, `procTestArray`, …) and 16 carry `Enabled = False`.

### LEGACY-078 · **M** · Behaviour-governing configuration lives in opaque blobs
38 `MEMO` columns hold serialised structure: `Reports.Value` (report definitions), `Muniments.Options` (document-type behaviour, hex-encoded XML), `Points.Options`/`Setting`, `Users.Permissions`, `Fixes.Value`, `Qualifies`, `TerminalOptions`, `Tokens`, `Dimensions`, `Sections`, `Serials`.

Configuration that determines system behaviour is undiffable, unreviewable, untestable and unmigratable. Two customers reporting different behaviour cannot be compared. A schema change affecting an option's meaning has no mechanism to rewrite the blobs. `Permissions:MEMO` in particular means the authorisation model is not queryable — you cannot answer "who can do X?" in SQL.

### LEGACY-079 · **M** · 44 repair objects, two parallel idempotency ledgers, and one provably broken guard
44 of 913 objects (4.8%) exist to repair data the system corrupted — 8 upgrade hooks and 36 `procFix*` procedures. Idempotency is tracked in two unrelated places: a `Fixes` table and rows in the generic `Options` table keyed `OptSection='Fixes'`.

**A concrete defect in that ledger:** `FixNumbers` reads `OptName='FixNumbers'` but writes `OptName='NcsIsManual'`. `'FixNumbers'` is never written anywhere in the tree, so the guard is permanently null and **the block re-runs on every rebuild** — and it collides with `FixNcsIsManual`, which owns that key. The object carries `Enabled = False`, which is presumably how this was contained.

### LEGACY-080 · **H** · Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers
There is no single schema version: **6,251 independent `Version` integers** (min 1, max 49,367, median 5), one per object. Module versions are unrelated to each other (`standard`=1101, `tcbReports`=215, `system`=1). Upgrade runs via 28 lifecycle hooks around a "pump" — unload and reload the entire database.

The UI confirms it is destructive and manual:
```
"File will be rebuilt. Please make sure that you have backup before proceeding."
"You can't rebuild the file through the network"
"You must upgrade the database file before able to login"
```
**Upgrade time scales with total data volume, not with the size of the change**, so it grows without bound over a customer's life. It cannot run over the network, so every upgrade is an on-site or remote-hands event. No forward-only migration ledger, no dry run, no rollback but restore. With 6,251 counters there is no value that answers "what schema is this customer on?" — support triage is guesswork.

**This is root cause RC-6: upgrade is expensive enough that data drift gets patched by repair scripts instead of fixed at source.**

### LEGACY-081 · **M** · Backup and restore are manual, whole-file and destructive
```
"When you restore you will lose all new data writen and not backuped, so make backup before restore."
"This operatrion is very serious" / "The data will be deleted before recovery"
"Can not emergency restore over network"
"Save To Floppy" / "Restore From Floppy"
```
Recovery granularity is the whole database at the last operator-initiated backup — restoring to fix one bad batch discards every transaction since. Restore cannot run over the network. Backup depends on a human remembering. **RPO is undefined and in practice is "since whenever someone last clicked it."** Floppy-disk export paths are still live UI in a shipping build.

### LEGACY-082 · **M** · Licensing is pinned to a hardcoded private IP address
`resource/setting.config`, shipped: `<GuardServer>192.168.1.14</GuardServer>` and `<WorkPath>C:\My Data\Legacy SQL\</WorkPath>`. Any customer whose LAN is not `192.168.1.0/24`, or whose licence host moves or changes DHCP lease, has a licensing failure with no diagnostic. A licensing check that must reach a single fixed IP is a single point of failure for the entire product by construction.

### LEGACY-083 · **H** · One error handler in 33,179 lines, and it swallows the error
Across all 913 objects there is exactly **one** `when` handler — `Appointments/procAppointment.sql:177`: `when any do vMaxDay = vMaxDay -1;` — using exceptions as month-length control flow, which masks genuine failures.

With 151 exception raise sites and 318 triggers and no compensating logic anywhere, every failure propagates raw to the client: the user sees Firebird engine text (`violation of FOREIGN KEY constraint "fkBtmMaster"`), and every partial multi-step operation unwinds only if the client's transaction happens to be scoped correctly.

### LEGACY-084 · **M** · Error messages are not actionable and the code convention is broken
All 56 exception definitions:
```
MatOvercost         'MatOvercost #@1'              ← identifier + placeholder, no message
AssetChanged        'AssetChanged #@1#@2#@3'       ← same
DocNameDuplicated   <no Message property at all>   ← raised twice in the corpus
InvalidUnitExchange 'Invalid Unit Exchange :-('    ← emoticon in production text
ObjectHasSons       'Object has sons'
CanNotDelete        'Can not delete record'
```
The `(x):` prefix looks like a searchable code but is not unique — **seven hospital exceptions all share `(d)`**, `Additions` reuses `(e)` for two different exceptions, and one is missing its colon and misspells "Patient". Messages state a refusal without a remedy: *which* object, *which* record, *which* value is never named. 5 of 56 exceptions are defined but never raised.

### LEGACY-085 · **M** · The English build was never proofread
Over 13,778 `msgstr` entries: **61 untranslated Arabic strings**, **122 empty translations**, **452 distinct misspellings** (575 occurrences), 232 with trailing whitespace.

Arabic reaching English users includes two *dialogs*: `هل تريد حفظ التعديلات ؟` ("Do you want to save changes?") and `حدث خطأ عند توليد الملف` ("An error occurred generating the file") — an English-locale user is asked to confirm an unsaved-changes prompt they cannot read.

Representative misspellings: `"Attend Entiers"` (×12, for "Entries"), `"Bill dosn't exist"` (×7), `"Calulating Profits"` (×6), `"Ignor New Debits"` (×5), `"Restor"` (×4), `"pay/recieve"`, `"This operatrion is very serious"` (**the restore confirmation dialog**), `"Realted pyamnet, can't be deleted."`, `"Admistrator"`, `"SunAccount"`, the product's own name, misspelt, and `"TBXToolbar3"` — a raw Delphi component name shipped as UI text, proving strings were extracted mechanically and never reviewed.

Note the metadata itself uses `Futures` throughout where **`Features`** is meant.

### LEGACY-086 · **L** · A vendor hardware config with mojibake and duplicate keys ships to every customer
`bin/Initial.xml` — the only file of its kind — is a cash-drawer/watchdog config for one OEM board (`PS6509LF`) containing raw Super-I/O port programming (`0x4E`/`0x4F`). `Cash_Drawer2_Action4/5/6` are each defined **three times** with differing values; comments are mojibake (Big5 read as Latin-1); `//` comments make it invalid XML. Direct port I/O requires kernel access and is blocked on modern Windows without a signed driver.

**New system:** peripherals through OS/vendor APIs (OPOS/JavaPOS or a vendor SDK), never raw port I/O; device profiles are schema-validated data.

### LEGACY-087 · **L** · Hardcoded developer build paths in shipped metadata
`types.hscript` and every module carry absolute paths from the original developer's machine: `W:\Work\delphi\jobs\legacy_sql\source\core\tcbTypesConsts.pas`. The build is machine-bound.

---

# PART II — ROOT CAUSES

Six structural decisions generate almost all 87 defects. Fix these and most of Part I becomes unreachable by construction. Fix only the symptoms and they will regrow.

### RC-1 · The database has no notion of an authenticated caller
Identity is written by the client into a namespace the client can write (`RDB$SET_CONTEXT`), read back by five triggers, each behind a client-settable off-switch. Consequence: **authorisation is advisory**. Generates LEGACY-025, 026, 027, 028, 029, 030, 031, 032, 033, 035, 038, 039, 040, 041, 042, 043, 044, 045, 046, 047, 048, 052.

**Fix:** identity is established server-side and is not addressable from the request path. Every authorisation decision reads an authenticated principal. Tenancy and confidentiality are mandatory query predicates (row-level security) that no parameter can widen.

### RC-2 · Derived state is stored and hand-maintained instead of derived
Balances, quantities and costs live in ~12 aggregate tables maintained by 318 triggers with hand-written `−old + new` arithmetic. Every one of those triggers is an opportunity to miss the DELETE case, miss a key column, or introduce NULL. Generates LEGACY-001, 002, 003, 004, 005, 006, 007, 008, 011, 012, 016, 017, 018, 021, 023, 024, 049, 050, 051, 054, 062 — and is the reason all 44 repair objects exist (LEGACY-079, filed under RC-6).

**Fix:** an immutable append-only ledger is the only financial truth. Aggregates are projections that can be dropped and rebuilt bit-identically, with a continuous reconciliation job. If a number cannot be recomputed from the ledger, it is not allowed to exist.

### RC-3 · Behaviour is encoded as boolean flags rather than types
544 boolean columns; `Users` 40, `Muniments` 32, `AccTypes` 30. Zero CHECK constraints. **Nothing declares which combinations are legal**, so the rules exist only in client code and trigger branches — unenumerable, untestable, unreasonable-about. Generates LEGACY-013, 020, 072 directly, and the untestability that lets everything else hide.

**Fix:** one enumerated discriminator per concept; booleans only for genuinely independent facts; every remaining rule a CHECK or an explicit state machine, so the legal state set is finite and a test generator can enumerate it.

### RC-4 · Business logic is written as dynamically-concatenated SQL strings
61 `execute statement` sites building queries by `||` into fixed-size buffers, with hardcoded optimiser plans assembled from independent code paths. No compile-time checking, no plan caching, silent truncation. Generates LEGACY-010, 014, 015, 022, 036, 037, 055, 056, 057, 058, 059, 063, 067, 068, 069, 071.

**Fix:** parameterised static SQL or a typed query builder that binds values. Filters cross API boundaries as structured values, never as SQL text. Never pin a query plan — a need for a hint is a schema defect to fix, not to freeze.

### RC-5 · Behaviour-governing artefacts live as blobs inside customer databases
Report definitions, document-type options, permissions and terminal settings are `MEMO` blobs. Consequence: **the system is statically un-analysable.** The call graph cannot be resolved, so dead code cannot be identified, so duplication accumulates instead of being consolidated. Generates LEGACY-009, 019, 034, 064, 065, 066, 075, 076, 077, 078, 083, 084, 085, 086.

**Fix:** everything that governs behaviour is version-controlled text — migrations, report definitions, permission catalogues, document-type definitions — reviewed and tested like code, deployed like code.

### RC-6 · Schema change is a whole-database rebuild
6,251 uncoordinated version integers, upgrade = unload/reload, console-only, no rollback but restore. Because a schema correction is expensive and risky, **drift gets patched by repair scripts rather than fixed at source** — which is why 4.8% of the corpus is `procFix*`. Generates LEGACY-053, 060, 061, 070, 073, 074, 079, 080, 081, 082, 087.

**Fix:** ordered forward-only migrations with one monotonic schema version, running online, idempotent, individually reversible, duration proportional to the change and not to the data. Then fixing a defect at source is cheap enough that nobody writes a repair script.

---

# PART III — TARGET ARCHITECTURE

## 3.0 Confirmed deployment decisions — read before Part IV

These are settled. They materially reduce v1 scope and Part IV must be read through them.

| Decision | Settled as |
|---|---|
| **Platform** | **Windows only** for v1. No macOS, no Linux desktop, no mobile. |
| **Packaging** | **Electron desktop applications** — a real Windows installer, own icon, own window, no browser visible. Both the back office and the POS, from one React codebase (§3.7.2). |
| **Data location** | **Cloud-hosted PostgreSQL** (Supabase, Singapore). Not on-premise, not a local file per PC. |
| **Compute** | **Cloudflare Containers** for the API and workers; **Cloudflare Workers** at the edge (§3.2.1). |
| **Runtime** | **Bun 1.4** for the API, workers and build; the test suite runs under Node 24 LTS, which is also kept as a drop-in fallback runtime (§3.2.2). |
| **First tax jurisdiction** | **Malaysia.** ⚠️ Verify current LHDN e-invoicing requirements against the authority's documentation before Phase 5. |
| **First deployment** | **The owner's own business.** Main software at the head office; POS at each branch; data synced between them. |
| **POS** | Built in-house (§3.7.4–3.7.6). Phase 6. Physical hardware out of scope for v1. |
| **Modules** | **Four in v1 — Accounting, Inventory, HR & Payroll, POS** (owner decision 2026-09-05, D20). Coverage map in §3.0.4; HR design in §3.10. |
| **Roles** | Nine seeded system roles on the RBAC tables, branch-scoped, with data-layer segregation of duties (§4.2.1–4.2.2). |
| **Tenancy** | Single tenant in practice at first — but see §3.0.2. |

### 3.0.1 What this removes from v1

Part IV describes a full commercial SaaS. Building for one's own business first means most of that is **deferred, not cancelled**. Do not build these in v1:

- **All billing and commerce** (§4.4) — plans, entitlements, metering, invoicing, dunning, trials, self-serve signup. There is no one to bill.
- **Enterprise identity** — SAML/SSO, SCIM provisioning, IP allow-lists.
- **Public-facing SaaS surface** — status page, published SLA, marketing signup flow, sandbox tenants.
- **Support tooling** — consent-based impersonation, tenant admin console.
- **Row-level confidentiality tiers** (the old `Level`) — v1 scopes visibility by company and branch through RBAC; per-row clearance is deferred until a requirement appears.
- **The other vertical modules** — fixed assets, service contracts, purchase-requisition/PO approval, and certainly the hospital, academy and aviation modules. **HR & Payroll is in v1** (D25, §3.10). The rest are ~140 tables of the old system that this business does not use; build them **only** if a paying customer ever asks (Phase 10).

### 3.0.2 What must still be built now, even for one business

Some things are cheap on day one and brutally expensive to retrofit. Build all of these in v1:

- **`tenant_id` on every table, with RLS from the first migration.** Even with one tenant. Retrofitting multi-tenancy into a live accounting database is one of the most expensive things in software. The column costs nothing today.
- **Company / branch as a first-class dimension** — the business already has an office and branches, so this is a real requirement now, not a hypothetical.
- **The immutable ledger, audit trail, and the integrity checker.** These are the whole point.
- **Backups with point-in-time recovery**, and a tested restore. It is his own company's books.
- **Migrations, CI, and the acceptance tests in Part VI.**

The rule: build the **structure** for multi-tenant SaaS, skip the **commerce**.

### 3.0.3 v1 functional scope, tuned to the actual business

The first customer is a **Malaysia-based importer and distributor of food products with branches**. That shapes v1 far more than a generic accounting feature list. ⚠️ *Confirm each of these with the business before building — they are inferred from the nature of the business, not stated requirements.*

**Likely critical, and easy to underestimate:**

| Requirement | Why it matters here | Old system's equivalent |
|---|---|---|
| **Landed cost** | Imported goods carry freight, duty, clearance and handling that must be allocated across a shipment and into unit cost — otherwise every margin figure is wrong | `BillItems.ExtraCost`, `BomExpenses` |
| **Batch / lot with expiry** | Food. Requires batch on every movement, FEFO picking, expiry reporting and near-expiry alerts | `Batches`, `MatBatches`, `Materials.ExpiredThrough`/`ExpiredBy`/`Age` |
| **Multi-branch stock** | Warehouse per branch, transfers between them, stock and margin visible per branch | `Warehouses` (tree), `MunIsTrans` |
| **Purchase in foreign currency** | Importing means supplier invoices in USD/AED/EUR against MYR books, with FX difference on settlement | `CurHistory`, `CurReconciles` |
| **Multi-unit items** | Carton / inner / piece, with exact conversion — sold in different units at different levels of trade | `MatUnits.Exchange` (defined but never applied — LEGACY-066) |
| **Price lists per customer type** | Wholesale, retail, branch transfer pricing | `Prices`, `PriceGroups`, `AccPrices` |
| **Customer credit control** | Distribution runs on credit; needs limits, ageing, and a block on over-limit sales | `Accounts.MaxLimit`, `DebtAge` |
| **Malaysian tax + e-invoicing** | ⚠️ Verify current LHDN MyInvois requirements against the authority's own documentation — thresholds and schema versions change | `procCalculateGSTReturn`, `GstListingReport` |
| **Attachments per document/batch** | Import permits, halal certificates, bills of lading, customs forms | `Archives` module |
| **Monthly payroll with Malaysian statutory contributions** | Staff at head office and branches are paid monthly with EPF, SOCSO, EIS and PCB/MTD handled correctly; the figures must tie to the ledger and to what is remitted (§3.10) | `Salaries` module (`Employees`, `Payrolls`, `PayItems`, `TaxLayers`, `Lends`) |
| **Staff identity for branch cashiers** | Cashiers are employees: a till login, a payroll record and an audit identity must be one person, and leaving the company must close all three (§3.10.2) | `Users` + `posEnrolls` + `Employees`, unlinked |

**Probably not needed in v1:** manufacturing/BOM, serial numbers (food is batch-tracked, not serialised), consignment stock, dealer commissions, loyalty points, project/job costing. Each is real functionality in the old system; none is obviously required to run an import-and-distribute business. Confirm before cutting.

### 3.0.4 Module coverage map — v1

The owner's instruction (2026-09-05): Dulja must include **accounting, inventory, HR and POS**, with named user roles. This table is the checklist. Every row names the phase that builds it and the Part VI test that proves it. Rows marked ⚠️ were identified as gaps for an importer-distributor with branch shops and need the owner's confirmation before their phase starts.

| Module | Capability | Phase | Proven by |
|---|---|---|---|
| **Accounting** | Chart of accounts, fiscal periods and locking, journals, immutable ledger, trial balance, balance projections, integrity checker | 1 | Tests 1–3, 9 |
| | Document types + versioned posting policies; numbering; approval state machine recorded in `document_event` | 2 | Tests 15, 16 |
| | Customers/vendors (Party), sales and purchase invoices, credit notes, receipts/payments, allocation, ageing, credit limits, payment terms | 4 | Test 8 |
| | **Bank reconciliation** — statement import (CSV), match/unmatch against receipts, payments, payroll batches and till bankings; unreconciled-items report | 4 | Test 39 |
| | **Post-dated cheques** — cheque-in-hand asset with maturity date, deposit and bounce reversal ⚠️ *(confirm the business collects PDCs)* | 4 | — |
| | Multi-currency: rates with source, base = value × rate, FX difference on settlement, revaluation | 1, 4 | Test 8 |
| | Tax: Malaysia pack with the regime as versioned data, returns, e-invoicing hooks | 5 | Test 26 |
| | Reports: trial balance, ledger, statements from Phase 1; report builder, financial-statement layouts and data export | 1 → 7 | Test 2 |
| **Inventory** | Items, exact-rational units, warehouses (tree), lots with expiry, FEFO picking, price lists per customer type, stock-on-hand and valuation projections | 3 | Tests 5–7 |
| | **Goods receipt before invoice** with a goods-received-not-invoiced accrual, and an **import-shipment document** that carries freight, duty and clearance into landed cost per lot | 3 | Test 5 |
| | **Sales order and purchase order** — non-posting commitment documents (`direction: none`, `inventory: none`) with agreed price, quantity and open-quantity tracking; a SALES_ORDER converts into one or more DELIVERY_ORDERs (back-orders stay open); a PURCHASE_ORDER is what a GOODS_RECEIPT receives against and prices its GRNI accrual from; no approval workflow (that stays Phase 10) | 3 | Test 15 |
| | **Delivery order** — stock leaves before the invoice; converted into the invoice; customer statements | 3 (document), 4 (invoice link) | — |
| | **Stock count / cycle count** with variance posted through a STOCK_COUNT document, approved by a second principal | 3 | Test 31 |
| | **Two-step inter-branch transfer** — dispatched into an in-transit warehouse, received at the branch, variance on receipt | 3 | — (Phase 3 definition of done) |
| | **Expiry write-off** — branch drafts, accountant approves, posts to an expiry-loss account tagged BRANCH; near-expiry alerts | 3 | — |
| | Cost layers; weighted average (owner to confirm); back-dated recost forward only; one costing implementation; free-of-charge lines that consume stock and cost at zero price | 3 | Tests 5–7 |
| **HR & Payroll** | Employee master (Party kind employee, optional principal, home branch), sensitive data encrypted and permission-gated, effective-dated compensation, typed pay components mapped to GL | 8 (the minimal master itself: 6) | Tests 31, 32 |
| | Statutory schemes as versioned, verified, effective-dated rate tables (EPF, SOCSO, EIS, PCB/MTD); pinned per run; unverified or out-of-range tables refuse | 8 | Tests 29, 33 |
| | PAYROLL document through the posting service; PAYROLL_PAYMENT bank batch; statutory remittances as PAYMENT documents to each authority; EMPLOYEE_ADVANCE with recovery deduction | 8 | Tests 28, 30 |
| | Payslips; monthly contribution schedules per scheme; annual statements; `employee_ytd` projection rebuilt from posted lines; mid-year cut-over YTD import | 8, 9 | Tests 33, 35 |
| | Attendance events from POS clock-in/out and manual correction — readable by HR, never an automatic pay input; unpaid leave enters payroll as a deduction quantity. A leave register (types, yearly entitlement, request/approval) only if the owner confirms ⚠️ | 8 (events: 6) | Test 33 (unpaid-leave quantity in the golden fixture) |
| | Termination closes payroll, till credential and role assignments in one transaction | 8 | Test 34 |
| **POS** | Selling, pricing, promotions, multi-tender, returns, customers, shifts and Z-report, staff PIN login, offline outbox, price check | 6 | Tests 19–22 |
| | **Till cash lifecycle** — paid-outs for small branch expenses, safe drops, daily banking as cash-in-transit cleared by bank reconciliation; no-sale, void and drawer-open events on the ticket stream ⚠️ | 6 | Test 21 |
| | Cashier authority offline: permission codes and discount/override limits travel with the catalogue; sync apply re-verifies the cashier's authority and any supervisor override server-side | 6 | Test 37 |
| **Cross-cutting** | Tenancy + RLS, identity, RBAC with nine roles, branch scoping, segregation of duties, audit log, idempotent API | 0, 2 | Tests 4, 10–14, 36 |
| | BRANCH dimension **mandatory** on every revenue, COGS and staff-cost ledger line (a posting-policy `requires`), so branch P&L has no unallocated lines | 2 | Test 28 (a PAYROLL line without BRANCH is refused) |
| | **Attachments** — object storage (R2) addressed by opaque server-generated ids (LEGACY-038), SHA-256 recorded per file, linked to a document or a lot, download gated by the owning module's read permission, included in tenant data export | 2 (service + document link), 3 (lot link) | Test 13 (every upload audited) |

**Still deferred (Phase 10):** fixed assets and depreciation (depreciation is a manual JOURNAL until then), service contracts and maintenance, purchase-requisition/PO approval workflow, and — very likely never — the clinic, school and aviation modules.

## 3.1 Non-negotiable principles

1. **The ledger is immutable and append-only.** Corrections are reversing entries, never updates. Every stored balance is a projection rebuildable bit-identically from the ledger.
2. **API-first.** The back-office app, the POS and every integration use the same documented API. No private back door, no direct database access from any client.
3. **Document types are data; posting rules are versioned policy objects** — declarative, validated, tested, and *pinned to each posted document* so history is never re-interpreted (the fix for LEGACY-013).
4. **Every write is attributable**: who, when, from where, under which policy version, with before/after images.
5. **Multi-tenant from line one.** Tenant is a first-class key enforced in the database, not in application code.
6. **Invariants live where they cannot be bypassed.** If a rule matters, it is a constraint or a policy the data layer enforces — never a convention a client is trusted to respect.

## 3.2 The stack — concrete decision

**Verified September 2026:** PostgreSQL 18 current (18.3) · Bun 1.4 released August 2026, Node 26.3-compatible, ships `Bun.sql` · Node.js 24 and 26 Active LTS · **Cloudflare Containers GA since April 2026** (up to 4 vCPU / 12 GiB) · oxfmt beta February 2026.

**Do not hardcode package versions when building.** Install latest at scaffold time, commit the lockfile, and let Renovate raise upgrades. Version numbers written into a specification are stale within a month; a lockfile is not.

### 3.2.1 The Cloudflare question, resolved

The team runs Cloudflare. The constraint is **stay on Cloudflare**, and that is satisfiable — but not by putting the ledger API in a Worker.

**Why not a plain Worker.** Cloudflare's own Hyperdrive documentation is explicit: it pools in **transaction mode**; `SET` "supports … for the duration of a transaction or a query" and is reset when the connection returns to the pool; each Worker invocation "may obtain multiple connections"; and it warns directly against wrapping multiple operations in one transaction because "the connection cannot be reused by other Worker isolates."

Every one of those collides with a hard requirement here:
- Debits-equal-credits is a `DEFERRABLE INITIALLY DEFERRED` constraint checked at COMMIT across many statements (LEGACY-003).
- Document numbering needs a transaction-scoped advisory lock (LEGACY-051).
- RLS needs `set_config('app.tenant_id', …, true)` held for the transaction (LEGACY-035).
- Cost-layer replay after a back-dated invoice runs for minutes (LEGACY-005), as do month-end close, tax returns and the migration import.

**The resolution: Cloudflare Containers.** GA since April 2026, up to 4 vCPU and 12 GiB — a long-lived process holding real Postgres connections. Workers stay in front for routing, auth pre-checks, rate limiting and serving the electron-builder update feed from R2; anything touching the ledger is forwarded to the container.

```
Electron app (back office or POS)
        │
        ▼
  Cloudflare Worker ── auth pre-check, rate limit, serves the electron-builder update feed from R2
        │  (ledger traffic forwarded)
        ▼
  Cloudflare Container ── Bun + Hono API  +  pg-boss workers
        │                 long-lived connections, real transactions
        ▼
  PostgreSQL 18 (Supabase, Singapore)
```

**Second rule, unchanged:** do not expose PostgREST / `supabase-js` directly to any client for financial writes. RLS is right for tenant *isolation* but cannot express "this balances, the period is open, and this actor may approve at this level." Direct table access from a client is how the old system's invariants were bypassed.

### 3.2.2 Recommended stack

| Layer | Choice | Why this one |
|---|---|---|
| **Language** | **TypeScript**, everywhere | One language across API, workers, back office and POS. |
| **Runtime** | **Bun 1.4** | Runs the API, workers and build (tests: see the Testing row). Node 26.3 compatibility as of August 2026, native `Bun.sql` Postgres client, and already the team's tooling runtime. Keep the API runtime-agnostic so **Node 24 LTS** remains a drop-in fallback if a library misbehaves. |
| **Database** | **PostgreSQL 18** | Exact `numeric`, `DEFERRABLE` constraints, RLS, `MERGE` (fixes LEGACY-002/049), advisory locks, period partitioning, `SERIALIZABLE`, logical replication. |
| **Managed by** | **Supabase** (Postgres + Auth), Singapore | Known to the team; PITR on paid tiers. Used as a database and auth provider, **not** as a backend. |
| **API framework** | **Hono** | Already in use; runs on Bun, Node and Workers alike, which keeps the container/edge split cheap. |
| **Validation + contract** | **Zod** + `@hono/zod-openapi` | One schema → runtime validation, types, and the OpenAPI document the POS consumes. |
| **Data access** | **Drizzle ORM** + `postgres.js` | SQL-first, trivially droppable to raw SQL for posting and costing. `postgres.js` runs on both Bun and Node, keeping the fallback real; `Bun.sql` is the same API if you switch later. |
| **Migrations** | **Drizzle Kit** + hand-written `down.sql`, expand/contract | Forward-only in production, one monotonic version, online (fixes LEGACY-080). Never DDL from application code (LEGACY-053). *pgroll is an ADR the agent may raise if expand/contract by hand proves painful — not a v1 dependency.* |
| **Job queue** | **pg-boss** | Postgres-backed, so a job is **enqueued in the same transaction as the posting** — the guarantee LEGACY-005 lacked. Verify it runs clean on Bun during Phase 0; it is plain JS over `pg`, so this should be routine. |
| **Money** | `numeric(19,4)` in Postgres; **decimal.js** behind a `Money` type | Never floats — LEGACY-008 produced a unit cost of 500,020.00 from a rounding residue in `double precision`. |
| **Desktop shell** | **Electron** + **electron-builder** | Both apps. Bundles its own Chromium, so **every shop PC renders identically** — Tauri would depend on whichever WebView2 each machine has, which is the wrong risk to take on unknown hardware. All TypeScript, no Rust in the build. Cost: ~120 MB per app, ~150 MB RAM idle. Revisit Tauri only if that footprint hurts on real hardware; the React code is identical either way. |
| **Frontend** | **React 19 + Vite**, **TanStack Router / Query / Table / Virtual**, React Hook Form + Zod, Tailwind (logical properties) + shadcn/ui | Router gives type-safe routes and search-param state — an accountant filters a ledger and wants that exact view back from a bookmark. Table + Virtual give the dense keyboard-driven grids. |
| **i18n** | **i18next** + ICU; `Intl` with `islamic-umalqura` | Arabic and English at parity, both directions (LEGACY-085). |
| **PDF / documents** | **Decide in week one** — Typst or a shaping-aware library | ⚠️ **Largest technical risk in reporting: Arabic RTL glyph shaping.** Prove it with a real tax invoice before Phase 6. |
| **Spreadsheets** | ExcelJS | |
| **Testing** | **Vitest** (run under Node 24 in CI — Vitest on Bun is unofficial) + **fast-check** + **Testcontainers** + **Playwright** | Concurrency defects (LEGACY-049/051/052) need real interleaved transactions; mocks will not find them. |
| **Lint / format** | **oxlint** + **oxfmt** | Oxc's Rust toolchain — fast on a monorepo, first-class in Turborepo and Nx. ⚠️ oxfmt was beta in Feb 2026; confirm it has reached stable, though formatter churn is low-risk. |
| **Monorepo / CI** | Turborepo + GitHub Actions | Back office, POS, API and shared domain in one repo. |
| **Compute** | **Cloudflare Containers** (API + workers), **Workers** at the edge | §3.2.1. |
| **Object storage** | **Cloudflare R2** | Attachments by opaque server-generated ids, never client paths (LEGACY-038). |
| **Observability** | OpenTelemetry + Sentry | Plus the ledger-integrity SLI (§4.9). |

### 3.2.3 What this preserves and what it costs

The team keeps **Bun, Hono, React, Vite, Supabase, R2, Cloudflare and TypeScript**. Three things are genuinely new:

1. **A container rather than a Worker** for anything touching the ledger — same Cloudflare account, different compute primitive.
2. **pg-boss** — transactional job enqueueing.
3. **Drizzle** in place of direct `supabase-js` access.

Electron is a day's learning; it is Node plus a window.

**Deliberately not used:** Prisma (query engine and weak raw-SQL/transaction story, wrong for a ledger) · Tauri (system WebView variance across shop PCs, Rust in the build) · Redis + BullMQ (more infrastructure for throughput you do not have, and it loses transactional enqueue) · Biome (superseded here by oxlint/oxfmt) · microservices (a modular monolith plus a worker process is the correct shape for this domain and team size — split a service out when a boundary demands it, never on principle).

### 3.2.4 Container topology

Cloudflare Containers are addressed through Durable Objects and **sleep after inactivity**. That shapes the deployment:

- **Two container classes from one image**, different entrypoints: `api` and `worker` (§5.2).
- **`api`**: one instance per environment for v1 (a singleton DO id — `"api"`), `sleepAfter: "10m"`. The edge Worker reaches it through the container binding (`getContainer(env.API, "api")`) — **the container has no public ingress**; that is the answer to "how does the Worker authenticate to the Container". The container still **re-verifies every JWT itself**; the Worker's check is a pre-filter, not a trust boundary.
- **`worker`**: must not sleep while jobs are pending. Keep it awake with a **Cloudflare Cron Trigger** every minute that pings the `worker` container (`sleepAfter` set long); the pg-boss poller runs inside it. The nightly integrity job and month-end close are pg-boss scheduled jobs, so they inherit this.
- **Postgres connections** from both classes: session mode / direct (§3.8 header). One small pool per instance.
- **Scaling later**: shard `api` by tenant id when a second tenant arrives — the DO id becomes the tenant id, which also gives per-tenant isolation of noisy neighbours for free.

## 3.3 Core domain model

```
Tenant
 └─ Company (was: Site) ── FiscalPeriod (open | closed | locked)
     ├─ ChartOfAccounts ── Account (tree; AccountType enum; currency; control-account role)
     ├─ Party (customer | vendor | employee | student | dealer)      ← replaces 20 Is* flags on Accounts
     │    └─ Employee (party kind employee; optional principal; home BRANCH)   ← §3.10
     │         ├─ EmployeeSensitive (encrypted, permission-gated) · EmployeeStatutoryProfile (effective-dated)
     │         ├─ CompensationLine (effective-dated) ── PayComponent (earning | deduction → GL account, schemes)
     │         ├─ AttendanceEvent (from POS clock-in; never an automatic pay input) · LeaveRecord ⚠️ only if the owner confirms
     │         └─ EmployeeYtd (projection, rebuildable) · EmployeeYtdOpening (cut-over)
     ├─ Dimension (CostCentre | Project | Department | Location | Region | SubAccount)
     │     generic dimension_type / dimension_value — a new dimension needs no schema change
     ├─ Currency ── ExchangeRate(effective_from, source) + RoundingPolicy(context)
     ├─ Item (product | service | asset)
     │    ├─ UnitOfMeasure + exact-rational conversions
     │    ├─ PriceList ── PriceListLine
     │    ├─ Lot / SerialUnit / Variant          ← SerialUnit is a ROW, unique, not a range
     │    └─ BillOfMaterials
     ├─ Warehouse (tree) ── StockBalance (projection)
     │
     ├─ DocumentType ── PostingPolicy(version)   ← the Muniment idea, done right
     │     JOURNAL · SALES_ORDER · DELIVERY_ORDER · SALES_INVOICE · RECEIPT · PURCHASE_ORDER · SHIPMENT · GOODS_RECEIPT · PURCHASE_INVOICE
     │     · PAYMENT · TRANSFER · STOCK_COUNT · POS_TICKET · PAYROLL · PAYROLL_PAYMENT · EMPLOYEE_ADVANCE … (all configuration, no code)
     │     draft → submitted → approved → issued → posted → (reversed); the one backward edge submitted|approved → draft (recalculation)
     ├─ Document (header) ── DocumentLine
     │    draft → submitted → approved → issued → posted → (reversed)
     │    ├─ CustomFieldValue                     ← the Descriptors idea, typed and indexed
     │    └─ Attachment (object storage, opaque id)
     │
     ├─ LedgerEntry  ── IMMUTABLE. The only financial truth.
     │    (document_id, line_no, account, dimensions[], debit, credit,
     │     currency, rate, rate_source, base_debit, base_credit,
     │     posted_at, posted_by, policy_version, period_id)
     ├─ InventoryMovement ── IMMUTABLE ── CostLayer + CostConsumption (derived, rebuildable)
     ├─ TaxTransaction ── TaxReturn (pluggable jurisdiction packs)
     ├─ StatutoryScheme ── StatutoryRateTable(version, effective_from, source, verified_by)   ← payroll rules as data (§3.10)
     └─ DocumentEvent ── IMMUTABLE ── every status transition with its actor (maker ≠ checker is read from here — §4.2.2)
```

**Projections** — derived from the ledger, never hand-edited. **Synchronous ones** (`account_balance`, `stock_on_hand`) are updated by the posting service in the same transaction via `MERGE` on the full key (the correct upsert LEGACY-002/049 lacked), so a trial balance is exact the instant a document posts. **Asynchronous ones** (`party_ageing`, `item_profitability`, `stock_valuation` history) are pg-boss jobs. **All of them** are rebuilt from `ledger_entry`/`inventory_movement` into scratch tables nightly and compared row for row; a mismatch is an incident.

**Keys:** `uuidv7()` primary keys everywhere (§3.9). **Never reuse an identifier; never rewind a sequence** (LEGACY-021).

## 3.4 Costing — the specific design

The single largest source of wrong numbers in the old system. Build it this way:

**Movements are immutable; cost layers are derived.** `inventory_movement` is append-only like the ledger. `cost_layer` and `cost_consumption` are *derived* tables — rebuildable from movements, and rebuilt forward from any invalidation point. `qty_remaining` on a layer is mutable precisely because it is derived state. Derived tables are **audit-exempt** (§3.8 linter rules) — auditing them would serialise every recost behind the per-tenant audit lock for nothing; the movements they derive from are the record.

**v1 costing method: weighted average (AVCO)**, matching the old system and the business's expectations. ⚠️ *Owner to confirm.* FIFO is supported by the same layer model (issues consume oldest layers first; AVCO issues at the running average and consumes proportionally) and can be enabled per company later without a schema change.

For each inventory receipt write a **cost layer**:
```
cost_layer(id, item, warehouse, lot, movement_id,
           qty_in, unit_cost, qty_remaining,
           effective_at, sequence)
```
- Issues consume layers per the company's method and **record exactly what they consumed** in `cost_consumption` (FIFO: specific layers; AVCO: a proportional slice of all open layers at the running average).
- A back-dated document invalidates only layers at or after its `sequence`; a background job replays **from that point forward**, not from the beginning of time.
- The replay writes an **adjustment entry**, never silently rewriting posted history.
- The chronological key is explicit and total: `(effective_date, document_sequence, line_number)` — never dependent on an index definition (LEGACY-067).
- Value is mandatory and non-null on every movement; a movement without value is rejected at write time (LEGACY-007).
- Negative computed cost is a hard error. Divisor is clamped to a minimum meaningful quantity (LEGACY-008).
- **One implementation.** Reporting, valuation and posting all call it (LEGACY-009).

## 3.5 Ideas to carry forward from the legacy system

These are genuinely good and should survive the rewrite:

- **The document-type engine** — but as versioned policy objects, not flags.
- **Custom fields (`Descriptors`)** as a core service: typed, attachable per document type, indexed, validated.
- **Analysis dimensions on every line** — generalised so a new dimension needs no schema change.
- **Per-context rounding policies** and currency sub-units — but actually applied (LEGACY-019).
- **Period locking** with before/after semantics and approval levels — but uniform, not per-tier.
- **Offline POS with parcel-based sync.**
- **An end-user report designer** — text-defined, diffable, version-controlled.
- **Feature gating** (`Futures`) → per-tenant plan entitlements.
- **Country seed-data packs** (chart of accounts, document types, tax codes) — the Syria/Lebanon/Simple pattern is exactly right; extend it.

## 3.6 Explicitly do NOT carry over

Node-locked dongle licensing · UDF-dependent SQL · hardcoded query plans · dynamic SQL string building · permission blobs · plaintext credentials · composite `Site+ID` keys · flag-column behaviour · the `procFix*` repair family (make it structurally unnecessary) · Delphi-serialised report files · customer-specific tables in the core schema · raw hardware port I/O.

---

## 3.7 Deployment shape: back office + shop POS + sync

**Confirmed scope decision:** Windows is the only target platform for now. Physical POS hardware is **not in v1**. A **separate POS application is installed at each shop** and syncs with the main system.

This is deliberately close to the old system's shape (back office + `PointOfSale.exe` + `SyncService.exe` + the `mpos` schema + parcels) — that part of the legacy system's architecture was sound and should be kept. What changes is the sync *mechanics*, which is where the old one is weak.

### 3.7.1 Two applications, one codebase

```
┌─────────────────────────────────────────┐        ┌──────────────────────────────┐
│  MAIN SYSTEM (back office)              │        │  SHOP POS  (one per shop)    │
│  React 19 + Vite in an Electron shell   │        │  Same React codebase, same   │
│  Bun + Hono API + pg-boss workers       │◄──────►│  Electron shell              │
│  in a Cloudflare Container              │  sync  │  Local SQLite (better-sqlite3)│
│  PostgreSQL 18 (Supabase, Singapore)    │  API   │  Sells offline               │
└─────────────────────────────────────────┘        └──────────────────────────────┘
```

Both are TypeScript + React. The POS reuses the component library, the money type, the i18n catalogue and the domain types. **Only the data layer differs** — the POS reads and writes local SQLite and talks to the sync API; the back office talks to Postgres through the API.

### 3.7.2 Packaging for Windows — Electron for both apps, from day one

**Decision (§0.3):** both the back office and the POS ship as **Electron** applications built with **electron-builder**. Not a PWA, not Tauri.

| Concern | How Electron handles it |
|---|---|
| Install experience | A real Windows installer (`.exe`/`.msi`), Start-menu icon, own window, no browser visible. Matches what users of the old desktop product expect. |
| Rendering consistency | Electron **bundles its own Chromium**, so every shop PC renders identically. Tauri would depend on whichever WebView2 each machine happens to have — the wrong risk on hardware you do not control. |
| Local data (POS) | **`better-sqlite3`** in the Electron main process — native SQLite, synchronous, fast, transactional. No OPFS or IndexedDB workarounds. |
| Auto-update | electron-builder's updater against a signed release feed. Every till updates itself; nobody visits the shop with a USB stick. **Code-sign from the first release** — unsigned Electron apps trip SmartScreen on every install. |
| Printing in v1 | `webContents.print()` through any **Windows printer driver** — so receipt and invoice printing works in v1 with zero hardware code. ESC/POS, cash drawers and scanners arrive in v2 via Node serial/USB libraries in the main process. |
| Footprint | ~120 MB per app on disk, ~150 MB RAM at idle. The price of bundled Chromium. Revisit Tauri only if this measurably hurts on real shop hardware — the React code is identical either way, so the door stays open. |
| Toolchain | All TypeScript. No Rust in the build. |

**Security posture for Electron** — these are not optional: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderers; a strict Content-Security-Policy; all privileged operations (SQLite, printing, sync) behind a **typed `contextBridge` API**, never raw Node in the renderer; renderer navigation locked to the app's own origin.

### 3.7.3 Sync protocol — the part that must be got right

The old system's parcel model is kept in spirit. The mechanics are redesigned so that the failures in Part I are impossible.

**The governing rule: the two directions own disjoint data, so there are no merge conflicts by construction.**
- **Back office owns the catalogue** — products, barcodes, prices, promotions, tax codes, customers, users. Flows *down* only.
- **The till owns the sales it made.** Flows *up* only. The back office never edits a till's transaction; it posts it to the ledger.

**Down-sync (catalogue → shop).** Pull-based and cursor-driven:
```
GET /v1/sync/catalogue?since=<cursor>&limit=1000
→ { changes: [...], next_cursor, has_more }
```
Every catalogue row carries a monotonic `revision`. **It must be assigned in commit order, not sequence order** — a plain sequence hands out 100 to a transaction that commits *after* a client has already read through 105, and that row is never seen. So the catalogue-write trigger takes `pg_advisory_xact_lock(hashtextextended('catalogue:' || tenant_id::text, 0))` before taking the next value, which serialises catalogue writes per tenant (low volume; acceptable) and makes cursor reads safe. Never a timestamp — clocks drift. The till stores its cursor and asks for everything after it. Interrupted transfers resume from the cursor; nothing is lost and nothing is re-applied twice. Deletions travel as tombstones, never as silent absence.

**Up-sync (sales → back office).** Push-based, batched, and idempotent:
- Every ticket gets a **uuidv7 generated at the till**, at the moment of sale — never a server-assigned id, never a shared counter. This is the fix for LEGACY-051's numbering race, and it means the till can sell for days with no network.
- Sales are written to a local **outbox** table *in the same local transaction as the sale*. A background loop drains the outbox. A sale can never be committed locally but lost in transit.
- The server applies a batch in one transaction with **a savepoint per ticket**: a bad ticket rolls back to its savepoint and is reported; the good tickets in the same batch still commit. Deduplication is on `client_ref`. **Re-sending a batch is harmless** — this is what makes retry safe on a flaky shop connection.
- The server responds with per-ticket accept/reject. Rejected tickets stay in the outbox with the reason attached and surface in a shop-level "needs attention" queue — never silently dropped.
- Only after a ticket is acknowledged does the till mark it synced.

**Stock.** The till holds an *advisory* stock figure for display and low-stock warnings. **It is never the source of truth.** Authoritative stock lives in the back office, computed from the movement ledger. A till that has been offline shows a stale figure and says so; it does not block a sale on a number it cannot trust. (The old system's negative-stock controls were per-user, opt-in, and bypassable four ways — LEGACY-048.)

**Serial-numbered goods** — *only if serials enter scope; §3.0.3 expects they will not for a food distributor* — are the one exception that needs care: a till cannot safely allocate a unique serial while offline. Either reserve serial blocks per till in advance, or restrict serialised sales to online mode. Decide this per product category, and make it explicit.

**What each shop syncs is scoped.** A shop pulls only its own price list, its own warehouse, its own promotions. This is branch-level scoping *within* one tenant — an RBAC/dimension concern (§4.2, §3.7.6), not tenancy.

### 3.7.4 The POS is built in-house — confirmed

**Decision: the POS application is built as part of Dulja, not integrated from a third party.** It is a first-class deliverable, sharing the codebase, domain model, money type, i18n catalogue and component library with the back office.

One discipline to keep anyway: **design the sync API as though an external client would use it** — versioned, authenticated, OpenAPI-documented, idempotent, with tombstones and an explicit reconciliation report. Two reasons. First, it forces the protocol to be correct rather than relying on both ends being written by the same person and quietly sharing assumptions — which is precisely how the old system ended up with sync logic nothing could verify. Second, it is the cheapest possible path to later integrating a customer's existing POS, a franchise partner's till, or an e-commerce front end, none of which need to be decided now.

### 3.7.5 POS local model and terminal identity

**Terminal identity.** `app.pos_terminal` (§3.8) — each terminal owns an `app.principal` of kind `terminal`, so it has a real audit identity and can be the `posted_by` of the tickets it syncs. Enrolment: an admin generates a one-time enrolment code in the back office; the till redeems it once, generating a keypair in Electron `safeStorage` and registering the public key. Thereafter every `/v1/sync/*` call is signed by the terminal key and exchanged for a short-lived terminal JWT signed by the API's own key (a secret listed in §4.11). Revoking a terminal (`revoked_at`) needs no user change.

**Cashier identity offline.** A cashier is a **human principal** whose till credential lives in `app.pos_cashier` (Phase 6): the PIN hash (Argon2id, per-cashier salt), the branch, and the permission codes and limits the till needs — a **projection**, regenerated by the catalogue-revision trigger whenever a `role_assignment`, `role_assignment_branch` or `role_permission` row affecting that principal changes (and on termination), compared nightly against `actor_has()` like every other projection (D14), never edited by hand. Limits live in a relational `branch_pos_policy(tenant_id, company_id, branch_id, max_line_discount_pct, max_ticket_discount_pct, max_void_amount, …)` row per branch (§4.1: never a blob), maintained under `admin.company.manage`; sync apply re-verifies against that row, never against the snapshot. That row is down-synced only to the terminals of its branch, so a cashier can sign in with no network. Every cashier has a real Supabase auth user — created through the admin API at hire even when the person never opens the back office (random undisclosed password; an alias address on a tenant domain the owner supplies when there is no mailbox) — so `auth_subject` is always a Supabase `sub` and the §4.2 rule that a principal is created only from a Supabase-obtained `sub` holds for cashiers too. The PIN is a till credential, never a login, and is the only credential the application hashes (LEGACY-025, 026, 028). `pos_cashier.employee_id` references the HR employee row (§3.10.2): **cashiers are employees**, and setting `employee.terminated_on` revokes the credential and expires every role assignment **by trigger, not by handler** — an AFTER UPDATE OF `terminated_on` trigger on `employee` sets `pos_cashier.revoked_at` and `role_assignment.expires_at`, and bumps the catalogue revision (tombstone), so a direct `app_rw` update or the Phase 9 importer cannot leave a live credential behind. Each ticket carries the cashier's principal id, which the back office stores as `document.attributed_to` — **data about the document, shown as attribution**. The *acting* principal for the posting (`created_by`/`posted_by`) is the **terminal**, resolved from the terminal's signed sync call, never from the payload (LEGACY-044). **Sync apply re-verifies** the attributed cashier's authority and any supervisor override (`pos.ticket.override` by a *different* principal, recorded as a `document_event` **attributed to** the supervisor and **acted by** the terminal — `document_event.attributed_to`, never a payload-supplied `actor_id`, LEGACY-044) against the server's current assignments; a ticket that fails goes to the shop's needs-attention queue, never silently into the ledger (LEGACY-027, LEGACY-048).

**Local SQLite schema (mirrors the wire contract in `packages/sync`):**
```
catalogue_item, catalogue_price, catalogue_customer, catalogue_tax_code, catalogue_promotion, catalogue_cashier
    — read-only mirrors, each row stamped with the revision it arrived at
sync_cursor(stream, revision)                 — one row per down-sync stream
shift(id, opened_by, opened_at, opening_float, closed_at, counted_cash, expected_cash, over_short)
ticket(id uuidv7, shift_id, cashier_principal_id, customer_id, status, currency, totals…, created_at)
ticket_line(ticket_id, line_no, item_id, qty, unit, unit_price, discount, tax_code, tax_amount, total)
ticket_tender(ticket_id, tender_no, method, amount, reference)
outbox(id, ticket_id, payload jsonb, attempts, last_error, acked_at)   — written in the same SQLite transaction as the ticket
```
A ticket and its outbox row are one local transaction; the drain loop marks `acked_at` only on server acknowledgement. Nothing in the local database is authoritative except the tickets the till itself created.

### 3.7.6 POS scope

Derived from what the old system's POS actually did (69 tables across `mposStandard` and `mposSystem`), reduced to what a trading and retail business needs. Restaurant-specific features (floor plans, tables, kitchen modifiers, meal courses) are **excluded unless the business confirms it needs them** — they are roughly a third of the old POS schema and serve a different industry.

**In scope for the POS v1**

| Area | Detail |
|---|---|
| Selling | Ticket + lines, barcode scan or search-by-name, quantity/unit change, line and ticket discount, price override within a permitted limit |
| Pricing | Price list per shop, promotions and offers with date windows, customer-specific pricing; loyalty points accrual ⚠️ *owner to confirm — §3.0.3 lists loyalty as probably not v1* |
| Payment | Multi-tender on one ticket (cash, card, transfer, store credit), change calculation, rounding per the currency's POS rounding rule |
| Returns | Return against an original ticket (looked up locally or via sync), and blind return where policy allows |
| Customers | Lookup, quick-create, account sales for credit customers within their credit limit |
| Shift | Open/close with declared opening float, cash count at close, over/short recorded as a posted difference, Z-report |
| Staff | PIN login per cashier (`pos_cashier`), clock-in/out recorded as `attendance_event` for HR (§3.10), per-cashier sales attribution; supervisor overrides by a second principal's PIN, recorded as a `document_event` |
| Cash control ⚠️ | Paid-outs for small branch expenses from the till (posted to expense with BRANCH), safe drops during a shift, daily banking as cash-in-transit cleared by bank reconciliation; no-sale, void and drawer-open events on the ticket stream. *Confirm with the owner (§3.0.4).* |
| Offline | Full selling capability with no network; outbox drains on reconnect; a visible, honest indicator of sync state and last-catalogue-update time |
| Price check | A read-only lookup mode (the old system shipped this as a separate `PriceChecker.exe`; here it is a mode of the same app) |

**Explicitly out of scope for v1:** POS-specific hardware (ESC/POS printers, cash drawers, barcode scanners, scales — §3.7.2 notes how they arrive in v2), restaurant table service, kitchen display, and weighing-scale integration. Receipts and invoices in v1 print through **ordinary Windows printer drivers** via Electron, which needs no hardware code and covers most shops.

**Posting rule.** A POS ticket is a `Document` of a POS document type, and posts to the ledger through **exactly the same posting service** as a back-office invoice — same policy objects, same validation, same cost layers. It is not a parallel path. The old system's biggest structural error in this area was giving the POS its own 69-table schema that mirrored the core; that duplication is what made the two disagree. Here the POS has a *local cache* for offline operation, not a *second model*.

## 3.8 Reference schema for Phases 0–1

This is the **shape and the enforcement pattern**, written so the first migration can be derived from it directly. It is not the whole schema — it is the core that every later table copies. Every Part I defect it closes is noted inline. PostgreSQL 18 syntax; `uuidv7()` is built in.

**Roles and connections (provisioning, not migration — task 0.2).** Three database roles: `app_migrator` (owner of schema `app`; used only by Drizzle Kit in CI and by the seed CLI; subject to `FORCE ROW LEVEL SECURITY` like every other role), `app_rw` (the API and workers; **no `BYPASSRLS`**, no `UPDATE`/`DELETE` on immutable tables), and `app_auth` (`NOLOGIN`, **no role attributes**; owns exactly one object — the `resolve_principal` function below — and reads `principal` and `membership` through role-scoped RLS policies rather than `BYPASSRLS`, which only a superuser can grant and Supabase's `postgres` role cannot; it is granted to `app_migrator` only so the migration can transfer that ownership; nothing ever connects as it). The container connects with **session-mode pooling or a direct connection (Supabase port 5432)** — never the transaction-mode pooler (6543), for the same reasons §3.2.1 rejects Hyperdrive. `app_rw` has `timezone = 'UTC'` set at the role level.

**Transactions.** Every database access, reads included, runs inside `withTenant(tx => …)`, which opens the transaction at **READ COMMITTED** (the audit chain below depends on it — see the note there), issues the two `set_config` calls first, and **retries once on `40P01` (deadlock) or `40001` (serialisation)** — safe because every unsafe API call is idempotent by key. A lint rule forbids bare `db.` calls. Without `withTenant`, `set_config(…, true)` is never set, `app.current_tenant()` is NULL, and RLS silently returns nothing. **Long jobs** (costing replay, sync apply, month-end) run as many short transactions, never one long one — the per-tenant audit lock is held to commit.

**Linter rules (task 0.4), stated exactly:** every table in schema `app` except `tenant`, `principal`, `permission` (global catalogues with their own policies below) must carry `tenant_id`, RLS enabled and forced, and a `tenant_isolation` policy. Every table except pure join tables and counter tables (`membership`, `role_permission`, `role_assignment`, `role_assignment_branch`, `ledger_entry_dimension`, `document_series`, `document_number_void`, `idempotency_key`; plus `audit_log`, keyed by `seq`, and the `permission` catalogue) must have `id uuid` and `created_at`; `ledger_entry` is exempt from `created_at` only — its timestamp is `posted_at`, set by the posting service and never updated. Every permissive RLS policy on a table in schema `app` is either the standard tenant policy (`tenant_isolation`, `tenant_self`, `principal_*`) or is scoped to `app_auth`; **every policy that adds a permission or branch gate is `AS RESTRICTIVE`** — permissive policies OR together, so a permissive gate would be voided by `tenant_isolation` (LEGACY-033). Every column named `*_by` (and `document_event.actor_id`) carries the `stamp_actor` trigger. Every FK to a tenant-scoped parent must be the composite `(tenant_id, <parent>_id)` form (see `ledger_entry.account_id` — the reason is under it). Every table is audited except the immutable ones and the derived ones (`ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `document_event`, `audit_log`, `account_balance`, `cost_layer`, `cost_consumption`, `employee_ytd`, `idempotency_key`) and the seeded `permission` catalogue; `tenant` and `principal`, which have no `tenant_id`, take the generator's global-table variant of the audit trigger (stated under `audit_log` below). **Immutable** (`ledger_entry`, `ledger_entry_dimension`, `inventory_movement`, `document_event`, `audit_log`) and **audit-exempt** are two different lists: derived tables are exempt from auditing but must remain updatable by `app_rw`.

```sql
-- 0001_foundations.sql  ───────────────────────────────────────────────────────
create extension if not exists btree_gist;
create schema app;
grant usage on schema app to app_rw;

-- Identity comes from the API, set once per transaction, local to the transaction.
-- withTenant():  select set_config('app.tenant_id', $1, true),
--                       set_config('app.actor_id',  $2, true);
-- Nothing else can widen it (closes LEGACY-026, 027, 035).
create function app.current_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create function app.current_actor() returns uuid language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid $$;

create table app.tenant (
  id          uuid primary key default uuidv7(),
  name        text not null,
  created_at  timestamptz not null default now()
);
alter table app.tenant enable row level security;
alter table app.tenant force row level security;
create policy tenant_self on app.tenant using (id = app.current_tenant());   -- app_rw sees only its own tenant row

-- ── Principals: humans, the per-tenant system actor, and POS terminals ─────────
-- One table, one FK target for every actor_id/created_by/posted_by column. "A terminal is not a user"
-- is expressed as kind = 'terminal', not as a separate table with no audit identity.
create type app.principal_kind as enum ('human', 'system', 'terminal');
create table app.principal (
  id            uuid primary key default uuidv7(),
  kind          app.principal_kind not null,
  auth_subject  text not null unique,   -- human: Supabase JWT `sub` (every human, cashiers included — §3.7.5);
                                        -- system: 'system:<tenant_id>'; terminal: 'terminal:<terminal_id>'
  email         text,                   -- humans only
  display_name  text not null,
  created_at    timestamptz not null default now(),
  check ((kind = 'system'   and auth_subject like 'system:%')
      or (kind = 'terminal' and auth_subject like 'terminal:%')
      or (kind = 'human'    and auth_subject not like 'system:%' and auth_subject not like 'terminal:%'))   -- a prefix can never impersonate a kind
);
create table app.membership (             -- v1 rule enforced, not commented: one tenant per principal
  tenant_id     uuid not null references app.tenant(id),
  principal_id  uuid not null references app.principal(id) unique,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, principal_id)
);
alter table app.principal enable row level security;  alter table app.principal force row level security;
-- Read/update: a principal is visible only through a membership in the current tenant.
create policy principal_in_tenant on app.principal for select
  using (exists (select 1 from app.membership m where m.principal_id = id and m.tenant_id = app.current_tenant()));
create policy principal_update_in_tenant on app.principal for update
  using (exists (select 1 from app.membership m where m.principal_id = id and m.tenant_id = app.current_tenant()));
-- Insert MUST be a separate policy. With no WITH CHECK, Postgres reuses USING as the INSERT check — and a brand-new
-- principal has no membership yet (membership references principal), so nothing could ever be inserted (v1.1 fix #2).
-- The API and the seed CLI always insert principal + membership in ONE transaction, and the principal insert carries
-- NO RETURNING clause (RETURNING is checked against the SELECT policy, which needs the membership that does not exist
-- yet). A principal without a membership is unreachable through any policy above.
-- API constraint (task 0.6): a human principal is created ONLY from a `sub` the API itself obtained through the
-- Supabase admin invite/create-user call — never from a client-supplied subject. Otherwise tenant B could pre-register
-- tenant A's user (auth_subject is unique, membership.principal_id is unique) and resolve_principal would route that
-- person into B forever.
create policy principal_insert on app.principal for insert with check (app.current_tenant() is not null);
alter table app.membership enable row level security;  alter table app.membership force row level security;
create policy tenant_isolation on app.membership using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant());

-- Tenant resolution runs BEFORE the tenant is known, so it cannot go through the policies above.
-- One SECURITY DEFINER function is the only such door. It is read-only and returns exactly one row or none.
-- It is OWNED BY app_auth (NOLOGIN, no attributes) — NOT by app_migrator. app_migrator is subject to FORCE ROW
-- LEVEL SECURITY like everyone else, and with app.tenant_id unset every policy above evaluates to "no rows", so a
-- migrator-owned definer could never resolve anyone (v1.1 fix #3). app_auth is NOT given BYPASSRLS: only a superuser
-- can create a role with that attribute, and Supabase's `postgres` role is not one. Instead the two tables carry a
-- policy scoped TO app_auth. Inside the SECURITY DEFINER body current_user = app_auth, so those policies apply
-- there and nowhere else. app_auth owns nothing else, holds SELECT on exactly these two tables, and holds CREATE on schema app only for the duration of the ownership transfer.
-- JWT verification (Supabase JWKS) happens in the API before this is called; the Container re-verifies the JWT
-- itself — the edge Worker's check is a pre-filter, not a trust boundary.
grant usage on schema app to app_auth;
grant select on app.principal, app.membership to app_auth;
create policy principal_resolver  on app.principal  for select to app_auth using (true);   -- role-scoped: only the definer sees all rows
create policy membership_resolver on app.membership for select to app_auth using (true);
create function app.resolve_principal(p_auth_subject text)
returns table (principal_id uuid, tenant_id uuid, kind app.principal_kind)
language sql security definer set search_path = app, pg_temp stable as $$
  select p.id, m.tenant_id, p.kind
    from app.principal p join app.membership m on m.principal_id = p.id
   where p.auth_subject = p_auth_subject
$$;
revoke all on function app.resolve_principal(text) from public;    -- BEFORE the ownership transfer: the ACL is remapped to the new
grant execute on function app.resolve_principal(text) to app_rw;   -- owner; issued after it these two are silent no-ops (verified on PG 18)
grant create on schema app to app_auth;                            -- ALTER … OWNER TO requires the new owner to hold CREATE on the schema
alter function app.resolve_principal(text) owner to app_auth;      -- requires: grant app_auth to app_migrator (task 0.2)
revoke create on schema app from app_auth;                         -- ownership persists; app_auth is back to USAGE only
-- CI check (task 0.6): connected as app_rw with NO set_config, resolve_principal(<known subject>) returns one row
-- while `select * from app.principal` returns zero rows. Both must hold, or the door is either shut or too wide.

-- ── Template every tenant-scoped table follows ─────────────────────────────
create table app.company (
  id                      uuid primary key default uuidv7(),
  tenant_id               uuid not null references app.tenant(id),
  code                    text not null,
  name                    text not null,
  base_currency           char(3) not null,
  timezone                text not null default 'Asia/Kuala_Lumpur',
  fx_rounding_account_id  uuid,                 -- FK added after app.account exists (below)
  created_at              timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)                        -- lets children use the composite FK form
);
alter table app.company enable row level security;
alter table app.company force row level security;          -- applies to the table owner too
create policy tenant_isolation on app.company
  using      (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());          -- a write to another tenant is rejected here
-- (RLS enable/force/policy is repeated for EVERY tenant-scoped table below — the 0.4 linter enforces it;
--  it is elided from here on for length. Every parent also carries unique (tenant_id, id).)

create table app.role (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  code         text not null,                  -- 'admin', 'accountant', 'user', … — the nine system roles of §4.2.1
  name_en      text not null,
  name_ar      text,
  description  text,
  is_system    boolean not null default false, -- seeded roles: never renamed or archived; their permissions change only by migration
  created_at   timestamptz not null default now(),
  unique (tenant_id, code), unique (tenant_id, id)
);
-- Global catalogue, seeded from packages/contracts/permissions.ts; a code no handler checks fails the build (LEGACY-047).
-- `mutating` lets CI prove that a read-only role is read-only (§4.2.2 R7).
create table app.permission (
  code         text primary key,               -- '<module>.<resource>.<action>' (§4.2.1)
  module       text not null check (module in ('admin', 'accounting', 'inventory', 'hr', 'pos')),
  mutating     boolean not null,
  description  text not null,
  check (code like module || '.%' and code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$')   -- the catalogue cannot drift from its own scheme
);
grant select on app.permission to app_rw;
create table app.role_permission (
  tenant_id        uuid not null,
  role_id          uuid not null,
  permission_code  text not null references app.permission(code),
  primary key (role_id, permission_code),
  foreign key (tenant_id, role_id) references app.role(tenant_id, id)
);
create table app.role_assignment (            -- a join table (no id/created_at — linter rule); scope = (principal, role, company)
  tenant_id     uuid not null references app.tenant(id),
  principal_id  uuid not null references app.principal(id),
  role_id       uuid not null,
  company_id    uuid not null,
  granted_by    uuid not null default app.current_actor() references app.principal(id),
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,                   -- NULL = open-ended; an expired assignment grants nothing (time-boxed auditors)
  primary key (principal_id, role_id, company_id),
  unique (tenant_id, principal_id, role_id, company_id),   -- lets the branch child use the composite FK form
  foreign key (tenant_id, role_id)    references app.role(tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
-- Branch scope (§4.2.1): rows restrict the assignment to a set of BRANCH dimension values; NO rows = every branch of the company.
create table app.role_assignment_branch (
  tenant_id     uuid not null,
  principal_id  uuid not null,
  role_id       uuid not null,
  company_id    uuid not null,
  branch_id     uuid not null,
  primary key (principal_id, role_id, company_id, branch_id),
  foreign key (tenant_id, principal_id, role_id, company_id)
    references app.role_assignment(tenant_id, principal_id, role_id, company_id) on delete cascade
  -- foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id) is added once that table exists (below)
);
-- THE authorisation predicate (§4.2.1): one function, security invoker, stable — used by every handler, by RLS policies on
-- sensitive tables (§3.10) and by triggers. Semantics (never fail open — LEGACY-042, LEGACY-050):
--   p_branch_id NULL  = "company-wide authority": granted only by an unexpired assignment with NO branch rows;
--   p_branch_id set   = granted by a company-wide assignment or by one whose branch rows include that branch;
--   the tenant's SYSTEM principal (server-side jobs and the seed CLI only, never a request path — RC-1) always passes, so a
--   payroll calculation, a YTD rebuild or a key-rotation job never silently processes zero rows behind an RLS gate.
create function app.actor_has(p_code text, p_company_id uuid, p_branch_id uuid default null) returns boolean
language sql stable as $$
  select exists (
    select 1 from app.principal p join app.membership m on m.principal_id = p.id
     where p.id = app.current_actor() and p.kind = 'system' and m.tenant_id = app.current_tenant())
  or exists (
    select 1
      from app.role_assignment ra
      join app.role_permission rp on rp.role_id = ra.role_id
     where ra.principal_id = app.current_actor()
       and ra.company_id   = p_company_id
       and rp.permission_code = p_code
       and (ra.expires_at is null or ra.expires_at > now())
       and (not exists (select 1 from app.role_assignment_branch b
                         where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id)
            or (p_branch_id is not null and exists (
                  select 1 from app.role_assignment_branch b
                   where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
                     and b.branch_id = p_branch_id))))
$$;
-- Branch isolation (§4.2.1, Phase 6 onward, when branch-scoped roles first exist): every table with a branch_id column carries
-- `create policy branch_isolation on <t> as restrictive using (app.actor_in_branch(company_id, branch_id))`, where actor_in_branch
-- is true for the system principal, for any unexpired company-wide assignment in that company, and for any branch row matching
-- branch_id. RESTRICTIVE, because permissive policies OR together and a permissive gate would be voided by tenant_isolation.
-- No self-grant, no self-escalation (§4.2.2 R5; LEGACY-032): an actor may not change their own assignments, nor the permissions
-- of a role they currently hold. The seed runs as the system principal, so the owner's first assignment passes.
create function app.forbid_self_grant() returns trigger language plpgsql as $$
begin
  -- Nested IFs, not `tg_table_name = … and new.principal_id …`: PL/pgSQL compiles the whole IF expression against the firing
  -- table's row type, so a reference to new.principal_id fails on role_permission even when the guard is false (verified on PG 18).
  if tg_table_name in ('role_assignment', 'role_assignment_branch') then
    if coalesce(new.principal_id, old.principal_id) = app.current_actor() then
      raise exception 'ERR_RBAC_SELF_GRANT: a principal cannot change their own role assignments' using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'role_permission' then
    if exists (select 1 from app.role_assignment ra
                where ra.role_id = coalesce(new.role_id, old.role_id) and ra.principal_id = app.current_actor()
                  and (ra.expires_at is null or ra.expires_at > now())) then          -- "currently hold": an expired assignment no longer binds
      raise exception 'ERR_RBAC_SELF_ESCALATION: a principal cannot change the permissions of a role they hold' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger role_assignment_no_self_grant        before insert or update or delete on app.role_assignment        for each row execute function app.forbid_self_grant();
create trigger role_assignment_branch_no_self_grant before insert or update or delete on app.role_assignment_branch for each row execute function app.forbid_self_grant();
create trigger role_permission_no_self_escalation   before insert or update or delete on app.role_permission        for each row execute function app.forbid_self_grant();
-- Kind discipline (§4.2.2 R8): a terminal holds only pos_terminal; pos_terminal is held only by a terminal; the system principal holds nothing.
create function app.assert_assignment_kind() returns trigger language plpgsql as $$
declare v_kind app.principal_kind; v_code text;
begin
  select kind into v_kind from app.principal where id = new.principal_id;
  select code into v_code from app.role      where id = new.role_id;
  if v_kind = 'system' then
    raise exception 'ERR_RBAC_KIND: the system principal holds no role' using errcode = 'check_violation';
  elsif (v_kind = 'terminal') <> (v_code = 'pos_terminal') then
    raise exception 'ERR_RBAC_KIND: role % cannot be assigned to a principal of kind %', v_code, v_kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger role_assignment_kind before insert or update on app.role_assignment for each row execute function app.assert_assignment_kind();
-- Last-admin guard (§4.2.2 R5): a change may not leave the tenant with no unexpired holder of admin.user.manage. Two functions,
-- one per table — PL/pgSQL compiles every column reference against the firing table's row type — and each acts ONLY when the
-- OLD row currently grants an unexpired admin and the change removes or expires it (a tenant that has no admin yet is untouched).
create function app.keep_last_admin_assignment() returns trigger language plpgsql as $$
declare removing boolean;
begin
  if tg_op = 'DELETE' then removing := true;
  else removing := (new.expires_at is not null and new.expires_at <= now()) or new.role_id <> old.role_id or new.principal_id <> old.principal_id;
  end if;
  if removing and (old.expires_at is null or old.expires_at > now())
     and exists (select 1 from app.role_permission rp where rp.role_id = old.role_id and rp.permission_code = 'admin.user.manage')
     and not exists (
        select 1 from app.role_assignment ra join app.role_permission rp on rp.role_id = ra.role_id
         where ra.tenant_id = old.tenant_id and rp.permission_code = 'admin.user.manage'
           and (ra.expires_at is null or ra.expires_at > now())
           and (ra.principal_id, ra.role_id, ra.company_id) <> (old.principal_id, old.role_id, old.company_id)) then
    raise exception 'ERR_RBAC_LAST_ADMIN: this change would leave no administrator in the tenant' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create function app.keep_last_admin_permission() returns trigger language plpgsql as $$
declare removing boolean;
begin
  -- An UPDATE that re-points the row (permission_code or role_id) removes the grant just as a DELETE does (verified on PG 18:
  -- with a DELETE-only trigger, `update … set permission_code = …` stripped the last administrator unchallenged).
  if tg_op = 'DELETE' then removing := true;
  else removing := new.permission_code <> old.permission_code or new.role_id <> old.role_id;
  end if;
  if removing and old.permission_code = 'admin.user.manage'
     and exists (select 1 from app.role_assignment ra where ra.role_id = old.role_id and (ra.expires_at is null or ra.expires_at > now()))
     and not exists (
        select 1 from app.role_assignment ra join app.role_permission rp on rp.role_id = ra.role_id
         where ra.tenant_id = old.tenant_id and rp.permission_code = 'admin.user.manage'
           and (ra.expires_at is null or ra.expires_at > now()) and ra.role_id <> old.role_id) then
    raise exception 'ERR_RBAC_LAST_ADMIN: this change would leave no administrator in the tenant' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);   -- never `return old` from a BEFORE UPDATE trigger: that silently discards the change instead of raising
end $$;
create trigger role_assignment_keep_last_admin before update or delete on app.role_assignment for each row execute function app.keep_last_admin_assignment();
create trigger role_permission_keep_last_admin before update or delete on app.role_permission for each row execute function app.keep_last_admin_permission();
-- Actor columns are never trusted (LEGACY-044): a column DEFAULT is not a control — direct SQL can supply any value. The generic
-- BEFORE INSERT OR UPDATE trigger app.stamp_actor(<column>), attached by the migration generator to every table with a *_by column
-- (created_by, posted_by, closed_by, voided_by, enrolled_by, granted_by, loaded_by, verified_by, entered_by; document_event.actor_id):
-- on INSERT a supplied value is replaced with app.current_actor() (a NULL stays NULL — posted_by/closed_by are set later); on UPDATE a
-- NULL → value transition is stamped with app.current_actor() (the moment of posting or closing), and any change to a non-null value
-- raises ERR_ACTOR_IMMUTABLE. statutory_rate_table: verified_by is stamped on
-- UPDATE OF verified_at and must differ from loaded_by (ERR_HR_SELF_VERIFY). The 0.4 linter checks every *_by column has it.
-- "Who can post a purchase return in company X?" = one join across principal → role_assignment → role_permission, filtered on
-- company_id, on expires_at, and on branch_id when the question is branch-specific (acceptance tests 14 and 36).

create type app.period_status as enum ('open', 'closed', 'locked');
create table app.fiscal_period (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  starts_on   date not null,
  ends_on     date not null,
  status      app.period_status not null default 'open',
  closed_by   uuid references app.principal(id), closed_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  check (ends_on >= starts_on),
  exclude using gist (company_id with =, daterange(starts_on, ends_on, '[]') with &&)  -- no overlaps
);

create type app.account_type as enum ('asset','liability','equity','income','expense');  -- one discriminator, not 30 booleans (LEGACY-072)
create table app.account (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  type        app.account_type not null,
  parent_id   uuid,                          -- composite FK below (schema rule: every tenant-scoped FK carries tenant_id)
  is_group    boolean not null default false,
  currency    char(3),                       -- null = any currency
  archived_at timestamptz,                   -- accounts are archived, never deleted (LEGACY-021)
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, parent_id)  references app.account(tenant_id, id)
);
alter table app.company add foreign key (tenant_id, fx_rounding_account_id) references app.account(tenant_id, id);

-- ── Document types are data; posting rules are versioned policy (RC-3, LEGACY-013) ──
create table app.document_type (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,                 -- 'JOURNAL' (Phase 1), 'SALES_INVOICE', 'PURCHASE_RETURN', 'POS_TICKET' …
  name_en     text not null, name_ar text,
  created_at  timestamptz not null default now(),
  unique (company_id, code), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
create table app.posting_policy (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  document_type_id  uuid not null,
  version           int  not null,
  effective_from    date not null,
  definition        jsonb not null,          -- validated against packages/domain/posting-policy.schema.json (below);
                                             -- seeded from version-controlled files, so it is diffable — not an opaque blob (LEGACY-078)
  created_at        timestamptz not null default now(),
  unique (document_type_id, version), unique (tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);

-- ── Numbering: a counter row per (company, series, period); numbers issued under an advisory lock (LEGACY-051) ──
create table app.document_series (
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  series            text not null,           -- 'INV', 'CN', 'JV', 'POS-KL01' …
  fiscal_period_id  uuid not null,
  next_number       bigint not null default 1,
  primary key (company_id, series, fiscal_period_id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
create table app.document_number_void (       -- a number that was issued and will never post: the gap, explained
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  series            text not null,
  fiscal_period_id  uuid not null,
  number            bigint not null,
  reason            text not null,
  voided_by         uuid not null default app.current_actor() references app.principal(id),
  voided_at         timestamptz not null default now(),
  primary key (company_id, series, fiscal_period_id, number),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
-- The posting service, inside the issuing transaction:
--   perform pg_advisory_xact_lock(hashtextextended('series:' || company_id::text || '/' || series || '/' || fiscal_period_id::text, 0));
--   insert into app.document_series (tenant_id, company_id, series, fiscal_period_id) values (…) on conflict do nothing;   -- first document of a new period (test 16)
--   update app.document_series set next_number = next_number + 1 where … returning next_number - 1;
-- The lock is released at commit; a rollback releases it and the number is never consumed.
-- Voiding an issued document sets status = 'void' AND inserts document_number_void in the same transaction.

create type app.document_status as enum ('draft','submitted','approved','issued','void','posted','reversed');
create table app.document (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references app.tenant(id),
  company_id            uuid not null,
  document_type_id      uuid not null,
  posting_policy_id     uuid,                -- PINNED at post time; never re-read (LEGACY-013)
  status                app.document_status not null default 'draft',
  series                text not null,
  fiscal_period_id      uuid,                -- resolved from effective_date at issue
  number                bigint,              -- assigned at ISSUE from document_series, never by the client (LEGACY-051)
  effective_date        date not null,
  party_id              uuid,                -- FK (tenant_id, party_id) → app.party is added by the Phase 2 migration
  currency              char(3) not null,
  exchange_rate         numeric(19,8) not null default 1,
  rate_source           text,                -- 'BNM 2026-09-04', 'manual:<actor>', … (LEGACY-012)
  reverses_document_id  uuid,                -- composite FK below
  client_ref            uuid,                -- uuidv7 generated at the till; the idempotency key (§3.7.3)
  branch_id             uuid not null,       -- BRANCH dimension value: the enforcement key for branch scoping (§4.2.1). NOT NULL: head-office documents carry the
                                             -- head-office value, never NULL, so no branch gate has a NULL path (LEGACY-042, 050). POS tickets take it from the terminal; composite FK below
  attributed_to         uuid references app.principal(id),   -- e.g. the cashier on a POS ticket: DATA about the document,
                                                             -- not the acting principal (created_by/posted_by) — LEGACY-044
  created_by            uuid not null default app.current_actor() references app.principal(id),
  created_at            timestamptz not null default now(),
  posted_by             uuid references app.principal(id), posted_at timestamptz,
  unique (company_id, series, fiscal_period_id, number),   -- per-period series: duplicates impossible, year 2 starts at 1
  unique (company_id, client_ref),                         -- re-sending a POS batch is harmless
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id)  references app.document_type(tenant_id, id),
  foreign key (tenant_id, posting_policy_id) references app.posting_policy(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id)  references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, reverses_document_id) references app.document(tenant_id, id)
);

-- Phase 2 adds app.document_event — append-only (forbid_change trigger; no update/delete for app_rw): document_id, from_status,
-- to_status, actor_id (stamped by trigger = app.current_actor(); never from a payload), attributed_to (the till-verified supervisor
-- or cashier a POS event is attributed to — data, like document.attributed_to), occurred_at, reason. Handlers never write it: an
-- AFTER UPDATE OF status trigger on document inserts it, and a BEFORE UPDATE OF status trigger enforces the legal transitions and
-- the maker ≠ checker and approval-authority rules, failing closed (§4.2.2 R1, R2). It joins the immutable list and the
-- audit-exempt list in the 0.4 linter when it lands.

-- ── Dimensions: generic, so a new axis needs no schema change (§3.3) ────────
create table app.dimension_type  (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null, code text not null, name_en text not null, created_at timestamptz not null default now(), unique (company_id, code), unique (tenant_id, id), foreign key (tenant_id, company_id) references app.company(tenant_id, id));
create table app.dimension_value (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), dimension_type_id uuid not null, code text not null, name_en text not null, parent_id uuid, archived_at timestamptz, created_at timestamptz not null default now(), unique (dimension_type_id, code), unique (tenant_id, id), foreign key (tenant_id, dimension_type_id) references app.dimension_type(tenant_id, id), foreign key (tenant_id, parent_id) references app.dimension_value(tenant_id, id));
-- The seed creates a BRANCH dimension type per company; pos_terminal.branch_id, document.branch_id and role_assignment_branch.branch_id reference values of it.
alter table app.role_assignment_branch add constraint role_assignment_branch_dim_fk foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);
alter table app.document add constraint document_branch_fk foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);

-- ── THE LEDGER. Immutable. The only financial truth. (D13, RC-2) ───────────────
create table app.ledger_entry (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  document_id        uuid not null,
  line_no            int  not null,
  account_id         uuid not null,
  debit              numeric(19,4) not null default 0 check (debit  >= 0),
  credit             numeric(19,4) not null default 0 check (credit >= 0),
  currency           char(3) not null,
  exchange_rate      numeric(19,8) not null,
  base_debit         numeric(19,4) not null,
  base_credit        numeric(19,4) not null,
  effective_date     date not null,
  fiscal_period_id   uuid not null,
  posting_policy_id  uuid not null,
  posted_at          timestamptz not null default now(),
  posted_by          uuid not null default app.current_actor() references app.principal(id),   -- session, never a parameter (LEGACY-044)
  check (not (debit > 0 and credit > 0)),                        -- one side per line
  check (base_debit  = round(debit  * exchange_rate, 4)),        -- base = value × rate, always (LEGACY-012)
  check (base_credit = round(credit * exchange_rate, 4)),
  unique (document_id, line_no),                                 -- also serves the per-document sum below
  unique (tenant_id, id),                                        -- lets ledger_entry_dimension use the composite FK form (v1.1 #14)
  -- Composite FKs: FK checks bypass RLS, so a plain `references app.account(id)` would let tenant A's entry
  -- point at tenant B's account if the uuid were known. Pairing tenant_id in the FK makes that impossible.
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)      references app.document(tenant_id, id),
  foreign key (tenant_id, account_id)       references app.account(tenant_id, id),        -- no orphan postings (LEGACY-021, 073)
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, posting_policy_id) references app.posting_policy(tenant_id, id)
);
-- Partition by fiscal year once volume warrants it; PK and unique keys must then include effective_date.
create index on app.ledger_entry (company_id, account_id, effective_date);   -- the index the old Journal never had (LEGACY-070)
create index on app.ledger_entry (company_id, effective_date);

create table app.ledger_entry_dimension (                       -- join table
  tenant_id           uuid not null references app.tenant(id),
  entry_id            uuid not null,
  dimension_type_id   uuid not null,
  dimension_value_id  uuid not null,
  primary key (entry_id, dimension_type_id),
  foreign key (tenant_id, entry_id)           references app.ledger_entry(tenant_id, id),
  foreign key (tenant_id, dimension_type_id)  references app.dimension_type(tenant_id, id),
  foreign key (tenant_id, dimension_value_id) references app.dimension_value(tenant_id, id)
);

-- Immutability: belt (privileges — see the grants block at the end) and braces (trigger). (LEGACY-031, 041)
create function app.forbid_change() returns trigger language plpgsql as $$
begin raise exception 'ERR_TABLE_IMMUTABLE: % is append-only', tg_table_name using errcode = 'check_violation'; end $$;
create trigger ledger_entry_immutable before update or delete on app.ledger_entry
  for each row execute function app.forbid_change();
create trigger ledger_entry_dimension_immutable before update or delete on app.ledger_entry_dimension
  for each row execute function app.forbid_change();

-- Period lock: checked on the LINES, not a sibling header table; fails closed on NULL. (LEGACY-031, 042)
create function app.assert_period_open() returns trigger language plpgsql as $$
declare st app.period_status;
begin
  select status into st from app.fiscal_period where id = new.fiscal_period_id;
  if st is distinct from 'open' then          -- NULL is distinct from 'open' → rejected, not skipped
    raise exception 'ERR_PERIOD_NOT_OPEN: period % is %', new.fiscal_period_id, coalesce(st::text, 'missing')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger ledger_entry_period_open before insert on app.ledger_entry
  for each row execute function app.assert_period_open();

-- Debits = credits in BASE currency, per document, checked at COMMIT. (LEGACY-003)
-- Per-transaction-currency balance is a posting-policy rule (a multi-currency revaluation journal
-- legitimately balances only in base). Because base amounts are rounded per line, the posting
-- service MUST add a base-currency FX-rounding line (rate 1, account company.fx_rounding_account_id)
-- when Σbase would otherwise be off by rounding residue — this trigger is the backstop, not the rounding logic.
-- Cost: FOR EACH ROW deferred → an N-line document re-sums N times at commit (uses the (document_id, line_no)
-- index). Acceptable to ~500 lines; the posting service also checks before insert so this rarely fires.
-- This is why the API needs a held transaction — and why it cannot run through transaction-mode pooling (§3.2.1).
create function app.assert_document_balanced() returns trigger language plpgsql as $$
declare diff numeric(19,4);
begin
  select coalesce(sum(base_debit) - sum(base_credit), 0) into diff
    from app.ledger_entry where document_id = new.document_id;
  if diff <> 0 then
    raise exception 'ERR_LEDGER_UNBALANCED: document % is off by %', new.document_id, diff
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger ledger_entry_balanced
  after insert on app.ledger_entry deferrable initially deferred
  for each row execute function app.assert_document_balanced();

-- ── POS terminals (§3.7.5): a terminal is a principal of kind 'terminal' ──────
create table app.pos_terminal (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  branch_id          uuid not null,                              -- a dimension_value of the BRANCH type
  principal_id       uuid not null unique references app.principal(id),   -- kind = 'terminal'
  name               text not null,
  device_public_key  bytea not null,
  enrolled_by        uuid not null default app.current_actor() references app.principal(id),
  enrolled_at        timestamptz not null default now(),
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);

-- ── Idempotency keys for every unsafe API call (§4.5, §3.7.3) ─────────────────
create table app.idempotency_key (
  tenant_id      uuid not null references app.tenant(id),
  principal_id   uuid not null references app.principal(id),   -- human, system or terminal
  key            text not null,               -- the Idempotency-Key header
  request_hash   bytea not null,              -- sha256 of method+path+body; same key + different hash → 409
  response_code  int,                         -- null while in flight → concurrent duplicate gets 409 + Retry-After
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours',
  primary key (tenant_id, principal_id, key)
);

-- ── Audit log: append-only, server-supplied actor, hash-chained. (LEGACY-029, 030, 040) ──
create table app.audit_log (
  seq          bigint generated always as identity primary key,
  tenant_id    uuid not null references app.tenant(id),
  actor_id     uuid not null default app.current_actor() references app.principal(id) deferrable initially deferred,
               -- NOT NULL is immediate (no anonymous writes); the FK is checked at COMMIT so the bootstrap's tenant row, audited
               -- before its system principal exists, can cite that principal as actor (verified on PG 18: without this the
               -- tenant insert fails on audit_log_actor_id_fkey and the reverse order fails on audit_log_tenant_id_fkey)
  occurred_at  timestamptz not null default now(),
  table_name   text not null,
  row_id       text not null,                 -- text: join tables have composite keys
  action       text not null check (action in ('insert','update','delete')),
  before       jsonb,
  after        jsonb,
  prev_hash    bytea,
  hash         bytea not null
);
create index on app.audit_log (tenant_id, seq desc);            -- the chain lookup below must not walk the whole PK
create trigger audit_log_immutable before update or delete on app.audit_log
  for each row execute function app.forbid_change();

-- The chain must not fork. ONE per-tenant transaction-scoped advisory lock — 'tenant-serial:<tenant>' — is
-- taken here AND by the catalogue-revision trigger (§3.7.3), so the two can never deadlock with each other.
-- It is correct only at READ COMMITTED: after acquiring the lock, the SELECT must see the previous holder's
-- committed row, which REPEATABLE READ's snapshot would hide. withTenant() pins READ COMMITTED.
-- Cost: audited writes for one tenant serialise for the transaction's duration — which is why long jobs
-- run as short transactions, and why derived/immutable tables are audit-exempt (linter rules above).
-- Escape hatch if this ever shows in p95: an ADR moving to a single-writer "sealer" job that chains rows
-- asynchronously by seq, with a per-row self-hash written at insert. Not a v1 concern.
-- The hash input is session-independent (epoch seconds, '|' delimiters), so any session can re-verify it.
create function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(
      new.tenant_id::text || '|' || new.actor_id::text || '|' || extract(epoch from new.occurred_at)::text || '|'
      || new.table_name || '|' || new.row_id || '|' || new.action || '|'
      || coalesce(new.before::text,'') || '|' || coalesce(new.after::text,''), 'UTF8'));
  return new;
end $$;
create trigger audit_log_chain before insert on app.audit_log
  for each row execute function app.audit_chain();
-- Verification (nightly job + acceptance test 13): walk rows by seq per tenant; each prev_hash must equal the
-- previous row's hash and each hash must recompute. Any mismatch is an incident, not a warning.

-- Generic row-audit trigger, attached to every audited table by the migration generator:
--   AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW. AFTER, not BEFORE: the bootstrap's system principal is the actor
--   of its own audit row, and audit_log.actor_id → principal(id) is checked at the end of the audit INSERT statement,
--   which must therefore run after the principal row exists (v1.1 fix #4); the tenant row is audited before any principal
--   exists, which is why audit_log.actor_id is deferrable initially deferred.
--   contract: insert one audit_log row with
--     tenant_id := coalesce(new.tenant_id, old.tenant_id), row_id := (new|old).id::text (or the composite key as text),
--     before := to_jsonb(old) (null on insert), after := to_jsonb(new) (null on delete), action := lower(tg_op).
--   Tables WITHOUT a tenant_id column (audit_log.tenant_id is NOT NULL, so the default expression would fail):
--     tenant     → tenant_id := (new|old).id
--     principal  → tenant_id := app.current_tenant()   (the generator emits this variant for tables the linter lists as global)
--     permission → exempt: a seeded catalogue that changes only by migration, which is itself version-controlled.
--   actor_id and hash come from the defaults/trigger above — there is no parameter to forge and no flag to skip.
--   Exempt (immutable or derived): ledger_entry, ledger_entry_dimension, inventory_movement, document_event, audit_log,
--   account_balance, cost_layer, cost_consumption, employee_ytd, idempotency_key, permission (document_event and employee_ytd are
--   forward declarations for Phases 2 and 8). Document status transitions ARE audited.

-- ── Privileges for the application role — the block that makes everything above reachable ──
grant select, insert, update on all tables in schema app to app_rw;
revoke insert, update on app.permission from app_rw;           -- seeded catalogue (§4.2.1): read-only for the app
revoke update, delete on app.ledger_entry, app.ledger_entry_dimension, app.audit_log from app_rw;   -- immutable
revoke delete on all tables in schema app from app_rw;          -- nothing financial or master is hard-deleted by the app (§3.9)
grant delete on app.idempotency_key, app.role_permission, app.role_assignment_branch to app_rw;   -- expired keys; join rows (the AFTER DELETE audit row keeps the before-image; forbid_self_grant guards both)
alter default privileges for role app_migrator in schema app grant select, insert, update on tables to app_rw;
-- Every future immutable table must repeat the revoke; the 0.4 linter checks that every table in the IMMUTABLE list
-- (ledger_entry, ledger_entry_dimension, inventory_movement, document_event, audit_log) has no update/delete privilege for app_rw.
-- Derived tables (account_balance, cost_layer, cost_consumption) are audit-exempt but MUST stay updatable by app_rw —
-- the posting service MERGEs into them. The immutable list and the audit-exempt list are not the same list (v1.1 fix #5).
```

**Bootstrap sequence (task 0.7b — the seed CLI runs as `app_migrator`, which is also subject to `FORCE ROW LEVEL SECURITY`):**
1. Generate `tenant_id` and `system_principal_id` in the CLI.
2. `set_config('app.tenant_id', tenant_id, true)` and `set_config('app.actor_id', system_principal_id, true)` — before any insert, so RLS and the audit `actor_id` default resolve.
3. Insert `tenant` (its audit row cites the not-yet-inserted system principal as actor — legal only because `audit_log.actor_id` is `deferrable initially deferred`); insert the `system` principal with `auth_subject = 'system:<tenant_id>'` (allowed by the `principal_insert` policy; **no `RETURNING`** — generate the id in the CLI; its own audit row cites itself as actor, which is valid because the audit trigger is AFTER ROW); insert its `membership` in the same transaction.
4. Create the owner's Supabase auth user through the Supabase admin API (service-role key, CLI only), then insert the `human` principal with that `sub`, its `membership`, the first `company` (MYR, `Asia/Kuala_Lumpur`), the `BRANCH` dimension type and head-office value, the **nine system roles** from `packages/db/seed/roles.ts` (`admin` holding every permission present at this phase except `pos.ticket.sell` and `pos.sync.*`), and the owner's `admin` assignment — granted by the system principal, so the no-self-grant rule (§4.2.2 R5) holds.
5. Load the Malaysia seed pack from `packages/db/seed/my/`: chart of accounts (including the FX-rounding account, then set `company.fx_rounding_account_id`), document types with policy v1, tax codes, fiscal periods for the current year.
6. Idempotent throughout: every insert is `on conflict do nothing` keyed on the natural key; running it twice changes nothing.

**MFA and first login.** The API rejects any JWT with `aal` below `aal2` on every route **except** the MFA-enrolment routes, which accept `aal1` — otherwise the owner's very first session after bootstrap could never enrol.

**The posting-policy definition — what a `definition` may express.** Phase 2 opens with an ADR proposing this schema in full (`packages/domain/posting-policy.schema.json`); this is the shape it must at minimum cover, so the agent knows what "a new document type with zero code" means:

```jsonc
{
  "version": 1,
  "documentType": "SALES_INVOICE",
  "direction": "outbound",                       // inbound | outbound | internal | none
  "requires": ["party", "warehouse"],            // header fields the document must carry
  "lines": [                                     // ledger lines produced per document line or per document
    { "for": "each_line", "side": "debit",  "account": { "from": "party.receivable_account" }, "amount": "line.total_incl_tax" },
    { "for": "each_line", "side": "credit", "account": { "from": "item.revenue_account" },     "amount": "line.total_excl_tax" },
    { "for": "each_tax",  "side": "credit", "account": { "from": "tax_code.output_account" },  "amount": "tax.amount" },
    { "for": "each_line", "side": "credit", "account": { "from": "item.inventory_account" },   "amount": "line.cost" },
    { "for": "each_line", "side": "debit",  "account": { "from": "item.cogs_account" },        "amount": "line.cost" }
  ],
  "inventory": { "effect": "issue", "warehouse": "header.warehouse", "costing": "consume_layers" },   // issue | receipt | transfer | none
  "tax": { "applies": true, "inclusive": "header.tax_inclusive" },
  "numbering": { "series": "INV", "assignAt": "issue" },
  "reversal": { "allowed": true, "producesType": "SALES_CREDIT_NOTE" },
  "approval": { "required": false, "approve": null, "post": "accounting.sales.post" },   // seeded: PAYMENT / PAYROLL_PAYMENT / EMPLOYEE_ADVANCE →
                                             // accounting.payment.approve / .post; PAYROLL → hr.payroll.approve / .post; STOCK_COUNT → inventory.adjustment.approve (both)
  "fxRoundingAccount": { "from": "company.fx_rounding_account_id" }
}
```

**Two things the schema deliberately does *not* do**, because the API does them and a CI test proves it: (1) assign document numbers — the posting service takes the advisory lock described under `document_series` and issues the next number at *issue*, recording voids in `document_number_void`; (2) compute balances — **the posting service updates `app.account_balance(company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)` in the same transaction via `MERGE`** (the correct upsert LEGACY-002/049 lacked), and the nightly ledger-integrity job rebuilds it from `ledger_entry` into a scratch table and compares row for row. A mismatch is an incident.

## 3.9 Engineering conventions

Settled so the agent does not have to decide them, and so every module looks the same.

**Identifiers.** `uuidv7()` server-side for everything (time-ordered, index-friendly). The POS generates a `uuidv7` at the till for each ticket (the `uuid` npm package or Bun's built-in), carried as `document.client_ref`. Never a sequential integer as a public identifier; never reuse; never rewind (LEGACY-021).

**Time and dates.** All timestamps `timestamptz`, stored in UTC. Every company has a `timezone` (`Asia/Kuala_Lumpur` for the first customer). **`effective_date` is a `date`, entered by the user, and is the accounting date** — it is never derived from `posted_at`. Fiscal period is resolved from `effective_date` at posting and stored on the row. Hijri display is a presentation concern via `Intl`; storage is always Gregorian.

**Money.** `numeric(19,4)` in Postgres. In TypeScript, `Money` is an opaque type wrapping `decimal.js`, carrying its currency; the compiler rejects adding MYR to USD. Display rounding applies the currency's policy at render time; **stored base amounts are never recomputed on read.** No `number` type ever holds a monetary value — a lint rule enforces it.

**Quantities.** `numeric(19,6)`. Unit conversions are exact rationals `(numerator bigint, denominator bigint)`, never floats (LEGACY-066). Quantity is stored once, in the item's base unit; the entered unit and quantity are kept for display.

**Naming.** `snake_case` everywhere in SQL; **singular** table names (`ledger_entry`, not `ledger_entries`), matching §3.8; enum types singular. TypeScript: `camelCase`, types `PascalCase`. Bilingual names on master data as `name_en` / `name_ar` columns — not a JSON blob.

**Enumerations.** Postgres `enum` for closed sets the code branches on (`document_status`, `period_status`, `account_type`). A lookup table for open sets the user extends (`document_type`, `dimension_type`, `tax_code`).

**Deletion.** Financial rows: never — reversal only. Master data: `archived_at`, never `DELETE`. HR master data: archived, never deleted; a terminated employee keeps every payroll line and payslip for the statutory retention period. Genuine deletion exists only for drafts and for the GDPR/PDPA erasure workflow, and both write an audit row first.

**Error codes.** Every error the API can return has a stable string code `ERR_<DOMAIN>_<REASON>` (`ERR_LEDGER_UNBALANCED`, `ERR_PERIOD_NOT_OPEN`, `ERR_STOCK_INSUFFICIENT`), a human message naming the specific entity, and a remedy. Codes are enumerated in one file; a code no code raises fails the build (the inverse of LEGACY-084).

**Database access.** Every query — reads included — runs inside `withTenant(tx => …)`, which opens the transaction and issues the two `set_config(…, true)` calls before anything else. A lint rule forbids bare `db.` calls. Without this RLS silently returns zero rows (§3.8).

**API.** `/v1/…`. Cursor pagination. `Idempotency-Key` header required on POST/PUT/PATCH/DELETE. `application/problem+json` errors. OpenAPI generated from Zod, committed, diffed in CI.

**Migrations.** One migration per PR, named `NNNN_<verb>_<noun>.sql`. **Production is forward-only.** Every migration ships a hand-written `NNNN.down.sql` that CI applies and then re-applies up on a Testcontainers database — "reversible" means that file exists and passes, not that production is ever rolled back. Expand/contract for any change touching a live table. Drizzle Kit generates the up; a human reads the SQL before merge. A CI check fails any new table lacking `tenant_id`, RLS, or an audit trigger.

**Tests.** `tests/regression/legacy-NNN.test.ts` — one file per Part I defect the current phase touches, named for it, so coverage of the defect register is greppable. `tests/invariants/` — the ledger and tenant-isolation suites, run on every PR. `tests/golden/` — costing and tax fixtures with expected output committed.

**Localisation.** Every user-facing string goes through i18next with an ICU message; a CI check fails any hard-coded string in a component. Both catalogues must be complete before merge — no empty `msgstr`, no source-language fallbacks in the other language (LEGACY-085).

**Logging.** Structured JSON; `tenant_id`, `actor_id`, `request_id`, `trace_id` on every line; never a token, password, or full card number. A lint rule forbids `console.log` outside scripts.

---

## 3.10 HR & Payroll — the specific design

Owner decision 2026-09-05 (D25): HR with payroll is in v1. This section is the design; Part V Phase 8 is the build. Three independent proposals (minimal, compliance-first, operator-first) were compared before this synthesis; where they disagreed, the choice and the reason are stated.

### 3.10.1 Scope

**In v1 (Phase 8 unless marked):**

- **Employee master** — `employee` extends a `party` of kind `employee` (1:1): employee number, home branch (a BRANCH dimension value), position, employment type, hire and termination dates, and an optional 1:1 `principal_id` (only staff who log in or sell). The minimal master lands in **Phase 6**, because cashiers are employees.
- **Sensitive data** in a separate `employee_sensitive` table, field-level encrypted in the application (§4.6): national ID or passport, date of birth, residency category, bank account, EPF/SOCSO/income-tax reference numbers, work-permit expiry. Protected **in the data layer**: an RLS policy created **`AS RESTRICTIVE`** — `create policy sensitive_gate on app.employee_sensitive as restrictive using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)))` — alongside the standard permissive `tenant_isolation`; Postgres ANDs restrictive policies with the permissive set, so the gate composes instead of being OR-ed away, and a principal without the permission gets zero rows through any path (the system principal passes, so jobs still run); the API additionally omits the fields, and the gate covers filter, sort, search and export, not only display (LEGACY-033). `employee_sensitive` carries no copy of `company_id`'s parents — the policy joins `employee`.
- **Effective-dated statutory profile** per employee: the inputs the PCB/MTD method needs (marital status, spouse-working flag, child relief count, …). ⚠️ The field list is verified against LHDN's current publication, never invented here.
- **Pay components** — a typed catalogue (`earning | deduction`), each mapped to a GL account and to statutory schemes through a join table (no "subject to X" booleans — RC-3). Malaysia seed: basic salary, fixed allowance, overtime (entered as an amount), bonus/commission, unpaid-leave deduction (days × daily rate), advance recovery.
- **Compensation lines** — effective-dated recurring pay lines per employee. Salary history is the closed rows; a promotion is a new row.
- **Statutory schemes as data** — `statutory_scheme` (EPF, SOCSO, EIS, PCB/MTD, plus any levy the owner confirms applies — a scheme is a **row**, never an enum, so a new levy is data, not a migration) and `statutory_rate_table(scheme, version, effective_from, effective_to, definition jsonb, source, loaded_by, verified_by, verified_at)`, seeded from version-controlled files under `packages/db/seed/my/statutory/<scheme>/vN.json` so every change is a reviewed diff (LEGACY-078). The seed PR is the primary load path; the runtime `hr.statutory_table.manage` load is break-glass, and **`verified_by` must differ from `loaded_by`** (trigger). **This document states no rate, threshold, ceiling or formula.** A run cannot pin an unverified table or one whose effective range does not cover the pay period (LEGACY-020).
- **Payroll run** — a `Document` of type `PAYROLL` (kind `regular | supplementary | final`), 1:1 with `document` and using **the document state machine, not its own**: calculate → submit → approve → post, through the one posting service under a pinned policy; every `payroll_line` pins the rate-table versions it used (LEGACY-013). A run may be recalculated only while draft or submitted; any recalculation after submit returns it to draft and voids the pending approval, so an approver always approves the figures that will post. Correction after posting is a reversal plus a supplementary run; nothing is edited in place (LEGACY-041).
- **Money out on Phase 4 machinery** — `PAYROLL_PAYMENT` (one bank batch, one line per employee, clears salaries payable per employee); statutory remittances as ordinary `PAYMENT` documents to each authority modelled as a vendor party, refused if the amount differs from the schedule they settle; `EMPLOYEE_ADVANCE` (debit staff-advance receivable per employee, credit bank) recovered by the advance-recovery component — the outstanding balance is a ledger projection, never a loan ledger.
- **Outputs** — a payslip PDF per employee per run (stored as an attachment with its hash); a monthly contribution/deduction schedule per scheme in the layout each authority accepts for upload ⚠️ *verify layouts against the authorities*, recorded as one `statutory_schedule` row per scheme per period (generated from posted lines only; attachment hash; the remittance PAYMENT that settled it) — a record, not a lodgement state machine; the annual per-employee statement and employer return generated from `employee_ytd` (Phase 8, using the Phase 7 report engine; form names verified against LHDN at build time); a bank-neutral CSV of the net-pay batch. Bank-specific formats are out.
- **Year-to-date** — `employee_ytd` (per employee per tax year) is a projection rebuilt from posted lines nightly and compared (D14); `employee_ytd_opening` rows are loaded at cut-over so a mid-year switch computes PCB correctly (Phase 9).
- **Leave — ⚠️ only if the owner confirms.** Unpaid leave enters payroll as a quantity on the unpaid-leave deduction component; statutory leave records stay where they are kept today. If the owner wants leave in Dulja, the minimal register is `leave_type` (annual, sick, unpaid, other), a yearly `leave_entitlement` per employee entered by HR (no accrual engine), `leave_record` approved by a different principal, and public holidays per company and branch. *(The judge panel scored this as scope a 30-person distributor may not need; it is a §5.3 owner question, not a default.)*
- **Proration** for mid-month joiners and leavers and for unpaid days follows a company-level configured rule (calendar days or working days) that the accountant confirms — configuration, never a statutory claim.
- **Manual statutory override** — a per-employee override line (PCB in particular) is allowed only with a reason and `entered_by`, is flagged, is listed on the approval screen and stays in the audit trail; the engine never guesses, the operator is accountable.
- **Employer registration identifiers** (EPF, SOCSO, LHDN employer numbers) are relational company settings supplied by the owner (§5.3) — never a blob (§4.1).
- **Attendance, minimal** — `attendance_event` (`clock_in | clock_out | manual_correction`) from the POS clock-in feature (Phase 6) and back-office corrections, attributed to the employee, with the terminal or principal as actor. Readable by HR and payroll as a report; **never an automatic pay input** in v1.
- **Termination** — setting `terminated_on` excludes the employee from later regular runs and, **by trigger** (an AFTER UPDATE OF `terminated_on` trigger on `employee`, so a direct `app_rw` update or the Phase 9 importer cannot bypass it), sets `pos_cashier.revoked_at`, expires every `role_assignment` of `employee.principal_id` and bumps the catalogue revision (tombstone); it runs under the terminating actor, so R4 and `forbid_self_grant` still hold and `hr_payroll` needs no `admin.role.assign`. The last pay is a `final` PAYROLL. A deferrable constraint trigger on both `pos_cashier` and `employee` enforces **cashiers are employees**: an unrevoked `pos_cashier` must reference an employee with `terminated_on IS NULL`.
- **Reports** — employee list by branch, payroll register per run, statutory summary per scheme per month, salaries-payable and scheme-payable reconciliation to the ledger, contract and permit expiry list.

**Out of v1** — each was a legacy Salaries table group; build only on a real request: org-structure tree and departments (`Organics`); shifts, rosters and shift groups; attendance-clock file import and attendance-driven pay; leave accrual, carry-forward and vacation layers; the incidents/penalties/rewards engine (a penalty or bonus is one ad-hoc component line, audited like any line); promotions workflow and employment-history tables; end-of-service or gratuity accrual (a statutory termination benefit is computed from the authority's rules and entered on a `final` run); piecework and production pay; loans with interest or variable schedules; overtime and public-holiday pay calculators (overtime is an amount in v1); employee self-service of any kind (payslips are printed by the payroll officer — a login for every warehouse hand would force MFA enrolment on people who never use a screen, §4.2); e-mailed payslips; recruitment, appraisal, training and expense claims; multi-currency payroll (MYR only); bank bulk-payment file formats and direct e-filing to the authorities (v1 exports a schedule the officer uploads). ⚠️ **Owner to confirm:** HRD Corp levy applicability; foreign workers; anyone hourly-paid or part-time; staff purchases at the till on salary deduction.

### 3.10.2 Identity: employee, principal, cashier

Three tables, one direction of reference. `employee` is the HR and statutory identity and exists for every staff member. `principal` (kind `human`) is the audit and login identity and exists only for staff who use the back office or a till; `employee.principal_id` is a nullable unique FK to it, and the principal never points at HR data, so identity works with no HR module loaded. `pos_cashier` (Phase 6) is the till credential — PIN hash, branch, snapshotted permission codes and limits — keyed on the principal and referencing the employee. Every cashier's principal is created from a Supabase-obtained `sub` like any other human (admin API at hire; alias address on a tenant domain when there is no mailbox — §3.7.5), so the identity model has exactly one human scheme; the PIN is never a login (LEGACY-025, 026, 028). Termination closes all three in one transaction (§3.7.5). The legacy split of `Users`, `Employees` and `Points` was right in spirit and wrong in mechanics: unlinked tables, a PIN reused as a password, no revocation path.

### 3.10.3 Posting

`PAYROLL` (direction none; inventory none; tax none — PCB is a statutory scheme, not the sales-tax engine; approval required; numbering series PAY at issue): for each earning component, DEBIT its expense account; for each employer contribution, DEBIT its expense account; CREDIT each scheme's payable account for the employee and employer shares; CREDIT the advance receivable for recoveries; CREDIT salaries payable per employee for net pay. Every line carries **BRANCH** (the employee's home branch; a `required` dimension on PAYROLL lines) and **EMPLOYEE** (one dimension value per employee), so branch staff cost and per-employee payables are ledger projections. The posting-policy schema (Phase 2 ADR) must therefore support per-line dimension tagging and line-level account resolution (`line.component.expense_account`, `line.scheme.payable_account`), and the chart-of-accounts seed pack gains salaries expense, employer-contribution expense per scheme, salaries payable, a payable per scheme, and staff advances. Acceptance test 28: a PAYROLL run and a hand-keyed JOURNAL with the same lines produce identical ledger entries after projecting out ids.

### 3.10.4 Rules this design must not break

LEGACY-011 (no NULL statutory input reaches a line: the run refuses, naming the employee) · LEGACY-013 (rate-table and policy versions pinned per line) · LEGACY-019 (each scheme's rounding rule is declared in its table and applied through the one rounding function) · LEGACY-020 (no rate in code; an unverified or out-of-range table refuses) · LEGACY-029/030 (every HR write audited, no flag) · LEGACY-031/041 (posted runs and lines immutable; correction by reversal; period lock on the lines) · LEGACY-032 (approval authorised against the actor; maker ≠ checker read from `document_event`) · LEGACY-033/045 (sensitive reads gated by an RLS predicate on the actor's permission, never by a parameter) · LEGACY-044 (payroll actors from the session) · LEGACY-078 (statutory rules as version-controlled data).

### 3.10.5 Risks

PCB/MTD correctness is the largest: the parameters change yearly and the method is intricate. Mitigations: parameters as verified data with a source; golden fixtures built from the authorities' published worked examples; a per-employee manual override with reason, surfaced on approval; and **one month run in parallel with the legacy system** before the first live run (the Phase 8 definition of done). Rate-table staleness: `effective_to` plus a scheduled job that warns sixty days before a table lapses. Small-team segregation of duties: HR prepares, the owner or accountant approves — a one-person tenant cannot approve its own payroll by design.

---

# PART IV — SaaS PRODUCT STANDARDS

Everything below is what turns a rewritten accounting engine into a professional SaaS product. The old system has essentially none of it.

**Each section is tagged.** **[v1]** = build now, even for one business — the structure is cheap today and brutally expensive to retrofit. **[deferred]** = the commercial layer; not built until there is a second customer (§3.0.1). Within a **[v1]** section, individual bullets may still be tagged *(deferred)*.

## 4.1 Tenancy — **[v1]**

**Model: pooled with row-level security**, plus a silo option for enterprise customers who require it contractually.

- `tenant_id` on every table; a Postgres RLS policy on every table keyed to a session-set, server-controlled tenant claim. **The application role has no `BYPASSRLS`.**
- A write whose `tenant_id` disagrees with the session claim is rejected by the policy, not by application code (LEGACY-035).
- Cross-tenant access (support, analytics) is a distinct principal with its own audit stream, never a widened user session. *(structure v1; support tooling deferred)*
- Tenant-level configuration is relational and versioned, never a blob (LEGACY-078).
- **Noisy-neighbour control:** per-tenant rate limits, query timeouts, and background-job quotas. *(deferred until a second tenant)*
- Document a written tenant-isolation test: a suite that attempts cross-tenant read/write through every endpoint and every background job, run in CI.

## 4.2 Identity and access — **[v1]** except where marked

- **AuthN is delegated to Supabase Auth** (D3): the application never stores or compares a password, which is how LEGACY-028 is closed — by not owning credentials at all. Supabase provides bcrypt hashing, TOTP MFA, rate limiting, short-lived JWTs with rotating refresh tokens, and revocation on logout/password change (LEGACY-043). The application enforces **MFA required per tenant** by rejecting any JWT whose `aal` claim is below `aal2`. The only credentials the application itself hashes are cashier PINs for offline POS login (§3.7.5) — Argon2id, per-cashier salt. **Inviting a user** creates the `principal` from the `sub` returned by the Supabase admin invite call, never from a subject supplied by the client — a client-supplied subject would let one tenant pre-register another tenant's user (§3.8, `principal_insert`).
- **Enterprise:** SAML/OIDC SSO, SCIM provisioning, IP allow-lists, session-length policy. *(deferred)* Enforced MFA policy is **v1**.
- **AuthZ:** relational RBAC — principal → role → permission, assigned per company and optionally per branch — plus row-level scoping through RLS. The role catalogue and permission scheme are in §4.2.1. **"Who can post a purchase return in company X?" must be answerable with one SQL query** (LEGACY-025, 034, 047).
- The permission catalogue is a version-controlled file (`packages/contracts/permissions.ts`) seeded into `app.permission`; a permission no code evaluates **fails the build**, and a handler that references a code not in the catalogue fails the build.
- **Machine access:** service accounts with scoped API keys, separate from human users, individually revocable, with their own audit trail.
- **Support access** *(deferred)*: impersonation requires explicit tenant consent, is time-boxed, is banner-visible to the user, and writes a distinct audit record naming both the support agent and the impersonated user.
- **Segregation of duties** is enforced in the data layer, not advised in the UI — the eight rules in §4.2.2. Approval is a state transition authorised against the *actor's* authority and recorded in `document_event` (LEGACY-032).

### 4.2.1 Role catalogue and permission scheme — **[v1]**

**Permission codes** are `<module>.<resource>.<action>` in five modules — `admin`, `accounting`, `inventory`, `hr`, `pos` — with a closed action vocabulary (`read`, `manage`, `create`, `post`, `approve`, `reverse`, `close`, `reopen`, `override`, `export`, `reconcile`, `sell`, `discount`, `return`, `return_blind`, `void`, `prepare`, `pay`, `record`, `request`, `check`, `clock`, `manage_pin`, `resolve`, `pull`, `push`, `file`, `generate`). Each row carries `module` and `mutating`. The catalogue is **phased**: a code enters the file in the phase that builds its handler, so "a code no handler checks fails the build" holds at every phase. The v1 catalogue:

| Module | Codes |
|---|---|
| `admin` | `admin.user.manage` · `admin.role.manage` · `admin.role.assign` · `admin.company.manage` · `admin.terminal.manage` · `admin.audit_log.read` · `admin.data.export` |
| `accounting` | `accounting.account.manage` · `accounting.ledger.read` · `accounting.period.close` · `accounting.period.reopen` · `accounting.journal.create` · `accounting.journal.post` · `accounting.party.manage` · `accounting.credit_limit.override` · `accounting.sales.create` · `accounting.sales.post` · `accounting.receipt.create` · `accounting.receipt.post` · `accounting.purchase.create` · `accounting.purchase.post` · `accounting.payment.create` · `accounting.payment.approve` · `accounting.payment.post` · `accounting.document.reverse` · `accounting.bank.reconcile` · `accounting.tax.manage` · `accounting.tax.file` · `accounting.report.read` · `accounting.report.export` — sales and purchase *orders* are created under `accounting.sales.create` / `accounting.purchase.create`; receipts (money in) need no maker-checker, payments (money out) do |
| `inventory` | `inventory.item.read` · `inventory.item.manage` · `inventory.price.manage` · `inventory.stock.read` · `inventory.cost.read` · `inventory.receipt.create` · `inventory.receipt.post` · `inventory.transfer.create` · `inventory.transfer.post` · `inventory.count.create` · `inventory.adjustment.create` · `inventory.adjustment.approve` · `inventory.negative_stock.override` |
| `hr` | `hr.employee.read` · `hr.employee.manage` · `hr.employee.read_sensitive` · `hr.compensation.read` · `hr.compensation.manage` · `hr.pay_component.manage` · `hr.statutory_table.manage` · `hr.statutory_table.verify` · `hr.attendance.record` · `hr.payroll.read` · `hr.payroll.prepare` · `hr.payroll.approve` · `hr.payroll.post` · `hr.payroll.pay` · `hr.filing.generate` · `hr.advance.create` · *(`hr.leave.record`, `hr.leave.approve` only if the leave register is confirmed)* |
| `pos` | `pos.ticket.sell` · `pos.ticket.discount` · `pos.ticket.return` · `pos.ticket.return_blind` · `pos.ticket.void` · `pos.ticket.override` · `pos.shift.own` · `pos.shift.close_any` · `pos.price.check` · `pos.customer.create` · `pos.attendance.clock` · `pos.cashier.manage_pin` · `pos.needs_attention.resolve` · `pos.report.read` · `pos.sync.pull` · `pos.sync.push` |

**Roles** are tenant-seeded rows in `app.role` with `is_system = true` (never renamed or archived; their permissions change only by migration, so a change is a reviewed diff). A principal may hold several roles; effective authority is the union across unexpired assignments in the target company, narrowed by branch rows. These nine match the people a distributor with branch shops actually employs; a tenant may clone one under `admin.role.manage`. ⚠️ *Owner to confirm the names before task 0.7.*

| Role | Who | May | May not |
|---|---|---|---|
| `admin` | The owner; the bootstrap role (§3.8 step 4) | Every permission present at the current phase — identity and configuration, every approval and exception authority — except selling at a till and terminal sync | Approve or post what they themselves submitted: R1 binds everyone, admin included; hold `pos.ticket.sell` or `pos.sync.*` |
| `accountant` | Head-office bookkeeper | Chart of accounts, journals, sales and purchase documents and their posting, receipts (create and post — money in), payment **approval and posting** (payments are drafted by `user` — R6), release of the net-pay bank batch (`hr.payroll.pay`), bank reconciliation, tax returns, period close; approve stock counts and expiry/damage write-offs (`inventory.adjustment.approve`); approve and post payroll as HR's checker; verify statutory tables | Draft a payment (`accounting.payment.create` is not in the seed — R6); approve or post any document they themselves submitted (R1); reopen a period; manage users |
| `user` | General back-office clerk | Draft sales and purchase orders and documents, receipts and payments (`*.create`); maintain customers and vendors (credit terms included); read accounts, items, stock and the staff directory (no sensitive fields) | Post, approve, override credit limits, see costs or compensation |
| `warehouse` | Head-office store staff | Receive against purchase documents, transfer to branches, draft stock counts and expired/damaged write-offs; post receipts and transfers — quantities only | Prices, costs, negative-stock override, approving or posting counts and adjustments (`inventory.adjustment.approve` is the accountant's) |
| `branch_manager` | Runs one shop; always assigned with branch rows | Everything a cashier may, plus overrides on *others'* tickets as the second principal, closing any shift and the Z-report, receiving transfers, drafting counts and write-offs, quick-creating customers, attendance corrections, resolving the needs-attention queue, resetting a PIN for a cashier in the same branch | Prices, item master or credit terms (head office owns the catalogue); costs; anything in another branch |
| `cashier` | Branch till staff; branch rows set; an active employee with a `pos_cashier` row | Sell, discount within the branch limit, return against an original ticket, own shift, price check, customer quick-create, clock in/out | Blind returns, voids, overrides on own tickets, closing others' shifts |
| `hr_payroll` | HR / payroll officer | Employee master including sensitive data (RLS-gated), compensation and pay components, load statutory tables (a *different* principal verifies), attendance records, payroll prepare and submit, advance drafts, filings | Approve or post payroll; approve a payment; verify a table they loaded; touch their own compensation or record (R4) |
| `auditor` | External accountant or statutory auditor; assigned with `expires_at` | Read everything financial: ledger, documents, reports, stock and costs, payroll register (`hr.payroll.read`: posted lines only — no compensation or sensitive rows) and statutory schedules, audit log and document events; export | Any mutating permission — CI proves the role holds none (R7); identity numbers and bank details (`hr.employee.read_sensitive` is not in the seed; a tenant may add it) |
| `pos_terminal` | A principal of kind `terminal`, assigned at enrolment with its branch row | `pos.sync.pull`, `pos.sync.push` | Anything else; a human never holds this role and a terminal holds nothing else (R8, trigger-enforced both ways) |

**Branch scoping.** `role_assignment_branch` rows restrict an assignment to a set of BRANCH dimension values; no rows means every branch of the company. `app.actor_has(code, company_id, branch_id)` (§3.8) resolves authority from the principal's unexpired assignments and is the **only** evaluation point for permissions — handlers, RLS policies and triggers all call it. A NULL branch asks for *company-wide* authority and is granted only by an assignment with no branch rows, so a branch-restricted principal never gains anything by omitting the branch (LEGACY-042, LEGACY-050). Branch *isolation* of rows is a RESTRICTIVE RLS policy `branch_isolation` on every table with a `branch_id` column (`document`, shifts, attendance events, `pos_cashier`, branch-keyed projections), attached from Phase 6 when branch-scoped roles first exist (§3.8), so a missed handler check cannot leak another branch's rows. A request may narrow scope below the assignments, never widen it (LEGACY-042, LEGACY-045). `document.branch_id` is **NOT NULL** — head-office documents carry the head-office BRANCH value — and `pos_terminal.branch_id` is what the till's documents inherit; back-office documents take the branch from an explicit choice.

### 4.2.2 Segregation of duties — enforced rules **[v1]**

Each rule names where it is enforced. None is a UI convention.

- **R1 Maker ≠ checker.** For any document whose posting policy declares `approval.required` (seeded: PAYROLL, PAYROLL_PAYMENT, EMPLOYEE_ADVANCE, PAYMENT, STOCK_COUNT adjustments, and any type the tenant flags), the actor of the `approved` and `posted` transitions must differ from every actor of the `submitted` transition on that document. The trigger resolves the policy **effective for the document's `effective_date`** — not `document.posting_policy_id`, which §3.8 pins only at post and is NULL at approval. Enforced in the data layer (Phase 2): (1) an AFTER UPDATE OF status trigger on `document` **inserts the `document_event` row itself** (from_status, to_status, actor_id = `app.current_actor()`, reason from a transaction setting) — handlers never write `document_event`, so a direct `app_rw` update cannot skip it; (2) a BEFORE UPDATE OF status trigger enforces the legal transitions (draft → submitted → approved → issued → posted → reversed; submitted|approved → draft only for recalculation, §3.10.1) and, for a type whose effective policy declares `approval.required`, **fails closed**: a transition to approved or posted with no `submitted` event raises `ERR_SOD_NO_SUBMISSION`, and one whose actor matches any `submitted` actor raises `ERR_SOD_MAKER_IS_CHECKER`. Tested through the API, jobs and direct `app_rw` SQL (test 31).
- **R2 Approval is authorised against the actor at transition time, in the data layer.** The same BEFORE UPDATE OF status trigger as R1 calls `app.actor_has(policy.approval.approve, document.company_id, document.branch_id)` for the approved transition and `app.actor_has(policy.approval.post, …)` for the posted transition; the codes come from the posting policy effective for the document's `effective_date` (§3.8 example: PAYMENT, PAYROLL_PAYMENT and EMPLOYEE_ADVANCE → `accounting.payment.approve` / `.post`; PAYROLL → `hr.payroll.approve` / `.post`; STOCK_COUNT → `inventory.adjustment.approve`). The handler's own check is a pre-flight for a better error message, not the control (LEGACY-032).
- **R3 Payroll chain.** The principal who submitted a PAYROLL run cannot approve or post it; a compensation change effective in the period of a run in `submitted` or `approved` status returns that run to `draft` (the one backward transition the state machine allows, recorded in `document_event` with reason `compensation_changed` — §3.10.1) and requires re-submission and re-approval; a change effective in a period whose run is already `posted` never touches that run — it is picked up by the next `supplementary` run. The approval screen lists everyone who changed compensation in the period.
- **R4 No self-pay.** Writes to `compensation_line`, `employee_sensitive`, `employee_statutory_profile`, `employee.terminated_on` and `leave_record.status = approved` where the target employee's `principal_id = app.current_actor()` are rejected by trigger (test 31).
- **R5 No self-grant, no self-escalation.** A principal cannot change their own `role_assignment` rows, nor the `role_permission` rows of a role they hold (`forbid_self_grant`, §3.8). The last principal holding `admin.user.manage` in a tenant cannot be stripped of it or expired (`keep_last_admin_assignment` / `keep_last_admin_permission`, §3.8, raising `ERR_RBAC_LAST_ADMIN`).
- **R6 Incompatible pairs in the seed.** The catalogue file names permission pairs no single *seeded role other than `admin`* may hold — `accounting.payment.create` with `accounting.payment.approve`, `hr.payroll.prepare` with `hr.payroll.approve`, `hr.statutory_table.manage` with `hr.statutory_table.verify`, `hr.employee.read_sensitive` with `pos.ticket.sell`. `admin` is exempt because it is the full-permission bootstrap role (§3.8 step 4, D26); what binds an admin is R1 — an admin can hold both `hr.payroll.prepare` and `hr.payroll.approve` but can never approve or post a run they submitted. Enforced by a CI lint over `packages/db/seed/roles.ts`; no runtime table (the judge panel rejected one as over-building). A *principal* may still hold both through two roles — a small business cannot always avoid it — and R1 then guarantees the same person never acts on both sides of one document.
- **R7 Read-only is provable.** `permission.mutating` is part of the catalogue; the seeded `auditor` role contains only non-mutating codes (CI test — `user` is a drafting role and holds `*.create` and `accounting.party.manage`, which are mutating by definition), and a mutating handler can never be gated by a read code (the build fails).
- **R8 Kind discipline, period control, overrides.** A principal of kind `terminal` may hold only `pos_terminal`; `pos_terminal` may be assigned only to kind `terminal` (`assert_assignment_kind`, §3.8, enforced both ways); the system principal holds no role, but `app.actor_has()` returns true for it so server-side jobs (payroll calculation, `employee_ytd` rebuild, key rotation) can read RLS-gated rows — it is reachable only from jobs and the seed CLI, never from a request path (RC-1), and every write it makes is audited under its own id. `accounting.period.reopen` is distinct from `close`, held by `admin` only in the seed, requires a reason written to the audit row, and every reopen is reported by the nightly integrity job. Overrides — negative stock, credit limit, POS discount, void, blind return — are explicit permissions exercised per document by a second principal and recorded as a `document_event`, never session flags (LEGACY-027, LEGACY-048).

## 4.3 Tenant lifecycle — **[deferred]** except data export

- Self-serve signup → email verification → guided onboarding wizard (company details, fiscal year, currency, chart-of-accounts template from a country pack, tax regime).
- **Sandbox/demo tenant** seeded with realistic data, resettable in one click.
- Trial with clear expiry, conversion path, and grace period.
- **Data export at any time** *(v1 — it is your own books)*, unprompted, in open formats (CSV + JSON + a documented schema) — a legal requirement in several jurisdictions and a trust signal in all. Built in Phase 7.
- Offboarding: export, then scheduled deletion with a stated retention window and a deletion certificate.
- **Never** an initialisation procedure callable on a running system (LEGACY-039). *(v1)* Bootstrap is the offline `bun run seed` CLI of §5.0 task 0.7b, run as the migrator role, following the sequence in §3.8.

## 4.4 Billing and metering — **[deferred]**

- Plans → **entitlements** (feature flags + limits), evaluated server-side on every request. *(The entitlement check itself is v1 — build the seam now, leave every plan unlimited.)* This is the modern replacement for `Futures` and the `.lic` dongle (LEGACY-082).
- Usage metering where the pricing model needs it (users, companies, documents/month, storage) — metered events written to an append-only stream, aggregated for billing.
- Integration with a billing provider (Stripe/Paddle/Chargebee) rather than home-grown invoicing; handle proration, upgrades/downgrades, dunning, failed payments, and tax on *your own* invoices.
- Grace and degradation behaviour must be explicit: what happens on non-payment (read-only, then export-only, then suspend) — never an abrupt licence-server failure with no diagnostic.

## 4.5 API design — **[v1]**

- **Zod schemas in `packages/contracts` are the source of truth**; the OpenAPI 3 document is generated from them (`@hono/zod-openapi`), committed, and diffed in CI; the TypeScript client both desktop apps use is generated from that document. Code-first, one definition.
- Versioning: URL-major (`/v1/`), additive-only within a version, documented deprecation policy with sunset headers.
- **Idempotency keys required on every unsafe method** — essential for POS terminals on flaky shop connections.
- Cursor pagination everywhere (never offset on large tables), consistent filter/sort grammar, sparse fieldsets.
- Errors as RFC 9457 `application/problem+json` with a **stable machine-readable code**, a human message naming the specific offending entity, and a remedy (LEGACY-084).
- Rate limits with `RateLimit-*` headers *(v1 for abuse protection; per-plan quotas deferred)*.
- **Webhooks** *(deferred)* with signed payloads, at-least-once delivery, replay endpoint, and a delivery log the tenant can inspect.
- Bulk endpoints for import/export with async job semantics and a status resource.

## 4.6 Data, privacy and compliance — **[v1]** except certification

- **Encryption:** TLS 1.3 in transit; encryption at rest; a managed KMS with documented key rotation. Field-level encryption for anything sensitive beyond the norm.
- **PII inventory** and a data-classification map. Documented retention per class. Right-to-export and right-to-erasure workflows that respect statutory accounting-record retention (you cannot delete a posted invoice because a customer asked — document why, and delete what you legally may). **HR data** — national ID or passport, date of birth, bank account and statutory reference numbers in `employee_sensitive` (§3.10) — is field-level encrypted with a dedicated key in the §4.11 inventory, gated by `hr.employee.read_sensitive`, carries a retention class, and the erasure workflow refuses to erase it inside the statutory retention window and records why.
- **Data residency** *(design for it; deferred as a feature)* if you will sell into the GCC or EU — retrofitting region-pinned tenancy is very expensive.
- Applicable regimes to scope explicitly with counsel: Malaysia **PDPA**, EU **GDPR** if selling there, plus each jurisdiction's statutory retention period for accounting records.
- Target **SOC 2 Type II** and/or **ISO 27001** readiness *(controls v1, certificate deferred)* — not the certificate on day one, but the controls (access review, change management, incident response, vendor management, logging) built in rather than retrofitted.
- A published **vulnerability disclosure policy** and a security contact. *(deferred)*

## 4.7 Accounting-specific compliance — **[v1]**

This is where an accounting SaaS lives or dies, and where the old system is weakest.

- **Immutable audit trail**: append-only, server-supplied actor, monotonic sequence, per-record chained hash so gaps and edits are detectable. Not optional, not suppressible (LEGACY-029, 030).
- **Sequential document numbering**: assigned at *issue*, per (series, period), unique-constrained, gapless-provable, with voided numbers explicitly recorded (LEGACY-051).
- **Period close**: uniform for all roles, reopening separately authorised and audited, immutability enforced across header + lines + projections in one boundary (LEGACY-031).
- **No deletion of posted documents at any privilege level.** Corrections are reversing entries (LEGACY-041).
- **E-invoicing / fiscalisation** as a pluggable jurisdiction pack with document hash, QR code, transmission log, retry, and status reconciliation. The old system has the table shape for this (`JurTaxInfo` with `Guid`/`Token`/`Hash`/`QRCode`) but ships the triggers **disabled**.
  - ⚠️ **Confirm current requirements before scoping.** Malaysia's LHDN **MyInvois** e-invoicing regime and the GCC/ZATCA VAT rules both changed materially in recent years and phase-in thresholds move. Treat every specific deadline, threshold and schema version as *to be verified against the authority's current documentation*, not as settled by this document. **Malaysia is confirmed as the first jurisdiction (§0.3).** The GCC pack is deferred until a customer there exists.
- **Tax engine**: versioned regimes with rate-effective-date tables; every tax code declares its regime; a mismatched return refuses to run (LEGACY-020).
- **Rounding**: one function, explicit mode, symmetric across sign, applied at persist time, rule recorded per currency and per tax code (LEGACY-019).
- **Payroll statutory pack (Malaysia):** EPF, SOCSO, EIS and PCB/MTD as versioned, effective-dated, **verified** rate tables pinned per payroll line; a run with an unverified or out-of-range table refuses; schedules and annual statements are generated from posted data and tie to the scheme payable accounts to the cent (§3.10). The same discipline as the tax engine — no rate lives in code, and a rate change is a seed PR, not a release.

## 4.8 Reliability and operations — **[v1]** except SLA

- **RPO/RTO stated as numbers**, tested quarterly by an actual restore drill (LEGACY-081).
- Continuous WAL archiving with **point-in-time recovery**; automated backups; restore verified automatically, not assumed.
- HA: managed Postgres with a standby; stateless application tier; read replicas for reporting.
- Zero-downtime deployments; **expand/contract migrations** so schema change never requires a maintenance window (the direct answer to LEGACY-080).
- Graceful degradation: if the reporting store is down, transactional entry continues.
- **Status page**, incident communication policy, published SLA with credits. *(deferred)*
- Runbooks and blameless post-incident reviews *(v1)*; a formal on-call rotation *(deferred — one person cannot rotate)*.

## 4.9 Observability — **[v1]**

- Structured JSON logs with tenant, user, request and trace ids on every line. **Never log credentials, tokens, or full PII.**
- Distributed tracing; RED metrics per endpoint; USE metrics per resource.
- **SLOs with error budgets** for: API availability, p95 latency on document post, report generation time, sync lag for offline POS.
- **A ledger-integrity SLI**: a continuous job asserting `Σdebit = Σcredit` per tenant/period/company and that projections match a fresh rebuild. This alarm is the single most valuable thing you can build — it is the alarm the old system needed and never had.
- Product analytics on feature usage, to decide what of the 460 tables' worth of functionality actually deserves rebuilding.

## 4.10 Frontend and UX standards — **[v1]**

- **Design system** with tokens; one component library; documented in Storybook.
- **Accessibility: WCAG 2.2 AA** — keyboard operability, focus management, contrast, screen-reader labels. Keyboard operability is also what makes the app fast for your own staff.
- **RTL and LTR parity** on every screen and every generated PDF, including numerals, Hijri and Gregorian dates, and column order. The old system did this well; do not regress it.
- **Keyboard-first data entry** for high-volume screens: tab order, type-ahead pickers, keyboard shortcuts, no mouse required to enter an invoice. This is the single biggest adoption risk in replacing a mature desktop app.
- Optimistic UI with clear pending/failed states; offline-tolerant POS.
- Empty states, inline help, and a searchable in-app documentation surface.

## 4.11 Engineering practice — **[v1]**

- **Trunk-based development**, small PRs, mandatory review, conventional commits, generated changelog.
- CI on every PR: lint, type-check, unit, integration, migration-up/down, **tenant-isolation suite**, **ledger-invariant suite**, dependency audit, SAST, secret scanning, license scanning.
- **Test strategy proportional to risk:**
  - *Property-based tests* for money arithmetic, rounding and currency conversion.
  - *Golden-file tests* for the costing engine and every tax return — a fixture set of documents with expected ledger output, so any formula change is visible in a diff.
  - *Deterministic-rebuild test:* rebuild every projection from the ledger into scratch tables; compare row for row on the full key and every amount.
  - *Concurrency tests* that actually interleave transactions — the old system's LEGACY-049/051/052 would all be caught by a two-connection test.
  - *Load tests* against realistic data volumes (take the real row counts from the customer's live database before sizing).
- Feature flags for progressive rollout; canary or blue/green deploys.
- **Architecture Decision Records** for every significant choice.
- Infrastructure as code; no manual production changes; **no DDL from application code** (LEGACY-053).
- Dependency update automation (Renovate) with a patch SLA.
- **Environments:** `dev` (local, Testcontainers), `staging` (a real Cloudflare Container against a staging Supabase project, seeded from an anonymised snapshot), `production`. Nothing reaches production without passing through staging.
- **Secrets:** never in the repository, never in `.env` files that are committed. Cloudflare secrets bindings for the container; Supabase vault or a KMS for anything the database needs; rotated on a schedule and on any suspected exposure. The inventory for v1: Supabase service-role key (seed CLI only), `app_rw` and `app_migrator` passwords, the **terminal-JWT signing key** (§3.7.5), the **HR field-encryption key** (§4.6, rotated with re-encryption as a pg-boss job), Sentry DSN, the code-signing certificate and its password (CI only).
- **Definition of done for any pull request:** tests added or updated · migration is reversible · OpenAPI updated if the API changed · both text directions checked if the UI changed · no new `⚠️` left unresolved in the code without a linked issue.

---

# PART V — BUILD PLAN

Each phase has a **definition of done that is testable**, not a feature list. §5.0 lists the first concrete tasks so work can begin without inventing them; §5.2 fixes the repository layout.

**Scoped to the confirmed decisions in §3.0:** one business, office + branches, cloud database, Windows desktop apps, **four modules (D20)**. Phase 8 is **HR & Payroll [v1]** (§3.10). Phase 10 (other verticals) is **deferred indefinitely** — build it only if a paying customer ever asks. Phase 5 is narrowed to one jurisdiction. Everything in Part IV marked deferred in §3.0.1 is out.

| Phase | Scope | Definition of done |
|---|---|---|
| **0 · Foundations** | Monorepo + CI, Cloudflare Container + Worker skeleton, tenancy + RLS, Supabase Auth integration, RBAC, append-only audit log, Electron shell for the back office, i18n/RTL shell, currency & rate service, dimension framework, custom-field service, migration tooling, ledger-integrity job skeleton (§5.0) | A tenant is created, users invited, roles assigned; every write audited with server-supplied actor; the tenant-isolation suite passes against every endpoint |
| **1 · Ledger** | Chart of accounts, fiscal periods & locking, **a single hand-written `JOURNAL` document type with policy v1** (Phase 2 generalises this into the policy engine), immutable `LedgerEntry`, numbering via `document_series`, `account_balance` via `MERGE`, trial balance, integrity checker | Σdebit = Σcredit holds under fuzz testing; projections rebuild **bit-identically**; a locked period cannot be altered through any path including import; the first PITR restore drill has been run against staging and written up as a runbook (§4.8, acceptance test 24) |
| **2 · Parties & documents** | Party model, `DocumentType` + versioned `PostingPolicy`, draft→issued→posted→reversed state machine with `document_event` and the R1/R2 status trigger, numbering, templates, **attachment service** (object storage, opaque ids, hash — §3.3) | **A new document type is added with zero code**; issued numbers are unique and gapless-provable |
| **3 · Inventory** | Items, exact-rational UoM, warehouses, **lots with expiry**, variants, movements, **cost layers**, **landed cost allocation** through an import-shipment document, **sales and purchase orders** (non-posting, open-quantity tracked), **goods receipt with GRNI accrual**, **delivery orders**, certificates and permits attached per lot, **stock counts with variance posting**, **two-step inter-branch transfers with an in-transit state**, **expiry write-off**, free-of-charge lines, price lists, valuation (§3.0.4). Serials only if §3.0.3 confirms them. | Back-dated purchase recosts only forward, in bounded time, with a visible adjustment entry; FEFO picking returns the earliest-expiring lot; a landed-cost allocation changes unit cost and every downstream margin; a stock count posts only the variance; goods in transit are in neither warehouse's on-hand and in the company's total |
| **4 · AR/AP** | Invoices, credit notes, receipts/payments, allocation, ageing, credit limits, payment terms, **bank reconciliation** (statement import, matching, unreconciled report), post-dated cheques ⚠️ (§3.0.4) | Ageing report reconciles to the ledger to the cent; a month is bank-reconciled with every receipt and payment matched or listed as unreconciled (till bankings and payroll batches join the same matching when Phases 6 and 8 land — test 39) |
| **5 · Tax** | **Malaysia only** for v1, as a pluggable jurisdiction pack. Tax codes, inclusive/exclusive, returns, e-invoicing hooks, transmission log. ⚠️ Verify current LHDN requirements first. | The return is generated, validated and reconciled end-to-end against a golden fixture |
| **6 · POS** | Shop POS application (§3.7.6), catalogue down-sync, outbox up-sync, shifts and cash reconciliation, offers, returns, loyalty ⚠️ *(confirm — §3.0.3)*, **the minimal employee master and `pos_cashier`** (cashiers are employees — §3.10.2), clock-in/out as `attendance_event`, **till cash lifecycle** ⚠️ (paid-outs, safe drops, banking — §3.0.4), server-side re-verification of cashier authority at sync apply | A till sells 8 hours offline and reconciles with **zero duplicates and zero lost tickets**; the shift Z-report ties to the ledger to the cent |
| **7 · Reporting** | Report definition format, server-side render (PDF/XLSX/CSV), ~60 parameterised core reports, saved views, financial-statement layouts, tenant data export in open formats (§4.3 — v1) | A user clones and edits a report without a release; every report's numbers tie to the ledger |
| **8 · HR & Payroll** *(v1 — D25)* | §3.10: employee master and sensitive data, effective-dated compensation and pay components, statutory schemes as versioned verified rate tables, PAYROLL / PAYROLL_PAYMENT / EMPLOYEE_ADVANCE document types and statutory remittances, payslips and monthly schedules, `employee_ytd` projection, a minimal leave register ⚠️ *(only if the owner confirms — §3.10.1, Part VII item 14)*, attendance events, termination flow, five HR reports | The business's real monthly payroll runs in Dulja **in parallel with the legacy system for one month**: every gross, statutory and net figure matches the legacy run and the authorities' calculators to the cent, or every difference is explained in writing and accepted by the owner; the run posts through the posting service under pinned policy and rate-table versions; Σ payslip net = salaries-payable credit; each scheme's schedule = its payable to the cent; preparer ≠ approver is enforced by the data layer; `employee_ytd` rebuilds bit-identically |
| **9 · Migration** | Importer reading the live legacy Firebird database → Dulja. Items, customers, suppliers, open balances, open documents, batch/expiry positions, **employee master and current-tax-year YTD** (§5.1 items 11–12). | Trial balance **and** stock valuation match the source on the cut-over date, and the difference on every recomputed figure is explained (§5.1); each employee's imported YTD reconciles to their last legacy payslip |
| **10 · Other verticals** *(deferred)* | Fixed assets and depreciation (manual JOURNALs until then), service contracts and maintenance, purchase-requisition and PO-approval workflow. **Do not build in v1.** The clinic, school and aviation modules should very likely never be built. | Each vertical ships and upgrades independently of the core |

**Sequencing notes.**
- POS moved ahead of Reporting because it is revenue-critical for the business and because it depends only on Phases 1–5. It cannot start earlier: it needs items and prices (Phase 3), payment and credit-limit handling (Phase 4), and tax on receipts (Phase 5).
- Reporting is not really one phase. A minimal set — trial balance, ledger, stock on hand, sales by item — ships continuously from Phase 1 onward, because you cannot verify any earlier phase without being able to read the numbers. Phase 7 is when the *report builder* and the full catalogue land.
- **HR & Payroll (Phase 8) depends on Phases 1, 2 and 4** — ledger; documents, policies and `document_event`; payments — and on Phase 6 for the minimal employee master, `pos_cashier` and the clock-in feed: whichever of Phases 6 and 8 starts first builds the minimal `employee` table (§3.10.1). It may start as soon as Phase 4 is green and run alongside Phases 5–7, and it must be complete before Phase 9: the first month after cut-over needs a payroll run, and Phase 9 imports the employee master and year-to-date figures. The legacy Salaries module keeps running until then.
- Do not start Phase 10 until Phases 1–3 have been running in production for a customer. The old product's fatal structural error was welding verticals into the core before the core was sound.

## 5.0 Phase 0 backlog — the first tasks, in order

Each item is small enough to be one pull request and has an acceptance check. Do them in this order; later items depend on earlier ones.

| # | Task | Done when |
|---|---|---|
| 0.1 | Scaffold the monorepo (§5.2) with Bun, Turborepo, oxlint/oxfmt, TypeScript strict, a shared `tsconfig`, and GitHub Actions running lint + typecheck + unit on every PR | CI is green on an empty repo; a deliberate lint error fails it |
| 0.2 | Provision Supabase (Singapore): project, PITR enabled, roles `app_migrator`, `app_rw` (no `BYPASSRLS`; `timezone=UTC`) and `app_auth` (`NOLOGIN`, no attributes — `BYPASSRLS` needs a superuser to grant and Supabase's `postgres` is not one; granted to `app_migrator` so migration 0001 can transfer ownership of `resolve_principal` to it — §3.8), session-mode connection strings for the container, a staging project alongside | Connection from a local Bun script succeeds as `app_rw` on port 5432; a `BYPASSRLS` probe as `app_rw` fails; `app_auth` cannot log in and has no `BYPASSRLS`; a transaction-mode (6543) connection string is not present in any config |
| 0.3 | Migration tooling: Drizzle Kit wired to `packages/db`; migration `0001_foundations.sql` from §3.8 applied to dev and staging; a CI job applies all migrations to a Testcontainers Postgres and runs the down path | Fresh database + all migrations = identical schema to staging (compared with `pg_dump --schema-only -n app`) |
| 0.4 | The **CI schema linter**: fails the build for any table without `tenant_id`, without an RLS policy, without `FORCE ROW LEVEL SECURITY`, or without the audit trigger | Add a bare table in a test branch → CI fails with the table named |
| 0.5 | Cloudflare Container skeleton (§3.2.4): `api` and `worker` classes from one image, a Worker in front forwarding `/v1/*` via the container binding, a Cron Trigger keeping `worker` awake; deploy to staging via GitHub Actions | `/healthz` returns 200 through the Worker and the container is unreachable directly; a scheduled job runs in `worker` while `api` is idle; deploy is one command |
| 0.6 | Supabase Auth integration: the API verifies the JWT against Supabase JWKS, calls `app.resolve_principal(sub)` (the one SECURITY DEFINER door, owned by `app_auth` — §3.8) to obtain `tenant_id` and `principal_id`, and the `withTenant(tx => …)` helper pins READ COMMITTED, issues `set_config(..., true)` first in every transaction, and retries once on `40P01`/`40001`; a lint forbids bare `db.` calls; a middleware rejects any request without a resolvable membership; the `aal2` gate applies to every route except MFA enrolment | Tenant-isolation test: two tenants, every endpoint, zero cross-tenant reads or writes; connected as `app_rw` with no `set_config`, `resolve_principal(<subject>)` returns one row while `select * from app.principal` returns none |
| 0.7 | RBAC tables per the amended §3.8 (`role.is_system`, `permission.module`/`mutating`, `role_assignment.granted_by`/`granted_at`/`expires_at`, `role_assignment_branch`, `app.actor_has()`, the `forbid_self_grant`, `assert_assignment_kind`, `keep_last_admin_*` and `stamp_actor` triggers) + the permission catalogue file with the Phase 0 codes + the nine seeded system roles (`packages/db/seed/roles.ts`) + the "who can do X in company Y (at branch B)" query; the build fails on a permission no code evaluates, on a seeded role other than `admin` holding an incompatible pair, and on a mutating code in `auditor` | Acceptance test 14 passes; the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36 pass against the Phase 0 catalogue; the branch-scoping assertions of test 36 are re-run in each phase that adds the entities they name |
| 0.7b | **Bootstrap seed** — `bun run seed`, an offline CLI run as `app_migrator` (never an API endpoint — LEGACY-039), following the six-step sequence in §3.8 exactly: tenant → system principal → owner's Supabase auth user (admin API) + human principal + membership → first company, BRANCH dimension, the nine system roles and the owner's `admin` assignment (granted by the system principal, so the no-self-grant rule holds) → Malaysia seed pack from `packages/db/seed/my/` | Running it twice changes nothing; the principal + membership inserts succeed under `FORCE ROW LEVEL SECURITY` (regression test for v1.1 fix #2); the owner logs in, enrols MFA at `aal1`, and sees an empty but fully configured company |
| 0.8 | Append-only, hash-chained audit log with the generic **AFTER ROW** trigger attached by the migration generator, including the `current_tenant()` variant for `principal` and the `id` variant for `tenant` (§3.8) | Acceptance test 13 passes; a manual `UPDATE app.audit_log` as `app_rw` is refused; inserting a `principal` produces exactly one audit row with a non-null `tenant_id` |
| 0.9 | Currency + exchange-rate service with `rate_source`; `Money` type in `packages/domain` with the lint rule forbidding `number` for money | Property tests: `a + b − b = a` for 10⁶ random Money values; adding two currencies is a type error |
| 0.10 | Dimension framework (type/value tables + API) and custom-field service (typed definitions + values + validation) | A new dimension and a new custom field are created through the API with no migration |
| 0.11 | pg-boss wired into the container; a job enqueued **inside** a posting transaction is visible only after commit and never on rollback; the ledger-integrity job scaffolded (runs, reports "no ledger yet") | A test rolls back a transaction that enqueued a job; the job never runs |
| 0.12 | i18n/RTL shell: i18next with `en` and `ar` catalogues, `dir` switching, Tailwind logical properties, the CI check for hard-coded strings and incomplete catalogues | A screen renders correctly in both directions; a hard-coded string fails CI |
| 0.13 | Electron shell for the back office: electron-builder producing a Windows installer from `apps/backoffice`, signed with the **owner-supplied** code-signing certificate (an owner dependency — see §5.3), security posture per §3.7.2, auto-update against a staging feed on R2, Supabase refresh token kept in Electron `safeStorage`. ⚠️ Verify here and record an ADR: electron-builder resolving dependencies from a **Bun workspace**, and `better-sqlite3` rebuilt against **Electron's Node ABI** (`@electron/rebuild`); if either fails, `apps/desktop` keeps its own npm lockfile | Installer runs on a clean Windows VM without an unsigned-publisher warning; renderer cannot reach Node; the token is not readable from disk in plain text; `better-sqlite3` loads inside the packaged app |
| 0.14 | Observability: OpenTelemetry traces from Worker → Container → Postgres with a shared `request_id`; Sentry in API and Electron; structured logging with the forbidden-field lint | One request is visible end to end in the trace viewer with tenant and actor attached |
| 0.15 | ADR directory, `CONTRIBUTING.md` with §0.2 and §3.9 inlined, and the PR template carrying the definition-of-done checklist from §4.11 | A PR cannot be opened without the checklist |

**Phase 0 exit:** every row above green (0.1 → 0.7, 0.7b, 0.8 → 0.15), plus acceptance tests 12, 13 and 14 passing in CI. Only then does Phase 1 (the ledger) begin.

## 5.1 Migration from the legacy system — specific hazards

The source data contains the consequences of Part I. Do not import it naively.

1. **Do not trust stored aggregates.** `AccTotals`, `AccObjects`, `AccCurTotals`, `MatTotals`, `MatObjects`, `MatQuantity`, `MatCosts`, `MatStatus` are all known to drift (LEGACY-001 → 006, 049, 050). **Recompute everything from `VouItems`/`BillItems`** and reconcile; where the recomputed figure differs from the stored one, report the difference to the customer rather than silently picking one.
2. **Expect unbalanced vouchers.** Nothing prevented them (LEGACY-003). Detect them, quantify them, and agree a treatment (suspense account) with the customer *before* migrating.
3. **Expect orphaned references.** `Job` 82% and `CostCentre` 81% unconstrained (LEGACY-073); the shipped `fixes/fix-Jobs.sql` and `fix-finals.sql` prove orphans occur. Report orphans; do not silently null them.
4. **Expect NULL-poisoned balances and costs** (LEGACY-007, 011). These will appear as blank or zero, not as errors.
5. **Expect duplicate aggregate rows** for `MatObjects`/`MatQuantity` (LEGACY-049).
6. **Do not import cost figures.** `MatCosts` has no rebuild path and multiple corruption routes. Recompute cost from movement history with the new engine, and reconcile the resulting opening valuation with the customer.
7. **Passwords cannot be migrated** — they are cleartext (LEGACY-028). Force a reset for every user; do not import the column.
8. **Document numbers may contain duplicates and gaps** (LEGACY-051). Preserve them as historical strings; start the new gapless series after cut-over.
9. **Report definitions live as blobs in the customer's database** (LEGACY-077). Extract and catalogue them early — it is the only way to know which of the 255 templates the customer actually uses.
10. **Scope first, migrate second.** Run row counts per table against the live database before designing the importer. 460 tables is the shipped surface, not the used surface.
11. **Legacy payroll data.** Import the employee master and each employee's current-tax-year YTD (gross, each statutory share, PCB) and reconcile them to the last legacy payslips before the first Dulja run; never import `TaxLayers` or recompute history from legacy rate layers; `Lends` are stored in UI units — convert explicitly to `Money`. `Users.PIN` and `Users.Password` are never imported (LEGACY-028).
12. **Employees exist twice in the legacy data** — `Salaries.Employees` and `Accounts` rows flagged `IsEmployee` (§0.4). Map both to one `party` of kind employee plus one `employee`; report the rows that do not match rather than guessing.

---

## 5.2 Repository layout

One monorepo. Turborepo. Bun workspaces.

```
/
├─ apps/
│  ├─ api/            Bun + Hono. Routes, middleware, OpenAPI. Deploys to the Cloudflare Container.
│  ├─ worker/         pg-boss job handlers (costing replay, integrity check, tax submission, sync apply).
│  │                  Same container image as api/, different entrypoint.
│  ├─ edge/           Cloudflare Worker: auth pre-check, rate limiting, update-feed delivery from R2, forward /v1/* to the container.
│  ├─ backoffice/     React 19 + Vite + TanStack. The main system UI. Packaged by Electron from apps/desktop.
│  ├─ pos/            React 19 + Vite + TanStack. The shop POS UI. Local SQLite via the Electron main process.
│  └─ desktop/        Electron main process, preload/contextBridge, electron-builder config, auto-update.
│                     Two build targets: backoffice.exe and pos.exe, from the two apps above.
├─ packages/
│  ├─ domain/         Pure TypeScript. Money, Quantity, posting policy evaluation, costing engine, tax engine.
│  │                  No I/O, no framework imports. This is where the golden tests live.
│  │                  payroll/: the statutory calculators and the rate-table JSON schema (§3.10); core never imports HR.
│  ├─ db/             Drizzle schema, migrations (SQL), the schema linter, seed data packs (country/chart-of-accounts/document types),
│  │                  seed/roles.ts (the nine system roles and the incompatible-pair list), seed/my/statutory/ (rate tables with source and verification metadata).
│  ├─ contracts/      Zod schemas → OpenAPI → generated TypeScript client used by both desktop apps.
│  ├─ sync/           The POS sync protocol: cursor down-sync, outbox up-sync, reconciliation. Shared by api/ and pos/.
│  ├─ ui/             shadcn/ui components, design tokens, RTL-aware primitives, Storybook.
│  └─ i18n/           en and ar catalogues, ICU helpers, Hijri formatting, the completeness checker.
├─ tests/
│  ├─ regression/     legacy-NNN.test.ts — one per Part I defect the code touches.
│  ├─ invariants/     ledger-balance, tenant-isolation, projection-rebuild, audit-chain.
│  ├─ golden/         costing, tax and payroll fixtures with committed expected output.
│  └─ e2e/            Playwright, both text directions, against staging.
├─ docs/
│  ├─ adr/            Architecture Decision Records, numbered. Start from the decision log in §0.3.
│  ├─ review/         Dated review reports (the 2026-09-04 review that produced v1.1 is the first).
│  ├─ superpowers/plans/  Dated implementation plans, one per phase slice (Plan 0A first).
│  └─ spec/           This document and its companion dossier, versioned with the code.
├─ infra/             Cloudflare (wrangler) config, container Dockerfile, GitHub Actions, Renovate.
├─ CONTRIBUTING.md    §0.2 and §3.9, verbatim.
└─ CLAUDE.md          Entry point for the implementing agent: the §0 reading order, pointers to CONTRIBUTING.md and
                      docs/spec/, the "never / always" lists from §0.2, and which phase is currently in progress.
```

**Dependency rule, enforced by the linter:** `domain` imports nothing from the other packages. `db` and `contracts` import `domain`. `api`, `worker`, `pos`, `backoffice` import from packages, never from each other. `desktop` imports only build outputs. Anything that violates this is a bug in the architecture, not a style issue.

## 5.3 Owner dependencies — things only the owner can supply

The agent will block on these; provide them before the phase that needs them.

| Needed by | Item |
|---|---|
| Before 0.2 | Sign-off on the v1.1 changelog rows marked *Confirm* or *Decide* (the two RLS corrections in §3.8; loyalty in POS v1) |
| 0.2 | Supabase organisation access (production + staging projects, Singapore) and billing enabled for PITR |
| 0.5 | Cloudflare account with Containers enabled; a domain for the API and update feed |
| 0.7b | The owner's login email; the company's legal name, base currency (MYR), fiscal-year start; the Supabase service-role key for the seed CLI |
| 0.13 | A **Windows code-signing certificate** (OV or EV) — without it every install shows an unsigned-publisher warning |
| 0.14 | Sentry organisation (or the go-ahead to create one) |
| 0.7 | Confirmation of the nine role names in §4.2.1 |
| Phase 3 | Confirmation of every ⚠️ row in §3.0.3 and §3.0.4, and the v1 costing method (§3.4) |
| Phase 5 | LHDN MyInvois credentials and the current requirement set (§4.7) |
| Phase 6 | The list of cashiers per branch; the alias e-mail domain for staff without a mailbox (every cashier gets a Supabase auth user — §3.7.5); the till cash-control answers (§3.0.4) |
| Phase 8 | Employer registration numbers per authority; the current EPF/SOCSO/EIS/PCB tables and the authorities' worked examples, transcribed and signed off by the accountant; the staff list with branch, employment type, bank and statutory numbers; pay-period and pay-date conventions; answers to the ⚠️ items in §3.10.1 |
| Any UI work | Screenshots of the equivalent legacy screens and a short description of how a fast operator uses each (§0.2) |
| Phase 9 | Read access to the live legacy database, and the Firebird version |

---

# PART VI — ACCEPTANCE TESTS

The bar for "we have not inherited the old system's defects." Every one maps to a Part I finding.

| # | Test | Guards |
|---|---|---|
| 1 | **Ledger invariant.** For any tenant, period and company: Σdebit = Σcredit. Enforced continuously, alerted on breach. | LEGACY-003 |
| 2 | **Deterministic projections.** Rebuild every projection from the ledger into scratch tables; compare row for row on the full key and all amounts. Identical. | LEGACY-001, 002, 013, 049, 050 |
| 3 | **Re-key a posting.** Post to account A, re-key to a never-used account B. `sum(balances) == sum(postings)`. | LEGACY-002 |
| 4 | **Multi-tenant aggregate.** Two tenants post to the same account+currency concurrently; each sees only its own. | LEGACY-001, 035 |
| 5 | **Back-dated costing.** 12 months of movements; insert a purchase dated month 3. Only months 3–12 recompute; adjustment is visible and explained; runtime proportional to affected movements, not total history. | LEGACY-004, 005, 010 |
| 6 | **Costing edge cases.** Return exceeding stock; wash line at zero stock; value-less movement. All rejected or handled; **no negative, NULL, or exploded cost is ever stored**. | LEGACY-007, 008 |
| 7 | **One costing answer.** Stock valuation and profit reports tie to the cent for an item that has been transferred, gone negative, and had a supplier return. | LEGACY-009 |
| 8 | **Multi-currency round-trip.** Invoice EUR, part-pay USD, settle in base, revalue at period end. FX gain/loss posts correctly; party balance correct in all three currencies; `base = round(value × rate)` holds on every line. | LEGACY-011, 012, 014 |
| 9 | **Period lock.** Once locked, no write alters any entry in it by any path — API, import, admin, background job. The only remedy is a reversing entry in an open period. | LEGACY-031, 041 |
| 10 | **Approval authority.** A user cannot set a document's approval state above their own authority through any endpoint or side effect. | LEGACY-032 |
| 11 | **No auth bypass.** No parameter, header, session variable or stored procedure grants elevated privilege. Automated test attempts every known bypass shape. | LEGACY-025, 026, 027, 030, 042 |
| 12 | **Tenant isolation.** Every endpoint and every background job attempts cross-tenant read and write; all rejected at the data layer. | LEGACY-035, 036 |
| 13 | **Audit completeness.** Every write produces an audit record with a server-supplied actor. No flag suppresses it. The application role cannot UPDATE or DELETE audit rows. Hash chain verifies. | LEGACY-029, 030, 040 |
| 14 | **Permission query.** "List every user who can post a purchase return in company X" is answerable in one SQL query. | LEGACY-034, 047 |
| 15 | **New document type, zero code.** Define "Consignment return" purely as configuration; it numbers, posts, prints, reports and reverses correctly. | RC-3 |
| 16 | **Numbering.** Concurrent creation of the first document of a new type succeeds for both. Issued numbers are unique per (series, period). Deletion of an issued document is impossible. Voided numbers are recorded. | LEGACY-051 |
| 17 | **Serial uniqueness under concurrency** *(only if serials are in scope, §3.0.3)*. Two terminals scan the same serial simultaneously; exactly one sale succeeds. | LEGACY-052 |
| 18 | **Stock availability.** Negative stock is rejected by the data layer regardless of session flags, user attributes, or write path. Overrides are explicit and audited. | LEGACY-048 |
| 19 | **Offline POS.** 500 tickets sold with the network down; reconnect; zero duplicates, zero lost tickets. Re-sending the same batch twice changes nothing. | LEGACY-051 |
| 20 | **Catalogue resume.** Kill the down-sync mid-transfer; resume from the cursor; the till's catalogue matches the back office exactly, with no row applied twice and no deletion missed. | — |
| 21 | **Shift reconciliation.** A shift's Z-report — opening float, tenders by type, over/short — ties to the ledger to the cent. | — |
| 22 | **One posting path.** A POS ticket and an equivalent back-office invoice produce identical ledger entries and cost consumptions after projecting out `id`, `document_id`, `posted_at`, `posted_by`. | LEGACY-009 |
| 23 | **RTL/LTR parity.** Every screen and generated PDF renders correctly in Arabic and English, including numerals, Hijri/Gregorian dates and column order. | LEGACY-085 |
| 24 | **Restore drill.** Restore to an arbitrary point in time; the trial balance computed from the restored ledger equals the trial balance the live system reported at that timestamp, and the audit chain verifies up to that point. | LEGACY-081 |
| 25 | **Zero-downtime migration.** A schema change deploys with no maintenance window; duration is proportional to the change, not the data. | LEGACY-080 |
| 26 | **Tax return determinism.** A golden fixture of documents produces a byte-identical return across runs; a tax code from the wrong regime causes a refusal, not a wrong number. | LEGACY-020, 058, 059 |
| 27 | **No SQL text across the API.** Automated check that no endpoint or procedure parameter is interpolated into a query. | LEGACY-036, 037 |
| 28 | **One payroll posting path.** A PAYROLL run and a hand-keyed JOURNAL with the same lines produce identical `ledger_entry` and `ledger_entry_dimension` rows after projecting out ids and timestamps. | LEGACY-003, 009 |
| 29 | **Rate-table pinning.** Run M calculates with the table effective at M; inserting a later version leaves M's posted lines, payslips and ledger byte-identical; a supplementary run in M+1 pins the new version; an unverified table, or one that does not cover the period, is refused (`ERR_PAYROLL_RATE_TABLE_UNVERIFIED`). | LEGACY-013, 020 |
| 30 | **Payslip ties to the ledger.** For every employee in a run: payslip net = credit to salaries payable tagged EMPLOYEE; Σ(employee + employer share) per scheme = credit to that scheme's payable; the monthly schedule per scheme equals that payable to the cent; a remittance for a different amount is refused. | LEGACY-011, 019 |
| 31 | **Segregation of duties.** The submitter of a PAYROLL, PAYMENT, PAYROLL_PAYMENT, EMPLOYEE_ADVANCE or STOCK_COUNT cannot approve or post it through any path — API, job, or direct SQL as `app_rw`; a principal cannot alter their own compensation, sensitive data or leave approval; a principal cannot change their own role assignments or the permissions of a role they hold. | LEGACY-032, 042 |
| 32 | **Sensitive fields have no side channel.** A principal without `hr.employee.read_sensitive` receives no identity, bank or statutory-number fields; one without `hr.compensation.read` receives no `compensation_line` or `employee_statutory_profile` rows (posted `payroll_line` amounts are gated by `hr.payroll.read`) — through any endpoint, filter, sort, search or export, checked over the OpenAPI document and by direct `app_rw` query under `withTenant`. | LEGACY-033, 045 |
| 33 | **Golden payroll.** An owner-verified fixture — employees, profiles, compensation, rate tables — produces byte-identical payroll lines, ledger entries, payslips and schedules across runs; a missing statutory input fails the run naming the employee, never a silent zero. | LEGACY-011, 020 |
| 34 | **Termination closes everything.** Setting `terminated_on` — including by direct `app_rw` SQL — revokes `pos_cashier` and expires every `role_assignment` in the same transaction (trigger); the next catalogue down-sync tombstones the cashier; a till that has applied the cursor rejects the PIN; the employee is excluded from the next regular run. | LEGACY-021, 044 |
| 35 | **YTD rebuild and recalculation.** `employee_ytd` rebuilt from opening rows plus posted lines matches the maintained projection row for row; recalculating a submitted run returns it to draft and voids the pending approval; a rate table can be verified only by a principal other than the one who loaded it. | LEGACY-004, 016 |
| 36 | **Role catalogue integrity and scoping.** Every code in the catalogue is evaluated by a handler and vice versa; no seeded role other than `admin` holds an incompatible pair; `auditor` holds no mutating code; a `branch_manager` at branch A cannot read or write documents, shifts, stock, attendance or tickets of branch B through any endpoint, filter or export; an expired assignment grants nothing; "who can approve payroll in company X" and "who can reset a PIN at branch B" are each one SQL query. | LEGACY-034, 042, 045, 047 |
| 37 | **POS authority re-verified server-side.** A ticket whose discount exceeds the branch limit, a void, or a blind return is rejected at sync apply unless it carries an override by a principal other than the cashier who holds the permission at that branch; rejected tickets land in needs-attention, never in the ledger. | LEGACY-027, 048 |
| 38 | **Payroll period lock.** A run whose period is closed or locked cannot post by any path until a principal with `accounting.period.reopen` reopens it with a reason; the reopen is audited and reported. | LEGACY-031 |
| 39 | **Bank reconciliation.** A month's statement import matches every receipt, payment, payroll batch and till banking or lists it as unreconciled; matching never alters a ledger entry; the reconciled balance equals the bank account's ledger balance. | LEGACY-031, 041 (matching never alters a posted entry); RC-2 |

---

# PART VII — OPEN QUESTIONS

These could not be settled from the shipped files and must be answered before design freeze. Several materially change scope.

1. **Which modules are actually used?** 460 tables is the shipped surface. **Run row counts per table against the live database.** The hospital (50 tables), academy (44), and aviation (`Airports`, `Aircrafts`, `SkyRoutes`) modules may be entirely dead weight — this could halve the rebuild.
2. **Data volume and history depth.** Row counts on `Journal`, `BillItems`, `VouItems` and the date range determine whether costing replay is currently a live pain point and how long migration will take.
3. **Malaysian e-invoicing specifics.** Malaysia is confirmed as the first jurisdiction (§0.3). What remains open is the *current* LHDN MyInvois requirement set — thresholds, mandatory fields, schema version, submission API. Verify against the authority's own current documentation before Phase 5; do not rely on this document or on training data for deadlines or schema versions.
4. **Is `Users.Password` hashed client-side?** Changes the migration plan (forced reset vs. rehash-on-login). The schema has no salt or algorithm column either way, so a forced reset is the safe default.
5. **Firebird version in production.** Determines whether the UDF path still works and how data can be extracted (`gbak` vs ODBC vs direct file read).
6. **Actual DDL constraints.** Several findings (LEGACY-024, 049, 051, 066, 074) rest on the schema dump's key convention rather than real DDL. Confirm against `RDB$RELATION_CONSTRAINTS` and `RDB$INDICES` before rating them.
7. **Does `MatOpens.Job` ever differ from 0 in production?** LEGACY-022 is a hard failure if so, and inert if not.
8. **Which of the 255 report templates are in use?** They live as blobs in the customer database; extract and catalogue them.
9. **Customisations.** The `Special`, `rah*` and `spr*` modules are customer-specific. Catalogue them before assuming the stock feature set.
10. ⚠️ **Must historical POS *data* migrate?** The POS application itself is being rebuilt (§3.7). The open question is whether past tickets in the old `mpos` schema need to come across, or whether the new POS starts clean at cut-over with only the catalogue. Starting clean is far cheaper; confirm it is acceptable.
11. **The UI.** Screens, navigation, keyboard model and daily workflow are **not covered by this document** and must be sourced separately before UI work begins.
12. ~~Deployment model~~ — **settled** (§0.3): cloud-hosted Postgres, Electron desktop apps, Windows only, POS built in-house, first deployment is the owner's own business. Retained here only so the numbering in earlier discussions still resolves.
13. **Is the legacy Salaries module in live use?** Row counts on `Employees`, `Payrolls`, `PayItems`, `Lends`, `TaxLayers`. Determines whether Phase 9 imports only the employee master and current-year YTD (the default) or also historical payroll detail for viewing.
14. ⚠️ **HR facts only the owner knows:** does HRD Corp or any other employer levy apply; are foreign workers employed (work permits, different scheme applicability); is anyone hourly-paid or part-time; do staff buy stock at the shops on salary deduction; is a leave register wanted in Dulja or do leave records stay where they are today. Each changes §3.10.1 scope.
15. ⚠️ **Till cash and cheques:** do branches pay small expenses from the till and bank cash daily; does the business collect post-dated cheques. Decides the §3.0.4 rows marked ⚠️ in Phases 4 and 6.

---

# APPENDIX A — DEFECT INDEX

| ID | Sev | Title | Root cause |
|---|:--:|---|---|
| LEGACY-001 | C | Currency balances updated without the tenant key | RC-2 |
| LEGACY-002 | C | Upsert never fires on UPDATE; re-keying destroys the amount | RC-2 |
| LEGACY-003 | C | Nothing enforces debits = credits | RC-2 |
| LEGACY-004 | C | Cost advanced on INSERT only; no rebuild path exists | RC-2 |
| LEGACY-005 | C | Dirty flag never set on INSERT; back-dated docs never recosted | RC-2 |
| LEGACY-006 | C | Re-keying a line desynchronises cost aggregates | RC-2 |
| LEGACY-007 | C | Value-less production movements NULL-poison cost forever | RC-2 |
| LEGACY-008 | C | Cost can go negative, explode 10,000×, or be wiped to zero | RC-2 |
| LEGACY-009 | C | Three different weighted-average formulas | RC-5 |
| LEGACY-010 | C | `procCalcJobCosts` cannot compute job cost; incremental mode cannot run | RC-4 |
| LEGACY-011 | C | NULL arithmetic irreversibly nulls balances and tax boxes | RC-2 |
| LEGACY-012 | C | Base amounts never derived from value × rate; rate never validated | RC-2 |
| LEGACY-013 | H | Reversal reads current flags, not those originally applied | RC-3 |
| LEGACY-014 | H | `procSumVouItems` discards the caller's exchange rate | RC-4 |
| LEGACY-015 | H | Date window predicate can never be satisfied | RC-4 |
| LEGACY-016 | H | `MatStatus` min/max ratchet; INSERT-only maintenance | RC-2 |
| LEGACY-017 | H | Delivery tracking double-adds bonus; never reverses on re-point | RC-2 |
| LEGACY-018 | H | Return-line delete path unreachable; edit double-counts | RC-2 |
| LEGACY-019 | H | Rounding configured everywhere, applied nowhere, function wrong | RC-5 |
| LEGACY-020 | H | GST return hardcodes rate, ambiguous date, enum collision | RC-3 |
| LEGACY-021 | H | Accounts deletable with postings; generator rewinds and reuses IDs | RC-2 |
| LEGACY-022 | H | Singleton SELECT ignores a key column; hard-fails on multi-job opening | RC-4 |
| LEGACY-023 | M | Audit sequence renumbered retroactively; collides across classes | RC-2 |
| LEGACY-024 | L | Account codes from `max()` on a string, unlocked | RC-2 |
| LEGACY-025 | C | `procQuickLogin` grants admin with no credentials | RC-1 |
| LEGACY-026 | C | Session identity is client-writable context | RC-1 |
| LEGACY-027 | C | One client-settable variable disables every write-time control | RC-1 |
| LEGACY-028 | C | Passwords stored and compared in cleartext | RC-1 |
| LEGACY-029 | C | Audit trail records no actor; table freely writable | RC-1 |
| LEGACY-030 | C | A login parameter switches the audit trail off | RC-1 |
| LEGACY-031 | C | Period locks per-tier, on a sibling table, not on the lines | RC-1 |
| LEGACY-032 | H | User can raise a document's approval above their own | RC-1 |
| LEGACY-033 | H | Confidentiality is a display filter with a caller-supplied off switch | RC-1 |
| LEGACY-034 | H | `Grants` permission table never read by any code | RC-5 |
| LEGACY-035 | H | Tenant scoping is a client convention | RC-1 |
| LEGACY-036 | H | Six procedures accept a raw SQL predicate as a parameter | RC-4 |
| LEGACY-037 | H | Four procedures interpolate unescaped user strings | RC-4 |
| LEGACY-038 | H | Path traversal to arbitrary file write on the DB server | RC-1 |
| LEGACY-039 | H | `procInitDatabase` creates an admin, unauthenticated, unguarded | RC-1 |
| LEGACY-040 | H | Deletions logged less reliably than inserts | RC-1 |
| LEGACY-041 | H | Hard deletes; anti-tampering triggers shipped disabled | RC-1 |
| LEGACY-042 | M | Ownership/paid checks fail open on a missing user row | RC-1 |
| LEGACY-043 | M | Failed authentication returns a row instead of raising | RC-1 |
| LEGACY-044 | M | Session records caller-controlled, attributable to the wrong user | RC-1 |
| LEGACY-045 | M | Department scoping is a report parameter | RC-1 |
| LEGACY-046 | M | Site protection bypassable; two different flags share one name | RC-1 |
| LEGACY-047 | M | Only 7 of ~55 permission flags are read by the database | RC-1 |
| LEGACY-048 | H | Stock controls opt-in per user, with four bypasses | RC-1 |
| LEGACY-049 | C | Aggregate tables unkeyed; upsert race duplicates silently | RC-2 |
| LEGACY-050 | H | NULL dimensions accumulate orphans and lose decrements | RC-2 |
| LEGACY-051 | H | Numbering races, no uniqueness, cannot be gapless | RC-2 |
| LEGACY-052 | C | Serials can be sold twice; the check has no callers | RC-1 |
| LEGACY-053 | M | Runtime DDL disables integrity machinery mid-transaction | RC-6 |
| LEGACY-054 | H | Full recost aborts on the first historical below-cost sale | RC-2 |
| LEGACY-055 | M | FIFO stock ageing non-functional (`OR` for `AND`) | RC-4 |
| LEGACY-056 | H | Serial lookup length-based, non-sargable, silently wrong | RC-4 |
| LEGACY-057 | H | Serial enquiry expands blocks with a full scan per unit | RC-4 |
| LEGACY-058 | M | Tax item filters contradictory between union halves | RC-4 |
| LEGACY-059 | H | Tax query overflows its buffer on a normal VAT return | RC-4 |
| LEGACY-060 | M | `procFixMatStatus` mis-sorts and drops currency columns | RC-6 |
| LEGACY-061 | M | `procUpdateMatCosts` permanently resets cost to opening value | RC-6 |
| LEGACY-062 | L | Costing watermark written with the wrong document | RC-2 |
| LEGACY-063 | L | Unguarded division by `BtmSize` in six of eight places | RC-4 |
| LEGACY-064 | L | Copy-paste dead NULL guard; `BuyCur` never defaulted | RC-5 |
| LEGACY-065 | L | Unreachable dead code in the audit trigger | RC-5 |
| LEGACY-066 | L | Unit conversion defined in schema, applied nowhere | RC-5 |
| LEGACY-067 | H | Stock-on-hand replays all history under a forced plan | RC-4 |
| LEGACY-068 | H | 23 hardcoded plans, two pinning generated index names | RC-4 |
| LEGACY-069 | M | Queries rebuilt per call into fixed buffers | RC-4 |
| LEGACY-070 | M | Index coverage missing on the columns reports filter by | RC-6 |
| LEGACY-071 | L | Recursive tree check per row inside triggers | RC-4 |
| LEGACY-072 | H | Zero CHECK constraints; 544 booleans encoding exclusive states | RC-3 |
| LEGACY-073 | H | Referential integrity inconsistent for the same relationship | RC-6 |
| LEGACY-074 | M | 42 of 460 tables have no primary key | RC-6 |
| LEGACY-075 | M | Template placeholders never substituted in shipped objects | RC-5 |
| LEGACY-076 | M | 9% of the corpus is duplicate or near-duplicate | RC-5 |
| LEGACY-077 | M | Call graph unresolvable; dead code undetectable | RC-5 |
| LEGACY-078 | M | Behaviour-governing config in opaque blobs | RC-5 |
| LEGACY-079 | M | 44 repair objects, two ledgers, one broken guard | RC-6 |
| LEGACY-080 | H | Upgrade is a whole-database rebuild, console-only | RC-6 |
| LEGACY-081 | M | Backup/restore manual, whole-file, destructive, no PITR | RC-6 |
| LEGACY-082 | M | Licensing pinned to a hardcoded private IP | RC-6 |
| LEGACY-083 | H | One error handler in 33,179 lines, and it swallows | RC-5 |
| LEGACY-084 | M | Error messages not actionable; code convention broken | RC-5 |
| LEGACY-085 | M | English build never proofread; Arabic in English dialogs | RC-5 |
| LEGACY-086 | L | Vendor hardware config with mojibake and duplicate keys | RC-5 |
| LEGACY-087 | L | Hardcoded developer build paths in shipped metadata | RC-6 |

**By severity:** Critical 21 · High 33 · Medium 24 · Low 9 — **87 total.**
**By root cause:** RC-1 (no authenticated caller) 22 · RC-2 (derived state hand-maintained) 21 · RC-3 (flags not types) 3 · RC-4 (dynamic SQL) 16 · RC-5 (blobs, un-analysable) 14 · RC-6 (rebuild-based upgrade) 11.

---

# APPENDIX B — WHAT THIS DOCUMENT DOES NOT COVER

Stated plainly so nothing is assumed:

1. **The user interface.** No screens, menu tree, navigation, data-entry flow, keyboard model or daily workflow was observed. Do not invent it from this document.
2. **Client-side business logic.** The 15 compiled plug-in DLLs hold validation rules, calculation ordering, posting sequence and screen behaviour. None were examined. **Assume undiscovered business rules exist.**
3. **Live data.** No production database was accessed — no row counts, no volumes, no evidence of which modules are used.
4. **Report internals.** The list of 255 templates is verified; their internal structure is not.
5. **Actual DDL.** Constraints, indexes and domain definitions were read from the product's schema-generation source, not from a live database. Findings marked ⚠️ depend on this.
6. **Anything about the vendor's intent.** Every defect here is a statement about observable behaviour of shipped code, not about the people who wrote it. A 20-year-old codebase serving real businesses across several countries got a great deal right; Part I is what a replacement must not repeat, not a verdict on the original.

---

*Compiled 2026-09-04 from the installed tree of the legacy accounting system (version 4.1.2). 913 database objects / 33,179 lines of PSQL extracted and audited; 460 tables / 5,136 columns; 13,778 UI strings; 255 report templates; 9 shipped repair scripts. No file in the installation was created, modified or deleted.*
