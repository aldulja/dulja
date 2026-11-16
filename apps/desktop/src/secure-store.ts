// No `electron` import in this file, by design: `safeStorage` arrives as the injected `SafeStorageLike`
// parameter below, named for real only at the one wiring point in `main.ts`. That is what lets the whole
// module — the refusal path included — be exercised under plain Node by `test/secure-store.test.ts`,
// which is the only place the `encryption-unavailable` branch can be reached at all: DPAPI is always
// available on the Windows hosts the Electron specs run on, so no E2E launch can ever produce it.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "safeStorage reports no OS keyring, so the refresh token cannot be stored encrypted. " +
        "Dulja does not fall back to plaintext; sign in again after enabling the keyring.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Named `SafeStorageLike`, not `Crypto` — `Crypto` is the DOM lib's global interface (`window.crypto`'s
 * type), and this tsconfig includes `"DOM"` for the renderer-facing files it also compiles. Shadowing it
 * here would be exactly the kind of global-shadowing defect this repo already has a recorded lesson
 * about.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(blob: Buffer): string;
}

/**
 * DoD 0.13 — "the token is not readable from disk in plain text". `safeStorage` is DPAPI on Windows.
 * When it is unavailable the store **refuses the write**; writing plaintext would satisfy the feature
 * and defeat the requirement.
 */
export function createSecureStore(dir: string, crypto: SafeStorageLike): SecureStore {
  const path = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.bin`);

  return {
    async get(key) {
      try {
        return crypto.decryptString(await readFile(path(key)));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (!crypto.isEncryptionAvailable()) throw new EncryptionUnavailableError();
      await mkdir(dir, { recursive: true });
      await writeFile(path(key), crypto.encryptString(value), { mode: 0o600 });
    },
    async remove(key) {
      await rm(path(key), { force: true });
    },
  };
}

export type SetOutcome = { ok: true } | { ok: false; reason: "encryption-unavailable" };

/**
 * `store.set`'s throw only means something to a caller in the same process — across `ipcMain.handle`'s
 * IPC boundary, `EncryptionUnavailableError`'s identity is lost (main.ts's handler is the only caller
 * that needs this; it forwards the result as `bridge-types.ts`'s `AuthSetResult`, structurally identical
 * to this type). Kept here, free of `electron`, so the translation itself — not just the refusal — is
 * unit-testable without launching Electron: DPAPI is always available on the Windows host these tests
 * run on, so an E2E spec can never exercise the `ok: false` branch; this is the only place that can.
 * Any error OTHER than `EncryptionUnavailableError` (a full disk, a permissions problem) still rejects —
 * it must not be reported to the renderer as "no keyring" when the real cause is something else.
 */
export async function setOrRefuse(
  store: SecureStore,
  key: string,
  value: string,
): Promise<SetOutcome> {
  try {
    await store.set(key, value);
    return { ok: true };
  } catch (error) {
    if (error instanceof EncryptionUnavailableError)
      return { ok: false, reason: "encryption-unavailable" };
    throw error;
  }
}
