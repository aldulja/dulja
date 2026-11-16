import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "@dulja/db/test";
import { CATALOGUES, checkCatalogues, createI18n, LOCALES } from "@dulja/i18n";
import type { StartedApi } from "../../apps/api/test/support/app";
import { fullRegression, sharedApi } from "../support/api";
import { pdfText } from "../support/pdf";
import { CATALOGUE_7C, readDefinition7C } from "../invariants/support/reports-7c";
import {
  HR_CATALOGUE,
  HR_CATALOGUE_DIR,
  hrReportFixture,
  readHrDefinition,
  readHrEnvelope,
  type HrReportFixture,
} from "../invariants/support/hr-reports";
import { REPO_ROOT } from "../support/source";

describe("LEGACY-085 The English build was never proofread — 0E", () => {
  it("no translation is empty (the legacy build shipped 122)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "empty_value")).toEqual([]);
  });

  it("no key exists in one catalogue and not the other", () => {
    expect(checkCatalogues().filter((v) => v.rule === "missing_key")).toEqual([]);
  });

  it("no Arabic string reaches an English value (the legacy build shipped 61, two of them dialogs)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "wrong_script" && v.locale === "en")).toEqual(
      [],
    );
  });

  it("no Arabic value is the English string verbatim", () => {
    expect(checkCatalogues().filter((v) => v.rule === "source_language_fallback")).toEqual([]);
  });

  it("no value has trailing whitespace (the legacy build shipped 232)", () => {
    expect(checkCatalogues().filter((v) => v.rule === "trailing_whitespace")).toEqual([]);
  });

  it('no raw component name is shipped as UI text (the legacy build shipped "TBXToolbar3")', () => {
    expect(checkCatalogues().filter((v) => v.rule === "component_name_leak")).toEqual([]);
  });

  it("a missing Arabic value renders the key, never the English string (fallbackLng: false)", async () => {
    const i18n = await createI18n({
      locale: "ar",
      catalogues: { en: { "x.y": "Save changes" }, ar: {} },
    });
    expect(i18n.t("x.y")).toBe("x.y");
    expect(i18n.t("x.y")).not.toBe("Save changes");
  });

  it("every shipped key is reachable in both locales", async () => {
    for (const locale of LOCALES) {
      const i18n = await createI18n({ locale });
      for (const key of Object.keys(CATALOGUES.en)) {
        expect(i18n.t(key), `${locale}:${key}`).not.toBe(key);
      }
    }
  });
});

/** Creates and posts a JOURNAL through the API. 1A's CreateDocumentBody carries `lines`, so one call. */
async function postedJournalThroughApi(api: StartedApi, s: Seed, amount: string): Promise<string> {
  const created = await api.request({
    method: "POST",
    path: `/v1/companies/${s.company}/documents`,
    as: s.human,
    body: {
      documentTypeCode: "JOURNAL",
      // January — the seed's only OPEN period. The plan's 2026-03-01 is in the seed's LOCKED March, so the
      // post below was refused and the helper, which checked nothing, handed back an unposted document.
      effectiveDate: "2026-01-15",
      currency: "MYR",
      branchId: s.hq,
      lines: [
        { lineNo: 1, accountId: s.cash, debit: amount },
        { lineNo: 2, accountId: s.sales, credit: amount },
      ],
    },
  });
  // Asserted, so a refused create or post fails HERE with its own status instead of as a 404 on
  // `…/documents//print` two calls later.
  expect(created.status).toBe(201);
  const documentId = ((await created.json()) as { id: string }).id;
  const posted = await api.request({
    method: "POST",
    path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
    as: s.human,
    body: { to: "posted" },
  });
  expect(posted.status).toBe(200);
  return documentId;
}

