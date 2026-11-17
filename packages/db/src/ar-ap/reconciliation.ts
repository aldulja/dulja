// packages/db/src/ar-ap/reconciliation.ts
//
// Slice 4B, contracts §4.8.3. The statement-import half (Task 6) and the matching half (Task 7) — the
// `Reconcilable` registry, `match`, `unmatch`, `unmatchedStatementLines` and `reconciledBalance`. NOTHING in
// this file writes, updates or deletes a ledger_entry, an account_balance or a document row: the only table
// the matching half writes is app.bank_match, the posting-only-tables lint (§3.7.5) makes the rest
// mechanical, and it is the whole of LEGACY-031's and LEGACY-041's fix applied to reconciliation (ADR 0048).
//
// No file under packages/db/src imports decimal.js (§4.2.1): `D` is 0D's cloned precision-40 constructor,
// exported from the domain barrel. CSV amounts are parsed and summed with it and leave as 4-dp strings.
import { D, Money, currency, isCalendarDate } from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

/** The instance type of 0D's cloned constructor. 0D exports the value `D`, not decimal.js's type. */
type Dec = InstanceType<typeof D>;

/**
 * Where a figure sits in the file: a 0-based column index, or a header name. A position, never an amount —
 * which is why it is named rather than spelled `number | string` on the three money-named members below.
 */
type CsvColumn = number | string;

/**
 * The CSV column map AND the statement header the file does not carry. §4.8.3 freezes
 * `importStatement(tx, ctx, { companyId, bankAccountId, csv, mapping })`, so `mapping` is the only place the
 * three NOT NULL header figures can come from (§4.8.3 leaves `CsvMapping`'s body to 4B). `currency` is NOT
 * here: it is `coalesce(account.currency, company.base_currency)`, because a statement is always in the
 * account's own currency and letting a caller declare a different one is a class of error, not a feature.
 */
export interface CsvMapping {
  readonly statement: {
    /** YYYY-MM-DD */
    readonly statementDate: string;
    /** at most 4 dp */
    readonly openingBalance: string;
    /** at most 4 dp */
    readonly closingBalance: string;
  };
  readonly columns: {
    readonly valueDate: CsvColumn;
    readonly description: CsvColumn;
    readonly reference?: CsvColumn;
    /** Either the signed single column (positive is money IN)… */
    readonly amount?: CsvColumn;
    /** …or the two-column bank form, where DEBIT is money OUT: amount = credit − debit. */
    readonly debit?: CsvColumn;
    readonly credit?: CsvColumn;
  };
  readonly dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  readonly hasHeader: boolean;
  /** default "," */
  readonly delimiter?: string;
  /** "1.234,56" → "1234.56" */
  readonly decimalComma?: boolean;
}

/**
 * `packages/db` may not import `@dulja/contracts` (§3.1) and therefore cannot construct `AppError`, so this
 * is 3C's `LandedCostError` shape: an exported class carrying a `readonly code` that is a literal member of
 * `ErrCode`, plus a `readonly detail`. Exported, so `apps/api` can write `error instanceof ImportError`;
 * `code` a literal, so a handler's `new AppError(error.code, error.detail)` needs no cast; and the token
 * stays in the message, so the API's `fromDomainError` lifts it unaided. Every rejection an import can
 * produce is a bad file or a bad mapping, so the class has exactly one code.
 */
export class ImportError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly detail: string) {
    super(`ERR_VALIDATION_FAILED: ${detail}`);
    this.name = "ImportError";
  }
}

/** The one other refusal an import raises: the statement already exists. Same coded shape, fixed detail —
 *  the driver's own text quotes the rejected key straight back (LEGACY-083). */
function conflict(detail: string): Error {
  return Object.assign(new Error(`ERR_CONFLICT_UNIQUE: ${detail}`), {
    code: "ERR_CONFLICT_UNIQUE" as const,
  });
}

/**
 * RFC 4180-shaped: quoted fields, `""` as an escaped quote inside one, CRLF or LF row ends. A quote opens a
 * quoted field only at the field's start; elsewhere it is an ordinary character (`12" PIPE`). A blank line
 * yields no row. It builds no SQL and touches no database (hazard 21).
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  const pushField = () => {
    row.push(field);
    field = "";
    atFieldStart = true;
  };
  const pushRow = () => {
    // A blank line — the trailing newline included — must not yield a row of one empty field.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === delimiter) pushField();
    else if (ch === "\n") {
      pushField();
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
      atFieldStart = false;
    }
  }
  pushField();
  pushRow();
  return rows;
}

const AMOUNT = /^-?\d+(\.\d{1,4})?$/;

function columnIndex(spec: CsvColumn, header: readonly string[] | null, what: string): number {
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec < 0)
      throw new ImportError(
        `mapping names column ${spec} for ${what}; a column index is 0 or more`,
      );
    return spec;
  }
  if (!header)
    throw new ImportError(`mapping names column "${spec}" for ${what} but hasHeader is false`);
  const at = header.findIndex((h) => h.trim() === spec);
  if (at < 0)
    throw new ImportError(
      `mapping names column "${spec}" for ${what}, which the header does not contain`,
    );
  return at;
}

/** A calendar date as YYYY-MM-DD, or null. Pure string and integer work: no `Date`, so no timezone can
 *  move a value date (§3.2 — an accounting date is a `date`, never derived from a timestamp). */
