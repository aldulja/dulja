import { Money, currency, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import type { JobClient } from "../jobs/enqueue";
import { issueDocument } from "../posting/issue";
import { resolvePolicy } from "../posting/load";
import { postDocument } from "../posting/post";
import type { TenantContext } from "../with-tenant";
import { allocateSettlement } from "./allocation";
import { codedError } from "./invoice";
import { isSettlementPolicy, settlementControlViolation } from "./policy-shape";
import { resolvePartyTerm } from "./payment-term";

export interface SettlementInput {
  /** The company the caller's permission gate cleared. RLS bounds the tenant and nothing else, so the type,
   *  the party, the bank account and the branch are each matched on it (AGENTS.md). */
  companyId: string;
  /** RECEIPT or PAYMENT — any type of `companyId` whose policy relieves the party's control account. */
  documentTypeId: string;
  /** The policy's `numbering.series`. Issue numbers in the policy's series whatever the draft says (§4.3.6),
   *  so a different one is refused rather than displayed on a draft it will never be numbered in. */
  series: string;
  effectiveDate: string;
  partyId: string;
  bankAccountId: string;
  currency: string;
  /** The caller's rate, 8 dp, never looked up again (SAH-014). The base currency takes only `1.00000000`. */
  exchangeRate: string;
  /** 4-dp decimal string, POSITIVE. */
  amount: string;
  /** The cheque or transfer reference; reaches the line's `description`. */
  reference?: string | null;
  /** The document's branch. `document.branch_id` is NOT NULL (spec:1766) and a settlement is a head-office act
   *  with no branch of its own, so when this is absent the function takes the company's lowest-coded live
   *  BRANCH value — `HQ` in every seeded company (§4.1). The route ALWAYS sends one. */
  branchId?: string;
  /** Allocate to these documents in the same transaction. Empty means an ON-ACCOUNT settlement. Each amount is
   *  a 4-dp string in the settlement's currency. */
  allocations?: readonly { settledDocumentId: string; amount: string }[];
  /** Passed straight to `postDocument` when the settlement is posted here (3B amendment A5): its step 14
   *  enqueues `accounting.projection.rebuild` for the party's ageing. The route passes `c.var.jobs`. */
  jobs?: JobClient;
}

export interface SettlementResult {
  documentId: string;
  lineId: string;
  allocationIds: string[];
  /** `postDocument`'s warnings when the settlement was posted here — among them the skipped projection
   *  enqueue of a caller that supplied no `jobs`. Empty for a draft. Returned, never dropped. */
  warnings: string[];
}

const RATE = /^\d+\.\d{8}$/;
const IDENTITY_RATE = "1.00000000";

/**
 * §4.14's RECEIPT and PAYMENT. ONE `kind: "account"` line carrying the bank or cash account and the money —
 * the apportionment lives in `app.allocation` (§4.8.1) and never in the ledger, which is what lets `unallocate`
 * exist without altering a posted entry (spec:2457). `amount = total_incl_tax` and `tax_amount = 0`: both
 * policies post `line.total_incl_tax`, the figure `openBalance` and `partyBalance` read (Task 9).
 *
 * The draft pins `payment_term_id` through `resolvePartyTerm` — the one reader of `party.payment_term_id`
 * (SAH-013) — and writes `rate_source`: `unit` for the identity pair (the base currency at `1.00000000`),
 * `manual:<actor>` for any other rate the caller supplied, because a posted base figure whose rate has no
 * provenance is SAH-012 itself. The caller's rate is never replaced (SAH-014); a rate other than
 * `1.00000000` on the base currency is refused.
 *
 * When `allocations` is non-empty the document is issued, posted AND allocated on the caller's `tx`, so a
 * failed allocation rolls the posting back with it. That is only possible for a type whose policy declares
 * `approval.required = false` — a RECEIPT. A PAYMENT with allocations is refused before anything is written:
 * R1 needs two principals in two sessions, so the caller drafts it, walks it through the state machine, and
 * allocates the posted payment through `POST …/documents/{documentId}/allocations`.
 *
 * Raises ERR_NOT_FOUND (a type, party, bank account or branch not of `companyId`, or a company with no live
 * branch), ERR_VALIDATION_FAILED (a non-positive amount; a malformed rate, or a base-currency rate that is not
 * the identity; a type that is not a settlement; a series that is not the policy's; allocations on an
 * approval-required type; a type that posts to a control account the party's open items are not on — a
 * refund, which has no posting rule; a group or archived bank account) and ERR_MONEY_SCALE (more than 4 dp). Everything
 * past the draft — the period, R2, over-allocation — is the posting service's and `allocateSettlement`'s.
 */
export async function draftSettlement(
  tx: Sql,
  ctx: TenantContext,
  input: SettlementInput,
): Promise<SettlementResult> {
  const cur = currency(input.currency) as CurrencyCode;
  const amount = Money.of(input.amount, cur); // ERR_MONEY_SCALE on more than 4 dp
  if (!amount.isPositive()) {
    throw codedError("ERR_VALIDATION_FAILED", "a settlement amount must be positive");
  }
  // Parsed up front, so a malformed line is refused before anything is written, not after the posting.
  const allocations = (input.allocations ?? []).map((a) => ({
    settledDocumentId: a.settledDocumentId,
    amount: Money.of(a.amount, cur),
  }));
  if (!RATE.test(input.exchangeRate) || /^0+\.0{8}$/.test(input.exchangeRate)) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `exchange rate ${input.exchangeRate} is not a positive 8-dp decimal`,
    );
  }

  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type
     where id = ${input.documentTypeId} and company_id = ${input.companyId}
       and archived_at is null`;
  if (type === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `document type ${input.documentTypeId} is not a live type of company ${input.companyId}`,
    );
  }
  // The policy the settlement will post under, resolved exactly as §4.3.2 step 4 will resolve it.
  const { definition } = await resolvePolicy(tx, type.id, input.effectiveDate);
  if (!isSettlementPolicy(definition)) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `document type ${definition.documentType} is not a settlement: its policy must credit party.receivable_account or debit party.payable_account, and move no stock`,
    );
  }
  if (input.series !== definition.numbering.series) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `a ${definition.documentType} is numbered in series ${definition.numbering.series}, not ${input.series}`,
    );
  }
  if (allocations.length > 0 && definition.approval.required) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `a ${definition.documentType} requires approval by a second principal (R1), so it cannot be posted and allocated in its drafter's transaction; allocate it once it is posted`,
    );
  }

  const [party] = await tx<{ id: string }[]>`
    select p.id from app.party p
     where p.id = ${input.partyId} and p.company_id = ${input.companyId} and p.archived_at is null`;
  if (party === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `party ${input.partyId} is not a live party of company ${input.companyId}`,
    );
  }
  // The account the policy relieves must be the one this party's open items live on
  // (`app.party_control_account`, 0045) — code review 2026-09-29. RECEIPT credits only
  // party.receivable_account and PAYMENT debits only party.payable_account, so a PAYMENT to a customer (a
  // customer refund) would debit 2100 or raise ERR_POLICY_REQUIRES_MISSING, and a RECEIPT from a vendor would
  // credit 1200 — each on an account that party's ageing, allocation and tie-out never read, leaving the
  // credit note it was meant to settle open for ever. No seeded policy posts a refund, and how one should is
  // money semantics — an owner decision (ADR) — so it is refused here, before anything is written. This is
  // the EARLY refusal; `postDocument` step 6c asks the same helper and is the control (code review 2, F7).
  const violation = await settlementControlViolation(tx, definition, party.id);
  if (violation !== null) throw codedError("ERR_VALIDATION_FAILED", violation);
  // Pinned here, at draft, and never re-read (SAH-013) — through the ONE reader of the column (4A Task 1).
  const paymentTermId = await resolvePartyTerm(tx, { partyId: party.id });

  // `document_line`'s account key is tenant-composite only, so the bank is bound to the company here.
  const [bank] = await tx<{ isGroup: boolean; archived: boolean }[]>`
    select is_group as "isGroup", (archived_at is not null) as archived
      from app.account where id = ${input.bankAccountId} and company_id = ${input.companyId}`;
  if (bank === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      `account ${input.bankAccountId} is not an account of company ${input.companyId}`,
    );
  }
  if (bank.isGroup || bank.archived) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `account ${input.bankAccountId} is ${bank.isGroup ? "a group" : "archived"} and takes no postings`,
    );
  }

  const [company] = await tx<{ baseCurrency: string }[]>`
    select base_currency::text as "baseCurrency" from app.company where id = ${input.companyId}`;
  const identity = input.currency === company!.baseCurrency;
  if (identity && input.exchangeRate !== IDENTITY_RATE) {
    throw codedError(
      "ERR_VALIDATION_FAILED",
      `a settlement in the base currency ${input.currency} carries the identity rate ${IDENTITY_RATE}, not ${input.exchangeRate}`,
    );
  }
  const rateSource = identity ? "unit" : `manual:${ctx.actorId}`;

  // The caller's branch is taken as given and only checked — silently replacing a value the caller DID
  // specify would be SAH-042's shape in reverse. The default applies only when none was sent.
  const [branch] =
    input.branchId === undefined
      ? await tx<{ id: string }[]>`
          select v.id from app.dimension_value v
            join app.dimension_type t on t.id = v.dimension_type_id
           where t.code = 'BRANCH' and t.company_id = ${input.companyId} and v.archived_at is null
           order by v.code
           limit 1`
      : await tx<{ id: string }[]>`
          select v.id from app.dimension_value v
            join app.dimension_type t on t.id = v.dimension_type_id
           where v.id = ${input.branchId} and t.code = 'BRANCH' and t.company_id = ${input.companyId}
             and v.archived_at is null`;
  if (branch === undefined) {
    throw codedError(
      "ERR_NOT_FOUND",
      input.branchId === undefined
        ? `company ${input.companyId} has no live branch`
        : `branch ${input.branchId} is not a live branch of company ${input.companyId}`,
    );
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, status, series, effective_date, party_id, currency,
       exchange_rate, rate_source, branch_id, payment_term_id)
    values (app.current_tenant(), ${input.companyId}, ${type.id}, 'draft', ${input.series},
            ${input.effectiveDate}::date, ${party.id}, ${input.currency}, ${input.exchangeRate},
            ${rateSource}, ${branch.id}, ${paymentTermId})
    returning id`;
  const documentId = doc!.id;

  const [line] = await tx<{ id: string }[]>`
    insert into app.document_line
      (tenant_id, company_id, document_id, line_no, kind, description, account_id,
       amount, tax_amount, total_incl_tax)
    values (app.current_tenant(), ${input.companyId}, ${documentId}, 1, 'account',
            ${input.reference ?? null}, ${input.bankAccountId},
            ${amount.toString()}, ${"0.0000"}, ${amount.toString()})
    returning id`;
  const lineId = line!.id;

  if (allocations.length === 0) return { documentId, lineId, allocationIds: [], warnings: [] };

  // Post first, then allocate: `allocateSettlement` refuses an unposted settlement, and an allocation against
  // one would be a promise rather than a fact. Both are on the caller's `tx`, so a refusal in either rolls the
  // other back — and the number issue took with it (spec:1744). The caller's JobClient goes with the post:
  // without it step 14's projection enqueue is skipped (code review 2026-09-29).
  await issueDocument(tx, ctx, { documentId });
  const { warnings } = await postDocument(tx, ctx, {
    documentId,
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });
  const { allocationIds } = await allocateSettlement(tx, ctx, {
    companyId: input.companyId,
    settlementDocumentId: documentId,
    lines: allocations,
  });
  return { documentId, lineId, allocationIds, warnings };
}
