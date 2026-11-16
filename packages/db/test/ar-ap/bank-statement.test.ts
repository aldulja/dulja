import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  importStatement,
  lintSchema,
  listApplied,
  listStatementLines,
  listStatements,
  parseDelimited,
  withTenant as prodWithTenant,
  type CsvMapping,
} from "../../src";
import { seedAccount, seedCurrency, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * 4B Task 6 — migration 0049 and the import half of `reconciliation.ts` (contracts §4.8.3, ADR 0048).
 *
 * The plan's fixture is Task 3's `arApFixture`; Task 3 has not run on this branch, so the one account
 * this suite needs — `1100` Bank, 0C's code — is seeded here with 1A's `seedAccount`, which is what
 * `arApFixture`'s `ACCOUNTS` list does for it.
 */
const CSV = [
  "Date,Narrative,Ref,Debit,Credit",
  "05/01/2026,TRANSFER FROM CUST-1,RCT-1,,1000.00",
  '08/01/2026,"PAYMENT, VEND-1",PAY-1,750.00,',
  "12/01/2026,BANK CHARGE,FEE,25.00,",
].join("\r\n");

const MAPPING: CsvMapping = {
  statement: { statementDate: "2026-01-31", openingBalance: "0.0000", closingBalance: "225.0000" },
  columns: {
    valueDate: "Date",
    description: "Narrative",
    reference: "Ref",
    debit: "Debit",
    credit: "Credit",
  },
  dateFormat: "DD/MM/YYYY",
  hasHeader: true,
};

let db: Db;
let s: Seed;
let other: Seed;
let bank: string;
let ctx: { tenantId: string; actorId: string; requestId: string };

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "bankstmt");
  other = await seedTenantV2(db, "bankstmt-other");
  bank = await seedAccount(db, s, { code: "1100", nameEn: "Bank", type: "asset" });
  ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
}, 240_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0049 — bank_statement and bank_statement_line (§4.8.3)", () => {
  it("applies as version 49", async () => {
    expect(await listApplied(db.migrator)).toContain(49);
  });

  it("both tables carry the §3.3 binding form, an audit trigger and an id", async () => {
    for (const table of ["bank_statement", "bank_statement_line"]) {
      const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`app.${table}`}::regclass`;
      expect(rel, table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await db.admin<{ policyname: string }[]>`
        select policyname from pg_policies where schemaname = 'app' and tablename = ${table}`;
      expect(
        policies.map((p) => p.policyname),
        table,
      ).toEqual(["tenant_isolation"]);
      const triggers = await db.admin<{ tgname: string }[]>`
        select tgname from pg_trigger where tgrelid = ${`app.${table}`}::regclass and not tgisinternal
         order by tgname`;
      expect(
        triggers.map((t) => t.tgname),
        table,
      ).toContain("audit_row");
    }
  });

  it("imported_by is stamped, so a supplied value cannot win (SAH-044)", async () => {
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.bank_statement'::regclass and not tgisinternal`;
    expect(triggers.map((t) => t.tgname)).toContain("stamp_imported_by");
  });

  it("app_rw may not DELETE either table — §3.5.4's pinned list is unchanged (spec:2049)", async () => {
    const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('bank_statement', 'bank_statement_line')`;
    expect(grants.filter((g) => g.privilege_type === "DELETE")).toEqual([]);
  });

  it("lintSchema reports zero violations after 0049", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

describe("parseDelimited (ADR 0048)", () => {
  it("handles quoted fields containing the delimiter, escaped quotes and CRLF", () => {
    const rows = parseDelimited('a,"b,c",d\r\n1,"he said ""hi""",3\r\n');
    expect(rows).toEqual([
      ["a", "b,c", "d"],
      ["1", 'he said "hi"', "3"],
    ]);
  });

  it("drops a trailing empty line rather than yielding a row of one empty field", () => {
    expect(parseDelimited("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("respects a semicolon delimiter", () => {
    expect(parseDelimited("a;b\n1;2", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("importStatement (§4.8.3, ADR 0048)", () => {
  it("imports the three lines, converts DD/MM/YYYY, and signs debit as money OUT", async () => {
    const { statementId, lines } = await prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, {
        companyId: s.company,
        bankAccountId: bank,
        csv: CSV,
        mapping: MAPPING,
      }),
    );
    expect(lines).toBe(3);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, limit: 50 }),
    );
    expect(rows.map((r) => [r.lineNo, r.valueDate, r.amount])).toEqual([
      [1, "2026-01-05", "1000.0000"],
      [2, "2026-01-08", "-750.0000"],
      [3, "2026-01-12", "-25.0000"],
    ]);
    expect(rows[1]!.description).toBe("PAYMENT, VEND-1");
    expect(rows[1]!.reference).toBe("PAY-1");
    expect(rows.every((r) => r.matchedAmount === "0.0000")).toBe(true);
  });

  it("stamps imported_by with the actor, and the header figures round-trip at 4 dp", async () => {
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, bankAccountId: bank, limit: 10 }),
    );
    expect(row).toMatchObject({
      bankAccountId: bank,
      statementDate: "2026-01-31",
      openingBalance: "0.0000",
      closingBalance: "225.0000",
      lines: 3,
    });
    const [stamped] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ imported_by: string }[]>`
        select imported_by from app.bank_statement where id = ${row!.id}`,
    );
    expect(stamped!.imported_by).toBe(s.human);
  });

  it("takes the currency from the ACCOUNT, never from the caller", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, limit: 10 }),
    );
    const [company] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ base_currency: string }[]>`
      select base_currency from app.company where id = ${s.company}`,
    );
    expect(rows[0]!.currency).toBe(company!.base_currency);

    // An account denominated in another currency: the statement is in the ACCOUNT's currency.
    await seedCurrency(db, s, { code: "USD" });
    const usdBank = await seedAccount(db, s, {
      code: "1110",
      nameEn: "Bank USD",
      type: "asset",
      currency: "USD",
    });
    await prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, {
        companyId: s.company,
        bankAccountId: usdBank,
        csv: CSV,
        mapping: MAPPING,
      }),
    );
    const [usd] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, bankAccountId: usdBank, limit: 10 }),
    );
    expect(usd!.currency).toBe("USD");
  });

  it("refuses a statement that does not add up, naming the difference (SAH-011's discipline)", async () => {
    const bad: CsvMapping = {
      ...MAPPING,
      statement: { ...MAPPING.statement, closingBalance: "300.0000", statementDate: "2026-02-28" },
    };
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, {
          companyId: s.company,
          bankAccountId: bank,
          csv: CSV,
          mapping: bad,
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*225\.0000.*300\.0000/);
  });

  it("refuses a second statement for the same account and date (unique (company, account, date))", async () => {
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, {
          companyId: s.company,
          bankAccountId: bank,
          csv: CSV,
          mapping: MAPPING,
        }),
      ),
    ).rejects.toThrow(/ERR_CONFLICT_UNIQUE|duplicate key/);
  });

  it("refuses a mapping that names neither `amount` nor the debit/credit pair", async () => {
    const bad = { ...MAPPING, columns: { valueDate: "Date", description: "Narrative" } } as never;
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, {
          companyId: s.company,
          bankAccountId: bank,
          csv: CSV,
          mapping: bad,
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*amount.*debit.*credit/);
  });

  it("refuses a zero-amount line rather than storing a fact that means nothing", async () => {
    const csv = ["Date,Narrative,Ref,Debit,Credit", "05/01/2026,NIL,X,0.00,0.00"].join("\n");
    const mapping: CsvMapping = {
      ...MAPPING,
      statement: {
        statementDate: "2026-03-31",
        openingBalance: "0.0000",
        closingBalance: "0.0000",
      },
    };
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, { companyId: s.company, bankAccountId: bank, csv, mapping }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*line 1.*zero/);
  });

  it("refuses an impossible date and an amount finer than 4 dp, naming the line, instead of storing a rounded figure", async () => {
    const mapping: CsvMapping = {
      ...MAPPING,
      statement: {
        statementDate: "2026-04-30",
        openingBalance: "0.0000",
        closingBalance: "10.0000",
      },
    };
    const importing = (csv: string) =>
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, { companyId: s.company, bankAccountId: bank, csv, mapping }),
      );
    await expect(
      importing(["Date,Narrative,Ref,Debit,Credit", "31/04/2026,X,Y,,10.00"].join("\n")),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*line 1.*31\/04\/2026/);
    await expect(
      importing(["Date,Narrative,Ref,Debit,Credit", "05/04/2026,X,Y,,10.00001"].join("\n")),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*line 1.*10\.00001/);
  });

  it("stores a signed single-column statement with quotes, braces and backslashes verbatim, past a BOM", async () => {
    // A spreadsheet's UTF-8 export leads with a byte-order mark; unstripped, it would make line 1's date
    // unparseable (and hide a header's first column name).
    const csv = [
      '\uFEFF2026-05-02;"ACME ""LTD"" {x}\\y";1.234,50',
      "2026-05-03;REFUND;-234,50",
    ].join("\n");
    const mapping: CsvMapping = {
      statement: {
        statementDate: "2026-05-31",
        openingBalance: "100.0000",
        closingBalance: "1100.0000",
      },
      columns: { valueDate: 0, description: 1, amount: 2 },
      dateFormat: "YYYY-MM-DD",
      hasHeader: false,
      delimiter: ";",
      decimalComma: true,
    };
    const { statementId } = await prodWithTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, { companyId: s.company, bankAccountId: bank, csv, mapping }),
    );
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, limit: 50 }),
    );
    expect(rows.map((r) => [r.description, r.reference, r.amount])).toEqual([
      ['ACME "LTD" {x}\\y', null, "1234.5000"],
      ["REFUND", null, "-234.5000"],
    ]);
  });
});

describe("bank statements are isolated by tenant and bound to their company (spec:106, §3.3)", () => {
  it("a second tenant sees neither table's rows", async () => {
    const seen = await withTenant(db.rw, other.tenant, other.human, async (tx) => ({
      statements: await listStatements(tx, { companyId: s.company, limit: 100 }),
      raw: await tx<{ n: number }[]>`
        select (select count(*)::int from app.bank_statement)
             + (select count(*)::int from app.bank_statement_line) as n`,
    }));
    expect(seen.statements).toEqual([]);
    expect(seen.raw[0]!.n).toBe(0);
  });

  it("a second tenant cannot attach a line to the first tenant's statement", async () => {
    const [statement] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, bankAccountId: bank, limit: 1 }),
    );
    await expect(
      withTenant(
        db.rw,
        other.tenant,
        other.human,
        (tx) => tx`
          insert into app.bank_statement_line
            (tenant_id, company_id, statement_id, line_no, value_date, description, amount)
          values (${other.tenant}, ${other.company}, ${statement!.id}, 99, '2026-01-31', 'forged', 1)`,
      ),
    ).rejects.toThrow(/bank_statement_line_tenant_id_company_id_statement_id_fkey/);
  });

  it("a line cannot name a sibling company's statement, and a statement cannot use its account", async () => {
    const sibling = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.company (id, tenant_id, code, name, base_currency)
        values (${sibling}, ${s.tenant}, 'SIB', 'Sibling', 'MYR')`,
    );
    const [statement] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatements(tx, { companyId: s.company, bankAccountId: bank, limit: 1 }),
    );
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
          insert into app.bank_statement_line
            (tenant_id, company_id, statement_id, line_no, value_date, description, amount)
          values (${s.tenant}, ${sibling}, ${statement!.id}, 99, '2026-01-31', 'forged', 1)`,
      ),
    ).rejects.toThrow(/bank_statement_line_tenant_id_company_id_statement_id_fkey/);
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, {
          companyId: sibling,
          bankAccountId: bank,
          csv: CSV,
          mapping: MAPPING,
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*is not an account of company/);
    const lines = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { companyId: sibling, statementId: statement!.id, limit: 50 }),
    );
    expect(lines).toEqual([]);
  });
});
