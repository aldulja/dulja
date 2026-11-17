import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter } from "../src/artefacts";
import {
  catalogueTemplates,
  classifyTemplate,
  templateColumns,
  templateStem,
} from "../src/catalogue/templates";
import { FixtureLegacyDriver, type LegacyCorpus } from "../src/drivers/fixture";
import { loadCorpus } from "./support/corpus";

const run = () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-9a-tpl-"));
  const writer = new ReportWriter(dir, { source: "fixture corpus", engineVersion: "Firebird 2.5" });
  return { dir, writer, driver: new FixtureLegacyDriver(loadCorpus()) };
};

/** A corpus whose only table is `REPORTS` with the given rows — for the cases the base corpus does not hold. */
const reportsOnly = (rows: Record<string, string | null>[]): LegacyCorpus => ({
  engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
  tables: {
    REPORTS: {
      keyColumns: ["ID"],
      columns: [
        { name: "ID", kind: "integer", scale: 0, nullable: false },
        { name: "NAME", kind: "text", scale: 0, nullable: true },
        { name: "USERNAME", kind: "text", scale: 0, nullable: true },
        { name: "DEFINITION", kind: "blob", scale: 0, nullable: true },
      ],
      rows,
    },
  },
});

describe("classifyTemplate — the dossier's §4.4 grouping, applied by rule not by list", () => {
  it("groups the names the dossier names", () => {
    expect(classifyTemplate("AccBalances")).toEqual({ group: "accounts", customisation: false });
    expect(classifyTemplate("BalanceSheets")).toEqual({ group: "accounts", customisation: false });
    expect(classifyTemplate("MatProfits")).toEqual({ group: "materials", customisation: false });
    expect(classifyTemplate("Inventory1")).toEqual({ group: "materials", customisation: false });
    expect(classifyTemplate("Tax.BillSaleForm")).toEqual({
      group: "documents",
      customisation: false,
    });
    expect(classifyTemplate("GstListingReport")).toEqual({ group: "tax", customisation: false });
    expect(classifyTemplate("hsprVisits")).toEqual({ group: "hospital", customisation: false });
    expect(classifyTemplate("StudentGradesRep")).toEqual({
      group: "academy",
      customisation: false,
    });
    expect(classifyTemplate("AstDepreciation")).toEqual({
      group: "fixed_assets",
      customisation: false,
    });
    expect(classifyTemplate("SalaryRep")).toEqual({ group: "payroll", customisation: false });
    expect(classifyTemplate("SrvMotion")).toEqual({ group: "services", customisation: false });
  });

  it("flags the customer-specific prefixes as customisations (Part VII #9)", () => {
    expect(classifyTemplate("sprAccTargets")).toEqual({
      group: "customisation",
      customisation: true,
    });
    expect(classifyTemplate("rahStockCalc")).toEqual({
      group: "customisation",
      customisation: true,
    });
    expect(classifyTemplate("repdntProfits")).toEqual({
      group: "customisation",
      customisation: true,
    });
  });

  it("says unknown rather than guessing", () => {
    expect(classifyTemplate("Zebra")).toEqual({ group: "unknown", customisation: false });
  });
});

describe("templateStem — the near-duplicate rule, checked against the dossier's own examples", () => {
  it("collapses the three families §7.10 names", () => {
    expect(templateStem("2.VouEntiers")).toBe(templateStem("VouEntiers"));
    expect(templateStem("AccMovementHorizontal")).toBe(templateStem("AccMovement"));
    expect(templateStem("AccMovementInfo")).toBe(templateStem("AccMovement"));
    expect(templateStem("BatchBalances_n")).toBe(templateStem("BatchBalances"));
  });

  it("keeps two unrelated names apart", () => {
    expect(templateStem("AccLedger")).not.toBe(templateStem("AccBalances"));
  });
});

