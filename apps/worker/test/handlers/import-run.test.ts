// The registry (through the barrel) before any loader module: a loader module imported first would build `loaders` with
// that loader still unset (9B T6's note). Everything here comes through the barrel, which imports `./load/registry`
// first.
import {
  accountMap,
  createReader,
  FixtureLegacyDriver,
  LoadError,
  setLoadSource,
  type LegacyCorpus,
  type LegacyReader,
  type LoadSource,
} from "@dulja/importer";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimImportRun,
  createImportRun,
  getImportRun,
  IMPORT_RUN_LEASE_SECONDS,
  ImportBatchError,
  importWriteCodes,
  PostingError,
  withTenant,
  type ImportRunRow,
} from "@dulja/db";
import {
  grantCodes,
  seedTenantV2,
  uuidv7,
  withTenant as asPrincipal,
  type Seed,
} from "@dulja/db/test";
import { importFailureDetail } from "../../src/handlers/import-run";
import { startWorker, type StartedWorker } from "../support/worker";

let w: StartedWorker;
let s: Seed;

/**
 * **The load source is injected, and most runs are restricted to ONE loader** (the plan's reasons, kept). Injected,
 * because `runLoad`'s default factory is `loadSourceFromEnv()`, which refuses before a row is read without
 * `LEGACY_ODBC_DSN`; restricted, because this file tests the HANDLER, not the loaders: `only: ["unit_of_measure"]`
 * (C14) runs `unitLoader` alone, which needs no account map, no §4.15 chart and no document type. The corpus is built
 * inline: `apps/worker/test/**` may not reach into another workspace's test tree (§3.1).
 */
const CORPUS = {
  engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
  tables: {
    UNITS: {
      keyColumns: ["UNTID"],
      columns: [
        { name: "UNTID", kind: "integer", scale: 0, nullable: false },
        { name: "UNTNAME", kind: "text", scale: 0, nullable: false },
      ],
      constraints: [],
      rows: [
        { UNTID: "1", UNTNAME: "Piece" },
        { UNTID: "2", UNTNAME: "Carton" },
      ],
    },
  },
} as unknown as LegacyCorpus;

/** How many times the run opened the legacy source — a refusal that must come BEFORE any read leaves it unchanged. */
let opened = 0;
const fixtureSource = async (): Promise<LoadSource> => {
  opened += 1;
  const driver = new FixtureLegacyDriver(CORPUS);
  return { driver, reader: await createReader(driver), close: async () => driver.close() };
};

/**
 * A source that hands `runLoad` one row per page and runs `between(n)` once page n has been loaded and the next is
 * asked for (and once more after the last) — where a second worker's delivery, or the passing of hours, can be staged
 * between two of a long load's pages (9B review, finding 5).
 */
const pagedSource =
  (units: readonly string[], between: (pagesDone: number) => Promise<void>) =>
  async (): Promise<LoadSource> => {
    opened += 1;
    const unitsTable = CORPUS.tables["UNITS"]!;
    const driver = new FixtureLegacyDriver({
      ...CORPUS,
      tables: {
        UNITS: { ...unitsTable, rows: units.map((id) => ({ UNTID: id, UNTNAME: `Unit ${id}` })) },
      },
    } as LegacyCorpus);
    const inner = await createReader(driver);
    const reader: LegacyReader = {
      firebirdVersion: inner.firebirdVersion,
      tables: () => inner.tables(),
      count: (table) => inner.count(table),
      dateRange: (table, column) => inner.dateRange(table, column),
      read: <T>(table: string, opts: { columns: string[]; batch: number }) => ({
        async *[Symbol.asyncIterator]() {
          let done = 0;
          for await (const page of inner.read<T>(table, { ...opts, batch: 1 })) {
            if (done > 0) await between(done);
            done += 1;
            yield page;
          }
          await between(done);
        },
      }),
    };
    return { driver, reader, close: async () => driver.close() };
  };

const MAP = {
  generatedFrom: "synthetic",
  entries: [
    {
      legacyCode: "1301",
      code: "1200",
      nameEn: "Trade receivables",
      nameAr: null,
      type: "asset",
      treatment: "ar_control",
      note: null,
    },
    {
      legacyCode: "2101",
      code: "2100",
      nameEn: "Trade payables",
      nameAr: null,
      type: "liability",
      treatment: "ap_control",
      note: null,
    },
  ],
};

