import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { MALAYSIA_REGIMES } from "@dulja/domain";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  assertPackShape,
  parseSeedArgs,
  PHASE_0_SUB_PACK_DIRECTORIES,
  seed,
  StubSeedAuthAdmin,
  SUB_PACKS,
  taxLoader,
  taxFileNames,
  readPackFile,
  type SeedSkip,
  type TaxRegimeManifest,
  type LoaderContext,
} from "../../src/seed";
import { startDb, withTenant, type Db } from "../harness";
import { seedAccount, seedTenantV2, type Seed } from "../fixtures";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PACK = fileURLToPath(new URL("../../seed/my/", import.meta.url));

let db: Db;
let a: Seed;
const ctx = (over: Partial<LoaderContext> = {}): LoaderContext => ({
  // `appEnv` stated rather than left undefined by the cast: these cases are the dev load.
  config: { tenantId: a.tenant, appEnv: "dev" } as never,
  tenantId: a.tenant,
  companyId: a.company,
  systemPrincipalId: a.system,
  packRoot: PACK,
  ...over,
});

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "taxpack");
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await seedAccount(db, a, { code: "1350", nameEn: "Input tax receivable", type: "asset" });
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("the tax sub-pack and its loader (§3.4.8, §4.2.13, amendment A6)", () => {
  it("SUB_PACKS carries tax LAST, in application order", () => {
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
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toContain("tax");
  });

  it("assertPackShape now admits the tax directory and names the known sub-packs for an unknown one", () => {
    expect(() => assertPackShape(PACK)).not.toThrow();
    const { mkdtempSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const fake = mkdtempSync(join(tmpdir(), "pack-"));
    for (const d of PHASE_0_SUB_PACK_DIRECTORIES) mkdirSync(join(fake, d));
    expect(() => assertPackShape(fake)).not.toThrow();
    // 8A shipped `statutory`, the last sub-pack whose loader was outstanding; an unknown directory is refused by name.
    mkdirSync(join(fake, "payroll"));
    expect(() => assertPackShape(fake)).toThrow(
      /unexpected sub-pack: payroll — the known sub-packs are .*statutory/,
    );
  });

  it("the loader inserts the regime, then its codes, and links each account by §4.15 code", async () => {
    const inserted = await withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx()));
    expect(inserted).toBe(5); // 1 regime + 4 codes
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [r] = await tx<
        { code: string; version: number; source: string; jurisdiction: string }[]
      >`
        select code, version, source, jurisdiction from app.tax_regime where company_id = ${a.company}`;
      expect(r).toMatchObject({ code: "SYNTH-MY-v1", version: 1, jurisdiction: "MY" });
      expect(r!.source).toContain("SYNTHETIC-TEST-v1");
      const codes = await tx<
        {
          code: string;
          kind: string;
          rate: string;
          output_account_id: string | null;
          input_account_id: string | null;
        }[]
      >`
        select c.code, c.kind, c.rate::text as rate, c.output_account_id, c.input_account_id
          from app.tax_code c where c.company_id = ${a.company} order by c.code`;
      expect(codes.map((c) => c.code)).toEqual([
        "SYN-EXEMPT",
        "SYN-IN-STD",
        "SYN-OUT-STD",
        "SYN-OUT-ZERO",
      ]);
      expect(codes.find((c) => c.code === "SYN-OUT-STD")!.rate).toBe("0.11000000");
      expect(codes.find((c) => c.code === "SYN-OUT-STD")!.output_account_id).not.toBeNull();
      expect(codes.find((c) => c.code === "SYN-IN-STD")!.input_account_id).not.toBeNull();
      expect(codes.find((c) => c.code === "SYN-EXEMPT")!.output_account_id).toBeNull();
    });
  });

  it("is idempotent — a second load inserts zero rows (§3.4.8, spec:2002)", async () => {
    expect(await withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx()))).toBe(0);
  });

  it("every rate and every code name in the shipped pack is synthetic (hazard 1, §2.6)", async () => {
    const dir = `${PACK}tax/`;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.toSorted()).toEqual(["SYNTH-MY-v1.codes.json", "SYNTH-MY-v1.regime.json"]);
    const text = files.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    for (const forbidden of [
      "SST",
      "GST",
      '"TX"',
      "ZRL",
      "ES43",
      "0.06",
      "0.08",
      "MyInvois",
      "LHDN",
    ]) {
      expect(text, `${forbidden} must not appear in a shipped seed file`).not.toContain(forbidden);
    }
    expect(text).toContain("SYNTHETIC-TEST-v1 — not a published figure (OD-15)");
  });

  it("a missing chart account fails LOUDLY, naming §3.4.8's ordering rule", async () => {
    const b = await seedTenantV2(db, "taxpack-noacct"); // no 2300, no 1350
    await expect(
      withTenant(db.rw, b.tenant, b.system, (tx) =>
        taxLoader.load(
          tx,
          ctx({ tenantId: b.tenant, companyId: b.company, systemPrincipalId: b.system }),
        ),
      ),
    ).rejects.toThrow(
      /account 2300 is not seeded for this company — seed --only chart-of-accounts first/,
    );
  });

  it("a pack directory with no tax/ names the directory rather than throwing ENOENT", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const empty = mkdtempSync(join(tmpdir(), "notax-"));
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx({ packRoot: empty }))),
    ).rejects.toThrow(/is not a readable directory — a tax pack needs it/);
  });
});

