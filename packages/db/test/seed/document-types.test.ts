import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { SeedError } from "../../src/seed/types";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  draftDocument,
  grantCodes,
  JOURNAL_POLICY_V1,
  seedTenant,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const PACK = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));
/** The domain's copy of the same envelope. The first assertion below pins the two files byte for byte. */
const DOMAIN_FIXTURE = fileURLToPath(
  new URL("../../../domain/test/posting/journal-envelope.fixture.json", import.meta.url),
);

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.system,
  requestId: "seed",
});

describe("the document-types sub-pack loader — contracts §3.4.8, §4.3.7", () => {
  let db: Db;
  let a: Seed;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    // Deliberately NOT seedTenantV2: the pack does the work.
    a = await seedTenant(db, "Alpha");
    const rows = await db.admin<{ code: string }[]>`select code from app.permission`;
    catalogue = rows.map((row) => row.code);
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the seed file is byte-identical to the domain fixture the evaluator tests use", () => {
    // Two assertions, because there are three copies of this JSON and each pair has to be pinned:
    // (1) the seed pack file against the domain test fixture, byte for byte — without it the fixture can
    //     drift and take the evaluator's tests with it; (2) the seed file's `policy` member against
    //     JOURNAL_POLICY_V1 in packages/db/test/fixtures.ts, which is what seedJournalPolicy inserts.
    const seedText = readFileSync(`${PACK}/JOURNAL.json`, "utf8");
    const fixtureText = readFileSync(DOMAIN_FIXTURE, "utf8");
    expect(seedText).toBe(fixtureText);

    const onDisk = JSON.parse(seedText) as { policy: unknown };
    expect(onDisk.policy).toEqual(JOURNAL_POLICY_V1);
  });

  it("seeds the JOURNAL type and its policy version 2 for the tenant", async () => {
    const results = await loadDocumentTypes(db.rw, ctx(a), PACK, catalogue);
    // seedTenant already made the JOURNAL type; 3B T8 added `COST_ADJUSTMENT.json`, 3C T5 added
    // `PURCHASE_ORDER.json`, 3C T6 added `GOODS_RECEIPT.json`, 3C T9 added `SHIPMENT.json` and 3C T10
    // added `PURCHASE_RETURN.json`, and 3D T5-T9 added `SALES_ORDER.json`, `DELIVERY_ORDER.json`,
    // `TRANSFER.json`, `TRANSFER_RECEIPT.json`, `STOCK_COUNT.json` and `EXPIRY_WRITE_OFF.json` to the
    // same sub-pack (§3.4.8: a slice adding rows adds a file, never a loader), 4A T5 and T7 added
    // `SALES_INVOICE.json` and `PURCHASE_INVOICE.json`, 4A T8 added `SALES_CREDIT_NOTE.json` and
    // `PURCHASE_CREDIT_NOTE.json`, 4A T10 added `PAYMENT.json` and `RECEIPT.json`, and 4B T5 added
    // `FX_REVALUATION.json`. `readEnvelopes` reads the directory in `toSorted()` order, so `COST_ADJUSTMENT`
    // — created here for the first time — comes first and `TRANSFER_RECEIPT` last.
    expect(results).toEqual([
      expect.objectContaining({ code: "COST_ADJUSTMENT", created: true }),
      expect.objectContaining({ code: "DELIVERY_ORDER", created: true }),
      // 8C T5 — EMPLOYEE_ADVANCE.json and PAYROLL_PAYMENT.json (module hr; accounting.payment.* approval).
      expect.objectContaining({ code: "EMPLOYEE_ADVANCE", created: true }),
      expect.objectContaining({ code: "EXPIRY_WRITE_OFF", created: true }),
      expect.objectContaining({ code: "FX_REVALUATION", created: true }),
      expect.objectContaining({ code: "GOODS_RECEIPT", created: true }),
      expect.objectContaining({ code: "JOURNAL", created: false }),
      // 9B T5 — OPENING_BALANCE.json (module accounting, series OB; JOURNAL's approval and reversal, applied by the
      // cut-over runbook's `--only document-types`).
      expect.objectContaining({ code: "OPENING_BALANCE", created: true }),
      // 9B T6 — OPENING_STOCK.json (module inventory, series OS; receipt at a recomputed cost, credit leg 3900).
      expect.objectContaining({ code: "OPENING_STOCK", created: true }),
      expect.objectContaining({ code: "PAYMENT", created: true }),
      // 8B T4 — PAYROLL.json (module hr; its approval codes are 8B T3's, migration 0089).
      expect.objectContaining({ code: "PAYROLL", created: true }),
      expect.objectContaining({ code: "PAYROLL_PAYMENT", created: true }),
      expect.objectContaining({ code: "POS_TICKET", created: true }),
      expect.objectContaining({ code: "PURCHASE_CREDIT_NOTE", created: true }),
      expect.objectContaining({ code: "PURCHASE_INVOICE", created: true }),
      expect.objectContaining({ code: "PURCHASE_ORDER", created: true }),
      expect.objectContaining({ code: "PURCHASE_RETURN", created: true }),
      expect.objectContaining({ code: "RECEIPT", created: true }),
      expect.objectContaining({ code: "SALES_CREDIT_NOTE", created: true }),
      expect.objectContaining({ code: "SALES_INVOICE", created: true }),
      expect.objectContaining({ code: "SALES_ORDER", created: true }),
      expect.objectContaining({ code: "SHIPMENT", created: true }),
      expect.objectContaining({ code: "STOCK_COUNT", created: true }),
      expect.objectContaining({ code: "TILL_BANKING", created: true }),
      expect.objectContaining({ code: "TILL_OVER_SHORT", created: true }),
      expect.objectContaining({ code: "TILL_PAID_OUT", created: true }),
      expect.objectContaining({ code: "TILL_SAFE_DROP", created: true }),
      expect.objectContaining({ code: "TRANSFER", created: true }),
      expect.objectContaining({ code: "TRANSFER_RECEIPT", created: true }),
    ]);

    const [policy] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ version: number; effective_from: string; definition: unknown }[]>`
      select version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, definition
        from app.posting_policy where document_type_id = ${a.docType} and version = 2`,
    );
    expect(policy).toMatchObject({ version: 2, effective_from: "2026-01-01" });
    expect(policy!.definition).toEqual(JOURNAL_POLICY_V1);
  });

  it("is idempotent, and re-running updates a drifted definition rather than skipping it (§3.4.8)", async () => {
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.posting_policy set definition = ${JSON.stringify({ ...JOURNAL_POLICY_V1, direction: "none" })}::text::jsonb
       where document_type_id = ${a.docType} and version = 2`,
    );
    await loadDocumentTypes(db.rw, ctx(a), PACK, catalogue);
    const [policy] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ definition: { direction: string } }[]>`
      select definition from app.posting_policy where document_type_id = ${a.docType} and version = 2`,
    );
    expect(policy!.definition.direction).toBe("internal");
  });

  it("refuses to rewrite a drifted version that a POSTED document pins, and names the fix (SAH-013)", async () => {
    // A tenant of its own, so the drift never has to be undone for the cases that follow: migration 0106's
    // guard makes a pinned version immutable, and no case may switch that guard off to restore one.
    const d = await seedTenantV2(db, "Drift");
    await loadDocumentTypes(db.rw, ctx(d), PACK, catalogue);
    // Drift version 2 while nothing pins it — an ordinary tenant write the guard admits — and only THEN
    // post a JOURNAL under it, which pins the drifted definition. Re-running the pack must now stop rather
    // than change what that document was posted under. Migration 0106's trigger is the second line of
    // defence; the loader refuses first, with a message an operator can act on.
    await withTenant(
      db.rw,
      d.tenant,
      d.human,
      (tx) => tx`
      update app.posting_policy set definition = ${JSON.stringify({ ...JOURNAL_POLICY_V1, direction: "none" })}::text::jsonb
       where document_type_id = ${d.docType} and version = 2`,
    );
    await grantCodes(db, d, { codes: ["accounting.journal.post"] });
    const id = await draftDocument(db, d);
    await withTenant(db.rw, d.tenant, d.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${d.tenant}, ${d.company}, ${id}, 1, ${d.cash}, 5)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${d.tenant}, ${d.company}, ${id}, 2, ${d.sales}, 5)`;
    });
    const pctx = { tenantId: d.tenant, actorId: d.human, requestId: "seed-pin" };
    await prodWithTenant(db.rw, pctx, (tx) => postDocument(tx, pctx, { documentId: id }));
    // Version 2 wins the 2026-01-01 tie with the fixture's version 1, so the posting pinned the drift.
    const [pinned] = await withTenant(
      db.rw,
      d.tenant,
      d.human,
      (tx) => tx<{ version: number }[]>`
      select p.version from app.document doc join app.posting_policy p on p.id = doc.posting_policy_id
       where doc.id = ${id}`,
    );
    expect(pinned!.version).toBe(2);
    await expect(loadDocumentTypes(db.rw, ctx(d), PACK, catalogue)).rejects.toThrow(SeedError);
    await expect(loadDocumentTypes(db.rw, ctx(d), PACK, catalogue)).rejects.toThrow(
      /pinned by posted documents; bump policyVersion/,
    );
  });

  it("the envelope's module reaches the column the attachment gate reads (contracts §4.5.8)", async () => {
    await loadDocumentTypes(db.rw, ctx(a), PACK, catalogue);
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { module: string }[]
        >`select module from app.document_type where company_id = ${a.company} and code = 'JOURNAL'`,
    );
    expect(row!.module).toBe("accounting");
  });

  it("refuses a policy naming a permission code the catalogue does not hold (F-21)", async () => {
    // `readEnvelopes` validates in `toSorted()` file order and throws on the first bad file, so since 3B
    // T8 added `COST_ADJUSTMENT.json` — which names the same code — that is the file named here.
    await expect(loadDocumentTypes(db.rw, ctx(a), PACK, ["admin.user.manage"])).rejects.toThrow(
      /COST_ADJUSTMENT\.json.*accounting\.journal\.post is not in the permission catalogue/s,
    );
  });

  it("refuses a file whose name and code disagree", async () => {
    const badDir = fileURLToPath(new URL("./fixtures/bad-document-types", import.meta.url));
    await expect(loadDocumentTypes(db.rw, ctx(a), badDir, catalogue)).rejects.toThrow(
      /WRONGNAME\.json/,
    );
  });
});
