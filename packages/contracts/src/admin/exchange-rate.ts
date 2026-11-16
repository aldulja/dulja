import { z } from "zod";
import {
  CurrencySchema as CurrencyCodeSchema,
  DateSchema,
  ListEnvelope,
  ListQuery,
  RateSchema,
  UuidSchema,
} from "../common";

export const ExchangeRateSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  fromCurrency: CurrencyCodeSchema,
  toCurrency: CurrencyCodeSchema,
  rate: RateSchema,
  effectiveFrom: DateSchema,
  source: z.string().min(1),
  enteredBy: UuidSchema,
});

export const CreateExchangeRateBody = z
  .object({
    fromCurrency: CurrencyCodeSchema,
    toCurrency: CurrencyCodeSchema,
    rate: RateSchema.refine((rate) => !/^0+\.0{8}$/.test(rate), "rate must be greater than zero"),
    effectiveFrom: DateSchema,
    source: z.string().min(1).max(200),
  })
  .strict();

export const ExchangeRateQuery = ListQuery.extend({
  from: CurrencyCodeSchema.optional(),
  to: CurrencyCodeSchema.optional(),
});
export const RateLookupQuery = z.object({
  from: CurrencyCodeSchema,
  to: CurrencyCodeSchema,
  on: DateSchema,
});
export const RateLookupResponse = z.object({
  from: CurrencyCodeSchema,
  to: CurrencyCodeSchema,
  rate: RateSchema,
  effectiveFrom: DateSchema,
  source: z.string(),
});
export const ExchangeRateList = ListEnvelope(ExchangeRateSchema);