beforeAll(async () => {
  w = await startWorker();
  s = await seedTenantV2(w.db, "import-job");
  // The requester holds every loader's write code (9B review, finding 4): the job re-checks them at claim time.
  await grantCodes(w.db, s, { codes: ["admin.company.manage", ...importWriteCodes(null)] });
}, 300_000);
/** Every run this file queued: `runLoad` writes its artefacts under `artefacts/legacy/<runId>/` in the working
 *  directory (git-ignored, customer data in production), and the file removes its own afterwards. */
const queued: string[] = [];
afterAll(async () => {
  for (const id of queued)
    rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await w?.stop();
});
beforeEach(() => {
  setLoadSource(fixtureSource);
  // The configured source belongs to `s`'s company (round 20 C19); a case that needs another binding sets its own.
  process.env["LEGACY_IMPORT_TARGET"] = `${s.tenant}:${s.company}`;
});
afterEach(() => {
  delete process.env["LEGACY_IMPORT_TARGET"];
});

/** One queued run of `s`'s company, written as the route writes it (the operator, not the system principal). */
const queue = async (
  over: Partial<{ dryRun: boolean; only: string[]; accountMap: unknown; cutOverDate: string }> = {},
  requester = s.human,
) => {
  const run = await withTenant(
    w.db.rw,
    { tenantId: s.tenant, actorId: requester, requestId: crypto.randomUUID() },
    (tx) =>
      createImportRun(tx, {
        companyId: s.company,
        cutOverDate: "2026-01-31",
        dryRun: false,
        only: ["unit_of_measure"],
        ...over,
      }),
  );
  queued.push(run.id);
  return run;
};
const payloadOf = (run: ImportRunRow, over: Record<string, unknown> = {}) => ({
  companyId: run.companyId,
  runId: run.id,
  cutOverDate: run.cutOverDate,
  dryRun: run.dryRun,
  ...(run.only === null ? {} : { only: run.only }),
  ...over,
});
const runJob = (run: ImportRunRow, over: Record<string, unknown> = {}) =>
  w.run("admin.import.run", {
    tenantId: s.tenant,
    requestId: crypto.randomUUID(),
    payload: payloadOf(run, over) as never,
  });
const reread = (id: string) =>
  withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "read" }, (tx) =>
    getImportRun(tx, id),
  );

