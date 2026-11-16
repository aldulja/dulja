// packages/db/test/sync/pos-columns.test.ts — 6A Task 4 (migration 0061): the POS columns and the per-terminal
// numbering suffix. Adapted from the plan's Step 1 (phase-6a:1474-1572): the grant moves to `beforeAll`
// because 6C's 0068 branch-isolation policies refuse a draft by a principal with no live role assignment, the
// `SERIES_TEST` type and its account are seeded once, and the terminal comes from `seedTerminal` — production's
// `createTerminal`, which satisfies R8 and the 0068 policies — rather than raw principal and terminal inserts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedTenantV2,
  seedTerminal,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const SERIES_POLICY = {
  version: 1,
  documentType: "SERIES_TEST",
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "POS", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

describe("migration 0061 — the POS columns and the per-terminal numbering suffix (§4.3.6, spec:1721)", () => {
  let db: Db;
  let s: Seed;
  let typeId: string;
  let cash: string;

  const post = async (documentId: string) => {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    return prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));
  };
  const draft = (amount: string) =>
    draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "POS",
      lines: [
        { kind: "account", accountId: cash, debit: amount },
        { kind: "account", accountId: s.sales, credit: amount },
      ],
    });

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Alpha");
    // `accounting.journal.post` is SERIES_POLICY's `approval.post`; the role assignment it creates is also
    // what 0068's branch_isolation policies need before `s.human` may draft at all.
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    typeId = await seedDocumentType(db, s, { code: "SERIES_TEST", policy: SERIES_POLICY });
    cash = await seedAccount(db, s, { code: "1001", nameEn: "Petty cash", type: "asset" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("document_line.kind admits all six labels — the union 8B's 0087 also writes (§4.3.4)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'document_line_kind_check'`;
    for (const label of ["account", "item", "tax", "text", "tender", "payroll"])
      expect(c!.def).toContain(`'${label}'`);
  });

  it("document.shift_id exists, is nullable, and carries NO foreign key (Task 0 amendment 6, 6D's A2)", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'shift_id'`;
    expect(cols).toEqual([{ column_name: "shift_id", data_type: "uuid", is_nullable: "YES" }]);
    // The absence of the key IS the assertion, not an oversight (6A Task 0 amendment 6; 6D amendment A2):
    // app.shift is 6D's table and PostgreSQL's referential-integrity scan bypasses row security, so a
    // validated key could not be added at 0070 either — it would see every ticket synced before 6D, each naming
    // a shift with no row, and FORCE RLS stops a migration backfilling the parents. 6D enforces the reference
    // in the apply path (`assertShiftKnown`) and adds only the index `document_shift_idx`.
    const keysOn = async (column: "shift_id" | "terminal_id") =>
      (
        await db.admin<{ conname: string }[]>`
        select con.conname from pg_constraint con
         where con.conrelid = 'app.document'::regclass and con.contype = 'f'
           and exists (select 1 from pg_attribute a
                        where a.attrelid = con.conrelid and a.attnum = any (con.conkey)
                          and a.attname = ${column})`
      ).map((r) => r.conname);
    expect(await keysOn("shift_id")).toEqual([]);
    // The control that keeps the empty answer above honest: the same query finds 0061's key on the column
    // beside it, so `[]` means "no key", not "a query that matches nothing".
    expect(await keysOn("terminal_id")).toEqual(["document_terminal_fk"]);
  });

  it("pos_terminal.code is nullable (expand — §3.4.7) and unique per company", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'pos_terminal' and column_name = 'code'`;
    expect(cols).toEqual([{ column_name: "code", is_nullable: "YES" }]);
    const [key] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'pos_terminal_company_id_code_key' and conrelid = 'app.pos_terminal'::regclass`;
    expect(key?.def).toBe("UNIQUE (company_id, code)");
    // And it holds through production's own terminal creation, not only in the catalogue.
    await seedTerminal(db, s, { code: "DUP1" });
    await expect(seedTerminal(db, s, { code: "DUP1" })).rejects.toThrow(
      /pos_terminal_company_id_code_key|duplicate key/,
    );
  });

  it("a document with NO terminal numbers on the policy series, unchanged (every pre-6A type)", async () => {
    const { documentId } = await draft("10.0000");
    const out = await post(documentId);
    expect(out.series).toBe("POS");
  });

  it("a document carrying a terminal numbers on '<series>-<terminal code>' (§4.14, spec:1721)", async () => {
    const { terminalId } = await seedTerminal(db, s, { code: "KL01" });
    const { documentId } = await draft("5.0000");
    // Tagged while still a draft: 0117 freezes the header once the document leaves draft.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document set terminal_id = ${terminalId} where id = ${documentId}`,
    );
    const out = await post(documentId);
    expect(out.series).toBe("POS-KL01");
    // Two independent counters, which is the whole point (test 16's 6A re-run): the untagged document above
    // took POS #1 and this one takes POS-KL01 #1, not #2.
    expect(out.number).toBe(1n);
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ series: string }[]>`
      select series from app.document_series where company_id = ${s.company} order by series`,
    );
    expect(rows.map((r) => r.series)).toEqual(["POS", "POS-KL01"]);
  });
});
