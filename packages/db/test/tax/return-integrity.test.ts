import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeDocumentTax,
  issueDocument,
  postDocument,
  reverseDocument,
  withTenant as prodWithTenant,
  type TenantContext,
} from "../../src";
import { lockTenantAuditSerial } from "../../src/costing/invalidate";
import {
  archiveTaxCode,
  createTaxCode,
  createTaxReturn,
  fileTaxReturn,
  generateTaxReturn,
  getTaxReturn,
  taxReturnTieOut,
} from "../../src/tax";
import {
  draftTypedDocument,
  seedAccount,
  seedCurrency,
  seedTaxCode,
  startDb,
  uuidv7,
  withTenant as onceWithTenant,
  type Db,
} from "../index";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../tests/invariants/support/tax";

// The PR 11 review's third round over the tax returns and the posting tax hook. Each describe block is
// one finding; every block builds its own tenant, so no block reads a row another one wrote.

let db: Db;
const ctxOf = (f: TaxFixture, requestId: string): TenantContext => ({
  tenantId: f.s.tenant,
  actorId: f.s.human,
  requestId,
});

beforeAll(async () => {
  db = await startDb();
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

/** A second company of the fixture's own tenant, on MYR unless told otherwise — the shape the AGENTS.md
 *  company-binding rule is about: RLS admits its rows to the first company's caller. */
async function siblingCompany(f: TaxFixture, baseCurrency = "MYR"): Promise<string> {
  const id = await uuidv7(db.admin);
  await prodWithTenant(db.rw, ctxOf(f, "sibling-company"), async (tx) => {
    await tx`insert into app.company (id, tenant_id, code, name, base_currency)
             values (${id}, ${f.s.tenant}, ${`SIB-${id.slice(-6)}`}, 'Sibling company', ${baseCurrency})`;
  });
  return id;
}

/** A promise and the function that settles it: the barrier that holds one transaction open while a second
 *  runs into its locks. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Returns once some backend of this database waits on a heavyweight lock — a row, a transaction id or an
 *  advisory key (the pattern of `costing/replay-concurrency.test.ts`). */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second transaction never waited on a lock");
}

/** The S1 box of a stored payload. */
const s1Of = (payload: string | null): string =>
  (JSON.parse(payload!) as { boxes: { code: string; amount: string }[] }).boxes.find(
    (b) => b.code === "S1",
  )!.amount;

describe("finding 5 — a return or code id is bound to the company the caller names", () => {
  let f: TaxFixture;
  let sibling: string;
  let returnId: string;
  let siblingCodeId: string;
  const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

  beforeAll(async () => {
    f = await taxFixture(db, "r3-scope");
    sibling = await siblingCompany(f);
    ({ taxCodeId: siblingCodeId } = await seedTaxCode(
      db,
      { ...f.s, company: sibling },
      { code: "SYN-SIB-ZERO", kind: "zero", rate: "0.00000000" },
    ));
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    const ctx = ctxOf(f, "r3-scope-setup");
    returnId = await prodWithTenant(db.rw, ctx, async (tx) => {
      const made = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        ...Q1,
      });
      await generateTaxReturn(tx, ctx, made.id);
      return made.id;
    });
  }, 300_000);

  const run = <T>(fn: (tx: import("postgres").Sql) => Promise<T>) =>
    prodWithTenant(db.rw, ctxOf(f, "r3-scope"), fn);

  it("getTaxReturn, generateTaxReturn and taxReturnTieOut refuse a sibling company with the unknown-id answer", async () => {
    const unknown = await uuidv7(db.admin);
    // The refusal for a real id under the wrong company must be the refusal an id that does not exist
    // gets — same code, same detail up to the id — or the status text tells a probe the row exists.
    await expect(run((tx) => getTaxReturn(tx, unknown, f.s.company))).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: `tax return ${unknown} is not visible`,
    });
    await expect(run((tx) => getTaxReturn(tx, returnId, sibling))).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: `tax return ${returnId} is not visible`,
    });
    await expect(
      run((tx) => generateTaxReturn(tx, ctxOf(f, "r3-scope"), returnId, sibling)),
    ).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: `tax return ${returnId} is not visible`,
    });
    await expect(run((tx) => taxReturnTieOut(tx, returnId, sibling))).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: `tax return ${returnId} is not visible`,
    });
    // …and the right company reads it: the binding refuses the wrong company, not the row.
    const read = await run((tx) => getTaxReturn(tx, returnId, f.s.company));
    expect(read.row.status).toBe("generated");
    expect(await run((tx) => taxReturnTieOut(tx, returnId, f.s.company))).toHaveLength(2);
  });

  it("fileTaxReturn refuses a sibling company and leaves the return generated", async () => {
    await expect(
      run((tx) =>
        fileTaxReturn(tx, ctxOf(f, "r3-scope"), { taxReturnId: returnId, companyId: sibling }),
      ),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
    const [row] = await db.admin<{ status: string }[]>`
      select status from app.tax_return where id = ${returnId}`;
    expect(row!.status).toBe("generated");
  });

  it("archiveTaxCode refuses a code of a sibling company and leaves it open", async () => {
    await expect(
      run((tx) => archiveTaxCode(tx, ctxOf(f, "r3-scope"), siblingCodeId, f.s.company)),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
    const [row] = await db.admin<{ archived_at: string | null }[]>`
      select archived_at::text from app.tax_code where id = ${siblingCodeId}`;
    expect(row!.archived_at).toBeNull();
    await run((tx) => archiveTaxCode(tx, ctxOf(f, "r3-scope"), siblingCodeId, sibling));
    const [after] = await db.admin<{ archived_at: string | null }[]>`
      select archived_at::text from app.tax_code where id = ${siblingCodeId}`;
    expect(after!.archived_at).not.toBeNull();
  });

  it("fileTaxReturn files under the right company", async () => {
    const filed = await run((tx) =>
      fileTaxReturn(tx, ctxOf(f, "r3-scope"), { taxReturnId: returnId, companyId: f.s.company }),
    );
    expect(filed.status).toBe("filed");
  });
});

