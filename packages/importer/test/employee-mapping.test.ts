import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { FixtureLegacyDriver, type LegacyCorpus } from "../src/drivers/fixture";
import type { LegacyRow } from "../src/legacy/types";
import { createReader } from "../src/reader";
import { RECONCILIATION_KINDS, reconcile } from "../src/reconcile";
import { EMPLOYEE_MATCH_STRATEGIES, normaliseLegacyName } from "../src/reconcile/employee-mapping";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

/** The base corpus with EMPLOYEES and ACCOUNTS rows appended. */
function grown(employees: LegacyRow[], accounts: LegacyRow[]): LegacyCorpus {
  const corpus = loadCorpus();
  const hr = corpus.tables.EMPLOYEES!;
  const acc = corpus.tables.ACCOUNTS!;
  return {
    ...corpus,
    tables: {
      ...corpus.tables,
      EMPLOYEES: { ...hr, rows: [...hr.rows, ...employees] },
      ACCOUNTS: { ...acc, rows: [...acc.rows, ...accounts] },
    },
  };
}

const employee = (id: string, name: string, account: string | null): LegacyRow => ({
  SITE: "1",
  ID: id,
  NAME: name,
  ACCOUNT: account,
  ORGANIC: "1",
});
const account = (id: string, name: string, flagged = "1"): LegacyRow => ({
  SITE: "1",
  ID: id,
  CODE: ["9", id].join(""),
  NAME: name,
  ISEMPLOYEE: flagged,
});

/** Every name the base corpus holds, in either table — none may reach the console (ADR 0083). */
const NAMES = ["Ali Hassan", "أحمد", "احمد", "Siti Nurhaliza", "Ravi Kumar"];

