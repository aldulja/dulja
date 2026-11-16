import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { hashPin } from "@dulja/db/staff/pin";
import type { Change } from "@dulja/sync";
import { POS_CHANNELS } from "../../../apps/desktop/src/bridge-types";
import type { OpenTillOptions, OpenedTill } from "../../../apps/pos/src/main/entry";
import { CATALOGUE, SELLER } from "../../../apps/pos/test/support/catalogue";
import { serveRenderer, type ServedRenderer } from "./renderer-server";

/**
 * The till for acceptance test 23's POS half (6B T11 Step 6), assembled from what `pos.exe` itself runs.
 *
 * The plan's sample launches `pos.exe` through `_electron`. The packaged till is Windows-only (D1) and starts
 * unenrolled, so that launch belongs to CI's Windows `desktop` job; on the ubuntu `e2e` runner it could only
 * skip. What this suite proves there is the same renderer in the same engine family: the built
 * `apps/pos/dist`, served through the desktop's own `resolveRendererRequest` under the desktop's own
 * `CONTENT_SECURITY_POLICY`, at the desktop window's size, talking to the **built main-process bundle**
 * (`apps/pos/dist-main/pos-main.cjs`, the file `apps/desktop/src/main-pos.ts` loads) over the fourteen
 * `POS_CHANNELS`. Nothing on the page side is a stub: every call reaches the real handlers, PIN authority,
 * SQLite store and receipt builder, and a refusal reaches the page in the preload's `ERR_…: detail` form.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const RENDERER = join(ROOT, "apps", "pos", "dist");
const MAIN_BUNDLE = join(ROOT, "apps", "pos", "dist-main", "pos-main.cjs");

/** The cashier the fixture seeds: the renderer suite's (`apps/pos/test/renderer.test.tsx`). */
export const CASHIER = { employeeNumber: "CASH", pin: "4821" } as const;
/** The fixture catalogue's one item: `9001` scans it, and it sells at 3.3300 gross. */
export const ITEM = (() => {
  const row = CATALOGUE.find((change) => change.stream === "item")!.row as Record<string, string>;
  return { barcode: row["barcode"]!, nameEn: row["name_en"]!, nameAr: row["name_ar"]! };
})();

const PRINCIPAL = "019aaadb-0000-7000-8000-0000000000e1";
const TERMINAL = "019aaadb-0000-7000-8000-0000000000e2";
const COMPANY = "019aaadb-0000-7000-8000-0000000000e3";
const ITEM_ID = "019aaadb-0000-7000-8000-0000000000e4";
const UNIT_ID = "019aaadb-0000-7000-8000-0000000000e5";
/** `apps/pos/src/main/device.ts`'s one key: the identity and its private key are a single stored value. */
const IDENTITY_KEY = "dulja.pos.identity";

const run = (args: readonly string[]): Promise<void> =>
  new Promise((done, fail) => {
    const child = spawn("bun", args, {
      cwd: ROOT,
      stdio: "inherit",
      // As `boot.ts` explains: `bun` is a `.cmd` shim on some Windows machines and only a shell finds it.
      shell: process.platform === "win32",
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`bun ${args.join(" ")} exited ${String(code)}`)),
    );
  });

/**
 * The two steps `apps/desktop`'s `build:pos` starts with: the renderer, then the main-process bundle with the
 * same `.sql` text loader the packaged till embeds its schema through.
 */
export async function buildTill(): Promise<void> {
  await run(["run", "--cwd", "apps/pos", "build"]);
  await run(["run", "--cwd", "apps/pos", "build:main"]);
}

export type ServedTill = ServedRenderer;

/** `apps/pos/dist` under the desktop's CSP: `serveRenderer`'s contract, for the till. */
export const serveTill = (): Promise<ServedTill> => serveRenderer(RENDERER, "till");

interface TillModule {
  openTill(options: OpenTillOptions): Promise<OpenedTill>;
}

/** What `ipcMain.handle` hands a listener, as far as `allowEvent` below reads it. */
interface BindingEvent {
  sender: Page;
  senderFrame: Frame;
}

type Answer = { ok: true; value: unknown } | { ok: false; error: { code: string; detail: string } };

