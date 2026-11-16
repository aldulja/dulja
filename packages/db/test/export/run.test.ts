import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore, objectKeyFor } from "../../src/attachment/object-store";
import { runExport } from "../../src/export/run";
import { getExportJob } from "../../src/export/store";
import {
  arApReportFixture,
  type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import { grantCodes, seedExportJob, seedItem, seedLot } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const GENERATED_AT = "2026-02-01T00:00:00Z";

/** Unpacks a `.tar.gz` into { path -> bytes }, in archive order. */
function unpack(bytes: Uint8Array): Map<string, Buffer> {
  const tarBytes = gunzipSync(Buffer.from(bytes));
  const out = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tarBytes.length;) {
    const name = tarBytes
      .subarray(at, at + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (name === "") break;
    const size = parseInt(
      tarBytes
        .subarray(at + 124, at + 135)
        .toString("ascii")
        .trim(),
      8,
    );
    out.set(name, tarBytes.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("runExport — spec:2186, spec:1067, ADR 0069", () => {
  let db: Db;
  let f: ArApReportFixture;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "export-run");
    store = new MemoryObjectStore();
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  const runFor = async (jobId: string, generatedAt = GENERATED_AT) => {
    const job = (await withTenant(db.rw, f.s.tenant, f.s.system, (tx) => getExportJob(tx, jobId)))!;
    return runExport((fn) => withTenant(db.rw, f.s.tenant, f.s.system, fn), store, {
      job,
      tenantId: f.s.tenant,
      generatedAt,
    });
  };

  /** An attachment row on `owner`, its bytes stored under its own key unless `stored` says otherwise. */
  const attach = async (
    owner: { documentId: string } | { lotId: string },
    fileName: string,
    content: string,
    stored: "same" | "none" | "tampered" = "same",
  ): Promise<string> => {
    const id = await uuidv7(db.admin);
    const key = objectKeyFor(f.s.tenant, id);
    const bytes = new TextEncoder().encode(content);
    if (stored === "same") await store.put(key, bytes, "application/pdf");
    if (stored === "tampered")
      await store.put(key, new TextEncoder().encode(`${content}!`), "application/pdf");
    await withTenant(
      db.rw,
      f.s.tenant,
      f.reader,
      (tx) => tx`
        insert into app.attachment
          (id, tenant_id, company_id, document_id, lot_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${id}, ${f.s.tenant}, ${f.s.company},
                ${"documentId" in owner ? owner.documentId : null}, ${"lotId" in owner ? owner.lotId : null},
                ${key}, ${fileName}, 'application/pdf', ${bytes.byteLength},
                ${createHash("sha256").update(bytes).digest()})`,
    );
    return id;
  };

  it("format 'both' writes schema.json first, manifest.json last and a CSV and a JSON per included table", async () => {
    const result = await runFor(
      await seedExportJob(db, f.s, { format: "both", readableModules: ["accounting"] }),
    );
    const files = [...unpack(result.bytes).keys()];
    expect(files[0]).toBe("schema.json");
    expect(files.at(-1)).toBe("manifest.json");
    expect(files).toContain("tables/account.csv");
    expect(files).toContain("tables/account.json");
    expect(result.manifest.tables.find((t) => t.name === "account")!.files).toEqual([
      "tables/account.csv",
      "tables/account.json",
    ]);
    expect(result.tableCount).toBe(result.manifest.tables.length);
    expect(result.rowCount).toBe(result.manifest.tables.reduce((a, t) => a + t.rowCount, 0));
    expect(result.sha256).toEqual(
      new Uint8Array(createHash("sha256").update(result.bytes).digest()),
    );
  });

  it("the table files carry the rows: the CSV header is the registry's column list and the JSON has one line per row", async () => {
    const result = await runFor(await seedExportJob(db, f.s, { format: "both" }));
    const files = unpack(result.bytes);
    const account = result.manifest.tables.find((t) => t.name === "account")!;
    const csv = files.get("tables/account.csv")!.toString("utf8").split("\n");
    expect(csv[0]!.split(",")).toContain("code");
    expect(csv.length - 2).toBe(account.rowCount); // the header and the final newline
    const json = files.get("tables/account.json")!.toString("utf8").trimEnd().split("\n");
    expect(json).toHaveLength(account.rowCount);
    expect(json.map((line) => (JSON.parse(line) as { code: string }).code)).toContain("4000");
  });

  it("format 'csv' writes no .json table file, and 'json' writes no .csv", async () => {
    const csv = await runFor(await seedExportJob(db, f.s, { format: "csv" }));
    const csvFiles = [...unpack(csv.bytes).keys()];
    expect(csvFiles.some((p) => p.endsWith(".json") && p.startsWith("tables/"))).toBe(false);
    const json = await runFor(await seedExportJob(db, f.s, { format: "json" }));
    expect([...unpack(json.bytes).keys()].some((p) => p.endsWith(".csv"))).toBe(false);
    // schema.json and manifest.json are present under EVERY format — spec:2186 requires the schema.
    expect(csvFiles).toContain("schema.json");
    expect(csvFiles).toContain("manifest.json");
  });

  it("a table whose gate the requester does not hold is absent and named in manifest.excluded", async () => {
    // seedExportJob's requester is `f.s.human` (`app.stamp_actor`), who holds no admin.audit_log.read.
    const result = await runFor(await seedExportJob(db, f.s, { readableModules: ["accounting"] }));
    expect([...unpack(result.bytes).keys()]).not.toContain("tables/audit_log.csv");
    expect(result.manifest.excluded).toContainEqual({
      table: "audit_log",
      gate: "admin.audit_log.read",
    });
    // …and the gate is the REQUESTER's, not the reading principal's: runFor reads as the system principal.
    expect(result.manifest.tables.map((t) => t.name)).not.toContain("audit_log");
  });

  it("attachments the requester's recorded modules cover are included; the rest are named, not dropped", async () => {
    const id = await attach({ documentId: f.invoiceId }, "invoice 01/26.pdf", "invoice pdf");
    const withAcc = await runFor(await seedExportJob(db, f.s, { readableModules: ["accounting"] }));
    const entry = withAcc.manifest.attachments.find((a) => a.id === id)!;
    expect(entry.fileName).toBe("invoice 01/26.pdf");
    expect(entry.path).toBe(`attachments/${id}-invoice_01_26.pdf`);
    expect(entry.sha256).toBe(createHash("sha256").update("invoice pdf").digest("hex"));
    expect(unpack(withAcc.bytes).get(entry.path)!.toString("utf8")).toBe("invoice pdf");
    // SAH-038: the store key is nowhere in the manifest.
    expect(JSON.stringify(withAcc.manifest)).not.toContain(objectKeyFor(f.s.tenant, id));

    const withNone = await runFor(await seedExportJob(db, f.s, { readableModules: [] }));
    expect(withNone.manifest.attachments).toEqual([]);
    expect(withNone.manifest.attachmentsOmitted).toContainEqual({
      id,
      reason: "module_not_readable",
    });
    expect([...unpack(withNone.bytes).keys()].some((p) => p.startsWith("attachments/"))).toBe(
      false,
    );
  });

  it("a lot attachment follows the recorded lot_attachments flag, not the module list", async () => {
    const { itemId } = await seedItem(db, f.s, { code: "EXP-LOT-ITEM", trackLots: true });
    const lotId = await seedLot(db, f.s, { itemId, code: "EXP-LOT" });
    const id = await attach({ lotId }, "certificate.pdf", "lot certificate");
    const without = await runFor(
      await seedExportJob(db, f.s, { readableModules: ["accounting", "inventory"] }),
    );
    expect(without.manifest.attachmentsOmitted).toContainEqual({
      id,
      reason: "module_not_readable",
    });
    const withLots = await runFor(
      await seedExportJob(db, f.s, { readableModules: [], lotAttachments: true }),
    );
    expect(withLots.manifest.attachments.map((a) => a.id)).toContain(id);
  });

  it("an attachment whose object is missing, or whose bytes no longer match its digest, is named", async () => {
    const missing = await attach({ documentId: f.invoiceId }, "gone.pdf", "gone", "none");
    const tampered = await attach({ documentId: f.invoiceId }, "edited.pdf", "edited", "tampered");
    const result = await runFor(await seedExportJob(db, f.s, { readableModules: ["accounting"] }));
    expect(result.manifest.attachmentsOmitted).toContainEqual({
      id: missing,
      reason: "object_missing",
    });
    expect(result.manifest.attachmentsOmitted).toContainEqual({
      id: tampered,
      reason: "digest_mismatch",
    });
    expect(result.manifest.attachments.map((a) => a.id)).not.toContain(tampered);
  });

  it("includeAttachments false omits the bytes but still exports the attachment METADATA table", async () => {
    const result = await runFor(await seedExportJob(db, f.s, { includeAttachments: false }));
    const files = [...unpack(result.bytes).keys()];
    expect(files.some((p) => p.startsWith("attachments/"))).toBe(false);
    expect(files).toContain("tables/attachment.csv");
    expect(result.manifest.attachments).toEqual([]);
    expect(result.manifest.attachmentsOmitted).toEqual([]);
    // The metadata never carries the store key (NEVER_EXPORTED, SAH-038).
    expect(unpack(result.bytes).get("tables/attachment.csv")!.toString("utf8")).not.toContain(
      `${f.s.tenant}/`,
    );
  });

  it("the same job run twice over the same state produces an identical sha256 (ADR 0069)", async () => {
    const jobId = await seedExportJob(db, f.s);
    const a = await runFor(jobId);
    const b = await runFor(jobId);
    expect(Buffer.from(a.sha256).toString("hex")).toBe(Buffer.from(b.sha256).toString("hex"));
    // generatedAt is an input, not a clock read inside: a different one changes the bytes.
    const c = await runFor(jobId, "2026-02-02T00:00:00Z");
    expect(Buffer.from(c.sha256).toString("hex")).not.toBe(Buffer.from(a.sha256).toString("hex"));
  });

  it("two exports of unchanged books carry identical table files; only the audit trail moves, by the export's own writes", async () => {
    // The honest version of the determinism claim. The requester now holds the audit gate, so the audit
    // trail is in the archive — and every export_job status write is audited (test 13), so a later export
    // carries the earlier one's rows. That is the books' audit trail growing, not nondeterminism.
    await grantCodes(db, f.s, { codes: ["admin.audit_log.read"], principalId: f.reader });
    const first = await runFor(await seedExportJob(db, f.s));
    const second = await runFor(await seedExportJob(db, f.s)); // its insert is one more audit row
    const a = unpack(first.bytes);
    const b = unpack(second.bytes);
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const path of a.keys()) {
      if (path === "manifest.json") continue; // names its own export job
      if (path.startsWith("tables/audit_log.")) continue;
      expect(a.get(path)!.equals(b.get(path)!), path).toBe(true);
    }
    const before = a.get("tables/audit_log.csv")!.toString("utf8").trimEnd().split("\n");
    const after = b.get("tables/audit_log.csv")!.toString("utf8").trimEnd().split("\n");
    // Ordered by the NUMERIC seq: a bare `order by seq` once bound to the text alias and put 201 after 20.
    const seqs = after.slice(1).map((line) => BigInt(line.split(",")[0]!));
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)).toBe(true);
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain(",export_job,");
    expect(added[0]).toContain(",insert,");
  });
});
