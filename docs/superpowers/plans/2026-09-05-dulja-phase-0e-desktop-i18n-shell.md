# Dulja Phase 0E — Desktop and i18n shell, back-office application, PDF-engine spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two things Phase 0 still owes on the desktop — a bilingual, bidirectional user-interface shell (`packages/i18n`, `packages/ui`, `apps/backoffice`) whose one real screen administers users and roles against 0B's endpoints, and an Electron desktop wrapper (`apps/desktop`) that packages it as `backoffice.exe` — and settle the one technical risk reporting cannot start without: which engine renders an Arabic PDF correctly (ADR 0016).

**Architecture:** Four new workspaces on top of the API 0B built and the cloud 0C provisioned. `packages/i18n` is a leaf — no internal imports at all — holding the `en`/`ar` ICU catalogues, the `Intl`-based date/number/money formatters (Gregorian **and** `islamic-umalqura`) and the catalogue-completeness checker. `packages/ui` imports `@dulja/i18n` and nothing else: design tokens as CSS custom properties, a Tailwind preset that admits only logical properties, a `DirectionProvider`, and the keyboard-first primitives. `apps/backoffice` is a React 19 + Vite + TanStack application that imports the packages, talks to `/v1` through Zod schemas from `@dulja/contracts`, and knows nothing about Electron. `apps/desktop` imports **build outputs only** (a Turborepo edge, never a workspace dependency): an Electron main process with the §3.7.2 security posture verbatim, a typed `contextBridge`, `safeStorage` for the Supabase refresh token, and electron-builder producing the Windows installer with auto-update against the R2 feed. The PDF spike lives outside all of it, in `spikes/pdf-engine/`, and produces one artefact — ADR 0016 — that 2C, 7A and 8D consume and never re-open.

**Tech Stack:** TypeScript · React 19 + Vite · TanStack Router / Query / Table / Virtual · React Hook Form + Zod · Tailwind (logical properties) + shadcn/ui · i18next + ICU · `Intl` with `islamic-umalqura` · Electron + electron-builder + electron-updater · `@sentry/electron` · Storybook · Vitest (under Node 24) + `@testing-library/react` + Playwright · Bun 1.4 for install and build · Turborepo. Versions are owned by the lockfile — no version literal appears in any source file (spec:104, D22).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §3.2.2 (frontend, i18n, PDF rows, spec:1129–1132), §3.7.1–§3.7.2 (spec:1256–1284), §3.9 Localisation (spec:2061), §4.10 (spec:2249–2256), §4.11 (spec:2258–2274), §5.0 rows 0.12 and 0.13 (spec:2322–2323), §5.2 (spec:2348–2389), §5.3 rows "0.13" and "Any UI work", Part VI test 23 (spec:2441), Part VII #11 (spec:2474). Cross-plan contract: `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`. Fixed input: `docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md` (Plan 0A — merged, verified on PostgreSQL 18, immovable).

