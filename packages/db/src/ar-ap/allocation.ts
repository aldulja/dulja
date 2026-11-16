import {
  Money,
  currency,
  parsePolicy,
  toBase,
  type CurrencyCode,
  type ExchangeRate,
} from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { codedError } from "./invoice";
import { isCreditNotePolicy, relievesPartyControl } from "./policy-shape";

/**
 * One settled document and how much of it this settlement pays. `amount` is in the SETTLED document's
 * currency and `settlementAmount` in the SETTLEMENT's (4B, cross-currency allocation — ADR 0047 decision 9,
 * a proposal): required when the two documents' currencies differ, and when they agree it may be omitted and
 * must otherwise equal `amount`.
 */
export interface AllocationLine {
  settledDocumentId: string;
  amount: Money;
  settlementAmount?: Money;
}

export interface AllocationRow {
  id: string;
  companyId: string;
  partyId: string;
  settlementDocumentId: string;
  settledDocumentId: string;
  /** 4-dp strings on the row; `{ amount, currency }` at the API. */
  amount: string;
  /** In the SETTLEMENT document's currency (4B); equal to `amount` on a same-currency row. */
  settlementAmount: string;
  baseAmount: string;
  fxDifference: string;
  allocatedBy: string;
  unallocatedAt: string | null;
  unallocatedBy: string | null;
  unallocationReason: string | null;
  createdAt: string;
  /** Three DERIVED read-only members, joined by `listAllocations` and stored in no column (contracts §4.8.1,
   *  amendment 11; 4B): the settled document's `currency`, in which `amount` is denominated, the settlement's
   *  `settlementCurrency`, in which `settlementAmount` is, and the company's `base_currency`, in which
   *  `baseAmount` and `fxDifference` are. */
  currency: string;
  settlementCurrency: string;
  baseCurrency: string;
}

export interface PartyBalance {
  byCurrency: Record<string, Money>;
  base: Money;
}

interface DocFacts {
  partyId: string | null;
  currency: string;
  baseCurrency: string;
  exchangeRate: string;
  rateSource: string | null;
  effectiveDate: string;
  status: string;
  /** Σ `total_incl_tax` of the lines, signed — a credit note's is negative (4A Task 8). The magnitude of a
   *  document that has NOT moved its control account only: once it has, the ledger's figure below is. */
  total: string;
  /** The document's exposure on its party's control account (`app.party_control_account`, 0045) in its OWN
   *  currency, debit-positive — the own-currency row of `app.document_control_exposure` (0129), the one
   *  derivation the ageing, the revaluation and `partyBalance` read too. For an ordinary document it is
   *  Σ (debit − credit) of its control rows. A foreign-currency document that moved the control account through a
   *  BASE-currency cost leg (a PURCHASE_RETURN relieves 2100 at `line.cost`, §4.7.3 amendment A4) has no control
   *  row in its own currency; its figure is its keyed total on the side the ledger moved (MON-01). */
  controlNet: string;
  /** The same row's base. For an ordinary document it is what the posting service put on the control account —
   *  Σ round(line × rate, 4) PER LINE, which is not round(Σ lines × rate, 4), so an allocation that closed a
   *  document at `toBase(total)` left the difference in the control account forever (A2). For a cost-leg document
   *  it is `round(controlNet × rate, 4)`: the price-versus-cost difference the cost leg also put there is a
   *  base-only residue that no allocation relieves, so it is never "realised" as FX (MON-11). */
  controlNetBase: string;
  /** The PINNED policy's `definition` (§4.3.2 step 13), null on a document that has not posted. */
  policy: unknown;
  /** True for a document that nets with the one it reversed: an ODD-depth full reversal
   *  (`app.document_reversal_depth`, 0048 — the one definition the ageing and bank matching read too). The
   *  reversal of a reversal — a re-deposited receipt — is even-depth, a live settlement, and false here; so is
   *  a partial credit note, which points at a still-`posted` invoice (Phase 4 review B4). */
  isFullReversal: boolean;
  /** True for a 4B FX_REVALUATION. A realised one names its party (ADR 0047) and moves the control account,
   *  but it is the correction of an allocation, never an open item: it neither settles nor is settled. */
  isFx: boolean;
}

