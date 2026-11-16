import { classifyTemplate, locateTemplates } from "./templates";
import { ALL_LEGACY_TABLES, LEGACY_MODULES } from "../legacy/modules";
import type { LegacyConstraint, LegacyDriver, LegacyScalar } from "../legacy/types";
import type { LegacyReader } from "../reader";

export type QuestionId = "VII-6" | "VII-7" | "VII-8" | "VII-9" | "VII-13";
export type QuestionStatus = "evidence_collected" | "unanswerable_here";

export interface OpenQuestionAnswer {
  readonly id: QuestionId;
  /** The spec's question, verbatim. */
  readonly question: string;
  readonly specLine: number;
  readonly status: QuestionStatus;
  readonly evidence: readonly Record<string, string>[];
  readonly finding: string;
  readonly ownerDecision: "OD-27";
  /** This probe decides nothing (contracts hazard 7): the answer is the owner's, recorded against OD-27. */
  readonly verdict: null;
}

export interface OpenQuestionReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly engineVersion: string;
  readonly answers: readonly OpenQuestionAnswer[];
}

export interface ConstraintClaim {
  readonly sah: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly claim: string;
  readonly confirmedBy: "absent_unique" | "declared_type" | "absent_primary_key" | "code_shape";
}

type Row = Record<string, LegacyScalar>;

/**
 * Part VII #6, verbatim (spec:2470): "Several findings (SAH-024, 049, 051, 066, 074) rest on the schema dump's
 * key convention rather than real DDL. Confirm against RDB$RELATION_CONSTRAINTS and RDB$INDICES before rating
 * them." One row per named defect, in the spec's own order. `confirmedBy` says what would confirm the claim,
 * so the artefact is falsifiable rather than rhetorical.
 */
export const CONSTRAINT_CLAIMS: readonly ConstraintClaim[] = [
  {
    sah: "SAH-024",
    table: "ACCOUNTS",
    columns: ["CODE"],
    confirmedBy: "code_shape",
    claim: "Account codes are allocated with max() on a string, without locking (spec:425)",
  },
  {
    sah: "SAH-049",
    table: "MATOBJECTS",
    columns: ["SITE", "ID"],
    confirmedBy: "absent_unique",
    claim: "Aggregate tables have no unique key, so the upsert race creates duplicates (spec:630)",
  },
  {
    sah: "SAH-051",
    table: "BILLS",
    columns: ["NUMBER"],
    confirmedBy: "absent_unique",
    claim: "Document numbering has no uniqueness constraint (spec:647)",
  },
  {
    sah: "SAH-066",
    table: "MATUNITS",
    columns: ["EXCHANGE"],
    confirmedBy: "declared_type",
    claim: "Unit conversion is defined in the schema and applied nowhere (spec:736)",
  },
  {
    sah: "SAH-074",
    table: "*",
    columns: [],
    confirmedBy: "absent_primary_key",
    claim: "42 of 460 tables have no primary key (spec:831)",
  },
];

/**
 * Part VII #13, verbatim (spec:2477): "Row counts on `Employees`, `Payrolls`, `PayItems`, `Lends`,
 * `TaxLayers`." The five names are the spec's, in the spec's order. **`LENDS` is deliberately not in
 * `LEGACY_MODULES`' Salaries list**: the dossier's Appendix A inventory of 36 Salaries tables does not contain
 * it and the per-module totals that sum to 460 depend on that list being exactly the inventory. It appears
 * only in the dossier's prose ("advances (`Lends` in UI units)", analysis §4.5). The probe therefore reports
 * it as absent from the map rather than counting it, and **no task adds it to the 460**.
 */
export const SALARIES_LIVENESS_TABLES: readonly string[] = [
  "EMPLOYEES",
  "PAYROLLS",
  "PAYITEMS",
  "LENDS",
  "TAXLAYERS",
];

