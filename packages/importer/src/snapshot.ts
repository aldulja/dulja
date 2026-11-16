import { createHmac, randomBytes } from "node:crypto";
import type { ReportWriter } from "./artefacts";
import { LEGACY_MODULES } from "./legacy/modules";
import { unreadable, type LegacyColumn, type LegacyDriver } from "./legacy/types";

export type PersonalKind =
  | "name"
  | "identifier"
  | "contact"
  | "address"
  | "free_text"
  | "credential"
  | "date_of_birth"
  | "pay";

export interface PersonalColumnRule {
  readonly pattern: RegExp;
  readonly kind: PersonalKind;
  readonly why: string;
}

/**
 * Ordered; first match wins. The rules are on **column names**, because that is all a generic snapshot of 460
 * unfamiliar tables can classify on, and the plan is written into the artefact so a person can see every
 * decision the tool made and challenge it. `credential` comes first: `NEVER_READ` already stops the two names
 * spec §5.1 #7 and #11 forbid, and any other column that looks like a secret is omitted rather than
 * pseudonymised, because a pseudonymised password is still a per-user token in a file leaving the customer's
 * machine.
 *
 * **The legacy columns are prefixed** (9B review, finding 2): the dossier's one verified naming fact is a per-table
 * prefix on every physical column (`Accounts.AccName`, `BillItems.BtmQnt`), so 9B reads `EMPNAME`, `EMPNATID`,
 * `ACCTAXNO`. A rule anchored on the bare word (`^name$`) matched none of them, and the snapshot copied every
 * employee's national id and pay in clear. So each rule is a STEM that matches anywhere in the name or after an
 * optional three-letter table prefix (`[a-z]{3}`), and the person words that would otherwise catch a key column
 * (`STUDENTID`) stay anchored behind that optional prefix. A rule that over-matches pseudonymises or omits a
 * harmless column — a fidelity cost in a staging seed; one that under-matches sends a person's data off-site.
 */
export const PERSONAL_COLUMN_RULES: readonly PersonalColumnRule[] = [
  {
    pattern: /password|passwd|^(?:[a-z]{3})?pin(?:code)?$|secret|token|apikey|api_key/i,
    kind: "credential",
    why: "A credential is omitted, never pseudonymised: a stable pseudonym of a secret is still a per-user token (spec:2338, §5.1 #7).",
  },
  {
    pattern: /dob$|birth/i,
    kind: "date_of_birth",
    why: "A date of birth is a quasi-identifier, and a pseudonym of a date is not a date, so it is omitted (9B review, finding 2).",
  },
  {
    pattern: /ytd|salary|wage|payslip/i,
    kind: "pay",
    why: "A pay figure is personal data behind hr.payroll.read in Dulja, and a pseudonym of an amount is not an amount, so it is omitted (9B review, finding 2).",
  },
  {
    pattern:
      /name(?:ar|en)?$|^(?:[a-z]{3})?(?:guardian|father|mother|spouse|patient|student|teacher)$/i,
    kind: "name",
    why: "A person's name identifies them directly; it is replaced by a stable pseudonym so joins still work.",
  },
  {
    pattern:
      /tax(?:no|num|number)|regnumber|passport|nric|^(?:[a-z]{3})?ic$|icno|identity|nationalid|natid|licence|license|bankacc|iban|cardno|epf(?:no|num|number)?$|socso(?:no|num|number)?$/i,
    kind: "identifier",
    why: "A government or financial identifier is a direct identifier and is replaced by a stable pseudonym.",
  },
  {
    pattern: /mobile|phone|tel|fax|email|mail|whatsapp/i,
    kind: "contact",
    why: "A contact detail identifies a person and is replaced by a stable pseudonym.",
  },
  {
    pattern: /address|street|city|postcode|zip|location|coordinate|latitude|longitude/i,
    kind: "address",
    why: "An address locates a person or a household and is replaced by a stable pseudonym.",
  },
  {
    pattern: /note|notes|remark|comment|description|memo|detail$/i,
    kind: "free_text",
    why: "Free text cannot be classified column-wise — an operator may have typed anything into it — so it is omitted.",
  },
];