/** The bilingual JOURNAL template, through the configuration API of 2C. */
async function seedStandardTemplate(api: StartedApi, s: Seed): Promise<void> {
  await api.request({
    method: "POST",
    path: `/v1/companies/${s.company}/print-templates`,
    as: s.human,
    body: {
      documentTypeCode: "JOURNAL",
      code: "standard",
      version: 1,
      nameEn: "Journal Voucher",
      nameAr: "قيد يومية",
      engine: "chromium",
      paper: "A4",
      labels: {
        en: { total: "Total", account: "Account", debit: "Debit", credit: "Credit" },
        ar: { total: "الإجمالي", account: "الحساب", debit: "مدين", credit: "دائن" },
      },
      body:
        '<!doctype html><html lang="{{ lang }}" dir="{{ dir }}"><head><meta charset="utf-8">' +
        "</head><body><h1>{{ document.typeName }}</h1><table><tr><th>{{ labels.account }}</th>" +
        "<th>{{ labels.debit }}</th><th>{{ labels.credit }}</th></tr>" +
        '{{#each lines}}<tr><td dir="auto">{{ account }}</td><td>{{ debit }}</td><td>{{ credit }}</td></tr>{{/each}}' +
        "</table><p>{{ labels.total }}: {{ totals.debit }}</p></body></html>",
    },
  });
}