function toIsoDate(raw: string, format: CsvMapping["dateFormat"]): string | null {
  const iso = format === "YYYY-MM-DD";
  const parts = (
    iso ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/
  ).exec(raw.trim());
  if (!parts) return null;
  const [, first, second, third] = parts as unknown as [string, string, string, string];
  const [y, m, d] = iso
    ? [first, second, third]
    : format === "DD/MM/YYYY"
      ? [third, second, first]
      : [third, first, second];
  const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isCalendarDate(date) ? date : null;
}

/** An amount of at most 4 dp, or null. Finer figures are refused, not rounded: a stored line that differs
 *  from the file is a silent correction (LEGACY-019), and the balance check below could not see it. */
function toDecimal(raw: string, decimalComma: boolean): Dec | null {
  const cleaned = raw.trim().replace(/\s/g, "");
  if (cleaned === "") return new D(0);
  const normalised = decimalComma
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  return AMOUNT.test(normalised) ? new D(normalised) : null;
}

function headerAmount(raw: string, what: string): Dec {
  if (!AMOUNT.test(raw))
    throw new ImportError(`mapping.statement.${what} "${raw}" is not an amount of at most 4 dp`);
  return new D(raw);
}

/** A row's cell at a mapped column; an unmapped column or a short row reads as empty. */
const cell = (cells: readonly string[], index: number | null): string =>
  index === null ? "" : (cells[index] ?? "");

interface ParsedLine {
  valueDate: string;
  description: string;
  reference: string | null;
  amount: Dec;
}

/**
 * Parses the file against the mapping, proves it adds up — `opening + Σ lines = closing`, or it is refused
 * naming the difference, because a statement that does not add up is a bad file or a bad mapping and
 * importing it would make every later "reconciled == ledger" assertion meaningless (ADR 0048) — and writes
 * one `bank_statement` and its lines. The actor reaches `imported_by` through `app.current_actor()`'s
 * default and `stamp_imported_by`, never through a parameter (LEGACY-044); hence `_ctx` is unread.
 */