/**
 * Header facts, the document's own total and its effect on the party's control account — one statement, so the
 * three cannot disagree. Bound to `companyId`: RLS bounds the tenant and nothing else, so an id alone would
 * reach a sibling company's document inside the same tenant (AGENTS.md).
 *
 * `lock` reads the document row `for share` — `allocateSettlement`'s read. `reverseDocument` takes the same row
 * `for update` before its "no live allocation" check, and the two conflict: an allocation that starts while a
 * reversal of either document is uncommitted waits for it and then reads `reversed`, and a reversal that starts
 * while an allocation is uncommitted waits and then sees the allocation. Without it the allocation read
 * `posted` from its snapshot and spent the receipt on an invoice the ledger no longer held (A1). The read-only
 * `openBalance` takes no lock.
 */
async function docFacts(
  tx: Sql,
  companyId: string,
  documentId: string,
  lock = false,
): Promise<DocFacts> {
  const [row] = await tx<DocFacts[]>`
    select d.party_id as "partyId", d.currency::text as currency, c.base_currency::text as "baseCurrency",
           d.exchange_rate::text as "exchangeRate", d.rate_source as "rateSource",
           to_char(d.effective_date, 'YYYY-MM-DD') as "effectiveDate", d.status::text as status,
           coalesce((select sum(dl.total_incl_tax) from app.document_line dl where dl.document_id = d.id), 0)
             ::numeric(19,4)::text as total,
           coalesce(x.amount, 0)::numeric(19,4)::text as "controlNet",
           coalesce(x.base_amount, 0)::numeric(19,4)::text as "controlNetBase",
           pp.definition as policy,
           coalesce(app.document_reversal_depth(d.id) % 2 = 1, false) as "isFullReversal",
           exists (select 1 from app.document_type t
                    where t.id = d.document_type_id and t.code = 'FX_REVALUATION') as "isFx"
      from app.document d
      join app.company c on c.id = d.company_id
      left join app.posting_policy pp on pp.id = d.posting_policy_id
      left join lateral app.document_control_exposure(d.id) x on x.currency = d.currency
     where d.id = ${documentId} and d.company_id = ${companyId}
     ${lock ? tx`for share of d` : tx``}`;
  if (row === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `document ${documentId} is not a document of company ${companyId}`,
    );
  }
  return row;
}

/**
 * The document's own rate, as the `ExchangeRate` `toBase` takes. **Every base conversion in this file goes
 * through `toBase`** (Global Constraint 5): `toBase` is `round(value × rate, 4)` HALF_AWAY_FROM_ZERO,
 * byte-for-byte the identity `ledger_entry`'s CHECK enforces (spec:1816, §4.2.1). A second spelling of that
 * arithmetic here would be a second answer, which is SAH-019 in a new place.
 */
function rateOf(facts: DocFacts): ExchangeRate {
  return {
    from: currency(facts.currency) as CurrencyCode,
    to: currency(facts.baseCurrency) as CurrencyCode,
    rate: facts.exchangeRate,
    effectiveFrom: facts.effectiveDate,
    source: facts.rateSource ?? "unit",
  };
}

/** Which side of the party's control account the document sits on: 1 debit, −1 credit, 0 neither. */
function sideOf(facts: DocFacts): -1 | 0 | 1 {
  const net = Money.of(facts.controlNet, currency(facts.currency) as CurrencyCode);
  return net.isZero() ? 0 : net.isNegative() ? -1 : 1;
}

