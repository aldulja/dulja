# Dulja documentation review — 2026-09-04

**Scope.** Full read of both project documents — `rebuild-spec.md` (2,146 lines before edits) and `legacy-system-analysis.md` (894 lines) — followed by targeted corrections, the product rename to **Dulja**, and a Phase 0 implementation plan. Nothing was scaffolded and no code was written; implementation waits for the owner's go.

**Verdict.** The two documents are unusually rigorous for a rebuild brief: every defect is cited to a source line, the decisions are logged, the schema is written to be derived into a migration directly, and the phase gates have testable definitions of done. The plan is sound. Two defects in the reference schema, however, would have stopped Phase 0 at tasks 0.6 and 0.7b — nobody could have logged in and the seed could not have inserted its first principal. Both are corrected. The spec is now version **1.1** with a changelog; the dossier is re-scoped as the *what-it-is* companion.

**Changes applied.** 75 exact-anchor edits across three passes: 56 to the spec (15 changelog rows), 19 to the dossier. Originals were backed up before editing. No filenames changed.

**Needs the owner.** Three items, listed in the spec's changelog as *Confirm* / *Decide*, must be signed off before Phase 0 task 0.2:

1. The `principal` RLS policy split (changelog #2).
2. The `app_auth` role owning `resolve_principal`, with role-scoped policies instead of `BYPASSRLS` (changelog #3).
3. Whether loyalty points are in POS v1 (changelog #9).

---

## 1. Findings

Severity here is about *impact on the build*, not on the old system.

### Critical — would have blocked Phase 0

**F1 · The seed could never insert a principal.** `§3.8` defined `principal_in_tenant` as a USING-only policy that requires a `membership` row. Postgres reuses the USING expression as the WITH CHECK for INSERT when none is given, and `membership` references `principal`, so the very first principal insert would fail under `FORCE ROW LEVEL SECURITY`. *Fixed:* separate SELECT, UPDATE and INSERT policies; the INSERT policy requires only that a tenant is set on the transaction. The API and seed CLI insert principal + membership in one transaction. Regression check added to task 0.7b.

**F2 · Login resolution could never return a row.** `resolve_principal` was SECURITY DEFINER owned by `app_migrator`. The spec itself states that `app_migrator` is subject to `FORCE ROW LEVEL SECURITY`. The function runs *before* `set_config('app.tenant_id')`, so every policy evaluated to "no rows" and the function returned nothing — for every user, forever. *Fixed:* a dedicated `app_auth` role (`NOLOGIN`, no attributes) owns only this function and reads only `principal` and `membership`, through RLS policies scoped `to app_auth` rather than through `BYPASSRLS` — a superuser is required to create a role with `BYPASSRLS`, and Supabase's `postgres` role is not one, so the attribute-based version would have failed at provisioning on the chosen platform. Task 0.2 provisions the role; task 0.6 gains a two-sided CI check (the function resolves; a direct select on `principal` returns nothing).

### High — would have produced a wrong build

**F3 · The generic audit trigger could not attach to global tables.** Its contract set `tenant_id := coalesce(new.tenant_id, old.tenant_id)`, but `tenant`, `principal` and `permission` have no `tenant_id` column while `audit_log.tenant_id` is NOT NULL. The trigger was also unspecified as BEFORE or AFTER; the bootstrap's system principal is the actor of its own audit row, which is only valid if the audit insert runs *after* the principal row exists. *Fixed:* AFTER ROW stated; per-table variants stated (`tenant` → own id; `principal` → `current_tenant()`; `permission` → exempt).

**F4 · The 0.4 linter rule was self-contradictory.** It said every audit-exempt table must have no UPDATE/DELETE privilege for `app_rw`, but `account_balance`, `cost_layer` and `cost_consumption` are audit-exempt *and* are written by the posting service via `MERGE`. *Fixed:* the immutable list and the audit-exempt list are now stated as two different lists.

**F5 · D5 contradicted §3.2.2 on the test runtime.** D5 and §3.0 said Bun runs "tests"; §3.2.2 said Vitest runs under Node 24 because Vitest on Bun is unofficial. *Fixed:* D5 reworded toward §3.2.2. The decision is unchanged.

**F6 · Loyalty points were both in and out of v1.** §3.0.3 listed them as probably not needed; §3.7.6 and Phase 6 included them. *Marked ⚠️ owner-decide in all three places.*

**F7 · The dossier contradicted the spec in four places.**
- Its coverage matrix still said 1 of 382 procedure bodies and 0 of 318 trigger bodies were read, while the spec's Part I audits the whole corpus. *Fixed:* rows rewritten to defer to the spec.
- Only §8 carried a "superseded" banner; §9 (build order differs from Part V), §10 (10 tests vs the spec's 27) and §13 (items 6 and 7 are settled by D21 and D16) did not. *Fixed:* banners added.
- §7.1 concluded "API-first, browser + mobile clients. Non-negotiable", which contradicts D1 (Windows only, Electron). *Fixed:* API-first kept as settled; clients noted as deferred by D1.
- No pointer to the spec at the top. *Fixed:* purpose paragraph names Dulja and the companion document.

### Medium / low

**F8** · `account.parent_id`, `dimension_value.parent_id` and `document.reverses_document_id` used plain FKs, violating the schema's own composite-FK rule stated under `ledger_entry`. *Fixed.* `document.party_id` annotated as a Phase 2 FK.
**F9** · "ULID" in D17 and §3.7.3 versus uuidv7 in §3.9, patched by a footnote. *Fixed:* uuidv7 everywhere, footnote removed.
**F10** · Data export is tagged v1 in §4.3 but appeared in no phase; the quarterly restore drill from §4.8 likewise. *Fixed:* export in Phase 7; first drill in the Phase 1 definition of done.
**F11** · "16 databases" in the dossier's Appendix A header (17 are listed); "first fifteen tasks" (there are sixteen). *Fixed.* The 382-vs-372 procedure count and the ~11,000-vs-13,778 string count between the two documents are **flagged, not reconciled** — the dossier now states that the spec's later, complete extraction is authoritative.
**F12** · Electron + Bun friction was not called out: electron-builder's dependency resolution from a Bun workspace, and `better-sqlite3` needing a rebuild against Electron's Node ABI. *Fixed:* explicit verify-and-ADR item in task 0.13, with the fallback (`apps/desktop` keeps its own npm lockfile).
**F13** · Found while writing the Phase 0 plan's schema linter: `ledger_entry_dimension.entry_id` was a plain FK to a tenant-scoped table, against the schema's own composite-FK rule. *Fixed* (`ledger_entry` gains `unique (tenant_id, id)`); the linter now checks the rule for every FK. Also stated the convention that a `principal` insert must not use `RETURNING` before its membership exists (spec changelog #14, #15).
**F14** · With more than one tenant, the `principal_insert` policy alone would let tenant B pre-register tenant A's Supabase user and capture them. *Recorded as a Plan 0B API constraint* (principals are created only from a `sub` the API obtained through the Supabase admin invite call), noted in spec §3.8 and §4.2.

---

## 2. Deliberately not changed

- **Version claims** in §3.2 (PostgreSQL 18.3, Bun 1.4, Cloudflare Containers GA, oxfmt status). The document states these were verified in September 2026; D22 re-pins everything at scaffold time from the lockfile. Left as written.
- **Filenames.** `rebuild-spec.md` and `legacy-system-analysis.md` are cross-referenced by name inside both documents and §5.2 moves them to `docs/spec/` at scaffold anyway. Renaming now would only churn links.
- **Legacy-system references.** The legacy system is the one being replaced; every mention of it stays. (Superseded on 2026-11-17: the owner directed that the legacy vendor's name be removed from the repository — `docs/decisions/2026-11-17-legacy-naming.md`.) Only the unnamed *new* product became Dulja.
- **The spec's size** (219 KB, roughly 55k tokens per full read). See recommendation 3 below.
- **Anything about the UI.** Both documents are explicit that the UI is unspecified and must come from screenshots and operator walkthroughs. Nothing was invented.

---

## 3. Best-practice recommendations for keeping the project healthy

These are in rough priority order. Items 1 and 2 are folded into the Phase 0 plan as its first task.

1. **Put the documents under version control today.** The folder is not a git repository. The first commit should be the two documents plus this review, under `docs/spec/` and `docs/review/` per §5.2, so every later decision is a diff against a known baseline. ADR-0001 should simply adopt spec v1.1 as the baseline.
2. **Give the implementing agent one entry point.** A root `CLAUDE.md` (added to §5.2) that states the §0 reading order, the "never / always" lists from §0.2, and which phase is in progress. An agent that opens the repo cold should not have to discover the spec.
3. **Split the spec into one file per Part** under `docs/spec/` (00-how-to-use, 01-defects, 02-root-causes, 03-architecture, 04-saas-standards, 05-build-plan, 06-acceptance, 07-open-questions). An agent working on Phase 3 should be able to load §3.4 and the costing defects without loading the POS sync protocol. *Proposed, not done* — it changes how you reference the document, so it is your call.
4. **Enforce the phase gate mechanically.** A `PHASE` marker in the repo and a CI job that refuses to merge work tagged for phase N+1 while phase N's definition-of-done suite is red. The spec relies on discipline here; make it a check.
5. **Make the defect register greppable against tests from day one.** `tests/regression/legacy-NNN.test.ts` is already the convention. Add a CI script that lists every `LEGACY-###` referenced in the current phase's spec sections and fails if a corresponding test file is missing. Appendix A is the checklist.
6. **Run the risk spikes in week one, not when the phase arrives.** Five things could invalidate settled decisions and are cheap to probe on an empty repo: Arabic RTL glyph shaping in the chosen PDF engine (§3.2.2 already says week one); electron-builder + Bun workspace + `better-sqlite3` (task 0.13); pg-boss under Bun (task 0.11); Cloudflare Container sleep/wake latency and the Cron keep-alive for the worker (task 0.5); Supabase session-mode connection limits against the container's pool size (task 0.2).
7. **Secret scanning before the first commit that touches Supabase.** §4.11 lists the v1 secret inventory. Add a pre-commit hook and the CI secret scanner in task 0.1, not later.
8. **Windows development environment.** Testcontainers needs Docker Desktop with WSL2 on the owner's machine. Confirm it is available before task 0.3; otherwise CI is the only place migrations can be tested.
9. **Keep the owner-decision list short and dated.** §5.3 now has a "Before 0.2" row. Every ⚠️ in the spec should resolve into either an ADR or a dated owner decision; none should survive a phase boundary unanswered.
10. **Re-run this kind of review at each phase boundary.** The reference schema for Phases 2–3 (party, item, movement, cost layers) will be written during those phases and deserves the same RLS/bootstrap walk-through that caught F1–F4 here.

---

## 4. Assumptions made during this review

- **A1** — "Dulja" names the new product only. The legacy system kept its own name throughout (superseded on 2026-11-17 — `docs/decisions/2026-11-17-legacy-naming.md`).
- **A2** — Both filenames stay as they are until §5.2 moves them into `docs/spec/` at scaffold.
- **A3** — "The plan" means an executable plan for **Phase 0 (Foundations)**, derived from §5.0's sixteen tasks with the v1.1 corrections folded in. The spec's own gating rule means Phases 1–9 are planned when their turn comes, against a Phase 0 that has actually passed.
- **A4** — No `git init` and no commit were made; the repository is created as the first step of the plan, on the owner's go.

---

## 5. Where things are

| Artefact | Path |
|---|---|
| Specification, v1.1 | `rebuild-spec.md` |
| Dossier, re-scoped | `legacy-system-analysis.md` |
| This review | `docs/review/2026-09-04-dulja-docs-review.md` |
| Phase 0 implementation plan | `docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md` |
| Pre-edit backups | session scratchpad `backup/` (outside the project) |

---

## Addendum — 2026-09-05: four modules and a role catalogue (spec v1.2)

**Owner instruction (2026-09-05):** the system must include accounting, inventory, HR and POS, and a user-permission model with named roles such as admin and user.

**What the spec said before:** accounting, inventory and POS were in v1; **HR/payroll was explicitly deferred** (D20, §3.0.1, Phase 8 "Verticals — deferred"); RBAC existed as tables but with no named roles.

**How the change was made.** Three independent design proposals were produced from the spec and the legacy dossier — minimal (YAGNI-first), compliance-first, and daily-operator-first — and scored by three judges with different lenses (spec author, business owner, external auditor). All three judges chose the minimal proposal and listed the same grafts and rejections; the synthesis follows their verdict.

**Adopted (now in the spec):**
- **HR & Payroll is Phase 8 [v1]** (§3.10). Employee extends Party; sensitive data in an RLS-gated, field-level-encrypted table; effective-dated compensation and typed pay components; statutory schemes (EPF, SOCSO, EIS, PCB/MTD) as versioned, *verified*, effective-dated rate tables with no rate stated in the spec; a payroll run is a Document of type PAYROLL using the ordinary document state machine and the one posting service; net pay, statutory remittances and advances go through the Phase 4 payment machinery; a rebuildable year-to-date projection; POS clock-in feeds attendance events. The other verticals move to a new Phase 10 (deferred). Phases 1–7 and 9 keep their numbers.
- **Nine seeded roles** (§4.2.1): `admin`, `accountant`, `user`, `warehouse`, `branch_manager`, `cashier`, `hr_payroll`, `auditor`, `pos_terminal`; a `<module>.<resource>.<action>` permission scheme in five modules; branch scope through `role_assignment_branch`; one authorisation predicate `app.actor_has()` usable inside RLS policies; **eight segregation-of-duties rules enforced in the data layer** (§4.2.2), with maker ≠ checker read from an append-only `document_event`.
- **Module coverage map** (§3.0.4) as the checklist for the owner's instruction, and the gaps the panel found for an importer-distributor with branch shops: bank reconciliation, goods receipt with GRNI accrual, an import-shipment document for landed cost, delivery orders, stock counts, two-step transfers, expiry write-off, till cash lifecycle, post-dated cheques (⚠️), BRANCH mandatory on revenue/COGS/staff-cost lines.

**Rejected by the judges and therefore not adopted, although two of the three designers proposed them:** a `pin:` identity scheme for till-only cashiers (every cashier gets a real Supabase auth user via the admin API instead); splitting `admin` from an `owner` role (the spec's bootstrap makes `admin` the full-permission role); a runtime toxic-pair table (a CI lint on the seed suffices); a surrogate id and `branch_id` column on `role_assignment` (kept as a join table; branch scope is a child table); a leave register as default scope (now ⚠️ owner-confirm); self-service permissions for every staff member (payslips are printed — a login for every warehouse hand would force MFA enrolment on people who never use a screen); scheme names as Postgres enums (a scheme is a row, so a new levy is data, not a migration).

**New owner decisions before the phases named:** the nine role names (before task 0.7); the alias e-mail domain for cashiers without a mailbox (before Phase 6); the ⚠️ rows of §3.0.4 and §3.10.1 — post-dated cheques, till paid-outs, leave register, HRD Corp levy, foreign workers, hourly staff, staff purchases on salary deduction (before Phases 4, 6 and 8).

**Plan 0A updated to match** (25 edits): principal per-kind CHECK (Task 5); `role` and `permission` columns, `role_assignment` grants/expiry, `role_assignment_branch`, `app.actor_has()`, the no-self-grant trigger and their tests (Task 6); `document.branch_id` with its composite FK (Task 7); audit attachment for the branch child (Task 9); linter lists (Task 11). Nothing has been scaffolded; implementation still waits for the owner's go.

### Verification of v1.2 — same day

Four independent verifiers read the edited spec and Plan 0A through four lenses (internal consistency, SQL and schema correctness, module coverage for the first customer, principles and defect register). One of them assembled the Plan 0A SQL into a single migration and **ran it on PostgreSQL 18** as the non-superuser migration role, which is how the blockers below were found. Every finding in the top severity band was then handed to an independent skeptic instructed to refute it: **12 of 12 were confirmed, none refuted.** All were fixed in both the spec and the plan; the remaining lower-severity findings were reviewed by hand and applied where valid.

**Blockers found by executing the SQL (would have stopped Plan 0A at Task 5 or 6):**
- Transferring ownership of `resolve_principal` to `app_auth` fails with "permission denied for schema app": the new owner needs `CREATE` on the schema for the duration of the transfer.
- The `REVOKE … FROM PUBLIC` / `GRANT EXECUTE … TO app_rw` issued after that transfer were silent no-ops (the migrator no longer owned the function), so PUBLIC kept EXECUTE on the identity door. They now run before the transfer.
- `forbid_self_grant` failed on every `role_permission` write: PL/pgSQL compiles `new.principal_id` against the firing table's row type regardless of the `tg_table_name` guard. Nested IFs fix it.
- With the audit trigger on `tenant`, the bootstrap could not run in either order: the tenant's audit row cites a system principal that does not exist yet, and the reverse order fails on the tenant FK. `audit_log.actor_id` is now `deferrable initially deferred` (NOT NULL stays immediate).
- The down file could not drop `membership` while the two `principal` policies referenced it.

**Contradictions in the new role model, all fixed:** R6 forbade any seeded role from holding an incompatible pair while `admin` holds every code by construction (admin is now exempt; R1 binds it); R3 sent a payroll run to a status that does not exist (`calculated` → `draft`); R7 declared `user` read-only while its own row grants drafting permissions; the accountant held the payment create+approve pair through "receipts" (receipts now have their own codes — money in needs no maker-checker); `actor_has()` failed open when a branch-restricted principal asked with a NULL branch, and `document.branch_id` was nullable (now NOT NULL, and NULL means company-wide authority only); the sensitive-data RLS gate would have been OR-ed away by tenant isolation (now `AS RESTRICTIVE`, with a linter rule); the system principal would have been blocked by every gate it needs to pass for background jobs (it now passes `actor_has()`); two "trigger-enforced" rules had no trigger (kind discipline and last-admin now do); actor columns relied on DEFAULTs, which direct SQL can override (a generic `stamp_actor` trigger now overwrites them).

**Coverage additions from the same run:** the attachment service and sales/purchase orders had no phase (now Phase 2/3); `ledger_entry` has no `created_at`, so the linter needed an exemption; six wrong Part VI citations in the coverage map were corrected; Phase 4's definition of done no longer depends on Phases 6 and 8.

Plan 0A now has 12 tasks with 61 database tests across nine suites; the spec's changelog rows 23–27 record this pass.

**Regressions in the verification fixes themselves (found by a final review, fixed the same day; changelog row 28):** the new last-admin guard had the very row-type hazard the verifiers had just caught in `forbid_self_grant` (one function attached to two tables, referencing columns of both) and fired whenever a tenant had no administrator at all, which would have failed the `actor_has()` test; it is now two functions that act only when the OLD row grants an unexpired `admin.user.manage` that the change removes. The `stamp_actor` linter rule would have reported `document.posted_by` and `fiscal_period.closed_by`, which were never stamped, and the trigger body overwrote on every INSERT (it would have set `posted_by` at draft time); the semantics are now insert-overwrite-if-supplied, update-stamp-the-NULL→value-transition, otherwise `ERR_ACTOR_IMMUTABLE`, attached to all seven actor columns. The fixture's `BRANCH` dimension type collided with the "dimension values form a tree" test (now `REGION`), and the kind-discipline test's system-principal case relied on trigger firing order (its actor is now a different principal). A fresh execution pass on PostgreSQL 18 follows below.

**Second execution pass (same day; changelog row 29).** Two independent executors assembled `provision/roles.sql`, `0001.up.sql` and `0001.down.sql` from Plan 0A by exact line range and ran them on private PostgreSQL 18 clusters as the plan's own roles: up, down and re-up all succeed, the schema fingerprint is identical across cycles, and after down nothing remains in the `app` schema. One executor replayed every `it(...)` of the nine test suites as SQL (61 found, matching the stated counts; 60 executable, all passing — the one skipped case is pure TypeScript); the other ran 158 broader probes and the Task 11 linter rules as catalog queries (zero violations on the shipped schema). One major finding: the last-admin guard on `role_permission` fired only on DELETE, so an `UPDATE … SET permission_code` or `SET role_id` stripped the tenant's last administrator unchallenged — the trigger now covers UPDATE, returns `coalesce(new, old)`, and the plan's test gained the UPDATE case. Minor: `forbid_self_grant` ignored `expires_at` on its role-permission branch (fixed to match "a role they currently hold"); spec §3.8 lacked two lines the plan already had (`revoke insert, update on app.permission` and the `ledger_entry_dimension_immutable` trigger); the `btree_gist` extension survives `0001.down.sql` (now documented as deliberate); two narration miscounts in Tasks 9 and 10. Seven skeptics then re-executed each finding on their own clusters: 7 of 7 confirmed, one with a different fix — keep the extension rather than drop it, because on a cluster where the platform pre-installed `btree_gist` a `drop extension` fails with "must be owner" and, inside the runner's single transaction, rolls back the entire down. The F1/F2 fixes were then re-executed on a third cluster: nine probes (UPDATE of code, UPDATE of role, no-op UPDATE, DELETE, second admin present, delete of the new last grant, expired and unexpired self-escalation) all behave as specified.