it("a file that does not match tax-pack.schema.json is a SeedError naming the path", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "badtax-"));
  mkdirSync(join(root, "tax"));
  // "11" instead of "0.11000000": a percentage, which would become an 1100 % tax in numeric(19,8).
  writeFileSync(
    join(root, "tax", "BAD-v1.regime.json"),
    JSON.stringify({
      code: "BAD-v1",
      version: 1,
      jurisdiction: "MY",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      nameEn: "Bad",
      source: "SYNTHETIC-TEST-v1 — not a published figure (OD-15)",
    }),
  );
  writeFileSync(
    join(root, "tax", "BAD-v1.codes.json"),
    JSON.stringify({
      regimeCode: "BAD-v1",
      regimeVersion: 1,
      codes: [
        {
          code: "BAD-OUT",
          nameEn: "Bad",
          rate: "11",
          kind: "output",
          roundingMode: "HALF_AWAY_FROM_ZERO",
          accountCode: "2300",
          effectiveFrom: "2026-01-01",
        },
      ],
    }),
  );
  await expect(
    withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx({ packRoot: root }))),
  ).rejects.toThrow(/BAD-v1\.codes\.json does not match urn:dulja:tax-pack:1: .*\/codes\/0\/rate/);
});

it("a pack whose output code names an asset, or whose input code names a liability, is a SeedError", async () => {
  // The runtime create refuses both (createTaxCode), and the tie-out takes each account's sign from its
  // type over every account the regime's codes name. The seed inserts codes directly, so without the same
  // rule a pack could put an output code on an asset and tie it out inverted — or name one account on both
  // sides of the tie-out.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const [kind, accountCode, type] of [
    ["output", "1350", "asset"],
    ["input", "2300", "liability"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "misfittax-"));
    mkdirSync(join(root, "tax"));
    writeFileSync(
      join(root, "tax", "MISFIT-v1.regime.json"),
      JSON.stringify({
        code: "MISFIT-v1",
        version: 1,
        jurisdiction: "MY",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        nameEn: "Misfit",
        source: "SYNTHETIC-TEST-v1 — not a published figure (OD-15)",
      }),
    );
    writeFileSync(
      join(root, "tax", "MISFIT-v1.codes.json"),
      JSON.stringify({
        regimeCode: "MISFIT-v1",
        regimeVersion: 1,
        codes: [
          {
            code: `MISFIT-${kind.toUpperCase()}`,
            nameEn: "Misfit",
            rate: "0.11000000",
            kind,
            roundingMode: "HALF_AWAY_FROM_ZERO",
            accountCode,
            effectiveFrom: "2026-01-01",
          },
        ],
      }),
    );
    await expect(
      withTenant(db.rw, a.tenant, a.system, (tx) => taxLoader.load(tx, ctx({ packRoot: root }))),
      `${kind} on ${accountCode}`,
    ).rejects.toThrow(
      `MISFIT-v1.codes.json: MISFIT-${kind.toUpperCase()}: an ${kind} tax code posts its tax to ` +
        `${kind === "output" ? "a liability" : "an asset"} account; account ${accountCode} is ${type}`,
    );
  }
  // Each refusal rolled its transaction back: no regime or code of the misfit pack is left behind.
  const [left] = await withTenant(
    db.rw,
    a.tenant,
    a.human,
    (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.tax_regime where company_id = ${a.company} and code = 'MISFIT-v1'`,
  );
  expect(left!.n).toBe(0);
});

it("validateTaxPack accepts both shipped files — the regime code's lower-case `v` included", async () => {
  const { validateTaxPack } = await import("@dulja/domain");
  for (const f of ["SYNTH-MY-v1.regime.json", "SYNTH-MY-v1.codes.json"]) {
    expect(validateTaxPack(JSON.parse(readFileSync(`${PACK}tax/${f}`, "utf8"))), f).toEqual({
      ok: true,
      errors: [],
    });
  }
});

// ── PR 11 review, round 3: a synthetic regime never reaches a production company. ─────────────────────
describe("APP_ENV=production skips a synthetic regime and says so; dev and staging load it", () => {
  /** A fresh tenant with the two tax accounts, so each case starts from a company holding no regime. */
  async function company(name: string): Promise<Seed> {
    const s = await seedTenantV2(db, name);
    await seedAccount(db, s, { code: "2300", nameEn: "Output tax payable", type: "liability" });
    await seedAccount(db, s, { code: "1350", nameEn: "Input tax receivable", type: "asset" });
    return s;
  }
  const loadAs = (
    s: Seed,
    appEnv: "dev" | "staging" | "production",
    over: Partial<LoaderContext> = {},
  ): Promise<number> =>
    withTenant(db.rw, s.tenant, s.system, (tx) =>
      taxLoader.load(
        tx,
        ctx({
          config: { tenantId: s.tenant, appEnv } as never,
          tenantId: s.tenant,
          companyId: s.company,
          systemPrincipalId: s.system,
          ...over,
        }),
      ),
    );
  const regimes = (s: Seed) =>
    db.admin<{ code: string }[]>`
      select code from app.tax_regime where company_id = ${s.company} order by code`;
  const codeCount = async (s: Seed): Promise<number> => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.tax_code where company_id = ${s.company}`;
    return row!.n;
  };

  it("production inserts nothing from SYNTH-MY-v1 and reports the file it skipped", async () => {
    const s = await company("taxpack-prod");
    const skipped: SeedSkip[] = [];
    const inserted = await loadAs(s, "production", { reportSkip: (skip) => skipped.push(skip) });
    expect(inserted).toBe(0);
    expect(await regimes(s)).toEqual([]);
    expect(await codeCount(s)).toBe(0);
    expect(skipped).toEqual([
      {
        subPack: "tax",
        file: "SYNTH-MY-v1.regime.json",
        reason: expect.stringMatching(/synthetic .*APP_ENV=production/),
      },
    ]);
  });

  it("dev and staging load the synthetic pack exactly as before and report no skip", async () => {
    for (const appEnv of ["dev", "staging"] as const) {
      const s = await company(`taxpack-${appEnv}`);
      const skipped: SeedSkip[] = [];
      expect(await loadAs(s, appEnv, { reportSkip: (skip) => skipped.push(skip) })).toBe(5);
      expect(await regimes(s)).toEqual([{ code: "SYNTH-MY-v1" }]);
      expect(skipped).toEqual([]);
    }
  });

  it("production still loads a regime whose source is not synthetic", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "realtax-"));
    mkdirSync(join(root, "tax"));
    writeFileSync(
      join(root, "tax", "OWNER-MY-v1.regime.json"),
      JSON.stringify({
        code: "OWNER-MY-v1",
        version: 1,
        jurisdiction: "MY",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        nameEn: "Owner-supplied regime (test only)",
        source: "Owner-supplied fixture for a test pack, outside the shipped directory",
      }),
    );
    writeFileSync(
      join(root, "tax", "OWNER-MY-v1.codes.json"),
      JSON.stringify({
        regimeCode: "OWNER-MY-v1",
        regimeVersion: 1,
        codes: [
          {
            code: "OWN-OUT",
            nameEn: "Owner output",
            rate: "0.05000000",
            kind: "output",
            roundingMode: "HALF_AWAY_FROM_ZERO",
            accountCode: "2300",
            effectiveFrom: "2026-01-01",
          },
        ],
      }),
    );
    const s = await company("taxpack-prod-real");
    const skipped: SeedSkip[] = [];
    expect(
      await loadAs(s, "production", { packRoot: root, reportSkip: (skip) => skipped.push(skip) }),
    ).toBe(2);
    expect(await regimes(s)).toEqual([{ code: "OWNER-MY-v1" }]);
    expect(skipped).toEqual([]);
  });

  it("`seed` reports the skip in the result the CLI prints, and loads the pack outside production", async () => {
    const { createDb } = await import("../../src/client");
    const migrator = createDb(db.url("app_migrator"));
    try {
      // One owner per tenant: the stub derives the identity subject from the e-mail, and a principal is
      // global, so a second tenant seeded for the same e-mail would mint a membership for nobody.
      const run = (appEnv: string) =>
        seed(
          migrator,
          parseSeedArgs(
            [
              "--tenant",
              randomUUID(),
              "--fiscal-year",
              "2026",
              "--owner-email",
              `owner-${appEnv}@example.my`,
              // A full seed outside dev states the real company (DBS-17).
              "--company-name",
              "Example Sdn Bhd",
            ],
            { APP_ENV: appEnv } as NodeJS.ProcessEnv,
          ),
          new StubSeedAuthAdmin(),
        );
      const production = await run("production");
      expect(production.applied.tax).toBe(0);
      expect(production.skipped).toEqual([
        {
          subPack: "tax",
          file: "SYNTH-MY-v1.regime.json",
          reason: expect.stringMatching(/synthetic .*APP_ENV=production/),
        },
      ]);
      // The CLI prints `JSON.stringify(result)`: the skip is in what an operator reads.
      expect(JSON.parse(JSON.stringify(production)).skipped[0].file).toBe(
        "SYNTH-MY-v1.regime.json",
      );
      const [none] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.tax_regime where company_id = ${production.companyId}`;
      expect(none!.n).toBe(0);

      const dev = await run("dev");
      expect(dev.applied.tax).toBe(5);
      expect(dev.skipped).toEqual([]);
    } finally {
      await migrator.end();
    }
  });

  it("the deploy procedure tells the seed where it runs: staging's workflow, and every production seed command", () => {
    // PR 11 review, round 3, adversarial pass. The skip above fires only when the seed SEES APP_ENV=production,
    // and the seed is an offline CLI run as app_migrator: it never reads the container's APP_ENV
    // (`infra/wrangler.jsonc`), and unset is dev. A procedure that does not set it seeds a production company
    // as dev — SYNTH-MY-v1 included — so the variable is part of each seed command the procedure gives.
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/deploy-staging.yml"), "utf8");
    const from = workflow.indexOf("- name: Re-apply the seed pack");
    expect(from, "deploy-staging.yml has no seed step").toBeGreaterThan(-1);
    const step = workflow.slice(from, workflow.indexOf("- name:", from + 1));
    expect(step).toMatch(/^\s+run: bun run seed --tenant /m);
    expect(step).toMatch(/^\s+APP_ENV: staging$/m);

    const runbook = readFileSync(join(REPO_ROOT, "docs/runbooks/deploy.md"), "utf8");
    expect(runbook).toContain("`APP_ENV=production bun run seed --tenant <id>`");
    expect(runbook).toContain("`APP_ENV=production bun run seed --tenant <id> --only <sub-pack>`");
  });

  it("every seed command any runbook gives names its APP_ENV, and the production restore names production", () => {
    // PR 11 review, round 3, second adversarial pass. The case above read deploy.md alone, and
    // supabase-provisioning.md's point-in-time recovery — a restore of the PRODUCTION project — still re-ran a
    // bare `bun run seed`, which seeds as dev and loads SYNTH-MY-v1 into the restored companies. So every
    // runbook is read, not a list of them, and a seed command added to one later meets the same rule: inside
    // its code span (or on its line), `bun run seed` is preceded by an `APP_ENV=` assignment.
    const dir = join(REPO_ROOT, "docs/runbooks");
    const unstated: string[] = [];
    let commands = 0;
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .toSorted()) {
      readFileSync(join(dir, file), "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const match of line.matchAll(/bun run seed\b/g)) {
            commands += 1;
            // The command's own text: back to the backtick that opens its span, or the whole line.
            const before = line.slice(0, match.index);
            const command = before.slice(before.lastIndexOf("`") + 1);
            if (!/\bAPP_ENV=\S+\s+(?:[A-Z_]+=\S+\s+)*$/.test(command))
              unstated.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(commands, "the scan found no seed command in docs/runbooks").toBeGreaterThan(0);
    expect(unstated, "a runbook seed command that does not name its APP_ENV").toEqual([]);

    // Naming one is not enough where the project is production: the restore must name production.
    const provisioning = readFileSync(
      join(REPO_ROOT, "docs/runbooks/supabase-provisioning.md"),
      "utf8",
    );
    const from = provisioning.indexOf("## 5. Point-in-time recovery");
    expect(from, "supabase-provisioning.md has no point-in-time recovery section").toBeGreaterThan(
      -1,
    );
    const pitr = provisioning.slice(from, provisioning.indexOf("\n## ", from + 1));
    expect(pitr).toContain("`APP_ENV=production bun run seed --tenant <id>`");
  });
});

