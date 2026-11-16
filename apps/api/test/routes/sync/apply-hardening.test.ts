import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch, reverseDocument, ageingTieOut, withTenant } from "@dulja/db";
import { Money, Quantity, currency, rational } from "@dulja/domain";
import {
  seedUnit,
  seedShift,
  seedEmployee,
  seedCashier,
  seedBranchPosPolicy,
  grantCodes,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  uuidv7Sync,
  enrolTerminal,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";
import {
  secondPrincipal,
  recordingJobs,
} from "../../../../../tests/invariants/support/post-inventory";

describe("terminal ticket boundaries and conserved refunds", () => {
  let api: StartedApi;
  let f: PosFixture;
  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "Boundaries");
    await seedBranchPosPolicy(api.db, f.s, {
      branchId: f.s.hq,
      limits: { maxLineDiscountPct: "1.000000", maxTicketDiscountPct: "1.000000" },
    });
  }, 240_000);
  afterAll(async () => api.stop());
  const apply = (tickets: ReturnType<typeof buildTicket>[]) =>
    withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "hardening" },
      (tx) =>
        applyBatch(
          tx,
          { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "hardening" },
          {
            terminalId: f.terminal.terminalId,
            companyId: f.s.company,
            branchId: f.s.hq,
            principalId: f.terminal.principalId,
            jobs: recordingJobs(),
          },
          {
            terminalId: f.terminal.terminalId,
            batchId: uuidv7Sync(),
            tickets,
            shifts: [],
            tillEvents: [],
          },
        ),
    );
  const system = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(api.db.rw, { tenantId: f.s.tenant, actorId: f.s.system, requestId: "setup" }, fn);
  const customer = async () =>
    (
      await api.db.admin<
        { id: string }[]
      >`select id from app.party where company_id=${f.s.company} and code='TAXCUST'`
    )[0]!.id;
  const accepted = async (ticket: ReturnType<typeof buildTicket>) => {
    const out = (await apply([ticket])).results[0]!;
    expect(out.status, JSON.stringify(out)).toBe("accepted");
    return out;
  };
  /** A reversal may not predate its document, and `buildTicket` sells "now", so a reversal is dated on the
   *  document's own effective date — never a literal that the calendar overtakes. */
  const effectiveDateOf = async (documentId: string) =>
    (
      await api.db.admin<
        { d: string }[]
      >`select effective_date::text as d from app.document where id=${documentId}`
    )[0]!.d;

  const refundFrom = async (source: ReturnType<typeof buildTicket>, quantity = "1.000000") => {
    const [src] = await api.db.admin<
      {
        id: string;
        quantity: string;
        entered: string;
        discount: string;
        net: string;
        gross: string;
        done_entered: string;
        done_discount: string;
        done_net: string;
        done_gross: string;
      }[]
    >`
      select l.id,l.quantity::text,coalesce(l.unit_quantity,l.quantity)::text as entered,l.discount::text,l.amount::text as net,l.total_incl_tax::text as gross,
      (-coalesce(done.entered,0))::text as done_entered,(-coalesce(done.discount,0))::text as done_discount,(-coalesce(done.net,0))::text as done_net,(-coalesce(done.gross,0))::text as done_gross
      from app.document_line l join app.document d on d.id=l.document_id
      left join lateral(select sum(coalesce(t.unit_quantity,t.quantity)) as entered,sum(t.discount) as discount,sum(t.amount) as net,sum(t.total_incl_tax) as gross from app.document_link k join app.document_line t on t.id=k.target_line_id join app.document r on r.id=k.target_document_id where k.source_line_id=l.id and k.link_kind='returns' and (r.status not in ('void','reversed') or (r.status='reversed' and app.document_claim_stands(r.id)))) done on true
      where d.client_ref=${source.clientRef} and l.kind='item' order by l.line_no limit 1`;
    // The till's rule (ADR 0056; Plan Contracts' 6A return hardening): round(full × cumulative entered ÷
    // source entered) less what earlier refunds took, the completing refund taking the exact residue.
    const cumulative = Quantity.of(src!.done_entered).add(Quantity.of(quantity));
    const ccy = currency(source.currency);
    const ratio = rational(
      BigInt(cumulative.toString().replace(".", "")),
      BigInt(Quantity.of(src!.entered).toString().replace(".", "")),
    );
    const completes = cumulative.compare(Quantity.of(src!.entered)) === 0;
    const share = (full: string, prior: string) =>
      (completes
        ? Money.of(full, ccy)
        : Money.of(full, ccy).multiply(ratio, "HALF_AWAY_FROM_ZERO")
      ).subtract(Money.of(prior, ccy));
    const sku = Object.entries(f.items).find(([, i]) => i.itemId === source.lines[0]!.itemId)![0];
    const refund = buildTicket(f, {
      sku,
      kind: "return",
      quantity,
      returnsClientRef: source.clientRef,
      customerId: source.customerId,
      unitPrice: source.lines[0]!.unitPrice.amount,
    });
    const line = refund.lines[0]!;
    line.unitId = source.lines[0]!.unitId;
    line.taxCodeId = source.lines[0]!.taxCodeId;
    const gross = share(src!.gross, src!.done_gross);
    const net = share(src!.net, src!.done_net);
    line.discount.amount = share(src!.discount, src!.done_discount).negate().toString();
    line.total.amount = gross.negate().toString();
    line.taxAmount.amount = gross.subtract(net).negate().toString();
    refund.tenders[0]!.amount.amount = line.total.amount;
    return refund;
  };

  it("account sales require a customer and debit AR exactly once", async () => {
    expect((await apply([buildTicket(f, { accountSale: true })])).results[0]!.error?.code).toBe(
      "ERR_VALIDATION_FAILED",
    );
    const id = await customer();
    const out = await accepted(buildTicket(f, { accountSale: true, customerId: id }));
    const [ar] = await api.db.admin<
      { debit: string; credit: string }[]
    >`select sum(debit)::text as debit,sum(credit)::text as credit from app.ledger_entry where document_id=${out.documentId} and account_id=${f.accounts["1200"]!}`;
    expect(ar).toEqual({ debit: "50.0000", credit: "0.0000" });
    const [exposure] = await system(
      (tx) =>
        tx<
          { amount: string }[]
        >`select app.document_base_total(${out.documentId}::uuid,1)::text as amount`,
    );
    expect(exposure!.amount).toBe("50.0000");
  });
  it("paid customer sales bypass credit hold; account sales preserve it", async () => {
    const id = await customer();
    await system((tx) => tx`update app.party set credit_hold=true where id=${id}`);
    await accepted(buildTicket(f, { customerId: id }));
    expect(
      (await apply([buildTicket(f, { customerId: id, accountSale: true })])).results[0]!.error
        ?.code,
    ).toBe("ERR_CREDIT_HOLD");
    await system((tx) => tx`update app.party set credit_hold=false where id=${id}`);
  });
  it("system and terminal identities cannot be cashiers or supervisors", async () => {
    for (const cashierPrincipalId of [f.s.system, f.terminal.principalId])
      expect((await apply([buildTicket(f, { cashierPrincipalId })])).results[0]!.error?.code).toBe(
        "ERR_RBAC_FORBIDDEN",
      );
    for (const supervisorPrincipalId of [f.s.system, f.terminal.principalId])
      expect(
        (
          await apply([
            buildTicket(f, {
              events: [
                {
                  kind: "override",
                  code: "pos.ticket.override",
                  subject: "void",
                  supervisorPrincipalId,
                  reason: "malicious identity",
                },
              ],
            }),
          ])
        ).results[0]!.error?.code,
      ).toBe("ERR_RBAC_FORBIDDEN");
  });
  it("wire totals cannot choose revenue independently of quantity and price", async () => {
    const bad = buildTicket(f);
    bad.lines[0]!.total.amount = "100.0000";
    bad.tenders[0]!.amount.amount = "100.0000";
    expect((await apply([bad])).results[0]!.error?.detail).toContain("quantity times unit price");
  });
  it("untaxed lines must actually have zero tax and a consistent total", async () => {
    const bad = buildTicket(f);
    bad.lines[0]!.taxCodeId = null;
    expect((await apply([bad])).results[0]!.error?.code).toBe("ERR_VALIDATION_FAILED");
  });
  it("duplicate wire line numbers and opposite tender signs are rejected", async () => {
    const bad = buildTicket(f);
    bad.lines.push({ ...bad.lines[0]! });
    bad.tenders[0]!.amount.amount = "100.0000";
    expect((await apply([bad])).results[0]!.error?.code).toBe("ERR_VALIDATION_FAILED");
    const signed = buildTicket(f);
    signed.tenders[0]!.amount.amount = "-50.0000";
    expect((await apply([signed])).results[0]!.error?.code).toBe("ERR_VALIDATION_FAILED");
  });
  it("a signed clock-in is stored once and stamped with the terminal actor", async () => {
    const ticket = buildTicket(f);
    ticket.attendance = [{ kind: "clock_in", principalId: f.cashierId, at: ticket.soldAt }];
    expect((await apply([ticket])).results[0]!.status).toBe("accepted");
    const rows = await api.db.admin<
      { kind: string; recorded_by: string; terminal_id: string; branch_id: string }[]
    >`
      select kind,recorded_by,terminal_id,branch_id from app.attendance_event where terminal_id=${f.terminal.terminalId}`;
    expect(rows).toEqual([
      {
        kind: "clock_in",
        recorded_by: f.terminal.principalId,
        terminal_id: f.terminal.terminalId,
        branch_id: f.s.hq,
      },
    ]);
    expect((await apply([ticket])).results[0]!.status).toBe("duplicate");
    const [count] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.attendance_event where terminal_id=${f.terminal.terminalId}`;
    expect(count!.n).toBe(1);
  });
  it("attendance refuses invalid or revoked cashiers and rolls back when a later ticket check fails", async () => {
    const unknown = buildTicket(f);
    unknown.attendance = [{ kind: "clock_in", principalId: uuidv7Sync(), at: unknown.soldAt }];
    expect((await apply([unknown])).results[0]!.error?.code).toBe("ERR_NOT_FOUND");
    const badTax = buildTicket(f);
    badTax.attendance = [{ kind: "clock_in", principalId: f.cashierId, at: badTax.soldAt }];
    badTax.lines[0]!.taxAmount.amount = "0.0000";
    expect((await apply([badTax])).results[0]!.status).toBe("rejected");
    const [count] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.attendance_event where terminal_id=${f.terminal.terminalId}`;
    expect(count!.n).toBe(1);
    await system(
      (tx) => tx`update app.pos_cashier set revoked_at=now() where principal_id=${f.cashierId}`,
    );
    const revoked = buildTicket(f);
    revoked.attendance = [{ kind: "clock_out", principalId: f.cashierId, at: revoked.soldAt }];
    expect((await apply([revoked])).results[0]!.error?.code).toBe("ERR_NOT_FOUND");
    await system(
      (tx) => tx`update app.pos_cashier set revoked_at=null where principal_id=${f.cashierId}`,
    );
  });
  it("checks the attendance principal's live clock grant and rolls its whole ticket back", async () => {
    const incoming = await seedCashier(api.db, f.s, {
      employeeId: await seedEmployee(api.db, f.s, {
        employeeNumber: "CLOCK-NOGRANT",
        homeBranchId: f.s.hq,
      }),
      branchId: f.s.hq,
      pin: "4321",
      permissions: ["pos.ticket.sell"],
    });
    const ticket = buildTicket(f);
    ticket.attendance = [{ kind: "clock_out", principalId: incoming, at: ticket.soldAt }];
    const outcome = (await apply([ticket])).results[0]!;
    expect(outcome.status).toBe("rejected");
    expect(outcome.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    const [count] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = ${ticket.clientRef}`;
    expect(count!.n).toBe(0);
    const [events] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.attendance_event where employee_id = (select employee_id from app.pos_cashier where principal_id = ${incoming})`;
    expect(events!.n).toBe(0);
  });
  it("gates each attendance event on ITS OWN principal, not on the ticket's cashier (handover)", async () => {
    // The handover (6B T4 Step 5): cashier B rings up the next sale, and A's clock-out rides on it because the
    // till's `pendingAttendance` drains every unsent row whatever its principal. Both are active cashiers here
    // holding `pos.attendance.clock`, so the ticket posts and each event is stored against its OWN employee.
    const employeeB = await seedEmployee(api.db, f.s, {
      employeeNumber: "HANDOVER-B",
      homeBranchId: f.s.hq,
    });
    const cashierB = await seedCashier(api.db, f.s, {
      employeeId: employeeB,
      branchId: f.s.hq,
      pin: "4321",
      permissions: ["pos.ticket.sell", "pos.attendance.clock"],
    });
    const [employeeA] = await api.db.admin<{ id: string }[]>`
      select employee_id::text as id from app.pos_cashier where principal_id = ${f.cashierId}`;
    const ticket = buildTicket(f, { cashierPrincipalId: cashierB });
    const later = new Date(Date.parse(ticket.soldAt) + 5_000).toISOString();
    ticket.attendance = [
      { kind: "clock_out", principalId: f.cashierId, at: ticket.soldAt },
      { kind: "clock_in", principalId: cashierB, at: later },
    ];
    const out = (await apply([ticket])).results[0]!;
    expect(out.status, JSON.stringify(out)).toBe("accepted");
    const rows = await api.db.admin<{ kind: string; employee_id: string; recorded_by: string }[]>`
      select kind, employee_id::text as employee_id, recorded_by::text as recorded_by
        from app.attendance_event
       where terminal_id = ${f.terminal.terminalId}
         and employee_id in (${employeeA!.id}, ${employeeB})
         and occurred_at >= ${ticket.soldAt}::timestamptz
       order by occurred_at`;
    expect(rows.map((r) => [r.kind, r.employee_id])).toEqual([
      ["clock_out", employeeA!.id],
      ["clock_in", employeeB],
    ]);
    expect(rows.every((r) => r.recorded_by === f.terminal.principalId)).toBe(true);
  });
  it("referenced returns preserve source cost and bound cumulative quantity", async () => {
    const source = buildTicket(f, { quantity: "2.000000" });
    const sale = await accepted(source);
    const refund = await refundFrom(source);
    const ret = await accepted(refund);
    const [line] = await api.db.admin<
      { cost: string; quantity: string }[]
    >`select cost::text,quantity::text from app.document_line where document_id=${ret.documentId} and kind='item'`;
    expect(line).toEqual({ cost: "30.0000", quantity: "-1.000000" });
    await accepted(await refundFrom(source));
    expect(
      (await apply([buildTicket(f, { kind: "return", returnsClientRef: source.clientRef })]))
        .results[0]!.error?.detail,
    ).toContain("remaining return quantity");
    const [cost] = await api.db.admin<
      { amount: string }[]
    >`select sum(base_debit-base_credit)::text as amount from app.ledger_entry where account_id=${f.accounts["5000"]!} and (document_id=${sale.documentId} or document_id in(select target_document_id from app.document_link where source_document_id=${sale.documentId}))`;
    expect(cost!.amount).toBe("0.0000");
  });
  it("refund price, customer and duplicate item matches fail closed", async () => {
    const id = await customer();
    const source = buildTicket(f, { customerId: id });
    await accepted(source);
    const bad = buildTicket(f, {
      kind: "return",
      returnsClientRef: source.clientRef,
      customerId: id,
      unitPrice: "60.0000",
    });
    expect((await apply([bad])).results[0]!.error?.detail).toContain("original price");
    expect(
      (await apply([buildTicket(f, { kind: "return", returnsClientRef: source.clientRef })]))
        .results[0]!.error?.detail,
    ).toContain("same customer");
    const duplicate = buildTicket(f);
    duplicate.lines.push({ ...duplicate.lines[0]!, lineNo: 2 });
    duplicate.tenders[0]!.amount.amount = "100.0000";
    await accepted(duplicate);
    expect(
      (await apply([buildTicket(f, { kind: "return", returnsClientRef: duplicate.clientRef })]))
        .results[0]!.error?.detail,
    ).toContain("unambiguous");
  });
  it("a duplicate refund row cannot claim the same source line twice", async () => {
    const source = buildTicket(f, { quantity: "2.000000" });
    await accepted(source);
    const bad = await refundFrom(source);
    bad.lines.push({ ...bad.lines[0]!, lineNo: 2 });
    bad.tenders[0]!.amount.amount = "-100.0000";
    expect((await apply([bad])).results[0]!.error?.detail).toContain("requested twice");
  });
  it("entered units convert stock and refund links to base quantities", async () => {
    const unit = await seedUnit(api.db, f.s, { code: "CASE" });
    await system(
      (tx) =>
        tx`insert into app.unit_conversion (tenant_id,item_id,unit_id,numerator,denominator) values (${f.s.tenant},${f.items["SKU-B"]!.itemId},${unit},2,1)`,
    );
    const source = buildTicket(f, { sku: "SKU-B", quantity: "2.000000" });
    source.lines[0]!.unitId = unit;
    const sale = await accepted(source);
    const [line] = await api.db.admin<
      { quantity: string; unit_quantity: string; cost: string }[]
    >`select quantity::text,unit_quantity::text,cost::text from app.document_line where document_id=${sale.documentId} and kind='item'`;
    expect(line).toEqual({ quantity: "4.000000", unit_quantity: "2.000000", cost: "120.0000" });
    const refund = await refundFrom(source);
    refund.lines[0]!.unitId = unit;
    const out = await accepted(refund);
    const [link] = await api.db.admin<
      { quantity: string }[]
    >`select quantity::text from app.document_link where target_document_id=${out.documentId}`;
    expect(link!.quantity).toBe("2.000000");
  });
  it("a three-part refund conserves original net, tax and cost including the final residue", async () => {
    const source = buildTicket(f, { sku: "SKU-C", quantity: "3.000000" });
    const sale = await accepted(source);
    const sourceLine = (
      await api.db.admin<
        { amount: string; gross: string; tax: string }[]
      >`select amount::text,total_incl_tax::text as gross,tax_amount::text as tax from app.document_line where document_id=${sale.documentId} and kind='item'`
    )[0]!;
    const ccy = currency("MYR");
    let tax = Money.zero(ccy);
    for (let i = 0; i < 3; i++) {
      // Each refund carries the till's cumulative share (round(net × k/3) − earlier refunds), NOT a fresh
      // one-unit sale's tax, which can differ from it in the fourth decimal on the second third.
      const out = await accepted(await refundFrom(source));
      const [line] = await api.db.admin<
        { tax: string }[]
      >`select tax_amount::text as tax from app.document_line where document_id=${out.documentId} and kind='item'`;
      tax = tax.add(Money.of(line!.tax, ccy).negate());
    }
    expect(tax.toString()).toBe(sourceLine.tax);
  });
  it("referenced discounts restore source facts with return-only authority", async () => {
    const source = buildTicket(f, { quantity: "2.000000", discount: "1.0000" });
    await accepted(source);
    const clerk = await secondPrincipal(api.db, f.s, "Return-only clerk");
    const employeeId = await seedEmployee(api.db, f.s, { employeeNumber: "RETURN-ONLY" });
    await seedCashier(api.db, f.s, { employeeId, branchId: f.s.hq, principalId: clerk });
    await grantCodes(api.db, f.s, {
      principalId: clerk,
      roleCode: "return-only",
      branchIds: [f.s.hq],
      codes: ["pos.ticket.return"],
    });
    const bad = await refundFrom(source);
    bad.cashierPrincipalId = clerk;
    bad.lines[0]!.discount.amount = "-0.4000";
    expect((await apply([bad])).results[0]!.error?.detail).toContain("preserve the original");
    const good = await refundFrom(source);
    good.cashierPrincipalId = clerk;
    await accepted(good);
    const blind = buildTicket(f, { kind: "return", discount: "1.0000", cashierPrincipalId: clerk });
    expect((await apply([blind])).results[0]!.error?.code).toBe("ERR_RBAC_FORBIDDEN");
  });
  it("discounted fractional returns use cumulative historical shares", async () => {
    const source = buildTicket(f, {
      quantity: "3.000000",
      unitPrice: "1.0000",
      discount: "1.0001",
    });
    await accepted(source);
    await accepted(await refundFrom(source, "1.500000"));
    await accepted(await refundFrom(source, "1.500000"));
  });
  it("nonintegral units refuse ambiguous partial residues and accept the whole source", async () => {
    const unit = await seedUnit(api.db, f.s, { code: "THIRD" });
    await system(
      (tx) =>
        tx`insert into app.unit_conversion (tenant_id,item_id,unit_id,numerator,denominator) values (${f.s.tenant},${f.items["SKU-B"]!.itemId},${unit},1,3)`,
    );
    const source = buildTicket(f, { sku: "SKU-B", quantity: "2.000000" });
    source.lines[0]!.unitId = unit;
    await accepted(source);
    expect((await apply([await refundFrom(source)])).results[0]!.error?.detail).toContain(
      "ambiguous rounding",
    );
    await accepted(await refundFrom(source, "2.000000"));
  });
  it("a quick-created code cannot silently attach another offline customer identity", async () => {
    const id = uuidv7Sync();
    const ticket = buildTicket(f, {
      accountSale: true,
      customerId: id,
      newCustomer: { id, code: "NEW-ID", nameEn: "Customer", phone: null },
    });
    await accepted(ticket);
    await accepted({ ...ticket, clientRef: uuidv7Sync() });
    const other = uuidv7Sync();
    const collision = buildTicket(f, {
      accountSale: true,
      customerId: other,
      newCustomer: { id: other, code: "NEW-ID", nameEn: "Different", phone: null },
    });
    const good = buildTicket(f);
    expect((await apply([collision, good])).results.map((r) => r.status)).toEqual([
      "rejected",
      "accepted",
    ]);
  });
  it("AR ageing ties out after customer-paid and account POS tickets", async () => {
    const rows = await system((tx) =>
      ageingTieOut(tx, { companyId: f.s.company, asOf: "2026-12-31" }),
    );
    expect(
      rows.every((r) => r.difference === "0.0000"),
      JSON.stringify(rows),
    ).toBe(true);
  });
  it("concurrent refunds cannot both consume one remaining source quantity", async () => {
    const source = buildTicket(f);
    await accepted(source);
    const one = await refundFrom(source),
      two = await refundFrom(source);
    const outcomes = await Promise.all([apply([one]), apply([two])]);
    expect(outcomes.map((o) => o.results[0]!.status).toSorted()).toEqual(["accepted", "rejected"]);
  });
  it("a replay remains duplicate after the original ticket has been reversed", async () => {
    const source = buildTicket(f);
    const out = await accepted(source);
    const reversalDate = await effectiveDateOf(out.documentId!);
    await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "reverse" },
      (tx) =>
        reverseDocument(
          tx,
          { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "reverse" },
          {
            documentId: out.documentId!,
            effectiveDate: reversalDate,
            reason: "correct receipt",
            jobs: recordingJobs(),
          },
        ),
    );
    expect((await apply([source])).results[0]!.status).toBe("duplicate");
  });
  it("reversing a partial return releases only its original budget and creates no refundable mirror sale", async () => {
    const source = buildTicket(f, { quantity: "2.000000" });
    await accepted(source);
    const returned = await accepted(await refundFrom(source));
    const reversalDate = await effectiveDateOf(returned.documentId!);
    const mirror = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "reverse-return" },
      (tx) =>
        reverseDocument(
          tx,
          { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "reverse-return" },
          {
            documentId: returned.documentId!,
            effectiveDate: reversalDate,
            reason: "cancel refund",
            jobs: recordingJobs(),
          },
        ),
    );
    const [header] = await api.db.admin<
      { client_ref: string }[]
    >`select client_ref from app.document where id=${mirror.reversalDocumentId}`;
    const bad = buildTicket(f, { kind: "return", returnsClientRef: header!.client_ref });
    expect((await apply([bad])).results[0]!.status).toBe("rejected");
    // The released original quantity is still refundable once through the genuine source.
    const original = await refundFrom(source);
    await accepted(original);
  });
  it("another terminal cannot overwrite the original quarantine payload or lose good neighbours", async () => {
    const first = buildTicket(f, { cashierPrincipalId: f.s.system });
    expect((await apply([first])).results[0]!.status).toBe("rejected");
    const other = await enrolTerminal(api, f.s, { code: "KL03", as: f.cashierId });
    const changed = { ...first, shiftId: uuidv7Sync() };
    const ownedShift = await seedShift(api.db, f.s, {
      terminalId: other.terminalId,
      cashierPrincipalId: f.cashierId,
    });
    const good = buildTicket(f, { shiftId: ownedShift });
    const result = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: other.principalId, requestId: "quarantine-owner" },
      (tx) =>
        applyBatch(
          tx,
          { tenantId: f.s.tenant, actorId: other.principalId, requestId: "quarantine-owner" },
          {
            terminalId: other.terminalId,
            principalId: other.principalId,
            companyId: f.s.company,
            branchId: f.s.hq,
            jobs: recordingJobs(),
          },
          {
            terminalId: other.terminalId,
            batchId: uuidv7Sync(),
            tickets: [changed, good],
            shifts: [],
            tillEvents: [],
          },
        ),
    );
    expect(result.results.map((r) => r.status)).toEqual(["rejected", "accepted"]);
    const [row] = await api.db.admin<
      { terminal_id: string; payload: { shiftId: string } }[]
    >`select terminal_id,payload from app.needs_attention where company_id=${f.s.company} and client_ref=${first.clientRef}`;
    expect(row!.terminal_id).toBe(f.terminal.terminalId);
    expect(row!.payload.shiftId).toBe(first.shiftId);
  });
  it("another terminal's reference is a rejection while good neighbours still commit", async () => {
    const source = buildTicket(f);
    const out = await accepted(source);
    const other = await enrolTerminal(api, f.s, { code: "KL02", as: f.cashierId });
    const ownedShift = await seedShift(api.db, f.s, {
      terminalId: other.terminalId,
      cashierPrincipalId: f.cashierId,
    });
    const good = buildTicket(f, { shiftId: ownedShift });
    const result = await withTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: other.principalId, requestId: "collision" },
      (tx) =>
        applyBatch(
          tx,
          { tenantId: f.s.tenant, actorId: other.principalId, requestId: "collision" },
          {
            terminalId: other.terminalId,
            principalId: other.principalId,
            companyId: f.s.company,
            branchId: f.s.hq,
            jobs: recordingJobs(),
          },
          {
            terminalId: other.terminalId,
            batchId: uuidv7Sync(),
            tickets: [source, good],
            shifts: [],
            tillEvents: [],
          },
        ),
    );
    expect(result.results.map((r) => r.status)).toEqual(["rejected", "accepted"]);
    expect(result.results[0]!.documentId).toBeNull();
    expect(out.documentId).toBeTruthy();
  });
  it("a late deferred refusal rolls back only its own ticket", async () => {
    await api.db.admin.unsafe(
      `create function app.test_pos_late_refusal() returns trigger language plpgsql as $$ begin if new.status='posted' and new.client_ref::text=current_setting('test.pos_bad_ref',true) then raise exception 'ERR_VALIDATION_FAILED: late ticket refusal' using errcode='23514'; end if; return new; end $$`,
    );
    await api.db.admin.unsafe(
      `create constraint trigger test_pos_late_refusal after update on app.document deferrable initially deferred for each row execute function app.test_pos_late_refusal()`,
    );
    try {
      const good1 = buildTicket(f),
        bad = buildTicket(f),
        good2 = buildTicket(f);
      const result = await withTenant(
        api.db.rw,
        { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "deferred" },
        async (tx) => {
          await tx`select set_config('test.pos_bad_ref',${bad.clientRef},true)`;
          return applyBatch(
            tx,
            { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "deferred" },
            {
              terminalId: f.terminal.terminalId,
              principalId: f.terminal.principalId,
              companyId: f.s.company,
              branchId: f.s.hq,
              jobs: recordingJobs(),
            },
            {
              terminalId: f.terminal.terminalId,
              batchId: uuidv7Sync(),
              tickets: [good1, bad, good2],
              shifts: [],
              tillEvents: [],
            },
          );
        },
      );
      expect(result.results.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
      expect(result.results[1]!.error?.detail).toContain("late ticket refusal");
      const [missing] = await api.db.admin<
        { n: number }[]
      >`select count(*)::int as n from app.document where client_ref=${bad.clientRef}`;
      expect(missing!.n).toBe(0);
    } finally {
      await api.db.admin.unsafe(`drop trigger test_pos_late_refusal on app.document`);
      await api.db.admin.unsafe(`drop function app.test_pos_late_refusal()`);
    }
  });
  it("archived items and same-tenant items from another company are refused", async () => {
    const item = f.items["SKU-A"]!.itemId;
    await system((tx) => tx`update app.item set archived_at=now() where id=${item}`);
    try {
      expect((await apply([buildTicket(f)])).results[0]!.error?.detail).toContain("active item");
    } finally {
      await system((tx) => tx`update app.item set archived_at=null where id=${item}`);
    }
    const foreign = await system(async (tx) => {
      const [co] = await tx<
        { id: string }[]
      >`insert into app.company (tenant_id,code,name,base_currency) values (${f.s.tenant},'FOREIGN','Foreign company','MYR') returning id`;
      const [foreignItem] = await tx<
        { id: string }[]
      >`insert into app.item(tenant_id,company_id,code,name_en,kind,base_unit_id,revenue_account_id,inventory_account_id,cogs_account_id,track_lots)
        select tenant_id,${co!.id},'FOREIGN-SKU',name_en,kind,base_unit_id,revenue_account_id,inventory_account_id,cogs_account_id,track_lots from app.item where id=${item} returning id`;
      return foreignItem!.id;
    });
    // The item is real and active — only its company differs — so the refusal below is the company check.
    const [row] = await api.db.admin<
      { company_id: string; archived_at: Date | null }[]
    >`select company_id, archived_at from app.item where id=${foreign}`;
    expect(row!.company_id).not.toBe(f.s.company);
    expect(row!.archived_at).toBeNull();
    const bad = buildTicket(f);
    bad.lines[0]!.itemId = foreign;
    const refused = (await apply([bad])).results[0]!;
    expect(refused.status).toBe("rejected");
    expect(refused.documentId).toBeNull();
    expect(refused.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(refused.error?.detail).toContain("active item of the terminal company");
  });
  it("overrides do not leak supervisor attribution into later document transitions", async () => {
    await grantCodes(api.db, f.s, {
      principalId: f.cashierId,
      branchIds: [f.s.hq],
      codes: ["pos.ticket.void"],
    });
    const first = buildTicket(f, {
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "void",
          supervisorPrincipalId: f.supervisorId,
          reason: "operator correction",
        },
      ],
    });
    const second = buildTicket(f);
    const result = await apply([first, second]);
    expect(result.results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    const events = await api.db.admin<
      { attributed_to: string | null; reason: string | null }[]
    >`select attributed_to,reason from app.document_event where document_id=any(${result.results.map((r) => r.documentId!)}::uuid[]) and event_kind='transition'`;
    expect(
      events.every(
        (e) => e.attributed_to !== f.supervisorId && e.reason !== "void: operator correction",
      ),
    ).toBe(true);
  });
});
