import { useEffect, useRef, useState, type FormEvent } from "react";
import { Money, Quantity, currency, roundToIncrement, type CurrencyCode } from "@dulja/domain";
import {
  createI18n,
  formatMoney,
  formatTimestamp,
  type Locale,
  type TranslationKey,
} from "@dulja/i18n";
import { Button, DirectionProvider, TextField } from "@dulja/ui";
import type { ReceiptPayload } from "../main/receipt";
import { Receipt } from "./components/receipt";
import { tillErrorCode } from "./lib/error-code";
import { FieldError, createScanGuard, parseMoney, parseQuantity } from "./lib/amount";
import type { BasketLine, Customer, Item, PosBridge, PosStatus } from "./lib/types";
/** Whether a key went to a field the cashier types into, where a printable key is text and not a command. */
const typingInto = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable);
type View = "sell" | "price" | "customer" | "shift";
/**
 * 6B T11 Step 2: a refusal is shown by its code in the till's language and never by its detail, which main
 * composes in English. A code with no message of its own, or an error that carries none, reads as internal.
 */
const FAULT_KEYS: Readonly<Record<string, TranslationKey>> = {
  ERR_TILL_PIN_INVALID: "pos.error.ERR_TILL_PIN_INVALID",
  ERR_TILL_LIMIT_EXCEEDED: "pos.error.ERR_TILL_LIMIT_EXCEEDED",
  ERR_TILL_CATALOGUE_STALE: "pos.error.ERR_TILL_CATALOGUE_STALE",
  ERR_TILL_STORE_CORRUPT: "pos.error.ERR_TILL_STORE_CORRUPT",
  ERR_RBAC_FORBIDDEN: "pos.error.ERR_RBAC_FORBIDDEN",
  ERR_NOT_FOUND: "pos.error.ERR_NOT_FOUND",
  ERR_VALIDATION_FAILED: "pos.error.ERR_VALIDATION_FAILED",
  ERR_MONEY_CURRENCY_MISMATCH: "pos.error.ERR_MONEY_CURRENCY_MISMATCH",
  ERR_RATE_LIMITED: "pos.error.ERR_RATE_LIMITED",
  ERR_TERMINAL_ENROLMENT_INVALID: "pos.error.ERR_TERMINAL_ENROLMENT_INVALID",
};
const faultKey = (error: unknown): TranslationKey =>
  FAULT_KEYS[tillErrorCode(error) ?? ""] ?? "pos.error.ERR_INTERNAL";
interface Payment {
  method: "cash" | "card" | "transfer" | "store_credit";
  amount: string;
  reference: string;
}
interface Quote {
  item: Item;
  unitPrice: string;
  /** The active promotion's share of one unit, `0.0000` when none applies; the tax and total are after it. */
  promotionDiscount: string;
  taxAmount: string;
  total: string;
}
/**
 * A scan reaches price check as a barcode as well as text: the main process puts the barcode hit first and
 * drops a duplicate (`priceCheck`), so a typed code or name still finds its matches and a scan of any length is
 * found exactly. Text with whitespace or longer than a barcode can be is never sent as one, so `TillSearchSchema`
 * does not refuse a long name for its barcode field.
 */
const lookup = (text: string): { text: string; barcode?: string } => {
  const value = text.trim();
  return value.length <= 64 && !/\s/.test(value)
    ? { text: value, barcode: value }
    : { text: value };
};
/**
 * A field a scanner types into keeps what it read after a lookup, selected and focused, so the cashier sees it and
 * the next scan replaces it: a keyboard-wedge scanner types and presses Enter (D18), and without the selection a
 * second scan would be appended to the first.
 */
