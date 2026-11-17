import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  grantCodes,
  JOURNAL_POLICY_V1,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "req-reverse",
});

async function draftWithLines(
  db: Db,
  seed: Seed,
  lines: { account: string; debit?: string; credit?: string }[],
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
    await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
             values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${seed.tenant}, ${seed.company}, ${id}, ${lineNo}, ${line.account}, ${line.debit ?? "0"}, ${line.credit ?? "0"})`;
    }
  });
  return id;
}

describe("reverseDocument and voidDocument — D13, spec:1745, LEGACY-002/041/051", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("creates a mirror document, posts it, and marks the original reversed", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    const reversal = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: doc,
        effectiveDate: "2026-01-20",
        reason: "keyed to the wrong account",
      }),
    );

    const [original] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`,
    );
    expect(original!.status).toBe("reversed");

    const [mirror] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        { status: string; series: string; reverses: string; effective_date: string }[]
      >`select status::text as status, series, reverses_document_id::text as reverses,
             to_char(effective_date, 'YYYY-MM-DD') as effective_date
        from app.document where id = ${reversal.reversalDocumentId}`,
    );
    expect(mirror).toMatchObject({
      status: "posted",
      series: "JV",
      reverses: doc,
      effective_date: "2026-01-20",
    });

    const entries = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        { account_id: string; debit: string; credit: string }[]
      >`select account_id::text as account_id, debit::text as debit, credit::text as credit
        from app.ledger_entry where document_id = ${reversal.reversalDocumentId} order by line_no`,
    );
    // Ledger line numbers follow the policy's rules, not the document's lines: JOURNAL_POLICY_V1 plans
    // every debit before every credit, so the mirror's debit (sales) is ledger line 1 and its credit
    // (cash) line 2 — each document line still lands on the opposite side of the original's.
    expect(entries).toEqual([
      { account_id: a.sales, debit: "100.0000", credit: "0.0000" },
      { account_id: a.cash, debit: "0.0000", credit: "100.0000" },
    ]);
  });

  it("test 3 — re-key a posting: sum(account_balance) equals sum(ledger_entry) after reverse and re-post", async () => {
    const wrong = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const never = await seedAccount(db, a, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });

    const first = await draftWithLines(db, a, [
      { account: wrong, debit: "250.0000" },
      { account: a.sales, credit: "250.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: first }));
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: first,
        effectiveDate: "2026-01-16",
        reason: "wrong account",
      }),
    );

    const second = await draftWithLines(db, a, [
      { account: never, debit: "250.0000" },
      { account: a.sales, credit: "250.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: second }));

    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        { account_id: string; projected: string; posted: string }[]
      >`select b.account_id::text as account_id,
             (b.base_debit - b.base_credit)::text as projected,
             (coalesce(sum(l.base_debit), 0) - coalesce(sum(l.base_credit), 0))::text as posted
        from app.account_balance b
        left join app.ledger_entry l
          on l.company_id = b.company_id and l.account_id = b.account_id
         and l.fiscal_period_id = b.fiscal_period_id and l.currency = b.currency
       group by b.account_id, b.base_debit, b.base_credit
       order by 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.projected).toBe(row.posted);

    const [wrongBalance] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ net: string }[]>`
      select (base_debit - base_credit)::text as net from app.account_balance
       where account_id = ${wrong} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    // The mis-keyed account nets to nothing (LEGACY-002).
    expect(wrongBalance!.net).toBe("0.0000");
    const [neverBalance] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ net: string }[]>`
      select (base_debit - base_credit)::text as net from app.account_balance
       where account_id = ${never} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(neverBalance!.net).toBe("250.0000");
  });

  it("refuses to reverse anything that is not posted, and refuses a second reversal", async () => {
    const draft = await draftWithLines(db, a, [
      { account: a.cash, debit: "1.0000" },
      { account: a.sales, credit: "1.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        reverseDocument(tx, ctx(a), {
          documentId: draft,
          effectiveDate: "2026-01-20",
          reason: "no",
        }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });

    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: draft }));
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: draft,
        effectiveDate: "2026-01-20",
        reason: "once",
      }),
    );
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        reverseDocument(tx, ctx(a), {
          documentId: draft,
          effectiveDate: "2026-01-20",
          reason: "twice",
        }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a reversal into a closed period — the correction must land somewhere open (spec:2224)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "3.0000" },
      { account: a.sales, credit: "3.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        reverseDocument(tx, ctx(a), {
          documentId: doc,
          effectiveDate: "2026-03-15",
          reason: "into a locked period",
        }),
      ),
    ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
  });

  it("voids an issued document and records the number so the gap is explained (LEGACY-051)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "9.0000" },
      { account: a.sales, credit: "9.0000" },
    ]);
    const { number, series, fiscalPeriodId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      issueDocument(tx, ctx(a), { documentId: doc }),
    );
    await prodWithTenant(db.rw, ctx(a), (tx) =>
      voidDocument(tx, ctx(a), {
        documentId: doc,
        reason: "printed on the wrong stationery",
      }),
    );

    const [header] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`,
    );
    expect(header!.status).toBe("void");
    const [voided] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ reason: string; voided_by: string }[]>`
      select reason, voided_by::text as voided_by from app.document_number_void
       where company_id = ${a.company} and series = ${series} and fiscal_period_id = ${fiscalPeriodId} and number = ${number.toString()}::bigint`,
    );
    expect(voided).toMatchObject({
      reason: "printed on the wrong stationery",
      voided_by: a.human,
    });
  });

  it("refuses to void a draft (it has no number) and a posted document (spec:2224)", async () => {
    const draft = await draftWithLines(db, a, [
      { account: a.cash, debit: "2.0000" },
      { account: a.sales, credit: "2.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        voidDocument(tx, ctx(a), { documentId: draft, reason: "no number yet" }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });

    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: draft }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        voidDocument(tx, ctx(a), { documentId: draft, reason: "too late" }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a reversal when the policy forbids one", async () => {
    const noReversal = {
      ...(JSON.parse(JSON.stringify(JOURNAL_POLICY_V1)) as Record<string, unknown>),
      reversal: { allowed: false, producesType: null },
    };
    const typeId = await uuidv7(db.admin);
    const policyId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${typeId}, ${a.tenant}, ${a.company}, 'NOREV', 'No reversal')`;
      await tx`insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
               values (${policyId}, ${a.tenant}, ${typeId}, 1, '2026-01-01', ${JSON.stringify({ ...noReversal, documentType: "NOREV" })}::text::jsonb)`;
    });
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${a.tenant}, ${a.company}, ${typeId}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 4.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${doc}, 2, ${a.sales}, 4.0000)`;
    });
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        reverseDocument(tx, ctx(a), {
          documentId: doc,
          effectiveDate: "2026-01-20",
          reason: "not allowed",
        }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });
});

