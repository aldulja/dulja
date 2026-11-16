// packages/db/src/tax/returns.ts
import type { Sql } from "postgres";
import {
  currency,
  malaysiaPack,
  Money,
  TaxError,
  taxSideOf,
  type CurrencyCode,
  type PostingPolicy,
  type ReturnBox,
  type TaxCodeDef,
  type TaxRegime,
  type TaxTransactionRow,
} from "@dulja/domain";
import { lockTenantAuditSerial } from "../costing/invalidate";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";

export interface TaxReturnRow {
  id: string;
  companyId: string;
  regimeId: string;
  regimeCode: string;
  regimeVersion: number;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "generated" | "filed";
  payload: string | null;
  payloadSha256: string | null;
  generatedBy: string | null;
  filedAt: string | null;
  attachmentId: string | null;
  createdAt: string;
}
export interface TaxReturnCursor {
  periodStart: string;
  id: string;
}

const SELECT_RETURN = (tx: Sql) => tx`
  select r.id, r.company_id, r.regime_id, g.code as regime_code, g.version as regime_version,
         r.period_start::text, r.period_end::text, r.status, r.payload,
         encode(r.payload_sha256, 'hex') as payload_sha256, r.generated_by,
         r.filed_at::text, r.attachment_id, r.created_at::text
    from app.tax_return r join app.tax_regime g on g.id = r.regime_id`;

/** The company half of every by-id read (AGENTS.md: an endpoint whose gate clears a company passes that
 *  company into every service call). RLS bounds the tenant and nothing else, so an id alone reaches a
 *  sibling company's return. It is bound in the SAME statement as the id, so another company's return and
 *  an id that does not exist are one refusal with one detail — a detail that differed would tell the
 *  caller the row exists elsewhere. `undefined` binds nothing, so an in-process caller that already holds
 *  a company-bound id compiles and behaves as before. Every use aliases `app.tax_return` as `r`. */
const IN_COMPANY = (tx: Sql, companyId: string | undefined) =>
  tx`(${companyId ?? null}::uuid is null or r.company_id = ${companyId ?? null}::uuid)`;

function toRow(r: Record<string, unknown>): TaxReturnRow {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    regimeId: r.regime_id as string,
    regimeCode: r.regime_code as string,
    regimeVersion: r.regime_version as number,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    status: r.status as TaxReturnRow["status"],
    payload: r.payload as string | null,
    payloadSha256: r.payload_sha256 as string | null,
    generatedBy: r.generated_by as string | null,
    filedAt: r.filed_at as string | null,
    attachmentId: r.attachment_id as string | null,
    createdAt: r.created_at as string,
  };
}

/** `ERR_CONFLICT_UNIQUE` — the 409 the create route documents as "Period overlaps one already reserved for
 *  the regime". The coded shape `ar-ap/reconciliation.ts` and `ar-ap/payment-term.ts` already raise:
 *  `packages/db` may not throw `AppError` (§3.1) and `PostingErrorCode` does not carry this code, so the
 *  token travels in the message and the API's `fromDomainError` lifts it. It introduces no new error code. */
function periodConflict(detail: string): Error {
  return Object.assign(new Error(`ERR_CONFLICT_UNIQUE: ${detail}`), {
    code: "ERR_CONFLICT_UNIQUE" as const,
  });
}

/** Reserves the period. **No two returns of one company and regime may share a day**: a transaction is in
 *  every return whose inclusive range covers its `effective_date` (`transactionsFor`), so Jan–Mar beside
 *  Feb–Apr would report February and March twice. `unique (company_id, regime_id, period_start)` stops only
 *  an identical START and stays as the backstop; the overlap read below is the rule, and it names the
 *  return it collides with.
 *
 *  **The tenant's audit-chain lock first** (`lockTenantAuditSerial`, 0010's 'tenant-serial:' key), as
 *  `generateTaxReturn` and `fileTaxReturn` take it: the insert below is an audited write and would take it
 *  anyway, and a creator that locked the regime row first waited on the chain at that insert while holding
 *  the row. Taken first, a creator waits holding nothing, behind a taxed post in flight or another creator.
 *
 *  **Then the regime row**, so a second creator of the same regime reads the overlap only after the first
 *  has committed — without it, two overlapping creates each read none of the other's uncommitted row and
 *  both insert. The audit chain also serialises two creators today; the overlap rule does not rest on a
 *  tenant-wide lock taken for another reason. **`for no key update`, not `for update`**, and that still
 *  matters with the chain taken first: an audited INSERT whose foreign key names this row — a tax code,
 *  `POST …/tax-codes` — fires the key check (`RI_ConstraintTrigger_c_…`, FOR KEY SHARE on this row)
 *  before `audit_row` waits on the chain, because AFTER triggers fire in name order.
 *  FOR UPDATE is the one row lock a key share blocks, so a creator holding the chain and asking for it
 *  waited on that insert while the insert waited on the chain: 40P01 (`return-integrity.test.ts` drives
 *  it with a real `createTaxCode`). Two creators conflict under either mode. */