/**
 * `|what the document put on its control account| − Σ live allocations` of a document — in EITHER role,
 * settlement or settled — in its own currency and in base (§4.8.1).
 *
 * **The magnitude is the LEDGER's, not the lines'** (code review 2026-09-29, A3). Once a document has moved
 * its party's control account, what it can settle or be settled by is what that posting put there —
 * `controlNet` in its currency, `controlNetBase` in base — and not Σ `total_incl_tax`. The two differ for any
 * policy that relieves the control account at another figure than the line total: a PURCHASE_RETURN debits
 * 2100 at `line.cost`, so one keyed at 120 and posted at an AVCO cost of 115 offered 120 of capacity, took
 * `remainingBase` 115 and "realised" a 5.0000 FX difference on a base-currency, rate-1 settlement; one keyed at
 * 0 could never be allocated at all. A document that has not moved the control account (not yet posted) has
 * no ledger figure, and its magnitude is its total — in base through `toBase`, at its own rate (spec:1816,
 * SAH-012). A foreign-currency document whose control legs are base-currency cost legs is measured on its
 * own-currency exposure — its keyed total, at its own rate (`docFacts`, 0129) — so its price-versus-cost
 * difference is never part of what it settles (MON-11).
 *
 * `.abs()` is deliberate and it is a MAGNITUDE, not a sign loss — and it is taken on the WHOLE, BEFORE the
 * allocations are subtracted, which is the only order that is arithmetic rather than nonsense. A credit note's
 * figure is negative (4A Task 8) and §4.8.1 makes a credit note a legal settlement or settled document, so for
 * a note of −100.0000 with 30.0000 allocated `|−100 − 30| = 130.0000` would report MORE than the note ever
 * had. `|−100| − 30 = 70.0000` is the figure every caller means, and `allocation.amount`'s `check (amount > 0)`
 * makes the magnitude the only thing it can be compared with. Which side of the ledger the document sits on is
 * `sideOf`'s question, not this figure's. `Money.of` parses the leading minus (0D's AMOUNT pattern), so no
 * second money parser is needed.
 */
async function openOf(
  tx: Sql,
  documentId: string,
  facts: DocFacts,
): Promise<{ document: Money; base: Money }> {
  const cur = currency(facts.currency) as CurrencyCode;
  const base = currency(facts.baseCurrency) as CurrencyCode;
  // BOTH roles consume the one magnitude. §4.8.1 lets a credit note settle an invoice AND be settled, and
  // counting only one role let it be spent in full twice — the invoice marked paid and the note settled again,
  // for one credit. (Nothing seeded can yet settle a credit note: a refund has no posting rule — PAYMENT debits
  // only party.payable_account, RECEIPT credits only party.receivable_account, and `draftSettlement` refuses
  // either against the other kind of party. How a refund posts is an owner decision.) As the settled document
  // a row consumes `amount` and `base_amount` (at this document's rate); as the settlement it consumes
  // `settlement_amount` and `base_amount + fx_difference` (the same value at THIS document's rate, §4.8.1).
  // Each is in this document's OWN currency, so the two roles add even when a row's two documents are in two
  // currencies (4B, ADR 0047 decision 9).
  const [alloc] = await tx<{ amount: string; base: string }[]>`
    select coalesce(sum(case when settled_document_id = ${documentId} then amount
                             else settlement_amount end), 0)::numeric(19,4)::text as amount,
           coalesce(sum(case when settled_document_id = ${documentId} then base_amount
                             else base_amount + fx_difference end), 0)::numeric(19,4)::text as base
      from app.allocation
     where (settled_document_id = ${documentId} or settlement_document_id = ${documentId})
       and unallocated_at is null`;
  const total = Money.of(facts.total, cur);
  // The base magnitude is what the posting put on the control account — Σ round(line × rate, 4) per line, the
  // figure the ledger holds — and not `round(total × rate, 4)`, which differs from it by a rounding unit per
  // line or two and would strand that unit in the control account once the document was "fully" allocated
  // (A2). The own-currency magnitude is the same rows' `controlNet` (A3, above).
  const posted = sideOf(facts) !== 0;
  const whole = posted ? Money.of(facts.controlNet, cur) : total;
  const wholeBase = posted ? Money.of(facts.controlNetBase, base) : toBase(total, rateOf(facts));
  return {
    document: whole.abs().subtract(Money.of(alloc!.amount, cur)),
    base: wholeBase.abs().subtract(Money.of(alloc!.base, base)),
  };
}

