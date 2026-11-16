// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hashPin } from "@dulja/db/staff/pin";
import {
  CATALOGUES,
  formatMoney,
  formatTimestamp,
  type Locale,
  type TranslationKey,
} from "@dulja/i18n";
import type { Change } from "@dulja/sync";
import { App } from "../src/renderer/app";
import type { PosBridge, PosStatus } from "../src/renderer/lib/types";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { registerPosHandlers } from "../src/main/register";
import { CATALOGUE, SELLER } from "./support/catalogue";
const PRINCIPAL = "019aaadb-0000-7000-8000-000000000001";
const UNIT = "019aaadb-0000-7000-8000-000000000004";
const ITEM = "019aaadb-0000-7000-8000-000000000003";
const CUSTOMER = "019aaadb-0000-7000-8000-000000000005";
let sqliteDb: PosDatabase;
let store: SqliteSyncStore;
let bridge: PosBridge;
let pinHash: string;
beforeAll(async () => {
  pinHash = await hashPin("4821");
});
beforeEach(async () => {
  sqliteDb = openPosDatabase(":memory:");
  store = new SqliteSyncStore(sqliteDb);
  const catalogue = CATALOGUE.map((change) => ({
    ...change,
    id: change.id === "item-A" ? ITEM : change.id,
    row: {
      ...(change.row as Record<string, unknown>),
      ...(change.stream === "item" ? { id: ITEM, base_unit_id: UNIT } : {}),
      ...(change.stream === "price_list_line" ? { item_id: ITEM } : {}),
    },
  })) as Change[];
  await store.applyChanges(catalogue);
  store.finishCataloguePull();
  await store.applyChanges([
    {
      stream: "cashier",
      op: "upsert",
      id: PRINCIPAL,
      revision: 20n,
      row: {
        principal_id: PRINCIPAL,
        employee_id: PRINCIPAL,
        employee_number: "CASH",
        branch_id: "br-1",
        pin_hash: pinHash,
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
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const names = [
    "enrol",
    "login",
    "openShift",
    "closeShift",
    "search",
    "priceCheck",
    "sell",
    "tender",
    "clock",
    "receipt",
    "print",
    "pull",
    "drain",
    "status",
  ];
  registerPosHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    channels: Object.fromEntries(names.map((name) => [name, name])),
    db: sqliteDb,
    store,
    loops: createSyncLoops({
      store,
      transport: null,
      terminalId: PRINCIPAL,
      newBatchId: () => PRINCIPAL,
    }),
    baseUrl: "http://127.0.0.1",
    terminalId: PRINCIPAL,
    deviceStore: { get: async () => null, set: async () => {}, remove: async () => {} },
    allowEvent: () => true,
    print: async () => {},
    onEnrolled: async () => {},
  });
  bridge = Object.fromEntries(
    names.map((name) => [
      name,
      async (...args: unknown[]) => {
        const answer = (await handlers.get(name)!({}, ...args)) as {
          ok: boolean;
          value: unknown;
          error?: { code: string; detail: string };
        };
        // What the page receives in pos.exe: the preload rejects with `<code>: <detail>`, and Electron's
        // contextBridge copies a thrown Error into the page with its `message` only, so no `code` property here.
        if (!answer.ok) throw new Error(`${answer.error!.code}: ${answer.error!.detail}`);
        return answer.value;
      },
    ]),
  ) as unknown as PosBridge;
});
afterEach(() => {
  cleanup();
  sqliteDb.close();
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
/** A person types an amount; a keyboard-wedge scanner types a whole code within a few milliseconds. */
const person = () => userEvent.setup({ delay: 60 });
/** `toHaveTextContent` collapses the element's whitespace (Intl's no-break spaces included) but not ours. */
const norm = (text: string) => text.replace(/\s+/g, " ").trim();
for (const locale of ["en", "ar"] as const) {
  const t = (key: TranslationKey) => CATALOGUES[locale][key]!;
  async function signIn(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
    await user.type(screen.getByLabelText(t("pos.pin")), "4821");
    await user.click(screen.getByRole("button", { name: t("pos.login") }));
    await user.clear(await screen.findByLabelText(t("pos.openingFloat")));
    await user.type(screen.getByLabelText(t("pos.openingFloat")), "100");
    await user.click(screen.getByRole("button", { name: t("pos.openShift") }));
    await screen.findByLabelText(t("pos.barcode"));
  }
  describe(`actual main-process POS UI (${locale})`, () => {
    it("sells by keyboard, pays rounded cash and renders the actual persisted bilingual receipt", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      expect(await screen.findByLabelText(t("pos.amount"))).toHaveValue("3.3500");
      await user.clear(screen.getByLabelText(t("pos.amount")));
      await user.type(screen.getByLabelText(t("pos.amount")), "5");
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      const receipt = await screen.findByRole("article", { name: t("pos.receipt") });
      expect(receipt).toHaveTextContent(locale === "ar" ? "أرز" : "Rice");
      expect(receipt).toHaveTextContent(t("pos.numberPending"));
      // The line column is headed by what it holds, and the receipt says who sold it (6B T11's receipt).
      expect(
        within(receipt).getByRole("columnheader", { name: t("pos.item") }),
      ).toBeInTheDocument();
      expect(within(receipt).queryByRole("columnheader", { name: t("pos.search") })).toBeNull();
      expect(within(receipt).getByText(t("pos.cashier"))).toBeInTheDocument();
      expect(within(receipt).getByText(PRINCIPAL)).toBeInTheDocument();
      expect(sqliteDb.raw.prepare("select total,status from ticket").get()).toEqual({
        total: "3.3500",
        status: "completed",
      });
      expect(sqliteDb.raw.prepare("select amount from ticket_tender").get()).toEqual({
        amount: "3.3500",
      });
      expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 1 });
      await user.click(screen.getByRole("button", { name: t("pos.nextSale") }));
      await screen.findByLabelText(t("pos.barcode"));
    });
    it("price checks leave ticket/outbox state unchanged and wrong PINs do not sign in", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "9999");
      await user.click(screen.getByRole("button", { name: t("pos.login") }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText(t("pos.pin"))).toHaveValue("");
      await user.clear(screen.getByLabelText(t("pos.employeeNumber")));
      await signIn(user);
      const before = sqliteDb.raw.prepare("select count(*) n from outbox").get();
      await user.keyboard("{F2}");
      await user.type(await screen.findByLabelText(t("pos.priceCheckQuery")), "Rice");
      await user.click(screen.getByRole("button", { name: t("pos.search") }));
      await waitFor(() =>
        expect(screen.getByRole("list")).toHaveTextContent(locale === "ar" ? "أرز" : "Rice"),
      );
      expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 0 });
      expect(sqliteDb.raw.prepare("select count(*) n from outbox").get()).toEqual(before);
      await user.keyboard("{Escape}");
      await screen.findByLabelText(t("pos.barcode"));
    });
    it("tells a locked-out employee number to wait in the till's language, not main's English detail", async () => {
      sqliteDb.raw.prepare("insert into meta (key, value) values ('pin_attempt:CASH', ?)").run(
        JSON.stringify({
          failures: 5,
          lockedUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      );
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "4821");
      await user.click(screen.getByRole("button", { name: t("pos.login") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("pos.error.ERR_RATE_LIMITED"));
      expect(alert).not.toHaveTextContent("too many wrong PINs");
      expect(screen.getByLabelText(t("pos.pin"))).toHaveValue("");
      expect(screen.queryByLabelText(t("pos.openingFloat"))).toBeNull();
    });
    it("shows a refused PIN as its code's message in the till's language, never main's English detail", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "0000");
      await user.click(screen.getByRole("button", { name: t("pos.login") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("pos.error.ERR_TILL_PIN_INVALID"));
      expect(alert).not.toHaveTextContent("ERR_TILL_PIN_INVALID");
      expect(alert).not.toHaveTextContent("that PIN does not match");
    });
    it("shows a failed status read in the till's language once the catalogue has loaded", async () => {
      const failing: PosBridge = {
        ...bridge,
        status: () => Promise.reject(new Error("ERR_TILL_STORE_CORRUPT: local file unreadable")),
      };
      render(<App bridge={failing} initialLocale={locale} />);
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(t("pos.error.ERR_TILL_STORE_CORRUPT")),
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("local file unreadable");
    });
    it("cancels an unpaid ticket and records both drawer events through the real main handlers", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
      await user.type(screen.getByLabelText(t("pos.reason")), "Customer cancelled");
      await user.click(screen.getByRole("button", { name: t("shift.cancelDraft") }));
      await screen.findByLabelText(t("pos.barcode"));
      expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({ status: "voided" });
      expect(
        sqliteDb.raw.prepare("select count(*) n from outbox where kind='ticket'").get(),
      ).toEqual({ n: 0 });
      await user.keyboard("{F10}");
      await screen.findByLabelText(t("pos.countedCash"));
      for (const key of ["shift.no_sale", "shift.drawer_open"] as const) {
        const button = screen.getByRole("button", { name: t(key) });
        await waitFor(() => expect(button).toBeEnabled());
        await user.click(button);
      }
      await waitFor(() =>
        expect(sqliteDb.raw.prepare("select count(*) n from till_event").get()).toEqual({ n: 2 }),
      );
    });
    it("reloads an unpaid local ticket and resumes payment without a second sale", async () => {
      const user = userEvent.setup();
      const first = render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
      first.unmount();
      render(<App bridge={bridge} initialLocale={locale} />);
      expect(await screen.findByLabelText(t("pos.amount"))).toHaveValue("3.3500");
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
      expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 1 });
    });
    it("price checks a scanned barcode as well as a typed name, and writes nothing", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      const tickets = sqliteDb.raw.prepare("select count(*) n from ticket").get();
      const outbox = sqliteDb.raw.prepare("select count(*) n from outbox").get();
      await user.keyboard("{F2}");
      // A keyboard-wedge scanner types the code and presses Enter (D18). The fixture's Rice is barcode 9001 and
      // code SKU-A, so only a barcode lookup finds it: no code or name contains "9001".
      await user.type(await screen.findByLabelText(t("pos.priceCheckQuery")), "9001{Enter}");
      const list = await screen.findByRole("list");
      expect(list).toHaveTextContent(locale === "ar" ? "أرز" : "Rice");
      expect(list).toHaveTextContent(
        norm(formatMoney({ amount: "3.3300", currency: "MYR" }, { locale })),
      );
      expect(screen.queryByText(t("pos.success"))).toBeNull();
      expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual(tickets);
      expect(sqliteDb.raw.prepare("select count(*) n from outbox").get()).toEqual(outbox);
    });
    it("price check keeps each scan selected, so the next scan replaces it rather than appending", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      const rice = locale === "ar" ? "أرز" : "Rice";
      await user.keyboard("{F2}");
      const field = await screen.findByLabelText(t("pos.priceCheckQuery"));
      await user.type(field, "9001{Enter}");
      expect(await screen.findByRole("list")).toHaveTextContent(rice);
      expect(field).toHaveFocus();
      expect(field).toHaveValue("9001");
      // The scanner types into the focused field without clicking it, so the selection stands.
      await user.keyboard("zzzz{Enter}");
      expect(await screen.findByText(t("pos.noItems"))).toHaveAttribute("role", "status");
      expect(field).toHaveValue("zzzz");
      await user.keyboard("9001{Enter}");
      await waitFor(() => expect(screen.getByRole("list")).toHaveTextContent(rice));
      expect(field).toHaveValue("9001");
      // A name looked up with the button hands the cursor back to the field, ready for the next scan.
      await user.clear(field);
      await user.type(field, "Rice");
      await user.click(screen.getByRole("button", { name: t("pos.search") }));
      await waitFor(() => expect(field).toHaveFocus());
      await user.keyboard("zzzz{Enter}");
      expect(await screen.findByText(t("pos.noItems"))).toHaveAttribute("role", "status");
      expect(field).toHaveValue("zzzz");
    });
    it("Enter in a cancel or void field runs that action only, never completing the sale or closing the shift", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      expect(await screen.findByLabelText(t("pos.amount"))).toHaveValue("3.3500");
      expect(screen.getByLabelText(t("pos.amount"))).toHaveFocus();
      // The key map's path (`docs/ui/od-24-phase-6b-screens.md`): Shift+Tab twice from the amount, past the
      // method, reaches the reason. Forward Tab would reach the payment's own reference field instead.
      await user.tab({ shift: true });
      await user.tab({ shift: true });
      expect(screen.getByLabelText(t("pos.reason"))).toHaveFocus();
      // With no reason the cancel button is disabled, so Enter in its field does nothing: no payment is taken.
      await user.keyboard("{Enter}");
      expect(screen.getByLabelText(t("pos.amount"))).toBeInTheDocument();
      // With one, Enter cancels the ticket, as the button beside the field would.
      await user.keyboard("customer left{Enter}");
      await screen.findByLabelText(t("pos.barcode"));
      expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({ status: "voided" });
      expect(sqliteDb.raw.prepare("select count(*) n from ticket_tender").get()).toEqual({ n: 0 });

      const shift = () => sqliteDb.raw.prepare("select closed_at, counted_cash from shift").get();
      const { id } = sqliteDb.raw.prepare("select id from ticket").get() as { id: string };
      await user.keyboard("{F10}");
      // With no reason the void button is disabled, so Enter in the ticket field does nothing.
      await user.type(await screen.findByLabelText(t("shift.voidTicket")), `${id}{Enter}`);
      expect(screen.queryByRole("alert")).toBeNull();
      // With one, Enter runs the void, which this cashier may not do; it never runs the close beside it.
      await user.type(screen.getByLabelText(t("pos.reason")), "wrong ticket{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(t("pos.error.ERR_RBAC_FORBIDDEN"));
      expect(screen.getByLabelText(t("pos.countedCash"))).toBeInTheDocument();
      expect(shift()).toEqual({ closed_at: null, counted_cash: null });
      expect(sqliteDb.raw.prepare("select count(*) n from till_event").get()).toEqual({ n: 0 });
    });
    it("a refused scan or price check stays selected, so the next scan replaces it", async () => {
      // Each lookup is refused while its flag is set, as an archived tax code or an over-long misread would be.
      const refuse = { search: true, priceCheck: false };
      const refusing: PosBridge = {
        ...bridge,
        search: async (input) => {
          if (refuse.search) {
            refuse.search = false;
            throw new Error("ERR_VALIDATION_FAILED: barcode too long");
          }
          return bridge.search(input);
        },
        priceCheck: async (input) => {
          if (refuse.priceCheck) {
            refuse.priceCheck = false;
            throw new Error("ERR_TILL_CATALOGUE_STALE: tax code archived");
          }
          return bridge.priceCheck(input);
        },
      };
      const user = userEvent.setup();
      render(<App bridge={refusing} initialLocale={locale} />);
      await signIn(user);
      const rice = locale === "ar" ? "أرز" : "Rice";
      const scan = screen.getByLabelText(t("pos.barcode"));
      await user.type(scan, "9001{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        t("pos.error.ERR_VALIDATION_FAILED"),
      );
      expect(scan).toHaveFocus();
      expect(scan).toHaveValue("9001");
      // The scanner types into the focused field without clicking it, so the selection stands.
      await user.keyboard("9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      expect(screen.queryByRole("alert")).toBeNull();

      await user.keyboard("{F2}");
      const field = await screen.findByLabelText(t("pos.priceCheckQuery"));
      await user.type(field, "9001{Enter}");
      expect(await screen.findByRole("list")).toHaveTextContent(rice);
      refuse.priceCheck = true;
      await user.keyboard("9001{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        t("pos.error.ERR_TILL_CATALOGUE_STALE"),
      );
      // The refused scan does not leave the previous item's price on screen as if it were this one's.
      expect(screen.queryByRole("list")).toBeNull();
      expect(field).toHaveFocus();
      expect(field).toHaveValue("9001");
      await user.keyboard("9001{Enter}");
      expect(await screen.findByRole("list")).toHaveTextContent(rice);
      expect(field).toHaveValue("9001");
      expect(screen.queryByRole("alert")).toBeNull();
    });
    it("a supervisor's approval typed for a sale never voids or cancels a ticket", async () => {
      const sold: unknown[] = [];
      const recording: PosBridge = {
        ...bridge,
        sell: async (input) => {
          sold.push(input);
          return bridge.sell(input);
        },
      };
      const user = userEvent.setup();
      render(<App bridge={recording} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      // A supervisor approves something on the sell screen: a number, a PIN and a reason for that approval.
      await user.click(screen.getByText(t("pos.approval")));
      await user.type(screen.getByLabelText(t("pos.supervisor")), "SUP9");
      await user.type(screen.getByLabelText(t("pos.supervisorPin")), "1234");
      await user.type(screen.getByLabelText(t("pos.reason")), "price match");
      await user.keyboard("{F10}");
      // The void starts empty, so a scanned reference ending in Enter does nothing: no reason, no supervisor.
      expect(await screen.findByLabelText(t("pos.reason"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      await user.type(screen.getByLabelText(t("shift.voidTicket")), `${ITEM}{Enter}`);
      expect(screen.getByRole("button", { name: t("shift.void") })).toBeDisabled();
      // What a supervisor types for a void is forgotten when the cashier leaves the screen.
      await user.type(screen.getByLabelText(t("pos.reason")), "wrong ticket");
      await user.type(screen.getByLabelText(t("pos.supervisor")), "SUP9");
      await user.type(screen.getByLabelText(t("pos.supervisorPin")), "5678");
      await user.keyboard("{Escape}");
      await screen.findByLabelText(t("pos.barcode"));
      // The sale's own approval is untouched by the void's screen.
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("SUP9");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("1234");
      expect(screen.getByLabelText(t("pos.reason"))).toHaveValue("price match");
      await user.keyboard("{F10}");
      expect(await screen.findByLabelText(t("pos.reason"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      await user.keyboard("{Escape}");
      // Without a supervisor the sale carries no approval; the approval's reason does not become the
      // cancellation's or the void's.
      await user.clear(await screen.findByLabelText(t("pos.supervisor")));
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
      expect(screen.getByLabelText(t("pos.reason"))).toHaveValue("");
      expect(screen.getByRole("button", { name: t("shift.cancelDraft") })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
      expect(screen.getByLabelText(t("pos.reason"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      expect(screen.getByRole("button", { name: t("shift.void") })).toBeDisabled();
      expect(sold.filter((input) => (input as { action?: string }).action !== undefined)).toEqual(
        [],
      );
      expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({
        status: "completed",
      });
    });
    it("a cancelled ticket stays closed when the bridge answers on a later task, as IPC does", async () => {
      // In pos.exe every bridge call is `ipcRenderer.invoke`, which settles on a later macrotask, so React renders
      // between the cancel and the status read that follows it. The suite's own bridge settles in microtasks and
      // never shows that render: there, the status read taken before the cancel still named the ticket as open,
      // and its payment screen came back with every key and button refused until the till restarted.
      const later = Object.fromEntries(
        Object.entries(bridge).map(([name, call]) => [
          name,
          async (...args: unknown[]) => {
            const value = await (call as (...a: unknown[]) => Promise<unknown>)(...args);
            await new Promise((settle) => setTimeout(settle, 15));
            return value;
          },
        ]),
      ) as unknown as PosBridge;
      const user = userEvent.setup();
      render(<App bridge={later} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
      await user.type(screen.getByLabelText(t("pos.reason")), "Customer cancelled{Enter}");
      expect(await screen.findByLabelText(t("pos.barcode"))).toBeInTheDocument();
      await new Promise((settle) => setTimeout(settle, 300));
      expect(screen.queryByLabelText(t("pos.amount"))).toBeNull();
      expect(screen.getByLabelText(t("pos.barcode"))).toBeInTheDocument();
      expect(screen.getByRole("button", { name: t("pos.lock") })).toBeEnabled();
      expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({ status: "voided" });
    });
    it("each shift is counted afresh: typing the next float or count replaces the last one", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "4821{Enter}");
      // The od-24 key map: type the float, Enter; F10, type the count, Enter, then Tab and Enter to confirm the
      // close's review (UI-02). No clearing in between.
      expect(await screen.findByLabelText(t("pos.openingFloat"))).toHaveFocus();
      await user.keyboard("100{Enter}");
      await screen.findByLabelText(t("pos.barcode"));
      await user.keyboard("{F10}");
      expect(await screen.findByLabelText(t("pos.countedCash"))).toHaveFocus();
      await user.keyboard("100{Enter}");
      await screen.findByRole("region", { name: t("pos.confirmClose") });
      await user.keyboard("{Tab}{Enter}");
      expect(await screen.findByLabelText(t("pos.openingFloat"))).toHaveFocus();
      await user.keyboard("150{Enter}");
      await screen.findByLabelText(t("pos.barcode"));
      // The last close's summary belongs to the shift it closed, not to this one.
      expect(screen.queryByText(t("pos.localTotals"))).toBeNull();
      await user.keyboard("{F10}");
      expect(await screen.findByLabelText(t("pos.countedCash"))).toHaveFocus();
      await user.keyboard("150{Enter}");
      await screen.findByRole("region", { name: t("pos.confirmClose") });
      await user.keyboard("{Tab}{Enter}");
      await screen.findByLabelText(t("pos.openingFloat"));
      expect(
        sqliteDb.raw
          .prepare("select opening_float, counted_cash from shift order by opened_at, rowid")
          .all(),
      ).toEqual([
        { opening_float: "100.0000", counted_cash: "100.0000" },
        { opening_float: "150.0000", counted_cash: "150.0000" },
      ]);
    });
    it("⚠️ OD-10: the shift view records a safe drop, and a paid-out waits for its receipt number", async () => {
      const sold: unknown[] = [];
      const recording: PosBridge = {
        ...bridge,
        sell: async (input) => {
          sold.push(input);
          return bridge.sell(input);
        },
      };
      const user = userEvent.setup();
      render(<App bridge={recording} initialLocale={locale} />);
      await signIn(user);
      await user.keyboard("{F10}");
      const kind = await screen.findByLabelText(t("shift.cashKind"));
      // A paid-out (the default) cannot be recorded without its receipt or voucher number.
      expect(kind).toHaveValue("paid_out");
      expect(screen.getByLabelText(t("shift.cashSupervisor"))).toHaveValue("");
      expect(screen.getByRole("button", { name: t("shift.recordCash") })).toBeDisabled();
      // A safe drop needs neither a reference nor a supervisor, and its form has no supervisor fields.
      await user.selectOptions(kind, "safe_drop");
      expect(screen.queryByLabelText(t("shift.cashSupervisor"))).toBeNull();
      await user.clear(screen.getByLabelText(t("shift.amount")));
      await user.type(screen.getByLabelText(t("shift.amount")), "30{Enter}");
      await waitFor(() =>
        expect(sold).toEqual([
          {
            action: "cash_movement",
            shiftId: expect.any(String),
            kind: "safe_drop",
            amount: "30.0000",
            fromSafe: false,
          },
        ]),
      );
      expect(sqliteDb.raw.prepare("select kind, amount from cash_event").all()).toEqual([
        { kind: "safe_drop", amount: "30.0000" },
      ]);
      // The form empties after recording, so a second Enter does not drop the same notes twice.
      expect(screen.getByLabelText(t("shift.amount"))).toHaveValue("0");
      // Banking from the safe sends fromSafe: true.
      await user.selectOptions(screen.getByLabelText(t("shift.cashKind")), "bank_safe");
      await user.clear(screen.getByLabelText(t("shift.amount")));
      await user.type(screen.getByLabelText(t("shift.amount")), "30");
      await user.click(screen.getByRole("button", { name: t("shift.recordCash") }));
      await waitFor(() => expect(sold).toHaveLength(2));
      expect(sold[1]).toMatchObject({ kind: "banking", fromSafe: true, amount: "30.0000" });
    });
    it("a Lock forgets every approval typed for the cashier who locked", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.click(screen.getByText(t("pos.approval")));
      await user.type(screen.getByLabelText(t("pos.supervisor")), "SUP9");
      await user.type(screen.getByLabelText(t("pos.supervisorPin")), "1234");
      await user.type(screen.getByLabelText(t("pos.reason")), "price match");
      await user.click(screen.getByRole("button", { name: t("pos.remove") }));
      await user.keyboard("{F10}");
      await user.type(await screen.findByLabelText(t("pos.reason")), "for A");
      await user.type(screen.getByLabelText(t("pos.supervisor")), "SUP9");
      await user.type(screen.getByLabelText(t("pos.supervisorPin")), "5678");
      await user.click(screen.getByRole("button", { name: t("pos.lock") }));
      await user.clear(await screen.findByLabelText(t("pos.employeeNumber")));
      await user.type(screen.getByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "4821{Enter}");
      // The till comes back to the shift screen it locked on, with the void's approval gone.
      expect(await screen.findByLabelText(t("pos.reason"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      await user.keyboard("{Escape}");
      await screen.findByLabelText(t("pos.barcode"));
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.reason"))).toHaveValue("");
    });
    it("a sign-out main forces, when the cashier's authority changes, forgets the sale's approval too", async () => {
      const sold: unknown[] = [];
      const recording: PosBridge = {
        ...bridge,
        sell: async (input) => {
          sold.push(input);
          return bridge.sell(input);
        },
      };
      const user = userEvent.setup();
      render(<App bridge={recording} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.click(screen.getByText(t("pos.approval")));
      await user.type(screen.getByLabelText(t("pos.supervisor")), "SUP9");
      await user.type(screen.getByLabelText(t("pos.supervisorPin")), "1234");
      await user.type(screen.getByLabelText(t("pos.reason")), "price match");
      // The back office edits this cashier's role and the till pulls the new snapshot: main refuses the next
      // call and drops the session, with no Lock pressed.
      sqliteDb.raw
        .prepare(
          "update catalogue_cashier set snapshot_json = json_set(snapshot_json, '$.revision', '21')",
        )
        .run();
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(t("pos.error.ERR_RBAC_FORBIDDEN"));
      // The refusal reads the till's state again at once, so the sign-in screen follows without a Sync.
      await user.clear(await screen.findByLabelText(t("pos.employeeNumber")));
      await user.type(screen.getByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "4821{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.click(screen.getByText(t("pos.approval")));
      expect(screen.getByLabelText(t("pos.supervisor"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.supervisorPin"))).toHaveValue("");
      expect(screen.getByLabelText(t("pos.reason"))).toHaveValue("");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
      expect(sold).toHaveLength(1);
      expect(sold[0]).toMatchObject({ approvals: [] });
    });
    it("price check shows a promotion between the list price and the total it produces", async () => {
      // The first lookup answers as an active 1.00 promotion would (`pricing.ts` prices the tax and total after
      // it); the second is the catalogue's own, with none.
      let lookups = 0;
      const promoted: PosBridge = {
        ...bridge,
        priceCheck: async (query) => {
          const quotes = (await bridge.priceCheck(query)) as Record<string, unknown>[];
          lookups += 1;
          return lookups > 1
            ? quotes
            : quotes.map((q) => ({
                ...q,
                promotionDiscount: "1.0000",
                total: "2.3300",
                taxAmount: "0.0000",
              }));
        },
      };
      const user = userEvent.setup();
      render(<App bridge={promoted} initialLocale={locale} />);
      await signIn(user);
      await user.keyboard("{F2}");
      await user.type(await screen.findByLabelText(t("pos.priceCheckQuery")), "Rice{Enter}");
      const line = await screen.findByRole("listitem");
      const money = (amount: string) => formatMoney({ amount, currency: "MYR" }, { locale });
      expect(norm(line.textContent ?? "")).toContain(
        norm(`${t("pos.promotionDiscount")}: ${money("1.0000")}`),
      );
      expect(norm(line.textContent ?? "")).toContain(norm(`${t("pos.total")}: ${money("2.3300")}`));
      // With no promotion there is no promotion figure.
      await user.keyboard("Rice{Enter}");
      await waitFor(() => expect(lookups).toBe(2));
      expect(await screen.findByRole("listitem")).not.toHaveTextContent(t("pos.promotionDiscount"));
    });
    it("an unknown barcode or empty lookup says so and never shows success", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      const tickets = sqliteDb.raw.prepare("select count(*) n from ticket").get();
      const outbox = sqliteDb.raw.prepare("select count(*) n from outbox").get();
      const scan = screen.getByLabelText(t("pos.barcode"));
      await user.type(scan, "0000000000000{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(t("pos.error.ERR_NOT_FOUND"));
      expect(screen.queryByText(t("pos.success"))).toBeNull();
      expect(screen.getByText(t("pos.empty"))).toBeInTheDocument();
      expect(screen.queryByLabelText(t("pos.quantity"))).toBeNull();
      // The misread code stays visible and selected, so the next scan replaces it rather than appending to it.
      expect(scan).toHaveFocus();
      expect(scan).toHaveValue("0000000000000");
      // The scanner types into the focused field without clicking it, so the selection stands.
      await user.keyboard("9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText(t("pos.success"))).toBeNull();
      await user.click(screen.getByRole("button", { name: t("pos.remove") }));

      await user.type(screen.getByLabelText(t("pos.query")), "zzzz{Enter}");
      expect(await screen.findByText(t("pos.noItems"))).toHaveAttribute("role", "status");
      expect(screen.queryByText(t("pos.success"))).toBeNull();

      await user.keyboard("{F2}");
      await user.type(await screen.findByLabelText(t("pos.priceCheckQuery")), "zzzz{Enter}");
      expect(await screen.findByText(t("pos.noItems"))).toHaveAttribute("role", "status");
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.queryByText(t("pos.success"))).toBeNull();

      await user.keyboard("{F4}");
      await user.type(await screen.findByLabelText(t("pos.customerQuery")), "zzzz{Enter}");
      expect(await screen.findByText(t("pos.noCustomers"))).toHaveAttribute("role", "status");
      expect(screen.queryByText(t("pos.success"))).toBeNull();
      // The customer search says what it searches: it once borrowed the items' "Search items".
      expect(screen.getByRole("button", { name: t("pos.searchCustomers") })).toBeEnabled();
      expect(screen.queryByRole("button", { name: t("pos.search") })).toBeNull();

      expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual(tickets);
      expect(sqliteDb.raw.prepare("select count(*) n from outbox").get()).toEqual(outbox);
    });
    it("says an expired or used enrolment code is the problem, in the till's words", async () => {
      const unenrolled: PosBridge = {
        ...bridge,
        status: async () => ({
          ...((await bridge.status()) as Record<string, unknown>),
          enrolled: false,
        }),
        enrol: async () => {
          throw new Error("ERR_TERMINAL_ENROLMENT_INVALID: enrolment code expired");
        },
      };
      const user = userEvent.setup();
      render(<App bridge={unenrolled} initialLocale={locale} />);
      await user.type(await screen.findByLabelText(t("pos.enrolCode")), `${"A".repeat(32)}{Enter}`);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("pos.error.ERR_TERMINAL_ENROLMENT_INVALID"));
      expect(alert).not.toHaveTextContent(t("pos.error.ERR_INTERNAL"));
      expect(alert).not.toHaveTextContent("ERR_TERMINAL_ENROLMENT_INVALID");
    });
    it("refuses a non-sale original in the till's words, not as an internal fault", async () => {
      // The till only holds the tickets it sold, so the receipt it reads back is presented as a return's.
      const asReturn: PosBridge = {
        ...bridge,
        receipt: async (clientRef: string) => ({
          ...((await bridge.receipt(clientRef)) as Record<string, unknown>),
          kind: "return",
        }),
      };
      const user = userEvent.setup();
      render(<App bridge={asReturn} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await user.click(await screen.findByRole("button", { name: t("pos.complete") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
      await user.click(screen.getByRole("button", { name: t("pos.nextSale") }));
      const { id } = sqliteDb.raw.prepare("select id from ticket").get() as { id: string };
      await user.click(await screen.findByRole("checkbox", { name: t("pos.return") }));
      await user.type(screen.getByLabelText(t("pos.original")), id);
      await user.click(screen.getByRole("button", { name: t("pos.loadOriginal") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("pos.originalSaleRequired"));
      expect(alert).not.toHaveTextContent(t("pos.error.ERR_INTERNAL"));
      expect(screen.getByText(t("pos.empty"))).toBeInTheDocument();
    });
    it("says a return of an account sale is credited to the account, before it is taken and on the receipt", async () => {
      await store.applyChanges([
        {
          stream: "customer",
          op: "upsert",
          id: CUSTOMER,
          revision: 40n,
          row: {
            id: CUSTOMER,
            code: "C-001",
            name_en: "Ahmad Trading",
            name_ar: "أحمد للتجارة",
            phone: null,
            currency: "MYR",
            credit_limit: "100.0000",
            credit_hold: false,
          },
        },
      ]);
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.keyboard("{F4}");
      await user.type(await screen.findByLabelText(t("pos.customerQuery")), "Ahmad{Enter}");
      await user.click(await screen.findByRole("button", { name: /C-001/ }));
      await user.type(await screen.findByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.click(screen.getByRole("checkbox", { name: t("pos.account") }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      // The sale went on the account: its receipt names that instead of listing no payment at all.
      const sale = await screen.findByRole("article", { name: t("pos.receipt") });
      expect(sale).toHaveTextContent(t("pos.chargedToAccount"));
      expect(sale).not.toHaveTextContent(t("pos.refundedToAccount"));
      await user.click(screen.getByRole("button", { name: t("pos.nextSale") }));
      const { id } = sqliteDb.raw.prepare("select id from ticket").get() as { id: string };
      await user.click(await screen.findByRole("checkbox", { name: t("pos.return") }));
      await user.type(screen.getByLabelText(t("pos.original")), id);
      await user.click(screen.getByRole("button", { name: t("pos.loadOriginal") }));
      // Told before the return is taken that nothing is paid out of the drawer.
      expect(await screen.findByText(t("pos.returnToAccount"))).toHaveAttribute("role", "status");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      // No payment step: the receipt, which says where the refund went, and the same instruction beside it.
      const refund = await screen.findByRole("article", { name: t("pos.receipt") });
      expect(screen.queryByLabelText(t("pos.amount"))).toBeNull();
      expect(refund).toHaveTextContent(t("pos.refundedToAccount"));
      expect(refund).toHaveTextContent(
        norm(
          `${t("pos.refundedToAccount")}: ${formatMoney({ amount: "-3.3300", currency: "MYR" }, { locale })}`,
        ),
      );
      expect(refund).not.toHaveTextContent(t("pos.chargedToAccount"));
      expect(screen.getByText(t("pos.returnToAccount"))).toHaveAttribute("role", "status");
      expect(
        sqliteDb.raw
          .prepare(
            `select k.status, k.customer_id, (select count(*) from ticket_tender t where t.ticket_id = k.id) n
               from ticket k where k.kind = 'return'`,
          )
          .get(),
      ).toEqual({ status: "completed", customer_id: CUSTOMER, n: 0 });
      // Leaving the receipt forgets the loaded original, so the next ticket is not told it is on account.
      await user.click(screen.getByRole("button", { name: t("pos.nextSale") }));
      await screen.findByLabelText(t("pos.barcode"));
      expect(screen.queryByText(t("pos.returnToAccount"))).toBeNull();
    });
  });
  describe(`till safety, full review 2026-11-15 (${locale})`, () => {
    const shifts = () =>
      sqliteDb.raw.prepare("select closed_at, counted_cash from shift order by rowid").all();
    async function keyboardSignIn(user: ReturnType<typeof userEvent.setup>) {
      await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "CASH");
      await user.type(screen.getByLabelText(t("pos.pin")), "4821{Enter}");
      await screen.findByLabelText(t("pos.openingFloat"));
    }
    async function toTender(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      await screen.findByLabelText(t("pos.amount"));
    }
    it("UI-02: a scan or a bare Enter on the shift view never closes the shift", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await keyboardSignIn(user);
      await user.keyboard("100{Enter}");
      await screen.findByLabelText(t("pos.barcode"));
      await user.keyboard("{F10}");
      await screen.findByLabelText(t("pos.countedCash"));
      await user.keyboard("9556001234567{Enter}");
      await pause();
      await user.keyboard("{Enter}");
      await pause();
      expect(shifts()).toEqual([{ closed_at: null, counted_cash: null }]);
      expect(screen.getByRole("alert")).toHaveTextContent(t("pos.countLooksLikeScan"));
    });
    it("UI-02: the first scan after sign-in never opens the shift with the barcode as its float", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await keyboardSignIn(user);
      await user.keyboard("9556001234567{Enter}");
      await pause();
      expect(shifts()).toEqual([]);
      expect(screen.getByLabelText(t("pos.openingFloat"))).toHaveValue("");
      expect(screen.getByRole("alert")).toHaveTextContent(t("pos.countLooksLikeScan"));
    });
    it("UI-02: a typed count closes only once its review is confirmed; Enter on the review goes back", async () => {
      const user = person();
      render(<App bridge={bridge} initialLocale={locale} />);
      await keyboardSignIn(user);
      await user.keyboard("100{Enter}");
      await screen.findByLabelText(t("pos.barcode"));
      await user.keyboard("{F10}");
      await screen.findByLabelText(t("pos.countedCash"));
      await user.keyboard("103.35{Enter}");
      const review = await screen.findByRole("region", { name: t("pos.confirmClose") });
      expect(review).toHaveTextContent(
        norm(formatMoney({ amount: "103.3500", currency: "MYR" }, { locale })),
      );
      expect(review).toHaveTextContent(
        norm(formatMoney({ amount: "100.0000", currency: "MYR" }, { locale })),
      );
      expect(screen.getByRole("button", { name: t("pos.changeCount") })).toHaveFocus();
      // A stray Enter (a scanner's, say) goes back to the count; it never confirms.
      await user.keyboard("{Enter}");
      expect(await screen.findByLabelText(t("pos.countedCash"))).toHaveFocus();
      expect(shifts()).toEqual([{ closed_at: null, counted_cash: null }]);
      await user.keyboard("103.35{Enter}");
      await screen.findByRole("region", { name: t("pos.confirmClose") });
      await user.keyboard("{Tab}");
      expect(screen.getByRole("button", { name: t("pos.confirmClose") })).toHaveFocus();
      await user.keyboard("{Enter}");
      await screen.findByLabelText(t("pos.openingFloat"));
      expect(shifts()).toEqual([{ closed_at: expect.any(String), counted_cash: "103.3500" }]);
    });
    it("UI-14: an empty discount is none; a bad amount is a validation refusal naming its field; local digits are read", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await user.clear(await screen.findByLabelText(t("pos.discount")));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
      await user.keyboard("{F8}");
      const amount = await screen.findByLabelText(t("pos.amount"));
      expect(screen.queryByRole("alert")).toBeNull();
      await user.clear(amount);
      await user.type(amount, "1.23456");
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(t("pos.error.ERR_VALIDATION_FAILED"));
      expect(alert).toHaveTextContent(t("pos.amount"));
      expect(alert).not.toHaveTextContent(t("pos.error.ERR_INTERNAL"));
      await user.clear(amount);
      await user.type(amount, "٥٫٠٠");
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
    });
    it("UI-15: after Complete the cursor is on Next sale, and a scan there starts the next sale", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await toTender(user);
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
      expect(screen.getByRole("button", { name: t("pos.nextSale") })).toHaveFocus();
      await user.keyboard("9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      expect(screen.queryByRole("article", { name: t("pos.receipt") })).toBeNull();
      expect(screen.getAllByLabelText(t("pos.quantity"))).toHaveLength(1);
    });
    it("UI-16/POS-20: a receipt that cannot be shown after a completed tender never strands the payment screen", async () => {
      let failed = false;
      const flaky: PosBridge = {
        ...bridge,
        receipt: async (clientRef) => {
          if (!failed) {
            failed = true;
            throw new Error("ERR_RBAC_FORBIDDEN: session changed");
          }
          return bridge.receipt(clientRef);
        },
      };
      const user = userEvent.setup();
      render(<App bridge={flaky} initialLocale={locale} />);
      await signIn(user);
      await toTender(user);
      await user.click(screen.getByRole("button", { name: t("pos.complete") }));
      expect(await screen.findByText(t("pos.receiptUnavailable"))).toBeInTheDocument();
      expect(screen.queryByLabelText(t("pos.amount"))).toBeNull();
      await user.click(screen.getByRole("button", { name: t("pos.showReceipt") }));
      await screen.findByRole("article", { name: t("pos.receipt") });
      await user.click(screen.getByRole("button", { name: t("pos.nextSale") }));
      await screen.findByLabelText(t("pos.barcode"));
      expect(sqliteDb.raw.prepare("select status from ticket").all()).toEqual([
        { status: "completed" },
      ]);
    });
    it("UI-22: after a clicked button the next scan goes to the scan field, and its Enter never clicks again", async () => {
      const user = userEvent.setup();
      render(<App bridge={bridge} initialLocale={locale} />);
      await signIn(user);
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.click(screen.getByRole("button", { name: t("pos.remove") }));
      await user.keyboard("9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await user.keyboard("{F10}");
      await screen.findByLabelText(t("pos.countedCash"));
      const noSale = screen.getByRole("button", { name: t("shift.no_sale") });
      await waitFor(() => expect(noSale).toBeEnabled());
      await user.click(noSale);
      await waitFor(() =>
        expect(sqliteDb.raw.prepare("select count(*) n from till_event").get()).toEqual({ n: 1 }),
      );
      await user.keyboard("9556001234567{Enter}");
      await pause();
      expect(sqliteDb.raw.prepare("select count(*) n from till_event").get()).toEqual({ n: 1 });
      expect(shifts()).toEqual([{ closed_at: null, counted_cash: null }]);
    });
    it("POS-03: a hung Sync never holds the sale keys", async () => {
      const hung: PosBridge = { ...bridge, drain: () => new Promise(() => {}) };
      const user = userEvent.setup();
      render(<App bridge={hung} initialLocale={locale} />);
      await signIn(user);
      await user.click(screen.getByRole("button", { name: t("pos.drain") }));
      await user.type(screen.getByLabelText(t("pos.barcode")), "9001{Enter}");
      await screen.findByLabelText(t("pos.quantity"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: t("pos.submit") })).toBeEnabled(),
      );
    });
    it("POS-18: a Sync that failed says so, never Completed", async () => {
      const down: PosBridge = {
        ...bridge,
        drain: () =>
          Promise.reject(new Error("ERR_INTERNAL: the till could not reach the sync API")),
      };
      const user = userEvent.setup();
      render(<App bridge={down} initialLocale={locale} />);
      await signIn(user);
      await user.click(screen.getByRole("button", { name: t("pos.drain") }));
      expect(await screen.findByText(t("pos.syncFailed"))).toBeInTheDocument();
      expect(screen.queryByText(t("pos.success"))).toBeNull();
    });
    describe("POS-04: another cashier's unfinished ticket", () => {
      beforeEach(async () => {
        await store.applyChanges([
          {
            stream: "cashier",
            op: "upsert",
            id: CUSTOMER,
            revision: 21n,
            row: {
              principal_id: CUSTOMER,
              employee_id: CUSTOMER,
              employee_number: "SUP",
              branch_id: "br-1",
              pin_hash: pinHash,
              snapshot: {
                codes: [...SELLER.codes, "pos.shift.close_any"],
                limits: SELLER.limits,
                revision: "21",
              },
              revoked_at: null,
            },
          },
        ]);
      });
      it("a close_any supervisor cancels the departed cashier's draft from the shift view and closes", async () => {
        const user = userEvent.setup();
        const first = render(<App bridge={bridge} initialLocale={locale} />);
        await signIn(user);
        await toTender(user);
        first.unmount();
        await bridge.login({ logout: true });
        render(<App bridge={bridge} initialLocale={locale} />);
        await user.type(await screen.findByLabelText(t("pos.employeeNumber")), "SUP");
        await user.type(screen.getByLabelText(t("pos.pin")), "4821{Enter}");
        await screen.findByLabelText(t("pos.barcode"));
        await user.keyboard("{F10}");
        const unfinished = await screen.findByRole("region", { name: t("pos.unfinishedTickets") });
        await user.type(within(unfinished).getByLabelText(t("pos.reason")), "Cashier went home");
        await user.click(within(unfinished).getByRole("button", { name: t("shift.cancelDraft") }));
        await waitFor(() =>
          expect(screen.queryByRole("region", { name: t("pos.unfinishedTickets") })).toBeNull(),
        );
        expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({
          status: "voided",
        });
        await user.type(screen.getByLabelText(t("pos.countedCash")), "100{Enter}");
        await user.click(await screen.findByRole("button", { name: t("pos.confirmClose") }));
        await screen.findByLabelText(t("pos.openingFloat"));
        expect(shifts()).toEqual([{ closed_at: expect.any(String), counted_cash: "100.0000" }]);
      });
      it("a change of signed-in cashier clears the last cashier's payment screen", async () => {
        const user = userEvent.setup();
        render(<App bridge={bridge} initialLocale={locale} />);
        await signIn(user);
        await toTender(user);
        // Main drops the session and another cashier signs in, with no Lock pressed on this screen.
        await bridge.login({ logout: true });
        await bridge.login({ employeeNumber: "SUP", pin: "4821" });
        await user.click(screen.getByRole("button", { name: t("pos.complete") }));
        await waitFor(() => expect(screen.queryByLabelText(t("pos.amount"))).toBeNull());
        expect(await screen.findByLabelText(t("pos.barcode"))).toBeInTheDocument();
        expect(sqliteDb.raw.prepare("select status from ticket").get()).toEqual({ status: "open" });
      });
    });
  });
  describe(`honest offline indicator (${locale})`, () => {
    /** The real main-process handlers, with only the sync state the indicator reads replaced. */
    const withStatus = (over: Partial<PosStatus>): PosBridge => ({
      ...bridge,
      status: async () => ({ ...((await bridge.status()) as PosStatus), ...over }),
    });
    const AT = "2026-06-15T09:00:00.000Z";
    it("shows online, the catalogue revision, the time it arrived and the pending count", async () => {
      render(
        <App
          bridge={withStatus({
            online: true,
            catalogueRevision: "412",
            catalogueAt: AT,
            pendingOutbox: 0,
          })}
          initialLocale={locale}
        />,
      );
      const indicator = await screen.findByRole("complementary");
      await waitFor(() => expect(within(indicator).getByText(t("pos.online"))).toBeInTheDocument());
      expect(within(indicator).queryByText(t("pos.offline"))).toBeNull();
      expect(indicator).toHaveTextContent(`${t("pos.catalogueRevision")}: 412`);
      expect(indicator).toHaveTextContent(
        norm(`${t("pos.catalogueAt")}: ${formatTimestamp(AT, { locale })}`),
      );
      expect(indicator).toHaveTextContent(`${t("pos.pending")}: 0`);
    });
    it("shows Offline and the unsent count, and keeps the catalogue time", async () => {
      render(
        <App
          bridge={withStatus({
            online: false,
            catalogueRevision: "412",
            catalogueAt: AT,
            pendingOutbox: 137,
          })}
          initialLocale={locale}
        />,
      );
      const indicator = await screen.findByRole("complementary");
      await waitFor(() => expect(indicator).toHaveTextContent(`${t("pos.pending")}: 137`));
      expect(within(indicator).getByText(t("pos.offline"))).toBeInTheDocument();
      expect(within(indicator).queryByText(t("pos.online"))).toBeNull();
      // Never the state alone: an offline till still says which catalogue it is pricing from, and since when.
      expect(indicator).toHaveTextContent(
        norm(`${t("pos.catalogueAt")}: ${formatTimestamp(AT, { locale })}`),
      );
      expect(indicator).toHaveTextContent(`${t("pos.catalogueRevision")}: 412`);
    });
    it("says plainly when the till has never pulled", async () => {
      render(
        <App
          bridge={withStatus({
            online: false,
            catalogueAt: null,
            catalogueRevision: "0",
            pendingOutbox: 3,
          })}
          initialLocale={locale}
        />,
      );
      const indicator = await screen.findByRole("complementary");
      // The pending count proves the stub's state has arrived; before it does, the indicator shows its defaults.
      await waitFor(() => expect(indicator).toHaveTextContent(`${t("pos.pending")}: 3`));
      expect(indicator).toHaveTextContent(`${t("pos.catalogueAt")}: ${t("pos.never")}`);
      expect(indicator).toHaveTextContent(`${t("pos.catalogueRevision")}: 0`);
      expect(within(indicator).getByText(t("pos.offline"))).toBeInTheDocument();
    });
    it("shows the real main process's state: offline with no transport, and the time of the last pull", async () => {
      render(<App bridge={bridge} initialLocale={locale} />);
      const indicator = await screen.findByRole("complementary");
      await waitFor(() =>
        expect(indicator).not.toHaveTextContent(`${t("pos.catalogueAt")}: ${t("pos.never")}`),
      );
      expect(within(indicator).getByText(t("pos.offline"))).toBeInTheDocument();
      expect(indicator).toHaveTextContent(`${t("pos.pending")}: 0`);
    });
  });
}
it("explains a missing desktop bridge without exposing a browser fallback", async () => {
  render(<App bridge={undefined} initialLocale={"en" as Locale} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(CATALOGUES.en["pos.bridgeMissing"]!);
});
