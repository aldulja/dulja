import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  grantCodes,
  JOURNAL_POLICY_V1,
  seedDocumentType,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { postJournal } from "../../../../../tests/invariants/support/post-journal";
import { startApi, type StartedApi } from "../../support/app";

/**
 * Review finding API-07 (2026-11-15). `GET …/ledger-entries` and the `accounting.ledger` report served an `hr`
 * document's ledger lines — a PAYROLL's per-employee net pay — under `accounting.ledger.read` alone. An `hr`
 * document's rows now need `hr.payroll.read` at the document's branch, the rule the generic document routes,
 * the attachment gate (`MODULE_READ_CODE`) and the export (`MODULE_ROW_GATES`) already apply.
 */
interface LedgerEntry {
  documentId: string;
}
interface LedgerReportRow {
  documentId: string;
  baseDebit: { amount: string };
  baseCredit: { amount: string };
  runningBaseBalance: { amount: string };
}

describe("ledger reads of hr documents need hr.payroll.read (API-07)", () => {
  let api: StartedApi;
  let s: Seed;
  let ledgerReader: string;
  let payrollReader: string;
  let journal: string;
  let payroll: string;

  const principal = async (name: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${id}`}, ${name})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "LedgerHr");
    const ledgerCodes = ["accounting.ledger.read", "accounting.report.read"];
    ledgerReader = await principal("Ledger reader");
    await grantCodes(api.db, s, { codes: ledgerCodes, principalId: ledgerReader });
    payrollReader = await principal("Payroll reader");
    await grantCodes(api.db, s, {
      codes: [...ledgerCodes, "hr.payroll.read"],
      principalId: payrollReader,
    });

    journal = (
      await postJournal(api.db, s, [
        { account: s.cash, debit: "100.0000" },
        { account: s.sales, credit: "100.0000" },
      ])
    ).documentId;
    // The same posting path with an `hr`-module type: `postJournal` drafts against `s.docType`/`s.policy`.
    const hrType = await seedDocumentType(api.db, s, {
      code: "HRJ",
      module: "hr",
      policy: { ...JOURNAL_POLICY_V1, documentType: "HRJ" },
    });
    const [policy] = await api.db.admin<{ id: string }[]>`
      select id from app.posting_policy where document_type_id = ${hrType}`;
    const [docType, docPolicy] = [s.docType, s.policy];
    Object.assign(s, { docType: hrType, policy: policy!.id });
    try {
      payroll = (
        await postJournal(api.db, s, [
          { account: s.sales, debit: "2468.0000" },
          { account: s.cash, credit: "2468.0000" },
        ])
      ).documentId;
    } finally {
      Object.assign(s, { docType, policy: docPolicy });
    }
    await api.loadPrincipals();
  }, 240_000);
  afterAll(async () => api.stop());

  const entries = async (as: string, query = ""): Promise<LedgerEntry[]> => {
    const response = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/ledger-entries?limit=200${query}`,
      as,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: LedgerEntry[] }).items;
  };
  const report = async (as: string): Promise<LedgerReportRow[]> => {
    const response = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/reports/accounting.ledger?accountId=${s.cash}&fromDate=2026-01-01&toDate=2026-01-31&limit=200`,
      as,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: LedgerReportRow[] }).items;
  };

  it("GET …/ledger-entries leaves an hr document's lines out without hr.payroll.read", async () => {
    const seen = new Set((await entries(ledgerReader)).map((row) => row.documentId));
    expect(seen.has(journal)).toBe(true);
    expect(seen.has(payroll)).toBe(false);
    expect(await entries(ledgerReader, `&documentId=${payroll}`)).toEqual([]);

    const all = new Set((await entries(payrollReader)).map((row) => row.documentId));
    expect(all.has(payroll)).toBe(true);
  });

  it("the accounting.ledger report leaves them out too, and its running balance still ties to the ledger", async () => {
    const rows = await report(ledgerReader);
    expect(rows.map((row) => row.documentId)).toContain(journal);
    expect(rows.map((row) => row.documentId)).not.toContain(payroll);
    expect(JSON.stringify(rows)).not.toContain("2468");

    const full = await report(payrollReader);
    expect(full.map((row) => row.documentId)).toContain(payroll);
    // a hidden line is left out, never re-summed: every row a reader sees carries the ledger's own balance.
    const byDocument = new Map(full.map((row) => [row.documentId, row.runningBaseBalance.amount]));
    for (const row of rows) {
      expect(row.runningBaseBalance.amount).toBe(byDocument.get(row.documentId));
    }
  });
});