/** `|control-account figure| − Σ live allocations` of a document of `companyId`, in its currency and in base
 *  (§4.8.1; `openOf`). */
export async function openBalance(
  tx: Sql,
  input: { companyId: string; documentId: string },
): Promise<{ document: Money; base: Money }> {
  const facts = await docFacts(tx, input.companyId, input.documentId);
  return openOf(tx, input.documentId, facts);
}

/**
 * §4.8.1. Records which documents a POSTED settlement of `companyId` paid. It writes NO ledger row — the
 * settlement's own posting already relieved the control account — and it computes `fx_difference` in base
 * without posting it: the gain or loss is 4B's `FX_REVALUATION` through `4900`/`5910` (§4.15), which
 * `settleWithFx` posts on the same transaction.
 *
 * **A settlement may be in another currency than the document it settles** (4B, ADR 0047 decision 9 — a
 * proposal): a USD receipt paying a EUR invoice. Each line then states both figures — `amount` in the settled
 * document's currency, `settlementAmount` in the settlement's — because neither can be derived from the other
 * without a cross rate nobody entered. `base_amount` is `amount` at the settled document's rate and
 * `fx_difference` is `settlementAmount` at the settlement's rate less that; a same-currency line needs no
 * `settlementAmount` and, if it gives one, it must equal `amount`.
 *
 * Refused (nothing is written, the caller's transaction is left to roll back):
 * - Σ settlement amounts greater than the settlement's open magnitude (`openOf`), or a line greater
 *   than its settled document's open balance — §6.2's allocation proof. Two lines against one document are
 *   bounded together, because each line's open balance is read after the one before it was inserted.
 * - a settlement or settled document not of `companyId` (ERR_NOT_FOUND), not posted (ERR_DOC_STATUS_ILLEGAL),
 *   or of another party;
 * - an `amount` not in the settled document's currency, or a `settlementAmount` not in the settlement's
 *   (ERR_MONEY_CURRENCY_MISMATCH, naming the line); a cross-currency line without `settlementAmount`, or a
 *   same-currency line whose `settlementAmount` differs from `amount` (ERR_VALIDATION_FAILED);
 * - a document settling itself (`allocation_distinct_check`'s rule, refused here with a message);
 * - a pair on the SAME side of the party's control account, or a document that does not move it at all. A
 *   settlement relieves what the settled document charged: an invoice debits the receivable and a receipt or
 *   credit note credits it. Allocating an invoice against an invoice would mark the second paid while the
 *   ledger still holds both, and 4B's ageing could never tie out to the control account again.
 * - an FX_REVALUATION on either side: a realised one names its party and moves the control account, but it
 *   is an allocation's correction, not an open item.
 *
 * **The allocation that COMPLETES a document takes the base residue** — `open base` for the settled side,
 * its control-account base figure less Σ (base_amount + fx_difference) for the settlement side — instead of a
 * fresh `toBase` of its amount, so a document paid in thirds is carried at exactly its own base figure and
 * Σ `fx_difference` is exactly what closes the control account in base (Tasks 6 and 8 take their residues the
 * same way). Each side completes on its OWN currency's figure: the settled one when `amount` is its open
 * balance, the settlement when `settlementAmount` is what it has left.
 *
 * The settlement and every settled document are locked first, sorted, under `allocation:<document id>`, so
 * two concurrent allocations cannot both read the same capacity or open balance and over-allocate.
 */
