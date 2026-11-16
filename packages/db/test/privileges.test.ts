import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectionChecks } from "../src/integrity";
import { JOB_NAMES } from "../src/jobs/enqueue";
import { JOBS } from "../src/jobs/names";
import { lintSchema } from "../src/lint-schema";
import { down, listApplied, up } from "../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";

export { schemaFingerprint } from "./support/schema-fingerprint";
import { schemaFingerprint } from "./support/schema-fingerprint";

describe("privileges and reversibility", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => db.stop());
  async function grantsFor(table: string): Promise<string[]> {
    const rows = await db.admin<
      { privilege_type: string }[]
    >`select privilege_type from information_schema.role_table_grants where grantee = 'app_rw' and table_schema = 'app' and table_name = ${table} order by 1`;
    return rows.map((row) => row.privilege_type);
  }
  it("ledger tables permit select and insert; audit rows are read-only to the application role", async () => {
    for (const table of ["ledger_entry", "ledger_entry_dimension"])
      expect(await grantsFor(table)).toEqual(["INSERT", "SELECT"]);
    expect(await grantsFor("audit_log")).toEqual(["SELECT"]);
  });
  it("app_rw may DELETE only from idempotency_key, the two RBAC join tables and drafts (document, document_line), and has no TRUNCATE/REFERENCES/TRIGGER anywhere", async () => {
    const rows = await db.admin<
      { table_name: string; privilege_type: string }[]
    >`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'app_rw' and table_schema = 'app' and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') order by 1, 2`;
    // contracts §3.5.4: 2B (migration 0023) is the ONLY slice that ever extends this list; the two document
    // rows are guarded by document_delete_draft_only / document_line_delete_draft_only (ERR_DOC_NOT_DRAFT).
    expect(rows).toEqual([
      { table_name: "document", privilege_type: "DELETE" },
      { table_name: "document_line", privilege_type: "DELETE" },
      { table_name: "idempotency_key", privilege_type: "DELETE" },
      { table_name: "role_assignment_branch", privilege_type: "DELETE" },
      { table_name: "role_permission", privilege_type: "DELETE" },
    ]);
  });
  it("0027 changed no privilege — the pinned DELETE list is what 2B left (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // §3.5.4's pinned list in full: Plan 0A's three plus 2B's two (after 0023). FIVE rows, in the
    // `order by table_name` order. An ALTER TABLE grants nothing, and a plan that quietly added a grant
    // here would be caught by this list, not by review. A difference is a finding in the slice that
    // granted it — never a reason to edit this expectation.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
  });
  it("the app_rw DELETE grant list is unchanged by slice 3D (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // contracts §3.5.4 (contracts:1119), verbatim and in `order by table_name` order: "after 0023 that
    // list ... is ["document", "document_line", "idempotency_key", "role_assignment_branch",
    // "role_permission"]. No other table ever grants DELETE." `attachment` and `saved_view` are archived
    // with `archived_at` (contracts:1115) and must NEVER appear here — a plan that adds either has
    // misread §3.5.4. Phase 3 created fifteen tables across 0028-0042 and granted DELETE on none of them:
    // every inventory row is append-only (inventory_movement, cost_layer, cost_consumption) or a
    // projection the posting service merges (stock_on_hand, stock_valuation). This is an EQUALITY, so a
    // later slice cannot widen the list quietly; a difference is a finding in whichever slice granted it.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
  });
  it("the app_rw DELETE grant list is unchanged by slice 4A (§3.5.4, hazard 25; 4A Task 14)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // Re-stated verbatim and NOT extended (4A plan, Global Constraint 10): 4A's two tables are master data
    // and a reversal record — `payment_term` archives with `archived_at` (0044) and `allocation` reverses
    // with `unallocated_at` (0046, whose allocation_guard admits the un-allocation as the ONE update) — so
    // neither gains DELETE, and 0045/0047 grant nothing. The two tables are named so this case cannot pass
    // on a database where 0044/0046 never ran: each must exist, be reachable, and hold no DELETE grant.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
    for (const table of ["payment_term", "allocation"]) {
      const grants = await grantsFor(table);
      expect(grants, table).toContain("SELECT");
      expect(grants, table).not.toContain("DELETE");
    }
  });
  it("app_rw's DELETE grants are still exactly §3.5.4's five tables after 0048–0052 (4B Task 12, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select distinct table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
       order by table_name`;
    // A re-assertion of an existing equality, written to pass on its first run: it goes red only if one of
    // 0048–0052 granted a DELETE. 4B's five tables are two projections that MERGE and zero their stale keys
    // (party_ageing, item_profitability — 0048) and three audited rows that are never deleted: a statement and
    // its lines are imported once (0049), and a match is reversed by `unmatched_at` (0050). 0051 is OD-09's and
    // unused; 0052 seeds one permission code. Each table is named so this case cannot pass on a database where
    // 0048–0050 never ran.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
    for (const table of [
      "party_ageing",
      "item_profitability",
      "bank_statement",
      "bank_statement_line",
      "bank_match",
    ]) {
      const grants = await grantsFor(table);
      expect(grants, table).toContain("SELECT");
      expect(grants, table).not.toContain("DELETE");
    }
  });
  it("the other pinned lists are where 4B left them: lint at zero, the projection checks (six since 8C), sixteen jobs, two linter sets untouched (4B Task 12)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    // 1B's registry after 4B Task 4: item_profitability joined the four current-state checks. party_ageing is
    // an as-of snapshot and is compared inside accounting.projection.rebuild instead (ADR 0046), so it is not here.
    expect(projectionChecks().map((check) => check.name)).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
    // §4.2.6: 4B added a PAYLOAD key (accounting.projection.rebuild's { companyId?, asOf? }), never a name —
    // the name was registered to 4B in JOBS from Phase 0.
    expect(JOB_NAMES).toHaveLength(16);
    expect(JOB_NAMES).toEqual(Object.keys(JOBS));
    expect(JOBS["accounting.projection.rebuild"].owner).toBe("4B");
    // plan0A's GLOBAL_TABLES and ALLOWED_PERMISSIVE are module-private in the tree, spelled `globalTables` and
    // `allowedPermissivePolicies`, so they are pinned by their literal in the source; §3.5.3 says neither
    // ever grows. `lintSchema` at zero above is the behavioural half of the same claim.
    const source = readFileSync(
      fileURLToPath(new URL("../src/lint-schema.ts", import.meta.url)),
      "utf8",
    );
    const setLiteral = (name: string): string[] => {
      const body = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)?.[1];
      return [...(body ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    };
    expect(setLiteral("globalTables")).toEqual(["tenant", "principal", "permission"]);
    expect(setLiteral("allowedPermissivePolicies")).toEqual([
      "tenant_isolation",
      "tenant_self",
      "principal_in_tenant",
      "principal_update_in_tenant",
      "principal_insert",
    ]);
  });
  it("0105 widened no table grant: app_rw reaches audit_log only through record_system_event", async () => {
    expect(await grantsFor("audit_log")).toEqual(["SELECT"]);
    const [fn] = await db.admin<{ prosecdef: boolean; owner: string }[]>`
      select p.prosecdef, pg_get_userbyid(p.proowner) as owner from pg_proc p
       where p.pronamespace = 'app'::regnamespace and p.proname = 'record_system_event'`;
    expect(fn).toEqual({ prosecdef: true, owner: "app_migrator" });
  });
  it("6A adds no DELETE grant; terminals revoke and queue rows resolve", async () => {
    const rows = await db.admin<
      { table_name: string }[]
    >`select table_name from information_schema.role_table_grants where grantee='app_rw' and table_schema='app' and privilege_type='DELETE' order by table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
  });
  it("7A adds no DELETE grant: the list after 0075 is still 2B's five (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
    // saved_view archives with archived_at and report_run is never removed (ADR 0067); both exist and are
    // reachable, so this case cannot pass on a database where 0074/0075 never ran.
    for (const table of ["report_definition", "saved_view", "report_run"]) {
      const grants = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = ${table}`;
      expect(grants.map((g) => g.privilege_type).toSorted(), table).toEqual([
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
    }
  });
  it("tenant tables force RLS", async () => {
    const rows = await db.admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'app'::regnamespace and relkind in ('r', 'p') order by 1`;
    for (const row of rows)
      // permission is the one global catalogue with no tenant column, so it carries no RLS at all.
      expect([row.relname, row.relrowsecurity, row.relforcerowsecurity]).toEqual(
        row.relname === "permission" ? [row.relname, false, false] : [row.relname, true, true],
      );
  });
  it("app_rw cannot reach migration metadata, create app objects, or grant itself BYPASSRLS", async () => {
    await expect(db.rw`select * from app_meta.schema_migration`).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.rw`create table app.rogue (id int)`).rejects.toThrow(/permission denied/);
    await expect(db.rw`alter role app_rw bypassrls`).rejects.toThrow(
      /permission denied|must be superuser|must have/,
    );
  });
  it("up → down → up reproduces the schema byte for byte (task 0.3 acceptance; §3.9 'reversible')", async () => {
    const before = await schemaFingerprint(db.admin);
    const applied = await listApplied(db.migrator);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].toReversed());
    const [n] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from information_schema.tables where table_schema = 'app'`;
    expect(n!.n).toBe(0);
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await schemaFingerprint(db.admin)).toBe(before);
  });
});
