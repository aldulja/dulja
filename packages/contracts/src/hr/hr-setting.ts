import { z } from "zod";
import { UuidSchema } from "../common";

/** spec:2086's two values — CONFIGURATION the accountant confirms, never a statutory claim (⚠️ OD-23). */
export const ProrationRuleSchema = z
  .enum(["calendar_days", "working_days"])
  .meta({ id: "ProrationRule" });

const PayDaySchema = z.number().int().min(1).max(31).nullable();

/** The registrations are RETURNED here and STORED on `statutory_scheme` (amendments A3, A4): one read, one place to
 *  write, no copy to keep in step. */
export const HrSettingSchema = z
  .object({
    companyId: UuidSchema,
    prorationRule: ProrationRuleSchema,
    payDay: PayDaySchema,
    employerRegistrations: z.array(
      z.object({
        schemeId: UuidSchema,
        schemeCode: z.string(),
        registration: z.string().max(80).nullable(),
      }),
    ),
  })
  .meta({ id: "HrSetting" });

/** Closed, as every 8A write body is: an unknown member is refused rather than ignored. */
export const UpdateHrSettingBody = z
  .object({
    prorationRule: ProrationRuleSchema,
    payDay: PayDaySchema,
    employerRegistrations: z
      .array(
        z
          .object({ schemeId: UuidSchema, registration: z.string().min(1).max(80).nullable() })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .meta({ id: "UpdateHrSettingBody" });

export type ProrationRuleDto = z.infer<typeof ProrationRuleSchema>;
export type HrSettingDto = z.infer<typeof HrSettingSchema>;
export type UpdateHrSettingInput = z.input<typeof UpdateHrSettingBody>;
