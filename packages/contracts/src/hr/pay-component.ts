import { z } from "zod";
import { ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/** Two values. spec:2079 and §4.6.1: an employer contribution is a scheme's employer share, never a third kind. */
export const PayComponentKindSchema = z
  .enum(["earning", "deduction"])
  .meta({ id: "PayComponentKind" });

export const PayComponentSchema = z
  .object({
    id: UuidSchema,
    code: z.string().min(1).max(40),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).nullable(),
    kind: PayComponentKindSchema,
    expenseAccountId: UuidSchema.nullable(),
    payableAccountId: UuidSchema.nullable(),
    quantityBased: z.boolean(),
    schemeIds: z.array(UuidSchema),
    archivedAt: TimestampSchema.nullable(),
  })
  .meta({ id: "PayComponent" });

/** `expenseAccountId` and `payableAccountId` are deliberately absent: 8B's chart seed sets them from the §4.15
 *  codes, and a caller pointing a component at an arbitrary account would make the PAYROLL policy's
 *  `line.component.expense_account` unpredictable. `.strict()` is what makes "absent" mean "refused" — a bare object
 *  would strip the key and answer 201 with a null account and no word that the field was discarded. */
export const CreatePayComponentBody = z
  .object({
    code: z.string().min(1).max(40),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    kind: PayComponentKindSchema,
    quantityBased: z.boolean().default(false),
  })
  .strict()
  .meta({ id: "CreatePayComponentBody" });

/** Rename only. `code` and `kind` are absent on purpose and `.strict()` refuses them: a posted payroll line is read
 *  back by component code years later, and changing `kind` would reverse the sign of every historical line. */
export const UpdatePayComponentBody = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().max(200).nullable().optional(),
  })
  .strict()
  .meta({ id: "UpdatePayComponentBody" });

/** The scheme joins to ADD. Additive in the database (`setComponentSchemes` is `on conflict do nothing` and there is
 *  no removal path — amendment A14): this body grows a set and never shrinks one; a mapping that must be withdrawn
 *  is withdrawn by archiving the component and replacing it. */
export const SetComponentSchemesBody = z
  .object({ schemeIds: z.array(UuidSchema).max(50) })
  .strict()
  .meta({ id: "SetComponentSchemesBody" });

/** Closed: the list handler reads `filter[kind][eq]` and `filter[archived][eq]` and nothing else, so a third key
 *  would be silently dropped and answered 200 — the failure §4.2.8 keeps out of the API. `sort` and `fields` are
 *  declared and bounded to the empty string (0B's `AuditLogQuery` form). It does not extend `ListQuery`: a company's
 *  catalogue is tens of rows, returned whole with a constant `null` cursor, so `cursor` and `limit` are refused by
 *  name rather than accepted and ignored. */
export const PayComponentQuery = z
  .object({
    "filter[kind][eq]": PayComponentKindSchema.optional(),
    "filter[archived][eq]": z.enum(["true", "false"]).optional(),
    sort: z.string().max(0, "sort is not supported on this resource").optional(),
    fields: z.string().max(0, "sparse fieldsets are not supported on this resource").optional(),
  })
  .strict();
export const PayComponentList = ListEnvelope(PayComponentSchema);
export type PayComponentDto = z.infer<typeof PayComponentSchema>;

/** ADR 0097 (full review PRD-08) — `POST /v1/companies/{companyId}/payroll-accounts`: no input. */
export const LinkPayrollAccountsBody = z
  .object({})
  .strict()
  .meta({ id: "LinkPayrollAccountsBody" });
/** What `linkPayrollAccounts` wired: the counts of components and schemes it linked (0 on a repeat; a value a
 *  tenant already chose is never overwritten). `missingCodes` is always empty on a 200 — a missing code is a 422. */
export const PayrollAccountLinkageSchema = z
  .object({
    componentsLinked: z.number().int().min(0),
    schemesLinked: z.number().int().min(0),
    missingCodes: z.array(z.string()),
  })
  .meta({ id: "PayrollAccountLinkage" });
