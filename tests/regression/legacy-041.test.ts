import { grantCodes, draftDocument, seedTenantV2, uuidv7 } from "@dulja/db/test";
import { repoFile, sliceRegression, thinRegression } from "../support/regression";
import { postLines } from "../support/ledger";
import { postDocument } from "@dulja/db";

thinRegression(
  "LEGACY-041",
  "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "packages/db/test/ledger.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "legacy-041" };
    const doc = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, (tx) =>
      postLines(tx, a, doc, [
        { account: a.cash, debit: "10" },
        { account: a.sales, credit: "10" },
      ]),
    );

    // Braces: the trigger refuses even the schema owner. Belt: app_rw has no privilege at all.
    await expect(
      db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
        await tx`delete from app.ledger_entry where document_id = ${doc}`;
      }),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(
      withTenant(rw, ctx, (tx) => tx`delete from app.ledger_entry where document_id = ${doc}`),
    ).rejects.toThrow(/permission denied/);

    const [c] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.ledger_entry where document_id = ${doc}`,
    );
    expect(c!.n).toBe(2);
  },
);

sliceRegression(
  "LEGACY-041",
  "Hard deletes; anti-tampering triggers shipped disabled",
  "1A",
  "a posted document's ledger cannot be updated or deleted by anyone, and the trigger is enabled",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY041-1A");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy041" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 12.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 2, ${seed.sales}, 12.0000)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`update app.ledger_entry set debit = 0 where document_id = ${doc}`,
      ),
    ).rejects.toThrow(/permission denied|ERR_TABLE_IMMUTABLE/);
    const [trigger] = await db.admin<{ tgenabled: string }[]>`
      select tgenabled::text as tgenabled from pg_trigger
       where tgrelid = 'app.ledger_entry'::regclass and tgname = 'ledger_entry_immutable'`;
    // 'O' = enabled for origin; never 'D'.
    expect(trigger!.tgenabled).toBe("O");
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "LEGACY-041",
  "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "2B",
  "a posted document cannot be hard-deleted, and both guard triggers are ENABLED, not inactive",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY041-2B");
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "legacy041-post" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy041" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 5.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 5.0000)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    await expect(
      withTenant(rw, ctx, (tx) => tx`delete from app.document where id = ${doc}`),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // The legacy shipped its only guards as `inactive`. 'O' = enabled for origin; 'D' would be disabled.
    const triggers = await db.admin<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled::text as tgenabled from pg_trigger
       where tgname in ('document_delete_draft_only', 'document_line_delete_draft_only',
                        'document_status_before', 'document_status_after', 'document_event_immutable')
       order by tgname`;
    expect(triggers).toHaveLength(5);
    expect(triggers.every((t) => t.tgenabled === "O")).toBe(true);
  },
);

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; 4A appends and never edits the blocks above. §4.8.1: a receipt
// relieves the control account when it POSTS, and app.allocation records the apportionment — so reversing an
// allocation is an UPDATE of its own row and never a change to a posted entry (spec:2457).
sliceRegression(
  "LEGACY-041",
  "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "4A",
  "app_rw holds no DELETE on app.allocation, and its audit and stamp triggers are ENABLED",
  async ({ db, expect }) => {
    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'allocation'
         and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
    // The legacy shipped its guards `inactive`. 'O' = enabled for origin; 'D' would be disabled.
    const triggers = await db.admin<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled::text as tgenabled from pg_trigger
       where tgrelid = 'app.allocation'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "allocation_guard", // 0046 §5: only the un-allocation may change a row, once
      "audit_row",
      "stamp_allocated_by",
      "stamp_unallocated_by",
    ]);
    expect(triggers.every((t) => t.tgenabled === "O")).toBe(true);
  },
);

sliceRegression(
  "LEGACY-041",
  "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "4A",
  "`allocation` is NOT in the posting-only-tables list, and that is deliberate",
  async ({ expect }) => {
    const rule = repoFile("scripts/lint/rules/posting-only-tables.ts");
    // Listing it would forbid the service that legitimately writes it (packages/db/src/ar-ap/allocation.ts).
    expect(rule).not.toMatch(/app\.allocation/);
    expect(rule).toMatch(/"app\.ledger_entry"/);
  },
);

