import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimExportJob,
  completeExportJob,
  createExportJob,
  exportObjectKeyFor,
  failExportJob,
  getExportJob,
  listExportJobs,
} from "../../src/export/store";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("the export-job store (contracts §4.6.1, 7C Task 5)", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "export-store");
  });
  afterAll(async () => {
    await db.stop();
  });

  const write = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, s.tenant, s.human, fn);

  it("exportObjectKeyFor is derived from ids alone (LEGACY-038)", () => {
    expect(exportObjectKeyFor("t-1", "j-1", 2)).toBe("t-1/exports/j-1/2.tar.gz");
  });

  it("a new job is queued with the recorded gates and no artefact", async () => {
    const row = await write((tx) =>
      createExportJob(tx, {
        companyId: s.company,
        format: "both",
        readableModules: ["accounting", "inventory"],
        lotAttachments: true,
        includeAttachments: true,
      }),
    );
    expect(row.status).toBe("queued");
    expect(row.companyId).toBe(s.company);
    expect(row.requestedBy).toBe(s.human);
    expect([...row.readableModules]).toEqual(["accounting", "inventory"]);
    expect(row.lotAttachments).toBe(true);
    expect(row.objectKey).toBeNull();
    expect(row.sha256).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("claim is conditional — the second claim of one job returns null", async () => {
    const row = await write((tx) =>
      createExportJob(tx, {
        companyId: s.company,
        format: "csv",
        readableModules: ["accounting"],
        lotAttachments: false,
        includeAttachments: false,
      }),
    );
    const claimed = await write((tx) => claimExportJob(tx, row.id));
    expect(claimed!.status).toBe("running");
    expect(claimed!.startedAt).not.toBeNull();
    expect(await write((tx) => claimExportJob(tx, row.id))).toBeNull();
  });

  it("complete records the artefact, the counts and the manifest; sha256 comes back as hex", async () => {
    const row = await write((tx) =>
      createExportJob(tx, {
        companyId: s.company,
        format: "both",
        readableModules: ["accounting"],
        lotAttachments: false,
        includeAttachments: true,
      }),
    );
    await write((tx) => claimExportJob(tx, row.id));
    const bytes = new TextEncoder().encode("archive");
    const digest = createHash("sha256").update(bytes).digest();
    await write((tx) =>
      completeExportJob(tx, {
        id: row.id,
        objectKey: exportObjectKeyFor(s.tenant, row.id, 1),
        sha256: digest,
        byteSize: bytes.byteLength,
        tableCount: 4,
        rowCount: 17,
        manifest: { tables: [], excluded: [] },
      }),
    );
    const done = await write((tx) => getExportJob(tx, row.id));
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(exportObjectKeyFor(s.tenant, row.id, 1));
    expect(done!.sha256).toBe(digest.toString("hex"));
    expect(done!.byteSize).toBe("7");
    expect(done!.rowCount).toBe("17");
    expect(done!.tableCount).toBe(4);
    expect(done!.manifest).toEqual({ tables: [], excluded: [] });
    expect(done!.finishedAt).not.toBeNull();
    // A job that is no longer running cannot be completed twice or failed afterwards.
    await write((tx) => failExportJob(tx, { id: row.id, error: "late" }));
    expect((await write((tx) => getExportJob(tx, row.id)))!.status).toBe("done");
  });

  it("fail records the message and leaves no artefact", async () => {
    const row = await write((tx) =>
      createExportJob(tx, {
        companyId: s.company,
        format: "json",
        readableModules: [],
        lotAttachments: false,
        includeAttachments: false,
      }),
    );
    await write((tx) => claimExportJob(tx, row.id));
    await write((tx) => failExportJob(tx, { id: row.id, error: "object store unavailable" }));
    const failed = await write((tx) => getExportJob(tx, row.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("object store unavailable");
    expect(failed!.objectKey).toBeNull();
    expect(failed!.finishedAt).not.toBeNull();
  });

  it("list is keyset-paged on (created_at, id) newest first, and filters by status", async () => {
    const all = await write((tx) => listExportJobs(tx, { companyId: s.company, limit: 100 }));
    expect(all.length).toBeGreaterThanOrEqual(4);
    const page1 = await write((tx) => listExportJobs(tx, { companyId: s.company, limit: 2 }));
    expect(page1.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
    const last = page1[1]!;
    const page2 = await write((tx) =>
      listExportJobs(tx, {
        companyId: s.company,
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      }),
    );
    expect(page2.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id));
    const failed = await write((tx) =>
      listExportJobs(tx, { companyId: s.company, status: "failed", limit: 100 }),
    );
    expect(failed.map((r) => r.status)).toEqual(["failed"]);
  });

  it("list narrows to one requester's jobs when asked (7C T9, ADR 0070)", async () => {
    const mine = await write((tx) =>
      listExportJobs(tx, { companyId: s.company, requestedBy: s.human, limit: 100 }),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.requestedBy === s.human)).toBe(true);
    const nobody = await write((tx) =>
      listExportJobs(tx, { companyId: s.company, requestedBy: s.system, limit: 100 }),
    );
    expect(nobody).toEqual([]);
  });
});
