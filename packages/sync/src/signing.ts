export const SYNC_TERMINAL_ID_HEADER = "X-Terminal-Id";
export const SYNC_TIMESTAMP_HEADER = "X-Terminal-Timestamp";
export const SYNC_SIGNATURE_HEADER = "X-Terminal-Signature";

/** Shared by the till signer and API verifier; the caller supplies the raw pathname. */
export function canonicalSyncRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}): string {
  return `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${input.body}`;
}

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

/** SHA-256 over UTF-8, using the same replacement of unpaired surrogates as HTTP text encoding. */
export function sha256Hex(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(bytes.length) * 8n);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!;
      const y = words[i - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[i] = words[i - 16]! + s0 + words[i - 7]! + s1;
    }
    let a = state[0]!,
      b = state[1]!,
      c = state[2]!,
      d = state[3]!;
    let e = state[4]!,
      f = state[5]!,
      g = state[6]!,
      h = state[7]!;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + ROUND_CONSTANTS[i]! + words[i]!) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const working = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] = state[i]! + working[i]!;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** The JSON wire form preserves revision bigints as decimal strings. */
export function serializeSyncBody(value: unknown): string {
  if (value === undefined) return "";
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  if (serialized === undefined) throw new TypeError("sync body must be JSON serializable");
  return serialized;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    result += BASE64[(word >>> 18) & 63]! + BASE64[(word >>> 12) & 63]!;
    result += b === undefined ? "=" : BASE64[(word >>> 6) & 63]!;
    result += c === undefined ? "=" : BASE64[word & 63]!;
  }
  return result;
}

/** Inject device signing; hash exactly the bodyText the transport will send. */
export function signSyncHeaders(
  req: {
    method: string;
    path: string;
    body?: unknown;
    bodyText?: string;
    at?: Date;
    terminalId: string;
  },
  sign: (message: Uint8Array) => Uint8Array,
): Record<string, string> {
  if (Object.hasOwn(req, "body") && Object.hasOwn(req, "bodyText"))
    throw new TypeError("body and bodyText are mutually exclusive");
  const timestamp = (req.at ?? new Date()).toISOString();
  const bodyText = req.bodyText ?? serializeSyncBody(req.body);
  const canonical = canonicalSyncRequest({
    method: req.method,
    path: req.path,
    timestamp,
    body: sha256Hex(bodyText),
  });
  return {
    [SYNC_TERMINAL_ID_HEADER]: req.terminalId,
    [SYNC_TIMESTAMP_HEADER]: timestamp,
    [SYNC_SIGNATURE_HEADER]: base64(sign(new TextEncoder().encode(canonical))),
  };
}
