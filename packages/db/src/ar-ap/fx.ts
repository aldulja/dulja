// packages/db/src/ar-ap/fx.ts
//
// Slice 4B (ADR 0047, a proposal implemented ahead of approval). FX difference on settlement and at period
// end, both as FX_REVALUATION documents through 1A's frozen postDocument. Nothing here writes a ledger,
// movement or projection table: every function drafts app.document + app.document_line rows and hands over
// (hazard 22, the posting-only-tables lint).
//
// Both FX documents carry BASE amounts in the base currency at exchange_rate 1.00000000, so the ledger_entry
// CHECK base = round(value × rate, 4) holds by construction. The one place a rate is applied is `toBase`
// (§4.2.1: round(value × rate, 4), HALF_AWAY_FROM_ZERO — the arithmetic the CHECK itself uses); no product of
// an amount and a rate is spelled anywhere else in this file (SAH-012, SAH-019).
//
// One direction rule for both halves, in DEBIT-POSITIVE terms on the subject account: a positive delta debits
// the subject account and credits the result account, a negative one does the reverse, and
//     resultAccount = resultSide === "credit" ? 4900 : 5910
// with no reference to the party's kind or the account's type. Both document_line amounts are non-negative
// magnitudes and the direction lives in debit/credit, so §4.4.2 A9 is satisfied by construction.
//
// A REALISED document carries its settlement's party_id (ADR 0047 decision 3), so partyBalance and the
// credit-control read (0045) see the correction the control account carries; app.party_ageing_rows excludes
// FX_REVALUATION explicitly (its rule 5) and allocateSettlement refuses one on either side, so it is never an
// open item. The UNREALISED document is company-level and names no party. The party is also on the lines'
// custom_fields, beside `fxKind` (contracts §4.14, round 8 amendment 5).
import { Money, currency, toBase, type CurrencyCode, type ExchangeRate } from "@dulja/domain";
import type { Sql } from "postgres";
import type { JobClient } from "../jobs/enqueue";
import { PostingError } from "../posting/errors";
import { postDocument } from "../posting/post";
import { reverseDocument } from "../posting/reverse";
import type { TenantContext } from "../with-tenant";
import { ageingRows } from "./ageing";
import { allocateSettlement, type AllocationLine } from "./allocation";

/** §4.14's one 4B row: accounting / internal / none / series FXR / accounting.journal.post. */
export const FX_REVALUATION_CODE = "FX_REVALUATION" as const;

/** The three §4.15 codes this slice RESOLVES. All three are 0C's; this slice seeds none (hazard 33). */
export const FX_ACCOUNT_CODES = { gain: "4900", loss: "5910", rounding: "5920" } as const;

export interface FxAccounts {
  gainAccountId: string;
  lossAccountId: string;
  roundingAccountId: string;
}

/**
 * Resolves `4900` and `5910` by code, and `5920` through `company.fx_rounding_account_id` (0C's wiring,
 * spec:2001), for one company. Fail closed — never a null account and never a fallback (hazard 33): 0C seeds
 * all three, and a company missing one has not had the chart pack applied.
 */
export async function resolveFxAccounts(tx: Sql, companyId: string): Promise<FxAccounts> {
  const rows = await tx<{ code: string; id: string }[]>`
    select code, id::text as id from app.account
     where company_id = ${companyId}
       and code = any(${[FX_ACCOUNT_CODES.gain, FX_ACCOUNT_CODES.loss]}::text[])
       and is_group = false and archived_at is null`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of [FX_ACCOUNT_CODES.gain, FX_ACCOUNT_CODES.loss]) {
    if (!byCode.has(code)) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `company ${companyId} cannot resolve account code ${code} (§4.15: seeded by 0C in chart-of-accounts/0c-base.json) — apply \`bun run seed --tenant <id> --only chart-of-accounts\``,
      );
    }
  }
  const [company] = await tx<{ rounding: string | null }[]>`
    select fx_rounding_account_id::text as rounding from app.company where id = ${companyId}`;
  if (!company?.rounding) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `company ${companyId} has no fx_rounding_account_id (${FX_ACCOUNT_CODES.rounding}; spec:2001, 0C's seed task)`,
    );
  }
  return {
    gainAccountId: byCode.get(FX_ACCOUNT_CODES.gain)!,
    lossAccountId: byCode.get(FX_ACCOUNT_CODES.loss)!,
    roundingAccountId: company.rounding,
  };
}

