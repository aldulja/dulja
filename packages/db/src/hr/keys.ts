import { ConfigError } from "./config-error";

/** AES-256 — the key length §3.11's HR_FIELD_ENCRYPTION_KEY decodes to (8A amendment A8, ADR 0071). */
export const HR_KEY_BYTES = 32;
/** base64 of 32 zero bytes. Legal ONLY when APP_ENV === "dev" — readConfig() refuses its absence elsewhere. */
export const DEV_HR_KEY = Buffer.alloc(HR_KEY_BYTES).toString("base64");

export interface HrKey {
  readonly version: number;
  readonly bytes: Buffer;
}
export interface HrKeyRing {
  current(): HrKey;
  forVersion(version: number): HrKey;
}
/** An operator fault (a row sealed under a key the process was not given, a tampered or moved ciphertext),
 *  never a caller fault: it carries no code, so apps/api answers it as ERR_INTERNAL (8A amendment A15). */
export class HrKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrKeyError";
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes a §3.11 HR key: base64 of EXACTLY 32 bytes, or a ConfigError naming the variable. `Buffer.from` is
 *  lenient — it skips characters outside the alphabet — so the alphabet is checked first. */
export function decodeHrKey(name: string, b64: string): Buffer {
  if (!BASE64.test(b64) || b64.length % 4 !== 0)
    throw new ConfigError(`${name} is not valid base64 (§3.11, 8A amendment A8)`);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== HR_KEY_BYTES)
    throw new ConfigError(
      `${name} decodes to ${bytes.length} bytes; exactly ${HR_KEY_BYTES} are required (§3.11, 8A amendment A8)`,
    );
  return bytes;
}

/**
 * The key ring: the current key and, while 8D's rotation runs, the previous one. A sealed field names its key by
 * its own leading version byte, so the ring opens a partially rotated row field by field (ADR 0071).
 */
export function createHrKeyRing(opts: {
  current: string;
  currentVersion: number;
  previous?: string | null;
  previousVersion?: number;
}): HrKeyRing {
  if (
    !Number.isInteger(opts.currentVersion) ||
    opts.currentVersion < 1 ||
    opts.currentVersion > 255
  )
    throw new ConfigError(
      "HR key currentVersion must be an integer from 1 to 255 (one envelope byte)",
    );
  const keys = new Map<number, HrKey>();
  const cur: HrKey = {
    version: opts.currentVersion,
    bytes: decodeHrKey("HR_FIELD_ENCRYPTION_KEY", opts.current),
  };
  keys.set(cur.version, cur);
  if (opts.previous != null && opts.previous !== "") {
    const pv = opts.previousVersion ?? opts.currentVersion - 1;
    if (!Number.isInteger(pv) || pv < 1 || pv === opts.currentVersion)
      throw new ConfigError("HR_FIELD_ENCRYPTION_KEY_PREVIOUS was supplied with no usable version");
    keys.set(pv, {
      version: pv,
      bytes: decodeHrKey("HR_FIELD_ENCRYPTION_KEY_PREVIOUS", opts.previous),
    });
  }
  return {
    current: () => cur,
    forVersion(version) {
      const k = keys.get(version);
      if (k === undefined)
        throw new HrKeyError(
          `no HR key for version ${version}; supply HR_FIELD_ENCRYPTION_KEY_PREVIOUS or run hr.encryption_key.rotate`,
        );
      return k;
    },
  };
}