describe("finding 1 — no two returns of one company and regime share a day", () => {
  let f: TaxFixture;
  let q1: string;
  const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };
  const create = (range: { periodStart: string; periodEnd: string }, regimeId = f.regimeId) => {
    const ctx = ctxOf(f, "r3-overlap");
    return prodWithTenant(db.rw, ctx, (tx) =>
      createTaxReturn(tx, ctx, { companyId: f.s.company, regimeId, ...range }),
    );
  };
  const count = async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.tax_return where company_id = ${f.s.company}`;
    return row!.n;
  };

  beforeAll(async () => {
    f = await taxFixture(db, "r3-overlap");
    q1 = (await create(Q1)).id;
  }, 300_000);

  it("refuses a range overlapping either end, contained, containing or identical — naming the return", async () => {
    // `unique (company_id, regime_id, period_start)` caught only an identical START. Feb–Apr against
    // Jan–Mar created, generated and filed, and February's and March's tax_transaction rows were then
    // reported by two returns.
    for (const [label, range] of [
      ["overlaps its end", { periodStart: "2026-02-01", periodEnd: "2026-04-30" }],
      ["overlaps its start", { periodStart: "2025-12-01", periodEnd: "2026-01-31" }],
      ["is contained in it", { periodStart: "2026-02-01", periodEnd: "2026-02-28" }],
      ["contains it", { periodStart: "2025-12-01", periodEnd: "2026-06-30" }],
      ["shares its start (Jan–Jan)", { periodStart: "2026-01-01", periodEnd: "2026-01-31" }],
      ["is identical", Q1],
    ] as const) {
      const refusal = create(range);
      await expect(refusal, label).rejects.toMatchObject({ code: "ERR_CONFLICT_UNIQUE" });
      await expect(refusal, label).rejects.toThrow(
        `${range.periodStart}..${range.periodEnd} overlaps tax return ${q1} (2026-01-01..2026-03-31, draft)`,
      );
    }
    expect(await count()).toBe(1); // every refusal left nothing behind
  });

  it("still admits a range adjacent at either end, and an overlapping range of ANOTHER regime", async () => {
    await expect(
      create({ periodStart: "2026-04-01", periodEnd: "2026-06-30" }),
    ).resolves.toMatchObject({ status: "draft" });
    await expect(
      create({ periodStart: "2025-12-01", periodEnd: "2025-12-31" }),
    ).resolves.toMatchObject({ status: "draft" });
    // The rule is per regime: a second regime's return may cover the same days, because its
    // transactions are a different set (`transactionsFor` binds `t.regime_id`).
    const [other] = await prodWithTenant(
      db.rw,
      ctxOf(f, "r3-overlap-regime"),
      (tx) => tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    name_en, source)
        values (${f.s.tenant}, ${f.s.company}, 'OTHER-MY-v1', 'MY', 1, '2026-01-01',
                'Second synthetic regime', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
        returning id`,
    );
    await expect(create(Q1, other!.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("two concurrent creates of overlapping ranges cannot both succeed", async () => {
    // The overlap read alone cannot see a concurrent create's uncommitted row. The second creator reads
    // only after the first has committed: it queues on the tenant's audit-chain lock, which a creator
    // takes first, and on the regime-row lock behind it, which is the overlap rule's own.
    const held = barrier();
    const inserted = barrier();
    const ctx = ctxOf(f, "r3-overlap-race");
    const first = prodWithTenant(db.rw, ctx, async (tx) => {
      const row = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-07-01",
        periodEnd: "2026-09-30",
      });
      inserted.open();
      await held.wait;
      return row;
    });
    await inserted.wait;
    const second = prodWithTenant(db.rw, ctx, (tx) =>
      createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-08-01",
        periodEnd: "2026-10-31",
      }),
    );
    await someoneWaits();
    held.open();
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "ERR_CONFLICT_UNIQUE" } });
    const rows = await db.admin<{ period_start: string }[]>`
      select period_start::text from app.tax_return
       where company_id = ${f.s.company} and regime_id = ${f.regimeId} and period_start >= '2026-07-01'`;
    expect(rows.map((r) => r.period_start)).toEqual(["2026-07-01"]);
  });

  it("a creator that starts while a taxed post holds the audit chain queues behind it, it does not deadlock with its key share on the regime", async () => {
    // A taxed post holds the tenant's audit-chain lock (the 'tenant-serial:' advisory key every audited
    // write takes, 0010) from its first audited write until it commits, and its `tax_transaction`
    // insert then takes FOR KEY SHARE on the regime row through the regime foreign key. A creator that
    // locked the regime FOR UPDATE and then waited on the audit-chain lock for its own audited insert
    // closed a cycle with it. A creator now takes the audit-chain lock first and holds nothing while it
    // waits; the next two tests pin that order and the lock mode it still needs. Driven without the
    // retry the production `withTenant` adds, so a deadlock surfaces here as 40P01 rather than as a
    // retried request.
    const auditHeld = barrier();
    const postHolds = barrier();
    const ctx = ctxOf(f, "r3-overlap-deadlock");
    const post = onceWithTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      // An audited write: from here this transaction holds the tenant's audit-chain lock.
      await tx`update app.tax_code set name_en = name_en where id = ${f.codes["SYN-EXEMPT"]!}`;
      postHolds.open();
      await auditHeld.wait;
      // …then the lock `insert into app.tax_transaction` takes through its regime foreign key.
      await tx`select 1 from app.tax_regime where id = ${f.regimeId} for key share`;
    });
    await postHolds.wait;
    const creator = onceWithTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-11-01",
        periodEnd: "2026-12-31",
      }),
    );
    await someoneWaits(); // the creator, on the audit-chain lock the post holds
    auditHeld.open();
    const [p, c] = await Promise.allSettled([post, creator]);
    expect(p.status, String((p as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(c.status, String((c as PromiseRejectedResult).reason)).toBe("fulfilled");
  });

  it("a creator takes the audit-chain lock before it locks the regime row — the order every return writer keeps", async () => {
    // The house rule (`lockTenantAuditSerial`'s comment): a transaction that will make an audited write
    // takes the audit chain before its first lock, so it waits holding nothing. `generateTaxReturn` and
    // `fileTaxReturn` do; a creator that locked the regime row first waited on the chain at its own
    // audited insert while holding that row. The probe sees which: it asks for the regime row while the
    // creator waits on the chain, and is refused at once if the creator holds any lock on it.
    const chainHeld = barrier();
    const release = barrier();
    const holder = onceWithTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await lockTenantAuditSerial(tx, f.s.tenant);
      chainHeld.open();
      await release.wait;
    });
    await chainHeld.wait;
    const ctx = ctxOf(f, "r3-overlap-order");
    const creator = onceWithTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
      }),
    );
    await someoneWaits(); // the creator, on the audit-chain lock the holder keeps
    const probe = db.admin.begin(
      (t) => t`select id from app.tax_regime where id = ${f.regimeId} for update nowait`,
    );
    const [seen] = await Promise.allSettled([probe]);
    release.open();
    const [h, c] = await Promise.allSettled([holder, creator]);
    expect(seen.status, String((seen as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(h.status, String((h as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(c.status, String((c as PromiseRejectedResult).reason)).toBe("fulfilled");
  });

  it("a creator holding the audit chain does not wait on a tax-code insert's key share of the regime", async () => {
    // Why the regime lock is FOR NO KEY UPDATE and not FOR UPDATE, with the audit chain taken first. An
    // insert into `app.tax_code` (`POST …/tax-codes`) fires its AFTER triggers in name order: the
    // foreign-key check (`RI_ConstraintTrigger_c_…`) takes FOR KEY SHARE on the regime row, and only then
    // does `audit_row` wait on the audit chain. A creator holding the chain and asking for FOR UPDATE —
    // the one row lock a key share blocks — would wait on that insert while the insert waited on it.
    // The creator pauses between its first statement and the regime lock to drive exactly that.
    const chainHeld = barrier();
    const go = barrier();
    const ctx = ctxOf(f, "r3-overlap-code");
    const creator = onceWithTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await lockTenantAuditSerial(tx, f.s.tenant); // createTaxReturn's first statement
      chainHeld.open();
      await go.wait;
      return createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2025-11-01",
        periodEnd: "2025-11-30",
      });
    });
    await chainHeld.wait;
    const coder = onceWithTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      createTaxCode(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        code: "SYN-OUT-ORDER",
        nameEn: "SYN-OUT-ORDER (synthetic)",
        rate: "0.11000000",
        kind: "output",
        roundingMode: "HALF_AWAY_FROM_ZERO",
        accountCode: "2300",
        effectiveFrom: "2026-01-01",
      }),
    );
    await someoneWaits(); // the code's insert: key share on the regime taken, waiting on the chain
    go.open();
    const [c, k] = await Promise.allSettled([creator, coder]);
    expect(c.status, String((c as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(k.status, String((k as PromiseRejectedResult).reason)).toBe("fulfilled");
  });
});

