// packages/sync/test/cursor.test.ts
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_STREAMS,
  SYNC_BATCH_SYNC_LIMIT,
  decodeSyncCursor,
  encodeSyncCursor,
  SyncCursorError,
} from "../src/index";

describe("the sync cursor codec (§4.10.1 — base64url of the decimal revision, opaque to the till)", () => {
  it("round-trips a bigint revision through a URL-safe string", () => {
    for (const n of [0n, 1n, 42n, 9007199254740993n, 9223372036854775807n]) {
      const raw = encodeSyncCursor({ revision: n });
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // §4.2.8's CursorSchema shape
      expect(decodeSyncCursor(raw).revision).toBe(n);
    }
  });

  it("9007199254740993 survives — the exact reason the wire form is a STRING and not a JSON number", () => {
    // Number(9007199254740993) === 9007199254740992. A revision past 2^53 read as a double would
    // silently re-deliver one row for ever, which is the failure acceptance test 20 exists to catch.
    const raw = encodeSyncCursor({ revision: 9007199254740993n });
    expect(decodeSyncCursor(raw).revision).toBe(9007199254740993n);
    expect(BigInt(Number(decodeSyncCursor(raw).revision))).not.toBe(9007199254740993n);
  });

  it("refuses anything that is not this shape with ERR_SYNC_CURSOR_INVALID", () => {
    for (const bad of [
      "",
      "!!!",
      "eyJrIjpbXX0",
      Buffer.from("-1").toString("base64url"),
      Buffer.from("1.5").toString("base64url"),
    ]) {
      let thrown: unknown;
      try {
        decodeSyncCursor(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, bad).toBeInstanceOf(SyncCursorError);
      expect((thrown as SyncCursorError).code).toBe("ERR_SYNC_CURSOR_INVALID");
    }
  });

  it("CATALOGUE_STREAMS is the eight members of Stream, in pull order, with no duplicate", () => {
    expect(CATALOGUE_STREAMS).toEqual([
      "item",
      "price_list",
      "price_list_line",
      "promotion",
      "customer",
      "tax_code",
      "cashier",
      "branch_pos_policy",
    ]);
    expect(new Set(CATALOGUE_STREAMS).size).toBe(CATALOGUE_STREAMS.length);
  });

  it("refuses revisions outside PostgreSQL's signed bigint sequence range", () => {
    for (const revision of [-1n, 9223372036854775808n]) {
      expect(() => encodeSyncCursor({ revision })).toThrow(SyncCursorError);
      const raw = Buffer.from(revision.toString(), "utf8").toString("base64url");
      expect(() => decodeSyncCursor(raw)).toThrow(SyncCursorError);
    }
  });

  it("the synchronous batch limit is the one number §4.10.4 fixes", () => {
    expect(SYNC_BATCH_SYNC_LIMIT).toBe(200);
  });
});
