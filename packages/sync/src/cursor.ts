import type { Cursor } from "./messages";

/** The ONE sync cursor codec. §4.2.8's `encodeCursor`/`decodeCursor` is a different codec for a different
 *  thing — a keyset position `{ k, id }` on a REST list — and neither is ever used for the other (hazard 9). */
export class SyncCursorError extends Error {
  readonly code = "ERR_SYNC_CURSOR_INVALID" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "SyncCursorError";
  }
}

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const MAX_REVISION = 9223372036854775807n;

function assertRevision(revision: bigint): void {
  if (revision < 0n || revision > MAX_REVISION)
    throw new SyncCursorError(`revision is outside the PostgreSQL bigint range: ${revision}`);
}

export function encodeSyncCursor(c: Cursor): string {
  assertRevision(c.revision);
  return Buffer.from(c.revision.toString(10), "utf8").toString("base64url");
}

/**
 * A cursor is a base64url string whose decoded text is a non-negative decimal integer and nothing else.
 * It is decoded to a `bigint`, never to a `number`: `app.catalogue_revision_seq` is a `bigint` sequence and a
 * revision past 2^53 read as a double would round, re-delivering one row for ever.
 */
export function decodeSyncCursor(raw: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw))
    throw new SyncCursorError(`cursor is not base64url: ${JSON.stringify(raw)}`);
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!DECIMAL.test(text))
    throw new SyncCursorError(`cursor does not decode to a revision: ${JSON.stringify(text)}`);
  const revision = BigInt(text);
  assertRevision(revision);
  return { revision };
}
