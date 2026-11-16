// packages/sync/test/pull-all.test.ts
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_STREAMS,
  pullAll,
  type Change,
  type CataloguePage,
  type Stream,
  type SyncStore,
  type SyncTransport,
  type OutboxRow,
  type BatchResult,
} from "../src/index";
import { encodeSyncCursor } from "../src/cursor";

/** The packages/sync copy is the specification of the port; the tests/ copy is what 6B's SQLite store is compared against.
 * The reference `SyncStore`: a map keyed `<stream>:<id>`, one cursor per stream (spec:1330), an outbox array.
 *  6B's SQLite store must behave identically; this one is the executable statement of what "identically" means. */
class MemoryStore implements SyncStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly cursors = new Map<string, bigint>();
  readonly outbox: OutboxRow[] = [];
  applied = 0;
  async getCursor(stream: Stream): Promise<bigint> {
    return this.cursors.get(stream) ?? 0n;
  }
  async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    let high = 0n;
    for (const ch of changes) {
      const key = `${ch.stream}:${ch.id}`;
      if (ch.op === "delete") this.rows.delete(key);
      else this.rows.set(key, ch.row as Record<string, unknown>);
      if (ch.revision > high) high = ch.revision;
      this.applied += 1;
    }
    // ⚠️ EVERY stream, not only the streams this page carried (Task 0 amendment 23c). A page is ordered by
    // revision ACROSS all streams, so a page ending at revision `high` has delivered everything <= high for
    // every stream — including the streams that had nothing. Advancing only the touched ones would leave
    // `cashier` and `branch_pos_policy` at 0n on every till until 6C ships, and `pullAll`'s minimum-across-
    // streams cursor would therefore be 0n for ever: every pull would re-fetch the whole catalogue and no
    // resume would exist. Nothing would fail; the till would just be permanently slow and permanently at
    // page one. This line is the contract 6B's SQLite store is measured against.
    for (const st of CATALOGUE_STREAMS) this.cursors.set(st, high);
  }
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    return this.outbox.filter((r) => r.ackedAt === null).slice(0, limit);
  }
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const refs = {
      ticket: new Set(
        result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ),
      shift: new Set(result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref)),
      till_event: new Set(
        result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
      cash_event: new Set(
        (result.cashEventResults ?? []).filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
    };
    for (const row of this.outbox)
      if (ids.includes(row.id) && refs[row.kind].has(row.ref))
        row.ackedAt = new Date().toISOString();
  }
}

function serverWith(
  changes: Change[],
  pageSize: number,
  dieAfterPages = Infinity,
): SyncTransport & { pages: number } {
  const sorted = changes.toSorted((a, b) =>
    a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0,
  );
  const t = {
    pages: 0,
    async pullCatalogue(since: string, limit: number): Promise<CataloguePage> {
      if (t.pages >= dieAfterPages) throw new Error("ECONNRESET");
      t.pages += 1;
      const from = since === "" ? 0n : BigInt(Buffer.from(since, "base64url").toString("utf8"));
      const window = sorted
        .filter((c) => c.revision > from)
        .slice(0, Math.min(limit, pageSize) + 1);
      const hasMore = window.length > Math.min(limit, pageSize);
      const page = hasMore ? window.slice(0, Math.min(limit, pageSize)) : window;
      const next = page.at(-1)?.revision ?? from;
      return {
        changes: page,
        next_cursor: encodeSyncCursor({ revision: next }),
        has_more: hasMore,
      };
    },
    async pushTickets(): Promise<BatchResult> {
      throw new Error("not used");
    },
  };
  return t;
}

const upsert = (stream: Change["stream"], id: string, revision: bigint): Change => ({
  stream,
  op: "upsert",
  id,
  revision,
  row: { id },
});
const tombstone = (stream: Change["stream"], id: string, revision: bigint): Change => ({
  stream,
  op: "delete",
  id,
  revision,
  row: null,
});

