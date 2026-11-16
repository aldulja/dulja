export type UpdateStatus = {
  state: "up-to-date" | "available" | "downloading" | "error";
  version?: string;
  message?: string;
};

/**
 * `ipcMain.handle` serialises any thrown error into a generic `Error` whose `message` is a string like
 * "Error invoking remote method '...': EncryptionUnavailableError: ..." — a subclass's identity does not
 * survive the IPC boundary, so a caller could only ever string-match a rejection to detect the refusal.
 * `set` therefore never rejects on a refusal; it resolves to this instead, so the renderer branches on a
 * value. The renderer must NOT fall back to web storage (`localStorage`/`sessionStorage`) on `ok: false`
 * — that would defeat DoD 0.13 by landing the token in plaintext in Chromium's own LevelDB.
 */
export type AuthSetResult = { ok: true } | { ok: false; reason: "encryption-unavailable" };

export interface DuljaAuthBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<AuthSetResult>;
  remove(key: string): Promise<void>;
}

export interface DuljaAppBridge {
  version(): Promise<string>;
  checkForUpdates(): Promise<UpdateStatus>;
}

export interface DuljaPrintBridge {
  /** D18: printing goes through the Windows driver stack via Electron, with no hardware code. */
  toPdf(options: { landscape: boolean }): Promise<Uint8Array>;
}

/** 6B adds `pos: DuljaPosBridge` here additively (§4.10.6); nothing in this file changes then. */
export interface DuljaBridge {
  auth: DuljaAuthBridge;
  app: DuljaAppBridge;
  print: DuljaPrintBridge;
  pos?: DuljaPosBridge;
}

export const CHANNELS = {
  authGet: "dulja:auth:get",
  authSet: "dulja:auth:set",
  authRemove: "dulja:auth:remove",
  appVersion: "dulja:app:version",
  appCheckForUpdates: "dulja:app:check-for-updates",
  printToPdf: "dulja:print:to-pdf",
} as const;

// apps/desktop/src/bridge-types.ts — appended. 0E T11's namespace note: "6B adds `pos` to the same
// DuljaBridge interface additively and changes nothing here."

/**
 * The till's whole privileged surface (§4.10.6, amendment A4).
 *
 * §4.10.6 fixes seven names — `sell`, `tender`, `closeShift`, `pull`, `drain`, `clock`, `priceCheck` — and
 * those are the seven a *ticket* needs. A till cannot reach a ticket without `enrol`, `login`, `openShift`,
 * `search`, `receipt`, `print` and `status`, so the interface is fourteen methods and the seven are a subset.
 *
 * **Every amount crosses as a fixed-4-dp string and every quantity as a fixed-6-dp string.** `Money` is a
 * class and does not survive structured cloning; a `number` would be the float spec:2041 forbids. The main
 * process parses each with `Money.of`/`Quantity.of` after validating with the Zod schemas in
 * `packages/contracts/src/pos/till.ts`, so a renderer that sent nonsense is refused at the boundary.
 */
export interface DuljaPosBridge {
  enrol(code: string): Promise<{ terminalId: string }>;
  login(
    input: { employeeNumber: string; pin: string } | { logout: true },
  ): Promise<{ principalId: string | null; codes: string[]; branchId: string | null }>;
  openShift(input: { openingFloat: string; currency: string }): Promise<{ shiftId: string }>;
  closeShift(input: {
    shiftId: string;
    countedCash: string;
  }): Promise<{ shiftId: string; tickets: number; byMethod: Record<string, string> }>;
  search(input: {
    text?: string;
    barcode?: string;
    code?: string;
    customer?: boolean;
  }): Promise<unknown[]>;
  priceCheck(input: {
    text?: string;
    barcode?: string;
    code?: string;
    customer?: boolean;
  }): Promise<unknown[]>;
  sell(input: unknown): Promise<{ clientRef: string; total: string; account?: boolean }>;
  tender(
    input: unknown,
  ): Promise<{ clientRef: string; payable: string; change: string; rounding: string }>;
  clock(kind: "clock_in" | "clock_out"): Promise<{ id: string }>;
  receipt(clientRef: string): Promise<unknown>;
  print(clientRef: string): Promise<void>;
  pull(): Promise<void>;
  drain(): Promise<void>;
  status(): Promise<unknown>;
}

/** `dulja:pos:<kebab-case method>`. The map is the ONE place a channel name exists: `preload-pos.ts` reads it
 *  and `main-pos.ts` passes it to `registerPosHandlers` as data, so the two ends cannot disagree. */
export const POS_CHANNELS = {
  enrol: "dulja:pos:enrol",
  login: "dulja:pos:login",
  openShift: "dulja:pos:open-shift",
  closeShift: "dulja:pos:close-shift",
  search: "dulja:pos:search",
  priceCheck: "dulja:pos:price-check",
  sell: "dulja:pos:sell",
  tender: "dulja:pos:tender",
  clock: "dulja:pos:clock",
  receipt: "dulja:pos:receipt",
  print: "dulja:pos:print",
  pull: "dulja:pos:pull",
  drain: "dulja:pos:drain",
  status: "dulja:pos:status",
} as const satisfies Readonly<Record<keyof DuljaPosBridge, string>>;

export interface DuljaTillBridge {
  app: DuljaAppBridge;
  pos: DuljaPosBridge;
}
