import type { Sql } from "postgres";
import { Money, type CurrencyCode } from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import { accountMap } from "./accounts";
import { draftAndPost, refuseForeignPostings, type ImportedLine } from "./document";
import { SUSPENSE_CODE } from "./opening-balance";
import { baseCurrency } from "./run";
import { dateOf, moneyOf, requireText } from "./scalar";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type RefResolver,
  type SourceColumn,
} from "./types";

/**
 * One open legacy AR/AP document, about to open as an `OPENING_BALANCE` with a party and a `legacy_ref` (ADR 0085).
 *
 * The two account members are **codes**, and are named so: `map(row, refs)` is frozen at two parameters (§4.13.2) and
 * has no `tx`, so it cannot resolve an account id; `load` does it once per page. A field named `*Id` holding `"1200"`
 * is the shape of a defect a later reader pastes into an `account_id` column.
 *
 * `amount` is the MAGNITUDE (A9's sign normalisation, applied at the boundary): never negative, and `side` — the side of
 * the party's control account the item sits on — carries the direction. A receivable opens on the debit side and a
 * payable on the credit side; a legacy credit (a negative `BILOPEN`: a credit note not yet set off, an advance) opens on
 * the other one.
 */
export interface OpenItemTarget {
  legacyNumber: string;
  partyId: string;
  kind: "receivable" | "payable";
  side: "debit" | "credit";
  controlAccountCode: string;
  suspenseAccountCode: string;
  amount: Money<CurrencyCode>;
  documentDate: string;
}

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "BILID",
    required: true,
    confidence: "hypothesis",
    note: "the bill's own key (Bills, prefix BIL); the import_batch source key",
  },
  {
    name: "BILNUMBER",
    required: true,
    confidence: "hypothesis",
    note: "the number printed on the customer's copy — preserved as a STRING in document.legacy_ref, duplicates included (LEGACY-051)",
  },
  {
    name: "BILACC",
    required: true,
    confidence: "hypothesis",
    note: "the Accounts key (ACCID) of the customer or vendor — resolved as the party loader's `ACC:<ACCID>`",
  },
  {
    name: "BILDATE",
    required: true,
    confidence: "hypothesis",
    note: "the document's own date, kept in the control line's description; the POSTING date is the cut-over date (spec:2039)",
  },
  {
    name: "BILOPEN",
    required: true,
    confidence: "hypothesis",
    note: "the unsettled amount as at the freeze — recomputed by 9A, never the stored aggregate (§5.1 #1); a NULL is refused, never zero (LEGACY-007)",
  },
  {
    name: "BILKIND",
    required: true,
    confidence: "hypothesis",
    note: "1 receivable, 2 payable; any other value is refused",
  },
];

const TREATMENT = { receivable: "ar_control", payable: "ap_control" } as const;

/**
 * `BILLS` → ONE `OPENING_BALANCE` document per open legacy document (§5.1 #8, ADR 0085) — the shape 4A's allocation and
 * 4B's ageing both need, because both settle and bucket a *document*, not a party total (§4.8.1, §4.8.2).
 *
 * Dr the party's control account / Cr `3900`, or the mirror. **Never a revenue, expense or tax account**: the
 * trial-balance opening (Task 5) already carries the legacy profit-and-loss position and leaves the AR/AP controls to
 * this load, and re-recognising revenue for an unpaid 2025 invoice would double the year. The type's policy has no tax
 * (`tax.applies: false`) and no line carries a tax code, so no tax fact is invented (Phase 5).
 *
 * The control leg is the map's `ar_control`/`ap_control` account AND the account the party's open items age on
 * (`app.party_control_account`, 0045) — the one `app.party_ageing_rows`, `openBalance` and `ageingTieOut` read. When the
 * two disagree (a receivable of a vendor, a party a person created on another control) `load` REFUSES the run rather
 * than posting a figure no party's ageing would hold, which is the one way §4.8.2's "to the cent" could fail.
 *
 * `document.legacy_ref` carries the printed number; `document.number` is issued by the posting service in the `OB`
 * series and is gapless (round 20 C1). That pairing is LEGACY-051's fix: the historical string is preserved, duplicates
 * and all, and the new numbering starts clean. Paged like any per-row loader (one document per row, one transaction per
 * page); `dependsOn` is `party`, the one table `map` resolves into.
 */
