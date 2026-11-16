import { discover, down, listApplied, up, withTenant } from "@dulja/db";
import { grantCodes, MIGRATIONS_DIR, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
// `startApi()` is `apps/api/test/support/app.ts`'s (§4.2.12); there is no `tests/support/app.ts`, and the
// 2C block below needs its OWN instance — see the note above it.
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { repoFile, sharedDb, thinRegression } from "../support/regression";

thinRegression(
  "SAH-080",
  "Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers",
  "packages/db/test/migrate.test.ts",
  async ({ db, expect }) => {
    const applied = await listApplied(db.migrator);
    expect(applied).toEqual([...applied].toSorted((x, y) => x - y));
    expect(new Set(applied).size).toBe(applied.length); // one monotonic version, not thousands of counters

    const migrations = discover(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) expect(existsSync(m.downPath)).toBe(true); // every step is reversible, in place

    const known = new Set(migrations.map((m) => m.version));
    for (const v of applied) expect(known.has(v), `applied migration ${v} has no file`).toBe(true);
  },
);

// ── appended by slice 0C ──────────────────────────────────────────────────────────────────────────────
// `expect` comes from each test's context: 0B's `thinRegression` callback above already binds that name.
describe("SAH-080 Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers — 0C", () => {
  it("the deploy applies numbered migrations forward-only and never dumps or repumps", ({
    expect,
  }) => {
    const wf = repoFile(".github/workflows/deploy-staging.yml");
    expect(wf).toContain("bun run --cwd packages/db db:migrate");
    // Each entry names a *command*, never a word: a bare "down" would also match "teardown" or "shutdown".
    for (const forbidden of ["pg_dump", "pg_restore", "drop database", "db:rollback"]) {
      expect(wf.toLowerCase()).not.toContain(forbidden);
    }
    expect(wf).not.toMatch(/\bcli\.ts\s+down\b/); // packages/db/src/cli.ts down <version>
    expect(wf).not.toMatch(/\bdb:down\b/);
  });

  it("one monotonic version ledger, not thousands of scattered integers", async ({ expect }) => {
    const { db } = await sharedDb();
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app_meta' and table_name = 'schema_migration' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["version", "name", "applied_at"]);
    const [pk] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.table_constraints
       where table_schema = 'app_meta' and table_name = 'schema_migration' and constraint_type = 'PRIMARY KEY'`;
    expect(pk!.n).toBe(1);
  });

  it("the runbook forbids rolling the database back in production", ({ expect }) => {
    expect(repoFile("docs/runbooks/deploy.md")).toMatch(/\*\*Do not roll back the database\.\*\*/);
  });
});

// ── appended by slice 2C ──────────────────────────────────────────────────────────────────────────────
// This block must NOT use `sharedApi()`: it rolls a migration back, and a `down(…, 26)` on the shared
// instance would break every other file mid-run — and, because migration numbers are allocated per slice
// (hazard 14), would also unwind any 0028+ that happens to be applied. A test that mutates the schema owns
// its instance and stops it. `expect` comes from each test's context, as in the blocks above.
describe("SAH-080 Schema upgrade is a full database dump-and-repump driven by 6,251 uncoordinated version integers — 2C", () => {
  let api: StartedApi;
  let s: Seed;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Sah080");
    await grantCodes(api.db, s, {
      codes: ["accounting.journal.create", "accounting.ledger.read"],
    });
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  it("migration 0027 applies while the API keeps serving — zero failed requests (test 25)", async ({
    expect,
  }) => {
    // This instance is ours, so rolling 0027 back is safe. Then hammer a read path while up() runs.
    // `down(…, 26)` now unwinds 0028–0112 too (3A–4A and the review migrations landed above 0027), so `up`
    // below re-applies the whole ladder under load, not 0027 alone.
    await down(api.db.migrator, MIGRATIONS_DIR, 26);

    const stop = new AbortController();
    const statuses: number[] = [];
    const loop = (async () => {
      while (!stop.signal.aborted) {
        const res = await api.request({
          method: "GET",
          as: s.human,
          // `…/ledger-entries`, 1A's read-only list under `accounting.ledger.read` — the code this block's
          // `beforeAll` grants. The 2C plan named `…/documents?limit=5`, a list route that does not exist
          // (documents are read one at a time by id), so every request was a 404 whatever the migration
          // did. This one reads only 0001's `ledger_entry` columns, so it is served at 26 and after.
          path: `/v1/companies/${s.company}/ledger-entries?limit=5`,
        });
        statuses.push(res.status);
        await res.arrayBuffer();
      }
    })();

    // Let the loop establish itself, migrate, then let it run a little longer.
    await new Promise((r) => setTimeout(r, 250));
    const applied = await up(api.db.migrator, MIGRATIONS_DIR);
    await new Promise((r) => setTimeout(r, 250));
    stop.abort();
    await loop;

    expect(applied).toContain(27);
    // No maintenance window: every request served, before, during and after.
    expect(statuses.length).toBeGreaterThan(10);
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  }, 240_000);

  it("the write path is unaffected: a document created before 0027 reads back after it", async ({
    expect,
  }) => {
    await down(api.db.migrator, MIGRATIONS_DIR, 26);
    // The pre-0027 write is made in the pre-0027 SHAPE, straight at app_rw, rather than through today's
    // `POST …/documents`: that handler now writes 3A's and 3D's line columns (0032, 0040), which `down(…, 26)`
    // has removed, so at 26 it is a 500 — the API that served schema 26 was 2C's, and it is not the tree's.
    // What the case proves is unchanged: a row written before the expand reads back after it, untouched.
    const id = await uuidv7(api.db.admin);
    await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(api.db.admin) },
      async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, 7.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, 7.0000)`;
      },
    );
    await up(api.db.migrator, MIGRATIONS_DIR);

    const after = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${id}`,
      as: s.human,
    });
    expect(after.status).toBe(200);
    // The old row simply has a null note. No backfill, no migration of data — that is the point.
    const [row] = await api.db.admin<{ notes: string | null }[]>`
      select notes from app.document where id = ${id}`;
    expect(row!.notes).toBeNull();
  }, 180_000);
});