describe("admin.import.run", () => {
  it("runs as the tenant's SYSTEM principal, never a human (spec:2179, hazard 20), and records the outcome", async () => {
    const run = await queue();
    await runJob(run);
    // A REAL run, not a dry one: a dry run commits nothing, so `import_batch` — and its audit rows — would be empty
    // and `every` over an empty array is vacuously true.
    const actors = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "read" },
      (tx) =>
        tx<
          { actor_id: string }[]
        >`select distinct actor_id from app.audit_log where table_name = 'import_batch'`,
    );
    expect(actors).toEqual([{ actor_id: s.system }]);
    const done = await reread(run.id);
    expect(done).toMatchObject({
      status: "done",
      attempts: 1,
      perLoader: { unit_of_measure: { inserted: 2, skipped: 0, conflicts: 0 } },
      skipCount: 0,
      error: null,
    });
    expect(done!.artefactCount).toBeGreaterThan(0);
  });

  it("is a no-op on a redelivery of a finished run — never a second load", async () => {
    const run = await queue();
    await runJob(run);
    const before = await reread(run.id);
    await runJob(run);
    expect(await reread(run.id)).toEqual(before);
  });

  it("logs the per-loader counts and the artefact count, and never a DSN", async () => {
    const run = await queue({ dryRun: true });
    w.logs.length = 0;
    await runJob(run);
    const line = w.logs.find(
      (l) => l.fields["job"] === "admin.import.run" && l.msg === "import run finished",
    );
    expect(line?.fields).toMatchObject({
      job: "admin.import.run",
      import_run_id: run.id,
      dry_run: true,
      // The first case loaded both units into this tenant, so the dry run reads both as already mapped.
      per_loader: { unit_of_measure: { inserted: 0, skipped: 2, conflicts: 0 } },
      skips: 0,
    });
    expect(JSON.stringify(w.logs)).not.toMatch(/LEGACY_ODBC_DSN=|password|PWD=/i);
    expect((await reread(run.id))!.status).toBe("done");
  });

  it("fails the RUN with a LoadError's exact code — legible on the status resource — and the job finishes", async () => {
    // `only` naming a target no loader has is runLoad's own ERR_VALIDATION_FAILED (C14): a real LoadError, raised
    // deterministically before the source is opened.
    const run = await queue({ only: ["no_such_table"] });
    const before = opened;
    await expect(runJob(run)).resolves.toBeUndefined();
    const failed = await reread(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/^ERR_VALIDATION_FAILED: no loader targets no_such_table;/);
    expect(failed!.error).not.toMatch(/^ERR_VALIDATION_FAILED: ERR_VALIDATION_FAILED/);
    expect(opened).toBe(before);
    const line = w.logs.findLast((l) => l.msg === "import run failed");
    expect(line?.fields).toMatchObject({ code: "ERR_VALIDATION_FAILED", import_run_id: run.id });
  });

  it("refuses a run that needs the account map and carries none, before the source is opened", async () => {
    const run = await queue({ only: ["unit_of_measure", "account"] });
    const before = opened;
    await runJob(run);
    const failed = await reread(run.id);
    expect(failed!.error).toMatch(/^ERR_VALIDATION_FAILED: import run .* includes account/);
    expect(opened).toBe(before);
  });

  it("refuses an account map assertAccountMap refuses, naming the run, before the source is opened", async () => {
    const run = await queue({
      only: ["account"],
      accountMap: { ...MAP, entries: [{ ...MAP.entries[0], code: "2200" }, MAP.entries[1]] },
    });
    const before = opened;
    await runJob(run);
    expect((await reread(run.id))!.error).toMatch(
      new RegExp(`^ERR_VALIDATION_FAILED: import run ${run.id}: legacy account 1301 maps to 2200`),
    );
    expect(opened).toBe(before);
  });

  it("sets the run's account map for the load and clears it afterwards, so no later run inherits it", async () => {
    // `account` is restricted to an empty legacy chart here: the corpus has no ACCOUNTS table, so pre-flight refuses
    // the run — AFTER the map was set, which is what this case needs to see cleared.
    const run = await queue({ only: ["account"], accountMap: MAP });
    await runJob(run);
    expect((await reread(run.id))!.error).toMatch(
      /^ERR_IMPORT_SOURCE_UNREADABLE: pre-flight failed/,
    );
    expect(() => accountMap()).toThrow(LoadError);
  });

  it("fails a run whose job payload disagrees with the run row — the row is authoritative", async () => {
    const run = await queue();
    const before = opened;
    await runJob(run, { cutOverDate: "2026-02-28" });
    expect((await reread(run.id))!.error).toMatch(
      /^ERR_VALIDATION_FAILED: the admin\.import\.run payload disagrees with import run .* on cutOverDate/,
    );
    expect(opened).toBe(before);
  });

  it("refuses a run of any tenant or company but the one LEGACY_IMPORT_TARGET binds, before the source is opened (9B review, finding 1)", async () => {
    // Another company of the same tenant: the binding names a company that is not this run's.
    process.env["LEGACY_IMPORT_TARGET"] = `${s.tenant}:${crypto.randomUUID()}`;
    const run = await queue();
    const before = opened;
    await expect(runJob(run)).resolves.toBeUndefined();
    const refused = await reread(run.id);
    expect(refused).toMatchObject({ status: "failed", perLoader: null });
    expect(refused!.error).toMatch(
      /^ERR_IMPORT_SOURCE_NOT_BOUND: the configured legacy source is bound to another tenant or company/,
    );
    // Another tenant entirely: its own admin's run, with the source bound to `s`.
    const other = await seedTenantV2(w.db, "import-job-unbound");
    process.env["LEGACY_IMPORT_TARGET"] = `${s.tenant}:${s.company}`;
    const theirs = await withTenant(
      w.db.rw,
      { tenantId: other.tenant, actorId: other.human, requestId: crypto.randomUUID() },
      (tx) =>
        createImportRun(tx, {
          companyId: other.company,
          cutOverDate: "2026-01-31",
          dryRun: false,
          only: ["unit_of_measure"],
        }),
    );
    queued.push(theirs.id);
    await w.run("admin.import.run", {
      tenantId: other.tenant,
      requestId: crypto.randomUUID(),
      payload: payloadOf(theirs) as never,
    });
    const row = await withTenant(
      w.db.rw,
      { tenantId: other.tenant, actorId: other.system, requestId: "read" },
      (tx) => getImportRun(tx, theirs.id),
    );
    expect(row!.error).toMatch(/^ERR_IMPORT_SOURCE_NOT_BOUND: /);
    expect(row!.error).not.toContain(s.company);
    expect(row!.error).not.toContain(s.tenant);
    expect(opened).toBe(before);
    // Unbound altogether: no run may read the configured source.
    delete process.env["LEGACY_IMPORT_TARGET"];
    const unbound = await queue();
    await runJob(unbound);
    expect((await reread(unbound.id))!.error).toMatch(
      /^ERR_IMPORT_SOURCE_NOT_BOUND: LEGACY_IMPORT_TARGET is not set;/,
    );
    expect(opened).toBe(before);
  });

  it("refuses a run whose requester no longer holds a write code of its loaders, before the source is opened (9B review, finding 4)", async () => {
    // A requester whose inventory.item.manage was revoked after the route accepted the run: admin.company.manage alone.
    const requester = await uuidv7(w.db.admin);
    await asPrincipal(w.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${requester}, 'human', ${`human:revoked:${s.tenant}`}, 'revoked')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${requester})`;
    });
    await grantCodes(w.db, s, { codes: ["admin.company.manage"], principalId: requester });
    const run = await queue({}, requester);
    const before = opened;
    await expect(runJob(run)).resolves.toBeUndefined();
    const refused = await reread(run.id);
    expect(refused).toMatchObject({ status: "failed", requestedBy: requester });
    expect(refused!.error).toMatch(
      new RegExp(
        `^ERR_RBAC_FORBIDDEN: principal ${requester}, who requested import run ${run.id}, no longer holds inventory\\.item\\.manage company-wide`,
      ),
    );
    expect(opened).toBe(before);
  });

  it("renews its lease as its pages commit, so a delivery after the lease would have lapsed defers instead of loading twice (9B review, finding 5)", async () => {
    // A load that outlives IMPORT_RUN_LEASE_SECONDS: after its first page, four hours and a minute "pass" (the claim
    // is back-dated past the lease). Before its second page it renews the claim, so a second worker that tries to take
    // the run over afterwards finds a LIVE claim — and the load that was running records `done`, not `failed`.
    const run = await queue();
    let takeover: ImportRunRow | null | undefined;
    setLoadSource(
      pagedSource(["101", "102"], async (pagesDone) => {
        await withTenant(
          w.db.rw,
          { tenantId: s.tenant, actorId: s.system, requestId: "x" },
          async (tx) => {
            if (pagesDone === 1)
              await tx`update app.import_run
                          set started_at = now() - make_interval(secs => ${IMPORT_RUN_LEASE_SECONDS + 60})
                        where id = ${run.id}`;
            else takeover = await claimImportRun(tx, run.id);
          },
        );
      }),
    );
    await runJob(run);
    expect(takeover).toBeNull();
    expect(await reread(run.id)).toMatchObject({
      status: "done",
      attempts: 1,
      perLoader: { unit_of_measure: { inserted: 2, skipped: 0, conflicts: 0 } },
    });
  });

  it("stops before its next page once another worker has taken the run over, and records nothing (9B review, finding 5)", async () => {
    // The lease DID lapse during page one — a page longer than the lease — and a second worker reclaimed the run. The
    // first load must not write page two beside the second load: its heartbeat finds the claim is no longer its own.
    const run = await queue();
    setLoadSource(
      pagedSource(["111", "112"], async (pagesDone) => {
        if (pagesDone !== 1) return;
        await withTenant(
          w.db.rw,
          { tenantId: s.tenant, actorId: s.system, requestId: "x" },
          async (tx) => {
            await tx`update app.import_run
                        set started_at = now() - make_interval(secs => ${IMPORT_RUN_LEASE_SECONDS + 60})
                      where id = ${run.id}`;
            await claimImportRun(tx, run.id);
          },
        );
      }),
    );
    await expect(runJob(run)).resolves.toBeUndefined();
    // The second worker's claim stands untouched; the first wrote no outcome and loaded only its first page.
    expect(await reread(run.id)).toMatchObject({ status: "running", attempts: 2, error: null });
    const batches = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "read" },
      (tx) =>
        tx<{ source_key: string }[]>`
          select source_key from app.import_batch where run_id = ${run.id} order by source_key`,
    );
    expect(batches.map((b) => b.source_key)).toEqual(["111"]);
    expect(w.logs.findLast((l) => l.fields["import_run_id"] === run.id)?.msg).toBe(
      "import run claim superseded; the load stopped before its next page",
    );
    await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "settle" },
      (tx) =>
        tx`update app.import_run set status = 'failed', error = 'ERR_INTERNAL: test', finished_at = now()
            where id = ${run.id}`,
    );
  });

  it("schedules a follow-up delivery when a load is already running in this process, instead of throwing (9B review, finding 7)", async () => {
    // pg-boss redelivers the run while its first delivery is still loading in this worker. Throwing spent one of the
    // job's retries per delivery, and a job that exhausted them before any claim left the run queued for ever.
    const run = await queue();
    let second: Promise<void> | undefined;
    setLoadSource(
      pagedSource(["121"], async (pagesDone) => {
        if (pagesDone === 1) second = runJob(run);
        await second;
      }),
    );
    await runJob(run);
    await expect(second).resolves.toBeUndefined();
    expect(await reread(run.id)).toMatchObject({ status: "done", attempts: 1 });
    const followUps = await w.db.admin<{ n: number; later: boolean }[]>`
      select count(*)::int as n, bool_and(start_after > now()) as later from pgboss.job
       where name = 'admin.import.run' and singleton_key = ${`${run.id}:busy`}`;
    expect(followUps[0]).toEqual({ n: 1, later: true });
  });

  it("maps an unreadable source to ERR_IMPORT_SOURCE_UNREADABLE without printing the DSN", async () => {
    setLoadSource(async () => {
      throw new LoadError(
        "ERR_IMPORT_SOURCE_UNREADABLE",
        "the ODBC driver could not connect (dsn redacted)",
      );
    });
    const run = await queue();
    await runJob(run);
    expect((await reread(run.id))!.error).toBe(
      "ERR_IMPORT_SOURCE_UNREADABLE: the ODBC driver could not connect (dsn redacted)",
    );
  });

  it("leaves a run held by a LIVE claim alone and schedules one follow-up after its lease", async () => {
    const run = await queue();
    await withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.system, requestId: "claim" }, (tx) =>
      claimImportRun(tx, run.id),
    );
    await runJob(run);
    expect(await reread(run.id)).toMatchObject({ status: "running", attempts: 1 });
    const followUps = await w.db.admin<{ n: number }[]>`
      select count(*)::int as n from pgboss.job
       where name = 'admin.import.run' and singleton_key = ${`${run.id}:lease:1`}`;
    expect(followUps[0]!.n).toBe(1);
    await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "settle" },
      (tx) =>
        tx`update app.import_run set status = 'failed', error = 'ERR_INTERNAL: test', finished_at = now()
            where id = ${run.id}`,
    );
  });

  it("is a logged no-op on an empty payload (the job-isolation harness's shape) or another tenant's run", async () => {
    await expect(
      w.run("admin.import.run", {
        tenantId: s.tenant,
        requestId: crypto.randomUUID(),
        payload: {} as never,
      }),
    ).resolves.toBeUndefined();
    const other = await seedTenantV2(w.db, "import-job-other");
    const run = await queue();
    await w.run("admin.import.run", {
      tenantId: other.tenant,
      requestId: crypto.randomUUID(),
      payload: payloadOf(run) as never,
    });
    expect((await reread(run.id))!.status).toBe("queued");
    await runJob(run);
    expect((await reread(run.id))!.status).toBe("done");
  });
});

describe("importFailureDetail — one stable `CODE: detail` per refusal", () => {
  it("never doubles a code the message already starts with", () => {
    expect(importFailureDetail(new LoadError("ERR_IMPORT_UNBALANCED_SOURCE", "no 3900"))).toBe(
      "ERR_IMPORT_UNBALANCED_SOURCE: no 3900",
    );
    expect(importFailureDetail(new ImportBatchError("UNITS/1 changed"))).toBe(
      "ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS/1 changed",
    );
    expect(importFailureDetail(new PostingError("ERR_PERIOD_NOT_OPEN", "2026-02 is closed"))).toBe(
      "ERR_PERIOD_NOT_OPEN: 2026-02 is closed",
    );
  });

  it("names anything else ERR_INTERNAL and caps the detail", () => {
    expect(importFailureDetail(new Error("boom"))).toBe("ERR_INTERNAL: boom");
    expect(importFailureDetail("plain")).toBe("ERR_INTERNAL: plain");
    expect(
      importFailureDetail(new LoadError("ERR_VALIDATION_FAILED", "x".repeat(5000))),
    ).toHaveLength(2000);
  });
});