/** The company's FX_REVALUATION type. `company_id` is not optional: `document_type` is unique per company and
 *  `app.document`'s FK checks the tenant only, so an unfiltered lookup would post under a sibling's type
 *  (3B's `resolveAdjustmentAccounts` states the same trap). */
async function fxDocumentType(tx: Sql, companyId: string): Promise<string> {
  const [type] = await tx<{ id: string }[]>`
    select id::text as id from app.document_type
     where company_id = ${companyId} and code = ${FX_REVALUATION_CODE} and archived_at is null`;
  if (!type) {
    throw new PostingError(
      "ERR_POLICY_NOT_FOUND",
      `document type ${FX_REVALUATION_CODE} is not configured for company ${companyId} — apply \`bun run seed --tenant <id> --only document-types\``,
    );
  }
  return type.id;
}

interface FxLine {
  accountId: string;
  /** Non-negative 4-dp magnitudes, base currency. Exactly one of the two is non-zero. */
  debit: string;
  credit: string;
  description: string;
  customFields: Record<string, string>;
}

/** Drafts one FX_REVALUATION, posts it through `postDocument`, and returns its id. The ONLY writer of a
 *  document in this module. */
async function draftAndPostFx(
  tx: Sql,
  ctx: TenantContext,
  input: {
    companyId: string;
    branchId: string;
    baseCurrency: string;
    effectiveDate: string;
    /** The settlement's party for a realised document; null for the company-level unrealised one. */
    partyId: string | null;
    lines: readonly FxLine[];
    jobs?: JobClient | undefined;
  },
): Promise<string> {
  const documentTypeId = await fxDocumentType(tx, input.companyId);
  // Base currency at the identity rate, so `rate_source` is `unit` — the spelling every 4A writer uses for
  // the identity pair (plan0A:1787's comment).
  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       rate_source, party_id, branch_id)
    values (app.current_tenant(), ${input.companyId}, ${documentTypeId}, ${"FXR"},
            ${input.effectiveDate}::date, ${input.baseCurrency}, ${"1.00000000"}, ${"unit"},
            ${input.partyId}, ${input.branchId})
    returning id::text as id`;
  if (!doc) {
    throw new PostingError(
      "ERR_INTERNAL",
      `the ${FX_REVALUATION_CODE} header for company ${input.companyId} was written but returned no id`,
    );
  }
  for (const [i, l] of input.lines.entries()) {
    await tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, account_id, debit, credit,
         custom_fields)
      values (app.current_tenant(), ${input.companyId}, ${doc.id}, ${i + 1}, 'account',
              ${l.description}, ${l.accountId}, ${l.debit}, ${l.credit},
              ${JSON.stringify(l.customFields)}::text::jsonb)`;
  }
  await postDocument(tx, ctx, {
    documentId: doc.id,
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });
  return doc.id;
}

/** The one direction rule (ADR 0047). `delta` is signed, base currency, debit-positive on the subject. */
function fxPair(
  subjectAccountId: string,
  delta: Money,
  accounts: FxAccounts,
  description: string,
  customFields: Record<string, string>,
): FxLine[] {
  const magnitude = delta.abs().toString();
  const subjectSide = delta.isNegative() ? "credit" : "debit";
  const resultSide = subjectSide === "debit" ? "credit" : "debit";
  const resultAccountId = resultSide === "credit" ? accounts.gainAccountId : accounts.lossAccountId;
  return [
    {
      accountId: subjectAccountId,
      description,
      debit: subjectSide === "debit" ? magnitude : "0.0000",
      credit: subjectSide === "credit" ? magnitude : "0.0000",
      customFields,
    },
    {
      accountId: resultAccountId,
      description,
      debit: resultSide === "debit" ? magnitude : "0.0000",
      credit: resultSide === "credit" ? magnitude : "0.0000",
      customFields,
    },
  ];
}