describe("finding 3 — a return is filed in its company's base currency, empty or not", () => {
  it("an empty period of a non-MYR company carries that company's currency in the payload", async () => {
    const f = await taxFixture(db, "r3-currency");
    await seedCurrency(db, f.s, { code: "EUR" });
    const eurCompany = await siblingCompany(f, "EUR");
    const { regimeId } = await seedTaxCode(
      db,
      { ...f.s, company: eurCompany },
      { code: "SYN-EUR-ZERO", kind: "zero", rate: "0.00000000" },
    );
    const ctx = ctxOf(f, "r3-currency");
    const { row, boxes, currency } = await prodWithTenant(db.rw, ctx, async (tx) => {
      const made = await createTaxReturn(tx, ctx, {
        companyId: eurCompany,
        regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      return generateTaxReturn(tx, ctx, made.id, eurCompany);
    });
    expect(currency).toBe("EUR");
    expect(JSON.parse(row.payload!)).toMatchObject({ currency: "EUR" });
    expect(boxes.map((b) => [b.amount.currency, b.amount.toString()])).toEqual(
      Array.from({ length: 5 }, () => ["EUR", "0.0000"]),
    );
  });
});

describe("finding 2 — a filed return's period takes no new tax facts, and a stale return does not file", () => {
  let f: TaxFixture;
  let invoiceId: string;
  let q1: string;
  const ctx = () => ctxOf(f, "r3-filed");

  /** Draft and tax-compute one SALES_INVOICE line, committed, and stop before the post — so a test can
   *  post it inside a transaction it holds open. The same steps `postArDocument` takes, minus the post. */
  async function draftInvoice(effectiveDate: string, amount: string): Promise<string> {
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!,
      series: "INV",
      effectiveDate,
      partyId: f.customerId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          quantity: "1.000000",
          accountId: f.accounts["4000"]!,
          amount,
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    });
    await prodWithTenant(db.rw, ctx(), async (tx) => {
      await tx`update app.document_line set total_incl_tax = amount where document_id = ${documentId}`;
      await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
      await computeDocumentTax(tx, ctx(), documentId);
    });
    return documentId;
  }
  const post = (tx: import("postgres").Sql, documentId: string) =>
    issueDocument(tx, ctx(), { documentId }).then(() => postDocument(tx, ctx(), { documentId }));
  const invoice = (effectiveDate: string, amount: string, taxCode: string | null = "SYN-OUT-STD") =>
    postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate,
      lines: [{ lineNo: 1, amount, taxCode }],
    });
  const taxRowsOn = async (effectiveDate: string) => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.tax_transaction
       where company_id = ${f.s.company} and effective_date = ${effectiveDate}`;
    return row!.n;
  };
  /** Create and generate a return over `range`, committed. */
  const generated = (range: { periodStart: string; periodEnd: string }) =>
    prodWithTenant(db.rw, ctx(), async (tx) => {
      const made = await createTaxReturn(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        ...range,
      });
      await generateTaxReturn(tx, ctx(), made.id, f.s.company);
      return made.id;
    });
  const file = (taxReturnId: string) =>
    prodWithTenant(db.rw, ctx(), (tx) =>
      fileTaxReturn(tx, ctx(), { taxReturnId, companyId: f.s.company }),
    );
  const statusOf = async (taxReturnId: string) => {
    const [row] = await db.admin<{ status: string }[]>`
      select status from app.tax_return where id = ${taxReturnId}`;
    return row!.status;
  };

  beforeAll(async () => {
    f = await taxFixture(db, "r3-filed");
    await invoice("2026-01-15", "1000.0000"); // the credit note's source
    ({ documentId: invoiceId } = await invoice("2026-01-20", "100.0000")); // the reversal's, untouched
    q1 = await generated({ periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    await file(q1);
  }, 300_000);

  const FILED = () => `the tax period 2026-01-01..2026-03-31 is filed (tax return ${q1})`;

  it("refuses a taxed post dated inside a filed return's range, naming the return and the range", async () => {
    // Before: it posted, and its tax_transaction rows were in no return — the filed one never reads them
    // again and the next return's period filter excludes them.
    const refusal = invoice("2026-02-10", "500.0000");
    await expect(refusal).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    await expect(refusal).rejects.toThrow(FILED());
    expect(await taxRowsOn("2026-02-10")).toBe(0);
  });

  it("refuses a credit note dated inside it the same way — a filed return is corrected by a later one", async () => {
    const refusal = postTaxedDocument(db, f, {
      typeCode: "SALES_CREDIT_NOTE",
      effectiveDate: "2026-03-05",
      lines: [{ lineNo: 1, amount: "-200.0000", taxCode: "SYN-OUT-STD" }],
    });
    await expect(refusal).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    await expect(refusal).rejects.toThrow(FILED());
    expect(await taxRowsOn("2026-03-05")).toBe(0);
  });

  it("refuses a reversal dated inside it the same way", async () => {
    const refusal = prodWithTenant(db.rw, ctx(), (tx) =>
      reverseDocument(tx, ctx(), {
        documentId: invoiceId,
        effectiveDate: "2026-03-20",
        reason: "Reversal into a filed tax period",
      }),
    );
    await expect(refusal).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    await expect(refusal).rejects.toThrow(FILED());
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text from app.document where id = ${invoiceId}`;
    expect(doc!.status).toBe("posted");
  });

  it("still posts a taxed document dated after the filed range, and an untaxed one dated inside it", async () => {
    await expect(invoice("2026-04-02", "300.0000")).resolves.toMatchObject({
      documentId: expect.any(String),
    });
    expect(await taxRowsOn("2026-04-02")).toBe(1);
    // A return reads tax_transaction and nothing else, so a document carrying no tax code writes no fact
    // a filed return could miss.
    await expect(invoice("2026-02-11", "75.0000", null)).resolves.toMatchObject({
      documentId: expect.any(String),
    });
  });

  it("refuses to file a generated return a later post made stale, until it is regenerated", async () => {
    const q2 = await generated({ periodStart: "2026-04-01", periodEnd: "2026-06-30" });
    await invoice("2026-05-05", "200.0000"); // Q2 is generated, not filed: the post is admitted
    const stale = file(q2);
    await expect(stale).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
    await expect(stale).rejects.toThrow(/regenerate it before filing/);
    expect(await statusOf(q2)).toBe("generated");

    await prodWithTenant(db.rw, ctx(), (tx) => generateTaxReturn(tx, ctx(), q2, f.s.company));
    const filed = await file(q2);
    expect(filed.status).toBe("filed");
    const s1 = (
      JSON.parse(filed.payload!) as { boxes: { code: string; amount: string }[] }
    ).boxes.find((b) => b.code === "S1")!;
    expect(s1.amount).toBe("500.0000"); // 300 of 2026-04-02 + 200 of 2026-05-05: the late post is filed
  });

  it("a post holding its lock on the return delays a filing, and the filing then refuses as stale", async () => {
    const q3 = await generated({ periodStart: "2026-07-01", periodEnd: "2026-09-30" });
    const documentId = await draftInvoice("2026-08-10", "400.0000");
    const posted = barrier();
    const commit = barrier();
    const poster = prodWithTenant(db.rw, ctx(), async (tx) => {
      await post(tx, documentId);
      posted.open();
      await commit.wait;
    });
    await posted.wait;
    const filer = file(q3);
    await someoneWaits(); // the filer, on the return row the post holds FOR SHARE
    commit.open();
    await poster;
    // Without the post's lock the filer rebuilt the payload before the post committed, matched the stored
    // one, filed, and the August invoice was in no return.
    await expect(filer).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
    expect(await statusOf(q3)).toBe("generated");
  });

  it("a filing that commits first makes the waiting post refuse", async () => {
    const q4 = await generated({ periodStart: "2026-10-01", periodEnd: "2026-12-31" });
    const documentId = await draftInvoice("2026-11-10", "400.0000");
    const filedIt = barrier();
    const commit = barrier();
    const filer = prodWithTenant(db.rw, ctx(), async (tx) => {
      const row = await fileTaxReturn(tx, ctx(), { taxReturnId: q4, companyId: f.s.company });
      filedIt.open();
      await commit.wait;
      return row;
    });
    await filedIt.wait;
    const poster = prodWithTenant(db.rw, ctx(), (tx) => post(tx, documentId));
    await someoneWaits();
    commit.open();
    await expect(filer).resolves.toMatchObject({ status: "filed" });
    await expect(poster).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    expect(await taxRowsOn("2026-11-10")).toBe(0);
  });
});