// ─── 4B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; 4B appends and never edits the blocks above. ADR 0048: a bank match
// is reversed by setting `unmatched_at`, never deleted, and its guards ship ENABLED — the legacy shipped its
// anti-tampering triggers `inactive`.
sliceRegression(
  "LEGACY-041",
  "Nothing in reconciliation is deleted, and no control is optional",
  "4B",
  "app_rw holds no DELETE on any of this slice's tables, and §3.5.4's pinned list is still its five rows",
  async ({ db, expect }) => {
    const mine = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
         and table_name in ('party_ageing', 'item_profitability', 'bank_statement',
                            'bank_statement_line', 'bank_match', 'pdc')`;
    expect(mine).toEqual([]);
    const all = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
       order by table_name`;
    expect([...new Set(all.map((r) => r.table_name))]).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
  },
);

sliceRegression(
  "LEGACY-041",
  "Nothing in reconciliation is deleted, and no control is optional",
  "4B",
  "bank_match's guard, audit and stamp triggers are ENABLED, and an unmatched row always names its actor",
  async ({ db, expect }) => {
    const triggers = await db.admin<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled::text as tgenabled from pg_trigger
       where tgrelid = 'app.bank_match'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "audit_row",
      "bank_match_guard", // 0050 §5: live at insert; only the unmatch may change a row, once, with a reason
      "stamp_matched_by",
      "stamp_unmatched_by",
    ]);
    // 'O' = enabled for origin; 'D' would be disabled.
    expect(triggers.every((t) => t.tgenabled === "O")).toBe(true);
    const [pair] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_unmatch_pair_check'`;
    expect(pair!.def).toContain("unmatched_at");
    expect(pair!.def).toContain("unmatched_by");
  },
);

sliceRegression(
  "LEGACY-041",
  "Nothing in reconciliation is deleted, and no control is optional",
  "4B",
  "`bank_match` is NOT in the posting-only-tables list, and that is deliberate",
  async ({ expect }) => {
    const rule = repoFile("scripts/lint/rules/posting-only-tables.ts");
    // Listing it would forbid the service that legitimately writes it (packages/db/src/ar-ap/reconciliation.ts);
    // what the list protects — the ledger — is what reconciliation never writes.
    expect(rule).not.toMatch(/app\.bank_(match|statement)/);
    expect(rule).toMatch(/"app\.ledger_entry"/);
  },
);