export async function createTaxReturn(
  tx: Sql,
  ctx: TenantContext,
  input: { companyId: string; regimeId: string; periodStart: string; periodEnd: string },
): Promise<TaxReturnRow> {
  await lockTenantAuditSerial(tx, ctx.tenantId);
  const [regime] = await tx<{ id: string }[]>`
    select id from app.tax_regime
     where id = ${input.regimeId} and company_id = ${input.companyId}
       for no key update`;
  if (!regime) throw new PostingError("ERR_NOT_FOUND", "tax regime is not in this company");
  const [cover] = await tx<{ partial: number }[]>`
    select count(*)::int as partial from app.fiscal_period
     where company_id = ${input.companyId}
       and starts_on <= ${input.periodEnd} and ends_on >= ${input.periodStart}
       and (starts_on < ${input.periodStart} or ends_on > ${input.periodEnd})`;
  if (cover!.partial > 0) {
    throw new PostingError(
      "ERR_POLICY_REQUIRES_MISSING",
      `${input.periodStart}..${input.periodEnd} cuts a fiscal period in half — a return covers whole periods`,
    );
  }
  const overlapping = await tx<
    { id: string; period_start: string; period_end: string; status: string }[]
  >`
    select id, period_start::text, period_end::text, status from app.tax_return
     where company_id = ${input.companyId} and regime_id = ${input.regimeId}
       and period_start <= ${input.periodEnd} and period_end >= ${input.periodStart}
     order by period_start, id`;
  if (overlapping.length > 0) {
    throw periodConflict(
      `${input.periodStart}..${input.periodEnd} overlaps ` +
        overlapping
          .map((o) => `tax return ${o.id} (${o.period_start}..${o.period_end}, ${o.status})`)
          .join(", ") +
        " of the same regime — a transaction would be reported by both; choose a range that starts after it ends or ends before it starts",
    );
  }

  const [made] = await tx<{ id: string }[]>`
    insert into app.tax_return (tenant_id, company_id, regime_id, period_start, period_end, status)
    values (${ctx.tenantId}, ${input.companyId}, ${input.regimeId},
            ${input.periodStart}, ${input.periodEnd}, 'draft')
    returning id`;
  const rows = (await tx`${SELECT_RETURN(tx)} where r.id = ${made!.id}`) as unknown as Record<
    string,
    unknown
  >[];
  return toRow(rows[0]!);
}

