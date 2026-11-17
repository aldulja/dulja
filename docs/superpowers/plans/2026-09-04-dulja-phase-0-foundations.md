# Dulja Phase 0 — Plan 0A: Repository Foundation and Database Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Dulja monorepo and deliver migration `0001_foundations` — tenancy, identity, RLS, RBAC tables, the immutable ledger core and the hash-chained audit log — proven correct by tests that run against a real PostgreSQL 18 in Testcontainers, including regression tests for the two v1.1 RLS defects.

**Architecture:** Bun workspaces + Turborepo monorepo. `packages/db` owns the SQL migrations, a small forward/back migration runner, a CI schema linter, and the Testcontainers test harness. Every test connects as the real application roles (`app_migrator`, `app_rw`), never as the superuser, so `FORCE ROW LEVEL SECURITY` is exercised exactly as production will exercise it. No API, UI, cloud or desktop code in this plan — those are Plans 0B and 0C (see roadmap below).

**Tech Stack:** Bun 1.4 (install, scripts, build) · Node 24 LTS (runs Vitest) · TypeScript strict · Turborepo · oxlint + oxfmt · PostgreSQL 18 (`postgres:18` image) · `postgres` (postgres.js) · `@testcontainers/postgresql` · Vitest · GitHub Actions.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 (moved there in Task 1; currently `rebuild-spec.md` at the project root). Sections this plan implements: §3.8 (reference schema, all of it), §3.9 (conventions), §5.0 tasks 0.1, 0.3, 0.4, 0.7 (tables + query), 0.8, 0.15, and the local-development half of 0.2. Companion: `docs/spec/legacy-system-analysis.md`.

## Global Constraints

Copied from the spec; every task's requirements include these.

- **Never** write to a ledger or movement table outside the posting service (§0.2). In this plan nothing writes to `ledger_entry` except tests proving the constraints.
- **Never** represent money as a float, anywhere (§0.2, D11). SQL money columns are `numeric(19,4)`; quantities `numeric(19,6)`.
- **Never** build SQL by string concatenation (§0.2). Tests use postgres.js tagged templates; the only `sql.unsafe` is the migration runner executing a whole migration file, which contains no user input.
- **Never** issue DDL from application code (§0.2, LEGACY-053). DDL lives only in `packages/db/migrations/*.sql`.
- **Never** hard-code a package version into a source file (D22). `bun add` latest; the lockfile owns versions; Renovate later.
- **Always**, for every new table: `tenant_id`, an RLS policy, `FORCE ROW LEVEL SECURITY`, `created_at`, a migration, a test that a second tenant cannot see it (§0.2). Exceptions are exactly the global tables named in §3.8: `tenant`, `principal`, `permission`.
- **Identifiers:** `uuidv7()` server-side (§3.9). **Time:** `timestamptz` in UTC; `effective_date` is a `date` (§3.9). **Naming:** `snake_case`, singular table names (§3.9).
- **Roles (§3.8, task 0.2):** `app_migrator` (schema owner, subject to FORCE RLS), `app_rw` (API; no `BYPASSRLS`; no UPDATE/DELETE on immutable tables), `app_auth` (`NOLOGIN`, no attributes; owns only `resolve_principal`; reads `principal`/`membership` through policies scoped `to app_auth`). Connections use session mode / direct (5432), never transaction-mode pooling.
- **Transactions (§3.8):** every database access runs inside a transaction that first issues `set_config('app.tenant_id', …, true)` and `set_config('app.actor_id', …, true)`, at READ COMMITTED.
- **Migrations (§3.9):** `NNNN_<verb>_<noun>.sql` with a hand-written `NNNN.down.sql`; CI applies up, down, up. Production is forward-only.
- **Tests (§3.9):** `tests/invariants/` for ledger and tenant isolation; `tests/regression/legacy-NNN.test.ts` per Part I defect touched. In this plan the db-level invariants live in `packages/db/test/` and are wired into the root `test` pipeline; the `tests/` tree at the repo root is created in Plan 0B when there is API code to exercise.
- **Commits:** conventional commits, small PRs (§4.11). Every commit message in this plan ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Phase 0 roadmap — how the sixteen §5.0 tasks split into three plans

Phase 0 mixes three independently testable subsystems and two of them block on accounts only the owner can create. Each plan produces working, tested software on its own. The rest of Phase 0 is now split four ways — **0B** (API core I), **0D** (API core II), **0C** (cloud) and **0E** (desktop/i18n shell) — and every later phase is sliced the same way; the catalogue, the frozen shared names and the migration-number ranges live in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`, which every later plan is written against.

| Spec task | Plan | Notes |
|---|---|---|
| 0.1 Monorepo + CI | **0A** (this) | Tasks 2, 12 |
| 0.2 Provision Supabase | 0A (local equivalent) + **0C** (real) | `provision/roles.sql` is written and tested here against Testcontainers; running it on Supabase is 0C and needs the owner's Supabase org |
| 0.3 Migration tooling + `0001_foundations` | **0A** | Tasks 4–10 |
| 0.4 CI schema linter | **0A** | Task 11 |
| 0.5 Cloudflare Container skeleton | **0C** | Needs the owner's Cloudflare account |
| 0.6 Supabase Auth + `withTenant` | **0B** | Hono API; the SQL side (`resolve_principal`) is proven here in Task 5. **0B constraint:** a human principal is created only from a `sub` the API obtained via the Supabase admin invite call, never from a client-supplied subject — otherwise one tenant could pre-register another tenant's user (spec §3.8 `principal_insert` comment) |
| 0.7 RBAC tables + permission catalogue + query | **0A** (tables, `actor_has`, branch scope, no-self-grant, query) + **0B** (catalogue file, build check) + **0C** (seeding the nine roles of spec §4.2.1) | Task 6 here |
| 0.7b Bootstrap seed CLI | **0C** | Runs against Supabase with the service-role key; its SQL sequence is proven here in Tasks 5 and 9 |
| 0.8 Audit log | **0A** | Task 9 |
| 0.9 Currency + `Money` | **0B** | `packages/domain` |
| 0.10 Dimensions + custom fields | **0A** (dimension tables) + **0B** (API, custom-field service) | Task 7 here |
| 0.11 pg-boss | **0B** | |
| 0.12 i18n / RTL shell | **0C** | Frontend |
| 0.13 Electron shell | **0C** | Needs the code-signing certificate |
| 0.14 Observability | **0C** | Needs Sentry org |
| 0.15 ADRs, CONTRIBUTING, PR template | **0A** | Tasks 1, 12 |

**Owner dependencies for this plan:** none beyond a Windows machine with **Docker Desktop (WSL2 backend)** for Testcontainers, Bun 1.4, Node 24 and git installed. Everything else in Phase 0 that needs the owner (§5.3) lands in 0C.

**Owner sign-offs required before Task 5 is merged (spec §5.3 "Before 0.2"):** the v1.1 changelog rows marked *Confirm* — the `principal` policy split and the `app_auth` role design. Task 5 implements both; if the owner rejects either, Task 5 changes, nothing else does. **Before Task 6:** the nine role names in spec §4.2.1 (v1.2 changelog #17) — Task 6 builds the tables the roles live in, not the roles themselves, so a rename later is a seed change only.

---

## File structure

Created by this plan, in order of appearance. One responsibility per file.

```
/                                   repo root (currently C:\Users\Edres101\Desktop\dulja)
├─ .gitignore
├─ .github/
│  ├─ workflows/ci.yml              lint · typecheck · db tests (Docker) on every PR
│  └─ pull_request_template.md      definition-of-done checklist from §4.11
├─ CLAUDE.md                        agent entry point: reading order, never/always lists, current phase
├─ CONTRIBUTING.md                  §0.2 and §3.9 verbatim
├─ package.json                     bun workspaces, root scripts
├─ turbo.json                       lint / typecheck / test pipelines
├─ tsconfig.base.json               strict TS shared by every package
├─ .oxlintrc.json                   lint rules (correctness + suspicious, no-console)
├─ docs/
│  ├─ spec/                         the two documents, moved here (§5.2)
│  ├─ review/                       2026-09-04-dulja-docs-review.md (already exists)
│  ├─ adr/0001-adopt-spec-v1-1.md   baseline decision
│  ├─ adr/0002-migration-runner.md  why a 60-line SQL runner instead of drizzle-kit migrate for hand-written SQL
│  └─ superpowers/plans/            this plan
└─ packages/db/
   ├─ package.json
   ├─ tsconfig.json
   ├─ vitest.config.ts
   ├─ provision/roles.sql           creates app_migrator, app_rw, app_auth — run once per database as an admin (task 0.2)
   ├─ migrations/
   │  ├─ 0001_foundations.sql       §3.8, grown across Tasks 5–10; every statement's purpose commented
   │  └─ 0001.down.sql              drops in reverse dependency order
   ├─ src/
   │  ├─ migrate.ts                 up(sql, dir) / down(sql, dir, toVersion); records in app_meta.schema_migration
   │  ├─ lint-schema.ts             the 0.4 linter: reads pg_catalog, returns violations
   │  └─ cli.ts                     `bun run db:migrate`, `db:rollback`, `db:lint` against DATABASE_URL_MIGRATOR
   └─ test/
      ├─ harness.ts                 startDb(): container + roles + migrations; connections per role; withTenant()
      ├─ roles.test.ts              Task 3 — roles exist with the right attributes
      ├─ migrate.test.ts            Task 4 — runner up/down/up against a temp migration dir
      ├─ identity.test.ts           Task 5 — v1.1 fixes #2 and #3 (bootstrap insert; resolve_principal)
      ├─ tenant-isolation.test.ts   Task 6 — two tenants; RBAC "who can do X" query
      ├─ documents.test.ts          Task 7 — uniqueness rules on series/number/client_ref
      ├─ ledger.test.ts             Task 8 — immutability, balance at commit, period lock
      ├─ audit.test.ts              Task 9 — actor from session, chain verifies, AFTER ROW self-reference
      ├─ privileges.test.ts         Task 10 — app_rw grants, up/down/up fingerprint
      └─ schema-lint.test.ts        Task 11 — a bare table is named in the violations
```

---

### Task 1: Repository baseline — git, docs in place, agent entry point, ADR-0001

**Files:**
- Create: `.gitignore`, `CLAUDE.md`, `docs/adr/0001-adopt-spec-v1-2.md`
- Move: `rebuild-spec.md` → `docs/spec/rebuild-spec.md`; `legacy-system-analysis.md` → `docs/spec/legacy-system-analysis.md`

**Interfaces:**
- Produces: the repository every later task commits into; `docs/spec/rebuild-spec.md` as the path every later file cites.

- [x] **Step 1: Initialise the repository and move the documents**

Run from `C:\Users\Edres101\Desktop\dulja`:

```bash
git init -b main
mkdir -p docs/spec docs/adr
git mv -k rebuild-spec.md docs/spec/rebuild-spec.md 2>/dev/null || mv rebuild-spec.md docs/spec/rebuild-spec.md
mv legacy-system-analysis.md docs/spec/legacy-system-analysis.md
```

Expected: `ls docs/spec` shows both files; the root has no `.md` besides those under `docs/`.

- [x] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
dist/
.turbo/
coverage/
*.log
.env
.env.*
!.env.example
.DS_Store
Thumbs.db
```

- [x] **Step 3: Write `CLAUDE.md`**

```markdown
# Dulja — agent entry point

Dulja is the accounting/ERP product replacing a legacy accounting system. You are implementing, not re-deciding.

## Read in this order, every session
1. `CONTRIBUTING.md` — the operating brief (§0.2) and engineering conventions (§3.9), verbatim.
2. `docs/spec/rebuild-spec.md` §0.3 (decision log) and §0.4 (glossary).
3. The spec sections for the **current phase** (below), then §5.0 for the task list.
4. `docs/adr/` — every decision taken since the spec.

## Current phase
**Phase 0 — Foundations.** Plan: `docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md` (Plan 0A).
Phase 0 exits only when every §5.0 row is green and acceptance tests 12, 13, 14 pass in CI.

## Never (spec §0.2)
- write to a ledger or movement table outside the posting service
- represent money as a float, anywhere, including in TypeScript
- build SQL by string concatenation
- issue DDL from application code
- disable an invariant, constraint or trigger "temporarily"
- gate an audit write on any flag
- hard-code a package version into a source file

## Always (spec §0.2)
- every new table: `tenant_id`, RLS policy, `FORCE ROW LEVEL SECURITY`, `created_at`, a migration, a second-tenant-cannot-see-it test
- every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, tenant-isolation test
- every UI screen: verified in both text directions before merge

## Working rules
- Tests run under Node 24 via Vitest (`bun run test`); Bun runs everything else.
- Unspecified and low-stakes → decide, write an ADR, proceed. Touches money, security, data model or sync → write the ADR as a proposal and ask.
- The owner's pending decisions are listed in `docs/spec/rebuild-spec.md` §5.3 ("Before 0.2") and in the v1.1 changelog rows marked *Confirm* / *Decide*.
```

- [x] **Step 4: Write ADR-0001**

`docs/adr/0001-adopt-spec-v1-2.md`:

```markdown
# ADR-0001 — Adopt rebuild-spec v1.2 as the implementation baseline

**Status:** accepted · **Date:** 2026-09-04

## Context
Two documents describe the product: `docs/spec/legacy-system-analysis.md` (what the legacy system is) and `docs/spec/rebuild-spec.md` (what Dulja is and how it is built). A review on 2026-09-04 (`docs/review/2026-09-04-dulja-docs-review.md`) corrected two blocking RLS defects and several inconsistencies and produced spec v1.1; a fourth pass on 2026-09-05 brought HR & Payroll into v1, added the nine-role catalogue and was adversarially verified (v1.2).

## Decision
Spec v1.2 is the baseline. Its §0.3 decision log (D1–D27) is binding. Any deviation is a new ADR in this directory, written as a proposal when it touches money semantics, security, the data model or the sync protocol, and approved by the owner before implementation.

## Consequences
- The two v1.1 rows marked *Confirm* (principal policy split; `app_auth` role) are implemented in Plan 0A Task 5 and need the owner's sign-off before that task merges.
- The row marked *Decide* (loyalty points in POS v1) must be resolved before Phase 6 planning.
- The v1.2 rows marked *Confirm* (the nine role names before task 0.7; the alias e-mail domain before Phase 6; the ⚠️ rows of §3.0.4 and §3.10.1 before Phases 4, 6 and 8) need sign-off before the tasks they name.
```

- [x] **Step 5: First commit**

```bash
git add -A
git commit -m "docs: adopt Dulja spec v1.2, dossier, review and ADR-0001 as baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: `git log --oneline` shows one commit; `git status` clean.

---

### Task 2: Monorepo scaffold — Bun workspaces, Turborepo, strict TypeScript, oxlint/oxfmt

**Files:**
- Create: `package.json`, `turbo.json`, `tsconfig.base.json`, `.oxlintrc.json`, `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/index.ts`

**Interfaces:**
- Produces: root scripts `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test` that every later task runs; the `@dulja/db` workspace package.

- [x] **Step 1: Root `package.json`**

```json
{
  "name": "dulja",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "lint": "oxlint .",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "build": "turbo run build"
  },
  "engines": { "bun": ">=1.4", "node": ">=24" },
  "packageManager": "bun@1.4.0"
}
```

`packageManager` is required by Turborepo 2 to detect the workspace tool. It pins the *toolchain*, like the lockfile does, not a library version — set it to whatever `bun --version` prints at scaffold time; Renovate keeps it current (D22).

- [x] **Step 2: Install the root toolchain (latest, pinned by the lockfile — D22)**

```bash
bun add -d typescript turbo oxlint oxfmt vitest
```

Expected: `bun.lock` created; `node_modules/.bin/oxlint`, `oxfmt`, `turbo`, `vitest`, `tsc` exist.

- [x] **Step 3: `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": { "dependsOn": ["^typecheck"] },
    "test": { "dependsOn": ["^build"], "cache": false },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] }
  }
}
```

`test` has `cache: false` because the db tests start a Docker container; caching them would hide schema regressions.

- [x] **Step 4: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

- [x] **Step 5: `.oxlintrc.json`**

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "error" },
  "rules": { "no-console": "error" },
  "overrides": [
    { "files": ["packages/*/src/cli.ts", "**/*.test.ts"], "rules": { "no-console": "off" } }
  ],
  "ignorePatterns": ["node_modules", "dist", ".turbo", "docs"]
}
```