export const openItemLoader: Loader<LegacyRow, OpenItemTarget> = {
  sourceTable: "BILLS",
  targetTable: "open_item",
  dependsOn: ["party"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BILID", "BILLS"),

  async map(row, refs: RefResolver) {
    const key = requireText(row, "BILID", "BILLS");
    const site = `BILLS/${key}`;
    const legacyNumber = requireText(row, "BILNUMBER", site);
    const kindCode = requireText(row, "BILKIND", site);
    if (kindCode !== "1" && kindCode !== "2")
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: BILKIND is ${kindCode}; an open item is 1 (receivable) or 2 (payable)`,
      );
    const kind = kindCode === "1" ? "receivable" : "payable";
    // The figures before the reference (T5's rule): a NULL amount or a bad date is refused at its own row, whether or
    // not the party imported, rather than hidden behind an orphan skip.
    const amount = moneyOf(row, "BILOPEN", baseCurrency(), site);
    const documentDate = dateOf(row, "BILDATE", site);
    const accountKey = requireText(row, "BILACC", site);
    const partyId = await refs.byLegacyRef("party", `ACC:${accountKey}`);
    if (!partyId)
      return {
        skip: `account ${accountKey} has no imported party; the open item ${legacyNumber} is an orphan (LEGACY-073)`,
      };
    if (amount.isZero())
      return {
        skip: `open item ${legacyNumber} has a zero open amount; a settled document is history, not an opening`,
      };

    const treatment = TREATMENT[kind];
    const control = accountMap().entries.find((e) => e.treatment === treatment);
    // Second line of defence: `assertAccountMap` (T4) refuses a map with no `ar_control` or `ap_control`. A THROW, not a
    // `{ skip }` — the map is run configuration, so a skip would report every open item identically and load none.
    if (!control)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `the account map has no account marked ${treatment}, so open item ${legacyNumber} has no control account to post to; assertAccountMap should have refused this map (contracts §4.8.2)`,
      );
    const debitSide = kind === "receivable";
    return {
      legacyNumber,
      partyId,
      kind,
      side: debitSide !== amount.isNegative() ? "debit" : "credit",
      controlAccountCode: control.code,
      suspenseAccountCode: SUSPENSE_CODE,
      amount: amount.abs(),
      documentDate,
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: OpenItemTarget[]) {
    // An open item is the position ON the cut-over date (spec:2039): a legacy document dated after it means the source
    // was not frozen, or the date is wrong. Refused, never silently left out — the ledger opening would not match.
    const late = rows.find((r) => r.documentDate > ctx.cutOverDate);
    if (late)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `legacy open item ${late.legacyNumber} is dated ${late.documentDate}, after the cut-over date ${ctx.cutOverDate}; freeze the source on the cut-over date, or correct the date`,
      );

    await refuseForeignPostings(tx, ctx, "open items are");
    const base = baseCurrency();
    const codes = [...new Set([...rows.map((r) => r.controlAccountCode), SUSPENSE_CODE])];
    const accounts = await tx<{ code: string; id: string }[]>`
      select code, id::text as id from app.account
       where company_id = ${ctx.companyId} and code = any(${codes}) and archived_at is null and not is_group`;
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    for (const code of codes)
      if (!byCode.has(code))
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `company ${ctx.companyId} has no live leaf account ${code}; the account map names it as a control (or it is the suspense ${SUSPENSE_CODE}), and it must exist before the open items load (contracts §4.15)`,
        );

    // The account each party's open items AGE on — the one `app.party_ageing_rows` and `ageingTieOut` read.
    const partyIds = [...new Set(rows.map((r) => r.partyId))];
    const parties = await tx<
      {
        id: string;
        kind: string;
        code: string;
        control: string | null;
        control_code: string | null;
      }[]
    >`
      select p.id::text as id, p.kind::text as kind, p.code,
             app.party_control_account(p)::text as control, a.code as control_code
        from app.party p
        left join app.account a on a.id = app.party_control_account(p)
       where p.company_id = ${ctx.companyId} and p.id = any(${partyIds}::uuid[])`;
    const partyBy = new Map(parties.map((p) => [p.id, p]));

    const suspense = byCode.get(SUSPENSE_CODE)!;
    const zero = Money.zero(base);
    const batchIds: string[] = [];
    for (const row of rows) {
      const control = byCode.get(row.controlAccountCode)!;
      const party = partyBy.get(row.partyId);
      if (!party || party.control !== control)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `legacy open item ${row.legacyNumber} is a ${row.kind} of ${party ? `${party.kind} ${party.code}` : `party ${row.partyId}`}, whose open items age on ${party?.control_code ?? "no account"} (app.party_control_account), not on the ${TREATMENT[row.kind]} ${row.controlAccountCode}; correct the party or the legacy kind before the load (contracts §4.8.2)`,
        );
      const debit = row.side === "debit";
      const lines: ImportedLine[] = [
        {
          lineNo: 1,
          kind: "account",
          accountId: control,
          description: `Open ${row.kind} at cut-over — legacy ${row.legacyNumber} dated ${row.documentDate}`,
          debit: debit ? row.amount : zero,
          credit: debit ? zero : row.amount,
        },
        {
          lineNo: 2,
          kind: "account",
          accountId: suspense,
          description: `Opening-balance suspense — the other side of legacy ${row.legacyNumber} (§5.1 #8)`,
          debit: debit ? zero : row.amount,
          credit: debit ? row.amount : zero,
        },
      ];
      const posted = await draftAndPost(tx, ctx, {
        documentTypeCode: "OPENING_BALANCE",
        legacyRef: row.legacyNumber,
        partyId: row.partyId,
        lines,
      });
      batchIds.push(posted.documentId);
    }
    return { inserted: rows.length, skipped: 0, batchIds };
  },
};