// ─── code review 3 (R10, migration 0117) ─────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended; it edits none of the blocks above. "Issued financial documents are immutable"
// (spec:574) reached the ledger (1A) and, since 0113, the lines; the header stayed writable to any app_rw
// session. 0117 freezes it once the document leaves draft, keeps the posting fields the posting service's
// alone, and ships ENABLED. Column by column, every status: `packages/db/test/document-header-guard.test.ts`.
sliceRegression(
  "LEGACY-041",
  "Documents are hard-deleted and the anti-tampering controls are shipped disabled",
  "code review 3",
  "a posted document's header cannot be rewritten by app_rw, a draft carries no posting_seq, and the guard is ENABLED",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "LEGACY041-CR3");
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "legacy041-cr3" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const journal = async (): Promise<string> => {
      const doc = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 7.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 7.0000)`;
      });
      return doc;
    };
    const header = async (doc: string) => {
      const [row] = await db.admin<{ h: unknown }[]>`
        select to_jsonb(d) as h from app.document d where d.id = ${doc}`;
      return row!.h;
    };

    const posted = await journal();
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: posted }));
    const before = await header(posted);
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`update app.document set effective_date = '2026-01-20' where id = ${posted}`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is posted; its header cannot be changed \(effective_date\)/,
    );
    await expect(
      withTenant(rw, ctx, (tx) => tx`update app.document set number = 999999 where id = ${posted}`),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is posted; its header cannot be changed \(number\)/,
    );
    expect(await header(posted)).toEqual(before);

    // A draft is free — except for the fields only the posting service writes.
    const draft = await journal();
    await expect(
      withTenant(rw, ctx, (tx) => tx`update app.document set posting_seq = 7 where id = ${draft}`),
    ).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* is draft; posting_seq is written by the posting service/,
    );

    // The legacy shipped its guards `inactive`. 'O' = enabled for origin; 'D' would be disabled.
    const [trigger] = await db.admin<{ tgenabled: string }[]>`
      select tgenabled::text as tgenabled from pg_trigger
       where tgrelid = 'app.document'::regclass and tgname = 'document_header_frozen_after_draft'`;
    expect(trigger!.tgenabled).toBe("O");
  },
);

sliceRegression(
  "LEGACY-041",
  "Till controls ship enabled",
  "6D",
  "immutable trigger, restrictive forced RLS and privileges are active",
  async ({ db, expect }) => {
    const triggers = await db.admin<
      { table: string; name: string; enabled: string }[]
    >`select c.relname as table,t.tgname as name,t.tgenabled::text as enabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relname in ('shift','till_event') and not t.tgisinternal`;
    expect(triggers.every((t) => t.enabled === "O")).toBe(true);
    expect(triggers.map((t) => `${t.table}:${t.name}`)).toContain("shift:audit_row");
    expect(triggers.map((t) => `${t.table}:${t.name}`)).toContain(
      "till_event:till_event_immutable",
    );
    const policies = await db.admin<
      { table: string; policy: string; permissive: string; forced: boolean }[]
    >`select p.tablename as table,p.policyname as policy,p.permissive,c.relforcerowsecurity as forced from pg_policies p join pg_class c on c.relname=p.tablename join pg_namespace n on n.oid=c.relnamespace and n.nspname=p.schemaname where p.schemaname='app' and p.tablename in ('shift','till_event')`;
    expect(policies).toHaveLength(4);
    expect(policies.every((p) => p.forced)).toBe(true);
    expect(
      policies
        .filter((p) => p.policy === "branch_isolation")
        .every((p) => p.permissive === "RESTRICTIVE"),
    ).toBe(true);
    expect(
      policies
        .filter((p) => p.policy === "tenant_isolation")
        .every((p) => p.permissive === "PERMISSIVE"),
    ).toBe(true);
    expect(new Set(policies.map((p) => p.policy))).toEqual(
      new Set(["tenant_isolation", "branch_isolation"]),
    );
    const grants = await db.admin<
      { table: string; privilege: string }[]
    >`select table_name as table,privilege_type as privilege from information_schema.role_table_grants where grantee='app_rw' and table_schema='app' and table_name in ('shift','till_event')`;
    expect(
      grants
        .filter((g) => g.table === "till_event")
        .map((g) => g.privilege)
        .toSorted(),
    ).toEqual(["INSERT", "SELECT"]);
    expect(grants.some((g) => g.privilege === "DELETE")).toBe(false);
  },
);

// ⚠️ OD-10 only (6D Task 13 Step 2), and gated by the FILE the owner's answer lands in rather than by a
// comment: with no `docs/owner/od-10/` directory, Tasks 9–11 were dropped and `till_banking` is not a
// registered `Reconcilable` kind. `it.skip` reports the case as skipped, which is the honest state — an
// omitted case disappears from the run, and a body-less `it` passes and claims a clause nothing tested.
//
// It asserts SCHEMA, not a transaction: `sharedDb()` has no POS corpus, so there is no banking document to
// unmatch here. The behavioural half (unmatch sets `unmatched_at`, re-match restores it, no ledger row
// moves) belongs to the tier that has a banking, `tests/invariants/pos-till-banking`, which OD-10 creates.
// `expect` is the test context's, as in the LEGACY-031 6D block, so nothing at module scope shadows the
// destructured `expect` of the blocks above.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { reconcilableSources } from "@dulja/db";
import { REPO_ROOT } from "../support/source";
import { sharedDb } from "../support/regression";

const OD10 = existsSync(join(REPO_ROOT, "docs/owner/od-10"));

describe("LEGACY-041 Till controls ship enabled — 6D, ⚠️ OD-10", () => {
  (OD10 ? it : it.skip)(
    "a bank match can only be unmatched, never deleted — the grant and the column say so (§4.8.3)",
    async ({ expect }) => {
      const { db } = await sharedDb();
      // 1. `app_rw` holds no DELETE on `app.bank_match`: §3.5.4 pins the whole DELETE list (4B's block above
      //    asserts it), so a `delete from app.bank_match` in any handler is a privilege error.
      const grants = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = 'bank_match'
           and privilege_type = 'DELETE'`;
      expect(grants).toEqual([]);

      // 2. The retention column exists and is nullable — the "unmatched, not gone" representation.
      const [col] = await db.admin<{ is_nullable: string; data_type: string }[]>`
        select is_nullable, data_type from information_schema.columns
         where table_schema = 'app' and table_name = 'bank_match' and column_name = 'unmatched_at'`;
      expect(col!.is_nullable).toBe("YES");
      expect(col!.data_type).toBe("timestamp with time zone");

      // 3. `till_banking` is a registered kind, so the clause has a subject at all. The registry is a Map:
      //    a source that REPLACED one of 4B's would leave the count unchanged, not add a kind.
      const kinds = reconcilableSources().map((s) => s.kind);
      expect(kinds).toContain("till_banking");
      expect(new Set(kinds).size).toBe(kinds.length);
    },
  );
});
