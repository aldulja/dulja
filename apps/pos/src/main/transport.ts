import { BatchResultSchema, BatchQueuedSchema } from "@dulja/contracts/sync/ticket";
import { CataloguePageSchema } from "@dulja/contracts/sync/catalogue";
import { textToRevision } from "./money";
import {
  serializeSyncBody,
  signSyncHeaders,
  SyncQueuedError,
  type BatchResult,
  type CataloguePage,
  type Change,
  type SyncTransport,
  type TicketBatch,
} from "@dulja/sync";
import type { DeviceIdentity } from "./device";

/** Every failure that is *not* a server answer. `pullAll` and `drainOutbox` must both propagate it: an
 *  interrupted transfer that looked like an empty finished page would advance nothing and finish, which is
 *  exactly the silent-truncation failure acceptance test 20 exists to catch. */
export class TransportOfflineError extends Error {
  constructor(override readonly cause: unknown) {
    super(`the till could not reach the sync API: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "TransportOfflineError";
  }
}

/**
 * The last signing instant, shared by every transport in this process. The server spends each signed message
 * once (ADR 0055 decision 7) and a message is method, path, body and a millisecond timestamp, so two of this
 * till's own requests — the catalogue and ticket loops run concurrently — must never share a millisecond.
 */
let lastSignedMs = 0;
function signingInstant(): Date {
  lastSignedMs = Math.max(Date.now(), lastSignedMs + 1);
  return new Date(lastSignedMs);
}

/**
 * How long one till → API request may take, headers and body together (full review 2026-11-15, POS-03). Without
 * it undici waits five minutes for headers and five more for the body, and every sync call queues behind the one
 * in flight, so a half-open API held the till's sync chain — and enrolment and quitting with it — for minutes.
 * A request that runs out of time is offline, like any other failure that is not a server answer.
 */
export const TILL_REQUEST_TIMEOUT_MS = 20_000;

export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly device: DeviceIdentity;
  private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly newIdempotencyKey: () => string;
  private readonly timeoutMs: number;

  constructor(opts: {
    baseUrl: string;
    device: DeviceIdentity;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    newIdempotencyKey: () => string;
    timeoutMs?: number;
  }) {
    this.baseUrl = opts.baseUrl;
    this.device = opts.device;
    this.doFetch = opts.fetch ?? fetch;
    this.newIdempotencyKey = opts.newIdempotencyKey;
    this.timeoutMs = opts.timeoutMs ?? TILL_REQUEST_TIMEOUT_MS;
  }

  async pullCatalogue(since: string, limit: number): Promise<CataloguePage> {
    const path = "/v1/sync/catalogue";
    const url = new URL(path, this.baseUrl);
    if (since !== "") url.searchParams.set("since", since);
    url.searchParams.set("limit", String(limit));
    // The signature covers the PATHNAME only: a cursor is not a secret, and a till retrying with a
    // different `limit` must not have to re-sign (§4.10.3, and 6A's `syncRequest` does the same).
    const headers = signSyncHeaders(
      { method: "GET", path, at: signingInstant(), terminalId: this.device.terminalId },
      (m) => this.device.sign(m),
    );
    const response = await this.send(url, { method: "GET", headers });
    const body = CataloguePageSchema.parse(await response.json());
    return {
      changes: body.changes.map((c): Change => ({
        stream: c.stream as Change["stream"],
        op: c.op,
        id: c.id,
        // The wire carries the revision as a STRING and it becomes a bigint here, once. `JSON.parse` would
        // have already rounded a number past 2^53 before this line ran.
        revision: textToRevision(c.revision),
        row: (c.row ?? null) as Change["row"],
      })),
      next_cursor: body.next_cursor,
      has_more: body.has_more,
    };
  }

  async pushTickets(batch: TicketBatch): Promise<BatchResult> {
    const path = "/v1/sync/tickets";
    // Stringified ONCE, here, and the same string is both hashed and sent. Two serialisations of one object
    // are equal; a string and an object are not, and the failure is an opaque 401 on every signed POST.
    const body = serializeSyncBody(batch);
    const headers = {
      ...signSyncHeaders(
        {
          method: "POST",
          path,
          bodyText: body,
          at: signingInstant(),
          terminalId: this.device.terminalId,
        },
        (m) => this.device.sign(m),
      ),
      "content-type": "application/json",
      // §4.2.9 layer one. Layer two is `client_ref` dedup on the server, which is what makes a re-send with
      // a FRESH key equally harmless — the two together are the DoD's "re-sending a batch changes nothing".
      "Idempotency-Key": this.newIdempotencyKey(),
    };
    const response = await this.send(new URL(path, this.baseUrl), {
      method: "POST",
      headers,
      body,
    });
    if (response.status === 202) {
      const queued = BatchQueuedSchema.parse(await response.json());
      if (queued.batchId !== batch.batchId)
        throw new TypeError("queued response names another batch");
      throw new SyncQueuedError(queued.batchId, queued.jobId);
    }
    const result = BatchResultSchema.parse(await response.json());
    if (result.batchId !== batch.batchId)
      throw new TypeError("acknowledgement names another batch");
    return result as BatchResult;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(url.toString(), {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TransportOfflineError(error);
    }
    if (response.status === 202 || response.ok) return response;
    const problem = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
    // The code, not the status: `ERR_TERMINAL_REVOKED` tells the shop to call the office and
    // `ERR_TERMINAL_SIGNATURE_INVALID` tells them the till's clock is wrong. "403" tells them nothing.
    throw new Error(
      `${problem.code ?? `HTTP_${response.status}`}: ${problem.detail ?? response.statusText}`,
    );
  }
}