`no-console` is the §3.9 logging rule ("a lint rule forbids console.log outside scripts"); the CLI and tests are the scripts.

- [x] **Step 6: `packages/db` package**

`packages/db/package.json`:

```json
{
  "name": "@dulja/db",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run",
    "db:migrate": "bun run src/cli.ts up",
    "db:rollback": "bun run src/cli.ts down",
    "db:lint": "bun run src/cli.ts lint"
  }
}
```

`test` invokes Vitest through `node` explicitly: the spec (§3.2.2, D5) runs the suite under Node 24 because Vitest on Bun is unofficial. Bun still installs and runs everything else.

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/db/src/index.ts`:

```ts
export { up, down, listApplied } from "./migrate";
export { lintSchema, type Violation } from "./lint-schema";
```

(Those modules arrive in Tasks 4 and 11; until then typecheck will fail on this file — so for this task, create `index.ts` with only a comment line `// populated by Tasks 4 and 11` and replace it in Task 4.)

- [x] **Step 7: Install db-package dependencies**

```bash
cd packages/db
bun add postgres
bun add -d @testcontainers/postgresql @types/node vitest
cd ../..
```

- [x] **Step 8: Prove the toolchain works and that a lint error fails it (task 0.1 acceptance)**

```bash
bun run lint && bun run format:check && bun run typecheck
```

Expected: all three exit 0 (there is almost nothing to check yet).

Now create `packages/db/src/bad.ts` containing `console.log("x")`, run `bun run lint`.
Expected: exit code non-zero, output names `bad.ts` and `no-console`. Delete `bad.ts`.

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Bun/Turborepo monorepo with strict TS, oxlint and oxfmt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Roles script and the Testcontainers harness

**Files:**
- Create: `packages/db/provision/roles.sql`, `packages/db/vitest.config.ts`, `packages/db/test/harness.ts`
- Test: `packages/db/test/roles.test.ts`

**Interfaces:**
- Produces (used by every later test file):
  - `startDb(opts?: { migrate?: boolean }): Promise<Db>` — starts `postgres:18`, runs `roles.sql` as the container superuser, sets passwords, opens one postgres.js client per role, and (unless `migrate: false`) applies `packages/db/migrations` as `app_migrator`.
  - `Db = { admin: Sql; migrator: Sql; rw: Sql; url(role): string; stop(): Promise<void> }` — `admin` is for catalog assertions and provisioning only; behaviour under test always goes through `migrator` or `rw`.
  - `withTenant(sql, tenantId, actorId, fn)` — one transaction, `set_config` first, mirrors the API helper of spec §3.8.
  - `uuidv7(sql): Promise<string>` — a server-generated id for tests.
  - `MIGRATIONS_DIR: string`, `ROLES_SQL: string`.

- [x] **Step 1: Write `packages/db/provision/roles.sql`**

This is spec task 0.2's role set. It is run once per database by an administrative role — the container superuser in tests, the `postgres` role on Supabase in Plan 0C. Passwords are never in this file.

```sql
-- Dulja application roles (spec §3.8 "Roles and connections", task 0.2). Idempotent; run as an admin role.
-- app_auth deliberately has NO BYPASSRLS: only a superuser may create a role with that attribute, and Supabase's
-- `postgres` role is not one. It reads principal/membership through policies scoped `to app_auth` (migration 0001).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_migrator') then
    create role app_migrator login nosuperuser nobypassrls nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw login nosuperuser nobypassrls nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    create role app_auth nologin nosuperuser nobypassrls nocreaterole noinherit;
  end if;
  -- app_migrator owns schema app; it needs CREATE on this database.
  execute format('grant create on database %I to app_migrator', current_database());
end $$;

alter role app_migrator set timezone = 'UTC';
alter role app_rw       set timezone = 'UTC';

-- PostgreSQL 16+: ALTER FUNCTION ... OWNER TO requires the ability to SET ROLE to the new owner.
-- INHERIT FALSE: app_migrator gains no privileges from app_auth, only the ability to hand it the function.
grant app_auth to app_migrator with inherit false;
```

- [x] **Step 2: Write `packages/db/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,      // the first container pull can be slow
    fileParallelism: false,    // one Postgres container at a time keeps Docker Desktop happy
  },
});
```

- [x] **Step 3: Write `packages/db/test/harness.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { up } from "../src/migrate";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");
export const ROLES_SQL = join(here, "..", "provision", "roles.sql");

export type Role = "app_migrator" | "app_rw";
const PASSWORDS: Record<Role, string> = { app_migrator: "migrator-test", app_rw: "rw-test" };

export interface Db {
  container: StartedPostgreSqlContainer;
  /** Container superuser. Provisioning and pg_catalog assertions ONLY — never for behaviour under test. */
  admin: Sql;
  /** app_migrator: runs migrations and the seed. Subject to FORCE RLS like every other role. */
  migrator: Sql;
  /** app_rw: the API role. No BYPASSRLS, no UPDATE/DELETE on immutable tables. */
  rw: Sql;
  url(role: Role): string;
  stop(): Promise<void>;
}

export interface StartOptions { migrate?: boolean }

const quiet = { onnotice: () => {} } as const;

export async function startDb(opts: StartOptions = {}): Promise<Db> {
  const container = await new PostgreSqlContainer("postgres:18").start();
  const admin = postgres(container.getConnectionUri(), { max: 2, ...quiet });
  await admin.unsafe(readFileSync(ROLES_SQL, "utf8"));
  // Utility statements cannot take bound parameters; these are constants from this file, not input.
  await admin.unsafe(`alter role app_migrator password '${PASSWORDS.app_migrator}'`);
  await admin.unsafe(`alter role app_rw password '${PASSWORDS.app_rw}'`);

  const url = (role: Role): string =>
    `postgres://${role}:${PASSWORDS[role]}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const migrator = postgres(url("app_migrator"), { max: 4, ...quiet });
  const rw = postgres(url("app_rw"), { max: 4, ...quiet });

  if (opts.migrate !== false) await up(migrator, MIGRATIONS_DIR);

  return {
    container, admin, migrator, rw, url,
    async stop() {
      await Promise.all([admin.end(), migrator.end(), rw.end()]);
      await container.stop();
    },
  };
}

/** Mirrors the API's withTenant() (spec §3.8): one transaction at READ COMMITTED, set_config before anything else. */
export async function withTenant<T>(
  sql: Sql, tenantId: string, actorId: string, fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_id', ${actorId}, true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

export async function uuidv7(sql: Sql): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select uuidv7()::text as id`;
  return row!.id;
}
```

- [x] **Step 4: Write the failing test `packages/db/test/roles.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES_SQL, startDb, type Db } from "./harness";

describe("provision/roles.sql — spec §3.8 roles, task 0.2 local equivalent", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb({ migrate: false }); });
  afterAll(async () => { await db.stop(); });

  it("creates exactly the three roles with the required attributes", async () => {
    const rows = await db.admin<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolname, rolcanlogin, rolbypassrls, rolsuper
        from pg_roles where rolname in ('app_migrator', 'app_rw', 'app_auth') order by rolname`;
    expect(rows).toEqual([
      { rolname: "app_auth",     rolcanlogin: false, rolbypassrls: false, rolsuper: false },
      { rolname: "app_migrator", rolcanlogin: true,  rolbypassrls: false, rolsuper: false },
      { rolname: "app_rw",       rolcanlogin: true,  rolbypassrls: false, rolsuper: false },
    ]);
  });

  it("app_rw and app_migrator sessions run in UTC", async () => {
    const [rw] = await db.rw<{ tz: string }[]>`select current_setting('timezone') as tz`;
    const [mig] = await db.migrator<{ tz: string }[]>`select current_setting('timezone') as tz`;
    expect(rw!.tz).toBe("UTC");
    expect(mig!.tz).toBe("UTC");
  });

  it("app_rw cannot assume app_auth; app_migrator can (needed to transfer function ownership)", async () => {
    await expect(db.rw`set role app_auth`).rejects.toThrow(/permission denied/);
    await db.migrator.begin(async (tx) => {
      await tx`set local role app_auth`;
      const [r] = await tx<{ u: string }[]>`select current_user as u`;
      expect(r!.u).toBe("app_auth");
    });
  });

  it("is idempotent", async () => {
    await expect(db.admin.unsafe(readFileSync(ROLES_SQL, "utf8"))).resolves.toBeDefined();
  });
});
```

- [x] **Step 5: Run it — expect a compile failure first, then green**

```bash
cd packages/db && bun run test
```

Expected on the first run: FAIL — `../src/migrate` does not exist yet (Task 4). Create a stub `packages/db/src/migrate.ts` containing only `export async function up(): Promise<number[]> { return []; }` so the harness compiles, re-run.
Expected: 4 passed. Docker must be running; the first run pulls `postgres:18`.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): application roles script and Testcontainers harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migration runner — forward-only up, hand-written down, ledger in `app_meta`

**Files:**
- Create: `packages/db/src/migrate.ts` (replaces the Task 3 stub), `packages/db/src/cli.ts`, `docs/adr/0002-migration-runner.md`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/migrate.test.ts`

**Interfaces:**
- Produces:
  - `discover(dir): Migration[]` where `Migration = { version: number; name: string; upPath: string; downPath: string }`; throws if a `NNNN_*.sql` has no `NNNN.down.sql`.
  - `up(sql, dir): Promise<number[]>` — applies each pending file in its own transaction, records `(version, name)` in `app_meta.schema_migration`, returns the versions applied.
  - `down(sql, dir, toVersion = 0): Promise<number[]>` — rolls back applied versions above `toVersion`, newest first.
  - `listApplied(sql): Promise<number[]>`.
- Consumes: `Sql` from postgres.js.

- [x] **Step 1: Write ADR-0002**

`docs/adr/0002-migration-runner.md`:

```markdown
# ADR-0002 — Apply SQL migrations with a 60-line runner; keep Drizzle Kit as the diff generator

**Status:** accepted · **Date:** 2026-09-04 · **Spec:** §3.2.2 "Migrations", §3.9 "Migrations"

## Context
The spec chooses Drizzle Kit for migrations with hand-written `down.sql` files. Migration 0001 is hand-written
PL/pgSQL from §3.8 (triggers, policies, a SECURITY DEFINER function). Drizzle Kit's applier needs its own journal
file and `--> statement-breakpoint` markers between statements, which adds friction to a file we author by hand
and review line by line.

## Decision
`packages/db/src/migrate.ts` applies `migrations/NNNN_<name>.sql` in version order, each in one transaction,
recording `(version, name, applied_at)` in `app_meta.schema_migration`. `down(toVersion)` applies the matching
`NNNN.down.sql`. Drizzle Kit stays in the toolchain for `drizzle-kit generate` schema diffs from Phase 1 onward;
its output is committed as a numbered file and applied by this runner after human review, as §3.9 requires.

## Consequences
- One monotonic schema version (`max(version)`) — the answer the old system never had (LEGACY-080).
- CI's up → down → up test (Task 10) is the "reversible" definition of §3.9.
- Production remains forward-only; `down` exists for CI and local development.
```

- [x] **Step 2: Write the failing test `packages/db/test/migrate.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, down, listApplied, up } from "../src/migrate";
import { startDb, type Db } from "./harness";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dulja-mig-"));
  writeFileSync(join(dir, "0001_create_smoke.sql"),
    "create schema smoke;\ncreate table smoke.t (id int primary key);\n");
  writeFileSync(join(dir, "0001.down.sql"), "drop schema smoke cascade;\n");
  writeFileSync(join(dir, "0002_add_name.sql"),
    "alter table smoke.t add column name text not null default '';\n");
  writeFileSync(join(dir, "0002.down.sql"), "alter table smoke.t drop column name;\n");
  return dir;
}

describe("migration runner", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb({ migrate: false }); });
  afterAll(async () => { await db.stop(); });

  it("discovers files in version order and demands a down for every up", () => {
    const dir = fixtureDir();
    expect(discover(dir).map((m) => [m.version, m.name])).toEqual([[1, "create_smoke"], [2, "add_name"]]);
    writeFileSync(join(dir, "0003_orphan.sql"), "select 1;");
    expect(() => discover(dir)).toThrow(/0003\.down\.sql/);
  });

  it("applies pending migrations once, records them, and is a no-op when current", async () => {
    const dir = fixtureDir();
    expect(await up(db.migrator, dir)).toEqual([1, 2]);
    expect(await listApplied(db.migrator)).toEqual([1, 2]);
    expect(await up(db.migrator, dir)).toEqual([]);
    const cols = await db.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'smoke' and table_name = 't' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(["id", "name"]);
  });

  it("rolls back newest-first to a target version, then all the way", async () => {
    const dir = fixtureDir();
    expect(await down(db.migrator, dir, 1)).toEqual([2]);
    expect(await listApplied(db.migrator)).toEqual([1]);
    expect(await down(db.migrator, dir)).toEqual([1]);
    const [s] = await db.migrator<{ n: number }[]>`
      select count(*)::int as n from information_schema.schemata where schema_name = 'smoke'`;
    expect(s!.n).toBe(0);
  });

  it("a failing migration leaves the ledger and the schema untouched", async () => {
    const dir = fixtureDir();
    await up(db.migrator, dir);
    writeFileSync(join(dir, "0003_broken.sql"), "create table smoke.u (id int);\nselect this_is_not_sql;\n");
    writeFileSync(join(dir, "0003.down.sql"), "drop table smoke.u;\n");
    await expect(up(db.migrator, dir)).rejects.toThrow();
    expect(await listApplied(db.migrator)).toEqual([1, 2]);
    const [u] = await db.migrator<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'smoke' and table_name = 'u'`;
    expect(u!.n).toBe(0);
    await down(db.migrator, dir);
  });
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/migrate.test.ts`
Expected: FAIL — `discover`, `down`, `listApplied` are not exported by the stub.

- [x] **Step 4: Write `packages/db/src/migrate.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";

export interface Migration { version: number; name: string; upPath: string; downPath: string }

const UP_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function discover(dir: string): Migration[] {
  const found: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const m = UP_FILE.exec(file);
    if (!m) continue;
    const downPath = join(dir, `${m[1]}.down.sql`);
    if (!existsSync(downPath)) {
      throw new Error(`migration ${file} has no ${m[1]}.down.sql — every migration ships a down (spec §3.9)`);
    }
    found.push({ version: Number(m[1]), name: m[2]!, upPath: join(dir, file), downPath });
  }
  return found.sort((a, b) => a.version - b.version);
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`create schema if not exists app_meta`;
  await sql`create table if not exists app_meta.schema_migration (
    version    int primary key,
    name       text not null,
    applied_at timestamptz not null default now()
  )`;
}

export async function listApplied(sql: Sql): Promise<number[]> {
  await ensureLedger(sql);
  const rows = await sql<{ version: number }[]>`select version from app_meta.schema_migration order by version`;
  return rows.map((r) => r.version);
}

/** Forward-only. Each file runs in its own transaction; a failure applies nothing from that file. */
export async function up(sql: Sql, dir: string): Promise<number[]> {
  const applied = new Set(await listApplied(sql));
  const ran: number[] = [];
  for (const m of discover(dir)) {
    if (applied.has(m.version)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(m.upPath, "utf8")); // whole file, simple-query mode; the file is code, not input
      await tx`insert into app_meta.schema_migration (version, name) values (${m.version}, ${m.name})`;
    });
    ran.push(m.version);
  }
  return ran;
}