/** The realised half's grouping: one line pair per (relief date, settled document). */
const pairKey = (onDate: string, settledId: string): string => `${onDate}/${settledId}`;

/** A figure's sign flipped, without ever producing a negative zero on the wire. */
const negated = (m: Money): Money => (m.isZero() ? m : m.negate());

/**
 * Posts the REALISED difference of one settlement of `companyId` as FX_REVALUATION documents, and returns
 * null when there is nothing to post.
 *
 * It reads the STORED `allocation.fx_difference` and never recomputes it: 4A owns that arithmetic, and the
 * §4.8.2 tie-out is self-consistent for any value of it (ADR 0047's table). What it posts is the DIFFERENCE
 * between what the settlement's live allocations call for and what realised FX documents for the settlement
 * already carry on the party's control account — keyed, per amendment 5, by the `fxKind` probe alone
 * (`custom_fields.fxKind = 'realised'` and `settlementDocumentId`; no `document_link` row, which 0037's
 * trigger refuses for a posted target). So a second call posts nothing, a call after `unallocate` posts the
 * unwinding entry, and a call after a re-allocation posts the new difference: the tie-out holds after every
 * allocation change, not only after the first.
 *
 * **Dated where the ageing relieves the pair.** `app.party_ageing_rows` counts an allocation as live from its
 * own accounting date, `allocation.effective_date`, until its un-allocation's, `allocation.unallocated_on`
 * (0046's allocation_guard stamps both), so an allocation's difference is posted on the first and withdrawn
 * on the second (code review B1). The first is the later of the two documents' dates — dating it on the
 * settlement alone would break the tie-out, for the days in between, of a deposit received before the invoice
 * it pays — moved forward to the first open period when that date's period is not open: dated on the
 * documents, an allocation made after their period closed could not post its difference at all, the
 * allocation rolled back, and the invoice could never be reversed. One document per such date, one line pair
 * per settled document.
 *
 * **Direction.** `fx_difference` is settlement base − settled base (§4.8.1). The settlement relieves the
 * control account on its own side (`side`: −1 a receipt crediting 1200, +1 a payment debiting 2100 — and +1
 * a refund debiting 1200, if a policy ever posts one: none does yet, ADR 0047 open question 5), and relieved
 * `fx_difference` more than the settled document charged; the correction
 * on the control account is therefore `−side × fx_difference`, debit-positive. That one expression gives a
 * customer's over-payment a debit to 1200 and a credit to 4900, and a vendor's over-payment a credit to 2100
 * and a debit to 5910.
 *
 * Posting requires `accounting.journal.post` (the policy's `approval.post`, spec §3.6.2's sentence for this
 * type), checked by 2B's status trigger against the caller at the settlement's branch.
 */
