import { openPosDatabase, type PosDatabase } from "./database";
import { SqliteSyncStore } from "./store";
import { loadDevice, type DeviceIdentity, type DeviceStore } from "./device";
import { HttpSyncTransport } from "./transport";
import { createSyncLoops, type SyncLoops } from "./loops";
import { registerPosHandlers, type PosHandlerDeps } from "./register";
import { tillUuidv7 } from "./ticket";
import type { ReceiptPayload } from "./receipt";
export interface OpenTillOptions {
  ipcMain: PosHandlerDeps["ipcMain"];
  channels: Readonly<Record<string, string>>;
  dbPath: string;
  baseUrl: string;
  deviceStore: DeviceStore;
  allowEvent: PosHandlerDeps["allowEvent"];
  print: (payload: ReceiptPayload) => Promise<void>;
  startLoops?: boolean;
}
export interface OpenedTill {
  db: PosDatabase;
  store: SqliteSyncStore;
  loops: SyncLoops;
  close(): Promise<void>;
}
/** Composition root loaded as a CJS build output; Electron is injected. */
export async function openTill(opts: OpenTillOptions): Promise<OpenedTill> {
  const sqliteDb = openPosDatabase(opts.dbPath);
  try {
    const store = new SqliteSyncStore(sqliteDb);
    const device = await loadDevice(opts.deviceStore);
    const transportFor = (identity: DeviceIdentity) =>
      new HttpSyncTransport({
        baseUrl: opts.baseUrl,
        device: identity,
        newIdempotencyKey: () => tillUuidv7(),
      });
    const loops = createSyncLoops({
      store,
      transport: device ? transportFor(device) : null,
      terminalId: device?.terminalId ?? "",
      newBatchId: () => tillUuidv7(),
    });
    const scope = (identity: DeviceIdentity): void => {
      sqliteDb.tx(() => {
        const put = sqliteDb.raw.prepare(
          "insert into meta (key,value) values (?,?) on conflict(key) do update set value=excluded.value",
        );
        if (identity.branchId) put.run("branch_id", identity.branchId);
        if (identity.companyId) put.run("company_id", identity.companyId);
      });
    };
    if (device) scope(device);
    registerPosHandlers({
      ipcMain: opts.ipcMain,
      channels: opts.channels,
      db: sqliteDb,
      store,
      loops,
      deviceStore: opts.deviceStore,
      baseUrl: opts.baseUrl,
      terminalId: device?.terminalId ?? null,
      allowEvent: opts.allowEvent,
      print: opts.print,
      onEnrolled: async (identity) => {
        await loops.rebind(transportFor(identity), identity.terminalId);
        store.resetCatalogue();
        scope(identity);
        if (opts.startLoops !== false) loops.start();
      },
    });
    if (opts.startLoops !== false) loops.start();
    return {
      db: sqliteDb,
      store,
      loops,
      close: async () => {
        await loops.rebind(null, "");
        sqliteDb.close();
      },
    };
  } catch (error) {
    sqliteDb.close();
    throw error;
  }
}
export { registerPosHandlers } from "./register";
