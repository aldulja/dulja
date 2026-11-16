import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimExportJob,
  EXPORT_JOB_JOB_OPTIONS,
  completeExportJob,
  exportObjectKeyFor,
  getExportJob,
  runExport,
  type JobClient,
} from "@dulja/db";
import {
  grantCodes,
  seedExportJob,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * The tenant data export's four routes (spec:2186, 2206, 2211; contracts §4.2.7 as amended by 7C A12; ADR
 * 0070): POST to request, GET to list and to read the status, GET …/content to download. 7C Task 6 shipped the
 * list; Task 9 the rest.
 */
describe("the export routes — admin.data.export at company scope", () => {
  let api: StartedApi;
  let s: Seed;
  let narrowed: string;
  let stranger: string;
  let colleague: string;
  const enqueued: { name: string; tenantId: string; payload: unknown; options?: unknown }[] = [];

  // Records the enqueue the POST makes in its own transaction; nothing in this suite posts a document.
  const jobs: JobClient = {
    enqueue: async (_tx, name, envelope, options) => {
      enqueued.push({ name, tenantId: envelope.tenantId, payload: envelope.payload, options });
      return `route-test:${name}:${enqueued.length}`;
    },
  } as JobClient;

  beforeAll(async () => {
    api = await startApi({ jobs });
    s = await seedTenantV2(api.db, "exports-routes");
    // The requester: the export code, and the accounting module's read code — so `accounting` is the one
    // module whose attachments they may read (§4.5.8).
    await grantCodes(api.db, s, { codes: ["admin.data.export", "accounting.ledger.read"] });
    // A branch-narrowed holder of the same code: app.actor_has(code, company, null) is false for it (test 36).
    // A member with no role at all is the plain refusal. A colleague holds the code company-wide.
    narrowed = await uuidv7(api.db.admin);
    stranger = await uuidv7(api.db.admin);
    colleague = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      for (const [id, label] of [
        [narrowed, "narrowed"],
        [stranger, "stranger"],
        [colleague, "colleague"],
      ] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      }
    });
    await grantCodes(api.db, s, {
      codes: ["admin.data.export"],
      principalId: narrowed,
      branchIds: [s.hq],
    });
    await grantCodes(api.db, s, { codes: ["admin.data.export"], principalId: colleague });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => api.stop());

  const exportsPath = () => `/v1/companies/${s.company}/exports`;
  const post = (body: unknown, as = s.human, idempotencyKey?: string | null) =>
    api.request({
      method: "POST",
      path: exportsPath(),
      body,
      as,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });

  /** Runs the queued export inline as the system principal, as the worker's handler would. */
  async function completeByHand(exportJobId: string): Promise<void> {
    // Claim, read, store, record — the worker's short transactions, never one across the store.
    const asSystem = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
      withTenant(api.db.rw, s.tenant, s.system, fn);
    const job = (await asSystem((tx) => claimExportJob(tx, exportJobId)))!;
    const result = await runExport(asSystem, api.objectStore, {
      job,
      tenantId: s.tenant,
      generatedAt: job.startedAt!,
    });
    const objectKey = exportObjectKeyFor(s.tenant, exportJobId, job.attempts);
    await api.objectStore.put(objectKey, result.bytes, "application/gzip");
    await asSystem(async (tx) => {
      await completeExportJob(tx, {
        id: exportJobId,
        objectKey,
        sha256: result.sha256,
        byteSize: result.bytes.byteLength,
        tableCount: result.tableCount,
        rowCount: result.rowCount,
        manifest: result.manifest,
      });
    });
  }

  it("lists the caller's jobs newest first, without the object key", async () => {
    const first = await seedExportJob(api.db, s);
    const second = await seedExportJob(api.db, s, { status: "done" });
    const response = await api.request({
      method: "GET",
      path: `${exportsPath()}?limit=1`,
      as: s.human,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
      next_cursor: string | null;
    };
    expect(body.items.map((item) => item.id)).toEqual([second]);
    expect(body.items[0]).not.toHaveProperty("objectKey");
    expect(body.next_cursor).not.toBeNull();
    const next = await api.request({
      method: "GET",
      path: `${exportsPath()}?limit=1&cursor=${body.next_cursor}`,
      as: s.human,
    });
    expect(((await next.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      first,
    ]);
    const done = await api.request({
      method: "GET",
      path: `${exportsPath()}?filter[status][eq]=done`,
      as: s.human,
    });
    const doneIds = ((await done.json()) as { items: { id: string; status: string }[] }).items;
    expect(doneIds.map((i) => i.id)).toContain(second);
    expect(doneIds.every((i) => i.status === "done")).toBe(true);
  });

  it("POST accepts with 202 and a status URL, enqueues the job, and records the gate snapshot", async () => {
    const before = enqueued.length;
    const res = await post({ format: "both", includeAttachments: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { exportJobId: string; jobId: string; statusUrl: string };
    // The status URL is the RESOURCE, never `/v1/jobs/{jobId}` (ADR 0067); the next request follows it verbatim.
    expect(body.statusUrl).toBe(`${exportsPath()}/${body.exportJobId}`);
    // …with the lease's options stated, so a worker that dies mid-export is redelivered and the job reclaimed
    // (Phase 7 review, finding 2).
    expect(enqueued.slice(before)).toEqual([
      {
        name: "admin.export.run",
        tenantId: s.tenant,
        payload: { exportJobId: body.exportJobId },
        options: EXPORT_JOB_JOB_OPTIONS,
      },
    ]);
    const status = await api.request({ method: "GET", path: body.statusUrl, as: s.human });
    expect(status.status).toBe(200);
    const job = (await status.json()) as Record<string, unknown>;
    expect(job).toMatchObject({
      status: "queued",
      format: "both",
      requestedBy: s.human,
      // accounting.ledger.read is held, inventory.stock.read and pos.report.read are not.
      readableModules: ["accounting"],
      lotAttachments: false,
      includeAttachments: true,
      manifest: null,
    });
    expect(job).not.toHaveProperty("objectKey");
  });

  it("the body defaults to both formats with attachments, and refuses an unknown format or field", async () => {
    const res = await post({});
    expect(res.status).toBe(202);
    const { exportJobId } = (await res.json()) as { exportJobId: string };
    const row = await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      getExportJob(tx, exportJobId),
    );
    expect(row).toMatchObject({ format: "both", includeAttachments: true });
    for (const body of [{ format: "xml" }, { format: "csv", requestedBy: colleague }]) {
      const refused = await post(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect((await problemOf(refused)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("POST without the Idempotency-Key header is refused (spec:2055)", async () => {
    const res = await post({ format: "both" }, s.human, null);
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a replay of the same key returns the same exportJobId and enqueues nothing new", async () => {
    const key = crypto.randomUUID();
    const first = await post({ format: "csv" }, s.human, key);
    const count = enqueued.length;
    const second = await post({ format: "csv" }, s.human, key);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(enqueued.length).toBe(count);
  });

  it("GET …/content on a queued job is 404, not an empty body", async () => {
    const { exportJobId } = (await (await post({ format: "both" })).json()) as {
      exportJobId: string;
    };
    const res = await api.request({
      method: "GET",
      path: `${exportsPath()}/${exportJobId}/content`,
      as: s.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("GET …/content on a done job serves the archive with its digest header", async () => {
    const { exportJobId } = (await (await post({ format: "both" })).json()) as {
      exportJobId: string;
    };
    await completeByHand(exportJobId);
    const res = await api.request({
      method: "GET",
      path: `${exportsPath()}/${exportJobId}/content`,
      as: s.human,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain(`dulja-export-${exportJobId}.tar.gz`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(gunzipSync(bytes).includes(Buffer.from("schema.json"))).toBe(true);
    // The status resource now carries the manifest the archive does, and its digest.
    const job = (await (
      await api.request({ method: "GET", path: `${exportsPath()}/${exportJobId}`, as: s.human })
    ).json()) as { status: string; sha256: string; manifest: { exportJobId: string } };
    expect(job.status).toBe("done");
    expect(job.sha256).toBe(res.headers.get("x-content-sha256"));
    expect(job.manifest.exportJobId).toBe(exportJobId);
  });

  it("an archive whose stored bytes no longer match the recorded digest is never served", async () => {
    const { exportJobId } = (await (await post({ format: "csv" })).json()) as {
      exportJobId: string;
    };
    await completeByHand(exportJobId);
    await api.objectStore.put(
      exportObjectKeyFor(s.tenant, exportJobId, 1),
      new TextEncoder().encode("not the archive"),
      "application/gzip",
    );
    const res = await api.request({
      method: "GET",
      path: `${exportsPath()}/${exportJobId}/content`,
      as: s.human,
    });
    expect(res.status).toBe(500);
    expect((await problemOf(res)).code).toBe("ERR_INTERNAL");
  });

  it("another holder of admin.data.export cannot see, read or download the requester's export (ADR 0070)", async () => {
    // The archive was built under the REQUESTER's gates; a colleague who lacks one of them must not reach it.
    const { exportJobId } = (await (await post({ format: "both" })).json()) as {
      exportJobId: string;
    };
    await completeByHand(exportJobId);
    for (const path of [
      `${exportsPath()}/${exportJobId}`,
      `${exportsPath()}/${exportJobId}/content`,
    ]) {
      const res = await api.request({ method: "GET", path, as: colleague });
      expect(res.status, path).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
    const list = await api.request({ method: "GET", path: exportsPath(), as: colleague });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("a branch-narrowed holder of the code and a principal without it are 403 on every one of the four (test 36)", async () => {
    const id = await seedExportJob(api.db, s, { status: "done" });
    for (const as of [narrowed, stranger]) {
      for (const [method, path] of [
        ["POST", exportsPath()],
        ["GET", exportsPath()],
        ["GET", `${exportsPath()}/${id}`],
        ["GET", `${exportsPath()}/${id}/content`],
      ] as const) {
        const res = await api.request({
          method,
          path,
          as,
          ...(method === "POST" ? { body: { format: "both" } } : {}),
        });
        expect(res.status, `${as} ${method} ${path}`).toBe(403);
        expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
      }
    }
  });
});