export async function postSettlementFxDifference(
  tx: Sql,
  ctx: TenantContext,
  input: { companyId: string; settlementDocumentId: string; jobs?: JobClient | undefined },
): Promise<{ fxDocumentIds: string[]; difference: Money } | null> {
  const settlementId = input.settlementDocumentId;
  // The lock `allocateSettlement` takes on the settlement (re-entrant inside one transaction), so two
  // concurrent calls for one settlement cannot both read "nothing posted yet" and post the difference twice.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`allocation:${settlementId}`}, 0))`;

  const [settlement] = await tx<
    {
      branch_id: string;
      base_currency: string;
      party_id: string | null;
      control_account_id: string | null;
      side: number;
    }[]
  >`
    with s as (
      select d.id, d.branch_id, c.base_currency, d.party_id,
             -- the ageing's own control account (0045's one definition), so the correction lands where
             -- the tie-out reads it
             app.party_control_account(p) as control_account_id
        from app.document d
        join app.company c on c.id = d.company_id
        left join app.party p on p.id = d.party_id
       where d.id = ${settlementId} and d.company_id = ${input.companyId}
    )
    select s.branch_id::text as branch_id, s.base_currency::text as base_currency,
           s.party_id::text as party_id, s.control_account_id::text as control_account_id,
           coalesce((select sign(sum(le.base_debit - le.base_credit))::int
                       from app.ledger_entry le
                      where le.document_id = s.id and le.account_id = s.control_account_id), 0) as side
      from s`;
  if (!settlement) {
    throw new PostingError(
      "ERR_NOT_FOUND",
      `settlement ${settlementId} is not a document of company ${input.companyId}`,
    );
  }
  if (settlement.party_id === null || settlement.control_account_id === null) return null;
  const partyId = settlement.party_id;
  const control = settlement.control_account_id;
  const base = currency(settlement.base_currency) as CurrencyCode;

  // What the settlement's allocations call for, per (relief date, settled document), in fx_difference terms:
  // each one's difference on its accounting date, and — once unallocated — its withdrawal on the
  // un-allocation's (B1). An allocation unallocated on its own date nets to nothing on that one day.
  const needed = await tx<{ on_date: string; settled_id: string; fx: string }[]>`
    select to_char(x.on_date, 'YYYY-MM-DD') as on_date,
           x.settled_document_id::text as settled_id,
           sum(x.fx)::numeric(19,4)::text as fx
      from (select a.effective_date as on_date, a.settled_document_id, a.fx_difference as fx
              from app.allocation a
             where a.company_id = ${input.companyId}
               and a.settlement_document_id = ${settlementId}
            union all
            select a.unallocated_on, a.settled_document_id, -a.fx_difference
              from app.allocation a
             where a.company_id = ${input.companyId}
               and a.settlement_document_id = ${settlementId}
               and a.unallocated_at is not null) x
     group by 1, 2`;
  // What realised FX documents for this settlement already carry on the control account, debit-positive. A
  // 'reversed' original and its reversal (whose lines reverseDocument copies, custom_fields included) both
  // count, so the pair nets to zero.
  const posted = await tx<{ on_date: string; settled_id: string; net: string }[]>`
    select to_char(d.effective_date, 'YYYY-MM-DD') as on_date,
           coalesce(l.custom_fields->>'settledDocumentId', '') as settled_id,
           sum(l.debit - l.credit)::numeric(19,4)::text as net
      from app.document d
      join app.document_type t on t.id = d.document_type_id
      join app.document_line l on l.document_id = d.id
     where d.company_id = ${input.companyId}
       and t.code = ${FX_REVALUATION_CODE}
       and d.status in ('posted', 'reversed')
       and l.account_id = ${control}
       and l.custom_fields->>'fxKind' = 'realised'
       and l.custom_fields->>'settlementDocumentId' = ${settlementId}
     group by 1, 2`;

  const deltas = new Map<string, { onDate: string; settledId: string; control: Money }>();
  const add = (onDate: string, settledId: string, amount: Money) => {
    const k = pairKey(onDate, settledId);
    const prior = deltas.get(k);
    deltas.set(k, {
      onDate,
      settledId,
      control: prior === undefined ? amount : prior.control.add(amount),
    });
  };
  for (const n of needed) {
    const fx = Money.of(n.fx, base);
    if (fx.isZero()) continue;
    if (settlement.side === 0) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `settlement ${settlementId} does not move its party's control account ${control}, so its realised FX difference has no side to correct`,
      );
    }
    // −side × fx_difference, debit-positive on the control account.
    add(n.on_date, n.settled_id, settlement.side > 0 ? negated(fx) : fx);
  }
  for (const p of posted) add(p.on_date, p.settled_id, negated(Money.of(p.net, base)));

  const open = [...deltas.values()]
    .filter((d) => !d.control.isZero())
    .toSorted((x, y) =>
      pairKey(x.onDate, x.settledId).localeCompare(pairKey(y.onDate, y.settledId)),
    );
  if (open.length === 0) return null;

  const accounts = await resolveFxAccounts(tx, input.companyId);
  const fxDocumentIds: string[] = [];
  let difference = Money.zero(base);
  for (const onDate of new Set(open.map((d) => d.onDate))) {
    const lines = open
      .filter((d) => d.onDate === onDate)
      .flatMap((d) => {
        // Back into fx_difference terms for the returned figure: fx = −side × control.
        difference = difference.add(settlement.side > 0 ? negated(d.control) : d.control);
        return fxPair(control, d.control, accounts, `realised FX on settlement ${settlementId}`, {
          fxKind: "realised",
          settlementDocumentId: settlementId,
          settledDocumentId: d.settledId,
          partyId,
        });
      });
    fxDocumentIds.push(
      await draftAndPostFx(tx, ctx, {
        companyId: input.companyId,
        branchId: settlement.branch_id,
        baseCurrency: settlement.base_currency,
        effectiveDate: onDate,
        partyId,
        lines,
        jobs: input.jobs,
      }),
    );
  }
  return { fxDocumentIds, difference };
}

