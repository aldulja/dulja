import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DATASETS,
  DATASET_IDS,
  datasetFor,
  isDatasetId,
  type DatasetId,
} from "../../src/reports/datasets";
import { MAX_DATASET_ROWS, type DatasetParams } from "../../src/reports/query";
import { ReportError } from "../../src/reports/errors";
import { rebuildPartyAgeing } from "../../src/ar-ap/ageing";
import { rebuildStockValuation } from "../../src/costing/valuation";
// The one shared "post a real balanced journal" helper (§4.17.1, 1B). Reachable from `packages/db/test/**`
// through 3B's amendment A21(c) — the third named `dependency-rule` allowance plus the `packages/db`
// tsconfig `include` (3b:3333). Four dots: this file is packages/db/test/reports/, the target is repo-root
// tests/. `JournalLine` names the account field `account`, not `accountId`.
import { postJournal, type JournalLine } from "../../../../tests/invariants/support/post-journal";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import {
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedLot,
  seedParty,
  seedPaymentTerm,
  seedPriceList,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DATASET_FILES = ["accounting.ts", "ar-ap.ts", "inventory.ts", "pos.ts", "hr.ts"];

describe("the DatasetId registry — contracts §4.16.2", () => {
  // Twenty-five 7A members, not §4.16.2's twenty-six: `pdc` is dropped with 4B's table because migration 0051
  // is reserved and unused (OD-09 not built) — the plan's one stated branch (7A execution handoff). 7C appends
  // its three Phase 6 members in the commit that adds them (§3.7.3; contracts round 15, A1 and A16 item 1), so
  // 7A's twenty-five keep their order and the register is twenty-eight.
  it("holds exactly the thirty-four members (7A's twenty-five + 7C's three + 8D's six), in registry order", () => {
    expect([...DATASET_IDS]).toEqual([
      "ledger_entry",
      "account_balance",
      "account",
      "document",
      "document_line",
      "document_event",
      "audit_log",
      "party",
      "party_ageing",
      "allocation",
      "payment_term",
      "bank_statement_line",
      "bank_match",
      "item",
      "lot",
      "warehouse",
      "price_list_line",
      "promotion",
      "inventory_movement",
      "stock_on_hand",
      "cost_layer",
      "cost_consumption",
      "stock_valuation",
      "item_profitability",
      "tax_transaction",
      // 7C, §4.16.2 — the three Phase 6 members 7A could not ship (migrations 0060 and 0070).
      "shift",
      "till_event",
      "needs_attention",
      // 8D, §4.16.2 — five appended in 8D Task 2 (contracts round 19) and `leave_record` in Task 8 (⚠️ OD-13
      // answered build, round 19 A14).
      "employee",
      "attendance_event",
      "payroll_line",
      "employee_ytd",
      "statutory_schedule",
      "leave_record",
    ]);
    expect(Object.keys(DATASETS)).toEqual([...DATASET_IDS]);
    expect(isDatasetId("pdc")).toBe(false);
  });

  it("every member's id matches its registry key and declares at least one unique column", () => {
    for (const id of DATASET_IDS) {
      expect(DATASETS[id].id, id).toBe(id);
      const fields = DATASETS[id].columns.map((c) => c.field);
      expect(fields.length, id).toBeGreaterThan(0);
      expect(new Set(fields).size, id).toBe(fields.length);
    }
  });

  it("an unknown id is ERR_REPORT_DATASET_UNKNOWN, naming the id (§4.2.4)", () => {
    expect(isDatasetId("invoices")).toBe(false);
    expect(isDatasetId("constructor")).toBe(false);
    try {
      datasetFor("invoices");
      expect.unreachable("an unknown dataset must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      expect((e as ReportError).code).toBe("ERR_REPORT_DATASET_UNKNOWN");
      expect((e as ReportError).detail).toContain("'invoices'");
    }
  });

  it("no dataset file contains a template-literal or concatenated identifier (test 27, SAH-069)", () => {
    // The whole point of `ref: (tx) => tx`l.account_id`` is that no identifier can come from data. A `${` inside
    // a SQL-looking template that is NOT a bound value would defeat it, so the shape is asserted mechanically:
    // every `${…}` in these files interpolates either a fragment-returning call or a bound parameter name.
    for (const file of DATASET_FILES) {
      const text = readFileSync(
        fileURLToPath(new URL(`../../src/reports/datasets/${file}`, import.meta.url)),
        "utf8",
      );
      expect(text, file).not.toMatch(/\$\{\s*(?:[a-zA-Z_$][\w$]*\s*\+|['"`])/); // no concatenation, no literal splice
      expect(text, file).not.toMatch(/\.unsafe\s*\(/); // §3.3: three homes, none here
      expect(text, file).not.toMatch(/\bsql`/); // only a `tx` may tag SQL (§3.7.5)
      // The only interpolation a dataset file makes is the company id, bound as a parameter.
      for (const m of text.matchAll(/\$\{([^}]*)\}/g)) expect(m[1], file).toBe("companyId");
    }
  });
});

describe("the accounting datasets", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let cashId: string;
  let salesId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "datasets-a");
    b = await seedTenantV2(db, "datasets-b");
    await grantCodes(db, a, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    await grantCodes(db, b, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    cashId = await seedAccount(db, a, { code: "1000", nameEn: "Cash", type: "asset" });
    salesId = await seedAccount(db, a, { code: "4000", nameEn: "Sales", type: "income" });
    // `postJournal` drafts the JOURNAL and posts it through the REAL `postDocument` (§4.3.1) — from 1A
    // onward the only way a test creates ledger rows (§4.17.1). Its defaults are this fixture's: effective
    // date 2026-01-15 in `s.period`, currency MYR at rate 1, actor `s.human`. Nothing here writes
    // `ledger_entry` or `account_balance`, which `posting-only-tables` and spec:98 both require.
    const post = (s: Seed, lines: JournalLine[]) => postJournal(db, s, lines);
    await post(a, [
      { account: cashId, debit: "120.0000" },
      { account: salesId, credit: "120.0000" },
    ]);
    await post(b, [
      {
        account: await seedAccount(db, b, { code: "1000", nameEn: "Cash", type: "asset" }),
        debit: "9.0000",
      },
      {
        account: await seedAccount(db, b, { code: "4000", nameEn: "Sales", type: "income" }),
        credit: "9.0000",
      },
    ]);
  });
  afterAll(async () => {
    await db.stop();
  });

  const run = (s: Seed, id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, {
        companyId: s.company,
        filters: [],
        sort: [],
        limit: 100,
        offset: 0,
        ...params,
      }),
    );

  it("ledger_entry returns the posted lines with every amount as a string and every date as YYYY-MM-DD", async () => {
    const rows = await run(a, "ledger_entry");
    expect(rows).toHaveLength(2);
    const cash = rows.find((r) => r["account_code"] === "1000")!;
    expect(cash["base_debit"]).toBe("120.0000");
    expect(typeof cash["base_debit"]).toBe("string");
    expect(cash["effective_date"]).toBe("2026-01-15");
    expect(cash["document_type_code"]).toBe("JOURNAL");
    expect(cash["account_type"]).toBe("asset");
    expect(cash["fiscal_period_code"]).toBe("2026-01");
    expect(cash["branch_code"]).toBe("HQ");
    expect(typeof cash["number"]).toBe("number");
    expect(cash["posted_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Every row carries exactly the declared fields, so a definition's `field` lookup and the row agree.
    expect(Object.keys(cash).toSorted()).toEqual(
      datasetFor("ledger_entry")
        .columns.map((c) => c.field)
        .toSorted(),
    );
  });

  it("account_balance returns the synchronous projection, never a re-aggregation", async () => {
    const rows = await run(a, "account_balance", { sort: [{ field: "account_code", dir: "asc" }] });
    expect(rows.map((r) => [r["account_code"], r["base_debit"], r["base_credit"]])).toEqual([
      ["1000", "120.0000", "0.0000"],
      ["4000", "0.0000", "120.0000"],
    ]);
    expect(rows[1]!["base_balance"]).toBe("-120.0000");
  });

  it("filters bind values as parameters and refuse an undeclared field", async () => {
    const only = await run(a, "ledger_entry", {
      filters: [{ field: "account_id", op: "eq", value: cashId }],
    });
    expect(only).toHaveLength(1);
    expect(only[0]!["account_code"]).toBe("1000");

    const both = await run(a, "ledger_entry", {
      filters: [{ field: "account_id", op: "in", value: [cashId, salesId] }],
    });
    expect(both).toHaveLength(2);

    const range = await run(a, "ledger_entry", {
      filters: [{ field: "effective_date", op: "gte", value: "2026-01-16" }],
    });
    expect(range).toEqual([]);

    const period = await run(a, "ledger_entry", {
      filters: [{ field: "fiscal_period_code", op: "eq", value: "2026-01" }],
    });
    expect(period).toHaveLength(2);

    await expect(
      run(a, "ledger_entry", { filters: [{ field: "secret", op: "eq", value: "x" }] }),
    ).rejects.toThrowError(/filter field 'secret' is not a column of dataset 'ledger_entry'/);
  });

  it("refuses a malformed value in TypeScript, before Postgres sees it", async () => {
    await expect(
      run(a, "ledger_entry", { filters: [{ field: "account_id", op: "eq", value: "not-a-uuid" }] }),
    ).rejects.toThrowError(/value 'not-a-uuid' is not a uuid \(field 'account_id'\)/);
    await expect(
      run(a, "ledger_entry", {
        filters: [{ field: "effective_date", op: "eq", value: "15/01/2026" }],
      }),
    ).rejects.toThrowError(/value '15\/01\/2026' is not a date \(field 'effective_date'\)/);
    await expect(
      run(a, "ledger_entry", { filters: [{ field: "account_id", op: "eq", value: [cashId] }] }),
    ).rejects.toThrowError(/takes one value, not a list/);
    await expect(
      run(a, "ledger_entry", { filters: [{ field: "account_id", op: "in", value: [] }] }),
    ).rejects.toThrowError(/has no values/);
    await expect(
      run(a, "ledger_entry", {
        // A ReportFilterOp the closed vocabulary does not hold is refused before any SQL is composed.
        filters: [{ field: "account_id", op: "matches" as never, value: cashId }],
      }),
    ).rejects.toThrowError(/filter operator 'matches' is not one of/);
    await expect(run(a, "ledger_entry", { companyId: "x" })).rejects.toBeInstanceOf(ReportError);
  });

  it("like is a prefix match and never a pattern (SAH-069's locale-fragile interpolation)", async () => {
    const hit = await run(a, "account", {
      filters: [{ field: "name_en", op: "like", value: "Ca" }],
    });
    expect(hit.map((r) => r["code"])).toEqual(["1000"]);
    const wild = await run(a, "account", {
      filters: [{ field: "name_en", op: "like", value: "%as" }],
    });
    expect(wild).toEqual([]); // the % is escaped, so it matches a literal per-cent sign
    const underscore = await run(a, "account", {
      filters: [{ field: "name_en", op: "like", value: "C_sh" }],
    });
    expect(underscore).toEqual([]); // so is the _
  });

  it("refuses a sort on a column the dataset marks unsortable, and clamps the limit", async () => {
    // A promotion's jsonb definition is shown but neither sortable nor filterable. (`audit_log`'s row images
    // were the first such columns; the Phase 7 review removed them from the dataset altogether.)
    await expect(
      run(a, "promotion", { sort: [{ field: "definition", dir: "asc" }] }),
    ).rejects.toThrowError(/sort field 'definition' is not sortable on dataset 'promotion'/);
    await expect(
      run(a, "promotion", { filters: [{ field: "definition", op: "eq", value: "{}" }] }),
    ).rejects.toThrowError(/filter field 'definition' is not filterable on dataset 'promotion'/);
    await expect(
      run(a, "audit_log", { sort: [{ field: "before", dir: "asc" }] }),
    ).rejects.toThrowError(/before/);
    const rows = await run(a, "ledger_entry", { limit: MAX_DATASET_ROWS + 1 });
    expect(rows).toHaveLength(2); // clamped, not rejected — a definition cannot ask for unbounded rows
    const desc = await run(a, "ledger_entry", { sort: [{ field: "account_code", dir: "desc" }] });
    expect(desc.map((r) => r["account_code"])).toEqual(["4000", "1000"]);
    const paged = await run(a, "ledger_entry", {
      sort: [{ field: "account_code", dir: "asc" }],
      limit: 1,
      offset: 1,
    });
    expect(paged.map((r) => r["account_code"])).toEqual(["4000"]);
  });

  it("every accounting dataset is company-scoped except audit_log, which is tenant-scoped by design", async () => {
    for (const id of [
      "ledger_entry",
      "account_balance",
      "account",
      "document",
      "document_line",
      "document_event",
      "tax_transaction",
    ] as const) {
      const mine = await run(a, id);
      const theirs = await run(b, id);
      // Cross-tenant invisibility comes from RLS; the company predicate is the second, narrower gate.
      const otherCompany = await withTenant(db.rw, a.tenant, a.human, (tx) =>
        datasetFor(id).run(tx, {
          companyId: b.company,
          filters: [],
          sort: [],
          limit: 100,
          offset: 0,
        }),
      );
      expect(otherCompany, id).toEqual([]);
      if (id === "ledger_entry") {
        expect(mine.length).toBe(2);
        expect(theirs.length).toBe(2);
        expect(theirs.map((r) => r["base_debit"]).toSorted()).toEqual(["0.0000", "9.0000"]);
      }
    }
    // app.audit_log has no company_id (plan0A:1920) — the accounting.audit_log report is the `auditor` view of
    // the whole tenant (spec:2163), gated by admin.audit_log.read, so the dataset declares company: null.
    const audit = await run(a, "audit_log", {
      filters: [{ field: "table_name", op: "eq", value: "account" }],
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!["table_name"]).toBe("account");
    const otherTenant = await run(b, "audit_log", {
      filters: [{ field: "row_id", op: "eq", value: cashId }],
    });
    expect(otherTenant).toEqual([]);
  });

  it("document and document_event read the posted JOURNAL and its transitions", async () => {
    const docs = await run(a, "document");
    expect(docs).toHaveLength(1);
    expect(docs[0]!["status"]).toBe("posted");
    expect(docs[0]!["base_total"]).toBe("120.0000");
    const lines = await run(a, "document_line", {
      filters: [{ field: "document_id", op: "eq", value: String(docs[0]!["document_id"]) }],
    });
    expect(lines.map((r) => r["line_no"])).toEqual([1, 2]);
    const events = await run(a, "document_event", {
      filters: [{ field: "to_status", op: "eq", value: "posted" }],
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!["actor_display_name"]).toBe("datasets-a owner");
  });
});

describe("the AR/AP datasets", () => {
  let db: Db;
  let s: Seed;
  let receivableId: string;
  let customerId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "datasets-arap");
    await grantCodes(db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    receivableId = await seedAccount(db, s, {
      code: "1200",
      nameEn: "Trade receivables",
      type: "asset",
    });
    await seedAccount(db, s, { code: "2100", nameEn: "Trade payables", type: "liability" });
    customerId = await seedParty(db, s, {
      kind: "customer",
      code: "C001",
      receivableAccountId: receivableId,
    });
    await seedParty(db, s, { kind: "vendor", code: "V001" });
    await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  });
  afterAll(async () => {
    await db.stop();
  });

  const run = (id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, {
        companyId: s.company,
        filters: [],
        sort: [],
        limit: 100,
        offset: 0,
        ...params,
      }),
    );

  it("party returns the customer with its control accounts resolved to codes", async () => {
    const rows = await run("party", { filters: [{ field: "kind", op: "eq", value: "customer" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["party_id"]).toBe(customerId);
    expect(rows[0]!["code"]).toBe("C001");
    expect(rows[0]!["receivable_account_code"]).toBe("1200");
    expect(rows[0]!["payable_account_code"]).toBe("2100");
    expect(rows[0]!["credit_hold"]).toBe(false);
    expect(rows[0]!["archived_at"]).toBeNull();
    expect((await run("party")).map((r) => r["code"])).toEqual(["C001", "V001"]);
  });

  it("payment_term returns due_days as an integer, not a string", async () => {
    const rows = await run("payment_term");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["code"]).toBe("NET30");
    expect(rows[0]!["due_days"]).toBe(30);
    expect(
      await run("payment_term", { filters: [{ field: "due_days", op: "gt", value: "30" }] }),
    ).toEqual([]);
  });

  it("party_ageing, allocation, bank_statement_line and bank_match are empty but queryable", async () => {
    for (const id of ["party_ageing", "allocation", "bank_statement_line", "bank_match"] as const) {
      expect(await run(id), id).toEqual([]);
    }
  });

  it("party_ageing accepts a bucket filter over its closed vocabulary", async () => {
    expect(
      await run("party_ageing", {
        filters: [{ field: "bucket", op: "in", value: ["current", "1_30"] }],
      }),
    ).toEqual([]);
  });

  it("bank_statement_line exposes the unreconciled predicate as a filterable column", async () => {
    expect(
      await run("bank_statement_line", {
        filters: [{ field: "is_matched", op: "eq", value: "false" }],
      }),
    ).toEqual([]);
    await expect(
      run("bank_statement_line", { filters: [{ field: "is_matched", op: "eq", value: "no" }] }),
    ).rejects.toThrowError(/value 'no' is not a boolean \(field 'is_matched'\)/);
  });

  it("every party-keyed AR/AP dataset declares party_id, so the statement reports can group by party", () => {
    for (const id of ["party", "party_ageing", "allocation"]) {
      const fields = datasetFor(id).columns.map((c) => c.field);
      expect(fields, id).toContain("party_id");
    }
  });

  // OD-09 = not built: migration 0051 is absent, so `pdc` is dropped with its table (§4.16.2).
  it("pdc is not a member — the post-dated cheque table was never created", () => {
    expect(() => datasetFor("pdc")).toThrowError(ReportError);
  });
});

describe("the AR/AP datasets over posted documents", () => {
  let db: Db;
  let s: Seed;
  let f: ArApFixture;
  let invoiceId: string;
  let receiptId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "datasets-arap-posted");
    f = await arApFixture(db, s);
    const line = (code: string, amount: string) => ({
      kind: "account" as const,
      accountId: f.accountIds[code]!,
      amount,
    });
    // 4A's REAL pack envelopes: an invoice due 2026-04-02 on the fixture's 30-day term, and a receipt that
    // settles 250 of its 400, so the ageing as of 2026-04-30 is 150 in 1_30.
    ({ documentId: invoiceId } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-03-03",
      partyId: f.partyIds.customer,
      lines: [line("4000", "400.0000")],
    }));
    ({ documentId: receiptId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-25",
      partyId: f.partyIds.customer,
      lines: [line("1100", "250.0000")],
      allocate: [{ settledDocumentId: invoiceId, amount: Money.of("250.0000", currency("MYR")) }],
    }));
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
  }, 300_000);
  afterAll(async () => {
    await db?.stop();
  });

  const run = (id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, {
        companyId: s.company,
        filters: [],
        sort: [],
        limit: 100,
        offset: 0,
        ...params,
      }),
    );

  it("allocation names both documents by type and number, with the amounts as strings", async () => {
    const rows = await run("allocation");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      party_id: f.partyIds.customer,
      party_code: "CUST-1",
      settlement_document_id: receiptId,
      settlement_type_code: "RECEIPT",
      settled_document_id: invoiceId,
      settled_type_code: "SALES_INVOICE",
      settled_effective_date: "2026-03-03",
      effective_date: "2026-04-25",
      amount: "250.0000",
      base_amount: "250.0000",
      unallocated_at: null,
    });
    expect(typeof rows[0]!["settled_number"]).toBe("number");
  });

  it("party_ageing reads the snapshot rebuildPartyAgeing wrote, in bucket order", async () => {
    const rows = await run("party_ageing", {
      filters: [{ field: "as_of", op: "eq", value: "2026-04-30" }],
    });
    expect(rows.map((r) => [r["party_code"], r["bucket"], r["amount"]])).toEqual([
      ["CUST-1", "1_30", "150.0000"],
    ]);
  });

  it("the document register carries the two posted documents with their ledger totals", async () => {
    const rows = await run("document", {
      filters: [{ field: "party_id", op: "eq", value: f.partyIds.customer }],
      sort: [{ field: "effective_date", dir: "asc" }],
    });
    expect(rows.map((r) => [r["document_type_code"], r["status"], r["base_total"]])).toEqual([
      ["SALES_INVOICE", "posted", "400.0000"],
      ["RECEIPT", "posted", "250.0000"],
    ]);
  });
});

describe("the inventory datasets", () => {
  let db: Db;
  let s: Seed;
  let itemId: string;
  let baseUnitId: string;
  let warehouseId: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "datasets-inv");
    await grantCodes(db, s, { codes: ["inventory.stock.read", "inventory.cost.read"] });
    const item = await seedItem(db, s, { code: "ITEM-1" });
    itemId = item.itemId;
    baseUnitId = item.baseUnitId;
    warehouseId = await seedWarehouse(db, s, { code: "WH-1" });
    lotId = await seedLot(db, s, { itemId, code: "L-1", expiresOn: "2027-06-30" });
    await seedPriceList(db, s, {
      code: "PL-1",
      lines: [{ itemId, unitId: baseUnitId, unitPrice: "12.5000" }],
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  const run = (id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, {
        companyId: s.company,
        filters: [],
        sort: [],
        limit: 100,
        offset: 0,
        ...params,
      }),
    );

  it("item returns the master row with its four account columns", async () => {
    const rows = await run("item", { filters: [{ field: "code", op: "eq", value: "ITEM-1" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["kind"]).toBe("product");
    expect(rows[0]!["base_unit_code"]).toBe("PCS");
    expect(rows[0]!["inventory_account_code"]).toBe("1300");
    for (const f of [
      "revenue_account_code",
      "inventory_account_code",
      "cogs_account_code",
      "expense_account_code",
    ]) {
      expect(Object.keys(rows[0]!), f).toContain(f);
    }
  });

  it("lot carries expires_on as YYYY-MM-DD and a days_to_expiry integer for the expiry list", async () => {
    const rows = await run("lot", { filters: [{ field: "item_id", op: "eq", value: itemId }] });
    const dated = rows.find((r) => r["code"] === "L-1")!;
    expect(dated["expires_on"]).toBe("2027-06-30");
    expect(typeof dated["days_to_expiry"]).toBe("number");
    // The dated lot sorts first; the item's sentinel lot (no expiry) last (expires_on asc nulls last).
    expect(rows[0]!["code"]).toBe("L-1");
  });

  it("warehouse exposes kind and branch_id, so a transfer register can group by both", async () => {
    const rows = await run("warehouse", { filters: [{ field: "code", op: "eq", value: "WH-1" }] });
    expect(rows[0]!["kind"]).toBe("stock");
    expect(rows[0]!["branch_id"]).toBe(s.hq);
    expect(rows[0]!["branch_code"]).toBe("HQ");
  });

  it("price_list_line joins its list for the company predicate and keeps the price a string", async () => {
    const rows = await run("price_list_line");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["unit_price"]).toBe("12.5000");
    expect(rows[0]!["price_list_code"]).toBe("PL-1");
    expect(rows[0]!["archived_at"]).toBeNull();
  });

  it("the six movement and cost datasets are queryable and empty before any posting", async () => {
    for (const id of [
      "inventory_movement",
      "stock_on_hand",
      "cost_layer",
      "cost_consumption",
      "stock_valuation",
      "item_profitability",
      "promotion",
    ] as const) {
      expect(await run(id), id).toEqual([]);
    }
  });

  it("cost_layer exposes unit_cost and qty_remaining and computes NO cost of its own (SAH-055)", () => {
    const fields = datasetFor("cost_layer").columns.map((c) => c.field);
    expect(fields).toEqual(
      expect.arrayContaining(["unit_cost", "qty_in", "qty_remaining", "effective_at", "sequence"]),
    );
    const text = readFileSync(
      fileURLToPath(new URL("../../src/reports/datasets/inventory.ts", import.meta.url)),
      "utf8",
    );
    // A division inside a cost dataset would be a recomputed unit cost — the defect SAH-055 and spec:1228 forbid.
    expect(text).not.toMatch(/\bvalue\s*\/\s*quantity\b/);
    expect(text).not.toMatch(/\bsum\(\s*\w+\.value\s*\)\s*\/\s*/);
    expect(text).not.toMatch(/\w+\.(?:value|qty_in|quantity)\s*\/\s*/);
  });

  it("stock_valuation and item_profitability are read, never re-derived (spec:1204)", () => {
    expect(datasetFor("stock_valuation").columns.map((c) => c.field)).toEqual(
      expect.arrayContaining(["as_of", "quantity", "value"]),
    );
    expect(datasetFor("item_profitability").columns.map((c) => c.field)).toEqual(
      expect.arrayContaining(["revenue_base", "cogs_base", "margin_base", "quantity_sold"]),
    );
  });

  // Runs last in this describe: it posts, so the "empty before any posting" case above must already have run.
  it("a posted receipt and issue reach the movement, stock, layer, consumption and valuation datasets", async () => {
    const receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const post = (documentTypeId: string, quantity: string, effectiveDate: string) =>
      postInventoryDocument(db, s, {
        documentTypeId,
        warehouseId,
        effectiveDate,
        jobs: recordingJobs(),
        lines: [{ itemId, warehouseId, lotId, quantity, unitPrice: "2.5000" }],
      });
    const receipt = await post(receiptType, "10.000000", "2026-01-10");
    await post(issueType, "4.000000", "2026-01-12");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildStockValuation(tx, { companyId: s.company, asOf: "2026-01-31" }),
    );

    const movements = await run("inventory_movement", {
      filters: [{ field: "item_id", op: "eq", value: itemId }],
    });
    expect(
      movements.map((r) => [r["document_type_code"], r["quantity"], r["effective_date"]]),
    ).toEqual([
      ["STOCK_RECEIPT_TEST", "10.000000", "2026-01-10"],
      ["STOCK_ISSUE_TEST", "-4.000000", "2026-01-12"],
    ]);
    expect(movements[0]!["document_id"]).toBe(receipt.documentId);
    expect(movements[0]!["warehouse_code"]).toBe("WH-1");

    const onHand = await run("stock_on_hand");
    expect(
      onHand.map((r) => [r["item_code"], r["warehouse_code"], r["lot_code"], r["quantity"]]),
    ).toEqual([["ITEM-1", "WH-1", "L-1", "6.000000"]]);

    const layers = await run("cost_layer");
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      qty_in: "10.000000",
      qty_remaining: "6.000000",
      value: "25.0000",
      effective_at: "2026-01-10",
      invalidated_at: null,
    });
    expect(typeof layers[0]!["age_days"]).toBe("number");

    const consumed = await run("cost_consumption");
    expect(consumed.map((r) => [r["quantity"], r["value"]])).toEqual([["4.000000", "10.0000"]]);

    const valuation = await run("stock_valuation", {
      filters: [{ field: "as_of", op: "eq", value: "2026-01-31" }],
    });
    expect(valuation.map((r) => [r["item_code"], r["quantity"], r["value"]])).toEqual([
      ["ITEM-1", "6.000000", "15.0000"],
    ]);
  });
});
