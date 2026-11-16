import {
  drainOutbox,
  pullAll,
  SyncQueuedError,
  SYNC_BATCH_SYNC_LIMIT,
  type SyncTransport,
} from "@dulja/sync";
import type { SqliteSyncStore } from "./store";
import { revisionToText } from "./money";

export interface SyncState {
  online: boolean;
  lastPullAt: string | null;
  lastPushAt: string | null;
  catalogueRevision: string;
  /** Outbox rows that will still be sent, refused ones being retried included. */
  pendingOutbox: number;
  /** Tickets and till events whose refusal is final: their shift's close is acknowledged (`outbox_refused`). */
  refusedOutbox: number;
  /** The last sync failure; failing that, the server's standing refusals (`refusalNotice`). */
  lastError: string | null;
}
export interface SyncLoops {
  pullNow(): Promise<void>;
  /**
   * Send the outbox. The timer's drain records a failure in `state()` and resolves; a `manual` drain (the
   * cashier's Sync) also rejects with it, so the screen never reports a push that failed as completed (POS-18).
   * A queued batch is not a failure: it is accepted for later and will be re-sent.
   */
  drainNow(opts?: { manual?: boolean }): Promise<void>;
  state(): SyncState;
  start(): void;
  stop(): void;
  /** Clear identity immediately, settle the old operation, then install the replacement. */
  rebind(transport: SyncTransport | null, terminalId: string): Promise<void>;
}

/**
 * The till's one status line for refusals (PR 12 review). A refused ticket waits in the server's
 * needs-attention queue, but a refused till event has no server queue at all (6D A10), and `pendingOutbox` no
 * longer counts a final refusal, so without this line a refused void would be visible nowhere. It names the
 * count and the newest reason and stands while the rows do; a failed sync, which the cashier must act on
 * first, takes its place.
 */
export function refusalNotice(refusals: {
  retrying: number;
  final: number;
  newest: string | null;
}): string | null {
  const total = refusals.retrying + refusals.final;
  if (total === 0) return null;
  return (
    `the server refused ${total} outbox message(s): ${refusals.retrying} sent again until accepted or their ` +
    `shift closes, ${refusals.final} final; newest: ${refusals.newest ?? "no reason given"}`
  );
}

export function createSyncLoops(opts: {
  store: SqliteSyncStore;
  transport: SyncTransport | null;
  terminalId: string;
  newBatchId: () => string;
  intervalMs?: number;
  now?: () => Date;
}): SyncLoops {
  const now = opts.now ?? (() => new Date());
  const interval = opts.intervalMs ?? 15_000;
  if (!Number.isSafeInteger(interval) || interval < 1)
    throw new RangeError("sync interval must be positive");
  let transport = opts.transport;
  let terminalId = opts.terminalId;
  let online = false;
  let lastPullAt: string | null = null;
  let lastPushAt: string | null = null;
  let lastError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;
  let tickRunning = false;

  function serial(operation: () => Promise<void>): Promise<void> {
    const at = generation;
    const pending = tail.then(async () => {
      if (at === generation) await operation();
    });
    tail = pending.catch(() => undefined);
    return pending;
  }
  function unavailable(): boolean {
    if (transport !== null) return false;
    online = false;
    lastError = "this till is not enrolled: no terminal key is present";
    return true;
  }
  const pullNow = (): Promise<void> =>
    serial(async () => {
      if (unavailable()) return;
      const at = generation;
      try {
        await pullAll(opts.store, transport!, { pageSize: 1000 });
        opts.store.finishCataloguePull();
        if (at === generation) {
          online = true;
          lastPullAt = now().toISOString();
          lastError = null;
        }
      } catch (error) {
        if (at === generation) {
          online = false;
          lastError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      }
    });
  const drainNow = ({ manual = false }: { manual?: boolean } = {}): Promise<void> =>
    serial(async () => {
      if (unavailable()) return;
      const at = generation;
      try {
        await drainOutbox(opts.store, transport!, {
          terminalId,
          newBatchId: opts.newBatchId,
          batchSize: SYNC_BATCH_SYNC_LIMIT,
        });
        if (at === generation) {
          online = true;
          lastPushAt = now().toISOString();
          lastError = null;
        }
      } catch (error) {
        if (at !== generation) return;
        online = error instanceof SyncQueuedError;
        lastError =
          error instanceof SyncQueuedError
            ? `batch ${error.batchId} was queued as job ${error.jobId}; it will be re-sent`
            : error instanceof Error
              ? error.message
              : String(error);
        if (manual && !(error instanceof SyncQueuedError)) throw error;
      }
    });
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    pullNow,
    drainNow,
    stop,
    state() {
      const catalogue = opts.store.catalogueState();
      return {
        online,
        lastPullAt,
        lastPushAt,
        catalogueRevision: revisionToText(catalogue.revision),
        pendingOutbox: catalogue.pendingOutbox,
        refusedOutbox: catalogue.refusedOutbox,
        lastError: lastError ?? refusalNotice(opts.store.outboxRefusals()),
      };
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (tickRunning) return;
        tickRunning = true;
        void (async () => {
          try {
            await pullNow();
          } catch {
            /* The manual call propagates; the indicator records timer failures. */
          }
          await drainNow().catch(() => undefined);
        })().finally(() => {
          tickRunning = false;
        });
      }, interval);
      timer.unref?.();
    },
    async rebind(next, nextTerminalId) {
      stop();
      transport = null;
      online = false;
      lastError = "this till is not enrolled: no terminal key is present";
      const at = ++generation;
      await tail;
      if (at !== generation) return;
      transport = next;
      terminalId = nextTerminalId;
    },
  };
}
