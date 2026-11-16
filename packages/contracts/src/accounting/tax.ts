import { z } from "zod";
import {
  CurrencySchema,
  DateSchema,
  ListEnvelope,
  ListQuery,
  RateSchema,
  TimestampSchema,
  UuidSchema,
} from "../common";

/** A 4-dp signed figure. The same file-local form 1A's `DocumentLineSchema` uses (§4.2.8's registered
 *  practice): a return's box and a credit note's tax are both legitimately negative. */
const Amount = z.string().regex(/^-?\d+\.\d{4}$/);

export const TaxCodeKindSchema = z.enum(["output", "input", "exempt", "zero", "out_of_scope"]);
export const RoundingModeSchema = z.enum([
  "HALF_AWAY_FROM_ZERO",
  "HALF_EVEN",
  "TOWARD_ZERO",
  "AWAY_FROM_ZERO",
]);

export const TaxCodeSchema = z.object({
  id: UuidSchema,
  regimeId: UuidSchema,
  regimeCode: z.string(),
  regimeVersion: z.number().int(),
  code: z.string(),
  nameEn: z.string(),
  nameAr: z.string().nullable(),
  rate: RateSchema,
  kind: TaxCodeKindSchema,
  roundingMode: RoundingModeSchema,
  outputAccountId: UuidSchema.nullable(),
  inputAccountId: UuidSchema.nullable(),
  effectiveFrom: DateSchema,
  effectiveTo: DateSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
});
export type TaxCodeDto = z.infer<typeof TaxCodeSchema>;

export const CreateTaxCodeBody = z.object({
  regimeId: UuidSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9-]{1,31}$/),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullish(),
  rate: RateSchema,
  kind: TaxCodeKindSchema,
  roundingMode: RoundingModeSchema.default("HALF_AWAY_FROM_ZERO"),
  /** A §4.15 account CODE, not an id — the register is the shared namespace, and a code is what a policy
   *  and a seed file both name (hazard 32). `null` for a code that produces no tax. */
  accountCode: z
    .string()
    .regex(/^[1-5][0-9]{3}$/)
    .nullable(),
  effectiveFrom: DateSchema,
  effectiveTo: DateSchema.nullish(),
});

export const TaxCodeQuery = ListQuery.extend({
  "filter[regimeCode][eq]": z.string().optional(),
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
}).strict();
export const TaxCodeList = ListEnvelope(TaxCodeSchema);

export const ReturnBoxSchema = z.object({
  code: z.string(),
  label: z.string(),
  amount: Amount,
});

export const TaxReturnStatusSchema = z.enum(["draft", "generated", "filed"]);
export const TaxReturnSchema = z.object({
  id: UuidSchema,
  regimeId: UuidSchema,
  regimeCode: z.string(),
  regimeVersion: z.number().int(),
  periodStart: DateSchema,
  periodEnd: DateSchema,
  status: TaxReturnStatusSchema,
  payloadSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  generatedBy: UuidSchema.nullable(),
  filedAt: TimestampSchema.nullable(),
  attachmentId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
});
export type TaxReturnDto = z.infer<typeof TaxReturnSchema>;

export const CreateTaxReturnBody = z
  .object({
    /** The regime CODE and version, resolved server-side — a screen picks from the tax-code list's rows and
     *  never has to hold a per-tenant uuid.
     *
     *  ⚠️ **A regime code admits a lower-case letter after the first**, and the tax-CODE pattern above does
     *  not. The shipped regime is `SYNTH-MY-v1`; the all-caps form would reject the only regime this slice
     *  ships and no return could be created at all. This regex is the same one
     *  `tax-pack.schema.json`'s `$defs/regimeCode` carries, and the two must stay identical. */
    regimeCode: z.string().regex(/^[A-Z][A-Za-z0-9-]{1,31}$/),
    regimeVersion: z.number().int().positive(),
    periodStart: DateSchema,
    periodEnd: DateSchema,
  })
  .refine((b) => b.periodEnd >= b.periodStart, {
    message: "periodEnd must not precede periodStart",
  });

export const TaxReturnQuery = ListQuery.extend({
  "filter[regimeCode][eq]": z.string().optional(),
}).strict();
export const TaxReturnList = ListEnvelope(TaxReturnSchema);

export const TaxReturnTieOutRowSchema = z.object({
  accountCode: z.string(),
  boxCodes: z.array(z.string()),
  boxBase: Amount,
  ledgerBase: Amount,
  difference: Amount,
});

/** The single-return read: the row, its boxes as generated, the payload bytes, and the tie-out. */
export const TaxReturnDetail = z.object({
  taxReturn: TaxReturnSchema,
  boxes: z.array(ReturnBoxSchema),
  payload: z.string().nullable(),
  tieOut: z.array(TaxReturnTieOutRowSchema),
  currency: CurrencySchema,
});

/** 5B — the body of `POST …/tax-returns/{taxReturnId}/file`. Both members optional: the ordinary
 *  filing sends `{}` and takes the server clock. */
export const FileTaxReturnBody = z
  .object({
    filedAt: TimestampSchema.optional(),
    attachmentId: UuidSchema.optional(),
  })
  .strict();
