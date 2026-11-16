import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditNoteFrom, type CreditNoteInput } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import {
  seedAccount,
  seedItem,
  seedParty,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { postArDocument, type ArLine } from "../../../../tests/invariants/support/post-ar";
import { loadTypesFromPack } from "./_support";

let db: Db;
let s: Seed;
let invType: string;
let cnType: string;
let pinvType: string;
let pcnType: string;
let partyId: string;
let vendorId: string;
let itemId: string;
/** The first case's invoice and its full reversal, which the second case nets. */
let reversedInvoiceId: string;
let reversalId: string;
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "credit-note");
  // The accounts the four policies resolve. `4000` and `5920` are seedTenantV2's, `1300`/`5000`/`5900` come
  // with `seedItem` and `2100` with `seedParty`; `seedAccount` is idempotent on (company_id, code). 4A seeds no
  // account (Global Constraint 14) — 0C, 3C and 3D own these.
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  // The types come from the PACK, through 1A's loader — the direction claims are about the seeded files.
  const types = await loadTypesFromPack(db, s, [
    "SALES_INVOICE",
    "SALES_CREDIT_NOTE",
    "PURCHASE_INVOICE",
    "PURCHASE_CREDIT_NOTE",
  ]);
  invType = types.salesInvoiceType!;
  cnType = types.salesCreditNoteType!;
  pinvType = types.purchaseInvoiceType!;
  pcnType = types.purchaseCreditNoteType!;
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CN" });
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-CN" });
  ({ itemId } = await seedItem(db, s, { code: "IT-CN", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** One invoice: 5 at 9.0000, cost 15.0000 — the cost a delivery would have written and the conversion copied. */
async function invoice(effectiveDate: string, lines?: readonly ArLine[]) {
  return postArDocument(db, s, {
    documentTypeId: invType,
    series: "INV",
    partyId,
    effectiveDate,
    lines: lines ?? [
      {
        kind: "item",
        itemId,
        quantity: "5.000000",
        unitPrice: "9.0000",
        amount: "45.0000",
        cost: "15.0000",
      },
    ],
  });
}

async function lineIdsOf(documentId: string): Promise<string[]> {
  const rows = await db.admin<{ id: string }[]>`
    select id from app.document_line where document_id = ${documentId} order by line_no`;
  return rows.map((r) => r.id);
}

type CreditArgs = Omit<CreditNoteInput, "companyId" | "targetDocumentTypeId" | "targetSeries">;

/** Drafts a SALES_CREDIT_NOTE through the service and leaves it a draft. */
function draftCredit(args: CreditArgs) {
  return withTenant(db.rw, s.tenant, s.human, (tx) =>
    creditNoteFrom(tx, ctxOf(s), {
      companyId: s.company,
      targetDocumentTypeId: cnType,
      targetSeries: "CN",
      ...args,
    }),
  );
}

/** Drafts, issues and posts in ONE transaction — so the reason lands on the draft → issued event. */
function postedCredit(args: CreditArgs) {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await creditNoteFrom(tx, ctxOf(s), {
      companyId: s.company,
      targetDocumentTypeId: cnType,
      targetSeries: "CN",
      ...args,
    });
    await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
    await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    return r;
  });
}

async function legs(documentId: string) {
  return db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, e.debit::text as debit, e.credit::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId}
     order by a.code, e.line_no`;
}

/** Σ(debit − credit) in base per account over a set of documents, at scale 4. */
async function netOver(documentIds: readonly string[]) {
  return db.admin<{ code: string; net: string }[]>`
    select a.code, sum(e.base_debit - e.base_credit)::numeric(19,4)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = any(${documentIds as string[]}::uuid[])
     group by a.code order by a.code`;
}

async function linesOf(documentId: string) {
  return db.admin<
    {
      q: string | null;
      unitPrice: string | null;
      discount: string;
      amount: string;
      tax: string;
      total: string;
      cost: string | null;
    }[]
  >`
    select quantity::text as q, unit_price::text as "unitPrice", discount::text as discount,
           amount::text as amount, tax_amount::text as tax, total_incl_tax::text as total,
           cost::text as cost
      from app.document_line where document_id = ${documentId} order by line_no`;
}

describe("SALES_CREDIT_NOTE — spec:2024, §4.14, ADR 0044 and ADR 0045", () => {
  it("reverseDocument on the invoice produces a SALES_CREDIT_NOTE that posts the OPPOSITE of the invoice", async () => {
    const inv = await invoice("2026-01-10");
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId: inv.documentId,
        effectiveDate: "2026-01-11",
        reason: "customer cancelled",
      }),
    );
    reversedInvoiceId = inv.documentId;
    reversalId = reversalDocumentId;
    expect(await legs(reversalDocumentId)).toEqual([
      { code: "1200", debit: "0.0000", credit: "45.0000" }, // AR relieved
      { code: "1250", debit: "15.0000", credit: "0.0000" }, // the corridor refilled — ADR 0045
      { code: "4000", debit: "45.0000", credit: "0.0000" }, // revenue reversed
      { code: "5000", debit: "0.0000", credit: "15.0000" }, // COGS reversed
    ]);
    const [head] = await db.admin<{ code: string; status: string; series: string }[]>`
      select t.code, d.status::text as status, d.series from app.document d
        join app.document_type t on t.id = d.document_type_id where d.id = ${reversalDocumentId}`;
    // …and it is numbered in the CREDIT NOTE's series: reverseDocument copies the invoice's series onto the
    // draft, and issueDocument renumbers it from the reversal type's own policy (§4.3.6).
    expect(head).toEqual({ code: "SALES_CREDIT_NOTE", status: "posted", series: "CN" });
    const [orig] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${inv.documentId}`;
    expect(orig!.status).toBe("reversed");
  });

  it("the invoice and its reversal net to zero on each of the four accounts (test 3's shape, on AR/AP)", async () => {
    expect(await netOver([reversedInvoiceId, reversalId])).toEqual([
      { code: "1200", net: "0.0000" },
      { code: "1250", net: "0.0000" },
      { code: "4000", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
  });

  it("a PARTIAL credit note carries NEGATED magnitudes, a POSITIVE cost, and posts the credit direction", async () => {
    const inv = await invoice("2026-01-12");
    const [invLine] = await lineIdsOf(inv.documentId);
    const cn = await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-13",
      reason: "two units damaged in transit",
      lines: [{ settledLineId: invLine!, quantity: "2.000000" }],
    });
    // The price is a price, not a magnitude, and is copied unnegated; the cost is a magnitude (§4.7.2 A6)
    // whose sign ADR 0045 takes from the negated quantity.
    expect(await linesOf(cn.documentId)).toEqual([
      {
        q: "-2.000000",
        unitPrice: "9.0000",
        discount: "0.0000",
        amount: "-18.0000",
        tax: "0.0000",
        total: "-18.0000",
        cost: "6.0000",
      },
    ]);
    expect(await legs(cn.documentId)).toEqual([
      { code: "1200", debit: "0.0000", credit: "18.0000" },
      { code: "1250", debit: "6.0000", credit: "0.0000" },
      { code: "4000", debit: "18.0000", credit: "0.0000" },
      { code: "5000", debit: "0.0000", credit: "6.0000" },
    ]);
    // The header mirrors the invoice and names it; the link is 3C's `returns` kind.
    const [head] = await db.admin<
      { rev: string | null; party: string | null; series: string; status: string }[]
    >`
      select reverses_document_id as rev, party_id as party, series, status::text as status
        from app.document where id = ${cn.documentId}`;
    expect(head).toEqual({ rev: inv.documentId, party: partyId, series: "CN", status: "posted" });
    const links = await db.admin<{ kind: string; q: string }[]>`
      select link_kind as kind, quantity::text as q from app.document_link
       where target_document_id = ${cn.documentId}`;
    expect(links).toEqual([{ kind: "returns", q: "2.000000" }]);
    expect(cn.linkIds).toHaveLength(1);
  });

  it("the reason reaches document_event.reason on the draft → issued row", async () => {
    const inv = await invoice("2026-01-13");
    const cn = await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-13",
      reason: "price agreed down after delivery",
      lines: [],
    });
    const events = await db.admin<{ to: string; reason: string | null }[]>`
      select to_status::text as "to", reason from app.document_event
       where document_id = ${cn.documentId} and event_kind = 'transition' order by id`;
    expect(events.find((e) => e.to === "issued")?.reason).toBe("price agreed down after delivery");
  });

  it("a credit note with NO reverses_document is refused at post — the requires control (§4.3.2 step 4)", async () => {
    const inv = await invoice("2026-01-14");
    const cn = await draftCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-15",
      reason: "test",
      lines: [],
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document set reverses_document_id = null where id = ${cn.documentId}`,
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, async (tx) => {
        await issueDocument(tx, ctxOf(s), { documentId: cn.documentId });
        return postDocument(tx, ctxOf(s), { documentId: cn.documentId });
      }),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: .*is missing reverses_document/);
  });

  it("a partial credit note does NOT mark the invoice reversed — only reverseDocument does that", async () => {
    const inv = await invoice("2026-01-16");
    const [invLine] = await lineIdsOf(inv.documentId);
    await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-16",
      reason: "one unit short-shipped",
      lines: [{ settledLineId: invLine!, quantity: "1.000000" }],
    });
    const [orig] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${inv.documentId}`;
    expect(orig!.status).toBe("posted");
  });

  it("a FULL reversal is refused once the invoice is partly credited, and admitted again after that note is voided", async () => {
    // Mirroring every line on top of a partial credit note would credit the customer twice for the same
    // units: 5 invoiced, 2 credited, then a full reversal took receivables to -18.0000 before the guard.
    const inv = await invoice("2026-01-18");
    const [invLine] = await lineIdsOf(inv.documentId);
    const partial = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        companyId: s.company,
        targetDocumentTypeId: cnType,
        targetSeries: "CN",
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-18",
        reason: "two units damaged",
        lines: [{ settledLineId: invLine!, quantity: "2.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    const reverse = () =>
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reverseDocument(tx, ctxOf(s), {
          documentId: inv.documentId,
          effectiveDate: "2026-01-19",
          reason: "wrong customer",
        }),
      );
    await expect(reverse()).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .*already been partly credited or returned against/,
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      voidDocument(tx, ctxOf(s), { documentId: partial.documentId, reason: "raised in error" }),
    );
    const { reversalDocumentId } = await reverse();
    expect(await netOver([inv.documentId, reversalDocumentId])).toEqual([
      { code: "1200", net: "0.0000" },
      { code: "1250", net: "0.0000" },
      { code: "4000", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
  });

  it("crediting more than the invoiced quantity is refused with ERR_DOC_LINK_OVER_FULFILLED (SAH-018)", async () => {
    const inv = await invoice("2026-01-17");
    const [invLine] = await lineIdsOf(inv.documentId);
    await expect(
      draftCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-17",
        reason: "too many",
        lines: [{ settledLineId: invLine!, quantity: "99.000000" }],
      }),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
    // …and across credit notes: 3 then 2 is the whole line, and one more unit is over.
    await draftCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-17",
      reason: "three back",
      lines: [{ settledLineId: invLine!, quantity: "3.000000" }],
    });
    await draftCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-17",
      reason: "two back",
      lines: [{ settledLineId: invLine!, quantity: "2.000000" }],
    });
    await expect(
      draftCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-17",
        reason: "one too many",
        lines: [{ settledLineId: invLine!, quantity: "1.000000" }],
      }),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("the credit note cannot itself be reversed (reversal.allowed is false)", async () => {
    const inv = await invoice("2026-01-18");
    const cn = await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-18",
      reason: "whole invoice",
      lines: [],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reverseDocument(tx, ctxOf(s), {
          documentId: cn.documentId,
          effectiveDate: "2026-01-19",
          reason: "no",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL|ERR_POLICY_INVALID/);
  });

  it("the credit that COMPLETES a line takes the residue, so AR, revenue, 1250 and COGS net to exactly zero", async () => {
    // 3 units, 10.0000 and cost 10.0000, credited a unit at a time: 3.3333 + 3.3333 + 3.3334. Pro-rata alone
    // would leave 0.0001 in all four accounts forever — the residue rule of Task 6's conversion, negated.
    const inv = await invoice("2026-01-20", [
      { kind: "item", itemId, quantity: "3.000000", amount: "10.0000", cost: "10.0000" },
    ]);
    const [invLine] = await lineIdsOf(inv.documentId);
    const notes: string[] = [];
    for (const day of ["2026-01-20", "2026-01-21", "2026-01-22"]) {
      const cn = await postedCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: day,
        reason: "one unit back",
        lines: [{ settledLineId: invLine!, quantity: "1.000000" }],
      });
      notes.push(cn.documentId);
    }
    const figures = [];
    for (const id of notes) figures.push((await linesOf(id))[0]!);
    expect(figures.map((f) => [f.amount, f.total, f.cost])).toEqual([
      ["-3.3333", "-3.3333", "3.3333"],
      ["-3.3333", "-3.3333", "3.3333"],
      ["-3.3334", "-3.3334", "3.3334"],
    ]);
    expect(await netOver([inv.documentId, ...notes])).toEqual([
      { code: "1200", net: "0.0000" },
      { code: "1250", net: "0.0000" },
      { code: "4000", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
    // Nothing is left to credit, and an empty `lines` says so rather than drafting an empty note.
    await expect(
      draftCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-22",
        reason: "again",
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*nothing left to credit/);
  });

  it("an empty `lines` credits what is still OPEN, and a VOID credit note releases its quantity and its figures", async () => {
    // 3 units, 10.0000 and cost 10.0000 again, so the last unit's residue (3.3334) differs from its pro-rata
    // (3.3333) and the case can tell whether the void was counted.
    const inv = await invoice("2026-01-23", [
      { kind: "item", itemId, quantity: "3.000000", amount: "10.0000", cost: "10.0000" },
    ]);
    const [invLine] = await lineIdsOf(inv.documentId);
    // One unit credited, issued and then voided: a released credit, exactly as `app.document_open_quantity`
    // releases it (3C), so it must not count towards the residue either.
    const voided = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        companyId: s.company,
        targetDocumentTypeId: cnType,
        targetSeries: "CN",
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-23",
        reason: "raised in error",
        lines: [{ settledLineId: invLine!, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await voidDocument(tx, ctxOf(s), { documentId: r.documentId, reason: "raised in error" });
      return r;
    });
    const notes: string[] = [];
    for (const day of ["2026-01-23", "2026-01-24"]) {
      const cn = await postedCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: day,
        reason: "one unit back",
        lines: [{ settledLineId: invLine!, quantity: "1.000000" }],
      });
      notes.push(cn.documentId);
    }
    // "The rest" is the one unit still open — not zero, which counting the void would have made it — and it
    // completes the line, so it takes the residue of all three.
    const rest = await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-24",
      reason: "the rest",
      lines: [],
    });
    expect(await linesOf(rest.documentId)).toEqual([
      {
        q: "-1.000000",
        unitPrice: null,
        discount: "0.0000",
        amount: "-3.3334",
        tax: "0.0000",
        total: "-3.3334",
        cost: "3.3334",
      },
    ]);
    expect(await netOver([inv.documentId, ...notes, rest.documentId])).toEqual([
      { code: "1200", net: "0.0000" },
      { code: "1250", net: "0.0000" },
      { code: "4000", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
    const [status] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${voided.documentId}`;
    expect(status!.status).toBe("void");
  });

  it("the company binds the invoice AND the target type: a sibling company's either is ERR_NOT_FOUND (AGENTS.md)", async () => {
    const inv = await invoice("2026-01-25");
    const other = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'CN-B', 'Credit note second company', 'MYR') returning id`;
      const [type] = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, module)
        values (${s.tenant}, ${company!.id}, 'SALES_CREDIT_NOTE', 'Sales Credit Note', 'accounting')
        returning id`;
      return { companyId: company!.id, typeId: type!.id };
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        creditNoteFrom(tx, ctxOf(s), {
          companyId: other.companyId,
          settledDocumentId: inv.documentId,
          targetDocumentTypeId: other.typeId,
          targetSeries: "CN",
          effectiveDate: "2026-01-25",
          reason: "wrong company",
          lines: [],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: settled document .* is not a document of company/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        creditNoteFrom(tx, ctxOf(s), {
          companyId: s.company,
          settledDocumentId: inv.documentId,
          targetDocumentTypeId: other.typeId,
          targetSeries: "CN",
          effectiveDate: "2026-01-25",
          reason: "wrong type",
          lines: [],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document type .* is not a live type of company/);
  });

  it("the target must be the type the invoice's PINNED policy reverses into, and the invoice must be posted", async () => {
    const inv = await invoice("2026-01-26");
    // A PURCHASE_CREDIT_NOTE against a SALES_INVOICE would post AR's credit to 2150.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        creditNoteFrom(tx, ctxOf(s), {
          companyId: s.company,
          settledDocumentId: inv.documentId,
          targetDocumentTypeId: pcnType,
          targetSeries: "PCN",
          effectiveDate: "2026-01-26",
          reason: "wrong direction",
          lines: [],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*PURCHASE_CREDIT_NOTE.*SALES_CREDIT_NOTE/);
    // A credit note is itself posted and credits nothing: its policy reverses into no type.
    const cn = await postedCredit({
      settledDocumentId: inv.documentId,
      effectiveDate: "2026-01-26",
      reason: "one unit",
      lines: [{ settledLineId: (await lineIdsOf(inv.documentId))[0]!, quantity: "1.000000" }],
    });
    await expect(
      draftCredit({
        settledDocumentId: cn.documentId,
        effectiveDate: "2026-01-26",
        reason: "x",
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*reverses into no type/);
    // An invoice still in draft has posted nothing to credit.
    const draftInv = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        insert into app.document
          (tenant_id, company_id, document_type_id, series, effective_date, party_id, currency, branch_id)
        values (${s.tenant}, ${s.company}, ${invType}, 'INV', '2026-01-26', ${partyId}, 'MYR', ${s.hq})
        returning id`;
      return d!.id;
    });
    await expect(
      draftCredit({
        settledDocumentId: draftInv,
        effectiveDate: "2026-01-26",
        reason: "x",
        lines: [],
      }),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: settled document .* is not posted/);
  });

  it("line validation: a line not on the invoice, a line asked twice, a zero quantity and a charge line", async () => {
    const [chargeAccount] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`;
    const inv = await invoice("2026-01-27", [
      {
        kind: "item",
        itemId,
        quantity: "2.000000",
        unitPrice: "9.0000",
        amount: "18.0000",
        cost: "6.0000",
      },
      { kind: "account", accountId: chargeAccount!.id, description: "freight", amount: "5.0000" },
    ]);
    const [goods, freight] = await lineIdsOf(inv.documentId);
    const foreign = (await lineIdsOf(reversalId))[0]!;
    const attempt = (lines: CreditArgs["lines"]) =>
      draftCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-27",
        reason: "x",
        lines,
      });
    await expect(attempt([{ settledLineId: foreign, quantity: "1.000000" }])).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line .* is not a line of the settled document/,
    );
    await expect(
      attempt([
        { settledLineId: goods!, quantity: "1.000000" },
        { settledLineId: goods!, quantity: "1.000000" },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line .* is asked for twice/);
    await expect(attempt([{ settledLineId: goods!, quantity: "0.000000" }])).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line 1 quantity must be positive/,
    );
    // A charge line carries no quantity for `returns` to bound: it is credited whole, by reversing the
    // invoice — named, or implied by an empty `lines`, it is refused rather than silently dropped.
    await expect(attempt([{ settledLineId: freight!, quantity: "1.000000" }])).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line 2 carries no quantity/,
    );
    await expect(attempt([])).rejects.toThrow(/ERR_VALIDATION_FAILED: line 2 carries no quantity/);
    // The goods line alone is creditable.
    const ok = await attempt([{ settledLineId: goods!, quantity: "1.000000" }]);
    expect(ok.lineIds).toHaveLength(1);
  });

  it("the reason is required — an empty one would reach document_event as NULL", async () => {
    const inv = await invoice("2026-01-28");
    await expect(
      draftCredit({
        settledDocumentId: inv.documentId,
        effectiveDate: "2026-01-28",
        reason: " ",
        lines: [],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: a credit note needs a reason/);
  });
});

describe("PURCHASE_CREDIT_NOTE — the same construction over PURCHASE_INVOICE's rules", () => {
  /** A vendor invoice for 2 units at 10.0000 — the 2150 accrual moved to trade payables. */
  function purchaseInvoice(effectiveDate: string) {
    return postArDocument(db, s, {
      documentTypeId: pinvType,
      series: "PINV",
      partyId: vendorId,
      effectiveDate,
      lines: [
        { kind: "item", itemId, quantity: "2.000000", unitPrice: "10.0000", amount: "20.0000" },
      ],
    });
  }

  it("reverseDocument on a PURCHASE_INVOICE produces a PURCHASE_CREDIT_NOTE that posts the opposite", async () => {
    const pinv = await purchaseInvoice("2026-01-10");
    expect(pinv.ledger).toEqual([
      { code: "2100", debit: "0.0000", credit: "20.0000" },
      { code: "2150", debit: "20.0000", credit: "0.0000" },
    ]);
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId: pinv.documentId,
        effectiveDate: "2026-01-11",
        reason: "vendor invoiced in error",
      }),
    );
    expect(await legs(reversalDocumentId)).toEqual([
      { code: "2100", debit: "20.0000", credit: "0.0000" },
      { code: "2150", debit: "0.0000", credit: "20.0000" },
    ]);
    const [head] = await db.admin<{ code: string; series: string }[]>`
      select t.code, d.series from app.document d
        join app.document_type t on t.id = d.document_type_id where d.id = ${reversalDocumentId}`;
    expect(head).toEqual({ code: "PURCHASE_CREDIT_NOTE", series: "PCN" });
  });

  it("a partial PURCHASE_CREDIT_NOTE negates the magnitudes and carries no cost (the invoice has none)", async () => {
    const pinv = await purchaseInvoice("2026-01-12");
    const [line] = await lineIdsOf(pinv.documentId);
    const pcn = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        companyId: s.company,
        settledDocumentId: pinv.documentId,
        targetDocumentTypeId: pcnType,
        targetSeries: "PCN",
        effectiveDate: "2026-01-13",
        reason: "one unit overbilled",
        lines: [{ settledLineId: line!, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    expect(await linesOf(pcn.documentId)).toEqual([
      {
        q: "-1.000000",
        unitPrice: "10.0000",
        discount: "0.0000",
        amount: "-10.0000",
        tax: "0.0000",
        total: "-10.0000",
        cost: null,
      },
    ]);
    expect(await legs(pcn.documentId)).toEqual([
      { code: "2100", debit: "10.0000", credit: "0.0000" },
      { code: "2150", debit: "0.0000", credit: "10.0000" },
    ]);
  });
});
