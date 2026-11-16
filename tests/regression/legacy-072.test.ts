import { grantCodes } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-072",
  "Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const [checks] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint c join pg_class t on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = 'app' and c.contype = 'c'`;
    expect(checks!.n).toBeGreaterThan(0);

    // Mutually exclusive states are one discriminator (an enum or a CHECK), never a fan of booleans.
    const [accountType] = await db.admin<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'type'`;
    expect(accountType!.udt_name).toBe("account_type");

    // `AccTypes` carried thirty booleans and zero CHECKs. `app.account` carries exactly one — `is_group`, which
    // is genuinely two-valued and orthogonal to `type` — and its five mutually exclusive states are the enum.
    const accountBooleans = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and data_type = 'boolean' order by column_name`;
    expect(accountBooleans.map((c) => c.column_name)).toEqual(["is_group"]);

    // And no column encodes an amount as a float, which is the same class of untyped defect (spec:2041).
    const floats = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and data_type in ('real', 'double precision')`;
    expect(floats).toEqual([]);
  },
);

// ─── 2A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above. The cases go
// through `sliceRegression` because 0B's body destructures `expect` — a module-scope import here would be
// shadowed by it (`no-shadow`) — and the third needs the production `withTenant` the context hands over.
import { sliceRegression } from "../support/regression";
import { seedTenantV2, uuidv7 } from "@dulja/db/test";

const LEGACY_072 =
  "Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states";

sliceRegression(
  "LEGACY-072",
  LEGACY_072,
  "2A",
  "every closed vocabulary this slice adds is a NAMED CHECK, and 6A and 8B drop two of them by name",
  async ({ db, expect }) => {
    const rows = await db.admin<{ conname: string; def: string }[]>`
      select c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
        join pg_namespace ns on ns.oid = t.relnamespace
       where ns.nspname = 'app' and c.contype = 'c'
         and c.conname in ('party_kind_check', 'document_type_module_check', 'document_line_kind_check')
       order by c.conname`;
    expect(rows.map((r) => r.conname)).toEqual([
      "document_line_kind_check",
      "document_type_module_check",
      "party_kind_check",
    ]);

    // The names are load-bearing, not cosmetic: 6A's 0061 and 8B's 0087 each DROP document_line_kind_check by
    // name and re-add it with the complete label union, and either phase may execute first (spec:2301).
    expect(rows.find((r) => r.conname === "party_kind_check")!.def).toMatch(
      /customer.*vendor.*employee.*student.*dealer/s,
    );
    expect(rows.find((r) => r.conname === "document_type_module_check")!.def).toMatch(
      /accounting.*inventory.*hr.*pos/s,
    );
  },
);

sliceRegression(
  "LEGACY-072",
  LEGACY_072,
  "2A",
  "the two tables this slice touches encode their states as a discriminator, and add no boolean at all",
  async ({ db, expect }) => {
    // `Account` carried twenty Is* flags; spec:1169 splits it into a GL-only Account and a Party whose one
    // `kind` column carries five mutually exclusive values. A party is never "IsCustomer AND IsVendor".
    // ONE named boolean since 4A, and only one: contracts §4.5.7 registers `party.credit_hold boolean not null
    // default false` (migration 0045, 4A T3). It is a single independent flag — "sales to this party are
    // held" — not one of several mutually exclusive states, which is what LEGACY-072 names; the party's kind is
    // still the one `kind` discriminator below. Listed exactly, so any other boolean on either table fails.
    const admitted: Record<string, string[]> = { party: ["credit_hold"], document_line: [] };
    for (const table of ["party", "document_line"]) {
      const booleans = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} and data_type = 'boolean'
         order by column_name`;
      expect(
        booleans.map((b) => b.column_name),
        table,
      ).toEqual(admitted[table]);
    }
    const [kind] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'party' and column_name = 'kind'`;
    expect(kind!.data_type).toBe("text"); // text + CHECK, never an enum (§3.4.4)
  },
);

sliceRegression(
  "LEGACY-072",
  LEGACY_072,
  "2A",
  "the vocabulary refuses a value outside it, at the database, whatever the caller is",
  async ({ rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy072-2a" };
    // Not through the API, not through a fixture: straight at app_rw, which is the only proof that matters.
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`
          insert into app.party (tenant_id, company_id, kind, code, name_en)
          values (${a.tenant}, ${a.company}, 'supplier', 'LEGACY072-supplier', 'Bad kind')`,
      ),
    ).rejects.toThrow(/party_kind_check/);
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "LEGACY-072",
  "Zero CHECK constraints across 460 tables, and 544 boolean columns encoding mutually exclusive states",
  "2B",
  "document_event carries one discriminator and a CHECK that makes every incoherent row impossible",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY072-2B");
    await grantCodes(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy072-2b" };
    // No boolean column at all: `event_kind` is the one discriminator, with a CHECK tying override_code and
    // the status pair to it (contracts §4.5.2) — not `is_override` + `is_transition` + `is_deleted`.
    const bools = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_event' and data_type = 'boolean'`;
    expect(bools).toEqual([]);
    const checks = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
       where conrelid = 'app.document_event'::regclass and contype = 'c'`;
    expect(checks[0]!.n).toBeGreaterThanOrEqual(2); // event_kind's IN list and the coherence CHECK
    const doc = await uuidv7(db.admin);
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
        values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`,
    );
    for (const row of [
      { kind: "transition", from: "draft", to: "draft", code: null }, // a transition that changes nothing
      { kind: "override", from: "draft", to: "submitted", code: null }, // an override that moves the status
      { kind: "wandering", from: "draft", to: "submitted", code: null }, // a kind outside the closed set
    ]) {
      // The override row is written as the tenant's SYSTEM principal, which `app.principal_has` admits whatever
      // the code and which is not the document's creator: BEFORE INSERT triggers run ahead of CHECK
      // constraints, so as `s.human` 2B's override guard refuses the code-less row first ("does not hold
      // <NULL>") and the CHECK under test is never reached (the same fix packages/db/test/document-event.test.ts
      // carries).
      const rowCtx = row.kind === "override" ? { ...ctx, actorId: s.system } : ctx;
      await expect(
        withTenant(
          rw,
          rowCtx,
          (tx) => tx`
            insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status, override_code)
            values (${s.tenant}, ${s.company}, ${doc}, ${row.kind}, ${row.from}::app.document_status,
                    ${row.to}::app.document_status, ${row.code})`,
        ),
        JSON.stringify(row),
      ).rejects.toThrow(
        /document_event_check|document_event_event_kind_check|violates check constraint/,
      );
    }
  },
);
