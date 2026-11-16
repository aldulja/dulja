import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import {
  registerReconcilableSource,
  type Reconcilable,
  type ReconcilableSource,
} from "../ar-ap/reconciliation";

/**
 * The `payroll_batch` source (8C Task 12, contracts round 18 B12; acceptance test 39's payroll-batch clause). §4.8.3's
 * seam, used exactly as 4B built it: 6D added `till_banking`, 8C adds `payroll_batch`, and **neither edits a file of
 * 4B's** — `reconcilable_kind`'s CHECK and `RECONCILABLE_DIRECTION` already admit the kind (`"out"`).
 *
 * It lists a posted `PAYROLL_PAYMENT`'s LEDGER bank leg rather than a document total (ADR 0048's reasoning): a batch
 * has no total column, the ledger is the record, and the leg is what a statement line is matched against. 4B's own
 * `ledgerLegSource` is module-private, so this is its SHAPE rather than its code — the same leg arithmetic in the
 * account's currency (base amounts for a base-currency account, the leg's own amounts when the leg is in the account's
 * currency), the same `posted`/`reversed` statuses (both halves of a full reversal moved the bank), the same
 * live-match subquery restricted to THIS bank account's statements, so the two behave alike at the margins. The figure
 * is a MAGNITUDE; `RECONCILABLE_DIRECTION.payroll_batch` carries the direction (§4.4.2 A9's discipline). An
 * `EMPLOYEE_ADVANCE` also credits `1100`, and is not a batch: the type code bounds the list.
 */
export const PAYROLL_BATCH_SOURCE: ReconcilableSource = {
  kind: "payroll_batch",
  async list(tx: Sql, input): Promise<Reconcilable[]> {
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
           and t.code = 'PAYROLL_PAYMENT'
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
      kind: "payroll_batch" as const,
      documentId: r.document_id,
      bankAccountId: input.bankAccountId,
      valueDate: r.value_date,
      amount: Money.of(r.magnitude, currency(r.ccy)),
      reference: r.reference,
    }));
  },
};

// Module-level, exactly as 4B and 6D register theirs: the `hr` barrel exports this file, so importing `@dulja/db`
// registers it. `registerReconcilableSource` is a `Map.set` keyed on the kind — it adds a kind and replaces none.
registerReconcilableSource(PAYROLL_BATCH_SOURCE);
