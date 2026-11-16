import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OVERRIDE_LIFTS } from "@dulja/db";
import { PERMISSIONS } from "@dulja/contracts";
import { ROLES, INCOMPATIBLE_PAIRS } from "../../packages/db/seed/roles";
import { TILL_OVERRIDE_LIFTS } from "../../apps/pos/src/main/authority";
import { openPosDatabase } from "../../apps/pos/src/main/database";
import { REPO_ROOT, sourceFiles } from "../support/source";
import { rule as postingOnly } from "../../scripts/lint/rules/posting-only-tables";

const migration = (name: string): string =>
  readFileSync(join(REPO_ROOT, "packages/db/migrations", name), "utf8");

describe("6B pinned authority, dependency and persistence boundaries", () => {
  it("pins every override subject against the live server map", () => {
    expect(Object.keys(TILL_OVERRIDE_LIFTS).toSorted()).toEqual(
      Object.keys(OVERRIDE_LIFTS).toSorted(),
    );
    for (const [subject, server] of Object.entries(OVERRIDE_LIFTS)) {
      expect([...TILL_OVERRIDE_LIFTS[subject]!].toSorted()).toEqual(
        subject === "price_override" ? ["price_override"] : [...server].toSorted(),
      );
      if (subject === "price_override") expect(server).toEqual([]);
    }
  });
  it("pins all three codes and both actual role seeds", () => {
    const codes = PERMISSIONS.filter((p) => p.phase === "6B");
    expect(codes.map((p) => p.code).toSorted()).toEqual([
      "pos.attendance.clock",
      "pos.price.check",
      "pos.shift.own",
    ]);
    for (const code of codes) {
      expect(code.module).toBe("pos");
      for (const role of ["cashier", "branch_manager"])
        expect(ROLES.find((r) => r.code === role)!.permissions).toContain(code.code);
      expect(INCOMPATIBLE_PAIRS.flat()).not.toContain(code.code);
    }
    // Test 36's clause: §3.6.3's lint scans `apps/pos` because these three are evaluated only at the till, so
    // each must stay referenced there as `PERMISSION["<code>"]` — never moved out, never a string literal.
    const posSource = sourceFiles(["apps/pos"])
      .map((s) => s.text)
      .join("\n");
    for (const code of codes) expect(posSource, code.code).toContain(`PERMISSION["${code.code}"]`);
  });
  it("indexes item.tax_code_id's non-null references and drops the index on the way down (A10)", () => {
    // Plan Contracts' 6B pricing prerequisite reconciliation: the tenant-composite FK, the Drizzle mirror and
    // an index for non-null references. A partial index, so the many untaxed items cost nothing.
    expect(migration("0063_alter_item_seed_permission_phase6b.sql")).toMatch(
      /create index item_tax_code_idx on app\.item \(tax_code_id\) where tax_code_id is not null;/,
    );
    expect(migration("0063.down.sql")).toContain("drop index if exists app.item_tax_code_idx;");
    expect(readFileSync(join(REPO_ROOT, "packages/db/src/schema/item.ts"), "utf8")).toContain(
      'index("item_tax_code_idx").on(table.taxCodeId)',
    );
  });
  it("ships no PostgreSQL dependency, DB barrel or renderer network path", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/pos/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(
      Object.keys(pkg.dependencies).filter((name) => name === "postgres" || name === "pg"),
    ).toEqual([]);
    const main = sourceFiles(["apps/pos/src/main"]);
    expect(main.filter((s) => /from ["']@dulja\/db["']/.test(s.text)).map((s) => s.path)).toEqual(
      [],
    );
    expect(
      [
        ...new Set(
          main.flatMap((s) =>
            [...s.text.matchAll(/from ["'](@dulja\/db\/[^"']+)["']/g)].map((m) => m[1]),
          ),
        ),
      ].toSorted(),
    ).toEqual(["@dulja/db/staff/pin"]);
    expect(
      sourceFiles(["apps/pos/src/renderer"])
        .filter((s) => /\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(s.text))
        .map((s) => s.path),
    ).toEqual([]);
    expect(postingOnly.run(sourceFiles(["apps/pos/src"]))).toEqual([]);
  });
  it("opens exactly nineteen tables, eight mirrors and TEXT exact-value columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-pinned-"));
    const db = openPosDatabase(join(dir, "till.sqlite"));
    try {
      const tables = db.raw
        .prepare<[], { name: string }>(
          "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
        )
        .all()
        .map((r) => r.name);
      // 19 since local schema version 3 added `cash_event` (OD-10, answered yes 2026-11-04).
      expect(tables).toHaveLength(19);
      expect(tables.filter((name) => name.startsWith("catalogue_"))).toHaveLength(8);
      const columns = db.raw
        .prepare<[], { table_name: string; name: string; type: string }>(
          "select m.name table_name,p.name,p.type from sqlite_master m join pragma_table_info(m.name) p where m.type='table'",
        )
        .all();
      expect(
        columns.filter(
          (c) =>
            /amount|price|cost|total|float|cash|revision|quantity|increment|limit|tax/.test(
              c.name,
            ) && c.type.toUpperCase() !== "TEXT",
        ),
      ).toEqual([]);
      expect(db.raw.pragma("synchronous", { simple: true })).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