export async function allocateSettlement(
  tx: Sql,
  _ctx: TenantContext,
  input: { companyId: string; settlementDocumentId: string; lines: readonly AllocationLine[] },
): Promise<{ allocationIds: string[]; fxDifference: Money }> {
  const settlementId = input.settlementDocumentId;
  if (input.lines.length === 0) {
    throw codedError("ERR_VALIDATION_FAILED", "an allocation needs at least one line");
  }
  const keys = [...new Set([settlementId, ...input.lines.map((l) => l.settledDocumentId)])];
  for (const id of keys.toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`allocation:${id}`}, 0))`;
  }

  const settlement = await docFacts(tx, input.companyId, settlementId, true);
  if (settlement.status !== "posted") {
    throw codedError(
      "ERR_DOC_STATUS_ILLEGAL",
      `settlement ${settlementId} is not posted (it is ${settlement.status})`,
    );
  }
  if (settlement.partyId === null) {
    throw codedError("ERR_VALIDATION_FAILED", `settlement ${settlementId} carries no party`);
  }
  // A full reversal and the document it reversed cancel each other in the ledger, so the reversal's whole
  // magnitude is already spent on its original and nothing of it is free to settle anything else. Allowing
  // it would mark a second invoice paid while the control account still holds that invoice in full.
  if (settlement.isFullReversal) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `settlement ${settlementId} is the full reversal of another document; it nets that document and settles nothing else`,
    );
  }
  if (settlement.isFx) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `document ${settlementId} is an FX_REVALUATION; a realised FX difference corrects an allocation and settles nothing`,
    );
  }
  // S2 — the settlement side is a SETTLEMENT by its PINNED policy's shape: one that relieves the party's
  // control account (a RECEIPT, a PAYMENT, a vendor's debit note), or a credit note. The routes gate an
  // allocation on the PATH document's own create code, so without this a clerk who may raise invoices put
  // the invoice on the path, the receipt in the body, and allocated receipts under the sales code.
  const pinned = settlement.policy === null ? null : parsePolicy(settlement.policy);
  if (pinned === null || !(relievesPartyControl(pinned) || isCreditNotePolicy(pinned))) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `document ${settlementId} is a ${pinned?.documentType ?? "document with no pinned policy"}, which is not a settlement: a settlement relieves the party's control account (a receipt, a payment) or credits a document it names (a credit note)`,
    );
  }
  const settlementSide = sideOf(settlement);
  if (settlementSide === 0) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `settlement ${settlementId} does not move its party's control account, so it settles nothing`,
    );
  }
  const setCur = currency(settlement.currency) as CurrencyCode;
  const baseCur = currency(settlement.baseCurrency) as CurrencyCode;

  // Pass 1 — every line's two figures, each in its own document's currency, validated before anything is
  // read for capacity or written. The settled document's facts are needed here for its currency.
  const planned: {
    settledId: string;
    settled: DocFacts;
    amount: Money;
    settlementAmount: Money;
  }[] = [];
  let asked = Money.zero(setCur);
  for (const [i, line] of input.lines.entries()) {
    const settled = await docFacts(tx, input.companyId, line.settledDocumentId, true);
    if (settled.isFx) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${i + 1}: document ${line.settledDocumentId} is an FX_REVALUATION; a realised FX difference is not an open item`,
      );
    }
    if ((line.amount.currency as string) !== settled.currency) {
      throw codedError(
        "ERR_MONEY_CURRENCY_MISMATCH",
        `line ${i + 1} is in ${line.amount.currency} and document ${line.settledDocumentId} is in ${settled.currency}`,
      );
    }
    if (!line.amount.isPositive()) {
      throw codedError("ERR_VALIDATION_FAILED", `line ${i + 1} amount must be positive`);
    }
    let settlementAmount: Money;
    if (settled.currency === settlement.currency) {
      if (line.settlementAmount !== undefined && !line.settlementAmount.equals(line.amount)) {
        throw codedError(
          "ERR_VALIDATION_FAILED",
          `line ${i + 1}: settlement ${settlementId} and document ${line.settledDocumentId} are both in ${setCur}, so settlementAmount must equal amount`,
        );
      }
      settlementAmount = line.amount;
    } else {
      if (line.settlementAmount === undefined) {
        throw codedError(
          "ERR_VALIDATION_FAILED",
          `line ${i + 1}: settlement ${settlementId} is in ${setCur} and document ${line.settledDocumentId} is in ${settled.currency}; settlementAmount in ${setCur} is required`,
        );
      }
      if ((line.settlementAmount.currency as string) !== (setCur as string)) {
        throw codedError(
          "ERR_MONEY_CURRENCY_MISMATCH",
          `line ${i + 1} settlementAmount is in ${line.settlementAmount.currency} and settlement ${settlementId} is in ${setCur}`,
        );
      }
      if (!line.settlementAmount.isPositive()) {
        throw codedError(
          "ERR_VALIDATION_FAILED",
          `line ${i + 1} settlementAmount must be positive`,
        );
      }
      settlementAmount = line.settlementAmount;
    }
    planned.push({
      settledId: line.settledDocumentId,
      settled,
      amount: line.amount,
      settlementAmount,
    });
    asked = asked.add(settlementAmount);
  }

  // 1. Σ settlement amounts may not exceed the settlement's magnitude less what it has already allocated —
  //    the magnitude FIRST, then the subtraction (see `openOf`). The base consumed so far is
  //    Σ (base_amount + fx_difference): each row's base at the SETTLEMENT's rate, which is what the settlement
  //    side's residue is taken from. Read through `openOf`, so what the settlement has already consumed in
  //    EITHER role counts.
  const capacity = await openOf(tx, settlementId, settlement);
  let remaining = capacity.document;
  let remainingBase = capacity.base;
  if (asked.compare(remaining) > 0) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `allocations total ${asked.toString()} exceed the settlement total ${remaining.toString()} still unallocated on ${settlementId}`,
    );
  }

  const ids: string[] = [];
  let fx = Money.zero(baseCur);
  for (const [i, { settledId, settled, amount, settlementAmount }] of planned.entries()) {
    if (settledId === settlementId) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `line ${i + 1}: document ${settledId} cannot settle itself`,
      );
    }
    if (settled.status !== "posted") {
      throw codedError(
        "ERR_DOC_STATUS_ILLEGAL",
        `document ${settledId} is not posted (it is ${settled.status})`,
      );
    }
    if (settled.isFullReversal) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `document ${settledId} is the full reversal of another document; it nets that document and has nothing open to settle`,
      );
    }
    if (settled.partyId !== settlement.partyId) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `document ${settledId} belongs to a different party than settlement ${settlementId}`,
      );
    }
    const settledSide = sideOf(settled);
    if (settledSide === 0) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `document ${settledId} does not move its party's control account, so nothing of it is open to settle`,
      );
    }
    if (settledSide === settlementSide) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `document ${settledId} and settlement ${settlementId} sit on the same side of the party's control account; a settlement relieves what the settled document charged`,
      );
    }
    const open = await openOf(tx, settledId, settled);
    if (amount.compare(open.document) > 0) {
      throw codedError(
        "ERR_VALIDATION_FAILED",
        `document ${settledId} has an open balance of ${open.document.toString()}`,
      );
    }

    // base_amount is at the SETTLED document's rate (§4.8.1's column comment). fx_difference is the settlement
    // amount at the SETTLEMENT's rate minus that — the gain or loss the settlement realised. Both go through
    // `toBase`; the line that completes either document takes that document's base residue instead, each
    // side judged on its own currency's figure.
    const baseAtSettled = amount.equals(open.document)
      ? open.base
      : toBase(amount, rateOf(settled));
    const baseAtSettlement = settlementAmount.equals(remaining)
      ? remainingBase
      : toBase(settlementAmount, rateOf(settlement));
    const diff = baseAtSettlement.subtract(baseAtSettled);

    const [row] = await tx<{ id: string }[]>`
      insert into app.allocation
        (tenant_id, company_id, party_id, settlement_document_id, settled_document_id,
         amount, settlement_amount, base_amount, fx_difference)
      values (app.current_tenant(), ${input.companyId}, ${settlement.partyId},
              ${settlementId}, ${settledId},
              ${amount.toString()}, ${settlementAmount.toString()},
              ${baseAtSettled.toString()}, ${diff.toString()})
      returning id`;
    ids.push(row!.id);
    remaining = remaining.subtract(settlementAmount);
    remainingBase = remainingBase.subtract(baseAtSettlement);
    fx = fx.add(diff);
  }
  return { allocationIds: ids, fxDifference: fx };
}

