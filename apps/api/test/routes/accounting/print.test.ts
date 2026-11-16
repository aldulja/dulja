import { composeTemplateSource } from "@dulja/domain";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `grantAdmin` and `problemOf` live in `tests/support/api.ts` (0B, §4.17.1) — five levels up from
// `apps/api/test/routes/accounting/`, the same path 2A's own route tests use.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { pdfText } from "../../../../../tests/support/pdf";
import { closeChromium, PDF_MAGIC } from "../../../src/print/engines";
import { startApi, type StartedApi } from "../../support/app";

const LABELS = {
  en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
  ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
};
/** `dir="auto"` isolates a mixed-script label so `1000 · Cash` keeps its own order inside an RTL page. */
const BODY = [
  '<!doctype html><html lang="{{ lang }}" dir="{{ dir }}"><head><meta charset="utf-8"></head><body>',
  "<h1>{{ document.typeName }}</h1>",
  "<table><thead><tr><th>{{ labels.account }}</th><th>{{ labels.debit }}</th><th>{{ labels.credit }}</th></tr></thead>",
  '<tbody>{{#each lines}}<tr><td dir="auto">{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}</tbody></table>',
  "<p>{{ labels.total }}: {{ totals.debit }}</p>",
  "</body></html>",
].join("");

const journalBody = (s: Seed, amount: string) => ({
  documentTypeCode: "JOURNAL",
  // January: the seed's only OPEN period. `seedTenant` makes February closed and March locked, so a
  // "2026-03-01" journal is refused ERR_PERIOD_NOT_OPEN before it can be printed.
  effectiveDate: "2026-01-15",
  currency: "MYR",
  branchId: s.hq,
  lines: [
    { lineNo: 1, accountId: s.cash, debit: amount, description: "Cash received" },
    { lineNo: 2, accountId: s.sales, credit: amount, description: "Sales" },
  ],
});

const TEMPLATE = {
  documentTypeCode: "JOURNAL",
  code: "standard",
  version: 1,
  nameEn: "Journal Voucher",
  nameAr: "قيد يومية",
  engine: "chromium",
  paper: "A4",
  labels: LABELS,
  body: BODY,
};