const QUESTIONS: Readonly<Record<QuestionId, { line: number; text: string }>> = {
  "VII-6": {
    line: 2470,
    text: "Actual DDL constraints. Several findings (SAH-024, 049, 051, 066, 074) rest on the schema dump's key convention rather than real DDL. Confirm against RDB$RELATION_CONSTRAINTS and RDB$INDICES before rating them.",
  },
  "VII-7": {
    line: 2471,
    text: "Does MatOpens.Job ever differ from 0 in production? SAH-022 is a hard failure if so, and inert if not.",
  },
  "VII-8": {
    line: 2472,
    text: "Which of the 255 report templates are in use? They live as blobs in the customer database; extract and catalogue them.",
  },
  "VII-9": {
    line: 2473,
    text: "Customisations. The Special, rah* and spr* modules are customer-specific. Catalogue them before assuming the stock feature set.",
  },
  "VII-13": {
    line: 2477,
    text: "Is the legacy Salaries module in live use? Row counts on Employees, Payrolls, PayItems, Lends, TaxLayers. Determines whether Phase 9 imports only the employee master and current-year YTD (the default) or also historical payroll detail for viewing.",
  },
};

/** A read batch for the probes: they scan whole tables, and a page this size keeps each round trip modest. */
const BATCH = 500;

/**
 * OD-27 (contracts §2.12, ⚠️): the evidence for Part VII #6, #7, #8, #9 and #13, and no answer. Every
 * `verdict` is null and every answer names OD-27 as the decider; a question this source cannot answer is
 * `unanswerable_here`, never a guess. Takes the driver beside the reader because #6 needs the declared
 * constraints and #8 the declared blob column, neither of which §4.13.1's `LegacyReader` carries.
 */
export async function answerOpenQuestions(
  reader: LegacyReader,
  driver: LegacyDriver,
): Promise<OpenQuestionReport> {
  const present = new Set(await reader.tables());
  const answers: OpenQuestionAnswer[] = [
    await sixDdlConstraints(reader, driver, present),
    await sevenMatOpensJob(reader, present),
    await eightTemplates(reader, driver, present),
    await nineCustomisations(reader, driver, present),
    await thirteenSalaries(reader, present),
  ];
  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source,
    engineVersion: reader.firebirdVersion,
    answers,
  };
}

function answer(
  id: QuestionId,
  evidence: Record<string, string>[],
  finding: string,
  status: QuestionStatus = "evidence_collected",
): OpenQuestionAnswer {
  return {
    id,
    question: QUESTIONS[id].text,
    specLine: QUESTIONS[id].line,
    status,
    evidence,
    finding,
    ownerDecision: "OD-27",
    verdict: null,
  };
}

function declaredOf(constraints: readonly LegacyConstraint[]): string {
  const parts = constraints
    .filter((c) => c.kind === "PRIMARY KEY" || c.kind === "UNIQUE")
    .map((c) => [c.kind, "(", c.columns.join(","), ")"].join(""));
  return parts.length > 0 ? parts.join(" ") : "none";
}

