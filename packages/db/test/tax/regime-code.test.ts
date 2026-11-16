import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, down, lintSchema, listApplied, up } from "../../src";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedAccount, seedTaxCode, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;
let outAccount: string;
let inpAccount: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "tax-a");
  b = await seedTenantV2(db, "tax-b");
  // `seedTaxCode`'s `kind` defaults to "output" and it resolves `output_account_id` by looking up account
  // code 2300, leaving it null when the account is absent — at which point `tax_code_account_for_kind_check`
  // refuses the insert. Vitest runs `it` blocks in file order, so the two §4.15 accounts are seeded HERE,
  // once, and not inside whichever case happens to be first. `seedTenantV2` creates 1000, 4000 and 5920 and
  // nothing else (§4.1, this plan's header fact 3).
  outAccount = await seedAccount(db, a, {
    code: "2300",
    nameEn: "Output tax payable",
    type: "liability",
  });
  inpAccount = await seedAccount(db, a, {
    code: "1350",
    nameEn: "Input tax receivable",
    type: "asset",
  });
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0053 — tax_regime and tax_code (§4.9.2, SAH-020)", () => {
  it("applies as version 53 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(53);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("tax_regime carries the columns §4.9.2 pins plus A2's source", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string; data_type: string }[]>`
      select column_name, is_nullable, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_regime' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(
      [
        "code",
        "created_at",
        "company_id",
        "effective_from",
        "effective_to",
        "id",
        "jurisdiction",
        "name_ar",
        "name_en",
        "source",
        "tenant_id",
        "version",
      ].toSorted(),
    );
    expect(cols.find((c) => c.column_name === "source")!.is_nullable).toBe("NO");
    expect(cols.find((c) => c.column_name === "jurisdiction")!.data_type).toBe("character");
  });

  it("a code cannot exist without a regime — regime_id is NOT NULL (SAH-020's missing discriminator)", async () => {
    const [c] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_code' and column_name = 'regime_id'`;
    expect(c!.is_nullable).toBe("NO");
  });

  it("the five kinds and the four rounding modes are text + CHECK, not enum labels (§3.4.4)", async () => {
    const rows = await db.admin<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_code'::regclass and contype = 'c' order by conname`;
    const kind = rows.find((r) => r.conname === "tax_code_kind_check")!;
    for (const k of ["output", "input", "exempt", "zero", "out_of_scope"])
      expect(kind.def).toContain(`'${k}'`);
    const mode = rows.find((r) => r.conname === "tax_code_rounding_mode_check")!;
    for (const m of ["HALF_AWAY_FROM_ZERO", "HALF_EVEN", "TOWARD_ZERO", "AWAY_FROM_ZERO"])
      expect(mode.def).toContain(`'${m}'`);
    // No new enum TYPE was created by this migration.
    const enums = await db.admin<{ typname: string }[]>`
      select t.typname from pg_type t where t.typnamespace = 'app'::regnamespace and t.typtype = 'e' order by 1`;
    expect(enums.map((e) => e.typname)).toEqual([
      "account_type",
      "document_status",
      "period_status",
      "principal_kind",
    ]);
  });

  it("a rate is numeric(19,8) and cannot be negative (SAH-019's NULL/overflow class)", async () => {
    const [r] = await db.admin<
      { numeric_precision: number; numeric_scale: number; is_nullable: string }[]
    >`
      select numeric_precision, numeric_scale, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_code' and column_name = 'rate'`;
    expect(r).toMatchObject({ numeric_precision: 19, numeric_scale: 8, is_nullable: "NO" });
    // A distinct `code`, because the SYN- codes below are asserted as an exact list and
    // `unique (company_id, code, effective_from)` would refuse a second row at the default code and date.
    const { regimeId } = await seedTaxCode(db, a, { code: "RATE-CHK" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                effective_from, output_account_id)
      values (${a.tenant}, ${a.company}, ${regimeId}, 'NEG', 'Negative', -0.01, 'output', 'HALF_EVEN', '2026-01-01', ${outAccount})`,
      ),
    ).rejects.toThrow(/tax_code_rate_check/);
  });

  it("seedTaxCode creates the regime once and links the two accounts by id", async () => {
    // The accounts are `beforeAll`'s — `app.account` carries `unique (company_id, code)`, so a second
    // `seedAccount` at the same code would be a conflict rather than a second row.
    const first = await seedTaxCode(db, a, {
      code: "SYN-OUT-STD",
      rate: "0.11000000",
      kind: "output",
    });
    const second = await seedTaxCode(db, a, {
      code: "SYN-IN-STD",
      rate: "0.11000000",
      kind: "input",
    });
    expect(second.regimeId).toBe(first.regimeId); // created on the FIRST call only
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const rows = await tx<
        { code: string; output_account_id: string | null; input_account_id: string | null }[]
      >`
        select code, output_account_id, input_account_id from app.tax_code
         where company_id = ${a.company} and code like 'SYN-%' order by code`;
      expect(rows.map((r) => r.code)).toEqual(["SYN-IN-STD", "SYN-OUT-STD"]);
      expect(rows.find((r) => r.code === "SYN-OUT-STD")!.output_account_id).toBe(outAccount);
      expect(rows.find((r) => r.code === "SYN-IN-STD")!.input_account_id).toBe(inpAccount);
    });
  });

  it("unique (company_id, code, version) on the regime and (company_id, code, effective_from) on the code", async () => {
    const idx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename in ('tax_regime', 'tax_code')
       order by indexname`;
    const all = idx.map((i) => i.indexdef).join("\n");
    expect(all).toMatch(
      /UNIQUE INDEX .* ON app\.tax_regime USING btree \(company_id, code, version\)/,
    );
    expect(all).toMatch(
      /UNIQUE INDEX .* ON app\.tax_code USING btree \(company_id, code, effective_from\)/,
    );
  });

  it("tenant B sees neither of tenant A's rows (spec:106, test 12)", async () => {
    await seedTaxCode(db, a, { code: "ISO-ONLY" });
    const mine = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.tax_code where code = 'ISO-ONLY'`,
    );
    expect(mine[0]!.n).toBe(1);
    const theirs = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.tax_code where code = 'ISO-ONLY'`,
    );
    expect(theirs[0]!.n).toBe(0);
    // …and a cross-tenant INSERT is refused by the WITH CHECK half of tenant_isolation.
    const stolen = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
      insert into app.tax_regime (id, tenant_id, company_id, code, jurisdiction, version, effective_from, name_en, source)
      values (${stolen}, ${a.tenant}, ${a.company}, 'X', 'MY', 1, '2026-01-01', 'X', 'test')`,
      ),
    ).rejects.toThrow();
  });

  it("both tables are audited — §3.5.3 gives neither an AUDIT_EXEMPT row", async () => {
    const trg = await db.admin<{ relname: string; tgname: string }[]>`
      select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'app'::regnamespace and c.relname in ('tax_regime', 'tax_code')
         and t.tgname = 'audit_row'
         and not t.tgisinternal order by 1, 2`;
    expect(trg.map((t) => `${t.relname}.${t.tgname}`)).toEqual([
      "tax_code.audit_row",
      "tax_regime.audit_row",
    ]);
  });

  it("up → down → up is byte-identical through 0053 (§3.4.6)", async () => {
    const before = await (
      await import("../support/schema-fingerprint")
    ).schemaFingerprint(db.admin);
    const applied = await listApplied(db.migrator);
    expect(await down(db.migrator, MIGRATIONS_DIR)).toEqual([...applied].toReversed());
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(applied);
    expect(await (await import("../support/schema-fingerprint")).schemaFingerprint(db.admin)).toBe(
      before,
    );
    expect(discover(MIGRATIONS_DIR).find((m) => m.version === 53)!.name).toBe(
      "create_tax_regime_code",
    );
  });
});
