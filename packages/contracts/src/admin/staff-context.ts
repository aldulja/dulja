import { z } from "zod";
import { CurrencySchema, UuidSchema } from "../common";

export const StaffContextSchema = z
  .object({
    companies: z.array(
      z
        .object({
          id: UuidSchema,
          code: z.string(),
          name: z.string(),
          baseCurrency: CurrencySchema,
          branches: z.array(
            z
              .object({
                id: UuidSchema,
                code: z.string(),
                nameEn: z.string(),
                nameAr: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type StaffContext = z.infer<typeof StaffContextSchema>;