---

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 0E — Desktop and i18n shell, back-office application, PDF-engine spike. **Phase:** 0. **Phase gate:** this plan starts only when **0B** is merged (login against the API, the `tests/` workspace, `scripts/lint/`) and, for Tasks 12–13 only, **0C** is merged (staging URL, the R2 update feed, `SENTRY_DSN`). It does not wait on 0D. Phase 0 has no predecessor phase, so spec:87 imposes no earlier DoD; 0E is the **last** Phase 0 slice in execution order (contracts §2.1: 0B → 0D → 0C → 0E) and therefore carries the phase-completion task (§3.8).
- **Depends on (merged):** **0B** — `apps/api` `createApp(deps)`, `ROUTES`, `packages/contracts` (`common.ts` `ProblemSchema` / `ListEnvelope` / `ListQuery`, `errors.ts` `Problem` / `ErrCode`, `permissions.ts` `PERMISSION`), the admin users / roles / role-assignment endpoints, `apps/api/test/support/app.ts` `startApi()` / `tokenFor()` / `request()`, the root `tests/` workspace, `scripts/lint/run.ts` and `bun run lint:rules`. **0C** — the staging deployment, the R2 `UPDATE_FEED` binding, `SENTRY_DSN`. **Plan 0A**, by exact name: `startDb`, `Db`, `withTenant` (the 4-argument *test* helper), `uuidv7`, `seedTenant`, `Seed`, `MIGRATIONS_DIR`, and the root scripts `bun run lint`, `format:check`, `typecheck`, `test`.
- **Migration numbers:** **0010 — reserved, and this plan writes none.** 0E creates no table and issues no DDL; §3.4.1 allows the gap ("unused numbers stay unused; `discover()` sorts whatever exists"). **ADR numbers:** 0016–0020 — **0016** PDF engine (spec:1132; agent-verifies-and-records, spec:93), **0017** electron-builder resolving from a Bun workspace + `better-sqlite3` against Electron's Node ABI (spec:2323), **0018** i18n catalogue format and the completeness rules, **0019** the `window.dulja` `contextBridge` surface — written **as a proposal** because it touches security (spec:95), **0020** reserved.
- **Interfaces consumed:** §4.1 (the Plan 0A produced surface — `startDb`, `Db`, `seedTenant`, `Seed`, `uuidv7`, the test `withTenant`); §4.2.3 (`Logger`, `AppEnv`); §4.2.4 (`Problem`, `ErrCode` — rendered here, never raised); §4.2.5 (`PERMISSION`, `PermissionCode` — the five `admin.*` codes the screen displays); §4.2.6 (`JobClient` — a stub only, to satisfy `createApp` in the e2e boot); §4.2.7 (`createApp(deps)`, `ROUTES`, the URL scheme `/v1/admin/*` and `/v1/companies/{companyId}/*`, `packages/contracts/openapi.json`); §4.2.8 (`ProblemSchema`, `ListEnvelope`, `ListQuery`, the `{ amount, currency }` money wire shape, the filter grammar); §4.2.12 (`startApi()`, `tokenFor()`, `ApiRequest`); §4.5.9 (`print_template.engine` — the column whose value set ADR 0016 fixes); §4.10.6 (`window.dulja.pos.*` — the namespace 6B occupies beside this slice's); §4.11.2 (the `reporting.render` job that consumes ADR 0016 in 7A).
- **Interfaces produced:** `@dulja/i18n` and `@dulja/ui` in full (their public surfaces are not in the registry — see *Contract additions* in the Self-Review); the `window.dulja.auth` / `window.dulja.app` / `window.dulja.print` bridge namespaces beside §4.10.6's `window.dulja.pos`; `scripts/lint/rules/no-hardcoded-string.ts`; the `tests/e2e` Playwright project of §3.7.1; ADR 0016, which `app.print_template.engine` (§4.5.9, 2C) and `renderReport`'s adapter set (§4.11.2, 7A) both consume.
- **Owner decisions:** **OD-18** (Windows code-signing certificate, OV or EV; spec:2323, §5.3 "0.13") → **Task 13 (isolated)**; default: the unsigned build is produced and verified, with the SmartScreen unsigned-publisher warning **expected and recorded**, and only Task 13 changes when the certificate arrives. **OD-24** (screenshots + a two-minute operator description before any screen; spec:79, 108, 2408, §5.3 "Any UI work") → **Task 7 (isolated)**; default: Task 8 builds the users-and-roles screen against 0B's OpenAPI document with the generic keyboard model of Task 4, and only `apps/backoffice/src/routes/admin/users.tsx` and `apps/backoffice/test/users.test.tsx` change if the owner's material shows a different workflow. **OD-20** (Cloudflare account and a domain) and **OD-22** (Sentry organisation) are 0C's gates; 0E consumes their values and states the local equivalent (`wrangler dev` / a stub DSN) inside Tasks 9 and 12 rather than re-gating them.
- **Part VI tests owned / re-run:** **owns 23** (RTL/LTR parity — the shell screen in both directions; every later UI slice and 2C/7A/8D for PDFs re-run it). **Re-runs: none.** **§3.0.4 rows owned:** none. **Regression files created / appended:** **creates `tests/regression/legacy-085.test.ts`** (i18n completeness — 0E is the first slice in execution order to touch LEGACY-085); **appends to `tests/regression/legacy-087.test.ts`** (created by 0B for the clean-runner build; 0E adds the `— 0E` block asserting the packaged installer carries no build-machine path).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **none**; account codes (§4.15) — **none seeded, none consumed**; report codes (§4.16.1) and `DatasetId` members (§4.16.2) — **none**; `fixtures.ts` helpers (§4.17) — **none** (§4.17 assigns 0E no row; `packages/db/test/fixtures.ts` is not modified by any task in this plan). It adds **no `ERR_*` code** (§4.2.4) and **no permission code** (§3.6.2): the shell renders problems and reads the catalogue, it raises neither.
- **Never re-decide:** D1–D27 (spec:114–142) — in particular **D2** (Electron + electron-builder, not PWA, not Tauri), **D10** (React 19, Vite, TanStack, RHF, Tailwind, shadcn/ui, i18next), **D18** (POS hardware out of scope; Windows printer drivers via Electron) and **D5** (Vitest runs under Node 24). Every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-05.

### Assumptions this plan rests on

Stated so a reviewer can reject one without reading the code.

1. **0C and 0D's plan files do not exist on disk** as this plan is written; **0B's does** and every name taken from it below was read out of it, not guessed. Names owed by 0C and 0D are cited from the **contracts registry by section**, verbatim. Where the registry is silent the plan says so and takes the narrowest possible dependency.
2. **0B's `packages/contracts` admin schemas, taken from the §4.2.8 module register — not guessed.** The register's row for `admin/user.ts`, `admin/role.ts`, `admin/role-assignment.ts`, `admin/company.ts` assigns 0B, verbatim: `UserSchema`/`InviteUserBody`/`UserQuery`/**`UserList`**; `RoleSchema`/`CreateRoleBody`/`UpdateRoleBody`/`RolePermissionsBody`/**`RoleList`**; `RoleAssignmentSchema`/`CreateRoleAssignmentBody`/`RoleAssignmentBranchBody`/**`RoleAssignmentList`**; `CompanySchema`/`CreateCompanyBody`/`UpdateCompanyBody`/**`CompanyList`**. **All four list wrappers are 0B's** — this plan re-exports them and re-derives none (contracts hazard 9: a registered name never gets a second spelling). 0B's plan file on disk gives the item shape this slice reads: `UserSchema = z.object({ id, displayName, email: z.string().nullable(), kind: z.enum(["human","system","terminal"]), createdAt, activeAssignments: z.number().int() })`. Endpoints: `GET|POST /v1/admin/users`, `/v1/admin/roles`, `/v1/companies`, `/v1/companies/{companyId}/role-assignments` (0B mounts assignments there because `role_assignment` carries `company_id` while `role` does not). Task 5's API wrapper still takes the Zod schema as a **parameter**, so a later rename in 0B costs one line in `apps/backoffice/src/lib/admin-schemas.ts`.
3. **`LintRule`, `LintViolation` and `SourceFile` live in `scripts/lint/types.ts`** (0B's file structure), and `SourceFile` is assumed to be `{ path: string; text: string }` — §3.7.5 gives the signature `run(files: SourceFile[]): LintViolation[]` without defining the shape. Task 3 parses with `ts.createSourceFile` inside the rule; if 0B shipped a `ts.SourceFile`, delete the parse line and use `file` directly. Task 3 Step 1 verifies which it is before writing anything.
4. **0B's `scripts/lint/rules/dependency-rule.ts` may not yet know the four workspaces this plan creates.** Task 3 Step 1 verifies its tier table contains `@dulja/ui`, `@dulja/i18n`, `@dulja/backoffice` and `@dulja/desktop` and adds the rows **additively** if it does not — exactly the §3.1 rows, no others.
5. **`packages/i18n` cannot import `@dulja/domain`** (§3.1: "`packages/i18n` — imports nothing internal"). So `formatMoney` takes the **wire shape** `{ amount: string; currency: string }` of §4.2.8's `MoneySchema`, not the `Money` type, and formats it as an exact decimal **string** through `Intl.NumberFormat.prototype.format`, never through `Number` (spec:2041 "No `number` type ever holds a monetary value").
6. **`packages/ui` may import `@dulja/i18n` and nothing else** (§3.1). Primitives therefore take plain props; every fetch, every Zod parse and every permission check happens in `apps/backoffice`.
7. **`apps/desktop` imports build outputs only** (spec:2389). It has **no** workspace dependency on `@dulja/backoffice`; the ordering is expressed in `turbo.json` as `"@dulja/desktop#build": { "dependsOn": ["@dulja/backoffice#build"] }` and electron-builder points at `../backoffice/dist`. 0B's `dependency-rule` lint then has nothing to catch, by construction.
8. **`safeStorage` is DPAPI-backed on Windows and may be unavailable elsewhere.** The bridge **refuses to persist** when `safeStorage.isEncryptionAvailable()` is `false` — it never falls back to plaintext, which would be exactly the defect DoD 0.13 forbids. Consequently the token test is meaningful only on Windows, which is why Task 11 adds a `windows-latest` CI job rather than extending Plan 0A's `ubuntu-latest` `checks` job.
9. **Test 23 must be runnable in CI without Supabase, Cloudflare or a code-signing certificate.** Task 9's Playwright project therefore boots the API locally on **0B's test JWKS issuer** (the same key pair `startApi()` / `tokenFor()` use, §4.2.12), seeds a tenant with `seedTenant`, mints an `aal2` token and injects the session, so the shell screen is reachable without the login UI. `PLAYWRIGHT_BASE_URL` plus a real Supabase session overrides all of it against staging once 0C's values exist.
10. **`better-sqlite3` belongs to 6B, but its ABI is proven here**, because DoD 0.13 says "`better-sqlite3` loads inside the packaged app". `apps/desktop` depends on it from this slice purely so `@electron/rebuild` runs against a real native module; the first code that stores a row in it is 6B's.
11. **The PDF spike decides an engine, not a template language for 2C.** ADR 0016 fixes the closed value set of `app.print_template.engine` (§4.5.9) and the adapter set `renderReport` receives in 7A (§4.11.2); 2C writes the templates.
12. **No LHDN / MyInvois field, endpoint, schema version or threshold appears in the spike's fixture invoice** (contracts §5 hazard 2). The fixture is a generic bilingual tax invoice — party block, line table, one tax line, totals — with invented, obviously-fake identifiers.
13. **`bun run lint`, `bun run format:check`, `bun run typecheck` and `bun run test` are green at the start of every task and must be green at its end** (Plan 0A's workspace-scripts contract, plan0A:224, 259–266). Every workspace this plan creates exposes `typecheck` and `test`; the two that emit output also expose `build`.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

**Never** (spec:97–104), at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (LEGACY-036/037/069);
- issue DDL from application code (LEGACY-053);
- disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053);
- gate an audit write on any flag (LEGACY-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always** (spec:106), for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. **For every UI screen: verified in both text directions before merge.**

**Localisation** (spec:2061): "Every user-facing string goes through i18next with an ICU message; a CI check fails any hard-coded string in a component. Both catalogues must be complete before merge — no empty `msgstr`, no source-language fallbacks in the other language (LEGACY-085)."

**Frontend and UX standards** (spec:2251–2256): "**Design system** with tokens; one component library; documented in Storybook." · "**Accessibility: WCAG 2.2 AA** — keyboard operability, focus management, contrast, screen-reader labels. Keyboard operability is also what makes the app fast for your own staff." · "**RTL and LTR parity** on every screen and every generated PDF, including numerals, Hijri and Gregorian dates, and column order. The old system did this well; do not regress it." · "**Keyboard-first data entry** for high-volume screens: tab order, type-ahead pickers, keyboard shortcuts, no mouse required to enter an invoice. This is the single biggest adoption risk in replacing a mature desktop app." · "Optimistic UI with clear pending/failed states; offline-tolerant POS." · "Empty states, inline help, and a searchable in-app documentation surface."

**Security posture for Electron** (spec:1284), verbatim and not optional: "`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderers; a strict Content-Security-Policy; all privileged operations (SQLite, printing, sync) behind a **typed `contextBridge` API**, never raw Node in the renderer; renderer navigation locked to the app's own origin."

**The UI is not specified here** (spec:108): "Before beginning any screen, request from the owner: screenshots of the equivalent legacy screen, and a two-minute description of how a fast operator uses it. Design the new screen to be *at least as fast by keyboard*. Do not invent workflows from this document."

**Money** (spec:2041): "`numeric(19,4)` in Postgres. In TypeScript, `Money` is an opaque type wrapping `decimal.js`, carrying its currency; the compiler rejects adding MYR to USD. Display rounding applies the currency's policy at render time; **stored base amounts are never recomputed on read.** No `number` type ever holds a monetary value — a lint rule enforces it."

**Time and dates** (spec:2039): "All timestamps `timestamptz`, stored in UTC. Every company has a `timezone` (`Asia/Kuala_Lumpur` for the first customer). **`effective_date` is a `date`, entered by the user, and is the accounting date** — it is never derived from `posted_at`. … Hijri display is a presentation concern via `Intl`; storage is always Gregorian."

**Naming** (spec:2045): "`snake_case` everywhere in SQL; **singular** table names … TypeScript: `camelCase`, types `PascalCase`. Bilingual names on master data as `name_en` / `name_ar` columns — not a JSON blob."

**Package versions** (spec:1084, D22): "**Do not hardcode package versions when building.** Install latest at scaffold time, commit the lockfile, and let Renovate raise upgrades."

**Environments** (spec:2272): "`dev` (local, Testcontainers), `staging` (a real Cloudflare Container against a staging Supabase project, seeded from an anonymised snapshot), `production`. Nothing reaches production without passing through staging."

**Secrets** (spec:2273): "never in the repository, never in `.env` files that are committed. … the code-signing certificate and its password (CI only)."

**Definition of done for any pull request** (spec:2274): "tests added or updated · migration is reversible · OpenAPI updated if the API changed · **both text directions checked if the UI changed** · no new `⚠️` left unresolved in the code without a linked issue."

**Commits** (§3.8): conventional commits, scope = workspace or area, subject `<type>(<scope>): <summary> [0E T<n>]`, and **every commit ends with the trailer**:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Definition of done — verbatim (spec:2322–2323)

| Row | Task (spec) | Done when (spec) |
|---|---|---|
| **0.12** | "i18n/RTL shell: i18next with `en` and `ar` catalogues, `dir` switching, Tailwind logical properties, the CI check for hard-coded strings and incomplete catalogues" | "A screen renders correctly in both directions; a hard-coded string fails CI" |
| **0.13** | "Electron shell for the back office: electron-builder producing a Windows installer from `apps/backoffice`, signed with the **owner-supplied** code-signing certificate (an owner dependency — see §5.3), security posture per §3.7.2, auto-update against a staging feed on R2, Supabase refresh token kept in Electron `safeStorage`. ⚠️ Verify here and record an ADR: electron-builder resolving dependencies from a **Bun workspace**, and `better-sqlite3` rebuilt against **Electron's Node ABI** (`@electron/rebuild`); if either fails, `apps/desktop` keeps its own npm lockfile" | "Installer runs on a clean Windows VM without an unsigned-publisher warning; renderer cannot reach Node; the token is not readable from disk in plain text; `better-sqlite3` loads inside the packaged app" |

**This slice's share:** both cells in full. The clause "without an unsigned-publisher warning" is the OD-18 half and is isolated in Task 13; the other three clauses of 0.13 are proven in Tasks 10–12 without any owner input.

**Where each clause is proven**

| Clause | Task | Evidence |
|---|---|---|
| `en` and `ar` catalogues, ICU, Hijri | 1, 2 | `packages/i18n/test/catalogue.test.ts`, `format.test.ts` |
| Both catalogues complete before merge | 3 | `packages/i18n/test/completeness.test.ts`, `tests/regression/legacy-085.test.ts` |
| A hard-coded string fails CI | 3 | `tests/invariants/lint-rules.test.ts` + `bun run lint:rules` |
| Tailwind logical properties | 4 | `packages/ui/test/logical-properties.test.ts` |
| `dir` switching | 4, 5 | `packages/ui/test/direction.test.tsx`, `apps/backoffice/test/shell.test.tsx` |
| **A screen renders correctly in both directions** | 8, 9 | `tests/e2e/rtl-parity.spec.ts` — **acceptance test 23** |
| Renderer cannot reach Node | 10 | `apps/desktop/test/posture.spec.ts` (`_electron.launch`) |
| Token not readable from disk in plain text | 11 | `apps/desktop/test/safe-storage.spec.ts` (the `windows-latest` CI job) |
| `better-sqlite3` loads inside the packaged app | 12 | `apps/desktop/test/native-module.spec.ts` + ADR 0017 |
| Auto-update against a staging feed on R2 | 12 | `apps/desktop/test/updater.spec.ts` against a local feed; staging under OD-20 |
| Installer runs on a clean Windows VM, no warning | 13 | `docs/runbooks/clean-vm-install.md`; **OD-18** |
| PDF engine decided (spec:1132, F-17) | 14 | `docs/adr/0016-pdf-engine.md` + `spikes/pdf-engine/out/*.pdf` |

---

## File structure

Created or modified by this plan, in order of appearance. One responsibility per file.

```
/
├─ package.json                                  MODIFY — workspaces are already ["packages/*","apps/*","tests"] (0B); add the "storybook" and "e2e" root scripts
├─ turbo.json                                    MODIFY — "@dulja/desktop#build" dependsOn "@dulja/backoffice#build" (the build-outputs-only edge)
├─ .github/workflows/ci.yml                      MODIFY — add the `desktop` job on windows-latest; the `checks` job (ubuntu) is untouched
├─ .oxlintrc.json                                MODIFY — no-console override for *.stories.tsx and tests/e2e
├─ docs/adr/0016-pdf-engine.md                   PDF engine decision (spec:1132) — consumed by 2C (§4.5.9) and 7A (§4.11.2)
├─ docs/adr/0017-electron-builder-bun-workspace.md   Bun-workspace resolution + better-sqlite3 Electron ABI (spec:2323)
├─ docs/adr/0018-i18n-catalogue-format.md        catalogue file format, key grammar, completeness rules
├─ docs/adr/0019-desktop-context-bridge.md       PROPOSAL (spec:95 — security) — the window.dulja surface
├─ docs/runbooks/clean-vm-install.md             the OD-18 manual verification runbook
├─ scripts/lint/rules/no-hardcoded-string.ts     0E's lint rule (§3.7.5 gains a row)
├─ spikes/pdf-engine/                            the F-17 spike — kept as ADR 0016's evidence
│  ├─ package.json                               NOT a workspace (outside the workspaces globs); run with `bun run --cwd spikes/pdf-engine`
│  ├─ fixture/invoice.json                       generic bilingual tax invoice — no LHDN field names (hazard 2)
│  ├─ candidates/typst/invoice.typ               candidate A
│  ├─ candidates/chromium/invoice.html           candidate B (Chromium print-to-PDF)
│  ├─ candidates/react-pdf/invoice.tsx           candidate C (a shaping-aware JS library: @react-pdf/renderer + fontkit)
│  ├─ render.ts                                  renders all three, both directions, into out/
│  └─ inspect.ts                                 extracts each PDF's text layer and scores the four criteria
├─ packages/i18n/
│  ├─ package.json · tsconfig.json · vitest.config.ts
│  ├─ src/index.ts                               the public surface, re-exported
│  ├─ src/locale.ts                              Locale, Dir, LOCALES, dirFor, isLocale
│  ├─ src/i18n.ts                                createI18n(): the i18next instance factory (ICU)
│  ├─ src/format.ts                              formatDate / formatTimestamp / formatNumber / formatMoney / formatQuantity
│  ├─ src/completeness.ts                        checkCatalogues(): CatalogueViolation[]
│  ├─ catalogues/en.json · catalogues/ar.json    the two ICU catalogues
│  └─ test/catalogue.test.ts · format.test.ts · completeness.test.ts
├─ packages/ui/
│  ├─ package.json · tsconfig.json · vitest.config.ts · .storybook/{main.ts,preview.tsx}
│  ├─ src/index.ts
│  ├─ src/tokens.css                             design tokens as CSS custom properties (spec:2251)
│  ├─ src/tailwind-preset.ts                     the preset; logical utilities only
│  ├─ src/direction.tsx                          DirectionProvider / useDirection
│  ├─ src/button.tsx · src/text-field.tsx · src/select.tsx · src/data-grid.tsx
│  ├─ src/*.stories.tsx                          Storybook, one per primitive, both directions
│  └─ test/logical-properties.test.ts · direction.test.tsx · data-grid.test.tsx
├─ apps/backoffice/
│  ├─ package.json · tsconfig.json · vite.config.ts · index.html · tailwind.config.ts · vitest.config.ts
│  ├─ src/main.tsx · src/router.tsx · src/app.css
│  ├─ src/lib/env.ts                             the VITE_* contract, parsed by Zod at boot
│  ├─ src/lib/problem.ts                         Problem → a user-facing message (§4.2.4)
│  ├─ src/lib/admin-api.ts                       typed fetch over /v1; the Zod schema is a parameter
│  ├─ src/lib/admin-schemas.ts                   the one file that names 0B's resource schemas
│  ├─ src/lib/session-storage.ts                 the two-adapter seam (browser | Electron bridge)
│  ├─ src/lib/supabase.ts                        the supabase-js client wired to that adapter
│  ├─ src/lib/session.tsx                        SessionProvider / useSession / useSupabase / useCompanyId
│  ├─ src/components/app-shell.tsx               chrome: locale + direction switcher, nav, error boundary
│  ├─ src/routes/login.tsx · src/routes/mfa-enrol.tsx
│  ├─ src/routes/admin/users.tsx                 THE screen — users and roles (OD-24)
│  └─ test/setup.ts · test/shell.test.tsx · login.test.tsx · users.test.tsx
├─ apps/desktop/
│  ├─ package.json · tsconfig.json · electron-builder.yml · playwright.config.ts
│  ├─ src/main.ts                                app lifecycle, window, navigation lock, CSP
│  ├─ src/window-options.ts                      browserWindowOptions — exported so a unit test can read it
│  ├─ src/bridge-types.ts                        DuljaBridge — shared by the preload and the renderer d.ts
│  ├─ src/preload.ts                             the typed contextBridge (window.dulja)
│  ├─ src/secure-store.ts                        the safeStorage token store
│  ├─ src/updater.ts                             electron-updater against the R2 feed
│  ├─ src/sentry.ts                              @sentry/electron in main and renderer
│  ├─ types/dulja.d.ts                           the renderer-side `declare global { interface Window }`
│  └─ test/window-options.test.ts · secure-store.test.ts · posture.spec.ts · safe-storage.spec.ts · updater.spec.ts · native-module.spec.ts
├─ tests/                                        (workspace created by 0B)
│  ├─ package.json                               MODIFY — @dulja/i18n and playwright; "test:e2e" already present
│  ├─ tsconfig.json                              MODIFY — include ../scripts/lint and e2e
│  ├─ playwright.config.ts                       the §3.7.1 e2e project
│  ├─ e2e/support/auth-stub.ts                   the four Supabase auth endpoints, CORS-fronted
│  ├─ e2e/support/boot.ts                        local API (CORS-fronted) + seeded tenant + a minted aal2 token
│  ├─ e2e/support/global-setup.ts                Playwright globalSetup → boots the local stack
│  ├─ e2e/support/global-teardown.ts             stops it again
│  ├─ e2e/rtl-parity.spec.ts                     ACCEPTANCE TEST 23
│  ├─ invariants/lint-rules.test.ts              the no-hardcoded-string proof
│  ├─ regression/legacy-085.test.ts                 CREATED here
│  └─ regression/legacy-087.test.ts                 MODIFY — append the "— 0E" describe block
└─ CLAUDE.md                                     MODIFY (last task) — "Current phase": Phase 0 complete, Phase 1 next
```

---

### Task 1: `packages/i18n` — the leaf package, `en`/`ar` catalogues, ICU, direction

**Files:**
- Create: `packages/i18n/package.json`, `packages/i18n/tsconfig.json`, `packages/i18n/vitest.config.ts`, `packages/i18n/src/locale.ts`, `packages/i18n/src/i18n.ts`, `packages/i18n/src/index.ts`, `packages/i18n/catalogues/en.json`, `packages/i18n/catalogues/ar.json`, `docs/adr/0018-i18n-catalogue-format.md`
- Test: `packages/i18n/test/catalogue.test.ts`

**Interfaces:**
- Consumes: nothing internal. §3.1 fixes `@dulja/i18n` as a leaf — "imports nothing internal" — so this package may not import `@dulja/domain`, `@dulja/contracts` or `@dulja/db`, now or ever.
- Produces:
  ```ts
  // packages/i18n/src/locale.ts
  export type Locale = "en" | "ar";
  export type Dir = "ltr" | "rtl";
  export const LOCALES: readonly Locale[];                 // ["en", "ar"]
  export const DEFAULT_LOCALE: Locale;                     // "en"
  export function isLocale(value: unknown): value is Locale;
  export function dirFor(locale: Locale): Dir;             // ar → "rtl", en → "ltr"

  // packages/i18n/src/i18n.ts
  export type Catalogue = Readonly<Record<string, string>>;
  export const CATALOGUES: Readonly<Record<Locale, Catalogue>>;
  export interface CreateI18nOptions { locale?: Locale; catalogues?: Readonly<Record<Locale, Catalogue>> }
  export function createI18n(opts?: CreateI18nOptions): Promise<i18n>;   // an initialised i18next instance, ICU-enabled
  // Copied verbatim from Step 6. It must be `keyof typeof en` — the literal key union of the imported
  // JSON — and never `keyof (typeof CATALOGUES)["en"]`, which collapses to `string` through the
  // `Readonly<Record<string, string>>` annotation on `Catalogue` and silently destroys the
  // "a typo is a compile error" property ADR 0018 claims.
  export type TranslationKey = keyof typeof en;
  ```

- [ ] **Step 1: Create the workspace and install its dependencies**

`packages/i18n/package.json` — no version numbers in source (D22); `bun add` writes the lockfile:

```json
{
  "name": "@dulja/i18n",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./catalogues/en.json": "./catalogues/en.json",
    "./catalogues/ar.json": "./catalogues/ar.json"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
```

`packages/i18n/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "resolveJsonModule": true },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/i18n/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

Install (from the repo root, so Bun records it in the single lockfile):

```bash
bun add --cwd packages/i18n i18next i18next-icu intl-messageformat
```

Expected: `packages/i18n/package.json` gains a `dependencies` block; `bun.lock` changes; no version string is typed by hand.

- [ ] **Step 2: Write the failing test**

`packages/i18n/test/catalogue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CATALOGUES, createI18n, DEFAULT_LOCALE, dirFor, isLocale, LOCALES } from "../src/index";

describe("locale and direction", () => {
  it("knows both locales and their directions", () => {
    expect(LOCALES).toEqual(["en", "ar"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(dirFor("en")).toBe("ltr");
    expect(dirFor("ar")).toBe("rtl");
  });

  it("guards unknown locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe("catalogues", () => {
  it("ships exactly the two catalogues, both non-empty", () => {
    expect(Object.keys(CATALOGUES).sort()).toEqual(["ar", "en"]);
    expect(Object.keys(CATALOGUES.en).length).toBeGreaterThan(20);
    expect(Object.keys(CATALOGUES.ar).length).toBe(Object.keys(CATALOGUES.en).length);
  });

  it("uses flat dotted keys, never nested objects (ADR 0018)", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        expect(typeof value, `${locale}:${key}`).toBe("string");
      }
    }
    expect(CATALOGUES.en["admin.users.title"]).toBe("Users and roles");
  });
});

describe("createI18n", () => {
  it("resolves a dotted key literally, with no nesting separator", async () => {
    const i18n = await createI18n({ locale: "en" });
    expect(i18n.t("admin.users.title")).toBe("Users and roles");
    expect(i18n.t("app.name")).toBe("Dulja");
  });

  it("serves Arabic when the locale is ar", async () => {
    const i18n = await createI18n({ locale: "ar" });
    expect(i18n.t("admin.users.title")).toBe("المستخدمون والأدوار");
  });

  it("applies English ICU plurals", async () => {
    const i18n = await createI18n({ locale: "en" });
    expect(i18n.t("admin.users.count", { count: 0 })).toBe("No users");
    expect(i18n.t("admin.users.count", { count: 1 })).toBe("1 user");
    expect(i18n.t("admin.users.count", { count: 7 })).toBe("7 users");
  });

  it("applies Arabic ICU plurals, including the dual form", async () => {
    const i18n = await createI18n({ locale: "ar" });
    const zero = i18n.t("admin.users.count", { count: 0 });
    const one = i18n.t("admin.users.count", { count: 1 });
    const two = i18n.t("admin.users.count", { count: 2 });
    const many = i18n.t("admin.users.count", { count: 7 });
    expect(new Set([zero, one, two, many]).size).toBe(4);   // ar distinguishes zero/one/two/plural
    expect(two).toContain("مستخدمان");
  });

  it("switches language on one instance without rebuilding it", async () => {
    const i18n = await createI18n({ locale: "en" });
    await i18n.changeLanguage("ar");
    expect(i18n.t("app.signOut")).toBe("تسجيل الخروج");
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
bun run --cwd packages/i18n test
```

Expected: FAIL — `Failed to resolve import "../src/index"` (the module does not exist yet).

- [ ] **Step 4: Write `src/locale.ts`**

```ts
/** The two locales of v1 (spec:1131 "Arabic and English at parity, both directions"). */
export type Locale = "en" | "ar";
export type Dir = "ltr" | "rtl";

export const LOCALES = ["en", "ar"] as const satisfies readonly Locale[];
export const DEFAULT_LOCALE: Locale = "en";

const DIR_BY_LOCALE: Readonly<Record<Locale, Dir>> = { en: "ltr", ar: "rtl" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The `dir` attribute the document root carries for this locale. Never inferred from content. */
export function dirFor(locale: Locale): Dir {
  return DIR_BY_LOCALE[locale];
}
```

- [ ] **Step 5: Write the two catalogues**

`packages/i18n/catalogues/en.json` — flat dotted keys, ICU message syntax, no nesting (ADR 0018). `app.endonym.*` holds each language's name **in its own script**; the completeness checker (Task 3) exempts that prefix and nothing else.

```json
{
  "app.name": "Dulja",
  "app.endonym.en": "English",
  "app.endonym.ar": "العربية",
  "app.language": "Language",
  "app.direction": "Text direction",
  "app.nav.users": "Users and roles",
  "app.signOut": "Sign out",
  "app.loading": "Loading…",
  "app.empty": "Nothing to show yet.",
  "app.error.title": "Something went wrong",
  "app.error.retry": "Try again",
  "app.skipToContent": "Skip to content",
  "auth.login.title": "Sign in",
  "auth.login.email": "E-mail",
  "auth.login.password": "Password",
  "auth.login.submit": "Sign in",
  "auth.login.failed": "That e-mail and password did not match an account.",
  "auth.mfa.title": "Set up two-factor authentication",
  "auth.mfa.intro": "Scan this code with your authenticator app, then type the six digits it shows.",
  "auth.mfa.code": "Six-digit code",
  "auth.mfa.verify": "Verify",
  "auth.mfa.required": "Two-factor authentication is required before you can continue.",
  "admin.users.title": "Users and roles",
  "admin.users.count": "{count, plural, =0 {No users} one {# user} other {# users}}",
  "admin.users.search": "Search users",
  "admin.users.column.email": "E-mail",
  "admin.users.column.name": "Name",
  "admin.users.column.roles": "Roles",
  "admin.users.column.status": "Status",
  "admin.users.column.invitedOn": "Invited on",
  "admin.users.status.active": "Active",
  "admin.users.status.expired": "Expired",
  "admin.users.invite": "Invite user",
  "admin.users.assignRole": "Assign role",
  "admin.users.expireAssignment": "Expire assignment",
  "admin.users.assignedBy": "Assigned by {actor} on {grantedOn}",
  "problem.remedy": "What to do: {remedy}",
  "problem.reference": "Reference {requestId}"
}
```

`packages/i18n/catalogues/ar.json` — the same key set, every value translated, no trailing whitespace:

```json
{
  "app.name": "دُلجة",
  "app.endonym.en": "English",
  "app.endonym.ar": "العربية",
  "app.language": "اللغة",
  "app.direction": "اتجاه النص",
  "app.nav.users": "المستخدمون والأدوار",
  "app.signOut": "تسجيل الخروج",
  "app.loading": "جارٍ التحميل…",
  "app.empty": "لا يوجد ما يُعرض بعد.",
  "app.error.title": "حدث خطأ ما",
  "app.error.retry": "أعد المحاولة",
  "app.skipToContent": "تخطَّ إلى المحتوى",
  "auth.login.title": "تسجيل الدخول",
  "auth.login.email": "البريد الإلكتروني",
  "auth.login.password": "كلمة المرور",
  "auth.login.submit": "تسجيل الدخول",
  "auth.login.failed": "لا يطابق هذا البريد الإلكتروني وكلمة المرور أي حساب.",
  "auth.mfa.title": "إعداد المصادقة الثنائية",
  "auth.mfa.intro": "امسح هذا الرمز بتطبيق المصادقة، ثم اكتب الأرقام الستة التي يعرضها.",
  "auth.mfa.code": "الرمز المكوَّن من ستة أرقام",
  "auth.mfa.verify": "تحقَّق",
  "auth.mfa.required": "المصادقة الثنائية مطلوبة قبل المتابعة.",
  "admin.users.title": "المستخدمون والأدوار",
  "admin.users.count": "{count, plural, =0 {لا يوجد مستخدمون} one {مستخدم واحد} two {مستخدمان} few {# مستخدمين} many {# مستخدمًا} other {# مستخدم}}",
  "admin.users.search": "ابحث في المستخدمين",
  "admin.users.column.email": "البريد الإلكتروني",
  "admin.users.column.name": "الاسم",
  "admin.users.column.roles": "الأدوار",
  "admin.users.column.status": "الحالة",
  "admin.users.column.invitedOn": "تاريخ الدعوة",
  "admin.users.status.active": "نشط",
  "admin.users.status.expired": "منتهٍ",
  "admin.users.invite": "دعوة مستخدم",
  "admin.users.assignRole": "إسناد دور",
  "admin.users.expireAssignment": "إنهاء الإسناد",
  "admin.users.assignedBy": "أسنده {actor} بتاريخ {grantedOn}",
  "problem.remedy": "ما العمل: {remedy}",
  "problem.reference": "المرجع {requestId}"
}
```

- [ ] **Step 6: Write `src/i18n.ts`**

```ts
import ICU from "i18next-icu";
import i18next, { type i18n } from "i18next";
import ar from "../catalogues/ar.json" with { type: "json" };
import en from "../catalogues/en.json" with { type: "json" };
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locale";

export type Catalogue = Readonly<Record<string, string>>;

/** The shipped catalogues. The completeness checker (src/completeness.ts) runs over exactly this object. */
export const CATALOGUES: Readonly<Record<Locale, Catalogue>> = { en, ar };

/** Every key the application may ask for. A typo is a compile error, not a fallback string. */
export type TranslationKey = keyof typeof en;

export interface CreateI18nOptions {
  locale?: Locale;
  /** Test seam: swap the catalogues without touching the shipped files. */
  catalogues?: Readonly<Record<Locale, Catalogue>>;
}

/**
 * An initialised i18next instance with the ICU message format (spec:2061 "an ICU message").
 * `keySeparator` and `nsSeparator` are false: keys are flat dotted literals (ADR 0018), so
 * "admin.users.title" is one key and can never be mistaken for a nested lookup.
 */
export async function createI18n(opts: CreateI18nOptions = {}): Promise<i18n> {
  const catalogues = opts.catalogues ?? CATALOGUES;
  const instance = i18next.createInstance();
  await instance.use(ICU).init({
    lng: opts.locale ?? DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    fallbackLng: false,          // LEGACY-085: a missing Arabic string must show as missing, never as English
    returnNull: false,
    resources: Object.fromEntries(
      LOCALES.map((locale) => [locale, { translation: catalogues[locale] }]),
    ),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },   // React escapes; double-escaping mangles Arabic punctuation
  });
  return instance;
}
```

`packages/i18n/src/index.ts`:

```ts
export { CATALOGUES, createI18n, type Catalogue, type CreateI18nOptions, type TranslationKey } from "./i18n";
export { DEFAULT_LOCALE, dirFor, isLocale, LOCALES, type Dir, type Locale } from "./locale";
```

- [ ] **Step 7: Run the test to see it pass**

```bash
bun run --cwd packages/i18n test
```

Expected: PASS — 9 tests in `packages/i18n/test/catalogue.test.ts` (counts in this plan are always per file). If the Arabic dual assertion fails, the `two` branch of `admin.users.count` is missing from `ar.json`; add it rather than weakening the test (Arabic has six plural categories and the dual is the one English speakers forget — LEGACY-085's family of defect).

- [ ] **Step 8: Write ADR 0018**

`docs/adr/0018-i18n-catalogue-format.md`, in Plan 0A's ADR format:

```markdown
# 0018 — Catalogue format: flat dotted ICU keys, two files, no fallback

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0E · **Spec:** §3.9 Localisation (spec:2061), §3.2.2 i18n row (spec:1131)

## Context
spec:2061 requires every user-facing string to go through i18next with an ICU message, both catalogues
complete before merge, "no empty `msgstr`, no source-language fallbacks in the other language (LEGACY-085)".
The legacy system shipped 13,778 entries with 122 empty translations and 61 untranslated Arabic strings
reaching English users. The format has to make those two states mechanically detectable.

## Decision
1. Two files, `packages/i18n/catalogues/<locale>.json`, one flat JSON object per locale. No nesting,
   no namespaces: `keySeparator: false`, `nsSeparator: false`.
2. Keys are dotted `<area>.<screen>.<element>` literals; `TranslationKey` is `keyof typeof en`, so an
   unknown key is a TypeScript error.
3. `fallbackLng: false`. A missing Arabic value renders the key, loudly — it never renders English.
4. ICU message syntax for plurals, selects and inline dates.
5. Exactly one exempt key prefix, `app.endonym.*`, which holds each language's name in its own script;
   every other key is subject to the completeness rules of `checkCatalogues` (§Task 3).

## Consequences
- Adding a key means editing both files in the same PR, or `checkCatalogues` fails CI.
- Flat keys make the completeness check a set comparison, not a tree walk.
- No fallback means an incomplete Arabic catalogue is visible in development, not in production.
```

- [ ] **Step 9: Root checks and commit**

```bash
bun run lint && bun run format:check && bun run typecheck && bun run --cwd packages/i18n test
```

Expected: all green.

```bash
git add packages/i18n docs/adr/0018-i18n-catalogue-format.md package.json bun.lock
git commit -m "feat(i18n): en/ar ICU catalogues, flat dotted keys, direction map [0E T1]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Formatting — Gregorian and Hijri dates, both numbering systems, money as an exact decimal string

**Files:**
- Create: `packages/i18n/src/format.ts`
- Modify: `packages/i18n/src/index.ts`
- Test: `packages/i18n/test/format.test.ts`

**Interfaces:**
- Consumes: `Locale` from Task 1.
- Produces:
  ```ts
  // packages/i18n/src/format.ts
  export type CalendarSystem = "gregory" | "islamic-umalqura";
  export type NumberingSystem = "latn" | "arab";
  export interface FormatContext {
    locale: Locale;
    calendar?: CalendarSystem;          // default "gregory"
    numberingSystem?: NumberingSystem;  // default "latn"
    timeZone?: string;                  // default "Asia/Kuala_Lumpur" (spec:2039)
  }
  /** The §4.2.8 wire shape of money — NOT the domain `Money` type, which this leaf package may not import. */
  export interface MoneyJson { readonly amount: string; readonly currency: string }
  export function localeTag(ctx: FormatContext): string;
  export function formatDate(isoDate: string, ctx: FormatContext, style?: "short" | "medium" | "long"): string;
  export function formatTimestamp(iso: string, ctx: FormatContext): string;
  export function formatNumber(decimal: string, ctx: FormatContext, opts?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string;
  export function formatMoney(value: MoneyJson, ctx: FormatContext, opts?: { minorUnits?: number }): string;
  export function formatQuantity(decimal: string, ctx: FormatContext): string;
  ```

**Why `MoneyJson` and not `Money`.** §3.1 makes `@dulja/i18n` a leaf that "imports nothing internal", so `@dulja/domain` is unreachable from here. §4.2.8 already fixes the wire shape `{ amount: string; currency: string }` (`MoneySchema`), and that is what an API response carries, so the formatter takes it directly. The amount stays a **string** through the whole function: `Intl.NumberFormat.prototype.format` accepts a decimal string and formats it exactly, so no `Number()` conversion ever happens and spec:2041's "No `number` type ever holds a monetary value" holds inside the renderer too. *(Note: §3.7.5 scopes 0D's `no-number-money` lint to `packages/domain`, `packages/contracts` and `apps/**` — `packages/i18n` is outside that glob, which is why the float path is proven here by a test instead. Widening the glob is a contracts amendment, not this plan's.)*

- [ ] **Step 1: Write the failing test**

`packages/i18n/test/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  formatTimestamp,
  localeTag,
} from "../src/format";

describe("localeTag", () => {
  it("builds a BCP-47 tag with the calendar and numbering extensions", () => {
    expect(localeTag({ locale: "en" })).toBe("en-u-ca-gregory-nu-latn");
    expect(localeTag({ locale: "ar", calendar: "islamic-umalqura", numberingSystem: "arab" }))
      .toBe("ar-u-ca-islamic-umalqura-nu-arab");
  });

  it("produces a tag the platform actually resolves to the requested calendar", () => {
    const tag = localeTag({ locale: "ar", calendar: "islamic-umalqura" });
    expect(new Intl.DateTimeFormat(tag).resolvedOptions().calendar).toBe("islamic-umalqura");
  });
});

describe("formatDate", () => {
  it("formats a YYYY-MM-DD accounting date in the Gregorian calendar", () => {
    const out = formatDate("2026-01-15", { locale: "en" });
    expect(out).toContain("2026");
    expect(out).toContain("15");
  });

  it("never shifts the day across a time zone (effective_date is a date, not an instant — spec:2039)", () => {
    // Asia/Kuala_Lumpur is UTC+8; a naive `new Date("2026-01-01")` rendered in a western zone shows 31 Dec.
    for (const timeZone of ["Asia/Kuala_Lumpur", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).toContain("2026");
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).toContain("1");
      expect(formatDate("2026-01-01", { locale: "en", timeZone })).not.toContain("2025");
    }
  });

  it("uses Intl's dateStyle, not component options, so a single-digit day carries no leading zero", () => {
    // The house date policy, pinned rather than described: `medium` is `Intl.DateTimeFormat`'s own
    // `dateStyle`, and en-US renders 5 January as "Jan 5, 2026". A formatter built from explicit
    // component options — `{ day: "2-digit", month: "short", year: "numeric" }` — renders "Jan 05, 2026"
    // for the same date and agrees with this one only on two-digit days. Any slice that builds its own
    // `Intl.DateTimeFormat` over a value this package also formats must use `dateStyle` so the two agree.
    // Verified on Node 24.9.0 (D5's test runtime), full ICU.
    expect(formatDate("2026-01-05", { locale: "en" })).toBe("Jan 5, 2026");
    expect(formatDate("2026-01-15", { locale: "en" })).toBe("Jan 15, 2026");
  });

  it("renders the same instant in the Hijri calendar under islamic-umalqura", () => {
    const gregorian = formatDate("2026-01-15", { locale: "ar", calendar: "gregory", numberingSystem: "latn" });
    const hijri = formatDate("2026-01-15", { locale: "ar", calendar: "islamic-umalqura", numberingSystem: "latn" });
    expect(gregorian).toContain("2026");
    expect(hijri).not.toContain("2026");     // the Hijri year is not 2026
    expect(hijri).toMatch(/14\d\d/);          // it is in the 1400s AH
  });
});

describe("formatNumber and formatQuantity", () => {
  it("renders Western digits under nu-latn and Arabic-Indic digits under nu-arab", () => {
    expect(formatNumber("1234", { locale: "ar", numberingSystem: "latn" })).toContain("1,234");
    // CLDR groups `ar` with U+066C ARABIC THOUSANDS SEPARATOR, so the four digits are NOT contiguous:
    // verified on Node 24.9.0, `new Intl.NumberFormat("ar-u-ca-gregory-nu-arab", …).format("1234")`
    // returns "١٬٢٣٤". Assert the digit *set* and the grouped form, never a
    // contiguous run — a `toContain("١٢٣٤")` here fails, and grouping is on for latn in the line above.
    const arab = formatNumber("1234", { locale: "ar", numberingSystem: "arab" });
    expect(arab).toBe("١٬٢٣٤");
    expect(arab).toMatch(/^[٠-٩٫٬]+$/);   // Arabic-Indic digits and separators only
  });

  it("keeps quantities at six decimal places (spec:2043)", () => {
    expect(formatQuantity("2.500000", { locale: "en" })).toBe("2.500000");
  });
});

describe("formatMoney", () => {
  it("formats the wire shape at the currency's minor units", () => {
    const out = formatMoney({ amount: "1234.5600", currency: "MYR" }, { locale: "en" }, { minorUnits: 2 });
    expect(out).toContain("1,234.56");
  });

  it("formats an amount larger than Number.MAX_SAFE_INTEGER exactly — proof that no float is involved", () => {
    // Number("9007199254740993.0001") === 9007199254740992 — a float path loses the last digit and the fraction.
    const out = formatMoney(
      { amount: "9007199254740993.0001", currency: "MYR" },
      { locale: "en", numberingSystem: "latn" },
      { minorUnits: 4 },
    );
    expect(out).toContain("9,007,199,254,740,993.0001");
  });

  it("keeps a negative amount negative and does not round it away", () => {
    const out = formatMoney({ amount: "-0.0001", currency: "MYR" }, { locale: "en" }, { minorUnits: 4 });
    expect(out).toContain("0.0001");
    expect(out).toMatch(/[-−(]/);
  });

  it("rejects an amount that is not a plain decimal string", () => {
    expect(() => formatMoney({ amount: "1e5", currency: "MYR" }, { locale: "en" })).toThrow(
      /formatMoney: amount must be a plain decimal string, received "1e5"/,
    );
  });
});

describe("formatTimestamp", () => {
  it("renders an RFC 3339 instant in the company time zone", () => {
    const out = formatTimestamp("2026-01-15T18:30:00Z", { locale: "en", timeZone: "Asia/Kuala_Lumpur" });
    expect(out).toContain("16");        // 18:30 UTC is 02:30 on the 16th in UTC+8
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
bun run --cwd packages/i18n test -- format
```

Expected: FAIL — `Failed to resolve import "../src/format"`.

- [ ] **Step 3: Write `src/format.ts`**

```ts
import type { Locale } from "./locale";

export type CalendarSystem = "gregory" | "islamic-umalqura";
export type NumberingSystem = "latn" | "arab";

export interface FormatContext {
  locale: Locale;
  /** Hijri display is a presentation concern via `Intl`; storage is always Gregorian (spec:2039). */
  calendar?: CalendarSystem;
  numberingSystem?: NumberingSystem;
  /** The company's timezone (spec:2039). Only `formatTimestamp` uses it; a `date` is zone-free by construction. */
  timeZone?: string;
}

/** The §4.2.8 wire shape of money. This package may not import `@dulja/domain` (§3.1), and must not: */
/** the amount stays a decimal string end to end, so no `number` ever holds it (spec:2041). */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";
const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localeTag(ctx: FormatContext): string {
  const calendar = ctx.calendar ?? "gregory";
  const numberingSystem = ctx.numberingSystem ?? "latn";
  return `${ctx.locale}-u-ca-${calendar}-nu-${numberingSystem}`;
}

function assertDecimal(fn: string, field: string, value: string): void {
  if (!DECIMAL.test(value)) {
    throw new TypeError(`${fn}: ${field} must be a plain decimal string, received "${value}"`);
  }
}

/**
 * A `date` column (spec:2039 — "`effective_date` is a `date`, entered by the user"). It is a calendar
 * day, not an instant, so it is always rendered in UTC: rendering `2026-01-01` in a western zone would
 * otherwise print 31 December 2025 and silently move an accounting date into the previous period.
 *
 * **House date policy (0E's to set — spec:2061, spec:2253).** A rendered date is always one of `Intl`'s
 * three `dateStyle` values — `short` | `medium` | `long`, default `medium` — and never a hand-assembled
 * set of component options. The two are not interchangeable: `dateStyle: "medium"` gives `Jan 5, 2026`
 * for a single-digit day, whereas `{ day: "2-digit", month: "short", year: "numeric" }` gives
 * `Jan 05, 2026`, and they agree only from the 10th of the month onward. Any slice that builds its own
 * `Intl.DateTimeFormat` over a value this package also formats must use `dateStyle` so the two paths
 * cannot print the same date two ways.
 */
export function formatDate(
  isoDate: string,
  ctx: FormatContext,
  style: "short" | "medium" | "long" = "medium",
): string {
  if (!ISO_DATE.test(isoDate)) {
    throw new TypeError(`formatDate: expected YYYY-MM-DD, received "${isoDate}"`);
  }
  return new Intl.DateTimeFormat(localeTag(ctx), { dateStyle: style, timeZone: "UTC" })
    .format(new Date(`${isoDate}T00:00:00Z`));
}

/** A `timestamptz` (spec:2039 — stored UTC, displayed in the company's timezone). */
export function formatTimestamp(iso: string, ctx: FormatContext): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`formatTimestamp: expected an RFC 3339 timestamp, received "${iso}"`);
  }
  return new Intl.DateTimeFormat(localeTag(ctx), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ctx.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(at);
}

export function formatNumber(
  decimal: string,
  ctx: FormatContext,
  opts: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  assertDecimal("formatNumber", "value", decimal);
  // Intl.NumberFormat#format accepts a decimal string and formats it exactly (Intl.NumberFormat V3).
  // Passing the string — never Number(string) — is what keeps this off the float path.
  return new Intl.NumberFormat(localeTag(ctx), {
    minimumFractionDigits: opts.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts.maximumFractionDigits ?? 20,
  }).format(decimal as unknown as number);
}

/** Quantities are `numeric(19,6)` (spec:2043) and are shown at their full scale. */
export function formatQuantity(decimal: string, ctx: FormatContext): string {
  assertDecimal("formatQuantity", "value", decimal);
  return new Intl.NumberFormat(localeTag(ctx), {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
    useGrouping: false,
  }).format(decimal as unknown as number);
}

/**
 * Display rounding applies the currency's policy at render time (spec:2041). `minorUnits` comes from
 * `app.currency.minor_units` (§4.2.10) and is supplied by the caller — this package holds no currency table.
 */
export function formatMoney(
  value: MoneyJson,
  ctx: FormatContext,
  opts: { minorUnits?: number } = {},
): string {
  assertDecimal("formatMoney", "amount", value.amount);
  const digits = opts.minorUnits ?? 2;
  return new Intl.NumberFormat(localeTag(ctx), {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value.amount as unknown as number);
}
```

The `as unknown as number` casts are the one place this file bends: `Intl.NumberFormat#format` accepts strings at runtime (Intl.NumberFormat V3, shipped in Node 20 and every current browser) but the DOM lib types still declare `number`. The cast is deliberate and is the *opposite* of a float conversion — `Number(value)` is what must never appear. The two big-value tests above fail loudly if anyone "simplifies" it.

- [ ] **Step 4: Re-export from `src/index.ts`**

```ts
export {
  formatDate,
  formatMoney,
  formatNumber,
  formatQuantity,
  formatTimestamp,
  localeTag,
  type CalendarSystem,
  type FormatContext,
  type MoneyJson,
  type NumberingSystem,
} from "./format";
export { CATALOGUES, createI18n, type Catalogue, type CreateI18nOptions, type TranslationKey } from "./i18n";
export { DEFAULT_LOCALE, dirFor, isLocale, LOCALES, type Dir, type Locale } from "./locale";
```

- [ ] **Step 5: Run the test to see it pass**

```bash
bun run --cwd packages/i18n test
```

Expected: PASS — 9 + 13 tests (`catalogue.test.ts`, `format.test.ts`). If `Intl.DateTimeFormat(...).resolvedOptions().calendar` is not `islamic-umalqura`, the runtime is missing full ICU data; run under Node 24 (`node --version`) rather than trimming the assertion — D5 fixes Node 24 as the test runtime for exactly this class of reason.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n
git commit -m "feat(i18n): Intl formatters — Hijri, both numbering systems, exact decimal money [0E T2]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The localisation CI gate — completeness checker, `no-hardcoded-string` lint, `legacy-085`

This task delivers the whole of DoD 0.12's second clause, "a hard-coded string fails CI", and the "both catalogues complete before merge" half of spec:2061. It has two TDD cycles: the checker, then the lint rule.

**Files:**
- Create: `packages/i18n/src/completeness.ts`, `packages/i18n/test/completeness.test.ts`, `scripts/lint/rules/no-hardcoded-string.ts`, `tests/invariants/lint-rules.test.ts`, `tests/regression/legacy-085.test.ts`
- Modify: `packages/i18n/src/index.ts`, `scripts/lint/rules/dependency-rule.ts` (verify, extend only if needed), `tests/tsconfig.json`

**Interfaces:**
- Consumes: `CATALOGUES`, `LOCALES`, `Locale` (Task 1); 0B's `LintRule`, `LintViolation`, `SourceFile` from `scripts/lint/run.ts` (§3.7.5); `bun run lint:rules` (0B).
- Produces:
  ```ts
  // packages/i18n/src/completeness.ts
  export interface CatalogueViolation { locale: Locale | "*"; key: string; rule: string; detail: string }
  export const CATALOGUE_RULES: readonly string[];   // the six rule names, in report order
  export function checkCatalogues(catalogues?: Readonly<Record<Locale, Readonly<Record<string, string>>>>): CatalogueViolation[];

  // scripts/lint/rules/no-hardcoded-string.ts
  export const rule: LintRule;                        // name: "no-hardcoded-string"
  ```

- [ ] **Step 1: Establish the two 0B shapes this task depends on**

Read `scripts/lint/types.ts` — 0B's home for the three shared lint types — and note two things before writing a line:

```bash
cat scripts/lint/types.ts
grep -n "SourceFile" scripts/lint/types.ts scripts/lint/run.ts
```

Expected: an exported `LintRule` with `run(files: SourceFile[]): LintViolation[]`. Record which `SourceFile` is:

- **`{ path: string; text: string }`** (the assumption this plan is written against) — keep the `ts.createSourceFile` call in Step 5.
- **a `ts.SourceFile`** — delete the `ts.createSourceFile` line in Step 5 and use `file` directly; nothing else changes.

Then check that 0B's dependency rule knows this slice's four workspaces:

```bash
grep -n "@dulja/ui\|@dulja/i18n\|@dulja/backoffice\|@dulja/desktop" scripts/lint/rules/dependency-rule.ts
```

Expected, per §3.1: four rows — `@dulja/i18n` may import nothing internal; `@dulja/ui` may import `@dulja/i18n` only; `@dulja/backoffice` may import any `packages/*` but no other app; `@dulja/desktop` may import **no** workspace at all (build outputs only). If any row is absent, add exactly that row — additively, changing no existing row — and say so in the commit message.

- [ ] **Step 2: Write the failing test for the checker**

`packages/i18n/test/completeness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CATALOGUES } from "../src/i18n";
import { checkCatalogues, type CatalogueViolation } from "../src/completeness";

const rules = (v: CatalogueViolation[]): string[] => [...new Set(v.map((x) => x.rule))].sort();

describe("checkCatalogues", () => {
  it("passes the shipped catalogues", () => {
    expect(checkCatalogues()).toEqual([]);
  });

  it("reports a key present in one catalogue and missing from the other", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello", "a.c": "World" }, ar: { "a.b": "مرحبا" } });
    expect(rules(v)).toEqual(["missing_key"]);
    expect(v[0]).toMatchObject({ locale: "ar", key: "a.c", rule: "missing_key" });
  });

  it("reports an empty translation (LEGACY-085: 122 empty entries shipped)", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello" }, ar: { "a.b": "   " } });
    expect(rules(v)).toEqual(["empty_value"]);
  });

  it("reports trailing whitespace (LEGACY-085: 232 entries)", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello " }, ar: { "a.b": "مرحبا" } });
    expect(v).toEqual([
      { locale: "en", key: "a.b", rule: "trailing_whitespace", detail: 'value is "Hello " — trim it' },
    ]);
  });

  it("reports an Arabic value copied verbatim from English (source-language fallback)", () => {
    const v = checkCatalogues({ en: { "a.b": "Sign out" }, ar: { "a.b": "Sign out" } });
    expect(rules(v)).toEqual(["source_language_fallback", "wrong_script"]);
  });

  it("reports Arabic reaching an English value (LEGACY-085: 61 untranslated strings, two of them dialogs)", () => {
    const v = checkCatalogues({ en: { "a.b": "هل تريد حفظ التعديلات ؟" }, ar: { "a.b": "هل تريد حفظ التعديلات ؟" } });
    expect(rules(v)).toContain("wrong_script");
    expect(v.some((x) => x.locale === "en" && x.rule === "wrong_script")).toBe(true);
  });

  it("reports a raw component name shipped as UI text (LEGACY-085: \"TBXToolbar3\")", () => {
    const v = checkCatalogues({ en: { "a.b": "TBXToolbar3" }, ar: { "a.b": "TBXToolbar3" } });
    expect(rules(v)).toContain("component_name_leak");
  });

  it("exempts app.endonym.* — each language names itself in its own script", () => {
    const v = checkCatalogues({
      en: { "app.endonym.ar": "العربية", "app.endonym.en": "English" },
      ar: { "app.endonym.ar": "العربية", "app.endonym.en": "English" },
    });
    expect(v).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
bun run --cwd packages/i18n test -- completeness
```

Expected: FAIL — `Failed to resolve import "../src/completeness"`.

- [ ] **Step 4: Write `src/completeness.ts`**

```ts
import { CATALOGUES } from "./i18n";
import { LOCALES, type Locale } from "./locale";

export interface CatalogueViolation {
  locale: Locale | "*";
  key: string;
  rule: string;
  detail: string;
}

export const CATALOGUE_RULES = [
  "missing_key",
  "empty_value",
  "trailing_whitespace",
  "source_language_fallback",
  "wrong_script",
  "component_name_leak",
] as const;

/** Keys whose value is deliberately in another script: each language names itself (ADR 0018). */
const EXEMPT_PREFIXES = ["app.endonym."];
const ARABIC = /[؀-ۿݐ-ݿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
/** A raw identifier shipped as UI text — the "TBXToolbar3" shape of LEGACY-085. */
const COMPONENT_NAME = /^[A-Z][A-Za-z]*\d+$/;

const exempt = (key: string): boolean => EXEMPT_PREFIXES.some((p) => key.startsWith(p));

/**
 * The mechanical half of spec:2061 — "Both catalogues must be complete before merge — no empty
 * `msgstr`, no source-language fallbacks in the other language (LEGACY-085)". Every rule below names a
 * concrete failure the legacy build shipped.
 */
export function checkCatalogues(
  catalogues: Readonly<Record<Locale, Readonly<Record<string, string>>>> = CATALOGUES,
): CatalogueViolation[] {
  const out: CatalogueViolation[] = [];
  const keys = [...new Set(LOCALES.flatMap((l) => Object.keys(catalogues[l] ?? {})))].sort();

  for (const key of keys) {
    for (const locale of LOCALES) {
      const value = catalogues[locale]?.[key];
      if (value === undefined) {
        out.push({ locale, key, rule: "missing_key", detail: `key is absent from the ${locale} catalogue` });
        continue;
      }
      if (value.trim() === "") {
        out.push({ locale, key, rule: "empty_value", detail: "value is empty or whitespace only" });
        continue;
      }
      if (value !== value.trim()) {
        out.push({ locale, key, rule: "trailing_whitespace", detail: `value is "${value}" — trim it` });
      }
      if (exempt(key)) continue;
      if (COMPONENT_NAME.test(value.trim())) {
        out.push({ locale, key, rule: "component_name_leak", detail: `"${value}" looks like a component name, not a sentence` });
      }
      if (locale === "en" && ARABIC.test(value)) {
        out.push({ locale, key, rule: "wrong_script", detail: "an English value contains Arabic characters" });
      }
      if (locale === "ar" && !ARABIC.test(value) && LATIN_WORD.test(value)) {
        out.push({ locale, key, rule: "wrong_script", detail: "an Arabic value contains no Arabic characters" });
      }
    }

    if (exempt(key)) continue;
    const en = catalogues.en?.[key];
    const ar = catalogues.ar?.[key];
    if (en !== undefined && ar !== undefined && en === ar && LATIN_WORD.test(en)) {
      out.push({ locale: "ar", key, rule: "source_language_fallback", detail: `the Arabic value is the English one verbatim: "${en}"` });
    }
  }
  return out;
}
```

Add to `packages/i18n/src/index.ts`:

```ts
export { CATALOGUE_RULES, checkCatalogues, type CatalogueViolation } from "./completeness";
```

- [ ] **Step 5: Run the checker test to see it pass**

```bash
bun run --cwd packages/i18n test
```

Expected: PASS — 9 + 12 + 8 tests (`catalogue.test.ts`, `format.test.ts`, `completeness.test.ts`). If "passes the shipped catalogues" fails, fix `catalogues/*.json`, never the rule.

- [ ] **Step 6: Write the failing test for the lint rule**

`tests/invariants/lint-rules.test.ts` — the `tests` workspace is the only tier that may import both `scripts/` and every package (§3.1):

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/no-hardcoded-string";

const ROOT = resolve(__dirname, "../..");

const src = (path: string, text: string) => ({ path, text });

/** Absent-directory-tolerant: `packages/ui/src` and `apps/backoffice/src` arrive in Tasks 4 and 5. */
const walk = (dir: string, out: { path: string; text: string }[] = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(src(full, readFileSync(full, "utf8")));
  }
  return out;
};