function text(value: LegacyScalar | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

async function sixDdlConstraints(
  reader: LegacyReader,
  driver: LegacyDriver,
  present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  const evidence: Record<string, string>[] = [];
  for (const claim of CONSTRAINT_CLAIMS) {
    const base = {
      sah: claim.sah,
      table: claim.table,
      columns: claim.columns.join(","),
      claim: claim.claim,
    };

    if (claim.confirmedBy === "absent_primary_key") {
      const tables = [...present].toSorted();
      const without: string[] = [];
      for (const table of tables)
        if ((await driver.keyColumns(table)).length === 0) without.push(table);
      evidence.push({
        ...base,
        declared: [String(tables.length), "tables read"].join(" "),
        finding: [
          String(without.length),
          "of",
          String(tables.length),
          "tables declare no PRIMARY KEY:",
          without.join(", ") || "(none)",
        ].join(" "),
      });
      continue;
    }
    if (!present.has(claim.table)) {
      evidence.push({
        ...base,
        declared: "table absent from this source",
        finding: "cannot be checked here",
      });
      continue;
    }
    const constraints = await driver.constraints(claim.table);
    const declared = declaredOf(constraints);
    const columns = await driver.columns(claim.table);

    // A source that has the table but not the column is the common case, not an error: this probe runs against
    // whatever the customer's database holds, and the synthetic base corpus holds ACCOUNTS without PARENT.
    // Reading a column the catalogue does not declare would raise ERR_IMPORT_SOURCE_UNREADABLE and abort the
    // whole run over one unanswerable claim, so it is checked first.
    const names = new Set(columns.map((c) => c.name));
    const needed =
      claim.confirmedBy === "code_shape" ? ["PARENT", ...claim.columns] : [...claim.columns];
    const missing = needed.filter((c) => !names.has(c));
    if (missing.length > 0) {
      evidence.push({
        ...base,
        declared,
        finding: [
          "column",
          missing.join(", "),
          missing.length === 1 ? "is" : "are",
          "not declared on this table; cannot be checked here",
        ].join(" "),
      });
      continue;
    }

    if (claim.confirmedBy === "declared_type") {
      const column = columns.find((c) => c.name === claim.columns[0]);
      evidence.push({
        ...base,
        declared,
        finding: [claim.columns[0] ?? "", "is declared", column?.kind ?? "unknown"].join(" "),
      });
      continue;
    }
    if (claim.confirmedBy === "code_shape") {
      const siblings = new Map<string, string[]>();
      for await (const batch of reader.read<Row>(claim.table, {
        columns: ["PARENT", "CODE"],
        batch: BATCH,
      })) {
        for (const row of batch) {
          const parent = text(row.PARENT);
          siblings.set(parent, [...(siblings.get(parent) ?? []), text(row.CODE)]);
        }
      }
      // A sibling group whose codes differ in width is one where `max()` on the string picks the wrong code
      // ('9' over '10') — SAH-024's collision. Equal widths throughout means the codes are zero-padded.
      const misordered = [...siblings.values()].filter(
        (codes) => new Set(codes.map((c) => c.length)).size > 1,
      ).length;
      const unique = constraints.some((c) => c.kind === "UNIQUE" && c.columns.includes("CODE"));
      evidence.push({
        ...base,
        declared,
        finding: [
          [unique ? "UNIQUE on CODE is declared" : "no UNIQUE on CODE", ";"].join(""),
          String(misordered),
          "sibling groups contain codes a lexicographic max() would mis-order; codes are",
          misordered === 0 ? "zero-padded" : "not zero-padded",
        ].join(" "),
      });
      continue;
    }
    const keyed = constraints.some((c) => c.kind === "PRIMARY KEY" || c.kind === "UNIQUE");
    const seen = new Map<string, number>();
    for await (const batch of reader.read<Row>(claim.table, {
      columns: [...claim.columns],
      batch: BATCH,
    })) {
      for (const row of batch) {
        const key = claim.columns.map((c) => text(row[c])).join("|");
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const duplicated = [...seen.values()].filter((n) => n > 1).length;
    evidence.push({
      ...base,
      declared,
      finding: [
        [keyed ? "a PRIMARY KEY or UNIQUE is declared" : "no PRIMARY KEY and no UNIQUE", ";"].join(
          "",
        ),
        String(duplicated),
        duplicated === 1 ? "natural key occurs" : "natural keys occur",
        "more than once",
      ].join(" "),
    });
  }
  return answer(
    "VII-6",
    evidence,
    "Each claim is reported against what the engine declares. Rating SAH-024, 049, 051, 066 and 074 — and un-skipping tests/regression/sah-024.test.ts, which 1A created marked it.skip pending this answer (contracts §3.7.3) — is the owner's and the architect's call, not this report's.",
  );
}

async function sevenMatOpensJob(
  reader: LegacyReader,
  present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  const table = "MATOPENS";
  if (!present.has(table)) {
    return answer(
      "VII-7",
      [{ table, rows: "", jobNonZero: "", distinctJobs: "" }],
      "MATOPENS is absent from this source, so the question cannot be answered here.",
      "unanswerable_here",
    );
  }
  const rows = await reader.count(table);
  const jobs = new Map<string, number>();
  for await (const batch of reader.read<Row>(table, { columns: ["JOB"], batch: BATCH })) {
    for (const row of batch) {
      const job = text(row.JOB);
      if (job === "" || job === "0") continue;
      jobs.set(job, (jobs.get(job) ?? 0) + 1);
    }
  }
  const nonZero = [...jobs.values()].reduce((a, b) => a + b, 0);
  return answer(
    "VII-7",
    [
      {
        table,
        rows: String(rows),
        jobNonZero: String(nonZero),
        distinctJobs: String(jobs.size),
      },
    ],
    nonZero > 0
      ? [
          "MatOpens.Job differs from 0 on",
          String(nonZero),
          "of",
          String(rows),
          "rows, so SAH-022's singleton SELECT ... INTO is a hard failure on this data, not inert.",
        ].join(" ")
      : [
          "MatOpens.Job is 0 or null on all",
          String(rows),
          "rows, so SAH-022 is inert on this data — which rates the defect and does not remove it from the new design.",
        ].join(" "),
  );
}

async function eightTemplates(
  reader: LegacyReader,
  driver: LegacyDriver,
  present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  if (!present.has("REPORTS")) {
    return answer(
      "VII-8",
      [],
      "REPORTS is absent from this source, so no template evidence exists here.",
      "unanswerable_here",
    );
  }
  const found = await locateTemplates(driver);
  if ("refused" in found)
    return answer(
      "VII-8",
      [],
      [found.refused, "— so no template evidence exists here."].join(" "),
      "unanswerable_here",
    );
  const { table, nameColumn, blobColumn, ownerColumn } = found;
  const rows = await reader.count(table);
  let withDefinition = 0;
  let customisations = 0;
  const owners = new Set<string>();
  const columns =
    ownerColumn === null ? [nameColumn, blobColumn] : [nameColumn, blobColumn, ownerColumn];
  for await (const batch of reader.read<Row>(table, { columns, batch: BATCH })) {
    for (const row of batch) {
      const definition = row[blobColumn];
      if (typeof definition === "string" && definition.length > 0) withDefinition += 1;
      if (ownerColumn !== null && row[ownerColumn] !== null && row[ownerColumn] !== undefined)
        owners.add(text(row[ownerColumn]).trim());
      if (classifyTemplate(text(row[nameColumn])).customisation) customisations += 1;
    }
  }
  return answer(
    "VII-8",
    [
      {
        table,
        rows: String(rows),
        withDefinition: String(withDefinition),
        empty: String(rows - withDefinition),
        distinctOwners: ownerColumn === null ? "" : String(owners.size),
        customisations: String(customisations),
      },
    ],
    "These are the definitions stored in this database; presence is not usage, and nothing here says a template was ever run. Run `legacy templates` for the per-template catalogue with hashes and the near-duplicate families.",
  );
}

async function nineCustomisations(
  reader: LegacyReader,
  driver: LegacyDriver,
  present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  const special = LEGACY_MODULES.find((m) => m.id === "special");
  const tables = (special?.tables ?? []).filter((t) => present.has(t));
  const counts: string[] = [];
  let withRows = 0;
  for (const table of tables) {
    const rows = await reader.count(table);
    if (rows > 0) withRows += 1;
    counts.push([table, String(rows)].join("="));
  }
  const templates: string[] = [];
  const found = present.has("REPORTS") ? await locateTemplates(driver) : null;
  if (found !== null && !("refused" in found)) {
    const { table, nameColumn } = found;
    for await (const batch of reader.read<Row>(table, { columns: [nameColumn], batch: BATCH })) {
      for (const row of batch) {
        const name = text(row[nameColumn]).trim();
        if (classifyTemplate(name).customisation) templates.push(name);
      }
    }
  }
  return answer(
    "VII-9",
    [
      {
        source: "Special module tables",
        present: String(tables.length),
        withRows: String(withRows),
        detail: counts.join(" "),
      },
      {
        source: "customisation report templates",
        present: String(templates.length),
        withRows: String(templates.length),
        detail: templates.join(" "),
      },
    ],
    "The Special module's tables and the spr*/rah*/dnt*/med* templates are the customer-specific surface (analysis §7.11). A table that ships with no rows is dead weight this rebuild need not carry; that judgement is the owner's.",
  );
}

async function thirteenSalaries(
  reader: LegacyReader,
  present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  const evidence: Record<string, string>[] = [];
  let live = 0;
  for (const table of SALARIES_LIVENESS_TABLES) {
    if (!present.has(table)) {
      evidence.push({
        table,
        rows: "",
        note: ALL_LEGACY_TABLES.has(table)
          ? "absent from this source but present in the 460-table shipped map"
          : "absent from this source and from the 460-table shipped map; the dossier names it in prose only (analysis §4.5)",
      });
      continue;
    }
    const rows = await reader.count(table);
    if (rows > 0) live += 1;
    evidence.push({ table, rows: String(rows), note: "" });
  }
  return answer(
    "VII-13",
    evidence,
    live > 0
      ? [
          "The Salaries module has rows in",
          String(live),
          "of the",
          String(SALARIES_LIVENESS_TABLES.length),
          "tables the spec names, so it is in live use; §5.1 #11's default stands — 9B imports the employee master and current-tax-year YTD and never TaxLayers.",
        ].join(" ")
      : "No table the spec names has a row, so the Salaries module is not in live use here; 9B's employee and YTD loaders have nothing to read and Phase 8 starts from an empty employee master.",
  );
}
