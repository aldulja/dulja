import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  lapsingTables,
  listRateTables,
  listSchemes,
  loadRateTable,
  RateTableNotVerifiableError,
  rateTableOn,
  verifyRateTable,
} from "../../src/hr/statutory";
import { setComponentSchemes } from "../../src/hr/compensation";
import {
  grantCodes,
  seedPayComponent,
  seedRateTable,
  seedStatutoryScheme,
  seedTenant,
  SYNTH_RATE_TABLE_V1,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const SOURCE = "Dulja test fixture / synthetic";

describe("migration 0084 — schemes as rows, rate tables as verified data", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let loader: string;
  let verifier: string;
  let schemeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-stat-a");
    b = await seedTenant(db, "8a-stat-b");
    loader = await uuidv7(db.admin);
    verifier = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      for (const [id, n] of [
        [loader, "Loader"],
        [verifier, "Verifier"],
      ] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${id}, ${`sub-${id}`}, 'human', ${n})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, {
      codes: ["hr.statutory_table.manage"],
      principalId: loader,
      roleCode: "t-stat-loader",
    });
    await grantCodes(db, a, {
      codes: ["hr.statutory_table.verify"],
      principalId: verifier,
      roleCode: "t-stat-verifier",
    });
    schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("a scheme is a ROW with a free-text code — a new levy is data, not a migration (spec:2080)", async () => {
    const levy = await seedStatutoryScheme(db, a, { code: "SYNTH_LEVY" });
    const schemes = await withTenant(db.rw, a.tenant, a.human, (tx) => listSchemes(tx, a.company));
    expect(schemes.map((s) => s.code).toSorted()).toEqual(["SYNTH", "SYNTH_LEVY"]);
    expect(levy).toBeTruthy();
    const enums = await db.admin<{ typname: string }[]>`
      select t.typname from pg_type t
       where t.typnamespace = 'app'::regnamespace and t.typtype = 'e' and t.typname like '%scheme%'`;
    expect(enums).toEqual([]);
  });

  it("a scheme code follows the rate-table schema's pattern, so a table's `scheme` can always match it", async () => {
    await expect(seedStatutoryScheme(db, a, { code: "synthetic-test" })).rejects.toThrow(
      /statutory_scheme_code_check/,
    );
  });

  it("payable_account_id and employer_expense_account_id are NULLABLE — 8B seeds them (A2)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_scheme' and column_name like '%account_id'`;
    expect(cols).toHaveLength(2);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
  });

  it("statutory_scheme carries employer_registration (amendment A3)", async () => {
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_scheme' and column_name = 'employer_registration'`;
    expect(col!.data_type).toBe("text");
  });

  it("loaded_by is stamped from the session, never from the caller (LEGACY-044)", async () => {
    const id = await withTenant(db.rw, a.tenant, loader, (tx) =>
      loadRateTable(tx, {
        schemeId,
        version: 1,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        definition: SYNTH_RATE_TABLE_V1,
        source: SOURCE,
      }),
    );
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    expect(row!.id).toBe(id);
    expect(row!.loadedBy).toBe(loader);
    expect(row!.verifiedBy).toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });

  it("test 35: the LOADER cannot verify their own table (ERR_HR_SELF_VERIFY, spec:2080)", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    await expect(
      withTenant(db.rw, a.tenant, loader, (tx) => verifyRateTable(tx, row!.id)),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY/);
  });

  it("a DIFFERENT principal can, and verified_by is stamped to them", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    await withTenant(db.rw, a.tenant, verifier, (tx) => verifyRateTable(tx, row!.id));
    const [after] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    expect(after!.verifiedBy).toBe(verifier);
    expect(after!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("a second verification is refused, not a silent success", async () => {
    const [row] = await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId));
    await expect(
      withTenant(db.rw, a.tenant, verifier, (tx) => verifyRateTable(tx, row!.id)),
    ).rejects.toBeInstanceOf(RateTableNotVerifiableError);
  });

  it("the same refusal holds against DIRECT app_rw SQL — the trigger is the control, not a handler", async () => {
    const id = await withTenant(db.rw, a.tenant, loader, (tx) =>
      loadRateTable(tx, {
        schemeId,
        version: 2,
        effectiveFrom: "2027-01-01",
        effectiveTo: null,
        definition: SYNTH_RATE_TABLE_V1,
        source: SOURCE,
      }),
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        loader,
        (tx) => tx`
        update app.statutory_rate_table set verified_at = now(), verified_by = ${verifier} where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY/);
  });

  it("a table cannot be INSERTED already verified — both stamps would name the same principal", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        loader,
        (tx) => tx`
        insert into app.statutory_rate_table
               (tenant_id, scheme_id, version, effective_from, definition, source, verified_at, verified_by)
        values (${a.tenant}, ${schemeId}, 7, '2030-01-01', ${tx.json(SYNTH_RATE_TABLE_V1 as never)}, ${SOURCE},
                now(), ${verifier})`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY/);
  });

  it("a verified table is frozen — definition, version, effective_from and source cannot change (LEGACY-041)", async () => {
    const [verified] = (
      await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId))
    ).filter((t) => t.verifiedAt !== null);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        verifier,
        (tx) => tx`
        update app.statutory_rate_table set definition = '{"tampered":true}'::jsonb where id = ${verified!.id}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY.*frozen/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        verifier,
        (tx) => tx`
        update app.statutory_rate_table set verified_at = now() - interval '1 day' where id = ${verified!.id}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY.*frozen/);
  });

  it("…but effective_to may still be moved, so a successor can close its predecessor's window", async () => {
    const [verified] = (
      await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId))
    ).filter((t) => t.verifiedAt !== null);
    await withTenant(
      db.rw,
      a.tenant,
      loader,
      (tx) => tx`
      update app.statutory_rate_table set effective_to = '2026-12-31' where id = ${verified!.id}`,
    );
  });

  it("rateTableOn returns only a VERIFIED table covering the date (spec:2080, LEGACY-020)", async () => {
    expect(
      (await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2026-06-30")))!
        .version,
    ).toBe(1);
    // v2 covers 2027 but is unverified
    expect(
      await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2027-06-30")),
    ).toBeNull();
    expect(
      await withTenant(db.rw, a.tenant, loader, (tx) => rateTableOn(tx, schemeId, "2025-01-01")),
    ).toBeNull();
  });

  it("two versions of one scheme cannot share a version number", async () => {
    await expect(
      withTenant(db.rw, a.tenant, loader, (tx) =>
        loadRateTable(tx, {
          schemeId,
          version: 1,
          effectiveFrom: "2028-01-01",
          effectiveTo: null,
          definition: SYNTH_RATE_TABLE_V1,
          source: SOURCE,
        }),
      ),
    ).rejects.toThrow(/statutory_rate_table_scheme_id_version_key|duplicate key/);
  });

  it("lapsingTables finds a table expiring inside the horizon and not one outside it (spec:2109)", async () => {
    const soon = await withTenant(db.rw, a.tenant, loader, (tx) =>
      lapsingTables(tx, "2026-11-15", 60),
    );
    expect(soon.map((t) => t.version)).toEqual([1]); // effective_to 2026-12-31 is 46 days away
    const notYet = await withTenant(db.rw, a.tenant, loader, (tx) =>
      lapsingTables(tx, "2026-06-01", 60),
    );
    expect(notYet).toEqual([]);
    const otherCompany = await withTenant(db.rw, a.tenant, loader, (tx) =>
      lapsingTables(tx, "2026-11-15", 60, { companyId: b.company }),
    );
    expect(otherCompany).toEqual([]);
  });

  it("a verified successor starting the day after silences the warning", async () => {
    const [v2] = (
      await withTenant(db.rw, a.tenant, loader, (tx) => listRateTables(tx, schemeId))
    ).filter((t) => t.version === 2);
    await withTenant(db.rw, a.tenant, verifier, (tx) => verifyRateTable(tx, v2!.id));
    expect(
      await withTenant(db.rw, a.tenant, loader, (tx) => lapsingTables(tx, "2026-11-15", 60)),
    ).toEqual([]);
  });

  it("a component and a scheme of different companies cannot be joined (SQLSTATE 23503)", async () => {
    const otherCompany = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${otherCompany}, ${a.tenant}, 'STAT-OTHER', 'Other company', 'MYR')`;
    });
    const foreign = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.statutory_scheme (id, tenant_id, company_id, code, name_en)
      values (${foreign}, ${a.tenant}, ${otherCompany}, 'SYNTH', 'Other company scheme')`,
    );
    const component = await seedPayComponent(db, a, { code: "BASIC" });
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => setComponentSchemes(tx, component, [foreign])),
    ).rejects.toMatchObject({ code: "23503" });
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setComponentSchemes(tx, component, [schemeId]),
    );
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        setComponentSchemes(tx, component, ["00000000-0000-7000-8000-0000000000ee"]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("no real statutory figure is anywhere in the fixture (hazard 1)", () => {
    expect(SYNTH_RATE_TABLE_V1.scheme).toBe("SYNTH");
    expect(SYNTH_RATE_TABLE_V1.source.authority).toBe("Dulja test fixture");
    expect(SYNTH_RATE_TABLE_V1.verification.method).toBe("synthetic_test");
  });

  it("tenant B sees no scheme and no table of tenant A (test 12)", async () => {
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) => listSchemes(tx, a.company)),
    ).toHaveLength(0);
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) => listRateTables(tx, schemeId)),
    ).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0084", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("seedRateTable's default definition is the synthetic table", async () => {
    const other = await seedStatutoryScheme(db, a, { code: "SYNTH_TWO" });
    const id = await seedRateTable(db, a, { schemeId: other, verified: true });
    const [row] = await withTenant(db.rw, a.tenant, a.human, (tx) => listRateTables(tx, other));
    expect(row!.id).toBe(id);
    expect((row!.definition as { scheme: string }).scheme).toBe("SYNTH");
    expect(row!.verifiedAt).not.toBeNull();
    expect(row!.verifiedBy).toBe(a.system);
  });
});