describe("no-hardcoded-string", () => {
  it("is registered under its contract name", () => {
    expect(rule.name).toBe("no-hardcoded-string");
  });

  it("flags a bare JSX text node in a component", () => {
    const v = rule.run([src("packages/ui/src/button.tsx", `export const B = () => <button>Save changes</button>;`)]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("flags a human-readable JSX attribute", () => {
    const v = rule.run([
      src("apps/backoffice/src/x.tsx", `export const X = () => <input placeholder="Search users" />;`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("placeholder");
  });

  it("flags a string literal passed as a JSX child expression", () => {
    const v = rule.run([src("apps/backoffice/src/x.tsx", `export const X = () => <span>{"Sign out"}</span>;`)]);
    expect(v).toHaveLength(1);
  });

  it("accepts a translated string", () => {
    const v = rule.run([
      src("apps/backoffice/src/x.tsx", `export const X = () => <span>{t("app.signOut")}</span>;`),
    ]);
    expect(v).toEqual([]);
  });

  it("accepts punctuation, digits and single letters", () => {
    const v = rule.run([
      src("packages/ui/src/x.tsx", `export const X = () => <span aria-hidden="true">·</span>;`),
    ]);
    expect(v).toEqual([]);
  });

  it("accepts an explicitly exempted line", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        `export const X = () => (\n  // i18n-exempt: brand name, never translated\n  <span>Dulja</span>\n);`,
      ),
    ]);
    expect(v).toEqual([]);
  });

  it("ignores stories, tests and files outside the UI trees", () => {
    expect(rule.run([src("packages/ui/src/button.stories.tsx", `<button>Save changes</button>;`)])).toEqual([]);
    expect(rule.run([src("apps/backoffice/test/x.test.tsx", `<button>Save changes</button>;`)])).toEqual([]);
    expect(rule.run([src("apps/api/src/routes/x.ts", `const s = "Save changes";`)])).toEqual([]);
  });

  it("reports zero violations across the shipped UI trees (DoD 0.12)", () => {
    const files = [
      ...walk(join(ROOT, "packages/ui/src")),
      ...walk(join(ROOT, "apps/backoffice/src")),
    ].map((f) => src(f.path.slice(ROOT.length + 1).replaceAll("\\", "/"), f.text));
    expect(rule.run(files)).toEqual([]);
  });
});
```

`tests/tsconfig.json` must see `scripts/`; add it to `include`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["invariants", "regression", "golden", "e2e", "vitest.config.ts", "playwright.config.ts", "../scripts/lint"]
}
```

- [ ] **Step 7: Run it to see it fail**

```bash
bun run --cwd tests test -- lint-rules
```

Expected: FAIL — `Failed to resolve import "../../scripts/lint/rules/no-hardcoded-string"`.

- [ ] **Step 8: Write `scripts/lint/rules/no-hardcoded-string.ts`**

```ts
import ts from "typescript";
import type { LintRule, LintViolation, SourceFile } from "../types";   // 0B's scripts/lint/types.ts

/** The trees a user-facing string may only reach through i18next (spec:2061). */
const UI_TREES = ["packages/ui/src/", "apps/backoffice/src/"];
/** Files where a literal is legitimate: stories are documentation, tests are fixtures. */
const IGNORED = /(\.stories\.tsx|\.test\.tsx|\.test\.ts|\.d\.ts)$/;
/** Attributes a human reads. `id`, `className`, `name`, `type`, `role` are not on this list. */
const HUMAN_ATTRIBUTES = new Set(["title", "placeholder", "label", "alt", "aria-label", "aria-description", "aria-placeholder"]);
/** Two or more Latin or Arabic letters in a row: prose. "·", "—", "42", "OK" pass. */
const PROSE = /[A-Za-z؀-ۿ]{2,}/;
const EXEMPT_COMMENT = "i18n-exempt";

const inScope = (path: string): boolean =>
  UI_TREES.some((tree) => path.startsWith(tree)) && !IGNORED.test(path) && path.endsWith(".tsx");

export const rule: LintRule = {
  name: "no-hardcoded-string",
  run(files: SourceFile[]): LintViolation[] {
    const out: LintViolation[] = [];
    for (const file of files) {
      if (!inScope(file.path)) continue;
      const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
      const lines = file.text.split(/\r?\n/);

      const report = (node: ts.Node, detail: string): void => {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        // An `// i18n-exempt: <reason>` comment on this line or the one above waives the rule.
        if ((lines[line] ?? "").includes(EXEMPT_COMMENT) || (lines[line - 1] ?? "").includes(EXEMPT_COMMENT)) return;
        out.push({ file: file.path, line: line + 1, rule: "no-hardcoded-string", detail });
      };

      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node) && PROSE.test(node.text)) {
          report(node, `JSX text "${node.text.trim()}" is not translated — wrap it in t("<key>")`);
        } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
          const init = node.initializer;
          if (init && ts.isStringLiteral(init) && HUMAN_ATTRIBUTES.has(node.name.text) && PROSE.test(init.text)) {
            report(node, `attribute ${node.name.text}="${init.text}" is not translated — wrap it in t("<key>")`);
          }
        } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression) && PROSE.test(node.expression.text)) {
          report(node, `JSX child "${node.expression.text}" is a literal — wrap it in t("<key>")`);
        }
        ts.forEachChild(node, visit);
      };

      visit(source);
    }
    return out;
  },
};
```

- [ ] **Step 9: Run the lint-rule test to see it pass**

```bash
bun run --cwd tests test -- lint-rules
```

Expected: PASS — 9 tests in `tests/invariants/lint-rules.test.ts`. The last one ("zero violations across the shipped UI trees") passes vacuously now — `walk` returns `[]` for a directory that does not exist yet, which is why the `existsSync` guard is in it. It becomes load-bearing from Task 4 onward and must never be deleted.

- [ ] **Step 10: Create the regression file `tests/regression/legacy-085.test.ts`**

0E is the first slice in execution order to touch LEGACY-085, so it **creates** the file with a `— 0E` block (§3.7.3); later UI slices append their own blocks and never edit this one.

```ts
import { describe, expect, it } from "vitest";
import { CATALOGUES, checkCatalogues, createI18n, LOCALES } from "@dulja/i18n";

describe("LEGACY-085 The English build was never proofread — 0E", () => {
  it("no translation is empty (the legacy build shipped 122)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "empty_value")).toEqual([]);
  });

  it("no key exists in one catalogue and not the other", () => {
    expect(checkCatalogues().filter((v) => v.rule === "missing_key")).toEqual([]);
  });

  it("no Arabic string reaches an English value (the legacy build shipped 61, two of them dialogs)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "wrong_script" && v.locale === "en")).toEqual([]);
  });

  it("no Arabic value is the English string verbatim", () => {
    expect(checkCatalogues().filter((v) => v.rule === "source_language_fallback")).toEqual([]);
  });

  it("no value has trailing whitespace (the legacy build shipped 232)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "trailing_whitespace")).toEqual([]);
  });

  it("no raw component name is shipped as UI text (the legacy build shipped \"TBXToolbar3\")", () => {
    expect(checkCatalogues().filter((v) => v.rule === "component_name_leak")).toEqual([]);
  });

  it("a missing Arabic value renders the key, never the English string (fallbackLng: false)", async () => {
    const i18n = await createI18n({
      locale: "ar",
      catalogues: { en: { "x.y": "Save changes" }, ar: {} },
    });
    expect(i18n.t("x.y")).toBe("x.y");
    expect(i18n.t("x.y")).not.toBe("Save changes");
  });

  it("every shipped key is reachable in both locales", async () => {
    for (const locale of LOCALES) {
      const i18n = await createI18n({ locale });
      for (const key of Object.keys(CATALOGUES.en)) {
        expect(i18n.t(key), `${locale}:${key}`).not.toBe(key);
      }
    }
  });
});
```

`tests/package.json` needs `@dulja/i18n` as a workspace dependency:

```bash
bun add --cwd tests @dulja/i18n@workspace:*
```

- [ ] **Step 11: Run the whole test tier and the rule runner**

```bash
bun run --cwd tests test && bun run lint:rules
```

Expected: both green; `lint:rules` prints nothing and exits 0.

- [ ] **Step 12: Commit**

```bash
git add packages/i18n scripts/lint tests
git commit -m "feat(i18n): catalogue completeness checker, no-hardcoded-string lint, legacy-085 [0E T3]

The two CI checks spec:2061 requires: both catalogues complete, and a hard-coded
string in packages/ui/src or apps/backoffice/src fails the build.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: `packages/ui` — tokens, the logical-properties Tailwind preset, `DirectionProvider`, keyboard-first primitives, Storybook

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`, `packages/ui/src/tokens.css`, `packages/ui/src/tailwind-preset.ts`, `packages/ui/src/direction.tsx`, `packages/ui/src/button.tsx`, `packages/ui/src/text-field.tsx`, `packages/ui/src/select.tsx`, `packages/ui/src/data-grid.tsx`, `packages/ui/src/index.ts`, `packages/ui/src/button.stories.tsx`, `packages/ui/src/text-field.stories.tsx`, `packages/ui/src/data-grid.stories.tsx`, `packages/ui/.storybook/main.ts`, `packages/ui/.storybook/preview.tsx`
- Modify: root `package.json` (`storybook` script), `.oxlintrc.json` (no-console override for `*.stories.tsx`)
- Test: `packages/ui/test/logical-properties.test.ts`, `packages/ui/test/direction.test.tsx`, `packages/ui/test/data-grid.test.tsx`

**Interfaces:**
- Consumes: `@dulja/i18n` — `dirFor`, `Dir`, `Locale` (Task 1). **Nothing else internal**: §3.1 fixes `@dulja/ui` as "imports `@dulja/i18n` only", so no primitive knows about `@dulja/contracts`, HTTP, or the permission catalogue.
- Produces:
  ```ts
  // packages/ui/src/index.ts
  export { DirectionProvider, useDirection, type DirectionValue } from "./direction";
  export { Button, type ButtonProps } from "./button";
  export { TextField, type TextFieldProps } from "./text-field";
  export { Select, type SelectProps, type SelectOption } from "./select";
  export { DataGrid, type DataGridProps, type Column } from "./data-grid";
  export { tailwindPreset, PHYSICAL_PROPERTY_PATTERNS } from "./tailwind-preset";
  // side-effect import for consumers: import "@dulja/ui/tokens.css";
  ```

**This export list is closed for Phase 0, and deliberately holds no composites.** `@dulja/ui` ships five
things a screen cannot build correctly on its own — direction, focus order, the logical-property preset,
and three inputs whose keyboard and RTL behaviour is proven by `direction.test.tsx` and `data-grid.test.tsx`.
Anything assembled *from* those — a page header, a dialog, a report table — is an application composite and
lives in `apps/backoffice/src/components/`, where it is free to reach application state, routes, permissions
and the problem envelope, none of which a `@dulja/ui` module may import (§3.1 pins `@dulja/ui` to "imports
`@dulja/i18n` only"). A later slice therefore writes its own composite locally rather than waiting on this
package; 1B does exactly that with `PageHeader`, `Modal` and `ReportTable`, and no name here collides. Their
three shapes are the three reasons the line sits where it does, and only one of them is an import rule:
1B's `ReportTable` does `import { useShell } from "./app-shell"` (1b:3886), which §3.1 forbids outright;
`PageHeader` and `Modal` import nothing illegal — they are markup assemblies (a `<header>` with a title
slot; a native `<dialog>` whose focus trap and Escape-to-close are the platform's, not a keyboard model
this package would have to prove) — so their bar is not legality but the RTL test budget below.
Promoting one of them into `@dulja/ui` is not a drive-by: it takes a §4 amendment adding the export, plus a
`packages/ui/src/*.tsx` created **in this slice's file** with a story in both directions and a test in
`packages/ui/test/`, because a primitive that no acceptance test drives in RTL is how test 23 regresses.

- [ ] **Step 1: Create the workspace and install**

`packages/ui/package.json`:

```json
{
  "name": "@dulja/ui",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/tokens.css",
    "./tailwind-preset": "./src/tailwind-preset.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "storybook": "storybook dev -p 6006 --no-open",
    "build-storybook": "storybook build -o storybook-static"
  }
}
```

```bash
bun add --cwd packages/ui @dulja/i18n@workspace:* clsx
bun add --cwd packages/ui --peer react react-dom
bun add --cwd packages/ui -d react react-dom @types/react @types/react-dom tailwindcss @tailwindcss/vite \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom @vitejs/plugin-react \
  storybook @storybook/react-vite
```

`packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["node"] },
  "include": ["src", "test", ".storybook", "vitest.config.ts"]
}
```

`packages/ui/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
```

`packages/ui/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Add the no-console override for stories to `.oxlintrc.json` (stories log nothing today, but Storybook idioms do; keeping the glob list honest is cheaper than a later surprise):

```json
{ "files": ["packages/*/src/cli.ts", "**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "tests/e2e/**"], "rules": { "no-console": "off" } }
```

- [ ] **Step 2: Write the failing tests**

`packages/ui/test/logical-properties.test.ts` — the mechanical half of spec:2253 ("RTL and LTR parity on every screen"). A physical property is the single most common way an Arabic screen silently breaks:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHYSICAL_PROPERTY_PATTERNS } from "../src/tailwind-preset";

const SRC = resolve(__dirname, "../src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".tsx") || f.endsWith(".css"));

describe("logical properties only", () => {
  it("exports the blocklist it is checked against", () => {
    expect(PHYSICAL_PROPERTY_PATTERNS.length).toBeGreaterThan(8);
  });

  it("no primitive uses a physical Tailwind utility or CSS property", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".stories.tsx")) continue;
      const text = readFileSync(join(SRC, file), "utf8");
      for (const line of text.split(/\r?\n/).entries()) {
        const [index, content] = line;
        for (const pattern of PHYSICAL_PROPERTY_PATTERNS) {
          if (new RegExp(pattern).test(content)) {
            offenders.push(`${file}:${index + 1} matches /${pattern}/ — ${content.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

`packages/ui/test/direction.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DirectionProvider, useDirection } from "../src/direction";

const Probe = () => {
  const { locale, dir } = useDirection();
  return <span data-testid="probe">{`${locale}/${dir}`}</span>;
};

describe("DirectionProvider", () => {
  it("puts lang and dir on the document root for English", () => {
    render(<DirectionProvider locale="en"><Probe /></DirectionProvider>);
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
    expect(screen.getByTestId("probe")).toHaveTextContent("en/ltr");
  });

  it("switches the document root to rtl for Arabic", () => {
    render(<DirectionProvider locale="ar"><Probe /></DirectionProvider>);
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    expect(screen.getByTestId("probe")).toHaveTextContent("ar/rtl");
  });

  it("refuses to be used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow("useDirection must be used inside <DirectionProvider>");
  });
});
```

`packages/ui/test/data-grid.test.tsx` — "no mouse required" (spec:2254), and the arrow keys must follow **visual** order, which reverses in Arabic:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DataGrid, type Column } from "../src/data-grid";
import { DirectionProvider } from "../src/direction";

interface Row { id: string; email: string; name: string }
const columns: Column<Row>[] = [
  { key: "email", header: "E-mail", cell: (r) => r.email },
  { key: "name", header: "Name", cell: (r) => r.name },
];
const rows: Row[] = [
  { id: "1", email: "a@example.test", name: "Aisha" },
  { id: "2", email: "b@example.test", name: "Bilal" },
];

const grid = (locale: "en" | "ar") => (
  <DirectionProvider locale={locale}>
    <DataGrid caption="Users" columns={columns} rows={rows} rowKey={(r) => r.id} emptyLabel="Nothing" />
  </DirectionProvider>
);

describe("DataGrid keyboard model", () => {
  it("is reachable by Tab and lands on the first cell", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("moves down and up with the arrow keys", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-cell", "1:0");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("ArrowRight advances a column in English", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
  });

  it("ArrowLeft advances a column in Arabic — visual order reverses with the direction", async () => {
    const user = userEvent.setup();
    render(grid("ar"));
    await user.tab();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("Home and End jump to the first and last column", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
    await user.keyboard("{Home}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("Enter activates the focused row (the OD-24 model's row selection)", async () => {
    const user = userEvent.setup();
    const activated: Row[] = [];
    render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r: Row) => r.id}
          emptyLabel="Nothing"
          onActivate={(r: Row) => activated.push(r)}
        />
      </DirectionProvider>,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(activated).toEqual([rows[1]]);
  });

  it("renders an accessible table with a caption and column headers", () => {
    render(grid("en"));
    expect(screen.getByRole("table", { name: "Users" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("shows the empty label and no rows when there is nothing", () => {
    render(
      <DirectionProvider locale="en">
        <DataGrid caption="Users" columns={columns} rows={[]} rowKey={(r: Row) => r.id} emptyLabel="Nothing" />
      </DirectionProvider>,
    );
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    // Two `row`s in the DOM: the `<thead>` header row and the single `<tbody>` row carrying the
    // empty label's `colSpan` cell (Step 7 renders both). "No data rows" is proved by there being
    // exactly one cell, spanning every column — not by counting rows.
    expect(screen.queryAllByRole("row")).toHaveLength(2);
    const cells = screen.queryAllByRole("cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("colspan", String(columns.length));
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
bun run --cwd packages/ui test
```

Expected: FAIL — `Failed to resolve import "../src/tailwind-preset"` and `"../src/direction"`.

- [ ] **Step 4: Write the tokens and the preset**

`packages/ui/src/tokens.css` — spec:2251 "Design system with tokens". Contrast ratios against their surface are in the comment; every pair clears WCAG 2.2 AA (4.5:1 for text, 3:1 for UI boundaries):

```css
/* Dulja design tokens. Values are the single source; Tailwind reads them through tailwind-preset.ts. */
:root {
  color-scheme: light dark;

  /* Arabic needs a face with full shaping; the stack names one before falling back. */
  --dulja-font-sans: "Segoe UI", "Noto Sans Arabic", "Noto Sans", system-ui, sans-serif;
  --dulja-font-mono: "Cascadia Mono", "Noto Sans Mono", ui-monospace, monospace;

  --dulja-space-1: 0.25rem;
  --dulja-space-2: 0.5rem;
  --dulja-space-3: 0.75rem;
  --dulja-space-4: 1rem;
  --dulja-space-6: 1.5rem;
  --dulja-space-8: 2rem;

  --dulja-radius-sm: 0.25rem;
  --dulja-radius-md: 0.5rem;

  --dulja-color-surface: #ffffff;
  --dulja-color-surface-raised: #f5f6f8;
  --dulja-color-border: #c3c8d0;          /* 3.1:1 on surface — AA for a UI boundary */
  --dulja-color-text: #12161c;            /* 16.9:1 on surface */
  --dulja-color-text-muted: #4a5058;      /* 8.1:1 on surface */
  --dulja-color-accent: #17457a;          /* 8.9:1 with accent-text */
  --dulja-color-accent-text: #ffffff;
  --dulja-color-danger: #8c1d18;          /* 8.6:1 with danger-text */
  --dulja-color-danger-text: #ffffff;
  --dulja-color-focus: #0b6bcb;           /* 3.4:1 on surface — AA for a focus indicator */
}

@media (prefers-color-scheme: dark) {
  :root {
    --dulja-color-surface: #12161c;
    --dulja-color-surface-raised: #1b212a;
    --dulja-color-border: #454c57;
    --dulja-color-text: #f2f4f7;
    --dulja-color-text-muted: #b3bac4;
    --dulja-color-accent: #9cc4f2;
    --dulja-color-accent-text: #0a1420;
    --dulja-color-danger: #f2b8b5;
    --dulja-color-danger-text: #4a0e0b;
    --dulja-color-focus: #9cc4f2;
  }
}

/* One focus indicator for the whole system — keyboard operability is a requirement, not a preference. */
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--dulja-color-focus);
  outline-offset: 2px;
}
```

`packages/ui/src/tailwind-preset.ts`:

```ts
import type { Config } from "tailwindcss";

/**
 * Physical directional properties. Every one of them lays out correctly in English and wrongly in
 * Arabic, which is why the whole set is banned in `packages/ui/src` and `apps/backoffice/src` and
 * checked by `test/logical-properties.test.ts`. The logical replacement is in the comment.
 */
export const PHYSICAL_PROPERTY_PATTERNS: readonly string[] = [
  "\\bm[lr]-",              // ml-/mr-      → ms-/me-
  "\\bp[lr]-",              // pl-/pr-      → ps-/pe-
  "\\b(left|right)-\\d",    // left-0       → start-0/end-0
  "\\btext-(left|right)\\b",// text-left    → text-start/text-end
  "\\bborder-[lr]\\b",      // border-l     → border-s/border-e
  "\\brounded-[tb]?[lr]\\b",// rounded-l    → rounded-s/rounded-e
  "\\bfloat-(left|right)\\b",
  "margin-(left|right)\\s*:",
  "padding-(left|right)\\s*:",
  "\\b(left|right)\\s*:\\s*[^;]*;",
  "text-align\\s*:\\s*(left|right)",
];

/**
 * The Tailwind preset every Dulja surface extends. It maps the CSS custom properties of tokens.css
 * onto Tailwind's scales, so a component names `bg-surface`, never a hex value.
 */
export const tailwindPreset = {
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--dulja-font-sans)"],
        mono: ["var(--dulja-font-mono)"],
      },
      colors: {
        surface: "var(--dulja-color-surface)",
        "surface-raised": "var(--dulja-color-surface-raised)",
        border: "var(--dulja-color-border)",
        text: "var(--dulja-color-text)",
        "text-muted": "var(--dulja-color-text-muted)",
        accent: "var(--dulja-color-accent)",
        "accent-text": "var(--dulja-color-accent-text)",
        danger: "var(--dulja-color-danger)",
        "danger-text": "var(--dulja-color-danger-text)",
        focus: "var(--dulja-color-focus)",
      },
      spacing: {
        1: "var(--dulja-space-1)",
        2: "var(--dulja-space-2)",
        3: "var(--dulja-space-3)",
        4: "var(--dulja-space-4)",
        6: "var(--dulja-space-6)",
        8: "var(--dulja-space-8)",
      },
      borderRadius: { sm: "var(--dulja-radius-sm)", md: "var(--dulja-radius-md)" },
    },
  },
} satisfies Partial<Config>;

export default tailwindPreset;
```

- [ ] **Step 5: Write `src/direction.tsx`**

```tsx
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { dirFor, type Dir, type Locale } from "@dulja/i18n";

export interface DirectionValue {
  locale: Locale;
  dir: Dir;
}

const DirectionContext = createContext<DirectionValue | null>(null);

export interface DirectionProviderProps {
  locale: Locale;
  children: ReactNode;
  /** Test seam: the document whose root receives `lang`/`dir`. Defaults to the ambient one. */
  target?: Document;
}

/**
 * The one place `dir` is decided (spec:2253). Nothing reads `navigator.language` and nothing infers
 * direction from content — the locale decides, and the document root carries it so CSS logical
 * properties resolve for every descendant, including portalled dialogs.
 */
export function DirectionProvider({ locale, children, target }: DirectionProviderProps) {
  const value = useMemo<DirectionValue>(() => ({ locale, dir: dirFor(locale) }), [locale]);
  useEffect(() => {
    const root = (target ?? globalThis.document)?.documentElement;
    if (!root) return;
    root.setAttribute("lang", locale);
    root.setAttribute("dir", value.dir);
  }, [locale, target, value.dir]);
  return <DirectionContext.Provider value={value}>{children}</DirectionContext.Provider>;
}

export function useDirection(): DirectionValue {
  const value = useContext(DirectionContext);
  if (value === null) throw new Error("useDirection must be used inside <DirectionProvider>");
  return value;
}
```

- [ ] **Step 6: Write the three simple primitives**

`packages/ui/src/button.tsx`:

```tsx
import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  children: ReactNode;
}

const VARIANTS = {
  primary: "bg-accent text-accent-text border-accent",
  secondary: "bg-surface text-text border-border",
  danger: "bg-danger text-danger-text border-danger",
} as const;

export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center gap-2 rounded-sm border px-4 py-2 text-start disabled:opacity-60",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
```

`packages/ui/src/text-field.tsx`:

```tsx
import clsx from "clsx";
import { useId, type InputHTMLAttributes } from "react";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Already translated by the caller — `packages/ui` never calls `t` (§3.1). */
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, className, ...rest }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-start text-text">{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={clsx(hint && hintId, error && errorId) || undefined}
        className={clsx(
          "rounded-sm border border-border bg-surface px-3 py-2 text-start text-text",
          error && "border-danger",
          className,
        )}
        {...rest}
      />
      {hint ? <p id={hintId} className="text-start text-text-muted">{hint}</p> : null}
      {error ? <p id={errorId} role="alert" className="text-start text-danger">{error}</p> : null}
    </div>
  );
}
```

`packages/ui/src/select.tsx`:

```tsx
import clsx from "clsx";
import { useId, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  /** Already translated by the caller. */
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> {
  label: string;
  options: readonly SelectOption[];
}

export function Select({ label, options, className, ...rest }: SelectProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-start text-text">{label}</label>
      <select
        id={id}
        className={clsx("rounded-sm border border-border bg-surface px-3 py-2 text-start text-text", className)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 7: Write `src/data-grid.tsx` — the keyboard model**

```tsx
import clsx from "clsx";
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDirection } from "./direction";

export interface Column<T> {
  key: string;
  /** Already translated by the caller. */
  header: string;
  cell: (row: T) => ReactNode;
  align?: "start" | "end";
}

export interface DataGridProps<T> {
  /** Already translated by the caller. */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  emptyLabel: string;
  /** `Enter` on any cell of a row activates that row — the OD-24 default model's row selection. */
  onActivate?: (row: T) => void;
}

/**
 * A roving-tabindex grid: one Tab stop for the whole table, arrows inside it (spec:2254 —
 * "no mouse required"). ArrowLeft/ArrowRight are mapped through the ambient direction, so the
 * *visual* next column is always to the reader's advancing side — the clause of acceptance test 23
 * that says "column order" (spec:2441).
 */
export function DataGrid<T>({ caption, columns, rows, rowKey, emptyLabel, onActivate }: DataGridProps<T>) {
  const { dir } = useDirection();
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const container = useRef<HTMLTableSectionElement>(null);

  const move = useCallback(
    (rowDelta: number, colDelta: number) => {
      setFocus((current) => {
        const row = Math.min(Math.max(current.row + rowDelta, 0), Math.max(rows.length - 1, 0));
        const col = Math.min(Math.max(current.col + colDelta, 0), columns.length - 1);
        container.current
          ?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)
          ?.focus();
        return { row, col };
      });
    },
    [columns.length, rows.length],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    switch (event.key) {
      case "ArrowDown": move(1, 0); break;
      case "ArrowUp": move(-1, 0); break;
      case forward: move(0, 1); break;
      case backward: move(0, -1); break;
      case "Home": move(0, -columns.length); break;
      case "End": move(0, columns.length); break;
      case "Enter": {
        const row = rows[focus.row];
        if (row !== undefined && onActivate !== undefined) onActivate(row);
        break;
      }
      default: return;
    }
    event.preventDefault();
  };

  return (
    <table className="w-full border-collapse text-start">
      <caption className="text-start text-text-muted">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={clsx("border-b border-border py-2 text-text", column.align === "end" ? "text-end" : "text-start")}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody ref={container} onKeyDown={onKeyDown}>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="py-6 text-center text-text-muted">{emptyLabel}</td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={rowKey(row)}>
              {columns.map((column, colIndex) => (
                <td
                  key={column.key}
                  data-cell={`${rowIndex}:${colIndex}`}
                  tabIndex={focus.row === rowIndex && focus.col === colIndex ? 0 : -1}
                  onFocus={() => setFocus({ row: rowIndex, col: colIndex })}
                  className={clsx("border-b border-border py-2 text-text", column.align === "end" ? "text-end" : "text-start")}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
```

`packages/ui/src/index.ts`:

```ts
export { Button, type ButtonProps } from "./button";
export { DataGrid, type Column, type DataGridProps } from "./data-grid";
export { DirectionProvider, useDirection, type DirectionProviderProps, type DirectionValue } from "./direction";
export { Select, type SelectOption, type SelectProps } from "./select";
export { PHYSICAL_PROPERTY_PATTERNS, tailwindPreset } from "./tailwind-preset";
export { TextField, type TextFieldProps } from "./text-field";
```

- [ ] **Step 8: Run the tests to see them pass**

```bash
bun run --cwd packages/ui test
```

Expected: PASS — 2 + 3 + 8 tests (`logical-properties.test.ts`, `direction.test.tsx`, `data-grid.test.tsx`). If the Arabic arrow test fails, `move` is not reading `dir`; do not "fix" it by swapping the keys unconditionally — the mapping must come from the provider, because the same grid renders both ways in one session.

- [ ] **Step 9: Storybook — one story per primitive, both directions**

`packages/ui/.storybook/main.ts`:

```ts
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
};
export default config;
```

`packages/ui/.storybook/preview.tsx`:

```tsx
import type { Decorator, Preview } from "@storybook/react-vite";
import { DirectionProvider } from "../src/direction";
import "../src/tokens.css";

const withDirection: Decorator = (Story, context) => (
  <DirectionProvider locale={context.globals["locale"] === "ar" ? "ar" : "en"}>
    <Story />
  </DirectionProvider>
);

const preview: Preview = {
  decorators: [withDirection],
  globalTypes: {
    locale: {
      description: "Locale and text direction",
      defaultValue: "en",
      toolbar: {
        icon: "globe",
        items: [
          { value: "en", title: "English (ltr)" },
          { value: "ar", title: "العربية (rtl)" },
        ],
      },
    },
  },
};
export default preview;
```

`packages/ui/src/button.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

const meta: Meta<typeof Button> = { title: "Primitives/Button", component: Button };
export default meta;

export const Primary: StoryObj<typeof Button> = { args: { variant: "primary", children: "Save" } };
export const Secondary: StoryObj<typeof Button> = { args: { variant: "secondary", children: "Cancel" } };
export const Danger: StoryObj<typeof Button> = { args: { variant: "danger", children: "Expire assignment" } };
```

`packages/ui/src/text-field.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextField } from "./text-field";

const meta: Meta<typeof TextField> = { title: "Primitives/TextField", component: TextField };
export default meta;

export const WithHint: StoryObj<typeof TextField> = {
  args: { label: "E-mail", hint: "The address the invitation is sent to", placeholder: "name@example.test" },
};
export const WithError: StoryObj<typeof TextField> = {
  args: { label: "E-mail", error: "That address is already a member of this tenant" },
};
```

`packages/ui/src/data-grid.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataGrid, type Column } from "./data-grid";

interface Row { id: string; email: string; roles: string }
const columns: Column<Row>[] = [
  { key: "email", header: "E-mail", cell: (r) => r.email },
  { key: "roles", header: "Roles", cell: (r) => r.roles, align: "end" },
];

const meta: Meta<typeof DataGrid<Row>> = { title: "Primitives/DataGrid", component: DataGrid<Row> };
export default meta;

export const TwoRows: StoryObj<typeof DataGrid<Row>> = {
  args: {
    caption: "Users and roles",
    columns,
    rows: [
      { id: "1", email: "aisha@example.test", roles: "admin" },
      { id: "2", email: "bilal@example.test", roles: "accountant, auditor" },
    ],
    rowKey: (r: Row) => r.id,
    emptyLabel: "Nothing to show yet.",
  },
};

export const Empty: StoryObj<typeof DataGrid<Row>> = {
  args: { ...TwoRows.args, rows: [] } as StoryObj<typeof DataGrid<Row>>["args"],
};
```

Add the root script to `package.json`:

```json
"storybook": "bun run --cwd packages/ui storybook"
```

Verify it boots and both directions render:

```bash
bun run storybook
```

Expected: Storybook serves on `http://localhost:6006`; switching the globe toolbar to **العربية (rtl)** mirrors the DataGrid — headers start on the right, the `align: "end"` column ends on the left. Screenshot both for the PR (spec:2274 "both text directions checked if the UI changed"). Stop it with Ctrl-C.

- [ ] **Step 10: Root checks and commit**

```bash
bun run lint && bun run format:check && bun run typecheck && bun run test && bun run lint:rules
```

Expected: all green. `lint:rules` must still print nothing — the primitives contain literal English (`"Save"` in the story, and the `label` props are *parameters*, not literals), and `no-hardcoded-string` ignores `*.stories.tsx` by design.

```bash
git add packages/ui package.json .oxlintrc.json bun.lock
git commit -m "feat(ui): tokens, logical-properties preset, DirectionProvider, keyboard grid, Storybook [0E T4]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `apps/backoffice` — the Vite/React 19/TanStack scaffold, direction switching, the problem envelope, the typed API client

**Files:**
- Create: `apps/backoffice/package.json`, `apps/backoffice/tsconfig.json`, `apps/backoffice/vite.config.ts`, `apps/backoffice/vitest.config.ts`, `apps/backoffice/tailwind.config.ts`, `apps/backoffice/index.html`, `apps/backoffice/src/main.tsx`, `apps/backoffice/src/app.css`, `apps/backoffice/src/router.tsx`, `apps/backoffice/src/lib/env.ts`, `apps/backoffice/src/lib/problem.ts`, `apps/backoffice/src/lib/admin-api.ts`, `apps/backoffice/src/components/app-shell.tsx`, `apps/backoffice/test/setup.ts`
- Test: `apps/backoffice/test/shell.test.tsx`

**Interfaces:**
- Consumes: `@dulja/ui` (Task 4) — `DirectionProvider`, `Button`, `Select`, `DataGrid`; `@dulja/i18n` (Tasks 1–3) — `createI18n`, `LOCALES`, `isLocale`, `formatDate`, `formatTimestamp`; `@dulja/contracts` (0B) — `ProblemSchema` and `Problem` (§4.2.4, §4.2.8).
- Produces:
  ```ts
  // apps/backoffice/src/lib/env.ts
  export interface AppEnvVars { apiBaseUrl: string; supabaseUrl: string; supabaseAnonKey: string; sentryDsn?: string; appEnv: "dev" | "staging" | "production" }
  export function readEnv(source?: Record<string, unknown>): AppEnvVars;

  // apps/backoffice/src/lib/problem.ts
  export class ApiError extends Error { readonly problem: Problem }
  export function problemMessage(problem: Problem, t: (key: string, vars?: Record<string, unknown>) => string): string;

  // apps/backoffice/src/lib/admin-api.ts
  export interface AdminApiOptions { baseUrl: string; accessToken: () => string | null; fetchImpl?: typeof fetch }
  export interface AdminApi {
    get<T>(path: string, schema: ZodType<T>): Promise<T>;
    send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, schema: ZodType<T>): Promise<T>;
  }
  export function createAdminApi(opts: AdminApiOptions): AdminApi;

  // apps/backoffice/src/components/app-shell.tsx
  export function AppShell(props: { children: ReactNode }): JSX.Element;
  export function LocaleSwitcher(): JSX.Element;
  ```

**Why the schema is a parameter.** §4.2.8 fixes the *convention* `<Resource>Schema` / `<Resource>List`, not the individual names, and 0B's plan is not on disk (assumption 2). `AdminApi.get(path, schema)` therefore takes the Zod schema from the call site, so `admin-api.ts` never imports a resource schema and a spelling difference in 0B costs one import line in `users.tsx`.

- [ ] **Step 1: Create the workspace and install**

`apps/backoffice/package.json`:

```json
{
  "name": "@dulja/backoffice",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173 --strictPort",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
```

```bash
bun add --cwd apps/backoffice @dulja/ui@workspace:* @dulja/i18n@workspace:* @dulja/contracts@workspace:* \
  react react-dom @tanstack/react-router @tanstack/react-query react-hook-form @hookform/resolvers zod \
  @supabase/supabase-js i18next react-i18next
bun add --cwd apps/backoffice -d @types/react @types/react-dom @vitejs/plugin-react vite tailwindcss @tailwindcss/vite \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

`apps/backoffice/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"]
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts", "tailwind.config.ts"]
}
```

`apps/backoffice/vite.config.ts` — `base: "/"` because the packaged app is served from the custom `dulja://app` origin registered in Task 10, **not** from `file://`; a real origin is what makes CSP, `localStorage` and the navigation lock work:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: { outDir: "dist", sourcemap: true, emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
```

`apps/backoffice/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["./test/setup.ts"] },
});
```

`apps/backoffice/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`apps/backoffice/tailwind.config.ts`:

```ts
import { tailwindPreset } from "@dulja/ui/tailwind-preset";
import type { Config } from "tailwindcss";

export default {
  presets: [tailwindPreset],
  content: ["./index.html", "./src/**/*.tsx", "../../packages/ui/src/**/*.tsx"],
} satisfies Config;
```

`apps/backoffice/index.html` — `lang`/`dir` are placeholders; `DirectionProvider` overwrites both on mount:

```html
<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dulja</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/backoffice/src/app.css`:

```css
@import "tailwindcss";
@import "@dulja/ui/tokens.css";

body {
  margin: 0;
  background: var(--dulja-color-surface);
  color: var(--dulja-color-text);
  font-family: var(--dulja-font-sans);
}
```

- [ ] **Step 2: Write the failing test**

`apps/backoffice/test/shell.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { createAdminApi } from "../src/lib/admin-api";
import { ApiError, problemMessage } from "../src/lib/problem";
import { readEnv } from "../src/lib/env";

describe("readEnv", () => {
  it("accepts a complete environment", () => {
    expect(
      readEnv({
        VITE_API_BASE_URL: "https://api.example.test",
        VITE_SUPABASE_URL: "https://project.supabase.co",
        VITE_SUPABASE_ANON_KEY: "anon-key",
        VITE_APP_ENV: "staging",
      }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-key",
      appEnv: "staging",
    });
  });

  it("names the missing variable rather than failing at the first fetch", () => {
    expect(() => readEnv({ VITE_API_BASE_URL: "https://api.example.test" })).toThrow(
      /VITE_SUPABASE_URL/,
    );
  });
});

describe("AppShell", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
  });

  it("renders in English by default with dir=ltr on the document root", async () => {
    render(<AppShell><p>content</p></AppShell>);
    await waitFor(() => expect(document.documentElement.getAttribute("dir")).toBe("ltr"));
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("Users and roles")).toBeInTheDocument();
  });

  it("switches the whole shell to Arabic and rtl from the locale switcher, by keyboard", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>content</p></AppShell>);
    await waitFor(() => expect(screen.getByLabelText("Language")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() => expect(document.documentElement.getAttribute("dir")).toBe("rtl"));
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
    expect(screen.getByText("المستخدمون والأدوار")).toBeInTheDocument();
  });

  it("offers a skip link as the first focusable element", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>content</p></AppShell>);
    await waitFor(() => expect(screen.getByText("Skip to content")).toBeInTheDocument());
    await user.tab();
    expect(document.activeElement).toHaveTextContent("Skip to content");
  });
});

describe("createAdminApi", () => {
  const problem = {
    type: "urn:dulja:error:ERR_RBAC_FORBIDDEN",
    title: "Forbidden",
    status: 403,
    detail: "principal 0192… may not manage users in company 0192…",
    instance: "/v1/admin/users",
    code: "ERR_RBAC_FORBIDDEN",
    remedy: "Ask an administrator for the admin.user.manage permission.",
    requestId: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
  };

  it("sends the bearer token and parses the body against the supplied schema", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ id: "1" }], next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = createAdminApi({ baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl });
    const schema = z.object({ items: z.array(z.object({ id: z.string() })), next_cursor: z.string().nullable() });
    await expect(api.get("/v1/admin/users", schema)).resolves.toEqual({ items: [{ id: "1" }], next_cursor: null });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer jwt" });
  });

  it("mints an Idempotency-Key on every unsafe method (§4.2.9)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const api = createAdminApi({ baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl });
    await api.send("POST", "/v1/admin/users", { email: "x@example.test" }, z.object({}));
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("throws an ApiError carrying the parsed problem envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(problem), { status: 403, headers: { "content-type": "application/problem+json" } }),
    );
    const api = createAdminApi({ baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl });
    await expect(api.get("/v1/admin/users", z.object({}))).rejects.toBeInstanceOf(ApiError);
    await api.get("/v1/admin/users", z.object({})).catch((e: ApiError) => {
      expect(e.problem.code).toBe("ERR_RBAC_FORBIDDEN");
      expect(problemMessage(e.problem, (k, v) => `${k}:${JSON.stringify(v ?? {})}`))
        .toContain("principal 0192… may not manage users");
    });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
bun run --cwd apps/backoffice test
```

Expected: FAIL — `Failed to resolve import "../src/components/app-shell"`.

- [ ] **Step 4: Write `src/lib/env.ts`**

```ts
import { z } from "zod";

const EnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_SENTRY_DSN: z.string().min(1).optional(),
  VITE_APP_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
});

export interface AppEnvVars {
  apiBaseUrl: string;
  supabaseUrl: string;
  /** The **publishable** anon key. The service-role key is confined to the seed CLI (§3.11) and never ships here. */
  supabaseAnonKey: string;
  sentryDsn?: string;
  appEnv: "dev" | "staging" | "production";
}

/** Fails at boot, naming the variable — never at the first fetch, with a blank screen. */
export function readEnv(source: Record<string, unknown> = import.meta.env as Record<string, unknown>): AppEnvVars {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${names}`);
  }
  const value = parsed.data;
  return {
    apiBaseUrl: value.VITE_API_BASE_URL,
    supabaseUrl: value.VITE_SUPABASE_URL,
    supabaseAnonKey: value.VITE_SUPABASE_ANON_KEY,
    ...(value.VITE_SENTRY_DSN === undefined ? {} : { sentryDsn: value.VITE_SENTRY_DSN }),
    appEnv: value.VITE_APP_ENV,
  };
}
```

- [ ] **Step 5: Write `src/lib/problem.ts` and `src/lib/admin-api.ts`**

`problem.ts`:

```ts
import { ProblemSchema } from "@dulja/contracts";
import type { Problem } from "@dulja/contracts";