describe("reverseDocument on a generalised line — D13, contracts §4.3.1", () => {
  let db: Db;
  let a: Seed;
  let typeId: string;
  const POLICY_TEST = {
    version: 1,
    documentType: "POLICY_TEST",
    direction: "internal",
    requires: [],
    lines: [
      {
        for: "each_line",
        side: "debit",
        account: { code: "1000" },
        amount: "line.amount",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { code: "4000" },
        amount: "line.amount",
        when: { "line.kind": "item" },
      },
    ],
    inventory: { effect: "none" },
    tax: { applies: false },
    numbering: { series: "PT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "POLICY_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    typeId = await seedDocumentType(db, a, { code: "POLICY_TEST", policy: POLICY_TEST });
  });
  afterAll(async () => {
    await db.stop();
  });

  const postItemDocument = async (line: Record<string, unknown>): Promise<string> => {
    return prodWithTenant(db.rw, ctx(a), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line ${tx({
        id: await uuidv7(db.admin),
        tenant_id: a.tenant,
        company_id: a.company,
        document_id: id,
        line_no: 1,
        kind: "item",
        ...line,
      })}`;
      await postDocument(tx, ctx(a), { documentId: id });
      return id;
    });
  };

  it("carries every 0019 column onto the reversal, negating the signed magnitudes", async () => {
    // 3A's 0032 added document_line_item_fk, so item_id must name a real row (assumption 10). Every
    // assertion below is unchanged — the reversal still mirrors the line it was built from.
    const { itemId: item } = await seedItem(db, a, { code: "ITM-2A" });
    const source = await postItemDocument({
      item_id: item,
      quantity: "3.000000",
      unit_price: "10.0000",
      discount: "1.5000",
      amount: "28.5000",
      tax_amount: "1.7100",
      total_incl_tax: "30.2100",
      // Objects, not their JSON text: postgres.js serialises a jsonb parameter with JSON.stringify, so a
      // string here is stored as a jsonb STRING — and `{}` read back as "{}" names dimension types 0 and 1.
      dimensions: {},
      custom_fields: { note: "keep me" },
    });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: source,
        effectiveDate: "2026-01-20",
        reason: "wrong quantity",
      }),
    );

    const [l] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<Record<string, string | null>[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               discount::text as discount, amount::text as amount, tax_amount::text as tax_amount,
               total_incl_tax::text as total_incl_tax, cost::text as cost, custom_fields::text as custom_fields
          from app.document_line where document_id = ${reversalDocumentId}`,
    );
    expect(l).toEqual({
      kind: "item",
      item_id: item,
      quantity: "-3.000000",
      unit_price: "10.0000",
      discount: "-1.5000",
      amount: "-28.5000",
      tax_amount: "-1.7100",
      total_incl_tax: "-30.2100",
      cost: null,
      custom_fields: '{"note": "keep me"}',
    });
  });

  it("the reversal's ledger entries mirror the original, and the original becomes reversed", async () => {
    const source = await postItemDocument({ amount: "40.0000" });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: source,
        effectiveDate: "2026-01-20",
        reason: "mistake",
      }),
    );
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ document_id: string; debit: string; credit: string }[]>`
        select document_id, debit::text as debit, credit::text as credit from app.ledger_entry
         where document_id in (${source}, ${reversalDocumentId}) order by document_id, line_no`,
    );
    const original = rows.filter((r) => r.document_id === source);
    const reversal = rows.filter((r) => r.document_id === reversalDocumentId);
    // The reversal's line carries amount = -40.0000, so amendment A9 flips each rule's side and takes the
    // absolute magnitude: planned line 1 (rule side debit, account 1000) becomes a 40.0000 CREDIT and
    // planned line 2 (rule side credit, account 4000) becomes a 40.0000 DEBIT. Positive magnitudes with
    // swapped sides is the only shape check (debit >= 0) admits (plan0A:2012).
    expect(original.map((r) => [r.debit, r.credit])).toEqual([
      ["40.0000", "0.0000"],
      ["0.0000", "40.0000"],
    ]);
    expect(reversal.map((r) => [r.debit, r.credit])).toEqual([
      ["0.0000", "40.0000"],
      ["40.0000", "0.0000"],
    ]);
    const [doc] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { status: string }[]
        >`select status::text as status from app.document where id = ${source}`,
    );
    expect(doc!.status).toBe("reversed");
  });

  it("the reversal carries reverses_document_id, so `requires: [reverses_document]` is satisfiable", async () => {
    const source = await postItemDocument({ amount: "7.0000" });
    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), { documentId: source, effectiveDate: "2026-01-20", reason: "r" }),
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { reverses_document_id: string }[]
        >`select reverses_document_id from app.document where id = ${reversalDocumentId}`,
    );
    expect(row!.reverses_document_id).toBe(source);
  });

  it("refuses when the effective policy forbids reversal, naming the type", async () => {
    const noReverse = await seedDocumentType(db, a, {
      code: "POLICY_TEST",
      policyVersion: 2,
      effectiveFrom: "2026-01-25",
      policy: { ...POLICY_TEST, reversal: { allowed: false, producesType: null } },
    });
    expect(noReverse).toBe(typeId);
    const source = await prodWithTenant(db.rw, ctx(a), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${typeId}, 'PT', ${a.period}, '2026-01-28', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${a.company}, ${id}, 1, 'item', '9.0000')`;
      await postDocument(tx, ctx(a), { documentId: id });
      return id;
    });
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        reverseDocument(tx, ctx(a), {
          documentId: source,
          effectiveDate: "2026-01-28",
          reason: "no",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL.*POLICY_TEST/s);
  });

  it("refuses when producesType names a type this company does not have", async () => {
    // POLICY_TEST_2 is registered in §4.14 by amendment A1 and is deliberately NOT seeded into tenant b —
    // only POLICY_TEST is. Naming a registered-but-absent code is the point: hazard 32 forbids inventing a
    // document-type code even for a case whose whole purpose is that the code cannot be resolved.
    const b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b, { codes: ["accounting.journal.post"] });
    const bType = await seedDocumentType(db, b, {
      code: "POLICY_TEST",
      policy: { ...POLICY_TEST, reversal: { allowed: true, producesType: "POLICY_TEST_2" } },
    });
    const source = await prodWithTenant(db.rw, ctx(b), async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${b.tenant}, ${b.company}, ${bType}, 'PT', ${b.period}, '2026-01-15', 'MYR', ${b.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${b.tenant}, ${b.company}, ${id}, 1, 'item', '5.0000')`;
      await postDocument(tx, ctx(b), { documentId: id });
      return id;
    });
    await expect(
      prodWithTenant(db.rw, ctx(b), (tx) =>
        reverseDocument(tx, ctx(b), {
          documentId: source,
          effectiveDate: "2026-01-15",
          reason: "x",
        }),
      ),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING.*POLICY_TEST_2/s);
  });

  it("reads `reversal` from the PINNED policy, not from whatever is effective today (LEGACY-013, amendment A8)", async () => {
    const source = await postItemDocument({ amount: "9.0000", quantity: "1.000000" });

    // A back-dated version 3 lands AFTER the original posted — which 2A's
    // `POST …/document-types/{documentTypeId}/policies` makes an ordinary API call, because ADR 0027 makes a
    // version append-only but says nothing about how far back `effective_from` may reach. `effective_from`
    // 2026-01-10 is greater than v1's 2026-01-01 and still on or before the original's 2026-01-15, so
    // `resolvePolicy(type, '2026-01-15')` now answers **v3** — whose policy forbids reversal. The pinned
    // `document.posting_policy_id` still names v1, and v1 is what was originally applied (spec:1753).
    // Version 3, not 2: the case above already added v2 and posted under it, so 0106's guard refuses to
    // rewrite it in place — a new version is the only way in, which is ADR 0027's rule.
    await seedDocumentType(db, a, {
      code: "POLICY_TEST",
      policyVersion: 3,
      effectiveFrom: "2026-01-10",
      policy: { ...POLICY_TEST, reversal: { allowed: false, producesType: null } },
    });

    const { reversalDocumentId } = await prodWithTenant(db.rw, ctx(a), (tx) =>
      reverseDocument(tx, ctx(a), {
        documentId: source,
        effectiveDate: "2026-01-20",
        reason: "pinned",
      }),
    );

    const [rows] = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ pinned: string; original: string }[]>`
      select r.posting_policy_id::text as pinned, o.posting_policy_id::text as original
        from app.document r join app.document o on o.id = ${source}
       where r.id = ${reversalDocumentId}`,
    );
    // The original keeps v1; the reversal is a new document at its own effective date and pins v3. Two
    // different policies on the two documents is the point — neither is re-interpreted later.
    expect(rows!.pinned).not.toBe(rows!.original);
    const versions = await prodWithTenant(
      db.rw,
      ctx(a),
      (tx) => tx<{ version: number }[]>`
      select p.version from app.posting_policy p
       where p.id in (${rows!.original}::uuid, ${rows!.pinned}::uuid) order by p.version`,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 3]);
  });
});