export async function importStatement(
  tx: Sql,
  _ctx: TenantContext,
  input: { companyId: string; bankAccountId: string; csv: string; mapping: CsvMapping },
): Promise<{ statementId: string; lines: number }> {
  const m = input.mapping;
  if (!toIsoDate(m.statement.statementDate, "YYYY-MM-DD"))
    throw new ImportError(
      `mapping.statement.statementDate "${m.statement.statementDate}" is not a YYYY-MM-DD date`,
    );
  const opening = headerAmount(m.statement.openingBalance, "openingBalance");
  const closing = headerAmount(m.statement.closingBalance, "closingBalance");

  // A spreadsheet's UTF-8 export leads with a byte-order mark, which would otherwise hide the first header.
  const rows = parseDelimited(input.csv.replace(/^\uFEFF/, ""), m.delimiter);
  if (rows.length === 0) throw new ImportError("the CSV is empty");
  const header = m.hasHeader ? rows[0]! : null;
  const body = m.hasHeader ? rows.slice(1) : rows;
  if (body.length === 0) throw new ImportError("the CSV has a header and no rows");

  const signed = m.columns.amount !== undefined;
  const pair = m.columns.debit !== undefined || m.columns.credit !== undefined;
  if (signed === pair)
    throw new ImportError(
      signed
        ? "mapping.columns names both `amount` and the `debit`/`credit` pair; name one form"
        : "mapping.columns must name either `amount` (signed) or the `debit`/`credit` pair",
    );
  const iDate = columnIndex(m.columns.valueDate, header, "valueDate");
  const iDesc = columnIndex(m.columns.description, header, "description");
  const at = (spec: CsvColumn | undefined, what: string) =>
    spec === undefined ? null : columnIndex(spec, header, what);
  const iRef = at(m.columns.reference, "reference");
  const iAmount = at(m.columns.amount, "amount");
  const iDebit = at(m.columns.debit, "debit");
  const iCredit = at(m.columns.credit, "credit");

  const decimalComma = m.decimalComma ?? false;
  const parsed: ParsedLine[] = [];
  let sum = new D(0);
  for (const [n, cells] of body.entries()) {
    const lineNo = n + 1;
    const figure = (index: number | null): Dec => {
      const raw = cell(cells, index);
      const value = toDecimal(raw, decimalComma);
      if (!value)
        throw new ImportError(
          `statement line ${lineNo}: "${raw}" is not an amount of at most 4 dp`,
        );
      return value;
    };
    // debit is money OUT: amount = credit − debit (ADR 0048).
    const amount = signed ? figure(iAmount) : figure(iCredit).minus(figure(iDebit));
    if (amount.isZero())
      throw new ImportError(
        `statement line ${lineNo} has a zero amount; a zero movement is not a fact about the bank`,
      );
    const rawDate = cell(cells, iDate);
    const valueDate = toIsoDate(rawDate, m.dateFormat);
    if (!valueDate)
      throw new ImportError(`statement line ${lineNo}: "${rawDate}" is not a ${m.dateFormat} date`);
    const reference = cell(cells, iRef).trim();
    parsed.push({
      valueDate,
      description: cell(cells, iDesc).trim(),
      reference: reference === "" ? null : reference,
      amount,
    });
    sum = sum.plus(amount);
  }

  if (!closing.minus(opening).equals(sum))
    throw new ImportError(
      `the statement does not add up: opening ${opening.toFixed(4)} + Σ lines ${sum.toFixed(4)} ` +
        `is ${opening.plus(sum).toFixed(4)}, but closing is ${closing.toFixed(4)}`,
    );

  // The currency is the ACCOUNT's, never the caller's (ADR 0048). Matching on both ids is the company
  // binding: RLS bounds the tenant and nothing else, so an account id alone would reach a sibling
  // company's bank account inside the same tenant.
  const [account] = await tx<{ currency: string | null; base_currency: string }[]>`
    select a.currency, c.base_currency
      from app.account a join app.company c on c.id = a.company_id
     where a.id = ${input.bankAccountId} and a.company_id = ${input.companyId}`;
  if (!account)
    throw new ImportError(
      `account ${input.bankAccountId} is not an account of company ${input.companyId}`,
    );

  const [statement] = await tx<{ id: string }[]>`
    insert into app.bank_statement
      (tenant_id, company_id, bank_account_id, statement_date, opening_balance, closing_balance, currency)
    values (app.current_tenant(), ${input.companyId}, ${input.bankAccountId},
            ${m.statement.statementDate}::date, ${opening.toFixed(4)}::numeric,
            ${closing.toFixed(4)}::numeric, ${account.currency ?? account.base_currency})
    returning id`.catch((error: unknown) => {
    if (
      (error as { constraint_name?: unknown }).constraint_name ===
      "bank_statement_company_id_bank_account_id_statement_date_key"
    )
      throw conflict("a statement for this bank account and statement date is already imported");
    throw error;
  });

  // One statement, not one per line: the four arrays are positional and correct only because all four are
  // built from `parsed` in the same order; `with ordinality` numbers the lines 1..n in that order.
  await tx`
    insert into app.bank_statement_line
      (tenant_id, company_id, statement_id, line_no, value_date, description, reference, amount)
    select app.current_tenant(), ${input.companyId}, ${statement!.id}, t.line_no::int,
           t.value_date, t.description, t.reference, t.amount
      from unnest(${parsed.map((l) => l.valueDate)}::date[],
                  ${parsed.map((l) => l.description)}::text[],
                  ${parsed.map((l) => l.reference)}::text[],
                  ${parsed.map((l) => l.amount.toFixed(4))}::numeric[])
           with ordinality as t(value_date, description, reference, amount, line_no)`;
  return { statementId: statement!.id, lines: parsed.length };
}

export interface BankStatementRow {
  id: string;
  bankAccountId: string;
  statementDate: string;
  openingBalance: string;
  closingBalance: string;
  currency: string;
  lines: number;
}

/**
 * Newest first. `after` is a keyset position — the last row of the previous page — so a caller can page past
 * `limit` (Task 8's list route); the order is `statement_date desc, id`, so the next page is an earlier date,
 * or the same date and a greater id.
 */
export async function listStatements(
  tx: Sql,
  params: {
    companyId: string;
    bankAccountId?: string;
    after?: { statementDate: string; id: string } | null;
    limit: number;
  },
): Promise<BankStatementRow[]> {
  const bankAccountId = params.bankAccountId ?? null;
  const afterDate = params.after?.statementDate ?? null;
  const afterId = params.after?.id ?? null;
  const rows = await tx<
    {
      id: string;
      bank_account_id: string;
      statement_date: string;
      opening_balance: string;
      closing_balance: string;
      currency: string;
      lines: number;
    }[]
  >`
    select st.id, st.bank_account_id, st.statement_date::text as statement_date,
           st.opening_balance::text as opening_balance, st.closing_balance::text as closing_balance,
           st.currency,
           (select count(*)::int from app.bank_statement_line l where l.statement_id = st.id) as lines
      from app.bank_statement st
     where st.company_id = ${params.companyId}
       and (${bankAccountId}::uuid is null or st.bank_account_id = ${bankAccountId}::uuid)
       and (${afterDate}::date is null
            or st.statement_date < ${afterDate}::date
            or (st.statement_date = ${afterDate}::date and st.id > ${afterId}::uuid))
     order by st.statement_date desc, st.id
     limit ${params.limit}`;
  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    statementDate: r.statement_date,
    openingBalance: r.opening_balance,
    closingBalance: r.closing_balance,
    currency: r.currency,
    lines: r.lines,
  }));
}

