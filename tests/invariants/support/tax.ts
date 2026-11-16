// tests/invariants/support/tax.ts — registered to 5A by contracts §4.17.1 (amendment A9).
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import {
  creditNoteFrom,
  issueDocument,
  postDocument,
  withTenant as prodWithTenant,
} from "@dulja/db";
import { taxLoader } from "@dulja/db/seed";
import { seedAccount, seedParty, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import { grantCodes } from "@dulja/db/test";
// 3B registers `ensureOpenPeriods` in `tests/invariants/support/post-inventory.ts`, beside
// `postInventoryDocument` and `recordingJobs` (contracts §4.17.1). There is no `support/costing.ts` —
// 3B's `tests/regression/support/costing.ts` is a different file in a different directory.
import { ensureOpenPeriods } from "./post-inventory";
import { postFromPack, seedTypeFromPack } from "./ar-ap";

/** The shipped pack root, resolved from THIS file so Vitest's cwd (`tests/`) cannot change the answer.
 *  4A's `PACK_ROOT` (packages/db/test/ar-ap/_support.ts, the RELATIVE "seed/my" readPackFile resolves)
 *  and 4B's `PACK_DIR` (tests/invariants/support/ar-ap.ts, an ABSOLUTE directory with a trailing
 *  separator — phase-4b amendment 9 names it PACK_DIR and not PACK_ROOT on purpose) both point at the
 *  same directory in two shapes; this third one exists because it is the shape THIS file needs and
 *  neither of those two is it. Do not import either here. */
export const TAX_PACK_ROOT = fileURLToPath(
  new URL("../../../packages/db/seed/my/", import.meta.url),
);

/** Applies `packages/db/seed/my/tax/` to one seeded company through the real loader — never by hand-writing
 *  regime and code rows, which is how a test starts asserting a pack it invented. */
export async function seedTaxPack(
  db: Db,
  s: Seed,
): Promise<{ regimeId: string; codes: Record<string, string> }> {
  await prodWithTenant(
    db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: "tax-pack" },
    async (tx) => {
      await taxLoader.load(tx, {
        // `appEnv` stated rather than left undefined by the cast: every suite here loads the synthetic pack,
        // which only a `dev` or `staging` seed does (PR 11 review, round 3).
        config: { tenantId: s.tenant, appEnv: "dev" } as never,
        tenantId: s.tenant,
        companyId: s.company,
        systemPrincipalId: s.system,
        packRoot: TAX_PACK_ROOT,
      });
    },
  );
  return prodWithTenant(
    db.rw,
    { tenantId: s.tenant, actorId: s.human, requestId: "tax-pack-read" },
    async (tx) => {
      const [regime] = await tx<{ id: string }[]>`
      select id from app.tax_regime where company_id = ${s.company} and code = 'SYNTH-MY-v1' and version = 1`;
      const rows = await tx<{ id: string; code: string }[]>`
      select id, code from app.tax_code where company_id = ${s.company} order by code`;
      return { regimeId: regime!.id, codes: Object.fromEntries(rows.map((r) => [r.code, r.id])) };
    },
  );
}

export interface TaxFixture {
  s: Seed;
  regimeId: string;
  /** `SYN-OUT-STD`, `SYN-OUT-ZERO`, `SYN-IN-STD`, `SYN-EXEMPT` → tax_code id. */
  codes: Record<string, string>;
  accounts: Record<string, string>;
  types: Record<string, string>;
  customerId: string;
  vendorId: string;
  poster: string;
}

/** The one setup every tax test uses. **Twelve accounts** — ten seeded here plus `1000` and `4000`, which
 *  `seedTenant` already created and which are RESOLVED rather than re-seeded — the four pack codes, the
 *  four taxed 4A types read off disk, a customer, a vendor, and open periods for the whole of 2026. */