describe("finding 2's lock order — a generation or filing queues behind a taxed post, it does not deadlock with it", () => {
  // A taxed post holds the tenant's audit-chain lock (0010's 'tenant-serial:' key) from its first audited
  // write — the issue's UPDATE of the document, or postDocument step 8's — and only at step 11 takes FOR
  // SHARE on the return whose range covers it. A generation or filing that locked the return row FIRST and
  // reached the audit-chain lock only through the audit trigger on its own UPDATE closed a cycle with it:
  // PostgreSQL aborted one with 40P01, and production's retry-once was all that stood between a busy tenant
  // and an ERR_INTERNAL replayed under the request's idempotency key for 24 hours. Both sides here are the
  // production calls, driven through the harness `withTenant`, which does NOT retry — a deadlock surfaces as
  // the rejection it is rather than as a re-run that happened to succeed.
  let f: TaxFixture;
  const ctx = () => ctxOf(f, "r3-lock-order");
  const once = <T>(fn: (tx: import("postgres").Sql) => Promise<T>) =>
    onceWithTenant(db.rw, f.s.tenant, f.s.human, fn);

  /** A SALES_INVOICE drafted and tax-computed, committed, not yet issued — so a test can issue and post it
   *  inside a transaction it holds open. */
  async function draftInvoice(effectiveDate: string, amount: string): Promise<string> {
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types["SALES_INVOICE"]!,
      series: "INV",
      effectiveDate,
      partyId: f.customerId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          quantity: "1.000000",
          accountId: f.accounts["4000"]!,
          amount,
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    });
    await prodWithTenant(db.rw, ctx(), async (tx) => {
      await tx`update app.document_line set total_incl_tax = amount where document_id = ${documentId}`;
      await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
      await computeDocumentTax(tx, ctx(), documentId);
    });
    return documentId;
  }

  /** Issues the invoice — an audited write, so from here the post holds the tenant's audit-chain lock —
   *  then waits for `resume` and posts it, step 11 taking FOR SHARE on the covering return. */
  function postHoldingTheAuditChain(documentId: string) {
    const issued = barrier();
    const resume = barrier();
    const done = once(async (tx) => {
      await issueDocument(tx, ctx(), { documentId });
      issued.open();
      await resume.wait;
      await postDocument(tx, ctx(), { documentId });
    });
    return { issued: issued.wait, resume: resume.open, done };
  }

  beforeAll(async () => {
    f = await taxFixture(db, "r3-lock-order");
  }, 300_000);

  it("a filing that starts while a post holds the audit chain waits for it, then refuses as stale", async () => {
    const q1 = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const made = await createTaxReturn(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      await generateTaxReturn(tx, ctx(), made.id, f.s.company);
      return made.id;
    });
    const documentId = await draftInvoice("2026-02-10", "400.0000");
    const poster = postHoldingTheAuditChain(documentId);
    await poster.issued;
    const filer = once((tx) =>
      fileTaxReturn(tx, ctx(), { taxReturnId: q1, companyId: f.s.company }),
    );
    await someoneWaits(); // the filer, on the audit-chain lock the post holds
    poster.resume();
    const [p, fl] = await Promise.allSettled([poster.done, filer]);
    expect(p.status, String((p as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(fl).toMatchObject({ status: "rejected", reason: { code: "ERR_DOC_STATUS_ILLEGAL" } });
    const [row] = await db.admin<{ status: string }[]>`
      select status from app.tax_return where id = ${q1}`;
    expect(row!.status).toBe("generated");
  });

  it("a generation that starts while a post holds the audit chain waits for it, then includes it", async () => {
    const q2 = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const made = await createTaxReturn(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-04-01",
        periodEnd: "2026-06-30",
      });
      return made.id;
    });
    const documentId = await draftInvoice("2026-05-10", "700.0000");
    const poster = postHoldingTheAuditChain(documentId);
    await poster.issued;
    const generator = once((tx) => generateTaxReturn(tx, ctx(), q2, f.s.company));
    await someoneWaits(); // the generator, on the audit-chain lock the post holds
    poster.resume();
    const [p, g] = await Promise.allSettled([poster.done, generator]);
    expect(p.status, String((p as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect(g.status, String((g as PromiseRejectedResult).reason)).toBe("fulfilled");
    const generated = (g as PromiseFulfilledResult<Awaited<ReturnType<typeof generateTaxReturn>>>)
      .value;
    expect(s1Of(generated.row.payload)).toBe("700.0000"); // the post it waited for is in the return
  });
});