/** Rolls back applied versions greater than toVersion, newest first. CI and local development only. */
export async function down(sql: Sql, dir: string, toVersion = 0): Promise<number[]> {
  const applied = await listApplied(sql);
  const byVersion = new Map(discover(dir).map((m) => [m.version, m] as const));
  const ran: number[] = [];
  for (const v of [...applied].reverse()) {
    if (v <= toVersion) break;
    const m = byVersion.get(v);
    if (!m) throw new Error(`applied migration ${v} has no file in ${dir}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(m.downPath, "utf8"));
      await tx`delete from app_meta.schema_migration where version = ${v}`;
    });
    ran.push(v);
  }
  return ran;
}
```

- [x] **Step 5: Write `packages/db/src/cli.ts` and export from `index.ts`**

`packages/db/src/cli.ts`:

```ts
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { down, listApplied, up } from "./migrate";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env["DATABASE_URL_MIGRATOR"];
if (!url) {
  console.error("DATABASE_URL_MIGRATOR is required (app_migrator, session mode / port 5432 — never 6543)");
  process.exit(2);
}
if (/:6543\b/.test(url)) {
  console.error("refusing a transaction-mode pooler URL (spec §3.2.1)");
  process.exit(2);
}
const sql = postgres(url, { max: 1 });
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "up") console.log("applied:", await up(sql, dir));
  else if (cmd === "down") console.log("rolled back:", await down(sql, dir, Number(arg ?? 0)));
  else if (cmd === "status") console.log("applied:", await listApplied(sql));
  else { console.error("usage: cli.ts up | down [toVersion] | status"); process.exit(2); }
} finally {
  await sql.end();
}
```

`packages/db/src/index.ts`:

```ts
export { discover, down, listApplied, up, type Migration } from "./migrate";
```

- [x] **Step 6: Run the tests and the toolchain**

Run: `cd packages/db && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: migrate.test.ts 4 passed, roles.test.ts 4 passed; lint and typecheck exit 0.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): SQL migration runner with app_meta ledger and down path (ADR-0002)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Migration 0001, part 1 — schema, identity functions, tenant, principal, membership, `resolve_principal` (v1.1 fixes #2 and #3)

**Owner gate:** this task implements the two v1.1 changelog rows marked *Confirm*. Merge only after the owner has signed them off (spec §5.3 "Before 0.2").

**Files:**
- Create: `packages/db/migrations/0001_foundations.sql`, `packages/db/migrations/0001.down.sql`
- Test: `packages/db/test/identity.test.ts`

**Interfaces:**
- Produces (SQL, used by every later section and by Plan 0B's API):
  - `app.current_tenant() returns uuid`, `app.current_actor() returns uuid` — read the two transaction-local settings.
  - `app.tenant(id, name, created_at)`; `app.principal(id, kind, auth_subject, email, display_name, created_at)`; `app.membership(tenant_id, principal_id, created_at)`.
  - `app.resolve_principal(p_auth_subject text) returns table (principal_id uuid, tenant_id uuid, kind app.principal_kind)` — callable by `app_rw` with no tenant set.
  - `app_meta.enable_tenant_rls(tbl regclass)` — procedure used by every tenant-scoped table in later sections: enable + force RLS and create the `tenant_isolation` policy.
- Convention every caller must follow: **insert a principal without `RETURNING`** and insert its `membership` in the same transaction. A `RETURNING` clause is checked against the SELECT policy, which needs the membership row that does not exist yet, and fails with "new row violates row-level security policy".

- [x] **Step 1: Write the failing test `packages/db/test/identity.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("identity core — spec §3.8; v1.1 fixes #2 (principal insert) and #3 (resolve_principal)", () => {
  let db: Db;
  let tenantId: string, systemId: string, humanId: string;

  beforeAll(async () => {
    db = await startDb();
    tenantId = await uuidv7(db.admin);
    systemId = await uuidv7(db.admin);
    humanId = await uuidv7(db.admin);
  });
  afterAll(async () => { await db.stop(); });

  it("bootstrap: tenant, system principal, membership — one transaction as app_migrator under FORCE RLS", async () => {
    await withTenant(db.migrator, tenantId, systemId, async (tx) => {
      await tx`insert into app.tenant (id, name) values (${tenantId}, 'Owner Sdn Bhd')`;
      // No RETURNING: it is checked against the SELECT policy, which needs the membership that does not exist yet.
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${systemId}, 'system', ${"system:" + tenantId}, 'system')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${systemId})`;
      const rows = await tx<{ id: string }[]>`select id from app.principal`;
      expect(rows.map((r) => r.id)).toEqual([systemId]);
    });
  });

  it("app_rw invites a human: principal + membership in one transaction, then both are visible", async () => {
    await withTenant(db.rw, tenantId, systemId, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
               values (${humanId}, 'human', 'sub-owner-1', 'owner@example.test', 'Owner')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${humanId})`;
    });
    await withTenant(db.rw, tenantId, systemId, async (tx) => {
      const rows = await tx<{ id: string }[]>`select id from app.principal`;
      expect(rows.map((r) => r.id).sort()).toEqual([systemId, humanId].sort());
    });
  });

  it("a principal insert with no tenant on the transaction is rejected", async () => {
    await expect(
      db.rw`insert into app.principal (kind, auth_subject, display_name) values ('human', 'stray', 'Stray')`,
    ).rejects.toThrow(/row-level security/);
  });

  it("resolve_principal answers for app_rw with NO tenant set, while direct selects return nothing", async () => {
    const rows = await db.rw<{ principal_id: string; tenant_id: string; kind: string }[]>`
      select * from app.resolve_principal('sub-owner-1')`;
    expect(rows).toEqual([{ principal_id: humanId, tenant_id: tenantId, kind: "human" }]);
    expect(await db.rw`select * from app.principal`).toHaveLength(0);
    expect(await db.rw`select * from app.membership`).toHaveLength(0);
    expect(await db.rw`select * from app.resolve_principal('nobody')`).toHaveLength(0);
  });

  it("resolve_principal is SECURITY DEFINER owned by app_auth, a role without BYPASSRLS", async () => {
    const [f] = await db.admin<{ owner: string; secdef: boolean; bypass: boolean }[]>`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef,
             (select rolbypassrls from pg_roles where oid = p.proowner) as bypass
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'resolve_principal'`;
    expect(f).toEqual({ owner: "app_auth", secdef: true, bypass: false });
  });

  it("a second tenant sees only itself", async () => {
    const t2 = await uuidv7(db.admin), s2 = await uuidv7(db.admin);
    await withTenant(db.migrator, t2, s2, async (tx) => {
      await tx`insert into app.tenant (id, name) values (${t2}, 'Other')`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${s2}, 'system', ${"system:" + t2}, 'system')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${t2}, ${s2})`;
    });
    await withTenant(db.rw, t2, s2, async (tx) => {
      expect((await tx<{ id: string }[]>`select id from app.tenant`).map((r) => r.id)).toEqual([t2]);
      expect((await tx<{ id: string }[]>`select id from app.principal`).map((r) => r.id)).toEqual([s2]);
    });
  });

  it("a principal's auth_subject prefix must match its kind", async () => {
    await expect(withTenant(db.migrator, tenantId, systemId, (tx) =>
      tx`insert into app.principal (kind, auth_subject, display_name) values ('human', 'system:impostor', 'X')`)).rejects.toThrow(/check constraint/);
    await expect(withTenant(db.migrator, tenantId, systemId, (tx) =>
      tx`insert into app.principal (kind, auth_subject, display_name) values ('system', 'not-prefixed', 'X')`)).rejects.toThrow(/check constraint/);
  });

  it("a membership naming another tenant is rejected by WITH CHECK", async () => {
    const t2 = await uuidv7(db.admin), s2 = await uuidv7(db.admin), p3 = await uuidv7(db.admin);
    await withTenant(db.migrator, t2, s2, async (tx) => {
      await tx`insert into app.tenant (id, name) values (${t2}, 'Other 2')`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${s2}, 'system', ${"system:" + t2}, 'system')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${t2}, ${s2})`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p3}, 'human', ${"p3:" + t2}, 'P3')`;
    });
    await expect(
      withTenant(db.rw, t2, s2, (tx) => tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${p3})`),
    ).rejects.toThrow(/row-level security/);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/identity.test.ts`
Expected: FAIL — `up()` finds no migrations, so `app.tenant` does not exist.

- [x] **Step 3: Write `packages/db/migrations/0001_foundations.sql` (sections 1–4)**

```sql
-- 0001_foundations.sql — Dulja reference schema (spec §3.8). Applied as app_migrator, one transaction.
-- Grown by Plan 0A Tasks 5–10; each section names the spec defects it closes. PostgreSQL 18: uuidv7() is built in.

-- ── 1. schema, extensions, identity functions ─────────────────────────────────────────────────────────
create extension if not exists btree_gist;
create schema app;
grant usage on schema app to app_rw;
grant usage on schema app to app_auth;

-- Identity comes from the API, set once per transaction, local to the transaction (closes LEGACY-026, 027, 035).
create function app.current_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create function app.current_actor() returns uuid language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid $$;

-- Migration-only helper: the RLS pattern every tenant-scoped table follows. Lives in app_meta (migrator-owned,
-- not granted to app_rw) so it is unreachable from application code. The 0.4 linter checks the result.
create procedure app_meta.enable_tenant_rls(tbl regclass) language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);   -- applies to the table owner too
  execute format(
    'create policy tenant_isolation on %s using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
    tbl);
end $$;

-- ── 2. tenant ─────────────────────────────────────────────────────────────────────────────────────────
create table app.tenant (
  id          uuid primary key default uuidv7(),
  name        text not null,
  created_at  timestamptz not null default now()
);
alter table app.tenant enable row level security;
alter table app.tenant force row level security;
create policy tenant_self on app.tenant using (id = app.current_tenant());   -- app_rw sees only its own tenant row
grant select, insert, update on app.tenant to app_rw;

-- ── 3. principals and memberships ─────────────────────────────────────────────────────────────────────
-- One table, one FK target for every actor column. "A terminal is not a user" is kind = 'terminal'.
create type app.principal_kind as enum ('human', 'system', 'terminal');
create table app.principal (
  id            uuid primary key default uuidv7(),
  kind          app.principal_kind not null,
  auth_subject  text not null unique,   -- human: Supabase JWT sub (every human, cashiers included); system: 'system:<tenant_id>'; terminal: 'terminal:<terminal_id>'
  email         text,
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
alter table app.principal enable row level security;
alter table app.principal force row level security;
-- Read/update: a principal is visible only through a membership in the current tenant.
create policy principal_in_tenant on app.principal for select
  using (exists (select 1 from app.membership m where m.principal_id = id and m.tenant_id = app.current_tenant()));
create policy principal_update_in_tenant on app.principal for update
  using (exists (select 1 from app.membership m where m.principal_id = id and m.tenant_id = app.current_tenant()));
-- Insert MUST be a separate policy (v1.1 fix #2). With no WITH CHECK, Postgres reuses USING as the INSERT check, and a
-- brand-new principal has no membership yet (membership references principal) — nothing could ever be inserted.
-- Callers insert principal (no RETURNING) + membership in ONE transaction.
create policy principal_insert on app.principal for insert with check (app.current_tenant() is not null);
call app_meta.enable_tenant_rls('app.membership');
grant select, insert, update on app.principal, app.membership to app_rw;

-- ── 4. resolve_principal — the one door that runs before the tenant is known (v1.1 fix #3) ─────────────
-- Owned by app_auth (NOLOGIN, no attributes), NOT by app_migrator: app_migrator is subject to FORCE ROW LEVEL SECURITY,
-- and with app.tenant_id unset every policy above yields no rows. app_auth is not given BYPASSRLS (only a superuser can
-- create such a role; Supabase's postgres role is not one). Instead these two policies are scoped TO app_auth: inside the
-- SECURITY DEFINER body current_user = app_auth, so they apply there and nowhere else.
grant select on app.principal, app.membership to app_auth;
create policy principal_resolver  on app.principal  for select to app_auth using (true);
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
alter function app.resolve_principal(text) owner to app_auth;      -- needs: grant app_auth to app_migrator (provision/roles.sql)
revoke create on schema app from app_auth;                         -- ownership persists; app_auth is back to USAGE only
```

- [x] **Step 4: Write `packages/db/migrations/0001.down.sql`**

Reverse order of dependency. Later tasks prepend their drops above these lines.

```sql
-- 0001.down.sql — reverse of 0001_foundations.sql. CI applies up → down → up (Task 10).
drop function  if exists app.resolve_principal(text);
drop policy    if exists principal_in_tenant on app.principal;          -- both USING clauses reference app.membership;
drop policy    if exists principal_update_in_tenant on app.principal;   -- without these two drops, dropping membership fails
drop table     if exists app.membership;
drop table     if exists app.principal;
drop type      if exists app.principal_kind;
drop table     if exists app.tenant;
drop procedure if exists app_meta.enable_tenant_rls(regclass);
drop function  if exists app.current_actor();
drop function  if exists app.current_tenant();
drop schema    if exists app;
-- The btree_gist extension created by the up file is deliberately NOT dropped: extensions are database-level, shared objects
-- (on Supabase they live in the platform-managed `extensions` schema), and `create extension if not exists` keeps re-up idempotent.
```

- [x] **Step 5: Run the tests**

Run: `cd packages/db && bun run test`
Expected: identity.test.ts 8 passed; roles and migrate suites still green.

If `alter function … owner to app_auth` fails with "must be able to SET ROLE app_auth": `provision/roles.sql` did not run, or the container image is older than PostgreSQL 16 — check `select version()` through `db.admin`. If it fails with "permission denied for schema app", the `grant create on schema app to app_auth` line is missing.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 1 — tenant, principal, membership, resolve_principal (v1.1 fixes #2, #3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Migration 0001, part 2 — company, RBAC, fiscal periods, accounts; tenant isolation and the "who can do X" query

**Files:**
- Modify: `packages/db/migrations/0001_foundations.sql` (append section 5), `packages/db/migrations/0001.down.sql` (prepend drops)
- Test: `packages/db/test/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `app.company`, `app.role`, `app.permission` (global), `app.role_permission`, `app.role_assignment`, `app.fiscal_period` (+ enum `app.period_status`), `app.account` (+ enum `app.account_type`). Every parent carries `unique (tenant_id, id)` so children can use the composite FK form.
- Consumes: Task 5's `app_meta.enable_tenant_rls`, `app.current_tenant()`.

- [x] **Step 1: Write the failing test `packages/db/test/tenant-isolation.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

interface Tenant { id: string; system: string; human: string; company: string }

async function bootstrapTenant(db: Db, name: string): Promise<Tenant> {
  const t: Tenant = { id: await uuidv7(db.admin), system: await uuidv7(db.admin), human: await uuidv7(db.admin), company: await uuidv7(db.admin) };
  await withTenant(db.migrator, t.id, t.system, async (tx) => {
    await tx`insert into app.tenant (id, name) values (${t.id}, ${name})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${t.system}, 'system', ${"system:" + t.id}, 'system')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${t.id}, ${t.system})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${t.human}, 'human', ${"human:" + t.id}, ${name + " owner"})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${t.id}, ${t.human})`;
    await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${t.company}, ${t.id}, 'HQ', ${name + " HQ"}, 'MYR')`;
  });
  return t;
}

