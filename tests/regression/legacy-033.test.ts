import { lintSchema } from "@dulja/db";
import { thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-033",
  "Confidentiality levels are a read-time display filter with a caller-supplied off switch",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.rule === "extra_permissive_policy")).toEqual([]);
    // A PERMISSIVE gate would be OR-ed away by tenant_isolation; every gate is AS RESTRICTIVE, so a filter
    // cannot be dropped by the caller — there is no read-time switch to supply (plan0A:2611, 2753).
    const permissive = await db.admin<{ tablename: string; policyname: string }[]>`
      select tablename, policyname from pg_policies where schemaname = 'app' and permissive = 'PERMISSIVE'
         and policyname not like '%tenant_isolation%' and policyname not like 'principal_%'
         and policyname not in ('tenant_self', 'membership_resolver')`;
    // The registered pre-tenant resolver is SELECT-only under app_auth, never a caller gate.
    expect(permissive).toEqual([
      { tablename: "terminal_enrolment", policyname: "enrolment_resolver" },
    ]);
    const policies = await db.admin<{ roles: string[]; cmd: string; qual: string }[]>`
      select roles,cmd,qual from pg_policies where schemaname='app'
      and tablename='terminal_enrolment' and policyname='enrolment_resolver'`;
    expect([...policies]).toEqual([{ roles: ["app_auth"], cmd: "SELECT", qual: "true" }]);
    const [resolver] = await db.admin<{ owner: string; definer: boolean; definition: string }[]>`
      select pg_get_userbyid(proowner) as owner,prosecdef as definer,pg_get_functiondef(oid) as definition
      from pg_proc where oid='app.resolve_enrolment(bytea)'::regprocedure`;
    expect(resolver).toMatchObject({ owner: "app_auth", definer: true });
    expect(resolver!.definition).toContain("e.code_hash = p_code_hash");
    expect(resolver!.definition).toContain("e.redeemed_at is null");
    expect(resolver!.definition).toContain("e.expires_at > now()");
  },
);