describe("finding 4 — the tie-out reads the accounts the regime's own codes post to", () => {
  let f: TaxFixture;
  const ctx = () => ctxOf(f, "r3-tieout");
  const newCode = (over: { code: string; kind: "output" | "input"; accountCode: string }) =>
    prodWithTenant(db.rw, ctx(), (tx) =>
      createTaxCode(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        nameEn: `${over.code} (synthetic)`,
        rate: "0.11000000",
        roundingMode: "HALF_AWAY_FROM_ZERO",
        effectiveFrom: "2026-01-01",
        ...over,
      }),
    );

  beforeAll(async () => {
    f = await taxFixture(db, "r3-tieout");
    await seedAccount(db, f.s, { code: "2310", nameEn: "Output tax payable B", type: "liability" });
  }, 300_000);

  it("sums every account an output or input code of the regime names — archived codes included", async () => {
    // `POST …/tax-codes` accepts any leaf account, and the tie-out compared the output boxes with 2300
    // alone: a second output code on 2310 put its tax in S2 and its ledger leg where the tie-out never
    // looked, and the return "reconciled" to a 55.0000 difference that was not there.
    const second = await newCode({ code: "SYN-OUT-B", kind: "output", accountCode: "2310" });
    const g: TaxFixture = { ...f, codes: { ...f.codes, "SYN-OUT-B": second.id } };
    await postTaxedDocument(db, g, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
    await postTaxedDocument(db, g, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-02-10",
      lines: [{ lineNo: 1, amount: "500.0000", taxCode: "SYN-OUT-B" }],
    });
    await postTaxedDocument(db, g, {
      typeCode: "PURCHASE_INVOICE",
      effectiveDate: "2026-03-20",
      partyId: f.vendorId,
      lines: [
        {
          lineNo: 1,
          kind: "account",
          accountId: f.accounts["5900"]!,
          amount: "800.0000",
          taxCode: "SYN-IN-STD",
        },
      ],
    });
    // Archiving a code stops new use; its posted tax is still in the account the tie-out must read.
    await prodWithTenant(db.rw, ctx(), (tx) => archiveTaxCode(tx, ctx(), second.id, f.s.company));
    const tie = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const made = await createTaxReturn(tx, ctx(), {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      await generateTaxReturn(tx, ctx(), made.id, f.s.company);
      return taxReturnTieOut(tx, made.id, f.s.company);
    });
    expect(tie).toEqual([
      {
        accountCode: "1350",
        boxCodes: ["P2"],
        boxBase: "88.0000",
        ledgerBase: "88.0000",
        difference: "0.0000",
      },
      {
        accountCode: "2300+2310",
        boxCodes: ["S2"],
        boxBase: "165.0000", // 110 on SYN-OUT-STD + 55 on SYN-OUT-B
        ledgerBase: "165.0000",
        difference: "0.0000",
      },
    ]);
  });

  it("a regime that declares no code of a kind ties that side out against its §4.15 account", async () => {
    const sibling = await siblingCompany(f);
    const { regimeId } = await seedTaxCode(
      db,
      { ...f.s, company: sibling },
      { code: "SYN-SIB-ZERO", kind: "zero", rate: "0.00000000" },
    );
    const tie = await prodWithTenant(db.rw, ctx(), async (tx) => {
      const made = await createTaxReturn(tx, ctx(), {
        companyId: sibling,
        regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
      });
      await generateTaxReturn(tx, ctx(), made.id, sibling);
      return taxReturnTieOut(tx, made.id, sibling);
    });
    expect(tie.map((r) => [r.accountCode, r.ledgerBase, r.difference])).toEqual([
      ["1350", "0.0000", "0.0000"],
      ["2300", "0.0000", "0.0000"],
    ]);
  });

  it("createTaxCode refuses an output code off a liability account and an input code off an asset one", async () => {
    // The tie-out takes each account's sign from its type (a liability reads credit − debit); an output
    // code posting to an asset would tie out with the wrong sign, so it is refused when it is created.
    for (const [kind, accountCode, type] of [
      ["output", "1350", "asset"],
      ["output", "4000", "income"],
      ["input", "2300", "liability"],
      ["input", "5900", "expense"],
    ] as const) {
      const refusal = newCode({ code: `SYN-BAD-${kind}-${accountCode}`, kind, accountCode });
      await expect(refusal, `${kind} on ${accountCode}`).rejects.toMatchObject({
        code: "ERR_POLICY_REQUIRES_MISSING",
      });
      await expect(refusal, `${kind} on ${accountCode}`).rejects.toThrow(
        `account ${accountCode} is ${type}`,
      );
    }
    await expect(
      newCode({ code: "SYN-IN-B", kind: "input", accountCode: "1350" }),
    ).resolves.toMatchObject({ kind: "input" });
  });
});
