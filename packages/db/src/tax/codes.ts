// packages/db/src/tax/codes.ts
import type { Sql } from "postgres";
import type { RoundingMode, TaxCodeDef, TaxRegime } from "@dulja/domain";
import { PostingError } from "../posting/errors";
import type { TenantContext } from "../with-tenant";

/** The keyset position of the `tax-codes` list. Declared locally as `{ code, id }` rather than imported
 *  from §4.2.8's `Cursor`, because `packages/db` may not import `@dulja/contracts` (§3.1) — the route
 *  module is what encodes and decodes the opaque wire cursor. */
export interface TaxCodeCursor {
  code: string;
  id: string;
}

export interface TaxCodeRow extends TaxCodeDef {
  companyId: string;
  nameEn: string;
  nameAr: string | null;
  archivedAt: string | null;
  regimeCode: string;
  regimeVersion: number;
}

/** Historical corrections may additionally resolve codes actually used by their posted source.
 * New invoices still require non-archived, effective codes.
 * Every non-archived code of a company effective on `on`, keyed by ROW ID — which is exactly the shape
 *  `DocumentSnapshot.refs.taxCodes` wants (§4.4.2: "keyed by the row id … so the evaluator never does a
 *  second lookup"). `TaxCodeDef` is a field-for-field superset of `TaxCodeRef` and satisfies it
 *  structurally, so nothing converts between the two. */
export async function loadTaxCodeRefs(
  tx: Sql,
  companyId: string,
  on: string,
  historicalSourceId: string | null = null,
): Promise<Record<string, TaxCodeDef>> {
  const rows = await tx<
    {
      id: string;
      regime_id: string;
      code: string;
      rate: string;
      kind: TaxCodeDef["kind"];
      rounding_mode: RoundingMode;
      output_account_id: string | null;
      input_account_id: string | null;
      effective_from: string;
      effective_to: string | null;
    }[]
  >`
    select c.id, c.regime_id, c.code, c.rate::text as rate, c.kind, c.rounding_mode,
           c.output_account_id, c.input_account_id, c.effective_from::text, c.effective_to::text
      from app.tax_code c
     where c.company_id = ${companyId}
       and ((c.archived_at is null and c.effective_from <= ${on}
             and (c.effective_to is null or c.effective_to >= ${on}))
         or exists (select 1 from app.tax_transaction t
                      join app.document source on source.id = t.document_id
                     where t.document_id = ${historicalSourceId} and t.tax_code_id = c.id
                       and source.company_id = ${companyId} and source.status in ('posted', 'reversed')))`;
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        regimeId: r.regime_id,
        code: r.code,
        rate: r.rate,
        kind: r.kind,
        roundingMode: r.rounding_mode,
        outputAccountId: r.output_account_id,
        inputAccountId: r.input_account_id,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
      } satisfies TaxCodeDef,
    ]),
  );
}

/**
 * The regime every tax code on one document belongs to, or `null` when no line carries a code.
 *
 * **A document whose lines span two regimes is refused.** LEGACY-020's failure was that nothing said which
 * regime a code belonged to, so a VAT tenant ran the GST return and reported sales as purchases; a document
 * mixing two regimes would put half its transactions in one return and half in another, with both returns
 * looking complete. The refusal names both regimes.
 */
