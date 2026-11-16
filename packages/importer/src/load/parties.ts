import type { Sql } from "postgres";
import type { LegacyRow } from "../legacy/types";
import { placeByCode } from "./master";
import { flagOf, optionalText, requireText } from "./scalar";
import { LoadError, type LoadContext, type Loader, type SourceColumn } from "./types";

interface PartyTarget {
  /** ACCID — the row's own surrogate key, the `import_batch` source key's body (`ACC:<ACCID>`). */
  legacyKey: string;
  /** ACCCODE — the code a person reads on the legacy chart; `party.legacy_ref`, as on `account.legacy_ref`. */
  legacyCode: string;
  kind: "customer" | "vendor";
  code: string;
  nameEn: string;
  nameAr: string | null;
  taxRegistration: string | null;
  email: string | null;
  phone: string | null;
}

/** The columns both readers of `ACCOUNTS` declare — the party loader adds its commercial ones, the account loader its
 *  opening balance. Every one a hypothesis in the dossier's prefixed spelling (analysis §3.1, §4.2: `Accounts` carries
 *  `IsCustomer`, `IsVendor`, `TaxNumber`, …). */
export const ACCOUNTS_KEY_COLUMNS: readonly SourceColumn[] = [
  {
    name: "ACCID",
    required: true,
    confidence: "hypothesis",
    note: "the account's own key (Accounts, prefix ACC)",
  },
  {
    name: "ACCCODE",
    required: true,
    confidence: "hypothesis",
    note: "the legacy chart code a person reads; the account map keys on it, and legacy_ref carries it",
  },
  {
    name: "ACCNAME",
    required: true,
    confidence: "hypothesis",
    note: "display name → name_en (the dossier names Accounts.AccName verbatim)",
  },
  {
    name: "ACCISCUSTOMER",
    required: false,
    confidence: "hypothesis",
    note: "flag (dossier: IsCustomer); a row that is neither customer nor vendor is a ledger account",
  },
  {
    name: "ACCISVENDOR",
    required: false,
    confidence: "hypothesis",
    note: "flag (dossier: IsVendor)",
  },
];

const COLUMNS: readonly SourceColumn[] = [
  ...ACCOUNTS_KEY_COLUMNS,
  { name: "ACCNAMEAR", required: false, confidence: "hypothesis", note: "Arabic name → name_ar" },
  {
    name: "ACCTAXNO",
    required: false,
    confidence: "hypothesis",
    note: "tax registration (dossier: TaxNumber) → party.tax_registration",
  },
  { name: "ACCEMAIL", required: false, confidence: "hypothesis", note: "→ party.email" },
  { name: "ACCPHONE", required: false, confidence: "hypothesis", note: "→ party.phone" },
];

/** The two §4.15 control accounts a party's `receivable_account_id`/`payable_account_id` take (§4.5.7). */
const CONTROL = { customer: "1200", vendor: "2100" } as const;

/**
 * `ACCOUNTS` → `app.party` (customer or vendor). §5.1 #12 and dossier §4.2: the legacy `Accounts` table is BOTH the
 * chart of accounts and the customer/vendor file. This loader takes the rows flagged customer or vendor; `accountLoader`
 * takes the rest. Source key: **`ACC:<ACCID>`** — what Task 7's `refs.byLegacyRef("party", \`ACC:${BILACC}\`)` passes.
 * The prefix keeps it disjoint from the account loader's bare `ACCCODE` keys on the same source table, which
 * `import_batch`'s natural key `(company_id, source_table, source_key)` requires.
 *
 * Written by tagged-template INSERT: there is no party-creation service in `packages/db` (the API's `POST …/parties`
 * inserts inline), and the row is the API's row minus the credit terms, which a party is created without.
 */
export const partyLoader: Loader<LegacyRow, PartyTarget> = {
  sourceTable: "ACCOUNTS",
  targetTable: "party",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => `ACC:${requireText(row, "ACCID", "ACCOUNTS")}`,

  map(row) {
    const legacyKey = requireText(row, "ACCID", "ACCOUNTS");
    const site = `ACCOUNTS/${legacyKey}`;
    const isCustomer = flagOf(row, "ACCISCUSTOMER", site) === true;
    const isVendor = flagOf(row, "ACCISVENDOR", site) === true;
    if (!isCustomer && !isVendor)
      return {
        skip: `account ${legacyKey} is neither customer nor vendor; it is a ledger account and the account loader takes it`,
      };
    if (isCustomer && isVendor)
      // Dulja's party.kind is single-valued (§4.5.7). A legacy row that is both is a real business fact and is
      // REPORTED, not halved: the operator creates the second party by hand after cut-over.
      return {
        skip: `account ${legacyKey} is flagged both customer and vendor; party.kind is single-valued — create the second party by hand and re-point its open items`,
      };
    const legacyCode = requireText(row, "ACCCODE", site);
    return {
      legacyKey,
      legacyCode,
      kind: isCustomer ? "customer" : "vendor",
      code: `${isCustomer ? "C" : "V"}-${legacyCode}`,
      nameEn: requireText(row, "ACCNAME", site),
      nameAr: optionalText(row, "ACCNAMEAR"),
      taxRegistration: optionalText(row, "ACCTAXNO"),
      email: optionalText(row, "ACCEMAIL"),
      phone: optionalText(row, "ACCPHONE"),
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: PartyTarget[]) {
    const controls = await tx<{ code: string; id: string }[]>`
      select code, id from app.account
       where company_id = ${ctx.companyId} and code in (${CONTROL.customer}, ${CONTROL.vendor})
         and is_group = false and archived_at is null`;
    const by = new Map(controls.map((a) => [a.code, a.id]));
    for (const code of [CONTROL.customer, CONTROL.vendor])
      if (!by.has(code))
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `company ${ctx.companyId} cannot resolve control account ${code}; apply 0C's chart pack (\`bun run seed --tenant … --only chart-of-accounts\`) before the load (contracts §4.15, §4.5.7)`,
        );
    return placeByCode(tx, ctx, "party", rows, {
      async find(_row, code) {
        const [found] = await tx<{ id: string }[]>`
          select id from app.party where company_id = ${ctx.companyId} and code = ${code}`;
        return found?.id ?? null;
      },
      async create(row, code) {
        const [made] = await tx<{ id: string }[]>`
          insert into app.party (tenant_id, company_id, kind, code, name_en, name_ar,
                                 receivable_account_id, payable_account_id,
                                 tax_registration, email, phone, legacy_ref)
          values (app.current_tenant(), ${ctx.companyId}, ${row.kind}, ${code}, ${row.nameEn}, ${row.nameAr},
                  ${row.kind === "customer" ? by.get(CONTROL.customer)! : null},
                  ${row.kind === "vendor" ? by.get(CONTROL.vendor)! : null},
                  ${row.taxRegistration}, ${row.email}, ${row.phone}, ${row.legacyCode})
          returning id`;
        return made!.id;
      },
    });
  },
};
