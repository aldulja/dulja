// packages/db/src/ar-ap/ageing.ts
//
// Slice 4B (contracts §4.8.2, ADR 0046). The TypeScript over migration 0048's app.party_ageing_rows: it
// selects, it MERGEs, it compares and it ties out. It contains NO ageing arithmetic of its own — every figure
// below comes out of the SQL function, so the report, the snapshot and the integrity comparison cannot
// disagree about what "open" means. Every amount leaves Postgres as `::text` (spec:2041).
//
// This file and `packages/db/src/projections/item-profitability.ts` are the only writers of the two async
// projections; neither is on the posting-only-tables lint's list (§3.7.5 names them as its exclusions).
import type { Sql } from "postgres";
import type { ProjectionMismatch } from "../integrity/types";

export type AgeingBucket = "current" | "1_30" | "31_60" | "61_90" | "over_90";

/** Registry order, oldest last — the order every report column set and every screen renders. */
export const PARTY_AGEING_BUCKETS: readonly AgeingBucket[] = [
  "current",
  "1_30",
  "31_60",
  "61_90",
  "over_90",
];

export interface PartyAgeingRow {
  partyId: string;
  currency: string;
  bucket: AgeingBucket;
  /** 4 dp, in the open documents' own currency. */
  amount: string;
  /** 4 dp, in the company's base currency, at each open document's own rate. */
  baseAmount: string;
}
export interface AgeingParams {
  companyId: string;
  asOf: string;
}

/** The fresh computation, straight off `app.party_ageing_rows` — never a second arithmetic (amendment 3). */
export async function ageingRows(tx: Sql, params: AgeingParams): Promise<PartyAgeingRow[]> {
  const rows = await tx<
    {
      party_id: string;
      currency: string;
      bucket: AgeingBucket;
      amount: string;
      base_amount: string;
    }[]
  >`
    select party_id::text as party_id, currency::text as currency, bucket,
           amount::text as amount, base_amount::text as base_amount
      from app.party_ageing_rows(${params.companyId}::uuid, ${params.asOf}::date)
     order by party_id, currency, bucket`;
  return rows.map((r) => ({
    partyId: r.party_id,
    currency: r.currency,
    bucket: r.bucket,
    amount: r.amount,
    baseAmount: r.base_amount,
  }));
}

/**
 * MERGE the fresh rows into the snapshot for this `(company, as_of)`, then zero the keys of the same scope
 * the fresh set no longer contains. It NEVER deletes: §3.5.4's app_rw DELETE list is pinned to five tables
 * and 2B is its only extender (ADR 0046). A zeroed row and an absent row read identically to every reader,
 * and `zeroed` counts only keys that were non-zero before this run.
 *
 * ONE statement and ONE evaluation of `app.party_ageing_rows` (code review B3): a `materialized` CTE of the
 * fresh rows feeds both data-modifying CTEs — the MERGE and the zeroing UPDATE, which touch disjoint keys —
 * and is returned as `rows`, so the nightly job's `comparePartyAgeing` compares the table against the very
 * rows written instead of evaluating the function a third time. Every sub-statement reads one snapshot, so
 * the zeroing never sees a key the MERGE inserts.
 *
 * SERIALISED per `(company, as_of)` first (code review 2, F6), exactly as contracts amendment A4 serialises
 * account_balance's MERGE in postDocument: `MERGE … WHEN NOT MATCHED THEN INSERT` does not re-check the target
 * on a concurrent insert, so two rebuilds that both found a key absent both inserted and the second raised
 * 23505 when the first committed — which withTenant does not retry. The nightly `.fanout` runs `runJob` per
 * company outside the stately queue and can overlap a post-triggered rebuild of the same as_of. The lock is
 * its OWN statement, before the MERGE's: under READ COMMITTED the MERGE then takes its snapshot after the
 * lock is granted, sees the other run's committed rows and updates them. A lock inside the same statement
 * would come after that statement's snapshot was fixed. Transaction-scoped; released at commit. The job
 * takes this lock and then `rebuildItemProfitability`'s, always in that order, so two runs cannot deadlock.
 */