describe("tenant isolation and RBAC — spec §3.8, §4.1, §4.2; acceptance tests 12 and 14", () => {
  let db: Db; let a: Tenant; let b: Tenant;
  beforeAll(async () => {
    db = await startDb();
    a = await bootstrapTenant(db, "Alpha");
    b = await bootstrapTenant(db, "Beta");
    await db.migrator`insert into app.permission (code, module, mutating, description) values
      ('accounting.purchase.post', 'accounting', true, 'Post a purchase document'),
      ('accounting.sales.post',    'accounting', true, 'Post a sales document'),
      ('admin.user.manage',        'admin',      true, 'Manage users')`;
  });
  afterAll(async () => { await db.stop(); });

  it("both tenants may use company code HQ; each sees only its own company", async () => {
    const seen = async (t: Tenant) =>
      withTenant(db.rw, t.id, t.human, async (tx) => (await tx<{ id: string }[]>`select id from app.company`).map((r) => r.id));
    expect(await seen(a)).toEqual([a.company]);
    expect(await seen(b)).toEqual([b.company]);
  });

  it("a write carrying another tenant's id is rejected by the policy, not by application code", async () => {
    await expect(
      withTenant(db.rw, a.id, a.human, (tx) => tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.id}, 'X', 'Forged', 'MYR')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("an update that would move a row to another tenant is rejected", async () => {
    await expect(
      withTenant(db.rw, a.id, a.human, (tx) => tx`update app.company set tenant_id = ${b.id} where id = ${a.company}`),
    ).rejects.toThrow(/row-level security/);
  });

  it("acceptance test 14: who can post a purchase return in company X is one query", async () => {
    const roleId = await uuidv7(db.admin);
    await withTenant(db.rw, a.id, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'ACCOUNTANT', 'Accountant')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.purchase.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`;
    });
    const who = (tx: Sql, companyId: string) => tx<{ id: string; display_name: string }[]>`
      select distinct p.id, p.display_name
        from app.principal p
        join app.role_assignment ra on ra.principal_id = p.id
        join app.role_permission rp on rp.role_id = ra.role_id
       where ra.company_id = ${companyId} and rp.permission_code = 'accounting.purchase.post'
         and (ra.expires_at is null or ra.expires_at > now())
       order by p.display_name`;
    expect(await withTenant(db.rw, a.id, a.system, (tx) => who(tx, a.company))).toEqual([{ id: a.human, display_name: "Alpha owner" }]);
    expect(await withTenant(db.rw, b.id, b.system, (tx) => who(tx, a.company))).toEqual([]);   // tenant B cannot even see A's assignment
  });

  it("a role_permission must name a catalogued permission", async () => {
    const roleId = await uuidv7(db.admin);
    await expect(withTenant(db.rw, a.id, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'BAD', 'Bad')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'does.not.exist')`;
    })).rejects.toThrow(/foreign key/);
  });

  it("fiscal periods cannot overlap within a company", async () => {
    await withTenant(db.rw, a.id, a.system, (tx) =>
      tx`insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on) values (${a.id}, ${a.company}, '2026-01-01', '2026-01-31')`);
    await expect(withTenant(db.rw, a.id, a.system, (tx) =>
      tx`insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on) values (${a.id}, ${a.company}, '2026-01-15', '2026-02-14')`),
    ).rejects.toThrow(/exclusion constraint/);
  });

  it("account codes are unique per company and an account can be archived", async () => {
    const acc = await uuidv7(db.admin);
    await withTenant(db.rw, a.id, a.system, async (tx) => {
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type) values (${acc}, ${a.id}, ${a.company}, '1000', 'Cash', 'asset')`;
    });
    await expect(withTenant(db.rw, a.id, a.system, (tx) =>
      tx`insert into app.account (tenant_id, company_id, code, name_en, type) values (${a.id}, ${a.company}, '1000', 'Dup', 'asset')`),
    ).rejects.toThrow(/unique/);
    await withTenant(db.rw, a.id, a.system, (tx) => tx`update app.account set archived_at = now() where id = ${acc}`);
    const [row] = await withTenant(db.rw, a.id, a.system, (tx) => tx<{ archived: boolean }[]>`select archived_at is not null as archived from app.account where id = ${acc}`);
    expect(row!.archived).toBe(true);
  });

  it("actor_has(): company-wide, branch-restricted and expired assignments (spec §4.2.1)", async () => {
    const roleId = await uuidv7(db.admin), p2 = await uuidv7(db.admin), branchTypeId = await uuidv7(db.admin);
    const b1 = await uuidv7(db.admin), b2 = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p2}, 'human', ${"human2:" + a.id}, 'Branch manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${p2})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'BRANCH_MANAGER', 'Branch manager')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.sales.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${p2}, ${roleId}, ${a.company})`;
    });
    // company-wide (no branch rows): true for any branch id
    expect(await withTenant(db.rw, a.id, p2, (tx) => tx<{ ok: boolean }[]>`select app.actor_has('accounting.sales.post', ${a.company}, ${b1}) as ok`))
      .toEqual([{ ok: true }]);
    // the branch child table exists in Task 6; its FK to dimension_value arrives in Task 7 — here the branch ids are opaque
    await withTenant(db.migrator, a.id, a.system, (tx) =>
      tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id) values (${a.id}, ${p2}, ${roleId}, ${a.company}, ${b1})`);
    const check = (branch: string) => withTenant(db.rw, a.id, p2, (tx) => tx<{ ok: boolean }[]>`select app.actor_has('accounting.sales.post', ${a.company}, ${branch}) as ok`);
    expect(await check(b1)).toEqual([{ ok: true }]);
    expect(await check(b2)).toEqual([{ ok: false }]);
    // a NULL branch asks for company-wide authority — a branch-restricted principal does NOT get it (never fail open)
    expect(await withTenant(db.rw, a.id, p2, (tx) => tx<{ ok: boolean }[]>`select app.actor_has('accounting.sales.post', ${a.company}, null) as ok`))
      .toEqual([{ ok: false }]);
    // the system principal passes without any assignment (jobs)
    expect(await withTenant(db.rw, a.id, a.system, (tx) => tx<{ ok: boolean }[]>`select app.actor_has('accounting.sales.post', ${a.company}, ${b2}) as ok`))
      .toEqual([{ ok: true }]);
    // expired
    await withTenant(db.migrator, a.id, a.system, (tx) => tx`update app.role_assignment set expires_at = now() - interval '1 minute' where principal_id = ${p2}`);
    expect(await check(b1)).toEqual([{ ok: false }]);
  });

  it("no self-grant: a principal cannot assign a role to themselves or change a role they hold (spec §4.2.2 R5)", async () => {
    const roleId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, (tx) => tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'SELFTEST', 'Self test')`);
    await expect(withTenant(db.rw, a.id, a.human, (tx) =>
      tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`)).rejects.toThrow(/ERR_RBAC_SELF_GRANT/);
    await withTenant(db.migrator, a.id, a.system, (tx) =>
      tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`);
    await expect(withTenant(db.rw, a.id, a.human, (tx) =>
      tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.purchase.post')`)).rejects.toThrow(/ERR_RBAC_SELF_ESCALATION/);
  });

  it("kind discipline: terminals hold only pos_terminal, humans never do, the system principal holds nothing (spec §4.2.2 R8)", async () => {
    const term = await uuidv7(db.admin), posRole = await uuidv7(db.admin), clerkRole = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${term}, 'terminal', ${"terminal:" + term}, 'Till 1')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${term})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${posRole}, ${a.id}, 'pos_terminal', 'POS terminal'), (${clerkRole}, ${a.id}, 'user', 'User')`;
    });
    const assign = (p: string, r: string) => withTenant(db.migrator, a.id, a.system, (tx) =>
      tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${p}, ${r}, ${a.company})`);
    await expect(assign(term, clerkRole)).rejects.toThrow(/ERR_RBAC_KIND/);
    await expect(assign(a.human, posRole)).rejects.toThrow(/ERR_RBAC_KIND/);
    await expect(withTenant(db.migrator, a.id, a.human, (tx) =>     // actor ≠ principal, so only the kind trigger can fire
      tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.system}, ${clerkRole}, ${a.company})`)).rejects.toThrow(/ERR_RBAC_KIND/);
    await assign(term, posRole);   // the one legal combination
  });

  it("the last administrator cannot be expired or stripped (spec §4.2.2 R5)", async () => {
    const adminRole = await uuidv7(db.admin), p2 = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${adminRole}, ${a.id}, 'admin', 'Administrator')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${adminRole}, 'admin.user.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${adminRole}, ${a.company})`;
    });
    await expect(withTenant(db.migrator, a.id, a.system, (tx) =>
      tx`update app.role_assignment set expires_at = now() where principal_id = ${a.human} and role_id = ${adminRole}`)).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await expect(withTenant(db.migrator, a.id, a.system, (tx) =>
      tx`delete from app.role_permission where role_id = ${adminRole} and permission_code = 'admin.user.manage'`)).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await expect(withTenant(db.migrator, a.id, a.system, (tx) =>     // re-pointing the grant is a removal too (UPDATE path)
      tx`update app.role_permission set permission_code = 'accounting.sales.post' where role_id = ${adminRole} and permission_code = 'admin.user.manage'`)).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p2}, 'human', ${"human3:" + a.id}, 'Second admin')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${p2})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${p2}, ${adminRole}, ${a.company})`;
      await tx`update app.role_assignment set expires_at = now() where principal_id = ${a.human} and role_id = ${adminRole}`;   // now allowed
    });
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/tenant-isolation.test.ts`
Expected: FAIL — `app.company` does not exist.

- [x] **Step 3: Append section 5 to `0001_foundations.sql`**

```sql
-- ── 5. company, RBAC, fiscal periods, accounts ────────────────────────────────────────────────────────
-- Template every tenant-scoped table follows. Every parent also carries unique (tenant_id, id) so that children
-- can reference it with the composite FK form — FK checks bypass RLS, so a plain FK would let tenant A point at
-- tenant B's row if the uuid were known.
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
  unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.company');

create table app.role (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  code         text not null,                  -- the nine system roles of spec §4.2.1 are seeded in Plan 0C
  name_en      text not null,
  name_ar      text,
  description  text,
  is_system    boolean not null default false, -- seeded roles: never renamed or archived; permissions change only by migration
  created_at   timestamptz not null default now(),
  unique (tenant_id, code), unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.role');

-- Global catalogue, seeded from packages/contracts/permissions.ts (Plan 0B); a code no handler checks fails the build (LEGACY-047).
-- `mutating` lets CI prove that a read-only role is read-only (spec §4.2.2 R7).
create table app.permission (
  code         text primary key,               -- '<module>.<resource>.<action>' (spec §4.2.1)
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
call app_meta.enable_tenant_rls('app.role_permission');

create table app.role_assignment (            -- a join table (no id/created_at — linter rule); scope = (principal, role, company)
  tenant_id     uuid not null references app.tenant(id),
  principal_id  uuid not null references app.principal(id),
  role_id       uuid not null,
  company_id    uuid not null,
  granted_by    uuid not null default app.current_actor() references app.principal(id),
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,                   -- NULL = open-ended; an expired assignment grants nothing
  primary key (principal_id, role_id, company_id),
  unique (tenant_id, principal_id, role_id, company_id),   -- lets the branch child use the composite FK form
  foreign key (tenant_id, role_id)    references app.role(tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.role_assignment');

-- Branch scope (spec §4.2.1): rows restrict an assignment to a set of BRANCH dimension values; NO rows = every branch.
-- The FK to dimension_value is added in Task 7, where that table is created.
create table app.role_assignment_branch (
  tenant_id     uuid not null,
  principal_id  uuid not null,
  role_id       uuid not null,
  company_id    uuid not null,
  branch_id     uuid not null,
  primary key (principal_id, role_id, company_id, branch_id),
  foreign key (tenant_id, principal_id, role_id, company_id)
    references app.role_assignment(tenant_id, principal_id, role_id, company_id) on delete cascade
);
call app_meta.enable_tenant_rls('app.role_assignment_branch');

-- THE authorisation predicate (spec §4.2.1): used by handlers, by RLS policies on sensitive tables and by triggers.
--   p_branch_id NULL  = "company-wide authority": granted only by an unexpired assignment with NO branch rows (never fails open);
--   p_branch_id set   = granted by a company-wide assignment or by one whose branch rows include that branch;
--   the tenant's SYSTEM principal (jobs and the seed CLI only) always passes, so a job never silently reads zero rows behind a gate.
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

-- No self-grant, no self-escalation (spec §4.2.2 R5; LEGACY-032). The seed runs as the system principal, so the owner's first
-- assignment passes.
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

-- Kind discipline (spec §4.2.2 R8): a terminal holds only pos_terminal; pos_terminal is held only by a terminal; system holds nothing.
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

-- Last-admin guard (spec §4.2.2 R5): a change may not leave the tenant with no unexpired holder of admin.user.manage. Two functions,
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
-- "Who can post a purchase return in company X?" = principal ⋈ role_assignment ⋈ role_permission, filtered on expires_at
-- (acceptance test 14); the branch-specific form is actor_has(code, company, branch) (acceptance test 36).

create type app.period_status as enum ('open', 'closed', 'locked');
create table app.fiscal_period (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  starts_on   date not null,
  ends_on     date not null,
  status      app.period_status not null default 'open',
  closed_by   uuid references app.principal(id),
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  check (ends_on >= starts_on),
  exclude using gist (company_id with =, daterange(starts_on, ends_on, '[]') with &&)   -- no overlaps
);
call app_meta.enable_tenant_rls('app.fiscal_period');

create type app.account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');  -- one discriminator, not 30 booleans (LEGACY-072)
create table app.account (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  type        app.account_type not null,
  parent_id   uuid,                          -- composite FK below
  is_group    boolean not null default false,
  currency    char(3),                       -- null = any currency
  archived_at timestamptz,                   -- accounts are archived, never deleted (LEGACY-021)
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, parent_id)  references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.account');
alter table app.company add constraint company_fx_rounding_account_fk
  foreign key (tenant_id, fx_rounding_account_id) references app.account(tenant_id, id);

grant select, insert, update on app.company, app.role, app.role_permission, app.role_assignment, app.role_assignment_branch, app.fiscal_period, app.account to app_rw;
```

- [x] **Step 4: Prepend to `0001.down.sql`** (above the Task 5 lines)

```sql
alter table if exists app.company drop constraint if exists company_fx_rounding_account_fk;
drop table if exists app.account;
drop type  if exists app.account_type;
drop table if exists app.fiscal_period;
drop type  if exists app.period_status;
drop function if exists app.keep_last_admin_assignment() cascade;   -- cascade removes the triggers
drop function if exists app.keep_last_admin_permission() cascade;
drop function if exists app.assert_assignment_kind() cascade;
drop function if exists app.forbid_self_grant() cascade;   -- cascade removes its three triggers
drop function if exists app.actor_has(text, uuid, uuid);
drop table if exists app.role_assignment_branch;
drop table if exists app.role_assignment;
drop table if exists app.role_permission;
drop table if exists app.permission;
drop table if exists app.role;
drop table if exists app.company;
```

- [x] **Step 5: Run the tests**

Run: `cd packages/db && bun run test`
Expected: tenant-isolation.test.ts 11 passed; earlier suites green.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 2 — company, RBAC, fiscal periods, accounts with tenant isolation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Migration 0001, part 3 — document types, posting policies, numbering tables, documents, dimensions

**Files:**
- Modify: `packages/db/migrations/0001_foundations.sql` (append section 6), `packages/db/migrations/0001.down.sql` (prepend drops)
- Create: `packages/db/test/fixtures.ts`
- Test: `packages/db/test/documents.test.ts`

**Interfaces:**
- Produces (SQL): `app.document_type`, `app.posting_policy`, `app.document_series`, `app.document_number_void`, `app.document` (+ enum `app.document_status`), `app.dimension_type`, `app.dimension_value`.
- Produces (test helper, used by Tasks 8–10): `seedTenant(db, name): Promise<Seed>` where
  `Seed = { tenant, system, human, company, period, closedPeriod, lockedPeriod, cash, sales, docType, policy }` — all uuids as strings; `period` is open (2026-01), `closedPeriod` closed (2026-02), `lockedPeriod` locked (2026-03); `cash` is an asset account, `sales` an income account; `docType` is `JOURNAL` with `policy` version 1.
- Consumes: Task 6 tables and `app_meta.enable_tenant_rls`.

