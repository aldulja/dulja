// packages/db/test/ar-ap/reinstated-chain-residue.test.ts — code review 3, R9's consumers. Since 0116 a
// reversed fulfilment still holds its claim on its source line while its reversal chain has a live even-depth
// member (app.document_claim_stands): app.document_open_quantity counts it. creditNoteFrom and
// convertToInvoice read `open_quantity` from that view, but their `done` sums — what has already been
// credited or converted, which decides whether THIS note or invoice completes the line and takes the residue —
// read the flat rule "not void, not reversed". For a reinstated chain the two disagreed: the credit or
// conversion that finished the line took the pro-rata instead of the residue, and 0.0001 stayed in the
// receivable, the revenue and the `1250` corridor for good.
//
// The seeded pack cannot build such a chain — SALES_CREDIT_NOTE is not reversible, and SALES_INVOICE reverses
// into it — so this suite configures the one shape a company may: an invoice type that reverses into a credit
// note type that reverses into itself. The types are the pack's own files with only code, series and reversal
// changed, loaded through 1A's real loader.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import { loadDocumentTypes } from "../../src/seed/document-types";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";
import { loadTypesFromPack, PACK_ROOT } from "./_support";

let db: Db;
let s: Seed;
let invType: string;
let cnType: string;
let doType: string;
let partyId: string;
let itemId: string;
let warehouseId: string;

const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-0000000000c9",
});

/** A pack file with its code, series and reversal replaced — nothing else of the policy changes. */
function variant(
  file: string,
  code: string,
  series: string,
  reversal: { allowed: boolean; producesType: string | null },
): unknown {
  const envelope = JSON.parse(
    readFileSync(join(PACK_ROOT, "document-types", `${file}.json`), "utf8"),
  ) as { code: string; policy: Record<string, unknown> };
  return {
    ...envelope,
    code,
    nameEn: `${code} (reversal chain)`,
    policy: {
      ...envelope.policy,
      documentType: code,
      numbering: { series, assignAt: "issue" },
      reversal,
    },
  };
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "reinstated-chain");
  await ensureOpenPeriods(db, s, 2026);
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  const pack = await loadTypesFromPack(db, s, ["DELIVERY_ORDER", "GOODS_RECEIPT"]);
  doType = pack.deliveryOrderType!;

  const dir = mkdtempSync(join(tmpdir(), "dulja-chain-types-"));
  writeFileSync(
    join(dir, "SI_CHAIN.json"),
    JSON.stringify(
      variant("SALES_INVOICE", "SI_CHAIN", "SIC", { allowed: true, producesType: "CN_CHAIN" }),
    ),
  );
  writeFileSync(
    join(dir, "CN_CHAIN.json"),
    JSON.stringify(
      variant("SALES_CREDIT_NOTE", "CN_CHAIN", "CNC", { allowed: true, producesType: "CN_CHAIN" }),
    ),
  );
  const catalogue = (
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ code: string }[]>`select code from app.permission order by code`,
    )
  ).map((row) => row.code);
  const loaded = await loadDocumentTypes(
    db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    dir,
    catalogue,
  );
  invType = loaded.find((r) => r.code === "SI_CHAIN")!.documentTypeId;
  cnType = loaded.find((r) => r.code === "CN_CHAIN")!.documentTypeId;

  await grantCodes(db, s, {
    codes: ["inventory.receipt.post", "inventory.transfer.post", "accounting.sales.post"],
  });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CHAIN" });
  const vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-CHAIN" });
  ({ itemId } = await seedItem(db, s, { code: "IT-CHAIN", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-CHAIN" });
  // Stock for the delivery case: 30 at 3.0000.
  const grn = await draftTypedDocument(db, s, {
    documentTypeId: pack.goodsReceiptType!,
    series: "GRN",
    effectiveDate: "2026-01-05",
    partyId: vendorId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        quantity: "30.000000",
        unitPrice: "3.0000",
        amount: "90.0000",
      },
    ],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId: grn.documentId, jobs: recordingJobs() }),
  );
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const reverse = (documentId: string, effectiveDate: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    reverseDocument(tx, ctxOf(s), {
      documentId,
      effectiveDate,
      reason: "chain",
      jobs: recordingJobs(),
    }),
  );

/** Reverses `documentId`, then reverses that reversal: the chain now ends live at depth 2, so the document's
 *  claim on its source line stands again although it reads 'reversed'. */
async function reinstate(documentId: string): Promise<void> {
  const r1 = await reverse(documentId, "2026-02-03");
  await reverse(r1.reversalDocumentId, "2026-02-04");
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ status: string; stands: boolean }[]>`
      select status::text as status, app.document_claim_stands(${documentId}) as stands
        from app.document where id = ${documentId}`,
  );
  expect(row).toEqual({ status: "reversed", stands: true });
}