/** What an enrolled till has pulled: the renderer suite's catalogue and its one cashier. */
async function seed(till: OpenedTill): Promise<void> {
  await till.store.applyChanges(
    CATALOGUE.map((change) => ({
      ...change,
      id: change.stream === "item" ? ITEM_ID : change.id,
      row: {
        ...(change.row as Record<string, unknown>),
        ...(change.stream === "item" ? { id: ITEM_ID, base_unit_id: UNIT_ID } : {}),
        ...(change.stream === "price_list_line" ? { item_id: ITEM_ID } : {}),
      },
    })) as Change[],
  );
  till.store.finishCataloguePull();
  await till.store.applyChanges([
    {
      stream: "cashier",
      op: "upsert",
      id: PRINCIPAL,
      revision: 20n,
      row: {
        principal_id: PRINCIPAL,
        employee_id: PRINCIPAL,
        employee_number: CASHIER.employeeNumber,
        branch_id: "br-1",
        pin_hash: await hashPin(CASHIER.pin),
        snapshot: {
          codes: [
            ...SELLER.codes,
            "pos.price.check",
            "pos.customer.create",
            "pos.attendance.clock",
          ],
          limits: SELLER.limits,
          revision: "20",
        },
        revoked_at: null,
      },
    },
  ]);
}

/**
 * Opens the built till against an in-memory store for `page` and installs `window.dulja.pos` before the page
 * loads.
 *
 * The till is enrolled (a device identity on branch `br-1`) and has pulled the renderer suite's catalogue and
 * one cashier, `CASH`/`4821`, whose PIN hash is a real Argon2id one. Its sync loops are not started and its
 * transport points at a closed port, so it sells offline, as a till does when the network is down; the
 * status line says so.
 *
 * `enrolled: false` opens the till as `pos.exe` first starts instead: no device identity, no catalogue and no
 * cashier, so the page shows the enrol form, and an enrolment reaches the closed port and is refused.
 *
 * `allowEvent` is `main-pos.ts`'s check in Playwright's terms: a call is answered only when it comes from this
 * page's main frame on the till's own origin.
 */
export async function openTill(
  page: Page,
  origin: string,
  { enrolled = true }: { enrolled?: boolean } = {},
): Promise<OpenedTill> {
  const { openTill: open } = createRequire(import.meta.url)(MAIN_BUNDLE) as TillModule;
  const { privateKey } = generateKeyPairSync("ed25519");
  const stored = new Map<string, string>(
    enrolled
      ? [
          [
            IDENTITY_KEY,
            JSON.stringify({
              terminalId: TERMINAL,
              branchId: "br-1",
              companyId: COMPANY,
              pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            }),
          ],
        ]
      : [],
  );
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const till = await open({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    channels: POS_CHANNELS,
    dbPath: ":memory:",
    baseUrl: "http://127.0.0.1:9",
    deviceStore: {
      get: async (key) => stored.get(key) ?? null,
      set: async (key, value) => void stored.set(key, value),
      remove: async (key) => void stored.delete(key),
    },
    allowEvent: (raw) => {
      const event = raw as BindingEvent;
      return (
        event.sender === page &&
        event.senderFrame === page.mainFrame() &&
        new URL(event.senderFrame.url()).origin === origin
      );
    },
    print: async () => {},
    startLoops: false,
  });
  try {
    if (enrolled) await seed(till);
    await page.exposeBinding(
      "duljaTillIpc",
      async (source, method: string, args: unknown[]): Promise<unknown> => {
        const channel = (POS_CHANNELS as Readonly<Record<string, string>>)[method];
        const handler = channel === undefined ? undefined : handlers.get(channel);
        if (handler === undefined) throw new Error(`no POS handler for ${method}`);
        const event: BindingEvent = { sender: source.page, senderFrame: source.frame };
        return handler(event, ...args);
      },
    );
    // `preload-pos.ts`, page side: one explicit member per channel and the refusal as `ERR_…: detail`.
    await page.addInitScript((methods: readonly string[]) => {
      const bound = window as unknown as {
        duljaTillIpc(method: string, args: unknown[]): Promise<Answer>;
        dulja: { pos: Record<string, (...args: unknown[]) => Promise<unknown>> };
      };
      const call = async (method: string, args: unknown[]): Promise<unknown> => {
        const answer = await bound.duljaTillIpc(method, args);
        if (answer.ok) return answer.value;
        throw new Error(`${answer.error.code}: ${answer.error.detail}`);
      };
      bound.dulja = {
        pos: Object.fromEntries(
          methods.map((method) => [method, (...args: unknown[]) => call(method, args)]),
        ),
      };
    }, Object.keys(POS_CHANNELS));
  } catch (error) {
    await till.close();
    throw error;
  }
  return till;
}
