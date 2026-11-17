import { createHash } from "node:crypto";
import type { ReportWriter } from "../artefacts";
import { unreadable, type LegacyDriver } from "../legacy/types";

export type TemplateGroup =
  | "accounts"
  | "materials"
  | "documents"
  | "payroll"
  | "hospital"
  | "academy"
  | "services"
  | "fixed_assets"
  | "tax"
  | "customisation"
  | "unknown";

export interface TemplateEntry {
  /** The row's name column, trimmed. */
  readonly name: string;
  /** The per-user owner, when the table declares such a column. */
  readonly owner: string | null;
  /** Decoded blob length. */
  readonly bytes: number;
  /** Of the decoded bytes; empty for an empty row. */
  readonly sha256: string;
  /** The artefact file the blob was written to; empty for an empty row. */
  readonly file: string;
  /** The dossier's §4.4 grouping, by rule. */
  readonly group: TemplateGroup;
  /** The spr, rah, dnt and med families — customer-specific (Part VII #9). */
  readonly customisation: boolean;
  readonly nearDuplicateOf: string | null;
  /** A row whose blob is null or zero-length. */
  readonly empty: boolean;
}

export interface TemplateCatalogue {
  readonly generatedAt: string;
  readonly source: string;
  readonly table: string;
  readonly nameColumn: string;
  readonly blobColumn: string;
  readonly ownerColumn: string | null;
  readonly entries: readonly TemplateEntry[];
  readonly byGroup: Readonly<Record<TemplateGroup, number>>;
  readonly shippedCountFromDossier: 255;
  readonly note: string;
}

/**
 * The dossier's own grouping (analysis §4.4), expressed as ordered rules rather than as a list of 255 names.
 * A rule can be checked against the dossier's examples in a test; a transcribed list of 255 strings cannot be
 * checked against anything and would rot the first time the customer renames a clone. The **customisation**
 * rules come first because `repdntProfits` matches both `rep*` and the `dnt` customisation and the answer that
 * matters for Part VII #9 is "customer-specific".
 */
export const TEMPLATE_GROUP_RULES: readonly {
  readonly group: TemplateGroup;
  readonly test: RegExp;
  readonly why: string;
}[] = [
  {
    group: "customisation",
    test: /(^|\.)(spr|rah)|dnt|(^|\.)med/i,
    why: "analysis §7.11: the Special/rah*/spr* modules and the dnt/med report families are customer-specific work (Part VII #9).",
  },
  {
    group: "tax",
    test: /^(gst|gulfvat|vat)/i,
    why: "analysis §4.4 names GstListingReport and GulfVat.Gst03Rep as the tax group.",
  },
  {
    group: "hospital",
    test: /^(hsp|hspr|hh|patient|prescription|surgery|reception|room|storysick)/i,
    why: "analysis §4.4: ~25 hsp*/hspr* templates plus the clinic-facing names of the Hospitals module.",
  },
  {
    group: "academy",
    test: /^(student|teacher|acad|class|semester|presence|lesson)/i,
    why: "analysis §4.4: ~10 academy templates, named for the Academy module's own entities.",
  },
  { group: "fixed_assets", test: /^ast/i, why: "analysis §4.4: ~8 Ast* fixed-asset templates." },
  {
    group: "payroll",
    test: /^(salary|payroll|pay(cash|group|master|ment)|shifts|attend|vacation|promotion)/i,
    why: "analysis §4.4: ~20 payroll templates over the Salaries module's runs, advances and attendance.",
  },
  {
    group: "services",
    test: /^(srv|mnt|service|transportservices|sky|aircraft|airport)/i,
    why: "analysis §4.4: ~15 services/maintenance templates, including the aviation sub-domain of §4.6.",
  },
  {
    group: "documents",
    test: /(billprint|vouprint|billsaleform|buyorder|saleorder|transform|outbillform|voucherform|vouform|voufacedform|vouopenform|vouentiers|voureview|printbilmodels|printvoumodels|simplified)/i,
    why: "analysis §4.4's document group: the printed forms for bills and vouchers.",
  },
  {
    group: "accounts",
    test: /^(acc|balancesheet|final|financequota|costcentre|operatingbalance|batchbalances|subacc|pend(payable|receivable))/i,
    why: "analysis §4.4: ~40 account templates — ledgers, balances, ages, statements.",
  },
  {
    group: "materials",
    test: /^(mat|inventory|warehouse|regionsmovement|serial|prod|order(acc|funds|mat|product|rep|stagnant))/i,
    why: "analysis §4.4: ~45 material templates — balances, profits, movement, batches, serials, limits.",
  },
];