// ── OD-15 provenance guard (Task 10). Runs on every build, answered or not. ───────────────────────────
describe("OD-15 — every shipped regime is either synthetic or backed by an accepted ADR 0049", () => {
  const TAX_DIR = join(REPO_ROOT, "packages/db/seed/my/tax");
  const ADR = join(REPO_ROOT, "docs/adr/0049-verified-lhdn-return-format.md");

  it("every RegimeDefinition in MALAYSIA_REGIMES has a matching seed pair, named by taxFileNames", () => {
    // A definition with no seed files is a regime no tenant can be put on; a seed pair with no definition
    // is a regime `buildReturn` refuses with ERR_TAX_REGIME_MISMATCH. Both are caught here, at build time,
    // rather than at a filing deadline.
    const present = readdirSync(TAX_DIR);
    for (const d of MALAYSIA_REGIMES) {
      const names = taxFileNames(d.code);
      expect(present, `${d.code} v${d.version} has no ${names.regime}`).toContain(names.regime);
      expect(present, `${d.code} v${d.version} has no ${names.codes}`).toContain(names.codes);
    }
    const declared = new Set(
      MALAYSIA_REGIMES.flatMap((d) => {
        const n = taxFileNames(d.code);
        return [n.regime, n.codes];
      }),
    );
    for (const file of present.filter((f) => f.endsWith(".json"))) {
      expect(declared, `${file} has no RegimeDefinition in MALAYSIA_REGIMES`).toContain(file);
    }
  });

  it("a regime whose source is not synthetic requires ADR 0049 to be accepted", () => {
    // The ONE mechanical link between "a real figure entered the repository" and "the ADR that records
    // where it came from was accepted first". Contracts hazards 1 and 2, spec:2467, and the reason this
    // guard is written before the answer arrives rather than after.
    const adr = existsSync(ADR) ? readFileSync(ADR, "utf8") : "";
    const accepted = /^Status: accepted$/m.test(adr);
    for (const d of MALAYSIA_REGIMES) {
      const manifest = readPackFile<TaxRegimeManifest>(
        join(REPO_ROOT, "packages/db/seed/my"),
        "tax",
        taxFileNames(d.code).regime,
      );
      const synthetic = manifest.source.startsWith("SYNTHETIC");
      expect(
        synthetic || accepted,
        `${d.code} v${d.version} declares source ${JSON.stringify(manifest.source)}, which is not ` +
          `synthetic, and docs/adr/0049-verified-lhdn-return-format.md is not accepted — ` +
          `a published figure may not enter this repository before the ADR that cites it (hazard 2)`,
      ).toBe(true);
    }
  });

  it("no Malaysian tax figure is hard-coded in the tax engine or the tax services", () => {
    // The mechanical half of hazard 1 for this slice's own source. A rate lives in `app.tax_code`, seeded
    // from a reviewed file; a decimal literal that looks like a rate in either directory is LEGACY-020.
    const suspects = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"]).flatMap((f) =>
      f.lines.flatMap((line, i) =>
        /(^|[^\w.])0\.[0-9]*[1-9][0-9]*\b/.test(line) && !/^\s*(?:\/\/|\/\*|\*)/.test(line)
          ? [`${f.path}:${i + 1} ${line.trim()}`]
          : [],
      ),
    );
    expect(suspects, "a decimal literal that could be a tax rate").toEqual([]);
  });
});

function sourceFiles(roots: string[]) {
  const out: { path: string; lines: string[] }[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (path.endsWith(".ts"))
      out.push({ path, lines: readFileSync(path, "utf8").split("\n") });
  };
  roots.forEach((root) => walk(join(REPO_ROOT, root)));
  return out;
}
