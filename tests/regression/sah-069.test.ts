import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fullRegression, problemOf, sharedApi } from "../support/api";
import { REPO_ROOT } from "../support/source";

fullRegression(
  "SAH-069",
  "Every report query is rebuilt, re-parsed and re-planned on each call, into fixed-size buffers",
  {
    "the free-text columns this slice reads are unbounded: nothing can be silently truncated by a buffer":
      async ({ api, expect }) => {
        // Named tables, not a schema-wide sweep: later slices add tables and cannot edit this block (§3.7.3).
        // Every one of these is `text`, never `varchar(n)` — an over-length value is refused by the schema at the
        // API boundary (next case), never trimmed to fit a declared width.
        const cols = await api.db.admin<
          { table_name: string; column_name: string; data_type: string }[]
        >`
      select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'app'
         and table_name in ('company', 'principal', 'role', 'permission', 'account', 'document', 'audit_log')
         and data_type = 'character varying'`;
        expect(cols).toEqual([]);
      },

    "an over-length value is REFUSED at the schema boundary, never trimmed to fit": async ({
      api,
      a,
      expect,
    }) => {
      const res = await api.request({
        method: "POST",
        path: "/v1/companies",
        as: a.human,
        body: { code: "SAH069A", name: "x".repeat(201), baseCurrency: "MYR" },
      }); // CreateCompanyBody: max(200)
      expect(res.status).toBe(400);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_VALIDATION_FAILED");
      expect(problem.errors?.some((e) => e.path.includes("name"))).toBe(true);
    },

    "a value at the declared limit round-trips byte-identically": async ({ api, a, expect }) => {
      const name = "ن".repeat(200); // 200 characters, 400 bytes: a byte buffer would have cut it
      const created = await api.request({
        method: "POST",
        path: "/v1/companies",
        as: a.human,
        body: { code: "SAH069B", name, baseCurrency: "MYR" },
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const read = await api.request({ method: "GET", path: `/v1/companies/${id}`, as: a.human });
      expect(((await read.json()) as { name: string }).name).toBe(name);
    },
  },
);

describe("SAH-069 Every report query is rebuilt, re-parsed and re-planned on each call — 7A", () => {
  // Each `it` takes vitest's context `expect`: a module-scope import would be shadowed by the 0B block's own
  // destructured `expect` above, which `no-shadow` refuses (tests/support/regression.ts says the same).
  // 61 `execute statement` sites; `procSerInventory` appended up to 24 fragments into a varchar(600);
  // ~54 sites interpolated DATE parameters as text. The report engine's answer is a CLOSED registry of
  // named static queries whose column references are literal fragments authored in three files.

  it("no dataset file contains a concatenated or interpolated identifier, an .unsafe(, or a bare sql`", ({
    expect,
  }) => {
    for (const file of ["accounting.ts", "ar-ap.ts", "inventory.ts"]) {
      const text = readFileSync(
        join(REPO_ROOT, `packages/db/src/reports/datasets/${file}`),
        "utf8",
      );
      expect(text, file).not.toMatch(/\$\{\s*(?:[a-zA-Z_$][\w$]*\s*\+|['"`])/);
      expect(text, file).not.toMatch(/\.unsafe\s*\(/);
      expect(text, file).not.toMatch(/\bsql`/);
    }
  });

  it("a DATE parameter is bound and CAST, never interpolated as text — the ~54-site defect", ({
    expect,
  }) => {
    const query = readFileSync(join(REPO_ROOT, "packages/db/src/reports/query.ts"), "utf8");
    expect(query).toMatch(/case "date":\s*return tx`\$\{value\}::date`/);
    expect(query).toContain("const DATE = /^\\d{4}-\\d{2}-\\d{2}$/");
    // The TypeScript shape check is what turns a malformed date into ERR_VALIDATION_FAILED naming the field
    // instead of SQLSTATE 22P02 mapped to ERR_INTERNAL.
  });

  it("`like` is a prefix match with the metacharacters neutralised, so no user string becomes a pattern", ({
    expect,
  }) => {
    const query = readFileSync(join(REPO_ROOT, "packages/db/src/reports/query.ts"), "utf8");
    expect(query).toContain('value.replace(/([\\\\%_])/g, "\\\\$1")');
  });

  it("every column a report filters on is indexed, on the three tables this slice created (SAH-070's twin)", async ({
    expect,
  }) => {
    // This file's 0B block runs on `sharedApi()`'s database, and a regression file uses one of the two shared
    // databases, never both (tests/support/api.ts) — so the 7A block reads the catalogue through the same one.
    const { api } = await sharedApi();
    const indexes = await api.db.migrator<{ tablename: string; indexdef: string }[]>`
      select tablename, indexdef from pg_indexes
       where schemaname = 'app' and tablename in ('report_definition', 'saved_view', 'report_run')`;
    const defs = indexes.map((i) => i.indexdef).join("\n");
    expect(defs).toMatch(/report_definition_lookup_idx.*company_id, code, version/s);
    expect(defs).toMatch(/report_run_recent_idx.*company_id, created_at/s);
    expect(defs).toMatch(/saved_view_owner_idx.*company_id, owner_principal_id/s);
  });
});
