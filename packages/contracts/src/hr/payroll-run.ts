import { z } from "zod";
import {
  CursorSchema,
  DateSchema,
  ListEnvelope,
  MoneySchema,
  QuantitySchema,
  UuidSchema,
} from "../common";

// 8B T10 (§4.2.8) — the payroll-run wire module. A run is a PAYROLL document; submit, approve and post go through
// 2B's generic `…/documents/{documentId}/transitions` route and have no schema here.

export const PayrollRunKindSchema = z
  .enum(["regular", "supplementary", "final"])
  .meta({ id: "PayrollRunKind" });

/** The one status union. `PayrollRunStatus` in `packages/db/src/hr/run.ts` is its TypeScript twin, and the two are
 *  edited together or the handler's return type stops matching its declared response schema. */
export const PayrollRunStatusSchema = z
  .enum(["draft", "submitted", "approved", "issued", "void", "posted", "reversed"])
  .meta({ id: "PayrollRunStatus" });

const ShareSchema = z.enum(["employee", "employer"]);

export const PayrollLineSchema = z
  .object({
    documentLineId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    componentId: UuidSchema.nullable(),
    /** The component's code beside its id (8B T11), so the approval screen names it without a catalogue read. */
    componentCode: z.string().nullable(),
    schemeId: UuidSchema.nullable(),
    schemeCode: z.string().nullable(),
    share: ShareSchema.nullable(),
    quantity: QuantitySchema.nullable(),
    /** §4.2.8's MoneySchema — `{ amount: "2000.0000", currency: "MYR" }`, a magnitude: the policy's `side` carries
     *  the direction (§4.4.2 A9). */
    amount: MoneySchema,
    /** LEGACY-013: the rate-table version a statutory line pinned; null on a component or net-pay line. */
    rateTableVersion: z.number().int().nullable(),
    /** spec:2087: a manual statutory override is never silent — its reason is on the line. */
    overrideReason: z.string().nullable(),
  })
  .meta({ id: "PayrollLine" });

/** 8B T11 (spec:2087) — one manual statutory override as the approval screen lists it. */
export const PayrollOverrideSchema = z
  .object({
    documentLineId: UuidSchema,
    employeeId: UuidSchema,
    employeeNumber: z.string(),
    schemeId: UuidSchema,
    schemeCode: z.string(),
    share: ShareSchema,
    amount: MoneySchema,
    reason: z.string(),
    enteredBy: UuidSchema,
    enteredByName: z.string(),
    enteredAt: z.string(),
  })
  .meta({ id: "PayrollOverride" });

const PinnedTableSchema = z.object({ schemeId: UuidSchema, version: z.number().int() });

export const PayrollRunSchema = z
  .object({
    documentId: UuidSchema,
    number: z.string().nullable(),
    series: z.string(),
    status: PayrollRunStatusSchema,
    kind: PayrollRunKindSchema,
    periodStart: DateSchema,
    periodEnd: DateSchema,
    payDate: DateSchema,
    pinnedTables: z.array(PinnedTableSchema),
    lines: z.array(PayrollLineSchema),
    /** spec:2087 — every manual statutory override on the run, flagged, with its reason and who entered it. */
    overrides: z.array(PayrollOverrideSchema),
    /** spec:2174 R3 (amendment A12): everyone who changed an employee's compensation effective inside the period —
     *  who, for whom and from when, never an amount (migration 0090's bounded lookup, readable under
     *  `hr.payroll.read`). */
    compensationChangedBy: z.array(
      z.object({
        principalId: UuidSchema,
        displayName: z.string(),
        employeeNumber: z.string(),
        effectiveFrom: DateSchema,
      }),
    ),
  })
  .meta({ id: "PayrollRun" });

/** `.strict()`: an unknown member is refused rather than dropped. `employeeIds` is permitted only for a
 *  `supplementary` or `final` run — a regular run reads the whole active master, because a regular run that silently
 *  skipped someone is exactly the failure a payroll register exists to catch. */
export const CreatePayrollRunBody = z
  .object({
    kind: PayrollRunKindSchema.default("regular"),
    periodStart: DateSchema,
    periodEnd: DateSchema,
    payDate: DateSchema,
    effectiveDate: DateSchema,
    branchId: UuidSchema,
    employeeIds: z.array(UuidSchema).min(1).max(1000).optional(),
  })
  .strict()
  .refine((b) => b.kind !== "regular" || b.employeeIds === undefined, {
    message: "employeeIds is permitted only on a supplementary or final run",
    path: ["employeeIds"],
  })
  .refine((b) => b.periodEnd >= b.periodStart, {
    message: "periodEnd must not be before periodStart",
    path: ["periodEnd"],
  })
  .refine((b) => b.payDate >= b.periodStart, {
    message: "payDate must not be before periodStart",
    path: ["payDate"],
  })
  .meta({ id: "CreatePayrollRunBody" });

/** spec:2087's manual statutory override is a **per-employee** line — `POST …/payroll-runs/{documentId}/overrides`. */
export const SetPayrollOverrideBody = z
  .object({
    employeeId: UuidSchema,
    schemeId: UuidSchema,
    share: ShareSchema,
    amount: MoneySchema,
    reason: z.string().min(1).max(500),
  })
  .strict()
  .meta({ id: "SetPayrollOverrideBody" });

/** §4.2.8 Layer 2: literal `filter[…]` keys, four field × operator pairs, keyset paging on (period_start, id).
 *  Closed (`.strict()`, the 8A query form): a flat or unknown parameter is refused, never silently ignored; `sort` and
 *  `fields` are bounded to the empty string because the order is fixed (period_start desc, id desc). */
export const PayrollRunQuery = z
  .object({
    "filter[kind][eq]": PayrollRunKindSchema.optional(),
    "filter[status][eq]": PayrollRunStatusSchema.optional(),
    "filter[periodStart][gte]": DateSchema.optional(),
    "filter[periodEnd][lte]": DateSchema.optional(),
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();

// `lines`, `overrides` and `compensationChangedBy` are detail-only — the list handler's head query returns none of
// them, and a list item that declared them would make `openapi.json` describe a body the route never sends.
export const PayrollRunListItem = PayrollRunSchema.omit({
  lines: true,
  overrides: true,
  compensationChangedBy: true,
}).meta({ id: "PayrollRunListItem" });
export const PayrollRunList = ListEnvelope(PayrollRunListItem);

export type PayrollRunDto = z.infer<typeof PayrollRunSchema>;
export type CreatePayrollRunBodyDto = z.infer<typeof CreatePayrollRunBody>;
export type SetPayrollOverrideBodyDto = z.infer<typeof SetPayrollOverrideBody>;
