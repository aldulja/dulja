import { z } from "zod";
import { ListEnvelope, ListQuery, MoneySchema, TimestampSchema, UuidSchema } from "../common";

const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

/** spec:1169 — one entity with one discriminator, replacing the legacy Account's twenty Is* flags (SAH-072).
 *  `student` and `dealer` are reserved names carried so a later module is data, not a migration. */
export const PartyKindSchema = z.enum(["customer", "vendor", "employee", "student", "dealer"]);

// 4A / 0045. `creditLimit` is MoneySchema and not a bare string: a party is a top-level resource and its
// currency is not implied by its path (§4.2.8, and 3C's sub-resource exception does not reach here).
const CREDIT_LIMIT_DESCRIPTION =
  "The party's credit limit in the COMPANY'S BASE CURRENCY, or null for no limit (a zero limit is 0.0000). " +
  "`party.credit_limit` is a bare numeric(19,4) with no currency column, and `app.party_open_balance` " +
  "converts every open document to base before comparing — so a limit expressed in the party's own trading " +
  "currency would be compared against the wrong number. The wire currency is therefore the base currency, " +
  "never the party's, and `MoneySchema` carries it explicitly so no reader has to guess. Setting it needs " +
  "accounting.credit_limit.override as well as accounting.party.manage (spec:2158).";
// 4A / 0045, on 6B's behalf (A10(b)). 4A resolves nothing against it — 6B's `resolvePrice` and 3D's sales
// screens do — but a column with no way to set it is a column §3.7.6's "customer-specific pricing" still
// cannot use, so the field the DDL adds is exposed in the same commit rather than left to a later slice.
const PRICE_LIST_DESCRIPTION =
  "The customer's price list (`app.price_list`, 3A), or null when this customer has no list of its own and " +
  "pricing falls back to the branch list and then the company-wide one. A trade LEVEL is " +
  "`price_list.customer_kind` and is the list's property, not the party's; this is the pointer.";

/** Accepted: never negative — `party_credit_limit_check` would otherwise surface as a 500 (SQLSTATE 23514). */
const CreditLimitInput = MoneySchema.refine((m) => !m.amount.startsWith("-"), {
  message: "a credit limit cannot be negative",
  path: ["amount"],
});

export const PartySchema = z.object({
  id: UuidSchema,
  kind: PartyKindSchema,
  code: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().max(200).nullable(),
  receivableAccountId: UuidSchema.nullable(),
  payableAccountId: UuidSchema.nullable(),
  currency: CurrencyCodeSchema.nullable(),
  taxRegistration: z.string().max(64).nullable(),
  email: z.string().email().max(320).nullable(),
  phone: z.string().max(64).nullable(),
  address: z.record(z.string(), z.unknown()),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  // 4A / 0045 — the customer's commercial terms (contracts §4.5.7).
  creditLimit: MoneySchema.nullable().describe(CREDIT_LIMIT_DESCRIPTION),
  paymentTermId: UuidSchema.nullable(),
  creditHold: z.boolean(),
  priceListId: UuidSchema.nullable().describe(PRICE_LIST_DESCRIPTION),
});

export const CreatePartyBody = z
  .object({
    kind: PartyKindSchema,
    code: z.string().min(1).max(64),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    receivableAccountId: UuidSchema.optional(),
    payableAccountId: UuidSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    taxRegistration: z.string().max(64).optional(),
    email: z.string().email().max(320).optional(),
    phone: z.string().max(64).optional(),
    address: z.record(z.string(), z.unknown()).optional(),
    // 4A / 0045. Nullable as well as optional so a PATCH can CLEAR a value: null is "no limit", "no term",
    // "no list of its own". `creditHold` is a plain boolean — a hold is on or off.
    creditLimit: CreditLimitInput.nullable().optional().describe(CREDIT_LIMIT_DESCRIPTION),
    paymentTermId: UuidSchema.nullable().optional(),
    creditHold: z.boolean().optional(),
    priceListId: UuidSchema.nullable().optional().describe(PRICE_LIST_DESCRIPTION),
  })
  .strict();

/** `code` and `kind` are absent: a party's identity and its discriminator do not change under an edit.
 *  `.strict()` turns an attempt into ERR_VALIDATION_FAILED rather than a silent no-op. `creditHold` and
 *  `priceListId` are editable under accounting.party.manage (spec:2158 gives the clerk credit terms);
 *  `creditLimit` additionally needs accounting.credit_limit.override, which the route checks per field. */
export const UpdatePartyBody = CreatePartyBody.omit({ kind: true, code: true }).partial().strict();

export const PartyQuery = ListQuery.extend({
  "filter[kind][eq]": PartyKindSchema.optional(),
  "filter[code][eq]": z.string().optional(),
  includeArchived: z.enum(["true", "false"]).default("false"),
});
export const PartyList = ListEnvelope(PartySchema);
