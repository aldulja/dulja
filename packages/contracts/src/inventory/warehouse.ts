import { z } from "zod";
import { ListEnvelope, ListQuery, TimestampSchema, UuidSchema } from "../common";

/** §4.6.1 — `in_transit` is the two-step-transfer waypoint spec:1053 needs; 3D uses it. */
export const WarehouseKindSchema = z.enum(["stock", "in_transit"]);

export const WarehouseSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  kind: WarehouseKindSchema,
  branchId: UuidSchema,
  parentId: UuidSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/** `branchId` is required because `warehouse.branch_id` is NOT NULL — head-office stores carry the
 *  head-office BRANCH value, which is what makes 6C's branch-isolation policy total (0029). */
export const CreateWarehouseBody = z
  .object({
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    kind: WarehouseKindSchema.optional(),
    branchId: UuidSchema,
    parentId: UuidSchema.nullable().optional(),
  })
  .strict();

/** `code`, `kind` and `branch_id` are immutable: movements already written are keyed by this row, and moving
 *  a warehouse to another branch would silently re-scope every historical figure (LEGACY-045). */
export const UpdateWarehouseBody = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().max(200).nullable().optional(),
    parentId: UuidSchema.nullable().optional(),
  })
  .strict();

export const WarehouseQuery = ListQuery.extend({
  "filter[kind][eq]": WarehouseKindSchema.optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});

export const WarehouseList = ListEnvelope(WarehouseSchema);

export const WarehouseNodeSchema = WarehouseSchema.extend({
  depth: z.number().int().nonnegative(),
  /** Codes from the root to this node inclusive — what a screen renders as a breadcrumb. */
  path: z.array(z.string()),
});

/** NOT a `ListEnvelope`: a tree is returned whole (a company has tens of warehouses, not thousands) and
 *  paging it would hand the caller a fragment it cannot reassemble. */
export const WarehouseTree = z.object({ items: z.array(WarehouseNodeSchema) });
