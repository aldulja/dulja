import { repoFile, sliceRegression, thinRegression } from "../support/regression";

thinRegression(
  "SAH-070",
  "Index coverage is thin on exactly the columns reports filter by",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const idx = await db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry'`;
    expect(idx.map((i) => i.indexname)).toContain("ledger_entry_account_date_idx");

    // The columns the §4.16 reports filter by are covered by real indexes rather than by pinned plans: the
    // ledger by (company_id, account_id, effective_date) and (company_id, effective_date), the document by its
    // numbering tuple. Coverage is the fix; SAH-068's plan pinning was the workaround for its absence.
    expect(idx.map((i) => i.indexname)).toContain("ledger_entry_company_date_idx");
    const docIdx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'document'`;
    expect(
      docIdx.some((i) => /company_id.*series.*fiscal_period_id.*number/s.test(i.indexdef)),
    ).toBe(true);
  },
);

sliceRegression(
  "SAH-070",
  "Index coverage missing on the columns reports filter by",
  "1A",
  "the ledger read's filters are covered: (company_id, account_id, effective_date) and (company_id, effective_date)",
  async ({ db, expect }) => {
    const rows = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry'`;
    const defs = rows.map((row) => row.indexdef.replace(/\s+/g, " "));
    expect(defs.some((def) => /\(company_id, account_id, effective_date\)/.test(def))).toBe(true);
    expect(defs.some((def) => /\(company_id, effective_date\)/.test(def))).toBe(true);
    const lineIdx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'document_line'`;
    expect(
      lineIdx.some((row) => /\(document_id, line_no\)/.test(row.indexdef.replace(/\s+/g, " "))),
    ).toBe(true);
  },
);

sliceRegression(
  "SAH-070",
  "Index coverage is thin on exactly the columns reports filter by",
  "1B",
  "every column the Phase 1 reports and jobs filter by has an index whose leading columns are exactly it",
  async ({ db, expect }) => {
    const expected: Record<string, string[]> = {
      account_balance_company_period_idx: ["company_id", "fiscal_period_id", "currency"],
      fiscal_period_company_status_ends_idx: ["company_id", "status", "ends_on"],
      document_company_period_status_idx: ["company_id", "fiscal_period_id", "status"],
      ledger_entry_account_date_idx: ["company_id", "account_id", "effective_date"],
      ledger_entry_company_date_idx: ["company_id", "effective_date"],
    };
    const rows = await db.admin<{ index_name: string; cols: string[] }[]>`
      select i.relname as index_name,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(ix.indkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as cols
        from pg_index ix
        join pg_class i on i.oid = ix.indexrelid
        join pg_class t on t.oid = ix.indrelid
       where t.relnamespace = 'app'::regnamespace and i.relname = any(${Object.keys(expected)})
       order by 1`;
    expect(Object.fromEntries(rows.map((row) => [row.index_name, row.cols]))).toEqual(expected);

    // spec:770 — "`Journal` … has exactly one declared index, and it is not on date". The legacy failure
    // mode is impossible here: the primary key, unique (tenant_id, id) and the two date indexes.
    const ledger = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from pg_index ix
        join pg_class i on i.oid = ix.indexrelid
        join pg_class t on t.oid = ix.indrelid
       where t.relnamespace = 'app'::regnamespace and t.relname = 'ledger_entry'`;
    expect(ledger[0]!.n).toBeGreaterThanOrEqual(3);
  },
);

// 1B added indexes for its two readers. The 7B catalogue filters by some forty column pairs, and its EXPLAIN gate
// (packages/db/test/reports/7b-report-indexes.test.ts, which runs every pair) found twenty that no index could
// SEEK on: the column in no index, behind a key the report does not bind (3A's chrono index puts item_id before
// effective_date, so a company-wide date range read every item's entries), or only in a partial index whose
// predicate a report's WHERE never states. That is the SAH-070 shape. This block pins migration 0077's fourteen
// indexes so a later slice cannot quietly drop one, and that the migration says which report needed each — and
// the seven 7C's filters needed, first recorded unserved and added to 0077 by the Phase 7 remediation
// (contracts round 15, A17 as executed).
sliceRegression(
  "SAH-070",
  "Index coverage is thin on exactly the columns reports filter by",
  "7B",
  "the twenty-one indexes of migration 0077 exist, non-partial, and the migration names the reports that needed them",
  async ({ db, expect }) => {
    const expected: Record<string, string> = {
      allocation_company_party_idx: "(company_id, party_id)",
      audit_log_tenant_actor_time_idx: "(tenant_id, actor_id, occurred_at)",
      audit_log_tenant_table_time_idx: "(tenant_id, table_name, occurred_at)",
      audit_log_tenant_time_idx: "(tenant_id, occurred_at)",
      cost_layer_company_item_warehouse_idx: "(company_id, item_id, warehouse_id)",
      document_company_branch_date_idx: "(company_id, branch_id, effective_date)",
      document_company_date_idx: "(company_id, effective_date)",
      document_company_party_date_idx: "(company_id, party_id, effective_date)",
      document_company_type_date_idx: "(company_id, document_type_id, effective_date)",
      document_event_company_time_idx: "(company_id, occurred_at)",
      inventory_movement_company_date_idx: "(company_id, effective_date, posting_seq)",
      inventory_movement_company_warehouse_date_idx: "(company_id, warehouse_id, effective_date)",
      lot_company_expires_idx: "(company_id, expires_on)",
      needs_attention_company_branch_created_idx: "(company_id, branch_id, created_at)",
      needs_attention_company_created_idx: "(company_id, created_at)",
      price_list_line_item_any_idx: "(item_id)",
      shift_company_cashier_opened_idx: "(company_id, opened_principal_id, opened_at)",
      shift_company_opened_idx: "(company_id, opened_at)",
      stock_on_hand_company_warehouse_idx: "(company_id, warehouse_id)",
      stock_valuation_company_as_of_idx: "(company_id, as_of, warehouse_id)",
      tax_transaction_company_period_idx: "(company_id, fiscal_period_id)",
    };
    const rows = await db.admin<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'app' and indexname = any(${Object.keys(expected)})`;
    expect(
      Object.fromEntries(
        rows.map((r) => [
          r.indexname,
          /USING btree (\([^)]*\))/.exec(r.indexdef)?.[1] ?? r.indexdef,
        ]),
      ),
    ).toEqual(expected);
    // A partial index is exactly what a report could not use (a definition filter cannot state `is null`).
    expect(rows.filter((r) => r.indexdef.includes(" WHERE ")).map((r) => r.indexname)).toEqual([]);
    const sql = repoFile("packages/db/migrations/0077_add_report_filter_indexes.sql");
    for (const report of [
      "accounting.document_register",
      "accounting.document_event_log",
      "accounting.audit_log",
      "inventory.movement_register",
      "inventory.stock_ageing",
      "inventory.stock_on_hand",
      "inventory.valuation",
      "inventory.expiry_list",
      "inventory.price_list",
      "accounting.party_statement",
      "accounting.allocation_register",
      "accounting.tax_return_view",
      "pos.sales_by_branch",
      "pos.sales_by_cashier",
      "pos.z_report",
      "pos.needs_attention",
    ]) {
      expect(sql, "0077 must say which report needed each index").toContain(report);
    }
  },
);
