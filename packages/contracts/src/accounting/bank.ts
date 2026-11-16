import { z } from "zod";
import {
  CurrencySchema,
  DateSchema,
  ListEnvelope,
  ListQuery,
  MoneySchema,
  TimestampSchema,
  UuidSchema,
} from "../common";

/**
 * Slice 4B, contracts §4.8.3 — the statement half of bank reconciliation (Task 6; Task 8 adds the
 * request/response schemas that need `bank_match`). ADR 0048.
 *
 * §4.2.8's second registered bare form (4B amendment 12, round 8): a row's money column is a bare signed
 * 4-dp string because the row carries its own `currency` exactly once. File-local, never a `common.ts`
 * export; `MoneySchema` stays the rule for a standalone amount.
 */
const Amount = z.string().regex(/^-?\d+\.\d{4}$/);

/** A column by 0-based index or by header name — a position in the file, never an amount. */
const Column = z.union([z.number().int().min(0), z.string().min(1)]);

/** `packages/db`'s `CsvMapping`, on the wire. The statement header rides the mapping because §4.8.3 freezes
 *  `importStatement`'s input and the three header columns are NOT NULL; the currency does not — it is the
 *  bank account's. */
export const CsvMappingSchema = z
  .object({
    statement: z
      .object({
        statementDate: DateSchema,
        openingBalance: Amount,
        closingBalance: Amount,
      })
      .strict(),
    columns: z
      .object({
        valueDate: Column,
        description: Column,
        reference: Column.optional(),
        amount: Column.optional(),
        debit: Column.optional(),
        credit: Column.optional(),
      })
      .strict()
      .refine(
        (c) => (c.amount !== undefined) !== (c.debit !== undefined || c.credit !== undefined),
        { message: "name either `amount` (signed) or the `debit`/`credit` pair, not both" },
      ),
    dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]),
    hasHeader: z.boolean(),
    delimiter: z.string().length(1).optional(),
    decimalComma: z.boolean().optional(),
  })
  .strict();

export const ImportStatementBody = z
  .object({
    bankAccountId: UuidSchema,
    csv: z.string().min(1).max(4_000_000),
    mapping: CsvMappingSchema,
  })
  .strict();

export const BankStatementSchema = z.object({
  id: UuidSchema,
  bankAccountId: UuidSchema,
  statementDate: DateSchema,
  openingBalance: Amount,
  closingBalance: Amount,
  currency: CurrencySchema,
  lines: z.number().int(),
});
export const BankStatementList = ListEnvelope(BankStatementSchema);

/**
 * §4.2.8 Layer 2's default — a literal `filter[<field>][<op>]` key, typed and visible in the OpenAPI document
 * (Task 8). `.strict()` for the reason `BankStatementLineQuery` gives below: `ListQuery` strips an unknown key.
 */
export const BankStatementQuery = ListQuery.extend({
  "filter[bank_account_id][eq]": UuidSchema.optional(),
}).strict();

export const BankStatementLineSchema = z.object({
  id: UuidSchema,
  statementId: UuidSchema,
  lineNo: z.number().int(),
  valueDate: DateSchema,
  description: z.string(),
  reference: z.string().nullable(),
  /** signed: positive is money IN (the bank's convention) */
  amount: Amount,
  /** Σ live matches against the line — a magnitude */
  matchedAmount: Amount,
});

/**
 * §4.2.8 layer 2: no slice introduces a new flat filter parameter, so the unmatched filter is a literal
 * `filter[<field>][<op>]` key (2A's form). `z.enum(["true","false"])` and not `z.coerce.boolean()`: a query
 * value is always a string and `Boolean("false")` is `true`, so the coercion would make
 * `filter[matched][eq]=false` mean "matched only", silently. `.strict()` for 1B's reason: `ListQuery` is a
 * plain `z.object`, which STRIPS an unknown key, so a misspelt `filter[mached][eq]` would answer 200 with
 * the wrong rows.
 */
export const BankStatementLineQuery = ListQuery.extend({
  "filter[matched][eq]": z.enum(["true", "false"]).optional(),
}).strict();
export const BankStatementLineList = ListEnvelope(BankStatementLineSchema);

// The DTO aliases the OD-24 screens import — a schema is a value, not a type (1B's `TrialBalanceRowDto`).
export type BankStatementDto = z.infer<typeof BankStatementSchema>;
export type BankStatementLineDto = z.infer<typeof BankStatementLineSchema>;

// ── Task 8 — the matching half on the wire (§4.8.3) ───────────────────────────────────────────────────────

/** The CHECK's four labels (migration 0050): 6D's and 8C's are admitted now, as the table admits them. */
export const ReconcilableKindSchema = z.enum([
  "receipt",
  "payment",
  "till_banking",
  "payroll_batch",
]);

export const CreateBankMatchBody = z
  .object({
    kind: ReconcilableKindSchema,
    documentId: UuidSchema,
    /** a magnitude, in the statement's currency; the statement line's sign carries the direction */
    amount: MoneySchema,
  })
  .strict();

/** The reason is compelled (migration 0050's `bank_match_guard`); a blank one is refused by the service. */
export const UnmatchBody = z.object({ reason: z.string().min(1).max(500) }).strict();

/** One `app.bank_match` row. `amount` is a magnitude in its statement's currency; the row survives an unmatch
 *  with `unmatchedAt` and `unmatchReason` set (spec:2049). */
export const BankMatchSchema = z.object({
  id: UuidSchema,
  statementLineId: UuidSchema,
  kind: ReconcilableKindSchema,
  reconcilableDocumentId: UuidSchema,
  amount: MoneySchema,
  matchedAt: TimestampSchema,
  unmatchedAt: TimestampSchema.nullable(),
  unmatchReason: z.string().nullable(),
});

/** `packages/db`'s `Reconcilable` on the wire. */
export const ReconcilableSchema = z.object({
  kind: ReconcilableKindSchema,
  documentId: UuidSchema,
  bankAccountId: UuidSchema,
  valueDate: DateSchema,
  /** a magnitude in the bank account's currency; the direction is the kind's */
  amount: MoneySchema,
  reference: z.string().nullable(),
});

/** `reconciledBalance` composed with `unmatchedStatementLines` — the frozen return type has no member for the
 *  unmatched statement lines, so the route composes the two halves rather than widening it (ADR 0048). */
export const ReconciledBalanceSchema = z.object({
  statement: MoneySchema,
  ledger: MoneySchema,
  unreconciled: z.array(ReconcilableSchema),
  unmatchedLines: z.array(BankStatementLineSchema),
});

/** Both keys REQUIRED, literal (§4.2.8 Layer 2), and nothing else admitted. */
export const ReconciliationQuery = z
  .object({
    "filter[bank_account_id][eq]": UuidSchema,
    "filter[as_of][eq]": DateSchema,
  })
  .strict();

// The remaining DTO aliases Task 11's screens import. `ReconcilableDto` matters most: `Reconcilable` is a
// packages/db interface and `apps/backoffice` may not reach packages/db (§3.1), so the wire shape has to have
// a name here or the screen has no legal way to spell it.
export type BankMatchDto = z.infer<typeof BankMatchSchema>;
export type ReconcilableDto = z.infer<typeof ReconcilableSchema>;
export type ReconciledBalanceDto = z.infer<typeof ReconciledBalanceSchema>;
