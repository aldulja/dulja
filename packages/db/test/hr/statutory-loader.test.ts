import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateTableValidationError } from "@dulja/domain/payroll";
import { loadStatutoryPack } from "../../src/seed/statutory";
import { assertPackShape, type LoaderContext } from "../../src/seed/packs";
import type { SeedConfig } from "../../src/seed/config";
import { seedTenant, SYNTH_RATE_TABLE_V1, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

// `packages/db/test/hr/` → four levels up is the repository root. The root `tests/` workspace's REPO_ROOT is not
// reachable from packages/db (§3.1), so the constant is derived here.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SHIPPED_PACK = join(REPO_ROOT, "packages", "db", "seed", "my");

const tempRoots: string[] = [];

/** A temporary pack root holding one scheme, one component and one rate table. The loader walks `schemes.json`
 *  and enters a directory named by each scheme's CODE, so the scheme row is written as well as the table. */
const tempPack = (definition: unknown = SYNTH_RATE_TABLE_V1): string => {
  const root = mkdtempSync(join(tmpdir(), "dulja-statutory-"));
  tempRoots.push(root);
  mkdirSync(join(root, "statutory", "SYNTH"), { recursive: true });
  writeFileSync(
    join(root, "statutory", "schemes.json"),
    JSON.stringify([{ code: "SYNTH", nameEn: "Synthetic test scheme" }]),
    "utf8",
  );
  writeFileSync(
    join(root, "statutory", "pay-components.json"),
    JSON.stringify([{ code: "BASIC", nameEn: "Basic salary", kind: "earning" }]),
    "utf8",
  );
  writeFileSync(join(root, "statutory", "SYNTH", "v1.json"), JSON.stringify(definition), "utf8");
  return root;
};

/** The loader reads `packRoot`, `tenantId`, `companyId` and `config.appEnv`; the rest of `SeedConfig` is inert. */
const ctxFor = (s: Seed, packRoot: string, appEnv: SeedConfig["appEnv"]): LoaderContext => {
  const config: SeedConfig = {
    tenantId: s.tenant,
    only: ["statutory"],
    packRoot,
    appEnv,
    tenantName: "8A loader test",
    ownerEmail: "loader@dulja.invalid",
    companyCode: "HQ",
    companyName: "8A loader test company",
    baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: 1,
    fiscalYear: 2026,
  };
  return {
    config,
    tenantId: s.tenant,
    companyId: s.company,
    systemPrincipalId: s.system,
    packRoot,
  };
};

describe("the statutory sub-pack loader (§3.4.8, ADR 0073)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-pack-shipped"); // the shipped pack
    b = await seedTenant(db, "8a-pack-temp"); // temporary packs
  }, 180_000);
  afterAll(async () => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    await db.stop();
  });

  const run = (s: Seed, packRoot: string, appEnv: SeedConfig["appEnv"] = "dev"): Promise<number> =>
    withTenant(db.rw, s.tenant, s.system, (tx) =>
      loadStatutoryPack(tx, ctxFor(s, packRoot, appEnv)),
    );
  const count = async (s: Seed, table: string): Promise<string> => {
    const [row] = await withTenant(db.rw, s.tenant, s.system, (tx) =>
      table === "statutory_scheme"
        ? tx<{ n: string }[]>`select count(*)::text as n from app.statutory_scheme`
        : table === "pay_component"
          ? tx<{ n: string }[]>`select count(*)::text as n from app.pay_component`
          : table === "pay_component_scheme"
            ? tx<{ n: string }[]>`select count(*)::text as n from app.pay_component_scheme`
            : tx<{ n: string }[]>`select count(*)::text as n from app.statutory_rate_table`,
    );
    return row!.n;
  };

  it("the shipped pack has the statutory directory assertPackShape now requires", () => {
    expect(() => assertPackShape(SHIPPED_PACK)).not.toThrow();
  });

  it("applies the shipped pack: four schemes and six components, and returns 10", async () => {
    expect(await run(a, SHIPPED_PACK)).toBe(10);
    expect(await count(a, "statutory_scheme")).toBe("4");
    expect(await count(a, "pay_component")).toBe("6");
    // No rate table came with them: the four scheme directories ship empty.
    expect(await count(a, "statutory_rate_table")).toBe("0");
  });

  it("is idempotent on the natural keys — the second run applies zero (§3.4.8)", async () => {
    expect(await run(a, SHIPPED_PACK)).toBe(0);
    expect(await count(a, "statutory_scheme")).toBe("4");
  });

  it("makes NO applicability claim — pay_component_scheme is empty after a fresh seed (spec:2078)", async () => {
    expect(await count(a, "pay_component_scheme")).toBe("0");
  });

  it("loads a rate table from a pack, unverified, stamped with the loading principal", async () => {
    expect(await run(b, tempPack())).toBe(3); // one scheme, one component, one rate table
    const [row] = await withTenant(
      db.rw,
      b.tenant,
      b.system,
      (tx) =>
        tx<
          {
            version: number;
            verified_at: string | null;
            verified_by: string | null;
            loaded_by: string;
            source: string;
          }[]
        >`
        select t.version, t.verified_at, t.verified_by, t.loaded_by, t.source
          from app.statutory_rate_table t
          join app.statutory_scheme s on s.id = t.scheme_id
         where s.company_id = ${b.company} and s.code = 'SYNTH'`,
    );
    expect(row!.version).toBe(1);
    // The seed NEVER verifies: verification is a human act by a DIFFERENT principal (spec:2080, ADR 0073).
    expect(row!.verified_at).toBeNull();
    expect(row!.verified_by).toBeNull();
    expect(row!.loaded_by).toBe(b.system);
    expect(row!.source).toContain("Dulja test fixture");
    // …and a re-run never overwrites it.
    expect(await run(b, tempPack({ ...SYNTH_RATE_TABLE_V1, effective_from: "2026-06-01" }))).toBe(
      0,
    );
  });

  it("refuses a test-fixture authority outside APP_ENV=dev, naming the file (§4.12.4)", async () => {
    for (const appEnv of ["staging", "production"] as const) {
      await expect(run(b, tempPack(), appEnv)).rejects.toThrow(
        /SYNTH\/v1\.json carries source\.authority "Dulja test fixture"; a test fixture may not be seeded outside APP_ENV=dev/,
      );
    }
  });

  it("refuses a file whose declared scheme disagrees with its directory", async () => {
    await expect(run(b, tempPack({ ...SYNTH_RATE_TABLE_V1, scheme: "OTHER" }))).rejects.toThrow(
      'SYNTH/v1.json declares scheme "OTHER"; the directory says "SYNTH"',
    );
  });

  it("refuses a definition with no source, with a JSON Pointer at the root (SAH-078)", async () => {
    const noSource: Record<string, unknown> = { ...SYNTH_RATE_TABLE_V1 };
    delete noSource["source"];
    let caught: unknown;
    try {
      await run(b, tempPack(noSource));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateTableValidationError);
    // Deleting a required root property yields one Ajv error at instancePath "", which `validateRateTable` maps to "/".
    expect((caught as RateTableValidationError).errors[0]!.path).toBe("/");
  });

  it("the shipped pack contains NO rate table — OD-23 has not landed (spec:2080, hazard 1)", () => {
    for (const scheme of ["EPF", "SOCSO", "EIS", "PCB"]) {
      const files = readdirSync(join(SHIPPED_PACK, "statutory", scheme));
      expect(files.filter((f) => f.endsWith(".json"))).toEqual([]);
    }
  });

  it("and neither shipped statutory file carries a rate-table shape or a figure", () => {
    for (const file of ["schemes.json", "pay-components.json"]) {
      const raw = readFileSync(join(SHIPPED_PACK, "statutory", file), "utf8");
      expect(raw).not.toMatch(/employee_rate|employer_rate|bands|brackets|ceiling|\d/);
    }
  });
});