export async function listTaxReturns(
  tx: Sql,
  p: { companyId: string; regimeCode?: string; cursor?: TaxReturnCursor | null; limit: number },
): Promise<TaxReturnRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select r.id, r.company_id, r.regime_id, g.code as regime_code, g.version as regime_version,
           r.period_start::text, r.period_end::text, r.status, r.payload,
           encode(r.payload_sha256, 'hex') as payload_sha256, r.generated_by,
           r.filed_at::text, r.attachment_id, r.created_at::text
      from app.tax_return r join app.tax_regime g on g.id = r.regime_id
     where r.company_id = ${p.companyId}
       and (${p.regimeCode ?? null}::text is null or g.code = ${p.regimeCode ?? null})
       and (${p.cursor?.periodStart ?? null}::date is null
            or (r.period_start, r.id) > (${p.cursor?.periodStart ?? null}::date, ${p.cursor?.id ?? null}::uuid))
     order by r.period_start, r.id
     limit ${p.limit}`;
  return rows.map(toRow);
}

/** The transactions of one return's period and regime. **Both period bounds are always bound** — LEGACY-059's
 *  failure was a concatenated query that silently lost its date filter and reported every voucher ever
 *  posted; this is a tagged template and the bounds are parameters, so losing one is not expressible. */
async function transactionsFor(tx: Sql, row: TaxReturnRow): Promise<TaxTransactionRow[]> {
  const rows = await tx<
    {
      document_id: string;
      document_type_code: string;
      line_no: number;
      tax_code_id: string;
      tax_code: string;
      regime_id: string;
      kind: TaxCodeDef["kind"];
      rate: string;
      base: string;
      tax: string;
      base_base: string;
      tax_base: string;
      effective_date: string;
      posting_seq: string;
      base_currency: string;
      document_currency: string;
      policy_lines: PostingPolicy["lines"] | null;
    }[]
  >`
    select t.document_id, dt.code as document_type_code, t.line_no, t.tax_code_id, c.code as tax_code,
           t.regime_id, c.kind, c.rate::text as rate,
           t.base::text, t.tax::text, t.base_base::text, t.tax_base::text,
           t.effective_date::text, t.posting_seq::text, co.base_currency,
           d.currency as document_currency, pp.definition -> 'lines' as policy_lines
      from app.tax_transaction t
      join app.tax_code c   on c.id = t.tax_code_id
      join app.document d   on d.id = t.document_id
      join app.document_type dt on dt.id = d.document_type_id
      join app.company co   on co.id = t.company_id
      left join app.posting_policy pp on pp.id = d.posting_policy_id
     where t.company_id    = ${row.companyId}
       and t.regime_id     = ${row.regimeId}
       and t.effective_date >= ${row.periodStart}
       and t.effective_date <= ${row.periodEnd}
     order by t.effective_date, t.posting_seq, t.line_no, c.code`;
  return rows.map((r) => {
    // TWO currencies, and they are not the same one. `base_base` / `tax_base` are the company's base
    // currency — what the return is filed in and what every box sums. `base` / `tax` are the DOCUMENT's
    // currency, so they are branded with `d.currency`. They are equal for a domestic invoice and differ the
    // moment a tenant codes tax on a foreign-currency one; labelling the document figures with the base
    // currency would hand `TaxTransactionRow.base` a `Money` that claims a currency it is not in, which is
    // exactly the mislabelling spec:2041's compile-time currency check exists to catch.
    const ccy = currency(r.base_currency);
    const doc = currency(r.document_currency);
    return {
      documentId: r.document_id,
      documentTypeCode: r.document_type_code,
      lineNo: r.line_no,
      taxCodeId: r.tax_code_id,
      taxCode: r.tax_code,
      regimeId: r.regime_id,
      kind: r.kind,
      rate: r.rate,
      base: Money.of(r.base, doc),
      tax: Money.of(r.tax, doc),
      baseBase: Money.of(r.base_base, ccy),
      taxBase: Money.of(r.tax_base, ccy),
      effectiveDate: r.effective_date,
      postingSeq: r.posting_seq,
      // MON-04: the fact's side is its DOCUMENT's — the policy it posted under — so an exempt purchase is
      // boxed as a purchase. A posted document always carries its policy; `null` keeps the kind-only rule.
      side: r.policy_lines === null ? null : taxSideOf({ lines: r.policy_lines }),
    } satisfies TaxTransactionRow;
  });
}

/**
 * The ONE place a return's payload is built: the regime, the period's `tax_transaction` rows and the
 * company's base currency through the pack, then validated. `generateTaxReturn` stores what it returns and
 * `fileTaxReturn` compares it with what was stored — one build, so "stale" means exactly "generating now
 * would write different bytes", never a second summing loop's opinion.
 */
async function buildPayloadFor(
  tx: Sql,
  row: TaxReturnRow,
): Promise<{ boxes: ReturnBox[]; payload: string; currency: CurrencyCode }> {
  const [regimeRow] = await tx<
    {
      id: string;
      code: string;
      jurisdiction: "MY";
      version: number;
      effective_from: string;
      effective_to: string | null;
    }[]
  >`
    select id, code, jurisdiction, version, effective_from::text, effective_to::text
      from app.tax_regime where id = ${row.regimeId}`;
  const regime: TaxRegime = {
    id: regimeRow!.id,
    code: regimeRow!.code,
    jurisdiction: regimeRow!.jurisdiction,
    version: regimeRow!.version,
    effectiveFrom: regimeRow!.effective_from,
    effectiveTo: regimeRow!.effective_to,
  };

  const transactions = await transactionsFor(tx, row);
  // The company's base currency is what the return is filed in — named to the pack, so an EMPTY period
  // of a company that does not keep MYR books is not filed as MYR (the pack's fallback when none is named).
  const [co] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${row.companyId}`;
  const ccy = currency(co!.base_currency);
  let built: { boxes: ReturnBox[]; payload: string };
  try {
    built = malaysiaPack.buildReturn({
      regime,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      transactions,
      currency: ccy,
    });
  } catch (e) {
    if (e instanceof TaxError) throw new PostingError(e.code, e.detail);
    throw e;
  }
  const check = malaysiaPack.validateReturn(built.payload);
  if (!check.ok) {
    // "generated, validated and reconciled" — a payload the pack cannot re-read is not generated.
    throw new PostingError(
      "ERR_TAX_REGIME_MISMATCH",
      `the generated return does not validate against ${regime.code} v${regime.version}: ${check.errors.join("; ")}`,
    );
  }
  return { ...built, currency: ccy };
}

