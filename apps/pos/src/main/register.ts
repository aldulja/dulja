import { Money, Quantity, currency } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import {
  TillClockSchema,
  TillCloseShiftSchema,
  TillEnrolSchema,
  TillSessionSchema,
  TillOpenShiftSchema,
  TillReceiptSchema,
  TillSearchSchema,
  TillSellRequestSchema,
  TillTenderSchema,
} from "@dulja/contracts/pos/till";
import type { TicketEvent } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { enrolDevice, type DeviceIdentity, type DeviceStore } from "./device";
import type { SyncLoops } from "./loops";
import { TillError } from "./errors";
import { authenticateCashier, clockEvent, requireCode, type TillCashier } from "./authority";
import {
  findItemByBarcode,
  findItemByCode,
  priceCheck,
  searchItems,
  tillCurrency,
} from "./pricing";
import { closeShift, currentShift, openShift, recordCashMovement, shiftTotals } from "./shift";
import { sell, recordTillEvent } from "./ticket";
import { tender } from "./tender";
import { returnTicket } from "./returns";
import { accountSale, findCustomers, quickCreateCustomer, getCustomer } from "./customer";
import { buildReceipt, type ReceiptPayload } from "./receipt";

export interface PosHandlerDeps {
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  };
  channels: Readonly<Record<string, string>>;
  db: PosDatabase;
  store: SqliteSyncStore;
  loops: SyncLoops;
  deviceStore: DeviceStore;
  baseUrl: string;
  terminalId: string | null;
  allowEvent: (event: unknown) => boolean;
  print: (payload: ReceiptPayload) => Promise<void>;
  onEnrolled: (identity: DeviceIdentity) => Promise<void>;
  /** Test seam for the PIN lockout window; production reads the wall clock. */
  now?: () => Date;
}
/** All identity and approval authority remains in main; the renderer receives only data. */
export function registerPosHandlers(deps: PosHandlerDeps): void {
  let session: TillCashier | null = null;
  let terminalId = deps.terminalId;
  let loginAttempt = 0;
  let enrolling = false;
  const sqliteDb = deps.db;
  const now = deps.now ?? (() => new Date());
  const requireSession = (): TillCashier => {
    if (enrolling || !session)
      throw new TillError("ERR_RBAC_FORBIDDEN", "no cashier is signed in at this till");
    const row = sqliteDb.raw
      .prepare<[string], { revoked_at: string | null; snapshot_json: string }>(
        "select revoked_at, snapshot_json from catalogue_cashier where id=?",
      )
      .get(session.principalId);
    if (
      !row ||
      row.revoked_at !== null ||
      (JSON.parse(row.snapshot_json) as { revision: string }).revision !== session.snapshotRevision
    ) {
      session = null;
      throw new TillError("ERR_RBAC_FORBIDDEN", "cashier authority changed; sign in again");
    }
    return session;
  };
  const requireTerminal = (): string => {
    if (enrolling || !terminalId)
      throw new TillError("ERR_VALIDATION_FAILED", "enrol this till before opening a shift");
    return terminalId;
  };
  const handle = (method: string, fn: (...args: unknown[]) => unknown): void => {
    const channel = deps.channels[method];
    if (!channel) throw new Error(`missing POS channel ${method}`);
    deps.ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!deps.allowEvent(event))
          throw new TillError("ERR_RBAC_FORBIDDEN", "untrusted IPC sender");
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        const validation = error instanceof Error && error.name === "ZodError";
        return {
          ok: false,
          error: {
            code:
              error instanceof TillError
                ? error.code
                : validation || error instanceof RangeError
                  ? "ERR_VALIDATION_FAILED"
                  : "ERR_INTERNAL",
            // The bare detail: the preload prefixes the code itself (`ERR_…: detail`), which is the form that
            // survives contextBridge, so a TillError's own prefixed `message` would arrive with it twice.
            detail:
              error instanceof TillError
                ? error.detail
                : error instanceof Error
                  ? error.message
                  : "operation failed",
          },
        };
      }
    });
  };
  /** The one door a PIN typed at this till goes through — sign-in and supervisor approval alike. */
  const authenticate = (employeeNumber: string, pin: string): Promise<TillCashier> =>
    authenticateCashier(sqliteDb, { employeeNumber, pin, at: now() });
  handle("enrol", async (raw) => {
    const { code } = TillEnrolSchema.parse({ code: raw });
    if (enrolling) throw new TillError("ERR_VALIDATION_FAILED", "enrolment already in progress");
    if (
      sqliteDb.raw.prepare("select 1 from shift where closed_at is null limit 1").get() ||
      sqliteDb.raw.prepare("select 1 from attendance where sent_at is null limit 1").get() ||
      deps.store.unsyncedCustomers() > 0 ||
      deps.store.catalogueState().pendingOutbox > 0
    )
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        "finish the shift and sync pending work before enrolment",
      );
    enrolling = true;
    session = null;
    loginAttempt += 1;
    try {
      const identity = await enrolDevice(deps.deviceStore, { baseUrl: deps.baseUrl, code });
      await deps.onEnrolled(identity);
      terminalId = identity.terminalId;
      return { terminalId };
    } finally {
      enrolling = false;
    }
  });
  handle("login", async (raw) => {
    const attempt = ++loginAttempt;
    session = null;
    const input = TillSessionSchema.parse(raw);
    if ("logout" in input) return { principalId: null, codes: [], branchId: null };
    requireTerminal();
    const cashier = await authenticate(input.employeeNumber, input.pin);
    if (attempt !== loginAttempt || enrolling)
      throw new TillError("ERR_RBAC_FORBIDDEN", "login was superseded");
    session = cashier;
    return {
      principalId: cashier.principalId,
      codes: [...cashier.codes],
      branchId: cashier.branchId,
    };
  });
  handle("openShift", (raw) => {
    const input = TillOpenShiftSchema.parse(raw);
    const cashier = requireSession();
    const cur = tillCurrency(sqliteDb);
    if (input.currency !== cur)
      throw new TillError("ERR_MONEY_CURRENCY_MISMATCH", "opening currency differs from this till");
    return {
      shiftId: openShift(sqliteDb, deps.store, {
        terminalId: requireTerminal(),
        cashier,
        openingFloat: Money.of(input.openingFloat, cur),
      }).id,
    };
  });
  handle("closeShift", (raw) => {
    const input = TillCloseShiftSchema.parse(raw);
    const cashier = requireSession();
    const shift = currentShift(sqliteDb, requireTerminal());
    if (!shift || shift.id !== input.shiftId)
      throw new TillError("ERR_VALIDATION_FAILED", "this shift is not open on this till");
    closeShift(sqliteDb, deps.store, {
      shiftId: shift.id,
      cashier,
      countedCash: Money.of(input.countedCash, shift.currency),
    });
    return { shiftId: shift.id, ...shiftTotals(sqliteDb, shift.id) };
  });
  handle("search", (raw) => {
    const q = TillSearchSchema.parse(raw);
    requireSession();
    if (q.customer)
      return findCustomers(sqliteDb, q.text ?? q.code ?? q.barcode!).map((customer) => ({
        ...customer,
        creditLimit: customer.creditLimit?.toString() ?? null,
      }));
    if (q.barcode !== undefined) {
      const item = findItemByBarcode(sqliteDb, q.barcode);
      return item ? [item] : [];
    }
    if (q.code !== undefined) {
      const item = findItemByCode(sqliteDb, q.code);
      return item ? [item] : [];
    }
    return searchItems(sqliteDb, q.text!);
  });
  handle("priceCheck", (raw) => {
    const q = TillSearchSchema.parse(raw);
    if (q.customer) throw new TillError("ERR_VALIDATION_FAILED", "price checking requires an item");
    return priceCheck(sqliteDb, requireSession(), {
      ...(q.text === undefined ? {} : { text: q.text }),
      ...(q.code === undefined ? {} : { code: q.code }),
      ...(q.barcode === undefined ? {} : { barcode: q.barcode }),
    }).map((r) => ({
      item: r.item,
      unitPrice: r.quote.unitPrice.toString(),
      promotionId: r.quote.promotionId,
      promotionDiscount: r.quote.promotionDiscount.toString(),
      taxAmount: r.taxed.tax.toString(),
      total: r.taxed.total.toString(),
    }));
  });
  handle("sell", async (raw) => {
    const input = TillSellRequestSchema.parse(raw);
    const cashier = requireSession();
    if ("action" in input) {
      const shift = currentShift(sqliteDb, requireTerminal());
      if (!shift || shift.id !== input.shiftId)
        throw new TillError("ERR_VALIDATION_FAILED", "event needs this till's open shift");
      if (input.action === "cash_movement") {
        // ⚠️ OD-10 (ADR 0064). A supervisor is authenticated here, in main, exactly as a void's is; whether the
        // amount needs one is `recordCashMovement`'s decision against the mirrored branch policy.
        let supervisor: TillCashier | null = null;
        if (input.approval) {
          supervisor = await authenticate(input.approval.employeeNumber, input.approval.pin);
          requireCode(supervisor, PERMISSION["pos.ticket.override"]);
          if (
            supervisor.principalId === cashier.principalId ||
            supervisor.branchId !== cashier.branchId
          )
            throw new TillError(
              "ERR_RBAC_FORBIDDEN",
              "approval needs another supervisor at this branch",
            );
        }
        if (requireSession().principalId !== cashier.principalId)
          throw new TillError("ERR_RBAC_FORBIDDEN", "cashier session changed");
        const id = recordCashMovement(sqliteDb, deps.store, {
          shiftId: shift.id,
          cashier,
          kind: input.kind,
          amount: Money.of(input.amount, shift.currency),
          reference: input.reference ?? null,
          fromSafe: input.fromSafe,
          supervisor,
        });
        return { clientRef: id, total: "0.0000" };
      }
      if (input.action === "cancel_draft") {
        const row = sqliteDb.raw
          .prepare<[string], { status: string; shift_id: string; cashier_principal_id: string }>(
            "select status,shift_id,cashier_principal_id from ticket where id=?",
          )
          .get(input.clientRef!);
        // A cashier cancels their own unfinished ticket. A holder of `pos.shift.close_any` may also cancel
        // another cashier's (POS-04): the shift cannot close while it is open, and its cashier may have gone
        // home or lost their credential. Only a draft no server has seen is cancelled (the outbox check below),
        // so nothing posted is undone, and the cancellation is recorded under the supervisor's own name.
        if (
          !row ||
          row.status !== "open" ||
          row.shift_id !== shift.id ||
          (row.cashier_principal_id !== cashier.principalId &&
            !cashier.codes.includes(PERMISSION["pos.shift.close_any"]))
        )
          throw new TillError("ERR_RBAC_FORBIDDEN", "cancel only your unfinished ticket");
        sqliteDb.tx(() => {
          if (
            sqliteDb.raw
              .prepare(
                "select 1 from outbox where kind='ticket' and ref=? and (acked_at is not null or attempts>0)",
              )
              .get(input.clientRef!)
          )
            throw new TillError("ERR_VALIDATION_FAILED", "ticket has already been submitted");
          // A clock event rides on exactly one ticket (6B T7), and this draft was that one for any event
          // `persistTicketDraft` stamped onto it. Deleting its outbox row would lose the event, so it is
          // released first to ride on the next ticket.
          sqliteDb.raw
            .prepare(
              `update attendance set sent_at = null
                where sent_at is not null and exists (
                  select 1 from outbox o, json_each(o.payload, '$.attendance') a
                   where o.kind = 'ticket' and o.ref = ? and o.acked_at is null and o.attempts = 0
                     and json_extract(a.value, '$.principalId') = attendance.principal_id
                     and json_extract(a.value, '$.kind') = attendance.kind
                     and json_extract(a.value, '$.at') = attendance.occurred_at)`,
            )
            .run(input.clientRef!);
          sqliteDb.raw
            .prepare(
              "delete from outbox where kind='ticket' and ref=? and acked_at is null and attempts=0",
            )
            .run(input.clientRef!);
          sqliteDb.raw
            .prepare("update ticket set status='voided' where id=?")
            .run(input.clientRef!);
          sqliteDb.raw.prepare("insert into meta (key,value) values (?,?)").run(
            `cancel:${input.clientRef}`,
            JSON.stringify({
              cashierPrincipalId: cashier.principalId,
              ...(row.cashier_principal_id !== cashier.principalId
                ? { onBehalfOfPrincipalId: row.cashier_principal_id }
                : {}),
              reason: input.reason,
              at: new Date().toISOString(),
            }),
          );
        });
        return { clientRef: input.clientRef, total: "0.0000" };
      }
      let supervisorId: string | null = null;
      if (input.action === "void") {
        requireCode(cashier, PERMISSION["pos.ticket.void"]);
        const row = sqliteDb.raw
          .prepare<[string], { status: string; shift_id: string; total: string; currency: string }>(
            "select status,shift_id,total,currency from ticket where id=?",
          )
          .get(input.clientRef!);
        if (
          !row ||
          row.status !== "completed" ||
          row.shift_id !== shift.id ||
          !sqliteDb.raw
            .prepare("select 1 from outbox where kind='ticket' and ref=? and acked_at is not null")
            .get(input.clientRef!)
        )
          throw new TillError(
            "ERR_VALIDATION_FAILED",
            "void requires an acknowledged ticket in this shift",
          );
        if (
          sqliteDb.raw
            .prepare("select 1 from till_event where ticket_client_ref=? and kind='void'")
            .get(input.clientRef!)
        )
          throw new TillError(
            "ERR_VALIDATION_FAILED",
            "a void is already recorded for this ticket",
          );
        if (
          sqliteDb.raw
            .prepare(
              "select 1 from ticket where returns_client_ref=? and status in ('open','completed')",
            )
            .get(input.clientRef!)
        )
          throw new TillError(
            "ERR_VALIDATION_FAILED",
            "ticket already has a return; reverse the return first",
          );
        if (input.approval) {
          const supervisor = await authenticate(input.approval.employeeNumber, input.approval.pin);
          requireCode(supervisor, PERMISSION["pos.ticket.override"]);
          if (
            supervisor.principalId === cashier.principalId ||
            supervisor.branchId !== cashier.branchId
          )
            throw new TillError(
              "ERR_RBAC_FORBIDDEN",
              "approval needs another supervisor at this branch",
            );
          supervisorId = supervisor.principalId;
        }
        if (
          Money.of(row.total, currency(row.currency))
            .abs()
            .compare(Money.of(cashier.limits.maxVoidAmount, currency(row.currency))) > 0 &&
          !supervisorId
        )
          throw new TillError("ERR_TILL_LIMIT_EXCEEDED", "void needs supervisor approval");
      } else requireCode(cashier, PERMISSION["pos.shift.own"]);
      if (requireSession().principalId !== cashier.principalId)
        throw new TillError("ERR_RBAC_FORBIDDEN", "cashier session changed");
      const id = recordTillEvent(sqliteDb, deps.store, {
        shiftId: shift.id,
        kind: input.action,
        cashier,
        ticketClientRef: input.clientRef ?? null,
        supervisorPrincipalId: supervisorId,
        reason: input.reason ?? null,
      });
      return { clientRef: id, total: "0.0000" };
    }

    const events: TicketEvent[] = [];
    for (const approval of input.approvals) {
      const supervisor = await authenticate(approval.employeeNumber, approval.pin);
      requireCode(supervisor, PERMISSION["pos.ticket.override"]);
      if (
        supervisor.principalId === cashier.principalId ||
        supervisor.branchId !== cashier.branchId
      )
        throw new TillError(
          "ERR_RBAC_FORBIDDEN",
          "approval needs a different supervisor at this branch",
        );
      events.push({
        kind: "override",
        code: PERMISSION["pos.ticket.override"],
        subject: approval.subject,
        reason: approval.reason,
        supervisorPrincipalId: supervisor.principalId,
      });
    }
    if (requireSession().principalId !== cashier.principalId)
      throw new TillError("ERR_RBAC_FORBIDDEN", "cashier session changed");
    const shift = currentShift(sqliteDb, requireTerminal());
    if (!shift || shift.id !== input.shiftId)
      throw new TillError("ERR_VALIDATION_FAILED", "selling requires this till's open shift");
    const cur = shift.currency;
    const lines = input.lines.map((l) => ({
      itemId: l.itemId,
      lotId: l.lotId ?? null,
      unitId: l.unitId ?? null,
      quantity: Quantity.of(l.quantity),
      priceOverride: l.priceOverride == null ? null : Money.of(l.priceOverride, cur),
      discount: l.discount == null ? null : Money.of(l.discount, cur),
    }));
    return sqliteDb.tx(() => {
      if (
        sqliteDb.raw
          .prepare(
            "select 1 from ticket where shift_id=? and cashier_principal_id=? and status='open' limit 1",
          )
          .get(shift.id, cashier.principalId)
      )
        throw new TillError(
          "ERR_VALIDATION_FAILED",
          "resume the unfinished ticket before creating another",
        );
      if (input.kind === "return") {
        const result = returnTicket(sqliteDb, deps.store, {
          shiftId: shift.id,
          cashier,
          returnsClientRef: input.returnsClientRef ?? null,
          lines: lines.map((l) => ({
            itemId: l.itemId,
            lotId: l.lotId,
            unitId: l.unitId,
            unitPrice: l.priceOverride,
            quantity: l.quantity,
          })),
          events,
        });
        // A return of an account sale is already completed on the customer's account: no payment step.
        return {
          clientRef: result.clientRef,
          total: result.draft.total.toString(),
          ...(result.settledOnAccount ? { account: true } : {}),
        };
      }
      const created = input.quickCustomer
        ? quickCreateCustomer(sqliteDb, cashier, {
            nameEn: input.quickCustomer.nameEn,
            phone: input.quickCustomer.phone ?? null,
            ...(input.quickCustomer.code === undefined ? {} : { code: input.quickCustomer.code }),
          })
        : null;
      const customerId = created?.customer.id ?? input.customerId ?? null;
      const customer = customerId === null ? null : getCustomer(sqliteDb, customerId);
      if (customerId !== null && !customer)
        throw new TillError("ERR_NOT_FOUND", "customer is not on this till");
      const sale = {
        shiftId: shift.id,
        cashier,
        customerId,
        newCustomer:
          created?.newCustomer ??
          (customer?.pending
            ? {
                id: customer.id,
                code: customer.code,
                nameEn: customer.nameEn,
                phone: customer.phone,
              }
            : null),
        lines,
        ticketDiscount: input.ticketDiscount == null ? null : Money.of(input.ticketDiscount, cur),
        events,
      };
      const result = input.account
        ? accountSale(sqliteDb, deps.store, { ...sale, customerId: customerId ?? "" })
        : sell(sqliteDb, deps.store, sale);
      return { clientRef: result.clientRef, total: result.draft.total.toString() };
    });
  });
  handle("tender", (raw) => {
    const input = TillTenderSchema.parse(raw);
    const cashier = requireSession();
    const row = sqliteDb.raw
      .prepare<[string], { currency: string; shift_id: string }>(
        "select currency,shift_id from ticket where id=?",
      )
      .get(input.clientRef);
    if (!row) throw new TillError("ERR_NOT_FOUND", "ticket is not on this till");
    if (currentShift(sqliteDb, requireTerminal())?.id !== row.shift_id)
      throw new TillError("ERR_VALIDATION_FAILED", "ticket shift is not open");
    const result = tender(sqliteDb, deps.store, {
      clientRef: input.clientRef,
      cashier,
      tenders: input.tenders.map((t) => ({
        method: t.method,
        amount: Money.of(t.amount, currency(row.currency)),
        reference: t.reference ?? null,
      })),
    });
    return {
      clientRef: result.clientRef,
      payable: result.payable.toString(),
      change: result.change.toString(),
      rounding: result.rounding.toString(),
    };
  });
  handle("clock", async (raw) => {
    const { kind } = TillClockSchema.parse({ kind: raw });
    return { id: await clockEvent(sqliteDb, requireSession(), kind) };
  });
  handle("receipt", (raw) => {
    const { clientRef } = TillReceiptSchema.parse({ clientRef: raw });
    requireSession();
    return buildReceipt(sqliteDb, clientRef);
  });
  handle("print", async (raw) => {
    const { clientRef } = TillReceiptSchema.parse({ clientRef: raw });
    requireSession();
    await deps.print(buildReceipt(sqliteDb, clientRef));
  });
  handle("pull", async () => {
    if (enrolling) throw new TillError("ERR_VALIDATION_FAILED", "enrolment in progress");
    await deps.loops.pullNow();
  });
  handle("drain", async () => {
    if (enrolling) throw new TillError("ERR_VALIDATION_FAILED", "enrolment in progress");
    await deps.loops.drainNow({ manual: true });
  });
  handle("status", () => ({
    roundingIncrement:
      session === null
        ? null
        : (sqliteDb.raw
            .prepare<[string], { rounding_increment: string }>(
              "select rounding_increment from catalogue_branch_pos_policy where branch_id=?",
            )
            .get(session.branchId)?.rounding_increment ??
          session?.limits.roundingIncrement ??
          null),
    openTicket:
      session === null
        ? null
        : (() => {
            const shift = terminalId === null ? null : currentShift(sqliteDb, terminalId);
            if (!shift) return null;
            return (
              sqliteDb.raw
                .prepare<
                  [string, string],
                  { clientRef: string; total: string; returnsClientRef: string | null }
                >(
                  "select id as clientRef, total, returns_client_ref as returnsClientRef from ticket where shift_id=? and cashier_principal_id=? and status='open' order by created_at limit 1",
                )
                .get(shift.id, session.principalId) ?? null
            );
          })(),
    // Other cashiers' unfinished tickets on the open shift: the close is refused while any is open, so the shift
    // screen names them, and a `pos.shift.close_any` holder can cancel them (POS-04).
    unfinishedTickets:
      session === null
        ? []
        : (() => {
            const shift = terminalId === null ? null : currentShift(sqliteDb, terminalId);
            if (!shift) return [];
            return sqliteDb.raw
              .prepare<
                [string, string],
                { clientRef: string; total: string; cashierPrincipalId: string }
              >(
                "select id as clientRef, total, cashier_principal_id as cashierPrincipalId from ticket where shift_id=? and cashier_principal_id<>? and status='open' order by created_at",
              )
              .all(shift.id, session.principalId);
          })(),
    // What the counted cash is reviewed against before a close (UI-02): the shift's opening float and the
    // till's own tender totals. A local aid, as at close; the till never computes expected cash (§4.10.1).
    shiftTotals:
      session === null
        ? null
        : (() => {
            const shift = terminalId === null ? null : currentShift(sqliteDb, terminalId);
            if (!shift) return null;
            return {
              openingFloat: shift.openingFloat.toString(),
              ...shiftTotals(sqliteDb, shift.id),
            };
          })(),
    ...deps.loops.state(),
    enrolled: terminalId !== null,
    signedIn:
      session === null ? null : { principalId: session.principalId, branchId: session.branchId },
    shiftId: terminalId === null ? null : (currentShift(sqliteDb, terminalId)?.id ?? null),
    currency: session === null ? null : tillCurrency(sqliteDb),
    catalogueAt: deps.store.catalogueState().pulledAt,
  }));
}
