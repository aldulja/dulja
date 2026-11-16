import { isCalendarDate } from "@dulja/domain";
import { z } from "zod";
import { AppError } from "./errors";
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
export const UuidSchema = z.string().uuid(),
  /** A real calendar date, `YYYY-MM-DD`. The shape alone admitted `2026-02-30`, which postgres.js rolls over
   *  to 2026-03-02 on the way to a `date` column — so a reversal, a receipt or a revaluation could land in a
   *  period nobody asked for. The refinement skips a string the regex already refused, so a malformed date
   *  carries one issue, not two. */
  DateSchema = z
    .string()
    .regex(DATE_SHAPE)
    .refine((value) => !DATE_SHAPE.test(value) || isCalendarDate(value), {
      message: "must be a calendar date YYYY-MM-DD",
    }),
  TimestampSchema = z.string().datetime({ offset: true }),
  CurrencySchema = z.string().regex(/^[A-Z]{3}$/),
  MoneySchema = z.object({ amount: z.string().regex(/^-?\d+\.\d{4}$/), currency: CurrencySchema }),
  QuantitySchema = z.string().regex(/^-?\d+\.\d{6}$/),
  /** A quantity a caller ASKS FOR — a pick, a link, a dispatch. Strictly positive: `QuantitySchema` admits
   *  a leading minus because a stored quantity is signed (a movement, a variance), but a requested one
   *  is a magnitude, and a negative here reached services that flipped the movement's direction — a
   *  branch clerk could pull another branch's in-transit goods into their own stock by dispatching -5.
   *  Phase 3 review pass. */
  PositiveQuantitySchema = z
    .string()
    .regex(/^\d+\.\d{6}$/)
    .refine((q) => !/^0+\.0{6}$/.test(q), {
      message: "a requested quantity must be greater than zero",
    }),
  /** A COUNTED quantity: zero is a legitimate answer (an empty shelf, a total-loss receipt), a negative
   *  is not. */
  NonNegativeQuantitySchema = z.string().regex(/^\d+\.\d{6}$/),
  RateSchema = z.string().regex(/^\d+\.\d{8}$/),
  CursorSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const ListEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });
export const ListQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  sort: z.string().optional(),
  fields: z.string().optional(),
});
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  remedy: z.string(),
  requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export interface Cursor {
  k: unknown[];
  id: string;
}
export const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
export function decodeCursor(raw: string): Cursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as Cursor).k) ||
      // Every keyset a route encodes is a scalar Postgres text — `k` is `[]`, `[code]`, `[effective_from]` or
      // `[created_at_text]` — so an object or an array inside it is hand-crafted; the cursor is base64url, not
      // signed. The check stops at the JSON type on purpose: a content rule would have to differ per route,
      // because `id` is a uuid on five of them and a bigint on the audit log.
      !(value as Cursor).k.every((part) => typeof part === "string" || typeof part === "number") ||
      typeof (value as Cursor).id !== "string" ||
      (value as Cursor).id === ""
    )
      throw new Error();
    return value as Cursor;
  } catch {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
  }
}

export const FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface FilterClause {
  field: string;
  op: FilterOp;
  value: string;
}

export function parseFilters(query: Record<string, string | string[]>): FilterClause[] {
  const filters: FilterClause[] = [];
  for (const [key, raw] of Object.entries(query)) {
    const match = /^filter\[([a-z_]+)\]\[([a-z]+)\]$/.exec(key);
    if (!match) continue;
    const op = match[2] as FilterOp;
    if (!(FILTER_OPS as readonly string[]).includes(op))
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        `filter operator ${JSON.stringify(op)} is not one of ${FILTER_OPS.join(", ")}`,
      );
    filters.push({
      field: match[1]!,
      op,
      value: Array.isArray(raw) ? raw[0]! : raw,
    });
  }
  return filters;
}