- [x] **Step 1: Write `packages/db/test/fixtures.ts`**

```ts
import { uuidv7, withTenant, type Db } from "./harness";

export interface Seed {
  tenant: string; system: string; human: string; company: string;
  period: string; closedPeriod: string; lockedPeriod: string;
  cash: string; sales: string; docType: string; policy: string;
  branchType: string; hq: string;   // the BRANCH dimension type and the head-office value every document carries
}

/** A complete minimal tenant: identity, one company (MYR), three fiscal periods, two accounts, one JOURNAL type. */
export async function seedTenant(db: Db, name: string): Promise<Seed> {
  const id = () => uuidv7(db.admin);
  const s: Seed = {
    tenant: await id(), system: await id(), human: await id(), company: await id(),
    period: await id(), closedPeriod: await id(), lockedPeriod: await id(),
    cash: await id(), sales: await id(), docType: await id(), policy: await id(),
    branchType: await id(), hq: await id(),
  };
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.tenant (id, name) values (${s.tenant}, ${name})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${s.system}, 'system', ${"system:" + s.tenant}, 'system')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${s.system})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${s.human}, 'human', ${"human:" + s.tenant}, ${name + " owner"})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${s.human})`;
    await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${s.company}, ${s.tenant}, 'HQ', ${name + " HQ"}, 'MYR')`;
    await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status) values
      (${s.period},       ${s.tenant}, ${s.company}, '2026-01-01', '2026-01-31', 'open'),
      (${s.closedPeriod}, ${s.tenant}, ${s.company}, '2026-02-01', '2026-02-28', 'closed'),
      (${s.lockedPeriod}, ${s.tenant}, ${s.company}, '2026-03-01', '2026-03-31', 'locked')`;
    await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type) values
      (${s.cash},  ${s.tenant}, ${s.company}, '1000', 'Cash',  'asset'),
      (${s.sales}, ${s.tenant}, ${s.company}, '4000', 'Sales', 'income')`;
    await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${s.branchType}, ${s.tenant}, ${s.company}, 'BRANCH', 'Branch')`;
    await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values (${s.hq}, ${s.tenant}, ${s.branchType}, 'HQ', 'Head office')`;
    await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en) values (${s.docType}, ${s.tenant}, ${s.company}, 'JOURNAL', 'Journal')`;
    await tx`insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
             values (${s.policy}, ${s.tenant}, ${s.docType}, 1, '2026-01-01', ${JSON.stringify({ version: 1, documentType: "JOURNAL", direction: "none", lines: [] })}::jsonb)`;
  });
  return s;
}

/** Inserts a draft document and returns its id. Numbers are assigned at issue by the posting service (Phase 1), never here. */
export async function draftDocument(db: Db, s: Seed, opts: { effectiveDate?: string; periodId?: string; clientRef?: string } = {}): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, s.tenant, s.human, (tx) => tx`
    insert into app.document (id, tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id, effective_date, currency, client_ref, branch_id)
    values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, ${s.policy}, 'JV', ${opts.periodId ?? s.period}, ${opts.effectiveDate ?? "2026-01-15"}, 'MYR', ${opts.clientRef ?? null}, ${s.hq})`);
  return id;
}
```

- [x] **Step 2: Write the failing test `packages/db/test/documents.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("documents, numbering tables, dimensions — spec §3.8 (LEGACY-013, 051)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("a draft carries created_by from the session, status draft, and no number", async () => {
    const id = await draftDocument(db, a);
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      tx<{ created_by: string; status: string; number: number | null }[]>`select created_by, status, number from app.document where id = ${id}`);
    expect(row).toEqual({ created_by: a.human, status: "draft", number: null });
  });

  it("several drafts may share a null number; two issued numbers in one series+period cannot collide", async () => {
    await draftDocument(db, a); await draftDocument(db, a);
    const d1 = await draftDocument(db, a); const d2 = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set number = 1, status = 'issued' where id = ${d1}`);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set number = 1, status = 'issued' where id = ${d2}`))
      .rejects.toThrow(/unique/);
  });

  it("client_ref is unique per company — re-sending a POS batch cannot create a second document", async () => {
    const ref = await uuidv7(db.admin);
    await draftDocument(db, a, { clientRef: ref });
    await expect(draftDocument(db, a, { clientRef: ref })).rejects.toThrow(/unique/);
  });

  it("a document cannot reference another tenant's document type even when the uuid is known (composite FK)", async () => {
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, branch_id)
      values (${b.tenant}, ${b.company}, ${a.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR', ${b.hq})`)).rejects.toThrow(/foreign key/);
  });

  it("posting policies are versioned per document type", async () => {
    await withTenant(db.rw, a.tenant, a.system, (tx) => tx`
      insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
      values (${a.tenant}, ${a.docType}, 2, '2026-06-01', '{"version":2}'::jsonb)`);
    await expect(withTenant(db.rw, a.tenant, a.system, (tx) => tx`
      insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
      values (${a.tenant}, ${a.docType}, 2, '2026-07-01', '{"version":2}'::jsonb)`)).rejects.toThrow(/unique/);
  });

  it("document_series counter rows are keyed per (company, series, period) and voids are recorded with the actor", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id) values (${a.tenant}, ${a.company}, 'INV', ${a.period})`;
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id) values (${a.tenant}, ${a.company}, 'INV', ${a.period}) on conflict do nothing`;
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from app.document_series where series = 'INV'`;
      expect(c!.n).toBe(1);
      await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason) values (${a.tenant}, ${a.company}, 'INV', ${a.period}, 7, 'printer jam; reissued')`;
      const [v] = await tx<{ voided_by: string }[]>`select voided_by from app.document_number_void where number = 7`;
      expect(v!.voided_by).toBe(a.human);
    });
  });

  it("dimension values form a tree within one tenant; a parent from another tenant is rejected", async () => {
    const typeA = await uuidv7(db.admin), root = await uuidv7(db.admin), typeB = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.system, async (tx) => {
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${typeA}, ${a.tenant}, ${a.company}, 'REGION', 'Region')`;   // the fixture already owns BRANCH
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values (${root}, ${a.tenant}, ${typeA}, 'CENTRAL', 'Central')`;
      await tx`insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en, parent_id) values (${a.tenant}, ${typeA}, 'KL', 'Kuala Lumpur', ${root})`;
    });
    await withTenant(db.rw, b.tenant, b.system, (tx) =>
      tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${typeB}, ${b.tenant}, ${b.company}, 'REGION', 'Region')`);
    await expect(withTenant(db.rw, b.tenant, b.system, (tx) =>
      tx`insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en, parent_id) values (${b.tenant}, ${typeB}, 'X', 'X', ${root})`))
      .rejects.toThrow(/foreign key/);
  });

  it("document.branch_id and role_assignment_branch.branch_id must be BRANCH values of the same tenant, and branch_id is required", async () => {
    // tenant A's head-office value must not be usable by tenant B
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, branch_id)
      values (${b.tenant}, ${b.company}, ${b.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR', ${a.hq})`)).rejects.toThrow(/document_branch_fk/);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => tx`
      insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency)
      values (${b.tenant}, ${b.company}, ${b.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR')`)).rejects.toThrow(/null value in column "branch_id"/);
    // a valid assignment first, so the branch FK — not the parent FK — is what fires
    const roleB = await uuidv7(db.admin);
    await withTenant(db.migrator, b.tenant, b.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleB}, ${b.tenant}, 'BM', 'Branch manager')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${b.tenant}, ${b.human}, ${roleB}, ${b.company})`;
    });
    await expect(withTenant(db.rw, b.tenant, b.system, (tx) => tx`
      insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id) values (${b.tenant}, ${b.human}, ${roleB}, ${b.company}, ${a.hq})`)).rejects.toThrow(/role_assignment_branch_dim_fk/);
  });
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/documents.test.ts`
Expected: FAIL — `app.document_type` does not exist.

- [x] **Step 4: Append section 6 to `0001_foundations.sql`**

```sql
-- ── 6. document types are data; posting rules are versioned policy (RC-3, LEGACY-013) ─────────────────────
create table app.document_type (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,                 -- 'JOURNAL' (Phase 1), 'SALES_INVOICE', 'PURCHASE_RETURN', 'POS_TICKET' …
  name_en     text not null,
  name_ar     text,
  created_at  timestamptz not null default now(),
  unique (company_id, code), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document_type');

create table app.posting_policy (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  document_type_id  uuid not null,
  version           int  not null,
  effective_from    date not null,
  definition        jsonb not null,          -- validated against packages/domain/posting-policy.schema.json (Phase 2);
                                             -- seeded from version-controlled files, so it is diffable, not a blob (LEGACY-078)
  created_at        timestamptz not null default now(),
  unique (document_type_id, version), unique (tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.posting_policy');

-- Numbering: a counter row per (company, series, period); numbers issued under an advisory lock by the posting
-- service (Phase 1), never by the client (LEGACY-051). The lock is released at commit; a rollback never consumes a number.
create table app.document_series (
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  series            text not null,           -- 'INV', 'CN', 'JV', 'POS-KL01' …
  fiscal_period_id  uuid not null,
  next_number       bigint not null default 1,
  primary key (company_id, series, fiscal_period_id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document_series');

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
call app_meta.enable_tenant_rls('app.document_number_void');

create type app.document_status as enum ('draft', 'submitted', 'approved', 'issued', 'void', 'posted', 'reversed');
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
  reverses_document_id  uuid,
  client_ref            uuid,                -- uuidv7 generated at the till; the idempotency key (§3.7.3)
  branch_id             uuid not null,       -- BRANCH dimension value, the enforcement key for branch scoping (spec §4.2.1). NOT NULL: head-office documents carry the HQ value, so no branch gate has a NULL path; composite FK added below
  attributed_to         uuid references app.principal(id),   -- e.g. the cashier: DATA about the document, not the actor (LEGACY-044)
  created_by            uuid not null default app.current_actor() references app.principal(id),
  created_at            timestamptz not null default now(),
  posted_by             uuid references app.principal(id),
  posted_at             timestamptz,
  unique (company_id, series, fiscal_period_id, number),   -- per-period series: duplicates impossible, year 2 starts at 1
  unique (company_id, client_ref),                         -- re-sending a POS batch is harmless
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id)     references app.document_type(tenant_id, id),
  foreign key (tenant_id, posting_policy_id)    references app.posting_policy(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id)     references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, reverses_document_id) references app.document(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document');

-- Dimensions: generic, so a new axis needs no schema change (§3.3).
create table app.dimension_type (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, code), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.dimension_type');

create table app.dimension_value (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  dimension_type_id  uuid not null,
  code               text not null,
  name_en            text not null,
  parent_id          uuid,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  unique (dimension_type_id, code), unique (tenant_id, id),
  foreign key (tenant_id, dimension_type_id) references app.dimension_type(tenant_id, id),
  foreign key (tenant_id, parent_id)         references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.dimension_value');
-- The seed (Plan 0C) creates a BRANCH dimension type per company; pos_terminal.branch_id, document.branch_id and role_assignment_branch.branch_id reference values of it.
alter table app.role_assignment_branch add constraint role_assignment_branch_dim_fk foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);
alter table app.document add constraint document_branch_fk foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);

grant select, insert, update on app.document_type, app.posting_policy, app.document_series, app.document_number_void,
  app.document, app.dimension_type, app.dimension_value to app_rw;
```

- [x] **Step 5: Prepend to `0001.down.sql`**

```sql
alter table if exists app.role_assignment_branch drop constraint if exists role_assignment_branch_dim_fk;
alter table if exists app.document drop constraint if exists document_branch_fk;
drop table if exists app.dimension_value;
drop table if exists app.dimension_type;
drop table if exists app.document;
drop type  if exists app.document_status;
drop table if exists app.document_number_void;
drop table if exists app.document_series;
drop table if exists app.posting_policy;
drop table if exists app.document_type;
```

- [x] **Step 6: Update the Task 6 branch test — the branch FK now exists**

`role_assignment_branch_dim_fk` makes the opaque branch ids in `tenant-isolation.test.ts` invalid. In its `actor_has()` test, replace the comment line and the single `role_assignment_branch` insert with real BRANCH values:

```ts
    // Task 7 added role_assignment_branch_dim_fk: branch ids must be BRANCH dimension values of this tenant.
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${branchTypeId}, ${a.id}, ${a.company}, 'BRANCH', 'Branch')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values
        (${b1}, ${a.id}, ${branchTypeId}, 'KL01', 'Kuala Lumpur 1'), (${b2}, ${a.id}, ${branchTypeId}, 'JB01', 'Johor Bahru 1')`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id) values (${a.id}, ${p2}, ${roleId}, ${a.company}, ${b1})`;
    });
```

(`branchTypeId`, `b1` and `b2` are already declared at the top of that test.)

- [x] **Step 7: Run the tests**

Run: `cd packages/db && bun run test`
Expected: documents.test.ts 8 passed; all earlier suites green, including tenant-isolation.test.ts with the updated branch test.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 3 — document types, policies, numbering, documents, dimensions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Migration 0001, part 4 — the immutable ledger: `ledger_entry`, dimensions join, immutability, period lock, balance at commit

**Files:**
- Modify: `packages/db/migrations/0001_foundations.sql` (append section 7), `packages/db/migrations/0001.down.sql` (prepend drops)
- Test: `packages/db/test/ledger.test.ts`

**Interfaces:**
- Produces (SQL): `app.ledger_entry`, `app.ledger_entry_dimension`, `app.forbid_change()` (trigger function reused by `audit_log` in Task 9), `app.assert_period_open()`, `app.assert_document_balanced()`; the deferred constraint trigger `ledger_entry_balanced`.
- Consumes: Task 7's `seedTenant`, `draftDocument`.
- `app_rw` receives **SELECT and INSERT only** on both ledger tables here; Task 10 asserts the absence of UPDATE/DELETE.

- [x] **Step 1: Write the failing test `packages/db/test/ledger.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

interface Line { account: string; debit?: string; credit?: string; currency?: string; rate?: string }

/** Writes ledger lines the way the posting service will (Phase 1), computing base amounts as round(value × rate, 4). */
async function post(tx: Sql, s: Seed, docId: string, lines: Line[], periodId = s.period): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n += 1;
    const rate = l.rate ?? "1";
    await tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit,
       effective_date, fiscal_period_id, posting_policy_id)
      values (${s.tenant}, ${s.company}, ${docId}, ${n}, ${l.account}, ${l.debit ?? "0"}, ${l.credit ?? "0"}, ${l.currency ?? "MYR"}, ${rate},
              round(${l.debit ?? "0"}::numeric * ${rate}::numeric, 4), round(${l.credit ?? "0"}::numeric * ${rate}::numeric, 4),
              '2026-01-15', ${periodId}, ${s.policy})`;
  }
}