export interface BankStatementLineRow {
  id: string;
  statementId: string;
  lineNo: number;
  valueDate: string;
  description: string;
  reference: string | null;
  /** signed: positive is money IN */
  amount: string;
  /** Σ live `bank_match.amount` against the line — a magnitude. */
  matchedAmount: string;
}

/** A statement line as SQL returns it; `matched` is Σ live `bank_match.amount` against it, at 4 dp. */
interface LineSqlRow {
  id: string;
  statement_id: string;
  line_no: number;
  value_date: string;
  description: string;
  reference: string | null;
  amount: string;
  matched: string;
}

const toLineRow = (r: LineSqlRow): BankStatementLineRow => ({
  id: r.id,
  statementId: r.statement_id,
  lineNo: r.line_no,
  valueDate: r.value_date,
  description: r.description,
  reference: r.reference,
  amount: r.amount,
  matchedAmount: r.matched,
});

/**
 * `companyId` is required, not optional: RLS bounds the tenant and nothing else, so a statement id alone
 * would reach a sibling company's statement inside the same tenant (AGENTS.md, the endpoint rule).
 *
 * `matchedAmount` is Σ live `bank_match.amount` against the line (migration 0050), and `unmatchedOnly` keeps
 * a line while `|amount| > matched` — so a partly matched line is still listed, and a fully matched one is not.
 * `matchedOnly` is its complement, the fully matched lines; naming both admits nothing. `afterLineNo` is a
 * keyset position (the last `lineNo` of the previous page), so a statement longer than `limit` can be paged.
 */
export async function listStatementLines(
  tx: Sql,
  params: {
    companyId: string;
    statementId: string;
    unmatchedOnly?: boolean;
    matchedOnly?: boolean;
    afterLineNo?: number | null;
    limit: number;
  },
): Promise<BankStatementLineRow[]> {
  const rows = await tx<LineSqlRow[]>`
    select l.id, l.statement_id, l.line_no, l.value_date::text as value_date, l.description,
           l.reference, l.amount::text as amount, coalesce(m.matched, 0)::numeric(19,4)::text as matched
      from app.bank_statement_line l
      left join lateral (select sum(bm.amount) as matched from app.bank_match bm
                          where bm.statement_line_id = l.id and bm.unmatched_at is null) m on true
     where l.statement_id = ${params.statementId} and l.company_id = ${params.companyId}
       and (${params.unmatchedOnly ?? false}::boolean = false or abs(l.amount) > coalesce(m.matched, 0))
       and (${params.matchedOnly ?? false}::boolean = false or abs(l.amount) <= coalesce(m.matched, 0))
       and (${params.afterLineNo ?? null}::int is null or l.line_no > ${params.afterLineNo ?? null}::int)
     order by l.line_no
     limit ${params.limit}`;
  return rows.map(toLineRow);
}

// ── The matching half (Task 7): the Reconcilable registry, match, unmatch, reconciledBalance ─────────────
//
// THE ACCOUNT'S OWN CURRENCY. Every ledger figure below — a source's `Reconcilable.amount`, match()'s
// capacity and reconciledBalance's `ledger` — is the bank account's balance in the currency its statement is
// in, `coalesce(account.currency, company.base_currency)`: the rule importStatement stores the statement's
// currency with. For a base-currency account that is the BASE columns, because a EUR receipt banked into a
// ringgit account arrived as ringgit; for a foreign-currency account it is the document columns of the rows
// in that currency, and a base-only row (a revaluation) moves no foreign amount at all. All three SQL
// statements spell it as the same `case`:
//
//   case when coalesce(a.currency, c.base_currency) = c.base_currency then le.base_debit - le.base_credit
//        when le.currency = a.currency then le.debit - le.credit
//        else 0 end
//
// The plan's raw Σ(debit − credit) is that figure only while every document is in the account's currency;
// with one EUR receipt on a ringgit account it adds euros to ringgit (ADR 0048).

export interface Reconcilable {
  kind: "receipt" | "payment" | "till_banking" | "payroll_batch";
  documentId: string;
  bankAccountId: string;
  /** YYYY-MM-DD. A ledger-leg source reports the document's `effective_date` (ADR 0048). */
  valueDate: string;
  /** A MAGNITUDE in the bank account's currency; the direction is the kind's (`RECONCILABLE_DIRECTION`). */
  amount: Money;
  reference: string | null;
}

/**
 * The seam 6D (till bankings) and 8C (payroll batches) plug into, each with ONE
 * `registerReconcilableSource` call and no edit to this file. `list` returns the documents of its kind that
 * have a leg on `bankAccountId` and whose `valueDate` lies in `[from, to]`; with `unmatchedOnly` it keeps a
 * document only while its leg exceeds its live matches on that account. `match` resolves a document through
 * its kind's source over the one-day window of the document's own `effective_date`, so a source's
 * `valueDate` is that date — the shape `ledgerLegSource` below gives 6D and 8C to copy.
 */