export async function resolveRegimeFor(tx: Sql, documentId: string): Promise<TaxRegime | null> {
  const rows = await tx<
    {
      id: string;
      code: string;
      jurisdiction: "MY";
      version: number;
      effective_from: string;
      effective_to: string | null;
    }[]
  >`
    select distinct r.id, r.code, r.jurisdiction, r.version,
                    r.effective_from::text, r.effective_to::text
      from app.document_line l
      join app.tax_code c on c.id = l.tax_code_id
      join app.tax_regime r on r.id = c.regime_id
     where l.document_id = ${documentId}
     order by r.code`;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new PostingError(
      "ERR_TAX_REGIME_MISMATCH",
      `document ${documentId} spans two tax regimes: ${rows.map((r) => r.code).join(" and ")}`,
    );
  }
  const r = rows[0]!;
  return {
    id: r.id,
    code: r.code,
    jurisdiction: r.jurisdiction,
    version: r.version,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

/** The `tax-codes` list route's read. Keyset on `(code, id)`; `regimeCode` is the one declared filter. */
export async function listTaxCodes(
  tx: Sql,
  p: {
    companyId: string;
    id?: string;
    regimeCode?: string;
    includeArchived?: boolean;
    cursor?: TaxCodeCursor | null;
    limit: number;
  },
): Promise<TaxCodeRow[]> {
  const rows = await tx<Record<string, string | number | null>[]>`
    select c.id, c.company_id, c.regime_id, c.code, c.name_en, c.name_ar, c.rate::text as rate, c.kind,
           c.rounding_mode, c.output_account_id, c.input_account_id,
           c.effective_from::text, c.effective_to::text, c.archived_at::text,
           r.code as regime_code, r.version as regime_version
      from app.tax_code c
      join app.tax_regime r on r.id = c.regime_id
     where c.company_id = ${p.companyId}
       and (${p.id ?? null}::uuid is null or c.id = ${p.id ?? null})
       and (${p.regimeCode ?? null}::text is null or r.code = ${p.regimeCode ?? null})
       and (${p.includeArchived ?? false} or c.archived_at is null)
       and (${p.cursor?.code ?? null}::text is null
            or (c.code, c.id) > (${p.cursor?.code ?? null}::text, ${p.cursor?.id ?? null}::uuid))
     order by c.code, c.id
     limit ${p.limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    companyId: r.company_id as string,
    regimeId: r.regime_id as string,
    code: r.code as string,
    nameEn: r.name_en as string,
    nameAr: r.name_ar as string | null,
    rate: r.rate as string,
    kind: r.kind as TaxCodeDef["kind"],
    roundingMode: r.rounding_mode as RoundingMode,
    outputAccountId: r.output_account_id as string | null,
    inputAccountId: r.input_account_id as string | null,
    effectiveFrom: r.effective_from as string,
    effectiveTo: r.effective_to as string | null,
    archivedAt: r.archived_at as string | null,
    regimeCode: r.regime_code as string,
    regimeVersion: r.regime_version as number,
  }));
}

/** **An output code's account must be a liability and an input code's an asset** (PR 11 review, round 3):
 *  output tax is owed, input tax is reclaimable. `taxReturnTieOut` reads every account the regime's codes
 *  name and takes each one's sign from its type, so a code on the wrong type would tie out inverted — and,
 *  because an account has one type, the rule is also what keeps the two sides of the tie-out from naming
 *  one account. The ONE statement of it, applied by both writers of a code's account: `createTaxCode` and
 *  the seed's `taxLoader`. Every other kind carries no account and fits. Returns the refusal's detail, or
 *  `null` when the account fits. */
export function taxCodeAccountMisfit(
  kind: TaxCodeDef["kind"],
  accountCode: string,
  accountType: string,
): string | null {
  if (kind !== "output" && kind !== "input") return null;
  const wanted = kind === "output" ? "liability" : "asset";
  if (accountType === wanted) return null;
  return (
    `an ${kind} tax code posts its tax to ${kind === "output" ? "a liability" : "an asset"} account; ` +
    `account ${accountCode} is ${accountType} (§4.15)`
  );
}

/** The break-glass runtime create under `accounting.tax.manage`. The PRIMARY load path is the seed PR
 *  (ADR 0050, §3.4.8) — this exists so an accountant can add a code mid-period without a deploy, and the
 *  audit trigger on `tax_code` is what records that they did.
 *
 *  An account of the wrong type for the code's kind (`taxCodeAccountMisfit`) is the 422
 *  `ERR_POLICY_REQUIRES_MISSING` the route already documents for an account it cannot use. */
export async function createTaxCode(
  tx: Sql,
  ctx: TenantContext,
  input: {
    companyId: string;
    regimeId: string;
    code: string;
    nameEn: string;
    nameAr?: string | null;
    rate: string;
    kind: TaxCodeDef["kind"];
    roundingMode: RoundingMode;
    accountCode: string | null;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<TaxCodeRow> {
  const [regime] = await tx<
    { id: string }[]
  >`select id from app.tax_regime where id = ${input.regimeId} and company_id = ${input.companyId}`;
  if (!regime) throw new PostingError("ERR_NOT_FOUND", "tax regime is not in this company");
  let accountId: string | null = null;
  if (input.accountCode !== null) {
    const [account] = await tx<{ id: string; type: string }[]>`
      select id, type::text from app.account where company_id = ${input.companyId} and code = ${input.accountCode} and archived_at is null and not is_group`;
    if (!account) {
      throw new PostingError(
        "ERR_POLICY_REQUIRES_MISSING",
        `account ${input.accountCode} does not exist for this company (§4.15)`,
      );
    }
    const misfit = taxCodeAccountMisfit(input.kind, input.accountCode, account.type);
    if (misfit) throw new PostingError("ERR_POLICY_REQUIRES_MISSING", misfit);
    accountId = account.id;
  }
  const [row] = await tx<{ id: string }[]>`
    insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, name_ar, rate, kind,
                              rounding_mode, output_account_id, input_account_id, effective_from, effective_to)
    values (${ctx.tenantId}, ${input.companyId}, ${input.regimeId}, ${input.code}, ${input.nameEn},
            ${input.nameAr ?? null}, ${input.rate}, ${input.kind}, ${input.roundingMode},
            ${input.kind === "output" ? accountId : null},
            ${input.kind === "input" ? accountId : null},
            ${input.effectiveFrom}, ${input.effectiveTo ?? null})
    returning id`;
  const [created] = await listTaxCodes(tx, {
    companyId: input.companyId,
    includeArchived: true,
    id: row!.id,
    limit: 1,
  }).then((all) => all.filter((c) => c.id === row!.id));
  return created!;
}

/** spec:2049: master data is archived, never deleted. `app_rw` holds no DELETE on this table (§3.5.4).
 *  `companyId`, when given, is part of the UPDATE's own WHERE, so a sibling company's code is the same
 *  `ERR_NOT_FOUND` as an id that does not exist and the route reads nothing first. */
export async function archiveTaxCode(
  tx: Sql,
  ctx: TenantContext,
  taxCodeId: string,
  companyId?: string,
): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update app.tax_code set archived_at = now()
     where id = ${taxCodeId} and archived_at is null
       and (${companyId ?? null}::uuid is null or company_id = ${companyId ?? null}::uuid)
    returning id`;
  if (rows.length === 0)
    throw new PostingError("ERR_NOT_FOUND", `tax code ${taxCodeId} is not an open code`);
}

