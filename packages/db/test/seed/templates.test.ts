import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTemplateSource } from "@dulja/domain";
import { SUB_PACKS } from "../../src/seed";
import { assertPackShape } from "../../src/seed/packs";
import { templateFileNames, templatesLoader } from "../../src/seed/templates";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const PACK_ROOT = fileURLToPath(new URL("../../seed/my", import.meta.url));

describe("the templates sub-pack loader — contracts §3.4.8, §4.2.13, §4.5.9", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  const ctx = () => ({
    config: {} as never,
    tenantId: a.tenant,
    companyId: a.company,
    systemPrincipalId: a.system,
    packRoot: PACK_ROOT,
  });

  it("SUB_PACKS carries document-types and templates in application order", () => {
    expect(SUB_PACKS).toEqual([
      "roles",
      "dimensions",
      "fiscal-periods",
      "chart-of-accounts",
      "document-types",
      "templates",
      "tax",
      "reports",
      "statutory",
    ]);
  });

  it("assertPackShape now accepts the shipped pack, which contains templates/", () => {
    expect(() => assertPackShape(PACK_ROOT)).not.toThrow();
  });

  it("derives both file names from the manifest fields", () => {
    expect(
      templateFileNames({
        documentType: "JOURNAL",
        code: "standard",
        version: 1,
        engine: "chromium",
      }),
    ).toEqual({ manifest: "JOURNAL.standard.v1.json", body: "JOURNAL.standard.v1.html" });
  });

  it("loads JOURNAL.standard.v1 into app.print_template with the front matter composed into source", async () => {
    const loaded = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      templatesLoader.load(tx, ctx()),
    );
    expect(loaded).toBe(1); // ONE ROW INSERTED (§4.2.13), not one file seen

    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<
        {
          code: string;
          version: number;
          name_en: string;
          name_ar: string;
          engine: string;
          paper: string;
          source: string;
        }[]
      >`select code, version, name_en, name_ar, engine, paper, source from app.print_template
          where document_type_id = ${a.docType}`,
    );
    expect(row).toMatchObject({
      code: "standard",
      version: 1,
      name_en: "Journal Voucher",
      engine: "chromium",
      paper: "A4",
    });
    expect(row!.name_ar).not.toBeNull();

    const parsed = parseTemplateSource(row!.source);
    expect(Object.keys(parsed.meta.labels.en).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.meta.labels.ar).length).toBe(
      Object.keys(parsed.meta.labels.en).length,
    );
    expect(parsed.body).toContain("{{#each lines}}");
  });

  it("is idempotent — a second run inserts nothing and changes nothing (§3.4.8 `do nothing`)", async () => {
    const before = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.print_template`,
    );
    const loaded = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      templatesLoader.load(tx, ctx()),
    );
    const after = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.print_template`,
    );
    // ZERO rows inserted on a re-run — `PackLoader.load` returns rows inserted, and that number is what
    // "changes nothing" means to the CLI's `SeedResult` (§4.2.13).
    expect(loaded).toBe(0);
    expect(after[0]!.n).toBe(before[0]!.n); // rows unchanged — a body change ships as a new version
  });

  it("raises SeedError, not a bare ENOENT, when the pack has no templates directory", async () => {
    const empty = fileURLToPath(new URL("./fixtures/no-templates", import.meta.url));
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) =>
        templatesLoader.load(tx, { ...ctx(), packRoot: empty }),
      ),
    ).rejects.toThrow(/no-templates[\\/]templates is not a readable directory/);
  });

  it("names the file when a manifest references a document type the tenant does not have", async () => {
    const badPack = fileURLToPath(new URL("./fixtures/bad-templates", import.meta.url));
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) =>
        templatesLoader.load(tx, { ...ctx(), packRoot: badPack }),
      ),
    ).rejects.toThrow(/NOSUCH\.standard\.v1\.json.*document type NOSUCH/s);
  });
});