import { repoFile } from "../support/regression";
thinRegression(
  "LEGACY-033",
  "Confidentiality is a display filter with a caller-supplied off switch — 6C",
  "packages/db/test/staff/branch-isolation.test.ts",
  async ({ db, expect }) => {
    const rows = await db.admin<
      { permissive: string }[]
    >`select permissive from pg_policies where schemaname='app' and policyname='branch_isolation'`;
    // 20 since 0071 (OD-10, answered yes 2026-11-04) attached Form A to app.till_banking_link.
    // 21 since 0096 (8D T8, ⚠️ OD-13 answered build) attached Form B to public_holiday (8D A8).
    expect(rows).toHaveLength(21);
    expect(rows.every((r) => r.permissive === "RESTRICTIVE")).toBe(true);
    // plan0A's ALLOWED_PERMISSIVE is spelled `allowedPermissivePolicies` in the tree (privileges.test.ts
    // pins the same literal). Searching for the plan's spelling found nothing, and slicing from index -1
    // left an empty string that could never contain "branch_isolation" (PR 12 review).
    const lint = repoFile("packages/db/src/lint-schema.ts");
    const body = /const allowedPermissivePolicies = new Set\(\[([^\]]*)\]\)/.exec(lint)?.[1];
    expect(body).toBeDefined();
    const permitted = [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(permitted.length).toBeGreaterThan(0);
    expect(permitted).not.toContain("branch_isolation");
    for (const path of ["hr/employee", "hr/attendance", "pos/cashier", "pos/branch-pos-policy"])
      expect(repoFile(`packages/contracts/src/${path}.ts`)).not.toMatch(
        /all_?branch|include_?all|no_?scope|unscoped/i,
      );
  },
);

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// The gate is an RLS predicate on the actor's permission, and no parameter changes it.
import { grantCodes as grant033, seedEmployee as employee033 } from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "LEGACY-033",
  "Confidentiality levels are a read-time display filter with a caller-supplied off switch",
  "8A",
  "all three HR gates are RESTRICTIVE predicates, no route declares an off switch, and a non-holder reads zero rows",
  async ({ db, rw, a, withTenant, expect }) => {
    const gates = await db.admin<{ tablename: string; policyname: string; permissive: string }[]>`
      select tablename, policyname, permissive from pg_policies
       where schemaname = 'app' and policyname in ('sensitive_gate', 'compensation_gate') order by 1`;
    expect(gates.map((r) => [r.tablename, r.policyname, r.permissive])).toEqual([
      ["compensation_line", "compensation_gate", "RESTRICTIVE"],
      ["employee_sensitive", "sensitive_gate", "RESTRICTIVE"],
      ["employee_statutory_profile", "compensation_gate", "RESTRICTIVE"],
    ]);

    // There is NO off switch: no parameter, header or body member anywhere in the committed document is named like
    // one. A name is checked, not every string, so the word "level" in a description cannot trip it.
    const doc = JSON.parse(repoFile("packages/contracts/openapi.json")) as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const OFF_SWITCH =
      /^(level|confidential.*|show_?all|showAll|include_?sensitive|includeSensitive|unmask.*|audit)$/i;
    const parameters = Object.values(doc.paths)
      .flatMap((ops) => Object.values(ops))
      .flatMap((op) => op.parameters ?? [])
      .map((p) => p.name);
    expect(parameters.filter((n) => OFF_SWITCH.test(n))).toEqual([]);
    const members = Object.values(doc.components.schemas).flatMap((schema) =>
      Object.keys(schema.properties ?? {}),
    );
    expect(members.filter((n) => OFF_SWITCH.test(n))).toEqual([]);

    // A row exists in two of the tables, written by the system principal (which every gate admits); a member of the company without the codes reads none of it.
    const employeeId = await employee033(db, a, { employeeNumber: "E-LEGACY033" });
    await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.system, requestId: "legacy-033-8a" },
      async (tx) => {
        await tx`insert into app.employee_sensitive (employee_id, tenant_id, key_version) values (${employeeId}, ${a.tenant}, 1)`;
        await tx`insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from)
               values (${a.tenant}, ${employeeId}, '2026-01-01')`;
      },
    );
    // `b.human` is a member of another tenant; the non-holder must be a member of THIS company, holding nothing.
    const [clerk] = await db.admin<{ id: string }[]>`select uuidv7() as id`;
    await withTenant(
      db.migrator,
      { tenantId: a.tenant, actorId: a.system, requestId: "legacy-033-clerk" },
      async (tx) => {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${clerk!.id}, ${`sub-${clerk!.id}`}, 'human', 'Clerk')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${clerk!.id})`;
      },
    );
    await grant033(db, a, { principalId: clerk!.id, roleCode: "legacy033-clerk" });
    const counts = await withTenant(
      rw,
      { tenantId: a.tenant, actorId: clerk!.id, requestId: "legacy-033-read" },
      async (tx) => ({
        employee: (
          await tx<
            { n: string }[]
          >`select count(*)::text as n from app.employee where id = ${employeeId}`
        )[0]!.n,
        employee_sensitive: (
          await tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`
        )[0]!.n,
        employee_statutory_profile: (
          await tx<{ n: string }[]>`select count(*)::text as n from app.employee_statutory_profile`
        )[0]!.n,
        compensation_line: (
          await tx<{ n: string }[]>`select count(*)::text as n from app.compensation_line`
        )[0]!.n,
      }),
    );
    // The employee IS visible (the clerk holds a company-wide role), so the zeros are the gates', not isolation's.
    expect(counts).toEqual({
      employee: "1",
      employee_sensitive: "0",
      employee_statutory_profile: "0",
      compensation_line: "0",
    });
  },
);