export async function taxFixture(db: Db, name: string): Promise<TaxFixture> {
  const s = await seedTenantV2(db, name);
  // ⚠️ `1000 Cash` and `4000 Sales` are `seedTenant`'s own rows and their ids are ALREADY on the Seed as
  // `s.cash` and `s.sales` (plan0A:1592-1594). `app.account` carries `unique (company_id, code)`, so
  // `seedAccount` on either would be a conflict — they are mapped, not created. **`4000` must be in this
  // map**: `postTaxedDocument` defaults every line to `f.accounts["4000"]`, and without the entry that
  // lookup is `undefined` at run time (the non-null assertion hides it from the compiler), every default
  // line inserts `account_id = null`, and SALES_INVOICE's `each_line` revenue rule resolves nothing.
  // `5920` is `seedTenantV2`'s and is reached through `company.fx_rounding_account_id`, never by code —
  // no test in this slice names it, so it is deliberately not in the map.
  const accounts: Record<string, string> = { "1000": s.cash, "4000": s.sales };
  for (const a of [
    // 5A's own two rows (§4.15). Every other line is 0C's, 3C's or 3D's and is only RESOLVED here.
    { code: "2300", nameEn: "Output tax payable", type: "liability" },
    { code: "1350", nameEn: "Input tax receivable", type: "asset" },
    { code: "1200", nameEn: "Trade receivables", type: "asset" },
    { code: "2100", nameEn: "Trade payables", type: "liability" },
    { code: "1100", nameEn: "Bank", type: "asset" },
    { code: "1300", nameEn: "Inventory control", type: "asset" },
    { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
    { code: "5900", nameEn: "Other operating expense", type: "expense" },
    { code: "2150", nameEn: "Goods received not invoiced", type: "liability" },
    { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" },
  ] as const) {
    accounts[a.code] = await seedAccount(db, s, { code: a.code, nameEn: a.nameEn, type: a.type });
  }
  const { regimeId, codes } = await seedTaxPack(db, s);
  const types: Record<string, string> = {};
  for (const code of [
    "SALES_INVOICE",
    "SALES_CREDIT_NOTE",
    "PURCHASE_INVOICE",
    "PURCHASE_CREDIT_NOTE",
  ]) {
    types[code] = await seedTypeFromPack(db, s, code);
  }
  const customerId = await seedParty(db, s, { kind: "customer", code: "TAXCUST" });
  const vendorId = await seedParty(db, s, { kind: "vendor", code: "TAXVEND" });
  await ensureOpenPeriods(db, s, 2026);
  // 2B's R2 evaluates policy.approval.post INSIDE the posting transaction and seedTenant grants nothing
  // (§4.1, pinned), so the codes are granted once per seed object, not once per file (§4.17's grantCodes note).
  await grantCodes(db, s, {
    codes: [
      "accounting.sales.create",
      "accounting.sales.post",
      "accounting.purchase.create",
      "accounting.purchase.post",
      "accounting.journal.create",
      "accounting.journal.post",
      "accounting.tax.manage",
    ],
  });
  return { s, regimeId, codes, accounts, types, customerId, vendorId, poster: s.human };
}

export interface TaxedLine {
  lineNo: number;
  kind?: "item" | "account";
  accountId?: string;
  amount: string;
  /** A key of `TaxFixture.codes`, or `null` for a line that carries no code at all. */
  taxCode: string | null;
}

/**
 * Drafts a typed document with taxed lines, computes its tax at persist time, and posts it through 1A's
 * frozen `postDocument` by way of 4B's `postFromPack` (which handles the approval path §4.5.1 requires).
 * **The only way a test in this slice creates tax transactions.**
 *
 * **The option this helper takes is `typeCode`; the option 4B's helper takes is `code`.** They are mapped
 * here, once, rather than renamed in either file: `PostFromPackOptions.code` is 4B's frozen surface
 * (phase-4b:1859) and `typeCode` is what every call site in this slice already reads. **There is no
 * `approval` member to pass** — `postFromPack` derives the path itself with `packApproval(opts.code)`
 * precisely so a call site cannot forget it (phase-4b:1943, 2014), which is why this file does not import
 * `packApproval` at all.
 */
export async function postTaxedDocument(
  db: Db,
  f: TaxFixture,
  opts: {
    typeCode: string;
    effectiveDate: string;
    partyId?: string;
    taxInclusive?: boolean;
    lines: TaxedLine[];
  },
): Promise<{ documentId: string; number: bigint }> {
  if (opts.typeCode.endsWith("CREDIT_NOTE")) {
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "tax-credit" };
    return prodWithTenant(db.rw, ctx, async (tx) => {
      const sourceType = opts.typeCode.replace("CREDIT_NOTE", "INVOICE");
      const candidates = await tx<
        {
          id: string;
          document_id: string;
          amount: string;
          total_incl_tax: string;
          quantity: string;
          tax_code_id: string | null;
        }[]
      >`
        select l.id, l.document_id, l.amount::text, l.total_incl_tax::text, l.quantity::text, l.tax_code_id
          from app.document_line l join app.document d on d.id = l.document_id
          join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${f.s.company} and t.code = ${sourceType} and d.status = 'posted'
           and d.effective_date <= ${opts.effectiveDate} and l.quantity > 0
         order by d.effective_date, d.id, l.line_no`;
      const lines = opts.lines.map((l) => {
        const codeId = l.taxCode === null ? null : f.codes[l.taxCode]!;
        const source = candidates.find(
          (c) =>
            c.tax_code_id === codeId &&
            new Decimal(opts.taxInclusive ? c.total_incl_tax : c.amount).gte(
              new Decimal(l.amount).abs(),
            ),
        );
        if (!source)
          throw new Error("tax credit fixture needs a posted invoice line covering its amount");
        return {
          source,
          quantity: new Decimal(l.amount)
            .abs()
            .div(opts.taxInclusive ? source.total_incl_tax : source.amount)
            .mul(source.quantity)
            .toFixed(6),
        };
      });
      const settledDocumentId = lines[0]!.source.document_id;
      if (lines.some((l) => l.source.document_id !== settledDocumentId))
        throw new Error("credit lines must belong to one invoice");
      const note = await creditNoteFrom(tx, ctx, {
        companyId: f.s.company,
        settledDocumentId,
        targetDocumentTypeId: f.types[opts.typeCode]!,
        targetSeries: "CN",
        effectiveDate: opts.effectiveDate,
        reason: "Synthetic tax fixture credit",
        lines: lines.map((l) => ({ settledLineId: l.source.id, quantity: l.quantity })),
      });
      await issueDocument(tx, ctx, { documentId: note.documentId });
      const posted = await postDocument(tx, ctx, { documentId: note.documentId });
      return { documentId: note.documentId, number: posted.number };
    });
  }
  // `postFromPack` returns `{ documentId, result: PostResult }` (phase-4b:1335), not a flattened row.
  const { documentId, result } = await postFromPack(db, f.s, {
    code: opts.typeCode,
    effectiveDate: opts.effectiveDate,
    partyId: opts.partyId ?? f.customerId,
    taxInclusive: opts.taxInclusive ?? false,
    computeTax: true, // postFromPack calls computeDocumentTax before it transitions
    lines: opts.lines.map((l) => ({
      lineNo: l.lineNo,
      kind: l.kind ?? "account",
      quantity: new Decimal(l.amount).abs().toFixed(6),
      accountId: l.accountId ?? f.accounts["4000"]!,
      amount: l.amount,
      ...(l.taxCode === null ? {} : { taxCodeId: f.codes[l.taxCode]! }),
    })),
  });
  return { documentId, number: result.number };
}