/**
 * Reads `app.tax_transaction` and **nothing else** — never a document, never a `ledger_entry` — builds the
 * payload through the pack, validates it, and writes the row.
 *
 * A refusal leaves the row untouched: the pack throws before the UPDATE, and the whole call is inside the
 * caller's `withTenant`, so a half-generated return is not reachable. `generated_by` is stamped by
 * `app.stamp_actor` on the NULL → value transition and keeps the FIRST generator on a regeneration — 1A's
 * `closed_by` decision (§4.3.4); `app.audit_log` is the per-generation record with its own stamped actor.
 *
 * **The tenant's audit-chain lock comes before the row lock**, for the reason `fileTaxReturn` gives: a
 * taxed post holds it from its first audited write and takes this row FOR SHARE only at step 11, so a
 * generation that locked the row first and reached the audit chain at its own UPDATE deadlocked with it.
 * Taken first, a generation waits for the post to commit and then builds a payload that includes it.
 */
export async function generateTaxReturn(
  tx: Sql,
  ctx: TenantContext,
  taxReturnId: string,
  companyId?: string,
): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }> {
  await lockTenantAuditSerial(tx, ctx.tenantId);
  const found = (await tx`${SELECT_RETURN(tx)}
     where r.id = ${taxReturnId} and ${IN_COMPANY(tx, companyId)}
       for update of r`) as unknown as Record<string, unknown>[];
  if (found.length === 0)
    throw new PostingError("ERR_NOT_FOUND", `tax return ${taxReturnId} is not visible`);
  const row = toRow(found[0]!);
  if (row.status === "filed") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `tax return ${taxReturnId} is filed — a filed return is corrected by a new period's return, never regenerated`,
    );
  }
  const built = await buildPayloadFor(tx, row);

  // `convert_to(text, 'UTF8')`, NOT `::bytea`. PostgreSQL has no cast from `text` to `bytea` — the column
  // is `text` (0054) and `select payload::bytea` raises "cannot cast type text to bytea"; postgres.js sends
  // a JS string as `text`, so the parameterised form fails identically. `convert_to` is the documented
  // text→bytes conversion and it names the encoding, which is the half that matters: the golden payload's
  // sha is the sha of its UTF-8 bytes, and the pack's Arabic labels make that a real distinction rather
  // than a pedantic one. (`sha256(''::bytea)` in T2's test works only because `''` is an UNTYPED literal
  // handed straight to bytea's input function — not a cast from `text`.)
  await tx`
    update app.tax_return
       set payload = ${built.payload},
           payload_sha256 = sha256(convert_to(${built.payload}, 'UTF8')),
           generated_by = coalesce(generated_by, app.current_actor()),
           status = 'generated'
     where id = ${taxReturnId}`;
  const after = (await tx`${SELECT_RETURN(tx)} where r.id = ${taxReturnId}`) as unknown as Record<
    string,
    unknown
  >[];
  return { row: toRow(after[0]!), boxes: built.boxes, currency: built.currency };
}

/** `regimeCode` + `regimeVersion` → the tenant's own regime id, or `null`. RLS bounds the read, so a code
 *  belonging to another tenant is indistinguishable from one that does not exist — which is what lets the
 *  route answer **404** and leak nothing (§4.2.7's not-found-over-forbidden rule for cross-tenant reads). */
