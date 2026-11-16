import { z } from "zod";
import { UuidSchema } from "../common";

/**
 * `GET /v1/me/companies` (ADR 0089) — the companies in which the caller holds at least one live role, each with the
 * branches that role admits. A selector, never data: ids, codes and names only, and it grants nothing — every screen
 * reached through it still asks its own permission. `.strict()` so an extra column cannot leak out unnoticed.
 */
export const MyCompaniesSchema = z
  .object({
    companies: z.array(
      z
        .object({
          id: UuidSchema,
          code: z.string(),
          name: z.string(),
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

export type MyCompanies = z.infer<typeof MyCompaniesSchema>;