/**
 * Reverses one LIVE allocation of the settlement `settlementDocumentId` of `companyId`: sets `unallocated_at`,
 * `unallocated_by` and `unallocation_reason`. Never touches a ledger entry (spec:2457, SAH-041). Bound to the
 * settlement as well as the company, because the route's gate cleared THAT document's authority and an
 * allocation id alone would reach another settlement's row.
 *
 * **The reason is WRITTEN, not merely validated.** `app.audit_row` records `to_jsonb(new)` of the row, so a
 * value that never reaches a column cannot reach the audit image either — compelling a reason and then
 * discarding it is the loss ADR 0023 fixed for `fiscal_period.reopen_reason`, and 0046 gives this one a column
 * for the same reason. **`app.current_actor()` in the UPDATE is redundant with the trigger, not a substitute
 * for it:** `stamp_actor` stamps on the NULL → value transition and overwrites whatever the statement
 * supplied, so the guarantee is the trigger's. It is written here because this is where a reader looks to find
 * out who reversed an allocation. Do not remove the `attach_stamp` call on the strength of this line.
 */
export async function unallocate(
  tx: Sql,
  _ctx: TenantContext,
  input: { companyId: string; settlementDocumentId: string; allocationId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason === "") {
    throw codedError("ERR_VALIDATION_FAILED", "a reason is required to unallocate");
  }
  const [row] = await tx<{ id: string }[]>`
    update app.allocation
       set unallocated_at      = now(),
           unallocated_by      = app.current_actor(),
           unallocation_reason = ${reason}
     where id = ${input.allocationId}
       and settlement_document_id = ${input.settlementDocumentId}
       and company_id = ${input.companyId}
       and unallocated_at is null
    returning id`;
  if (row === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `allocation ${input.allocationId} is not an open allocation of settlement ${input.settlementDocumentId} in company ${input.companyId}`,
    );
  }
}

