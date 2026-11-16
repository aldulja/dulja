import { AUDIT_EXEMPT, lintSchema, verifyChain } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-065",
  "Unreachable dead code in the audit trigger",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, b, withTenant, expect }) => {
    // One generic trigger function, attached by one procedure, with no per-table branches to go stale: there is
    // no branch to become unreachable. Every non-exempt table carries it, and the linter says so.
    expect((await lintSchema(db.admin)).filter((v) => v.rule === "audit_trigger")).toEqual([]);

    const fns = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname like 'audit%' order by p.proname`;
    // Containment, not equality: later slices may add an audit helper and cannot edit this block (§3.7.3).
    for (const name of ["audit_chain", "audit_row"])
      expect(fns.map((f) => f.proname)).toContain(name);

    const attached = await db.admin<{ relname: string }[]>`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and t.tgname = 'audit_row' and not t.tgisinternal order by c.relname`;
    expect(attached.length).toBeGreaterThan(0);
    for (const r of attached) expect(AUDIT_EXEMPT.has(r.relname)).toBe(false);

    // Migration 0010 replaced app.audit_chain()'s body in place, which puts two hash formulas in the tree at once
    // — 0001 still writes the old one and 0010.down still restores it. So "no stale code path in the audit
    // trigger" now also means the body actually in force is the canonical one, and that the verifier the
    // application imports agrees with it over real rows rather than with the text it was copied from.
    const [chain] = await db.admin<{ prosrc: string }[]>`
      select prosrc from pg_proc where oid = 'app.audit_chain()'::regprocedure`;
    expect(chain!.prosrc).toContain("jsonb_build_array");
    expect(chain!.prosrc).not.toContain("|| '|' ||");
    for (const seed of [a, b])
      expect(
        await withTenant(
          rw,
          { tenantId: seed.tenant, actorId: seed.system, requestId: "legacy-065" },
          (tx) => verifyChain(tx, seed.tenant),
        ),
      ).toMatchObject({ brokenLinks: 0, badHashes: 0 });
  },
);
