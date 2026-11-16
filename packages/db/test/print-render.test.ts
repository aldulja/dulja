import { composeTemplateSource } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../src/posting";
import { PrintError, renderDocumentSource } from "../src/print";
import {
  DEFAULT_TEMPLATE_CODE,
  loadPrintContext,
  resolvePrintTemplate,
} from "../src/print/template";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, type Db } from "./harness";

const LABELS = {
  en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
  ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
};
const BODY = [
  '<h1 dir="{{ dir }}">{{ document.typeName }}</h1>',
  "<p>{{ company.name }} — {{ document.series }}-{{ document.number }}</p>",
  "<table>{{#each lines}}<tr><td>{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}</table>",
  "<p>{{ labels.total }}: {{ totals.debit }}</p>",
  '{{#if document.notes}}<p class="notes">{{ document.notes }}</p>{{/if}}',
].join("\n");

const ctx = (s: Seed, requestId: string) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId,
});

async function seedTemplate(
  db: Db,
  s: Seed,
  opts: { code?: string; version?: number; engine?: string },
) {
  const requestId = await uuidv7(db.admin);
  return prodWithTenant(db.rw, ctx(s, requestId), async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.print_template
        (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
      values (${s.tenant}, ${s.company}, ${s.docType}, ${opts.code ?? DEFAULT_TEMPLATE_CODE},
              ${opts.version ?? 1}, 'Journal Voucher', 'قيد يومية', ${opts.engine ?? "chromium"},
              ${composeTemplateSource({ labels: LABELS }, BODY)}, 'A4')
      returning id`;
    return row!.id;
  });
}

/**
 * A posted JOURNAL, file-local. §4.17 assigns 2C no fixture helper and hazard 9 forbids inventing one,
 * and 1B's `postJournal` lives in `tests/invariants/support/` — the root test tier, which
 * `packages/db/test` cannot import (§3.1). So this is a local function in the one file that needs it,
 * shaped like 1A's `packages/db/test/posting/post.test.ts`. The `grantCodes` call is not optional: 2B's
 * R2 runs `app.actor_has(policy.approval.post, …)` inside the posting transaction and `seedTenant`
 * grants `s.human` nothing (§4.1, pinned).
 */
async function postJournalLocal(
  db: Db,
  s: Seed,
  lines: readonly { accountId: string; debit?: string; credit?: string; description?: string }[],
  notes?: string,
): Promise<string> {
  await grantCodes(db, s, { principalId: s.human, codes: ["accounting.journal.post"] });
  const documentId = await draftDocument(db, s);
  const requestId = await uuidv7(db.admin);
  await prodWithTenant(db.rw, ctx(s, requestId), async (tx) => {
    // A note is written on the DRAFT: once posted the header is frozen (migration 0117).
    if (notes !== undefined)
      await tx`update app.document set notes = ${notes} where id = ${documentId}`;
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, description, account_id, debit, credit)
        values (${s.tenant}, ${s.company}, ${documentId}, ${lineNo}, 'account',
                ${l.description ?? null}, ${l.accountId},
                ${l.debit ?? "0.0000"}, ${l.credit ?? "0.0000"})`;
    }
    await postDocument(tx, ctx(s, requestId), { documentId });
  });
  return documentId;
}

/** `seedTenantV2` already created `1000 Cash` (asset) and `4000 Sales` (income) — §4.1's pinned seed
 *  constants — and §4.15 gives 2C no account to seed, so this reads the ids rather than creating rows. */
