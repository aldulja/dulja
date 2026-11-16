import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import { postDocument, type PostResult } from "./post";
import { setEventContext } from "./lifecycle";
import { SyncError } from "../sync/enrolment";
import type { TerminalApplyContext } from "../sync/apply";
import type { TenantContext } from "../with-tenant";

/** The four §4.14 till types, so a caller cannot pass a code the register does not have. `over_short` is
 *  the shift close's; the other three are OD-10's (answered yes, 2026-11-04), posted by `applyCashEvent`
 *  (`sync/till-cash.ts`, ADR 0064). */
export type TillDocumentKind = "over_short" | "paid_out" | "safe_drop" | "banking";

export interface TillDocumentInput {
  kind: TillDocumentKind;
  /** The §4.14 code — `TILL_OVER_SHORT` | `TILL_PAID_OUT` | `TILL_SAFE_DROP` | `TILL_BANKING`. */
  typeCode: string;
  shiftId: string;
  amount: Money;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveDate: string;
  attributedTo: string;
  description: string;
  clientRef: string | null;
}

/** The five §4.15 codes this file may be asked for, and the file that seeds each — so the refusal below
 *  tells an operator which seed pack has not been applied instead of "account not found". */
const SEEDED_BY: Readonly<Record<string, string>> = {
  "1100": "0c-base.json (0C)",
  "1110": "6a-pos-tenders.json (6A)",
  "1130": "6d-till.json (6D)",
  "5120": "6d-till.json (6D)",
  "5130": "6d-till.json (6D, OD-10)",
};

/**
 * The **draft** series for each till document kind — §4.14's `Series` column, which amendment A15 fixes as
 * the *policy* series (`policy.numbering.series`).
 *
 * **Why this column has to be written at all.** `app.document.series` is `text not null` **with no
 * default** (plan0A:1780). §4.3.6 only *updates* it at issue, so every insert in every plan supplies it
 * (plan0A:1608's `draftDocument` writes `'JV'`; 1a:2585 and 1a:3615 do the same) — and a header insert
 * that omits it dies on
 * `null value in column "series" of relation "document" violates not-null constraint`
 * **before `postDocument` is ever reached**, which is a confusing failure for a correct close.
 *
 * **Why a literal and not a read of the policy.** The value is overwritten within milliseconds:
 * `postDocument` step 1 issues the document, and 6A's `resolveSeries` recomputes the string as
 * `` `${policySeries}-${pos_terminal.code}` `` for any document carrying a `terminal_id` (amendment A15),
 * so the final `series` on every row this function writes is `TOS-<code>` / ⚠️ `TPO-`/`TSD-`/`TBK-<code>`
 * regardless of what the draft held. Reading `posting_policy.definition->'numbering'->>'series'` here to
 * obtain a value that is discarded would be a second policy read outside `resolvePolicy` — which is the
 * thing §4.3.1 gives `postDocument` sole custody of. These four literals are §4.14 register values, in
 * this slice's declared namespace list (Global Constraint 13), and `TillDocumentKind` makes the record
 * exhaustive: a fifth kind does not compile without its row.
 */
const SERIES_FOR: Readonly<Record<TillDocumentKind, string>> = {
  over_short: "TOS",
  paid_out: "TPO", // OD-10
  safe_drop: "TSD", // OD-10
  banking: "TBK", // OD-10
};

/**
 * `app.account.code` → id, or a refusal naming the code and its seed file.
 *
 * This is hazard 33's "a slice consuming a code it did not seed asserts that the account resolves" in code
 * rather than only in a test: `postDocument` would otherwise fail at step 10 on a null `account_id` with a
 * message about a NOT NULL constraint, in the slice that did not write the seed file.
 */
export async function resolveAccountByCode(
  sp: Sql,
  companyId: string,
  code: string,
): Promise<string> {
  const [row] = await sp<{ id: string }[]>`
    select id from app.account
     where company_id = ${companyId} and code = ${code} and is_group = false and archived_at is null`;
  if (!row) {
    throw new SyncError(
      "ERR_NOT_FOUND",
      `account ${code} is not in company ${companyId}; it is seeded by ${SEEDED_BY[code] ?? "an unregistered file"}` +
        ` — run \`bun run seed --tenant <id> --only chart-of-accounts\``,
    );
  }
  return row.id;
}

/**
 * The company's LOCAL date for an instant, which is the `effective_date` every till document takes.
 *
 * **Never `String(iso).slice(0, 10)`.** That is the UTC date, and a Malaysian shop closing at 07:00 MYT on
 * 1 February is 23:00 UTC on 31 January — the document would post into January and, if January is closed,
 * die on `ERR_PERIOD_NOT_OPEN` with a message about a period the operator did not choose. 6A derives a
 * ticket's `effective_date` as `date(soldAt at time zone company.timezone)` (its `ticketEffectiveDate`
 * helper does the same thing for its own test), and every till document uses that one derivation so a
 * shift's tickets and its close land in one fiscal period.
 */
export async function tillEffectiveDate(
  sp: Sql,
  companyId: string,
  instant: string,
): Promise<string> {
  const [row] = await sp<{ d: string }[]>`
    select date(${instant}::timestamptz at time zone
                (select timezone from app.company where id = ${companyId}))::text as d`;
  return row!.d;
}

