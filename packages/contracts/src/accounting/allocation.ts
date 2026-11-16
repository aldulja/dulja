import { z } from "zod";
import { DateSchema, ListEnvelope, MoneySchema, TimestampSchema, UuidSchema } from "../common";

/**
 * 4A Task 9 — allocation (contracts §4.8.1): which settlement paid which invoice, the open balance it leaves,
 * and a party's balance per currency.
 *
 * **Money on these rows is `MoneySchema`, not a bare 4-dp string, and that is a considered exception to 3C's
 * document-sub-resource convention (§4.2.8).** The convention exists because a sub-resource's currency is
 * implied by its parent document — but an allocation carries TWO currencies: `amount` is the settled
 * document's, and `baseAmount` / `fxDifference` are the company's base currency. On a foreign-currency
 * settlement they differ, and a bare string would leave a reader unable to tell which is which.
 */
export const AllocationSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  partyId: UuidSchema,
  settlementDocumentId: UuidSchema,
  settledDocumentId: UuidSchema,
  amount: MoneySchema,
  /** 4B: the same payment in the SETTLEMENT's currency — equal to `amount` on a same-currency row. */
  settlementAmount: MoneySchema,
  baseAmount: MoneySchema,
  fxDifference: MoneySchema,
  allocatedBy: UuidSchema,
  unallocatedAt: TimestampSchema.nullable(),
  unallocatedBy: UuidSchema.nullable(),
  /** Returned beside the two above so a reversal is legible without a second query. */
  unallocationReason: z.string().nullable(),
  createdAt: TimestampSchema,
});

export const AllocateSettlementLineSchema = z
  .object({
    settledDocumentId: UuidSchema,
    /** In the SETTLED document's currency. Strictly positive: a magnitude (`allocation_amount_check`); the
     *  service refuses zero or a minus naming the line. */
    amount: MoneySchema,
    /** 4B (ADR 0047 decision 9, a proposal): the same payment in the SETTLEMENT's currency. Required when the
     *  two documents' currencies differ (a USD receipt paying a EUR invoice); omitted, or equal to `amount`,
     *  when they agree. */
    settlementAmount: MoneySchema.optional(),
  })
  .strict();

/** The most documents one allocation may name — the bound `ReplacePriceListLinesBody.lines` carries (code
 *  review 2026-09-29). Each line takes an advisory lock and a row lock in the one transaction, so an unbounded
 *  body held a transaction open over as many locks as a client cared to send. Shared with
 *  `DraftSettlementBody.allocations`. */
export const MAX_ALLOCATION_LINES = 500;

export const AllocateSettlementBody = z
  .object({
    /** The SETTLEMENT is the path document; each line names a posted document of the same party it pays. */
    lines: z.array(AllocateSettlementLineSchema).min(1).max(MAX_ALLOCATION_LINES),
  })
  .strict();

export const AllocateSettlementResultSchema = z.object({
  allocationIds: z.array(UuidSchema),
  /** In BASE: Σ `fx_difference` of the allocations just made (§4.8.1). */
  fxDifference: MoneySchema,
  /** 4B (ADR 0047): the realised FX_REVALUATION documents posted IN THE SAME TRANSACTION through
   *  `4900`/`5910` — empty when the difference is zero. One per date the ageing relieves a pair on. */
  fxDocumentIds: z.array(UuidSchema),
});

/** `.min(1)` because `unallocate` COMPELS a reason, and `.max(2000)` is the bound 2B's `OverrideBody.reason`
 *  uses — the value is stored in `allocation.unallocation_reason`. */
export const UnallocateBody = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();

/** §4.2.8's literal `filter[…]` key. Absent or `false`: the live allocations; `true`: the reversed ones. */
export const AllocationQuery = z
  .object({
    "filter[unallocated][eq]": z.enum(["true", "false"]).optional(),
  })
  .strict();

export const AllocationList = ListEnvelope(AllocationSchema);

export const OpenBalanceSchema = z.object({
  documentId: UuidSchema,
  /** `|what the document put on its control account| − Σ live allocations`, in the document's own currency —
   *  the ledger's figure once it has posted (a PURCHASE_RETURN's is its cost, not its keyed price), its line
   *  total before. */
  document: MoneySchema,
  /** The same in base: the control-account rows' base figure (Σ round(line × rate, 4)) less Σ live base. */
  base: MoneySchema,
});

/** `asOf` is REQUIRED: a balance is always as of a date, and defaulting it to today would make two callers a
 *  second apart disagree with no visible cause. */
export const PartyBalanceQuery = z.object({ asOf: DateSchema }).strict();

export const PartyBalanceSchema = z.object({
  partyId: UuidSchema,
  asOf: DateSchema,
  /** Keyed by ISO 4217 code. **Party-facing:** positive is "owed to us" for a customer and "owed by us" for a
   *  vendor, which for a vendor is the ledger figure negated (§4.8.1's sign convention). */
  byCurrency: z.record(z.string().regex(/^[A-Z]{3}$/), MoneySchema),
  base: MoneySchema,
});

export type AllocationDto = z.infer<typeof AllocationSchema>;
export type AllocateSettlementBodyDto = z.infer<typeof AllocateSettlementBody>;
export type OpenBalanceDto = z.infer<typeof OpenBalanceSchema>;
export type PartyBalanceDto = z.infer<typeof PartyBalanceSchema>;