describe("catalogueTemplates — §5.1 #9 / LEGACY-077", () => {
  it("writes every blob out byte-for-byte and hashes what it wrote", async () => {
    const { dir, writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);

    const acc = catalogue.entries.find((e) => e.name === "AccMovement");
    expect(acc).toMatchObject({
      owner: "SYSDBA",
      bytes: 9,
      group: "accounts",
      customisation: false,
      file: "templates/AccMovement.report",
      empty: false,
      nearDuplicateOf: "AccMovementHorizontal",
    });
    const written = readFileSync(join(dir, "templates", "AccMovement.report"));
    expect(written.toString("base64")).toBe("VER1/+AAECAw");
    expect(acc?.sha256).toBe(createHash("sha256").update(written).digest("hex"));
  });

  it("records a row whose blob is null as empty and writes no file for it", async () => {
    const { writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);
    expect(catalogue.entries.find((e) => e.name === "MatBalances")).toMatchObject({
      empty: true,
      bytes: 0,
      file: "",
      sha256: "",
      owner: null,
      group: "materials",
    });
  });

  it("discovers the name, owner and blob columns rather than assuming them", async () => {
    const { writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);
    expect(catalogue).toMatchObject({
      table: "REPORTS",
      nameColumn: "NAME",
      ownerColumn: "USERNAME",
      blobColumn: "DEFINITION",
      shippedCountFromDossier: 255,
    });
    expect(catalogue.byGroup).toEqual({
      accounts: 2,
      materials: 1,
      documents: 1,
      payroll: 0,
      hospital: 0,
      academy: 0,
      services: 0,
      fixed_assets: 0,
      tax: 0,
      customisation: 1,
      unknown: 0,
    });
    expect(await templateColumns(driver)).toEqual({
      table: "REPORTS",
      nameColumn: "NAME",
      ownerColumn: "USERNAME",
      blobColumn: "DEFINITION",
    });
  });

  it("refuses rather than reporting an empty catalogue when the table has no blob column", async () => {
    const corpus = loadCorpus();
    const stripped = {
      ...corpus,
      tables: {
        ...corpus.tables,
        REPORTS: {
          rows: corpus.tables.REPORTS?.rows ?? [],
          keyColumns: corpus.tables.REPORTS?.keyColumns ?? [],
          columns: (corpus.tables.REPORTS?.columns ?? []).filter((c) => c.kind !== "blob"),
        },
      },
    };
    const { writer } = run();
    await expect(catalogueTemplates(new FixtureLegacyDriver(stripped), writer)).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: REPORTS declares no blob column; report definitions cannot be extracted/,
    );
  });

  it("refuses when the source has no REPORTS table at all", async () => {
    const corpus = loadCorpus();
    const { REPORTS: _dropped, ...rest } = corpus.tables;
    const { writer } = run();
    await expect(
      catalogueTemplates(new FixtureLegacyDriver({ ...corpus, tables: rest }), writer),
    ).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE: REPORTS is not a table of this source/);
  });

  it("gives two per-user copies of one name two files, even where only the case differs", async () => {
    // "per-user report definitions are stored in System.Reports" (analysis §4.4): one template name can occur
    // once per user, and Windows — where the owner runs this — folds case in a file name. Without a distinct
    // file per row the second blob would overwrite the first while the catalogue still hashed both.
    const { dir, writer } = run();
    const driver = new FixtureLegacyDriver(
      reportsOnly([
        { ID: "1", NAME: "AccMovement", USERNAME: "SYSDBA", DEFINITION: "VER1/+AAECAw" },
        { ID: "2", NAME: "AccMovement", USERNAME: "ahmad", DEFINITION: "VER1/+AAECBA" },
        { ID: "3", NAME: "accmovement", USERNAME: "sara", DEFINITION: "VER1/+AAECBQ" },
      ]),
    );
    const catalogue = await catalogueTemplates(driver, writer);
    expect(catalogue.entries.map((e) => e.file)).toEqual([
      "templates/AccMovement.report",
      "templates/AccMovement~2.report",
      "templates/accmovement~3.report",
    ]);
    for (const entry of catalogue.entries) {
      const written = readFileSync(join(dir, entry.file));
      expect(createHash("sha256").update(written).digest("hex")).toBe(entry.sha256);
    }
    // An identical name is the strongest near-duplicate there is, so each copy points at another.
    expect(catalogue.entries.map((e) => e.nearDuplicateOf)).toEqual([
      "AccMovement",
      "AccMovement",
      "AccMovement",
    ]);
  });

  it("never writes a file name Windows reserves or one built from the legacy name's separators", async () => {
    const { writer } = run();
    const driver = new FixtureLegacyDriver(
      reportsOnly([
        { ID: "1", NAME: "CON", USERNAME: null, DEFINITION: "VER1/+AAECAw" },
        { ID: "2", NAME: "../../etc/passwd", USERNAME: null, DEFINITION: "VER1/+AAECBA" },
        { ID: "3", NAME: "تقرير", USERNAME: null, DEFINITION: "VER1/+AAECBQ" },
      ]),
    );
    const files = (await catalogueTemplates(driver, writer)).entries.map((e) => e.file);
    expect(files[0]).toBe("templates/CON_.report");
    expect(files[1]).toBe("templates/etc_passwd.report");
    expect(files[2]).toMatch(/^templates\/unnamed-[0-9a-f]{12}\.report$/);
  });
});
