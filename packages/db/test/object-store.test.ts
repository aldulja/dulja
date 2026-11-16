import { describe, expect, it } from "vitest";
import {
  MemoryObjectStore,
  ObjectKeyError,
  R2ObjectStore,
  objectKeyFor,
} from "../src/attachment/object-store";

const TENANT = "01927f3a-0000-7000-8000-000000000001";
const ATTACHMENT = "01927f3a-0000-7000-8000-0000000000aa";

describe("objectKeyFor — SAH-038: the key is derived, never supplied", () => {
  it("is exactly '<tenant_id>/<attachment_id>'", () => {
    expect(objectKeyFor(TENANT, ATTACHMENT)).toBe(`${TENANT}/${ATTACHMENT}`);
  });

  it("refuses anything that is not a uuid — no traversal, no absolute path, no folder", () => {
    for (const bad of [
      "../../../windows/temp/evil.dll",
      "..",
      `${TENANT}/../${ATTACHMENT}`,
      "/etc/passwd",
      "C:\\Windows\\Temp\\evil.dll",
      "",
      `${ATTACHMENT} `,
    ]) {
      expect(() => objectKeyFor(bad, ATTACHMENT)).toThrow(ObjectKeyError);
      expect(() => objectKeyFor(TENANT, bad)).toThrow(ObjectKeyError);
    }
  });

  it("names the offending argument without echoing it back in full", () => {
    let caught: unknown;
    try {
      objectKeyFor(TENANT, "../evil");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObjectKeyError);
    expect((caught as ObjectKeyError).code).toBe("ERR_OBJECT_KEY_INVALID");
    expect((caught as Error).message).toContain("attachmentId");
    expect((caught as Error).message).not.toContain("../evil");
  });
});

describe("MemoryObjectStore", () => {
  it("round-trips bytes and content type, and returns null for a miss", async () => {
    const store = new MemoryObjectStore();
    const key = objectKeyFor(TENANT, ATTACHMENT);
    await store.put(key, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
    const got = await store.get(key);
    expect(got).not.toBeNull();
    expect(Array.from(got!.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(got!.contentType).toBe("application/pdf");
    expect(
      await store.get(objectKeyFor(TENANT, "01927f3a-0000-7000-8000-0000000000bb")),
    ).toBeNull();
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("stores a copy, so a later mutation of the caller's buffer cannot change the object", async () => {
    const store = new MemoryObjectStore();
    const key = objectKeyFor(TENANT, ATTACHMENT);
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put(key, bytes, "application/octet-stream");
    bytes[0] = 99;
    expect(Array.from((await store.get(key))!.bytes)).toEqual([1, 2, 3]);
  });
});

describe("R2ObjectStore — the S3-compatible surface, exercised through an injected fetch", () => {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization") });
    if (req.method === "GET") {
      return new Response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const store = new R2ObjectStore({
    accountId: "acc",
    bucket: "dulja-attachments",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    fetchImpl,
  });
  const key = objectKeyFor(TENANT, ATTACHMENT);

  it("addresses the object at <accountId>.r2.cloudflarestorage.com/<bucket>/<key> and signs the request", async () => {
    calls.length = 0;
    await store.put(key, new Uint8Array([1]), "application/pdf");
    expect(calls[0]!.url).toBe(`https://acc.r2.cloudflarestorage.com/dulja-attachments/${key}`);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
  });

  it("returns null on a 404 rather than throwing", async () => {
    const missing = new R2ObjectStore({
      accountId: "acc",
      bucket: "b",
      accessKeyId: "A",
      secretAccessKey: "s",
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    expect(await missing.get(key)).toBeNull();
  });

  it("throws, naming the status, on any other failure — never a silent empty object", async () => {
    const broken = new R2ObjectStore({
      accountId: "acc",
      bucket: "b",
      accessKeyId: "A",
      secretAccessKey: "s",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    await expect(broken.get(key)).rejects.toThrow(/object store GET failed: 503/);
  });
});