/** Ordered rules, first match wins; `unknown` is a real answer and never a silent default into another group. */
export function classifyTemplate(name: string): { group: TemplateGroup; customisation: boolean } {
  const bare = name.trim();
  for (const rule of TEMPLATE_GROUP_RULES) {
    if (rule.test.test(bare))
      return { group: rule.group, customisation: rule.group === "customisation" };
  }
  return { group: "unknown", customisation: false };
}

/**
 * The near-duplicate rule, derived from the three families analysis §7.10 names by example: a numeric clone
 * prefix (`2.VouEntiers`), an orientation or detail suffix (`AccMovementHorizontal`, `AccMovementInfo`) and a
 * `_n` revision suffix (`BatchBalances_n`). Two templates whose stems are equal are *candidates* for
 * consolidation — the dossier's "consolidate the 255 into ~60" — not proof that either is unused.
 */
export function templateStem(name: string): string {
  return name
    .trim()
    .replace(/^\d+\s*[.\-_]\s*/, "")
    .replace(/(_n|_\d+|horizontal|info|detail|details|short|long|simplified)$/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

const EMPTY_BY_GROUP: Readonly<Record<TemplateGroup, number>> = {
  accounts: 0,
  materials: 0,
  documents: 0,
  payroll: 0,
  hospital: 0,
  academy: 0,
  services: 0,
  fixed_assets: 0,
  tax: 0,
  customisation: 0,
  unknown: 0,
};

/** `System.Reports` (analysis §4.4); in the shipped map it is the `system` module's `REPORTS`. */
const TEMPLATE_TABLE = "REPORTS";
const NAME_CANDIDATES = ["NAME", "REPORTNAME", "CAPTION", "TITLE"] as const;
const OWNER_CANDIDATES = ["USERNAME", "USER", "OWNER", "PROFILE", "USERID"] as const;

/** Where the definitions live in this source, as its catalogue declares it. */
export interface TemplateColumns {
  readonly table: string;
  readonly nameColumn: string;
  readonly blobColumn: string;
  readonly ownerColumn: string | null;
}

/**
 * Discovers the name, owner and blob columns of `REPORTS` from the catalogue — no shipped file gives
 * `System.Reports`' column names, so none is assumed. The one discovery the catalogue, Task 13's Part VII #8
 * and #9 probes and the `all` command use, so none of them can read the table differently. A source without
 * the table, without a blob column or without a text column is a `refused` answer naming why, never a guess;
 * a failure of the source itself still rejects.
 */
export async function locateTemplates(
  driver: LegacyDriver,
): Promise<TemplateColumns | { readonly refused: string }> {
  const table = TEMPLATE_TABLE;
  if (!(await driver.tables()).includes(table))
    return {
      refused: [
        table,
        "is not a table of this source; report definitions cannot be extracted",
      ].join(" "),
    };
  const columns = await driver.columns(table);
  const blobColumn = columns.find((c) => c.kind === "blob")?.name;
  if (!blobColumn)
    return {
      refused: [table, "declares no blob column; report definitions cannot be extracted"].join(" "),
    };
  const nameColumn =
    NAME_CANDIDATES.find((c) => columns.some((col) => col.name === c)) ??
    columns.find((c) => c.kind === "text")?.name;
  if (!nameColumn)
    return { refused: [table, "declares no text column to read a template name from"].join(" ") };
  const ownerColumn =
    OWNER_CANDIDATES.find((c) => c !== nameColumn && columns.some((col) => col.name === c)) ?? null;
  return { table, nameColumn, blobColumn, ownerColumn };
}

/** `locateTemplates`, refusing with `ERR_IMPORT_SOURCE_UNREADABLE` where it answers `refused`. */
export async function templateColumns(driver: LegacyDriver): Promise<TemplateColumns> {
  const found = await locateTemplates(driver);
  if ("refused" in found) throw unreadable(found.refused);
  return found;
}

/** Device names Windows reserves with any extension — the machine the owner runs this on (spec §3.0). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A template name can contain a dot, a space, a separator and Arabic text; a file name here may not. */
function safeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120);
  if (cleaned.length === 0)
    return ["unnamed-", createHash("sha256").update(name).digest("hex").slice(0, 12)].join("");
  return WINDOWS_RESERVED.test(cleaned) ? [cleaned, "_"].join("") : cleaned;
}