function captured(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

describe("normaliseLegacyName — the name match is a hypothesis, so its rule is testable in isolation", () => {
  it("collapses padding and doubled spaces, and upper-cases the Latin script", () => {
    expect(normaliseLegacyName("  Ali   Hassan ")).toBe("ALI HASSAN");
  });

  it("folds the Arabic forms a data-entry operator uses interchangeably", () => {
    expect(normaliseLegacyName("  أحمد   سعيد ")).toBe(normaliseLegacyName("احمد سعيد"));
    expect(normaliseLegacyName("إبراهيم")).toBe(normaliseLegacyName("ابراهيم"));
    expect(normaliseLegacyName("مصطفىٰ")).toBe(normaliseLegacyName("مصطفي"));
    expect(normaliseLegacyName("فاطمة")).toBe(normaliseLegacyName("فاطمه"));
    expect(normaliseLegacyName("محمــــد")).toBe(normaliseLegacyName("محمد"));
    // A decomposed hamza (alef + U+0654) composes under NFC before the fold.
    expect(normaliseLegacyName("أحمد")).toBe(normaliseLegacyName("احمد"));
  });

  it("does not fold two genuinely different names together", () => {
    expect(normaliseLegacyName("Ali Hassan")).not.toBe(normaliseLegacyName("Ali Hussain"));
    // The invariant locale: a dotted i stays I wherever the extraction runs.
    expect(normaliseLegacyName("siti")).toBe("SITI");
  });
});

describe("reconcile employee_mapping — §5.1 #12", () => {
  it("reports every row exactly once, with the strategy that matched it", async () => {
    const report = await reconcile(await reader(), "employee_mapping");
    expect(report.kind).toBe("employee_mapping");
    expect(report.rows).toEqual([
      {
        employeeId: "1|5",
        employeeName: "Ali Hassan",
        declaredAccount: "1|12",
        accountId: "1|12",
        accountCode: "2100",
        accountName: "Ali Hassan",
        status: "matched_by_account",
        strategy: "account_column",
        confidence: "hypothesis",
      },
      {
        employeeId: "1|6",
        employeeName: "أحمد   سعيد",
        declaredAccount: null,
        accountId: "1|13",
        accountCode: "2101",
        accountName: "احمد سعيد",
        status: "matched_by_name",
        strategy: "normalised_name",
        confidence: "hypothesis",
      },
      {
        employeeId: "1|7",
        employeeName: "Siti Nurhaliza",
        declaredAccount: null,
        accountId: null,
        accountCode: null,
        accountName: null,
        status: "hr_only",
        strategy: null,
        confidence: null,
      },
      {
        employeeId: null,
        employeeName: null,
        declaredAccount: null,
        accountId: "1|14",
        accountCode: "2102",
        accountName: "Ravi Kumar",
        status: "account_only",
        strategy: null,
        confidence: null,
      },
    ]);
  });

  it("summarises the four outcomes as strings, and says what the owner must do with them", async () => {
    const report = await reconcile(await reader(), "employee_mapping");
    expect(report.summary).toEqual({
      hrRows: "3",
      accountRows: "3",
      matchedByAccount: "1",
      matchedByName: "1",
      hrOnly: "1",
      accountOnly: "1",
      ambiguousNames: "0",
      note: "Every unmatched row is a decision for the owner: 9B maps a matched pair to one party of kind employee plus one employee, and refuses to guess for the rest (§5.1 #12).",
    });
    expect(Object.values(report.summary).every((v) => typeof v === "string")).toBe(true);
  });

  it("declares both strategies as hypotheses — the link column is not in the spec or the dossier", () => {
    expect(EMPLOYEE_MATCH_STRATEGIES.map((s) => [s.id, s.confidence])).toEqual([
      ["account_column", "hypothesis"],
      ["normalised_name", "hypothesis"],
    ]);
    for (const strategy of EMPLOYEE_MATCH_STRATEGIES)
      expect(strategy.derivation.length).toBeGreaterThan(40);
  });

  it("reports two flagged accounts sharing one name as ambiguous, naming both, and picks neither", async () => {
    const corpus = grown([], [account("15", "Siti  Nurhaliza"), account("16", "SITI NURHALIZA")]);
    const report = await reconcile(
      await createReader(new FixtureLegacyDriver(corpus)),
      "employee_mapping",
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        employeeId: "1|7",
        accountId: "1|15 1|16",
        accountName: "Siti  Nurhaliza | SITI NURHALIZA",
        status: "ambiguous_name",
        strategy: "normalised_name",
      }),
    );
    // Neither candidate is claimed, so each is still an unmatched account the owner sees.
    expect(report.rows.filter((r) => r.status === "account_only").map((r) => r.accountId)).toEqual([
      "1|14",
      "1|15",
      "1|16",
    ]);
    expect(report.summary.ambiguousNames).toBe("1");
    expect(report.summary.hrOnly).toBe("0");
  });

  it("reports two HR rows normalising onto one account as ambiguous, as the strategy's derivation says", async () => {
    const corpus = grown(
      [employee("8", "ravi kumar", null), employee("9", "Ravi  Kumar", null)],
      [],
    );
    const report = await reconcile(
      await createReader(new FixtureLegacyDriver(corpus)),
      "employee_mapping",
    );
    const ravi = report.rows.filter((r) => r.employeeId === "1|8" || r.employeeId === "1|9");
    expect(ravi.map((r) => [r.employeeId, r.status, r.accountId])).toEqual([
      ["1|8", "ambiguous_name", "1|14"],
      ["1|9", "ambiguous_name", "1|14"],
    ]);
    expect(report.rows).toContainEqual(
      expect.objectContaining({ accountId: "1|14", status: "account_only" }),
    );
    expect(report.summary.ambiguousNames).toBe("2");
    expect(report.summary.matchedByName).toBe("1");
  });

  it("matches by the account column before any name, whatever the HR row order", async () => {
    // Employee 8 comes first and shares account 14's name; employee 9 declares account 14 outright. The declared
    // link wins, and employee 8 is left unmatched rather than taking the account by name.
    const corpus = grown([employee("8", "Ravi Kumar", null), employee("9", "R. Kumar", "14")], []);
    const report = await reconcile(
      await createReader(new FixtureLegacyDriver(corpus)),
      "employee_mapping",
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        employeeId: "1|9",
        accountId: "1|14",
        status: "matched_by_account",
      }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ employeeId: "1|8", accountId: null, status: "hr_only" }),
    );
  });

  it("keeps a declared account that is not flagged IsEmployee on the row, and never reads that account", async () => {
    // Employee 7 declares account 11 (Sales, not flagged). No match is invented and the link is not dropped.
    const corpus = loadCorpus();
    const hr = corpus.tables.EMPLOYEES!;
    const pointed = await createReader(
      new FixtureLegacyDriver({
        ...corpus,
        tables: {
          ...corpus.tables,
          EMPLOYEES: {
            ...hr,
            rows: hr.rows.map((r) => (r.ID === "7" ? { ...r, ACCOUNT: "11" } : r)),
          },
        },
      }),
    );
    const report = await reconcile(pointed, "employee_mapping");
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        employeeId: "1|7",
        declaredAccount: "1|11",
        accountId: null,
        accountName: null,
        status: "hr_only",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("Sales");
  });

  it("holds the counting invariants: every HR row and every flagged account lands in exactly one count", async () => {
    const corpus = grown(
      [employee("8", "ravi kumar", null), employee("9", "Ravi  Kumar", null)],
      [account("15", "Siti Nurhaliza"), account("16", "Siti Nurhaliza")],
    );
    const { summary } = await reconcile(
      await createReader(new FixtureLegacyDriver(corpus)),
      "employee_mapping",
    );
    const n = (k: string) => Number(summary[k]);
    expect(n("hrRows")).toBe(
      n("matchedByAccount") + n("matchedByName") + n("hrOnly") + n("ambiguousNames"),
    );
    expect(n("accountRows")).toBe(n("matchedByAccount") + n("matchedByName") + n("accountOnly"));
  });

  it("is empty-handed, not broken, for a customer who never used the Salaries module", async () => {
    const corpus = loadCorpus();
    const { EMPLOYEES: _, ...rest } = corpus.tables;
    const report = await reconcile(
      await createReader(new FixtureLegacyDriver({ ...corpus, tables: rest })),
      "employee_mapping",
    );
    expect(report.summary.hrRows).toBe("0");
    expect(report.summary.accountOnly).toBe("3");
  });

  it("has an implementation for all six kinds now, so the dispatcher needs no fallback", async () => {
    expect(RECONCILIATION_KINDS).toHaveLength(6);
    for (const kind of RECONCILIATION_KINDS) {
      expect((await reconcile(await reader(), kind)).kind).toBe(kind);
    }
  });
});