/** Every non-2xx response becomes one of these. The UI never reads `res.status` directly. */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.code}: ${problem.detail}`);
    this.name = "ApiError";
  }
}

export async function toApiError(response: Response, instance: string): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = ProblemSchema.safeParse(body);
  if (parsed.success) return new ApiError(parsed.data as Problem);
  // A response that is not a problem envelope is still an error the user must see, with the request id we have.
  return new ApiError({
    type: "urn:dulja:error:ERR_INTERNAL",
    title: "Internal error",
    status: response.status,
    detail: `The server returned ${response.status} with a body that is not a problem envelope.`,
    instance,
    code: "ERR_INTERNAL",
    remedy: "Retry; if it persists, quote the reference below to support.",
    requestId: response.headers.get("x-request-id") ?? "unknown",
  } as Problem);
}

/**
 * spec:2051 — every error carries "a human message naming the specific entity, and a remedy".
 * The server writes both; the UI shows both plus the request id, and never invents its own wording.
 */
export function problemMessage(
  problem: Problem,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return [
    problem.detail,
    t("problem.remedy", { remedy: problem.remedy }),
    t("problem.reference", { requestId: problem.requestId }),
  ].join(" ");
}
```

`admin-api.ts`:

```ts
import type { ZodType } from "zod";
import { toApiError } from "./problem";

export interface AdminApiOptions {
  baseUrl: string;
  accessToken: () => string | null;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface AdminApi {
  get<T>(path: string, schema: ZodType<T>): Promise<T>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body: unknown, schema: ZodType<T>): Promise<T>;
}

/**
 * The one door to `/v1`. The response schema is a parameter, not an import, so this file never names a
 * resource schema and the §4.2.8 naming convention can be satisfied by 0B in whatever spelling it chose.
 */
export function createAdminApi({ baseUrl, accessToken, fetchImpl = fetch }: AdminApiOptions): AdminApi {
  const call = async <T>(method: string, path: string, body: unknown, schema: ZodType<T>): Promise<T> => {
    const token = accessToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    // §4.2.9: the header is required on every unsafe method; one fresh key per attempt.
    if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await toApiError(response, path);
    return schema.parse(await response.json());
  };

  return {
    get: (path, schema) => call("GET", path, undefined, schema),
    send: (method, path, body, schema) => call(method, path, body, schema),
  };
}
```

- [ ] **Step 6: Write `src/components/app-shell.tsx`**

```tsx
import { DirectionProvider, Select } from "@dulja/ui";
import { createI18n, isLocale, LOCALES, type Locale } from "@dulja/i18n";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { i18n as I18n } from "i18next";

interface ShellValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error("useShell must be used inside <AppShell>");
  return value;
}

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useShell();
  return (
    <Select
      label={t("app.language")}
      value={locale}
      options={LOCALES.map((code) => ({ value: code, label: t(`app.endonym.${code}`) }))}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (isLocale(next)) setLocale(next);
      }}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");          // what the operator asked for
  const [language, setLanguage] = useState<Locale>("en");      // what i18next has actually applied
  const [i18n, setI18n] = useState<I18n | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createI18n({ locale: "en" }).then((instance) => {
      if (cancelled) return;
      setI18n(instance);
      setLanguage("en");
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * `changeLanguage` is a **promise** and fires no React update. Without recording its completion in
   * state, the switch re-renders once with `i18n.language` still the old value, commits the old
   * catalogue's strings, and then nothing re-renders when the promise settles — the chrome stays
   * English forever while `dir` flips. `language` is that record; do not "simplify" it away.
   */
  useEffect(() => {
    if (i18n === null) return;
    let live = true;
    void i18n.changeLanguage(locale).then(() => {
      if (live) setLanguage(locale);
    });
    return () => { live = false; };
  }, [i18n, locale]);

  if (i18n === null) return null;
  // `getFixedT(language)` makes the applied language an explicit input of every lookup, so React's
  // dependency on it is real rather than incidental.
  const fixedT = i18n.getFixedT(language);
  const t = (key: string, vars?: Record<string, unknown>) => fixedT(key, vars ?? {}) as string;

  return (
    // `locale` is what the switcher shows; `language` is what is rendered. Direction follows
    // `language` so that `dir`, `lang` and every string flip in one commit — which is exactly what
    // `shell.test.tsx` and acceptance test 23 assert.
    <ShellContext.Provider value={{ locale, setLocale, t }}>
      <DirectionProvider locale={language}>
        <a href="#main" className="sr-only focus:not-sr-only">{t("app.skipToContent")}</a>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="font-bold">{t("app.name")}</span>
          <LocaleSwitcher />
        </header>
        <div className="flex">
          <nav aria-label={t("app.nav.users")} className="border-e border-border p-4">
            <a href="/admin/users" className="text-start text-accent">{t("app.nav.users")}</a>
          </nav>
          <main id="main" className="flex-1 p-4">{children}</main>
        </div>
      </DirectionProvider>
    </ShellContext.Provider>
  );
}
```

`src/router.tsx` and `src/main.tsx` mount it; the routes themselves arrive in Tasks 6 and 8:

```tsx
// apps/backoffice/src/router.tsx
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});

export const routeTree = rootRoute.addChildren([indexRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
```

```tsx
// apps/backoffice/src/main.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import "./app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 7: Run the test to see it pass**

```bash
bun run --cwd apps/backoffice test
```

Expected: PASS — 8 tests in `apps/backoffice/test/shell.test.tsx` (2 `readEnv` + 3 `AppShell` + 3 `createAdminApi`).

- [ ] **Step 8: Prove the build produces a `dist/` Task 10 can load**

```bash
bun run --cwd apps/backoffice build && ls apps/backoffice/dist
```

Expected: `index.html` plus a hashed `assets/` directory. Task 10's Electron protocol handler serves exactly this directory.

- [ ] **Step 9: Commit**

```bash
git add apps/backoffice package.json bun.lock
git commit -m "feat(backoffice): Vite/React/TanStack shell, direction switching, problem envelope, typed /v1 client [0E T5]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Supabase sign-in and MFA enrolment at `aal1`, with a swappable session store

**Files:**
- Create: `apps/backoffice/src/lib/session-storage.ts`, `apps/backoffice/src/lib/supabase.ts`, `apps/backoffice/src/lib/session.tsx`, `apps/backoffice/src/routes/login.tsx`, `apps/backoffice/src/routes/mfa-enrol.tsx`, `apps/backoffice/src/routes/admin/users.tsx` (the stub Task 8 replaces)
- Modify: `apps/backoffice/src/router.tsx`, `apps/backoffice/src/main.tsx` (Step 7 — the composition root)
- Test: `apps/backoffice/test/login.test.tsx`

**Interfaces:**
- Consumes: `readEnv` (Task 5); `AppShell` / `useShell` (Task 5); `@supabase/supabase-js`; the API's `aal2` rule (§4.2.3 — "MFA-enrolment routes accept `aal1`, everything else requires `aal2`") and its 0.7b DoD clause "the owner logs in, enrols MFA at `aal1`" (spec:2317).
- Produces:
  ```ts
  // apps/backoffice/src/lib/session-storage.ts
  export interface SessionStore {                       // the seam Task 11 plugs the Electron bridge into
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }
  export const browserSessionStore: SessionStore;       // window.localStorage
  export function electronSessionStore(bridge: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; remove(k: string): Promise<void> }): SessionStore;
  export function pickSessionStore(win?: Window & { dulja?: { auth?: unknown } }): SessionStore;

  // apps/backoffice/src/lib/supabase.ts
  export function createSupabase(env: AppEnvVars, store: SessionStore): SupabaseClient;

  // apps/backoffice/src/lib/session.tsx
  export interface SessionValue { accessToken: string | null; aal: "aal1" | "aal2" | null; email: string | null; signIn(email: string, password: string): Promise<void>; signOut(): Promise<void> }
  export function SessionProvider(props: { client: SupabaseClient; children: ReactNode }): JSX.Element;
  export function useSession(): SessionValue;
  ```

**Why two stores behind one interface.** In the browser (Vite dev, Playwright, staging) the Supabase session lives in `localStorage`. Inside Electron the refresh token must live in `safeStorage` (DoD 0.13), which only the main process can reach. Making the store an injected `SessionStore` means Task 6 is testable today with a fake, and Task 11 supplies the bridge-backed implementation without touching a line of this task's code.

- [ ] **Step 1: Write the failing test**

`apps/backoffice/test/login.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { SessionProvider, useSession } from "../src/lib/session";
import { LoginRoute } from "../src/routes/login";
import { MfaEnrolRoute } from "../src/routes/mfa-enrol";
import { browserSessionStore, electronSessionStore, pickSessionStore } from "../src/lib/session-storage";

const fakeClient = (overrides: Record<string, unknown> = {}) =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(async () => ({
        data: { session: { access_token: "jwt", user: { email: "owner@example.test" } } },
        error: null,
      })),
      signOut: vi.fn(async () => ({ error: null })),
      mfa: {
        enroll: vi.fn(async () => ({ data: { id: "factor-1", totp: { qr_code: "data:image/svg+xml,<svg/>" } }, error: null })),
        challengeAndVerify: vi.fn(async () => ({ data: { access_token: "jwt-aal2" }, error: null })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null })),
      },
      ...overrides,
    },
  }) as never;

describe("session store selection", () => {
  it("uses localStorage in a plain browser", () => {
    expect(pickSessionStore({} as Window)).toBe(browserSessionStore);
  });

  it("uses the Electron bridge when window.dulja.auth exists", () => {
    const bridge = { get: vi.fn(async () => null), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const store = pickSessionStore({ dulja: { auth: bridge } } as never);
    expect(store).not.toBe(browserSessionStore);
    expect(typeof store.getItem).toBe("function");
  });

  it("round-trips a value through the bridge store", async () => {
    const memory = new Map<string, string>();
    const store = electronSessionStore({
      get: async (k) => memory.get(k) ?? null,
      set: async (k, v) => { memory.set(k, v); },
      remove: async (k) => { memory.delete(k); },
    });
    await store.setItem("sb-token", "abc");
    await expect(store.getItem("sb-token")).resolves.toBe("abc");
    await store.removeItem("sb-token");
    await expect(store.getItem("sb-token")).resolves.toBeNull();
  });
});

describe("LoginRoute", () => {
  it("signs in with e-mail and password using only the keyboard", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<AppShell><SessionProvider client={client}><LoginRoute /></SessionProvider></AppShell>);
    // The e-mail field carries `autoFocus` (Step 5), so the operator lands ready to type: no Tab is
    // needed to reach it, and counting shell-chrome tab stops here would couple this test to
    // AppShell's DOM order (skip link → language switcher → nav link → main). The *real* tab order is
    // proved where it is meaningful, in `tests/e2e/rtl-parity.spec.ts` against the running app.
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
    await user.keyboard("owner@example.test");
    await user.tab();                       // → password
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await user.keyboard("correct horse battery staple");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
        email: "owner@example.test",
        password: "correct horse battery staple",
      }),
    );
  });

  it("shows the server's message when the credentials do not match", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: { session: null }, error: { message: "Invalid login credentials" } })),
    });
    render(<AppShell><SessionProvider client={client}><LoginRoute /></SessionProvider></AppShell>);
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toBeInTheDocument());
    await user.type(screen.getByLabelText("E-mail"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid login credentials"));
  });
});

describe("MfaEnrolRoute", () => {
  it("enrols a TOTP factor at aal1 and verifies the six digits (spec:2317)", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<AppShell><SessionProvider client={client}><MfaEnrolRoute /></SessionProvider></AppShell>);
    await waitFor(() => expect(client.auth.mfa.enroll).toHaveBeenCalledWith({ factorType: "totp" }));
    expect(screen.getByAltText("Set up two-factor authentication")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "factor-1", code: "123456" }),
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
bun run --cwd apps/backoffice test -- login
```

Expected: FAIL — `Failed to resolve import "../src/lib/session-storage"`.

- [ ] **Step 3: Write `src/lib/session-storage.ts`**

```ts
export interface SessionStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The browser path: Vite dev, Playwright, and the app served from staging. */
export const browserSessionStore: SessionStore = {
  getItem: async (key) => globalThis.localStorage?.getItem(key) ?? null,
  setItem: async (key, value) => { globalThis.localStorage?.setItem(key, value); },
  removeItem: async (key) => { globalThis.localStorage?.removeItem(key); },
};

export interface AuthBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The Electron path: every byte goes through the contextBridge into `safeStorage` (Task 11). */
export function electronSessionStore(bridge: AuthBridge): SessionStore {
  return {
    getItem: (key) => bridge.get(key),
    setItem: (key, value) => bridge.set(key, value),
    removeItem: (key) => bridge.remove(key),
  };
}

/** One decision point, so nothing else in the app tests for Electron. */
export function pickSessionStore(
  win: (Window & { dulja?: { auth?: AuthBridge } }) | undefined = globalThis.window as never,
): SessionStore {
  const bridge = win?.dulja?.auth;
  return bridge ? electronSessionStore(bridge) : browserSessionStore;
}
```

- [ ] **Step 4: Write `src/lib/supabase.ts` and `src/lib/session.tsx`**

```ts
// apps/backoffice/src/lib/supabase.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppEnvVars } from "./env";
import type { SessionStore } from "./session-storage";

/**
 * Supabase is used as an auth provider only (spec:1112 — "Used as a database and auth provider, **not**
 * as a backend"). No table is ever read through this client; every read goes to `/v1` (spec:1118).
 */
export function createSupabase(env: AppEnvVars, store: SessionStore): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage: {
        getItem: (key) => store.getItem(key),
        setItem: (key, value) => store.setItem(key, value),
        removeItem: (key) => store.removeItem(key),
      },
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
```

```tsx
// apps/backoffice/src/lib/session.tsx
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface SessionValue {
  accessToken: string | null;
  aal: "aal1" | "aal2" | null;
  email: string | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

export function SessionProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [aal, setAal] = useState<"aal1" | "aal2" | null>(null);

  useEffect(() => {
    void client.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
      setEmail(data.session?.user?.email ?? null);
    });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token ?? null);
      setEmail(session?.user?.email ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    if (accessToken === null) { setAal(null); return; }
    void client.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      setAal(data?.currentLevel === "aal2" ? "aal2" : "aal1");
    });
  }, [accessToken, client]);

  const value = useMemo<SessionValue>(
    () => ({
      accessToken,
      aal,
      email,
      async signIn(emailAddress, password) {
        const { error } = await client.auth.signInWithPassword({ email: emailAddress, password });
        if (error) throw new Error(error.message);
      },
      async signOut() {
        await client.auth.signOut();
      },
    }),
    [accessToken, aal, client, email],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
```

- [ ] **Step 5: Write the two routes**

```tsx
// apps/backoffice/src/routes/login.tsx
import { Button, TextField } from "@dulja/ui";
import { useState, type FormEvent } from "react";
import { useShell } from "../components/app-shell";
import { useSession } from "../lib/session";

export function LoginRoute() {
  const { t } = useShell();
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("auth.login.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
      <h1 className="text-start">{t("auth.login.title")}</h1>
      <TextField
        label={t("auth.login.email")}
        type="email"
        autoComplete="username"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
      />
      <TextField
        label={t("auth.login.password")}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />
      {error === null ? null : <p role="alert" className="text-start text-danger">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy}>{t("auth.login.submit")}</Button>
    </form>
  );
}
```

```tsx
// apps/backoffice/src/routes/mfa-enrol.tsx
import { Button, TextField } from "@dulja/ui";
import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useShell } from "../components/app-shell";
import { useSession, useSupabase } from "../lib/session";   // one import statement, not two

/**
 * The one route the API admits at `aal1` (§4.2.3 — "MFA-enrolment routes accept `aal1`, everything else
 * requires `aal2`"). It closes the 0.7b clause "the owner logs in, enrols MFA at `aal1`" (spec:2317).
 */
export function MfaEnrolRoute() {
  const { t } = useShell();
  const { aal } = useSession();
  const client: SupabaseClient = useSupabase();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client.auth.mfa.enroll({ factorType: "totp" }).then(({ data, error: cause }) => {
      if (cause) { setError(cause.message); return; }
      setFactorId(data?.id ?? null);
      setQr(data?.totp?.qr_code ?? null);
    });
  }, [client]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (factorId === null) return;
    const { error: cause } = await client.auth.mfa.challengeAndVerify({ factorId, code });
    if (cause) setError(cause.message);
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
      <h1 className="text-start">{t("auth.mfa.title")}</h1>
      {aal === "aal1" ? <p className="text-start text-text-muted">{t("auth.mfa.required")}</p> : null}
      <p className="text-start">{t("auth.mfa.intro")}</p>
      {qr === null ? null : <img src={qr} alt={t("auth.mfa.title")} width={200} height={200} />}
      <TextField
        label={t("auth.mfa.code")}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.currentTarget.value)}
      />
      {error === null ? null : <p role="alert" className="text-start text-danger">{error}</p>}
      <Button type="submit" variant="primary">{t("auth.mfa.verify")}</Button>
    </form>
  );
}
```

`SessionProvider` must also expose the client, so add to `session.tsx`:

```tsx
const SupabaseContext = createContext<SupabaseClient | null>(null);
export function useSupabase(): SupabaseClient {
  const client = useContext(SupabaseContext);
  if (client === null) throw new Error("useSupabase must be used inside <SessionProvider>");
  return client;
}
```

and wrap the provider's return in `<SupabaseContext.Provider value={client}>…</SupabaseContext.Provider>`.

- [ ] **Step 6: Register the routes**

Replace `apps/backoffice/src/router.tsx`'s children:

```tsx
import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { LoginRoute } from "./routes/login";
import { MfaEnrolRoute } from "./routes/mfa-enrol";
import { UsersRoute } from "./routes/admin/users";

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> });

export const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginRoute });
export const mfaRoute = createRoute({ getParentRoute: () => rootRoute, path: "/mfa", component: MfaEnrolRoute });
export const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin/users", component: UsersRoute });
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => { throw redirect({ to: "/admin/users" }); },
});

export const routeTree = rootRoute.addChildren([indexRoute, loginRoute, mfaRoute, usersRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
```

`UsersRoute` arrives in Task 8; until then create `apps/backoffice/src/routes/admin/users.tsx` with `export function UsersRoute() { return null; }` so the router typechecks, and replace it wholesale in Task 8.

- [ ] **Step 7: Mount the client and the provider at the composition root**

Without this step nothing in the running application ever constructs a Supabase client or renders `SessionProvider`: `LoginRoute`, `MfaEnrolRoute` and Task 8's `UsersScreen` all call `useSession()` / `useSupabase()`, which throw `useSession must be used inside <SessionProvider>` on every route, and the whole of Task 9's acceptance test 23 is unreachable. The `SessionStore` seam Task 11 plugs into is dead code until it is wired here.

**`createSupabase` is called exactly once in the whole application — here, in `main.tsx`, and nowhere else.** `readEnv()` runs at the same point so a missing `VITE_*` fails at boot naming the variable (Task 5 Step 4) instead of at the first fetch with a blank screen. `pickSessionStore()` chooses `localStorage` in a browser and the Electron bridge when `window.dulja.auth` exists (Step 3), so the same file serves both shells with no branch of its own.

Replace `apps/backoffice/src/main.tsx` in full:

```tsx
// apps/backoffice/src/main.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readEnv } from "./lib/env";
import { SessionProvider } from "./lib/session";
import { pickSessionStore } from "./lib/session-storage";
import { createSupabase } from "./lib/supabase";
import { router } from "./router";
import "./app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");

// The composition root: env is read once, the store is chosen once, the client is built once.
const env = readEnv();
const supabase = createSupabase(env, pickSessionStore());
const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    {/* SessionProvider sits inside QueryClientProvider (its consumers use `useQuery`) and outside
        RouterProvider (every route is a consumer). */}
    <QueryClientProvider client={queryClient}>
      <SessionProvider client={supabase}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

`AppShell` stays where it is — inside the root route's component (`router.tsx` above) — so the chrome and the direction switch wrap every route while the client and the session sit above the router.

- [ ] **Step 8: Run the tests to see them pass**

```bash
bun run --cwd apps/backoffice test && bun run --cwd apps/backoffice typecheck
```

Expected: PASS — 8 + 6 tests (`shell.test.tsx`, `login.test.tsx`); `typecheck` clean, which is what proves `main.tsx` composes the four providers with the types they actually declare.

- [ ] **Step 9: Commit**

```bash
git add apps/backoffice
git commit -m "feat(backoffice): Supabase sign-in, aal1 MFA enrolment, swappable session store [0E T6]