export async function findRegime(
  tx: Sql,
  companyId: string,
  code: string,
  version: number,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.tax_regime
     where company_id = ${companyId} and code = ${code} and version = ${version}`;
  return row?.id ?? null;
}

/** Re-reads a stored return's boxes from its own payload — never by re-summing, so what a screen shows is
 *  what was generated. A draft has no payload and therefore no boxes. `currency` is the COMPANY's base
 *  currency and is returned in every case, draft included: `TaxReturnDetail` declares the member and the
 *  route must not run its own SQL to fill it. */
export async function getTaxReturn(
  tx: Sql,
  taxReturnId: string,
  companyId?: string,
): Promise<{ row: TaxReturnRow; boxes: ReturnBox[]; currency: CurrencyCode }> {
  const found = (await tx`${SELECT_RETURN(tx)}
     where r.id = ${taxReturnId} and ${IN_COMPANY(tx, companyId)}`) as unknown as Record<
    string,
    unknown
  >[];
  if (found.length === 0)
    throw new PostingError("ERR_NOT_FOUND", `tax return ${taxReturnId} is not visible`);
  const row = toRow(found[0]!);
  const [co] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${row.companyId}`;
  const ccy = currency(co!.base_currency);
  if (row.payload === null) return { row, boxes: [], currency: ccy };
  const parsed = JSON.parse(row.payload) as {
    boxes: { code: string; label: string; amount: string }[];
  };
  return {
    row,
    boxes: parsed.boxes.map((b) => ({
      code: b.code,
      label: b.label,
      amount: Money.of(b.amount, ccy),
    })),
    currency: ccy,
  };
}

export interface TaxReturnTieOutRow {
  accountCode: string;
  boxCodes: string[];
  boxBase: string;
  ledgerBase: string;
  difference: string;
}

/**
 * The DoD's **"reconciled"** verb. For each direction — input and output — the sum of the return's tax
 * boxes that feed it against `app.account_balance` for the same periods, over **every account the regime's
 * own codes of that kind post to** (PR 11 review, round 3): an output code's `output_account_id`, an input
 * code's `input_account_id`, archived codes included, because archiving stops new use and leaves posted tax
 * where it is. `POST …/tax-codes` accepts any leaf liability for an output code, so a hard-coded `2300`
 * missed a second output code's ledger leg and reported a difference that was not there. `accountCode` is
 * the sorted distinct codes joined with `+` — `2300` and `1350` for the synthetic regime, as before — and a
 * regime that declares no code of a kind falls back to that side's §4.15 account.
 *
 * **`account_balance`, not `ledger_entry`** — 1B's rule (§4.16.3): a report that quietly re-aggregated the
 * ledger would hide exactly the drift the integrity job exists to find. **Less the legs of documents that carry
 * no tax fact of the regime** (MON-06): a remittance, an opening balance or a manual journal on these accounts
 * moves `account_balance` and no box, so `ledgerBase` is the balance less that movement, read per document
 * from `ledger_entry` because `account_balance` has no document key. The orientation is per account
 * type: `2300` is a liability, so its ledger figure is credit − debit; `1350` is an asset, so debit − credit.
 * Reversing the orientation is how a tie-out passes for assets and fails for liabilities — 4B's second-pass
 * finding, avoided here by taking the sign from `app.account.type` and not from a hand-written map (and
 * `createTaxCode` refuses an output code off a liability or an input code off an asset).
 */