/**
 * `allocateSettlement` followed by `postSettlementFxDifference`, in the caller's ONE transaction (ADR 0047):
 * posting the difference in a later, separate call would leave the §4.8.2 tie-out false in between, which is
 * a state a reader of the ageing report could observe.
 */
export async function settleWithFx(
  tx: Sql,
  ctx: TenantContext,
  input: {
    companyId: string;
    settlementDocumentId: string;
    lines: readonly AllocationLine[];
    jobs?: JobClient | undefined;
  },
): Promise<{ allocationIds: string[]; fxDifference: Money; fxDocumentIds: string[] }> {
  const allocated = await allocateSettlement(tx, ctx, {
    companyId: input.companyId,
    settlementDocumentId: input.settlementDocumentId,
    lines: input.lines,
  });
  const fx = await postSettlementFxDifference(tx, ctx, {
    companyId: input.companyId,
    settlementDocumentId: input.settlementDocumentId,
    jobs: input.jobs,
  });
  return { ...allocated, fxDocumentIds: fx?.fxDocumentIds ?? [] };
}

export interface RevaluationLine {
  accountId: string;
  accountCode: string;
  currency: string;
  /** The exposure in `currency`, debit-positive on the account. */
  amountCcy: string;
  /** Base the ledger carries for that exposure: each open item at its own rate, plus any unrealised
   *  revaluation still outstanding on it. Debit-positive. */
  carriedBase: string;
  /** `toBase(amountCcy, rate)`. */
  revaluedBase: string;
  /** revaluedBase − carriedBase: what this revaluation posts on the account, debit-positive. */
  delta: string;
  rate: string;
}

export interface RevaluationResult {
  /** null when nothing needed revaluing, or the period was already revalued. */
  documentId: string | null;
  fiscalPeriodId: string;
  asOf: string;
  /** The currency of `carriedBase`, `revaluedBase` and `delta` — returned so a caller naming both of a
   *  line's currencies needs no second query. */
  baseCurrency: string;
  lines: readonly RevaluationLine[];
}

/**
 * One UNREALISED FX_REVALUATION per company per period, dated the period's `ends_on` (§4.14's row).
 *
 * **Party control accounts are revalued from the OPEN ITEMS** (`ageingRows` at `ends_on`), not from
 * `account_balance`'s per-currency rows, which on a party control account are not an open-item view (ADR
 * 0046, amendment 4). **Every other account is revalued only when it is DENOMINATED in a foreign currency**
 * (`account.currency` set and not the base currency, asset or liability, not a group) — ADR 0047's narrowing
 * of the plan's "every monetary account carrying a non-base balance": a multi-currency account's non-base rows
 * cannot be told from a corridor's document-currency leg (4A's PURCHASE_INVOICE debits `2150` in the invoice
 * currency while 3C's GOODS_RECEIPT credits it in base), and revaluing that leg would restate a clearing
 * account that holds no exposure. Inventory, revenue and expense accounts are never revalued.
 *
 * `carriedBase` includes any unrealised revaluation still outstanding on the (account, currency) — so a
 * period whose predecessor was never reversed is revalued by the increment, not twice.
 *
 * Refused: a period not of the company (ERR_PERIOD_NOT_FOUND); an exposed currency with no `app.rate_for`
 * row on or before `ends_on` (ERR_RATE_NOT_FOUND naming the pair — never 1, never the previous row's rate:
 * SAH-012, SAH-014); a period that is not open (postDocument's ERR_PERIOD_NOT_OPEN).
 */