The session store is an interface so the Electron safeStorage adapter (T11) drops in
without touching the login flow.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 7: OWNER GATE OD-24 — screenshots and the operator description for the users-and-roles screen

This is the whole of OD-24 for this slice, isolated in one task per contracts §2.0 and hazard 29 ("Every screen task begins with OD-24"). It blocks **Task 8 only**. Nothing else in this plan waits on it, and dropping or deferring it renumbers no interface.

**Files:**
- Create: `docs/ui/od-24-users-and-roles.md` (the received material and the keyboard model derived from it)

**Interfaces:**
- Consumes: nothing. **Produces:** the keyboard model Task 8 implements — a table of key → action, and the field order.

- [ ] **Step 1: Request the material (spec:108, §5.3 "Any UI work")**

Ask the owner, in writing, for exactly two things:

> 1. Screenshots of the equivalent legacy screen for managing users and their permissions — the list view and whatever dialog assigns a role.
> 2. A two-minute description of how a fast operator uses it: which keys they press, in what order, and what they never touch the mouse for.

- [ ] **Step 2: Verify the material arrived**

```bash
ls docs/ui/od-24-users-and-roles.md docs/ui/od-24-*.png
```

Expected: the markdown file and at least one screenshot exist, and the markdown's "Operator description" section is not empty. **This is the verification command; a task that cannot run it is not done.**

- [ ] **Step 3: Until it arrives — the stated default, written down**

Create `docs/ui/od-24-users-and-roles.md` with this content, marked pending, so Task 8 has a model to build against and the diff when the owner answers is one file:

```markdown
# OD-24 — Users and roles screen

**Status:** ⚠️ PENDING owner material (contracts §2.12 OD-24; spec:79, 108, 2408).
**Default in force:** the generic keyboard model below, derived from spec:2254 ("tab order, type-ahead
pickers, keyboard shortcuts, no mouse required") and 0B's OpenAPI document. **No workflow is invented
beyond it** — where the old screen's behaviour is unknown, the new screen does the obvious thing and
says so here.

## Operator description
_(pending — paste the owner's two-minute description here verbatim)_

## Screenshots
_(pending — `docs/ui/od-24-*.png`)_

## Keyboard model the default implements

| Key | Action |
|---|---|
| `Tab` | skip link → language switcher → search box → grid → "Invite user" |
| `/` | focus the search box from anywhere on the screen |
| `↑ ↓` | move a row inside the grid |
| `→ ←` | move a column, mapped through `dir` (Arabic reverses them) |
| `Home` / `End` | first / last column |
| `Enter` on a row | open the role-assignment panel for that user |
| `Esc` | close the panel, returning focus to the row it opened from |

## What changes when the owner's material arrives
Only `apps/backoffice/src/routes/admin/users.tsx` and `apps/backoffice/test/users.test.tsx`. No API
call, no contract, no other task.
```

- [ ] **Step 4: Commit**

```bash
git add docs/ui
git commit -m "docs(ui): OD-24 gate — users-and-roles screen material and the default keyboard model [0E T7]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The one real screen — users and roles against 0B's admin endpoints

**Files:**
- Create: `apps/backoffice/src/routes/admin/users.tsx` (replacing the Task 6 stub), `apps/backoffice/src/lib/admin-schemas.ts`
- Modify: `packages/ui/src/text-field.tsx` (Step 4 — `forwardRef`, for the `/` shortcut), `apps/backoffice/src/router.tsx` and `apps/backoffice/src/lib/session.tsx` (Step 5 — `UsersScreen` and `useCompanyId`)
- Test: `apps/backoffice/test/users.test.tsx`

**Interfaces:**
- Consumes: `createAdminApi` (Task 5), `useShell` (Task 5), `useSession` (Task 6), `DataGrid` / `Button` / `TextField` / `Select` (Task 4), `formatTimestamp` (Task 2); 0B's endpoints, exactly as 0B mounts them — `GET|POST /v1/admin/users`, `GET /v1/admin/roles`, `GET /v1/companies`, `POST /v1/companies/{companyId}/role-assignments`; and 0B's `UserSchema` (`id`, `displayName`, `email` nullable, `kind`, `createdAt`, `activeAssignments`), `UserList`, `RoleSchema`, `RoleAssignmentSchema`, `CompanySchema`, `ListEnvelope` (assumption 2).
- Produces, copied verbatim from Step 4 — the injected-props shape every test in this task depends on:
  ```ts
  // apps/backoffice/src/routes/admin/users.tsx
  export interface UsersRouteProps { api: AdminApiOptions; companyId: string }
  export function UsersRoute({ api, companyId }: UsersRouteProps): JSX.Element;
  ```
  and `apps/backoffice/src/lib/admin-schemas.ts` — the one file that names 0B's resource schemas, so a spelling change in 0B is a one-file edit.

- [ ] **Step 1: Write `src/lib/admin-schemas.ts` — the single import surface for 0B's shapes**

```ts
/**
 * The only file that names 0B's resource schemas, so a rename there is a one-file edit here.
 * **Every one of these names is 0B's**, registered in contracts §4.2.8's module table:
 * `admin/user.ts` → UserSchema/InviteUserBody/UserQuery/UserList; `admin/role.ts` →
 * RoleSchema/…/RoleList; `admin/role-assignment.ts` → RoleAssignmentSchema/…/RoleAssignmentList;
 * `admin/company.ts` → CompanySchema/…/CompanyList. Nothing here is re-derived from `ListEnvelope`:
 * a second spelling of a registered name is contracts hazard 9, and 0E imports rather than invents.
 */
import {
  CompanyList,
  CompanySchema,
  RoleAssignmentList,
  RoleAssignmentSchema,
  RoleList,
  RoleSchema,
  UserList,
  UserSchema,
} from "@dulja/contracts";
import { z } from "zod";

export type User = z.infer<typeof UserSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Company = z.infer<typeof CompanySchema>;
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export {
  CompanyList,
  CompanySchema,
  RoleAssignmentList,
  RoleAssignmentSchema,
  RoleList,
  RoleSchema,
  UserList,
  UserSchema,
};
```

If any of the four list wrappers is missing when 0B's `packages/contracts` is on disk, that is a **0B defect against §4.2.8**, not a licence to re-derive it here: raise it against 0B rather than writing `ListEnvelope(...)` in this file.

- [ ] **Step 2: Write the failing test**

`apps/backoffice/test/users.test.tsx` — the API is injected through `fetchImpl`, so no network and no MSW:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { UsersRoute } from "../src/routes/admin/users";

// Exactly 0B's UserSchema: id, displayName, email (nullable), kind, createdAt, activeAssignments.
const USERS = {
  items: [
    { id: "u1", displayName: "Aisha", email: "aisha@example.test", kind: "human", createdAt: "2026-01-15T02:00:00Z", activeAssignments: 2 },
    { id: "u2", displayName: "Bilal", email: "bilal@example.test", kind: "human", createdAt: "2026-02-03T02:00:00Z", activeAssignments: 0 },
  ],
  next_cursor: null,
};
const ROLES = {
  items: [
    { id: "r1", code: "admin", nameEn: "Administrator", nameAr: "مدير", isSystem: true },
    { id: "r2", code: "accountant", nameEn: "Accountant", nameAr: "محاسب", isSystem: true },
  ],
  next_cursor: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchImpl = (overrides: Record<string, Response> = {}) =>
  vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    for (const [fragment, response] of Object.entries(overrides)) {
      if (path.includes(fragment)) return response.clone();
    }
    if (path.includes("/v1/admin/users")) return json(USERS);
    if (path.includes("/v1/admin/roles")) return json(ROLES);
    if (path.includes("/role-assignments")) return json({ id: "ra1" });
    throw new Error(`unexpected fetch: ${path}`);
  });

/** The OD-24 model: the operator lands on a row and presses Enter to select it. */
const activateRow = async (user: ReturnType<typeof userEvent.setup>, email: string) => {
  await user.click(screen.getByText(email));
  await user.keyboard("{Enter}");
};

/**
 * `UsersRoute` calls `useQuery` twice and `useQueryClient` once (Step 4), so it must be rendered under
 * a `QueryClientProvider` or TanStack Query throws `No QueryClient set, use QueryClientProvider to set
 * one` on first render. A **fresh** client per test, with retries off, keeps one test's cache and one
 * test's failed request out of the next.
 */
const renderScreen = (impl = fetchImpl()) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <UsersRoute
          api={{ baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl: impl }}
          companyId="c1"
        />
      </AppShell>
    </QueryClientProvider>,
  );
};

describe("UsersRoute", () => {
  it("lists users with their roles and a translated count", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    expect(screen.getByText("2 users")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["E-mail", "Name", "Roles", "Status", "Invited on"]);
  });

  it("formats createdAt through the i18n formatter, not toLocaleDateString", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    const row = screen.getByText("aisha@example.test").closest("tr")!;
    expect(within(row).getByText(/2026/)).toBeInTheDocument();
  });

  it("derives Status from activeAssignments — 0 is 0B's \"expired out of the tenant\"", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText("bilal@example.test")).toBeInTheDocument());
    expect(within(screen.getByText("aisha@example.test").closest("tr")!).getByText("Active")).toBeInTheDocument();
    expect(within(screen.getByText("bilal@example.test").closest("tr")!).getByText("Expired")).toBeInTheDocument();
  });

  it("focuses the search box on `/` from anywhere on the screen (OD-24 default model)", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Search users")).toBeInTheDocument());
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));
  });

  it("filters the grid as the operator types", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("bilal@example.test")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Search users"), "aisha");
    expect(screen.queryByText("bilal@example.test")).not.toBeInTheDocument();
    expect(screen.getByText("aisha@example.test")).toBeInTheDocument();
  });

  it("cannot assign until a row is selected — the button is disabled", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Assign role"), "r2");
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    await activateRow(user, "aisha@example.test");
    expect(screen.getByRole("button", { name: "Assign role" })).toBeEnabled();
  });

  it("assigns to the row the operator activated, not the first row", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    await waitFor(() => expect(screen.getByText("bilal@example.test")).toBeInTheDocument());
    await activateRow(user, "bilal@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), "r2");
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => {
      const call = impl.mock.calls.find(([u]) => String(u).includes("/role-assignments"));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ principalId: "u2", roleId: "r2" });
    });
  });

  it("assigns a role through the company-scoped endpoint with an Idempotency-Key", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), "r2");
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => {
      const call = impl.mock.calls.find(([u]) => String(u).includes("/role-assignments"));
      expect(call).toBeDefined();
      expect(String(call![0])).toBe("https://api.example.test/v1/companies/c1/role-assignments");
      const headers = (call![1] as RequestInit).headers as Record<string, string>;
      expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  it("shows the server's problem detail and remedy when the API refuses", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl({
      "/role-assignments": new Response(
        JSON.stringify({
          type: "urn:dulja:error:ERR_RBAC_SELF_GRANT",
          title: "Self grant",
          status: 409,
          detail: "principal 0192… may not grant a role to itself",
          instance: "/v1/companies/c1/role-assignments",
          code: "ERR_RBAC_SELF_GRANT",
          remedy: "Ask another administrator to make this assignment.",
          requestId: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
        }),
        { status: 409, headers: { "content-type": "application/problem+json" } },
      ),
    });
    renderScreen(impl);
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    // A row must be activated first: the test above proves the Assign button is `disabled` while
    // `selected === null`, so without this line no request is ever sent and no alert is ever rendered.
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), "r2");
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("may not grant a role to itself"));
    expect(screen.getByRole("alert")).toHaveTextContent("Ask another administrator");
  });

  it("shows the empty state rather than a blank grid", async () => {
    renderScreen(fetchImpl({ "/v1/admin/users": json({ items: [], next_cursor: null }) }));
    await waitFor(() => expect(screen.getByText("Nothing to show yet.")).toBeInTheDocument());
    expect(screen.getByText("No users")).toBeInTheDocument();
  });

  it("renders every column header in Arabic when the shell switches", async () => {
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() => expect(screen.getByText("البريد الإلكتروني")).toBeInTheDocument());
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
bun run --cwd apps/backoffice test -- users
```

Expected: FAIL — `UsersRoute` renders `null` (the Task 6 stub), so `screen.getByText("aisha@example.test")` times out.

- [ ] **Step 4: Write `src/routes/admin/users.tsx`**

```tsx
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { formatTimestamp } from "@dulja/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import { createAdminApi, type AdminApiOptions } from "../../lib/admin-api";
import { ApiError, problemMessage } from "../../lib/problem";
import { RoleAssignmentSchema, RoleList, UserList, type Role, type User } from "../../lib/admin-schemas";

export interface UsersRouteProps {
  /** Injected so the screen is testable without a network; the route supplies the real one. */
  api: AdminApiOptions;
  companyId: string;
}

export function UsersRoute({ api, companyId }: UsersRouteProps) {
  const { t, locale } = useShell();
  const client = useMemo(() => createAdminApi(api), [api]);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [roleId, setRoleId] = useState("");
  const [selected, setSelected] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const users = useQuery({ queryKey: ["users"], queryFn: () => client.get("/v1/admin/users", UserList) });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => client.get("/v1/admin/roles", RoleList) });

  // OD-24 default keyboard model: "/" focuses search from anywhere on the screen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, []);

  const rows = (users.data?.items ?? []).filter((user: User) =>
    search === "" || `${user.email ?? ""} ${user.displayName}`.toLowerCase().includes(search.toLowerCase()),
  );

  // Every cell reads a field 0B's UserSchema actually carries: id, displayName, email (nullable),
  // kind, createdAt, activeAssignments. `activeAssignments === 0` is 0B's "expired out of the tenant".
  const columns: Column<User>[] = [
    { key: "email", header: t("admin.users.column.email"), cell: (u) => u.email ?? "" },
    { key: "name", header: t("admin.users.column.name"), cell: (u) => u.displayName },
    { key: "roles", header: t("admin.users.column.roles"), cell: (u) => String(u.activeAssignments), align: "end" },
    {
      key: "status",
      header: t("admin.users.column.status"),
      cell: (u) => t(u.activeAssignments === 0 ? "admin.users.status.expired" : "admin.users.status.active"),
    },
    {
      key: "invitedOn",
      header: t("admin.users.column.invitedOn"),
      cell: (u) => formatTimestamp(u.createdAt, { locale }),
      align: "end",
    },
  ];

  // The row the operator activated with Enter (docs/ui/od-24-users-and-roles.md). Never "the first row".
  const assign = async () => {
    setError(null);
    if (selected === null || roleId === "") return;
    try {
      await client.send(
        "POST",
        `/v1/companies/${companyId}/role-assignments`,
        { principalId: selected.id, roleId },
        RoleAssignmentSchema.partial(),
      );
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (cause) {
      setError(cause instanceof ApiError ? problemMessage(cause.problem, t) : String(cause));
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-start">{t("admin.users.title")}</h1>
      <p className="text-start text-text-muted">{t("admin.users.count", { count: rows.length })}</p>

      <div className="flex flex-wrap items-end gap-4">
        <TextField
          label={t("admin.users.search")}
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          label={t("admin.users.assignRole")}
          value={roleId}
          options={(roles.data?.items ?? []).map((role: Role) => ({ value: role.id, label: role.code }))}
          onChange={(e) => setRoleId(e.currentTarget.value)}
        />
        <Button
          variant="primary"
          disabled={selected === null || roleId === ""}
          onClick={() => void assign()}
        >
          {t("admin.users.assignRole")}
        </Button>
      </div>

      {error === null ? null : <p role="alert" className="text-start text-danger">{error}</p>}

      <DataGrid
        caption={t("admin.users.title")}
        columns={columns}
        rows={rows}
        rowKey={(u: User) => u.id}
        emptyLabel={t("app.empty")}
        onActivate={setSelected}
      />
    </section>
  );
}
```

`TextField` must forward its ref for the `/` shortcut; wrap it in `forwardRef` in `packages/ui/src/text-field.tsx`:

```tsx
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, ...rest }, ref,
) {
  /* body unchanged; add ref={ref} to the <input> */
});
```

- [ ] **Step 5: Wire the route to the real API**

In `apps/backoffice/src/router.tsx`, replace the `usersRoute` component with a wrapper that supplies the injected options from the live session:

```tsx
function UsersScreen() {
  const { accessToken } = useSession();
  const env = readEnv();
  const companyId = useCompanyId();      // from the session's memberships; see below
  return <UsersRoute api={{ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }} companyId={companyId} />;
}
```

`useCompanyId` reads the first company from `GET /v1/companies` (0B's companies endpoint) and is three lines in `apps/backoffice/src/lib/session.tsx`:

```tsx
export function useCompanyId(): string {
  const { accessToken } = useSession();
  const env = readEnv();
  const api = useMemo(() => createAdminApi({ baseUrl: env.apiBaseUrl, accessToken: () => accessToken }), [accessToken, env.apiBaseUrl]);
  const { data } = useQuery({ queryKey: ["companies"], queryFn: () => api.get("/v1/companies", CompanyList) });
  return data?.items[0]?.id ?? "";
}
```

`CompanyList` is already exported by `admin-schemas.ts` (Step 1); `readEnv`, `useMemo`, `useQuery` and `createAdminApi` are the imports it adds to `session.tsx`.

- [ ] **Step 6: Run the tests to see them pass**

```bash
bun run --cwd apps/backoffice test && bun run --cwd apps/backoffice typecheck
```

Expected: PASS — 8 + 6 + 11 tests (`shell.test.tsx`, `login.test.tsx`, `users.test.tsx`).

- [ ] **Step 7: Verify no hard-coded string slipped in**

```bash
bun run lint:rules && bun run --cwd tests test -- lint-rules
```

Expected: both green — every visible string on the screen came from `t(...)`.

- [ ] **Step 8: Commit**

```bash
git add apps/backoffice packages/ui
git commit -m "feat(backoffice): users-and-roles screen against 0B admin endpoints [0E T8]

Keyboard model per docs/ui/od-24-users-and-roles.md (OD-24 default in force).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `tests/e2e` Playwright project — **acceptance test 23, RTL/LTR parity**

The slice's owned Part VI test (spec:2441): "Every screen and generated PDF renders correctly in Arabic and English, including numerals, Hijri/Gregorian dates and column order." The PDF half is 2C/7A/8D's re-run; this task owns the screen half and the harness both halves re-use.

**Files:**
- Create: `tests/playwright.config.ts`, `tests/e2e/support/auth-stub.ts`, `tests/e2e/support/boot.ts`, `tests/e2e/support/global-setup.ts`, `tests/e2e/support/global-teardown.ts`, `tests/e2e/rtl-parity.spec.ts`
- Modify: `tests/package.json`, root `package.json` (`e2e` script), `.github/workflows/ci.yml` (an `e2e` step in the existing `checks` job)

**Interfaces:**
- Consumes: 0B's `startApi()` (§4.2.12) — the Testcontainers database **and** the test JWKS issuer in one call, so the API accepts tokens this harness mints; `seedTenant`, `Seed`, `uuidv7` and the 4-argument test `withTenant` (§4.1); the five Phase 0 `admin.*` codes 0B's migration `0002_seed_permission_phase0.sql` puts in the global `app.permission` (§3.6.2); `createApp`'s `JobClient` dependency (§4.2.6) is already satisfied inside `startApi()`.
- Produces: `bun run e2e`; `tests/e2e/support/boot.ts` `bootLocalStack(): Promise<LocalStack>` and `grantAdminRole(api, seed)` — the fixture every later UI slice re-uses when it re-runs test 23.

**Owner gate note (hazard 5).** *Owner provides: the staging base URL and a real Supabase session (OD-20, OD-21). Verify with `PLAYWRIGHT_BASE_URL=https://<staging-domain> bun run e2e` — the same spec file passes unchanged.* **Until provided:** the local stack below runs in CI on every PR and must pass; spec:2377 ("Playwright, both text directions, against staging") is satisfied by the same file pointed at a different base URL.

- [ ] **Step 1: Install and configure**

```bash
bun add --cwd tests -d @playwright/test hono @hono/node-server jose
bun add --cwd tests @dulja/db@workspace:*
bunx playwright install --with-deps chromium
```

`hono` is a direct dependency of this workspace, not merely a transitive one of `apps/api`: Step 2's auth stub and Step 3's CORS front both `import { Hono } from "hono"` and `import { cors } from "hono/cors"`.

`tests/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Skipped when PLAYWRIGHT_BASE_URL points at staging — nothing local is started then.
  globalSetup: "./e2e/support/global-setup.ts",
  globalTeardown: "./e2e/support/global-teardown.ts",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

Root `package.json` gains:

```json
"e2e": "bun run --cwd tests test:e2e"
```

- [ ] **Step 2: Write the auth stub**

`tests/e2e/support/auth-stub.ts` — the four Supabase auth endpoints `supabase-js` touches, answering with a token minted by 0B's test issuer so the **real API accepts it**:

```ts
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

/** The origin `vite preview` serves the built back office from (Step 3's `WEB_PORT`). */
export const WEB_ORIGIN = "http://127.0.0.1:4173";

export interface AuthStub {
  url: string;
  stop(): Promise<void>;
}

/**
 * Supabase Auth, reduced to what the login form calls. `mintToken` is `StartedApi.tokenFor` — one
 * issuer and one key pair for the stub and the API, so a session obtained here is a session the API
 * honours. Nothing here mimics Supabase beyond these four responses.
 */
export function startAuthStub(
  principalId: string,
  email: string,
  mintToken: (principalId: string, aal?: "aal1" | "aal2") => string,
  port = 8788,
): Promise<AuthStub> {
  const app = new Hono();
  const session = (aal: "aal1" | "aal2") => ({
    access_token: mintToken(principalId, aal),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "stub-refresh-token",
    user: { id: principalId, email, aud: "authenticated", app_metadata: {}, user_metadata: {} },
  });

  /**
   * The browser reaches this stub cross-origin — the page is on `:4173`, the stub on `:8788` — and
   * `supabase-js` sends `apikey`, `authorization`, `x-client-info` and `content-type`, every one of
   * which makes the request non-simple and triggers a preflight. Without this middleware the
   * `OPTIONS` gets no handler, no `Access-Control-Allow-*` comes back, and sign-in fails in the
   * browser with a CORS error rather than an HTTP one. `allowHeaders` is deliberately **omitted**:
   * Hono's `cors()` then echoes `Access-Control-Request-Headers` back verbatim, so a header
   * `supabase-js` adds in a future version cannot silently break this harness.
   */
  app.use("*", cors({ origin: WEB_ORIGIN, allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 }));

  app.post("/auth/v1/token", (c) =>
    c.json(session(c.req.query("grant_type") === "refresh_token" ? "aal2" : "aal2")));
  app.get("/auth/v1/user", (c) => c.json(session("aal2").user));
  app.get("/auth/v1/factors", (c) => c.json([]));
  app.post("/auth/v1/logout", (c) => c.body(null, 204));

  return new Promise((resolve) => {
    const server: ServerType = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      }),
    );
  });
}
```

- [ ] **Step 3: Write the boot fixture**

`tests/e2e/support/boot.ts`:

```ts
import { serve, type ServerType } from "@hono/node-server";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../../apps/api/test/support/app";
import { startAuthStub, WEB_ORIGIN, type AuthStub } from "./auth-stub";

const ROOT = resolve(__dirname, "../../..");
const API_PORT = 8787;
const AUTH_PORT = 8788;
const WEB_PORT = 4173;

export interface LocalStack {
  api: StartedApi;
  seed: Seed;
  baseURL: string;
  stop(): Promise<void>;
}

const waitFor = async (url: string, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

const run = (command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess =>
  spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit", shell: process.platform === "win32" });

/** The five Phase 0 admin codes 0B's migration 0002 seeds into the global `app.permission` (§3.6.2). */
const ADMIN_CODES = [
  "admin.user.manage",
  "admin.role.manage",
  "admin.role.assign",
  "admin.company.manage",
  "admin.audit_log.read",
];

/**
 * `seedTenant` (Plan 0A, §4.1) creates identity, a company, periods and accounts — and **no role and no
 * role_assignment**, so its human principal holds nothing and every `requirePermission` route would
 * answer 403. The grant is made as the **system** principal, because `app.forbid_self_grant`
 * (plan0A:1404) refuses a principal granting a role to itself, and it uses a non-`pos_terminal` role
 * code, because `app.assert_assignment_kind` (plan0A:1421) ties that one code to terminal principals.
 *
 * `role` carries `id uuid primary key default uuidv7()`, so its id is pre-generated here per §4.1's
 * "ids are pre-generated with `uuidv7(db.admin)` in tests". `role_permission` (plan0A:1322) and
 * `role_assignment` (plan0A:1331 — "a join table (no id/created_at — linter rule)") have **no `id`
 * column at all**; naming one in those two inserts is an error, not an omission.
 *
 * Exported because contracts §4.17.1 registers it: `bootLocalStack()` and `grantAdminRole(api, seed)`
 * in `tests/e2e/support/boot.ts` are 0E's row, and 1B, 2C, 7A, 8D and every later UI slice re-use them
 * when they re-run test 23 rather than hand-rolling these three inserts.
 */
export async function grantAdminRole(api: StartedApi, seed: Seed): Promise<void> {
  const roleId = await uuidv7(api.db.admin);
  await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
    await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
             values (${roleId}, ${seed.tenant}, 'e2e_admin', 'E2E administrator', false)`;
    await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
             select ${seed.tenant}, ${roleId}, code from app.permission where code = any(${ADMIN_CODES})`;
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
             values (${seed.tenant}, ${seed.human}, ${roleId}, ${seed.company})`;
  });
}

/**
 * The whole stack, locally: Testcontainers Postgres + 0B's API on its test JWKS issuer + the auth stub
 * + the built back office served by `vite preview`. Everything a browser needs, and no owner account.
 */
export async function bootLocalStack(): Promise<LocalStack> {
  const api = await startApi();
  const seed = await seedTenant(api.db, "e2e");
  await grantAdminRole(api, seed);

  /**
   * The API is reached cross-origin here — the page is on `:4173`, the API on `:8787` — and every
   * `/v1` call carries `authorization`, plus `idempotency-key` on unsafe methods, so every one of them
   * is preflighted. §4.2.3's middleware chain is fixed at `otel → requestId → logger → auth →
   * idempotency → requirePermission → handler` and contains **no CORS**, by design: in production the
   * back office is served from the same origin as the API. So the harness — not the API — supplies it,
   * as a thin front that answers the preflight and then delegates every request to `createApp`'s own
   * `fetch` untouched. `x-request-id` is exposed because `toApiError` (Task 5) reads it off the
   * response when a body is not a problem envelope; cross-origin it reads `null` without this line.
   * `allowHeaders` is omitted so Hono echoes `Access-Control-Request-Headers` verbatim.
   */
  const front = new Hono();
  front.use(
    "*",
    cors({
      origin: WEB_ORIGIN,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["x-request-id"],
      maxAge: 600,
    }),
  );
  front.all("*", (c) => api.app.fetch(c.req.raw));

  const httpApi: ServerType = serve({ fetch: front.fetch, port: API_PORT, hostname: "127.0.0.1" });
  await waitFor(`http://127.0.0.1:${API_PORT}/healthz`);

  const auth: AuthStub = await startAuthStub(seed.human, "owner@example.test", api.tokenFor, AUTH_PORT);

  const buildEnv = {
    VITE_API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    VITE_SUPABASE_URL: auth.url,
    VITE_SUPABASE_ANON_KEY: "stub-anon-key",
    VITE_APP_ENV: "dev",
  };

  await new Promise<void>((done, fail) => {
    const build = run("bun", ["run", "--cwd", "apps/backoffice", "build"], buildEnv);
    build.on("exit", (code) => (code === 0 ? done() : fail(new Error(`backoffice build exited ${code}`))));
  });

  const preview = run("bun", ["run", "--cwd", "apps/backoffice", "preview"], buildEnv);
  await waitFor(`http://127.0.0.1:${WEB_PORT}/`);

  return {
    api,
    seed,
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    async stop() {
      preview.kill();
      await auth.stop();
      await new Promise<void>((done) => httpApi.close(() => done()));
      await api.stop();
    },
  };
}
```

`tests/e2e/support/global-setup.ts`:

```ts
import type { FullConfig } from "@playwright/test";
import { bootLocalStack, type LocalStack } from "./boot";

declare global { var __duljaStack: LocalStack | undefined }

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Pointed at staging (OD-20/OD-21), nothing local is started — the same specs run against the real thing.
  if (process.env["PLAYWRIGHT_BASE_URL"]) return;
  globalThis.__duljaStack = await bootLocalStack();
}
```

`tests/e2e/support/global-teardown.ts`:

```ts
export default async function globalTeardown(): Promise<void> {
  await globalThis.__duljaStack?.stop();
  globalThis.__duljaStack = undefined;
}
```

- [ ] **Step 4: Write the failing acceptance test**

`tests/e2e/rtl-parity.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

const signIn = async (page: Page) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("owner@example.test");
  await page.getByLabel("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users and roles" })).toBeVisible();
};

const switchToArabic = async (page: Page) => {
  await page.getByLabel("Language").selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
};