describe("the ledger — spec §3.8 (LEGACY-003, 012, 031, 041, 042, 044)", () => {
  let db: Db; let a: Seed; let b: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); b = await seedTenant(db, "Beta"); });
  afterAll(async () => { await db.stop(); });

  it("a balanced two-line journal commits and carries posted_by from the session", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [{ account: a.cash, debit: "100.0000" }, { account: a.sales, credit: "100.0000" }]));
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ posted_by: string; base_debit: string }[]>`
      select posted_by, base_debit from app.ledger_entry where document_id = ${doc} order by line_no`);
    expect(rows.map((r) => r.posted_by)).toEqual([a.human, a.human]);
    expect(rows[0]!.base_debit).toBe("100.0000");
  });

  it("an unbalanced document is rejected at COMMIT with ERR_LEDGER_UNBALANCED — nothing from it survives", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [{ account: a.cash, debit: "100" }, { account: a.sales, credit: "90" }])))
      .rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
    const [c] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry where document_id = ${doc}`);
    expect(c!.n).toBe(0);
  });

  it("balance is checked in BASE currency: a foreign-currency journal at rate 4.85 balances", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [
      { account: a.cash, debit: "100", currency: "EUR", rate: "4.85" }, { account: a.sales, credit: "100", currency: "EUR", rate: "4.85" }]));
    const [r] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ base: string }[]>`select base_debit as base from app.ledger_entry where document_id = ${doc} and line_no = 1`);
    expect(r!.base).toBe("485.0000");
  });

  it("base = round(value × rate, 4) is a CHECK — a stale or hand-typed base amount is rejected (LEGACY-012)", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 100, 0, 'USD', 4.2, 500, 0, '2026-01-15', ${a.period}, ${a.policy})`))
      .rejects.toThrow(/check constraint/);
  });

  it("one side per line: debit and credit both non-zero is rejected", async () => {
    const doc = await draftDocument(db, a);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [{ account: a.cash, debit: "5", credit: "5" }])))
      .rejects.toThrow(/check constraint/);
  });

  it("posting into a closed or locked period is refused on the LINE (LEGACY-031)", async () => {
    for (const p of [a.closedPeriod, a.lockedPeriod]) {
      const doc = await draftDocument(db, a, { periodId: p, effectiveDate: p === a.closedPeriod ? "2026-02-10" : "2026-03-10" });
      await expect(withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [{ account: a.cash, debit: "1" }, { account: a.sales, credit: "1" }], p)))
        .rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
    }
  });

  it("ledger entries cannot be updated or deleted — even by the schema owner (trigger), and the app role lacks the privilege", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => post(tx, a, doc, [{ account: a.cash, debit: "10" }, { account: a.sales, credit: "10" }]));
    await expect(withTenant(db.migrator, a.tenant, a.system, (tx) => tx`update app.ledger_entry set debit = 11 where document_id = ${doc} and line_no = 1`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(db.migrator, a.tenant, a.system, (tx) => tx`delete from app.ledger_entry where document_id = ${doc}`))
      .rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.ledger_entry set debit = 11 where document_id = ${doc} and line_no = 1`))
      .rejects.toThrow(/permission denied/);
  });

  it("an entry cannot point at another tenant's account even when the uuid is known (composite FK)", async () => {
    const doc = await draftDocument(db, b);
    await expect(withTenant(db.rw, b.tenant, b.human, (tx) => post(tx, b, doc, [{ account: a.cash, debit: "1" }, { account: b.sales, credit: "1" }], b.period)))
      .rejects.toThrow(/foreign key/);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/ledger.test.ts`
Expected: FAIL — `app.ledger_entry` does not exist.

- [x] **Step 3: Append section 7 to `0001_foundations.sql`**

```sql
-- ── 7. THE LEDGER. Immutable. The only financial truth. (D13, RC-2) ────────────────────────────────────
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
  unique (document_id, line_no),
  unique (tenant_id, id),                                        -- lets ledger_entry_dimension use the composite FK form
  -- Composite FKs: FK checks bypass RLS, so a plain `references app.account(id)` would let tenant A's entry point at
  -- tenant B's account if the uuid were known. Pairing tenant_id in the FK makes that impossible.
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)       references app.document(tenant_id, id),
  foreign key (tenant_id, account_id)        references app.account(tenant_id, id),        -- no orphan postings (LEGACY-021, 073)
  foreign key (tenant_id, fiscal_period_id)  references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, posting_policy_id) references app.posting_policy(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.ledger_entry');
-- Partition by fiscal year once volume warrants it; PK and unique keys must then include effective_date.
create index ledger_entry_account_date_idx on app.ledger_entry (company_id, account_id, effective_date);   -- the index Journal never had (LEGACY-070)
create index ledger_entry_company_date_idx on app.ledger_entry (company_id, effective_date);

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
call app_meta.enable_tenant_rls('app.ledger_entry_dimension');

-- Immutability: belt (privileges — the grants block at the end of this file) and braces (trigger). (LEGACY-031, 041)
create function app.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'ERR_TABLE_IMMUTABLE: % is append-only', tg_table_name using errcode = 'check_violation';
end $$;
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
-- Per-transaction-currency balance is a posting-policy rule (a revaluation journal legitimately balances only in base).
-- Because base amounts are rounded per line, the posting service MUST add a base-currency FX-rounding line (rate 1,
-- account company.fx_rounding_account_id) when Σbase would otherwise be off by rounding residue — this trigger is the
-- backstop, not the rounding logic. FOR EACH ROW deferred → an N-line document re-sums N times at commit (uses the
-- (document_id, line_no) index); acceptable to ~500 lines. This is why the API needs a held transaction (§3.2.1).
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

grant select, insert on app.ledger_entry, app.ledger_entry_dimension to app_rw;   -- no update, no delete: immutable
```

- [x] **Step 4: Prepend to `0001.down.sql`**

```sql
drop table    if exists app.ledger_entry_dimension;
drop table    if exists app.ledger_entry;
drop function if exists app.assert_document_balanced();
drop function if exists app.assert_period_open();
drop function if exists app.forbid_change();
```

(`forbid_change` is also used by `audit_log` from Task 9 onward; Task 9's drops come *above* these lines, so the order stays valid.)

- [x] **Step 5: Run the tests**

Run: `cd packages/db && bun run test`
Expected: ledger.test.ts 8 passed; all earlier suites green.

The `assert_document_balanced` trigger reads `app.ledger_entry` under RLS as the inserting role; inside `withTenant` the tenant is set, so it sees the document's own lines. If the unbalanced test unexpectedly *passes* the commit, the tenant setting was not applied on the connection that ran the COMMIT — check that `withTenant` uses the transaction handle `tx`, not `sql`.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 4 — immutable ledger with period lock and balance-at-commit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Migration 0001, part 5 — append-only, hash-chained audit log and the generic AFTER ROW audit trigger

**Files:**
- Modify: `packages/db/migrations/0001_foundations.sql` (append section 8), `packages/db/migrations/0001.down.sql` (prepend drops)
- Test: `packages/db/test/audit.test.ts`

**Interfaces:**
- Produces (SQL): `app.audit_log`, `app.audit_chain()` (BEFORE INSERT on `audit_log`), `app.audit_row()` (the generic row trigger; arguments `mode` ∈ `tenant_column | self_id | current_tenant`, `key_cols` = comma-separated key columns or `''`), `app_meta.attach_audit(tbl regclass, mode text, key_cols text)`.
- Attaches `audit_row` to every table created so far except the exempt ones (`permission`, `ledger_entry`, `ledger_entry_dimension`, `audit_log`). Task 10 attaches it to `pos_terminal`; `idempotency_key` is exempt.
- Consumes: Task 8's `app.forbid_change()`; Task 7's fixtures.

- [ ] **Step 1: Write the failing test `packages/db/test/audit.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

interface AuditRow { seq: number; actor_id: string; table_name: string; row_id: string; action: string; before: unknown; after: { code?: string } | null }

/** The nightly integrity job's chain walk (spec §3.8, acceptance test 13). Returns broken links and bad hashes. */
async function verifyChain(tx: Sql, tenantId: string): Promise<{ broken_links: number; bad_hashes: number; rows: number }> {
  const [r] = await tx<{ broken_links: number; bad_hashes: number; rows: number }[]>`
    with ordered as (
      select *, lag(hash) over (order by seq) as expected_prev from app.audit_log where tenant_id = ${tenantId})
    select count(*)::int as rows,
           count(*) filter (where prev_hash is distinct from expected_prev)::int as broken_links,
           count(*) filter (where hash <> sha256(coalesce(prev_hash, ''::bytea) || convert_to(
             tenant_id::text || '|' || actor_id::text || '|' || extract(epoch from occurred_at)::text || '|'
             || table_name || '|' || row_id || '|' || action || '|'
             || coalesce(before::text, '') || '|' || coalesce(after::text, ''), 'UTF8')))::int as bad_hashes
      from ordered`;
  return r!;
}

describe("audit log — spec §3.8 (LEGACY-029, 030, 040); acceptance test 13", () => {
  let db: Db; let a: Seed;
  beforeAll(async () => { db = await startDb(); a = await seedTenant(db, "Alpha"); });
  afterAll(async () => { await db.stop(); });

  const auditFor = (tenant: string, table: string) => withTenant(db.rw, tenant, a.system, (tx) =>
    tx<AuditRow[]>`select seq, actor_id, table_name, row_id, action, before, after from app.audit_log where tenant_id = ${tenant} and table_name = ${table} order by seq`);

  it("the seed itself was audited, including the system principal citing itself as actor (AFTER ROW ordering)", async () => {
    const rows = await auditFor(a.tenant, "principal");
    expect(rows.length).toBe(2);
    expect(rows[0]!.actor_id).toBe(a.system);
    expect(rows[0]!.action).toBe("insert");
    const tenantRows = await auditFor(a.tenant, "tenant");
    expect(tenantRows.map((r) => r.row_id)).toEqual([a.tenant]);   // self_id mode: tenant.id is the tenant
  });

  it("an insert and an update by app_rw produce one row each, with the session actor and before/after images", async () => {
    const companyId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${companyId}, ${a.tenant}, 'BR1', 'Branch 1', 'MYR')`;
      await tx`update app.company set name = 'Branch One' where id = ${companyId}`;
    });
    const rows = (await auditFor(a.tenant, "company")).filter((r) => r.row_id === companyId);
    expect(rows.map((r) => [r.action, r.actor_id])).toEqual([["insert", a.human], ["update", a.human]]);
    expect(rows[0]!.before).toBeNull();
    expect((rows[1]!.before as { name: string }).name).toBe("Branch 1");
    expect((rows[1]!.after as { name: string }).name).toBe("Branch One");
  });

  it("composite-key tables record the key as row_id", async () => {
    const rows = await auditFor(a.tenant, "membership");
    expect(rows.map((r) => r.row_id).sort()).toEqual([`${a.tenant}/${a.system}`, `${a.tenant}/${a.human}`].sort());
  });

  it("a write with a tenant but no actor on the transaction is rejected — there are no anonymous writes", async () => {
    await expect(db.rw.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'ANON', 'Anon', 'MYR')`;
    })).rejects.toThrow(/null value in column "actor_id"/);
  });

  it("ledger entries are exempt: posting produces no audit rows for ledger_entry", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id) values
      (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash},  10, 0, 'MYR', 1, 10, 0, '2026-01-15', ${a.period}, ${a.policy}),
      (${a.tenant}, ${a.company}, ${doc}, 2, ${a.sales}, 0, 10, 'MYR', 1, 0, 10, '2026-01-15', ${a.period}, ${a.policy})`);
    expect(await auditFor(a.tenant, "ledger_entry")).toEqual([]);
    expect((await auditFor(a.tenant, "document")).some((r) => r.row_id === doc)).toBe(true);   // the document itself IS audited
  });

  it("the hash chain verifies end to end, and a second tenant's chain is independent", async () => {
    const b = await seedTenant(db, "Beta");
    const ra = await withTenant(db.rw, a.tenant, a.system, (tx) => verifyChain(tx, a.tenant));
    const rb = await withTenant(db.rw, b.tenant, b.system, (tx) => verifyChain(tx, b.tenant));
    expect(ra.rows).toBeGreaterThan(10);
    expect(ra).toMatchObject({ broken_links: 0, bad_hashes: 0 });
    expect(rb).toMatchObject({ broken_links: 0, bad_hashes: 0 });
    const [first] = await withTenant(db.rw, b.tenant, b.system, (tx) => tx<{ prev_hash: Buffer | null }[]>`select prev_hash from app.audit_log where tenant_id = ${b.tenant} order by seq limit 1`);
    expect(first!.prev_hash).toBeNull();   // a tenant's chain starts at its own genesis
  });

  it("actor columns are stamped from the session, never taken from the statement (LEGACY-044)", async () => {
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, branch_id, created_by)
      values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', ${a.period}, '2026-01-15', 'MYR', ${a.hq}, ${a.system})`);   // claims the system principal
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ created_by: string }[]>`select created_by from app.document where id = ${doc}`);
    expect(row!.created_by).toBe(a.human);   // overwritten with the real actor
    await expect(withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set created_by = ${a.system} where id = ${doc}`)).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
    await withTenant(db.rw, a.tenant, a.human, (tx) => tx`update app.document set posted_by = ${a.system}, posted_at = now() where id = ${doc}`);   // NULL → value: stamped, not trusted
    const [p] = await withTenant(db.rw, a.tenant, a.human, (tx) => tx<{ posted_by: string }[]>`select posted_by from app.document where id = ${doc}`);
    expect(p!.posted_by).toBe(a.human);
  });

  it("audit rows cannot be updated or deleted — trigger for the owner, missing privilege for app_rw", async () => {
    await expect(withTenant(db.migrator, a.tenant, a.system, (tx) => tx`update app.audit_log set action = 'insert' where tenant_id = ${a.tenant}`)).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(db.migrator, a.tenant, a.system, (tx) => tx`delete from app.audit_log where tenant_id = ${a.tenant}`)).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(withTenant(db.rw, a.tenant, a.system, (tx) => tx`delete from app.audit_log where tenant_id = ${a.tenant}`)).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/audit.test.ts`
Expected: FAIL — `app.audit_log` does not exist.

- [ ] **Step 3: Append section 8 to `0001_foundations.sql`**

```sql
-- ── 8. Audit log: append-only, server-supplied actor, hash-chained (LEGACY-029, 030, 040) ─────────────────
create table app.audit_log (
  seq          bigint generated always as identity primary key,
  tenant_id    uuid not null references app.tenant(id),
  actor_id     uuid not null default app.current_actor() references app.principal(id) deferrable initially deferred,
               -- NOT NULL is immediate (no anonymous writes); the FK is checked at COMMIT so the bootstrap's tenant row, audited
               -- before its system principal exists, can cite that principal as actor (verified on PG 18)
  occurred_at  timestamptz not null default now(),
  table_name   text not null,
  row_id       text not null,                 -- text: join tables have composite keys
  action       text not null check (action in ('insert', 'update', 'delete')),
  before       jsonb,
  after        jsonb,
  prev_hash    bytea,
  hash         bytea not null
);
call app_meta.enable_tenant_rls('app.audit_log');
create index audit_log_tenant_seq_idx on app.audit_log (tenant_id, seq desc);   -- the chain lookup must not walk the whole PK
create trigger audit_log_immutable before update or delete on app.audit_log
  for each row execute function app.forbid_change();

-- The chain must not fork. ONE per-tenant transaction-scoped advisory lock — 'tenant-serial:<tenant>' — is taken here AND by
-- the catalogue-revision trigger (§3.7.3, Phase 6), so the two can never deadlock with each other. Correct only at READ
-- COMMITTED: after acquiring the lock, the SELECT must see the previous holder's committed row, which a REPEATABLE READ
-- snapshot would hide. withTenant() pins READ COMMITTED. Cost: audited writes for one tenant serialise for the transaction's
-- duration — which is why long jobs run as short transactions and why derived/immutable tables are audit-exempt.
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
      || coalesce(new.before::text, '') || '|' || coalesce(new.after::text, ''), 'UTF8'));
  return new;
end $$;
create trigger audit_log_chain before insert on app.audit_log
  for each row execute function app.audit_chain();
-- Verification (nightly job + acceptance test 13): walk rows by seq per tenant; each prev_hash must equal the previous
-- row's hash and each hash must recompute. Any mismatch is an incident, not a warning.

-- Generic row-audit trigger. AFTER ROW, not BEFORE: the bootstrap's system principal is the actor of its own audit row,
-- and audit_log.actor_id → principal(id) is checked at the end of the audit INSERT, which must therefore run after the
-- principal row exists. Arguments: tg_argv[0] = mode ('tenant_column' | 'self_id' | 'current_tenant'),
-- tg_argv[1] = comma-separated key columns for composite-key tables, or ''. actor_id and hash come from the defaults and
-- the chain trigger — there is no parameter to forge and no flag to skip.
create function app.audit_row() returns trigger language plpgsql as $$
declare
  rec       jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_mode    text  := coalesce(tg_argv[0], 'tenant_column');
  v_keys    text  := coalesce(tg_argv[1], '');
  v_tenant  uuid;
  v_row_id  text;
begin
  v_tenant := case v_mode
    when 'self_id'        then (rec ->> 'id')::uuid          -- app.tenant: the row IS the tenant
    when 'current_tenant' then app.current_tenant()          -- global tables without tenant_id (app.principal)
    else                       (rec ->> 'tenant_id')::uuid   -- every tenant-scoped table
  end;
  if v_keys <> '' then
    select string_agg(rec ->> k, '/' order by ord) into v_row_id
      from unnest(string_to_array(v_keys, ',')) with ordinality as t(k, ord);
  else
    v_row_id := rec ->> 'id';
  end if;
  insert into app.audit_log (tenant_id, table_name, row_id, action, before, after)
  values (v_tenant, tg_table_name, v_row_id, lower(tg_op),
          case when tg_op = 'INSERT' then null else to_jsonb(old) end,
          case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return null;
end $$;

-- Migration-only helper (app_meta, unreachable from application code): attach the generic trigger to one table.
create procedure app_meta.attach_audit(tbl regclass, mode text default 'tenant_column', key_cols text default '')
language plpgsql as $$
begin
  execute format(
    'create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_row(%L, %L)',
    tbl, mode, key_cols);
end $$;

-- Attach to every audited table created so far. Exempt (immutable or derived): ledger_entry, ledger_entry_dimension,
-- audit_log; exempt (seeded catalogue): permission. Document status transitions ARE audited (document is listed).
call app_meta.attach_audit('app.tenant',               'self_id');
call app_meta.attach_audit('app.principal',            'current_tenant');
call app_meta.attach_audit('app.membership',           'tenant_column', 'tenant_id,principal_id');
call app_meta.attach_audit('app.company');
call app_meta.attach_audit('app.role');
call app_meta.attach_audit('app.role_permission',      'tenant_column', 'role_id,permission_code');
call app_meta.attach_audit('app.role_assignment',      'tenant_column', 'principal_id,role_id,company_id');
call app_meta.attach_audit('app.role_assignment_branch','tenant_column', 'principal_id,role_id,company_id,branch_id');
call app_meta.attach_audit('app.fiscal_period');
call app_meta.attach_audit('app.account');
call app_meta.attach_audit('app.document_type');
call app_meta.attach_audit('app.posting_policy');
call app_meta.attach_audit('app.document_series',      'tenant_column', 'company_id,series,fiscal_period_id');
call app_meta.attach_audit('app.document_number_void', 'tenant_column', 'company_id,series,fiscal_period_id,number');
call app_meta.attach_audit('app.document');
call app_meta.attach_audit('app.dimension_type');
call app_meta.attach_audit('app.dimension_value');

grant select, insert on app.audit_log to app_rw;   -- no update, no delete: immutable

-- Actor columns are never trusted (LEGACY-044): a DEFAULT is not a control — direct SQL can supply any value. stamp_actor()
-- OVERWRITES the named column with app.current_actor() on INSERT and forbids changing it on UPDATE.
-- Semantics: on INSERT a supplied value is replaced with the session actor (a NULL stays NULL — posted_by / closed_by are set later);
-- on UPDATE a NULL → value transition is stamped with the session actor; any change to a non-null value raises.
create function app.stamp_actor() returns trigger language plpgsql as $$
declare col text := tg_argv[0]; oldv text; newv text;
begin
  newv := to_jsonb(new) ->> col;
  if tg_op = 'INSERT' then
    if newv is not null then
      new := jsonb_populate_record(new, jsonb_build_object(col, app.current_actor()));
    end if;
  else
    oldv := to_jsonb(old) ->> col;
    if oldv is null and newv is not null then
      new := jsonb_populate_record(new, jsonb_build_object(col, app.current_actor()));
    elsif oldv is not null and newv is distinct from oldv then
      raise exception 'ERR_ACTOR_IMMUTABLE: % cannot be changed', col using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create procedure app_meta.attach_stamp(tbl regclass, col text) language plpgsql as $$
begin
  execute format('create trigger stamp_%s before insert or update on %s for each row execute function app.stamp_actor(%L)', col, tbl, col);
end $$;
call app_meta.attach_stamp('app.role_assignment',      'granted_by');
call app_meta.attach_stamp('app.document_number_void', 'voided_by');
call app_meta.attach_stamp('app.document',             'created_by');
call app_meta.attach_stamp('app.document',             'posted_by');    -- NULL while draft; stamped on the NULL → value transition at post
call app_meta.attach_stamp('app.fiscal_period',        'closed_by');    -- likewise at close
call app_meta.attach_stamp('app.ledger_entry',         'posted_by');
```

- [ ] **Step 4: Prepend to `0001.down.sql`**

```sql
drop procedure if exists app_meta.attach_stamp(regclass, text);
drop function  if exists app.stamp_actor() cascade;     -- cascade removes every stamp_* trigger
drop procedure if exists app_meta.attach_audit(regclass, text, text);
drop function  if exists app.audit_row() cascade;      -- cascade removes every audit_row trigger
drop table     if exists app.audit_log;
drop function  if exists app.audit_chain();
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/db && bun run test`
Expected: audit.test.ts 8 passed (the actor-stamp test asserts created_by overwritten, created_by immutable, and posted_by stamped on the NULL → value transition); every earlier suite still green (they now run with auditing attached — if `identity.test.ts` fails on the tenant insert with `audit_log_actor_id_fkey`, the actor FK lost its `deferrable initially deferred`; if it fails on the system principal insert, the trigger was created BEFORE instead of AFTER).

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 5 — hash-chained append-only audit log with generic AFTER ROW trigger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Migration 0001, part 6 — POS terminals, idempotency keys, the privileges block, and the up → down → up proof

**Files:**
- Modify: `packages/db/migrations/0001_foundations.sql` (append section 9 — the final section), `packages/db/migrations/0001.down.sql` (prepend drops)
- Test: `packages/db/test/privileges.test.ts`

**Interfaces:**
- Produces (SQL): `app.pos_terminal`, `app.idempotency_key`; the final grant/revoke block for `app_rw`.
- Produces (test): `schemaFingerprint(sql): Promise<string>` — a deterministic text dump of tables, columns, constraints, indexes, policies, triggers and functions in schema `app`, used by CI's reversibility check.

- [ ] **Step 1: Write the failing test `packages/db/test/privileges.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { down, up } from "../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";

/** Deterministic description of schema app — what `pg_dump --schema-only -n app` would show, without needing pg_dump on the host. */
export async function schemaFingerprint(sql: Sql): Promise<string> {
  const parts = await Promise.all([
    sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'app' order by 1, 2`,
    sql`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'app'::regnamespace order by 1, 2`,
    sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'app' order by 1, 2`,
    sql`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'app' order by 1, 2`,
    sql`select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'app'::regnamespace) order by 1, 2`,
    sql`select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef from pg_proc p where p.pronamespace = 'app'::regnamespace order by 1`,
    sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind = 'r' order by 1`,
  ]);
  return JSON.stringify(parts);
}