export interface ReconcilableSource {
  kind: Reconcilable["kind"];
  list(
    tx: Sql,
    input: {
      companyId: string;
      bankAccountId: string;
      from: string;
      to: string;
      unmatchedOnly: boolean;
    },
  ): Promise<Reconcilable[]>;
}

/** Money in or money out, per kind. All four are declared here, including the two nobody has shipped: the
 *  CHECK already admits them (§4.8.3) and a direction is a property of the kind, not of the slice. A FULL
 *  reversal of a document runs the other way, which `match` reads off the document, never off this map. */
export const RECONCILABLE_DIRECTION: Readonly<Record<Reconcilable["kind"], "in" | "out">> = {
  receipt: "in",
  payment: "out",
  till_banking: "in", // 6D — cash out of the till and INTO the bank
  payroll_batch: "out", // 8C — the net-pay batch leaving the bank
};

const SOURCES = new Map<Reconcilable["kind"], ReconcilableSource>();

/** 1B's `registerProjectionCheck` rule: registering twice under one kind replaces the earlier entry, so a
 *  hot reload is harmless. */
export function registerReconcilableSource(source: ReconcilableSource): void {
  SOURCES.set(source.kind, source);
}

export function reconcilableSources(): readonly ReconcilableSource[] {
  return [...SOURCES.values()].toSorted((x, y) => x.kind.localeCompare(y.kind));
}

/**
 * One source shape serves receipts and payments, and it lists from the LEDGER's bank leg rather than from a
 * document total (ADR 0048): that works for a receipt banked into any of several bank accounts and gives 6D
 * and 8C a shape they can copy without knowing what a "total" means for their own type. Both halves of a
 * full reversal are listed — the original is `reversed`, its mirror `posted` — because both moved the bank.
 * The live-match Σ is taken over lines of THIS bank account's statements, so a document with legs on two
 * bank accounts is reconciled on each separately.
 */
function ledgerLegSource(kind: Reconcilable["kind"], typeCode: string): ReconcilableSource {
  return {
    kind,
    async list(tx, input) {
      const rows = await tx<
        {
          document_id: string;
          value_date: string;
          magnitude: string;
          reference: string | null;
          ccy: string;
        }[]
      >`
        with legs as (
          select d.id, d.effective_date, d.series, d.number,
                 coalesce(a.currency, c.base_currency) as ccy,
                 sum(case when coalesce(a.currency, c.base_currency) = c.base_currency
                            then le.base_debit - le.base_credit
                          when le.currency = a.currency then le.debit - le.credit
                          else 0 end) as leg
            from app.ledger_entry le
            join app.document      d on d.id = le.document_id
            join app.document_type t on t.id = d.document_type_id
            join app.account       a on a.id = le.account_id
            join app.company       c on c.id = le.company_id
           where le.company_id = ${input.companyId}
             and le.account_id = ${input.bankAccountId}
             and d.company_id = ${input.companyId}
             and t.code = ${typeCode}
             and d.status in ('posted', 'reversed')
             and d.effective_date between ${input.from}::date and ${input.to}::date
           group by d.id, d.effective_date, d.series, d.number, a.currency, c.base_currency
        )
        select g.id as document_id, g.effective_date::text as value_date,
               abs(g.leg)::numeric(19,4)::text as magnitude,
               nullif(concat_ws('-', g.series, g.number::text), '') as reference, g.ccy
          from legs g
         where g.leg <> 0
           and (${input.unmatchedOnly}::boolean = false
                or abs(g.leg) > coalesce((select sum(bm.amount)
                                            from app.bank_match bm
                                            join app.bank_statement_line sl on sl.id = bm.statement_line_id
                                            join app.bank_statement st on st.id = sl.statement_id
                                           where bm.reconcilable_document_id = g.id
                                             and bm.unmatched_at is null
                                             and st.bank_account_id = ${input.bankAccountId}), 0))
         order by g.effective_date, g.id`;
      return rows.map((r) => ({
        kind,
        documentId: r.document_id,
        bankAccountId: input.bankAccountId,
        valueDate: r.value_date,
        amount: Money.of(r.magnitude, currency(r.ccy)),
        reference: r.reference,
      }));
    },
  };
}

// §4.8.3 as amended in round 7 (4A amendment 12): 4B registers these two over 4A's RECEIPT and PAYMENT types,
// because this FILE is in 4B's range and did not exist before Task 6, so 4A had nothing to register into
// (ADR 0048). 6D adds till_banking and 8C payroll_batch, each with one registerReconcilableSource call.
registerReconcilableSource(ledgerLegSource("receipt", "RECEIPT"));
registerReconcilableSource(ledgerLegSource("payment", "PAYMENT"));

