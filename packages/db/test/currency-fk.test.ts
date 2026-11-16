import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { down, up } from "../src/migrate";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { MIGRATIONS_DIR, startDb, withTenant, type Db } from "./harness";

/**
 * Migration 0008. `app.currency` is where `minor_units`, `pos_rounding_increment` and `rounding_mode` live, so a
 * code with no row behind it is an amount whose rounding is undefined — these keys are what make that unstorable.
 *
 * The two tenants are built with 0008 rolled back, which is how every other fixture builds one: company and
 * document first, currency later or not at all. Rolling 0008 forward over them is the case a database created at
 * 0008 never exercises — that `ADD CONSTRAINT` validates rows that were already in the tables.
 */
describe("migration 0008 — currency codes are foreign keys", () => {
  let db: Db;
  let alpha: Seed;
  let beta: Seed;

  /** Idempotent on purpose: `seedTenant` may define MYR itself, and this suite must hold either way. */
  const defineCurrency = (seed: Seed, code: string) =>
    withTenant(
      db.rw,
      seed.tenant,
      seed.human,
      (tx) => tx`insert into app.currency (tenant_id, code, name_en)
                 values (${seed.tenant}, ${code}, ${code})
                 on conflict (tenant_id, code) do nothing`,
    );

  beforeAll(async () => {
    db = await startDb();
    await down(db.migrator, MIGRATIONS_DIR, 7);
    alpha = await seedTenant(db, "FkAlpha");
    await grantCodes(db, alpha); // 6C: explicit company-wide branch visibility; no permission codes.
    beta = await seedTenant(db, "FkBeta");
    await grantCodes(db, beta); // 6C: explicit company-wide branch visibility; no permission codes.
    await defineCurrency(alpha, "MYR");
    await defineCurrency(beta, "MYR");
    await defineCurrency(alpha, "USD"); // Alpha only — the cross-tenant case below turns on that
    await up(db.migrator, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await db.stop();
  });

  it("points every currency-code column at app.currency, tenant first", async () => {
    // Read the catalogue, not `pg_get_constraintdef`: the printed form omits the schema when `app` happens to be
    // on the search_path, and the thing worth pinning is the column pair anyway. `tenant_id` first is the whole
    // security property — the borrowed-code case below is what it buys.
    const keys = await db.admin<{ conname: string; tbl: string; cols: string[] }[]>`
      select c.conname,
             c.conrelid::regclass::text as tbl,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c
       where c.contype = 'f' and c.confrelid = 'app.currency'::regclass
       order by c.conname`;
    // "Every" is the whole catalogue, not 0008's six: 1A's 0012 added account_balance's key after this case was
    // written, and a later column that referenced app.currency without the tenant would have to show up here.
    expect(keys.map((key) => [key.conname, key.tbl, key.cols])).toEqual([
      ["account_balance_tenant_id_currency_fkey", "app.account_balance", ["tenant_id", "currency"]],
      ["account_currency_fk", "app.account", ["tenant_id", "currency"]],
      ["company_base_currency_fk", "app.company", ["tenant_id", "base_currency"]],
      ["document_currency_fk", "app.document", ["tenant_id", "currency"]],
      ["exchange_rate_from_currency_fk", "app.exchange_rate", ["tenant_id", "from_currency"]],
      ["exchange_rate_to_currency_fk", "app.exchange_rate", ["tenant_id", "to_currency"]],
      ["ledger_entry_currency_fk", "app.ledger_entry", ["tenant_id", "currency"]],
    ]);
    // Seven composite keys are seven chances to have written one the linter's `composite_fk` rule rejects.
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("refuses a company whose base currency the tenant never defined", async () => {
    await expect(
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) => tx`insert into app.company (tenant_id, code, name, base_currency)
                   values (${alpha.tenant}, 'FKBAD', 'Unknown currency', 'XYZ')`,
      ),
    ).rejects.toThrow(/company_base_currency_fk/);

    await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx`insert into app.company (tenant_id, code, name, base_currency)
                 values (${alpha.tenant}, 'FKUSD', 'Known currency', 'USD')`,
    );
  });

  it("refuses an exchange rate on either leg", async () => {
    const rate = (from: string, to: string, on: string) =>
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) => tx`insert into app.exchange_rate
                     (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
                   values (${alpha.tenant}, ${alpha.company}, ${from}, ${to}, 4.2, ${on}, 'fk-test')`,
      );
    await expect(rate("XYZ", "MYR", "2026-01-01")).rejects.toThrow(
      /exchange_rate_from_currency_fk/,
    );
    await expect(rate("USD", "XYZ", "2026-01-01")).rejects.toThrow(/exchange_rate_to_currency_fk/);
    await rate("USD", "MYR", "2026-01-01"); // both legs defined: the row the table exists for
  });

  it("refuses a document in a currency the tenant never defined", async () => {
    await expect(
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) => tx`insert into app.document
                     (tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id,
                      effective_date, currency, branch_id)
                   values (${alpha.tenant}, ${alpha.company}, ${alpha.docType}, ${alpha.policy}, 'JV',
                           ${alpha.period}, '2026-01-15', 'XYZ', ${alpha.hq})`,
      ),
    ).rejects.toThrow(/document_currency_fk/);
  });

  it("refuses a ledger entry in a currency the tenant never defined", async () => {
    const documentId = await draftDocument(db, alpha);
    // rate 1 and base_debit = debit, so `base_debit = round(debit * exchange_rate, 4)` holds: that CHECK is
    // evaluated at row time and would otherwise mask the key, which is an AFTER-statement RI trigger.
    await expect(
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) => tx`insert into app.ledger_entry
                     (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
                      exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
                   values (${alpha.tenant}, ${alpha.company}, ${documentId}, 1, ${alpha.cash}, 100, 0, 'XYZ',
                           1, 100, 0, '2026-01-15', ${alpha.period}, ${alpha.policy})`,
      ),
    ).rejects.toThrow(/ledger_entry_currency_fk/);
  });

  it("refuses an account in an undefined currency and still lets null mean 'the company's own'", async () => {
    const account = (currency: string | null, code: string) =>
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) => tx`insert into app.account (tenant_id, company_id, code, name_en, type, currency)
                   values (${alpha.tenant}, ${alpha.company}, ${code}, 'FK account', 'asset', ${currency})`,
      );
    await expect(account("XYZ", "1901")).rejects.toThrow(/account_currency_fk/);
    await account("USD", "1902");
    // MATCH SIMPLE, not MATCH FULL — and this is the assertion that keeps it that way. Every account the
    // chart-of-accounts pack seeds writes null here (src/seed/chart-of-accounts.ts:75), so a key that refused
    // null would fail `bun run seed` on its first row rather than on some exotic foreign-currency account.
    await account(null, "1903");
  });

  it("accepts a document and a balanced pair of entries in a defined currency", async () => {
    const documentId = await draftDocument(db, alpha);
    await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx`insert into app.ledger_entry
                   (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency,
                    exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id)
                 values (${alpha.tenant}, ${alpha.company}, ${documentId}, 1, ${alpha.cash}, 100, 0, 'USD',
                         1, 100, 0, '2026-01-15', ${alpha.period}, ${alpha.policy}),
                        (${alpha.tenant}, ${alpha.company}, ${documentId}, 2, ${alpha.sales}, 0, 100, 'USD',
                         1, 0, 100, '2026-01-15', ${alpha.period}, ${alpha.policy})`,
    );
    const [row] = await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry where document_id = ${documentId}`,
    );
    expect(row!.n).toBe(2);
  });

  it("will not let a tenant borrow a code only another tenant defined", async () => {
    // USD exists — in Alpha. The key is composite on (tenant_id, code), so for Beta it does not exist at all, and
    // knowing the code buys nothing. A key on the code alone would have accepted this row.
    await expect(
      withTenant(
        db.rw,
        beta.tenant,
        beta.human,
        (tx) => tx`insert into app.company (tenant_id, code, name, base_currency)
                   values (${beta.tenant}, 'FKUSD', 'Borrowed', 'USD')`,
      ),
    ).rejects.toThrow(/company_base_currency_fk/);
  });

  it("keeps a currency that has been posted against — archive it, never delete it", async () => {
    await expect(
      withTenant(
        db.migrator,
        alpha.tenant,
        alpha.system,
        (tx) => tx`delete from app.currency where tenant_id = ${alpha.tenant} and code = 'USD'`,
      ),
    ).rejects.toThrow(/violates foreign key constraint/);

    await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx`update app.currency set archived_at = now()
                 where tenant_id = ${alpha.tenant} and code = 'USD'`,
    );
  });
});