export async function revalueAtPeriodEnd(
  tx: Sql,
  ctx: TenantContext,
  input: { companyId: string; fiscalPeriodId: string; jobs?: JobClient | undefined },
): Promise<RevaluationResult> {
  const [period] = await tx<{ ends_on: string }[]>`
    select to_char(ends_on, 'YYYY-MM-DD') as ends_on from app.fiscal_period
     where id = ${input.fiscalPeriodId} and company_id = ${input.companyId}`;
  if (!period) {
    throw new PostingError(
      "ERR_PERIOD_NOT_FOUND",
      `fiscal period ${input.fiscalPeriodId} is not a period of company ${input.companyId}`,
    );
  }
  const asOf = period.ends_on;
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency::text as base_currency from app.company where id = ${input.companyId}`;
  const baseCode = company!.base_currency;
  const base = currency(baseCode) as CurrencyCode;
  const result = (
    documentId: string | null,
    lines: readonly RevaluationLine[],
  ): RevaluationResult => ({
    documentId,
    fiscalPeriodId: input.fiscalPeriodId,
    asOf,
    baseCurrency: baseCode,
    lines,
  });

  // One revaluation per company per period, serialised so two concurrent runs cannot both pass the guard.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fx-revaluation:${input.companyId}/${asOf}`}, 0))`;
  // `status in ('posted','reversed')` — NOT `= 'posted'`: reverseRevaluation leaves the ORIGINAL 'reversed',
  // and a `= 'posted'` guard would then count zero and revalue the period a second time. A REVERSAL never
  // counts (`reverses_document_id is null`): it copies the original's `fxKind` lines and may be dated on any day
  // from the original's on, so one dated on a LATER period's end (January's, reversed on February 28) hid that
  // period's own revaluation (MON-07). `exists`, not a join, because a revaluation posts a pair of marked lines
  // per exposure.
  const [already] = await tx<{ done: boolean }[]>`
    select exists (
      select 1 from app.document d
        join app.document_type t on t.id = d.document_type_id
       where t.code = ${FX_REVALUATION_CODE} and d.company_id = ${input.companyId}
         and d.status in ('posted', 'reversed') and d.effective_date = ${asOf}::date
         and d.reverses_document_id is null
         and exists (select 1 from app.document_line l
                      where l.document_id = d.id and l.custom_fields->>'fxKind' = 'unrealised')) as done`;
  if (already?.done) return result(null, []);

  type Exposure = { accountId: string; currency: string; amountCcy: Money; carriedBase: Money };
  const exposures = new Map<string, Exposure>();
  const addExposure = (accountId: string, ccy: string, amountCcy: Money, carriedBase: Money) => {
    const k = `${accountId}/${ccy}`;
    const prior = exposures.get(k);
    exposures.set(
      k,
      prior === undefined
        ? { accountId, currency: ccy, amountCcy, carriedBase }
        : {
            accountId,
            currency: ccy,
            amountCcy: prior.amountCcy.add(amountCcy),
            carriedBase: prior.carriedBase.add(carriedBase),
          },
    );
  };

  // (a) party control exposure, from the open items. `ageingRows` is positive-for-open in the PARTY's
  //     orientation — 0048 flips a vendor's figures — so a vendor's are flipped back into the ledger's
  //     debit-positive orientation, by the same `kind` test the function flipped them by.
  const parties = await tx<{ id: string; vendor: boolean; control_account_id: string | null }[]>`
    select p.id::text as id, (p.kind = 'vendor') as vendor,
           app.party_control_account(p)::text as control_account_id
      from app.party p where p.company_id = ${input.companyId}`;
  const partyOf = new Map(parties.map((p) => [p.id, p]));
  const controlIds = new Set(
    parties.map((p) => p.control_account_id).filter((id): id is string => id !== null),
  );
  for (const row of await ageingRows(tx, { companyId: input.companyId, asOf })) {
    if (row.currency === baseCode) continue;
    const party = partyOf.get(row.partyId);
    if (!party?.control_account_id) continue;
    const ccy = currency(row.currency) as CurrencyCode;
    const amount = Money.of(row.amount, ccy);
    const carried = Money.of(row.baseAmount, base);
    addExposure(
      party.control_account_id,
      row.currency,
      party.vendor ? negated(amount) : amount,
      party.vendor ? negated(carried) : carried,
    );
  }

  // (b) accounts DENOMINATED in a foreign currency, from the ledger up to asOf in that currency.
  const denominated = await tx<
    { account_id: string; currency: string; ccy: string; base: string }[]
  >`
    select a.id::text as account_id, a.currency::text as currency,
           coalesce(sum(le.debit - le.credit), 0)::numeric(19,4)::text           as ccy,
           coalesce(sum(le.base_debit - le.base_credit), 0)::numeric(19,4)::text as base
      from app.account a
      join app.ledger_entry le
        on le.account_id = a.id and le.currency = a.currency and le.effective_date <= ${asOf}::date
     where a.company_id = ${input.companyId}
       and a.currency is not null and a.currency <> ${baseCode}
       and a.is_group = false
       and a.type in ('asset', 'liability')
     group by a.id, a.currency`;
  for (const b of denominated) {
    if (controlIds.has(b.account_id)) continue; // (a) covered it, from the better source
    const ccy = currency(b.currency) as CurrencyCode;
    addExposure(b.account_id, b.currency, Money.of(b.ccy, ccy), Money.of(b.base, base));
  }

  // Unrealised revaluation still outstanding on each (account, currency) as of asOf — the subject legs of
  // earlier FX_REVALUATION documents and of their reversals (whose lines carry the copied custom_fields).
  const outstanding = await tx<{ account_id: string; currency: string; net: string }[]>`
    select l.account_id::text as account_id, l.custom_fields->>'revaluedCurrency' as currency,
           sum(l.debit - l.credit)::numeric(19,4)::text as net
      from app.document d
      join app.document_type t on t.id = d.document_type_id
      join app.document_line l on l.document_id = d.id
     where d.company_id = ${input.companyId}
       and t.code = ${FX_REVALUATION_CODE}
       and d.status in ('posted', 'reversed')
       and d.effective_date <= ${asOf}::date
       and l.custom_fields->>'fxKind' = 'unrealised'
       and l.account_id::text = l.custom_fields->>'revaluedAccountId'
     group by 1, 2`;
  for (const o of outstanding) {
    const net = Money.of(o.net, base);
    if (net.isZero()) continue;
    // An exposure the open items no longer show (everything settled) still has its restatement to undo.
    addExposure(o.account_id, o.currency, Money.zero(currency(o.currency) as CurrencyCode), net);
  }

  const codeOf = new Map(
    (
      await tx<{ id: string; code: string }[]>`
        select id::text as id, code from app.account where company_id = ${input.companyId}`
    ).map((r) => [r.id, r.code]),
  );
  const ordered = [...exposures.values()]
    .filter((e) => !(e.amountCcy.isZero() && e.carriedBase.isZero()))
    .toSorted((x, y) =>
      `${codeOf.get(x.accountId)}/${x.currency}`.localeCompare(
        `${codeOf.get(y.accountId)}/${y.currency}`,
      ),
    );
  if (ordered.length === 0) return result(null, []);

  const detail: RevaluationLine[] = [];
  const toPost: { exposure: Exposure; delta: Money }[] = [];
  for (const e of ordered) {
    const [rate] = await tx<
      { rate: string | null; effective_from: string | null; source: string | null }[]
    >`
      select rate::text as rate, to_char(effective_from, 'YYYY-MM-DD') as effective_from, source
        from app.rate_for(${input.companyId}, ${e.currency}, ${baseCode}, ${asOf}::date)`;
    if (!rate?.rate) {
      // SAH-012/SAH-014: never assume 1 and never reuse another currency's or an earlier loop's rate.
      throw new PostingError(
        "ERR_RATE_NOT_FOUND",
        `no exchange_rate row for ${e.currency} → ${baseCode} effective on or before ${asOf} (company ${input.companyId}); enter one before revaluing`,
      );
    }
    const quote: ExchangeRate = {
      from: currency(e.currency) as CurrencyCode,
      to: base,
      rate: rate.rate,
      effectiveFrom: rate.effective_from ?? asOf,
      source: rate.source ?? "",
    };
    // The ONE conversion (§4.2.1, SAH-019): round(value × rate, 4), HALF_AWAY_FROM_ZERO — toBase.
    const revaluedBase = toBase(e.amountCcy, quote);
    const delta = revaluedBase.subtract(e.carriedBase);
    detail.push({
      accountId: e.accountId,
      accountCode: codeOf.get(e.accountId) ?? "",
      currency: e.currency,
      amountCcy: e.amountCcy.toString(),
      carriedBase: e.carriedBase.toString(),
      revaluedBase: revaluedBase.toString(),
      delta: delta.toString(),
      rate: rate.rate,
    });
    if (!delta.isZero()) toPost.push({ exposure: e, delta });
  }
  if (toPost.length === 0) return result(null, detail);

  const accounts = await resolveFxAccounts(tx, input.companyId);
  // Head office, resolved BY CODE and never "the first row": app.document.branch_id is NOT NULL and a
  // company-level revaluation belongs to head office, so `order by code limit 1` would hand the whole
  // unrealised FX to whichever branch sorts first in 7C's branch P&L. `HQ` is Plan 0A's seeded value.
  const [hq] = await tx<{ id: string }[]>`
    select v.id::text as id from app.dimension_value v
      join app.dimension_type t on t.id = v.dimension_type_id
     where t.code = 'BRANCH' and t.company_id = ${input.companyId} and v.code = 'HQ'
       and v.archived_at is null`;
  if (!hq) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `company ${input.companyId} has no live BRANCH dimension value with code HQ, and a company-level ${FX_REVALUATION_CODE} must carry one (app.document.branch_id is NOT NULL)`,
    );
  }
  const lines = toPost.flatMap(({ exposure: e, delta }) =>
    fxPair(
      e.accountId,
      delta,
      accounts,
      `unrealised FX on ${codeOf.get(e.accountId) ?? e.accountId} ${e.currency} at ${asOf}`,
      {
        fxKind: "unrealised",
        fiscalPeriodId: input.fiscalPeriodId,
        revaluedAccountId: e.accountId,
        revaluedCurrency: e.currency,
      },
    ),
  );
  const documentId = await draftAndPostFx(tx, ctx, {
    companyId: input.companyId,
    branchId: hq.id,
    baseCurrency: baseCode,
    effectiveDate: asOf,
    partyId: null,
    lines,
    jobs: input.jobs,
  });
  return result(documentId, detail);
}

/**
 * Reverses one UNREALISED revaluation of `companyId` through 1A's frozen `reverseDocument` (D13) — §4.14's
 * "reversed at period start", so `effectiveDate` is normally the first day of the following period, which
 * must be open. A REALISED document is refused: it is undone by un-allocating (or reversing) its settlement,
 * never on its own (amendment 5).
 */
export async function reverseRevaluation(
  tx: Sql,
  ctx: TenantContext,
  input: {
    companyId: string;
    documentId: string;
    effectiveDate: string;
    jobs?: JobClient | undefined;
  },
): Promise<{ reversalDocumentId: string; number: bigint }> {
  const [doc] = await tx<{ unrealised: boolean; realised: boolean }[]>`
    select exists (select 1 from app.document_line l
                    where l.document_id = d.id and l.custom_fields->>'fxKind' = 'unrealised') as unrealised,
           exists (select 1 from app.document_line l
                    where l.document_id = d.id and l.custom_fields->>'fxKind' = 'realised') as realised
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.id = ${input.documentId} and d.company_id = ${input.companyId}
       and t.code = ${FX_REVALUATION_CODE}`;
  if (!doc) {
    throw new PostingError(
      "ERR_NOT_FOUND",
      `document ${input.documentId} is not an ${FX_REVALUATION_CODE} of company ${input.companyId}`,
    );
  }
  if (!doc.unrealised || doc.realised) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} is not an unrealised revaluation; a realised FX difference is undone through its settlement, never on its own`,
    );
  }
  return reverseDocument(tx, ctx, {
    documentId: input.documentId,
    effectiveDate: input.effectiveDate,
    reason: "period-start reversal of the unrealised FX revaluation (§4.14, ADR 0047)",
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });
}
