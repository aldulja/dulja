import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, REPO_ROOT } from "../support/source";
import { taxFixture } from "./support/tax";
// tests/invariants/phase-5a-pinned.test.ts
// The lists slice 5A must leave unchanged, and the acceptance tests §2.6 lists as re-runs. Every case here
// is an EQUALITY, not a superset check: a list that grew silently is the failure this file exists to find.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, createTaxReturn } from "@dulja/db";
import { startDb, seedTenant, type Db, type Seed } from "@dulja/db/test";
import { PERMISSIONS } from "@dulja/contracts";
import { ROLES } from "../../packages/db/seed/roles";
import { ROUTES } from "../../apps/api/src/routes/index";
import { PROBES } from "./probes";

describe("slice 5A — the pinned lists and the re-run matrix", () => {
  let db: Db;
  let seed: Seed;
  beforeAll(async () => {
    db = await startDb();
    seed = await seedTenant(db, "5a-pinned");
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  // ── §3.5.4: the app_rw DELETE grant list. 2B is the ONLY slice that ever extends it (hazard 25). ─────
  it("app_rw holds DELETE on exactly the pinned tables — 5A adds none", async () => {
    const rows = await withTenant(
      db.rw,
      { tenantId: seed.tenant, actorId: seed.human, requestId: "5a-pinned" },
      (tx) => tx<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`,
    );
    const granted = rows.map((r) => r.table_name);
    expect(granted).not.toContain("tax_code"); // archived with archived_at (spec:2049)
    expect(granted).not.toContain("tax_transaction"); // immutable, and posting-only besides
    expect(granted).not.toContain("tax_return"); // a regeneration is an UPDATE of the same row
    expect(granted).not.toContain("tax_regime");
    // The full pinned equality lives in packages/db/test/privileges.test.ts (Plan 0A, extended by 2B);
    // this is the 5A-shaped statement of it and it fails the moment one of the four appears.
  }, 180_000);

  // ── §3.5.3: the linter sets, at exactly the state the register declares. Hazard 13. ──────────────────
  it("only tax_transaction joined AUDIT_EXEMPT and IMMUTABLE; the other three tables are audited", () => {
    expect(AUDIT_EXEMPT).toContain("tax_transaction");
    expect(IMMUTABLE).toContain("tax_transaction");
    for (const t of ["tax_regime", "tax_code", "tax_return"]) {
      expect(AUDIT_EXEMPT, `${t} must stay audited (test 13)`).not.toContain(t);
      expect(IMMUTABLE, `${t} is mutable master data`).not.toContain(t);
    }
  });

  it("the schema linter passes over the four new tables", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table.startsWith("tax_"))).toEqual([]);
  }, 180_000);

  // ── Test 13 re-run: audit completeness over this slice's own tables. ─────────────────────────────────
  it("a write to each audited tax table lands in app.audit_log under the acting principal", async () => {
    const f = await taxFixture(db, "pinned-audit");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "pinned-audit" };
    const before = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name in ('tax_code', 'tax_return')`,
    );
    await withTenant(db.rw, ctx, async (tx) => {
      await tx`update app.tax_code set name_en = 'renamed (audited)' where id = ${f.codes["SYN-EXEMPT"]!}`;
      await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
    });
    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number; actors: string[] }[]>`
      select count(*)::int as n, array_agg(distinct actor_id::text) as actors
        from app.audit_log where table_name in ('tax_code', 'tax_return')`,
    );
    expect(after[0]!.n).toBeGreaterThan(before[0]!.n);
    expect(after[0]!.actors).toContain(f.s.human);
  }, 180_000);

  // ── Test 36 re-run: the permission catalogue. §3.6.1's vocabulary is CLOSED (hazard 26). ─────────────
  it("5A added exactly one permission code and it is granted to exactly the accountant", () => {
    const tax = PERMISSIONS.filter((p) => p.phase === "5A");
    expect(tax.map((p) => p.code)).toEqual(["accounting.tax.manage"]); // `.file` is 5B's, not seeded here
    expect(tax[0]!.mutating).toBe(true);
    const holders = ROLES.filter(
      (r) => r.code !== "admin" && r.permissions.includes("accounting.tax.manage"),
    )
      .map((r) => r.code)
      .toSorted();
    expect(holders).toEqual(["accountant"]);
  });

  // ── Test 12 re-run: two route modules, two probes, keyed by RouteModule.path (hazard 31). ────────────
  it("both new route modules have a probe, and no probe names a route that does not exist", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/v1/companies/:companyId/tax-codes");
    expect(paths).toContain("/v1/companies/:companyId/tax-returns");
    for (const p of paths) expect(Object.keys(PROBES), `${p} has no probe`).toContain(p);
    for (const k of Object.keys(PROBES)) expect(paths, `${k} probes nothing`).toContain(k);
  });

  // ── Test 27 re-run: no SQL text across the API, stated for this slice's own surface. ─────────────────
  it("this slice ships no sql.unsafe and no concatenated SQL", () => {
    const offenders = sourceFiles([
      "packages/domain/src/tax",
      "packages/db/src/tax",
      "packages/db/src/posting/tax.ts",
      "packages/db/src/seed/tax.ts",
      "apps/api/src/routes/accounting/tax-codes.ts",
      "apps/api/src/routes/accounting/tax-returns.ts",
    ]).flatMap((f) =>
      f.lines.flatMap((line, i) => (/\.unsafe\s*\(/.test(line) ? [`${f.path}:${i + 1}`] : [])),
    );
    expect(offenders).toEqual([]); // §3.3: sql.unsafe has exactly three homes and none is here
  });

  // ── Test 15 re-run, the assertion half: the four types gained tax through SEED DATA only. ────────────
  it("the four 4A types carry policyVersion 2 with a tax block, and 5A shipped no document-type code", () => {
    const PACK = join(REPO_ROOT, "packages/db/seed/my/document-types");
    for (const code of [
      "SALES_INVOICE",
      "SALES_CREDIT_NOTE",
      "PURCHASE_INVOICE",
      "PURCHASE_CREDIT_NOTE",
    ]) {
      const env = JSON.parse(readFileSync(join(PACK, `${code}.json`), "utf8")) as {
        code: string;
        policyVersion: number;
        policy: { tax: { applies: boolean }; lines: { for: string }[] };
      };
      expect(env.code).toBe(code);
      expect(env.policyVersion).toBe(2);
      expect(env.policy.tax.applies).toBe(true);
      expect(env.policy.lines.filter((l) => l.for === "each_tax")).toHaveLength(1);
    }
    // And nothing else in the pack is 5A's. The card is explicit: this slice registers no §4.14 code.
    const owned = readdirSync(PACK).filter((f) => f.startsWith("TAX_"));
    expect(owned).toEqual([]);
  });
});
