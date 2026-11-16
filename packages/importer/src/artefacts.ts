import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { unreadable } from "./legacy/types";

export interface ArtefactEntry {
  readonly name: string;
  readonly kind: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtefactIndex {
  readonly generatedAt: string;
  readonly source: string;
  readonly engineVersion: string;
  readonly artefacts: readonly ArtefactEntry[];
}

const BOM = "﻿";
const NEEDS_QUOTE = /[",\r\n]/;
/** OWASP "CSV injection": a leading `=`, `+`, `-`, `@`, tab or CR makes a spreadsheet evaluate the cell. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** A plain signed decimal is a number to a spreadsheet, never a formula — and a prefix would corrupt it. */
const PLAIN_DECIMAL = /^[+-]?\d+(\.\d+)?$/;

function cell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const s = FORMULA_LEAD.test(raw) && !PLAIN_DECIMAL.test(raw) ? ["'", raw].join("") : raw;
  return NEEDS_QUOTE.test(s) ? ['"', s.replaceAll('"', '""'), '"'].join("") : s;
}

/**
 * RFC 4180, CRLF, with a UTF-8 BOM. The BOM is not decoration: these files carry Arabic master-data names, and
 * Excel on Windows — which is what the owner will open them in — decodes a BOM-less UTF-8 CSV as the system code
 * page and renders every Arabic name as mojibake. SAH-085 is the same defect in the other direction.
 *
 * The CSV is for a person (ADR 0083), so a cell a spreadsheet would run as a formula is prefixed with `'` — the
 * 7A report-CSV rule (`packages/db/src/hr/csv-cell.ts`), restated here because this package may not import
 * `@dulja/db`. A plain signed decimal (`-50.0000`) is exempt: it is a figure, not a formula, and the JSON beside
 * every CSV carries the raw values for a machine.
 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return BOM;
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [
    headers.map(cell).join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ];
  return [BOM, lines.join("\r\n"), "\r\n"].join("");
}

const INDEX = "index.json";

/** ISO-8601 to the second, in UTC, so two runs of the same command are diffable (spec:2039). */
function stamp(): string {
  return [new Date().toISOString().slice(0, 19), "Z"].join("");
}

/**
 * Every artefact this slice produces is written as machine-readable JSON and, where a person reads it, as a CSV
 * the owner's accountant can open — and hashed, and listed in `index.json`. The hash is what lets 9B's cut-over
 * runbook say "the reconciliation the owner signed off is exactly this file" months later (ADR 0083).
 */
export class ReportWriter {
  private readonly entries: ArtefactEntry[] = [];
  private readonly generatedAt = stamp();
  private readonly outDir: string;
  private readonly header: { readonly source: string; readonly engineVersion: string };

  constructor(outDir: string, header: { source: string; engineVersion: string }) {
    this.outDir = outDir;
    this.header = header;
    mkdirSync(outDir, { recursive: true });
  }

  json(name: string, value: unknown, rows: number): ArtefactEntry {
    return this.write(
      name,
      "json",
      rows,
      Buffer.from([JSON.stringify(value, null, 2), "\n"].join(""), "utf8"),
    );
  }

  csv(name: string, rows: readonly Record<string, unknown>[]): ArtefactEntry {
    return this.write(name, "csv", rows.length, Buffer.from(toCsv(rows), "utf8"));
  }

  bytes(name: string, content: Buffer): ArtefactEntry {
    return this.write(name, "blob", 1, content);
  }

  /**
   * Writes `index.json` last, listing itself, and returns exactly what it wrote — the returned object and the file
   * on disk are the same value. Its own entry carries `bytes: 0` and `sha256: ""` because a file cannot contain the
   * digest of its own final bytes; `rows` is the number of artefacts indexed beside it. `finish` does not go
   * through `write`, so it never appends its own entry and calling it twice produces the same index.
   */
  finish(): ArtefactIndex {
    const self: ArtefactEntry = {
      name: INDEX,
      kind: "json",
      rows: this.entries.length,
      bytes: 0,
      sha256: "",
    };
    const index: ArtefactIndex = {
      generatedAt: this.generatedAt,
      source: this.header.source,
      engineVersion: this.header.engineVersion,
      artefacts: [...this.entries, self],
    };
    writeFileSync(
      join(this.outDir, INDEX),
      Buffer.from([JSON.stringify(index, null, 2), "\n"].join(""), "utf8"),
    );
    return index;
  }

  /**
   * An artefact's name stays inside the output directory and never takes the index's own name: later tasks
   * write names derived from legacy data (a template blob's), and a name that climbed out with `..` would write
   * customer data somewhere `.gitignore` does not cover.
   */
  private write(name: string, kind: string, rows: number, content: Buffer): ArtefactEntry {
    const clean = normalize(name);
    if (
      isAbsolute(name) ||
      clean === INDEX ||
      clean === ".." ||
      clean.startsWith(["..", sep].join("")) ||
      clean.startsWith("../")
    )
      throw unreadable(
        ["artefact name", JSON.stringify(name), "is not a plain relative name"].join(" "),
      );
    // A template blob lands under `templates/` (Task 12), so the artefact's own directory may not exist yet.
    mkdirSync(dirname(join(this.outDir, clean)), { recursive: true });
    writeFileSync(join(this.outDir, clean), content);
    const entry: ArtefactEntry = {
      name,
      kind,
      rows,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    this.entries.push(entry);
    return entry;
  }
}