export async function taxReturnTieOut(
  tx: Sql,
  taxReturnId: string,
  companyId?: string,
): Promise<TaxReturnTieOutRow[]> {
  const { row, boxes, currency: ccy } = await getTaxReturn(tx, taxReturnId, companyId);
  if (row.payload === null) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `tax return ${taxReturnId} is a draft — generate it first`,
    );
  }
  const definition = malaysiaPack.regimes.find(
    (d) => d.code === row.regimeCode && d.version === row.regimeVersion,
  )!;

  // The accounts each side reads, from the regime's own codes (see above).
  const named = await tx<{ kind: "output" | "input"; code: string }[]>`
    select distinct c.kind, a.code
      from app.tax_code c
      join app.account a
        on a.id = case c.kind when 'output' then c.output_account_id else c.input_account_id end
     where c.company_id = ${row.companyId} and c.regime_id = ${row.regimeId}
       and c.kind in ('output', 'input')`;
  const accountsOf = (kind: "output" | "input", fallback: string): string[] => {
    const codes = [...new Set(named.filter((n) => n.kind === kind).map((n) => n.code))].toSorted();
    return codes.length > 0 ? codes : [fallback];
  };

  // Which tax box feeds which side: an `output` box credits the output accounts, an `input` box debits the
  // input accounts. The mapping comes from the DEFINITION's own `kinds` and `measure`, never from a literal
  // box code, so a regime with different box codes (OD-15's) ties out without editing this function.
  const wanted: { accountCodes: string[]; boxCodes: string[] }[] = [
    {
      accountCodes: accountsOf("input", "1350"),
      boxCodes: definition.boxes
        .filter((b) => b.measure === "tax" && b.kinds.includes("input"))
        .map((b) => b.code),
    },
    {
      accountCodes: accountsOf("output", "2300"),
      boxCodes: definition.boxes
        .filter((b) => b.measure === "tax" && b.kinds.includes("output"))
        .map((b) => b.code),
    },
  ];

  // `ccy` came back from `getTaxReturn` — one read of `company.base_currency` per tie-out, not two.
  const out: TaxReturnTieOutRow[] = [];
  for (const w of wanted) {
    let boxTotal = Money.zero(ccy);
    for (const b of boxes) if (w.boxCodes.includes(b.code)) boxTotal = boxTotal.add(b.amount);
    const [led] = await tx<{ base: string | null }[]>`
      select coalesce(sum(case a.type when 'liability' then b.base_credit - b.base_debit
                                      else b.base_debit - b.base_credit end), 0)::numeric(19,4)::text as base
        from app.account_balance b
        join app.account a on a.id = b.account_id
        join app.fiscal_period p on p.id = b.fiscal_period_id
       where b.company_id = ${row.companyId}
         and a.code       = any(${w.accountCodes}::text[])
         and p.starts_on >= ${row.periodStart}
         and p.ends_on   <= ${row.periodEnd}`;
    // MON-06 (ADR 0050 decision 19's 2026-11-15 amendment): the same accounts' movement posted by documents
    // that carry NO tax fact of this regime — the remittance of an earlier period's tax (Dr 2300 / Cr 1100), an
    // OPENING_BALANCE, a manual JOURNAL. It is in `account_balance` and in no box, so counted it reported the
    // last period's tax as a difference in every period after the first payment. The ledger figure stays
    // `account_balance`'s; only this explained part is read from `ledger_entry`, per document.
    const [untaxed] = await tx<{ base: string | null }[]>`
      select coalesce(sum(case a.type when 'liability' then e.base_credit - e.base_debit
                                      else e.base_debit - e.base_credit end), 0)::numeric(19,4)::text as base
        from app.ledger_entry e
        join app.account a on a.id = e.account_id
        join app.fiscal_period p on p.id = e.fiscal_period_id
       where e.company_id = ${row.companyId}
         and a.code       = any(${w.accountCodes}::text[])
         and p.starts_on >= ${row.periodStart}
         and p.ends_on   <= ${row.periodEnd}
         and not exists (select 1 from app.tax_transaction t
                          where t.document_id = e.document_id and t.regime_id = ${row.regimeId})`;
    // `coalesce(..., 0)` is deliberate and is LEGACY-011's fix at this boundary: an account with no balance
    // row must read 0.0000, never null, or the difference would be null and the DoD assertion vacuous.
    const ledger = Money.of(led!.base!, ccy).subtract(Money.of(untaxed!.base!, ccy));
    out.push({
      accountCode: w.accountCodes.join("+"),
      boxCodes: w.boxCodes,
      boxBase: boxTotal.toString(),
      ledgerBase: ledger.toString(),
      difference: boxTotal.subtract(ledger).toString(),
    });
  }
  return out;
}

// ── 5B: the `generated → filed` transition (5A's plan hands it here under accounting.tax.file) ───

