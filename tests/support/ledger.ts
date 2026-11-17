import type { Sql } from "postgres";
import type { Seed } from "@dulja/db/test";

export interface Line {
  account: string;
  debit?: string;
  credit?: string;
  currency?: string;
  rate?: string;
}

/**
 * The exact `app.ledger_entry` insert the posting service must reproduce — column list and
 * `base_* = round(value × rate, 4)` copied from `packages/db/test/ledger.test.ts` (plan0A:1908–1923; contracts
 * §4.1 names that helper as the reference). Copied rather than imported: that file is a `.test.ts` with a
 * top-level `describe`, and importing it would re-run Plan 0A's ledger suite inside the `tests` workspace.
 *
 * Nothing outside these regression files may write a ledger table (contracts hazard 22, the `posting-only-tables`
 * lint of 1A) — but `scripts/lint/run.ts` walks `apps`, `packages` and `scripts` only, so `tests/**` is outside
 * every lint root, and `tests/**` is where the defect being regressed has to be re-attempted. That exemption is
 * structural, not recorded in contracts §3.7.5, so header assumption 13 carries it: a later slice that adds
 * `tests` to `ROOTS` must put `tests/support/**` on `posting-only-tables`'s allow-list in the same PR, or every
 * thin ledger regression fails lint. When 1A ships `postDocument`, these files keep this helper: they assert the
 * DATABASE refuses the defect, not that the service avoids it.
 */
export async function postLines(
  tx: Sql,
  s: Seed,
  docId: string,
  lines: Line[],
  periodId = s.period,
  // Inside `periodId`: 0107 refuses a line dated outside the period it names (ERR_PERIOD_NOT_FOUND) before
  // assert_period_open ever looks at the period's status — the same parameter `packages/db/test/ledger.test.ts`
  // gained for the same reason.
  effectiveDate = "2026-01-15",
): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n += 1;
    const rate = l.rate ?? "1";
    // 0008 made ledger_entry.currency a foreign key into app.currency, and a Line may name any code it
    // likes (legacy-012 posts in EUR). seedTenant supplies only the tenant's own MYR, so the helper that
    // assembles the posting supplies the rest — otherwise every suite wanting a foreign-currency line
    // would have to know to seed it first. Defaults on the column, like seedCurrency: this is a test
    // convenience, not a statement about what that currency's rounding policy should be.
    await tx`insert into app.currency (tenant_id, code, name_en)
      values (${s.tenant}, ${l.currency ?? "MYR"}, ${l.currency ?? "MYR"})
      on conflict (tenant_id, code) do nothing`;
    await tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit,
       effective_date, fiscal_period_id, posting_policy_id)
      values (${s.tenant}, ${s.company}, ${docId}, ${n}, ${l.account}, ${l.debit ?? "0"}, ${l.credit ?? "0"}, ${l.currency ?? "MYR"}, ${rate},
              round(${l.debit ?? "0"}::numeric * ${rate}::numeric, 4), round(${l.credit ?? "0"}::numeric * ${rate}::numeric, 4),
              ${effectiveDate}, ${periodId}, ${s.policy})`;
  }
}