describe("bun run legacy reconcile — the employee artefact and the console (ADR 0083)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes every kind under --kind all, prints counts only, and keeps names in the artefact", async () => {
    const out = mkdtempSync(join(tmpdir(), "dulja-9a-t11-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["reconcile", "--fixture", "base", "--out", out])).toBe(0);
    const printed = captured(log);
    expect(printed).toContain(
      "employee_mapping : 4 findings — hrRows=3 accountRows=3 matchedByAccount=1 matchedByName=1 hrOnly=1 accountOnly=1 ambiguousNames=0",
    );
    for (const name of NAMES) expect(printed).not.toContain(name);
    expect(captured(error)).toBe("");
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as {
      artefacts: { name: string }[];
    };
    expect(index.artefacts.map((a) => a.name)).toEqual([
      ...RECONCILIATION_KINDS.flatMap((k) => [[k, "json"].join("."), [k, "csv"].join(".")]),
      "index.json",
    ]);
    // The owner decides each unmatched row by name, so the artefact (git-ignored, ADR 0083) carries them.
    expect(readFileSync(join(out, "employee_mapping.csv"), "utf8")).toContain("Siti Nurhaliza");
  });

  it("refuses an unknown --kind before opening the source, naming the six", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["reconcile", "--kind", "employees", "--fixture", "base"])).toBe(2);
    expect(captured(error)).toBe(
      "config: unknown --kind employees — expected all or one of aggregate_drift, unbalanced_vouchers, orphans, null_poison, duplicate_aggregates, employee_mapping",
    );
  });
});
