import { z } from "zod";
import { CurrencySchema, DateSchema, RateSchema, UuidSchema } from "../common";
import { MAX_ALLOCATION_LINES } from "./allocation";
import { DocumentTypeCodeSchema } from "./document";

/**
 * 4A Task 10 — RECEIPT and PAYMENT (§4.14, spec:2147): one bank line carrying the money, and optionally the
 * allocations it pays.
 *
 * A bare 4-dp decimal string, not `MoneySchema`: every amount in this body is in the settlement's own
 * `currency`, which the body states ONCE — the document-sub-resource exception §4.2.8 registers for 3C,
 * applied to a body whose currency is a sibling field rather than a repeated one. Strictly positive: a
 * settlement and an allocation are magnitudes (`allocation_amount_check`), and the direction is the policy's.
 */
const SettlementAmount = z
  .string()
  .regex(/^\d+\.\d{4}$/)
  .refine((amount) => !/^0+\.0{4}$/.test(amount), {
    message: "an amount must be greater than zero",
  });

export const SettlementAllocationSchema = z
  .object({
    /** A posted document of the same party, on the other side of its control account. */
    settledDocumentId: UuidSchema,
    amount: SettlementAmount,
  })
  .strict();

export const DraftSettlementBody = z
  .object({
    /** RECEIPT or PAYMENT. `documentTypeCode`, `effectiveDate` and `branchId` are not decoration: §4.5.4's
     *  `create` stage resolves this route's gate from the policy of the type the BODY names, at this date and
     *  branch, because no document exists yet (the shape of 3D's `…/documents/transfers`). */
    documentTypeCode: DocumentTypeCodeSchema,
    /** The policy's `numbering.series` — `RCT` or `PAY-OUT`; any other is refused. */
    series: z.string().regex(/^[A-Z0-9-]{1,16}$/),
    effectiveDate: DateSchema,
    partyId: UuidSchema,
    /** The bank or cash account the money moves through — a postable account of the path company. */
    bankAccountId: UuidSchema,
    /** Required on the wire, optional in the service: the route never relies on the head-office default. */
    branchId: UuidSchema,
    currency: CurrencySchema,
    /** The caller's rate, kept as given (LEGACY-014); the base currency takes only `1.00000000`. */
    exchangeRate: RateSchema.refine((rate) => !/^0+\.0{8}$/.test(rate), {
      message: "rate must be greater than zero",
    }),
    amount: SettlementAmount,
    /** The cheque or transfer reference; stored as the bank line's description. */
    reference: z.string().max(128).nullish(),
    /** Empty or absent means an ON-ACCOUNT settlement, which is legitimate and is returned as a draft. Non-empty
     *  is accepted only for a type needing no second principal (a RECEIPT): it is then issued, posted and
     *  allocated in one transaction. */
    allocations: z.array(SettlementAllocationSchema).max(MAX_ALLOCATION_LINES).default([]),
  })
  .strict();

export const SettlementResultSchema = z.object({
  /** A DRAFT when `allocations` was empty (issue and post it through `…/transitions`), POSTED otherwise. */
  documentId: UuidSchema,
  lineId: UuidSchema,
  allocationIds: z.array(UuidSchema),
  /** 4B (ADR 0047): the realised FX_REVALUATION documents the allocations posted in the same transaction —
   *  empty for a draft, and whenever the difference is zero. */
  fxDocumentIds: z.array(UuidSchema),
});

export type DraftSettlementBodyDto = z.infer<typeof DraftSettlementBody>;
export type SettlementResultDto = z.infer<typeof SettlementResultSchema>;
