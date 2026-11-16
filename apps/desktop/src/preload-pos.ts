// apps/desktop/src/preload-pos.ts
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, POS_CHANNELS, type DuljaTillBridge } from "./bridge-types";

/**
 * The till's preload. spec:1284: *"all privileged operations behind a typed `contextBridge` API, never raw
 * Node in the renderer"*.
 *
 * Every member is an explicit function over a **named constant** channel. There is no `invoke(channel, …)`
 * with a caller-supplied name anywhere in this file, and `pos-bridge.test.ts` asserts that mechanically —
 * one generic passthrough would turn fourteen audited doors into one unaudited one.
 *
 * Each handler answers `{ ok, value } | { ok, error }` (Task 9 Step 5), so this file unwraps: a rejected
 * promise carrying an `Error` loses its class across the bridge, and the renderer needs the `code` to pick a
 * message out of `packages/i18n` (spec:2061 — a component holds no string).
 *
 * **The code travels at the head of the message, `ERR_…: detail`, because the message is all that crosses.**
 * contextBridge copies a thrown `Error` into the page with its `message` and drops every other property
 * (Electron's context-bridge docs, the `Error` row), so a `code` field set here never reaches the renderer;
 * `apps/pos/src/renderer/lib/error-code.ts` reads it back from the message. `code` stays on the object for
 * callers in this world only.
 */
class TillError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TillError";
  }
}
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const answer = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; detail: string } };
  if (answer.ok) return answer.value;
  throw new TillError(answer.error.code, answer.error.detail);
};

const bridge: DuljaTillBridge = {
  app: {
    version: () => ipcRenderer.invoke(CHANNELS.appVersion),
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.appCheckForUpdates),
  },
  pos: {
    enrol: (code) => call(POS_CHANNELS.enrol, code) as Promise<{ terminalId: string }>,
    login: (input) =>
      call(POS_CHANNELS.login, input) as Promise<{
        principalId: string | null;
        codes: string[];
        branchId: string | null;
      }>,
    openShift: (input) => call(POS_CHANNELS.openShift, input) as Promise<{ shiftId: string }>,
    closeShift: (input) =>
      call(POS_CHANNELS.closeShift, input) as Promise<{
        shiftId: string;
        tickets: number;
        byMethod: Record<string, string>;
      }>,
    search: (input) => call(POS_CHANNELS.search, input) as Promise<unknown[]>,
    priceCheck: (input) => call(POS_CHANNELS.priceCheck, input) as Promise<unknown[]>,
    sell: (input) =>
      call(POS_CHANNELS.sell, input) as Promise<{ clientRef: string; total: string }>,
    tender: (input) =>
      call(POS_CHANNELS.tender, input) as Promise<{
        clientRef: string;
        payable: string;
        change: string;
        rounding: string;
      }>,
    clock: (kind) => call(POS_CHANNELS.clock, kind) as Promise<{ id: string }>,
    receipt: (clientRef) => call(POS_CHANNELS.receipt, clientRef),
    print: (clientRef) => call(POS_CHANNELS.print, clientRef) as Promise<void>,
    pull: () => call(POS_CHANNELS.pull) as Promise<void>,
    drain: () => call(POS_CHANNELS.drain) as Promise<void>,
    status: () => call(POS_CHANNELS.status),
  },
};

contextBridge.exposeInMainWorld("dulja", bridge);
