import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/client";
import { lintSchema } from "../../src/lint-schema";
import { discover, listApplied, up } from "../../src/migrate";
import { parseSeedArgs, seed, StubSeedAuthAdmin } from "../../src/seed";
import { adminPermissions, ROLES } from "../../seed/roles";
import { MIGRATIONS_DIR, startDb, type Db } from "../harness";

/**
 * 4B Task 12 Step 4 — the Phase 4 staging re-seed, run where no staging account exists yet (hazard 5; OD-19,
 * OD-21). The staging half is three commands against the owner's database:
 *
 *   bun run --cwd packages/db db:migrate
 *   bun run --cwd packages/db seed -- --tenant "$TENANT_ID" --only chart-of-accounts
 *   bun run --cwd packages/db seed -- --tenant "$TENANT_ID" --only document-types
 *
 * and this file runs those same three commands — the real `bun run` scripts, as child processes, against a
 * `startDb()` container — over the state staging is actually in: a database migrated to Phase 3's exit and a
 * tenant seeded from Phase 3's pack. That premise matters for both halves. For the migration half, Phase 3's
 * tree already held the review migrations 0105–0112, so on every deployed database 4A's and 4B's 0044–0052 are
 * applied AFTER them, out of version order — the runner allows it (contracts §3.4.1: whatever is not in
 * `listApplied()`, in version order), but no other test in the tree applies them in that order; `startDb()`'s
 * own `up()` always runs 0044 before 0105. For the seed half, a re-seed is judged by what it CREATES on a
 * tenant that already exists, which a fresh tenant cannot show.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(here, "..", "..");
const PACK_ROOT = join(PACKAGE_DIR, "seed", "my");

/** The migrations in the tree at Phase 3's exit (AGENTS.md "In the tree"): 0001–0042 and the review tail. */
const atPhase3Exit = (version: number): boolean =>
  version <= 42 || (version >= 105 && version <= 112);

/** 4A's four (0044–0047) and 4B's four. 0051 is OD-09's post-dated-cheque migration and is not built. */
const PHASE_4_MIGRATIONS = [44, 45, 46, 47, 48, 49, 50, 52];

/** The twelve document types Phase 3 left in the pack (0C/1A's JOURNAL, 3B, 3C and 3D's eleven). */
const PHASE_3_DOCUMENT_TYPES = [
  "COST_ADJUSTMENT",
  "DELIVERY_ORDER",
  "EXPIRY_WRITE_OFF",
  "GOODS_RECEIPT",
  "JOURNAL",
  "PURCHASE_ORDER",
  "PURCHASE_RETURN",
  "SALES_ORDER",
  "SHIPMENT",
  "STOCK_COUNT",
  "TRANSFER",
  "TRANSFER_RECEIPT",
];

/** 4A's six (T5, T7, T8, T10) and 4B T5's one, in code order. */
const PHASE_4_DOCUMENT_TYPES = [
  "FX_REVALUATION",
  "PAYMENT",
  "PURCHASE_CREDIT_NOTE",
  "PURCHASE_INVOICE",
  "RECEIPT",
  "SALES_CREDIT_NOTE",
  "SALES_INVOICE",
];

/** The eight permission codes migrations 0047 (4A's seven) and 0052 (4B's one) add to the global catalogue. */
const PHASE_4_CODES = [
  "accounting.bank.reconcile",
  "accounting.credit_limit.override",
  "accounting.payment.approve",
  "accounting.payment.create",
  "accounting.payment.post",
  "accounting.receipt.create",
  "accounting.receipt.post",
  "accounting.sales.post",
];

interface SeedOutput {
  tenantId: string;
  companyId: string;
  applied: Record<string, number>;
  created: boolean;
}