describe("acceptance test 20 — catalogue resume (spec:2438)", () => {
  const corpus: Change[] = [];
  for (let i = 1n; i <= 50n; i += 1n) corpus.push(upsert("item", `item-${i}`, i));
  corpus.push(tombstone("item", "item-7", 51n));
  corpus.push(upsert("price_list", "pl-1", 52n));

  it("a complete pull applies every change exactly once and lands on the last revision", async () => {
    const store = new MemoryStore();
    const out = await pullAll(store, serverWith(corpus, 10), { pageSize: 10 });
    expect(out.applied).toBe(corpus.length);
    expect(store.applied).toBe(corpus.length);
    expect(store.rows.has("item:item-7")).toBe(false); // the tombstone was applied, not ignored
    expect(store.rows.size).toBe(49 + 1); // 50 items − 1 deleted + 1 price list
    // 52n and not 51n: the corpus's LAST change is the price_list at 52, and applyChanges advances EVERY
    // stream to the page's highest revision. `item`'s own last change was 51 (the tombstone), but a cursor
    // is a position in the one global revision order, not a high-water mark per table.
    expect(await store.getCursor("item")).toBe(52n);
    for (const st of CATALOGUE_STREAMS) expect(await store.getCursor(st), st).toBe(52n);
  });

  it("killed mid-transfer and resumed: no row applied twice, no deletion missed", async () => {
    const store = new MemoryStore();
    // Three pages of ten, then the connection drops — exactly "kill the down-sync mid-transfer".
    await expect(pullAll(store, serverWith(corpus, 10, 3), { pageSize: 10 })).rejects.toThrow(
      "ECONNRESET",
    );
    const partial = store.applied;
    expect(partial).toBe(30);
    expect(store.rows.has("item:item-7")).toBe(true); // the tombstone is BEYOND the kill point
    // Three pages of ten ended at revision 30, and every stream now says 30 — so the minimum says 30 too,
    // which is what makes the resume below ask for 31 and not for 1.
    for (const st of CATALOGUE_STREAMS) expect(await store.getCursor(st), st).toBe(30n);

    const out = await pullAll(store, serverWith(corpus, 10), { pageSize: 10 });
    expect(out.applied).toBe(corpus.length - partial); // only what was left: 22
    expect(store.applied).toBe(corpus.length); // and the total is exact: nothing applied twice
    expect(store.rows.has("item:item-7")).toBe(false); // the deletion was NOT missed
    expect(store.rows.size).toBe(50);
  });

  it("the wire cursor is the MINIMUM across streams, so a resume never skips a stream", async () => {
    const store = new MemoryStore();
    // Every stream is preset, and `price_list` is the laggard. Presetting only two would make this case
    // vacuous: the six untouched streams would answer 0n, the minimum would be 0n, and the assertion would
    // pass for the wrong reason on any implementation at all.
    for (const st of CATALOGUE_STREAMS) store.cursors.set(st, 40n);
    store.cursors.set("price_list", 5n);
    // A resume must ask from 5, not from 40, or every price-list change between 5 and 40 is lost for ever.
    const t = serverWith(corpus, 100);
    let asked = "";
    const spy: SyncTransport = {
      ...t,
      async pullCatalogue(since, limit) {
        if (asked === "") asked = since;
        return t.pullCatalogue(since, limit);
      },
    };
    await pullAll(store, spy, { pageSize: 100 });
    expect(BigInt(Buffer.from(asked, "base64url").toString("utf8"))).toBe(5n);
  });

  it("an empty catalogue is a no-op that still terminates", async () => {
    const store = new MemoryStore();
    const out = await pullAll(store, serverWith([], 10), { pageSize: 10 });
    expect(out.applied).toBe(0);
    expect(await store.getCursor("item")).toBe(0n);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid pageSize %s before reading the catalogue",
    async (pageSize) => {
      const store = new MemoryStore();
      let calls = 0;
      const t: SyncTransport = {
        async pullCatalogue(): Promise<never> {
          calls += 1;
          throw new Error("invalid pageSize reached transport");
        },
        async pushTickets(): Promise<never> {
          throw new Error("not used");
        },
      };
      await expect(pullAll(store, t, { pageSize })).rejects.toBeInstanceOf(RangeError);
      expect(calls).toBe(0);
      expect(store.applied).toBe(0);
      for (const stream of CATALOGUE_STREAMS) expect(await store.getCursor(stream)).toBe(0n);
    },
  );
});