export async function getTaxCode(tx: Sql, companyId: string, id: string): Promise<TaxCodeRow> {
  const [row] = await listTaxCodes(tx, { companyId, id, includeArchived: true, limit: 1 });
  if (!row) throw new PostingError("ERR_NOT_FOUND", "tax code is not in this company");
  return row;
}

/** A POS partial return's single linked source provides historical code visibility without full-reversal semantics. */
export async function resolvePosReturnTaxSource(
  tx: Sql,
  documentId: string,
): Promise<string | null> {
  const sources = await tx<{ id: string }[]>`
    select distinct source.id
    from app.document target join app.document_type target_type on target_type.id=target.document_type_id
    join app.document_link k on k.target_document_id=target.id and k.link_kind='returns'
    join app.document source on source.id=k.source_document_id
    join app.document_type source_type on source_type.id=source.document_type_id
    where target.id=${documentId} and target_type.code='POS_TICKET' and source_type.code='POS_TICKET'
      and source.status='posted' and source.reverses_document_id is null and source.company_id=target.company_id and source.branch_id=target.branch_id
      and source.party_id is not distinct from target.party_id and source.currency=target.currency
      and target.terminal_id is not null and k.quantity>0
      and not exists (select 1 from app.document_line l where l.document_id=target.id and l.kind='item' and l.quantity>=0)`;
  if (sources.length > 1)
    throw new PostingError(
      "ERR_VALIDATION_FAILED",
      "POS return has ambiguous historical tax sources",
    );
  return sources[0]?.id ?? null;
}
