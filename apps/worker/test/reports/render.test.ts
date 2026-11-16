import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimReportRun,
  createReportRun,
  failReportRun,
  getReportRun,
  leaseFollowUpKey,
  MemoryObjectStore,
  REPORT_RUN_JOB_OPTIONS,
  type ObjectStore,
  REPORT_RUN_LEASE_SECONDS,
  REPORT_RUN_MAX_CLAIMS,
  reportObjectKeyFor,
  withTenant,
} from "@dulja/db";
import { seedReportDefinition, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { statementDefinition } from "@dulja/domain";
import { postJournal } from "../../../../tests/invariants/support/post-journal";
import { REPO_ROOT } from "../../../../tests/support/source";
import { setObjectStore } from "../../src/object-store";
import { REPORT_RENDER_TIMEOUT_MS } from "../../src/reports/engines";
import { startWorker, type StartedWorker } from "../support/worker";

const DEF = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: {
    source: "account_balance",
    filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
  },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
    { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
  ],
  groups: [],
  totals: [{ field: "base_debit", fn: "sum" }],
  sort: [{ field: "account_code", dir: "asc" }],
  layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
  tieOut: { kind: "ledger_sum" },
};

describe("the reporting.render job — contracts §4.11.2, ADR 0066/0067", () => {
  let w: StartedWorker;
  let store: MemoryObjectStore;
  let s: Seed;
  let definitionId: string;

  beforeAll(async () => {
    store = new MemoryObjectStore();
    setObjectStore(store);
    w = await startWorker();
    s = await seedTenantV2(w.db, "render-job");
    // `JournalLine` names the field `account`, not `accountId` (§4.17.1, 1B). seedTenant's 1000/4000.
    await postJournal(w.db, s, [
      { account: s.cash, debit: "42.0000" },
      { account: s.sales, credit: "42.0000" },
    ]);
    definitionId = await seedReportDefinition(w.db, s, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
  });
  afterAll(async () => {
    await w.stop();
  });

  const asHuman = async <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(w.db.admin) },
      fn,
    );
  const queue = (
    format: "csv" | "xlsx" | "pdf",
    lang: "en" | "ar" = "en",
    reportDefinitionId = definitionId,
    parameters: Record<string, string> = { fiscalPeriodId: s.period },
  ) =>
    asHuman((tx) =>
      createReportRun(tx, { companyId: s.company, reportDefinitionId, parameters, format, lang }),
    );
  const read = (runId: string) => asHuman((tx) => getReportRun(tx, runId));
  const render = async (runId: string) =>
    w.run("reporting.render", {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload: { runId },
    });
  const text = (key: string) => new TextDecoder().decode(store.objects.get(key)!.bytes);

  it("drives a run queued → done and stores the CSV under the derived key", async () => {
    const run = await queue("csv");
    await render(run.id);
    const done = await read(run.id);
    expect(done!.status).toBe("done");
    expect(done!.error).toBeNull();
    expect(done!.finishedAt).not.toBeNull();
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "csv", 1));
    const stored = store.objects.get(done!.objectKey!)!;
    expect(stored.contentType).toBe("text/csv; charset=utf-8");
    const csv = text(done!.objectKey!);
    expect(csv).toContain("Code,Debit");
    expect(csv).toContain("1000,42.0000");
    expect(csv).toContain("42.0000");
  });

  it("records the sha256 of the stored bytes, so a download can be verified", async () => {
    const run = await queue("csv");
    await render(run.id);
    const done = await read(run.id);
    const stored = store.objects.get(done!.objectKey!)!;
    expect(done!.sha256).toBe(createHash("sha256").update(stored.bytes).digest("hex"));
  });

  it("renders in Arabic with the Arabic labels", async () => {
    const run = await queue("csv", "ar");
    await render(run.id);
    const csv = text((await read(run.id))!.objectKey!);
    expect(csv).toContain("الرمز");
    expect(csv).toContain("مدين");
  });

  it("renders XLSX through the same path, under the format's own extension", async () => {
    const run = await queue("xlsx");
    await render(run.id);
    const done = await read(run.id);
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "xlsx", 1));
    // An XLSX file is a ZIP container: "PK".
    expect([...store.objects.get(done!.objectKey!)!.bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it("a re-delivery is harmless: the second run of the same job stores nothing new", async () => {
    const run = await queue("csv");
    const envelope = {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload: { runId: run.id },
    };
    await w.run("reporting.render", envelope);
    const before = store.objects.size;
    const first = await read(run.id);
    await w.run("reporting.render", envelope);
    expect(store.objects.size).toBe(before);
    expect(await read(run.id)).toEqual(first);
  });

  // ── Phase 7 review, finding 2: a claim held by a worker that died ─────────────────────────────────────
  /** Moves a run's claim `minutesAgo` into the past (and sets its claim count), as the clock would. */
  const age = (runId: string, minutesAgo: number, claims?: number) =>
    asHuman(async (tx) => {
      const attempts = claims === undefined ? tx`` : tx`, attempts = ${claims}`;
      await tx`
        update app.report_run set started_at = now() - make_interval(mins => ${minutesAgo}) ${attempts}
         where id = ${runId}::uuid`;
    });
  /** What a worker that died after its claim leaves behind: the row `running`, its claim `minutesAgo` old. */
  const abandon = async (runId: string, minutesAgo: number, claims?: number) => {
    await asHuman((tx) => claimReportRun(tx, runId));
    await age(runId, minutesAgo, claims);
  };

  it("a redelivered job reclaims a run whose claim outlived its lease, and finishes it (7 review)", async () => {
    const run = await queue("csv");
    await abandon(run.id, REPORT_RUN_LEASE_SECONDS / 60 + 1);
    await render(run.id);
    const done = await read(run.id);
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "csv", 2)); // the reclaim's
  });

  /** The follow-up deliveries pg-boss holds for a run — what will reach it after a live claim lapses. */
  const followUps = (runId: string) =>
    w.db.admin<
      { singleton_key: string; due_in: number; after_lease: boolean; retry_limit: number }[]
    >`
      select j.singleton_key,
             extract(epoch from j.start_after - now())::int as due_in,
             j.start_after > r.started_at + make_interval(secs => ${REPORT_RUN_LEASE_SECONDS}) as after_lease,
             j.retry_limit
        from pgboss.job j join app.report_run r on r.id = ${runId}::uuid
       where j.name = 'reporting.render' and j.data -> 'payload' ->> 'runId' = ${runId}
         and j.singleton_key like ${`${runId}:lease:%`}
       order by j.singleton_key`;

  it("a delivery that finds a LIVE claim schedules ONE follow-up after the lease and spends no retry — the run is never stolen (7 second review, finding 1)", async () => {
    const run = await queue("csv");
    await abandon(run.id, 1);
    // More deliveries than pg-boss's whole retry budget: a THROW on each spent one retry, and the budget ran out
    // before the lease lapsed. Each now returns, and the claim gets exactly one follow-up delivery.
    for (let i = 0; i < REPORT_RUN_JOB_OPTIONS.retryLimit + 2; i += 1) await render(run.id);
    expect((await read(run.id))!.status).toBe("running");
    const due = await followUps(run.id);
    expect(due).toHaveLength(1);
    expect(due[0]!.singleton_key).toBe(leaseFollowUpKey(run.id, 1));
    expect(due[0]!.after_lease).toBe(true); // it arrives to a claim it can take over
    expect(due[0]!.due_in).toBeLessThanOrEqual(REPORT_RUN_LEASE_SECONDS + 60);
    expect(due[0]!.retry_limit).toBe(REPORT_RUN_JOB_OPTIONS.retryLimit); // a full budget of its own
  });

  it("exhaustion: a run whose every worker dies ends FAILED, each claim having a delivery due after its lease (7 second review, finding 1)", async () => {
    const run = await queue("csv");
    for (let claim = 1; claim <= REPORT_RUN_MAX_CLAIMS; claim += 1) {
      // A worker claims (the first delivery, or the previous claim's follow-up) and dies mid-render…
      await abandon(run.id, 1);
      expect((await read(run.id))!.attempts).toBe(claim);
      // …a duplicate delivery finds its claim live and schedules that claim's follow-up, spending no retry.
      await render(run.id);
      const due = await followUps(run.id);
      expect(due.map((d) => d.singleton_key)).toContain(leaseFollowUpKey(run.id, claim));
      expect(
        due.find((d) => d.singleton_key === leaseFollowUpKey(run.id, claim))!.after_lease,
      ).toBe(true);
      // The lease lapses (the clock moves past it) before the follow-up arrives.
      await age(run.id, REPORT_RUN_LEASE_SECONDS / 60 + 1);
    }
    // The last claim's follow-up arrives: the claim after REPORT_RUN_MAX_CLAIMS fails the run.
    await render(run.id);
    const failed = await read(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/^ERR_INTERNAL: the run was claimed 3 times/);
  });

  it("a run abandoned REPORT_RUN_MAX_CLAIMS times is failed, not left running (7 review)", async () => {
    const run = await queue("csv");
    await abandon(run.id, REPORT_RUN_LEASE_SECONDS / 60 + 1, REPORT_RUN_MAX_CLAIMS);
    await render(run.id);
    const failed = await read(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/^ERR_INTERNAL: /);
    expect(failed!.objectKey).toBeNull();
  });

  it("a superseded claim cannot complete: the attempt it claimed fences its writes (7 review)", async () => {
    const run = await queue("csv");
    const stale = (await asHuman((tx) => claimReportRun(tx, run.id)))!;
    await age(run.id, REPORT_RUN_LEASE_SECONDS / 60 + 1);
    await render(run.id); // the redelivery reclaims and finishes
    const done = await read(run.id);
    expect(done!.status).toBe("done");
    // The worker that was presumed dead wakes up and reports a failure: it no longer holds the claim.
    await asHuman((tx) =>
      failReportRun(tx, { runId: run.id, error: "ERR_INTERNAL: late", attempt: stale.attempts }),
    );
    expect(await read(run.id)).toEqual(done);
  });

  it("a superseded worker that wakes up never overwrites its successor's artefact — the stored bytes are always the recorded digest's (7 second review, finding 2)", async () => {
    // Fencing guarded the row, not the store: under ONE key per run, the presumed-dead worker's late `put`
    // replaced the bytes whose sha256 its successor had recorded, and every download then failed integrity.
    let releaseStale!: () => void;
    let staleReachedPut!: () => void;
    const reachedPut = new Promise<void>((resolve) => (staleReachedPut = resolve));
    const released = new Promise<void>((resolve) => (releaseStale = resolve));
    let puts = 0;
    const gated: ObjectStore = {
      put: async (key, bytes, contentType) => {
        puts += 1;
        if (puts === 1) {
          staleReachedPut();
          await released; // the first worker stalls here, past its lease
        }
        await store.put(key, bytes, contentType);
      },
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
    };
    setObjectStore(gated);
    try {
      const run = await queue("csv");
      const stale = render(run.id); // claim #1, renders, stalls in put
      await reachedPut;
      // The books move and the claim lapses; the follow-up reclaims (#2), renders the NEW figures and finishes.
      await postJournal(w.db, s, [
        { account: s.cash, debit: "7.0000" },
        { account: s.sales, credit: "7.0000" },
      ]);
      await age(run.id, REPORT_RUN_LEASE_SECONDS / 60 + 1);
      await render(run.id);
      const done = (await read(run.id))!;
      expect(done.status).toBe("done");
      expect(done.attempts).toBe(2);
      // The stale worker wakes up and stores its (old) bytes, then finds its claim fenced.
      releaseStale();
      await stale;
      expect(await read(run.id)).toEqual(done);
      const served = (await store.get(done.objectKey!))!;
      expect(createHash("sha256").update(served.bytes).digest("hex")).toBe(done.sha256);
      // …and the object the superseded claim stored is discarded, not left as an orphan.
      expect(await store.get(reportObjectKeyFor(s.tenant, run.id, "csv", 1))).toBeNull();
    } finally {
      setObjectStore(store);
    }
  });

  it("the lease outlives the PDF engine's own timeout, and the job's options redeliver after it (7 review)", () => {
    expect(REPORT_RUN_LEASE_SECONDS * 1000).toBeGreaterThan(REPORT_RENDER_TIMEOUT_MS);
    expect(REPORT_RUN_JOB_OPTIONS.expireInSeconds).toBe(REPORT_RUN_LEASE_SECONDS);
    // Enough deliveries for every allowed claim plus the one that fails an abandoned run.
    expect(REPORT_RUN_JOB_OPTIONS.retryLimit).toBeGreaterThan(REPORT_RUN_MAX_CLAIMS);
  });

  it("re-checks the stored definition's gate when it renders: a wider gate fails the run before any row is read (7 second review, finding 8)", async () => {
    // Rows written straight to the table — as one written before the gate rules, or by a path that bypassed the
    // store, would be. The first opens the audit trail to accounting.report.read; the second prints the lines'
    // booked cost under the same code.
    const widened = await seedReportDefinition(w.db, s, {
      code: "accounting.audit_log",
      definition: {
        ...DEF,
        code: "accounting.audit_log",
        parameters: [],
        dataset: { source: "audit_log", filters: [] },
        columns: [
          {
            field: "table_name",
            labelEn: "Table",
            labelAr: "الجدول",
            format: "text",
            align: "start",
          },
        ],
        totals: [],
        sort: [],
      },
    });
    const costly = await seedReportDefinition(w.db, s, {
      code: "accounting.line_cost",
      definition: {
        ...DEF,
        code: "accounting.line_cost",
        parameters: [],
        dataset: { source: "document_line", filters: [] },
        columns: [
          { field: "line_no", labelEn: "Line", labelAr: "السطر", format: "text", align: "start" },
          { field: "cost", labelEn: "Cost", labelAr: "التكلفة", format: "money", align: "end" },
        ],
        totals: [],
        sort: [],
      },
    });
    for (const [definition, reason] of [
      [widened, /^ERR_VALIDATION_FAILED: .*\/permission dataset 'audit_log' may be gated only on/],
      [
        costly,
        /^ERR_VALIDATION_FAILED: .*column 'cost' of dataset 'document_line' needs 'inventory\.cost\.read'/,
      ],
    ] as const) {
      const run = await queue("csv", "en", definition, {});
      await render(run.id);
      const failed = await read(run.id);
      expect(failed!.status).toBe("failed");
      expect(failed!.error).toMatch(reason);
      expect(failed!.objectKey).toBeNull();
    }
  });

  it("a bad definition fails the RUN, not the job, and the reason reaches the status resource", async () => {
    const broken = await seedReportDefinition(w.db, s, {
      code: "accounting.general_ledger",
      definition: {
        ...DEF,
        code: "accounting.general_ledger",
        dataset: { source: "invoices", filters: [] },
      },
    });
    const run = await queue("csv", "en", broken, {});
    await render(run.id);
    const failed = await read(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/^ERR_REPORT_DATASET_UNKNOWN: /);
    expect(failed!.objectKey).toBeNull();
  });

  it("a stored definition the schema refuses fails the run with ERR_VALIDATION_FAILED", async () => {
    const malformed = await seedReportDefinition(w.db, s, {
      code: "accounting.malformed",
      definition: { ...DEF, code: "accounting.malformed", columns: [] },
    });
    const run = await queue("csv", "en", malformed, {});
    await render(run.id);
    const failed = await read(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toMatch(/^ERR_VALIDATION_FAILED: /);
  });

  it("runs as the tenant's SYSTEM principal, and every write is audited under it (hazard 20)", async () => {
    const run = await queue("csv");
    await render(run.id);
    const rows = await w.db.admin<{ actor_id: string; action: string }[]>`
      select actor_id, action from app.audit_log
       where table_name = 'report_run' and row_id = ${run.id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(rows[0]!.actor_id).toBe(s.human); // the request is the human's
    expect(rows[1]!.actor_id).toBe(s.system); // the status moves are the system principal's
    expect(rows[2]!.actor_id).toBe(s.system);
    expect((await read(run.id))!.requestedBy).toBe(s.human);
  });

  it("renders a STATEMENT definition through statementRows, not through a plain dataset read", async () => {
    // The one end-to-end proof that `STATEMENT_CODES` is wired into the run path: this definition groups on
    // `section_label` and sorts on `section_rank`, which `account_balance` does NOT declare as columns — so a handler that called
    // `datasetFor(source).run` directly would render an empty Section column with a total that still added up.
    const statement = statementDefinition("balance_sheet", {
      code: "accounting.balance_sheet",
      nameEn: "Balance sheet",
      nameAr: "الميزانية العمومية",
      permission: "accounting.report.read",
    });
    const definition = await seedReportDefinition(w.db, s, {
      code: "accounting.balance_sheet",
      definition: statement,
    });
    const run = await queue("csv", "en", definition);
    await render(run.id);

    const done = await read(run.id);
    expect(done!.error).toBeNull();
    expect(done!.status).toBe("done");
    const csv = new TextDecoder().decode((await store.get(done!.objectKey!))!.bytes);
    expect(csv).toContain("Section"); // the header
    // The annotated heading — the whole point of the dispatch — in the run's language, never the raw token.
    expect(csv).toContain("Assets");
    expect(csv).not.toMatch(/(^|,)asset(,|\r)/m);

    const arabic = await queue("csv", "ar", definition);
    await render(arabic.id);
    const doneAr = await read(arabic.id);
    expect(doneAr!.status).toBe("done");
    const csvAr = new TextDecoder().decode((await store.get(doneAr!.objectKey!))!.bytes);
    expect(csvAr).toContain("الأصول");
  });

  it("renders an 8D code through the unchanged job — hr.annual_statement reaches done (spec:2083, 8D T6)", async () => {
    const envelope = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/db/seed/my/reports/8d/hr.annual_statement.json"),
        "utf8",
      ),
    ) as { definition: unknown };
    const annualId = await seedReportDefinition(w.db, s, {
      code: "hr.annual_statement",
      definition: envelope.definition,
    });
    const run = await queue("csv", "en", annualId, { taxYear: "2026" });
    await render(run.id);

    const done = await read(run.id);
    expect(done!.error).toBeNull();
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "csv", 1));
    expect(done!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A statement over an EMPTY employee_ytd is a legitimate zero-row report, not a failure: this file's seed has no
    // payroll. What is proved here is that 7A's job accepts an 8D definition unchanged — the figures are proved in
    // packages/db (hr-definitions.test.ts), against a corpus that has them.
    expect(store.objects.get(done!.objectKey!)!.contentType).toBe("text/csv; charset=utf-8");
    expect(text(done!.objectKey!)).toContain("Gross for the year");
  });
});