async function lineOf(documentId: string) {
  const [row] = await db.admin<{ amount: string; cost: string | null }[]>`
    select amount::text as amount, cost::text as cost
      from app.document_line where document_id = ${documentId} order by line_no limit 1`;
  return row!;
}

/** Σ(debit − credit) in base per account over a set of documents, at scale 4. */
async function netOver(documentIds: readonly string[]) {
  return db.admin<{ code: string; net: string }[]>`
    select a.code, sum(e.base_debit - e.base_credit)::numeric(19,4)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = any(${documentIds as string[]}::uuid[])
     group by a.code order by a.code`;
}

/** Every document of this company that reverses one of `ids`, followed down the chain. */
async function chainOf(ids: readonly string[]): Promise<string[]> {
  const rows = await db.admin<{ id: string }[]>`
    with recursive c (id) as (
      select d.id from app.document d where d.id = any(${ids as string[]}::uuid[])
      union
      select r.id from c join app.document r on r.reverses_document_id = c.id
    )
    select id::text as id from c`;
  return rows.map((r) => r.id);
}

describe("R9's consumers — a reinstated fulfilment counts as done, so the last one takes the residue", () => {
  it("creditNoteFrom: three credits of one unit against a reinstated first one close the line at exactly zero", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "SIC",
      partyId,
      effectiveDate: "2026-02-01",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "3.000000",
          unitPrice: "3.3333",
          amount: "10.0000",
          cost: "10.0000",
        },
      ],
    });
    const [invLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv.documentId}`;
    const credit = (effectiveDate: string) =>
      withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const r = await creditNoteFrom(tx, ctxOf(s), {
          companyId: s.company,
          settledDocumentId: inv.documentId,
          targetDocumentTypeId: cnType,
          targetSeries: "CNC",
          effectiveDate,
          reason: "chain credit",
          lines: [{ settledLineId: invLine!.id, quantity: "1.000000" }],
        });
        await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
        await postDocument(tx, ctxOf(s), { documentId: r.documentId });
        return r.documentId;
      });

    const first = await credit("2026-02-02");
    expect(await lineOf(first)).toEqual({ amount: "-3.3333", cost: "3.3333" });
    await reinstate(first);
    const second = await credit("2026-02-05");
    expect(await lineOf(second)).toEqual({ amount: "-3.3333", cost: "3.3333" });
    // The third unit completes the line — the first credit's unit is out again — so it takes the residue.
    const third = await credit("2026-02-06");
    expect(await lineOf(third)).toEqual({ amount: "-3.3334", cost: "3.3334" });

    const all = await chainOf([inv.documentId, first, second, third]);
    expect(await netOver(all)).toEqual([
      { code: "1200", net: "0.0000" },
      { code: "1250", net: "0.0000" },
      { code: "4000", net: "0.0000" },
      { code: "5000", net: "0.0000" },
    ]);
  });

  it("convertToInvoice: three conversions of one unit against a reinstated first one relieve 1250 and bill the amount exactly", async () => {
    const delivery = await draftTypedDocument(db, s, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-02-01",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "3.000000",
          unitPrice: "3.3333",
          amount: "10.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: delivery.documentId, jobs: recordingJobs() }),
    );
    const convert = (effectiveDate: string) =>
      withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const r = await convertToInvoice(tx, ctxOf(s), {
          companyId: s.company,
          sourceDocumentId: delivery.documentId,
          targetDocumentTypeId: invType,
          targetSeries: "SIC",
          effectiveDate,
          lines: [{ sourceLineId: delivery.lineIds[0]!, quantity: "1.000000" }],
        });
        await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
        await postDocument(tx, ctxOf(s), { documentId: r.documentId });
        return r.documentId;
      });

    const first = await convert("2026-02-02");
    expect((await lineOf(first)).amount).toBe("3.3333");
    await reinstate(first);
    const second = await convert("2026-02-05");
    expect((await lineOf(second)).amount).toBe("3.3333");
    const third = await convert("2026-02-06");
    expect((await lineOf(third)).amount).toBe("3.3334");

    // The delivery put 9.0000 of cost into 1250 (3 × 3.0000); the chain and the three invoices take it all out.
    const all = await chainOf([delivery.documentId, first, second, third]);
    const nets = Object.fromEntries((await netOver(all)).map((r) => [r.code, r.net]));
    expect(nets["1250"]).toBe("0.0000");
    expect(nets["4000"]).toBe("-10.0000");
    expect(nets["1200"]).toBe("10.0000");
  });
});