fullRegression("LEGACY-085", "Arabic renders correctly in every output, PDFs included — 2C", {
  "one template row renders both directions with the right labels and no leakage": async ({
    api,
  }) => {
    // Its own V2 tenant, not `sharedApi()`'s `a`: that one is Plan 0A's `seedTenant`, whose JOURNAL policy
    // predates 2A's schema (no `requires`, `inventory` or `tax`), so since 2A every create of a JOURNAL there
    // is refused ERR_POLICY_INVALID. `seedTenantV2` adds 1A's JOURNAL_POLICY_V1 over it as version 2 (§4.1).
    const a = await seedTenantV2(api.db, "LEGACY085-2C");
    await grantCodes(api.db, a, {
      codes: [
        "accounting.journal.create",
        "accounting.journal.post",
        "accounting.ledger.read",
        "admin.company.manage",
      ],
    });
    const documentId = await postedJournalThroughApi(api, a, "42.0000");
    await seedStandardTemplate(api, a);

    const seen: Record<string, string> = {};
    for (const lang of ["en", "ar"] as const) {
      const res = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/documents/${documentId}/print`,
        as: a.human,
        body: { lang },
      });
      expect(res.status).toBe(200);
      seen[lang] = (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    }

    // The Arabic render carries Arabic labels and no English ones; the English render, the reverse.
    expect(seen["ar"]).toContain("مدين");
    expect(seen["ar"]).not.toContain("Debit");
    expect(seen["en"]).toContain("Debit");
    expect(seen["en"]).not.toContain("مدين");
    // The amount is identical in both — Latin digits inside an RTL run are not reordered (LEGACY-085).
    expect(seen["ar"]).toContain("42.0000");
    expect(seen["en"]).toContain("42.0000");
  },
});

describe("LEGACY-085 The English build was never proofread — 7A", () => {
  // 61 untranslated Arabic strings, 122 empty translations, 452 misspellings; two Arabic DIALOGS reached
  // English users. spec:2061: "Both catalogues must be complete before merge — no empty msgstr, no
  // source-language fallbacks in the other language." A report is a user-facing surface, so it is bound too.

  it("the schema makes a missing Arabic label unrepresentable — nameAr and labelAr are REQUIRED, minLength 1", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/domain/report-definition.schema.json"), "utf8"),
    );
    expect(schema.required).toContain("nameAr");
    expect(schema.properties.nameAr).toEqual({ type: "string", minLength: 1 });
    expect(schema.$defs.column.required).toEqual(expect.arrayContaining(["labelEn", "labelAr"]));
    expect(schema.$defs.column.properties.labelAr).toEqual({ type: "string", minLength: 1 });
    // A definition with an empty Arabic label cannot be seeded OR created through the API: one validator,
    // one refusal, at both doors. That is the structural version of "no empty msgstr".
  });

  it("every committed report definition carries both languages, and neither falls back to the other", () => {
    const root = join(REPO_ROOT, "packages/db/seed/my/reports");
    for (const slice of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const file of readdirSync(join(root, slice.name)).filter((n) => n.endsWith(".json"))) {
        // §4.16.1's envelope: the definition is under `definition`, beside the row's `definitionVersion`.
        const { definition } = JSON.parse(readFileSync(join(root, slice.name, file), "utf8")) as {
          definition: {
            nameEn: string;
            nameAr: string;
            columns: { labelEn: string; labelAr: string }[];
          };
        };
        const where = `${slice.name}/${file}`;
        expect(definition.nameAr.trim(), where).not.toBe("");
        expect(definition.nameAr, where).not.toBe(definition.nameEn); // no source-language fallback
        expect(definition.nameEn, where).toBe(definition.nameEn.trim()); // no trailing whitespace (232 occurrences)
        expect(definition.nameAr, where).toBe(definition.nameAr.trim());
        for (const column of definition.columns) {
          expect(column.labelAr.trim(), `${where} ${column.labelEn}`).not.toBe("");
          expect(column.labelAr, `${where} ${column.labelEn}`).not.toBe(column.labelEn);
        }
      }
    }
  });

  it("the renderer picks the Arabic label for lang ar and never falls back to the English one", async () => {
    const { intlFormatters, renderReport } = await import("@dulja/domain");
    const definition = {
      version: 1,
      code: "accounting.trial_balance",
      nameEn: "Trial balance",
      nameAr: "ميزان المراجعة",
      module: "accounting",
      permission: "accounting.report.read",
      parameters: [],
      dataset: { source: "account_balance", filters: [] },
      columns: [{ field: "c", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
      groups: [],
      totals: [],
      sort: [],
      layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
      tieOut: { kind: "none" },
    } as const;
    const ar = renderReport(structuredClone(definition) as never, [{ c: "1000" }], {
      format: "csv",
      lang: "ar",
      formatters: intlFormatters("ar"),
    });
    expect(ar.title).toBe("ميزان المراجعة");
    expect(ar.columns[0]!.label).toBe("الرمز");
    expect(ar.dir).toBe("rtl");
    // …and the English render carries neither Arabic string.
    const en = renderReport(structuredClone(definition) as never, [{ c: "1000" }], {
      format: "csv",
      lang: "en",
      formatters: intlFormatters("en"),
    });
    expect(en.title).toBe("Trial balance");
    expect(en.columns[0]!.label).toBe("Code");
    expect(en.dir).toBe("ltr");
  });
});

describe("LEGACY-085 The English build was never proofread — 7C", () => {
  it("every 7C definition has its own Arabic name and an Arabic label for every column, none a fallback", () => {
    for (const code of CATALOGUE_7C) {
      const definition = readDefinition7C(code);
      expect(definition.nameAr.trim(), `${code}.nameAr`).not.toBe("");
      expect(definition.nameAr, `${code}.nameAr`).not.toBe(definition.nameEn);
      for (const column of definition.columns) {
        expect(column.labelAr.trim(), `${code}.${column.field}.labelAr`).not.toBe("");
        expect(column.labelAr, `${code}.${column.field}.labelAr`).not.toBe(column.labelEn);
      }
      // Two columns with different English labels never share one Arabic label — the tax view's "Type" and
      // "Kind" once did (round 15, A16 item 16). An Arabic reader must be able to tell the columns apart.
      const byArabic = new Map<string, Set<string>>();
      for (const column of definition.columns) {
        const english = byArabic.get(column.labelAr) ?? new Set<string>();
        english.add(column.labelEn);
        byArabic.set(column.labelAr, english);
      }
      for (const [arabic, english] of byArabic) {
        expect(english.size, `${code}: "${arabic}" labels ${[...english].join(", ")}`).toBe(1);
      }
    }
  });

  it("a rendered 7C report is right-to-left in Arabic and keeps its logical column order (test 23)", async () => {
    const { intlFormatters, renderReport } = await import("@dulja/domain");
    const definition = readDefinition7C("accounting.party_statement");
    const rows = [
      {
        effective_date: "2026-01-15",
        document_type_code: "SALES_INVOICE",
        series: "SI",
        number: 1,
        status: "posted",
        currency: "MYR",
        base_total: "1000.0000",
        document_id: "0190a000-0000-7000-8000-000000000001",
        posting_seq: 1,
        party_id: "0190a000-0000-7000-8000-000000000002",
      },
    ];
    const render = (lang: "en" | "ar") =>
      renderReport(definition, rows, {
        format: "csv",
        lang,
        formatters: intlFormatters(lang, { currency: "MYR" }),
        parameters: { fromDate: "2026-01-01", toDate: "2026-01-31" },
        generatedAt: "2026-02-01T00:00:00Z",
      });
    const ar = render("ar");
    const en = render("en");
    expect(ar.dir).toBe("rtl");
    expect(en.dir).toBe("ltr");
    expect(ar.title).toBe(definition.nameAr);
    expect(en.title).toBe(definition.nameEn);
    // 7A's contract: `columns` is LOGICAL order and is never reversed for rtl — the renderer flips the page.
    expect(ar.columns.map((c) => c.field)).toEqual(en.columns.map((c) => c.field));
    expect(ar.columns.map((c) => c.label)).toEqual(definition.columns.map((c) => c.labelAr));
    expect(en.columns.map((c) => c.label)).toEqual(definition.columns.map((c) => c.labelEn));
  });
});

/** The distinct money figures a PDF's text states, as a sorted set (the 8D block's comparison). */
const amounts8d = (t: string): string[] =>
  [...new Set(t.match(/\d[\d,]*\.\d{2}(?!\d)/g) ?? [])].toSorted();

describe("LEGACY-085 The English build was never proofread — 8D (the payslip)", () => {
  // `sharedApi()`'s app, with a V2 tenant of the block's own: `hrReportFixture` calls `payrollFixture`, which is not
  // idempotent and seeds a SYNTH scheme (`unique (company_id, code)`), so it cannot share `a`.
  let api: StartedApi;
  let s: Seed;
  let f: HrReportFixture;

  beforeAll(async () => {
    api = (await sharedApi()).api;
    s = await seedTenantV2(api.db, "LEGACY085-8D");
    f = await hrReportFixture(api.db, s);
    await grantCodes(api.db, s, { codes: ["hr.filing.generate"] });
    // The pack file itself, as `bun run seed --only reports` applies it.
    await seedReportDefinition(api.db, s, {
      code: "hr.payslip",
      definition: readHrEnvelope("hr.payslip").definition,
    });
    await api.loadPrincipals();
  }, 300_000);

  /** Generate one language's payslips and return the first one's rendered text. File-local, as the payslip route
   *  test's own helpers are: §4.17.1 assigns this slice no third shared helper. */
  const payslipText = async (lang: "en" | "ar"): Promise<string> => {
    const gen = await api.request({
      method: "POST",
      as: s.human,
      body: { lang },
      path: `/v1/companies/${s.company}/payroll-runs/${f.runDocumentId}/payslips`,
    });
    expect(gen.status).toBe(201);
    const { items } = (await gen.json()) as { items: { attachmentId: string }[] };
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `/v1/companies/${s.company}/attachments/${items[0]!.attachmentId}/content`,
    });
    expect(res.status).toBe(200);
    return (await pdfText(new Uint8Array(await res.arrayBuffer()))).join("\n");
  };

  it("the payslip renders each language's own labels and the same figures (test 23)", async () => {
    const en = await payslipText("en");
    const ar = await payslipText("ar");
    expect(en).toContain("Amount");
    expect(ar).toContain("المبلغ");
    expect(ar).not.toContain("Amount");
    expect(en).not.toContain("المبلغ");
    // Compared as a SET of distinct figures: the one signed cell's minus reaches this container's text layer as a
    // Private Use glyph that splits an RTL cell's digits (test 15's known artefact; payslips.test.ts says the same).
    // The zero cell (an employer share's 0.00 to net) is left out of the Arabic comparison: in an RTL row some Chromium
    // builds' text layers split its digits, while every non-zero figure survives whole (CI's Chromium, PR #17).
    const nonZero = (t: string): string[] => amounts8d(t).filter((a) => a !== "0.00");
    expect(nonZero(en).length).toBeGreaterThan(0);
    expect(nonZero(ar)).toEqual(nonZero(en));
  });

  it("both directions come from ONE definition per code — there is no second Arabic file, and no label falls back", () => {
    const files = readdirSync(HR_CATALOGUE_DIR).filter((n) => n.endsWith(".json"));
    expect(files.filter((n) => /[-_]ar\b|[-_]ar\./.test(n))).toEqual([]);
    expect(files.toSorted()).toEqual(HR_CATALOGUE.map((c) => `${c}.json`).toSorted());
    for (const code of HR_CATALOGUE) {
      const d = readHrDefinition(code);
      expect(d.nameAr.trim(), `${code}.nameAr`).not.toBe("");
      expect(d.nameAr, `${code}.nameAr`).not.toBe(d.nameEn);
      for (const c of d.columns) {
        expect(c.labelEn.trim(), `${code}.${c.field}.labelEn`).not.toBe("");
        expect(c.labelAr.trim(), `${code}.${c.field}.labelAr`).not.toBe("");
        expect(c.labelAr, `${code}.${c.field}.labelAr`).not.toBe(c.labelEn);
      }
    }
  });
});