describe("Phase 4's staging re-seed, run locally (4B Task 12 Step 4, hazard 5)", () => {
  let db: Db;
  let migrator: Sql;
  let scratch: string;
  const tenantId = randomUUID();

  /** One of the plan's commands, exactly as written, with the container's migrator URL as the credential. The
   *  Supabase variables are removed so the CLI takes its stub auth admin (OD-21); `--only` skips the owner
   *  step that would call it, so nothing reaches a network either way. */
  const bunRun = (args: readonly string[]) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL_MIGRATOR: db.url("app_migrator"),
    };
    delete env["SUPABASE_URL"];
    delete env["SUPABASE_SERVICE_ROLE_KEY"];
    const run = spawnSync("bun", ["run", ...args], {
      cwd: PACKAGE_DIR,
      env,
      encoding: "utf8",
      timeout: 120_000,
      // Windows only, as in tests/e2e/support/boot.ts: `bun` is a `.cmd` shim on some machines and only the
      // shell finds it. Every argument is a literal or a uuid minted above.
      shell: process.platform === "win32",
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  const seedCommand = (only: string) =>
    bunRun(["seed", "--", "--tenant", tenantId, "--only", only]);
  const parseSeed = (stdout: string): SeedOutput => JSON.parse(stdout) as SeedOutput;

  const documentTypes = async (): Promise<string[]> =>
    (
      await db.admin<{ code: string }[]>`
        select code from app.document_type where tenant_id = ${tenantId} order by code`
    ).map((row) => row.code);
  const accountCodes = async (): Promise<string[]> =>
    (
      await db.admin<{ code: string }[]>`
        select code from app.account where tenant_id = ${tenantId} order by code`
    ).map((row) => row.code);
  const phase4Grants = async (): Promise<string[]> =>
    (
      await db.admin<{ grant: string }[]>`
        select r.code || ' ' || rp.permission_code as grant
          from app.role_permission rp join app.role r on r.id = rp.role_id
         where rp.tenant_id = ${tenantId} and rp.permission_code in ${db.admin(PHASE_4_CODES)}
         order by 1`
    ).map((row) => row.grant);

  beforeAll(async () => {
    db = await startDb({ migrate: false });
    migrator = createDb(db.url("app_migrator"));
    scratch = mkdtempSync(join(tmpdir(), "dulja-phase4-pack-"));

    // 1. The database as Phase 3 left it: every migration file in the Phase 3 set, applied by the same runner.
    const phase3Migrations = join(scratch, "migrations");
    mkdirSync(phase3Migrations);
    for (const migration of discover(MIGRATIONS_DIR).filter((m) => atPhase3Exit(m.version))) {
      copyFileSync(migration.upPath, join(phase3Migrations, basename(migration.upPath)));
      copyFileSync(migration.downPath, join(phase3Migrations, basename(migration.downPath)));
    }
    await up(migrator, phase3Migrations);

    // 2. The tenant as Phase 3's seed left it: today's pack with only Phase 3's document types. Phase 4 changed
    //    no other pack file (it seeds no account — 4B's header; 4A's chart files are 0C's, 3C's and 3D's), and
    //    `roles` is TypeScript data whose loader skips a code the catalogue does not hold yet (F-21), so today's
    //    ROLES over a Phase 3 catalogue grant exactly what Phase 3's did.
    const phase3Pack = join(scratch, "pack");
    cpSync(PACK_ROOT, phase3Pack, { recursive: true });
    // Reconstruct Phase 3 before applying today's migrations; its database has no tax tables.
    rmSync(join(phase3Pack, "chart-of-accounts", "5a-tax.json"));
    for (const file of readdirSync(join(phase3Pack, "tax"))) rmSync(join(phase3Pack, "tax", file));
    // …and no report definitions: `app.report_definition` is 7A's 0074, so a Phase 3 database cannot hold the
    // catalogue slices' `reports/<slice>/` files (7B's first). The directory and its README stay — the pack
    // shape requires the sub-pack directory (contracts 7B amendment A18 item 4).
    for (const entry of readdirSync(join(phase3Pack, "reports"), { withFileTypes: true })) {
      if (entry.isDirectory()) rmSync(join(phase3Pack, "reports", entry.name), { recursive: true });
    }
    // …and no statutory rows: `app.statutory_scheme` is 8A's 0084. The required directory stays, emptied, which the
    // statutory loader reads as nothing to load.
    rmSync(join(phase3Pack, "statutory"), { recursive: true });
    mkdirSync(join(phase3Pack, "statutory"));
    for (const file of readdirSync(join(phase3Pack, "document-types"))) {
      if (!PHASE_3_DOCUMENT_TYPES.includes(file.replace(/\.json$/, "")))
        rmSync(join(phase3Pack, "document-types", file));
    }
    const seeded = await seed(
      migrator,
      parseSeedArgs(
        ["--tenant", tenantId, "--pack", phase3Pack, "--fiscal-year", "2026"],
        {} as NodeJS.ProcessEnv,
      ),
      new StubSeedAuthAdmin(),
    );
    expect(seeded.created).toBe(true);
    expect(seeded.applied["document-types"]).toBe(PHASE_3_DOCUMENT_TYPES.length);
  });

  afterAll(async () => {
    await migrator.end();
    await db.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("starts from Phase 3's exit: no 4A or 4B migration applied, no Phase 4 type, no Phase 4 code granted", async () => {
    const applied = await listApplied(migrator);
    expect(applied.filter((version) => PHASE_4_MIGRATIONS.includes(version))).toEqual([]);
    expect(applied).toContain(112);
    const [missing] = await db.admin<{ allocation: string | null; bank_match: string | null }[]>`
      select to_regclass('app.allocation')::text as allocation, to_regclass('app.bank_match')::text as bank_match`;
    expect(missing).toEqual({ allocation: null, bank_match: null });
    expect(await documentTypes()).toEqual(PHASE_3_DOCUMENT_TYPES);
    expect(await phase4Grants()).toEqual([]);
  });

  it("`db:migrate` exits 0 and applies 0044–0052 after 0105–0112; the schema lints clean", async () => {
    const before = await listApplied(migrator);
    const run = bunRun(["db:migrate"]);
    expect(run.status, run.stderr).toBe(0);
    // cli.ts prints `applied: [ … ]`; the numbers it printed are the ones the ledger gained.
    const printed = [...(run.stdout.split("applied:")[1] ?? "").matchAll(/\d+/g)].map(Number);
    const after = await listApplied(migrator);
    expect(printed).toEqual(after.filter((version) => !before.includes(version)));
    expect(printed).toEqual(expect.arrayContaining(PHASE_4_MIGRATIONS));
    expect(printed).not.toContain(51);
    expect(after).toEqual(discover(MIGRATIONS_DIR).map((m) => m.version));
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("`seed --only chart-of-accounts` exits 0 and adds only Phase 5 chart leaves; every Phase 4 account already exists", async () => {
    const before = await accountCodes();
    const run = seedCommand("chart-of-accounts");
    expect(run.status, run.stderr).toBe(0);
    const out = parseSeed(run.stdout);
    expect(out).toMatchObject({ tenantId, created: false });
    expect(out.applied["chart-of-accounts"]).toBe(2);
    const after = await accountCodes();
    expect(after.filter((code) => !before.includes(code))).toEqual(["1350", "2300"]);
    // The six 4B Task 2 asserts resolve (1100, 1200, 2100 and the FX three), and 3C/3D's 2150 and 1250 that
    // 4A's invoices clear.
    expect(before).toEqual(
      expect.arrayContaining(["1100", "1200", "1250", "2100", "2150", "4900", "5910", "5920"]),
    );
  });

  it("`seed --only document-types` exits 0 and reports FX_REVALUATION and 4A's six created", async () => {
    const before = await documentTypes();
    const run = seedCommand("document-types");
    expect(run.status, run.stderr).toBe(0);
    const out = parseSeed(run.stdout);
    expect(out).toMatchObject({ tenantId, created: false });
    const after = await documentTypes();
    const created = after.filter((code) => !before.includes(code));
    // The loader's count is "rows inserted" (§4.2.13); the census names them.
    expect(out.applied["document-types"]).toBe(created.length);
    expect(created).toEqual(expect.arrayContaining(PHASE_4_DOCUMENT_TYPES));
    expect(created).toContain("FX_REVALUATION");
    // ⚠️ OD-09 is not built, so neither post-dated-cheque type exists (4B Task 9).
    expect(created).not.toContain("PDC_RECEIPT");
    expect(created).not.toContain("PDC_DEPOSIT");
    // Each created type carries its policy version, and no Phase 3 policy was rewritten (0106, LEGACY-013).
    const policies = await db.admin<{ code: string; versions: number }[]>`
      select t.code, count(p.id)::int as versions
        from app.document_type t left join app.posting_policy p on p.document_type_id = t.id
       where t.tenant_id = ${tenantId} and t.code in ${db.admin(PHASE_4_DOCUMENT_TYPES)}
       group by t.code order by t.code`;
    expect(policies).toEqual(PHASE_4_DOCUMENT_TYPES.map((code) => ({ code, versions: 1 })));

    // Running it twice changes nothing (spec:2317).
    const again = seedCommand("document-types");
    expect(again.status, again.stderr).toBe(0);
    expect(parseSeed(again.stdout).applied["document-types"]).toBe(0);
  });

  it("the three commands leave Phase 4's role grants unapplied — 0047 and 0052 name `--only roles` as the fourth", async () => {
    // Both migrations say the grants over their codes are "applied by `bun run seed --tenant <id> --only
    // roles`"; the plan's staging list does not include that command. Without it the staging owner (admin) and
    // accountant hold none of the eight codes, and no AR/AP or bank-reconciliation route admits them.
    expect(await phase4Grants()).toEqual([]);

    const beforeGrants = new Set(
      (
        await db.admin<{ grant: string }[]>`
      select r.code || ' ' || rp.permission_code as grant from app.role_permission rp
      join app.role r on r.id=rp.role_id where rp.tenant_id=${tenantId}`
      ).map((row) => row.grant),
    );
    const run = seedCommand("roles");
    expect(run.status, run.stderr).toBe(0);
    const catalogue = (
      await db.admin<{ code: string }[]>`select code from app.permission order by code`
    ).map((row) => row.code);
    const expected = ROLES.flatMap((role) =>
      (role.code === "admin" ? adminPermissions(catalogue) : role.permissions)
        .filter((code) => PHASE_4_CODES.includes(code))
        .map((code) => `${role.code} ${code}`),
    ).toSorted();
    // The live re-seed also applies later registered codes; count exactly the grants missing beforehand.
    const newGrants = ROLES.flatMap((role) =>
      (role.code === "admin" ? adminPermissions(catalogue) : role.permissions)
        .filter((code) => catalogue.includes(code))
        .map((code) => `${role.code} ${code}`),
    ).filter((grant) => !beforeGrants.has(grant));
    expect(parseSeed(run.stdout).applied.roles).toBe(newGrants.length);
    expect(await phase4Grants()).toEqual(expected);
    // Every code reaches the admin; the accountant gets accounting.bank.reconcile; the auditor gets none (R7).
    expect(expected).toContain("accountant accounting.bank.reconcile");
    expect(expected.filter((grant) => grant.startsWith("admin "))).toHaveLength(
      PHASE_4_CODES.length,
    );
    expect(expected.filter((grant) => grant.startsWith("auditor "))).toEqual([]);
  });
});