/**
 * §5.1 #9 (spec:2341) / LEGACY-077. Takes the **driver**, not the `LegacyReader`: §4.13.1 froze `LegacyReader`
 * without a catalogue accessor, and this is the one report that needs a column's *declared type* — which
 * column is the blob is discovered, never assumed. Extending `LegacyReader` to suit one report would change a
 * surface 9B consumes; taking the driver changes nothing.
 *
 * The bytes are written out verbatim and hashed. Nothing here parses a `TDluxReportContainer` — the file is
 * opaque, and 7B decides later what to read out of it. Every row gets its own file: per-user copies share a
 * name (analysis §4.4), and Windows folds case, so a name already taken — compared case-insensitively — gets a
 * `~<n>` suffix rather than overwriting the blob the catalogue already hashed.
 */
export async function catalogueTemplates(
  driver: LegacyDriver,
  writer: ReportWriter,
): Promise<TemplateCatalogue> {
  const { table, nameColumn, blobColumn, ownerColumn } = await templateColumns(driver);
  const wanted =
    ownerColumn === null ? [nameColumn, blobColumn] : [nameColumn, blobColumn, ownerColumn];
  const staged: { name: string; owner: string | null; bytes: Buffer | null }[] = [];
  for await (const batch of driver.cursor({ table, columns: wanted }, 50)) {
    for (const row of batch) {
      const encoded = row[blobColumn];
      const owner = ownerColumn === null ? null : row[ownerColumn];
      staged.push({
        name: String(row[nameColumn] ?? "").trim(),
        owner: owner === null || owner === undefined ? null : String(owner).trim(),
        bytes:
          typeof encoded === "string" && encoded.length > 0 ? Buffer.from(encoded, "base64") : null,
      });
    }
  }

  const stems = new Map<string, number[]>();
  staged.forEach((row, index) => {
    const stem = templateStem(row.name);
    stems.set(stem, [...(stems.get(stem) ?? []), index]);
  });

  const byGroup: Record<TemplateGroup, number> = { ...EMPTY_BY_GROUP };
  const taken = new Set<string>();
  const entries: TemplateEntry[] = staged.map((row, index) => {
    const { group, customisation } = classifyTemplate(row.name);
    byGroup[group] += 1;
    const sibling = (stems.get(templateStem(row.name)) ?? []).find((i) => i !== index);
    const nearDuplicateOf = sibling === undefined ? null : (staged[sibling]?.name ?? null);
    if (row.bytes === null || row.bytes.byteLength === 0) {
      return {
        name: row.name,
        owner: row.owner,
        bytes: 0,
        sha256: "",
        file: "",
        group,
        customisation,
        nearDuplicateOf,
        empty: true,
      };
    }
    const base = safeFileName(row.name);
    let stem = base;
    for (let n = 2; taken.has(stem.toLowerCase()); n += 1) stem = [base, String(n)].join("~");
    taken.add(stem.toLowerCase());
    const file = ["templates/", stem, ".report"].join("");
    writer.bytes(file, row.bytes);
    return {
      name: row.name,
      owner: row.owner,
      bytes: row.bytes.byteLength,
      sha256: createHash("sha256").update(row.bytes).digest("hex"),
      file,
      group,
      customisation,
      nearDuplicateOf,
      empty: false,
    };
  });

  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source,
    table,
    nameColumn,
    blobColumn,
    ownerColumn,
    entries,
    byGroup,
    shippedCountFromDossier: 255,
    note: "Presence with a non-empty blob is evidence a template exists here, not evidence it is used. Part VII #8 — which of the 255 are in use — is OD-27 and is answered by the questions probe. `nearDuplicateOf` marks consolidation candidates (analysis §7.10), never dead templates.",
  };
}
