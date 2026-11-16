import { describe, expect, it } from "vitest";
import {
  answerOpenQuestions,
  CONSTRAINT_CLAIMS,
  SALARIES_LIVENESS_TABLES,
} from "../src/catalogue/questions";
import { FixtureLegacyDriver, type LegacyCorpus } from "../src/drivers/fixture";
import { OdbcLegacyDriver } from "../src/drivers/odbc";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const probe = async (corpus: LegacyCorpus) => {
  const driver = new FixtureLegacyDriver(corpus, "questions corpus");
  return answerOpenQuestions(await createReader(driver), driver);
};
const report = () => probe(loadCorpus("questions"));

describe("LegacyDriver.constraints — what the engine declares (Part VII #6)", () => {
  it("returns a corpus's declared constraints and synthesises the PRIMARY KEY its key columns imply", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus("questions"));
    expect(await driver.constraints("ACCOUNTS")).toEqual([
      {
        table: "ACCOUNTS",
        name: "PK_ACCOUNTS",
        kind: "PRIMARY KEY",
        columns: ["SITE", "ID"],
        referencedTable: null,
      },
    ]);
    expect(await driver.constraints("MATUNITS")).toEqual([
      {
        table: "MATUNITS",
        name: "PK_MATUNITS",
        kind: "PRIMARY KEY",
        columns: ["SITE", "ID", "UNIT"],
        referencedTable: null,
      },
    ]);
    expect(await driver.constraints("MATOBJECTS")).toEqual([]);
    await expect(driver.constraints("NOSUCH")).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
  });

  it("reads RDB$RELATION_CONSTRAINTS live with the table bound, grouping index segments per constraint", async () => {
    const asked: { text: string; params: readonly unknown[] }[] = [];
    const conn = {
      query(text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
        asked.push({ text, params });
        return Promise.resolve([
          { CN: "PK_BILLITEMS", CT: "PRIMARY KEY", FN: "SITE", RT: "" },
          { CN: "PK_BILLITEMS", CT: "PRIMARY KEY", FN: "ID", RT: "" },
          { CN: "FK_BILLITEMS_BILLS", CT: "FOREIGN KEY", FN: "BILL", RT: "BILLS" },
          { CN: "CHK_QTY", CT: "CHECK", FN: null, RT: "" },
          { CN: "INTEG_7", CT: "NOT NULL", FN: null, RT: "" },
        ]);
      },
      close: () => Promise.resolve(),
    };
    const driver = new OdbcLegacyDriver(conn, "DSN=x");
    expect(await driver.constraints("BILLITEMS")).toEqual([
      {
        table: "BILLITEMS",
        name: "PK_BILLITEMS",
        kind: "PRIMARY KEY",
        columns: ["SITE", "ID"],
        referencedTable: null,
      },
      {
        table: "BILLITEMS",
        name: "FK_BILLITEMS_BILLS",
        kind: "FOREIGN KEY",
        columns: ["BILL"],
        referencedTable: "BILLS",
      },
      { table: "BILLITEMS", name: "CHK_QTY", kind: "CHECK", columns: [], referencedTable: null },
      { table: "BILLITEMS", name: "INTEG_7", kind: "other", columns: [], referencedTable: null },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text.startsWith("select ")).toBe(true);
    expect(asked[0]?.text).toContain("rdb$relation_constraints");
    expect(asked[0]?.params).toEqual(["BILLITEMS"]);
  });
});