/**
 * Per-currency and base open balances of a party of `companyId` as of `asOf` — test 8's "correct in all three
 * currencies".
 *
 * **It reads the LEDGER, on the party's own control account, and never the document totals.** `app.allocation`
 * keys on `settled_document_id` and a RECEIPT is always the settlement, never a settled document, so a
 * document-side sum would add each receipt's total instead of netting it. The control account nets the pair by
 * construction: the invoice debits it and the receipt credits it, both through the posting service. It is the
 * source `app.party_open_balance` (0045) reads and the control §4.8.2 fixes for 4B's ageing — `1200` / `2100`
 * by default — so the three cannot give three answers about the underlying rows. Allocation does not enter the
 * arithmetic: it records WHICH invoice a settlement paid, never THAT one was paid.
 *
 * **THE SIGN CONVENTION (§4.8.1).** A PARTY-FACING figure: positive is "owed to us" for a customer and "owed by
 * us" for a vendor — so a vendor's figure is the raw `Σ (base_debit − base_credit)` on its payable NEGATED,
 * which is why the `case` on `party.kind` is inside the query and not left to the caller.
 * `app.party_open_balance` does NOT negate (it is the customer-only credit-control read), so for a customer
 * the two agree exactly and for a vendor they differ by one negation. **A vendor figure taken from here must be
 * negated before it is compared with a control-account balance; 4B's `ageingTieOut` reads the control account
 * directly and must not be routed through this function unconverted.**
 *
 * A party with nothing posted owes `0.0000` in base and names no currency — never NULL (SAH-011).
 */
