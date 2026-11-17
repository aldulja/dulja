import { AwsClient } from "aws4fetch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ObjectKeyError extends Error {
  readonly code = "ERR_OBJECT_KEY_INVALID" as const;
  constructor(argument: "tenantId" | "attachmentId") {
    // The bad value is deliberately NOT echoed: it is attacker-controlled and this message reaches a log.
    super(
      `${argument} must be a uuid — an object key is derived out of server-minted ids only (LEGACY-038)`,
    );
    this.name = "ObjectKeyError";
  }
}

/**
 * The ONE object-key derivation in the system. Both arguments are server-minted `uuidv7` values:
 * `tenant_id` comes from the session (`app.current_tenant()`), `attachmentId` is the row's primary key.
 * Nothing a client sends — a file name, a folder, a document reference — ever reaches this function,
 * which is the structural answer to LEGACY-038 (spec:545).
 */
export function objectKeyFor(tenantId: string, attachmentId: string): string {
  if (!UUID.test(tenantId)) throw new ObjectKeyError("tenantId");
  if (!UUID.test(attachmentId)) throw new ObjectKeyError("attachmentId");
  return `${tenantId}/${attachmentId}`;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/** Tests, `bun run dev` without R2 credentials, and `ROUTES`' stub construction (§4.2.7). */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return Promise.resolve(
      found ? { bytes: Uint8Array.from(found.bytes), contentType: found.contentType } : null,
    );
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

export interface R2ObjectStoreOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * R2 through its S3-compatible endpoint. The container has no Workers bindings — `ATTACHMENTS` is bound on
 * `apps/edge` (§3.11) — so the API signs SigV4 requests against `<accountId>.r2.cloudflarestorage.com`.
 * The four values arrive as environment variables (§3.11) and never as literals.
 */
export class R2ObjectStore implements ObjectStore {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(opts: R2ObjectStoreOptions) {
    this.#client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.#base = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** No R2 call may hold the caller — and, on the upload path, its request — for longer than this. */
  static readonly TIMEOUT_MS = 30_000;

  async #send(key: string, init: RequestInit): Promise<Response> {
    const signed = await this.#client.sign(`${this.#base}/${key}`, {
      ...init,
      signal: AbortSignal.timeout(R2ObjectStore.TIMEOUT_MS),
    });
    return this.#fetch(signed);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.#send(key, {
      method: "PUT",
      body: bytes as unknown as NonNullable<RequestInit["body"]>,
      headers: { "content-type": contentType },
    });
    if (!res.ok) throw new Error(`object store PUT failed: ${res.status}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.#send(key, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store GET failed: ${res.status}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send(key, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`object store removal failed: ${res.status}`);
    }
  }
}
