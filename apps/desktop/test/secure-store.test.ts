import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSecureStore,
  EncryptionUnavailableError,
  setOrRefuse,
  type SecureStore,
} from "../src/secure-store";

/** A stand-in for `safeStorage`: reversible, but not the plaintext — exactly the property under test. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (v: string) =>
    Buffer.from(`enc:${Buffer.from(v, "utf8").toString("base64")}`, "utf8"),
  decryptString: (b: Buffer) => Buffer.from(b.toString("utf8").slice(4), "base64").toString("utf8"),
});

describe("createSecureStore", () => {
  it("round-trips a value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("sb-auth-token", "refresh-token-value");
    await expect(store.get("sb-auth-token")).resolves.toBe("refresh-token-value");
  });

  it("never writes the plaintext to disk (DoD 0.13)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("sb-auth-token", "refresh-token-value");
    for (const entry of await readdir(dir)) {
      const bytes = await readFile(join(dir, entry));
      expect(bytes.toString("utf8")).not.toContain("refresh-token-value");
      expect(bytes.toString("latin1")).not.toContain("refresh-token-value");
    }
  });

  it("returns null for an absent key rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    await expect(createSecureStore(dir, fakeCrypto()).get("nothing")).resolves.toBeNull();
  });

  it("removes a key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("k", "v");
    await store.remove("k");
    await expect(store.get("k")).resolves.toBeNull();
  });

  it("refuses to persist when encryption is unavailable — never falls back to plaintext", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto(false));
    await expect(store.set("k", "v")).rejects.toBeInstanceOf(EncryptionUnavailableError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps one key's file separate from another's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await store.set("a", "1");
    await store.set("b", "2");
    expect((await readdir(dir)).length).toBe(2);
    await expect(store.get("a")).resolves.toBe("1");
  });
});

describe("setOrRefuse — the IPC-boundary translation, unit-tested because nothing else can be", () => {
  /**
   * `safeStorage` reports encryption available on every host these tests actually run on (this repo's
   * `windows-latest` job has DPAPI), so `test/safe-storage.spec.ts`'s real Electron launch can never
   * exercise the `ok: false` branch. This is the only place that proves it: `EncryptionUnavailableError`
   * turns into a plain value instead of an IPC-mangled rejection.
   */
  it("resolves ok: true when the store accepts the write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto());
    await expect(setOrRefuse(store, "k", "v")).resolves.toEqual({ ok: true });
  });

  it("resolves ok: false, reason: encryption-unavailable — never rejects — on that refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dulja-"));
    const store = createSecureStore(dir, fakeCrypto(false));
    await expect(setOrRefuse(store, "k", "v")).resolves.toEqual({
      ok: false,
      reason: "encryption-unavailable",
    });
  });

  it("still rejects on any other failure — a full disk must not be reported as 'no keyring'", async () => {
    const brokenStore: SecureStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error("ENOSPC: no space left on device")),
      remove: () => Promise.resolve(),
    };
    await expect(setOrRefuse(brokenStore, "k", "v")).rejects.toThrow("ENOSPC");
  });
});