export async function partyBalance(
  tx: Sql,
  input: { companyId: string; partyId: string; asOf: string },
): Promise<PartyBalance> {
  const [party] = await tx<{ baseCurrency: string }[]>`
    select c.base_currency::text as "baseCurrency"
      from app.party p join app.company c on c.id = p.company_id
     where p.id = ${input.partyId} and p.company_id = ${input.companyId}`;
  if (party === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `party ${input.partyId} is not a party of company ${input.companyId}`,
    );
  }
  // Per document through `app.document_control_exposure` (0129) — the derivation the ageing reads — so a
  // foreign-currency return's cost leg counts in its own currency at the keyed total and its price-versus-cost
  // difference in base, not the whole return in base (MON-11). Its rows are the document's control rows, dated
  // on the document's effective date, as 0048's ageing reads them.
  const rows = await tx<{ currency: string; open: string; openBase: string }[]>`
    select x.currency::text as currency,
           coalesce(sum(x.amount * sgn.v), 0)::numeric(19,4)::text      as open,
           coalesce(sum(x.base_amount * sgn.v), 0)::numeric(19,4)::text as "openBase"
      from app.party p
      cross join lateral (select case when p.kind = 'vendor' then -1 else 1 end as v) sgn
      join app.document d on d.party_id = p.id and d.company_id = p.company_id
      cross join lateral app.document_control_exposure(d.id) x
     where p.id = ${input.partyId} and p.company_id = ${input.companyId}
       and d.effective_date <= ${input.asOf}::date
     group by x.currency
     order by x.currency`;
  const baseCur = currency(party.baseCurrency) as CurrencyCode;
  const byCurrency: Record<string, Money> = {};
  let base = Money.zero(baseCur);
  for (const r of rows) {
    byCurrency[r.currency] = Money.of(r.open, currency(r.currency) as CurrencyCode);
    base = base.add(Money.of(r.openBase, baseCur));
  }
  return { byCurrency, base };
}

/**
 * The allocations of `companyId`, optionally of one settlement and/or against one settled document; live rows
 * only unless `includeUnallocated`. The three joins carry no column of their own: `sd.currency` is the settled
 * document's currency, in which `amount` is denominated, `st.currency` the settlement's, in which
 * `settlement_amount` is (4B), and `c.base_currency` is the currency of `base_amount` and `fx_difference` — so
 * a row states all of its currencies and the API mapper needs no second query.
 */
export async function listAllocations(
  tx: Sql,
  input: {
    companyId: string;
    settlementDocumentId?: string;
    settledDocumentId?: string;
    includeUnallocated?: boolean;
  },
): Promise<AllocationRow[]> {
  const settlement = input.settlementDocumentId ?? null;
  const settled = input.settledDocumentId ?? null;
  const rows = await tx<AllocationRow[]>`
    select a.id, a.company_id as "companyId", a.party_id as "partyId",
           a.settlement_document_id as "settlementDocumentId", a.settled_document_id as "settledDocumentId",
           a.amount::text as amount, a.settlement_amount::text as "settlementAmount",
           a.base_amount::text as "baseAmount",
           a.fx_difference::text as "fxDifference", a.allocated_by as "allocatedBy",
           to_char(a.unallocated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "unallocatedAt",
           a.unallocated_by as "unallocatedBy", a.unallocation_reason as "unallocationReason",
           to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
           sd.currency::text as currency, st.currency::text as "settlementCurrency",
           c.base_currency::text as "baseCurrency"
      from app.allocation a
      join app.document sd on sd.id = a.settled_document_id
      join app.document st on st.id = a.settlement_document_id
      join app.company  c  on c.id  = a.company_id
     where a.company_id = ${input.companyId}
       and (${settlement}::uuid is null or a.settlement_document_id = ${settlement}::uuid)
       and (${settled}::uuid is null or a.settled_document_id = ${settled}::uuid)
       and (${input.includeUnallocated ?? false}::boolean or a.unallocated_at is null)
     order by a.created_at, a.id`;
  return [...rows];
}
