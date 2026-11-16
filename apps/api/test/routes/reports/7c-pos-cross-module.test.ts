import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  currency,
  statementDefinition,
  statementKindFor,
  validateReportDefinition,
} from "@dulja/domain";
import {
  applyBatch,
  reportDefinitionSets,
  salesByCashier,
  withTenant,
  zReport,
  type DatasetRow,
  type TenantContext,
} from "@dulja/db";
import {
  arApReportFixture,
  crossParams,
  posParams,
  posReportFixture,
  readDefinition7C,
  readEnvelope7C,
  type ArApReportFixture,
  type PosReportFixture,
} from "../../../../../tests/invariants/support/reports-7c";
import {
  assertFieldCoverage,
  assertTieOut,
  runDefinition,
} from "../../../../../tests/invariants/support/reports";
import { startApi, type StartedApi } from "../../support/app";

/**
 * 7C Task 4 — the four POS and two cross-module definitions (contracts §4.16.1; round 15, A2, A5 and A7).
 *
 * In `apps/api/test/`, not `packages/db/test/`: `posReportFixture` takes a `StartedApi` because 6C's
 * `staffFixture` does, and `packages/db/test/**` has no allowance to import `apps/api/test/**` (§3.1). The
 * PRODUCTION three-argument `withTenant(sql, ctx, fn)` is the one this tier uses.
 *
 * `pos.z_report` and `pos.sales_by_cashier` re-express 6D's codes at definitionVersion 2; 6D's routes and DTOs
 * stand byte-for-byte (7B A2) and the parity cases compare the definitions with 6D's `zReport` and
 * `salesByCashier` on the fixture's whole day — including a till paid-out (OD-10, ADR 0064) on the open
 * shift, which the Z-report's cash-control section lists and which must move neither net sales nor a count.
 */
const MYR = currency("MYR");

/** A day either side of the run date, as 6D's own tests and test 21 use: the POS corpus is dated `now()` and
 *  both 6D and the `shift` dataset bucket in the company's timezone (A16 item 3). */