/**
 * `ImportError`'s twin, for the same three reasons (see that class): exported, so `apps/api` can test
 * `instanceof`; a `readonly code` that is a literal member of `ErrCode`, so Task 8's handlers write
 * `new AppError(error.code, error.detail)` with no cast and no branch in `apps/api/src/problem.ts`; and the
 * token still in the message, so the packages/db-tier tests assert `rejects.toThrow(/ERR_BANK_MATCH_AMOUNT…/)`.
 *
 * One code covers every refusal of a match, deliberately — including a line, document or account that is
 * "not visible": under FORCE RLS an invisible row and a row in another tenant or company are the same
 * observation, and §4.2.4 allocated 4B exactly one new `ERRORS` row. The one refusal it does not cover is a
 * blank unmatch reason, which is `ERR_VALIDATION_FAILED` — bad input, not a disagreement of amounts.
 */
export class BankMatchError extends Error {
  readonly code = "ERR_BANK_MATCH_AMOUNT" as const;
  constructor(readonly detail: string) {
    super(`ERR_BANK_MATCH_AMOUNT: ${detail}`);
    this.name = "BankMatchError";
  }
}

/** Task 6's `conflict` shape for the one ERRORS code a match does not own. */
function invalid(detail: string): Error {
  return Object.assign(new Error(`ERR_VALIDATION_FAILED: ${detail}`), {
    code: "ERR_VALIDATION_FAILED" as const,
  });
}

export interface BankMatchRow {
  id: string;
  statementLineId: string;
  kind: Reconcilable["kind"];
  reconcilableDocumentId: string;
  /** a magnitude */
  amount: string;
  matchedAt: string;
  unmatchedAt: string | null;
}

const opposite = (d: "in" | "out"): "in" | "out" => (d === "in" ? "out" : "in");

/**
 * Matches `amount` of a statement line to one document. It writes ONE `app.bank_match` row and nothing else
 * (acceptance test 39): there is no period check because there is nothing for a period lock to protect — a
 * match in a locked period succeeds and that period's ledger rows are byte-identical afterwards (ADR 0048,
 * the LEGACY-031 4B block). The actor reaches `matched_by` through the column default and its stamp trigger,
 * never through a parameter (LEGACY-044), hence `_ctx` is unread.
 *
 * Refused with `ERR_BANK_MATCH_AMOUNT`, in this order: a non-positive amount; a line not visible in
 * `companyId`; an amount in another currency than the statement's; a document not visible in `companyId`, or
 * not posted; a kind with no registered source, or a document its source does not list on the line's bank
 * account (a `receipt` must name a RECEIPT); a direction that disagrees — the kind's own, turned round for a
 * full reversal, against the line's sign and against the document's own bank leg; an amount beyond the
 * line's remaining magnitude; a second live match of the same pair; an amount beyond the document's
 * remaining bank leg.
 *
 * The line and the document are locked first (sorted advisory keys, the allocation service's pattern), so
 * two concurrent matches cannot both read the same remaining figure and over-match either side.
 */
