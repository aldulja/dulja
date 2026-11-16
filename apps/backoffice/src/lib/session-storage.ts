/**
 * Where the Supabase session lives, behind one interface so Task 11's Electron adapter drops in
 * without touching the login flow.
 *
 * This file is the renderer half of DoD 0.13 — "the token is not readable from disk in plain text"
 * (spec:2323). The desktop half refuses to write plaintext (`apps/desktop/src/secure-store.ts`);
 * this half refuses to route around that refusal. Read `electronSessionStore` before changing
 * anything here.
 */

export interface SessionStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Present only on a store that can *fail* to persist — the Electron one. `browserSessionStore`
   * omits it, which keeps `pickSessionStore({}) === browserSessionStore` an identity, not a copy.
   */
  persistence?: SessionPersistence;
}

/** Whether what this store was handed will still be there next launch, and how to hear it change. */
export interface SessionPersistence {
  durable(): boolean;
  subscribe(listener: () => void): () => void;
}

/**
 * The browser path: Vite dev, Playwright, and the app served from staging. In a plain browser there
 * is no Electron bridge and web storage is the only option there is — that is expected, and is not
 * the hazard `electronSessionStore` guards against.
 */
export const browserSessionStore: SessionStore = {
  getItem: async (key) => globalThis.localStorage?.getItem(key) ?? null,
  setItem: async (key, value) => {
    globalThis.localStorage?.setItem(key, value);
  },
  removeItem: async (key) => {
    globalThis.localStorage?.removeItem(key);
  },
};

/**
 * Declared structurally rather than imported: `apps/backoffice` may not import `apps/desktop`
 * (dependency-rule lint, AGENTS.md "applications import packages, never other applications"). The
 * source of truth for this shape is `apps/desktop/src/bridge-types.ts`; keep the two in step.
 */
export type AuthSetResult = { ok: true } | { ok: false; reason: "encryption-unavailable" };

export interface AuthBridge {
  get(key: string): Promise<string | null>;
  /** **Resolves** on refusal — it does not reject. See `electronSessionStore`. */
  set(key: string, value: string): Promise<AuthSetResult>;
  remove(key: string): Promise<void>;
}

/**
 * The Electron path: every byte goes through the contextBridge into `safeStorage` (Task 11).
 *
 * `bridge.set` **resolves** with `{ ok: false, reason: "encryption-unavailable" }` when the OS
 * keyring is missing — it does not reject, because `ipcMain.handle` flattens a thrown error into a
 * generic `Error` whose subclass identity does not survive IPC (ADR 0019 rule 4). TypeScript will
 * not force a caller to look at that result: ignoring it compiles cleanly and proceeds as though
 * the token were saved. The `if (result.ok)` below is the only thing standing between a refusal and
 * a silent lie, so:
 *
 * **On a refusal this store keeps the value in memory for this run and writes it NOWHERE else.** Not
 * `localStorage`, not `sessionStorage`, not IndexedDB, not a cookie. Every one of those is readable
 * from disk in plain text — falling back to any of them would put the refresh token in Chromium's
 * own LevelDB and defeat DoD 0.13 silently, on exactly the machines where encryption was
 * unavailable. The operator is told instead, through `persistence`.
 */
export function electronSessionStore(bridge: AuthBridge): SessionStore {
  /** Values the keyring refused. Process-lifetime only: nothing here is ever written to disk. */
  const memory = new Map<string, string>();
  const listeners = new Set<() => void>();
  let durable = true;

  const degrade = (): void => {
    if (!durable) return;
    durable = false;
    for (const listener of listeners) listener();
  };

  return {
    async getItem(key) {
      // The in-run value wins over the keyring's. After a refusal the keyring holds nothing for this
      // key — or worse, a value left by an earlier run — and handing that back would resurrect a
      // stale session rather than the one the operator just signed into.
      const held = memory.get(key);
      return held === undefined ? bridge.get(key) : held;
    },
    async setItem(key, value) {
      // A refusal RESOLVES, but the call can still *reject* — the IPC channel torn down during
      // shutdown, the main process gone. Left bare, that rejection travels out through `setItem`
      // into supabase-js and surfaces as raw IPC text where the sign-in error belongs. Either way
      // the token is not stored, so either way it takes the same path: memory for this run, and
      // the operator is told.
      let result: AuthSetResult;
      try {
        result = await bridge.set(key, value);
      } catch {
        result = { ok: false, reason: "encryption-unavailable" };
      }
      if (result.ok) {
        // Persisted encrypted: the memory overlay must not shadow it from here on.
        memory.delete(key);
        return;
      }
      memory.set(key, value);
      degrade();
    },
    async removeItem(key) {
      memory.delete(key);
      await bridge.remove(key);
    },
    // Arrow properties, not method shorthand: `useSyncExternalStore` is handed these detached from
    // the object, so neither may depend on `this`.
    persistence: {
      durable: () => durable,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

const noop = (): void => {};
const NEVER_DURABLE: SessionPersistence = { durable: () => false, subscribe: () => noop };

/**
 * Everything in the process heap and nothing on disk. Used when the app is plainly inside Electron
 * but the bridge is missing, where the browser store would be actively unsafe and no store at all
 * would mean no session.
 */
export function memorySessionStore(): SessionStore {
  const memory = new Map<string, string>();
  return {
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => {
      memory.set(key, value);
    },
    removeItem: async (key) => {
      memory.delete(key);
    },
    persistence: NEVER_DURABLE,
  };
}

/** The shape `pickSessionStore` sniffs. `window.dulja` exists only inside the Electron shell. */
type BridgeWindow = Window & { dulja?: { auth?: AuthBridge } };

/**
 * `dulja:` is the packaged app's own scheme (`APP_ORIGIN` in `apps/desktop/src/window-options.ts`),
 * duplicated rather than imported for the same reason `AuthSetResult` is. No browser serves it, so
 * together with the Electron user-agent token it is a sound "this is the desktop shell" signal.
 */
const APP_SCHEME = "dulja:";

const looksLikeElectron = (win: BridgeWindow | undefined): boolean =>
  /\bElectron\//.test(win?.navigator?.userAgent ?? "") || win?.location?.protocol === APP_SCHEME;

/** One decision point, so nothing else in the app tests for Electron. */
export function pickSessionStore(
  win: BridgeWindow | undefined = globalThis.window as BridgeWindow | undefined,
): SessionStore {
  const bridge = win?.dulja?.auth;
  if (bridge) return electronSessionStore(bridge);
  /*
   * Defence in depth for DoD 0.13. Inside Electron the preload is the only route to `safeStorage`;
   * if it failed to load, `window.dulja` is simply absent and this function would otherwise pick
   * the browser store — putting the refresh token in Chromium's LevelDB in plain text, silently,
   * on a machine nobody is watching. That is the exact failure the whole chain exists to prevent,
   * so a desktop shell with no bridge gets memory-only and the operator gets the warning.
   *
   * This is a backstop, not the fix: the preload must not be able to fail silently in the first
   * place, which is a packaging concern and is recorded against Task 12.
   */
  if (looksLikeElectron(win)) return memorySessionStore();
  return browserSessionStore;
}