/**
 * 9B review, finding 2 — the tables whose every row is a person's data: the whole `salaries` database (employees,
 * payslips, attendance, leave, loans) and the shipped map's user and payroll tables elsewhere. In these the snapshot
 * FAILS CLOSED: a column no rule recognises is omitted, not copied, and only the table's own key (so its rows stay
 * countable and joinable) leaves in clear. Everywhere else an unrecognised column is copied, as before — a code, a
 * quantity, a date, a foreign key — because a staging seed with every unfamiliar column blanked rehearses nothing.
 * Taken from 9A's module map (`LEGACY_MODULES`), never typed by hand, so a table the dossier lists is never missed.
 */
export const PERSONAL_TABLES: ReadonlySet<string> = new Set(
  LEGACY_MODULES.flatMap((m) =>
    m.id === "salaries" ? m.tables : m.tables.filter((t) => /(?:USERS|PAYROLLS|PAYITEMS)$/.test(t)),
  ),
);

/** spec §5.1 #7 and #11: `Users.Password` and `Users.PIN` are never imported and, here, never read. */
export const NEVER_READ: ReadonlySet<string> = new Set(["USERS.PASSWORD", "USERS.PIN"]);

/** ADR 0083's amendment C4: a short value's pseudonym is short too, and the plan says what that costs. */
const SHORT_VALUE_NOTE =
  "A value shorter than eight characters yields a pseudonym of the same length with a real collision probability; it is not lengthened (ADR 0083, amendment C4).";

export interface SnapshotColumnPlan {
  readonly table: string;
  readonly column: string;
  readonly action: "copy" | "pseudonymise" | "omit";
  readonly kind: PersonalKind | null;
  readonly why: string;
}

export interface SnapshotTable {
  readonly table: string;
  readonly rows: number;
  readonly file: string;
  readonly sha256: string;
}

export interface SnapshotResult {
  readonly generatedAt: string;
  readonly source: string;
  readonly tables: readonly SnapshotTable[];
  readonly plan: readonly SnapshotColumnPlan[];
  readonly pseudonymisedColumns: number;
  readonly omittedColumns: number;
  readonly saltPersisted: false;
}

/**
 * Every column of a table gets exactly one row, in the catalogue's own order. Nothing is left unclassified. `keys` is
 * the table's primary key (`LegacyDriver.keyColumns`): in a `PERSONAL_TABLES` table it is the only unrecognised column
 * copied (9B review, finding 2), so a table the catalogue declares no key for leaves only its pseudonymised columns.
 */
export function planSnapshot(
  table: string,
  columns: readonly LegacyColumn[],
  keys: readonly string[] = [],
): SnapshotColumnPlan[] {
  const personal = PERSONAL_TABLES.has(table);
  return columns.map((column): SnapshotColumnPlan => {
    if (NEVER_READ.has([table, column.name].join("."))) {
      return {
        table,
        column: column.name,
        action: "omit",
        kind: "credential",
        why: "On the deny-list: spec §5.1 #7 and #11 forbid reading this column at all (SAH-028).",
      };
    }
    if (column.kind === "blob") {
      return {
        table,
        column: column.name,
        action: "omit",
        kind: "free_text",
        why: "A blob is opaque bytes that may contain anything, including a scan of an identity document; it is omitted.",
      };
    }
    const rule = PERSONAL_COLUMN_RULES.find((r) => r.pattern.test(column.name));
    if (rule === undefined) {
      if (personal && !keys.includes(column.name))
        return {
          table,
          column: column.name,
          action: "omit",
          kind: null,
          why: "Fail-closed: every row of this table is a person's data, and no rule recognises this column, so it is omitted rather than copied — only the table's key leaves in clear (9B review, finding 2; ADR 0083).",
        };
      return {
        table,
        column: column.name,
        action: "copy",
        kind: null,
        why: personal
          ? "The table's own key, copied so its rows stay countable and joinable; every other unrecognised column of this personal table is omitted (9B review, finding 2)."
          : "No rule classifies this column as personal, so the value is copied — a code, a quantity, a date or a foreign key.",
      };
    }
    return rule.kind === "credential" ||
      rule.kind === "free_text" ||
      rule.kind === "date_of_birth" ||
      rule.kind === "pay"
      ? { table, column: column.name, action: "omit", kind: rule.kind, why: rule.why }
      : {
          table,
          column: column.name,
          action: "pseudonymise",
          kind: rule.kind,
          why: [rule.why, SHORT_VALUE_NOTE].join(" "),
        };
  });
}