export interface FileTaxReturnInput {
  taxReturnId: string;
  /** The path company. When given it is part of the locking read, so a sibling company's return is the
   *  same `ERR_NOT_FOUND` as an id that does not exist. */
  companyId?: string;
  /** RFC 3339. Defaults to `now()`; supplied when the operator files late and records the real date. */
  filedAt?: string;
  /** The filing acknowledgement, already uploaded through 2C's attachment route. The composite FK
   *  `(tenant_id, attachment_id) → app.attachment` is what proves it exists and belongs to the tenant;
   *  a bad id surfaces as `ERR_CONFLICT_REFERENCE` through `fromDatabaseError`. */
  attachmentId?: string;
}

/** Moves a `generated` return to `filed`. Refuses every other status with the code 5A's own
 *  `generateTaxReturn` uses for the mirror-image refusal, so the two transitions of one row speak
 *  one language. Writes no payload: filing is an act of record, not a regeneration, and a return whose
 *  bytes changed at filing would break test 26's byte-identity.
 *
 *  **It refuses a STALE return** (PR 11 review, round 3). A taxed document posted inside a `generated`
 *  return's range after it was generated is a fact its payload does not hold, and filing it would leave
 *  that fact in no return — the next return's period filter excludes it. So the payload is rebuilt by the
 *  one build `generateTaxReturn` uses and compared byte for byte with the stored one; a difference is
 *  `ERR_DOC_STATUS_ILLEGAL`, "regenerate it before filing". The rebuild runs after the `for update` below,
 *  and a post into this range holds the return row FOR SHARE until it commits (`insertTaxTransactions`),
 *  so a post in flight is either committed — and seen here — or waits for this filing and is then refused
 *  as dated in a filed period.
 *
 *  **The tenant's audit-chain lock is taken FIRST, before the row** (`lockTenantAuditSerial`, 0010's
 *  'tenant-serial:' key). A post holds that lock from its first audited write — the issue, or step 8's
 *  UPDATE of the document — and reaches the return row only at step 11. A filing that locked the row first
 *  reached the audit chain only through the trigger on its own UPDATE, and the two orders closed a cycle:
 *  PostgreSQL aborted one with 40P01 (`return-integrity.test.ts` drives it). In the post's order, a filing
 *  that arrives during a post waits for it holding nothing and then finds the payload stale; one that
 *  arrives first makes the post wait at its first audited write. The price is the audit chain held across
 *  the rebuild, a lock the UPDATE below would take anyway and keep until commit. */
export async function fileTaxReturn(
  tx: Sql,
  ctx: TenantContext,
  input: FileTaxReturnInput,
): Promise<TaxReturnRow> {
  await lockTenantAuditSerial(tx, ctx.tenantId);
  const rows = (await tx`${SELECT_RETURN(tx)}
     where r.id = ${input.taxReturnId} and ${IN_COMPANY(tx, input.companyId)}
       for update of r`) as unknown as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new PostingError(
      "ERR_NOT_FOUND",
      `tax return ${input.taxReturnId} is not visible in this tenant`,
    );
  }
  const locked = toRow(rows[0]!);
  if (locked.status !== "generated") {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `tax return ${input.taxReturnId} is ${locked.status}, not generated — only a generated return may be filed`,
    );
  }
  const current = await buildPayloadFor(tx, locked);
  if (current.payload !== locked.payload) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `tax return ${input.taxReturnId} no longer matches the tax transactions of ${locked.periodStart}..${locked.periodEnd} — ` +
        "a document was posted into its period after it was generated; regenerate it before filing",
    );
  }
  if (input.attachmentId) {
    const [attachment] = await tx<{ id: string }[]>`
      select a.id from app.attachment a join app.document d on d.id = a.document_id
       where a.id = ${input.attachmentId} and d.company_id = ${locked.companyId}`;
    if (!attachment)
      throw new PostingError("ERR_NOT_FOUND", "filing attachment is not in this company");
  }
  // ONE update, and that is load-bearing: the audit trigger writes a row per UPDATE, so a second
  // statement to default `filed_at` would put two audit rows behind one status change — the same
  // LEGACY-041 shape the `for update` two lines above exists to prevent.
  await tx`
    update app.tax_return
       set status        = 'filed',
           filed_at      = coalesce(${input.filedAt ?? null}::timestamptz, now()),
           attachment_id = ${input.attachmentId ?? null}
     where id = ${input.taxReturnId}
  `;
  const { row } = await getTaxReturn(tx, input.taxReturnId, input.companyId);
  return row;
}