// ─── 8D ──────────────────────────────────────────────────────────────────────────────────────────────────
// The report-side clause of test 32: no HR report or dataset carries a sensitive field, and the one list that does
// (the permit list, 8D amendment A3) is gated by the same RESTRICTIVE policy, never by a parameter.
import { readdirSync as readdir033, readFileSync as readFile033 } from "node:fs";
import { join as join033 } from "node:path";
import {
  createHrKeyRing as ring033,
  DEV_HR_KEY as devKey033,
  permitExpiry as permitExpiry033,
  writeSensitive as writeSensitive033,
} from "@dulja/db";
import {
  seedTenantV2 as tenant033,
  uuidv7 as uuid033,
  withTenant as withTenant033,
  type Seed as Seed033,
} from "@dulja/db/test";
import { sharedDb as sharedDb033 } from "../support/regression";
import { REPO_ROOT as ROOT033 } from "../support/source";
import { beforeAll, describe, expect, it } from "vitest";

describe("LEGACY-033 Confidentiality levels are a read-time display filter with a caller-supplied off switch — 8D", () => {
  const SENSITIVE = [
    "national_id",
    "passport",
    "date_of_birth",
    "bank_account",
    "residency_category",
    "epf_number",
    "socso_number",
    "tax_number",
    "work_permit_expiry",
  ];
  const DIR = join033(ROOT033, "packages/db/seed/my/reports/8d");
  const RING = ring033({ current: devKey033, currentVersion: 1 });
  let db: Awaited<ReturnType<typeof sharedDb033>>["db"];
  let s: Seed033;
  let outsider: string; // a member of the company holding hr.employee.read only

  beforeAll(async () => {
    // Only the Db is shared; the block seeds its own tenant so its employees and permits are its own.
    db = (await sharedDb033()).db;
    s = await tenant033(db, "LEGACY-033 8D");
    await grant033(db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive"] });
    outsider = await uuid033(db.admin);
    await withTenant033(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${outsider}, ${`stub:legacy033-${outsider}`}, 'human', 'Outsider')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${outsider})`;
    });
    await grant033(db, s, {
      codes: ["hr.employee.read"],
      principalId: outsider,
      roleCode: "legacy033-clerk-8d",
    });
    const withPermit = await employee033(db, s, { employeeNumber: "E-7001" });
    await withTenant033(db.rw, s.tenant, s.human, (tx) =>
      writeSensitive033(tx, RING, withPermit, { work_permit_expiry: "2026-02-15" }),
    );
  }, 240_000);

  it("no 8D report definition names a sensitive, compensation or statutory-profile field", () => {
    const files = readdir033(DIR).filter((n) => n.endsWith(".json"));
    expect(files.length).toBe(8);
    for (const name of files) {
      const text = readFile033(join033(DIR, name), "utf8");
      for (const field of [...SENSITIVE, "compensation", "statutory_profile", "marital_status"]) {
        expect(text, `${name} names ${field}`).not.toContain(field);
      }
    }
  });

  it("no HR dataset joins a gated table — a dataset cannot decrypt and must not try", () => {
    const text = repoFile("packages/db/src/reports/datasets/hr.ts");
    for (const table of ["employee_sensitive", "compensation_line", "employee_statutory_profile"]) {
      expect(text, table).not.toContain(table);
    }
  });

  it("the permit list is empty for a principal without the code and non-empty for one with it — the gate is the POLICY", async () => {
    const without = await withTenant033(db.rw, s.tenant, outsider, (tx) =>
      permitExpiry033(tx, RING, { companyId: s.company, withinDays: 100_000 }),
    );
    const holder = await withTenant033(db.rw, s.tenant, s.human, (tx) =>
      permitExpiry033(tx, RING, { companyId: s.company, withinDays: 100_000 }),
    );
    // Same function, same parameters, two actors: nothing in TypeScript branched on a permission. The outsider
    // sees the employee (a company-wide role), so the empty list is sensitive_gate's, not branch isolation's.
    expect(without).toEqual([]);
    expect(holder.map((r) => r.employeeNumber)).toEqual(["E-7001"]);
    const [visible] = await withTenant033(
      db.rw,
      s.tenant,
      outsider,
      (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from app.employee where employee_number = 'E-7001'`,
    );
    expect(visible!.n).toBe(1);
  });
});