test.describe("acceptance test 23 — RTL/LTR parity", () => {
  test("the shell screen renders left-to-right in English", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const headers = await page.getByRole("columnheader").allInnerTexts();
    expect(headers).toEqual(["E-mail", "Name", "Roles", "Status", "Invited on"]);
  });

  test("the same screen renders right-to-left in Arabic, with the column order reversed visually", async ({ page }) => {
    await signIn(page);
    const firstLtr = await page.getByRole("columnheader").first().boundingBox();
    await switchToArabic(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    const headersAr = await page.getByRole("columnheader").allInnerTexts();
    expect(headersAr[0]).toBe("البريد الإلكتروني");
    const firstRtl = await page.getByRole("columnheader").first().boundingBox();
    // Same first column, opposite side of the viewport — that is what "column order" means (spec:2441).
    expect(firstRtl!.x).toBeGreaterThan(firstLtr!.x);
  });

  test("text alignment follows the direction, with no physical overrides", async ({ page }) => {
    await signIn(page);
    const heading = page.getByRole("heading", { name: "Users and roles" });
    expect(await heading.evaluate((el) => getComputedStyle(el).textAlign)).toBe("start");
    await switchToArabic(page);
    expect(await page.getByRole("heading").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("start");
  });

  test("the keyboard reaches and drives the grid in both directions, with no mouse", async ({ page }) => {
    await signIn(page);
    await page.keyboard.press("/");
    await expect(page.getByLabel("Search users")).toBeFocused();
    // Two tabs, not three: at this point no row is activated and no role is chosen, so the Assign
    // button is `disabled` (Task 8 Step 4) and a disabled button is not in the tab order. The only
    // other element between them, the `role="alert"` paragraph, renders only when `error !== null`.
    await page.getByLabel("Search users").press("Tab");   // → role select
    await page.keyboard.press("Tab");                     // → grid, first cell (Assign is disabled)
    await expect(page.locator('[data-cell="0:0"]')).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();

    await switchToArabic(page);
    await page.locator('[data-cell="0:0"]').focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
  });

  test("dates and numerals render in the locale's own systems", async ({ page }) => {
    await signIn(page);
    // `createdAt` is `now()` at seed time, so assert the shape of a four-digit year, not a literal one.
    await expect(page.getByRole("cell", { name: /20\d\d/ }).first()).toBeVisible();
    await switchToArabic(page);
    await expect(page.getByText(/مستخدم/)).toBeVisible();   // the ICU plural resolved in Arabic
  });

  test("no English string leaks into the Arabic screen", async ({ page }) => {
    await signIn(page);
    await switchToArabic(page);
    const main = await page.locator("main").innerText();
    // Latin letters may appear only inside seeded data (e-mail addresses, role codes), never in chrome.
    const chrome = await page.locator("h1, th, label, button").allInnerTexts();
    for (const text of chrome) {
      expect(text, `"${text}" is untranslated on the Arabic screen`).not.toMatch(/^[A-Za-z][A-Za-z ]{3,}$/);
    }
    expect(main.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Run it to see it fail**

```bash
bun run e2e
```

Expected: FAIL on the first run before the harness exists — `Cannot find module './e2e/support/global-setup'`. After Step 3 the boot succeeds and the six specs report the real state of the screen.

- [ ] **Step 6: Make it pass**

Any failure here is a defect in Tasks 4–8, not in this spec file. The three that actually occur, and their fixes:

| Symptom | Cause | Fix |
|---|---|---|
| `textAlign` is `left`, not `start` | a physical Tailwind class reached a component | add the pattern to `PHYSICAL_PROPERTY_PATTERNS` and fix the component; `packages/ui/test/logical-properties.test.ts` then guards it |
| `firstRtl.x` is not greater than `firstLtr.x` | `dir` is on a wrapper `div` rather than `documentElement` | `DirectionProvider` must set it on the root (Task 4) |
| the Arabic ICU plural renders as the key | `admin.users.count` lacks a plural category the count needs | add it to `ar.json`; `legacy-085` and `catalogue.test.ts` cover it thereafter |

```bash
bun run e2e
```

Expected: PASS — 6 specs, one worker.

- [ ] **Step 7: Add e2e to CI**

In `.github/workflows/ci.yml`, inside the existing `checks` job, after `bun run test`:

```yaml
      - run: bunx playwright install --with-deps chromium
      - run: bun run e2e
        env:
          TESTCONTAINERS_RYUK_DISABLED: "true"
```

- [ ] **Step 8: Commit**

```bash
git add tests package.json .github/workflows/ci.yml bun.lock
git commit -m "test(e2e): Playwright RTL/LTR parity on the shell screen — acceptance test 23 [0E T9]

Boots the whole stack locally on 0B's test JWKS issuer, so the test runs in CI with no
Supabase, no Cloudflare and no certificate. PLAYWRIGHT_BASE_URL points it at staging.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 10: `apps/desktop` — the Electron main process with the §3.7.2 security posture verbatim

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.build.json`, `apps/desktop/playwright.config.ts`, `apps/desktop/src/window-options.ts`, `apps/desktop/src/main.ts`
- Modify: root `turbo.json`
- Test: `apps/desktop/test/window-options.test.ts`, `apps/desktop/test/posture.spec.ts`

**Interfaces:**
- Consumes: `apps/backoffice/dist` — a **build output**, never an import (spec:2389; assumption 7).
- Produces:
  ```ts
  // apps/desktop/src/window-options.ts
  export const APP_SCHEME: "dulja";
  export const APP_ORIGIN: "dulja://app";
  export const CONTENT_SECURITY_POLICY: string;
  export function browserWindowOptions(preloadPath: string): Electron.BrowserWindowConstructorOptions;
  export function isAppUrl(url: string): boolean;
  ```

**Why a custom `dulja://` scheme and not `file://`.** spec:1284 requires "renderer navigation locked to the app's own origin". `file://` has an opaque origin: `localStorage` is unavailable, CSP behaves differently, and "the app's own origin" is not expressible. A privileged, standard, secure custom scheme gives the renderer a real origin, so the navigation lock, the CSP and the session store all mean what they say.

- [ ] **Step 1: Create the workspace**

`apps/desktop/package.json` — CommonJS, deliberately: electron-builder's dependency resolution and `@electron/rebuild` are best-trodden on CJS main processes, and this app has no reason to be the place that proves ESM-in-main:

```json
{
  "name": "@dulja/desktop",
  "private": true,
  "type": "commonjs",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.build.json && bun build src/preload.ts --outfile dist/preload.js --target node --format cjs --external electron",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "test:electron": "playwright test",
    "start": "electron .",
    "dist": "electron-builder --win --publish never"
  }
}
```

**The preload is bundled; the main process is not.** With `sandbox: true` (Task 10 Step 4) Electron replaces the preload's `require` with a polyfill that resolves only `electron`, `events`, `timers` and `url` — a relative `require("./bridge-types")` throws, the preload never runs, and `window.dulja` is `undefined`. So `tsc` emits the main process and `bun build` emits **one self-contained `dist/preload.js`** with `CHANNELS` inlined and only `electron` left external. If `--format cjs` misbehaves on the installed Bun, `bunx esbuild src/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/preload.js` is the drop-in replacement.

**No `@dulja/backoffice` dependency appears here, ever** — that is the build-outputs-only rule (assumption 7).

```bash
bun add --cwd apps/desktop -d electron electron-builder @electron/rebuild @playwright/test
bun add --cwd apps/desktop electron-updater @sentry/electron better-sqlite3
```

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node10",
    "verbatimModuleSyntax": false,
    "lib": ["ES2023", "DOM"],
    "types": ["node"]
  },
  "include": ["src", "test", "types", "playwright.config.ts", "vitest.config.ts"]
}
```

`apps/desktop/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
```

`apps/desktop/playwright.config.ts` — the Electron specs, separate from `tests/e2e` (which §3.7.1 scopes to the web app against staging):

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
});
```

Root `turbo.json` gains the ordering edge — this is the *only* place the two apps are related. **This is an additive edit: add exactly the one `@dulja/desktop#build` key to the existing `tasks` object and change no other key.** Plan 0A's `turbo.json` (plan0A:259–266) is the source of the workspace-scripts contract and may carry pipeline entries this plan does not reproduce; pasting a whole document over it would delete them silently. The fragment to add:

```json
    "@dulja/desktop#build": { "dependsOn": ["@dulja/backoffice#build"], "outputs": ["dist/**"] }
```

Verify afterwards that the file still contains every key it had before:

```bash
git diff --unified=0 turbo.json
```

Expected: one added line (plus a comma on the previous one), nothing removed.

- [ ] **Step 2: Write the failing tests**

`apps/desktop/test/window-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, browserWindowOptions, CONTENT_SECURITY_POLICY, isAppUrl } from "../src/window-options";

describe("browserWindowOptions — spec:1284, verbatim and not optional", () => {
  const options = browserWindowOptions("/app/preload.js");

  it("isolates the context", () => expect(options.webPreferences?.contextIsolation).toBe(true));
  it("disables node integration", () => expect(options.webPreferences?.nodeIntegration).toBe(false));
  it("sandboxes the renderer", () => expect(options.webPreferences?.sandbox).toBe(true));
  it("keeps web security on", () => expect(options.webPreferences?.webSecurity).not.toBe(false));
  it("disables remote content bridges", () => {
    expect(options.webPreferences?.webviewTag).toBe(false);
    expect(options.webPreferences?.nodeIntegrationInSubFrames).toBe(false);
  });
  it("points at exactly one preload script", () => expect(options.webPreferences?.preload).toBe("/app/preload.js"));
  it("does not show the window before it has painted", () => expect(options.show).toBe(false));
});

describe("CONTENT_SECURITY_POLICY", () => {
  /**
   * Directive-wise, never against the whole string. The policy is one line and `style-src 'self'
   * 'unsafe-inline'` follows `script-src 'self'`, so a negative lookahead like
   * `/script-src 'self'(?!.*unsafe-inline)/` sees style-src's `unsafe-inline` from script-src's only
   * candidate position and never matches — it fails on a policy that is in fact correct.
   */
  const directive = (name: string): string | undefined =>
    CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

  it("permits no eval and no inline script", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directive("script-src")).toBe("script-src 'self'");
  });
  it("forbids objects, framing and form posts", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
  });
  it("declares a default-src of self", () => expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'/));
});

describe("isAppUrl — the navigation lock", () => {
  it("admits the app's own origin", () => {
    expect(isAppUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isAppUrl(`${APP_ORIGIN}/admin/users`)).toBe(true);
  });
  it("refuses everything else", () => {
    for (const url of [
      "https://evil.test/",
      "http://127.0.0.1:4173/",
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "dulja://other/index.html",
      "javascript:alert(1)",
      "about:blank",
    ]) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });
});
```

`apps/desktop/test/posture.spec.ts` — the DoD 0.13 clause "renderer cannot reach Node", proven in a real packaged-shape launch:

```ts
import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

test.describe("Electron security posture", () => {
  test("the renderer cannot reach Node", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const reachable = await page.evaluate(() => [
      typeof (globalThis as Record<string, unknown>)["require"],
      typeof (globalThis as Record<string, unknown>)["process"],
      typeof (globalThis as Record<string, unknown>)["module"],
      typeof (globalThis as Record<string, unknown>)["Buffer"],
    ]);
    expect(reachable).toEqual(["undefined", "undefined", "undefined", "undefined"]);
    await app.close();
  });

  test("the document is served from the app's own origin under the CSP", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(await page.evaluate(() => globalThis.location.origin)).toBe("dulja://app");
    const csp = await page.evaluate(() =>
      document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
    );
    // The CSP is delivered as a response header, not a meta tag — so there is nothing to read here:
    expect(csp).toBe("");
    // …and the header's arrival is proved by a behaviour the CSP governs and the DevTools protocol
    // does not exempt: an inline <script> inserted into the document. (`page.evaluate(() => eval(…))`
    // is NOT that proof — CDP's Runtime.evaluate is generally exempt from the page CSP, so it would
    // pass or fail for reasons unrelated to the header.) `script-src 'self'` with no 'unsafe-inline',
    // no nonce and no hash must refuse to execute it.
    const inlineScriptRan = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const probe = globalThis as unknown as Record<string, unknown>;
          probe["__duljaCspProbe"] = false;
          const element = document.createElement("script");
          element.textContent = 'window.__duljaCspProbe = true;';
          document.head.appendChild(element);
          setTimeout(() => resolve(probe["__duljaCspProbe"] === true), 100);
        }),
    );
    expect(inlineScriptRan).toBe(false);
    await app.close();
  });

  test("navigation away from the app's origin is refused", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => { globalThis.location.href = "https://example.test/"; });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => globalThis.location.origin)).toBe("dulja://app");
    await app.close();
  });

  test("window.open is refused rather than opening a second renderer", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const opened = await page.evaluate(() => globalThis.open("https://example.test/") !== null);
    expect(opened).toBe(false);
    expect(app.windows()).toHaveLength(1);
    await app.close();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
bun run --cwd apps/desktop test
```

Expected: FAIL — `Failed to resolve import "../src/window-options"`.

- [ ] **Step 4: Write `src/window-options.ts`**

```ts
import type { BrowserWindowConstructorOptions } from "electron";

export const APP_SCHEME = "dulja" as const;
export const APP_ORIGIN = `${APP_SCHEME}://app` as const;

/**
 * spec:1284 "a strict Content-Security-Policy". `connect-src` admits https so the renderer can reach
 * the API; `style-src` admits inline because Tailwind's runtime injects a style element. Nothing
 * admits script beyond the app's own bundle, and nothing admits eval.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** spec:1284, verbatim: contextIsolation on, nodeIntegration off, sandbox on. */
export function browserWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    show: false,                       // shown on `ready-to-show`, so no white flash
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  };
}

/** The navigation lock (spec:1284 "renderer navigation locked to the app's own origin"). */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Write `src/main.ts`**

```ts
import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { pathToFileURL } from "node:url";
import { join, normalize, resolve } from "node:path";
import {
  APP_ORIGIN,
  APP_SCHEME,
  browserWindowOptions,
  CONTENT_SECURITY_POLICY,
  isAppUrl,
} from "./window-options";

/** The built back office. A path, not an import — `desktop` imports build outputs only (spec:2389). */
const RENDERER_DIR = resolve(__dirname, "../../backoffice/dist");

// Must run before `app.whenReady()`: a standard, secure scheme is what gives the renderer a real origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serveRenderer(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const candidate = normalize(join(RENDERER_DIR, decodeURIComponent(pathname)));
    // Path traversal out of the renderer directory is answered with the SPA shell, never with a file.
    const inside = candidate.startsWith(RENDERER_DIR);
    const target = inside && /\.[a-z0-9]+$/i.test(pathname) ? candidate : join(RENDERER_DIR, "index.html");
    return net.fetch(pathToFileURL(target).toString());
  });
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(browserWindowOptions(join(__dirname, "preload.js")));

  // Navigation lock. Anything not on the app's origin is refused here and offered to the OS browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  return window;
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    serveRenderer();
    applyCsp();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
```

- [ ] **Step 6: Run both suites to see them pass**

The renderer's `readEnv()` throws at boot when a `VITE_*` variable is missing (Task 5 Step 4), so the build needs the three required ones. Their values are irrelevant here — the posture specs never reach the network — but without them the window renders blank and every failure looks like a posture failure:

```bash
VITE_API_BASE_URL=https://api.invalid \
VITE_SUPABASE_URL=https://project.invalid \
VITE_SUPABASE_ANON_KEY=local-placeholder \
  bun run --cwd apps/backoffice build \
  && bun run --cwd apps/desktop build \
  && bun run --cwd apps/desktop test \
  && bun run --cwd apps/desktop test:electron
```

Expected: PASS — 12 Vitest assertions in `apps/desktop/test/window-options.test.ts` and 4 Playwright specs. The renderer must be built first; that is exactly the `turbo.json` edge added in Step 1.

A `preload.js` does not exist until Task 11; until then Electron logs "Unable to load preload script" and the four posture specs still pass, because they assert what the renderer **cannot** do. Re-run them at the end of Task 11.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop turbo.json bun.lock
git commit -m "feat(desktop): Electron main with the spec §3.7.2 posture, custom origin, navigation lock, CSP [0E T10]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The typed `contextBridge` and the `safeStorage` refresh-token store

**Files:**
- Create: `apps/desktop/src/bridge-types.ts`, `apps/desktop/src/secure-store.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/types/dulja.d.ts`, `docs/adr/0019-desktop-context-bridge.md`
- Modify: `apps/desktop/src/main.ts` (register the IPC handlers), `.github/workflows/ci.yml` (the `desktop` job on `windows-latest`)
- Test: `apps/desktop/test/secure-store.test.ts`, `apps/desktop/test/safe-storage.spec.ts`

**Interfaces:**
- Consumes: `electron.safeStorage`, `electron.contextBridge`, `electron.ipcRenderer`; the `AuthBridge` shape `apps/backoffice/src/lib/session-storage.ts` expects (Task 6) — `get` / `set` / `remove`.
- Produces:
  ```ts
  // apps/desktop/src/bridge-types.ts — the whole renderer-visible surface
  export interface DuljaAuthBridge { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
  export interface DuljaAppBridge { version(): Promise<string>; checkForUpdates(): Promise<UpdateStatus> }
  export interface DuljaPrintBridge { toPdf(options: { landscape: boolean }): Promise<Uint8Array> }
  export interface DuljaBridge { auth: DuljaAuthBridge; app: DuljaAppBridge; print: DuljaPrintBridge }
  export type UpdateStatus = { state: "up-to-date" | "available" | "downloading" | "error"; version?: string; message?: string };
  export const CHANNELS: { readonly [K in string]: string };

  // apps/desktop/src/secure-store.ts
  export class EncryptionUnavailableError extends Error {}
  export interface SecureStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
  export interface Crypto { isEncryptionAvailable(): boolean; encryptString(v: string): Buffer; decryptString(b: Buffer): string }
  export function createSecureStore(dir: string, crypto: Crypto): SecureStore;   // required, never defaulted
  ```

**Why `crypto` is a required parameter and not a defaulted `safeStorage`.** A module-level `import { safeStorage } from "electron"` would run under Vitest too, where `electron`'s main export is a **path string** and the named binding does not exist — the module fails or yields `undefined` at load, and Step 2's expected `Failed to resolve import "../src/secure-store"` would be masked by an unrelated error. Making the parameter required keeps `secure-store.ts` free of any Electron import; the main process supplies the real `safeStorage` in Step 5, which is the only place that legitimately runs inside Electron.

**Namespace note.** §4.10.6 already reserves `window.dulja.pos.{sell, tender, closeShift, pull, drain, clock, priceCheck}` for 6B. This task occupies `window.dulja.auth`, `window.dulja.app` and `window.dulja.print` **beside** it; 6B adds `pos` to the same `DuljaBridge` interface additively and changes nothing here.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/secure-store.test.ts` — pure, no Electron; `safeStorage` is injected:

```ts
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecureStore, EncryptionUnavailableError } from "../src/secure-store";

/** A stand-in for `safeStorage`: reversible, but not the plaintext — exactly the property under test. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (v: string) => Buffer.from(`enc:${Buffer.from(v, "utf8").toString("base64")}`, "utf8"),
  decryptString: (b: Buffer) => Buffer.from(b.toString("utf8").slice(4), "base64").toString("utf8"),
});

describe("createSecureStore", () => {
  it("round-trips a value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("sb-auth-token", "refresh-token-value");
    await expect(store.get("sb-auth-token")).resolves.toBe("refresh-token-value");
  });

  it("never writes the plaintext to disk (DoD 0.13)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("sb-auth-token", "refresh-token-value");
    for (const entry of await readdir(dir)) {
      const bytes = await readFile(join(dir, entry));
      expect(bytes.toString("utf8")).not.toContain("refresh-token-value");
      expect(bytes.toString("latin1")).not.toContain("refresh-token-value");
    }
  });

  it("returns null for an absent key rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    await expect(createSecureStore(dir, fakeCrypto()).get("nothing")).resolves.toBeNull();
  });

  it("removes a key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("k", "v");
    await store.remove("k");
    await expect(store.get("k")).resolves.toBeNull();
  });

  it("refuses to persist when encryption is unavailable — never falls back to plaintext", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto(false));
    await expect(store.set("k", "v")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps one key's file separate from another's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("a", "1");
    await store.set("b", "2");
    expect((await readdir(dir)).length).toBe(2);
    await expect(store.get("a")).resolves.toBe("1");
  });
});
```

`apps/desktop/test/safe-storage.spec.ts` — the real DPAPI path; runs on the `windows-latest` job:

```ts
import { _electron as electron, expect, test } from "@playwright/test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const TOKEN = "dulja-e2e-refresh-token-9f2c";

const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
};

test.describe("safeStorage token store", () => {
  test("stores and returns the token through the bridge, and leaves no plaintext on disk", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.evaluate(
      async (token) => { await globalThis.dulja.auth.set("sb-auth-token", token); },
      TOKEN,
    );
    expect(await page.evaluate(() => globalThis.dulja.auth.get("sb-auth-token"))).toBe(TOKEN);

    const userData: string = await app.evaluate(({ app: a }) => a.getPath("userData"));
    for (const file of await walk(userData)) {
      const bytes = await readFile(file);
      expect(bytes.toString("utf8"), file).not.toContain(TOKEN);
      expect(bytes.toString("latin1"), file).not.toContain(TOKEN);
    }
    await app.close();
  });

  test("the bridge exposes only the declared namespaces", async () => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(await page.evaluate(() => Object.keys(globalThis.dulja).sort())).toEqual(["app", "auth", "print"]);
    expect(await page.evaluate(() => Object.keys(globalThis.dulja.auth).sort())).toEqual(["get", "remove", "set"]);
    expect(await page.evaluate(() => typeof (globalThis.dulja as Record<string, unknown>)["ipcRenderer"])).toBe("undefined");
    await app.close();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
bun run --cwd apps/desktop test
```

Expected: FAIL — `Failed to resolve import "../src/secure-store"`.

- [ ] **Step 3: Write `src/secure-store.ts`**

```ts
// No `electron` import in this file, by design — see the note in the Interfaces block above.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "safeStorage reports no OS keyring, so the refresh token cannot be stored encrypted. " +
        "Dulja does not fall back to plaintext; sign in again after enabling the keyring.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(blob: Buffer): string;
}

/**
 * DoD 0.13 — "the token is not readable from disk in plain text". `safeStorage` is DPAPI on Windows.
 * When it is unavailable the store **refuses the write**; writing plaintext would satisfy the feature
 * and defeat the requirement.
 */
export function createSecureStore(dir: string, crypto: Crypto): SecureStore {
  const path = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.bin`);

  return {
    async get(key) {
      try {
        return crypto.decryptString(await readFile(path(key)));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (!crypto.isEncryptionAvailable()) throw new EncryptionUnavailableError();
      await mkdir(dir, { recursive: true });
      await writeFile(path(key), crypto.encryptString(value), { mode: 0o600 });
    },
    async remove(key) {
      await rm(path(key), { force: true });
    },
  };
}
```

- [ ] **Step 4: Write `src/bridge-types.ts`, `src/preload.ts` and `types/dulja.d.ts`**

```ts
// apps/desktop/src/bridge-types.ts
export type UpdateStatus = {
  state: "up-to-date" | "available" | "downloading" | "error";
  version?: string;
  message?: string;
};

export interface DuljaAuthBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DuljaAppBridge {
  version(): Promise<string>;
  checkForUpdates(): Promise<UpdateStatus>;
}

export interface DuljaPrintBridge {
  /** D18: printing goes through the Windows driver stack via Electron, with no hardware code. */
  toPdf(options: { landscape: boolean }): Promise<Uint8Array>;
}

/** 6B adds `pos: DuljaPosBridge` here additively (§4.10.6); nothing in this file changes then. */
export interface DuljaBridge {
  auth: DuljaAuthBridge;
  app: DuljaAppBridge;
  print: DuljaPrintBridge;
}

export const CHANNELS = {
  authGet: "dulja:auth:get",
  authSet: "dulja:auth:set",
  authRemove: "dulja:auth:remove",
  appVersion: "dulja:app:version",
  appCheckForUpdates: "dulja:app:check-for-updates",
  printToPdf: "dulja:print:to-pdf",
} as const;
```

```ts
// apps/desktop/src/preload.ts
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type DuljaBridge } from "./bridge-types";

/**
 * spec:1284 — "all privileged operations behind a typed `contextBridge` API, never raw Node in the
 * renderer". Every member is an explicit function over a named channel: no `ipcRenderer`, no `invoke`
 * with a caller-supplied channel name, nothing generic.
 */
const bridge: DuljaBridge = {
  auth: {
    get: (key) => ipcRenderer.invoke(CHANNELS.authGet, key),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.authSet, key, value),
    remove: (key) => ipcRenderer.invoke(CHANNELS.authRemove, key),
  },
  app: {
    version: () => ipcRenderer.invoke(CHANNELS.appVersion),
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.appCheckForUpdates),
  },
  print: {
    toPdf: (options) => ipcRenderer.invoke(CHANNELS.printToPdf, options),
  },
};

contextBridge.exposeInMainWorld("dulja", bridge);
```

This file is **bundled**, not merely compiled (Task 10 Step 1): under `sandbox: true` a preload's `require` resolves only `electron`, `events`, `timers` and `url`, so the relative import of `./bridge-types` must be inlined by `bun build` before Electron ever sees it. A plain `tsc` output here fails at runtime with "Cannot find module './bridge-types'", the preload never executes, and every `window.dulja` assertion below fails with `undefined`.

```ts
// apps/desktop/types/dulja.d.ts — consumed by the renderer's tsconfig and by the Playwright specs
import type { DuljaBridge } from "../src/bridge-types";

declare global {
  // eslint-disable-next-line no-var
  var dulja: DuljaBridge;
  interface Window { dulja: DuljaBridge }
}
export {};
```

- [ ] **Step 5: Register the handlers in `src/main.ts`**

**Extend** `main.ts`'s existing `electron` import — Task 10 Step 5 wrote `import { app, BrowserWindow, net, protocol, session, shell } from "electron";` — to add `ipcMain` and `safeStorage`, rather than adding a second statement from the same module (`import/no-duplicates`). Then add the two new relative imports and the function, above `createWindow`:

```ts
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } from "electron";  // extended
import { createSecureStore } from "./secure-store";
import { CHANNELS } from "./bridge-types";

function registerBridgeHandlers(): void {
  // The one place `safeStorage` is named: the main process, which is the only context that has it.
  const store = createSecureStore(join(app.getPath("userData"), "secure"), safeStorage);
  ipcMain.handle(CHANNELS.authGet, (_event, key: string) => store.get(key));
  ipcMain.handle(CHANNELS.authSet, (_event, key: string, value: string) => store.set(key, value));
  ipcMain.handle(CHANNELS.authRemove, (_event, key: string) => store.remove(key));
  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion());
  ipcMain.handle(CHANNELS.printToPdf, async (event, options: { landscape: boolean }) =>
    new Uint8Array(await event.sender.printToPDF({ landscape: options.landscape, printBackground: true })),
  );
}
```

and call `registerBridgeHandlers()` inside `app.whenReady()` before `createWindow()`. `CHANNELS.appCheckForUpdates` is registered in Task 12 with the updater.

- [ ] **Step 6: Add the `windows-latest` CI job**

`safeStorage` is DPAPI-backed; on a Linux runner with no keyring `isEncryptionAvailable()` is `false` and the plaintext assertion proves nothing (assumption 8). Add a **second** job to `.github/workflows/ci.yml`, leaving Plan 0A's `checks` job untouched:

```yaml
  desktop:
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: bun install --frozen-lockfile
      - run: bun run --cwd apps/backoffice build
        env:
          VITE_API_BASE_URL: https://api.invalid
          VITE_SUPABASE_URL: https://project.invalid
          VITE_SUPABASE_ANON_KEY: ci-placeholder
      - run: bun run --cwd apps/desktop build
      - run: bun run --cwd apps/desktop test
      - run: bun run --cwd apps/desktop test:electron
```

- [ ] **Step 7: Run everything to see it pass**

```bash
bun run --cwd apps/desktop test && bun run --cwd apps/desktop build && bun run --cwd apps/desktop test:electron
```

Expected: PASS — 18 Vitest assertions (12 in `window-options.test.ts` + the 6 new ones in `secure-store.test.ts`; the command runs the whole workspace), and 4 + 2 Playwright specs (the Task 10 posture specs now also confirm the preload loaded). On a non-Windows machine `safe-storage.spec.ts` fails at `set` with `EncryptionUnavailableError`; that is the correct behaviour, and the job that must pass is `desktop` on `windows-latest`.

- [ ] **Step 8: Write ADR 0019 as a proposal (spec:95 — it touches security)**

`docs/adr/0019-desktop-context-bridge.md`:

```markdown
# 0019 — The `window.dulja` context-bridge surface (PROPOSAL)

**Status:** proposed — awaiting the owner's approval before merge · **Date:** 2026-09-05 · **Slice:** 0E
**Spec:** §3.7.2 (spec:1284), §0.2 "if it touches money semantics, security, the data model, or the sync protocol, write the ADR as a proposal and ask before implementing" (spec:95)

## Context
The renderer is sandboxed with `contextIsolation: true` and `nodeIntegration: false`. Everything
privileged therefore crosses one boundary. That boundary's shape is a security decision, and §4.10.6
of the plan contracts has already frozen one member of it — `window.dulja.pos.*` for the POS (6B).

## Proposal
One frozen object, `window.dulja`, with exactly three namespaces in 0E and one added by 6B:

| Namespace | Members | Why it must cross the boundary |
|---|---|---|
| `auth` | `get(key)`, `set(key, value)`, `remove(key)` | `safeStorage` lives only in the main process |
| `app` | `version()`, `checkForUpdates()` | `app.getVersion()`, electron-updater |
| `print` | `toPdf({ landscape })` | `webContents.printToPDF` (D18: Windows drivers, no hardware code) |
| `pos` (6B) | per §4.10.6 | `better-sqlite3` |

Rules the implementation holds to:
1. **No generic channel.** `ipcRenderer` is never exposed; each member names one constant channel.
2. **No filesystem, no network, no shell.** A renderer that wants a file asks for a named operation.
3. **The main process validates every argument** and returns plain JSON-serialisable values.
4. **`safeStorage` unavailable → refuse.** Never a plaintext fallback (DoD 0.13).

## Consequences
- Adding a member is an amendment to this ADR, not a code change alone.
- 6B extends `DuljaBridge` additively and touches no 0E file.
- A renderer compromise reaches only these seven functions.

## Question for the owner
Approve this surface, or name an operation it should not carry.
```

- [ ] **Step 9: Commit**

```bash
git add apps/desktop docs/adr/0019-desktop-context-bridge.md .github/workflows/ci.yml
git commit -m "feat(desktop): typed contextBridge and safeStorage token store; windows CI job [0E T11]

ADR 0019 is a proposal per spec:95 — the bridge surface is a security decision.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: electron-builder installer, auto-update, Sentry, the `better-sqlite3` ABI, and ADR 0017

**Files:**
- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/src/updater.ts`, `apps/desktop/src/sentry.ts`, `docs/adr/0017-electron-builder-bun-workspace.md`
- Modify: `apps/desktop/src/main.ts`, `apps/desktop/package.json`, `tests/regression/legacy-087.test.ts` (append the `— 0E` block)
- Test: `apps/desktop/test/native-module.spec.ts`, `apps/desktop/test/updater.spec.ts`

**Interfaces:**
- Consumes: `CHANNELS.appCheckForUpdates` (Task 11); 0C's R2 `UPDATE_FEED` binding and the electron-builder feed the edge Worker serves (§3.11); `SENTRY_DSN` (§3.11).
- Produces: `dist-installer/Dulja Back Office Setup <version>.exe`; `apps/desktop/src/updater.ts` `configureUpdater(feedUrl: string): void` and `checkForUpdates(): Promise<UpdateStatus>`; `apps/desktop/src/sentry.ts` `initSentry(dsn: string | undefined): void`.

**Owner gate note (hazard 5).** *Owner provides: the update-feed domain served from R2 (OD-20). Verify with `DULJA_UPDATE_FEED=https://<domain>/updates/backoffice/ bun run --cwd apps/desktop test:electron -- updater` — the spec reports `up-to-date` against the published `latest.yml`.* *Owner provides: the Sentry DSN (OD-22). Verify with `SENTRY_DSN=<dsn> bun run --cwd apps/desktop start` and one event visible in the Sentry issue stream.* **Until provided:** the updater runs against a local static feed served from `apps/desktop/dist-installer/`, and Sentry initialises with no DSN and is inert (the code path is still exercised).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/native-module.spec.ts` — DoD 0.13 "`better-sqlite3` loads inside the packaged app":

```ts
import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

test("better-sqlite3 loads in the main process against Electron's Node ABI", async () => {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, DULJA_E2E: "1" } });
  const result = await app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3") as new (path: string) => {
      prepare(sql: string): { get(): { answer: number } };
      close(): void;
    };
    const db = new Database(":memory:");
    const row = db.prepare("select 42 as answer").get();
    db.close();
    return row.answer;
  });
  expect(result).toBe(42);
  await app.close();
});
```

`apps/desktop/test/updater.spec.ts`:

```ts
import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

