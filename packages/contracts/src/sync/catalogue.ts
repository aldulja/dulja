// packages/contracts/src/sync/catalogue.ts
import { z } from "zod";
import { CursorSchema } from "../common";

export const StreamSchema = z.enum([
  "item",
  "price_list",
  "price_list_line",
  "promotion",
  "customer",
  "tax_code",
  "cashier",
  "branch_pos_policy",
]);
/**
 * Named components (plan 6A T8's `.openapi("Change")` / `.openapi("CataloguePage")`), spelled as Zod 4's
 * `.meta({ id })` like every other named schema in this package: `@dulja/contracts` depends on `zod` alone, and
 * `@hono/zod-openapi` turns a meta `id` into the same `#/components/schemas/<id>` reference.
 */
export const ChangeSchema = z
  .object({
    stream: StreamSchema,
    op: z.enum(["upsert", "delete"]),
    id: z.string().uuid(),
    /** A bigint on the wire is a STRING: a revision past 2^53 read as a JSON number would round (T1). */
    revision: z.string().regex(/^\d+$/),
    row: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: "Change" });
/** snake_case members: §4.10.1 fixes them as the spec's own names (spec:1297). */
export const CataloguePageSchema = z
  .object({
    changes: z.array(ChangeSchema),
    next_cursor: CursorSchema,
    has_more: z.boolean(),
  })
  .meta({ id: "CataloguePage" });
/**
 * `since` stays a bare string, not the plan's `CursorSchema.optional()`: the route decodes it and answers a
 * malformed cursor ERR_SYNC_CURSOR_INVALID, which a pattern here would pre-empt with ERR_VALIDATION_FAILED.
 */
export const CatalogueQuery = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});
