import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import {
  draftDocument,
  seedTenant,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "./index";

describe("app.document_event — contracts §4.5.2/§4.5.3, spec:1782–1787, R8 spec:2179", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  /** A second human in tenant `s`, so an override can be attributed to somebody other than the creator. */
  const secondPrincipal = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };
  /** Grants `codes` to `principalId` through a real role chain, acting as the tenant's SYSTEM principal
   *  (app.forbid_self_grant refuses a principal granting to itself). */
  const grant = async (s: Seed, principalId: string, codes: string[]): Promise<void> => {
    const roleId = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${s.tenant}, ${`r-${roleId.slice(-12)}`}, 'grant')`;
      for (const code of codes) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${s.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    });
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
    // accounting.credit_limit.override is 4A's catalogue row (§3.6.2) and does not exist at 2B. The override
    // door is a mechanism, not a code, so the mechanism is proved against a row inserted here as the migrator.
    // app.permission is global, has no RLS and is read-only for app_rw, so only this test's own container ever
    // sees the row and permission-catalogue.test.ts (its own container) stays green.
    await db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
  });
  afterAll(async () => {
    await db.stop();
  });

  it("carries the contracts §4.5.2 columns and is tenant-isolated, forced, indexed", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "actor_id",
      // 0045 (code review 2026-09-29): the base total a credit-limit override approved.
      "approved_base_total",
      // 0114 (code review 2): the stock content a negative-stock override approved.
      "approved_stock_digest",
      "attributed_to",
      "company_id",
      "created_at",
      "document_id",
      "event_kind",
      "from_status",
      "id",
      "occurred_at",
      "override_code",
      "reason",
      "tenant_id",
      "to_status",
    ]);
    const [rls] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'app'::regnamespace and relname = 'document_event'`;
    expect([rls!.relrowsecurity, rls!.relforcerowsecurity]).toEqual([true, true]);
    const idx = await db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'document_event' order by 1`;
    expect(idx.map((i) => i.indexname)).toContain("document_event_document_idx");
  });

  it("stamps actor_id from the session and refuses a payload actor (spec:1370, SAH-044)", async () => {
    const doc = await draftDocument(db, a);
    const other = await secondPrincipal(a, "impostor");
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ actor_id: string }[]>`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, actor_id)
        values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted', ${other})
        returning actor_id`,
    );
    expect(row!.actor_id).toBe(a.human);
  });

  it("is immutable: app_rw holds no UPDATE or DELETE and the trigger refuses both", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_event' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT", "SELECT"]);
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
        values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document_event set reason = 'tampered' where document_id = ${doc}`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);
  });

  it("refuses a transition row with an override_code and an override row without one", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code)
          values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted', 'accounting.credit_limit.override')`,
      ),
    ).rejects.toThrow(/document_event_check/);
    // Written as the tenant's system principal, which app.principal_has admits whatever the code and which is
    // not the document's creator: BEFORE INSERT triggers run ahead of CHECK constraints, so as anyone else the
    // override guard refuses the row first ("does not hold <NULL>") and the check is never reached. This way
    // the guard lets it through and the refusal is the check's alone.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`
          insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
          values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft')`,
      ),
    ).rejects.toThrow(/document_event_check/);
  });

  it("admits an override only from a second principal who holds the code (R8, spec:2179)", async () => {
    const doc = await draftDocument(db, a); // created_by = a.human
    const supervisor = await secondPrincipal(a, "supervisor");
    await grant(a, supervisor, ["accounting.credit_limit.override"]);

    // the creator cannot override their own document, even holding the code
    await grant(a, a.human, ["accounting.credit_limit.override"]);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
          values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'because I said so')`,
      ),
    ).rejects.toThrow(
      /ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/,
    );

    // a second principal WITHOUT the code is refused
    const bystander = await secondPrincipal(a, "bystander");
    // Reach the document while holding no override code, so this remains an R8
    // permission refusal rather than a branch-visibility refusal after 0068.
    await grantCodes(db, a, { principalId: bystander });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        bystander,
        (tx) => tx`
          insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
          values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'passing by')`,
      ),
    ).rejects.toThrow(
      /ERR_OVERRIDE_NOT_AUTHORISED: principal .* does not hold accounting\.credit_limit\.override/,
    );

    // the supervisor, who holds it and is not the creator, is admitted
    const [ok] = await withTenant(
      db.rw,
      a.tenant,
      supervisor,
      (tx) => tx<{ actor_id: string; override_code: string }[]>`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code, reason)
        values (${a.tenant}, ${a.company}, ${doc}, 'override', 'draft', 'draft', 'accounting.credit_limit.override', 'customer is good for it')
        returning actor_id, override_code`,
    );
    expect(ok).toEqual({ actor_id: supervisor, override_code: "accounting.credit_limit.override" });
  });

  it("app.principal_has answers for a named principal, honours branch rows and never fails open", async () => {
    const scoped = await secondPrincipal(a, "branch-only");
    const roleId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'bm2b', 'Branch manager')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'accounting.credit_limit.override')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${scoped}, ${roleId}, ${a.company})`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${scoped}, ${roleId}, ${a.company}, ${a.hq})`;
    });
    const [r] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ at_hq: boolean; company_wide: boolean; unknown_code: boolean }[]>`
        select app.principal_has(${scoped}, 'accounting.credit_limit.override', ${a.company}, ${a.hq}) as at_hq,
               app.principal_has(${scoped}, 'accounting.credit_limit.override', ${a.company})          as company_wide,
               app.principal_has(${scoped}, 'accounting.period.close', ${a.company}, ${a.hq})          as unknown_code`,
    );
    expect(r).toEqual({ at_hq: true, company_wide: false, unknown_code: false });
  });

  it("tenant B cannot see or write tenant A's events (spec:106 'a test that a second tenant cannot see it')", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
        values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`,
    );
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.document_event where document_id = ${doc}`,
    );
    expect(seen[0]!.n).toBe(0);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
          insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status)
          values (${a.tenant}, ${a.company}, ${doc}, 'transition', 'draft', 'submitted')`,
      ),
    ).rejects.toThrow(/row-level security|violates row-level security policy/);
  });

  it("the schema linter reports zero violations and the six sets are untouched", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
