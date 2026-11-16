import { z } from "zod";
import { DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** §4.2.1's four rounding modes — the scheme's FALLBACK when a rate table declares none. */
export const RoundingModeSchema = z
  .enum(["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"])
  .meta({ id: "RoundingMode" });

/** A scheme is a ROW, never an enum (spec:2080). There is no create route: schemes are seed-pack data (ADR 0073). */
export const StatutorySchemeSchema = z
  .object({
    id: UuidSchema,
    // The §4.12.3 pattern, so a scheme code and a rate table's `scheme` cannot disagree (migration 0084 checks it).
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).nullable(),
    payableAccountId: UuidSchema.nullable(), // 8B fills it (amendment A2)
    employerExpenseAccountId: UuidSchema.nullable(),
    authorityPartyId: UuidSchema.nullable(),
    employerRegistration: z.string().max(80).nullable(), // ⚠️ OD-23 (amendment A3)
    roundingMode: RoundingModeSchema,
  })
  .meta({ id: "StatutoryScheme" });

export const StatutorySchemeList = ListEnvelope(StatutorySchemeSchema);

/** `definition` is `unknown` deliberately: the generated `RateTable` lives in `packages/domain/payroll`, which this
 *  core-tier package does not reach (spec:2366). The route parses it with `parseRateTable` and answers
 *  ERR_VALIDATION_FAILED with the validator's JSON Pointers — a better error than a Zod restatement would give. */
export const RateTableSchema = z
  .object({
    id: UuidSchema,
    schemeId: UuidSchema,
    schemeCode: z.string(),
    version: z.number().int().min(1),
    effectiveFrom: DateSchema,
    effectiveTo: DateSchema.nullable(),
    definition: z.unknown(),
    source: z.string(),
    loadedBy: UuidSchema,
    verifiedBy: UuidSchema.nullable(),
    verifiedAt: TimestampSchema.nullable(),
  })
  .meta({ id: "StatutoryRateTable" });

export const RateTableList = ListEnvelope(RateTableSchema);

/** Closed: the definition is the whole of a load. Version, dates and source are READ from it, never sent beside it,
 *  so the row and its definition cannot disagree. */
export const LoadRateTableBody = z
  .object({ definition: z.unknown() })
  .strict()
  .meta({ id: "LoadRateTableBody" });

/** Neither list takes a query: a company has a handful of schemes and a scheme a handful of versions, returned whole
 *  with a constant `null` cursor. Closed, so `limit`, `cursor`, a filter or a sort is refused rather than ignored. */
export const StatutoryListQuery = z.object({}).strict().meta({ id: "StatutoryListQuery" });

export type RoundingModeDto = z.infer<typeof RoundingModeSchema>;
export type StatutorySchemeDto = z.infer<typeof StatutorySchemeSchema>;
export type RateTableDto = z.infer<typeof RateTableSchema>;
