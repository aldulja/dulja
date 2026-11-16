import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXPORT_JOB_JOB_OPTIONS,
  EXPORT_JOB_LEASE_SECONDS,
  EXPORT_JOB_MAX_CLAIMS,
  exportObjectKeyFor,
  getExportJob,
  leaseFollowUpKey,
  MemoryObjectStore,
  objectKeyFor,
  type ObjectStore,
} from "@dulja/db";
// `seedExportJob` is a FIXTURE (`packages/db/test/fixtures.ts`), reachable only through the `./test` subpath.
import {
  seedExportJob,
  seedItem,
  seedLot,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { setObjectStore } from "../../src/object-store";
import { startWorker, type StartedWorker } from "../support/worker";

describe("the admin.export.run handler — §4.2.6, hazard 20, ADR 0070", () => {
  let w: StartedWorker;
  let s: Seed;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    w = await startWorker();
    s = await seedTenantV2(w.db, "export-job");
    store = new MemoryObjectStore();
    setObjectStore(store);
  }, 300_000);
  afterAll(async () => {
    await w.stop();
  });

  const run = async (exportJobId: string) =>
    w.run("admin.export.run", {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload: { exportJobId },
    });
  const read = (jobId: string) =>
    withTenant(w.db.rw, s.tenant, s.human, (tx) => getExportJob(tx, jobId));

  it("claims the row, writes the archive to the store and completes it", async () => {
    const jobId = await seedExportJob(w.db, s);
    await run(jobId);
    const row = await read(jobId);
    expect(row!.status).toBe("done");
    expect(row!.objectKey).toBe(exportObjectKeyFor(s.tenant, jobId, 1));
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tableCount).toBeGreaterThan(0);
    const stored = await store.get(row!.objectKey!);
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe("application/gzip");
    // The recorded digest and size are those of the bytes in the store.
    expect(createHash("sha256").update(stored!.bytes).digest("hex")).toBe(row!.sha256);
    expect(row!.byteSize).toBe(String(stored!.bytes.byteLength));
    // …and the manifest on the row is the one inside the archive, stamped with the claim's time.
    const manifest = row!.manifest as { exportJobId: string; generatedAt: string };
    expect(manifest.exportJobId).toBe(jobId);
    expect(manifest.generatedAt).toBe(row!.startedAt);
    expect(gunzipSync(Buffer.from(stored!.bytes)).includes(Buffer.from("manifest.json"))).toBe(
      true,
    );
  });

  it("runs as the tenant's SYSTEM principal, and each status move is audited under it (hazard 20, test 13)", async () => {
    const jobId = await seedExportJob(w.db, s);
    await run(jobId);
    const rows = await w.db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'export_job' and row_id = ${jobId} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]); // create, claim, complete
    expect(rows[0]!.actor_id).toBe(s.human);
    expect(rows[1]!.actor_id).toBe(s.system);
    expect(rows[2]!.actor_id).toBe(s.system);
    // The REQUESTER stays the requester: the system principal never becomes `requested_by`.
    expect((await read(jobId))!.requestedBy).toBe(s.human);
  });

  it("a re-delivery of a completed job is a no-op, not a second archive", async () => {
    const jobId = await seedExportJob(w.db, s);
    await run(jobId);
    const first = await read(jobId);
    const puts = store.objects.size;
    await run(jobId);
    const second = await read(jobId);
    expect(second!.finishedAt).toBe(first!.finishedAt);
    expect(second!.sha256).toBe(first!.sha256);
    expect(store.objects.size).toBe(puts);
  });

  it("a store failure fails the row with its reason rather than leaving it running", async () => {
    const failing: ObjectStore = {
      put: () => Promise.reject(new Error("object store unavailable")),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    };
    setObjectStore(failing);
    try {
      const jobId = await seedExportJob(w.db, s);
      await run(jobId);
      const row = await read(jobId);
      expect(row!.status).toBe("failed");
      expect(row!.error).toContain("object store unavailable");
      expect(row!.objectKey).toBeNull();
    } finally {
      setObjectStore(store);
    }
  });

  // ── Phase 7 review, finding 2: a claim held by a worker that died ─────────────────────────────────────
  /** What a worker that died after its claim leaves behind: the row `running`, its claim `minutesAgo` old. */
  const abandon = async (jobId: string, minutesAgo: number, claims?: number) => {
    await withTenant(w.db.rw, s.tenant, s.system, async (tx) => {
      const attempts = claims === undefined ? tx`` : tx`, attempts = ${claims}`;
      await tx`
        update app.export_job
           set status = 'running', started_at = now() - make_interval(mins => ${minutesAgo}) ${attempts}
         where id = ${jobId}::uuid`;
    });
  };

  it("a redelivered job reclaims an export whose claim outlived its lease, and finishes it (7 review)", async () => {
    const jobId = await seedExportJob(w.db, s);
    await abandon(jobId, EXPORT_JOB_LEASE_SECONDS / 60 + 1);
    await run(jobId);
    const row = await read(jobId);
    expect(row!.status).toBe("done");
    expect(row!.objectKey).toBe(exportObjectKeyFor(s.tenant, jobId, 1)); // seeded unclaimed: the reclaim is #1
  });

  /** The follow-up deliveries pg-boss holds for an export — what will reach it after a live claim lapses. */
  const followUps = (jobId: string) =>
    w.db.admin<{ singleton_key: string; after_lease: boolean; retry_limit: number }[]>`
      select j.singleton_key,
             j.start_after > e.started_at + make_interval(secs => ${EXPORT_JOB_LEASE_SECONDS}) as after_lease,
             j.retry_limit
        from pgboss.job j join app.export_job e on e.id = ${jobId}::uuid
       where j.name = 'admin.export.run' and j.data -> 'payload' ->> 'exportJobId' = ${jobId}
         and j.singleton_key like ${`${jobId}:lease:%`}
       order by j.singleton_key`;

  it("exhaustion: a LIVE claim gets ONE follow-up after the lease and spends no retry, and an export whose every worker dies ends FAILED (7 second review, finding 1)", async () => {
    // pg-boss's whole retry budget with backoff (60 + 120 + 240 + 480 + 960 s) is shorter than the hour's lease,
    // so throwing on a live claim ran it out and left the row `running` with no job. Each delivery now returns.
    const live = await seedExportJob(w.db, s);
    for (let claim = 1; claim <= EXPORT_JOB_MAX_CLAIMS; claim += 1) {
      await abandon(live, 1, claim);
      for (let i = 0; i < EXPORT_JOB_JOB_OPTIONS.retryLimit + 2; i += 1) await run(live);
      expect((await read(live))!.status).toBe("running");
      const due = (await followUps(live)).filter(
        (d) => d.singleton_key === leaseFollowUpKey(live, claim),
      );
      expect(due).toHaveLength(1); // one per claim, however many deliveries saw it live
      expect(due[0]!.after_lease).toBe(true);
      expect(due[0]!.retry_limit).toBe(EXPORT_JOB_JOB_OPTIONS.retryLimit);
    }
    // The last claim's lease lapses and its follow-up arrives: the claim after the maximum fails the export.
    await abandon(live, EXPORT_JOB_LEASE_SECONDS / 60 + 1, EXPORT_JOB_MAX_CLAIMS);
    await run(live);
    expect((await read(live))!.status).toBe("failed");

    const abandoned = await seedExportJob(w.db, s);
    await abandon(abandoned, EXPORT_JOB_LEASE_SECONDS / 60 + 1, EXPORT_JOB_MAX_CLAIMS);
    await run(abandoned);
    const row = await read(abandoned);
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/^ERR_INTERNAL: /);
    expect(EXPORT_JOB_JOB_OPTIONS.expireInSeconds).toBe(EXPORT_JOB_LEASE_SECONDS);
    expect(EXPORT_JOB_JOB_OPTIONS.retryLimit).toBeGreaterThan(EXPORT_JOB_MAX_CLAIMS);
  });

  it("a superseded worker that wakes up never overwrites its successor's archive — the stored bytes are always the recorded digest's (7 second review, finding 2)", async () => {
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
          await released;
        }
        await store.put(key, bytes, contentType);
      },
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
    };
    setObjectStore(gated);
    try {
      const jobId = await seedExportJob(w.db, s);
      const stale = run(jobId); // claim #1 builds its archive and stalls in put
      await reachedPut;
      // Its lease lapses; the follow-up reclaims (#2) and builds an archive stamped with ITS claim's time.
      await abandon(jobId, EXPORT_JOB_LEASE_SECONDS / 60 + 1);
      await run(jobId);
      const done = (await read(jobId))!;
      expect(done.status).toBe("done");
      expect(done.attempts).toBe(2);
      releaseStale();
      await stale;
      expect(await read(jobId)).toEqual(done);
      const served = (await store.get(done.objectKey!))!;
      expect(createHash("sha256").update(served.bytes).digest("hex")).toBe(done.sha256);
      expect(await store.get(exportObjectKeyFor(s.tenant, jobId, 1))).toBeNull();
    } finally {
      setObjectStore(store);
    }
  });

  it("no transaction is open while the attachment bytes are fetched (hazard 20, 7 review)", async () => {
    // Before the fix `runExport` ran wholly inside ONE `withTenant`, holding an `app_rw` transaction open across
    // every object-store `get`: a slow R2 round-trip per attachment pinned a pooled connection and its
    // snapshot. Now the rows are read in the transaction and the bytes fetched after it has committed.
    const bytes = new TextEncoder().encode("attachment bytes");
    const attachmentId = await uuidv7(w.db.admin);
    const key = objectKeyFor(s.tenant, attachmentId);
    await store.put(key, bytes, "application/pdf");
    // A lot attachment: the owner CHECK wants a document or a lot, and a lot needs no posting.
    const { itemId } = await seedItem(w.db, s, { code: "EXP-ATT", trackLots: true });
    const lotId = await seedLot(w.db, s, { itemId, code: "EXP-ATT-1" });
    await withTenant(
      w.db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.attachment
          (id, tenant_id, company_id, lot_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${attachmentId}, ${s.tenant}, ${s.company}, ${lotId}, ${key}, 'evidence.pdf', 'application/pdf',
                ${bytes.byteLength}, ${createHash("sha256").update(bytes).digest()})`,
    );
    const openDuringGet: number[] = [];
    const watching: ObjectStore = {
      put: (k, b, t) => store.put(k, b, t),
      delete: (k) => store.delete(k),
      get: async (k) => {
        const [row] = await w.db.admin<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where usename = 'app_rw' and state like 'idle in transaction%'`;
        openDuringGet.push(row!.n);
        return store.get(k);
      },
    };
    setObjectStore(watching);
    try {
      const jobId = await seedExportJob(w.db, s, {
        includeAttachments: true,
        lotAttachments: true,
      });
      await run(jobId);
      const row = await read(jobId);
      expect(row!.status).toBe("done");
      const manifest = row!.manifest as { attachments: { id: string }[] };
      expect(manifest.attachments.map((a) => a.id)).toContain(attachmentId);
      expect(openDuringGet.length).toBeGreaterThan(0);
      expect(openDuringGet.every((n) => n === 0)).toBe(true);
    } finally {
      setObjectStore(store);
    }
  });

  it("a long failure reason is capped as a report run's is, never stored uncapped (7 review)", async () => {
    const failing: ObjectStore = {
      put: () => Promise.reject(new Error("x".repeat(5000))),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    };
    setObjectStore(failing);
    try {
      const jobId = await seedExportJob(w.db, s);
      await run(jobId);
      const row = await read(jobId);
      expect(row!.status).toBe("failed");
      expect(row!.error!.startsWith("ERR_INTERNAL: xxx")).toBe(true);
      expect(row!.error!.length).toBe(2000);
    } finally {
      setObjectStore(store);
    }
  });
});