const rescan = (field: HTMLInputElement | null) => {
  field?.focus();
  field?.select();
};
export function App({
  bridge,
  initialLocale = "en",
}: {
  bridge: PosBridge | undefined;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [translator, setTranslator] = useState<Awaited<ReturnType<typeof createI18n>> | null>(null);
  const [status, setStatus] = useState<PosStatus | null>(null);
  const [view, setView] = useState<View>("sell");
  const [busy, setBusy] = useState(false);
  // A key, translated at render: the status poll below keeps its first render's `t`, and the language may change.
  const [fault, setFault] = useState<TranslationKey | null>(null);
  // The field a validation refusal is about, named beside it (UI-14).
  const [faultField, setFaultField] = useState<TranslationKey | null>(null);
  // A manual Sync or Pull runs beside the sale, never under `busy` (POS-03), and reports here on its own.
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<"pos.syncDone" | "pos.syncFailed" | null>(null);
  const [notice, setNotice] = useState(false);
  const [code, setCode] = useState("");
  const [employee, setEmployee] = useState("");
  const [pin, setPin] = useState("");
  // Empty, never "0": a bare Enter must not open or close a shift on a figure nobody typed (UI-02).
  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  // The count under review, as the domain reads it: a close is final, so it is shown and confirmed first (UI-02).
  const [closeReview, setCloseReview] = useState<string | null>(null);
  const floatGuard = useRef(createScanGuard());
  const countGuard = useRef(createScanGuard());
  const countRef = useRef<HTMLInputElement>(null);
  // Reasons typed to cancel other cashiers' unfinished tickets, by ticket (POS-04).
  const [draftReasons, setDraftReasons] = useState<Record<string, string>>({});
  const [eventTicket, setEventTicket] = useState("");
  const [shiftResult, setShiftResult] = useState<{
    tickets: number;
    byMethod: Record<string, string>;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  // `null` until a lookup has run, so "nothing matched" is said only after one has.
  const [items, setItems] = useState<Item[] | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  // Tickets this screen has closed (cancelled, or completed and dismissed). A status read taken before the close
  // committed still names the ticket as open; resuming it would bring a voided ticket's payment screen back, with
  // every key and button refused until the till restarted. A closed ticket never reopens, so it is skipped.
  const closed = useRef(new Set<string>());
  const priceRef = useRef<HTMLInputElement>(null);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [kind, setKind] = useState<"sale" | "return">("sale");
  const [original, setOriginal] = useState("");
  // The original the cashier loaded, and whether it was an account sale: a return of one is credited back to the
  // account and takes no payment step, so the cashier is told before the drawer is opened (ADR 0056).
  const [loaded, setLoaded] = useState<{ clientRef: string; onAccount: boolean } | null>(null);
  const [ticketDiscount, setTicketDiscount] = useState("0");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newCode, setNewCode] = useState("");
  const [account, setAccount] = useState(false);
  const [supervisor, setSupervisor] = useState("");
  const [supervisorPin, setSupervisorPin] = useState("");
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState("discount");
  // A void's or a cancellation's own reason and supervisor approval, never the sell screen's: a supervisor's PIN
  // given for a discount or a price override must not void a ticket. Emptied whenever the screen changes, below.
  const [eventReason, setEventReason] = useState("");
  const [eventSupervisor, setEventSupervisor] = useState("");
  const [eventPin, setEventPin] = useState("");
  // ⚠️ OD-10 (ADR 0064): the shift view's cash-movement form. Its supervisor fields are its own, for the reason
  // the void's are: a PIN typed to approve one act must never approve another. Emptied with the void's, below.
  const [cashKind, setCashKind] = useState<"paid_out" | "safe_drop" | "bank_safe" | "bank_drawer">(
    "paid_out",
  );
  const [cashAmount, setCashAmount] = useState("0");
  const [cashReference, setCashReference] = useState("");
  const [cashSupervisor, setCashSupervisor] = useState("");
  const [cashPin, setCashPin] = useState("");
  const [ticket, setTicket] = useState<{
    clientRef: string;
    total: string;
    returnsClientRef?: string | null;
  } | null>(null);
  const [payments, setPayments] = useState<Payment[]>([
    { method: "cash", amount: "", reference: "" },
  ]);
  const [receipt, setReceipt] = useState<ReceiptPayload | null>(null);
  // A completed ticket whose receipt could not be fetched: the sale is done, so the payment screen is gone and
  // the cashier can try the receipt again or go on to the next sale (UI-16, POS-20).
  const [unprinted, setUnprinted] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const t = (key: TranslationKey) => translator?.t(key) ?? "";
  // The till's currency is the one its catalogue prices in (`status.currency`), never a literal: an amount is
  // shown only once the till has said which currency it holds, and nothing is written in a guessed one.
  const cur = status?.currency ? currency(status.currency) : null;
  const money = (amount: string) =>
    cur === null ? "" : formatMoney({ amount, currency: cur }, { locale });
  const tillCurrency = (): CurrencyCode => {
    if (cur === null) throw new Error("ERR_TILL_CATALOGUE_STALE: this till holds no currency yet");
    return cur;
  };
  const refresh = async () => {
    if (bridge) setStatus((await bridge.status()) as PosStatus);
  };
  // Which screen is showing, and to whom: the payment screen and the receipt are each one ticket's, the rest are
  // views. The signed-in cashier is part of it, so a Lock and the next sign-in start the void and cancellation
  // fields empty even when the till comes back to the same view.
  const screenKey = `${status?.signedIn?.principalId ?? ""}:${
    receipt
      ? `receipt:${receipt.clientRef}`
      : unprinted
        ? `unprinted:${unprinted}`
        : ticket
          ? `ticket:${ticket.clientRef}`
          : view
  }`;
  useEffect(() => {
    setCloseReview(null);
    setEventReason("");
    setEventSupervisor("");
    setEventPin("");
    setCashSupervisor("");
    setCashPin("");
  }, [screenKey]);
  // The sale's supervisor approval belongs to the cashier it was typed for. It survives moving between views
  // (F10 and back), but not a change of who is signed in — a Lock, or main dropping the session when the
  // cashier's authority changes — so it never goes out with another cashier's sale.
  const signedInPrincipal = status?.signedIn?.principalId ?? null;
  useEffect(() => {
    setSupervisor("");
    setSupervisorPin("");
    setReason("");
  }, [signedInPrincipal]);
  // A ticket on screen is its cashier's. When another cashier signs in — after a Lock, or after main dropped the
  // session — the last one's payment screen, receipt and basket go (POS-04); the ticket itself stays open in main,
  // where its own cashier resumes it, or a supervisor holding `pos.shift.close_any` cancels it.
  const lastPrincipal = useRef<string | null>(null);
  useEffect(() => {
    if (signedInPrincipal === null) return;
    if (lastPrincipal.current !== null && lastPrincipal.current !== signedInPrincipal) {
      setTicket(null);
      setReceipt(null);
      setUnprinted(null);
      setBasket([]);
      setKind("sale");
      setOriginal("");
      setLoaded(null);
      setCustomer(null);
      setNewName("");
      setNewPhone("");
      setNewCode("");
      setAccount(false);
      setTicketDiscount("0");
      setView("sell");
    }
    lastPrincipal.current = signedInPrincipal;
  }, [signedInPrincipal]);
  useEffect(() => {
    let active = true;
    void createI18n({ locale }).then((value) => {
      if (active) setTranslator(value);
    });
    return () => {
      active = false;
    };
  }, [locale]);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const read = async () => {
      try {
        const value = (await bridge.status()) as PosStatus;
        if (active) setStatus(value);
      } catch (error) {
        if (active) setFault(faultKey(error));
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bridge]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // On the receipt, a scan starts the next sale with that item (UI-15): its first character goes to the scan
      // field, which the next sale's screen focuses for the rest of the code and its Enter.
      if (
        (receipt || unprinted) &&
        !busy &&
        event.key.length === 1 &&
        /\S/.test(event.key) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !typingInto(event.target)
      ) {
        event.preventDefault();
        next();
        setBarcode(event.key);
        return;
      }
      if (busy || ticket || receipt || unprinted) return;
      const target: Record<string, View> = { F2: "price", F4: "customer", F10: "shift" };
      if (target[event.key]) {
        event.preventDefault();
        setView(target[event.key]!);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setView("sell");
        scanRef.current?.focus();
      }
      if (event.key === "F8" && view === "sell") {
        event.preventDefault();
        document.getElementById("review-ticket")?.click();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, ticket, receipt, unprinted, view]);
  useEffect(() => {
    if (
      !ticket &&
      !receipt &&
      !unprinted &&
      status?.signedIn &&
      status.openTicket &&
      !closed.current.has(status.openTicket.clientRef)
    ) {
      setTicket(status.openTicket);
      setPayments([
        {
          method: "cash",
          amount:
            status.roundingIncrement && status.currency && !status.openTicket.returnsClientRef
              ? roundToIncrement(
                  Money.of(status.openTicket.total, currency(status.currency)),
                  status.roundingIncrement,
                ).toString()
              : status.openTicket.total,
          reference: "",
        },
      ]);
    }
  }, [status, ticket, receipt, unprinted]);
  /**
   * One operation at a time. Work that ends in a refusal of its own (a scan that matched nothing, an original
   * that is not a sale) returns that refusal's key, which is shown like a thrown one and never as success. A
   * lookup passes `notice: false`: finding something, or nothing, is not a completed operation.
   */
  const run = async (
    work: () => Promise<TranslationKey | void>,
    { notice: announce = true }: { notice?: boolean } = {},
  ) => {
    if (busy) return;
    setBusy(true);
    setFault(null);
    setFaultField(null);
    setNotice(false);
    try {
      const refused = await work();
      await refresh();
      if (refused) setFault(refused);
      else if (announce) setNotice(true);
    } catch (error) {
      setFault(faultKey(error));
      setFaultField(error instanceof FieldError ? error.field : null);
      // A refusal can mean the till's state moved under the screen — main dropped the session, another cashier
      // signed in (POS-04) — so the screen reads it again rather than waiting for the next poll.
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const submit =
    (work: () => Promise<TranslationKey | void>, options?: { notice?: boolean }) =>
    (event: FormEvent) => {
      event.preventDefault();
      void run(work, options);
    };
  /**
   * After a button that is not a form's submit, the cursor goes back to the screen's own field (UI-22). A clicked
   * button keeps focus, so a scanner's trailing Enter would click it again — a second No sale, a second clock
   * event — and a button that removes itself leaves focus on `<body>`, where the next scan is lost. With no such
   * field on screen the button lets go of focus, so an Enter does nothing.
   */
  const refocus = () => {
    const field = scanRef.current ?? countRef.current;
    if (field) field.focus();
    else if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  };
  const act = (work: () => Promise<TranslationKey | void>) => {
    void run(work).finally(refocus);
  };
  /** A manual Pull or Sync, in the background: a slow or hung API never holds the sale's keys (POS-03). */
  const sync = (work: () => Promise<void>) => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setNotice(false);
    void work()
      .then(
        () => setSyncResult("pos.syncDone"),
        () => setSyncResult("pos.syncFailed"),
      )
      .finally(() => {
        setSyncing(false);
        void refresh().catch(() => undefined);
      });
    refocus();
  };
  /** An amount that arrived as a scan, or is too long to be cash, is refused and emptied, never used (UI-02). */
  const refuseScan = (empty: () => void, guard: ReturnType<typeof createScanGuard>) => {
    setFault("pos.countLooksLikeScan");
    setFaultField(null);
    setNotice(false);
    empty();
    guard.reset();
  };
  const add = (item: Item) => {
    setBasket((lines) => [...lines, { item, quantity: "1", priceOverride: "", discount: "0" }]);
    setBarcode("");
    setItems(null);
    scanRef.current?.focus();
  };
  const edit = (index: number, change: Partial<BasketLine>) =>
    setBasket((lines) => lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const sell = async () => {
    if (!bridge || !status?.shiftId) return;
    const ccy = tillCurrency();
    const result = await bridge.sell({
      shiftId: status.shiftId,
      kind,
      returnsClientRef: kind === "return" ? original.trim() || null : null,
      customerId: customer?.id ?? null,
      ...(kind === "sale" && newName.trim()
        ? {
            quickCustomer: {
              nameEn: newName.trim(),
              phone: newPhone.trim() || null,
              ...(newCode.trim() ? { code: newCode.trim() } : {}),
            },
          }
        : {}),
      account: kind === "sale" && account,
      lines: basket.map((line) => ({
        itemId: line.item.itemId,
        unitId: line.unitId ?? line.item.baseUnitId,
        lotId: line.lotId ?? null,
        quantity: parseQuantity(line.quantity, "pos.quantity").toString(),
        ...(line.priceOverride.trim()
          ? { priceOverride: parseMoney(line.priceOverride, ccy, "pos.priceOverride").toString() }
          : {}),
        ...(kind === "sale" &&
        !parseMoney(line.discount, ccy, "pos.discount", { emptyIsZero: true }).isZero()
          ? { discount: parseMoney(line.discount, ccy, "pos.discount").toString() }
          : {}),
      })),
      ...(kind === "sale" &&
      !parseMoney(ticketDiscount, ccy, "pos.ticketDiscount", { emptyIsZero: true }).isZero()
        ? { ticketDiscount: parseMoney(ticketDiscount, ccy, "pos.ticketDiscount").toString() }
        : {}),
      approvals: supervisor.trim()
        ? [
            {
              employeeNumber: supervisor.trim(),
              pin: supervisorPin,
              subject,
              reason: reason.trim(),
            },
          ]
        : [],
    });
    setSupervisorPin("");
    // An account sale, or a return of one (credited back to the customer's account), takes no tender: it is
    // complete now, so it never shows the payment screen, whatever the receipt call does (UI-16).
    if (account || result.account) {
      await showReceipt(result.clientRef);
      return;
    }
    setTicket({ ...result, returnsClientRef: kind === "return" ? original.trim() || null : null });
    setPayments([
      {
        method: "cash",
        amount:
          status.roundingIncrement && !(kind === "return" && original.trim())
            ? roundToIncrement(Money.of(result.total, ccy), status.roundingIncrement).toString()
            : result.total,
        reference: "",
      },
    ]);
  };
  /** The receipt of a completed ticket. Failing, the ticket is still complete: the screen says so (UI-16). */
  const showReceipt = async (clientRef: string) => {
    if (!bridge) return;
    closed.current.add(clientRef);
    setTicket(null);
    setUnprinted(clientRef);
    setReceipt((await bridge.receipt(clientRef)) as ReceiptPayload);
    setUnprinted(null);
  };
  const next = () => {
    if (ticket) closed.current.add(ticket.clientRef);
    if (receipt) closed.current.add(receipt.clientRef);
    setTicket(null);
    setReceipt(null);
    setUnprinted(null);
    setBasket([]);
    setKind("sale");
    setOriginal("");
    setLoaded(null);
    setCustomer(null);
    setNewName("");
    setNewPhone("");
    setNewCode("");
    setAccount(false);
    setTicketDiscount("0");
    setSupervisor("");
    setSupervisorPin("");
    setReason("");
    setView("sell");
  };
  if (!translator) return null;
  return (
    <DirectionProvider locale={locale}>
      <div className="pos-app">
        <header>
          <h1>{t("pos.title")}</h1>
          <Button
            onClick={(event) => {
              setLocale(locale === "en" ? "ar" : "en");
              // A click lets go of the toggle, so a scanner's Enter cannot switch the language back (UI-22); a
              // toggle reached by keyboard keeps the cursor, for the cashier who switches by keyboard.
              if (event.detail > 0) refocus();
            }}
          >
            {t(locale === "en" ? "app.endonym.ar" : "app.endonym.en")}
          </Button>
        </header>
        {!bridge ? (
          <p role="alert">{t("pos.bridgeMissing")}</p>
        ) : (
          <>
            <aside aria-live="polite">
              <span>{t(status?.online ? "pos.online" : "pos.offline")}</span>
              <span>
                {t("pos.catalogueRevision")}: {status?.catalogueRevision ?? "0"}
              </span>
              <span>
                {t("pos.catalogueAt")}:{" "}
                {status?.catalogueAt
                  ? formatTimestamp(status.catalogueAt, { locale })
                  : t("pos.never")}
              </span>
              <span>
                {t("pos.pending")}: {status?.pendingOutbox ?? 0}
              </span>
            </aside>
            {fault && (
              <p role="alert">
                {t("pos.error")} <span>{t(fault)}</span>
                {faultField && <span> · {t(faultField)}</span>}
              </p>
            )}
            {notice && <p role="status">{t("pos.success")}</p>}
            {syncResult && <p role="status">{t(syncResult)}</p>}
            {status?.lastError && <p role="status">{t("pos.syncAttention")}</p>}
            {!status?.enrolled ? (
              <form
                onSubmit={submit(async () => {
                  await bridge.enrol(code.trim());
                  setCode("");
                  await bridge.pull();
                })}
              >
                <h2>{t("pos.enrol")}</h2>
                <TextField
                  autoFocus
                  label={t("pos.enrolCode")}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoComplete="off"
                />
                <Button type="submit" disabled={busy}>
                  {t("pos.enrol")}
                </Button>
              </form>
            ) : !status.signedIn ? (
              <form
                onSubmit={submit(async () => {
                  try {
                    await bridge.login({ employeeNumber: employee.trim(), pin });
                  } finally {
                    setPin("");
                  }
                })}
              >
                <h2>{t("pos.login")}</h2>
                <TextField
                  autoFocus
                  label={t("pos.employeeNumber")}
                  value={employee}
                  onChange={(e) => setEmployee(e.target.value)}
                  required
                  autoComplete="username"
                />
                <TextField
                  label={t("pos.pin")}
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  required
                  autoComplete="off"
                />
                <Button type="submit" disabled={busy}>
                  {t("pos.login")}
                </Button>
                <Button disabled={syncing} onClick={() => sync(() => bridge.pull())}>
                  {t("pos.pull")}
                </Button>
              </form>
            ) : (
              <>
                <nav>
                  <Button disabled={busy || ticket !== null} onClick={() => setView("sell")}>
                    {t("pos.sell")}
                  </Button>
                  <Button disabled={busy || ticket !== null} onClick={() => setView("price")}>
                    {t("pos.priceCheck")}
                  </Button>
                  <Button disabled={busy || ticket !== null} onClick={() => setView("customer")}>
                    {t("pos.customer")}
                  </Button>
                  <Button disabled={busy || ticket !== null} onClick={() => setView("shift")}>
                    {t("pos.shift")}
                  </Button>
                  <Button disabled={syncing} onClick={() => sync(() => bridge.pull())}>
                    {t("pos.pull")}
                  </Button>
                  <Button disabled={syncing} onClick={() => sync(() => bridge.drain())}>
                    {t("pos.drain")}
                  </Button>
                  <Button
                    disabled={busy || ticket !== null}
                    onClick={() =>
                      void run(async () => {
                        await bridge.login({ logout: true });
                        setPin("");
                      })
                    }
                  >
                    {t("pos.lock")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await bridge.clock("clock_in");
                      })
                    }
                  >
                    {t("pos.clockIn")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await bridge.clock("clock_out");
                      })
                    }
                  >
                    {t("pos.clockOut")}
                  </Button>
                </nav>
                {!status.shiftId && !ticket ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      // A bare Enter opens nothing, and a scan is never a float (UI-02).
                      if (!float.trim()) return;
                      if (floatGuard.current.looksScanned(float)) {
                        refuseScan(() => setFloat(""), floatGuard.current);
                        return;
                      }
                      void run(async () => {
                        const ccy = tillCurrency();
                        await bridge.openShift({
                          openingFloat: parseMoney(float, ccy, "pos.openingFloat").toString(),
                          currency: ccy,
                        });
                        // Each shift is counted afresh: the next open starts empty, and the last close's summary
                        // belongs to the shift it closed.
                        setFloat("");
                        floatGuard.current.reset();
                        setShiftResult(null);
                        setView("sell");
                      });
                    }}
                  >
                    <h2>{t("pos.openShift")}</h2>
                    <p>
                      {t("pos.currency")}: {cur}
                    </p>
                    <TextField
                      autoFocus
                      label={t("pos.openingFloat")}
                      inputMode="decimal"
                      value={float}
                      // Typing replaces the figure rather than adding digits to it.
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => floatGuard.current.onKeyDown(e)}
                      onChange={(e) => {
                        if (e.target.value === "") floatGuard.current.reset();
                        setFloat(e.target.value);
                      }}
                      required
                      autoComplete="off"
                    />
                    <Button type="submit" disabled={busy}>
                      {t("pos.openShift")}
                    </Button>
                  </form>
                ) : receipt ? (
                  <>
                    <Receipt receipt={receipt} locale={locale} t={t} />
                    {receipt.kind === "return" && receipt.onAccount && (
                      <p role="status">{t("pos.returnToAccount")}</p>
                    )}
                    <div className="receipt-actions">
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => bridge.print(receipt.clientRef))}
                      >
                        {t("pos.print")}
                      </Button>
                      {/*
                       * The void's fields are its own form, so Enter in one of them voids this ticket once the
                       * button would, and never anything else (`docs/ui/od-24-phase-6b-screens.md`).
                       */}
                      <form
                        onSubmit={submit(async () => {
                          await bridge.sell({
                            action: "void",
                            shiftId: status.shiftId,
                            clientRef: receipt.clientRef,
                            reason: eventReason,
                            ...(eventSupervisor
                              ? {
                                  approval: {
                                    employeeNumber: eventSupervisor,
                                    pin: eventPin,
                                    subject: "void",
                                    reason: eventReason,
                                  },
                                }
                              : {}),
                          });
                          setEventPin("");
                          next();
                        })}
                      >
                        <TextField
                          label={t("pos.reason")}
                          value={eventReason}
                          onChange={(e) => setEventReason(e.target.value)}
                        />
                        <TextField
                          label={t("pos.supervisor")}
                          value={eventSupervisor}
                          onChange={(e) => setEventSupervisor(e.target.value)}
                        />
                        <TextField
                          type="password"
                          label={t("pos.supervisorPin")}
                          value={eventPin}
                          onChange={(e) => setEventPin(e.target.value)}
                        />
                        <Button type="submit" disabled={busy || !eventReason.trim()}>
                          {t("shift.void")}
                        </Button>
                      </form>
                      {/* The cursor's place after a sale, so the next scan starts the next sale (UI-15). */}
                      <Button autoFocus disabled={busy} onClick={next}>
                        {t("pos.nextSale")}
                      </Button>
                    </div>
                  </>
                ) : unprinted ? (
                  <section>
                    <p role="status">{t("pos.receiptUnavailable")}</p>
                    <div className="receipt-actions">
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => showReceipt(unprinted))}
                      >
                        {t("pos.showReceipt")}
                      </Button>
                      <Button autoFocus disabled={busy} onClick={next}>
                        {t("pos.nextSale")}
                      </Button>
                    </div>
                  </section>
                ) : ticket ? (
                  <section>
                    <h2>{t("pos.tender")}</h2>
                    <p>
                      {t("pos.total")}: {money(ticket.total)}
                    </p>
                    {/*
                     * Cancelling is its own form, outside the payment's: Enter in the reason cancels the ticket
                     * once the button would, and can never complete the sale the cashier meant to cancel.
                     */}
                    <form
                      onSubmit={submit(async () => {
                        await bridge.sell({
                          action: "cancel_draft",
                          shiftId: status.shiftId,
                          clientRef: ticket.clientRef,
                          reason: eventReason,
                        });
                        next();
                      })}
                    >
                      <TextField
                        label={t("pos.reason")}
                        value={eventReason}
                        onChange={(e) => setEventReason(e.target.value)}
                      />
                      <Button type="submit" disabled={busy || !eventReason.trim()}>
                        {t("shift.cancelDraft")}
                      </Button>
                    </form>
                    <form
                      onSubmit={submit(async () => {
                        const ccy = tillCurrency();
                        await bridge.tender({
                          clientRef: ticket.clientRef,
                          tenders: payments.map((payment) => ({
                            method: payment.method,
                            amount: parseMoney(payment.amount, ccy, "pos.amount").toString(),
                            reference: payment.reference || null,
                          })),
                        });
                        // The tender committed: the ticket is complete, whatever the receipt call does (UI-16).
                        await showReceipt(ticket.clientRef);
                      })}
                    >
                      <p>{t("pos.cashHint")}</p>
                      {payments.map((payment, index) => (
                        <fieldset key={index}>
                          <label>
                            {t("pos.method")}
                            <select
                              value={payment.method}
                              onChange={(e) =>
                                setPayments((rows) =>
                                  rows.map((row, i) =>
                                    i === index
                                      ? {
                                          ...row,
                                          method: e.target.value as Payment["method"],
                                          amount:
                                            rows.length === 1
                                              ? e.target.value === "cash" &&
                                                cur !== null &&
                                                status?.roundingIncrement &&
                                                !ticket.returnsClientRef
                                                ? roundToIncrement(
                                                    Money.of(ticket.total, cur),
                                                    status.roundingIncrement,
                                                  ).toString()
                                                : ticket.total
                                              : row.amount,
                                        }
                                      : row,
                                  ),
                                )
                              }
                            >
                              {(["cash", "card", "transfer", "store_credit"] as const).map(
                                (method) => (
                                  <option key={method} value={method}>
                                    {t(`pos.${method}`)}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <TextField
                            autoFocus={index === 0}
                            label={t("pos.amount")}
                            inputMode="decimal"
                            value={payment.amount}
                            onChange={(e) =>
                              setPayments((rows) =>
                                rows.map((row, i) =>
                                  i === index ? { ...row, amount: e.target.value } : row,
                                ),
                              )
                            }
                          />
                          <TextField
                            label={t("pos.reference")}
                            value={payment.reference}
                            onChange={(e) =>
                              setPayments((rows) =>
                                rows.map((row, i) =>
                                  i === index ? { ...row, reference: e.target.value } : row,
                                ),
                              )
                            }
                          />
                          {payments.length > 1 && (
                            <Button
                              disabled={busy}
                              onClick={() =>
                                setPayments((rows) => rows.filter((_, i) => i !== index))
                              }
                            >
                              {t("pos.remove")}
                            </Button>
                          )}
                        </fieldset>
                      ))}
                      <Button
                        disabled={busy || payments.length >= 8}
                        onClick={() =>
                          setPayments((rows) => [
                            ...rows,
                            { method: "card", amount: "0", reference: "" },
                          ])
                        }
                      >
                        {t("pos.addTender")}
                      </Button>
                      <Button type="submit" disabled={busy}>
                        {t("pos.complete")}
                      </Button>
                    </form>
                  </section>
                ) : view === "shift" ? (
                  <section>
                    <h2>{t("pos.closeShift")}</h2>
                    <div className="flex gap-3">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await bridge.sell({ action: "no_sale", shiftId: status.shiftId });
                          })
                        }
                      >
                        {t("shift.no_sale")}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await bridge.sell({ action: "drawer_open", shiftId: status.shiftId });
                          })
                        }
                      >
                        {t("shift.drawer_open")}
                      </Button>
                    </div>
                    {/*
                     * The void and the close are two forms. Enter in a void field voids the named ticket once the
                     * button would; it can never close the shift against a count nobody entered.
                     */}
                    <form
                      onSubmit={submit(async () => {
                        await bridge.sell({
                          action: "void",
                          shiftId: status.shiftId,
                          clientRef: eventTicket,
                          reason: eventReason,
                          ...(eventSupervisor
                            ? {
                                approval: {
                                  employeeNumber: eventSupervisor,
                                  pin: eventPin,
                                  subject: "void",
                                  reason: eventReason,
                                },
                              }
                            : {}),
                        });
                        setEventPin("");
                        setEventTicket("");
                      })}
                    >
                      <TextField
                        label={t("shift.voidTicket")}
                        value={eventTicket}
                        onChange={(e) => setEventTicket(e.target.value)}
                      />
                      <TextField
                        label={t("pos.reason")}
                        value={eventReason}
                        onChange={(e) => setEventReason(e.target.value)}
                      />
                      <TextField
                        label={t("pos.supervisor")}
                        value={eventSupervisor}
                        onChange={(e) => setEventSupervisor(e.target.value)}
                      />
                      <TextField
                        type="password"
                        label={t("pos.supervisorPin")}
                        value={eventPin}
                        onChange={(e) => setEventPin(e.target.value)}
                      />
                      <Button type="submit" disabled={busy || !eventTicket || !eventReason.trim()}>
                        {t("shift.void")}
                      </Button>
                    </form>
                    {/*
                     * ⚠️ OD-10 (ADR 0064): cash leaving the drawer without a sale. Its own form, so Enter here records
                     * the movement once and can never void a ticket or close the shift.
                     */}
                    <form
                      onSubmit={submit(async () => {
                        await bridge.sell({
                          action: "cash_movement",
                          shiftId: status.shiftId,
                          kind:
                            cashKind === "bank_safe" || cashKind === "bank_drawer"
                              ? "banking"
                              : cashKind,
                          amount: parseMoney(cashAmount, tillCurrency(), "shift.amount").toString(),
                          ...(cashReference.trim() ? { reference: cashReference.trim() } : {}),
                          fromSafe: cashKind === "bank_safe",
                          ...(cashKind === "paid_out" && cashSupervisor
                            ? { approval: { employeeNumber: cashSupervisor, pin: cashPin } }
                            : {}),
                        });
                        setCashAmount("0");
                        setCashReference("");
                        setCashPin("");
                      })}
                    >
                      <h3>{t("shift.cashMovement")}</h3>
                      <label>
                        {t("shift.cashKind")}
                        <select
                          value={cashKind}
                          onChange={(e) => setCashKind(e.target.value as typeof cashKind)}
                        >
                          <option value="paid_out">{t("shift.paid_out")}</option>
                          <option value="safe_drop">{t("shift.safe_drop")}</option>
                          <option value="bank_safe">{t("shift.bank_safe")}</option>
                          <option value="bank_drawer">{t("shift.bank_drawer")}</option>
                        </select>
                      </label>
                      <TextField
                        label={t("shift.amount")}
                        inputMode="decimal"
                        value={cashAmount}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setCashAmount(e.target.value)}
                      />
                      <TextField
                        label={t(
                          cashKind === "paid_out" ? "shift.cashReceipt" : "shift.cashReference",
                        )}
                        value={cashReference}
                        onChange={(e) => setCashReference(e.target.value)}
                      />
                      {cashKind === "paid_out" ? (
                        <>
                          <TextField
                            label={t("shift.cashSupervisor")}
                            value={cashSupervisor}
                            onChange={(e) => setCashSupervisor(e.target.value)}
                          />
                          <TextField
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            label={t("shift.cashSupervisorPin")}
                            value={cashPin}
                            onChange={(e) => setCashPin(e.target.value)}
                          />
                        </>
                      ) : null}
                      <Button
                        type="submit"
                        disabled={busy || (cashKind === "paid_out" && !cashReference.trim())}
                      >
                        {t("shift.recordCash")}
                      </Button>
                    </form>
                    {(status.unfinishedTickets ?? []).length > 0 && (
                      // Another cashier's unfinished tickets hold the close. A `pos.shift.close_any` holder cancels
                      // them here, under their own name; main refuses anyone else (POS-04).
                      <section aria-labelledby="unfinished-tickets">
                        <h3 id="unfinished-tickets">{t("pos.unfinishedTickets")}</h3>
                        {(status.unfinishedTickets ?? []).map((draft) => (
                          <form
                            key={draft.clientRef}
                            onSubmit={submit(async () => {
                              await bridge.sell({
                                action: "cancel_draft",
                                shiftId: status.shiftId,
                                clientRef: draft.clientRef,
                                reason: draftReasons[draft.clientRef] ?? "",
                              });
                              setDraftReasons((reasons) =>
                                Object.fromEntries(
                                  Object.entries(reasons).filter(
                                    ([ref]) => ref !== draft.clientRef,
                                  ),
                                ),
                              );
                            })}
                          >
                            <p>
                              {draft.clientRef} · {t("pos.total")}: {money(draft.total)}
                            </p>
                            <TextField
                              label={t("pos.reason")}
                              value={draftReasons[draft.clientRef] ?? ""}
                              onChange={(e) =>
                                setDraftReasons((reasons) => ({
                                  ...reasons,
                                  [draft.clientRef]: e.target.value,
                                }))
                              }
                            />
                            <Button
                              type="submit"
                              disabled={busy || !(draftReasons[draft.clientRef] ?? "").trim()}
                            >
                              {t("shift.cancelDraft")}
                            </Button>
                          </form>
                        ))}
                      </section>
                    )}
                    {closeReview === null ? (
                      /*
                       * The count's Enter never closes the shift (UI-02): it shows the count for review. A scan is
                       * refused here, and so is a figure too long to be cash, so a barcode never becomes the count.
                       */
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!counted.trim()) return;
                          if (countGuard.current.looksScanned(counted)) {
                            refuseScan(() => setCounted(""), countGuard.current);
                            return;
                          }
                          setFault(null);
                          setFaultField(null);
                          setNotice(false);
                          try {
                            setCloseReview(
                              parseMoney(counted, tillCurrency(), "pos.countedCash").toString(),
                            );
                          } catch (error) {
                            setFault(faultKey(error));
                            setFaultField(error instanceof FieldError ? error.field : null);
                          }
                        }}
                      >
                        <p>{t("pos.localTotals")}</p>
                        <TextField
                          ref={countRef}
                          autoFocus
                          label={t("pos.countedCash")}
                          inputMode="decimal"
                          value={counted}
                          autoComplete="off"
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => countGuard.current.onKeyDown(e)}
                          onChange={(e) => {
                            if (e.target.value === "") countGuard.current.reset();
                            setCounted(e.target.value);
                          }}
                        />
                        <Button type="submit" disabled={busy}>
                          {t("pos.closeShift")}
                        </Button>
                      </form>
                    ) : (
                      /*
                       * The review. Its cursor is on Change count, so a stray Enter (a scanner's) goes back to the
                       * count; the close takes Tab to Confirm close and Enter — a step no scan can make.
                       */
                      <section aria-labelledby="confirm-close">
                        <h3 id="confirm-close">{t("pos.confirmClose")}</h3>
                        <p>{t("pos.reviewCount")}</p>
                        <dl>
                          <dt>{t("pos.countedCash")}</dt>
                          <dd>{money(closeReview)}</dd>
                          {status.shiftTotals && (
                            <>
                              <dt>{t("pos.openingFloat")}</dt>
                              <dd>{money(status.shiftTotals.openingFloat)}</dd>
                              {Object.entries(status.shiftTotals.byMethod).map(
                                ([method, amount]) => (
                                  <div key={method}>
                                    <dt>{t(`pos.${method}` as TranslationKey)}</dt>
                                    <dd>{money(amount)}</dd>
                                  </div>
                                ),
                              )}
                            </>
                          )}
                        </dl>
                        <p>{t("pos.localTotals")}</p>
                        <div className="flex gap-3">
                          <Button
                            autoFocus
                            disabled={busy}
                            onClick={() => {
                              setCloseReview(null);
                              setCounted("");
                              countGuard.current.reset();
                            }}
                          >
                            {t("pos.changeCount")}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const result = await bridge.closeShift({
                                  shiftId: status.shiftId!,
                                  countedCash: closeReview,
                                });
                                setShiftResult(result);
                                setCounted("");
                                countGuard.current.reset();
                                setCloseReview(null);
                              })
                            }
                          >
                            {t("pos.confirmClose")}
                          </Button>
                        </div>
                      </section>
                    )}
                  </section>
                ) : view === "price" ? (
                  <section>
                    <h2>{t("pos.priceCheck")}</h2>
                    <form
                      onSubmit={submit(
                        async () => {
                          // Selected again whatever the lookup returns, a refusal included, so the next scan
                          // replaces this one; a refused scan never leaves the previous item's price showing.
                          try {
                            setQuotes((await bridge.priceCheck(lookup(query))) as Quote[]);
                          } catch (error) {
                            setQuotes(null);
                            throw error;
                          } finally {
                            rescan(priceRef.current);
                          }
                        },
                        { notice: false },
                      )}
                    >
                      <TextField
                        ref={priceRef}
                        autoFocus
                        label={t("pos.priceCheckQuery")}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        required
                      />
                      <Button disabled={busy} type="submit">
                        {t("pos.search")}
                      </Button>
                    </form>
                    {quotes?.length === 0 && <p role="status">{t("pos.noItems")}</p>}
                    {quotes !== null && quotes.length > 0 && (
                      <ul>
                        {quotes.map((quote) => (
                          <li key={quote.item.itemId}>
                            {locale === "ar"
                              ? (quote.item.nameAr ?? quote.item.nameEn)
                              : quote.item.nameEn}
                            : {money(quote.unitPrice)}
                            {/* The tax and total are after the promotion, so it is shown between them and the
                                list price: the figures add up, and the cashier never quotes the list price. */}
                            {cur !== null && !Money.of(quote.promotionDiscount, cur).isZero() && (
                              <>
                                {" "}
                                · {t("pos.promotionDiscount")}: {money(quote.promotionDiscount)}
                              </>
                            )}{" "}
                            · {t("pos.taxTotal")}: {money(quote.taxAmount)} · {t("pos.total")}:{" "}
                            {money(quote.total)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ) : view === "customer" ? (
                  <section>
                    <h2>{t("pos.customer")}</h2>
                    <form
                      onSubmit={submit(
                        async () =>
                          setCustomers(
                            (await bridge.search({
                              text: customerQuery,
                              customer: true,
                            })) as Customer[],
                          ),
                        { notice: false },
                      )}
                    >
                      <TextField
                        autoFocus
                        label={t("pos.customerQuery")}
                        value={customerQuery}
                        onChange={(e) => setCustomerQuery(e.target.value)}
                        required
                      />
                      <Button disabled={busy} type="submit">
                        {t("pos.searchCustomers")}
                      </Button>
                    </form>
                    {customers?.length === 0 && <p role="status">{t("pos.noCustomers")}</p>}
                    {customers !== null && customers.length > 0 && (
                      <ul>
                        {customers.map((hit) => (
                          <li key={hit.id}>
                            <Button
                              onClick={() => {
                                setCustomer(hit);
                                setNewName("");
                                setView("sell");
                              }}
                            >
                              {locale === "ar" ? (hit.nameAr ?? hit.nameEn) : hit.nameEn} {hit.code}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Button
                      onClick={() => {
                        setCustomer(null);
                        setNewName("");
                        setView("sell");
                      }}
                    >
                      {t("pos.walkIn")}
                    </Button>
                    <fieldset>
                      <legend>{t("pos.newCustomer")}</legend>
                      <TextField
                        label={t("pos.name")}
                        value={newName}
                        onChange={(e) => {
                          setNewName(e.target.value);
                          setCustomer(null);
                        }}
                      />
                      <TextField
                        label={t("pos.phone")}
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                      />
                      <TextField
                        label={t("pos.customerCode")}
                        value={newCode}
                        onChange={(e) => setNewCode(e.target.value)}
                      />
                      <Button onClick={() => setView("sell")}>{t("pos.back")}</Button>
                    </fieldset>
                  </section>
                ) : (
                  <section>
                    <h2>{t("pos.basket")}</h2>
                    <div className="search">
                      <form
                        onSubmit={submit(
                          async () => {
                            // A code that adds nothing (unknown, refused, or one of several to choose from) stays
                            // on screen, selected, so the next scan replaces it rather than being appended to it.
                            try {
                              const hits = (await bridge.search({ barcode })) as Item[];
                              if (hits.length === 0) {
                                setItems(null);
                                return "pos.error.ERR_NOT_FOUND";
                              }
                              if (hits.length === 1) add(hits[0]!);
                              else setItems(hits);
                            } catch (error) {
                              setItems(null);
                              throw error;
                            } finally {
                              rescan(scanRef.current);
                            }
                          },
                          { notice: false },
                        )}
                      >
                        <TextField
                          ref={scanRef}
                          autoFocus
                          label={t("pos.barcode")}
                          value={barcode}
                          onChange={(e) => setBarcode(e.target.value)}
                          required
                        />
                        <Button disabled={busy} type="submit">
                          {t("pos.add")}
                        </Button>
                      </form>
                      <form
                        onSubmit={submit(
                          async () => setItems((await bridge.search({ text: query })) as Item[]),
                          { notice: false },
                        )}
                      >
                        <TextField
                          label={t("pos.query")}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          required
                        />
                        <Button disabled={busy} type="submit">
                          {t("pos.search")}
                        </Button>
                      </form>
                    </div>
                    {items?.length === 0 && <p role="status">{t("pos.noItems")}</p>}
                    {items !== null && items.length > 0 && (
                      <ul>
                        {items.map((item) => (
                          <li key={item.itemId}>
                            <Button onClick={() => add(item)}>
                              {item.code} ·{" "}
                              {locale === "ar" ? (item.nameAr ?? item.nameEn) : item.nameEn}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={kind === "return"}
                        onChange={(e) => {
                          setKind(e.target.checked ? "return" : "sale");
                          setAccount(false);
                        }}
                      />
                      {t("pos.return")}
                    </label>
                    {kind === "return" && (
                      <>
                        <TextField
                          label={t("pos.original")}
                          hint={t("pos.blind")}
                          value={original}
                          onChange={(e) => setOriginal(e.target.value)}
                        />
                        <Button
                          disabled={busy || !original.trim()}
                          onClick={() =>
                            void run(async () => {
                              const source = (await bridge.receipt(
                                original.trim(),
                              )) as ReceiptPayload;
                              // Its own words, not an Error: a thrown message would read as an internal fault.
                              if (source.kind !== "sale") return "pos.originalSaleRequired";
                              setLoaded({
                                clientRef: source.clientRef,
                                onAccount: source.onAccount,
                              });
                              setBasket(
                                source.lines.map((line) => ({
                                  item: {
                                    itemId: line.itemId,
                                    code: line.code,
                                    nameEn: line.nameEn,
                                    nameAr: line.nameAr,
                                    baseUnitId: line.unitId,
                                    barcode: null,
                                    trackLots: line.lotId !== null,
                                    stockHint: null,
                                    stockHintAt: null,
                                  },
                                  unitId: line.unitId,
                                  lotId: line.lotId,
                                  quantity: Quantity.of(line.quantity).toString(),
                                  priceOverride: "",
                                  discount: "0",
                                })),
                              );
                            })
                          }
                        >
                          {t("pos.loadOriginal")}
                        </Button>
                        {loaded?.onAccount && loaded.clientRef === original.trim() && (
                          <p role="status">{t("pos.returnToAccount")}</p>
                        )}
                      </>
                    )}
                    <p>
                      {t("pos.customer")}: {(customer?.nameEn ?? newName) || t("pos.walkIn")}
                    </p>
                    {basket.length === 0 && <p>{t("pos.empty")}</p>}
                    {basket.map((line, index) => (
                      <fieldset key={index}>
                        <legend>
                          {line.item.code} ·{" "}
                          {locale === "ar"
                            ? (line.item.nameAr ?? line.item.nameEn)
                            : line.item.nameEn}
                        </legend>
                        <TextField
                          label={t("pos.quantity")}
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(e) => edit(index, { quantity: e.target.value })}
                        />
                        <TextField
                          label={t("pos.priceOverride")}
                          inputMode="decimal"
                          value={line.priceOverride}
                          onChange={(e) => edit(index, { priceOverride: e.target.value })}
                        />
                        {kind === "sale" && (
                          <TextField
                            label={t("pos.discount")}
                            inputMode="decimal"
                            value={line.discount}
                            onChange={(e) => edit(index, { discount: e.target.value })}
                          />
                        )}
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setBasket((rows) => rows.filter((_, i) => i !== index));
                            refocus();
                          }}
                        >
                          {t("pos.remove")}
                        </Button>
                      </fieldset>
                    ))}
                    {kind === "sale" && (
                      <>
                        <TextField
                          label={t("pos.ticketDiscount")}
                          inputMode="decimal"
                          value={ticketDiscount}
                          onChange={(e) => setTicketDiscount(e.target.value)}
                        />
                        <label>
                          <input
                            type="checkbox"
                            checked={account}
                            onChange={(e) => setAccount(e.target.checked)}
                          />
                          {t("pos.account")}
                        </label>
                        {account && <p>{t("pos.creditHint")}</p>}
                      </>
                    )}
                    <details>
                      <summary>{t("pos.approval")}</summary>
                      <TextField
                        label={t("pos.supervisor")}
                        value={supervisor}
                        onChange={(e) => setSupervisor(e.target.value)}
                      />
                      <TextField
                        label={t("pos.supervisorPin")}
                        type="password"
                        inputMode="numeric"
                        value={supervisorPin}
                        onChange={(e) => setSupervisorPin(e.target.value)}
                        autoComplete="off"
                      />
                      <label>
                        {t("pos.subject")}
                        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
                          <option value="discount">{t("pos.discountApproval")}</option>
                          <option value="price_override">{t("pos.priceApproval")}</option>
                          <option value="blind_return">{t("pos.blindApproval")}</option>
                        </select>
                      </label>
                      <TextField
                        label={t("pos.reason")}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </details>
                    <Button
                      id="review-ticket"
                      variant="primary"
                      disabled={busy || basket.length === 0}
                      onClick={() => void run(sell)}
                    >
                      {t("pos.submit")}
                    </Button>
                  </section>
                )}
                {shiftResult && (
                  <section>
                    <h2>{t("pos.shift")}</h2>
                    <p>{t("pos.localTotals")}</p>
                    <ul>
                      {Object.entries(shiftResult.byMethod).map(([method, amount]) => (
                        <li key={method}>
                          {t(`pos.${method}` as TranslationKey)}: {money(amount)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <p className="shortcuts">{t("pos.shortcuts")}</p>
              </>
            )}
          </>
        )}
      </div>
    </DirectionProvider>
  );
}
