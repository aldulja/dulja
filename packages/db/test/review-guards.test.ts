import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot, postDocument } from "../src/posting";
import { setValues } from "../src/custom-fields/service";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

/**
 * The Phase 0/1 data-layer guards the Phase 2 review pass added (migrations 0105–0108) and the two service
 * checks beside them. Each case is the scenario the review described, made to fail.
 */
const ctx = (s: Seed, actor = s.human) => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: `rg-${Math.random().toString(16).slice(2)}`,
});

describe("review remediations — the data layer holds what the API alone used to", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  /** A draft with a balanced pair of lines, written the way post.test.ts writes one. */
  const draftWithLines = async (s: Seed, amount: string): Promise<string> => {
    const id = await draftDocument(db, s);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, ${amount})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, ${amount})`;
    });
    return id;
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  describe("0105 — app.record_system_event is the system's one door into the audit log", () => {
    it("lets app_rw record an integrity incident and a month-end row, hashed into the chain", async () => {
      const c = ctx(a, a.system);
      const seq = await prodWithTenant(
        db.rw,
        c,
        async (tx) =>
          (
            await tx<{ seq: string }[]>`
              select app.record_system_event('integrity_incident', ${c.requestId}, '{"ok":false}'::jsonb)::text as seq`
          )[0]!.seq,
      );
      const [row] = await db.admin<
        { table_name: string; row_id: string; actor_id: string; tenant_id: string; hash: Buffer }[]
      >`select table_name, row_id, actor_id, tenant_id, hash from app.audit_log where seq = ${seq}::bigint`;
      expect(row).toMatchObject({
        table_name: "integrity_incident",
        row_id: c.requestId,
        actor_id: a.system,
        tenant_id: a.tenant,
      });
      expect(row!.hash.byteLength).toBeGreaterThan(0);
    });

    it("admits exactly two table names — it is not a general audit_log writer", async () => {
      await expect(
        prodWithTenant(
          db.rw,
          ctx(a),
          (tx) => tx`select app.record_system_event('company', 'forged', '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/ERR_VALIDATION_FAILED: company is not a system event/);
    });

    it("is SECURITY DEFINER, owned by the migrator, executable by app_rw — and app_rw still has no INSERT on audit_log", async () => {
      const [fn] = await db.admin<{ owner: string; prosecdef: boolean; can_execute: boolean }[]>`
        select pg_get_userbyid(p.proowner) as owner, p.prosecdef,
               has_function_privilege('app_rw', p.oid, 'execute') as can_execute
          from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = 'record_system_event'`;
      expect(fn).toMatchObject({ owner: "app_migrator", prosecdef: true, can_execute: true });
      const grants = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = 'audit_log' order by 1`;
      expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
    });
  });

  describe("0106 — a pinned posting_policy never changes", () => {
    it("refuses to update the version a posted document pins, and to delete any version", async () => {
      const id = await draftWithLines(a, "10.0000");
      await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: id }));
      const [pinned] = await db.admin<{ posting_policy_id: string }[]>`
        select posting_policy_id from app.document where id = ${id}`;
      await expect(
        withTenant(
          db.rw,
          a.tenant,
          a.human,
          (tx) =>
            tx`update app.posting_policy set effective_from = '2025-12-31' where id = ${pinned!.posting_policy_id}`,
        ),
      ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: posting_policy .* is pinned/);
      await expect(
        db.admin`delete from app.posting_policy where id = ${pinned!.posting_policy_id}`,
      ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: posting_policy .* is never deleted/);
    });

    it("still lets an UNPINNED version be replaced — the staging-placeholder case §3.4.8 protects", async () => {
      const [v1] = await db.admin<{ id: string }[]>`
        select id from app.posting_policy where document_type_id = ${b.docType} order by version limit 1`;
      // seedTenantV2 posted nothing in Beta, so version 1 is pinned by no document.
      await withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) =>
          tx`update app.posting_policy set effective_from = '2025-12-01' where id = ${v1!.id}`,
      );
      const [after] = await db.admin<{ effective_from: string }[]>`
        select to_char(effective_from, 'YYYY-MM-DD') as effective_from from app.posting_policy where id = ${v1!.id}`;
      expect(after!.effective_from).toBe("2025-12-01");
    });
  });

  describe("0107 — a closed period is immutable in its dates; a ledger entry fits its period", () => {
    it("refuses to move a closed period's dates or its company", async () => {
      await expect(
        db.admin`update app.fiscal_period set ends_on = '2026-02-15' where id = ${a.closedPeriod}`,
      ).rejects.toThrow(
        /ERR_PERIOD_STATUS_ILLEGAL: fiscal period .* is closed; its dates cannot change/,
      );
      await expect(
        db.admin`update app.fiscal_period set company_id = ${b.company} where id = ${a.period}`,
      ).rejects.toThrow(
        /ERR_PERIOD_STATUS_ILLEGAL: fiscal period .* cannot move to another company/,
      );
    });

    it("refuses to shrink an OPEN period around ledger entries it already holds", async () => {
      const id = await draftWithLines(a, "3.0000"); // effective 2026-01-15 in the open January period
      await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: id }));
      await expect(
        db.admin`update app.fiscal_period set ends_on = '2026-01-10' where id = ${a.period}`,
      ).rejects.toThrow(/holds ledger entries outside/);
      // Widening — or narrowing on the empty side — is fine. An update that succeeds fires the audit
      // trigger, whose SECURITY DEFINER insert into app.audit_log is under forced RLS, so the admin path
      // still needs a tenant context to be let through; the refusals above never get that far.
      await withTenant(db.admin, a.tenant, a.system, async (tx) => {
        await tx`update app.fiscal_period set starts_on = '2026-01-02' where id = ${a.period}`;
        await tx`update app.fiscal_period set starts_on = '2026-01-01' where id = ${a.period}`;
      });
    });

    it("requires a reason to reopen, whatever path writes the row (spec:2179 R8)", async () => {
      await expect(
        db.admin`update app.fiscal_period set status = 'open' where id = ${a.closedPeriod}`,
      ).rejects.toThrow(/ERR_VALIDATION_FAILED: reopening fiscal period .* needs a reason/);
      // Tenant context for the audit row the accepted updates write (see the case above).
      await withTenant(db.admin, a.tenant, a.system, async (tx) => {
        await tx`update app.fiscal_period set status = 'open', reopen_reason = 'audit adjustment'
                  where id = ${a.closedPeriod}`;
        await tx`update app.fiscal_period set status = 'closed' where id = ${a.closedPeriod}`;
      });
    });

    it("refuses a ledger entry whose period does not contain its date or is another company's", async () => {
      const id = await draftWithLines(a, "1.0000");
      const [policy] = await db.admin<{ id: string }[]>`
        select id from app.posting_policy where document_type_id = ${a.docType} order by version desc limit 1`;
      const attempt = (periodId: string) =>
        withTenant(
          db.rw,
          a.tenant,
          a.human,
          (tx) => tx`
            insert into app.ledger_entry
              (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate,
               base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
            values (${a.tenant}, ${a.company}, ${id}, 99, ${a.cash}, 1, 0, 'MYR', 1, 1, 0, '2026-01-15',
                    ${periodId}, ${policy!.id})`,
        );
      // February is closed, and 2026-01-15 is not in it either: the FIT check fires before the OPEN check
      // (trigger names run alphabetically), so the message names the date.
      await expect(attempt(a.closedPeriod)).rejects.toThrow(
        /ERR_PERIOD_NOT_FOUND: 2026-01-15 lies outside/,
      );
      // Beta's period is invisible under Alpha's RLS: "not visible", never "belongs to another company".
      await expect(attempt(b.period)).rejects.toThrow(
        /ERR_PERIOD_NOT_FOUND: fiscal period .* is not visible/,
      );
    });

    it("refuses a zero POS rounding increment on the column", async () => {
      await expect(
        withTenant(
          db.rw,
          a.tenant,
          a.human,
          (tx) => tx`insert into app.currency (tenant_id, code, name_en, pos_rounding_increment)
                     values (${a.tenant}, 'ZZZ', 'Zero increment', 0)`,
        ),
      ).rejects.toThrow(/currency_pos_rounding_increment_positive/);
    });
  });

  describe("0108 — an assignment names a member of the tenant", () => {
    it("refuses a role assignment to another tenant's principal at the trigger, by name", async () => {
      const [role] = await db.admin<{ id: string }[]>`
        select id from app.role where tenant_id = ${a.tenant} limit 1`;
      await expect(
        withTenant(
          db.migrator,
          a.tenant,
          a.system,
          (tx) => tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
                     values (${a.tenant}, ${b.human}, ${role!.id}, ${a.company})`,
        ),
      ).rejects.toThrow(/ERR_RBAC_KIND: principal .* is not a member of this tenant/);
    });

    it("holds the membership key in the schema, not only in the trigger", async () => {
      const rows = await db.admin<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def from pg_constraint
         where conname in ('role_assignment_membership_fk', 'pos_terminal_membership_fk') order by 1`;
      expect(rows.map((r) => r.conname)).toEqual([
        "pos_terminal_membership_fk",
        "role_assignment_membership_fk",
      ]);
      for (const row of rows)
        expect(row.def).toMatch(/REFERENCES app\.membership\(tenant_id, principal_id\)/);
    });
  });

  describe("the posting service re-validates every planned account at post time", () => {
    it("refuses to post to an account archived after the line was written", async () => {
      const c = await seedTenantV2(db, "Gamma");
      await grantCodes(db, c, { codes: ["accounting.journal.post"] });
      const id = await draftWithLines(c, "4.0000");
      // Under a tenant context: the update is audited, and app.audit_log's forced RLS refuses a row without one.
      await withTenant(
        db.admin,
        c.tenant,
        c.system,
        (tx) => tx`update app.account set archived_at = now() where id = ${c.sales}`,
      );
      const raised = await prodWithTenant(db.rw, ctx(c), (tx) =>
        postDocument(tx, ctx(c), { documentId: id }),
      ).catch((e: unknown) => e as Error);
      expect(String((raised as Error).message)).toMatch(
        /ERR_POLICY_REQUIRES_MISSING: planned line 2 .* is not a live, postable account/,
      );
      const [entries] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where document_id = ${id}`;
      expect(entries!.n).toBe(0);
    });
  });

  describe("custom-field values are bound to the company on both sides", () => {
    it("setValues refuses an entity of another company, worded like an invented id", async () => {
      const definitionId = await uuidv7(db.admin);
      await withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (
          tx,
        ) => tx`insert into app.custom_field_definition (id, tenant_id, company_id, entity, code, name_en, kind)
                   values (${definitionId}, ${a.tenant}, ${a.company}, 'document', 'KIND', 'Kind', 'text')`,
      );
      // A second company in tenant A, with a document of its own.
      const second = await uuidv7(db.admin);
      const foreignDoc = await uuidv7(db.admin);
      await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${second}, ${a.tenant}, 'SECOND', 'Alpha second', 'MYR')`;
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${foreignDoc}, ${a.tenant}, ${second}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      });
      const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
        setValues(tx, a.company, "document", foreignDoc, [{ definitionId, value: "x" }]),
      );
      expect(result).toEqual({
        ok: false,
        errors: [{ path: "entityId", message: `no document ${foreignDoc} in this company` }],
      });
      const [n] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.custom_field_value where entity_id = ${foreignDoc}`;
      expect(n!.n).toBe(0);
    });

    it("loadSnapshot ignores a value another company wrote against this document's id", async () => {
      const id = await draftWithLines(a, "2.0000");
      const second = await uuidv7(db.admin);
      const definitionId = await uuidv7(db.admin);
      await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${second}, ${a.tenant}, 'THIRD', 'Alpha third', 'MYR')`;
        await tx`insert into app.custom_field_definition (id, tenant_id, company_id, entity, code, name_en, kind)
                 values (${definitionId}, ${a.tenant}, ${second}, 'document', 'kind', 'Kind', 'text')`;
        await tx`insert into app.custom_field_value (tenant_id, definition_id, entity_id, value)
                 values (${a.tenant}, ${definitionId}, ${id}, '"steered"'::jsonb)`;
      });
      const snapshot = await prodWithTenant(db.rw, ctx(a), (tx) => loadSnapshot(tx, id));
      expect(snapshot.header.customFields).not.toHaveProperty("kind");
    });
  });
});