test("checkForUpdates reaches the feed and reports a state, never throws into the renderer", async () => {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DULJA_E2E: "1", DULJA_UPDATE_FEED: "http://127.0.0.1:9/none/" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const status = await page.evaluate(() => globalThis.dulja.app.checkForUpdates());
  expect(["up-to-date", "available", "downloading", "error"]).toContain(status.state);
  expect(typeof await page.evaluate(() => globalThis.dulja.app.version())).toBe("string");
  await app.close();
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
bun run --cwd apps/desktop test:electron -- updater
```

Expected: FAIL — `No handler registered for 'dulja:app:check-for-updates'`.

- [ ] **Step 3: Write `src/updater.ts` and `src/sentry.ts`**

```ts
// apps/desktop/src/updater.ts
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "./bridge-types";

/**
 * electron-builder's updater against the feed the edge Worker serves from R2 (§3.11 `UPDATE_FEED`;
 * spec:1279 "Every till updates itself"). The feed URL is configuration, never a literal.
 */
export function configureUpdater(feedUrl: string): void {
  autoUpdater.autoDownload = false;
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
}

/** Never throws into the renderer: an unreachable feed is a state, not an exception. */
export async function checkForUpdates(): Promise<UpdateStatus> {
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo.version;
    if (version === undefined || version === autoUpdater.currentVersion.version) return { state: "up-to-date" };
    void autoUpdater.downloadUpdate();
    return { state: "available", version };
  } catch (cause) {
    return { state: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
}
```

```ts
// apps/desktop/src/sentry.ts
import * as Sentry from "@sentry/electron/main";

/** spec:2324 — Sentry in the API and Electron. No DSN means inert, not broken (OD-22 default). */
export function initSentry(dsn: string | undefined, environment: string): void {
  if (dsn === undefined || dsn === "") return;
  Sentry.init({ dsn, environment, tracesSampleRate: 0.1 });
}
```

Wire both into `src/main.ts`'s `app.whenReady()` block:

```ts
import { checkForUpdates, configureUpdater } from "./updater";
import { initSentry } from "./sentry";

initSentry(process.env["SENTRY_DSN"], process.env["APP_ENV"] ?? "dev");
configureUpdater(process.env["DULJA_UPDATE_FEED"] ?? "http://127.0.0.1:4180/updates/backoffice/");
ipcMain.handle(CHANNELS.appCheckForUpdates, () => checkForUpdates());
```

- [ ] **Step 4: Write `electron-builder.yml`**

```yaml
appId: my.dulja.backoffice
productName: Dulja Back Office
copyright: © Dulja
directories:
  output: dist-installer
  buildResources: build
# `desktop` imports build outputs only (spec:2389): the renderer arrives as files, not as a dependency.
files:
  - dist/**/*
  - package.json
extraResources:
  - from: ../backoffice/dist
    to: renderer
asar: true
asarUnpack:
  - "**/node_modules/better-sqlite3/**"      # a native module cannot be loaded from inside the archive
npmRebuild: true
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: ${productName} Setup ${version}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
publish:
  - provider: generic
    url: ${env.DULJA_UPDATE_FEED}
```

`RENDERER_DIR` in `src/main.ts` must resolve both in development (`../../backoffice/dist`) and inside the package (`process.resourcesPath/renderer`). Replace the constant with:

```ts
const RENDERER_DIR = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : resolve(__dirname, "../../backoffice/dist");
```

- [ ] **Step 5: Build the installer and verify the ⚠️ items of spec:2323**

```bash
bun run --cwd apps/backoffice build
bun run --cwd apps/desktop build
bun run --cwd apps/desktop dist
ls "apps/desktop/dist-installer"
```

Expected: `Dulja Back Office Setup 0.1.0.exe` plus `latest.yml`. **Two things are being verified here, and both go into ADR 0017:**

1. **Bun-workspace resolution.** electron-builder walks `node_modules` to decide what to bundle. Bun's workspace layout hoists to the repo root. If the build fails with "cannot find module" for a runtime dependency, the documented fallback of spec:2323 applies: give `apps/desktop` its own `package-lock.json` (`cd apps/desktop && npm install --package-lock-only && npm ci`) and set `buildDependenciesFromSource: false`. Record which of the two happened.
2. **`better-sqlite3` against Electron's Node ABI.** `npmRebuild: true` runs `@electron/rebuild`. If the packaged app fails to load it, run `bunx @electron/rebuild -f -w better-sqlite3 -m apps/desktop` and record the invocation.

```bash
bun run --cwd apps/desktop test:electron
```

Expected: PASS — 4 posture + 2 bridge + 1 native-module + 1 updater specs.

- [ ] **Step 6: Append the `— 0E` block to `tests/regression/legacy-087.test.ts`**

LEGACY-087 is "Hardcoded developer build paths in shipped metadata: `W:\Work\delphi\jobs\…`. The build is machine-bound." 0B created the file for the clean-runner fact; **append**, never edit an earlier block (§3.7.3):

Append these imports at the top of the file first — **if 0B's block already imports a name, keep the single existing import rather than adding a second statement**:

```ts
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
```

The block needs its own `walk`, written here in full. It is the **async, string-returning** walk of `apps/desktop/test/safe-storage.spec.ts` — *not* the synchronous `{ path, text }[]` walk of `tests/invariants/lint-rules.test.ts`. Pointing at that one would be silently vacuous: `for (const file of await walk(dir))` would bind `file` to an object, `/\.(yml|yaml|json|txt)$/i.test(file)` would test the string `"[object Object]"` and never match, the loop body would never run, `offenders` would stay empty and the test would pass without opening a single file.

```ts
/** Every file under `dir`, recursively, as an absolute path. */
const walkFiles = async (dir: string, out: string[] = []): Promise<string[]> => {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0E", () => {
  const INSTALLER_DIR = resolve(__dirname, "../../apps/desktop/dist-installer");
  const built = existsSync(INSTALLER_DIR);

  it.runIf(built)("no shipped metadata file carries an absolute path from the build machine", async () => {
    const offenders: string[] = [];
    const files = await walkFiles(INSTALLER_DIR);
    // Guard against the vacuous pass: if nothing matched the extension filter, the assertion below
    // would prove nothing at all.
    const inspected = files.filter((file) => /\.(yml|yaml|json|txt)$/i.test(file));
    expect(inspected.length, `no metadata file found under ${INSTALLER_DIR}`).toBeGreaterThan(0);
    for (const file of inspected) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/[A-Za-z]:\\[^\s"']{4,}/g)) offenders.push(`${file}: ${match[0]}`);
      for (const match of text.matchAll(/\/(home|Users)\/[^\s"']{2,}/g)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it.runIf(built)("the update feed is configuration, not a literal in the shipped app", async () => {
    const latest = await readFile(join(INSTALLER_DIR, "latest.yml"), "utf8");
    expect(latest).toContain("version:");
    expect(latest).not.toMatch(/[A-Za-z]:\\/);
  });
});
```

`it.runIf(built)` skips both when `dist-installer/` is absent (Step 5 was not run on this machine); when it is present, the `inspected.length` guard makes the first one impossible to pass vacuously.

- [ ] **Step 7: Write ADR 0017**

`docs/adr/0017-electron-builder-bun-workspace.md`:

```markdown
# 0017 — electron-builder from a Bun workspace, and `better-sqlite3` against Electron's ABI

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0E
**Spec:** §5.0 task 0.13 (spec:2323) — "⚠️ Verify here and record an ADR"; D2, D5.

## Context
spec:2323 names two risks and demands they be settled in Phase 0: electron-builder resolving
dependencies from a **Bun** workspace, and `better-sqlite3` rebuilt against **Electron's Node ABI**
(`@electron/rebuild`). "If either fails, `apps/desktop` keeps its own npm lockfile."

## What was verified
_(fill in from the Step 5 run — the exact command, the exact output, and which branch was taken)_

| Risk | Outcome | Evidence |
|---|---|---|
| electron-builder from the Bun workspace | `works` / `needs its own npm lockfile` | the `bun run --cwd apps/desktop dist` transcript |
| `better-sqlite3` inside the packaged app | `works` / `needs an explicit @electron/rebuild` | `apps/desktop/test/native-module.spec.ts` |

## Decision
1. `apps/desktop` builds with electron-builder, `npmRebuild: true`, `asarUnpack` for
   `better-sqlite3` (a native module cannot be loaded from inside the asar archive).
2. The renderer arrives as `extraResources` from `apps/backoffice/dist` — **build output, not a
   dependency** — which is how spec:2389's "`desktop` imports only build outputs" is held mechanically.
3. **Fallback, if the table above says so:** `apps/desktop` carries its own `package-lock.json`,
   generated by `npm install --package-lock-only`, and CI runs `npm ci` in that directory before
   `electron-builder`. Nothing else in the monorepo changes; Bun still owns every other workspace.
4. `better-sqlite3` is a dependency of `apps/desktop` from 0E even though the back office does not use
   it: the DoD requires the ABI path to be proven now. 6B is its first real consumer.

## Consequences
- 6B inherits a working native-module build and does not re-solve it.
- The renderer can be rebuilt without touching the desktop package, and vice versa.
```

- [ ] **Step 8: Commit**

```bash
git add apps/desktop docs/adr/0017-electron-builder-bun-workspace.md tests/regression/legacy-087.test.ts
git commit -m "feat(desktop): electron-builder installer, auto-update, Sentry, better-sqlite3 ABI [0E T12]

ADR 0017 records the two ⚠️ verifications spec:2323 demands. legacy-087 gains the 0E block:
no build-machine path reaches shipped metadata.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 13: OWNER GATE OD-18 — the signed installer

The only clause of DoD 0.13 an owner item blocks: "Installer runs on a clean Windows VM **without an unsigned-publisher warning**". Everything else in 0.13 is already green from Tasks 10–12. This task is isolated per contracts §2.0 and §2.12; dropping it renumbers nothing.

**Files:**
- Create: `docs/runbooks/clean-vm-install.md`
- Modify: `.github/workflows/release.yml` (new), `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: the unsigned installer from Task 12. **Produces:** a signed `Dulja Back Office Setup <version>.exe` and the runbook that verifies it.

**Owner gate (hazard 5 pattern).**
*Owner provides:* a **Windows code-signing certificate, OV or EV** (OD-18; spec:92, 2323; §5.3 "0.13"), as two GitHub Actions secrets — `WINDOWS_CODE_SIGN_CERT` (base64 of the `.pfx`) and `WINDOWS_CODE_SIGN_PASSWORD`. These two names are frozen by §3.11 and are **CI only** — never in a container, never on a developer machine, never in the repository (spec:2273).
*Verify with:*

```bash
gh secret list --repo <owner>/<repo> | grep -E "WINDOWS_CODE_SIGN_(CERT|PASSWORD)"
```

Expected: both names listed. Then, after a release run, on the clean VM:

```powershell
Get-AuthenticodeSignature ".\Dulja Back Office Setup 0.1.0.exe" | Format-List Status, SignerCertificate
```

Expected: `Status : Valid` and a `SignerCertificate` whose subject is the owner's organisation.

*Until provided:* the unsigned installer of Task 12 is the artefact, the SmartScreen warning is **expected and recorded** in the runbook, and only this task's two files change when the certificate arrives.

- [ ] **Step 1: Write the clean-VM runbook**

`docs/runbooks/clean-vm-install.md`:

```markdown
# Runbook — verifying the back-office installer on a clean Windows VM (DoD 0.13)

A clean VM means: a fresh Windows 11 image, never used for development, no Node, no Bun, no Visual
Studio redistributables beyond the base image, SmartScreen at its default setting.

## 1. Get the artefact
Download `Dulja Back Office Setup <version>.exe` from the `release` workflow run (or copy the local
`apps/desktop/dist-installer/` build).

## 2. Check the signature before running anything
```powershell
Get-AuthenticodeSignature ".\Dulja Back Office Setup <version>.exe" | Format-List Status, SignerCertificate
```
| Result | Meaning |
|---|---|
| `Status : Valid` | OD-18 satisfied. Continue to step 3 and expect **no** publisher warning. |
| `Status : NotSigned` | OD-18 still pending. Continue; a SmartScreen "Windows protected your PC / Unknown publisher" dialog **is expected** and is not a defect. Record the screenshot in the PR. |

## 3. Install
Double-click. Choose a per-user installation. Expected: the installer completes, a Start-menu entry
"Dulja Back Office" exists, and the application window opens.

## 4. The three clauses that do not need the certificate
| Clause | How to check on the VM |
|---|---|
| renderer cannot reach Node | in the app, press `Ctrl+Shift+I` — DevTools does not open in a packaged build; instead confirm via the CI job `desktop / posture.spec.ts` on the same commit |
| token not readable from disk in plain text | sign in, then `Select-String -Path "$env:APPDATA\dulja-back-office\secure\*" -Pattern "<the refresh token>"` → **no matches** |
| `better-sqlite3` loads inside the packaged app | CI job `desktop / native-module.spec.ts` on the same commit |

## 5. Uninstall
Settings → Apps → Dulja Back Office → Uninstall. Expected: the Start-menu entry disappears and
`%APPDATA%\dulja-back-office` is the only residue (it holds the encrypted token store).

## 6. Record
Attach to the PR: the `Get-AuthenticodeSignature` output, a screenshot of the first-run window in
**both** text directions (spec:2274), and — while OD-18 is pending — the SmartScreen dialog.
```

- [ ] **Step 2: Add the release workflow, signing only when the secrets exist**

`.github/workflows/release.yml`:

```yaml
name: release
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
jobs:
  windows-installer:
    runs-on: windows-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: bun install --frozen-lockfile
      - run: bun run --cwd apps/backoffice build
        env:
          VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL }}
          VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}
          VITE_SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
          VITE_APP_ENV: staging
      - run: bun run --cwd apps/desktop build
      # OD-18: the two §3.11 secret names, and no others. Absent → an unsigned build, by design.
      - run: bun run --cwd apps/desktop dist
        env:
          DULJA_UPDATE_FEED: ${{ vars.DULJA_UPDATE_FEED }}
          CSC_LINK: ${{ secrets.WINDOWS_CODE_SIGN_CERT }}
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CODE_SIGN_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with:
          name: backoffice-installer
          path: apps/desktop/dist-installer/*
```

`CSC_LINK` / `CSC_KEY_PASSWORD` are electron-builder's own variable names; the **repository secrets** carry the §3.11 names, and this file is the one place the two are joined. 6B's `pos.exe` job references the same two secrets and no others (§3.11).

- [ ] **Step 3: Verify the pending path today**

```bash
gh secret list 2>/dev/null | grep -E "WINDOWS_CODE_SIGN" || echo "OD-18 pending — unsigned build is the artefact"
```

Expected while pending: the fallback line prints, `bun run --cwd apps/desktop dist` still succeeds, and `Get-AuthenticodeSignature` reports `NotSigned`. Record that in the runbook's step 2 table and in the PR.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/clean-vm-install.md .github/workflows/release.yml
git commit -m "chore(desktop): release workflow and clean-VM runbook; OD-18 signing gate isolated [0E T13]

Signing is driven by WINDOWS_CODE_SIGN_CERT/PASSWORD (§3.11, CI only). Absent, the build
is unsigned and the SmartScreen warning is expected and recorded.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: The PDF-engine spike and ADR 0016

spec:1132 calls the Arabic RTL glyph shaping problem "the largest technical risk in reporting" and spec:93 puts it in the *agent verifies and records an ADR — do not stop* list: "the PDF engine (§3.2.2 — decide in week one with a real Arabic tax invoice)". Contracts hazard 30: "**The PDF engine is decided once, in 0E (ADR 0016)**, on a real Arabic tax invoice; 2C, 7A and 8D consume that ADR and never re-evaluate engines." Two downstream consumers depend on the literal it fixes: `app.print_template.engine` (§4.5.9, 2C's migration 0026) and `renderReport`'s adapter set (§4.11.2, 7A).

**Files:**
- Create: `spikes/pdf-engine/package.json`, `spikes/pdf-engine/fixture/invoice.json`, `spikes/pdf-engine/candidates/typst/invoice.typ`, `spikes/pdf-engine/candidates/chromium/invoice.html`, `spikes/pdf-engine/candidates/react-pdf/invoice.tsx`, `spikes/pdf-engine/render.ts`, `spikes/pdf-engine/inspect.ts`, `docs/adr/0016-pdf-engine.md`

**Interfaces:**
- Consumes: nothing from the monorepo. `spikes/` is outside the `workspaces` globs (`packages/*`, `apps/*`, `tests`) deliberately: a spike must be able to install a candidate the product does not depend on.
- Produces: `docs/adr/0016-pdf-engine.md`, whose **Verdict table** is the closed value set of `app.print_template.engine` (§4.5.9) and the adapter set of §4.11.2.

**Hazard note (contracts §5 item 2).** The fixture invoice contains **no** LHDN or MyInvois field name, endpoint, schema version, threshold or deadline. Its identifiers are obviously synthetic. Real e-invoicing fields arrive only with 5B's ADR 0051.

- [ ] **Step 1: Write the fixture**

`spikes/pdf-engine/fixture/invoice.json` — a bilingual tax invoice with everything that makes Arabic typesetting hard: contextual letter forms, a lam-alef ligature, a mixed Arabic/Latin/digit line, and a right-aligned money column:

```json
{
  "number": "INV-EXAMPLE-000042",
  "issuedOn": "2026-01-15",
  "currency": "MYR",
  "seller": {
    "nameEn": "Example Trading Sdn Bhd",
    "nameAr": "شركة المثال للتجارة",
    "addressEn": "12 Example Street, Kuala Lumpur",
    "addressAr": "١٢ شارع المثال، كوالالمبور",
    "registrationId": "REG-EXAMPLE-0001"
  },
  "buyer": {
    "nameEn": "Al-Amin Stores",
    "nameAr": "متاجر الأمين",
    "addressEn": "5 Sample Road, Penang",
    "addressAr": "٥ طريق العينة، بينانج",
    "registrationId": "REG-EXAMPLE-0002"
  },
  "lines": [
    { "descriptionEn": "Arabica coffee beans 1 kg", "descriptionAr": "حبوب قهوة عربية ١ كجم", "quantity": "12.000000", "unitPrice": "38.5000", "amount": "462.0000" },
    { "descriptionEn": "Paper cups (sleeve of 50)", "descriptionAr": "أكواب ورقية (رزمة ٥٠)", "quantity": "40.000000", "unitPrice": "7.2500", "amount": "290.0000" },
    { "descriptionEn": "Delivery to Penang — model XR-9", "descriptionAr": "التوصيل إلى بينانج — طراز XR-9", "quantity": "1.000000", "unitPrice": "60.0000", "amount": "60.0000" }
  ],
  "subtotal": "812.0000",
  "tax": { "labelEn": "Tax (example rate)", "labelAr": "الضريبة (نسبة توضيحية)", "rate": "0.0600", "amount": "48.7200" },
  "total": "860.7200",
  "notes": {
    "en": "This is a synthetic fixture. No figure here is a real statutory rate.",
    "ar": "هذه وثيقة اختبارية. لا يمثل أي رقم فيها نسبة قانونية حقيقية."
  }
}
```

Two shaping traps are deliberate: `لا` in `المثال`/`الأمين` exercises the lam-alef ligature, and `التوصيل إلى بينانج — طراز XR-9` mixes an RTL run, an em dash and an LTR run with digits in one line.

- [ ] **Step 2: Write the three candidates**

`spikes/pdf-engine/package.json`:

```json
{
  "name": "dulja-spike-pdf-engine",
  "private": true,
  "type": "module",
  "scripts": {
    "render": "bun run render.ts",
    "inspect": "bun run inspect.ts"
  }
}
```

```bash
bun add --cwd spikes/pdf-engine playwright @react-pdf/renderer react pdfjs-dist \
  @fontsource/noto-sans-arabic @fontsource/noto-sans
# Candidates A and B use whatever Noto the machine has installed; candidate C cannot — fontkit needs a
# real file path, so the two @fontsource packages put one inside spikes/pdf-engine/node_modules.
# Typst is a binary, not an npm package: install it on the machine running the spike
#   winget install --id Typst.Typst      (Windows)
#   brew install typst                   (macOS)
typst --version
```

**Candidate A — Typst** (`candidates/typst/invoice.typ`): a typesetting engine with its own shaper. The template reads `fixture/invoice.json` through `--input`:

```typst
#let data = json(sys.inputs.fixture)
#let dir = sys.inputs.dir            // "ltr" or "rtl"
#set text(font: ("Noto Sans Arabic", "Noto Sans"), size: 10pt, dir: if dir == "rtl" { rtl } else { ltr })
#set page(paper: "a4", margin: 2cm)

#let nm(p) = if dir == "rtl" { p.nameAr } else { p.nameEn }
#let ln(l) = if dir == "rtl" { l.descriptionAr } else { l.descriptionEn }

= #if dir == "rtl" [فاتورة ضريبية] else [Tax invoice]
#data.number · #data.issuedOn

#grid(columns: (1fr, 1fr), nm(data.seller), nm(data.buyer))

#table(
  columns: (3fr, 1fr, 1fr, 1fr),
  align: (start, end, end, end),
  [#if dir == "rtl" [الوصف] else [Description]],
  [#if dir == "rtl" [الكمية] else [Quantity]],
  [#if dir == "rtl" [السعر] else [Unit price]],
  [#if dir == "rtl" [المبلغ] else [Amount]],
  ..data.lines.map(l => (ln(l), l.quantity, l.unitPrice, l.amount)).flatten(),
)

#align(end)[
  #data.subtotal \
  #if dir == "rtl" { data.tax.labelAr } else { data.tax.labelEn }: #data.tax.amount \
  *#data.total #data.currency*
]
```

**Candidate B — Chromium print-to-PDF** (`candidates/chromium/invoice.html`): the shaper already in the stack. Electron's `webContents.printToPDF` and Playwright's `page.pdf()` are the same engine, so a pass here means the desktop app can print without a second dependency (D18). The file is one HTML document reading the fixture via a `<script type="application/json">` block and rendering it with the same logical-property CSS the app uses:

```html
<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: "Noto Sans Arabic", "Noto Sans", sans-serif; font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #888; padding: 4px; text-align: start; }
  .num { text-align: end; font-variant-numeric: tabular-nums; }
  .totals { text-align: end; }
</style></head>
<body>
  <h1 id="title"></h1>
  <p id="meta"></p>
  <div id="parties"></div>
  <table><thead><tr id="head"></tr></thead><tbody id="lines"></tbody></table>
  <div class="totals" id="totals"></div>
  <script id="fixture" type="application/json"></script>
  <script>
    const data = JSON.parse(document.getElementById("fixture").textContent);
    const rtl = document.documentElement.dir === "rtl";
    const T = rtl
      ? { title: "فاتورة ضريبية", desc: "الوصف", qty: "الكمية", price: "السعر", amt: "المبلغ" }
      : { title: "Tax invoice", desc: "Description", qty: "Quantity", price: "Unit price", amt: "Amount" };
    document.getElementById("title").textContent = T.title;
    document.getElementById("meta").textContent = `${data.number} · ${data.issuedOn}`;
    document.getElementById("parties").textContent =
      `${rtl ? data.seller.nameAr : data.seller.nameEn} → ${rtl ? data.buyer.nameAr : data.buyer.nameEn}`;
    document.getElementById("head").innerHTML =
      `<th>${T.desc}</th><th class="num">${T.qty}</th><th class="num">${T.price}</th><th class="num">${T.amt}</th>`;
    document.getElementById("lines").innerHTML = data.lines.map((l) =>
      `<tr><td>${rtl ? l.descriptionAr : l.descriptionEn}</td><td class="num">${l.quantity}</td>` +
      `<td class="num">${l.unitPrice}</td><td class="num">${l.amount}</td></tr>`).join("");
    document.getElementById("totals").innerHTML =
      `${data.subtotal}<br>${rtl ? data.tax.labelAr : data.tax.labelEn}: ${data.tax.amount}` +
      `<br><strong>${data.total} ${data.currency}</strong>`;
  </script>
</body></html>
```

**Candidate C — `@react-pdf/renderer`** (`candidates/react-pdf/invoice.tsx`): a pure-JS renderer with `fontkit` shaping. It is the only candidate that needs no external binary and no browser, which matters for the container image 7A's `reporting.render` job runs in — which is why the ADR treats it as the one whose result changes 7A's deployment shape.

```tsx
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

/** The fixture's shape — the same JSON `render.ts` reads and the other two candidates consume. */
export interface InvoiceParty { nameEn: string; nameAr: string; addressEn: string; addressAr: string; registrationId: string }
export interface InvoiceLine { descriptionEn: string; descriptionAr: string; quantity: string; unitPrice: string; amount: string }
export interface Invoice {
  number: string;
  issuedOn: string;
  currency: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  subtotal: string;
  tax: { labelEn: string; labelAr: string; rate: string; amount: string };
  total: string;
  notes: { en: string; ar: string };
}

/**
 * fontkit loads TrueType/OpenType from a **file path** (`fontkit.open`), so the font must exist on
 * disk — a family name means nothing here, unlike candidates A and B. `.ttf` is preferred over `.woff`
 * and `.woff2` because woff2 decoding needs a Brotli decoder fontkit may not have. Resolving by scan
 * rather than by a hard-coded filename keeps this working when @fontsource changes its file naming.
 */
const fontFile = (pkg: string, match: RegExp): string => {
  const dir = join(import.meta.dir, "../../node_modules", pkg, "files");
  const rank = (name: string) => (name.endsWith(".ttf") ? 0 : name.endsWith(".woff") ? 1 : 2);
  const found = readdirSync(dir)
    .filter((name) => match.test(name) && /\.(ttf|woff|woff2)$/.test(name))
    .sort((a, b) => rank(a) - rank(b))[0];
  if (found === undefined) {
    throw new Error(`no usable font file in ${dir} — run \`bun add --cwd spikes/pdf-engine ${pkg}\``);
  }
  return join(dir, found);
};

Font.register({ family: "NotoSansArabic", src: fontFile("@fontsource/noto-sans-arabic", /arabic-400-normal/) });
Font.register({ family: "NotoSans", src: fontFile("@fontsource/noto-sans", /latin-400-normal/) });

// The Arabic face first, the Latin face as the fallback: react-pdf's substitution engine walks the
// stack per code point, which is what keeps `XR-9` legible inside an Arabic sentence. If the installed
// version's types reject the array form, use the string "NotoSansArabic, NotoSans" instead and record
// which form was needed in ADR 0016 — it is a property of the candidate, and the ADR is where
// candidate properties go.
const FONT_STACK = ["NotoSansArabic", "NotoSans"];

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: FONT_STACK },
  heading: { fontSize: 16, marginBottom: 8 },
  meta: { marginBottom: 12 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#888888", paddingVertical: 4 },
  description: { flex: 3 },
  figure: { flex: 1, textAlign: "right" },
  totals: { marginTop: 16 },
});

/**
 * `direction` is set on every container: react-pdf lays a `row` out end-to-start under `rtl`, which is
 * the column-order half of acceptance test 23. `textAlign: "right"` on the figure columns is the
 * physical spelling react-pdf offers — it has no logical `start`/`end` — so under `rtl` the figures
 * still sit against the reader's trailing edge because the row itself is reversed.
 */
export async function renderInvoice(fixture: Invoice, dir: "ltr" | "rtl"): Promise<Buffer> {
  const rtl = dir === "rtl";
  const label = rtl
    ? { title: "فاتورة ضريبية", desc: "الوصف", qty: "الكمية", price: "السعر", amt: "المبلغ" }
    : { title: "Tax invoice", desc: "Description", qty: "Quantity", price: "Unit price", amt: "Amount" };
  const party = (p: InvoiceParty) => (rtl ? p.nameAr : p.nameEn);

  return renderToBuffer(
    <Document>
      <Page size="A4" style={styles.page} debug={false}>
        <View style={{ direction: dir }}>
          <Text style={styles.heading}>{label.title}</Text>
          <Text style={styles.meta}>{`${fixture.number} · ${fixture.issuedOn}`}</Text>

          <View style={[styles.parties, { direction: dir }]}>
            <Text>{party(fixture.seller)}</Text>
            <Text>{party(fixture.buyer)}</Text>
          </View>

          <View style={[styles.row, { direction: dir }]}>
            <Text style={styles.description}>{label.desc}</Text>
            <Text style={styles.figure}>{label.qty}</Text>
            <Text style={styles.figure}>{label.price}</Text>
            <Text style={styles.figure}>{label.amt}</Text>
          </View>

          {fixture.lines.map((line, index) => (
            <View key={String(index)} style={[styles.row, { direction: dir }]}>
              <Text style={styles.description}>{rtl ? line.descriptionAr : line.descriptionEn}</Text>
              <Text style={styles.figure}>{line.quantity}</Text>
              <Text style={styles.figure}>{line.unitPrice}</Text>
              <Text style={styles.figure}>{line.amount}</Text>
            </View>
          ))}

          <View style={[styles.totals, { direction: dir }]}>
            <Text style={styles.figure}>{fixture.subtotal}</Text>
            <Text style={styles.figure}>
              {`${rtl ? fixture.tax.labelAr : fixture.tax.labelEn}: ${fixture.tax.amount}`}
            </Text>
            <Text style={styles.figure}>{`${fixture.total} ${fixture.currency}`}</Text>
            <Text>{rtl ? fixture.notes.ar : fixture.notes.en}</Text>
          </View>
        </View>
      </Page>
    </Document>,
  );
}
```

- [ ] **Step 3: Write `render.ts` — six PDFs, one command**

`spikes/pdf-engine/render.ts` renders each candidate in `ltr` and `rtl` into `out/<candidate>-<dir>.pdf`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = join(import.meta.dir, "out");
mkdirSync(OUT, { recursive: true });
const fixturePath = join(import.meta.dir, "fixture/invoice.json");
const fixture = readFileSync(fixturePath, "utf8");

for (const dir of ["ltr", "rtl"] as const) {
  // A — Typst
  try {
    execFileSync("typst", [
      "compile", join(import.meta.dir, "candidates/typst/invoice.typ"),
      join(OUT, `typst-${dir}.pdf`),
      "--input", `fixture=${fixturePath}`, "--input", `dir=${dir}`,
    ], { stdio: "inherit" });
  } catch (cause) {
    console.error(`typst ${dir} failed:`, cause);
  }

  // B — Chromium print-to-PDF (the same engine Electron's webContents.printToPDF uses)
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const html = readFileSync(join(import.meta.dir, "candidates/chromium/invoice.html"), "utf8")
    .replace('<html>', `<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}">`)
    .replace('<script id="fixture" type="application/json"></script>',
             `<script id="fixture" type="application/json">${fixture}</script>`);
  await page.setContent(html, { waitUntil: "networkidle" });
  writeFileSync(join(OUT, `chromium-${dir}.pdf`), await page.pdf({ format: "A4", printBackground: true }));
  await browser.close();

  // C — @react-pdf/renderer. `renderInvoice(fixture, dir): Promise<Buffer>` is exported by
  // candidates/react-pdf/invoice.tsx above; the dynamic import keeps the font registration (a
  // module-level side effect) out of the process until this candidate actually runs.
  const { renderInvoice } = await import("./candidates/react-pdf/invoice");
  writeFileSync(join(OUT, `react-pdf-${dir}.pdf`), await renderInvoice(JSON.parse(fixture), dir));
}

console.log(`wrote six PDFs to ${OUT}`);
```

- [ ] **Step 4: Write `inspect.ts` — the four criteria, measured not eyeballed**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = join(import.meta.dir, "out");
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixture/invoice.json"), "utf8"));

/** The three strings that decide the verdict: a ligature, a mixed run, and a plain Arabic phrase. */
const PROBES = [fixture.seller.nameAr, fixture.lines[2].descriptionAr, fixture.tax.labelAr] as string[];

for (const file of readdirSync(OUT).filter((f) => f.endsWith(".pdf")).sort()) {
  const bytes = new Uint8Array(readFileSync(join(OUT, file)));
  const pdf = await getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const items = content.items as { str: string; transform: number[] }[];
  const text = items.map((i) => i.str).join(" ");

  const roundTrips = PROBES.filter((p) => text.includes(p)).length;
  const tofu = /[�?]{2,}/.test(text);
  const firstX = items.find((i) => i.str.trim() !== "")?.transform[4] ?? 0;
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);

  console.log(
    [
      file.padEnd(22),
      `text-round-trip ${roundTrips}/${PROBES.length}`,
      `tofu ${tofu ? "YES" : "no"}`,
      `first-item-x ${Math.round(Number(firstX))}`,
      `sha256 ${digest}`,
    ].join("  "),
  );
}
```

Reading the output: **text-round-trip 3/3** means the shaper emitted a `ToUnicode` map that restores the source string — the report is searchable and copy-pastable. **tofu YES** means missing glyphs. **first-item-x** near the page width on an `-rtl.pdf` and near zero on the matching `-ltr.pdf` is the bidi evidence. Running `render` twice and comparing `sha256` is the determinism criterion 5A's test 26 and 8B's test 29 depend on.

- [ ] **Step 5: Run the spike and look at the six PDFs**

```bash
bun run --cwd spikes/pdf-engine render && bun run --cwd spikes/pdf-engine inspect
bun run --cwd spikes/pdf-engine render && bun run --cwd spikes/pdf-engine inspect   # twice, for determinism
```

Expected: a table of six rows. **Then open all six** — the machine cannot see a broken ligature that still round-trips. Check, on each `-rtl.pdf`: the heading is on the right; the description column starts on the right and the amount column ends on the left; `المثال` shows a joined lam-alef, not two isolated letters; `XR-9` reads left-to-right inside the Arabic sentence; digits are consistent within a column.

