import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** See the note in `price-list.ts`: the 3A data layer returns `timestamptz` columns as Postgres text
 *  (`starts_at::text`), which `TimestampSchema` rejects. The REQUEST side below still uses
 *  `TimestampSchema`, because what a client sends is ours to fix and RFC 3339 is what it must send. */
const PgTimestampSchema = z.string().min(1);

const fraction = (value: string): string =>
  (/\.(\d+)(?:Z|[+-])/.exec(value)?.[1] ?? "").replace(/0+$/, "");

function validWindow(b: {
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
}): boolean {
  if (!b.startsAt || !b.endsAt) return true;
  // RFC 3339 allows different offsets: compare instants, never their textual clock times.
  const start = Date.parse(b.startsAt);
  const end = Date.parse(b.endsAt);
  if (start !== end) return end > start;
  // Date truncates sub-millisecond precision, while PostgreSQL retains microseconds. Resolve a
  // millisecond tie using the original fractional seconds; trailing zeroes denote the same instant.
  return fraction(b.endsAt) > fraction(b.startsAt);
}

/** Migration 0030's `promotion_kind_check`, spelled once. `buy_one_get_one` is `bundle` with a definition;
 *  a fourth label would be a migration, so the wire vocabulary is closed here exactly as the CHECK is. */
export const PromotionKindSchema = z.enum(["percent_off", "amount_off", "bundle"]);

export const PromotionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  kind: PromotionKindSchema,
  /** Interpreted by 6B at the till; no code in slice 3A reads it, so no code in slice 3A shapes it either. */
  definition: z.record(z.string(), z.unknown()),
  startsAt: PgTimestampSchema.nullable(),
  endsAt: PgTimestampSchema.nullable(),
  /** null = every branch (spec:1312). */
  branchId: UuidSchema.nullable(),
  createdAt: PgTimestampSchema,
});

export const CreatePromotionBody = z
  .object({
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    kind: PromotionKindSchema,
    definition: z.record(z.string(), z.unknown()),
    startsAt: TimestampSchema.optional(),
    endsAt: TimestampSchema.optional(),
    branchId: UuidSchema.optional(),
  })
  .strict()
  // Mirrors `promotion_window_check` (strictly greater, as the CHECK is) so a reversed window is a 400 naming
  // `endsAt` rather than a 500 from a check_violation.
  .refine(validWindow, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

/** `code`, `kind` and `branchId` are absent: an offer's identity, its interpretation at the till and the
 *  branch it belongs to are set once. There is no archive route — a promotion is RETIRED by patching
 *  `endsAt`, because §4.6.1 gives this table no `archived_at`. */
export const UpdatePromotionBody = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().max(200).nullable().optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
    startsAt: TimestampSchema.nullable().optional(),
    endsAt: TimestampSchema.nullable().optional(),
  })
  .strict()
  .refine(validWindow, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const PromotionQuery = ListQuery.extend({
  /** A branch's offers PLUS the company-wide ones (spec:1312). */
  branchId: UuidSchema.optional(),
  /** Keeps only the offers whose window contains this instant. */
  activeOn: TimestampSchema.optional(),
});
export const PromotionList = ListEnvelope(PromotionSchema);
