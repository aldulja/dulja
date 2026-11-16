import { z } from "zod";
import { CurrencySchema, DateSchema, MoneySchema, RateSchema, UuidSchema } from "../common";

/**
 * 4B Task 5 — the unrealised period-end revaluation (contracts §4.14's `FX_REVALUATION`, ADR 0047), posted by
 * `POST /v1/companies/{companyId}/documents/revaluations`.
 *
 * **Every amount on a line is `MoneySchema`**, not §4.2.8's bare 4-dp form: a line carries TWO currencies —
 * `amountCcy` is in the exposure's `currency`, the three base figures in the company's — and the registered
 * bare form is admitted only for a row that carries its own currency exactly once (round 8 amendment 12).
 */
export const RevalueBody = z
  .object({
    /** The period to revalue; the document is dated its `ends_on`. */
    fiscalPeriodId: UuidSchema,
  })
  .strict();

export const RevaluationLineSchema = z.object({
  accountId: UuidSchema,
  accountCode: z.string(),
  /** The exposure's currency — the currency of `amountCcy`. */
  currency: CurrencySchema,
  /** The exposure, debit-positive on the account. */
  amountCcy: MoneySchema,
  /** Base the ledger carries for it: each open item at its own rate, plus unrealised FX still outstanding. */
  carriedBase: MoneySchema,
  /** `toBase(amountCcy, rate)` — round(value × rate, 4), HALF_AWAY_FROM_ZERO. */
  revaluedBase: MoneySchema,
  /** revaluedBase − carriedBase: what the document posts on the account, debit-positive. */
  delta: MoneySchema,
  /** The `app.rate_for` rate effective on the period's `ends_on`. */
  rate: RateSchema,
});

export const RevaluationResultSchema = z.object({
  /** null when nothing was exposed, or the period had already been revalued (the call is then a no-op). */
  documentId: UuidSchema.nullable(),
  fiscalPeriodId: UuidSchema,
  asOf: DateSchema,
  baseCurrency: CurrencySchema,
  lines: z.array(RevaluationLineSchema),
});

export type RevalueBodyDto = z.infer<typeof RevalueBody>;
export type RevaluationResultDto = z.infer<typeof RevaluationResultSchema>;
