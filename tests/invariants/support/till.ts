import { mkdtempSync, rmSync } from "node:fs";
import { createPublicKey, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Money, Quantity, currency } from "@dulja/domain";
import { withTenant, updateItem } from "@dulja/db";
import { seedPriceList } from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app";
import { staffFixture, type StaffFixture } from "./staff";
import { openPosDatabase, type PosDatabase } from "../../../apps/pos/src/main/database";
import { SqliteSyncStore } from "../../../apps/pos/src/main/store";
import { createSyncLoops, type SyncLoops } from "../../../apps/pos/src/main/loops";
import { loginCashier, type TillCashier } from "../../../apps/pos/src/main/authority";
import { openShift } from "../../../apps/pos/src/main/shift";
import { sell, tillUuidv7 } from "../../../apps/pos/src/main/ticket";
import { tender } from "../../../apps/pos/src/main/tender";
import { HttpSyncTransport } from "../../../apps/pos/src/main/transport";

/** Uses the shipped signer, exact-body codec and response validation against the actual API app. */
export class HttpTillTransport extends HttpSyncTransport {
  private readonly state: { offline: boolean; calls: number };
  constructor(api: StartedApi, staff: StaffFixture) {
    const state = { offline: false, calls: 0 };
    super({
      baseUrl: "http://localhost",
      device: {
        terminalId: staff.terminalA.terminalId,
        publicKeyDer: createPublicKey(staff.terminalA.privateKey).export({
          type: "spki",
          format: "der",
        }),
        sign: (bytes) => sign(null, bytes, staff.terminalA.privateKey),
      },
      newIdempotencyKey: () => tillUuidv7(),
      fetch: async (input, init) => {
        state.calls += 1;
        if (state.offline)
          throw Object.assign(new Error("ECONNREFUSED: till transport is disconnected"), {
            code: "ECONNREFUSED",
          });
        return api.app.fetch(new Request(input, init));
      },
    });
    this.state = state;
  }
  get offline(): boolean {
    return this.state.offline;
  }
  set offline(value: boolean) {
    this.state.offline = value;
  }
  get calls(): number {
    return this.state.calls;
  }
}
export interface TillFixture {
  staff: StaffFixture;
  api: StartedApi;
  dir: string;
  db: PosDatabase;
  store: SqliteSyncStore;
  transport: HttpTillTransport;
  loops: SyncLoops;
  terminalId: string;
  cashier: TillCashier | null;
  shiftId: string;
  close(): Promise<void>;
}
/** Adds only local SQLite, real transport drivers and the registered SKU-A price-list prerequisite. */
export async function tillFixture(api: StartedApi, name: string): Promise<TillFixture> {
  const staff = await staffFixture(api, name);
  await seedPriceList(api.db, staff.seed, {
    code: `${name}-RETAIL`,
    lines: [{ itemId: staff.itemId, unitPrice: "11.5000" }],
  });
  // Exercise the new item assignment through the production service, using this fixture's existing tax pack.
  await withTenant(
    api.db.rw,
    { tenantId: staff.seed.tenant, actorId: staff.seed.human, requestId: `${name}-tax` },
    (tx) => updateItem(tx, staff.itemId, { taxCodeId: staff.pos.taxCodes["SYN-OUT-STD"]! }),
  );
  const dir = mkdtempSync(join(tmpdir(), `dulja-till-${name}-`));
  const sqliteDb = openPosDatabase(join(dir, "till.sqlite"));
  const store = new SqliteSyncStore(sqliteDb);
  const transport = new HttpTillTransport(api, staff);
  const loops = createSyncLoops({
    store,
    transport,
    terminalId: staff.terminalA.terminalId,
    newBatchId: () => tillUuidv7(),
    intervalMs: 1_000_000,
  });
  return {
    staff,
    api,
    dir,
    db: sqliteDb,
    store,
    transport,
    loops,
    terminalId: staff.terminalA.terminalId,
    cashier: null,
    shiftId: "",
    close: async () => {
      await loops.rebind(null, "");
      sqliteDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function openTill(f: TillFixture): Promise<void> {
  await f.loops.pullNow();
  f.db.raw
    .prepare(
      "insert into meta(key,value) values ('branch_id',?) on conflict(key) do update set value=excluded.value",
    )
    .run(f.staff.branchA);
  f.cashier = await loginCashier(f.db, { principalId: f.staff.cashierA, pin: "4321" });
  f.shiftId = openShift(f.db, f.store, {
    terminalId: f.terminalId,
    cashier: f.cashier,
    openingFloat: Money.of("100.0000", currency("MYR")),
  }).id;
}
export function sellOffline(f: TillFixture, count: number): string[] {
  if (!f.cashier) throw new Error("open the till before selling");
  const refs: string[] = [];
  const start = Date.now() - 8 * 60 * 60 * 1000;
  for (let n = 0; n < count; n += 1) {
    const at = new Date(start + Math.floor((n * 8 * 60 * 60 * 1000) / count));
    const result = sell(f.db, f.store, {
      shiftId: f.shiftId,
      cashier: f.cashier,
      at,
      lines: [{ itemId: f.staff.itemId, quantity: Quantity.of("0.100000") }],
    });
    refs.push(
      tender(f.db, f.store, {
        clientRef: result.clientRef,
        cashier: f.cashier,
        tenders: [{ method: "cash", amount: result.draft.total }],
      }).clientRef,
    );
  }
  return refs;
}