const dayOffset = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("7C POS and cross-module definitions — §4.16.1, amendments A2, A5 and A7", () => {
  let api: StartedApi;
  let p: PosReportFixture;
  let a: ArApReportFixture;
  let fromDate: string;
  let toDate: string;
  /** The till paid-out posted on the fixture's open shift (OD-10). */
  let paidOutRef: string;

  beforeAll(async () => {
    api = await startApi();
    p = await posReportFixture(api, "7c-pos");
    a = await arApReportFixture(api.db, "7c-cross");
    fromDate = dayOffset(-1);
    toDate = dayOffset(1);

    // OD-10's paid-out (docs/owner/od-10/decision.md fact 1): branch A allows one up to 100.0000, and the
    // cashier pays 12.5000 out of the OPEN shift's drawer with a reference (fact 4). Through `applyBatch`, as
    // every POS row of this fixture is written.
    await withTenant(
      api.db.migrator,
      { tenantId: p.s.tenant, actorId: p.s.system, requestId: crypto.randomUUID() },
      (tx) => tx`update app.branch_pos_policy
                    set paid_out_allowed = true, max_paid_out_amount = 100
                  where company_id = ${p.s.company} and branch_id = ${p.branchA}`,
    );
    paidOutRef = crypto.randomUUID();
    const terminal = p.staff.terminalA;
    const ctx: TenantContext = {
      tenantId: p.s.tenant,
      actorId: terminal.principalId,
      requestId: crypto.randomUUID(),
    };
    const out = await withTenant(api.db.rw, ctx, (tx) =>
      applyBatch(
        tx,
        ctx,
        {
          terminalId: terminal.terminalId,
          companyId: p.s.company,
          branchId: p.branchA,
          principalId: terminal.principalId,
        },
        {
          terminalId: terminal.terminalId,
          batchId: crypto.randomUUID(),
          tickets: [],
          shifts: [],
          tillEvents: [],
          cashEvents: [
            {
              clientRef: paidOutRef,
              shiftId: p.openShiftId,
              kind: "paid_out",
              amount: { amount: "12.5000", currency: "MYR" },
              cashierPrincipalId: p.staff.cashierA,
              supervisorPrincipalId: null,
              occurredAt: new Date().toISOString(),
              reference: "RCPT-7C",
              fromSafe: false,
            },
          ],
        } as never,
      ),
    );
    if (out.cashEventResults?.[0]?.status !== "accepted") {
      throw new Error(`the paid-out was ${JSON.stringify(out.cashEventResults)}`);
    }
  }, 300_000);
  afterAll(async () => {
    await api?.stop();
  });

  const readPos = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(
      api.db.rw,
      { tenantId: p.s.tenant, actorId: p.reader, requestId: crypto.randomUUID() },
      fn,
    );
  const readAcc = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(
      api.db.rw,
      { tenantId: a.s.tenant, actorId: a.reader, requestId: crypto.randomUUID() },
      fn,
    );

  const POS = [
    "pos.z_report",
    "pos.sales_by_cashier",
    "pos.sales_by_branch",
    "pos.needs_attention",
  ] as const;
  const CROSS = ["accounting.branch_profit_and_loss", "accounting.tax_return_view"] as const;

  /** The shared parameter tables (`reports-7c.ts`), which the slice-exit roll-up reads too. */
  const posArgs = (code: string): Record<string, string> =>
    posParams(code, p, { fromDate, toDate });
  const crossArgs = (code: string): Record<string, string> => crossParams(code, a);
  /** A fixed-scale money string, or null for null — so a parity compares stored figures exactly. */
  const money = (v: unknown): string | null =>
    v === null || v === undefined ? null : Money.of(String(v), MYR).toString();

  it("all six validate, and only the two re-expressed carry definitionVersion 2", async () => {
    const sets = await readPos((tx) => reportDefinitionSets(tx));
    for (const code of [...POS, ...CROSS]) {
      const result = validateReportDefinition(readDefinition7C(code), sets);
      expect(result.errors, code).toEqual([]);
      expect(result.ok, code).toBe(true);
    }
    expect(readEnvelope7C("pos.z_report").definitionVersion).toBe(2);
    expect(readEnvelope7C("pos.sales_by_cashier").definitionVersion).toBe(2);
    for (const code of ["pos.sales_by_branch", "pos.needs_attention", ...CROSS] as const) {
      expect(readEnvelope7C(code).definitionVersion, code).toBe(1);
    }
  });

  it("every field the six name is a column its dataset serves", async () => {
    for (const code of POS) {
      const definition = readDefinition7C(code);
      assertFieldCoverage(
        definition,
        await readPos((tx) => runDefinition(tx, definition, posArgs(code))),
      );
    }
    for (const code of CROSS) {
      const definition = readDefinition7C(code);
      assertFieldCoverage(
        definition,
        await readAcc((tx) => runDefinition(tx, definition, crossArgs(code))),
      );
    }
  });

  it("no 7C definition reads the till_event dataset — it is a designer source (amendment A2)", () => {
    const sources = [...POS, ...CROSS].map((c) => readDefinition7C(c).dataset.source);
    expect(sources).not.toContain("till_event");
    // `accounting.branch_profit_and_loss`'s source is `account_balance` — the row SHAPE, not the query (A5).
    expect(sources).toEqual([
      "shift",
      "shift",
      "shift",
      "needs_attention",
      "account_balance",
      "tax_transaction",
    ]);
  });

  it("pos.z_report ties to app.shift's stored figures — one shift, and the history over the day", async () => {
    const definition = readDefinition7C("pos.z_report");
    await readPos((tx) =>
      assertTieOut(tx, definition, { params: posArgs("pos.z_report"), baseCurrency: MYR }),
    );
    await readPos((tx) =>
      assertTieOut(tx, definition, {
        params: { companyId: p.s.company, fromDate, toDate },
        baseCurrency: MYR,
      }),
    );
  });

  it("pos.z_report PARITY: the definition equals 6D's zReport figure for figure, shift by shift", async () => {
    const definition = readDefinition7C("pos.z_report");
    // The HISTORY shape over the day, so every shift — the closed one, the open one carrying the paid-out, and
    // the fixture's two ticketless ones — is compared, not one chosen row.
    const rows = await readPos((tx) =>
      runDefinition(tx, definition, { companyId: p.s.company, fromDate, toDate }),
    );
    const route = await readPos((tx) =>
      zReport(tx, { companyId: p.s.company, from: fromDate, to: toDate, limit: 100 }),
    );
    expect(route.length).toBeGreaterThanOrEqual(2);
    // The same shifts, in the same order (opened_at desc, id desc — 6D's keyset order).
    expect(rows.map((r) => r["shift_id"])).toEqual(route.map((r) => r.shiftId));
    for (const r of route) {
      const row = rows.find((x) => x["shift_id"] === r.shiftId)!;
      const events = (kind: string) => r.tillEvents.find((e) => e.kind === kind)?.count ?? 0;
      expect(row["branch_id"], r.shiftId).toBe(r.branchId);
      expect(row["terminal_id"], r.shiftId).toBe(r.terminalId);
      expect(row["terminal_code"], r.shiftId).toBe(r.terminalCode);
      expect(row["cashier_principal_id"], r.shiftId).toBe(r.openedPrincipalId);
      expect(row["closed_principal_id"], r.shiftId).toBe(r.closedPrincipalId);
      expect(row["currency"], r.shiftId).toBe(r.currency);
      expect(money(row["opening_float"]), r.shiftId).toBe(money(r.openingFloat));
      expect(money(row["counted_cash"]), r.shiftId).toBe(money(r.countedCash));
      expect(money(row["expected_cash"]), r.shiftId).toBe(money(r.expectedCash));
      expect(money(row["over_short"]), r.shiftId).toBe(money(r.overShort));
      expect(row["over_short_document_id"], r.shiftId).toBe(r.overShortDocumentId);
      expect(row["ticket_count"], r.shiftId).toBe(r.ticketCount);
      expect(row["return_count"], r.shiftId).toBe(r.returnCount);
      expect(row["no_sale_count"], r.shiftId).toBe(events("no_sale"));
      expect(row["drawer_open_count"], r.shiftId).toBe(events("drawer_open"));
      expect(row["void_count"], r.shiftId).toBe(events("void"));
    }
    // The closed shift is the one test 21 reconciles: four tickets, two returns, a 2.0000 short.
    const closed = route.find((r) => r.shiftId === p.closedShiftId)!;
    expect([closed.ticketCount, closed.returnCount, closed.overShort]).toEqual([4, 2, "-2.0000"]);
    // OD-10: the paid-out is in 6D's cash-control section and moves neither a count nor net sales — the
    // dataset's net sales are POS_TICKET income only, the predicate 6D's tenders and salesByCashier use.
    const open = route.find((r) => r.shiftId === p.openShiftId)!;
    expect(open.cashControl).toEqual([
      { documentTypeCode: "TILL_PAID_OUT", amount: "-12.5000", currency: "MYR" },
    ]);
    const openRow = rows.find((x) => x["shift_id"] === p.openShiftId)!;
    expect([
      openRow["ticket_count"],
      openRow["return_count"],
      money(openRow["net_sales_base"]),
    ]).toEqual([0, 0, "0.0000"]);
  });

  it("pos.sales_by_cashier PARITY: Σ net_sales_base, tickets and returns per cashier equal 6D's salesByCashier", async () => {
    const definition = readDefinition7C("pos.sales_by_cashier");
    const rows = await readPos((tx) =>
      runDefinition(tx, definition, posArgs("pos.sales_by_cashier")),
    );
    const route = await readPos((tx) =>
      salesByCashier(tx, { companyId: p.s.company, from: fromDate, to: toDate, limit: 100 }),
    );
    expect(route.some((r) => r.cashierPrincipalId === p.staff.cashierA)).toBe(true);
    const mine = (r: { cashierPrincipalId: string; branchId: string }): DatasetRow[] =>
      rows.filter(
        (x) => x["cashier_principal_id"] === r.cashierPrincipalId && x["branch_id"] === r.branchId,
      );
    for (const r of route) {
      let net = Money.zero(MYR);
      let overShort = Money.zero(MYR);
      let tickets = 0;
      let returns = 0;
      for (const row of mine(r)) {
        net = net.add(Money.of(String(row["net_sales_base"]), MYR));
        if (row["over_short"] !== null)
          overShort = overShort.add(Money.of(String(row["over_short"]), MYR));
        tickets += Number(row["ticket_count"]);
        returns += Number(row["return_count"]);
      }
      expect(net.toString(), r.cashierPrincipalId).toBe(Money.of(r.netSalesBase, MYR).toString());
      expect(tickets, r.cashierPrincipalId).toBe(r.ticketCount);
      expect(returns, r.cashierPrincipalId).toBe(r.returnCount);
      // 6D attributes the over/short to the shift's CLOSER and the dataset to its opener; one cashier opens
      // and closes every shift here (ShiftOpenClose's one cashierPrincipalId), so the two agree.
      expect(overShort.toString(), r.cashierPrincipalId).toBe(
        Money.of(r.overShortBase, MYR).toString(),
      );
    }
    // And the definition reports no takings for a cashier 6D does not list.
    for (const row of rows) {
      if (money(row["net_sales_base"]) === "0.0000") continue;
      expect(
        route.some(
          (r) =>
            r.cashierPrincipalId === row["cashier_principal_id"] && r.branchId === row["branch_id"],
        ),
        String(row["cashier_name"]),
      ).toBe(true);
    }
  });

  it("pos.sales_by_cashier ties Σ net_sales_base to the ledger's POS_TICKET income", async () => {
    const definition = readDefinition7C("pos.sales_by_cashier");
    await readPos((tx) =>
      assertTieOut(tx, definition, {
        params: posArgs("pos.sales_by_cashier"),
        baseCurrency: MYR,
        window: { fromDate, toDate, accountTypes: ["income"], documentTypeCodes: ["POS_TICKET"] },
      }),
    );
  });

  it("pos.sales_by_branch ties per branch, and branch B has no takings", async () => {
    const definition = readDefinition7C("pos.sales_by_branch");
    const window = {
      fromDate,
      toDate,
      accountTypes: ["income"],
      documentTypeCodes: ["POS_TICKET"],
    } as const;
    await readPos((tx) =>
      assertTieOut(tx, definition, {
        params: posArgs("pos.sales_by_branch"),
        baseCurrency: MYR,
        window,
      }),
    );
    await readPos((tx) =>
      assertTieOut(tx, definition, {
        params: { ...posArgs("pos.sales_by_branch"), branchId: p.branchA },
        baseCurrency: MYR,
        window: { ...window, branchId: p.branchA },
      }),
    );
    const rows = await readPos((tx) =>
      runDefinition(tx, definition, { ...posArgs("pos.sales_by_branch"), branchId: p.branchB }),
    );
    expect(rows.every((r) => r["branch_id"] === p.branchB)).toBe(true);
    expect(rows.every((r) => money(r["net_sales_base"]) === "0.0000")).toBe(true);
  });

  it("pos.needs_attention lists the rejected ticket and never its payload", async () => {
    const definition = readDefinition7C("pos.needs_attention");
    const rows = await readPos((tx) =>
      runDefinition(tx, definition, posArgs("pos.needs_attention")),
    );
    expect(rows.map((r) => r["client_ref"])).toEqual([p.rejectedClientRef]);
    expect(definition.columns.map((c) => c.field)).not.toContain("payload");
    expect(Object.keys(rows[0]!)).not.toContain("payload");
    expect(definition.permission).toBe("pos.needs_attention.resolve");
    await readPos((tx) =>
      assertTieOut(tx, definition, {
        params: posArgs("pos.needs_attention"),
        baseCurrency: MYR,
        witness: {
          key: ["client_ref"],
          rows: (tx2) => tx2<{ client_ref: string }[]>`
            select na.client_ref::text as client_ref from app.needs_attention na
             where na.company_id = ${p.s.company} and na.resolved_at is null order by na.client_ref`,
        },
      }),
    );
    // The closed half is the resolved rows — none here.
    const resolved = await readPos((tx) =>
      runDefinition(tx, definition, { ...posArgs("pos.needs_attention"), isOpen: "false" }),
    );
    expect(resolved).toEqual([]);
  });

  // THE CASE THAT MAKES A5 MECHANICAL: the seed file is not "modelled on" 7A's perBranch layout, it IS that
  // layout composed onto this code's identity. A hand-written divergence in any member fails here with a diff.
  it("accounting.branch_profit_and_loss IS statementDefinition(profit_and_loss, …, { perBranch: true })", () => {
    expect(readDefinition7C("accounting.branch_profit_and_loss")).toEqual(
      statementDefinition(
        "profit_and_loss",
        {
          code: "accounting.branch_profit_and_loss",
          nameEn: "Branch profit and loss",
          nameAr: "الأرباح والخسائر حسب الفرع",
          permission: "accounting.report.read",
        },
        { perBranch: true },
      ),
    );
  });

  it("accounting.branch_profit_and_loss is a STATEMENT code whose rows come from ledger_entry (A5)", async () => {
    const definition = readDefinition7C("accounting.branch_profit_and_loss");
    expect(definition.dataset.source).toBe("account_balance");
    expect(statementKindFor("accounting.branch_profit_and_loss")).toBe("profit_and_loss");
    expect(definition.groups.map((g) => g.field)).toEqual(["branch_code", "section_label"]);
    expect(definition.parameters.map((x) => x.name)).toEqual(["fiscalPeriodId", "branchId"]);

    // With a branchId the run takes `statementRows`' ledger_entry branch, the only place a branch tag exists on
    // a posted amount; `branch_id` on the rows is the proof — the account_balance fallback carries none.
    const rows = await readAcc((tx) =>
      runDefinition(tx, definition, crossArgs("accounting.branch_profit_and_loss")),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!)).toContain("branch_id");
    expect(rows.every((r) => r["branch_id"] === a.s.hq)).toBe(true);
    expect(rows.every((r) => r["section"] === "revenue" || r["section"] === "expense")).toBe(true);

    await readAcc((tx) =>
      assertTieOut(tx, definition, {
        params: crossArgs("accounting.branch_profit_and_loss"),
        baseCurrency: MYR,
        window: {
          fiscalPeriodId: a.fiscalPeriodId,
          branchId: a.s.hq,
          accountTypes: ["income", "expense"],
        },
      }),
    );
  });

  it("accounting.tax_return_view names no authority form, box, rate or deadline, and ties to 2300", async () => {
    const definition = readDefinition7C("accounting.tax_return_view");
    const text = JSON.stringify(definition).toLowerCase();
    for (const forbidden of ["LHDN", "MyInvois", "SST-02", "GST-03", "box", "deadline"]) {
      expect(text, forbidden).not.toContain(forbidden.toLowerCase());
    }
    expect(definition.permission).toBe("accounting.tax.manage");
    const rows = await readAcc((tx) =>
      runDefinition(tx, definition, crossArgs("accounting.tax_return_view")),
    );
    // The invoice's output tax and the credit note's signed reversal of part of it (5A's engine).
    expect(rows.map((r) => r["document_id"]).toSorted()).toEqual(
      [a.invoiceId, a.creditNoteId].toSorted(),
    );
    expect(rows.every((r) => r["tax_code_kind"] === "output")).toBe(true);
    await readAcc((tx) =>
      assertTieOut(tx, definition, {
        params: crossArgs("accounting.tax_return_view"),
        baseCurrency: MYR,
        window: { fiscalPeriodId: a.fiscalPeriodId, accountCode: "2300" },
      }),
    );
    // The input side (A7): the fixture buys nothing, so the input view is empty — the witness of the filter.
    const input = await readAcc((tx) =>
      runDefinition(tx, definition, {
        ...crossArgs("accounting.tax_return_view"),
        taxCodeKind: "input",
      }),
    );
    expect(input).toEqual([]);
  });
});
