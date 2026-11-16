import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDatasetId } from "@dulja/db";
import {
  catalogueTemplates,
  FixtureLegacyDriver,
  ReportWriter,
  type LegacyCorpus,
} from "@dulja/importer";
import { CATALOGUE_7C } from "../invariants/support/reports-7c";
import { REPO_ROOT } from "../support/source";

describe("SAH-077 The call graph is unresolvable, so dead code cannot be identified — 7A", () => {
  // The defect: "report definitions are stored as MEMO blobs in the Reports table inside customer
  // databases, not as files … no static analysis can ever determine whether a procedure is live."
  // spec:1246 puts "Delphi-serialised report files" on the do-NOT-carry-over list; spec:1240 wants the
  // designer "text-defined, diffable, version-controlled". This block is the structural proof.

  it("the report format is a committed JSON Schema with a stable $id, not an opaque blob", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/domain/report-definition.schema.json"), "utf8"),
    );
    expect(schema.$id).toBe("urn:dulja:report-definition:1");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version).toEqual({ const: 1 });
    // additionalProperties: false at EVERY level is what makes an escape hatch impossible — without it a
    // `sqlOverride` or a serialised blob could ride along and SAH-077 would be back.
    const defs = Object.entries<{ additionalProperties?: boolean; type?: string }>(schema.$defs);
    expect(defs.length).toBeGreaterThan(0);
    for (const [name, def] of defs) {
      if (def.type === "object") expect(def.additionalProperties, name).toBe(false);
    }
  });

  it("every core definition is a version-controlled FILE whose name is its code", () => {
    const root = join(REPO_ROOT, "packages/db/seed/my/reports");
    const slices = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const slice of slices) {
      for (const file of readdirSync(join(root, slice.name)).filter((n) => n.endsWith(".json"))) {
        // §4.16.1's envelope: `{ definitionVersion, definition }`. The ROW version lives in the envelope and
        // never in the file name, so the name is always exactly `<definition.code>.json`.
        const where = `${slice.name}/${file}`;
        const body = JSON.parse(readFileSync(join(root, slice.name, file), "utf8")) as {
          definitionVersion: number;
          definition: { code: string; version: number };
        };
        expect(Object.keys(body).toSorted(), where).toEqual(["definition", "definitionVersion"]);
        expect(Number.isInteger(body.definitionVersion) && body.definitionVersion >= 1, where).toBe(
          true,
        );
        expect(body.definition.version, where).toBe(1); // the FORMAT version, always 1
        expect(file, where).toBe(`${body.definition.code}.json`);
      }
    }
    // 7A ships the directory and the loader and seeds nothing (§2.8); 7B, 7C and 8D fill their own
    // directories. The assertion holds at every phase because the rule is the file NAME, not the count.
    expect(readdirSync(root)).toContain("README.md");
  });

  it('a stored definition is reachable by SQL, so "which reports exist?" is a query and not an archaeology project', () => {
    const migration = readFileSync(
      join(REPO_ROOT, "packages/db/migrations/0074_create_report_definition.sql"),
      "utf8",
    );
    expect(migration).toMatch(/\bdefinition\s+jsonb not null/);
    expect(migration).toMatch(/\bcode\s+text not null/);
    // `Users.Permissions:MEMO` was the same defect on the authorisation side — "you cannot answer 'who can
    // do X?' in SQL". A jsonb column with a queryable `code` is the direct answer for reports.
    expect(migration).not.toMatch(/\bbytea\b/);
  });
});

const pathOf7C = (code: string) =>
  join(REPO_ROOT, "packages", "db", "seed", "my", "reports", "7c", `${code}.json`);
/** Every string value in a parsed JSON document, depth first. */
const stringsOf = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value !== null && typeof value === "object"
        ? Object.values(value).flatMap(stringsOf)
        : [];