/**
 * Drafts a two-line `account` document for a till event and posts it through `postDocument`.
 *
 * **It computes nothing and posts everything** (Global Constraint 1, hazard 22). There is no
 * `insert into app.ledger_entry` in this file: the two `document_line` rows carry a magnitude on `debit`
 * or on `credit`, the `TILL_OVER_SHORT` policy's two JOURNAL-shaped rules turn them into planned ledger
 * lines, and 1A's `insertLines` writes the ledger. `posting-only-tables` (§3.7.5) allows
 * `packages/db/src/posting/**` for exactly this kind of file and would fail the build on a ledger insert
 * anywhere else — which is why this function lives here and not in `sync/`.
 *
 * **The magnitude is always positive and the two codes carry the direction** (§4.4.2 A9). The caller
 * chooses which code is the debit and which the credit; this function never reads `amount.isNegative()`,
 * and a caller that passed a negative `amount` would die on `document_line`'s `check (debit >= 0)` — which
 * is the right place for that to fail.
 *
 * **The terminal acts, the human is attributed** (hazard 19). `created_by` and `posted_by` come from the
 * column default `app.current_actor()`, which is the terminal principal resolved from the signed call;
 * `attributed_to` is `input.attributedTo` and is a data column. No line here puts a payload principal into
 * an actor column.
 */
export async function buildTillDocument(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  input: TillDocumentInput,
): Promise<PostResult> {
  if (input.amount.isNegative() || input.amount.isZero()) {
    // A zero document would reach §4.3.2 step 6, plan two zero lines, have both dropped by the zero-drop,
    // and raise ERR_DOC_NO_LINES from step 6's OUTPUT case — a confusing error for a legitimate exact
    // count. The caller decides not to post instead, and this guard makes that contract explicit.
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${input.typeCode} for shift ${input.shiftId}: amount must be a positive magnitude, received ${input.amount.toString()}`,
    );
  }

  const [type] = await sp<{ id: string }[]>`
    select id from app.document_type
     where company_id = ${terminal.companyId} and code = ${input.typeCode} and archived_at is null`;
  if (!type) {
    throw new SyncError(
      "ERR_NOT_FOUND",
      `document type ${input.typeCode} is not seeded in company ${terminal.companyId}` +
        ` — run \`bun run seed --tenant <id> --only document-types\``,
    );
  }

  const debitAccountId = await resolveAccountByCode(sp, terminal.companyId, input.debitAccountCode);
  const creditAccountId = await resolveAccountByCode(
    sp,
    terminal.companyId,
    input.creditAccountCode,
  );

  const [company] = await sp<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${terminal.companyId}`;
  // `Money.currency` IS the three-letter code — §4.2.1 declares `CurrencyCode = string & { __brand }` and
  // `Money<C extends CurrencyCode>`'s `readonly currency: C` (contracts:1335, 1350). There is no `.code`
  // member on it, and reaching for one is `TS2339`. This value flows into the base-currency comparison
  // below and into `document.currency`, so the slip would not have been cosmetic.
  const amountCurrency: string = input.amount.currency;
  // A till document in a non-base currency would need a rate, and 0D's rate lookup is a different task in
  // a different slice. A drawer in a foreign currency is a real shop but not a v1 one, and refusing is
  // honest: `ERR_RATE_NOT_FOUND` from deep inside `postDocument` would be a worse message than this.
  if (amountCurrency !== company!.base_currency) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${input.typeCode} for shift ${input.shiftId}: the shift is in ${amountCurrency} and the company's base` +
        ` currency is ${company!.base_currency}; a till document in a second currency needs an exchange rate` +
        ` this path does not resolve`,
    );
  }

  const [doc] = await sp<{ id: string }[]>`
    insert into app.document (
      tenant_id, company_id, document_type_id, branch_id, status, series, effective_date,
      currency, exchange_rate, attributed_to, terminal_id, shift_id, client_ref, notes)
    values (
      app.current_tenant(), ${terminal.companyId}, ${type.id}, ${terminal.branchId}, 'draft',
      ${SERIES_FOR[input.kind]}, ${input.effectiveDate}::date, ${amountCurrency}, 1, ${input.attributedTo},
      ${terminal.terminalId}, ${input.shiftId}, ${input.clientRef}, ${input.description})
    returning id`;

  const magnitude = input.amount.toString();
  // Two `kind = 'account'` lines in the §4.3.4 base shape — `debit`/`credit` are the columns the policy's
  // two `each_line` rules address, and each carries a non-negative magnitude with the other at 0.
  await sp`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, description,
                                   account_id, debit, credit, amount)
    values (app.current_tenant(), ${terminal.companyId}, ${doc!.id}, 1, 'account', ${input.description},
            ${debitAccountId}, ${magnitude}, 0, ${magnitude}),
           (app.current_tenant(), ${terminal.companyId}, ${doc!.id}, 2, 'account', ${input.description},
            ${creditAccountId}, 0, ${magnitude}, ${magnitude})`;

  // `postDocument` issues (assigning TOS-<terminal code> through 6A's resolveSeries), resolves the policy
  // pinned by effective date, evaluates it, balances in base, writes the ledger and the BRANCH dimension,
  // MERGEs account_balance and flips the status — §4.3.2 steps 1–15. Nothing above duplicates any of it.
  await setEventContext(sp, { reason: input.description, attributedTo: input.attributedTo });
  return postDocument(sp, ctx, { documentId: doc!.id });
}