describe("privileges and reversibility — spec §3.8 grants block, §3.9 migrations", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  async function grantsFor(table: string): Promise<string[]> {
    const rows = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = ${table} order by 1`;
    return rows.map((r) => r.privilege_type);
  }

  it("immutable tables: app_rw may SELECT and INSERT only", async () => {
    for (const t of ["ledger_entry", "ledger_entry_dimension", "audit_log"]) {
      expect(await grantsFor(t), t).toEqual(["INSERT", "SELECT"]);
    }
  });

  it("app_rw may DELETE only from idempotency_key and the two RBAC join tables, and has no TRUNCATE/REFERENCES/TRIGGER anywhere", async () => {
    const rows = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`;
    expect(rows).toEqual([
      { table_name: "idempotency_key", privilege_type: "DELETE" },
      { table_name: "role_assignment_branch", privilege_type: "DELETE" },
      { table_name: "role_permission", privilege_type: "DELETE" },
    ]);
  });

  it("every table in schema app has RLS enabled and forced, except the global catalogue permission (which has no tenant column)", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'app'::regnamespace and relkind = 'r' order by 1`;
    for (const r of rows) {
      if (r.relname === "permission") { expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([false, false]); continue; }
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    }
  });

  it("app_rw cannot reach app_meta, cannot create objects in app, and cannot bypass RLS", async () => {
    await expect(db.rw`select * from app_meta.schema_migration`).rejects.toThrow(/permission denied/);
    await expect(db.rw`create table app.rogue (id int)`).rejects.toThrow(/permission denied/);
    await expect(db.rw`alter role app_rw bypassrls`).rejects.toThrow(/permission denied|must be superuser|must have/);
  });

  it("up → down → up reproduces the schema byte for byte (task 0.3 acceptance; §3.9 'reversible')", async () => {
    const before = await schemaFingerprint(db.admin);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([1]);
    const [n] = await db.admin<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
    expect(n!.n).toBe(0);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual([1]);
    expect(await schemaFingerprint(db.admin)).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/privileges.test.ts`
Expected: FAIL — `idempotency_key` does not exist, and `app_rw` still holds UPDATE on tables where Tasks 5–9 granted it broadly.

- [ ] **Step 3: Append section 9 to `0001_foundations.sql`**

```sql
-- ── 9. POS terminals, idempotency keys, and the privileges block ────────────────────────────────────────
-- A terminal is a principal of kind 'terminal' (§3.7.5): a real audit identity and a valid posted_by.
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
call app_meta.enable_tenant_rls('app.pos_terminal');
call app_meta.attach_audit('app.pos_terminal');
call app_meta.attach_stamp('app.pos_terminal', 'enrolled_by');

-- Idempotency keys for every unsafe API call (§4.5, §3.7.3). Audit-exempt (derived request state), and the ONE table
-- app_rw may delete from: expired keys.
create table app.idempotency_key (
  tenant_id      uuid not null references app.tenant(id),
  principal_id   uuid not null references app.principal(id),   -- human, system or terminal
  key            text not null,               -- the Idempotency-Key header
  request_hash   bytea not null,              -- sha256 of method+path+body; same key + different hash → 409
  response_code  int,                         -- null while in flight → a concurrent duplicate gets 409 + Retry-After
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours',
  primary key (tenant_id, principal_id, key)
);
call app_meta.enable_tenant_rls('app.idempotency_key');

-- ── Privileges for the application role — restated in one place so the earlier per-section grants are irrelevant ──
revoke all on all tables in schema app from app_rw;
grant select, insert, update on all tables in schema app to app_rw;
revoke update, delete on app.ledger_entry, app.ledger_entry_dimension, app.audit_log from app_rw;   -- immutable
revoke insert, update on app.permission from app_rw;                                                -- seeded catalogue: read-only for the app
grant delete on app.idempotency_key, app.role_permission, app.role_assignment_branch to app_rw;     -- expired keys; join rows (audited before-image; forbid_self_grant guards both)
alter default privileges for role app_migrator in schema app grant select, insert, update on tables to app_rw;
-- Every future immutable table must repeat the revoke; the 0.4 linter (Task 11) checks that every table in the IMMUTABLE
-- list (ledger_entry, ledger_entry_dimension, inventory_movement, document_event, audit_log) has no update/delete privilege for app_rw.
-- Derived tables (account_balance, cost_layer, cost_consumption — later phases) are audit-exempt but MUST stay updatable
-- by app_rw: the posting service MERGEs into them. The immutable list and the audit-exempt list are not the same list.
```

- [ ] **Step 4: Prepend to `0001.down.sql`**

```sql
-- Default privileges depend on the schema: without this line `drop schema app` (last line of this file) fails with
-- "cannot drop schema app because other objects depend on it".
alter default privileges for role app_migrator in schema app revoke select, insert, update on tables from app_rw;
drop table if exists app.idempotency_key;
drop table if exists app.pos_terminal;
```

The complete `0001.down.sql` now reads, top to bottom: Task 10's three statements (default-privilege revoke, two drops), Task 9's six lines, Task 8's five lines, Task 7's ten lines (two constraint drops, then eight drops), Task 6's sixteen lines (one constraint drop, then fifteen drops), then Task 5's eleven statements (the `resolve_principal` drop, two policy drops, then eight drops) ending in `drop schema if exists app;`. Read it once end to end and confirm every object created in the up file has a drop — the one deliberate exception is the `btree_gist` extension (see the comment at the end of Task 5's block) — `down()` itself throws on a dependency it cannot resolve, and the fingerprint test catches a silent omission.

- [ ] **Step 5: Run the whole suite**

Run: `cd packages/db && bun run test`
Expected: privileges.test.ts 5 passed; all eight suites green. A `down` line that is missing or out of order fails `down()` itself with a dependency error naming the object; a silent omission that still lets `down()` finish fails the fingerprint compare, whose message names the first differing catalog entry.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): migration 0001 part 6 — POS terminals, idempotency keys, app_rw privileges; up/down/up proven

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The CI schema linter (spec task 0.4)

**Files:**
- Create: `packages/db/src/lint-schema.ts`
- Modify: `packages/db/src/cli.ts` (add the `lint` command), `packages/db/src/index.ts`
- Test: `packages/db/test/schema-lint.test.ts`

**Interfaces:**
- Produces: `lintSchema(sql: Sql): Promise<Violation[]>` with `Violation = { table: string; rule: string; detail: string }`. Rules, stated exactly from spec §3.8:
  - `tenant_id` — every table except `tenant`, `principal`, `permission` has a `tenant_id` column.
  - `rls_enabled`, `rls_forced`, `tenant_isolation_policy` — the same tables have RLS enabled, forced, and a policy named `tenant_isolation`.
  - `id_column`, `created_at` — every table except the join/counter tables (`membership`, `role_permission`, `role_assignment`, `role_assignment_branch`, `ledger_entry_dimension`, `document_series`, `document_number_void`, `idempotency_key`), `audit_log` (keyed by `seq`, timestamped by `occurred_at`) and `permission` (keyed by `code`) has `id` and `created_at`; `ledger_entry` is exempt from `created_at` only (its timestamp is `posted_at`).
  - `extra_permissive_policy` — every permissive policy is one of the standard tenant policies or is scoped to `app_auth`; any other policy (a permission or branch gate) must be `AS RESTRICTIVE`, because permissive policies OR together (LEGACY-033).
  - `stamp_actor` — every `*_by` column has a `stamp_<col>` trigger (LEGACY-044).
  - `composite_fk` — every FK whose referenced table is tenant-scoped includes `tenant_id` in its column list.
  - `audit_trigger` — every table not in the audit-exempt list carries a trigger named `audit_row`.
  - `immutable_privileges`, `immutable_trigger` — every table in the immutable list has no UPDATE/DELETE for `app_rw` and has a `*_immutable` trigger.
- The two lists live in this file and are the single source of truth for later migrations:
  `AUDIT_EXEMPT = ledger_entry, ledger_entry_dimension, inventory_movement, document_event, audit_log, account_balance, cost_layer, cost_consumption, employee_ytd, idempotency_key, permission`;
  `IMMUTABLE = ledger_entry, ledger_entry_dimension, inventory_movement, document_event, audit_log` (`document_event` and `employee_ytd` are forward declarations for Phases 2 and 8).

- [x] **Step 1: Write the failing test `packages/db/test/schema-lint.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { startDb, type Db } from "./harness";

describe("schema linter — spec task 0.4", () => {
  let db: Db;
  beforeAll(async () => { db = await startDb(); });
  afterAll(async () => { await db.stop(); });

  it("the shipped schema has zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a bare table is reported by name, once per broken rule, and the transaction is rolled back", async () => {
    await db.migrator.begin(async (tx) => {
      await tx`create table app.rogue (id int)`;
      const v = await lintSchema(tx as never);
      const rogue = v.filter((x) => x.table === "rogue").map((x) => x.rule).sort();
      expect(rogue).toEqual(["audit_trigger", "created_at", "rls_enabled", "rls_forced", "tenant_id", "tenant_isolation_policy"]);   // `id int` satisfies id_column; no *_by column
      expect(v.filter((x) => x.table !== "rogue")).toEqual([]);
      throw new Error("rollback");   // begin() rolls back on throw; the catch below swallows our own marker
    }).catch(() => undefined);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a plain FK to a tenant-scoped parent is a composite_fk violation; a plain FK to a global table is not", async () => {
    await db.migrator.begin(async (tx) => {
      await tx`create table app.child (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id),
                 company_id uuid references app.company(id), principal_id uuid references app.principal(id), created_at timestamptz not null default now())`;
      const v = (await lintSchema(tx as never)).filter((x) => x.table === "child");
      expect(v.filter((x) => x.rule === "composite_fk").map((x) => x.detail)).toEqual([
        expect.stringContaining("company"),
      ]);
      throw new Error("rollback");
    }).catch(() => undefined);
  });

  it("a permissive gate policy and an unstamped actor column are reported", async () => {
    await db.migrator.begin(async (tx) => {
      await tx`create policy leaky_gate on app.company using (true)`;
      await tx`create table app.gadget (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), approved_by uuid, created_at timestamptz not null default now())`;
      const v = await lintSchema(tx as never);
      expect(v.filter((x) => x.table === "company").map((x) => x.rule)).toEqual(["extra_permissive_policy"]);
      expect(v.filter((x) => x.table === "gadget").map((x) => x.rule)).toContain("stamp_actor");
      throw new Error("rollback");
    }).catch(() => undefined);
  });

  it("an app_rw UPDATE grant on an immutable table is reported", async () => {
    await db.migrator.begin(async (tx) => {
      await tx`grant update on app.ledger_entry to app_rw`;
      const v = (await lintSchema(tx as never)).filter((x) => x.table === "ledger_entry");
      expect(v.map((x) => x.rule)).toEqual(["immutable_privileges"]);
      throw new Error("rollback");
    }).catch(() => undefined);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/db && bun run test -- test/schema-lint.test.ts`