describe("SAH-077 The call graph is unresolvable, so dead code cannot be identified — 7C", () => {
  it("all 7C report definitions are version-controlled, line-oriented text, not blobs (spec:1240)", () => {
    for (const code of CATALOGUE_7C) {
      const path = pathOf7C(code);
      const text = readFileSync(path, "utf8");
      expect(() => JSON.parse(text), path).not.toThrow();
      expect(
        text.endsWith("\n"),
        `${path} must end with a newline so a diff is line-oriented`,
      ).toBe(true);
      expect(text.split("\n").length, `${path} is one long line`).toBeGreaterThan(10);
    }
    // ⚠️ OD-09: the post-dated cheque register is not built, and no file pretends otherwise.
    expect(existsSync(pathOf7C("accounting.pdc_register"))).toBe(false);
  });

  it("no 7C definition carries SQL text — a registered dataset id is the only source (test 27)", () => {
    const sqlShaped = /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where)\b/i;
    for (const code of CATALOGUE_7C) {
      const { definition } = JSON.parse(readFileSync(pathOf7C(code), "utf8")) as {
        definition: { dataset: { source: string } };
      };
      expect(
        isDatasetId(definition.dataset.source),
        `${code} reads ${definition.dataset.source}`,
      ).toBe(true);
      for (const value of stringsOf(definition)) {
        expect(value, `${code} carries SQL-shaped text`).not.toMatch(sqlShaped);
        expect(value, `${code} carries a statement terminator`).not.toContain(";");
      }
    }
  });

  // ⚠️ OD-27: Plan 7C Task 12's legacy-template `it` is appended to THIS describe when 9A has run and the owner
  // has named the templates in use (docs/decisions/od-27-7c-template-mapping.md).
});

describe("SAH-077 The call graph is unresolvable, so dead code cannot be identified — 9A", () => {
  // A self-contained two-row corpus: packages/importer/test/support/corpus.ts is that package's own test
  // helper and is imported by no other workspace (plan 9A header, §4.17.1 "none added").
  const corpus: LegacyCorpus = {
    engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
    tables: {
      REPORTS: {
        keyColumns: ["ID"],
        columns: [
          { name: "ID", kind: "integer", scale: 0, nullable: false },
          { name: "NAME", kind: "text", scale: 0, nullable: true },
          { name: "DEFINITION", kind: "blob", scale: 0, nullable: true },
        ],
        rows: [
          { ID: "1", NAME: "AccMovement", DEFINITION: "VER1/+AAECAw" },
          { ID: "2", NAME: "AccMovementHorizontal", DEFINITION: "VER1/+AAECBA" },
        ],
      },
    },
  };

  it("makes the un-analysable blobs analysable: every definition comes out as a hashed file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sah-077-"));
    const writer = new ReportWriter(dir, {
      source: "regression corpus",
      engineVersion: "Firebird 2.5",
    });
    const catalogue = await catalogueTemplates(new FixtureLegacyDriver(corpus), writer);

    // The defect is that report definitions are opaque MEMO blobs inside the database, so nothing outside the
    // Dlux engine can see what exists or what duplicates what. Dulja's answer is not "parse the blob" — it is
    // "get every blob out of the database, name it, hash it, and say which names are near-duplicates".
    expect(catalogue.entries.map((e) => [e.name, e.bytes, e.file])).toEqual([
      ["AccMovement", 9, "templates/AccMovement.report"],
      ["AccMovementHorizontal", 9, "templates/AccMovementHorizontal.report"],
    ]);
    for (const entry of catalogue.entries) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.entries[0]?.nearDuplicateOf).toBe("AccMovementHorizontal");
    expect(catalogue.entries[1]?.nearDuplicateOf).toBe("AccMovement");
  });

  it("states that presence is not usage, so nobody reads a consolidation candidate as dead code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sah-077-"));
    const writer = new ReportWriter(dir, {
      source: "regression corpus",
      engineVersion: "Firebird 2.5",
    });
    const catalogue = await catalogueTemplates(new FixtureLegacyDriver(corpus), writer);
    expect(catalogue.note).toContain("not evidence it is used");
  });
});