async function accountId(db: Db, s: Seed, code: string): Promise<string> {
  const [row] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`;
  return row!.id;
}

describe("resolvePrintTemplate — highest version wins, code defaults to standard", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await seedTemplate(db, a, { version: 1 });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("returns the only version", async () => {
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      resolvePrintTemplate(tx, { companyId: a.company, documentTypeId: a.docType }),
    );
    expect(row).toMatchObject({ code: "standard", version: 1, engine: "chromium", paper: "A4" });
  });

  it("prefers the highest version of the same code — a new version supersedes (constraint 8)", async () => {
    await seedTemplate(db, a, { version: 2 });
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      resolvePrintTemplate(tx, { companyId: a.company, documentTypeId: a.docType }),
    );
    expect(row.version).toBe(2);
  });

  it("raises ERR_NOT_FOUND naming the code it looked for", async () => {
    const requestId = await uuidv7(db.admin);
    await expect(
      prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
        resolvePrintTemplate(tx, {
          companyId: a.company,
          documentTypeId: a.docType,
          templateCode: "receipt",
        }),
      ),
    ).rejects.toThrow(/no print template 'receipt'/);
  });

  it("loadPrintContext labels every account the document touches and nothing else", async () => {
    const documentId = await postJournalLocal(db, a, [
      { accountId: await accountId(db, a, "1000"), debit: "10.0000" },
      { accountId: await accountId(db, a, "4000"), credit: "10.0000" },
    ]);
    const requestId = await uuidv7(db.admin);
    const context = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      loadPrintContext(tx, documentId, "en"),
    );
    // seedTenant names the company `${name} HQ` (fixtures.ts), so "Alpha" is the tenant and this is its company.
    expect(context.companyName).toBe("Alpha HQ");
    expect(context.documentTypeNameEn).toBeTruthy();
    expect(context.partyName).toBeNull();
    expect(context.notes).toBeNull();
    expect(Object.values(context.accountLabels).toSorted()).toEqual([
      "1000 · Cash",
      "4000 · Sales",
    ]);
  });
});

describe("renderDocumentSource — the impure half of printing", () => {
  let db: Db;
  let a: Seed;
  let documentId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    // The unit fixture's JOURNAL type is `name_en 'Journal'` with no `name_ar`; the seed pack's
    // (seed/my/document-types/JOURNAL.json) is what these cases assume. `{{ document.typeName }}` reads the
    // document TYPE's name, not the template's, so without both names the Arabic case below would fall
    // back to the English one and could not show that typeName follows the language.
    await prodWithTenant(
      db.rw,
      ctx(a, await uuidv7(db.admin)),
      (tx) => tx`update app.document_type set name_en = 'Journal Voucher', name_ar = 'قيد يومية'
                  where id = ${a.docType}`,
    );
    await seedTemplate(db, a, {});
    documentId = await postJournalLocal(db, a, [
      {
        accountId: await accountId(db, a, "1000"),
        debit: "150.0000",
        description: "Cash received",
      },
      { accountId: await accountId(db, a, "4000"), credit: "150.0000", description: "Sales" },
    ]);
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("substitutes the model into the body and reports the row's engine and paper", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }),
    );

    expect(out.engine).toBe("chromium");
    expect(out.paper).toBe("A4");
    expect(out.templateCode).toBe("standard");
    expect(out.rendered).toContain("Journal Voucher");
    expect(out.rendered).toContain('dir="ltr"');
    expect(out.rendered).toContain("Total: 150.0000");
    // Accounts print as "1000 · Cash", never as a uuid — that is loadPrintContext's whole job.
    expect(out.rendered).toContain("1000 · Cash");
    expect(out.rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("renders the Arabic template text from the same row, with the ar labels and dir=rtl", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "ar" }),
    );
    expect(out.rendered).toContain('dir="rtl"');
    expect(out.rendered).toContain("الإجمالي: 150.0000");
    expect(out.rendered).toContain("قيد يومية");
    // 0A's `1000 Cash` carries no `name_ar`, so `coalesce(name_ar, name_en)` shows the English name.
    // That is the decided fallback, not an oversight — it is asserted so nobody "fixes" it into a blank.
    expect(out.rendered).toContain("1000 · Cash");
  });

  it("names the file from the series, number and language", async () => {
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }),
    );
    expect(out.fileStem).toMatch(/^JV-\d{6}-en$/);
  });

  it("is deterministic — two renders of one document are the same string", async () => {
    const requestId = await uuidv7(db.admin);
    const [one, two] = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => [
      await renderDocumentSource(tx, { documentId, lang: "en" }),
      await renderDocumentSource(tx, { documentId, lang: "en" }),
    ]);
    expect(one!.rendered).toBe(two!.rendered);
  });

  it("raises PrintError ERR_NOT_FOUND for a document another tenant owns", async () => {
    const b = await seedTenantV2(db, "Beta");
    const requestId = await uuidv7(db.admin);
    await expect(
      prodWithTenant(db.rw, ctx(b, requestId), (tx) =>
        renderDocumentSource(tx, { documentId, lang: "en" }),
      ),
    ).rejects.toBeInstanceOf(PrintError);
  });

  it("raises PrintError ERR_NOT_FOUND when the named template code has no row", async () => {
    const requestId = await uuidv7(db.admin);
    const raised = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en", templateCode: "receipt" }),
    ).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(PrintError);
    expect((raised as PrintError).code).toBe("ERR_NOT_FOUND");
  });

  it("reports an unparseable stored source as ERR_VALIDATION_FAILED naming the template", async () => {
    const requestId = await uuidv7(db.admin);
    await prodWithTenant(
      db.rw,
      ctx(a, requestId),
      (tx) => tx`
        insert into app.print_template
          (tenant_id, company_id, document_type_id, code, version, name_en, engine, source, paper)
        values (${a.tenant}, ${a.company}, ${a.docType}, 'broken', 1, 'Broken', 'chromium',
                '<p>no front matter</p>', 'A4')`,
    );
    const raised = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en", templateCode: "broken" }),
    ).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(PrintError);
    expect((raised as PrintError).code).toBe("ERR_VALIDATION_FAILED");
    expect((raised as PrintError).detail).toMatch(
      /print template broken v1 has an unreadable source/,
    );
  });

  it("prints a note once 0027 has added the column", async () => {
    const noted = await postJournalLocal(
      db,
      a,
      [
        { accountId: await accountId(db, a, "1000"), debit: "10.0000" },
        { accountId: await accountId(db, a, "4000"), credit: "10.0000" },
      ],
      "Consignor notified",
    );
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId: noted, lang: "en" }),
    );
    expect(out.model.document.notes).toBe("Consignor notified");
    expect(out.rendered).toContain('class="notes"');
    expect(out.rendered).toContain("Consignor notified");
  });

  it("prints an empty note as nothing at all, not as the string 'null'", async () => {
    // `documentId` was posted with no note: its `notes` is NULL.
    const [head] = await db.admin<{ notes: string | null }[]>`
      select notes from app.document where id = ${documentId}`;
    expect(head!.notes).toBeNull();
    const requestId = await uuidv7(db.admin);
    const out = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      renderDocumentSource(tx, { documentId, lang: "en" }),
    );
    expect(out.model.document.notes).toBe("");
    expect(out.rendered).not.toContain('class="notes"');
    expect(out.rendered).not.toContain("null");
  });
});