/**
 * ADR 0083 §5, as amended by correction C4: `HMAC-SHA256(salt, table ‖ column ‖ value)` rendered as hex and
 * truncated to **the length of the value it replaces**, so the pseudonym fits every column the original fitted.
 * The table and column are inside the message, so the same customer name in two columns yields two different
 * pseudonyms and a join the source did not have cannot be rebuilt from the snapshot. The salt is per run and
 * never written down, so the mapping is irreversible even to whoever produced the file.
 */
export function pseudonymise(salt: Buffer, table: string, column: string, value: string): string {
  const blocks: string[] = [];
  for (let counter = 0; blocks.length * 64 < value.length; counter += 1) {
    blocks.push(
      createHmac("sha256", salt)
        .update([table, column, value, String(counter)].join("\u0000"))
        .digest("hex"),
    );
  }
  return blocks.join("").slice(0, value.length);
}

/** Rows per read; the snapshot holds a table in memory before writing its CSV, as every 9A report does. */
const BATCH = 500;

/**
 * spec:2272 — the anonymised snapshot `staging` is seeded from. It writes one CSV per requested table with the
 * omitted columns absent from the header as well as from the rows, and it writes the classification plan
 * beside them so the anonymisation is auditable rather than asserted. **An omitted column never reaches the
 * `SelectSpec`**: a denied value is not read and then dropped, it is never selected — and a table with no
 * column left to copy is counted, not read, because an empty column list means "every column" to a driver.
 * **The salt is not written**: nothing in the run directory can reverse a pseudonym, which is the property that
 * lets the file leave the customer's premises at all.
 */
export async function snapshot(
  driver: LegacyDriver,
  writer: ReportWriter,
  opts: { readonly tables?: readonly string[]; readonly salt?: Buffer } = {},
): Promise<SnapshotResult> {
  const salt = opts.salt ?? randomBytes(32);
  const present = new Set(await driver.tables());
  const wanted = opts.tables ?? [...present].toSorted();
  for (const table of wanted) {
    if (!present.has(table)) throw unreadable([table, "is not a table of this source"].join(" "));
  }

  const plan: SnapshotColumnPlan[] = [];
  const tables: SnapshotTable[] = [];

  for (const table of wanted) {
    const tablePlan = planSnapshot(
      table,
      await driver.columns(table),
      await driver.keyColumns(table),
    );
    plan.push(...tablePlan);
    const kept = tablePlan.filter((p) => p.action !== "omit");
    const rows: Record<string, unknown>[] = [];
    if (kept.length > 0) {
      for await (const batch of driver.cursor(
        { table, columns: kept.map((p) => p.column) },
        BATCH,
      )) {
        for (const row of batch) {
          const out: Record<string, unknown> = {};
          for (const column of kept) {
            const value = row[column.column];
            out[column.column] =
              column.action === "pseudonymise" && typeof value === "string"
                ? pseudonymise(salt, table, column.column, value)
                : value;
          }
          rows.push(out);
        }
      }
    }
    const entry = writer.csv(["snapshot/", table, ".csv"].join(""), rows);
    tables.push({
      table,
      rows: kept.length > 0 ? rows.length : await driver.count(table),
      file: entry.name,
      sha256: entry.sha256,
    });
  }

  const result: SnapshotResult = {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source,
    tables,
    plan,
    pseudonymisedColumns: plan.filter((p) => p.action === "pseudonymise").length,
    omittedColumns: plan.filter((p) => p.action === "omit").length,
    saltPersisted: false,
  };
  writer.json("snapshot-plan.json", result, plan.length);
  writer.csv(
    "snapshot-plan.csv",
    plan.map((p) => ({
      table: p.table,
      column: p.column,
      action: p.action,
      kind: p.kind ?? "",
      why: p.why,
    })),
  );
  return result;
}
