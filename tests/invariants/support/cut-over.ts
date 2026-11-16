import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
// The PRODUCTION `withTenant(sql, ctx, fn)` and `systemContext` from `@dulja/db` (§4.2.2).
import { createHrKeyRing, systemContext, withTenant } from "@dulja/db";
import { currency, Money } from "@dulja/domain";
import { seedAccount, seedDocumentType, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import {
  createReader,
  FixtureLegacyDriver,
  readAccountMap,
  reconcileCutOver,
  runLoad,
  setAccountMap,
  setKeyRing,
  setLoadSource,
  type LegacyColumn,
  type LegacyConstraint,
  type LegacyCorpus,
  type CutOverReconciliation,
  type LegacyRow,
  type LoadContext,
  type SkipRecord,
} from "@dulja/importer";
// `sharedApi()`, never `startApi()` — contracts §3.7.5 (round 3): `apps/api` exports no test-support subpath, and a
// `tests/**` file that needs a running API takes 0B's memoised one and never stops it.
import { grantAdmin, sharedApi, type FullContext } from "../../support/api";
import { REPO_ROOT } from "../../support/source";

// 9B T5 — contracts round 20, amendment C6 (§4.17.1). The cut-over corpus the invariant and regression tiers load.
// Task 10 added the fifth export, `reconcileFor`, which wraps `reconcileCutOver`.

export interface CutOverFixture {
  api: FullContext["api"];
  seed: Seed;
  ctx: LoadContext;
  runId: string;
}

const CORPUS_ROOT = join(REPO_ROOT, "packages/importer/test/corpus");
const ACCOUNT_MAP = join(REPO_ROOT, "packages/importer/test/fixtures/account-map.json");
/** The HR key ring a whole-registry load seals the corpus's (invented) sensitive fields under — 9B T8's employee loader
 *  refuses to run without one. A deterministic test key, never 8A's `DEV_HR_KEY`; the importer suites use the same. */
const KEY_RING = createHrKeyRing({
  current: Buffer.alloc(32, 7).toString("base64"),
  currentVersion: 1,
});
const TYPE_DIR = join(REPO_ROOT, "packages/db/seed/my/document-types");

/** The six §4.15 codes a 9B loader resolves that `seedTenantV2` does not create — the same list as
 *  `packages/importer/test/support/tenant.ts`, repeated because `tests/` may not import `packages/importer/test/**`
 *  (§3.1). Two short lists, deliberately, rather than a cross-workspace test import. */
const ACCOUNTS: readonly {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}[] = [
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset" },
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability" },
  { code: "3900", nameEn: "Opening-balance suspense", type: "equity" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

/** The cut-over document types (§4.14 `OB`/`OS`), each from the slice's OWN seed file — a re-typed policy would make
 *  every posting assertion green against a policy nobody deploys. A file a later task has not written yet is passed
 *  over. */
const CUT_OVER_TYPES = ["OPENING_BALANCE.json", "OPENING_STOCK.json"] as const;

async function seedLoadable(db: Db, name: string): Promise<Seed> {
  const seed = await seedTenantV2(db, name);
  for (const account of ACCOUNTS) await seedAccount(db, seed, account);
  for (const file of CUT_OVER_TYPES) {
    const path = join(TYPE_DIR, file);
    if (!existsSync(path)) continue;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as {
      code: string;
      module: "accounting" | "inventory" | "hr" | "pos";
      policyVersion: number;
      effectiveFrom: string;
      policy: unknown;
    };
    await seedDocumentType(db, seed, {
      code: envelope.code,
      module: envelope.module,
      policy: envelope.policy,
      policyVersion: envelope.policyVersion,
      effectiveFrom: envelope.effectiveFrom,
    });
  }
  return seed;
}

/**
 * A tenant the cut-over load can run against — `seedTenantV2` plus the six §4.15 accounts and the cut-over document
 * types — an admin principal, and a `LoadContext` under the tenant's SYSTEM principal (spec:2179), dated `2026-01-31`,
 * the date the committed corpus is written for. Sets the run's account map to the importer's fixture map.
 *
 * **The API is `sharedApi()`'s and is never stopped** (§3.7.5, §4.17.1). Every call seeds a tenant of its own, so
 * isolation between cases is by tenant — which RLS makes real — not by container.
 */
export async function cutOverFixture(name: string): Promise<CutOverFixture> {
  const { api } = await sharedApi();
  const seed = await seedLoadable(api.db, `${name}-${randomUUID().slice(0, 8)}`);
  await grantAdmin(api, seed);
  const runId = randomUUID();
  const ctx: LoadContext = {
    ...(await systemContext(api.db.rw, seed.tenant, runId)),
    companyId: seed.company,
    runId,
    cutOverDate: "2026-01-31",
    dryRun: false,
  };
  setAccountMap(readAccountMap(ACCOUNT_MAP));
  setKeyRing(KEY_RING);
  return { api, seed, ctx, runId };
}

/** 9A's on-disk corpus format — `catalog.json` plus one `<TABLE>.json` per catalogued table — read here because 9A's
 *  reader (`readCorpus`) is package-internal and `tests/` may not import `packages/importer/test/**` (§3.1). */
function readCorpus(name: string): LegacyCorpus {
  const dir = join(CORPUS_ROOT, name);
  const catalog = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as {
    engineVersion: string | null;
    tables: Record<
      string,
      { keyColumns: string[]; columns: LegacyColumn[]; constraints?: LegacyConstraint[] }
    >;
  };
  for (const file of readdirSync(dir))
    if (file.endsWith(".json") && file !== "catalog.json" && !catalog.tables[file.slice(0, -5)])
      throw new Error(`corpus ${name}: ${file} has rows but no catalog entry`);
  const tables = Object.fromEntries(
    Object.entries(catalog.tables).map(([table, meta]) => [
      table,
      {
        ...meta,
        constraints: meta.constraints ?? [],
        rows: JSON.parse(readFileSync(join(dir, `${table}.json`), "utf8")) as LegacyRow[],
      },
    ]),
  );
  return { engineVersion: catalog.engineVersion, tables };
}

/**
 * Runs the whole registered load against a committed corpus and returns its skip register.
 *
 * **Two forms, and the difference is which TENANT is loaded.** `loadFromCorpus(fixture, corpus)` loads INTO the
 * caller's fixture — the form every caller that then QUERIES the result must use. `loadFromCorpus(corpus)` seeds a
 * tenant of its own and returns only the skips: usable solely by a caller that reads nothing but the skip register
 * (`legacy-073`, Task 15's `legacy-022`). Neither form stops anything; the run's artefact directory is removed afterwards.
 */
export async function loadFromCorpus(
  fixture: CutOverFixture,
  corpus: string,
  over?: Partial<LoadContext>,
): Promise<SkipRecord[]>;
export async function loadFromCorpus(
  corpus: string,
  over?: Partial<LoadContext>,
): Promise<SkipRecord[]>;
export async function loadFromCorpus(
  first: CutOverFixture | string,
  second?: string | Partial<LoadContext>,
  third: Partial<LoadContext> = {},
): Promise<SkipRecord[]> {
  const corpus = typeof first === "string" ? first : (second as string);
  const over =
    typeof first === "string" ? ((second as Partial<LoadContext> | undefined) ?? {}) : third;
  const fixture = typeof first === "string" ? await cutOverFixture(`corpus-${corpus}`) : first;
  const data = readCorpus(corpus);
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(data);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
  const ctx = { ...fixture.ctx, ...over };
  try {
    return (await runLoad(fixture.api.db.rw, ctx)).skips;
  } finally {
    rmSync(join("artefacts", "legacy", ctx.runId), { recursive: true, force: true });
  }
}

/**
 * The definition-of-done predicate (Task 10's call site): after a load the company's ledger nets to zero to the cent,
 * and every row on the suspense account `3900` is a cut-over document's line that says why it is there — the
 * "explained" half of spec:2295. Throws naming every non-zero account balance, so a failure reads as a trial balance.
 * An `OPENING_BALANCE` explains its `3900` row with an account line on `3900`; an `OPENING_STOCK` has no account line —
 * its `3900` credit is the policy's leg of each item line (round 20 C11) — so it explains it when every one of its lines
 * names the position it opens.
 *
 * **Compared as `Money`, never as `number`** (spec:2041). `MYR` is a fact about the FIXTURE — 0A's `seedTenant` gives
 * every test company `base_currency = 'MYR'` — never about production, which reads `baseCurrency()`.
 */
export async function assertExplained(
  fixture: CutOverFixture,
  tolerance = "0.0000",
): Promise<void> {
  const MYR = currency("MYR");
  const { balances, unexplained } = await withTenant(
    fixture.api.db.rw,
    fixture.ctx,
    async (tx) => ({
      balances: await tx<{ code: string; balance: string }[]>`
      select a.code, sum(l.base_debit - l.base_credit)::text as balance
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.company_id = ${fixture.ctx.companyId}
       group by a.code having sum(l.base_debit - l.base_credit) <> 0 order by a.code`,
      unexplained: await tx<{ code: string; series: string; number: string | null }[]>`
      select t.code, d.series, d.number::text as number
        from app.ledger_entry l
        join app.account a on a.id = l.account_id
        join app.document d on d.id = l.document_id
        join app.document_type t on t.id = d.document_type_id
       where l.company_id = ${fixture.ctx.companyId} and a.code = '3900'
         and not (
               (t.code = 'OPENING_BALANCE'
                and exists (select 1 from app.document_line dl
                             where dl.document_id = d.id and dl.account_id = a.id
                               and coalesce(btrim(dl.description), '') <> ''))
            or (t.code = 'OPENING_STOCK'
                and exists (select 1 from app.document_line dl where dl.document_id = d.id)
                and not exists (select 1 from app.document_line dl
                                 where dl.document_id = d.id
                                   and (dl.kind <> 'item' or coalesce(btrim(dl.description), '') = ''))))
       order by d.series, d.number`,
    }),
  );
  const total = balances.reduce((sum, r) => sum.add(Money.of(r.balance, MYR)), Money.zero(MYR));
  const list = balances.map((r) => `${r.code}=${r.balance}`).join(", ");
  if (total.abs().compare(Money.of(tolerance, MYR)) > 0)
    throw new Error(`the ledger is out by ${total.toString()}; balances: ${list}`);
  if (unexplained.length > 0)
    throw new Error(
      `3900 carries rows no cut-over line explains: ${unexplained
        .map((d) => `${d.code} ${d.series} ${d.number ?? "(unnumbered)"}`)
        .join(", ")}; balances: ${list}`,
    );
}

/**
 * 9B T10 — the cut-over reconciliation (ADR 0086) of the fixture's tenant against the committed `cut-over` corpus, on
 * the caller's transaction: the source the load read, through 9A's reader, and the account map `cutOverFixture` set.
 * The definition of done's call site is `tests/invariants/cut-over-reconciliation.test.ts`.
 */
export async function reconcileFor(
  tx: Parameters<typeof reconcileCutOver>[0],
  fixture: CutOverFixture,
): Promise<CutOverReconciliation> {
  const driver = new FixtureLegacyDriver(readCorpus("cut-over"));
  try {
    return await reconcileCutOver(tx, await createReader(driver), fixture.ctx);
  } finally {
    await driver.close();
  }
}