export async function match(
  tx: Sql,
  _ctx: TenantContext,
  input: {
    companyId: string;
    statementLineId: string;
    reconcilable: Pick<Reconcilable, "kind" | "documentId">;
    amount: Money;
  },
): Promise<{ matchId: string }> {
  const { kind, documentId } = input.reconcilable;
  const kindDirection: "in" | "out" | undefined = RECONCILABLE_DIRECTION[kind];
  if (kindDirection === undefined) {
    throw new BankMatchError(`"${String(kind)}" is not a reconcilable kind`);
  }
  if (!input.amount.isPositive()) {
    throw new BankMatchError(
      `a match amount is a magnitude and must be greater than zero, got ${input.amount.toString()}`,
    );
  }
  const amount = input.amount.toDecimal();

  for (const key of [
    `bank_match:line:${input.statementLineId}`,
    `bank_match:document:${documentId}`,
  ].toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  const [line] = await tx<
    { amount: string; bank_account_id: string; currency: string; matched: string }[]
  >`
    select l.amount::text as amount, st.bank_account_id, st.currency,
           coalesce((select sum(bm.amount) from app.bank_match bm
                      where bm.statement_line_id = l.id and bm.unmatched_at is null), 0)
             ::numeric(19,4)::text as matched
      from app.bank_statement_line l
      join app.bank_statement st on st.id = l.statement_id and st.company_id = l.company_id
     where l.id = ${input.statementLineId} and l.company_id = ${input.companyId}`;
  if (!line) {
    throw new BankMatchError(
      `statement line ${input.statementLineId} is not visible in company ${input.companyId}`,
    );
  }
  if ((input.amount.currency as string) !== line.currency) {
    throw new BankMatchError(
      `a match of ${input.amount.currency} cannot reconcile statement line ${input.statementLineId}, which is in ${line.currency}`,
    );
  }

  const [doc] = await tx<
    { effective_date: string; status: string; is_reversal: boolean; leg: string; matched: string }[]
  >`
    select d.effective_date::text as effective_date, d.status::text as status,
           -- An ODD-depth full reversal runs against its kind; the reversal of a reversal (the re-deposit)
           -- runs with it again — 0048's app.document_reversal_depth, shared with the ageing and allocation.
           coalesce(app.document_reversal_depth(d.id) % 2 = 1, false) as is_reversal,
           coalesce((select sum(case when coalesce(a.currency, c.base_currency) = c.base_currency
                                       then le.base_debit - le.base_credit
                                     when le.currency = a.currency then le.debit - le.credit
                                     else 0 end)
                       from app.ledger_entry le
                       join app.account a on a.id = le.account_id
                       join app.company c on c.id = le.company_id
                      where le.document_id = d.id and le.account_id = ${line.bank_account_id}), 0)
             ::numeric(19,4)::text as leg,
           coalesce((select sum(bm.amount)
                       from app.bank_match bm
                       join app.bank_statement_line sl on sl.id = bm.statement_line_id
                       join app.bank_statement st on st.id = sl.statement_id
                      where bm.reconcilable_document_id = d.id and bm.unmatched_at is null
                        and st.bank_account_id = ${line.bank_account_id}), 0)
             ::numeric(19,4)::text as matched
      from app.document d
     where d.id = ${documentId} and d.company_id = ${input.companyId}`;
  if (!doc) {
    throw new BankMatchError(`document ${documentId} is not visible in company ${input.companyId}`);
  }
  if (doc.status !== "posted" && doc.status !== "reversed") {
    throw new BankMatchError(
      `document ${documentId} is ${doc.status}; only a posted document's bank leg can be matched`,
    );
  }

  // The registry is the authority for which documents a kind covers: a `receipt` naming a PAYMENT — or a
  // journal that happens to debit the bank — is refused here, before any figure is compared.
  const source = SOURCES.get(kind);
  if (!source) {
    throw new BankMatchError(
      `no Reconcilable source is registered for kind ${kind}; the slice that ships the kind registers it`,
    );
  }
  const listed = await source.list(tx, {
    companyId: input.companyId,
    bankAccountId: line.bank_account_id,
    from: doc.effective_date,
    to: doc.effective_date,
    unmatchedOnly: false,
  });
  if (!listed.some((r) => r.documentId === documentId)) {
    throw new BankMatchError(
      `document ${documentId} is not a ${kind} banked through account ${line.bank_account_id}`,
    );
  }

  // A full reversal runs the other way from its kind: a reversed receipt — the bounced cheque — is money out,
  // and its mirror matches the bank's debit, never the original credit a second time.
  const expected = doc.is_reversal ? opposite(kindDirection) : kindDirection;
  const what = doc.is_reversal ? `the reversal of a ${kind}` : `a ${kind}`;
  const lineAmount = new D(line.amount);
  const lineDirection = lineAmount.isPositive() ? "in" : "out";
  if (expected !== lineDirection) {
    throw new BankMatchError(
      `${what} is money ${expected} and statement line ${line.amount} is money ` +
        `${lineDirection} (${lineAmount.isPositive() ? "+" : "-"}): the direction disagrees`,
    );
  }
  const leg = new D(doc.leg);
  if (!leg.isZero() && (leg.isPositive() ? "in" : "out") !== expected) {
    throw new BankMatchError(
      `${what} is money ${expected}, but document ${documentId}'s bank leg ${leg.toFixed(4)} runs the ` +
        `other way: the direction disagrees`,
    );
  }

  const lineMatched = new D(line.matched);
  const lineRemaining = lineAmount.abs().minus(lineMatched);
  if (amount.greaterThan(lineRemaining)) {
    throw new BankMatchError(
      `statement line total ${lineAmount.abs().toFixed(4)} already carries ${lineMatched.toFixed(4)} ` +
        `of matches, so ${amount.toFixed(4)} exceeds the remaining ${lineRemaining.toFixed(4)}`,
    );
  }

  const [pair] = await tx<{ id: string }[]>`
    select id from app.bank_match
     where statement_line_id = ${input.statementLineId}
       and reconcilable_document_id = ${documentId} and unmatched_at is null`;
  if (pair) {
    throw new BankMatchError(
      `statement line ${input.statementLineId} already carries a live match to document ${documentId} ` +
        `(${pair.id}); unmatch it and match the whole amount once`,
    );
  }

  const docMatched = new D(doc.matched);
  const docRemaining = leg.abs().minus(docMatched);
  if (amount.greaterThan(docRemaining)) {
    throw new BankMatchError(
      `document ${documentId} has a bank leg of ${leg.abs().toFixed(4)} and is already matched for ` +
        `${docMatched.toFixed(4)} on account ${line.bank_account_id}, so ${amount.toFixed(4)} exceeds ` +
        `the remaining ${docRemaining.toFixed(4)}`,
    );
  }

  const [row] = await tx<{ id: string }[]>`
    insert into app.bank_match
      (tenant_id, company_id, statement_line_id, reconcilable_kind, reconcilable_document_id, amount)
    values (app.current_tenant(), ${input.companyId}, ${input.statementLineId}, ${kind},
            ${documentId}, ${amount.toFixed(4)}::numeric)
    returning id`;
  return { matchId: row!.id };
}

/**
 * Sets `unmatched_at`, `unmatched_by` (stamped) and `unmatch_reason` on a live match of `companyId`. It never
 * alters a ledger entry and never removes the row (spec:2457, LEGACY-041): the row survives with both audit
 * images, and 0050's `bank_match_guard` refuses every other change to it. The reason is a column because
 * app.audit_row writes `to_jsonb(new)` and a value never written to a column is not in that image.
 */
export async function unmatch(
  tx: Sql,
  _ctx: TenantContext,
  input: { companyId: string; matchId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason === "") throw invalid("a reason is required to unmatch a bank match");
  const [row] = await tx<{ id: string }[]>`
    update app.bank_match
       set unmatched_at = now(), unmatched_by = app.current_actor(), unmatch_reason = ${reason}
     where id = ${input.matchId} and company_id = ${input.companyId} and unmatched_at is null
    returning id`;
  if (!row) {
    throw new BankMatchError(
      `match ${input.matchId} is not a live match of company ${input.companyId}`,
    );
  }
}

/** The statement side of the unreconciled list: every line of `bankAccountId`'s statements dated on or
 *  before `asOf` whose magnitude still exceeds its live matches — the partly matched included. */
export async function unmatchedStatementLines(
  tx: Sql,
  params: { companyId: string; bankAccountId: string; asOf: string },
): Promise<BankStatementLineRow[]> {
  const rows = await tx<LineSqlRow[]>`
    select l.id, l.statement_id, l.line_no, l.value_date::text as value_date, l.description,
           l.reference, l.amount::text as amount, coalesce(m.matched, 0)::numeric(19,4)::text as matched
      from app.bank_statement_line l
      join app.bank_statement st on st.id = l.statement_id and st.company_id = l.company_id
      left join lateral (select sum(bm.amount) as matched from app.bank_match bm
                          where bm.statement_line_id = l.id and bm.unmatched_at is null) m on true
     where l.company_id = ${params.companyId}
       and st.bank_account_id = ${params.bankAccountId}
       and l.value_date <= ${params.asOf}::date
       and abs(l.amount) > coalesce(m.matched, 0)
     order by l.value_date, st.statement_date, l.line_no`;
  return rows.map(toLineRow);
}

/**
 * `statement === ledger` is the definition of done (§4.8.3, test 39). `statement` is the closing balance of
 * the latest statement dated on or before `asOf`; `ledger` is the bank account's balance at `asOf` in its own
 * currency (above); `unreconciled` is every registered source's unmatched documents up to `asOf`. It does
 * not return the unmatched statement LINES — the frozen type has no member for them — so
 * `unmatchedStatementLines` is the sibling the API composes with it (ADR 0048).
 */
export async function reconciledBalance(
  tx: Sql,
  input: { companyId: string; bankAccountId: string; asOf: string },
): Promise<{ statement: Money; ledger: Money; unreconciled: Reconcilable[] }> {
  const [account] = await tx<{ ccy: string }[]>`
    select coalesce(a.currency, c.base_currency) as ccy
      from app.account a join app.company c on c.id = a.company_id
     where a.id = ${input.bankAccountId} and a.company_id = ${input.companyId}`;
  if (!account) {
    throw new BankMatchError(
      `account ${input.bankAccountId} is not an account of company ${input.companyId}`,
    );
  }
  const ccy = currency(account.ccy);

  const [stmt] = await tx<{ closing: string }[]>`
    select closing_balance::text as closing from app.bank_statement
     where company_id = ${input.companyId} and bank_account_id = ${input.bankAccountId}
       and statement_date <= ${input.asOf}::date
     order by statement_date desc limit 1`;

  const [led] = await tx<{ balance: string }[]>`
    select coalesce(sum(case when coalesce(a.currency, c.base_currency) = c.base_currency
                               then le.base_debit - le.base_credit
                             when le.currency = a.currency then le.debit - le.credit
                             else 0 end), 0)::numeric(19,4)::text as balance
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      join app.company c on c.id = le.company_id
     where le.company_id = ${input.companyId} and le.account_id = ${input.bankAccountId}
       and le.effective_date <= ${input.asOf}::date`;

  const unreconciled: Reconcilable[] = [];
  for (const source of reconcilableSources()) {
    // 1900-01-01 is a deliberate floor rather than the earliest statement date: an item older than the first
    // statement is exactly the kind of thing that must show up as unreconciled.
    unreconciled.push(
      ...(await source.list(tx, {
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        from: "1900-01-01",
        to: input.asOf,
        unmatchedOnly: true,
      })),
    );
  }

  return {
    statement: Money.of(stmt?.closing ?? "0.0000", ccy),
    ledger: Money.of(led!.balance, ccy),
    unreconciled,
  };
}