export async function rebuildPartyAgeing(
  tx: Sql,
  params: AgeingParams,
): Promise<{ merged: number; zeroed: number; rows: PartyAgeingRow[] }> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`party_ageing:${params.companyId}/${params.asOf}`}, 0))`;
  const result = await tx<
    {
      merged: number;
      zeroed: number;
      party_id: string | null;
      currency: string | null;
      bucket: AgeingBucket | null;
      amount: string | null;
      base_amount: string | null;
    }[]
  >`
    with fresh as materialized (
      select r.party_id, r.currency, r.bucket, r.amount, r.base_amount
        from app.party_ageing_rows(${params.companyId}::uuid, ${params.asOf}::date) r
    ),
    merged as (
      merge into app.party_ageing t
      using fresh s
         on t.company_id = ${params.companyId}::uuid and t.party_id = s.party_id
        and t.currency   = s.currency                and t.as_of    = ${params.asOf}::date
        and t.bucket     = s.bucket
       when matched then update
            set amount = s.amount, base_amount = s.base_amount, updated_at = now()
       when not matched then insert
            (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
            values (app.current_tenant(), ${params.companyId}::uuid, s.party_id, s.currency,
                    ${params.asOf}::date, s.bucket, s.amount, s.base_amount)
      returning 1
    ),
    zeroed as (
      update app.party_ageing t
         set amount = 0, base_amount = 0, updated_at = now()
       where t.company_id = ${params.companyId}::uuid and t.as_of = ${params.asOf}::date
         and (t.amount <> 0 or t.base_amount <> 0)
         and not exists (
           select 1 from fresh r
            where r.party_id = t.party_id and r.currency = t.currency and r.bucket = t.bucket)
      returning 1
    )
    select (select count(*) from merged)::int as merged,
           (select count(*) from zeroed)::int as zeroed,
           f.party_id::text as party_id, f.currency::text as currency, f.bucket,
           f.amount::text as amount, f.base_amount::text as base_amount
      from (select 1) as one
      left join fresh f on true
     order by f.party_id, f.currency, f.bucket`;

  const rows: PartyAgeingRow[] = [];
  for (const r of result) {
    if (r.party_id === null) continue; // the one row an empty fresh set still returns, for the counts
    rows.push({
      partyId: r.party_id,
      currency: r.currency!,
      bucket: r.bucket!,
      amount: r.amount!,
      baseAmount: r.base_amount!,
    });
  }
  return { merged: result[0]!.merged, zeroed: result[0]!.zeroed, rows };
}

/**
 * Rebuild-and-compare (test 2, spec:1204 "a mismatch is an incident"): the stored snapshot for this
 * `(company, as_of)` full-outer-joined against the fresh function. A zero stored row reads as absent, and a
 * missing side is reported as missing rather than compared as zero.
 *
 * `fresh`, when given, is the fresh side — the rows `rebuildPartyAgeing` computed and wrote in this same
 * transaction — so the nightly job does not evaluate `app.party_ageing_rows` again (code review B3). Without
 * it the function is evaluated here.
 */
export async function comparePartyAgeing(
  tx: Sql,
  params: AgeingParams,
  fresh?: readonly PartyAgeingRow[],
): Promise<ProjectionMismatch[]> {
  const freshRows =
    fresh === undefined
      ? tx`
          select party_id, currency, bucket, amount, base_amount
            from app.party_ageing_rows(${params.companyId}::uuid, ${params.asOf}::date)`
      : tx`
          select f.party_id, f.currency, f.bucket, f.amount, f.base_amount
            from unnest(${fresh.map((r) => r.partyId)}::uuid[],
                        ${fresh.map((r) => r.currency)}::text[],
                        ${fresh.map((r) => r.bucket)}::text[],
                        ${fresh.map((r) => r.amount)}::numeric(19,4)[],
                        ${fresh.map((r) => r.baseAmount)}::numeric(19,4)[])
                 as f(party_id, currency, bucket, amount, base_amount)`;
  const rows = await tx<
    {
      party_id: string;
      currency: string;
      bucket: string;
      stored_amount: string | null;
      stored_base: string | null;
      fresh_amount: string | null;
      fresh_base: string | null;
    }[]
  >`
    with stored as (
      select party_id, currency, bucket, amount, base_amount
        from app.party_ageing
       where company_id = ${params.companyId}::uuid and as_of = ${params.asOf}::date
         and (amount <> 0 or base_amount <> 0)
    ),
    fresh as (${freshRows})
    select coalesce(s.party_id, f.party_id)::text as party_id,
           coalesce(s.currency, f.currency)::text as currency,
           coalesce(s.bucket, f.bucket)           as bucket,
           s.amount::text as stored_amount, s.base_amount::text as stored_base,
           f.amount::text as fresh_amount,  f.base_amount::text as fresh_base
      from stored s
      full outer join fresh f
        on f.party_id = s.party_id and f.currency = s.currency and f.bucket = s.bucket
     where s.party_id is null or f.party_id is null
        or s.amount <> f.amount or s.base_amount <> f.base_amount
     order by 1, 2, 3`;

  return rows.map((r): ProjectionMismatch => {
    const key = {
      company_id: params.companyId,
      party_id: r.party_id,
      currency: r.currency,
      as_of: params.asOf,
      bucket: r.bucket,
    };
    if (r.stored_amount === null) {
      return {
        projection: "party_ageing",
        key,
        side: "missing_in_projection",
        detail: `fresh amount ${r.fresh_amount}, base_amount ${r.fresh_base}, no stored row`,
      };
    }
    if (r.fresh_amount === null) {
      return {
        projection: "party_ageing",
        key,
        side: "missing_in_rebuild",
        detail: `stored amount ${r.stored_amount}, base_amount ${r.stored_base}, no fresh row`,
      };
    }
    const parts: string[] = [];
    if (r.stored_amount !== r.fresh_amount)
      parts.push(`amount ${r.stored_amount} <> ${r.fresh_amount}`);
    if (r.stored_base !== r.fresh_base)
      parts.push(`base_amount ${r.stored_base} <> ${r.fresh_base}`);
    return { projection: "party_ageing", key, side: "amount_differs", detail: parts.join("; ") };
  });
}

export interface AgeingTieOutRow {
  accountId: string;
  accountCode: string;
  accountType: string;
  ageingBase: string;
  ledgerBase: string;
  revaluationBase: string;
  /** ageingBase − (ledgerBase − revaluationBase). "0.0000" is the definition of done (§4.8.2). */
  difference: string;
}

/**
 * The definition-of-done figure (§4.8.2, ADR 0046). One row per control account any party of the company
 * points at — the account `app.party_ageing_rows` reads for that party: `coalesce(payable, receivable)` for a
 * vendor, `coalesce(receivable, payable)` otherwise (`app.party_control_account`, 0045).
 *
 *   difference = ageingBase − (ledgerBase − revaluationBase)
 *
 * and "0.0000" is the DoD. All three columns are in the ACCOUNT's orientation — an asset control
 * debit-positive, a liability control credit-positive — by the account type's sign (+1 / −1).
 *
 * `app.party_ageing_rows` orients by party KIND, not by account: it flips a vendor's figure and no one
 * else's (§4.8.2's "vendor side sign-flipped", frozen). On an ordinary company that is the same thing — every
 * customer sits on an asset control and every vendor on a liability one — but 0045's fallbacks let a party
 * sit on an account whose type disagrees with its kind: an employee or dealer with only a payable account is
 * aged un-flipped on `2100`, a vendor with only a receivable account flipped on `1200`. So each party's
 * ageing is first brought back to debit-positive by the SAME kind test 0048 flipped it by, and only the sum
 * is oriented by the account (code review 2, F3 — the tie-out read twice the balance for such a party):
 *
 *   ageingBase = sign(account) × Σ sign(kind) × party ageing      (sign(kind) = −1 for a vendor, else +1)
 *   difference = sign(account) × (Σ sign(kind) × party ageing − (ledger − revaluation))
 *
 * When every party on an account has the orientation its type implies, this is the figure the ageing
 * reports, unchanged.
 *
 * `revaluationBase` is the base carried by posted UNREALISED `FX_REVALUATION` documents up to `asOf`, the
 * reversal counted through its original's marker (see `outstandingRevaluation`): the ageing values open
 * items at each document's own rate, so an unrealised restatement of the control account is legitimately
 * outside it until it is reversed. Zero until 4B Task 5 ships the type.
 */
export async function ageingTieOut(tx: Sql, params: AgeingParams): Promise<AgeingTieOutRow[]> {
  const rows = await tx<
    {
      account_id: string;
      code: string;
      type: string;
      ageing_base: string;
      ledger_base: string;
      revaluation_base: string;
      difference: string;
    }[]
  >`
    with party_control as (
      -- party_sign undoes 0048's kind-keyed flip: the same test, so the two cannot disagree.
      select p.id as party_id,
             app.party_control_account(p) as account_id,
             case when p.kind = 'vendor' then -1 else 1 end as party_sign
        from app.party p
       where p.company_id = ${params.companyId}::uuid
    ),
    acct as (
      select a.id, a.code, a.type::text as type,
             case when a.type = 'liability' then -1 else 1 end as sign
        from app.account a
       where a.company_id = ${params.companyId}::uuid
         and a.id in (select pc.account_id from party_control pc)
    ),
    ageing as (
      -- debit-positive, like the ledger: each party's figure back through its own kind sign
      select pc.account_id, sum(pc.party_sign * g.base_amount) as base
        from app.party_ageing_rows(${params.companyId}::uuid, ${params.asOf}::date) g
        join party_control pc on pc.party_id = g.party_id
       group by 1
    ),
    led as (
      select le.account_id, sum(le.base_debit - le.base_credit) as base
        from app.ledger_entry le
       where le.company_id = ${params.companyId}::uuid and le.effective_date <= ${params.asOf}::date
       group by 1
    ),
    rev as (
      -- EXISTS, never a join to document_line: a join would multiply every ledger row by the number of
      -- marked lines (two per exposure pair), reading a revaluation of 800 where 400 was posted.
      select le.account_id, sum(le.base_debit - le.base_credit) as base
        from app.ledger_entry le
        join app.document d      on d.id = le.document_id
        join app.document_type t on t.id = d.document_type_id
       where le.company_id = ${params.companyId}::uuid
         and le.effective_date <= ${params.asOf}::date
         and t.code = 'FX_REVALUATION'
         and exists (select 1 from app.document_line ol
                      where ol.document_id = coalesce(d.reverses_document_id, d.id)
                        and ol.custom_fields->>'fxKind' = 'unrealised')
       group by 1
    )
    select a.id::text as account_id, a.code, a.type,
           (a.sign * coalesce(g.base, 0))::numeric(19,4)::text       as ageing_base,
           (a.sign * coalesce(l.base, 0))::numeric(19,4)::text       as ledger_base,
           (a.sign * coalesce(r.base, 0))::numeric(19,4)::text       as revaluation_base,
           (a.sign * (coalesce(g.base, 0) - (coalesce(l.base, 0) - coalesce(r.base, 0))))::numeric(19,4)::text
                                                                     as difference
      from acct a
      left join ageing g on g.account_id = a.id
      left join led    l on l.account_id = a.id
      left join rev    r on r.account_id = a.id
     order by a.code`;

  return rows.map((r) => ({
    accountId: r.account_id,
    accountCode: r.code,
    accountType: r.type,
    ageingBase: r.ageing_base,
    ledgerBase: r.ledger_base,
    revaluationBase: r.revaluation_base,
    difference: r.difference,
  }));
}

/**
 * Base carried on `accountId` by posted UNREALISED `FX_REVALUATION` documents up to `asOf`, signed by the
 * account's type — `ageingTieOut`'s `revaluationBase` for that one account, exported because Task 5's tests
 * assert it directly. `coalesce(d.reverses_document_id, d.id)` reads the ORIGINAL's lines when the document
 * is a reversal, so the pair nets to zero whether or not `reverseDocument` copies `custom_fields` onto the
 * reversing lines. The two queries must stay identical, and test 8 asserts that they agree.
 */
export async function outstandingRevaluation(
  tx: Sql,
  params: { companyId: string; accountId: string; asOf: string },
): Promise<string> {
  const [row] = await tx<{ base: string }[]>`
    select (case when a.type = 'liability' then -1 else 1 end
            * coalesce(sum(le.base_debit - le.base_credit), 0))::numeric(19,4)::text as base
      from app.account a
      left join app.ledger_entry le on le.account_id = a.id
       and le.company_id = ${params.companyId}::uuid
       and le.effective_date <= ${params.asOf}::date
       and exists (select 1 from app.document d
                     join app.document_type t on t.id = d.document_type_id
                    where d.id = le.document_id
                      and t.code = 'FX_REVALUATION'
                      and exists (select 1 from app.document_line ol
                                   where ol.document_id = coalesce(d.reverses_document_id, d.id)
                                     and ol.custom_fields->>'fxKind' = 'unrealised'))
     where a.company_id = ${params.companyId}::uuid
       and a.id = ${params.accountId}::uuid
     group by a.type`;
  // An account the caller cannot see (or of another company) carries nothing.
  return row?.base ?? "0.0000";
}
