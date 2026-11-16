import type { PostingPolicy } from "@dulja/domain";
import type { Sql } from "postgres";

/**
 * Which way a policy's rules move the party's control account, decided by policy SHAPE, never by
 * document-type code (3C's rule). Shared by `settlement.ts` (which types may be drafted as a settlement) and
 * `allocation.ts` (which posted documents may stand on an allocation's settlement side) — two spellings of one
 * question is hazard 9. Deliberately NOT re-exported from `ar-ap/index.ts`, with one exception:
 * `settlementControlViolation` below, which `postDocument` (step 6c) and `apps/api`'s generic draft route ask
 * too. This file imports only types, so `posting/post.ts` reaches it with no cycle through `settlement.ts`.
 */
function controlRules(policy: PostingPolicy): { from: string; side: string }[] {
  return policy.lines.flatMap((rule) =>
    "from" in rule.account &&
    (rule.account.from === "party.receivable_account" ||
      rule.account.from === "party.payable_account")
      ? [{ from: rule.account.from, side: rule.side }]
      : [],
  );
}

/**
 * Every rule on the party's control account RELIEVES it — credits `party.receivable_account` (money in from a
 * customer) or debits `party.payable_account` (money out to a vendor, or a vendor's debit note) — and at least
 * one such rule exists. A SALES_INVOICE debits the receivable and a PURCHASE_INVOICE credits the payable, so
 * neither relieves.
 */
export function relievesPartyControl(policy: PostingPolicy): boolean {
  const control = controlRules(policy);
  return (
    control.length > 0 &&
    control.every((rule) =>
      rule.from === "party.receivable_account" ? rule.side === "credit" : rule.side === "debit",
    )
  );
}

/** The party control accounts a policy's rules post to — `party.receivable_account`, `party.payable_account`
 *  — each once. `settlement.ts` checks them against the account the party's open items live on. */
export function partyControlSources(policy: PostingPolicy): string[] {
  return [...new Set(controlRules(policy).map((rule) => rule.from))];
}

/**
 * A SETTLEMENT type (§4.14's RECEIPT and PAYMENT): it moves no stock, and it relieves the party's control
 * account. The draft-side question — `draftSettlement` refuses any other type, so it is not a second door for
 * raising an invoice.
 */
export function isSettlementPolicy(policy: PostingPolicy): boolean {
  return policy.inventory.effect === "none" && relievesPartyControl(policy);
}

/**
 * The refund refusal (code review 2026-09-29; code review 2, M5-X / F7), in ONE spelling for every path that
 * drafts or posts a settlement. A SETTLEMENT policy relieves `party.receivable_account` (RECEIPT) or
 * `party.payable_account` (PAYMENT); the account that source resolves to must be the one this party's open
 * items live on — `app.party_control_account`, 0045's one definition, asked in SQL and never copied here
 * (hazard 9). Otherwise the posting lands on an account the party's ageing, allocation and tie-out never read:
 * a RECEIPT from a vendor credits 1200, a PAYMENT to a customer debits 2100, and the 1200/2100 tie-out of the
 * Phase 4 definition of done (spec:2290) stops reconciling. That is a refund, which has no posting rule in
 * this version — how one posts is an owner decision (ADR 0047 open question 5).
 *
 * Returns the refusal's text, or null when there is nothing to refuse: no party, a policy that is not a
 * settlement, an unknown party (the caller's own lookup answers that), or a source that reaches the control
 * account. Only SETTLEMENT policies are asked: a cross-kind invoice (a SALES_INVOICE to a vendor) breaks the
 * tie-out the same way, and whether to refuse it is a separate owner question this does not decide.
 *
 * Callers: `draftSettlement` (the early refusal, before anything is written), `apps/api`'s
 * POST …/documents (a pre-flight, so no draft and later no number is spent on it) and `postDocument` step
 * 6c, the control every ledger write goes through (spec:2173 — the data layer, not a handler).
 */
export async function settlementControlViolation(
  tx: Sql,
  definition: PostingPolicy,
  partyId: string | null,
): Promise<string | null> {
  if (partyId === null || !isSettlementPolicy(definition)) return null;
  const [party] = await tx<
    {
      kind: string;
      code: string;
      receivable: string | null;
      payable: string | null;
      control: string | null;
    }[]
  >`
    select p.kind::text as kind, p.code, p.receivable_account_id as receivable,
           p.payable_account_id as payable, app.party_control_account(p) as control
      from app.party p
     where p.id = ${partyId}`;
  if (party === undefined) return null;
  for (const source of partyControlSources(definition)) {
    const account = source === "party.receivable_account" ? party.receivable : party.payable;
    if (account === null || account !== party.control) {
      const theirs =
        party.control === null
          ? "no control account"
          : party.control === party.receivable
            ? "its receivable account"
            : "its payable account";
      return `a ${definition.documentType} posts to ${source}, but ${party.kind} ${party.code}'s open items are on ${theirs} (app.party_control_account): for this party it would be a refund, and a refund has no posting rule in this version — how one posts is an owner decision`;
    }
  }
  return null;
}

/**
 * A CREDIT-NOTE type (spec:2024, §4.14's SALES_CREDIT_NOTE and PURCHASE_CREDIT_NOTE): it moves no stock, it
 * touches the party's control account, and it `requires` the document it credits. Its rules carry the
 * INVOICE's sides — the note's magnitudes are negated and A9's sign normalisation flips each one — so it does
 * not pass `relievesPartyControl`, and §4.8.1 still makes it a legal settlement.
 */
export function isCreditNotePolicy(policy: PostingPolicy): boolean {
  return (
    policy.inventory.effect === "none" &&
    policy.requires.includes("reverses_document") &&
    controlRules(policy).length > 0
  );
}

/** The rules that name their account by fixed `code`, with their side. */
function fixedRules(policy: PostingPolicy): { code: string; side: string }[] {
  return policy.lines.flatMap((rule) =>
    "code" in rule.account ? [{ code: rule.account.code, side: rule.side }] : [],
  );
}

/**
 * The CORRIDOR a stock document filled and an invoice relieves (§4.15's `1250` and `2150` rows, ADR 0044):
 * every account the `target`'s rules name by fixed code that the `source`'s rules name by the same code on
 * the OTHER side. A DELIVERY_ORDER debits `1250` and a SALES_INVOICE credits it; a GOODS_RECEIPT credits
 * `2150` and a PURCHASE_INVOICE debits it. A PURCHASE_RETURN moves stock outbound too, but it debits the
 * party's payable account and names no `1250` at all, so it shares no corridor with a SALES_INVOICE — an
 * invoice built on it would credit a corridor nothing had filled (code review 2026-09-29). Decided by policy
 * SHAPE, never by document-type code (3C's rule). Used by `invoice.ts` only.
 */
export function sharedCorridor(source: PostingPolicy, target: PostingPolicy): string[] {
  const filled = fixedRules(source);
  return [
    ...new Set(
      fixedRules(target)
        .filter((t) => filled.some((f) => f.code === t.code && f.side !== t.side))
        .map((t) => t.code),
    ),
  ];
}