- [ ] **Step 6: Write ADR 0016 — the artefact 2C and 7A consume**

`docs/adr/0016-pdf-engine.md`:

```markdown
# 0016 — PDF engine for documents and reports

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0E
**Spec:** §3.2.2 PDF row (spec:1132) — "Decide in week one — Typst or a shaping-aware library. ⚠️ Largest
technical risk in reporting: Arabic RTL glyph shaping. Prove it with a real tax invoice before Phase 6";
§0.2 (spec:93) puts this in *agent verifies and records an ADR — do not stop*.
**Consumed by:** 2C (`app.print_template.engine`, contracts §4.5.9, migration 0026), 7A
(`renderReport` adapters, contracts §4.11.2), 8D (payslips and annual statements). **Never re-opened**
(contracts §5 hazard 30).

## Criteria
1. **Shaping** — contextual forms and the lam-alef ligature render correctly.
2. **Bidi** — a mixed Arabic/Latin/digit run orders correctly inside an RTL paragraph.
3. **Text layer** — the source string round-trips out of the PDF (searchable, copy-pastable, auditable).
4. **Determinism** — two renders of one input are byte-identical (tests 26 and 29 depend on this).
5. **Operable** — runs headless in the container image, and in the Electron main process for
   single-document printing (D18: Windows drivers, no hardware code).

## Verdict table
_(filled from `bun run --cwd spikes/pdf-engine inspect`, with the six PDFs attached to the PR)_

| Candidate | `engine` code | 1 Shaping | 2 Bidi | 3 Text layer | 4 Determinism | 5 Operable | Verdict |
|---|---|---|---|---|---|---|---|
| Typst | `typst` | | | | | | |
| Chromium print-to-PDF | `chromium` | | | | | | |
| `@react-pdf/renderer` | `react-pdf` | | | | | | |

## Decision
The **chosen engine** is the first row marked `pass` on all five criteria; it is the default for every
`print_template` and every `report_run`.

**The closed value set of `app.print_template.engine` (contracts §4.5.9) is exactly the set of codes
this table marks `pass`.** 2C's migration 0026 writes that CHECK from this table and adds nothing to it;
7A ships one `renderReport` adapter per code in it.

If **no** candidate passes all five, that is a finding, not a decision: raise it to the owner with the
six PDFs before Phase 2 begins — 2C cannot ship templates without this ADR.

## Consequences
- 2C, 7A and 8D consume the engine code; none of them re-evaluates engines.
- The spike stays at `spikes/pdf-engine/` as this ADR's evidence and is re-runnable when a candidate
  releases a new version.
- No LHDN or MyInvois field appears in the fixture; e-invoicing formats arrive with 5B's ADR 0051.
```

- [ ] **Step 7: Commit**

```bash
git add spikes/pdf-engine docs/adr/0016-pdf-engine.md
git commit -m "docs(adr): 0016 PDF engine decided on a bilingual tax invoice [0E T14]

Six PDFs, three candidates, both directions, five criteria. The verdict table is the
closed value set of app.print_template.engine that 2C and 7A consume.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Phase 0 exit — run the binding gate, rewrite `CLAUDE.md`

0E is the last Phase 0 slice in execution order (contracts §2.1: 0B → 0D → 0C → 0E), so §3.8 puts the "Current phase" rewrite here, and spec:2327 puts the phase gate here too.

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/review/2026-09-05-phase-0-exit.md`

**Interfaces:**
- Consumes: every Phase 0 slice's CI status. **Produces:** the written Phase 0 report spec:110 requires ("Report per phase, in writing, against the definition of done — what passes, what does not, what you decided under ADR, what you are asking. Short.").

- [ ] **Step 1: Run the binding exit gate**

Contracts §2.1 states it as the union of spec:2327 with the Done-when cells of 0.6 and 0.7: **every §5.0 row green, tests 11, 12, 13, 14 and 27 passing in CI, and the catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36 passing against the Phase 0 catalogue.**

```bash
bun run lint && bun run format:check && bun run typecheck && bun run lint:rules && bun run test && bun run e2e
```

Expected: green. Then confirm each named test by file:

| Test | File | Owner |
|---|---|---|
| 11 No auth bypass | `tests/invariants/auth-bypass.test.ts` | 0B |
| 12 Tenant isolation | `tests/invariants/tenant-isolation.test.ts` | 0B |
| 13 Audit completeness | `packages/db/test/audit.test.ts` + the chain-walk job | 0B, 0D |
| 14 Permission query | `packages/db/test/tenant-isolation.test.ts` against the seeded catalogue | 0D |
| 23 RTL/LTR parity | `tests/e2e/rtl-parity.spec.ts` | **0E** |
| 27 No SQL text across the API | `tests/invariants/lint-rules.test.ts` + `bun run lint:rules` | 0B |
| 36 (the five Phase 0 clauses) | `packages/db/test/permission-catalogue.test.ts`, `scripts/lint/rules/role-seed.ts` | 0D |

- [ ] **Step 2: Write the phase report**

`docs/review/2026-09-05-phase-0-exit.md`:

```markdown
# Phase 0 exit report (spec:110)

**Date:** _(the run date)_ · **Slices:** 0A, 0B, 0D, 0C, 0E

## Against the definition of done
| §5.0 row | Owner | State | Evidence |
|---|---|---|---|
| 0.1 scaffold | 0A | | |
| 0.2 Supabase | 0C | | ⚠️ OD-19 |
| 0.3 migration tooling | 0A | | |
| 0.4 schema linter | 0A | | |
| 0.5 Cloudflare skeleton | 0C | | ⚠️ OD-20 |
| 0.6 auth + withTenant | 0B | | |
| 0.7 RBAC + catalogue | 0D | | ⚠️ OD-04 |
| 0.7b bootstrap seed | 0C | | ⚠️ OD-21 |
| 0.8 audit log | 0A | | |
| 0.9 Money + rates | 0D | | |
| 0.10 dimensions + custom fields | 0D | | |
| 0.11 pg-boss | 0D | | |
| **0.12 i18n/RTL shell** | **0E** | | `tests/e2e/rtl-parity.spec.ts`, `tests/regression/legacy-085.test.ts` |
| **0.13 Electron shell** | **0E** | | `apps/desktop/test/*.spec.ts`, `docs/runbooks/clean-vm-install.md`; ⚠️ OD-18 |
| 0.14 observability | 0C | | ⚠️ OD-22 |
| 0.15 ADRs + CONTRIBUTING + PR template | 0A | | |

## Acceptance tests in CI
11 · 12 · 13 · 14 · **23** · 27 · 36 (the five Phase 0 clauses) — pass/fail per run.

## Decided under ADR in this phase
0003–0006 (0B) · 0007–0010 (0D) · 0011–0015 (0C) · **0016 PDF engine, 0017 electron-builder/Bun/ABI,
0018 i18n catalogue format, 0019 context-bridge surface (proposal — awaiting approval)** (0E).

## What we are asking
OD-04, OD-18, OD-19, OD-20, OD-21, OD-22, OD-24 — each isolated in one task; none blocks a merge.
ADR 0019 needs the owner's approval before it moves from *proposed* to *accepted*.
```

- [ ] **Step 3: Rewrite `CLAUDE.md`'s "Current phase" section (§3.8)**

Replace the section 0B left in place with:

```markdown
## Current phase
**Phase 0 — Foundations: complete.** All five slices are merged and green — 0A (monorepo, migration
0001, schema linter, CI), 0B (identity, `withTenant`, errors, idempotency, permission catalogue, the
root `tests/` tree), 0D (`Money`, currency and rates, dimensions and custom fields, pg-boss, catalogue
lints, seeded roles), 0C (Supabase, Cloudflare Containers, bootstrap seed, observability) and 0E
(i18n/RTL shell, `packages/ui`, `apps/backoffice`, the Electron desktop shell, PDF engine).
The exit gate is recorded in `docs/review/2026-09-05-phase-0-exit.md`: every §5.0 row green, and
acceptance tests 11, 12, 13, 14, 23, 27 plus the Phase 0 clauses of 36 passing in CI.

**Next: Phase 1 — the ledger.** Plan 1A
(`docs/superpowers/plans/2026-09-05-dulja-phase-1a-posting-service.md`) then Plan 1B
(`…-phase-1b-projections-integrity-reports.md`). Phase 1 begins only now, because spec:87 says a phase
begins when the previous phase's definition of done passes in CI.
Every plan for every phase is already written; the catalogue and the frozen cross-plan contracts are in
`docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`. Read that document before any plan.

**Owner items still open** (contracts §2.12): OD-04, OD-18, OD-19, OD-20, OD-21, OD-22, OD-24. Each is
one isolated task in its slice; none blocks Phase 1.
```

- [ ] **Step 4: Verify the phase-gate claim before making it**

```bash
grep -c "Phase 0 — Foundations: complete" CLAUDE.md
bun run lint && bun run format:check && bun run typecheck && bun run lint:rules && bun run test && bun run e2e
```

Expected: `1`, and every command green. **If any is red, the section is not written** — the claim in `CLAUDE.md` is the gate Phase 1 reads, and a false one starts the ledger on a broken foundation (spec:87).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/review/2026-09-05-phase-0-exit.md
git commit -m "docs: Phase 0 exit report; CLAUDE.md current phase is now Phase 1 [0E T15]

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

Run against the spec and the contracts document with fresh eyes, per the writing-plans skill. Issues found are fixed inline above; what follows is the record.

### 1. Spec coverage

| Spec requirement | Task | Note |
|---|---|---|
| §3.2.2 frontend row (React 19, Vite, TanStack, RHF+Zod, Tailwind, shadcn/ui) | 4, 5 | shadcn/ui is the source of the primitives' shape; the four this slice needs are written out rather than pulled in wholesale, because every one had to lose its physical Tailwind classes |
| §3.2.2 i18n row (i18next + ICU; `Intl` with `islamic-umalqura`) | 1, 2 | |
| §3.2.2 PDF row (decide in week one, real Arabic tax invoice) | 14 | ADR 0016 |
| §3.2.2 desktop row (Electron + electron-builder, both apps) | 10–13 | `pos.exe` is 6B's; the shared main-process code is here |
| §3.7.1 two applications, one codebase | 4, 5 | `packages/ui` and `packages/i18n` are the shared halves 6B re-uses |
| §3.7.2 install experience, rendering consistency, auto-update, printing, security posture | 10–13 | printing is `window.dulja.print.toPdf` (Task 11), D18-compliant |
| §3.9 Localisation (spec:2061) | 1, 3 | both halves: catalogue completeness and the hard-coded-string check |
| §4.10 design system + tokens + Storybook | 4 | |
| §4.10 WCAG 2.2 AA — keyboard, focus, contrast, labels | 4, 8 | roving tabindex, one focus indicator in `tokens.css`, contrast ratios recorded per token, `aria-describedby` on every field |
| §4.10 RTL/LTR parity on every screen | 4, 8, 9 | test 23 |
| §4.10 keyboard-first data entry | 4, 8 | the OD-24 default model |
| §4.10 empty states | 4, 8 | `emptyLabel` is a required prop, not an option |
| §4.11 CI on every PR; environments; secrets | 3, 9, 11, 13 | `checks` gains e2e; a `desktop` job on `windows-latest`; a `release` workflow |
| §5.0 row 0.12 | 1–5, 8, 9 | |
| §5.0 row 0.13 | 10–13 | |
| §5.2 `apps/backoffice`, `apps/desktop`, `packages/ui`, `packages/i18n`, `tests/e2e` | 1, 4, 5, 9, 10 | all five directories created exactly where §5.2 puts them |
| §5.2 dependency rule; `desktop` imports build outputs only | 3, 10 | verified in the lint rule, expressed as a turbo edge |
| §5.3 "0.13" code-signing certificate | 13 | OD-18, isolated |
| §5.3 "Any UI work" screenshots | 7 | OD-24, isolated |
| Part VI test 23 | 9 | **owned** |
| Part VII #11 ("The UI … must be sourced separately") | 7 | the whole reason Task 7 exists and is a gate |
| LEGACY-085 | 3 | `tests/regression/legacy-085.test.ts` created |
| LEGACY-087 | 12 | appended, not edited (§3.7.3) |

**Gaps deliberately left, with where they close:** the PDF half of test 23 (2C for documents, 7A for reports, 8D for payslips — each re-runs test 23 per contracts §6.1); `apps/pos` and `pos.exe` (6B, which re-uses `packages/ui`, `packages/i18n` and the `apps/desktop` main-process code and adds `window.dulja.pos.*` per §4.10.6); every screen after the first (each slice with a screen task carries its own OD-24 gate, hazard 29).

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "similar to Task N", "add appropriate error handling", "etc." or elided content appears in any step. **Task 14's candidate C (`spikes/pdf-engine/candidates/react-pdf/invoice.tsx`) was one sentence of prose in an earlier draft while `render.ts` imported `renderInvoice` from it; it is now written out in full — font resolution, the `renderInvoice(fixture, dir): Promise<Buffer>` signature `render.ts` calls, and the four-column table in both directions.** Three places look like placeholders and are not:

- **ADR 0016's Verdict table and ADR 0017's "What was verified" table are empty on purpose.** They are filled by running the command the step above them gives (`bun run --cwd spikes/pdf-engine inspect`, `bun run --cwd apps/desktop dist`). Writing a verdict here would be inventing the result of a measurement the spec explicitly orders the agent to *take* (spec:93, 2323).
- **`docs/ui/od-24-users-and-roles.md`'s "Operator description" is `_(pending)_`.** That is the OD-24 gate's state, and the file states exactly what changes when it arrives.
- **`docs/review/2026-09-05-phase-0-exit.md`'s state column is blank.** It records the result of the run in Task 15 Step 1.

### 3. Type consistency

Checked every name used across task boundaries:

| Name | Defined | Used |
|---|---|---|
| `Locale`, `Dir`, `dirFor`, `LOCALES`, `isLocale`, `DEFAULT_LOCALE` | T1 | T2 (`FormatContext.locale`), T4 (`DirectionProvider`), T5 (`LocaleSwitcher`) |
| `createI18n`, `CATALOGUES`, `Catalogue`, `TranslationKey` | T1 | T3 (`checkCatalogues` default), T5 (`AppShell`), legacy-085 |
| `FormatContext`, `MoneyJson`, `formatDate`, `formatTimestamp` | T2 | T8 (the `createdAt` column uses `formatTimestamp`, because 0B returns a `timestamptz`, not a `date`) |
| `checkCatalogues`, `CatalogueViolation`, `CATALOGUE_RULES` | T3 | legacy-085 |
| `rule` (`no-hardcoded-string`) | T3 | `tests/invariants/lint-rules.test.ts`, `bun run lint:rules` |
| `PHYSICAL_PROPERTY_PATTERNS`, `tailwindPreset` | T4 | `packages/ui/test/logical-properties.test.ts`, `apps/backoffice/tailwind.config.ts` |
| `DirectionProvider`, `useDirection`, `DirectionValue` | T4 | T4 (`DataGrid`), T5 (`AppShell`) |
| `Column<T>`, `DataGridProps<T>` | T4 | T8 (`columns: Column<User>[]`) |
| `TextField` **with `forwardRef`** | T4, amended in T8 Step 4 | T8's `/` shortcut needs the ref; the amendment is stated where it is needed |
| `AppEnvVars`, `readEnv` | T5 | T6 (`createSupabase`), T8 (`useCompanyId`) |
| `ApiError`, `problemMessage`, `toApiError` | T5 | T8 (the refusal path) |
| `AdminApi`, `AdminApiOptions`, `createAdminApi` | T5 | T8 (`UsersRouteProps.api`) |
| `useShell` (`{ locale, setLocale, t }`) | T5 | T6 (both routes), T8 |
| `SessionStore`, `AuthBridge`, `pickSessionStore`, `electronSessionStore` | T6 | T11 (`DuljaAuthBridge` has the identical `get`/`set`/`remove` shape) |
| `SessionValue`, `useSession`, `useSupabase` | T6 | T8 (`accessToken`) |
| `UserList`, `RoleList`, `CompanyList`, `RoleAssignmentList` — **all four re-exported from 0B, none re-derived** (§4.2.8 register) — plus `User`, `Role`, `Company`, `RoleAssignment` | T8 (`admin-schemas.ts`) | T8 (`UsersRoute`) and T8 Step 5 (`useCompanyId`) — the single import surface for 0B's names |
| `language` (AppShell's applied-language state) | T5 Step 6 | T5 Step 6 itself — it drives `getFixedT` and `DirectionProvider`, and is what makes `shell.test.tsx`'s Arabic assertion and test 23 possible at all |
| The composition root — `readEnv()` + `pickSessionStore()` + `createSupabase()` + `SessionProvider` | T6 Step 7 (`main.tsx`) | every route: `LoginRoute`, `MfaEnrolRoute` (T6) and `UsersScreen` (T8 Step 5) call `useSession` / `useSupabase`, which throw outside the provider |
| `bootLocalStack`, `LocalStack` | T9 | `global-setup.ts`, and every later slice re-running test 23 |
| `APP_ORIGIN`, `isAppUrl`, `browserWindowOptions`, `CONTENT_SECURITY_POLICY` | T10 | T10 tests, `src/main.ts` |
| `DuljaBridge`, `CHANNELS`, `UpdateStatus` | T11 | `preload.ts`, `main.ts`, T12 (`checkForUpdates` returns `UpdateStatus`) |
| `SecureStore`, `createSecureStore`, `EncryptionUnavailableError` | T11 | `main.ts`, `secure-store.test.ts` |
| `configureUpdater`, `checkForUpdates`, `initSentry` | T12 | `main.ts` |

Twelve mismatches were found and fixed inline.

1. `AuthBridge` (T6, `session-storage.ts`) and `DuljaAuthBridge` (T11) now carry the identical three-method shape, so the Electron adapter satisfies the renderer's interface structurally with no adapter layer.
2. `TextField` was a plain function component, which the `/`-focus shortcut of T8 cannot use — T8 Step 4 states the `forwardRef` amendment at the point of need.
3. **0B's plan landed on disk while this one was being written**, so every name taken from it was re-read out of it rather than inferred. Three corrections followed: `LintRule` / `LintViolation` / `SourceFile` are imported from `scripts/lint/types.ts`, not `run.ts` (T3); the list wrappers already exist in `packages/contracts` and are **re-exported**, not re-derived (T8); and 0B's `UserSchema` is `{ id, displayName, email (nullable), kind, createdAt, activeAssignments }`, so T8's grid reads those fields — `Status` is derived from `activeAssignments === 0` (0B's own "expired out of the tenant"), and `Invited on` formats `createdAt` with **`formatTimestamp`**, not `formatDate`, because it is a `timestamptz`.
4. **`seedTenant` creates no role and no `role_assignment`** (plan0A:1573–1600), so the e2e principal held no permission and every admin route would have answered 403. T9's `bootLocalStack` now calls `grantAdminRole`, which inserts a non-`pos_terminal` role with the five Phase 0 `admin.*` codes and assigns it **as the system principal** — the two triggers that would otherwise refuse it are `app.forbid_self_grant` (plan0A:1404) and `app.assert_assignment_kind` (plan0A:1421), and the code is written to satisfy both.
5. T9's date assertion pinned the literal `2026`, but `createdAt` is `now()` at seed time; it now matches `/20\d\d/`.

An independent audit against the contracts document, Plan 0A and the spec found seven more, fixed in the same way.

6. **Nothing mounted the session.** `main.tsx` was `StrictMode > QueryClientProvider > RouterProvider`, so `createSupabase` was never called and `SessionProvider` never rendered: every route threw `useSession must be used inside <SessionProvider>`, and test 23 could not run at all. **T6 Step 7** is now the composition root, and states the invariant "`createSupabase` is called exactly once, here".
7. **`AppShell`'s locale switch changed `dir` but not the strings.** `changeLanguage` is async and fires no React update, so the shell committed English text and never re-rendered. **T5 Step 6** now records the applied language in state and derives `t` from `i18n.getFixedT(language)`, with `DirectionProvider` driven by the same value so direction and strings flip in one commit.
8. **`users.test.tsx` rendered `UsersRoute` — which calls `useQuery` twice — with no `QueryClientProvider`.** `renderScreen` now wraps a fresh `QueryClient` (retries off) per test.
9. **Four assertions could not pass as written**, each verified against the code in the step that produces the value: the Arabic-Indic digit test asserted a contiguous `١٢٣٤` where CLDR inserts U+066C (verified on Node 24.9.0: the output is `١٬٢٣٤`); the CSP test's negative lookahead saw `style-src`'s `unsafe-inline` and so never matched a correct policy (now asserted per directive); the DataGrid empty-state test counted one `row` where the implementation renders two (header + the `colSpan` empty cell); and the login keyboard test tabbed past the e-mail field, which `autoFocus` already owns (it now asserts that focus and drives from there, leaving the real tab order to the e2e spec, where it is meaningful).
10. **Two tests exercised nothing.** The problem-envelope test never activated a row, so the Assign button was `disabled` and no request was ever made; and the `legacy-087` append pointed at the synchronous `{ path, text }[]` `walk` of `lint-rules.test.ts` while treating its members as path strings, which made the whole loop dead. Both now do what they claim, and the legacy-087 block asserts that it inspected at least one file before asserting it found nothing.
11. **The e2e stack is cross-origin and nothing served CORS.** §4.2.3's middleware chain has no CORS entry — correctly, since production serves the app from the API's origin — so the harness supplies it: `cors()` on the auth stub, and a thin Hono front in `boot.ts` that answers the preflight and delegates to `createApp`'s own `fetch`, exposing `x-request-id` for `toApiError`.
12. **`grantAdminRole` was declared without `export`** though contracts §4.17.1 registers it as the fixture later UI slices re-use; it is exported now. In the same block, `role_assignment` and `role_permission` deliberately carry **no `id`** — plan0A:1331 marks `role_assignment` "a join table (no id/created_at — linter rule)" and plan0A:1322 gives `role_permission` a `(role_id, permission_code)` primary key — so only `role`'s id is pre-generated, and the comment now says so.

Two more arrived as handoffs from neighbouring slices, which read this plan as a dependency.

13. **The date style was a default, not a policy** (raised by 7A). `formatDate` defaulted to `dateStyle: "medium"` and said nothing about it, while 7A's pure-test `intlFormatters` builds its own `Intl.DateTimeFormat` from `{ day: "2-digit", month: "short", year: "numeric" }`. The two agree from the 10th of the month onward and disagree before it — `Jan 5, 2026` against `Jan 05, 2026`, verified on Node 24.9.0 — so a single date could print two ways depending on which path rendered it. Since §4 gives the calendar and numeral policy to this package's `FormatContext`, the day format belongs here too: **T2 Step 3**'s doc comment now states the house rule (always one of `Intl`'s three `dateStyle` values, never hand-assembled component options) and **T2 Step 1** pins it with an exact-output test on a single-digit day, so any slice building its own formatter has something to match rather than a convention to guess. 7A's own test-only formatter is the side that moves; it is reported to 7A, not edited here.
14. **`@dulja/ui`'s export list had no stated boundary** (raised by 1B). 1B writes `PageHeader`, `Modal` and `ReportTable` inside `apps/backoffice/src/components/` because `@dulja/ui` exports no equivalent, and asked whether they should be primitives instead. They should not, and the paragraph now gives the accurate reason per component rather than one blanket claim: `ReportTable` imports `useShell` from the application shell (1b:3886), which §3.1's "imports `@dulja/i18n` only" forbids outright, while `PageHeader` and `Modal` import nothing illegal and are held out on cost instead — a `@dulja/ui` export has to carry a story in both directions and an RTL test in `packages/ui/test/`, and neither a `<header>` with a title slot nor a native `<dialog>` (whose focus trap is the platform's) has behaviour worth that budget in Phase 0. Nothing changes in the code — this plan's `packages/ui/src/index.ts` never named either component — but **T4's Interfaces block** now says the list is closed for Phase 0, that composites live in the application, and what promoting one would actually cost (a §4 amendment plus a story and an RTL test in this slice's own files), so the next reader does not re-open it.

### 4. Contract additions — names this plan had to define because the contracts document lacks them

Every one is reported for the roadmap; none contradicts a frozen name.

| Addition | Where | Why the registry lacks it |
|---|---|---|
| `@dulja/i18n` public surface — `Locale`, `Dir`, `LOCALES`, `DEFAULT_LOCALE`, `dirFor`, `isLocale`, `Catalogue`, `CATALOGUES`, `TranslationKey`, `createI18n`, `CreateI18nOptions` | T1 | §3.1 names the package and its tier; §4 registers no member |
| `@dulja/i18n` formatters — `CalendarSystem`, `NumberingSystem`, `FormatContext`, **`MoneyJson`**, `localeTag`, `formatDate`, `formatTimestamp`, `formatNumber`, `formatQuantity`, `formatMoney` | T2 | `MoneyJson` is the §4.2.8 `MoneySchema` wire shape given a TypeScript name, because §3.1 forbids `@dulja/i18n` importing `@dulja/domain` |
| `checkCatalogues`, `CatalogueViolation`, `CATALOGUE_RULES` and the six rule names | T3 | spec:2061 requires the check; no section names it |
| `scripts/lint/rules/no-hardcoded-string.ts` (rule name `no-hardcoded-string`) | T3 | §3.7.5's rule table has no 0E row |
| `@dulja/ui` public surface — `DirectionProvider`, `DirectionProviderProps`, `useDirection`, `DirectionValue`, `Button`, `TextField`, `Select`, `SelectOption`, `DataGrid`, `Column`, `DataGridProps`, `tailwindPreset`, `PHYSICAL_PROPERTY_PATTERNS`, `src/tokens.css` | T4 | §3.1 names the package and its tier; §4 registers no member |
| `apps/backoffice` surface — `readEnv`, `AppEnvVars`, `ApiError`, `toApiError`, `problemMessage`, `createAdminApi`, `AdminApi`, `AdminApiOptions`, `AppShell`, `useShell`, `LocaleSwitcher`, `SessionStore`, `AuthBridge`, `browserSessionStore`, `electronSessionStore`, `pickSessionStore`, `createSupabase`, `SessionProvider`, `useSession`, `useSupabase`, `useCompanyId`, `LoginRoute`, `MfaEnrolRoute`, `UsersRoute`, `UsersRouteProps` | T5, T6, T8 | §4 registers no front-end interface |
| **`window.dulja.auth` / `window.dulja.app` / `window.dulja.print`**, `DuljaBridge`, `DuljaAuthBridge`, `DuljaAppBridge`, `DuljaPrintBridge`, `UpdateStatus`, `CHANNELS` (six channel literals) | T11 | §4.10.6 freezes only `window.dulja.pos.*`; the root namespace is shared and this slice occupies three more |
| `APP_SCHEME` = `"dulja"`, `APP_ORIGIN` = `"dulja://app"`, `CONTENT_SECURITY_POLICY`, `browserWindowOptions`, `isAppUrl` | T10 | spec:1284 states the posture in prose; no section gives it a shape |
| `SecureStore`, `Crypto`, `createSecureStore`, `EncryptionUnavailableError` | T11 | |
| `configureUpdater`, `checkForUpdates`, `initSentry` | T12 | |
| `bootLocalStack`, `LocalStack`, `AuthStub`, `startAuthStub`, `WEB_ORIGIN`, `grantAdminRole` (`tests/e2e/support/`) | T9 | §3.7.1 names the `tests/e2e` directory only; `grantAdminRole` exists because §4.17's `seedTenant` deliberately seeds no role, and it is **not** a `fixtures.ts` helper — it lives in the e2e support tree, so §4.17 is untouched |
| Environment names **`VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SENTRY_DSN`, `VITE_APP_ENV`, `DULJA_UPDATE_FEED`** | T5, T12 | §3.11 has no renderer row. The anon key is **publishable**, unlike `SUPABASE_SERVICE_ROLE_KEY`, which §3.11 confines to the seed CLI and which never appears in this slice |
| ADR numbers **0018** (i18n catalogue format) and **0019** (context-bridge surface, a proposal) | T1, T11 | §3.9 allocates 0016–0020 to 0E and names only 0016 and 0017 |
| `spikes/pdf-engine/` — a directory outside every `workspaces` glob | T14 | §3.1's "additional directories" list has no spike home |
| `docs/ui/od-24-<screen>.md` — the OD-24 material's filename convention | T7 | §2.12 names the gate, not where its answer lands |
| `docs/runbooks/clean-vm-install.md` | T13 | §3.1 names `docs/runbooks/` for the restore drill and cut-over only |
| `.github/workflows/ci.yml` job **`desktop`** on `windows-latest`, and `.github/workflows/release.yml` | T11, T13 | Plan 0A's CI has one `ubuntu-latest` job; `safeStorage`, NSIS and the Electron ABI are Windows facts |

### 5. Hazards re-checked (contracts §5)

2 (no invented MyInvois detail) — the spike fixture is generic, asserted in T14's hazard note. 5 (owner-account tasks) — T9, T12 and T13 each carry the "owner provides X; verify with `<command>`; until provided …" form. 6 (one isolated task per OD item) — OD-18 is T13, OD-24 is T7; OD-20 and OD-22 belong to 0C and are consumed here with a stated local equivalent, not re-gated. 8 (Plan 0A names) — `startDb`, `seedTenant`, `Seed`, `uuidv7`, the test `withTenant` are cited exactly; none is renamed. 9 (`fixtures.ts` additive) — **this plan does not touch `packages/db/test/fixtures.ts` at all**; §4.17 assigns 0E no helper. 13 (`lint-schema.ts` hotspot) — untouched; 0E creates no table. 14 (migration numbers) — 0010 reserved and unused; no migration written. 29 (UI unspecified) — T7. 30 (PDF engine once, in 0E) — T14. 32 (no literal in a shared namespace) — 0E writes into none of the five.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-0e-desktop-i18n-shell.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**

### Order and dependencies inside this slice

Tasks 1 → 6 and 8 → 15 are strictly sequential. **Task 7 (OD-24) must be requested before Task 5 begins**, because its answer lands during Tasks 5–6 and is consumed by Task 8; it is placed at 7 so that the request is made early and the screen is built once. **Task 14 (the PDF spike) has no dependency on any other task in this plan** and spec:1132 says "decide in week one" — start it in parallel with Task 1 if a second worker is available.

Tasks 12 and 13 consume 0C's staging deployment, R2 update feed and Sentry DSN. If 0C is not yet merged, execute them against the stated local equivalents (a static feed from `apps/desktop/dist-installer/`, an empty DSN) and re-run the two verify commands after 0C lands.

### The next slice in dependency order

**Phase 0 exits with Task 15.** The next plan is **1A — Posting service, JOURNAL, numbering, `account_balance`, chart of accounts, periods**, at `docs/superpowers/plans/2026-09-05-dulja-phase-1a-posting-service.md` (contracts §6.4). It begins **only** when Task 15's gate is green in CI: every §5.0 row, and acceptance tests 11, 12, 13, 14, 23, 27 plus the Phase 0 clauses of test 36 (spec:87, spec:2327).

What 1A and its successors inherit from this slice:

| Consumer | Inherits |
|---|---|
| **1A, 1B** | `packages/ui` and `packages/i18n` for the chart-of-accounts, journal-entry and fiscal-period screens; the OD-24 gate pattern of Task 7; the test-23 harness `bootLocalStack` for their own both-directions check |
| **2C** | **ADR 0016** — the closed value set of `app.print_template.engine` (§4.5.9), and the `window.dulja.print.toPdf` bridge for single-document printing |
| **6B** | the whole `apps/desktop` main process, preload and electron-builder configuration; it adds `window.dulja.pos.*` (§4.10.6) to `DuljaBridge` additively and reuses ADR 0017's native-module path for `better-sqlite3`; its `pos.exe` signing job references the same two §3.11 secret names as Task 13 |
| **7A** | **ADR 0016** — one `renderReport` adapter per passing engine code (§4.11.2) |
| **8D** | ADR 0016 for payslips and annual statements |
| **every slice with a screen** | `packages/ui`, `packages/i18n`, the `no-hardcoded-string` rule, and the obligation to re-run test 23 (contracts §6.1) |