describe("answerOpenQuestions — OD-27, and it decides nothing", () => {
  it("answers all five questions and no others, in spec order", async () => {
    const r = await report();
    expect(r.answers.map((a) => a.id)).toEqual(["VII-6", "VII-7", "VII-8", "VII-9", "VII-13"]);
    expect(r.answers.map((a) => a.specLine)).toEqual([2470, 2471, 2472, 2473, 2477]);
  });

  it("leaves every verdict null and names the owner decision on every answer (hazard 7)", async () => {
    for (const answer of (await report()).answers) {
      expect(answer.verdict).toBeNull();
      expect(answer.ownerDecision).toBe("OD-27");
    }
  });

  it("#6 reports what the engine declares against each of the five claims", async () => {
    const six = (await report()).answers.find((a) => a.id === "VII-6");
    expect(six?.status).toBe("evidence_collected");
    expect(six?.evidence).toEqual([
      {
        legacyDefect: "LEGACY-024",
        table: "ACCOUNTS",
        columns: "CODE",
        declared: "PRIMARY KEY(SITE,ID)",
        finding:
          "no UNIQUE on CODE; 1 sibling groups contain codes a lexicographic max() would mis-order; codes are not zero-padded",
        claim: "Account codes are allocated with max() on a string, without locking (spec:425)",
      },
      {
        legacyDefect: "LEGACY-049",
        table: "MATOBJECTS",
        columns: "SITE,ID",
        declared: "none",
        finding: "no PRIMARY KEY and no UNIQUE; 1 natural key occurs more than once",
        claim:
          "Aggregate tables have no unique key, so the upsert race creates duplicates (spec:630)",
      },
      {
        legacyDefect: "LEGACY-051",
        table: "BILLS",
        columns: "NUMBER",
        declared: "table absent from this source",
        finding: "cannot be checked here",
        claim: "Document numbering has no uniqueness constraint (spec:647)",
      },
      {
        legacyDefect: "LEGACY-066",
        table: "MATUNITS",
        columns: "EXCHANGE",
        declared: "PRIMARY KEY(SITE,ID,UNIT)",
        finding: "EXCHANGE is declared float",
        claim: "Unit conversion is defined in the schema and applied nowhere (spec:736)",
      },
      // "declare", not "declares": the sentence is built from a count that is usually greater than one.
      {
        legacyDefect: "LEGACY-074",
        table: "*",
        columns: "",
        declared: "10 tables read",
        finding: "1 of 10 tables declare no PRIMARY KEY: MATOBJECTS",
        claim: "42 of 460 tables have no primary key (spec:831)",
      },
    ]);
  });

  it("#7 quantifies MatOpens.Job rather than asserting LEGACY-022", async () => {
    const seven = (await report()).answers.find((a) => a.id === "VII-7");
    expect(seven?.evidence).toEqual([
      { table: "MATOPENS", rows: "2", jobNonZero: "1", distinctJobs: "1" },
    ]);
    expect(seven?.finding).toBe(
      "MatOpens.Job differs from 0 on 1 of 2 rows, so LEGACY-022's singleton SELECT ... INTO is a hard failure on this data, not inert.",
    );
  });

  it("#8 reports template evidence and refuses to call presence usage", async () => {
    const eight = (await report()).answers.find((a) => a.id === "VII-8");
    expect(eight?.evidence).toEqual([
      {
        table: "REPORTS",
        rows: "3",
        withDefinition: "2",
        empty: "1",
        distinctOwners: "2",
        customisations: "1",
      },
    ]);
    expect(eight?.finding).toContain("presence is not usage");
  });

  it("#9 counts every Special-module table and the customisation templates", async () => {
    const nine = (await report()).answers.find((a) => a.id === "VII-9");
    expect(nine?.evidence).toEqual([
      { source: "Special module tables", present: "1", withRows: "0", detail: "SPRORDERS=0" },
      {
        source: "customisation report templates",
        present: "1",
        withRows: "1",
        detail: "sprAccTargets",
      },
    ]);
  });

  it("#13 counts the five tables the spec names, and says LENDS is not in the shipped map", async () => {
    const thirteen = (await report()).answers.find((a) => a.id === "VII-13");
    expect(SALARIES_LIVENESS_TABLES).toEqual([
      "EMPLOYEES",
      "PAYROLLS",
      "PAYITEMS",
      "LENDS",
      "TAXLAYERS",
    ]);
    expect(thirteen?.evidence).toEqual([
      { table: "EMPLOYEES", rows: "1", note: "" },
      { table: "PAYROLLS", rows: "1", note: "" },
      { table: "PAYITEMS", rows: "1", note: "" },
      {
        table: "LENDS",
        rows: "",
        note: "absent from this source and from the 460-table shipped map; the dossier names it in prose only (analysis §4.5)",
      },
      { table: "TAXLAYERS", rows: "0", note: "" },
    ]);
    expect(thirteen?.finding).toBe(
      "The Salaries module has rows in 3 of the 5 tables the spec names, so it is in live use; §5.1 #11's default stands — 9B imports the employee master and current-tax-year YTD and never TaxLayers.",
    );
  });

  it("declares one claim per Part VII #6 defect and no more", () => {
    expect(CONSTRAINT_CLAIMS.map((c) => c.legacyDefect)).toEqual([
      "LEGACY-024",
      "LEGACY-049",
      "LEGACY-051",
      "LEGACY-066",
      "LEGACY-074",
    ]);
  });
});

describe("answerOpenQuestions against a source that cannot answer — it says so, and never aborts", () => {
  it("runs over the base corpus, where MATOPENS is absent and ACCOUNTS has no PARENT", async () => {
    const r = await probe(loadCorpus());
    const byId = new Map(r.answers.map((a) => [a.id, a]));
    expect(byId.get("VII-6")?.evidence[0]).toMatchObject({
      legacyDefect: "LEGACY-024",
      finding: "column PARENT is not declared on this table; cannot be checked here",
    });
    expect(byId.get("VII-7")?.status).toBe("unanswerable_here");
    expect(byId.get("VII-8")?.status).toBe("evidence_collected");
    for (const answer of r.answers) expect(answer.verdict).toBeNull();
  });

  it("answers #8 unanswerable_here, with the reason, when REPORTS has no blob column or is absent", async () => {
    const corpus = loadCorpus("questions");
    const reports = corpus.tables.REPORTS;
    if (!reports) throw new Error("the questions corpus lost REPORTS");
    const noBlob = {
      ...corpus,
      tables: {
        ...corpus.tables,
        REPORTS: { ...reports, columns: reports.columns.filter((c) => c.kind !== "blob") },
      },
    };
    const eight = (await probe(noBlob)).answers.find((a) => a.id === "VII-8");
    expect(eight).toMatchObject({ status: "unanswerable_here", evidence: [] });
    expect(eight?.finding).toContain("REPORTS declares no blob column");

    const { REPORTS: _dropped, ...rest } = corpus.tables;
    const absent = (await probe({ ...corpus, tables: rest })).answers;
    expect(absent.find((a) => a.id === "VII-8")?.status).toBe("unanswerable_here");
    expect(absent.find((a) => a.id === "VII-9")?.evidence[1]).toMatchObject({
      source: "customisation report templates",
      present: "0",
    });
  });
});