Expected: FAIL — `../src/lint-schema` does not exist.

- [x] **Step 3: Write `packages/db/src/lint-schema.ts`**

```ts
import type { Sql } from "postgres";

export interface Violation { table: string; rule: string; detail: string }

/** Global catalogues without tenant_id (spec §3.8 linter rules). */
const GLOBAL_TABLES = new Set(["tenant", "principal", "permission"]);
/** Join and counter tables that legitimately lack id/created_at, plus audit_log (seq/occurred_at) and permission (code). */
const NO_ID_TABLES = new Set([
  "membership", "role_permission", "role_assignment", "role_assignment_branch", "ledger_entry_dimension",
  "document_series", "document_number_void", "idempotency_key", "audit_log", "permission",
]);
/** Tables whose row timestamp is not named created_at (ledger_entry: posted_at is the posting instant, never updated). */
const NO_CREATED_AT_TABLES = new Set([...NO_ID_TABLES, "ledger_entry"]);
/** The permissive policies allowed on tenant-scoped or global tables; every other policy must be RESTRICTIVE (spec §3.8). */
const ALLOWED_PERMISSIVE = new Set(["tenant_isolation", "tenant_self", "principal_in_tenant", "principal_update_in_tenant", "principal_insert"]);
/** Immutable or derived — no audit_row trigger. NOT the same list as IMMUTABLE (spec v1.1 fix #5). */
export const AUDIT_EXEMPT = new Set([
  "ledger_entry", "ledger_entry_dimension", "inventory_movement", "document_event", "audit_log",
  "account_balance", "cost_layer", "cost_consumption", "employee_ytd", "idempotency_key", "permission",
]);
/** Append-only: app_rw must hold no UPDATE/DELETE and a *_immutable trigger must exist. */
export const IMMUTABLE = new Set(["ledger_entry", "ledger_entry_dimension", "inventory_movement", "document_event", "audit_log"]);

interface TableRow { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }
interface FkRow { tbl: string; conname: string; ref: string; cols: string[] }

export async function lintSchema(sql: Sql): Promise<Violation[]> {
  const [tables, columns, policies, triggers, grants, fks] = await Promise.all([
    sql<TableRow[]>`select relname, relrowsecurity, relforcerowsecurity from pg_class
                     where relnamespace = 'app'::regnamespace and relkind = 'r' order by 1`,
    sql<{ table_name: string; column_name: string }[]>`select table_name, column_name from information_schema.columns where table_schema = 'app'`,
    sql<{ tablename: string; policyname: string; permissive: string; roles: string[] }[]>`select tablename, policyname, permissive, roles from pg_policies where schemaname = 'app'`,
    sql<{ tbl: string; tgname: string }[]>`select c.relname as tbl, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
                                           where not t.tgisinternal and c.relnamespace = 'app'::regnamespace`,
    sql<{ table_name: string; privilege_type: string }[]>`select table_name, privilege_type from information_schema.role_table_grants
                                                         where grantee = 'app_rw' and table_schema = 'app'`,
    sql<FkRow[]>`select c.conrelid::regclass::text as tbl, c.conname, c.confrelid::regclass::text as ref,
                        (select array_agg(a.attname::text order by k.ord)
                           from unnest(c.conkey) with ordinality as k(attnum, ord)
                           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
                   from pg_constraint c where c.contype = 'f' and c.connamespace = 'app'::regnamespace`,
  ]);

  const colsOf = (t: string) => new Set(columns.filter((c) => c.table_name === t).map((c) => c.column_name));
  const hasTrigger = (t: string, pred: (name: string) => boolean) => triggers.some((x) => x.tbl === t && pred(x.tgname));
  const v: Violation[] = [];

  for (const t of tables) {
    const name = t.relname;
    const cols = colsOf(name);
    if (!GLOBAL_TABLES.has(name)) {
      if (!cols.has("tenant_id")) v.push({ table: name, rule: "tenant_id", detail: "missing tenant_id column (spec §0.2 Always)" });
      if (!t.relrowsecurity) v.push({ table: name, rule: "rls_enabled", detail: "row level security is not enabled" });
      if (!t.relforcerowsecurity) v.push({ table: name, rule: "rls_forced", detail: "FORCE ROW LEVEL SECURITY is not set" });
      if (!policies.some((p) => p.tablename === name && p.policyname === "tenant_isolation")) {
        v.push({ table: name, rule: "tenant_isolation_policy", detail: "no policy named tenant_isolation" });
      }
    }
    if (!NO_ID_TABLES.has(name) && !cols.has("id")) v.push({ table: name, rule: "id_column", detail: "missing id uuid column" });
    if (!NO_CREATED_AT_TABLES.has(name) && !cols.has("created_at")) v.push({ table: name, rule: "created_at", detail: "missing created_at column" });
    for (const p of policies.filter((x) => x.tablename === name)) {
      const roleScoped = p.roles.includes("app_auth") && !p.roles.includes("app_rw") && !p.roles.includes("public");
      if (p.permissive === "PERMISSIVE" && !ALLOWED_PERMISSIVE.has(p.policyname) && !roleScoped) {
        v.push({ table: name, rule: "extra_permissive_policy", detail: `${p.policyname} is PERMISSIVE — a gate must be AS RESTRICTIVE, or it is OR-ed away by tenant_isolation (LEGACY-033)` });
      }
    }
    for (const c of cols) {
      if (c.endsWith("_by") && !hasTrigger(name, (n) => n === `stamp_${c}`)) {
        v.push({ table: name, rule: "stamp_actor", detail: `${c} has no stamp_${c} trigger — a DEFAULT is not a control (LEGACY-044)` });
      }
    }
    if (!AUDIT_EXEMPT.has(name) && !hasTrigger(name, (n) => n === "audit_row")) {
      v.push({ table: name, rule: "audit_trigger", detail: "no audit_row trigger and not in AUDIT_EXEMPT" });
    }
    if (IMMUTABLE.has(name)) {
      const held = grants.filter((g) => g.table_name === name && (g.privilege_type === "UPDATE" || g.privilege_type === "DELETE"));
      if (held.length > 0) v.push({ table: name, rule: "immutable_privileges", detail: `app_rw holds ${held.map((g) => g.privilege_type).join(", ")}` });
      if (!hasTrigger(name, (n) => n.endsWith("_immutable"))) v.push({ table: name, rule: "immutable_trigger", detail: "no *_immutable trigger" });
    }
  }

  for (const fk of fks) {
    const ref = fk.ref.replace(/^app\./, "");
    if (GLOBAL_TABLES.has(ref)) continue;                       // plain FKs to global catalogues are fine
    if (!fk.cols.includes("tenant_id")) {
      v.push({ table: fk.tbl.replace(/^app\./, ""), rule: "composite_fk",
               detail: `${fk.conname} → ${fk.ref}(${fk.cols.join(", ")}) does not include tenant_id (spec §3.8: FK checks bypass RLS)` });
    }
  }
  return v.sort((x, y) => x.table.localeCompare(y.table) || x.rule.localeCompare(y.rule));
}
```

- [x] **Step 4: Add the `lint` command to `cli.ts` and export from `index.ts`**

In `packages/db/src/cli.ts`, add the import and a branch:

```ts
import { lintSchema } from "./lint-schema";
// … inside the try block, before the usage line:
  else if (cmd === "lint") {
    const v = await lintSchema(sql);
    if (v.length > 0) { console.error(JSON.stringify(v, null, 2)); process.exit(1); }
    console.log("schema lint: 0 violations");
  }
```

and change the usage string to `"usage: cli.ts up | down [toVersion] | status | lint"`.

`packages/db/src/index.ts`:

```ts
export { discover, down, listApplied, up, type Migration } from "./migrate";
export { AUDIT_EXEMPT, IMMUTABLE, lintSchema, type Violation } from "./lint-schema";
```

- [x] **Step 5: Run the tests and the toolchain**

Run: `cd packages/db && bun run test && cd ../.. && bun run lint && bun run typecheck`
Expected: schema-lint.test.ts 5 passed; nine suites green; lint and typecheck exit 0.

If the first test reports a `composite_fk` violation on `ledger_entry_dimension.entry_id`, Task 8's composite form (`foreign key (tenant_id, entry_id) references app.ledger_entry(tenant_id, id)`) was not applied — fix the migration, not the linter.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): CI schema linter — tenant_id, RLS, composite FKs, audit and immutability rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: CI on every pull request, CONTRIBUTING.md, PR template, Phase 0A exit check

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `CONTRIBUTING.md`
- Modify: `CLAUDE.md` (mark Plan 0A done; point at 0B/0C)

**Interfaces:**
- Produces: the CI gate every later PR passes through — lint, format, typecheck, and the Testcontainers suite (which is the migration up → down → up check and the schema linter in one).

- [x] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  checks:
    runs-on: ubuntu-latest          # Docker is preinstalled; Testcontainers uses it
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run format:check
      - run: bun run typecheck
      - run: bun run test
        env:
          TESTCONTAINERS_RYUK_DISABLED: "true"   # GitHub runners are ephemeral; Ryuk adds startup time for nothing
```

- [x] **Step 2: Write `.github/pull_request_template.md`** (spec §4.11 definition of done)

```markdown
## What and why
<!-- one paragraph; link the spec section or ADR this implements -->

## Phase gate
- [ ] This PR belongs to the phase named in `CLAUDE.md` ("Current phase") — nothing from a later phase.

## Definition of done (spec §4.11)
- [ ] Tests added or updated (`tests/regression/legacy-NNN.test.ts` for every Part I defect this touches)
- [ ] Migration is reversible: `NNNN.down.sql` exists and CI's up → down → up passed
- [ ] OpenAPI updated if the API changed
- [ ] Both text directions checked if the UI changed
- [ ] No new `⚠️` left unresolved in code without a linked issue
- [ ] Any decision not in the spec's §0.3 has an ADR under `docs/adr/`
```

- [x] **Step 3: Write `CONTRIBUTING.md` — §0.2 and §3.9 verbatim**

Extract the two sections from the spec by heading so nothing is retyped. From the repo root:

```bash
{
  echo "# Contributing to Dulja"
  echo
  echo "The two sections below are copied verbatim from \`docs/spec/rebuild-spec.md\` (v1.2). If they drift, the spec wins — re-run the extraction in Plan 0A Task 12 Step 3."
  echo
  awk '/^## 0\.2 Operating brief/{p=1} /^## 0\.3 /{p=0} p' docs/spec/rebuild-spec.md
  echo
  awk '/^## 3\.9 Engineering conventions/{p=1} /^# PART IV/{p=0} p' docs/spec/rebuild-spec.md
} > CONTRIBUTING.md
```

Expected: `CONTRIBUTING.md` contains the heading "0.2 Operating brief for the implementing agent" and the heading "3.9 Engineering conventions", and ends with the Logging paragraph of §3.9. Open it and confirm the two sections are complete and nothing else was captured.

- [x] **Step 4: Update `CLAUDE.md` — current phase**

Replace the "Current phase" section with:

```markdown
## Current phase
**Phase 0 — Foundations.** Plan 0A (`docs/superpowers/plans/2026-09-04-dulja-phase-0-foundations.md`) is complete: monorepo, migration 0001, schema linter, CI.
Next: Plan 0B (identity, tenant transactions, errors, idempotency, permission catalogue), then 0D (`Money`, currency, dimensions, pg-boss), 0C (Supabase, Cloudflare, bootstrap seed, observability) and 0E (Electron and i18n shell, back office). All of them, and every phase after, are already written: see the plan catalogue and the frozen cross-plan contracts in `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md`.
Phase 0 exits only when every §5.0 row is green and acceptance tests 12, 13, 14 pass in CI.
```

- [x] **Step 5: Run everything one last time, then push and open the PR**

```bash
bun run lint && bun run format:check && bun run typecheck && bun run test
```

Expected: all green; the db suite reports nine files passed.

```bash
git add -A
git commit -m "ci: GitHub Actions gate, PR template, CONTRIBUTING from spec §0.2/§3.9

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then — **only if the owner has created the GitHub repository and asked for it to be pushed** — add the remote, push `main`, and confirm the `ci` workflow runs green on GitHub. Pushing is the owner's call; it is not part of this plan's definition of done.

- [x] **Step 6: Plan 0A exit check**

All of the following hold, or the plan is not done:

| Check | Where proven |
|---|---|
| `bun run lint` fails on a deliberate `console.log` (task 0.1) | Task 2 Step 8 |
| Roles exist with exactly the spec's attributes; `app_auth` has no `BYPASSRLS` and cannot log in (task 0.2, local) | `roles.test.ts` |
| Migration 0001 applies; up → down → up reproduces an identical catalog fingerprint (task 0.3) | `privileges.test.ts` |
| The seed's identity sequence works under `FORCE ROW LEVEL SECURITY` — v1.1 fix #2 | `identity.test.ts` |
| `resolve_principal` answers for `app_rw` with no tenant set; direct selects return nothing — v1.1 fix #3 | `identity.test.ts` |
| Two tenants cannot read or write each other's rows through any table (acceptance test 12, data layer) | `tenant-isolation.test.ts`, `documents.test.ts`, `ledger.test.ts` |
| "Who can post a purchase return in company X" is one query (acceptance test 14) | `tenant-isolation.test.ts` |
| Σdebit = Σcredit enforced at commit; period lock on the lines; ledger immutable | `ledger.test.ts` |
| Every write audited with a server-supplied actor; chain verifies; audit rows immutable (acceptance test 13, data layer) | `audit.test.ts` |
| Schema linter reports a bare table by name (task 0.4) | `schema-lint.test.ts` |
| CI runs all of the above on every PR | `.github/workflows/ci.yml` |

What Plan 0A deliberately does **not** prove, and where it is proven instead: JWT verification and `withTenant` in the API (0B, task 0.6); the permission catalogue build check (0B, task 0.7); the real Supabase provisioning, seed CLI, Cloudflare deploy, Electron shell, i18n shell and observability (0C).