const textOf = async (res: Response): Promise<string> =>
  (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");

describe("POST …/documents/{documentId}/print — §4.5.9, test 23 for PDFs", () => {
  let api: StartedApi;
  let a: Seed;
  let documentId: string;

  /** Creates and posts a JOURNAL through the public surface, so the test never writes app.document itself. */
  const postedJournal = async (s: Seed, amount: string): Promise<string> => {
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: journalBody(s, amount),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${id}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    return id;
  };

  const seedTemplate = async (s: Seed): Promise<void> => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/print-templates`,
      as: s.human,
      body: TEMPLATE,
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    // `grantAdmin(api, s)` gives the admin codes (templates are `admin.company.manage`); creating and posting
    // a JOURNAL resolves `accounting.journal.post` from the policy (2A), and printing needs the accounting
    // module's read code (§4.5.4). `seedTenant` grants `s.human` nothing (§4.1, pinned).
    await grantAdmin(api, a);
    await grantCodes(api.db, a, {
      codes: ["accounting.journal.create", "accounting.journal.post", "accounting.ledger.read"],
    });
    // The unit fixture's JOURNAL type is `name_en 'Journal'` with no `name_ar`; the seed pack's
    // (seed/my/document-types/JOURNAL.json) is what the text-layer cases assume. `{{ document.typeName }}`
    // reads the document TYPE's name, not the template's, so without both names the Arabic case could not
    // show that typeName follows the language (packages/db/test/print-render.test.ts does the same).
    await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "print-type-names" },
      (tx) => tx`update app.document_type set name_en = 'Journal Voucher', name_ar = 'قيد يومية'
                  where id = ${a.docType}`,
    );
    documentId = await postedJournal(a, "150.0000");
    await seedTemplate(a);
  }, 240_000);
  afterAll(async () => {
    await closeChromium();
    await api.stop();
  });

  const print = (body: unknown, as?: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: as ?? a.human,
      body,
    });
  it("returns a real PDF with a Content-Disposition naming the series and language", async () => {
    const res = await print({ lang: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="JV-\d{6}-en\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  }, 120_000);

  it("carries a real text layer — the amount round-trips out of the PDF (ADR 0016 criterion 3)", async () => {
    const text = await textOf(await print({ lang: "en" }));
    expect(text).toContain("150.0000");
    expect(text).toContain("1000 · Cash");
    expect(text).toContain("Journal Voucher");
    expect(text).toContain("Total: 150.0000");
  }, 120_000);

  it("renders the SAME document in Arabic from the SAME template row (spec:2253)", async () => {
    const text = await textOf(await print({ lang: "ar" }));
    expect(text).toContain("قيد يومية");
    expect(text).toContain("الإجمالي");
    expect(text).toContain("مدين");
    expect(text).toContain("دائن");
    // The Latin amount and the isolated account label are unchanged inside an RTL page — the bidi
    // criterion, not a hope.
    expect(text).toContain("150.0000");
    expect(text).toContain("1000 · Cash");
    // And no English label leaked into the Arabic render.
    expect(text).not.toContain("Debit");
    expect(text).not.toContain("Journal Voucher");
  }, 120_000);

  it("puts the column headings in the opposite reading order in the two directions", async () => {
    // `pdfText` returns each line in READING order, so the Arabic heading row reads account → debit →
    // credit exactly as the English one does; that is only true if the RTL page really laid the columns
    // out right to left and the reader undid it. A page that had ignored `dir` would read them reversed.
    const en = await pdfText(new Uint8Array(await (await print({ lang: "en" })).arrayBuffer()));
    const ar = await pdfText(new Uint8Array(await (await print({ lang: "ar" })).arrayBuffer()));
    expect(en.some((line) => line === "Account Debit Credit")).toBe(true);
    expect(ar.some((line) => line === "الحساب مدين دائن")).toBe(true);
  }, 120_000);

  it("defaults templateCode to 'standard' and refuses an unknown one with 404", async () => {
    expect((await print({ lang: "en" })).status).toBe(200);
    const res = await print({ lang: "en", templateCode: "receipt" });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  }, 120_000);

  it("refuses a lang outside the pair with ERR_VALIDATION_FAILED", async () => {
    const res = await print({ lang: "fr" });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("answers 404 for a document the path's company does not hold", async () => {
    const other = await seedTenantV2(api.db, "Gamma");
    await grantCodes(api.db, other, { codes: ["accounting.ledger.read"] });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${other.company}/documents/${documentId}/print`,
      as: other.human,
      body: { lang: "en" },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses a principal who can post but cannot READ the module (§4.5.4's rule)", async () => {
    // A second tenant whose principal holds exactly the codes needed to reach this point — create and post a
    // journal, manage the company's templates — and NOT accounting.ledger.read. That isolates the gate:
    // the 403 can only come from the module read code.
    const b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, b, {
      codes: ["accounting.journal.create", "accounting.journal.post", "admin.company.manage"],
    });
    const other = await postedJournal(b, "5.0000");
    await seedTemplate(b);

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/documents/${other}/print`,
      as: b.human,
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  }, 180_000);

  it("replays by re-running: the same key returns a PDF, not a null body", async () => {
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human,
      body: { lang: "en" },
      idempotencyKey: key,
    });
    const second = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human,
      body: { lang: "en" },
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("application/pdf");
    expect(second.headers.get("idempotency-replayed")).toBeNull();
    const bytes = new Uint8Array(await second.arrayBuffer());
    expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
  }, 120_000);

  it("still refuses the same key with a DIFFERENT body — the reservation is unchanged", async () => {
    const key = crypto.randomUUID();
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human,
      body: { lang: "en" },
      idempotencyKey: key,
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human,
      body: { lang: "ar" },
      idempotencyKey: key,
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_REUSED");
  }, 120_000);

  it("records a descriptor, never the bytes, in app.idempotency_key", async () => {
    const key = crypto.randomUUID();
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/print`,
      as: a.human,
      body: { lang: "en" },
      idempotencyKey: key,
    });
    const [row] = await api.db.admin<
      { response_body: { contentType: string; byteSize: number; sha256: string } }[]
    >`select response_body from app.idempotency_key where key = ${key}`;
    expect(row!.response_body.contentType).toBe("application/pdf");
    expect(row!.response_body.byteSize).toBeGreaterThan(1_000);
    expect(row!.response_body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row!.response_body).length).toBeLessThan(400);
  }, 120_000);

  it("refuses a template whose engine has no adapter with ERR_PRINT_ENGINE_UNSUPPORTED", async () => {
    // Migration 0026's CHECK admits `chromium` alone, so a row naming another engine cannot be inserted; the
    // route must still fail closed on the value it reads. The CHECK is dropped for this one insert and
    // restored, exactly the shape a widening migration would leave behind before its adapter lands.
    await api.db.admin`alter table app.print_template drop constraint print_template_engine_check`;
    try {
      // Inside a tenant session (the audit trigger stamps app.current_actor()), as the migrator role, which
      // FORCE ROW LEVEL SECURITY binds like any other.
      await api.db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
        await tx`
          insert into app.print_template
            (tenant_id, company_id, document_type_id, code, version, name_en, engine, source, paper)
          values (${a.tenant}, ${a.company}, ${a.docType}, 'reactish', 1, 'R', 'react-pdf',
                  ${composeTemplateSource({ labels: LABELS }, BODY)}, 'A4')`;
      });
    } finally {
      await api.db.admin`
        alter table app.print_template
          add constraint print_template_engine_check check (engine in ('chromium')) not valid`;
    }
    const res = await print({ lang: "en", templateCode: "reactish" });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
  }, 120_000);
});
